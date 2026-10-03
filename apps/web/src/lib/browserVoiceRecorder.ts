import type { VoiceRecorder, VoiceRecorderStatus } from "@t3tools/client-runtime/voice-input";

/** Container the clip is recorded in; the server picks the decoder by file extension. */
export type VoiceRecordingFormat = {
  /** Passed to MediaRecorder; may carry a codecs parameter. */
  readonly recorderMimeType: string | null;
  /** Bare type sent with the upload. */
  readonly mimeType: string;
  readonly fileName: string;
};

const WEBM_FORMAT: VoiceRecordingFormat = {
  recorderMimeType: "audio/webm;codecs=opus",
  mimeType: "audio/webm",
  fileName: "dictation.webm",
};

/** Opus in WebM where supported (Chromium, Electron, Firefox), AAC in MP4 on Safari. */
export function pickVoiceRecordingFormat(
  isTypeSupported: (mimeType: string) => boolean,
): VoiceRecordingFormat {
  if (isTypeSupported("audio/webm;codecs=opus")) return WEBM_FORMAT;
  if (isTypeSupported("audio/webm")) return { ...WEBM_FORMAT, recorderMimeType: "audio/webm" };
  if (isTypeSupported("audio/mp4")) {
    return { recorderMimeType: "audio/mp4", mimeType: "audio/mp4", fileName: "dictation.m4a" };
  }
  // Let the browser choose; the container is read back from the finished blob.
  return { ...WEBM_FORMAT, recorderMimeType: null };
}

/** Format of a finished clip, by the type the browser actually produced. */
export function voiceRecordingFormatForBlobType(
  blobType: string,
  fallback: VoiceRecordingFormat,
): VoiceRecordingFormat {
  const bare = blobType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (bare === "audio/webm" || bare === "video/webm") return WEBM_FORMAT;
  if (bare === "audio/mp4" || bare === "video/mp4") {
    return { recorderMimeType: bare, mimeType: "audio/mp4", fileName: "dictation.m4a" };
  }
  return fallback;
}

export function isBrowserVoiceRecordingSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.MediaRecorder !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function"
  );
}

export type BrowserVoiceRecording = {
  readonly blob: Blob;
  readonly format: VoiceRecordingFormat;
  readonly durationSeconds: number;
};

/**
 * MediaRecorder behind the platform-neutral VoiceRecorder. Finished clips live as
 * object URLs; the blob stays here until the controller deletes the recording.
 */
export class BrowserVoiceRecorder implements VoiceRecorder {
  uri: string | null = null;
  private readonly onStatus: (status: VoiceRecorderStatus) => void;
  private readonly recordings = new Map<string, BrowserVoiceRecording>();
  private stream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private levelSamples: Uint8Array<ArrayBuffer> | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private format: VoiceRecordingFormat = WEBM_FORMAT;
  private chunks: Blob[] = [];
  private startedAt: number | null = null;
  private limitTimer: ReturnType<typeof setTimeout> | null = null;
  private stopping: Promise<void> | null = null;

  constructor(onStatus: (status: VoiceRecorderStatus) => void) {
    this.onStatus = onStatus;
  }

  /** Opens the microphone, prompting for permission the first time. */
  async acquire(): Promise<void> {
    if (this.stream) return;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
    this.stream = stream;
    for (const track of stream.getAudioTracks()) {
      // Unplugged or revoked microphone mid-take.
      track.addEventListener("ended", () => this.fail("The microphone was disconnected."));
    }
  }

