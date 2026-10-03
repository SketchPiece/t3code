import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  setIsAudioActiveAsync,
  useAudioRecorder,
  type RecordingStatus,
} from "expo-audio";
import { File } from "expo-file-system";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { AppState } from "react-native";
import { useSharedValue } from "react-native-reanimated";

import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { serverVoiceTranscriber } from "../../../helm/voice/serverTranscriber";
import type { ComposerEditorSelection } from "../../components/ComposerEditor";
import { getLocalVoiceTranscriber } from "../../native/voiceTranscription";
import { useEnvironmentServerConfig } from "../../state/entities";
import { getNativeShowcaseScene } from "../showcase/nativeShowcaseScene";
import {
  VoiceInputController,
  VOICE_RECORDING_LIMIT_SECONDS,
  voiceInputBlocksSubmission,
  voiceInputFreezesEditor,
  type VoiceDraftSnapshot,
  type VoiceFinishIntent,
  type VoiceInputState,
} from "@t3tools/client-runtime/voice-input";
import { normalizeVoiceInputDecibels, VOICE_WAVEFORM_SAMPLE_COUNT } from "./voiceInputMetering";

const INITIAL_STATE: VoiceInputState = { phase: "idle", error: null, errorAction: null };
const VOICE_METERING_INTERVAL_MS = 80;
const VOICE_RECORDING_OPTIONS = {
  ...RecordingPresets.HIGH_QUALITY,
  isMeteringEnabled: true,
};

async function releaseVoiceRecordingAudio(): Promise<void> {
  try {
    await setAudioModeAsync({ allowsRecording: false });
  } finally {
    // Expo does not deactivate AVAudioSession when recording stops or its
    // category changes. Explicit deactivation resumes interrupted app audio.
    await setIsAudioActiveAsync(false);
  }
}

async function configureVoiceRecordingAudio(): Promise<void> {
  try {
    await setAudioModeAsync({
      allowsRecording: true,
      interruptionMode: "doNotMix",
      playsInSilentMode: true,
      shouldPlayInBackground: false,
    });
    await setIsAudioActiveAsync(true);
  } catch (error) {
    try {
      await releaseVoiceRecordingAudio();
    } catch {
      // Keep the setup error. The controller has not started a recorder yet.
    }
    throw error;
  }
}

