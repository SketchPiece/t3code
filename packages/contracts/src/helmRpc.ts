import * as Schema from "effect/Schema";

import { HelmDraft, HelmDraftEvent, HelmDraftSetInput } from "./helmDrafts.ts";
import { HelmRemoteCommand, HelmRemoteSendResult } from "./helmRemote.ts";

// Helm fork: all of Helm's own calls go through two RPC methods, `helm.command` and
// `helm.subscribe`. Past about 200 methods the RPC group's union is too big for the Effect
// type checker, which then reads `any` across the server; one method per Helm feature pushed
// it over. Each command keeps its own scope (RpcAuthorization's per-payload check).

export const HelmCommand = Schema.Union([
  /** Helm Mobile as a remote: a command for Helm's desktop windows (helmRemote.ts). */
  Schema.Struct({ command: Schema.Literal("remote.send"), input: HelmRemoteCommand }),
  /** A draft shared by the Mac and the phone (helmDrafts.ts). */
  Schema.Struct({ command: Schema.Literal("drafts.set"), input: HelmDraftSetInput }),
]);
export type HelmCommand = typeof HelmCommand.Type;

export const HelmCommandResult = Schema.Union([
  Schema.Struct({ command: Schema.Literal("remote.send"), result: HelmRemoteSendResult }),
  Schema.Struct({ command: Schema.Literal("drafts.set"), result: HelmDraft }),
]);
export type HelmCommandResult = typeof HelmCommandResult.Type;

export const HelmTopic = Schema.Literals(["remote", "drafts"]);
export type HelmTopic = typeof HelmTopic.Type;

export const HelmSubscribeInput = Schema.Struct({ topic: HelmTopic });
export type HelmSubscribeInput = typeof HelmSubscribeInput.Type;

export const HelmTopicEvent = Schema.Union([
  /** A command from Helm Mobile's remote for the desktop windows. */
  Schema.Struct({ topic: Schema.Literal("remote"), event: HelmRemoteCommand }),
  Schema.Struct({ topic: Schema.Literal("drafts"), event: HelmDraftEvent }),
]);
export type HelmTopicEvent = typeof HelmTopicEvent.Type;
