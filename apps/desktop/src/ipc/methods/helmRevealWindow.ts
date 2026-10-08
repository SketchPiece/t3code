import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as IpcChannels from "../channels.ts";

// Helm fork: Helm Mobile's "Open on Mac" brings the window forward, even from another app.
export const revealWindow = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.HELM_REVEAL_WINDOW_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.helm.revealWindow")(function* () {
    const windows = yield* ElectronWindow.ElectronWindow;
    const window = yield* windows.currentMainOrFirst;
    if (Option.isSome(window)) yield* windows.reveal(window.value);
  }),
});
