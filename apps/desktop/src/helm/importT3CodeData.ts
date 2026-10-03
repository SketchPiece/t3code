import * as NodeSqlite from "node:sqlite";

import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

// Helm fork: replaces Helm's server state with a copy of the official T3 Code
// install, on request only. The Helm menu's "Import from T3 Code…" leaves a
// request file and relaunches; this runs before the backend starts, so no
// server has Helm's database open. Helm's previous state moves into
// backups/ first, and T3 Code's files are only read.
//
// Copied: the database (a VACUUM INTO snapshot, consistent even while T3 Code
// is running), attachments, and portable preferences. Not copied: the
// environment id, secrets, sign-in and encrypted connections — two servers
// sharing those would fight over one identity.

const COPIED_FILES = ["settings.json", "keybindings.json", "client-settings.json"] as const;
const COPIED_DIRECTORIES = ["attachments", "themes", "project-icons"] as const;
const MARKER_FILE = "helm-imported-from-t3code.txt";
/** Left by the Helm menu; the next launch imports and removes it. */
const REQUEST_FILE = "helm-import-from-t3code.request";
const V1_DATABASE = "state.sqlite";
const V2_DATABASE = "statev2.sqlite";
const DATABASE_FILES = [V1_DATABASE, V2_DATABASE].flatMap((name) => [
  name,
  `${name}-wal`,
  `${name}-shm`,
]);
/** Everything an import overwrites, moved aside first. */
const REPLACED = [...DATABASE_FILES, ...COPIED_FILES, ...COPIED_DIRECTORIES, MARKER_FILE];

export type T3CodeImportResult =
  | {
      readonly status: "imported";
      readonly source: string;
      readonly copied: ReadonlyArray<string>;
      readonly backup: string;
    }
  | {
      readonly status: "skipped";
      readonly reason: "not-requested" | "no-t3code-state";
    }
  | { readonly status: "failed"; readonly error: string };

/** Asks the next launch to replace Helm's state with T3 Code's. */
export const requestT3CodeImport = Effect.fn("helm.requestT3CodeImport")(function* (
  stateDir: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(stateDir, { recursive: true });
  yield* fileSystem.writeFileString(path.join(stateDir, REQUEST_FILE), "requested\n");
});

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

  if (!(yield* exists(target(REQUEST_FILE)))) {
    return { status: "skipped", reason: "not-requested" } satisfies T3CodeImportResult;
  }
  // One attempt per request, whatever happens next.
  yield* fileSystem.remove(target(REQUEST_FILE), { force: true }).pipe(Effect.ignore);

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

  const startedAt = DateTime.formatIso(yield* DateTime.now);
  const backup = path.join(
    input.stateDir,
    "backups",
    `before-t3code-import-${startedAt.replaceAll(":", "-")}`,
  );
  const movedAside: string[] = [];
  const moveAside = Effect.gen(function* () {
    yield* fileSystem.makeDirectory(backup, { recursive: true });
    for (const name of REPLACED) {
      if (!(yield* exists(target(name)))) continue;
      yield* fileSystem.rename(target(name), path.join(backup, name));
      movedAside.push(name);
    }
  });
  const restore = Effect.gen(function* () {
    for (const name of [...COPIED_FILES, ...COPIED_DIRECTORIES, database]) {
      yield* fileSystem.remove(target(name), { recursive: true, force: true }).pipe(Effect.ignore);
    }
    for (const name of movedAside) {
      yield* fileSystem.rename(path.join(backup, name), target(name)).pipe(Effect.ignore);
    }
  });

  const copied: string[] = [];
  const copy = Effect.gen(function* () {
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

  const exit = yield* Effect.exit(Effect.andThen(moveAside, copy));
  if (Exit.isFailure(exit)) {
    // Put Helm's own state back rather than start on a half copy.
    yield* restore;
    return {
      status: "failed",
      error: Cause.pretty(exit.cause),
    } satisfies T3CodeImportResult;
  }

  yield* fileSystem
    .writeFileString(
      target(MARKER_FILE),
      `imported ${startedAt}\nfrom ${input.t3CodeStateDir}\ncopied ${copied.join(", ")}\nprevious state in ${backup}\n`,
    )
    .pipe(Effect.ignore);
  return {
    status: "imported",
    source: input.t3CodeStateDir,
    copied,
    backup,
  } satisfies T3CodeImportResult;
});
