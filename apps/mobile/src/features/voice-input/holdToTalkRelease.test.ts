import { describe, expect, it } from "vite-plus/test";

import {
  HOLD_TO_TALK_CANCEL_DX,
  HOLD_TO_TALK_TAP_MS,
  resolveHoldRelease,
} from "./holdToTalkRelease";

describe("resolveHoldRelease", () => {
  it("treats a quick press as a tap that keeps recording", () => {
    expect(
      resolveHoldRelease({ heldMs: HOLD_TO_TALK_TAP_MS - 1, dx: -200, phase: "recording" }),
    ).toBe("tap");
  });

  it("sends on release and cancels after sliding left onto the cross", () => {
    expect(resolveHoldRelease({ heldMs: 2_000, dx: -10, phase: "recording" })).toBe("send");
    expect(
      resolveHoldRelease({ heldMs: 2_000, dx: HOLD_TO_TALK_CANCEL_DX - 1, phase: "recording" }),
    ).toBe("cancel");
  });

  it("cancels a long hold released before the microphone opened", () => {
    expect(resolveHoldRelease({ heldMs: 2_000, dx: 0, phase: "preparing" })).toBe("cancel");
  });
});
