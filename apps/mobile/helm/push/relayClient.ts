import { RelayAgentActivitySnapshotResponse, RelayOkResponse } from "@t3tools/contracts/relay";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import Constants from "expo-constants";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { readHelmPushConfig } from "./config";

// Helm fork: the mobile half of agent notifications through the Volna core.
// Device and Live Activity registration and the activity snapshot — the four
// calls agent awareness makes — go to the core's /helm routes with its token,
// so no T3 Connect (Clerk) account is needed. Everything else stays upstream's.
const config = readHelmPushConfig(Constants.expoConfig?.extra);

const request = <A>(
  method: "GET" | "POST" | "DELETE",
  path: string,
  decode: (body: unknown) => A,
  body?: unknown,
) =>
  Effect.promise(async () => {
    if (!config) throw new Error("Helm push is not configured");
    const response = await fetch(`${config.url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${config.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`Volna core ${path} answered ${response.status}`);
    return decode(await response.json());
  });

const decodeOk = Schema.decodeUnknownSync(RelayOkResponse);
const decodeSnapshot = Schema.decodeUnknownSync(RelayAgentActivitySnapshotResponse);

/** The upstream relay client with agent-awareness calls sent to the Volna core. */
export function withHelmPushRelay<A, E, R>(
  base: Layer.Layer<A | ManagedRelay.ManagedRelayClient, E, R>,
): Layer.Layer<A | ManagedRelay.ManagedRelayClient, E, R> {
  if (!config) return base;
  const helm = Layer.effect(
    ManagedRelay.ManagedRelayClient,
    Effect.gen(function* () {
      const relay = yield* ManagedRelay.ManagedRelayClient;
      return ManagedRelay.ManagedRelayClient.of({
        ...relay,
        registerDevice: ({ payload }) => request("POST", "/v1/mobile/devices", decodeOk, payload),
        unregisterDevice: ({ deviceId }) =>
          request("DELETE", `/v1/mobile/devices/${encodeURIComponent(deviceId)}`, decodeOk),
        registerLiveActivity: ({ payload }) =>
          request("POST", "/v1/mobile/live-activities", decodeOk, payload),
        getAgentActivitySnapshot: () => request("GET", "/v1/mobile/agent-activity", decodeSnapshot),
      });
    }),
  ).pipe(Layer.provide(base));
  return Layer.merge(base, helm);
}

export const helmPushConfigured = config !== null;
