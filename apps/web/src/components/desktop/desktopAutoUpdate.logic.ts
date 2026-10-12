import type { DesktopUpdateState } from "@t3tools/contracts";

import { resolveDesktopUpdateButtonAction } from "../desktopUpdate.logic";

/** How long the user must leave the app alone before it restarts itself. */
export const AUTO_INSTALL_USER_IDLE_MS = 3 * 60_000;

/**
 * A thread that a restart would cut off: an agent is working, about to start,
 * or waiting on the user's answer.
 */
export const isThreadBusy = (status: string) =>
  status === "preparing" ||
  status === "queued" ||
  status === "starting" ||
  status === "running" ||
  status === "waiting";

/**
 * The next step of an automatic update. Downloads as soon as an update is
 * available, and installs only once no local thread is busy and the user has
 * been idle long enough. Failed downloads and installs are left to the user,
 * so a broken update never loops.
 */
export function resolveAutoUpdateStep(input: {
  readonly state: DesktopUpdateState | null;
  readonly busyLocalThreads: boolean;
  /** True once the user has left the app alone for {@link AUTO_INSTALL_USER_IDLE_MS}. */
  readonly userIdle: boolean;
}): "download" | "install" | "wait" | "none" {
  const { state } = input;
  if (state === null || !state.enabled || state.status === "error") return "none";
  const action = resolveDesktopUpdateButtonAction(state);
  if (action === "download") return "download";
  if (action !== "install") return "none";
  return input.busyLocalThreads || !input.userIdle ? "wait" : "install";
}
