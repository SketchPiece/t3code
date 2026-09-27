import type { EnvironmentTheme } from "@t3tools/contracts";
import {
  RESERVED_THEME_IDS,
  T3_CODE_DARK_THEME_COLORS,
  T3_CODE_LIGHT_THEME_COLORS,
  THEME_COLOR_ROLES,
  type ThemeAppearance,
  type ThemeColorRole,
  type ThemeColors,
} from "@t3tools/shared/themePalettes";

/** A theme some connected machine publishes, as a mobile theme selection. */
export type PublishedMobileThemeId = `published:${string}`;

export interface PublishedMobileTheme {
  readonly id: PublishedMobileThemeId;
  readonly label: string;
  /** The machine it came from, for the settings card. */
  readonly environmentLabel: string;
  /** Only the appearances the file describes; a dark-only theme offers no light palette. */
  readonly colors: Partial<Record<ThemeAppearance, ThemeColors>>;
}

const THEME_COLOR_ROLE_SET: ReadonlySet<string> = new Set(THEME_COLOR_ROLES);
// The color forms mobile can hand to React Native (oklch converts to sRGB).
const NATIVE_THEME_COLOR_PATTERN =
  /^(?:#(?:[\da-f]{3}|[\da-f]{6}|[\da-f]{8})|oklch\(\s*[\d.]+\s+[\d.]+\s+-?[\d.]+(?:\s*\/\s*[\d.]+)?\s*\)|rgba?\([\d.,\s/%]+\))$/i;

export function isPublishedMobileThemeId(value: unknown): value is PublishedMobileThemeId {
  return typeof value === "string" && value.startsWith("published:") && value.length > 10;
}

function publishedColorOverrides(
  colors: Readonly<Record<string, string>> | undefined,
): Partial<Record<ThemeColorRole, string>> {
  const overrides: Partial<Record<ThemeColorRole, string>> = {};
  for (const [role, color] of Object.entries(colors ?? {})) {
    const value = color.trim();
    if (THEME_COLOR_ROLE_SET.has(role) && NATIVE_THEME_COLOR_PATTERN.test(value)) {
      overrides[role as ThemeColorRole] = value;
    }
  }
  return overrides;
}

function paletteFor(
  appearance: ThemeAppearance,
  colors: Readonly<Record<string, string>> | undefined,
): ThemeColors | undefined {
  const overrides = publishedColorOverrides(colors);
  if (Object.keys(overrides).length === 0) return undefined;
  return {
    ...(appearance === "dark" ? T3_CODE_DARK_THEME_COLORS : T3_CODE_LIGHT_THEME_COLORS),
    ...overrides,
  };
}

/**
 * The themes connected machines publish, first machine wins on a shared id.
 * Mobile renders explicit palettes only: the seeded short form (canvas +
 * accent, no colors) needs web's palette generator, so those files are
 * skipped rather than shown as the stock palette under a custom name. Reserved
 * ids are dropped for the same reason web drops them.
 */
export function resolvePublishedMobileThemes(
  environments: Iterable<{
    readonly environmentLabel: string;
    readonly themes: ReadonlyArray<EnvironmentTheme> | undefined;
  }>,
): ReadonlyArray<PublishedMobileTheme> {
  const themes = new Map<PublishedMobileThemeId, PublishedMobileTheme>();
  for (const environment of environments) {
    for (const theme of environment.themes ?? []) {
      const id: PublishedMobileThemeId = `published:${theme.id}`;
      if (themes.has(id) || RESERVED_THEME_IDS.has(theme.id)) continue;
      const otherAppearance = theme.appearance === "dark" ? "light" : "dark";
      const colors: Partial<Record<ThemeAppearance, ThemeColors>> = {};
      const own = paletteFor(theme.appearance, theme.colors);
      const other = paletteFor(otherAppearance, theme.variants?.[otherAppearance]);
      if (own) colors[theme.appearance] = own;
      if (other) colors[otherAppearance] = other;
      if (!own && !other) continue;
      themes.set(id, {
        id,
        label: theme.name,
        environmentLabel: environment.environmentLabel,
        colors,
      });
    }
  }
  return [...themes.values()];
}
