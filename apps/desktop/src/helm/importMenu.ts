import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import { requestT3CodeImport } from "./importT3CodeData.ts";

// Helm fork: Helm menu → "Import from T3 Code…". Confirms, leaves a request
// for the next launch (importT3CodeData.ts) and relaunches, because the import
// must run before the backend opens Helm's database. The file services are
// looked up optionally so the upstream menu layer keeps its requirements.
export const makeImportFromT3CodeAction = Effect.gen(function* () {
  const electronApp = yield* ElectronApp.ElectronApp;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* Effect.serviceOption(FileSystem.FileSystem);
  const path = yield* Effect.serviceOption(Path.Path);

  return Effect.gen(function* () {
    if (Option.isNone(fileSystem) || Option.isNone(path)) return;
    const dialog = yield* ElectronDialog.ElectronDialog;
    const { response } = yield* dialog.showMessageBox({
      type: "warning",
      title: "Import from T3 Code",
      message: "Replace Helm's threads and projects with a copy of T3 Code's?",
      detail:
        "Helm restarts and copies T3 Code's threads, projects, attachments and settings. " +
        "Helm's current data is moved to a backup folder in its data directory. " +
        "T3 Code itself is not changed.",
      buttons: ["Import and Restart", "Cancel"],
      defaultId: 1,
      cancelId: 1,
    });
    if (response !== 0) return;
    yield* requestT3CodeImport(environment.stateDir).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem.value),
      Effect.provideService(Path.Path, path.value),
    );
    yield* electronApp.relaunch({});
    yield* electronApp.quit;
  }).pipe(Effect.withSpan("helm.importFromT3CodeMenu"));
});
