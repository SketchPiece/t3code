import type { SettingsSearchItem } from "../components/settings/settingsSearch";

// Helm fork: Settings → Helm (HelmSettingsPanel.tsx) in settings search.
export const HELM_SETTINGS_SEARCH_ITEMS = [
  {
    id: "helm-look",
    title: "Helm look",
    to: "/settings/helm",
    searchTerms: ["bakelite theme palette ibm plex font type stock t3 code look"],
  },
  {
    id: "helm-dictation",
    title: "Helm dictation",
    to: "/settings/helm",
    searchTerms: ["voice microphone transcribe gpt helm-cloud speech"],
  },
  {
    id: "t3-dictation",
    title: "T3 Code dictation",
    to: "/settings/helm",
    searchTerms: ["voice microphone local speech model transcribe whisper"],
  },
  {
    id: "helm-remote",
    title: "Helm Mobile remote",
    to: "/settings/helm",
    searchTerms: ["phone iphone remote control open thread type scroll send"],
  },
  {
    id: "helm-draft-sync",
    title: "Shared drafts",
    to: "/settings/helm",
    searchTerms: ["phone iphone helm mobile unsent draft sync"],
  },
  {
    id: "helm-nearby",
    title: "Announce on the local network",
    to: "/settings/helm",
    scope: "environment",
    searchTerms: ["bonjour wifi nearby phone pairing code helm mobile"],
  },
  {
    id: "helm-tailnet-pairing",
    title: "Pair phones on the tailnet",
    to: "/settings/helm",
    scope: "environment",
    searchTerms: ["tailscale phone pairing approve helm mobile"],
  },
  {
    id: "helm-screen-remote",
    title: "Screen remote",
    to: "/settings/helm",
    scope: "environment",
    searchTerms: ["phone ipad screen sharing mouse keyboard control mac experimental"],
  },
  {
    id: "helm-phone-confirm",
    title: "Confirm on the phone",
    to: "/settings/helm",
    scope: "environment",
    searchTerms: ["face id sudo password approve phone helm mobile"],
  },
  {
    id: "helm-cloud-alerts",
    title: "Alerts through helm-cloud",
    to: "/settings/helm",
    scope: "environment",
    searchTerms: ["push notifications live activities phone t3 connect relay"],
  },
  {
    id: "t3-usage-analytics",
    title: "Send usage data to T3 Code",
    to: "/settings/helm",
    scope: "environment",
    searchTerms: ["telemetry analytics posthog anonymous privacy"],
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;
