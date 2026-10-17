// @effect-diagnostics nodeBuiltinImport:off globalTimers:off
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { authEvents, listenForSudo, respond } from "./authBridge.ts";

const socketPath = () =>
  NodePath.join(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "helm-auth-")), "sudo.sock");

/** What pam_helm does: one JSON line up, one back. */
function askSudo(path: string, command: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = NodeNet.connect(path, () => {
      const request = {
        type: "sudo",
        nonce: "bm9uY2U=",
        user: "me",
        host: "mac",
        command,
        timeout: 5,
      };
      socket.write(`${JSON.stringify(request)}\n`);
    });
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => (buffer += chunk));
    socket.on("end", () => resolve(JSON.parse(buffer.trim())));
    socket.on("error", reject);
  });
}

const listening = (server: NodeNet.Server) =>
  new Promise<void>((resolve) =>
    server.listening ? resolve() : server.once("listening", () => resolve()),
  );

describe("helm auth bridge", () => {
  it.effect("without a phone listening, sudo goes straight on to the password", () =>
    Effect.promise(async () => {
      const path = socketPath();
      const server = listenForSudo(path);
      await listening(server);
      const reply = await askSudo(path, "sudo true");
      server.close();
      assert.deepStrictEqual(reply, { status: "unavailable" });
    }),
  );

  it.effect("passes the phone's signature back to sudo and tells the phone it's done", () =>
    Effect.gen(function* () {
      const path = socketPath();
      const server = listenForSudo(path);
      yield* Effect.promise(() => listening(server));
      let reply: Promise<Record<string, unknown>> | undefined;
      const events = yield* authEvents.pipe(
        Stream.tap((event) => {
          if (event.type === "snapshot") {
            reply = askSudo(path, "sudo brew services restart nginx");
            return Effect.void;
          }
          if (event.type === "added") {
            return respond({ id: event.request.id, action: "approve", signature: "c2ln" });
          }
          return Effect.void;
        }),
        Stream.take(3),
        Stream.runCollect,
      );
      const answer = yield* Effect.promise(() => reply!);
      server.close();
      const [, added, removed] = events;
      assert.deepStrictEqual(
        added?.type === "added" ? [added.request.title, added.request.sudo?.nonce] : null,
        ["brew services restart nginx", "bm9uY2U="],
      );
      assert.deepStrictEqual(removed?.type === "removed" ? removed.outcome : null, "approved");
      assert.deepStrictEqual(answer, { status: "approved", signature: "c2ln" });
    }),
  );
});
