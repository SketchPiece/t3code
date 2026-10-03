import { HelmTailscale } from "./native";
import { rewriteTailnetUrl } from "./urls";

// Helm fork: whether tailnet URLs go through the in-app node. On once this
// phone has logged in (the login persists), off after logging out, so a phone
// running the Tailscale VPN app instead still reaches 100.x directly.
let routing = HelmTailscale?.hasState() ?? false;

export function setTailnetRouting(enabled: boolean) {
  routing = enabled;
}

export function toReachableUrl(url: string): string {
  return rewriteTailnetUrl(url, routing ? HelmTailscale : null);
}

export const HELM_TAILNET_HOSTNAME = "helm-phone";
