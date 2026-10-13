import * as NodeHttpServerRequest from "@effect/platform-node/NodeHttpServerRequest";
import { AuthTerminalOperateScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { authenticateMediaRequest } from "../auth/http.ts";
import * as ServerConfig from "../config.ts";

// Helm fork: the screen remote (experimental). The phone watches this Mac's screen and drives
// its mouse and keyboard. `native/helm-screen` captures and encodes (H.264) and posts the
// input; this route spawns one per phone and relays:
//   helper → phone: binary [u8 kind][payload] (1 video, 2 format), text JSON (info, cursor, error)
//   phone → helper: text JSON commands (start, move, button, scroll, key, text, keyframe)
// Driving the computer is as strong as a terminal, so it takes terminal:operate.
export const HELM_SCREEN_PATH = "/api/helm/screen";

/** Above this much unsent video the phone is falling behind: frames wait for a keyframe. */
const MAX_BUFFERED_BYTES = 2 * 1024 * 1024;
const MAX_COMMAND_BYTES = 64 * 1024;
const textDecoder = new TextDecoder();

/** The helper next to the bundled resource monitor, or the dev build in `native/`. */
export const resolveHelmScreenPath = Effect.fn("helm.screenRemote.resolvePath")(function* (
  config: ServerConfig.ServerConfig["Service"],
) {
  if (process.platform !== "darwin") return undefined;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const candidates = [
    process.env.HELM_SCREEN_PATH,
    config.resourceMonitorPath &&
      path.join(path.dirname(config.resourceMonitorPath), "helm-screen"),
    path.resolve(import.meta.dirname, "../../../../native/helm-screen/build/helm-screen"),
    path.resolve(import.meta.dirname, "../../../native/helm-screen/build/helm-screen"),
  ];
  for (const candidate of candidates) {
    if (candidate && (yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false)))) {
      return candidate;
    }
  }
  return undefined;
});

type Out =
  | { readonly _tag: "binary"; readonly data: Uint8Array }
  | { readonly _tag: "text"; readonly data: string };

const makeHandler = (
  helperPath: string | undefined,
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (request.headers.upgrade?.toLowerCase() !== "websocket") {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }
    yield* authenticateMediaRequest(AuthTerminalOperateScope);
    if (helperPath === undefined) {
      return HttpServerResponse.text("Screen remote is not available on this computer.", {
        status: 501,
      });
    }
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const output = yield* Queue.unbounded<Out>();
        const commands = yield* Queue.unbounded<string>();
        const helper = yield* spawner.spawn(ChildProcess.make(helperPath, []));
        yield* Stream.fromQueue(commands).pipe(
          Stream.map((line) => `${line}\n`),
          Stream.encodeText,
          Stream.run(helper.stdin),
          Effect.forkScoped,
        );
        yield* helper.stderr.pipe(
          Stream.decodeText,
          Stream.runForEach((text) => Effect.logDebug("helm-screen", { text })),
          Effect.ignore,
          Effect.forkScoped,
        );
        // stdout is [u8 kind][u32 length][payload]; kind 10 is JSON, the rest goes as binary.
        let pending = Buffer.alloc(0);
        const readFrames = (chunk: Uint8Array) =>
          Effect.sync(() => {
            pending = Buffer.concat([pending, chunk]);
            while (pending.length >= 5) {
              const length = pending.readUInt32BE(1);
              if (pending.length < 5 + length) break;
              const kind = pending[0]!;
              const payload = pending.subarray(5, 5 + length);
              Queue.offerUnsafe(
                output,
                kind === 10
                  ? { _tag: "text", data: payload.toString("utf8") }
                  : {
                      _tag: "binary",
                      data: new Uint8Array(Buffer.concat([pending.subarray(0, 1), payload])),
                    },
              );
              pending = pending.subarray(5 + length);
            }
          });
        // The helper ends when its display goes away or capture fails; the phone then sees it close.
        const helperDone = helper.stdout.pipe(Stream.runForEach(readFrames), Effect.ignore);
        const command = (line: string) => Queue.offer(commands, line).pipe(Effect.asVoid);

        // Video is already compressed; no deflate, and the socket buffer stays the one we watch.
        const incoming = NodeHttpServerRequest.toIncomingMessage(request);
        delete incoming.headers["sec-websocket-extensions"];
        const transport = incoming.socket;
        const socket = yield* request.upgrade;
        const reader = yield* socket.reader;
        const writer = yield* socket.writer;

        // A phone that falls behind skips video until the next keyframe, which it gets at once.
        let skipping = false;
        const send = Queue.take(output).pipe(
          Effect.flatMap((out) => {
            if (out._tag === "text") return writer.write(out.data);
            const kind = out.data[0];
            if (kind === 1) {
              const keyframe = (out.data[1]! & 1) === 1;
              if (transport.writableLength > MAX_BUFFERED_BYTES) {
                if (!skipping) {
                  skipping = true;
                  return command(JSON.stringify({ t: "keyframe" }));
                }
                return Effect.void;
              }
              if (skipping && !keyframe) return Effect.void;
              skipping = false;
            }
            return writer.write(out.data);
          }),
        );
        const receive = (chunk: Uint8Array | string) => {
          const text = typeof chunk === "string" ? chunk : textDecoder.decode(chunk);
          if (text.length > MAX_COMMAND_BYTES || text.includes("\n")) return Effect.void;
          return command(text);
        };
        const receiveInput = reader.pull.pipe(
          Effect.flatMap((chunks) => Effect.forEach(chunks, receive, { discard: true })),
        );
        yield* Effect.logInfo("helm screen remote: phone connected");
        return yield* Effect.raceFirst(
          Effect.raceFirst(Effect.forever(send), Effect.forever(receiveInput)),
          helperDone,
        ).pipe(Effect.as(HttpServerResponse.empty()));
      }),
    ).pipe(
      // A dropped socket is a normal end of watching.
      Effect.orElseSucceed(() => HttpServerResponse.empty()),
      Effect.ensuring(Effect.logInfo("helm screen remote: phone left")),
    );
  });

export const screenRemoteRouteLayer = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const helperPath = yield* resolveHelmScreenPath(config);
    yield* router.add("GET", HELM_SCREEN_PATH, makeHandler(helperPath, spawner));
  }),
);
