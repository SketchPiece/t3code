import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

import * as RelayConfiguration from "t3code-relay/src/Config.ts";

/**
 * Railway variables can't always hold multi-line values, so PEM keys may be
 * pasted with literal `\n` escapes.
 */
export function unescapePem(value: string): string {
  return value.includes("\\n") ? value.replaceAll("\\n", "\n") : value;
}

/**
 * Railway exposes the service's generated or custom domain as
 * RAILWAY_PUBLIC_DOMAIN; RELAY_PUBLIC_ORIGIN wins when set.
 */
export function resolvePublicOrigin(input: {
  readonly publicOrigin: string | undefined;
  readonly railwayPublicDomain: string | undefined;
}): string | undefined {
  const explicit = input.publicOrigin?.trim().replace(/\/+$/u, "");
  if (explicit) return explicit;
  const domain = input.railwayPublicDomain?.trim();
  return domain ? `https://${domain}` : undefined;
}

const optionalString = (name: string) =>
  Config.String(name).pipe(
    Config.option,
    Config.map(
      Option.flatMap((value) => (value.trim() ? Option.some(value.trim()) : Option.none())),
    ),
    Config.map(Option.getOrUndefined),
  );

export const HelmRelayConfig = Effect.gen(function* () {
  const relayIssuer = resolvePublicOrigin({
    publicOrigin: yield* optionalString("RELAY_PUBLIC_ORIGIN"),
    railwayPublicDomain: yield* optionalString("RAILWAY_PUBLIC_DOMAIN"),
  });
  if (!relayIssuer) {
    return yield* Effect.die(
      new Error("Set RELAY_PUBLIC_ORIGIN or give the Railway service a public domain."),
    );
  }

  const apnsEnabled = yield* Config.Boolean("APNS_ENABLED").pipe(Config.withDefault(true));
  const apns = apnsEnabled
    ? {
        environment: yield* Config.schema(RelayConfiguration.ApnsEnvironment, "APNS_ENVIRONMENT"),
        teamId: yield* Config.String("APNS_TEAM_ID"),
        keyId: yield* Config.String("APNS_KEY_ID"),
        bundleId: yield* Config.String("APNS_BUNDLE_ID"),
        privateKey: Redacted.make(
          unescapePem(Redacted.value(yield* Config.Redacted("APNS_PRIVATE_KEY"))),
        ),
      }
    : null;
  const fcmServiceAccount = yield* optionalString("FCM_SERVICE_ACCOUNT");

  const relay = RelayConfiguration.make({
    relayIssuer,
    apns,
    ...(fcmServiceAccount ? { fcmServiceAccount: Redacted.make(fcmServiceAccount) } : {}),
    clerkSecretKey: yield* Config.Redacted("CLERK_SECRET_KEY"),
    clerkPublishableKey: yield* Config.String("CLERK_PUBLISHABLE_KEY"),
    clerkJwtAudience: yield* Config.String("CLERK_JWT_AUDIENCE"),
    apnsDeliveryJobSigningSecret: yield* Config.Redacted("RELAY_JOB_SIGNING_SECRET"),
    cloudMintPrivateKey: Redacted.make(
      unescapePem(Redacted.value(yield* Config.Redacted("RELAY_MINT_PRIVATE_KEY"))),
    ),
    cloudMintPublicKey: unescapePem(yield* Config.String("RELAY_MINT_PUBLIC_KEY")),
    managedEndpointBaseDomain: yield* Config.NonEmptyString("RELAY_TUNNEL_ZONE_NAME"),
    managedEndpointNamespace: yield* Config.NonEmptyString("RELAY_TUNNEL_NAMESPACE").pipe(
      Config.withDefault("helm"),
    ),
    managedEndpointCleanupMode: yield* RelayConfiguration.managedEndpointCleanupModeConfig,
  });

  return {
    relay,
    port: yield* Config.Port("PORT").pipe(Config.withDefault(8080)),
    databaseUrl: yield* Config.Redacted("DATABASE_URL"),
    cloudflare: {
      apiToken: yield* Config.Redacted("CLOUDFLARE_API_TOKEN"),
      accountId: yield* Config.NonEmptyString("CLOUDFLARE_ACCOUNT_ID"),
      tunnelZoneId: yield* Config.NonEmptyString("CLOUDFLARE_TUNNEL_ZONE_ID"),
    },
  };
});
