import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import {
  deletePendingAttachmentUpload,
  runAttachmentUploadCycle,
} from "@t3tools/client-runtime/state/attachments";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { createVoiceTranscriptionEnvironmentAtoms } from "@t3tools/client-runtime/state/voiceTranscription";
import {
  createServerVoiceTranscriber,
  VoiceTranscriptionError,
  type VoiceTranscriber,
} from "@t3tools/client-runtime/voice-input";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";

import { connectionAtomRuntime } from "../../src/connection/runtime";
import { appAtomRegistry } from "../../src/state/atom-registry";
import { attachmentEnvironment } from "../../src/state/attachments";
import { environmentSession } from "../../src/state/session";

const voiceEnvironment = createVoiceTranscriptionEnvironmentAtoms(connectionAtomRuntime);

/**
 * Dictation recognized by the connected Helm server (Russian and English in one take).
 * expo-audio records AAC in an .m4a container, which the server forwards as is.
 */
export function serverVoiceTranscriber(target: {
  readonly environmentId: EnvironmentId;
  readonly threadId?: ThreadId;
}): VoiceTranscriber {
  const { environmentId } = target;
  return createServerVoiceTranscriber({
    uploadRecording: async (uri, signal) => {
      const { File, UploadType } = await import("expo-file-system");
      const file = new File(uri);
      const result = await runAttachmentUploadCycle({
        registry: appAtomRegistry,
        createUploadUrl: attachmentEnvironment.createUploadUrl,
        remove: attachmentEnvironment.remove,
        environmentId,
        upload: {
          type: "file",
          name: "dictation.m4a",
          mimeType: "audio/mp4",
          sizeBytes: file.size,
        },
        resolveUploadUrl: (relativeUrl) => {
          const connection = appAtomRegistry.get(
            environmentSession.preparedConnectionValueAtom(environmentId),
          );
          return Option.isNone(connection)
            ? null
            : resolveAssetUrl(connection.value.httpBaseUrl, relativeUrl);
        },
        transport: (url) => {
          const abort = new AbortController();
          signal.addEventListener("abort", () => abort.abort(), { once: true });
          return {
            abort: () => abort.abort(),
            done: file
              .upload(url, {
                httpMethod: "POST",
                uploadType: UploadType.BINARY_CONTENT,
                headers: { "Content-Type": "audio/mp4" },
                signal: abort.signal,
              })
              .then((response) => {
                if (response.status < 200 || response.status >= 300) {
                  throw new Error(`Recording upload failed (${response.status}).`);
                }
              }),
          };
        },
        onMinted: () => (signal.aborted ? "cancel" : "continue"),
      });
      if (result.status !== "uploaded") {
        if (result.attachmentId !== null && result.status === "failed") {
          deletePendingAttachmentUpload({
            registry: appAtomRegistry,
            remove: attachmentEnvironment.remove,
            environmentId,
            attachmentId: result.attachmentId,
          });
        }
        throw new VoiceTranscriptionError(
          result.status === "cancelled" ? "cancelled" : "transcription-failed",
          "Could not upload the recording.",
          result.status === "failed" ? { cause: result.error } : undefined,
        );
      }
      return result.attachmentId;
    },
    transcribeAttachment: async (attachmentId, signal) => {
      const result = await runAtomCommand(
        appAtomRegistry,
        voiceEnvironment.transcribe,
        {
          environmentId,
          input: { attachmentId, ...(target.threadId ? { threadId: target.threadId } : {}) },
        },
        { reportFailure: false },
      );
      if (signal.aborted) {
        throw new VoiceTranscriptionError("cancelled", "Voice transcription was cancelled.");
      }
      if (result._tag !== "Success") {
        throw new VoiceTranscriptionError("transcription-failed", "Voice transcription failed.", {
          cause: squashAtomCommandFailure(result),
        });
      }
      return result.value.text;
    },
  });
}
