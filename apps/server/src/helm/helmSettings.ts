import { DEFAULT_SERVER_SETTINGS, type HelmServerSettingsFields } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { ServerSettingsService } from "../serverSettings.ts";

// Helm fork: the server's Helm switches (contracts/helmSettings.ts). A setting that
// cannot be read counts as its default, so a broken settings file never turns a feature off.
type HelmServerSetting = keyof typeof HelmServerSettingsFields;

export const readHelmSetting = (key: HelmServerSetting) =>
  Effect.serviceOption(ServerSettingsService).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed(DEFAULT_SERVER_SETTINGS[key]),
        onSome: (settings) =>
          settings.getSettings.pipe(
            Effect.map((current) => current[key]),
            Effect.orElseSucceed(() => DEFAULT_SERVER_SETTINGS[key]),
          ),
      }),
    ),
  );

/** The setting now, then each time it changes. */
export const helmSettingChanges = Effect.fn("helm.settingChanges")(function* (
  key: HelmServerSetting,
) {
  const settings = yield* ServerSettingsService;
  const changes = yield* settings.subscribeChanges;
  const initial = yield* readHelmSetting(key);
  return Stream.concat(
    Stream.make(initial),
    changes.pipe(Stream.map((current) => current[key])),
  ).pipe(Stream.changes);
});