  async prepareToRecordAsync(): Promise<void> {
    await this.acquire();
    const stream = this.stream;
    if (!stream) throw new Error("Microphone is not available.");
    this.uri = null;
    this.chunks = [];
    this.format = pickVoiceRecordingFormat((type) => MediaRecorder.isTypeSupported(type));
    const recorder = new MediaRecorder(
      stream,
      this.format.recorderMimeType ? { mimeType: this.format.recorderMimeType } : undefined,
    );
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) this.chunks.push(event.data);
    });
    recorder.addEventListener("error", () => this.fail("Voice recording failed."));
    this.mediaRecorder = recorder;

    try {
      const audioContext = new AudioContext();
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 512;
      audioContext.createMediaStreamSource(stream).connect(analyser);
      this.audioContext = audioContext;
      this.analyser = analyser;
      this.levelSamples = new Uint8Array(analyser.fftSize);
    } catch {
      // The level meter is decoration; recording works without it.
    }
  }

  record(options: { readonly forDuration: number }): void {
    const recorder = this.mediaRecorder;
    if (!recorder || recorder.state !== "inactive") return;
    recorder.start();
    this.startedAt = performance.now();
    this.limitTimer = setTimeout(() => {
      void this.stop().then(() =>
        this.onStatus({ isFinished: true, hasError: false, error: null, url: this.uri }),
      );
    }, options.forDuration * 1_000);
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    const recorder = this.mediaRecorder;
    if (!recorder) return Promise.resolve();
    this.clearLimitTimer();
    const stopping = new Promise<void>((resolve) => {
      const finish = () => {
        this.finishTake(recorder);
        resolve();
      };
      if (recorder.state === "inactive") {
        finish();
        return;
      }
      recorder.addEventListener("stop", finish, { once: true });
      recorder.stop();
    }).finally(() => {
      this.stopping = null;
    });
    this.stopping = stopping;
    return stopping;
  }

  /** Current input loudness from 0 to 1, for the level meter. */
  readLevel(): number {
    const analyser = this.analyser;
    const samples = this.levelSamples;
    if (!analyser || !samples) return 0;
    analyser.getByteTimeDomainData(samples);
    let sum = 0;
    for (const sample of samples) {
      const centered = (sample - 128) / 128;
      sum += centered * centered;
    }
    // Speech RMS sits well under 0.3; scale it so normal speech fills the meter.
    return Math.min(1, Math.sqrt(sum / samples.length) * 4);
  }

  /** Milliseconds since recording started, or 0 before it starts. */
  elapsedMs(): number {
    return this.startedAt === null ? 0 : performance.now() - this.startedAt;
  }

  getRecording(uri: string): BrowserVoiceRecording | null {
    return this.recordings.get(uri) ?? null;
  }

  deleteRecording(uri: string): void {
    if (!this.recordings.delete(uri)) return;
    URL.revokeObjectURL(uri);
  }

  /** Closes the microphone; an unfinished take is stopped and kept for the controller to delete. */
  release(): void {
    if (this.mediaRecorder?.state === "recording") void this.stop();
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
    void this.audioContext?.close().catch(() => {});
    this.audioContext = null;
    this.analyser = null;
    this.levelSamples = null;
  }

  dispose(): void {
    this.release();
    for (const uri of this.recordings.keys()) URL.revokeObjectURL(uri);
    this.recordings.clear();
  }

  private finishTake(recorder: MediaRecorder): void {
    if (this.mediaRecorder !== recorder) return;
    this.mediaRecorder = null;
    const durationSeconds = Math.max(0.1, this.elapsedMs() / 1_000);
    this.startedAt = null;
    if (this.chunks.length === 0) return;
    const blob = new Blob(this.chunks, { type: this.chunks[0]?.type || this.format.mimeType });
    this.chunks = [];
    const uri = URL.createObjectURL(blob);
    this.recordings.set(uri, {
      blob,
      format: voiceRecordingFormatForBlobType(blob.type, this.format),
      durationSeconds,
    });
    this.uri = uri;
  }

  private fail(message: string): void {
    if (this.mediaRecorder?.state !== "recording") return;
    void this.stop().then(() =>
      this.onStatus({ isFinished: false, hasError: true, error: message, url: this.uri }),
    );
  }

  private clearLimitTimer(): void {
    if (this.limitTimer === null) return;
    clearTimeout(this.limitTimer);
    this.limitTimer = null;
  }
}
