import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthSessionId,
  AuthTerminalOperateScope,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServer } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { screenRemoteRouteLayer } from "./screenRemoteRoute.ts";

const platformLayer = NodeHttpPlatform.layer.pipe(Layer.provideMerge(NodeServices.layer));

// Stands in for native/helm-screen: an info message, one video frame, then every command echoed.
const FAKE_HELPER = `#!/usr/bin/env node
const frame = (kind, payload) => {
  const head = Buffer.alloc(5);
  head[0] = kind;
  head.writeUInt32BE(payload.length, 1);
  process.stdout.write(Buffer.concat([head, payload]));
};
const json = (value) => frame(10, Buffer.from(JSON.stringify(value)));
json({ t: "info", width: 1512, height: 982 });
frame(1, Buffer.from([1, 0, 0, 0, 0, 0, 0, 0, 0, 0xaa, 0xbb]));
let pending = "";
process.stdin.on("data", (chunk) => {
  pending += chunk;
  let index;
  while ((index = pending.indexOf("\\n")) >= 0) {
    const line = pending.slice(0, index);
    if (JSON.parse(line).t === "probeArgs") json({ t: "args", args: process.argv.slice(2) });
    else json({ t: "echo", line });
    pending = pending.slice(index + 1);
  }
});
`;

const authLayer = (scopes: ReadonlyArray<AuthEnvironmentScope>) =>
  Layer.mock(EnvironmentAuth.EnvironmentAuth, {
    authenticateWebSocketUpgrade: () =>
      Effect.succeed({
        sessionId: AuthSessionId.make("screen-test"),
        subject: "screen-test",
        method: "bearer-access-token",
        scopes,
      }),
  });

const serve = (scopes: ReadonlyArray<AuthEnvironmentScope>, consentPath?: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "helm-screen-test-" });
    const helper = `${dir}/helm-screen`;
    yield* fs.writeFileString(helper, FAKE_HELPER);
    yield* fs.chmod(helper, 0o755);
    const hostEnvironment = yield* HostProcess.Environment;
    const services = yield* Layer.build(
      HttpRouter.serve(
        screenRemoteRouteLayer.pipe(
          Layer.provide(ServerConfig.layerTest(dir, { prefix: "screen" })),
          Layer.provide(platformLayer),
          Layer.provide(Layer.succeed(HostProcess.Platform, "darwin")),
          Layer.provide(
            Layer.succeed(HostProcess.Environment, {
              ...hostEnvironment,
              HELM_SCREEN_PATH: helper,
              HELM_SCREEN_UNLOCK_SETTINGS_PATH: consentPath,
            }),
          ),
        ),
        { disableListenLog: true },
      ).pipe(Layer.provideMerge(NodeHttpServer.layerTest), Layer.provide(authLayer(scopes))),
    );
    const server = Context.get(services, HttpServer.HttpServer);
    return `${HttpServer.formatAddress(server.address).replace(/^http/, "ws")}/api/helm/screen?wsTicket=t`;
  }).pipe(Effect.provide(NodeServices.layer));

it.effect("relays the helper's video and messages, and the phone's commands back", () =>
  Effect.gen(function* () {
    const url = yield* serve([AuthTerminalOperateScope]);
    const texts: unknown[] = [];
    const frames: Uint8Array[] = [];
    const echoed = Promise.withResolvers<void>();
    const socket = yield* Effect.acquireRelease(
      Effect.sync(() => new WebSocket(url)),
      (socket) => Effect.sync(() => socket.close()),
    );
    socket.binaryType = "arraybuffer";
    socket.addEventListener("error", () => echoed.reject(new Error("socket failed")));
    socket.addEventListener("open", () => socket.send(JSON.stringify({ t: "move", x: 1, y: 2 })));
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") {
        frames.push(new Uint8Array(event.data as ArrayBuffer));
        return;
      }
      const message = JSON.parse(event.data);
      texts.push(message);
      if (message.t === "echo") echoed.resolve();
    });
    yield* Effect.promise(() => echoed.promise);
    expect(texts).toEqual([
      { t: "info", width: 1512, height: 982 },
      { t: "echo", line: JSON.stringify({ t: "move", x: 1, y: 2 }) },
    ]);
    // The kind byte stays in front of the payload for the phone.
    expect(frames).toEqual([new Uint8Array([1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0xaa, 0xbb])]);
  }).pipe(Effect.scoped),
);

it.effect("refuses a session that can't drive a terminal", () =>
  Effect.gen(function* () {
    const url = yield* serve([AuthOrchestrationOperateScope]);
    const closed = Promise.withResolvers<boolean>();
    const socket = new WebSocket(url);
    socket.addEventListener("open", () => closed.resolve(true));
    socket.addEventListener("error", () => closed.resolve(false));
    expect(yield* Effect.promise(() => closed.promise)).toBe(false);
  }).pipe(Effect.scoped),
);

it.effect("passes only the desktop launcher's consent path to the helper", () =>
  Effect.gen(function* () {
    const path = "/tmp/local-desktop-consent.json";
    const url = yield* serve([AuthTerminalOperateScope], path);
    const received = Promise.withResolvers<unknown>();
    const socket = yield* Effect.acquireRelease(
      Effect.sync(() => new WebSocket(url)),
      (socket) => Effect.sync(() => socket.close()),
    );
    socket.addEventListener("error", () => received.reject(new Error("socket failed")));
    socket.addEventListener("open", () =>
      socket.send(JSON.stringify({ t: "probeArgs", settingsPath: "/tmp/phone-chosen.json" })),
    );
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      const value = JSON.parse(event.data);
      if (value.t === "args") received.resolve(value.args);
    });
    expect(yield* Effect.promise(() => received.promise)).toEqual(["--unlock-settings", path]);
  }).pipe(Effect.scoped),
);
