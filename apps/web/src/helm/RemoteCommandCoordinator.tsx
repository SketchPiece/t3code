import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { rememberTimelineAtEnd } from "../components/chat/timelineScrollAnchoring";

import { resolveComposerDraftKey, useComposerDraftStore } from "../composerDraftStore";
import { dispatchSnapShotComposerFocus } from "../lib/desktopSnapShot";
import { buildThreadRouteParams } from "../threadRoutes";
import { onRemoteCommand } from "./remoteCommands";

// Helm fork: acts on Helm Mobile's remote.
// - "thread.open" shows the thread at its latest messages and brings the window forward (not when
//   the remote only switches threads).
// - "composer.insert" does the same and adds the dictated words to the thread's draft.
// - "timeline.scroll" moves the shown thread's timeline, the remote being a trackpad for it.

/** Asks the open ChatView to scroll: `by` pixels, or to the end when `by` is missing. */
export const REMOTE_SCROLL_EVENT = "helm:remote-scroll";
export interface RemoteScrollDetail {
  readonly threadKey: string;
  readonly by?: number;
  readonly smooth?: boolean;
}

function scroll(detail: RemoteScrollDetail): void {
  window.dispatchEvent(new CustomEvent<RemoteScrollDetail>(REMOTE_SCROLL_EVENT, { detail }));
}

export function RemoteCommandCoordinator() {
  const navigate = useNavigate();

  useEffect(
    () =>
      onRemoteCommand((environmentId, command) => {
        const ref = { environmentId, threadId: command.threadId };
        const threadKey = scopedThreadKey(ref);
        if (command.type === "timeline.scroll") {
          scroll({
            threadKey,
            ...(command.by === undefined ? {} : { by: command.by }),
            ...(command.smooth === undefined ? {} : { smooth: command.smooth }),
          });
          return;
        }
        // What the remote opens starts at the latest message, not where it was last left.
        rememberTimelineAtEnd(threadKey);
        scroll({ threadKey });
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
