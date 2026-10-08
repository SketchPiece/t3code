import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { resolveComposerDraftKey, useComposerDraftStore } from "../composerDraftStore";
import { dispatchSnapShotComposerFocus } from "../lib/desktopSnapShot";
import { buildThreadRouteParams } from "../threadRoutes";
import { onRemoteCommand } from "./remoteCommands";

// Helm fork: acts on Helm Mobile's remote. "thread.open" shows the thread and brings the window
// forward; "composer.insert" shows the thread and adds the dictated words to its draft.
export function RemoteCommandCoordinator() {
  const navigate = useNavigate();

  useEffect(
    () =>
      onRemoteCommand((environmentId, command) => {
        const ref = { environmentId, threadId: command.threadId };
        void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(ref) });
        if (command.type === "thread.open") {
          void window.desktopBridge?.revealWindow?.();
          return;
        }
        const text = command.text.trim();
        if (text.length === 0) return;
        const store = useComposerDraftStore.getState();
        const key = resolveComposerDraftKey(store, ref);
        const current = (key ? store.draftsByThreadKey[key]?.prompt : undefined) ?? "";
        const head = current.replace(/\s+$/, "");
        store.setPrompt(ref, head.length > 0 ? `${head} ${text}` : text);
        dispatchSnapShotComposerFocus();
      }),
    [navigate],
  );

  return null;
}
