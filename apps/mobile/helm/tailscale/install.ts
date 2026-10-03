import { HelmTailscale } from "./native";
import { HELM_TAILNET_HOSTNAME, toReachableUrl } from "./routing";

// Helm fork: imported first thing in index.ts, before anything captures fetch
// or WebSocket, so pairing, RPC, uploads and device streams all reach tailnet
// hosts through the in-app node. Images use the rewritten httpBaseUrl from
// withTailnetUrls (state/session.ts).

const originalFetch = globalThis.fetch;
globalThis.fetch = function tailnetFetch(input: RequestInfo | URL, init?: RequestInit) {
  if (typeof input === "string") return originalFetch(toReachableUrl(input), init);
  if (input instanceof URL) return originalFetch(toReachableUrl(input.href), init);
  const url = toReachableUrl(input.url);
  return originalFetch(url === input.url ? input : new Request(url, input), init);
};

const OriginalWebSocket = globalThis.WebSocket;
class TailnetWebSocket extends OriginalWebSocket {
  constructor(url: string | URL, protocols?: string | string[], options?: unknown) {
    // @ts-expect-error React Native's WebSocket takes a third options argument.
    super(toReachableUrl(String(url)), protocols, options);
  }
}
globalThis.WebSocket = TailnetWebSocket;

if (HelmTailscale?.hasState()) {
  HelmTailscale.start(HELM_TAILNET_HOSTNAME).catch(() => {
    // The Tailscale screen shows the node's state and retries.
  });
}
