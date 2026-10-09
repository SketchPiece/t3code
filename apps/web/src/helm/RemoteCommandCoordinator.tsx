import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { rememberTimelineAtEnd } from "../components/chat/timelineScrollAnchoring";

import { resolveComposerDraftKey, useComposerDraftStore } from "../composerDraftStore";
import { dispatchSnapShotComposerFocus } from "../lib/desktopSnapShot";
import { buildThreadRouteParams } from "../threadRoutes";
import { onRemoteCommand } from "./remoteCommands";

// Helm fork: acts on Helm Mobile's remote. "thread.open" shows the thread and brings the window
// forward (not when the remote only switches threads); "composer.insert" shows the thread and adds
// the dictated words to its draft.
/** The thread shown already scrolls to its end when the remote opens or types into it. */
export const REMOTE_SCROLL_TO_END_EVENT = "helm:remote-scroll-to-end";

export function RemoteCommandCoordinator() {
  const navigate = useNavigate();

  useEffect(
    () =>
      onRemoteCommand((environmentId, command) => {
        const ref = { environmentId, threadId: command.threadId };
        // What the remote opens starts at the latest message, not where it was last left.
        const threadKey = scopedThreadKey(ref);
        rememberTimelineAtEnd(threadKey);
        window.dispatchEvent(new CustomEvent(REMOTE_SCROLL_TO_END_EVENT, { detail: threadKey }));
        void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(ref) });
        if (command.type === "thread.open") {
          if (command.reveal !== false) void window.desktopBridge?.revealWindow?.();
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
