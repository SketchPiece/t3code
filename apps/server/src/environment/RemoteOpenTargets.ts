import { type RemoteOpenTarget } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import { readTailscaleSshEnabled, readTailscaleStatus } from "@t3tools/tailscale";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

const SSH_PORT = 22;
// Every client's config waits on these targets and the tailscale CLI takes ~0.4 s, so answer
// from the last result and refresh it in the background once it is older than this.
const TARGETS_REFRESH_AFTER_MS = 30_000;

export class RemoteOpenTargets extends Context.Service<
  RemoteOpenTargets,
  {
    readonly resolveTargets: () => Effect.Effect<ReadonlyArray<RemoteOpenTarget>>;
  }
>()("t3/environment/RemoteOpenTargets") {}

/** @public */
export const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const net = yield* NetService.NetService;

  const resolveTargets = Effect.gen(function* () {
    // Check both loopback families: sshd can be bound IPv6-only.
    const sshdListening = yield* Effect.zipWith(
      net.hasListenerOnHost(SSH_PORT, "127.0.0.1"),
      net.hasListenerOnHost(SSH_PORT, "::1"),
      (ipv4, ipv6) => ipv4 || ipv6,
    );
    const username = yield* HostProcess.Username;

    const magicDnsName = yield* readTailscaleStatus.pipe(
      Effect.map((status) => status.magicDnsName),
      Effect.orElseSucceed(() => null),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );

    const targets: Array<RemoteOpenTarget> = [];

    if (!sshdListening) {
      // Tailscale SSH needs no local sshd; tailscaled alone does not prove an SSH route.
      if (
        magicDnsName !== null &&
        (yield* readTailscaleSshEnabled.pipe(
          Effect.orElseSucceed(() => false),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        ))
      ) {
        targets.push({
          kind: "tailscale",
          host: magicDnsName,
          ...(username === null ? {} : { username }),
        });
      }
      return targets;
    }

    if (magicDnsName !== null) {
      targets.push({
        kind: "tailscale",
        host: magicDnsName,
        ...(username === null ? {} : { username }),
      });
    }

    // hostname() may be an FQDN; mDNS always uses <first-label>.local.
    const hostname = yield* HostProcess.Hostname;
    const shortHostname = hostname.split(".")[0]?.trim();
    if (shortHostname !== undefined && shortHostname.length > 0) {
      targets.push({
        kind: "mdns",
        host: `${shortHostname}.local`,
        ...(username === null ? {} : { username }),
      });
    }

    return targets;
  });

  const scope = yield* Effect.scope;
  let cached: { readonly targets: ReadonlyArray<RemoteOpenTarget>; readonly at: number } | null =
    null;
  let refreshing = false;
  const refresh = Effect.tap(resolveTargets, (targets) =>
    Effect.map(Clock.currentTimeMillis, (at) => {
      cached = { targets, at };
    }),
  );
  const cachedTargets = Effect.gen(function* () {
    const last = cached;
    if (last === null) return yield* refresh;
    const now = yield* Clock.currentTimeMillis;
    if (!refreshing && now - last.at > TARGETS_REFRESH_AFTER_MS) {
      refreshing = true;
      // Forked from the request, so it keeps the request's context (hostname, username).
      yield* refresh.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            refreshing = false;
          }),
        ),
        Effect.forkIn(scope),
      );
    }
    return last.targets;
  });

  return RemoteOpenTargets.of({
    resolveTargets: Effect.fn("RemoteOpenTargets.resolveTargets")(function () {
      return cachedTargets;
    }),
  });
});

export const layer = Layer.effect(RemoteOpenTargets, make);
