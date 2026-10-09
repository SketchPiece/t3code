import { describe, expect, it } from "vite-plus/test";

import { DRAG_EASE_MS, easeToward } from "./remoteScrollGlide";

describe("easeToward", () => {
  it("covers most of the way within a few frames and lands exactly", () => {
    let position = 0;
    for (let frame = 0; frame < 4; frame += 1)
      position = easeToward(position, 100, 16, DRAG_EASE_MS);
    expect(position).toBeGreaterThan(70);
    expect(position).toBeLessThan(100);
    for (let frame = 0; frame < 60; frame += 1)
      position = easeToward(position, 100, 16, DRAG_EASE_MS);
    expect(position).toBe(100);
  });

  it("moves the same distance for the same time, whatever the frame rate", () => {
    const at60 = easeToward(easeToward(0, 100, 16, DRAG_EASE_MS), 100, 16, DRAG_EASE_MS);
    const at30 = easeToward(0, 100, 32, DRAG_EASE_MS);
    expect(at60).toBeCloseTo(at30, 6);
  });
});
