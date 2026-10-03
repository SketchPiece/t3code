import type { ExpoConfig } from "expo/config";
import * as NodeModule from "node:module";

// Loaded like the repo's other config plugins: the package has no ESM entry.
const { AndroidConfig, withStringsXml } = NodeModule.createRequire(import.meta.url)(
  "expo/config-plugins",
) as typeof import("expo/config-plugins");

// Helm fork: the app's name and artwork. app.config.ts passes each build
// variant through applyHelmBrand and the finished config through
// withHelmConfig, so upstream's VARIANT_CONFIG stays as is. Schemes and
// relying parties keep T3 Code's values; iOS signs as Helm under the
// developer's own team, since T3's team and bundle ids are not ours to sign.

const ASSETS = "./helm/assets";
const HELM_APPLE_TEAM_ID = "4KSA86792T";
const HELM_IOS_BUNDLE_PREFIX = "com.sketchpiece.helm";

import { HELM_APP_NAME, HELM_APP_NAME_RU } from "./name.ts";

export { HELM_APP_NAME };

const displayNames = (name: string) =>
  ({
    development: `${name} Dev`,
    preview: `${name} Preview`,
    production: name,
  }) as const;

const DISPLAY_NAMES = displayNames(HELM_APP_NAME);
const DISPLAY_NAMES_RU = displayNames(HELM_APP_NAME_RU);

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
 * Sets the name under the icon and the splash colors. The name is "Helm", and
 * "Штурвал" on a phone set to Russian (a ru localization, which also lets iOS
 * offer a per-app language). Expo derives the native project name from
 * `name`, which must stay ASCII (and T3 Code's, for the build scripts).
 */
export function withHelmConfig(config: ExpoConfig, variantName: Variant): ExpoConfig {
  const displayName = DISPLAY_NAMES[variantName];
  const russianName = DISPLAY_NAMES_RU[variantName];
  const withIosName: ExpoConfig = {
    ...config,
    locales: {
      ...config.locales,
      ru: { ios: { CFBundleDisplayName: russianName }, android: { app_name: russianName } },
    },
    plugins: config.plugins?.map(withBakeliteSplash),
    ios: {
      ...config.ios,
      appleTeamId: config.ios?.appleTeamId ? HELM_APPLE_TEAM_ID : undefined,
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

export function applyHelmBrand<
  T extends {
    readonly iosBundleIdentifier: string;
    readonly assets: Readonly<Record<string, unknown>>;
  },
>(variant: T): T {
  return {
    ...variant,
    // com.t3tools.t3code(.preview) -> com.sketchpiece.helm(.preview). The
    // simulator-only dev client keeps its id: repo scripts launch it by name.
    iosBundleIdentifier: variant.iosBundleIdentifier.replace(
      /^com\.t3tools\.t3code(?!\.dev$)/,
      HELM_IOS_BUNDLE_PREFIX,
    ),
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

// Helm fork: IBM Plex Sans for the interface, Plex Mono for code, Unbounded
// for the name. Files are SIL OFL 1.1 (helm/fonts/LICENSE.md). Family names
// are the fonts' PostScript names; global.css refers to the same names.
const FONTS = "./helm/fonts";
const HELM_FONT_FAMILIES = [
  ["IBMPlexSans-Regular", 400],
  ["IBMPlexSans-Medium", 500],
  ["IBMPlexSans-SemiBold", 600],
  ["IBMPlexMono-Regular", 400],
  ["Unbounded-SemiBold", 600],
] as const;

export const helmFontPlugin: [string, unknown] = [
  "expo-font",
  {
    ios: { fonts: HELM_FONT_FAMILIES.map(([family]) => `${FONTS}/${family}.ttf`) },
    android: {
      fonts: HELM_FONT_FAMILIES.map(([family, weight]) => ({
        fontFamily: family,
        fontDefinitions: [{ path: `${FONTS}/${family}.ttf`, weight }],
      })),
    },
  },
];
