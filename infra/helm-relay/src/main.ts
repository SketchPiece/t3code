// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiScalar from "effect/unstable/httpapi/HttpApiScalar";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

import { RelayApi } from "@t3tools/contracts/relay";
import * as RelayConfiguration from "t3code-relay/src/Config.ts";
import * as WebCrypto from "t3code-relay/src/WebCrypto.ts";
import * as AgentActivityPublisher from "t3code-relay/src/agentActivity/AgentActivityPublisher.ts";
import * as AgentActivityRows from "t3code-relay/src/agentActivity/AgentActivityRows.ts";
import * as ApnsClient from "t3code-relay/src/agentActivity/ApnsClient.ts";
import * as ApnsDeliveries from "t3code-relay/src/agentActivity/ApnsDeliveries.ts";
import * as ApnsDeliveryQueue from "t3code-relay/src/agentActivity/ApnsDeliveryQueue.ts";
import * as ApnsProviderTokens from "t3code-relay/src/agentActivity/ApnsProviderTokens.ts";
import * as DeliveryAttempts from "t3code-relay/src/agentActivity/DeliveryAttempts.ts";
import * as Devices from "t3code-relay/src/agentActivity/Devices.ts";
import * as FcmAssertionSigner from "t3code-relay/src/agentActivity/FcmAssertionSigner.ts";
import * as FcmClient from "t3code-relay/src/agentActivity/FcmClient.ts";
import * as FcmDeliveries from "t3code-relay/src/agentActivity/FcmDeliveries.ts";
import * as FcmDeliveryQueueSender from "t3code-relay/src/agentActivity/FcmDeliveryQueueSender.ts";
import * as LiveActivities from "t3code-relay/src/agentActivity/LiveActivities.ts";
import * as MobileRegistrations from "t3code-relay/src/agentActivity/MobileRegistrations.ts";
import type { SignedApnsDeliveryJob } from "t3code-relay/src/agentActivity/apnsDeliveryJobs.ts";
import * as DpopProofs from "t3code-relay/src/auth/DpopProofs.ts";
import * as RelayTokens from "t3code-relay/src/auth/RelayTokens.ts";
import * as RelayDb from "t3code-relay/src/db.ts";
import * as EnvironmentConnector from "t3code-relay/src/environments/EnvironmentConnector.ts";
import * as EnvironmentCredentials from "t3code-relay/src/environments/EnvironmentCredentials.ts";
import * as EnvironmentLinker from "t3code-relay/src/environments/EnvironmentLinker.ts";
import * as EnvironmentLinks from "t3code-relay/src/environments/EnvironmentLinks.ts";
import * as EnvironmentPublishSignatures from "t3code-relay/src/environments/EnvironmentPublishSignatures.ts";
import * as ManagedEndpointAllocations from "t3code-relay/src/environments/ManagedEndpointAllocations.ts";
import * as ManagedEndpointReaper from "t3code-relay/src/environments/ManagedEndpointReaper.ts";
import * as ManagedTunnelLimits from "t3code-relay/src/environments/ManagedTunnelLimits.ts";
import {
  clientApi,
  dpopClientApi,
  healthApi,
  metadataApi,
  mobileApi,
  RELAY_HTTP_ROUTER_CONFIG,
  relayClientAuthLayer,
  relayCors,
  relayDocsRedirectRoute,
  relayDpopClientAuthLayer,
  relayEnvironmentAuthLayer,
  relayNotFoundRoute,
  serverApi,
  tokenApi,
  traceRelayHttpRequestWith,
  withoutCapturedParentSpan,
} from "t3code-relay/src/http/Api.ts";

import { managedEndpointProviderLayer } from "./cloudflare.ts";
import { HelmRelayConfig } from "./config.ts";
import { relayDbLayer } from "./database.ts";
import { makeDeliveryQueue } from "./deliveryQueue.ts";

