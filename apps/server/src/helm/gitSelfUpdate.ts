import {
  ServerSelfUpdateError,
  type ServerSelfUpdateProgressStage,
  type ServerSelfUpdateResult,
} from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as ProcessRunner from "../processRunner.ts";

// Helm fork: a server run from a git checkout updates by building a release tag beside the
// running one (scripts/helm-server-update.sh, which also documents the setup). Its supervisor
// (systemd Restart=always) starts the new build after this process exits.
export const helmServerUpdateScript = Config.String("HELM_SERVER_UPDATE_SCRIPT").pipe(
  Config.option,
  Config.map(Option.filter((script) => script.trim() !== "")),
);

const HELM_RELEASE_VERSION = /^\d+\.\d+\.\d+-helm\.\d{8}\.\d+$/;
const BUILD_TIMEOUT = Duration.minutes(30);
// Lets the final progress event reach the client before the socket drops.
const EXIT_DELAY = Duration.seconds(1);

export const update = Effect.fn("helm.git_self_update.update")(function* (input: {
  readonly script: string;
  readonly targetVersion: string;
  readonly runner: ProcessRunner.ProcessRunner["Service"];
  readonly reportProgress: (
    stage: ServerSelfUpdateProgressStage,
  ) => Effect.Effect<void, ServerSelfUpdateError>;
  readonly exitForRestart: Effect.Effect<void>;
}) {
  const targetVersion = input.targetVersion.trim();
  if (!HELM_RELEASE_VERSION.test(targetVersion)) {
    return yield* new ServerSelfUpdateError({
      reason: `'${targetVersion}' is not a Helm release version.`,
    });
  }
  yield* input.reportProgress("downloading");
  const result = yield* input.runner
    .run({
      command: "bash",
      args: [input.script, targetVersion],
      timeout: BUILD_TIMEOUT,
      maxOutputBytes: 64 * 1024,
      outputMode: "truncate",
    })
    .pipe(
      Effect.mapError(
        (cause) =>
          new ServerSelfUpdateError({ reason: `Could not build Helm ${targetVersion}.`, cause }),
      ),
    );
  if (result.code !== 0) {
    const tail = result.stderr.trim().split("\n").slice(-3).join("\n");
    return yield* new ServerSelfUpdateError({
      reason: `Could not build Helm ${targetVersion}.${tail === "" ? "" : `\n${tail}`}`,
    });
  }
  yield* input.reportProgress("installing");
  yield* Effect.logInfo("Helm build ready; exiting so the supervisor starts it.", {
    targetVersion,
  });
  yield* Effect.sleep(EXIT_DELAY).pipe(
    Effect.andThen(input.exitForRestart),
    Effect.forkDetach({ startImmediately: true }),
  );
  return { targetVersion, method: "respawn" } satisfies ServerSelfUpdateResult;
});
