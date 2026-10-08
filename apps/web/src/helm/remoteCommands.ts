import { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import { subscribe } from "@t3tools/client-runtime/rpc";
import { type EnvironmentId, type HelmRemoteCommand, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

// Helm fork: Helm Mobile as a remote. The desktop app follows `helm.remote.subscribe` on every
// connected environment and hands each command to the listeners in the UI (root route).
export type RemoteCommandListener = (
  environmentId: EnvironmentId,
  command: HelmRemoteCommand,
) => void;

const listeners = new Set<RemoteCommandListener>();

export function onRemoteCommand(listener: RemoteCommandListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function deliver(environmentId: EnvironmentId, command: HelmRemoteCommand): void {
  for (const listener of listeners) {
    try {
      listener(environmentId, command);
    } catch {
      // One failing listener must not keep the command from the others.
    }
  }
}

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    // Only the desktop app is a remote's target; a browser tab elsewhere is not.
    if (typeof window === "undefined" || !window.desktopBridge) return;
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    yield* SubscriptionRef.changes(registry.entries).pipe(
      Stream.map((entries) => Array.from(entries.keys())),
      Stream.switchMap((environmentIds) =>
        Stream.mergeAll(
          environmentIds.map((environmentId) =>
            registry.runStream(environmentId, subscribe(WS_METHODS.helmRemoteSubscribe, {})).pipe(
              Stream.map((command) => [environmentId, command] as const),
              // Servers without the remote end the stream; nothing to follow there.
              Stream.catchCause(() => Stream.empty),
            ),
          ),
          { concurrency: "unbounded" },
        ),
      ),
      Stream.runForEach(([environmentId, command]) =>
        Effect.sync(() => deliver(environmentId, command)),
      ),
      Effect.forkScoped,
    );
  }),
);
