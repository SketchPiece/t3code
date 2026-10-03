import { NativeModules, Platform, Settings } from "react-native";

// Helm fork: the app speaks Russian when the phone's first preferred language
// is Russian, English otherwise. iOS's per-app language (Settings → Штурвал →
// Language) lands in the same AppleLanguages list. Read once at startup; the
// translation plugin (babel-plugin.cjs) branches every string on this.
function systemLanguage(): string {
  if (Platform.OS === "ios") {
    const languages: unknown = Settings.get("AppleLanguages");
    return Array.isArray(languages) ? String(languages[0] ?? "") : "";
  }
  const i18n = NativeModules.I18nManager as
    | { getConstants?: () => { localeIdentifier?: string }; localeIdentifier?: string }
    | undefined;
  return i18n?.getConstants?.().localeIdentifier ?? i18n?.localeIdentifier ?? "";
}

export const helmRussian = /^ru(?:\b|_)/i.test(systemLanguage());
