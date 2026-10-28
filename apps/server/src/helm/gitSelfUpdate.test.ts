import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProcessRunner from "../processRunner.ts";
import * as HelmGitSelfUpdate from "./gitSelfUpdate.ts";

const harness = (build: { readonly code: number; readonly stderr?: string }) => {
  const calls: string[] = [];
  const runner = ProcessRunner.ProcessRunner.of({
    run: (input) =>
      Effect.sync(() => {
        calls.push(`build ${input.args.join(" ")}`);
        return {
          stdout: "",
          stderr: build.stderr ?? "",
          code: ChildProcessSpawner.ExitCode(build.code),
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutInvalidUtf8: false,
          stderrInvalidUtf8: false,
        };
      }),
  });
  const update = (targetVersion: string) =>
    HelmGitSelfUpdate.update({
      script: "/helm/scripts/helm-server-update.sh",
      targetVersion,
      runner,
      reportProgress: (stage) => Effect.sync(() => calls.push(stage)),
      exitForRestart: Effect.sync(() => calls.push("exit")),
    });
  return { calls, update };
};

it.effect("builds the release tag, then exits for the supervisor to restart", () =>
  Effect.gen(function* () {
    const { calls, update } = harness({ code: 0 });
    const result = yield* update("0.1.4-helm.20261028.1");
    expect(result).toEqual({ targetVersion: "0.1.4-helm.20261028.1", method: "respawn" });
    expect(calls).toEqual([
      "downloading",
      "build /helm/scripts/helm-server-update.sh 0.1.4-helm.20261028.1",
      "installing",
    ]);
    yield* TestClock.adjust("1 second");
    expect(calls.at(-1)).toBe("exit");
  }),
);

it.effect("keeps running when the version is not Helm's or the build fails", () =>
  Effect.gen(function* () {
    const upstream = harness({ code: 0 });
    expect((yield* upstream.update("0.1.4-nightly.20261028.3824").pipe(Effect.flip)).reason).toBe(
      "'0.1.4-nightly.20261028.3824' is not a Helm release version.",
    );
    expect(upstream.calls).toEqual([]);

    const broken = harness({ code: 1, stderr: "vp i\nbuild log: /tmp/x.log\ntsc failed" });
    expect((yield* broken.update("0.1.4-helm.20261028.1").pipe(Effect.flip)).reason).toBe(
      "Could not build Helm 0.1.4-helm.20261028.1.\nvp i\nbuild log: /tmp/x.log\ntsc failed",
    );
    yield* TestClock.adjust("1 second");
    expect(broken.calls).not.toContain("exit");
  }),
);
