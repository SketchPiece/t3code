import { setAgentAwarenessRelayTokenProvider } from "../../src/features/agent-awareness/remoteRegistration";
import { helmPushConfigured } from "./relayClient";

// Helm fork: agent awareness only registers while a relay token provider is
// set (upstream sets it on T3 Connect sign-in). With the Volna core configured
// the phone is always "signed in"; relayClient.ts supplies the real token.
if (helmPushConfigured) {
  setAgentAwarenessRelayTokenProvider(() => Promise.resolve("helm-push"), "helm-push");
}
