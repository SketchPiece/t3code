import { describe, expect, it } from "vite-plus/test";

import { pickVoiceRecordingFormat, voiceRecordingFormatForBlobType } from "./browserVoiceRecorder";

const supports =
  (...types: string[]) =>
  (type: string) =>
    types.includes(type);

describe("pickVoiceRecordingFormat", () => {
  it("records Opus in WebM where the browser supports it", () => {
    expect(pickVoiceRecordingFormat(supports("audio/webm;codecs=opus", "audio/mp4"))).toEqual({
      recorderMimeType: "audio/webm;codecs=opus",
      mimeType: "audio/webm",
      fileName: "dictation.webm",
    });
  });

  it("falls back to MP4 audio named .m4a on Safari", () => {
    expect(pickVoiceRecordingFormat(supports("audio/mp4"))).toEqual({
      recorderMimeType: "audio/mp4",
      mimeType: "audio/mp4",
      fileName: "dictation.m4a",
    });
  });

  it("lets the browser choose when nothing known is supported", () => {
    expect(pickVoiceRecordingFormat(supports()).recorderMimeType).toBeNull();
  });
});

describe("voiceRecordingFormatForBlobType", () => {
  const fallback = pickVoiceRecordingFormat(supports());

  it("names the clip after the container the browser produced", () => {
    expect(voiceRecordingFormatForBlobType("audio/mp4;codecs=mp4a.40.2", fallback)).toMatchObject({
      mimeType: "audio/mp4",
      fileName: "dictation.m4a",
    });
    expect(voiceRecordingFormatForBlobType("audio/webm;codecs=opus", fallback)).toMatchObject({
      mimeType: "audio/webm",
      fileName: "dictation.webm",
    });
  });

  it("keeps the requested format for an unlabeled blob", () => {
    expect(voiceRecordingFormatForBlobType("", fallback)).toBe(fallback);
  });
});
