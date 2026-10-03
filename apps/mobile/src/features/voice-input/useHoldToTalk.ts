import type { VoiceFinishIntent, VoiceInputPhase } from "@t3tools/client-runtime/voice-input";
import { useEffect, useMemo, useRef, useState } from "react";
import { PanResponder } from "react-native";

import {
  HOLD_TO_TALK_CANCEL_DX,
  resolveHoldRelease,
  type HoldToTalkMode,
} from "./holdToTalkRelease";

/**
 * ChatGPT-style press on the composer's mic: hold to record and release to send, slide
 * left to cancel, or tap to record hands-free and finish with ✓. The same handlers go on
 * every mounted copy of the mic (compact strip and expanded toolbar) because a hold keeps
 * its responder on the view it started on even after the toolbar flips to dictation.
 */
export function useHoldToTalk(input: {
  /** The mic is showing and at rest, so a press starts a recording. */
  readonly enabled: boolean;
  readonly phase: VoiceInputPhase;
  readonly start: () => void;
  readonly stop: (intent: VoiceFinishIntent) => void;
  readonly cancel: () => void;
}) {
  const [mode, setMode] = useState<HoldToTalkMode>("idle");
  const [cancelArmed, setCancelArmed] = useState(false);
  const latestRef = useRef(input);
  latestRef.current = input;
  const pressedAtRef = useRef(0);

  // Back at rest (sent, cancelled, failed): the next press starts fresh.
  useEffect(() => {
    if (input.phase === "preparing" || input.phase === "recording") return;
    setMode("idle");
    setCancelArmed(false);
  }, [input.phase]);

  const panHandlers = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => latestRef.current.enabled,
        // A scroll view must not steal a hold that is recording.
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: () => {
          pressedAtRef.current = Date.now();
          setMode("holding");
          setCancelArmed(false);
          latestRef.current.start();
        },
        onPanResponderMove: (_event, gesture) => {
          setCancelArmed(gesture.dx < HOLD_TO_TALK_CANCEL_DX);
        },
        onPanResponderRelease: (_event, gesture) => {
          setCancelArmed(false);
          const release = resolveHoldRelease({
            heldMs: Date.now() - pressedAtRef.current,
            dx: gesture.dx,
            phase: latestRef.current.phase,
          });
          if (release === "tap") {
            setMode("tap");
            return;
          }
          setMode("idle");
          if (release === "send") latestRef.current.stop("send");
          else latestRef.current.cancel();
        },
        onPanResponderTerminate: () => {
          setCancelArmed(false);
          setMode("idle");
          latestRef.current.cancel();
        },
      }).panHandlers,
    [],
  );

  return { mode, cancelArmed, panHandlers };
}
