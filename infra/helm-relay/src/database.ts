import * as PgClient from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as Redacted from "effect/Redacted";

// drizzle-orm's types are nominal and pnpm installs a copy per peer set, so a
// database built with this package's copy would not satisfy RelayDb. Borrow the
// relay's own copy instead.
import * as PgDrizzle from "../../relay/node_modules/drizzle-orm/effect-postgres/index.js";
import { migrate } from "../../relay/node_modules/drizzle-orm/effect-postgres/migrator.js";
import * as RelayDb from "t3code-relay/src/db.ts";

/**
 * One long-lived pool for the process, where the Worker opened one per
 * request through Hyperdrive. Upstream's drizzle-kit migrations (the folder
 * Alchemy applies to PlanetScale) run before the relay serves.
 */
export const relayDbLayer = (databaseUrl: Redacted.Redacted<string>) =>
  Layer.effect(
    RelayDb.RelayDb,
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const migrationsFolder = path.join(
        path.dirname(yield* path.fromFileUrl(new URL(import.meta.url))),
        "../../relay/migrations/postgres",
      );
      const db = yield* PgDrizzle.makeWithDefaults();
      yield* migrate(db, { migrationsFolder, migrationsTable: "relay_migrations" });
      return db;
    }),
  ).pipe(Layer.provide(PgClient.layer({ url: databaseUrl })));
