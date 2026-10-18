import type { HelmCommand, HelmCommandResult, HelmTopic, HelmTopicEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { authEvents, registerApprover, respond } from "./authBridge.ts";
import { draftEvents, setDraft } from "./drafts.ts";
import { remoteCommands, sendRemoteCommand } from "./remoteCommands.ts";

// Helm fork: `helm.command` and `helm.subscribe` (contracts/helmRpc.ts) route to the feature
// that owns each command or stream.

export const runHelmCommand = (
  stateDir: string,
  request: HelmCommand,
): Effect.Effect<HelmCommandResult> => {
  switch (request.command) {
    case "remote.send":
      return Effect.map(sendRemoteCommand(request.input), (result) => ({
        command: request.command,
        result,
      }));
    case "drafts.set":
      return Effect.map(setDraft(stateDir, request.input), (result) => ({
        command: request.command,
        result,
      }));
    case "auth.respond":
      return Effect.map(respond(request.input), (result) => ({
        command: request.command,
        result,
      }));
    case "auth.registerApprover":
      return Effect.map(registerApprover(request.input), (result) => ({
        command: request.command,
        result,
      }));
  }
};

export const helmTopicEvents = (
  stateDir: string,
  topic: HelmTopic,
): Stream.Stream<HelmTopicEvent> => {
  switch (topic) {
    case "remote":
      return Stream.map(remoteCommands, (event) => ({ topic, event }));
    case "drafts":
      return Stream.map(draftEvents(stateDir), (event) => ({ topic, event }));
    case "auth":
      return Stream.map(authEvents, (event) => ({ topic, event }));
  }
};
