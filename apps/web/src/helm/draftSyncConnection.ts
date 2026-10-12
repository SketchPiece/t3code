import { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import { request, subscribe } from "@t3tools/client-runtime/rpc";
import {
  type EnvironmentId,
  type HelmDraftEvent,
  type HelmDraftSetInput,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

// Helm fork: the connection side of shared drafts (draftSync.ts), run with the connection
// (connection/runtime.ts). Kept apart from draftSync.ts, which reads the app's state modules:
// those import the connection runtime, and importing them from it leaves them half-loaded.

const SEND_TIMEOUT = "20 seconds";

interface DraftEventHandlers {
  readonly follow: (environmentIds: ReadonlyArray<EnvironmentId>) => void;
  readonly receive: (environmentId: EnvironmentId, event: HelmDraftEvent) => void;
}

interface OutgoingDraft {
  readonly environmentId: EnvironmentId;
  readonly input: HelmDraftSetInput;
  readonly done: (sent: boolean) => void;
}

let send: ((environmentId: EnvironmentId, input: HelmDraftSetInput) => Promise<boolean>) | null =
  null;
let handlers: DraftEventHandlers | null = null;
/** What came before draftSync.ts started listening, handed over when it does. */
let followed: ReadonlyArray<EnvironmentId> | null = null;
const early: Array<readonly [EnvironmentId, HelmDraftEvent]> = [];

export const canSendDrafts = (): boolean => send !== null;

/** Sends a draft to an environment; resolves whether the server took it. */
export const sendDraft = (
  environmentId: EnvironmentId,
  input: HelmDraftSetInput,
): Promise<boolean> => (send ? send(environmentId, input) : Promise.resolve(false));

/** Hands the subscriptions' events to draftSync.ts; returns the stop. */
export function handleDraftEvents(next: DraftEventHandlers): () => void {
  handlers = next;
  if (followed) next.follow(followed);
  for (const [environmentId, event] of early.splice(0)) next.receive(environmentId, event);
  return () => {
    if (handlers === next) handlers = null;
  };
}

function follow(environmentIds: ReadonlyArray<EnvironmentId>): void {
  followed = environmentIds;
  handlers?.follow(environmentIds);
}

function receive(environmentId: EnvironmentId, event: HelmDraftEvent): void {
  if (handlers) handlers.receive(environmentId, event);
  else early.push([environmentId, event]);
}

const sameIds = (left: ReadonlyArray<EnvironmentId>, right: ReadonlyArray<EnvironmentId>) =>
  left.length === right.length && left.every((id, index) => id === right[index]);

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    if (typeof window === "undefined") return;
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    const outbox = yield* Queue.unbounded<OutgoingDraft>();
    send = (environmentId, input) =>
      new Promise((done) => {
        Queue.offerUnsafe(outbox, { environmentId, input, done });
      });
    yield* Stream.fromQueue(outbox).pipe(
      Stream.mapEffect(
        ({ environmentId, input, done }) =>
          registry
            .run(environmentId, request(WS_METHODS.helmDraftsSet, input))
            .pipe(
              Effect.timeout(SEND_TIMEOUT),
              Effect.match({ onFailure: () => done(false), onSuccess: () => done(true) }),
            ),
        { concurrency: "unbounded" },
      ),
      Stream.runDrain,
      Effect.forkScoped,
    );
    yield* SubscriptionRef.changes(registry.entries).pipe(
      Stream.map((entries) => Array.from(entries.keys()).toSorted()),
      // Only a change in which environments exist restarts the subscriptions.
      Stream.changesWith(sameIds),
      Stream.tap((environmentIds) => Effect.sync(() => follow(environmentIds))),
      Stream.switchMap((environmentIds) =>
        Stream.mergeAll(
          environmentIds.map((environmentId) =>
            registry.runStream(environmentId, subscribe(WS_METHODS.helmDraftsSubscribe, {})).pipe(
              Stream.map((event) => [environmentId, event] as const),
              // Servers without shared drafts end the stream; nothing to sync there.
              Stream.catchCause(() => Stream.empty),
            ),
          ),
          { concurrency: "unbounded" },
        ),
      ),
      Stream.runForEach(([environmentId, event]) =>
        Effect.sync(() => receive(environmentId, event)),
      ),
      Effect.forkScoped,
    );
  }),
);
