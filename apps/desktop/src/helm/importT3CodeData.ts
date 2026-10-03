import * as NodeSqlite from "node:sqlite";

import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

// Helm fork: on Helm's first launch, seed its server state from the official
// T3 Code install so threads, projects and settings carry over. Runs once,
// before the backend starts, and never writes to T3 Code's files.
//
// Copied: the database (a VACUUM INTO snapshot, consistent even while T3 Code
// is running), attachments, and portable preferences. Not copied: the
// environment id, secrets, sign-in and encrypted connections — two servers
// sharing those would fight over one relay registration and one identity.

const COPIED_FILES = ["settings.json", "keybindings.json", "client-settings.json"] as const;
const COPIED_DIRECTORIES = ["attachments", "themes", "project-icons"] as const;
const MARKER_FILE = "helm-imported-from-t3code.txt";
const V1_DATABASE = "state.sqlite";
const V2_DATABASE = "statev2.sqlite";

export type T3CodeImportResult =
  | {
      readonly status: "imported";
      readonly source: string;
      readonly copied: ReadonlyArray<string>;
    }
  | {
      readonly status: "skipped";
      readonly reason: "already-has-state" | "already-imported" | "no-t3code-state";
    }
  | { readonly status: "failed"; readonly error: string };

export const importT3CodeData = Effect.fn("helm.importT3CodeData")(function* (input: {
  /** Helm's server state dir (…/.helm/userdata). */
  readonly stateDir: string;
  /** T3 Code's server state dir, normally ~/.t3/userdata. */
  readonly t3CodeStateDir: string;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const target = (name: string) => path.join(input.stateDir, name);
  const source = (name: string) => path.join(input.t3CodeStateDir, name);
  const exists = (file: string) => fileSystem.exists(file).pipe(Effect.orElseSucceed(() => false));

  if (yield* exists(target(MARKER_FILE))) {
    return { status: "skipped", reason: "already-imported" } satisfies T3CodeImportResult;
  }
  if ((yield* exists(target(V2_DATABASE))) || (yield* exists(target(V1_DATABASE)))) {
    return { status: "skipped", reason: "already-has-state" } satisfies T3CodeImportResult;
  }
  // A V2 T3 Code keeps its stale V1 file beside the live one; a V1 copy is
  // upgraded by the server's own V2 import on first start.
  const database = (yield* exists(source(V2_DATABASE)))
    ? V2_DATABASE
    : (yield* exists(source(V1_DATABASE)))
      ? V1_DATABASE
      : null;
  if (database === null) {
    return { status: "skipped", reason: "no-t3code-state" } satisfies T3CodeImportResult;
  }

  const copied: string[] = [];
  const copy = Effect.gen(function* () {
    yield* fileSystem.makeDirectory(input.stateDir, { recursive: true });
    yield* Effect.try(() => {
      const sqlite = new NodeSqlite.DatabaseSync(source(database), { readOnly: true });
      try {
        sqlite.exec(`VACUUM INTO '${target(database).replaceAll("'", "''")}'`);
      } finally {
        sqlite.close();
      }
    });
    copied.push(database);
    for (const file of COPIED_FILES) {
      if (!(yield* exists(source(file)))) continue;
      yield* fileSystem.copyFile(source(file), target(file));
      copied.push(file);
    }
    for (const directory of COPIED_DIRECTORIES) {
      if (!(yield* exists(source(directory)))) continue;
      yield* fileSystem.copy(source(directory), target(directory));
      copied.push(`${directory}/`);
    }
  });

  const exit = yield* Effect.exit(copy);
  if (Exit.isFailure(exit)) {
    // A half-copied database would pass for real state on the next launch.
    yield* fileSystem.remove(target(database), { force: true }).pipe(Effect.ignore);
    return {
      status: "failed",
      error: Cause.pretty(exit.cause),
    } satisfies T3CodeImportResult;
  }

  const importedAt = DateTime.formatIso(yield* DateTime.now);
  yield* fileSystem
    .writeFileString(
      target(MARKER_FILE),
      `imported ${importedAt}\nfrom ${input.t3CodeStateDir}\ncopied ${copied.join(", ")}\n`,
    )
    .pipe(Effect.ignore);
  return {
    status: "imported",
    source: input.t3CodeStateDir,
    copied,
  } satisfies T3CodeImportResult;
});
