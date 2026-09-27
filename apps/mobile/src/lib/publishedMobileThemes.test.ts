import type { EnvironmentTheme } from "@t3tools/contracts";
import { T3_CODE_LIGHT_THEME_COLORS } from "@t3tools/shared/themePalettes";
import { describe, expect, it } from "vite-plus/test";

import { resolvePublishedMobileThemes } from "./publishedMobileThemes";

const exported = (overrides: Partial<EnvironmentTheme> = {}): EnvironmentTheme => ({
  id: "volna-bakelite",
  name: "Volna",
  appearance: "dark",
  colors: { canvas: "#2a2522", accent: "#e8a33d" },
  ...overrides,
});

describe("resolvePublishedMobileThemes", () => {
  it("renders an exported palette per described appearance", () => {
    const [theme] = resolvePublishedMobileThemes([
      {
        environmentLabel: "MacBook Pro",
        themes: [exported({ variants: { light: { canvas: "#e7e0d2" } } })],
      },
    ]);

    expect(theme?.id).toBe("published:volna-bakelite");
    expect(theme?.environmentLabel).toBe("MacBook Pro");
    expect(theme?.colors.dark?.canvas).toBe("#2a2522");
    expect(theme?.colors.dark?.accent).toBe("#e8a33d");
    expect(theme?.colors.light?.canvas).toBe("#e7e0d2");
    // Roles the file leaves out keep the stock palette for that appearance.
    expect(theme?.colors.light?.text).toBe(T3_CODE_LIGHT_THEME_COLORS.text);
  });

  it("offers only the appearances a file describes", () => {
    const [theme] = resolvePublishedMobileThemes([
      { environmentLabel: "MacBook Pro", themes: [exported()] },
    ]);

    expect(theme?.colors.light).toBeUndefined();
  });

  it("skips seeded-only, reserved, and colorless themes", () => {
    const themes = resolvePublishedMobileThemes([
      {
        environmentLabel: "MacBook Pro",
        themes: [
          exported({ id: "seeded", colors: undefined, canvas: "#000000", accent: "#ffffff" }),
          exported({ id: "ember" }),
          exported({ id: "junk", colors: { canvas: "url(evil)", notARole: "#ffffff" } }),
        ],
      },
    ]);

    expect(themes).toEqual([]);
  });

  it("keeps the first machine's theme when two publish the same id", () => {
    const themes = resolvePublishedMobileThemes([
      { environmentLabel: "MacBook Pro", themes: [exported()] },
      { environmentLabel: "Mac mini", themes: [exported({ name: "Other" })] },
    ]);

    expect(themes.map((theme) => theme.environmentLabel)).toEqual(["MacBook Pro"]);
  });
});
