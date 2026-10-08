import type { HelmRemoteCommand, HelmRemoteSendResult } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

// Helm fork: Helm Mobile's remote. A command the phone sends goes to every desktop window
// subscribed right now; nothing is kept for windows that connect later.
type Listener = (command: HelmRemoteCommand) => void;
const listeners = new Set<Listener>();

export const sendRemoteCommand = (
  command: HelmRemoteCommand,
): Effect.Effect<HelmRemoteSendResult> =>
  Effect.sync(() => {
    for (const listener of listeners) listener(command);
    return { delivered: listeners.size };
  });

export const remoteCommands: Stream.Stream<HelmRemoteCommand> = Stream.callback<HelmRemoteCommand>(
  (queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const listener: Listener = (command) => Queue.offerUnsafe(queue, command);
        listeners.add(listener);
        return listener;
      }),
      (listener) => Effect.sync(() => listeners.delete(listener)),
    ),
);
