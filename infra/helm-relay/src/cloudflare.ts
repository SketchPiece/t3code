import type * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { fromApiToken } from "@distilled.cloud/cloudflare/Credentials";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

import * as ManagedEndpointProvider from "t3code-relay/src/environments/ManagedEndpointProvider.ts";

// The Worker gets scoped Cloudflare tokens from Alchemy bindings. Here one API
// token (Account: Cloudflare Tunnel Edit, Zone: DNS Edit) feeds the same
// Alchemy client builders, so tunnel and DNS calls behave exactly as upstream.

// The Worker's runtime context stores binding outputs; these clients read none.
const noBindingOutputs: Alchemy.BaseRuntimeContext = {
  Type: "helm-relay",
  id: "helm-relay",
  env: {},
  get: () => Effect.succeed(undefined),
  set: (id) => Effect.succeed(id),
};

export const managedEndpointProviderLayer = (input: {
  readonly apiToken: Redacted.Redacted<string>;
  readonly accountId: string;
  readonly tunnelZoneId: string;
}) => {
  const credentials = fromApiToken({ apiToken: Redacted.value(input.apiToken) }).pipe(
    Layer.provideMerge(FetchHttpClient.layer),
  );
  const authorize: Cloudflare.Tunnel.TunnelAuth["authorize"] = (effect) =>
    effect.pipe(Effect.provide(credentials));

  return ManagedEndpointProvider.layerCloudflareBindings(
    Cloudflare.Tunnel.readWriteClient({ authorize, accountId: Effect.succeed(input.accountId) }),
    Cloudflare.DNS.dnsReadWriteClient({ authorize }, Effect.succeed(input.tunnelZoneId)),
    noBindingOutputs,
  );
};
