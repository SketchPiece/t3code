import { useAtomValue } from "@effect/atom-react";
import { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useEffect, useRef, useState } from "react";

import { isDesktopLocalConnectionTarget } from "~/connection/desktopLocal";
import { useClientSettings } from "~/hooks/useSettings";
import { useDesktopUpdateState } from "~/state/desktopUpdate";
import { useEnvironments } from "~/state/environments";
import { environmentThreadShells } from "~/state/threads";
import {
  AUTO_INSTALL_USER_IDLE_MS,
  isThreadBusy,
  resolveAutoUpdateStep,
} from "./desktopAutoUpdate.logic";

/** Whether any thread is busy across the environments in a newline-joined key. */
const busyThreadsAtom = Atom.family((environmentIds: string) =>
  Atom.make((get) =>
    environmentIds
      .split("\n")
      .filter((id) => id !== "")
      .some((id) =>
        get(environmentThreadShells.environmentThreadsAtom(EnvironmentId.make(id))).some((thread) =>
          isThreadBusy(thread.status),
        ),
      ),
  ).pipe(Atom.withLabel(`desktop-auto-update-busy-threads:${environmentIds}`)),
);

const USER_INPUT_EVENTS = ["pointerdown", "keydown", "wheel"] as const;
const IDLE_RECHECK_MS = 30_000;

/**
 * Desktop only. With "Install updates automatically" on, downloads each
 * update when it appears and restarts into it once this app's own backends
 * have no busy thread and the user has left the app alone for a while.
 * Remote environments keep running, so they do not hold the install back.
 */
export function DesktopAutoUpdateCoordinator() {
  const enabled = useClientSettings((settings) => settings.autoInstallDesktopUpdates);
  return enabled ? <DesktopAutoUpdateRunner /> : null;
}

function DesktopAutoUpdateRunner() {
  const state = useDesktopUpdateState();
  const { environments } = useEnvironments();
  const localEnvironmentIds = environments
    .filter(
      (environment) =>
        environment.entry.target._tag === "PrimaryConnectionTarget" ||
        isDesktopLocalConnectionTarget(environment.entry.target),
    )
    .map((environment) => environment.environmentId)
    .join("\n");
  const busyLocalThreads = useAtomValue(busyThreadsAtom(localEnvironmentIds));

  const lastInputAtRef = useRef(0);
  const [userIdle, setUserIdle] = useState(false);
  const attemptedRef = useRef<string | null>(null);

  const step = resolveAutoUpdateStep({ state, busyLocalThreads, userIdle });
  const installPending = step === "wait" || step === "install";

  // Watch input and re-check the idle clock on a slow timer, only while a
  // downloaded update waits. The clock starts when the wait does.
  useEffect(() => {
    if (!installPending) return;
    lastInputAtRef.current = Date.now();
    const onInput = () => {
      lastInputAtRef.current = Date.now();
      setUserIdle(false);
    };
    const timer = window.setInterval(() => {
      setUserIdle(Date.now() - lastInputAtRef.current >= AUTO_INSTALL_USER_IDLE_MS);
    }, IDLE_RECHECK_MS);
    for (const type of USER_INPUT_EVENTS) {
      window.addEventListener(type, onInput, { capture: true, passive: true });
    }
    return () => {
      window.clearInterval(timer);
      for (const type of USER_INPUT_EVENTS) {
        window.removeEventListener(type, onInput, { capture: true });
      }
    };
  }, [installPending]);

  const version =
    step === "install"
      ? state?.downloadedVersion
      : step === "download"
        ? state?.availableVersion
        : null;

  useEffect(() => {
    const bridge = window.desktopBridge;
    if (!bridge || (step !== "download" && step !== "install")) return;
    // One attempt per step and version. A refusal or failure waits for the user.
    const attempt = `${step}:${version ?? ""}`;
    if (attemptedRef.current === attempt) return;
    attemptedRef.current = attempt;
    const run = step === "download" ? bridge.downloadUpdate() : bridge.installUpdate();
    run.catch((error: unknown) => {
      console.warn(`Automatic update ${step} failed`, error);
    });
  }, [step, version]);

  return null;
}
