import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand } from "./runtime.ts";

/** Helm fork: the voice.transcribe command, instantiated per client like the attachment atoms. */
export function createVoiceTranscriptionEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    transcribe: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:voice:transcribe",
      tag: WS_METHODS.voiceTranscribe,
    }),
  };
}
