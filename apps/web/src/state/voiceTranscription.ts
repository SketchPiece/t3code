import { createVoiceTranscriptionEnvironmentAtoms } from "@t3tools/client-runtime/state/voiceTranscription";

import { connectionAtomRuntime } from "../connection/runtime";

export const voiceTranscriptionEnvironment =
  createVoiceTranscriptionEnvironmentAtoms(connectionAtomRuntime);