export function useVoiceInputController(input: {
  readonly ownerKey: string | null;
  readonly draftMessage: string;
  readonly selection: ComposerEditorSelection;
  readonly disabled?: boolean;
  /** Server that transcribes (Helm: Russian and English); on-device iOS recognition otherwise. */
  readonly environmentId: EnvironmentId | null;
  readonly threadId?: ThreadId;
  readonly onChangeDraftMessage: (value: string) => void;
  readonly onChangeSelection: (selection: ComposerEditorSelection) => void;
  /** Sends the draft; hold-to-talk calls it once its transcript is in the draft. */
  readonly onSubmitDraft?: () => void;
}) {
  const serverConfig = useEnvironmentServerConfig(input.environmentId);
  const serverTranscribes = serverConfig?.environment.capabilities.voiceTranscription === true;
  const [state, setState] = useState<VoiceInputState>(INITIAL_STATE);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const keepAwakeId = useId();
  const keepAwakeSessionRef = useRef(0);
  const elapsedSecondsRef = useRef(0);
  const audioLevelsRef = useRef(Array<number>(VOICE_WAVEFORM_SAMPLE_COUNT).fill(0));
  const audioLevels = useSharedValue(audioLevelsRef.current);
  const controllerRef = useRef<VoiceInputController | null>(null);
  const previousDraftRef = useRef({ ownerKey: input.ownerKey, text: input.draftMessage });
  const revisionRef = useRef(0);
  if (
    previousDraftRef.current.ownerKey !== input.ownerKey ||
    previousDraftRef.current.text !== input.draftMessage
  ) {
    previousDraftRef.current = { ownerKey: input.ownerKey, text: input.draftMessage };
    revisionRef.current += 1;
  }
  const latestInputRef = useRef({ ...input, serverTranscribes });
  latestInputRef.current = { ...input, serverTranscribes };
  // Hold-to-talk sends after the committed transcript reaches the draft props.
  const pendingSubmitRef = useRef(false);
  useEffect(() => {
    if (!pendingSubmitRef.current || input.draftMessage.trim().length === 0) return;
    pendingSubmitRef.current = false;
    latestInputRef.current.onSubmitDraft?.();
  }, [input.draftMessage]);

  const handleRecorderStatus = useCallback((status: RecordingStatus) => {
    controllerRef.current?.handleRecorderStatus({
      isFinished: status.isFinished,
      hasError: status.hasError || status.mediaServicesDidReset === true,
      error: status.error,
      url: status.url,
    });
  }, []);
  const recorder = useAudioRecorder(VOICE_RECORDING_OPTIONS, handleRecorderStatus);

  if (!controllerRef.current) {
    controllerRef.current = new VoiceInputController({
      recorder,
      getTranscriber: () => {
        const current = latestInputRef.current;
        return current.serverTranscribes && current.environmentId !== null
          ? serverVoiceTranscriber({
              environmentId: current.environmentId,
              ...(current.threadId ? { threadId: current.threadId } : {}),
            })
          : getLocalVoiceTranscriber();
      },
      requestPermission: async () => {
        const permission = await requestRecordingPermissionsAsync();
        return { granted: permission.granted, canAskAgain: permission.canAskAgain };
      },
      configureRecording: configureVoiceRecordingAudio,
      releaseRecording: releaseVoiceRecordingAudio,
      deleteRecording: (uri) => new File(uri).delete(),
      readDraft: (): VoiceDraftSnapshot | null => {
        const current = latestInputRef.current;
        if (!current.ownerKey) return null;
        return {
          ownerKey: current.ownerKey,
          text: current.draftMessage,
          selection: current.selection,
          revision: revisionRef.current,
        };
      },
      commitDraft: (text, selection) => {
        const current = latestInputRef.current;
        current.onChangeSelection(selection);
        current.onChangeDraftMessage(text);
      },
      submitDraft: () => {
        pendingSubmitRef.current = true;
      },
      onStateChange: setState,
    });
  }

  const controller = controllerRef.current;
  const previousOwnerRef = useRef(input.ownerKey);
  useEffect(() => {
    if (previousOwnerRef.current === input.ownerKey) return;
    previousOwnerRef.current = input.ownerKey;
    controller.ownerChanged();
  }, [controller, input.ownerKey]);

  useFocusEffect(
    useCallback(
      () => () => {
        controller.dispose();
      },
      [controller],
    ),
  );

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState) => {
      // iOS reports `inactive` while its permission dialog is open. Only the
      // real background state cancels preparation; recorder status handles
      // calls and route interruptions during capture.
      if (nextState === "background") controller.appMovedToBackground();
    });
    return () => subscription.remove();
  }, [controller]);

  useEffect(() => () => controller.dispose(), [controller]);

  useEffect(() => {
    if (state.phase !== "recording") return;

    const tag = `voice-input:${keepAwakeId}:${++keepAwakeSessionRef.current}`;
    const activation = activateKeepAwakeAsync(tag);
    void activation.catch(() => {});
    return () => {
      // Release after activation settles, even if the recording ends immediately.
      void activation.then(() => deactivateKeepAwake(tag)).catch(() => {});
    };
  }, [keepAwakeId, state.phase]);

  useEffect(() => {
    if (state.phase !== "preparing" && state.phase !== "recording") return;

    if (audioLevelsRef.current.some((level) => level !== 0)) {
      audioLevelsRef.current = Array<number>(VOICE_WAVEFORM_SAMPLE_COUNT).fill(0);
      audioLevels.value = audioLevelsRef.current;
    }
    if (elapsedSecondsRef.current !== 0) {
      elapsedSecondsRef.current = 0;
      setElapsedSeconds(0);
    }
    if (state.phase !== "recording") return;

    const sampleRecording = () => {
      if (controller.currentState.phase !== "recording") return;
      const status = recorder.getStatus();
      if (!status.isRecording) return;

      const level = normalizeVoiceInputDecibels(status.metering);
      const history = audioLevelsRef.current;
      if (level !== 0 || history.some((sample) => sample !== 0)) {
        const nextLevels = [...history.slice(1), level];
        audioLevelsRef.current = nextLevels;
        audioLevels.value = nextLevels;
      }

      const nextElapsedSeconds = Math.min(
        VOICE_RECORDING_LIMIT_SECONDS,
        Math.max(0, Math.floor(status.durationMillis / 1_000)),
      );
      if (nextElapsedSeconds !== elapsedSecondsRef.current) {
        elapsedSecondsRef.current = nextElapsedSeconds;
        setElapsedSeconds(nextElapsedSeconds);
      }
    };

    sampleRecording();
    const intervalId = setInterval(sampleRecording, VOICE_METERING_INTERVAL_MS);
    return () => clearInterval(intervalId);
  }, [audioLevels, controller, recorder, state.phase]);

  const start = useCallback(() => {
    if (!latestInputRef.current.disabled) void controller.start();
  }, [controller]);
  const stop = useCallback(
    (intent: VoiceFinishIntent = "insert") => controller.stop(intent),
    [controller],
  );
  const retry = useCallback(() => {
    if (!latestInputRef.current.disabled) void controller.retry();
  }, [controller]);
  const cancel = useCallback(() => {
    pendingSubmitRef.current = false;
    controller.cancel();
  }, [controller]);

  return {
    // Store screenshots show the dictation button even on simulators, whose
    // on-device transcription is unavailable.
    isAvailable:
      serverTranscribes || getLocalVoiceTranscriber() !== null || getNativeShowcaseScene() !== null,
    state,
    audioLevels,
    elapsedSeconds,
    isBusy: voiceInputBlocksSubmission(state),
    freezesEditor: voiceInputFreezesEditor(state),
    blocksSubmission: voiceInputBlocksSubmission(state),
    start,
    stop,
    retry,
    cancel,
  };
}
