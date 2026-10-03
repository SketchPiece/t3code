import type { VoiceInputPhase } from "@t3tools/client-runtime/voice-input";

/** A press shorter than this is a tap: recording continues until ✓. */
export const HOLD_TO_TALK_TAP_MS = 300;
/** Sliding this far left onto ✕ arms cancel. */
export const HOLD_TO_TALK_CANCEL_DX = -72;

export type HoldToTalkMode = "idle" | "holding" | "tap";

/** What lifting the finger does after a hold that started recording. */
export function resolveHoldRelease(input: {
  readonly heldMs: number;
  readonly dx: number;
  readonly phase: VoiceInputPhase;
}): "tap" | "send" | "cancel" {
  if (input.heldMs < HOLD_TO_TALK_TAP_MS) return "tap";
  if (input.dx < HOLD_TO_TALK_CANCEL_DX) return "cancel";
  // Released before the microphone opened (a slow permission check): nothing to send.
  return input.phase === "recording" ? "send" : "cancel";
}