// The Node counterpart of t3code-relay's src/worker.ts: the same services and
// HTTP API, with the Worker's platform pieces swapped for a Postgres pool,
// in-process delivery queues, a timer for the cron and the Cloudflare API for
// tunnels. Keep the service graph in step with worker.ts when merging upstream.

const webcryptoLayer = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
    digest: (algorithm, data) =>
      Effect.promise(async () => {
        const input = new Uint8Array(data.length);
        input.set(data);
        return new Uint8Array(await globalThis.crypto.subtle.digest(algorithm, input.buffer));
      }),
  }),
);

const httpPlatformNotSupportedLayer = Layer.succeed(HttpPlatform.HttpPlatform, {
  platform: "web",
  compression: {
    algorithms: new Set<HttpPlatform.CompressionAlgorithm>(),
    compressResponse: (response) => Effect.succeed(response),
  },
  fileResponse: () => Effect.die("Relay API does not serve filesystem responses"),
  fileWebResponse: () => Effect.die("Relay API does not serve file responses"),
});

const relayApiLayer = Layer.mergeAll(
  healthApi,
  metadataApi,
  mobileApi,
  clientApi,
  tokenApi,
  dpopClientApi,
  serverApi,
);

// Relay spans stay in-process; the Worker exports them to Axiom.
const noTraceExport = Layer.empty;

const pruneExpiredState = Effect.all(
  [
    DpopProofs.DpopProofReplay.pipe(
      Effect.flatMap((dpopProofs) => dpopProofs.pruneExpired),
      // Keep completed thread rows long enough to show their final state.
      Effect.andThen(
        Effect.all([AgentActivityRows.AgentActivityRows, DateTime.now]).pipe(
          Effect.flatMap(([activityRows, now]) =>
            activityRows.pruneTerminal({
              updatedBefore: DateTime.formatIso(DateTime.subtract(now, { minutes: 30 })),
            }),
          ),
        ),
      ),
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.interrupt
          : Effect.logWarning("Failed to prune expired relay state", { cause }),
      ),
    ),
    ManagedEndpointReaper.ManagedEndpointReaper.pipe(
      Effect.flatMap((reaper) => reaper.sweep.pipe(Effect.timeout("2 minutes"))),
      Effect.tap((result) =>
        result.scanned > 0
          ? Effect.logInfo("Finished managed tunnel cleanup", result)
          : Effect.void,
      ),
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.interrupt
          : Effect.logWarning("Failed to clean up inactive managed tunnels", { cause }),
      ),
    ),
  ],
  { concurrency: 2, discard: true },
).pipe(Effect.withSpan("relay.cron.prune_expired_state"));

