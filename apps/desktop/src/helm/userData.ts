import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import { HELM_DESKTOP_IDENTITY } from "./identity.ts";

// Helm fork: Electron's profile lives in Helm's own dir. T3 Code's profiles
// (and the Windows credential-key carry-over upstream does between them) are
// never touched, so the two apps can run side by side.
export const resolveHelmUserDataPath = Effect.fn("desktop.userData.resolveUserDataPath")(
  function* (input: {
    readonly appDataDirectory: string;
    readonly isDevelopment: boolean;
    readonly platform: NodeJS.Platform;
  }) {
    const path = yield* Path.Path;
    return path.join(
      input.appDataDirectory,
      input.isDevelopment
        ? HELM_DESKTOP_IDENTITY.developmentUserDataDirName
        : HELM_DESKTOP_IDENTITY.userDataDirName,
    );
  },
);
