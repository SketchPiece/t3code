import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { readHelmPushConfig } from "./pushConfig.ts";

const storeWith = (value: string | null) =>
  ({
    get: () =>
      Effect.succeed(value === null ? Option.none() : Option.some(new TextEncoder().encode(value))),
  }) as unknown as ServerSecretStore.ServerSecretStore["Service"];

describe("readHelmPushConfig", () => {
  it.effect("points the publisher at the Volna core's /helm routes", () =>
    Effect.gen(function* () {
      const config = yield* readHelmPushConfig(
        storeWith('{"url":"https://volna-core.example.app/","token":"secret"}'),
      );
      assert.deepStrictEqual(config, {
        url: "https://volna-core.example.app/helm",
        token: "secret",
      });
    }),
  );

  it.effect("leaves the upstream relay in charge when unset or malformed", () =>
    Effect.gen(function* () {
      assert.isNull(yield* readHelmPushConfig(storeWith(null)));
      assert.isNull(yield* readHelmPushConfig(storeWith('{"url":""}')));
      assert.isNull(yield* readHelmPushConfig(storeWith("not json")));
    }),
  );
});
