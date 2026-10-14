import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as DesktopAppSettings from "../../settings/DesktopAppSettings.ts";
import { getScreenUnlockEnabled, setScreenUnlockEnabled } from "./screenUnlock.ts";

const layer = (platform: NodeJS.Platform) =>
  Layer.mergeAll(
    DesktopAppSettings.layerTest(),
    Layer.mock(DesktopEnvironment.DesktopEnvironment, {
      platform,
    } as DesktopEnvironment.DesktopEnvironment["Service"]),
  );

describe("screen unlock IPC", () => {
  it.effect("enables and revokes desktop consent without a relaunch", () =>
    Effect.gen(function* () {
      assert.isFalse(yield* getScreenUnlockEnabled.handler());
      yield* setScreenUnlockEnabled.handler(true);
      assert.isTrue(yield* getScreenUnlockEnabled.handler());
      yield* setScreenUnlockEnabled.handler(false);
      assert.isFalse(yield* getScreenUnlockEnabled.handler());
    }).pipe(Effect.provide(layer("darwin"))),
  );
  it.effect("cannot enable unlocking on a non-Mac desktop", () =>
    Effect.gen(function* () {
      yield* setScreenUnlockEnabled.handler(true);
      assert.isFalse(yield* getScreenUnlockEnabled.handler());
    }).pipe(Effect.provide(layer("linux"))),
  );
});