const main = Effect.gen(function* () {
  const config = yield* HelmRelayConfig;
  const apnsQueue = yield* makeDeliveryQueue<SignedApnsDeliveryJob>({ name: "apns_delivery" });
  const fcmQueue = yield* makeDeliveryQueue<FcmDeliveries.FcmDeliveryJob>({
    name: "fcm_delivery",
  });

  const runtimeLayer = Layer.empty
    .pipe(
      Layer.provideMerge(MobileRegistrations.layer),
      Layer.provideMerge(AgentActivityPublisher.layer),
      Layer.provideMerge(EnvironmentConnector.layer),
      Layer.provideMerge(EnvironmentLinker.layer),
      Layer.provideMerge(
        Layer.merge(EnvironmentPublishSignatures.layer, ManagedEndpointReaper.layer),
      ),
      Layer.provideMerge(managedEndpointProviderLayer(config.cloudflare)),
      Layer.provideMerge(DpopProofs.layer),
      Layer.provideMerge(ApnsDeliveries.layer),
      Layer.provideMerge(
        FcmDeliveries.layer.pipe(
          Layer.provide(
            Layer.succeed(FcmDeliveryQueueSender.FcmDeliveryQueueSender, { send: fcmQueue.send }),
          ),
          Layer.provideMerge(
            FcmClient.layer.pipe(
              Layer.provide(FcmAssertionSigner.layer),
              Layer.provide(
                Layer.succeed(WebCrypto.WebCrypto, { subtle: globalThis.crypto.subtle }),
              ),
            ),
          ),
        ),
      ),
      Layer.provideMerge(ApnsClient.layer.pipe(Layer.provideMerge(ApnsProviderTokens.layer))),
      Layer.provideMerge(
        ApnsDeliveryQueue.layer.pipe(
          Layer.provide(
            Layer.succeed(ApnsDeliveryQueue.ApnsDeliveryQueueSender, { send: apnsQueue.send }),
          ),
        ),
      ),
      Layer.provideMerge(Layer.mergeAll(AgentActivityRows.layer, Devices.layer)),
      Layer.provideMerge(EnvironmentCredentials.layer),
      Layer.provideMerge(
        Layer.mergeAll(
          EnvironmentLinks.layer,
          ManagedEndpointAllocations.layer,
          ManagedTunnelLimits.layer,
        ),
      ),
    )
    .pipe(
      Layer.provideMerge(LiveActivities.layer),
      Layer.provideMerge(DeliveryAttempts.layer),
      Layer.provideMerge(RelayTokens.layer),
      Layer.provideMerge(
        RelayDb.RelayTransactions.layer.pipe(Layer.provideMerge(relayDbLayer(config.databaseUrl))),
      ),
      Layer.provideMerge(RelayConfiguration.layer(config.relay)),
      Layer.provideMerge(webcryptoLayer),
      // The Worker runtime supplies fetch.
      Layer.provideMerge(FetchHttpClient.layer),
    );
  const runtime = yield* Layer.build(runtimeLayer);

  yield* apnsQueue
    .consume((job) =>
      ApnsDeliveries.ApnsDeliveries.pipe(
        Effect.flatMap((deliveries) => deliveries.processSignedJob(job)),
      ),
    )
    .pipe(Effect.provide(runtime), Effect.forkScoped);
  yield* fcmQueue
    .consume((job) =>
      FcmDeliveries.FcmDeliveries.pipe(Effect.flatMap((deliveries) => deliveries.process(job))),
    )
    .pipe(Effect.provide(runtime), Effect.forkScoped);

  yield* pruneExpiredState.pipe(
    Effect.repeat(Schedule.spaced("5 minutes")),
    Effect.provide(runtime),
    Effect.forkScoped,
  );

  const appLayer = relayApiLayer.pipe(
    Layer.provideMerge(relayClientAuthLayer),
    Layer.provideMerge(relayDpopClientAuthLayer),
    Layer.provideMerge(relayEnvironmentAuthLayer),
    Layer.provide(Layer.succeedContext(runtime)),
  );

  const httpEffect = yield* Layer.merge(
    Layer.mergeAll(
      HttpApiBuilder.layer(RelayApi, { openapiPath: "/openapi.json" }).pipe(
        Layer.provide(appLayer),
      ),
      HttpApiScalar.layer(RelayApi, { path: "/docs" }),
      relayDocsRedirectRoute,
    ).pipe(Layer.provide([Etag.layerWeak, httpPlatformNotSupportedLayer, relayCors])),
    relayNotFoundRoute,
  ).pipe(
    HttpRouter.toHttpEffect,
    Effect.provideService(HttpRouter.RouterConfig, RELAY_HTTP_ROUTER_CONFIG),
    withoutCapturedParentSpan,
  );

  // Built in main's scope: provided per effect, the server would close as soon as serving starts.
  const server = yield* Layer.build(
    NodeHttpServer.layer(NodeHttp.createServer, { port: config.port }),
  );
  yield* HttpServer.serveEffect()(
    traceRelayHttpRequestWith(httpEffect, noTraceExport).pipe(Effect.provide(runtime)),
  ).pipe(Effect.provide(server));
  yield* Effect.logInfo("Helm relay listening", {
    port: config.port,
    issuer: config.relay.relayIssuer,
  });
  return yield* Effect.never;
});

main.pipe(Effect.scoped, Effect.provide(NodeServices.layer), NodeRuntime.runMain);
