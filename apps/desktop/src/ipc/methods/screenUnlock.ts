import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as DesktopAppSettings from "../../settings/DesktopAppSettings.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod, makeSyncIpcMethod } from "../DesktopIpc.ts";

export const getScreenUnlockEnabled = makeSyncIpcMethod({
  channel: IpcChannels.GET_SCREEN_UNLOCK_ENABLED_CHANNEL,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.screenUnlock.getEnabled")(function* () {
    const settings = yield* DesktopAppSettings.DesktopAppSettings;
    return (yield* settings.get).screenUnlockEnabled;
  }),
});

export const setScreenUnlockEnabled = makeIpcMethod({
  channel: IpcChannels.SET_SCREEN_UNLOCK_ENABLED_CHANNEL,
  payload: Schema.Boolean,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.screenUnlock.setEnabled")(function* (enabled) {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    if (environment.platform !== "darwin") return;
    const settings = yield* DesktopAppSettings.DesktopAppSettings;
    yield* settings.setScreenUnlockEnabled(enabled);
  }),
});
