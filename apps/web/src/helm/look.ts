// Helm fork: Settings → Helm → "Helm look", the Bakelite palette and IBM Plex type. Kept in
// local storage beside the theme, not in client settings, so the first paint already has it.
const STORAGE_KEY = "helm:look";

let enabled = read();

function read(): boolean {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
}

export function isHelmLookEnabled(): boolean {
  return enabled;
}

/** Marks the page for helm.css; call before the first render. */
export function applyHelmLook(): void {
  if (typeof document === "undefined") return;
  document.documentElement.toggleAttribute("data-helm-look", enabled);
}

export function setHelmLookEnabled(next: boolean): void {
  enabled = next;
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, next ? "on" : "off");
  } catch {
    // The choice still holds for this session.
  }
  applyHelmLook();
}
