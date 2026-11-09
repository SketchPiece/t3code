import { useClientSettings } from "~/hooks/useSettings";

import { DraftSyncCoordinator } from "./DraftSyncCoordinator";
import { RemoteCommandCoordinator } from "./RemoteCommandCoordinator";

// Helm fork: Helm Mobile's remote and shared drafts, each behind its switch in Settings → Helm.
export function HelmCoordinators() {
  const remote = useClientSettings((settings) => settings.helmRemoteEnabled);
  const draftSync = useClientSettings((settings) => settings.helmDraftSyncEnabled);
  return (
    <>
      {remote ? <RemoteCommandCoordinator /> : null}
      {draftSync ? <DraftSyncCoordinator /> : null}
    </>
  );
}
