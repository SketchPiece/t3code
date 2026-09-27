import type { ExpoConfig } from "expo/config";
import * as NodeModule from "node:module";

// Loaded like the repo's other config plugins: the package has no ESM entry.
const { AndroidConfig, withStringsXml } = NodeModule.createRequire(import.meta.url)(
  "expo/config-plugins",
) as typeof import("expo/config-plugins");

// Shturval fork: the app's name and artwork. app.config.ts passes each build
// variant through applyShturvalBrand and the finished config through
// withShturvalConfig, so upstream's VARIANT_CONFIG stays as is and bundle
// ids, schemes and relying parties keep T3 Code's values.

const ASSETS = "./shturval/assets";

import { SHTURVAL_APP_NAME } from "./name.ts";

export { SHTURVAL_APP_NAME };

const DISPLAY_NAMES = {
  development: `${SHTURVAL_APP_NAME} Dev`,
  preview: `${SHTURVAL_APP_NAME} Preview`,
  production: SHTURVAL_APP_NAME,
} as const;

type Variant = keyof typeof DISPLAY_NAMES;

// The splash sits on Bakelite: ivory in light, bakelite in dark.
function withBakeliteSplash(plugin: NonNullable<ExpoConfig["plugins"]>[number]) {
  if (!Array.isArray(plugin) || plugin[0] !== "expo-splash-screen") return plugin;
  const options = plugin[1] as { dark?: object };
  return [
    plugin[0],
    {
      ...options,
      backgroundColor: "#E7E0D2",
      dark: { ...options.dark, backgroundColor: "#161310" },
    },
  ] as typeof plugin;
}

/**
 * Sets the name under the icon and the splash colors. Expo derives the native project name from
 * `name`, which must stay ASCII (and T3 Code's, for the build scripts), so the
 * Cyrillic name goes into the display name only.
 */
export function withShturvalConfig(config: ExpoConfig, variantName: Variant): ExpoConfig {
  const displayName = DISPLAY_NAMES[variantName];
  const withIosName: ExpoConfig = {
    ...config,
    plugins: config.plugins?.map(withBakeliteSplash),
    ios: {
      ...config.ios,
      infoPlist: { ...config.ios?.infoPlist, CFBundleDisplayName: displayName },
    },
  };
  return withStringsXml(withIosName, (stringsConfig) => {
    stringsConfig.modResults = AndroidConfig.Strings.setStringItem(
      [{ $: { name: "app_name" }, _: displayName }],
      stringsConfig.modResults,
    );
    return stringsConfig;
  });
}

export function applyShturvalBrand<
  T extends { readonly assets: Readonly<Record<string, unknown>> },
>(variant: T): T {
  return {
    ...variant,
    assets: {
      ...variant.assets,
      appIcon: `${ASSETS}/ios-1024.png`,
      iosIcon: `${ASSETS}/ios-1024.png`,
      splashIcon: `${ASSETS}/splash.png`,
      androidAdaptiveForeground: `${ASSETS}/android-foreground.png`,
      androidAdaptiveBackgroundColor: "#B8321F",
      androidAdaptiveBackgroundImage: undefined,
      androidSplashIcon: `${ASSETS}/android-splash.png`,
      androidMonochromeIcon: `${ASSETS}/android-monochrome.png`,
      androidNotificationIcon: `${ASSETS}/android-notification.png`,
      androidNotificationColor: "#E8A33D",
    },
  } as T;
}

// Shturval fork: IBM Plex Sans for the interface, Plex Mono for code, Unbounded
// for the name. Files are SIL OFL 1.1 (shturval/fonts/LICENSE.md). Family names
// are the fonts' PostScript names; global.css refers to the same names.
const FONTS = "./shturval/fonts";
const SHTURVAL_FONT_FAMILIES = [
  ["IBMPlexSans-Regular", 400],
  ["IBMPlexSans-Medium", 500],
  ["IBMPlexSans-SemiBold", 600],
  ["IBMPlexMono-Regular", 400],
  ["Unbounded-SemiBold", 600],
] as const;

export const shturvalFontPlugin: [string, unknown] = [
  "expo-font",
  {
    ios: { fonts: SHTURVAL_FONT_FAMILIES.map(([family]) => `${FONTS}/${family}.ttf`) },
    android: {
      fonts: SHTURVAL_FONT_FAMILIES.map(([family, weight]) => ({
        fontFamily: family,
        fontDefinitions: [{ path: `${FONTS}/${family}.ttf`, weight }],
      })),
    },
  },
];
