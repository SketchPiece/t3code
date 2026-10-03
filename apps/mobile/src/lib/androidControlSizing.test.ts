import { describe, expect, it } from "vite-plus/test";

import { resolveAndroidControlSizing } from "./androidControlSizing";

describe("Android control sizing", () => {
  it.each([
    [11, 16, 48, 48, 162, 48],
    [17, 24, 48, 56, 250, 48],
    [22, 31, 62, 72, 324, 62],
  ])(
    "scales controls at %ipt",
    (fontSize, iconSize, buttonSize, fabSize, menuWidth, menuItemHeight) => {
      expect(resolveAndroidControlSizing(fontSize)).toMatchObject({
        iconSize,
        buttonSize,
        fabSize,
        menuWidth,
        menuItemHeight,
      });
    },
  );
});
