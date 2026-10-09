import * as Schema from "effect/Schema";

import { ThreadId } from "./baseSchemas.ts";

// Helm fork: Helm Mobile as a remote for Helm on the Mac. The phone sends a command to its
// server; every desktop window subscribed there acts on it.
export const HelmRemoteCommand = Schema.Union([
  /** Show this thread in the desktop window and, unless `reveal` is false, bring the window forward. */
  Schema.Struct({
    type: Schema.Literal("thread.open"),
    threadId: ThreadId,
    /** False when switching threads from the remote: the window changes without taking focus. */
    reveal: Schema.optional(Schema.Boolean),
  }),
  /** Add dictated text to the end of the thread's composer draft, for the user to edit and send. */
  Schema.Struct({
    type: Schema.Literal("composer.insert"),
    threadId: ThreadId,
    text: Schema.String.check(Schema.isMaxLength(20_000)),
  }),
]);
export type HelmRemoteCommand = typeof HelmRemoteCommand.Type;

export const HelmRemoteSendResult = Schema.Struct({
  /** How many desktop windows took the command; 0 means none was listening. */
  delivered: Schema.Number,
});
export type HelmRemoteSendResult = typeof HelmRemoteSendResult.Type;
