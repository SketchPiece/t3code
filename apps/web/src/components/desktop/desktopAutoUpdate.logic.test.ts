import { describe, expect, it } from "vite-plus/test";
import type { DesktopUpdateState } from "@t3tools/contracts";

import { resolveAutoUpdateStep } from "./desktopAutoUpdate.logic";

const baseState: DesktopUpdateState = {
  enabled: true,
  status: "idle",
  channel: "latest",
  currentVersion: "1.0.0",
  hostArch: "arm64",
  appArch: "arm64",
  runningUnderArm64Translation: false,
  availableVersion: null,
  downloadedVersion: null,
  releaseNotes: [],
  omittedReleaseCount: 0,
  downloadPercent: null,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
};

const available: DesktopUpdateState = {
  ...baseState,
  status: "available",
  availableVersion: "1.1.0",
};
const downloaded: DesktopUpdateState = {
  ...baseState,
  status: "downloaded",
  availableVersion: "1.1.0",
  downloadedVersion: "1.1.0",
};
const idle = { busyLocalThreads: false, userIdle: true };

describe("resolveAutoUpdateStep", () => {
  it("downloads an available update even while threads are busy", () => {
    expect(
      resolveAutoUpdateStep({ state: available, busyLocalThreads: true, userIdle: false }),
    ).toBe("download");
  });

  it("installs a downloaded update once threads and the user are idle", () => {
    expect(resolveAutoUpdateStep({ state: downloaded, ...idle })).toBe("install");
  });

  it("waits while a local thread is busy", () => {
    expect(resolveAutoUpdateStep({ state: downloaded, ...idle, busyLocalThreads: true })).toBe(
      "wait",
    );
  });

  it("waits while the user is active", () => {
    expect(
      resolveAutoUpdateStep({
        state: downloaded,
        ...idle,
        userIdle: false,
      }),
    ).toBe("wait");
  });

  it("leaves failed downloads and installs to the user", () => {
    for (const errorContext of ["download", "install"] as const) {
      expect(
        resolveAutoUpdateStep({
          state: { ...downloaded, status: "error", errorContext },
          ...idle,
        }),
      ).toBe("none");
    }
  });

  it("does nothing when updates are disabled or unknown", () => {
    expect(resolveAutoUpdateStep({ state: { ...available, enabled: false }, ...idle })).toBe(
      "none",
    );
    expect(resolveAutoUpdateStep({ state: null, ...idle })).toBe("none");
  });
});
