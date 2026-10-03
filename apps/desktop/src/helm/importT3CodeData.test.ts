import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeSqlite from "node:sqlite";

import { importT3CodeData, requestT3CodeImport } from "./importT3CodeData.ts";

const writeDatabase = (file: string, title: string) => {
  const database = new NodeSqlite.DatabaseSync(file);
  database.exec(`CREATE TABLE threads (title TEXT); INSERT INTO threads VALUES ('${title}');`);
  database.close();
};

const readTitles = (file: string) => {
  const database = new NodeSqlite.DatabaseSync(file, { readOnly: true });
  const rows = database.prepare("SELECT title FROM threads").all();
  database.close();
  return rows.map((row) => row.title);
};

const setup = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped();
  const t3CodeStateDir = path.join(root, ".t3", "userdata");
  const stateDir = path.join(root, ".helm", "userdata");
  yield* fileSystem.makeDirectory(path.join(t3CodeStateDir, "attachments"), { recursive: true });
  yield* fileSystem.makeDirectory(path.join(t3CodeStateDir, "secrets"), { recursive: true });
  yield* fileSystem.makeDirectory(stateDir, { recursive: true });
  writeDatabase(path.join(t3CodeStateDir, "statev2.sqlite"), "Аудит диска");
  writeDatabase(path.join(stateDir, "statev2.sqlite"), "Helm own thread");
  yield* fileSystem.writeFileString(path.join(stateDir, "settings.json"), '{"helm":true}');
  yield* fileSystem.writeFileString(path.join(t3CodeStateDir, "settings.json"), "{}");
  yield* fileSystem.writeFileString(path.join(t3CodeStateDir, "environment-id"), "t3-env");
  yield* fileSystem.writeFileString(path.join(t3CodeStateDir, "secrets", "key.bin"), "secret");
  yield* fileSystem.writeFileString(path.join(t3CodeStateDir, "attachments", "a.png"), "png");
  return { fileSystem, path, stateDir, t3CodeStateDir };
});

describe("importT3CodeData", () => {
  it.effect("does nothing until the import is requested", () =>
    Effect.gen(function* () {
      const { path, stateDir, t3CodeStateDir } = yield* setup;
      const result = yield* importT3CodeData({ stateDir, t3CodeStateDir });
      assert.deepStrictEqual(result, { status: "skipped", reason: "not-requested" });
      assert.deepStrictEqual(readTitles(path.join(stateDir, "statev2.sqlite")), [
        "Helm own thread",
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("replaces Helm's state with T3 Code's once, keeping a backup", () =>
    Effect.gen(function* () {
      const { fileSystem, path, stateDir, t3CodeStateDir } = yield* setup;
      yield* requestT3CodeImport(stateDir);

      const result = yield* importT3CodeData({ stateDir, t3CodeStateDir });
      assert.strictEqual(result.status, "imported");
      if (result.status !== "imported") return;

      assert.deepStrictEqual(readTitles(path.join(stateDir, "statev2.sqlite")), ["Аудит диска"]);
      assert.deepStrictEqual(readTitles(path.join(result.backup, "statev2.sqlite")), [
        "Helm own thread",
      ]);
      assert.strictEqual(
        yield* fileSystem.readFileString(path.join(result.backup, "settings.json")),
        '{"helm":true}',
      );
      assert.isTrue(yield* fileSystem.exists(path.join(stateDir, "attachments", "a.png")));
      assert.isFalse(yield* fileSystem.exists(path.join(stateDir, "environment-id")));
      assert.isFalse(yield* fileSystem.exists(path.join(stateDir, "secrets")));

      const again = yield* importT3CodeData({ stateDir, t3CodeStateDir });
      assert.deepStrictEqual(again, { status: "skipped", reason: "not-requested" });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("drops a request when T3 Code has nothing to import", () =>
    Effect.gen(function* () {
      const { path, stateDir } = yield* setup;
      yield* requestT3CodeImport(stateDir);
      const missing = path.join(stateDir, "..", "missing");
      const first = yield* importT3CodeData({ stateDir, t3CodeStateDir: missing });
      assert.deepStrictEqual(first, { status: "skipped", reason: "no-t3code-state" });
      const second = yield* importT3CodeData({ stateDir, t3CodeStateDir: missing });
      assert.deepStrictEqual(second, { status: "skipped", reason: "not-requested" });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
