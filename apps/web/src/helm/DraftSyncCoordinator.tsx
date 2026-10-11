import { useEffect } from "react";

import { startDraftSync } from "./draftSync";

// Helm fork: keeps unsent drafts shared with Helm Mobile (draftSync.ts). The server side of it
// runs with the connection (connection/runtime.ts); this pushes local edits while the app is up.
export function DraftSyncCoordinator() {
  useEffect(() => startDraftSync(), []);
  return null;
}
