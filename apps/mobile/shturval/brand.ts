// Shturval fork: the app's name and artwork. app.config.ts passes each build
// variant through applyShturvalBrand, so upstream's VARIANT_CONFIG stays as is
// and bundle ids, schemes and relying parties keep T3 Code's values.

const ASSETS = "./shturval/assets";

export const SHTURVAL_APP_NAME = "Штурвал";

const APP_NAMES = {
  development: `${SHTURVAL_APP_NAME} Dev`,
  preview: `${SHTURVAL_APP_NAME} Preview`,
  production: SHTURVAL_APP_NAME,
} as const;

type Variant = keyof typeof APP_NAMES;

export function applyShturvalBrand<
  T extends { readonly appName: string; readonly assets: Readonly<Record<string, unknown>> },
>(variantName: Variant, variant: T): T {
  return {
    ...variant,
    appName: APP_NAMES[variantName],
    assets: {
      ...variant.assets,
      appIcon: `${ASSETS}/ios-1024.png`,
      iosIcon: `${ASSETS}/ios-1024.png`,
      splashIcon: `${ASSETS}/ios-1024.png`,
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
