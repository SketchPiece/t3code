import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeSqlite from "node:sqlite";

import { importT3CodeData } from "./importT3CodeData.ts";

const setup = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped();
  const t3CodeStateDir = path.join(root, ".t3", "userdata");
  const stateDir = path.join(root, ".helm", "userdata");
  yield* fileSystem.makeDirectory(path.join(t3CodeStateDir, "attachments"), { recursive: true });
  yield* fileSystem.makeDirectory(path.join(t3CodeStateDir, "secrets"), { recursive: true });
  const database = new NodeSqlite.DatabaseSync(path.join(t3CodeStateDir, "state.sqlite"));
  database.exec("CREATE TABLE threads (title TEXT); INSERT INTO threads VALUES ('Аудит диска');");
  database.close();
  yield* fileSystem.writeFileString(path.join(t3CodeStateDir, "settings.json"), "{}");
  yield* fileSystem.writeFileString(path.join(t3CodeStateDir, "environment-id"), "t3-env");
  yield* fileSystem.writeFileString(path.join(t3CodeStateDir, "secrets", "key.bin"), "secret");
  yield* fileSystem.writeFileString(path.join(t3CodeStateDir, "attachments", "a.png"), "png");
  return { fileSystem, path, stateDir, t3CodeStateDir };
});

describe("importT3CodeData", () => {
  it.effect("copies threads and preferences once, but not T3 Code's identity", () =>
    Effect.gen(function* () {
      const { fileSystem, path, stateDir, t3CodeStateDir } = yield* setup;

      const first = yield* importT3CodeData({ stateDir, t3CodeStateDir });
      assert.strictEqual(first.status, "imported");

      const database = new NodeSqlite.DatabaseSync(path.join(stateDir, "state.sqlite"), {
        readOnly: true,
      });
      const rows = database.prepare("SELECT title FROM threads").all();
      database.close();
      assert.deepStrictEqual(
        rows.map((row) => row.title),
        ["Аудит диска"],
      );
      assert.isTrue(yield* fileSystem.exists(path.join(stateDir, "settings.json")));
      assert.isTrue(yield* fileSystem.exists(path.join(stateDir, "attachments", "a.png")));
      assert.isFalse(yield* fileSystem.exists(path.join(stateDir, "environment-id")));
      assert.isFalse(yield* fileSystem.exists(path.join(stateDir, "secrets")));

      const second = yield* importT3CodeData({ stateDir, t3CodeStateDir });
      assert.deepStrictEqual(second, { status: "skipped", reason: "already-imported" });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("leaves Helm alone when there is nothing to import", () =>
    Effect.gen(function* () {
      const { path, stateDir } = yield* setup;
      const result = yield* importT3CodeData({
        stateDir,
        t3CodeStateDir: path.join(stateDir, "..", "missing"),
      });
      assert.deepStrictEqual(result, { status: "skipped", reason: "no-t3code-state" });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
