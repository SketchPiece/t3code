import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import {
  deletePendingAttachmentUpload,
  runAttachmentUploadCycle,
} from "@t3tools/client-runtime/state/attachments";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  createServerVoiceTranscriber,
  VoiceInputController,
  voiceInputBlocksSubmission,
  type VoiceDraftSnapshot,
  type VoiceInputState,
} from "@t3tools/client-runtime/voice-input";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { BrowserVoiceRecorder } from "~/lib/browserVoiceRecorder";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { attachmentEnvironment } from "~/state/attachments";
import { readPreparedConnection } from "~/state/session";
import { voiceTranscriptionEnvironment } from "~/state/voiceTranscription";

const IDLE_STATE: VoiceInputState = { phase: "idle", error: null, errorAction: null };

/** Rejects as soon as the signal aborts, so a cancelled take frees the transcription slot. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("Voice transcription was cancelled."));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("Voice transcription was cancelled."));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

async function uploadVoiceRecording(
  environmentId: EnvironmentId,
  recording: { readonly blob: Blob; readonly mimeType: string; readonly fileName: string },
  signal: AbortSignal,
): Promise<string> {
  const result = await runAttachmentUploadCycle({
    registry: appAtomRegistry,
    createUploadUrl: attachmentEnvironment.createUploadUrl,
    remove: attachmentEnvironment.remove,
    environmentId,
    upload: {
      type: "file",
      name: recording.fileName,
      mimeType: recording.mimeType,
      sizeBytes: recording.blob.size,
    },
    resolveUploadUrl: (relativeUrl) => {
      const connection = readPreparedConnection(environmentId);
      return connection ? resolveAssetUrl(connection.httpBaseUrl, relativeUrl) : null;
    },
    onMinted: () => (signal.aborted ? "cancel" : "continue"),
    transport: (url) => {
      const controller = new AbortController();
      return {
        abort: () => controller.abort(),
        done: fetch(url, {
          method: "POST",
          headers: { "Content-Type": recording.mimeType },
          body: recording.blob,
          signal: AbortSignal.any([controller.signal, signal]),
        }).then((response) => {
          if (!response.ok) throw new Error(`Recording upload rejected (${response.status}).`);
        }),
      };
    },
  });
  if (result.status === "uploaded") return result.attachmentId;
  if (result.attachmentId && result.status === "failed") {
    deletePendingAttachmentUpload({
      registry: appAtomRegistry,
      remove: attachmentEnvironment.remove,
      environmentId,
      attachmentId: result.attachmentId,
    });
  }
  throw result.status === "failed" ? result.error : new Error("Recording upload was cancelled.");
}

type ComposerVoiceInput = {
  /** Identifies the draft; a change cancels a running take. */
  readonly ownerKey: string;
  readonly environmentId: EnvironmentId;
  /** Server thread the draft belongs to, used as recognition hints. */
  readonly threadId: ThreadId | null;
  readonly readPrompt: () => string;
  readonly readSelection: () => { readonly start: number; readonly end: number };
  readonly commitPrompt: (
    text: string,
    selection: { readonly start: number; readonly end: number },
  ) => void;
};

function createComposerVoiceSession(input: {
  readonly latestInput: { readonly current: ComposerVoiceInput };
  readonly onStateChange: (state: VoiceInputState) => void;
}) {
  // The recorder reports auto-stop and mic loss to the controller created below.
  let controller: VoiceInputController | null = null;
  const recorder = new BrowserVoiceRecorder((status) => controller?.handleRecorderStatus(status));
  // Recording length by attachment, reported with the transcription for usage accounting.
  const durationByAttachmentId = new Map<string, number>();
  const transcriber = createServerVoiceTranscriber({
    uploadRecording: async (uri, signal) => {
      const recording = recorder.getRecording(uri);
      if (!recording) throw new Error("The recording is no longer available.");
      const attachmentId = await abortable(
        uploadVoiceRecording(
          input.latestInput.current.environmentId,
          {
            blob: recording.blob,
            mimeType: recording.format.mimeType,
            fileName: recording.format.fileName,
          },
          signal,
        ),
        signal,
      );
      durationByAttachmentId.set(attachmentId, recording.durationSeconds);
      return attachmentId;
    },
    transcribeAttachment: async (attachmentId, signal) => {
      const { environmentId, threadId } = input.latestInput.current;
      // The server deletes the clip after one attempt; a retry uploads it again.
      const durationSeconds = durationByAttachmentId.get(attachmentId);
      durationByAttachmentId.delete(attachmentId);
      const result = await abortable(
        runAtomCommand(
          appAtomRegistry,
          voiceTranscriptionEnvironment.transcribe,
          {
            environmentId,
            input: {
              attachmentId,
              ...(threadId ? { threadId } : {}),
              ...(durationSeconds ? { durationSeconds } : {}),
            },
          },
          { reportFailure: false },
        ),
        signal,
      );
      if (result._tag !== "Success") throw squashAtomCommandFailure(result);
      return result.value.text;
    },
  });
  controller = new VoiceInputController({
    recorder,
    getTranscriber: () => transcriber,
    requestPermission: async () => {
      try {
        await recorder.acquire();
        return { granted: true, canAskAgain: true };
      } catch {
        // Browsers re-prompt after the user changes the site permission, so retry stays useful.
        return { granted: false, canAskAgain: true };
      }
    },
    configureRecording: () => recorder.acquire(),
    releaseRecording: async () => recorder.release(),
    deleteRecording: (uri) => recorder.deleteRecording(uri),
    readDraft: (): VoiceDraftSnapshot => {
      const current = input.latestInput.current;
      return {
        ownerKey: current.ownerKey,
        text: current.readPrompt(),
        selection: current.readSelection(),
        // The editor is read-only while dictation runs, so the text alone tells a stale draft.
        revision: 0,
      };
    },
    commitDraft: (text, selection) => input.latestInput.current.commitPrompt(text, selection),
    onStateChange: (next) => {
      // Close the microphone on every way out, including a take cancelled while
      // permission was still being asked, before the controller owned the stream.
      if (next.phase === "idle" || next.phase === "error") recorder.release();
      input.onStateChange(next);
    },
  });
  return { recorder, controller };
}

/**
 * Dictation for the web composer: records with MediaRecorder, transcribes on the
 * connected server, and inserts the transcript at the caret of the draft it started in.
 */
export function useComposerVoiceInput(input: ComposerVoiceInput) {
  const [state, setState] = useState<VoiceInputState>(IDLE_STATE);
  const latestInputRef = useRef(input);
  useLayoutEffect(() => {
    latestInputRef.current = input;
  });
  const [{ recorder, controller }] = useState(() =>
    createComposerVoiceSession({
      latestInput: latestInputRef,
      onStateChange: setState,
    }),
  );

  const previousOwnerRef = useRef(input.ownerKey);
  useEffect(() => {
    if (previousOwnerRef.current === input.ownerKey) return;
    previousOwnerRef.current = input.ownerKey;
    controller.ownerChanged();
  }, [controller, input.ownerKey]);

  useEffect(
    () => () => {
      controller.dispose();
      recorder.dispose();
    },
    [controller, recorder],
  );

  const start = useCallback(() => void controller.start(), [controller]);
  const stop = useCallback(() => void controller.stop("insert"), [controller]);
  const retry = useCallback(() => void controller.retry(), [controller]);
  const cancel = useCallback(() => controller.cancel(), [controller]);

  return {
    state,
    recorder,
    isActive: state.phase !== "idle",
    blocksSubmission: voiceInputBlocksSubmission(state),
    start,
    stop,
    retry,
    cancel,
  };
}
