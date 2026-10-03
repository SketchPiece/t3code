import { VoiceTranscribeError, type VoiceTranscribeInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import {
  parseThreadSegmentFromAttachmentId,
  PENDING_ATTACHMENT_THREAD_SEGMENT,
  resolveAttachmentPathById,
} from "../attachmentStore.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { readHelmPushConfig } from "./pushConfig.ts";

// Helm fork: dictation is transcribed by the Volna core (POST /helm/v1/transcriptions),
// which holds the OpenAI key; this server only forwards the clip with its server token.
// Spoken languages are fixed to the owner's two; keywords come from the thread plus
// the coding words a Russian speaker says in English, so they stay in Latin script.
const LANGUAGES = ["ru", "en"];
const CODING_KEYWORDS = [
  "commit",
  "push",
  "pull request",
  "PR",
  "merge",
  "rebase",
  "branch",
  "main",
  "worktree",
  "diff",
  "review",
  "deploy",
  "build",
  "release",
  "bug",
  "fix",
  "feature",
  "refactor",
  "test",
  "lint",
  "typecheck",
  "API",
  "endpoint",
  "backend",
  "frontend",
  "server",
  "client",
  "mobile",
  "desktop",
  "web",
  "UI",
  "UX",
  "README",
  "TypeScript",
  "React",
  "React Native",
  "Effect",
  "useEffect",
  "useState",
  "props",
  "state",
  "hook",
  "component",
  "GitHub",
  "Railway",
  "Codex",
  "Claude",
  "Helm",
];
const MIME_BY_EXTENSION: Record<string, string> = {
  ".m4a": "audio/mp4",
  ".mp4": "audio/mp4",
  ".webm": "audio/webm",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
};

const TranscriptionResponse = Schema.Struct({ text: Schema.String });
const decodeTranscriptionResponse = Schema.decodeUnknownEffect(TranscriptionResponse);

/** Transcribes a pending uploaded clip and deletes it, whatever the outcome. */
export const transcribeVoice = Effect.fn("HelmVoice.transcribe")(function* (
  input: VoiceTranscribeInput,
  keywords: ReadonlyArray<string>,
) {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const core = yield* readHelmPushConfig(secrets);
  if (core === null) {
    return yield* new VoiceTranscribeError({ reason: "unavailable" });
  }
  if (
    parseThreadSegmentFromAttachmentId(input.attachmentId) !== PENDING_ATTACHMENT_THREAD_SEGMENT
  ) {
    return yield* new VoiceTranscribeError({ reason: "not-found" });
  }
  const config = yield* ServerConfig.ServerConfig;
  const filePath = resolveAttachmentPathById({
    attachmentsDir: config.attachmentsDir,
    attachmentId: input.attachmentId,
  });
  if (filePath === null) {
    return yield* new VoiceTranscribeError({ reason: "not-found" });
  }

  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* Effect.gen(function* () {
    const bytes = yield* fileSystem.readFile(filePath);
    const extension = path.extname(filePath).toLowerCase();
    const form = new FormData();
    form.set(
      "file",
      new Blob([bytes], { type: MIME_BY_EXTENSION[extension] ?? "application/octet-stream" }),
      `audio${extension}`,
    );
    for (const language of LANGUAGES) form.append("languages[]", language);
    for (const keyword of new Set([...keywords, ...CODING_KEYWORDS])) {
      form.append("keywords[]", keyword);
    }
    if (input.durationSeconds !== undefined) form.set("seconds", String(input.durationSeconds));

    const client = yield* HttpClient.HttpClient;
    const response = yield* client
      .execute(
        HttpClientRequest.post(`${core.url}/v1/transcriptions`).pipe(
          HttpClientRequest.bearerToken(core.token),
          HttpClientRequest.bodyFormData(form),
        ),
      )
      .pipe(Effect.timeout("90 seconds"));
    if (response.status === 413) {
      return yield* new VoiceTranscribeError({ reason: "too-large" });
    }
    if (response.status === 503) {
      return yield* new VoiceTranscribeError({ reason: "unavailable" });
    }
    if (response.status < 200 || response.status >= 300) {
      return yield* new VoiceTranscribeError({
        reason: "failed",
        cause: `Volna core answered ${response.status}.`,
      });
    }
    return yield* decodeTranscriptionResponse(yield* response.json);
  }).pipe(
    Effect.mapError((cause) =>
      Schema.is(VoiceTranscribeError)(cause)
        ? cause
        : new VoiceTranscribeError({ reason: "failed", cause }),
    ),
    Effect.ensuring(fileSystem.remove(filePath, { force: true }).pipe(Effect.ignore)),
  );
});
