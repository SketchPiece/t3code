import type { VoiceInputState } from "@t3tools/client-runtime/voice-input";
import { CheckIcon, MicIcon, RotateCwIcon, XIcon } from "lucide-react";
import { memo, useEffect, useState, type PointerEvent } from "react";

import type { BrowserVoiceRecorder } from "~/lib/browserVoiceRecorder";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const LEVEL_BAR_COUNT = 5;
// The meter repaints from React state, so keep it well under the display rate.
const LEVEL_SAMPLE_INTERVAL_MS = 100;

const keepEditorFocus = (event: PointerEvent<HTMLElement>) => event.preventDefault();

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export const ComposerDictationButton = memo(function ComposerDictationButton(props: {
  disabled: boolean;
  onStart: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={props.disabled}
            onPointerDown={keepEditorFocus}
            onClick={props.onStart}
            aria-label="Dictate"
          />
        }
      >
        <MicIcon />
      </TooltipTrigger>
      <TooltipPopup>Dictate</TooltipPopup>
    </Tooltip>
  );
});

/** Elapsed time and input level, sampled from the recorder while it records. */
function DictationRecordingStatus({ recorder }: { recorder: BrowserVoiceRecorder }) {
  const [sample, setSample] = useState(() => ({
    elapsedMs: 0,
    levels: Array<number>(LEVEL_BAR_COUNT).fill(0),
  }));

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      const level = recorder.readLevel();
      setSample((previous) => ({
        elapsedMs: recorder.elapsedMs(),
        levels: [...previous.levels.slice(1), level],
      }));
    }, LEVEL_SAMPLE_INTERVAL_MS);
    return () => window.clearInterval(intervalId);
  }, [recorder]);

  return (
    <div className="flex min-w-0 flex-1 items-center justify-center gap-2.5">
      <span className="size-2 shrink-0 rounded-full bg-destructive" aria-hidden="true" />
      <span className="text-sm text-foreground tabular-nums">
        {formatElapsed(sample.elapsedMs)}
      </span>
      <div className="flex h-4 items-center gap-0.5" aria-hidden="true">
        {sample.levels.map((level, index) => (
          <span
            // Fixed-length rolling window; position is the identity.
            // oxlint-disable-next-line react/no-array-index-key
            key={index}
            className="w-1 rounded-full bg-muted-foreground"
            style={{ height: `${Math.round(20 + level * 80)}%` }}
          />
        ))}
      </div>
    </div>
  );
}

/** Replaces the composer's action row while dictation records, transcribes, or failed. */
export const ComposerDictationBar = memo(function ComposerDictationBar(props: {
  state: VoiceInputState;
  recorder: BrowserVoiceRecorder | null;
  onCancel: () => void;
  onStop: () => void;
  onRetry: () => void;
}) {
  const { state, onCancel } = props;
  const isCapturing = state.phase === "preparing" || state.phase === "recording";

  useEffect(() => {
    if (!isCapturing) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [isCapturing, onCancel]);

  const cancelButton = (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      onPointerDown={keepEditorFocus}
      onClick={onCancel}
      aria-label={state.phase === "error" ? "Dismiss" : "Cancel dictation"}
    >
      <XIcon />
    </Button>
  );

  return (
    <div
      data-chat-composer-dictation="true"
      className="flex min-w-0 flex-1 items-center gap-2"
      role="group"
      aria-label="Dictation"
    >
      {cancelButton}
      {state.phase === "recording" && props.recorder ? (
        <DictationRecordingStatus recorder={props.recorder} />
      ) : state.phase === "error" ? (
        <p className="min-w-0 flex-1 truncate text-center text-sm text-destructive" role="alert">
          {state.error}
        </p>
      ) : (
        <div className="flex min-w-0 flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
          <Spinner size="sm" aria-hidden="true" />
          <span>{state.phase === "transcribing" ? "Transcribing…" : "Starting microphone…"}</span>
        </div>
      )}
      {state.phase === "error" ? (
        state.errorAction === "retry" ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  onPointerDown={keepEditorFocus}
                  onClick={props.onRetry}
                  aria-label="Retry"
                />
              }
            >
              <RotateCwIcon />
            </TooltipTrigger>
            <TooltipPopup>Retry</TooltipPopup>
          </Tooltip>
        ) : null
      ) : (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                size="icon-sm"
                disabled={state.phase !== "recording"}
                onPointerDown={keepEditorFocus}
                onClick={props.onStop}
                aria-label="Insert transcript"
              />
            }
          >
            <CheckIcon />
          </TooltipTrigger>
          <TooltipPopup>Insert transcript</TooltipPopup>
        </Tooltip>
      )}
    </div>
  );
});
