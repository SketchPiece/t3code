// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- a long-lived helper process.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../config.ts";
import { helmSettingChanges } from "./helmSettings.ts";

// Helm fork: with an external display connected, Touch ID sheets go straight to the password
// (native/helm-auth). Settings → Helm → "Password instead of Touch ID" turns it off. Only the
// server on the real `~/.helm` runs it, so dev servers on other base dirs don't double up.

const RESTART_DELAY_MS = 10_000;

function helperDirectory(resourceMonitorPath: string | undefined): string | undefined {
  const candidates = [
    process.env.HELM_AUTH_DIR,
    resourceMonitorPath && NodePath.dirname(resourceMonitorPath),
    NodePath.resolve(import.meta.dirname, "../../../../native/helm-auth/build"),
    NodePath.resolve(import.meta.dirname, "../../../native/helm-auth/build"),
  ];
  return candidates.find(
    (dir): dir is string => !!dir && NodeFS.existsSync(NodePath.join(dir, "helm-auth")),
  );
}

/** Runs the watcher while `wanted()` says so, and again if it crashes. */
function superviseHelper(helperPath: string, wanted: () => boolean) {
  let child: NodeChildProcess.ChildProcess | null = null;
  let restart: ReturnType<typeof setTimeout> | null = null;
  const start = () => {
    if (child || !wanted()) return;
    const process = NodeChildProcess.spawn(helperPath, [], { stdio: ["pipe", "ignore", "ignore"] });
    child = process;
    process.on("error", () => undefined);
    process.on("exit", () => {
      if (child !== process) return;
      child = null;
      restart = setTimeout(start, RESTART_DELAY_MS);
      restart.unref();
    });
  };
  const stop = () => {
    if (restart) clearTimeout(restart);
    restart = null;
    const process = child;
    child = null;
    process?.kill();
  };
  return { sync: () => (wanted() ? start() : stop()), stop };
}

export const touchIdPasswordLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    if ((yield* HostProcess.Platform) !== "darwin") return;
    const config = yield* ServerConfig;
    const home = NodeOS.homedir();
    const isMainInstance =
      config.baseDir === NodePath.join(home, ".helm") &&
      NodePath.basename(config.stateDir) === "userdata";
    const force = Option.getOrUndefined(
      yield* Config.String("HELM_AUTH_FORCE").pipe(Config.option),
    );
    if (!isMainInstance && !force) return;

    const directory = helperDirectory(config.resourceMonitorPath);
    if (!directory) return;

    let on = true;
    const helper = yield* Effect.acquireRelease(
      Effect.sync(() => superviseHelper(NodePath.join(directory, "helm-auth"), () => on)),
      (helper) => Effect.sync(helper.stop),
    );
    const changes = yield* helmSettingChanges("helmTouchIdPasswordEnabled");
    yield* changes.pipe(
      Stream.runForEach((value) =>
        Effect.sync(() => {
          on = value;
          helper.sync();
        }),
      ),
      Effect.forkScoped,
    );
  }),
);
