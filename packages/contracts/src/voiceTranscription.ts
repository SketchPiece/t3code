import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

// Helm fork: dictation. The client uploads the clip through attachments.createUploadUrl,
// then asks the server to transcribe that pending attachment; the server deletes it after.
export const VoiceTranscribeInput = Schema.Struct({
  attachmentId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  /** Thread the dictation is for; its project and branch become recognition hints. */
  threadId: Schema.optional(ThreadId),
  /** Recording length by the client's clock, for usage accounting. */
  durationSeconds: Schema.optional(Schema.Number.check(Schema.isGreaterThan(0))),
});
export type VoiceTranscribeInput = typeof VoiceTranscribeInput.Type;

export const VoiceTranscribeResult = Schema.Struct({
  text: Schema.String,
});
export type VoiceTranscribeResult = typeof VoiceTranscribeResult.Type;

export const VoiceTranscribeErrorReason = Schema.Literals([
  "unavailable",
  "not-found",
  "too-large",
  "failed",
]);
export type VoiceTranscribeErrorReason = typeof VoiceTranscribeErrorReason.Type;

export class VoiceTranscribeError extends Schema.TaggedError<VoiceTranscribeError>()(
  "VoiceTranscribeError",
  {
    reason: VoiceTranscribeErrorReason,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "unavailable":
        return "Voice transcription is not configured on this server.";
      case "not-found":
        return "The recording was not found on the server.";
      case "too-large":
        return "The recording is too long to transcribe.";
      case "failed":
        return "Transcription failed.";
    }
  }
}
