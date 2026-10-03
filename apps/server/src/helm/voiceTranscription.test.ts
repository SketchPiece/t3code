import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import { createPendingAttachmentId } from "../attachmentStore.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { transcribeVoice } from "./voiceTranscription.ts";

interface SentRequest {
  readonly url: string;
  readonly authorization: string | undefined;
  readonly form: FormData;
}

const secretsLayer = (helmPush: string | null) =>
  Layer.succeed(ServerSecretStore.ServerSecretStore, {
    get: () =>
      Effect.succeed(
        helmPush === null ? Option.none() : Option.some(new TextEncoder().encode(helmPush)),
      ),
  } as unknown as ServerSecretStore.ServerSecretStore["Service"]);

const coreLayer = (sent: Array<SentRequest>, response: () => Response) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        if (request.body._tag === "FormData") {
          sent.push({
            url: request.url,
            authorization: request.headers.authorization,
            form: request.body.formData,
          });
        }
        return HttpClientResponse.fromWeb(request, response());
      }),
    ),
  );

const CORE = '{"url":"https://core.example.app/","token":"server-token"}';

const testLayer = (helmPush: string | null, sent: Array<SentRequest>, response: () => Response) =>
  Layer.mergeAll(
    secretsLayer(helmPush),
    coreLayer(sent, response),
    ServerConfig.layerTest(process.cwd(), { prefix: "helm-voice-test-" }),
  ).pipe(Layer.provideMerge(NodeServices.layer));

/** Writes a pending clip the way the upload route stores one and returns its id and path. */
const storeClip = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const attachmentId = createPendingAttachmentId(".m4a");
  const filePath = path.join(config.attachmentsDir, `${attachmentId}.m4a`);
  yield* fileSystem.makeDirectory(config.attachmentsDir, { recursive: true });
  yield* fileSystem.writeFile(filePath, new Uint8Array([1, 2, 3]));
  return { attachmentId, filePath };
});

describe("transcribeVoice", () => {
  const sent: Array<SentRequest> = [];

  it.effect(
    "forwards the clip to the Volna core with hints, returns its text and deletes the clip",
    () =>
      Effect.gen(function* () {
        const { attachmentId, filePath } = yield* storeClip;
        const result = yield* transcribeVoice({ attachmentId, durationSeconds: 4 }, [
          "t3code",
          "helm-voice",
          "t3code",
        ]);
        assert.deepStrictEqual(result, { text: "Сделай commit" });

        const [request] = sent;
        assert.strictEqual(request?.url, "https://core.example.app/helm/v1/transcriptions");
        assert.strictEqual(request?.authorization, "Bearer server-token");
        assert.deepStrictEqual(request?.form.getAll("languages[]"), ["ru", "en"]);
        const keywords = request?.form.getAll("keywords[]") ?? [];
        // The thread's own names lead, then the fixed coding words, without repeats.
        assert.deepStrictEqual(keywords.slice(0, 2), ["t3code", "helm-voice"]);
        assert.include(keywords, "pull request");
        assert.strictEqual(new Set(keywords).size, keywords.length);
        assert.strictEqual(request?.form.get("seconds"), "4");
        const file = request?.form.get("file");
        assert.instanceOf(file, File);
        assert.strictEqual((file as File).name, "audio.m4a");
        assert.strictEqual((file as File).type, "audio/mp4");

        const fileSystem = yield* FileSystem.FileSystem;
        assert.isFalse(yield* fileSystem.exists(filePath));
      }).pipe(
        Effect.provide(testLayer(CORE, sent, () => Response.json({ text: "Сделай commit" }))),
      ),
  );

  it.effect(
    "tells a missing core, a missing clip and a failing core apart, and still deletes the clip",
    () =>
      Effect.gen(function* () {
        const { attachmentId, filePath } = yield* storeClip;
        const failed = yield* Effect.flip(transcribeVoice({ attachmentId }, []));
        assert.strictEqual(failed.reason, "failed");
        const fileSystem = yield* FileSystem.FileSystem;
        assert.isFalse(yield* fileSystem.exists(filePath));

        const missing = yield* Effect.flip(transcribeVoice({ attachmentId }, []));
        assert.strictEqual(missing.reason, "not-found");
      }).pipe(Effect.provide(testLayer(CORE, [], () => new Response("busy", { status: 502 })))),
  );

  it.effect("is unavailable without the helm-push secret", () =>
    Effect.gen(function* () {
      const { attachmentId } = yield* storeClip;
      const unavailable = yield* Effect.flip(transcribeVoice({ attachmentId }, []));
      assert.strictEqual(unavailable.reason, "unavailable");
    }).pipe(Effect.provide(testLayer(null, [], () => Response.json({ text: "" })))),
  );
});
