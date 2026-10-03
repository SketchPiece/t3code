import type { VoiceInputState } from "@t3tools/client-runtime/voice-input";

export type VoiceComposerPresentation = {
  readonly leadingAction: "cancel" | null;
  /** "retry" transcribes a kept take again (or records anew when none was kept). */
  readonly trailingAction: "mic" | "confirm" | "retry";
  readonly showsSend: boolean;
  readonly statusKind: "active" | "error" | null;
  readonly statusLabel: string | null;
  readonly confirmationEnabled: boolean;
};

export function resolveVoiceComposerPresentation(
  state: VoiceInputState,
  elapsedSeconds: number,
): VoiceComposerPresentation {
  switch (state.phase) {
    case "idle":
      return {
        leadingAction: null,
        trailingAction: "mic",
        showsSend: true,
        statusKind: null,
        statusLabel: null,
        confirmationEnabled: false,
      };
    case "error":
      // A failed take keeps the dictation bar: dismiss on the left, retry on the right.
      // Missing microphone access keeps the mic, which opens Settings.
      return state.errorAction === "retry"
        ? {
            leadingAction: "cancel",
            trailingAction: "retry",
            showsSend: false,
            statusKind: "error",
            statusLabel: state.error,
            confirmationEnabled: false,
          }
        : {
            leadingAction: null,
            trailingAction: "mic",
            showsSend: true,
            statusKind: "error",
            statusLabel: state.error,
            confirmationEnabled: false,
          };
    case "preparing":
      return {
        leadingAction: "cancel",
        trailingAction: "confirm",
        showsSend: false,
        statusKind: "active",
        statusLabel: "Preparing",
        confirmationEnabled: false,
      };
    case "recording": {
      const seconds = Math.max(0, Math.floor(elapsedSeconds));
      return {
        leadingAction: "cancel",
        trailingAction: "confirm",
        showsSend: false,
        statusKind: "active",
        statusLabel: `Recording ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`,
        confirmationEnabled: true,
      };
    }
    case "transcribing":
      return {
        leadingAction: "cancel",
        trailingAction: "confirm",
        showsSend: false,
        statusKind: "active",
        statusLabel: "Transcribing",
        confirmationEnabled: false,
      };
  }
}
