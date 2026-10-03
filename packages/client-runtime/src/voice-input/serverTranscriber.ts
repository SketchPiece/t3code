import type { VoiceTranscriber } from "./transcription.ts";

/**
 * Helm fork: transcription by the connected server (voice.transcribe), which recognizes
 * Russian and English in one take. Uploading the clip is platform-specific, so each
 * client passes its own `uploadRecording`; the upload returns the pending attachment id.
 */
export function createServerVoiceTranscriber(input: {
  readonly uploadRecording: (uri: string, signal: AbortSignal) => Promise<string>;
  readonly transcribeAttachment: (attachmentId: string, signal: AbortSignal) => Promise<string>;
}): VoiceTranscriber {
  return {
    prepare: async () => ({
      // The server is told the spoken languages itself; this only picks word spacing.
      locale: "ru",
      transcribe: async (uri, { signal }) =>
        input.transcribeAttachment(await input.uploadRecording(uri, signal), signal),
    }),
  };
}
