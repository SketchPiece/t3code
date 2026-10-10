import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, HelmRemoteCommand, ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { resolveAssetUrl } from "~/assets/assetUrls";
import { assetEnvironment } from "~/state/assets";
import { readPreparedConnection } from "~/state/session";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";

import { rememberTimelineAtEnd } from "../components/chat/timelineScrollAnchoring";
import { toastManager } from "../components/ui/toast";
import {
  type ComposerThreadTarget,
  resolveComposerDraftKey,
  useComposerDraftStore,
} from "../composerDraftStore";
import { dispatchSnapShotComposerFocus } from "../lib/desktopSnapShot";
import { randomUUID } from "../lib/utils";
import { buildDraftThreadRouteParams, buildThreadRouteParams } from "../threadRoutes";
import { onRemoteCommand } from "./remoteCommands";

// Helm fork: acts on Helm Mobile's remote.
// - "thread.open" shows the thread at its latest messages and brings the window forward (not when
//   the remote only switches threads).
// - "composer.insert" does the same and adds the dictated words to the thread's draft.
// - "composer.attach" does the same and adds a picture the phone uploaded to the draft.
// A new thread not sent yet is opened and typed into as its draft.
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

/** A new thread not sent yet that the ref names, which is where its words and pictures go. */
function unsentDraft(ref: ScopedThreadRef) {
  const store = useComposerDraftStore.getState();
  const draftId = store.getDraftIdByRef(ref);
  if (draftId === null || store.getDraftSession(draftId)?.promotedTo) return null;
  return draftId;
}

export function RemoteCommandCoordinator() {
  const navigate = useNavigate();
  const createAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, { reportFailure: false });

  useEffect(() => {
    /** Brings the picture's bytes over from the server and adds them to the draft. */
    async function attach(
      environmentId: EnvironmentId,
      target: ComposerThreadTarget,
      command: Extract<HelmRemoteCommand, { type: "composer.attach" }>,
    ): Promise<void> {
      const fail = (): void => {
        toastManager.add({
          type: "error",
          title: `Couldn't add ${command.name} from the phone`,
          description: "Add the picture again from Helm Mobile.",
        });
      };
      const connection = readPreparedConnection(environmentId);
      if (!connection) return fail();
      const result = await createAssetUrl({
        environmentId,
        input: { resource: { _tag: "attachment", attachmentId: command.attachmentId } },
      });
      const url =
        result._tag === "Success"
          ? resolveAssetUrl(connection.httpBaseUrl, result.value.relativeUrl)
          : null;
      if (!url) return fail();
      let blob: Blob;
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        blob = await response.blob();
      } catch {
        return fail();
      }
      if (!blob.type.startsWith("image/")) return fail();
      const file = new File([blob], command.name, { type: blob.type });
      const accepted = useComposerDraftStore.getState().addImage(target, {
        type: "image",
        id: randomUUID(),
        name: file.name,
        mimeType: file.type,
        sizeBytes: file.size,
        previewUrl: URL.createObjectURL(file),
        file,
      });
      if (!accepted) return fail();
      dispatchSnapShotComposerFocus();
    }

    return onRemoteCommand((environmentId, command) => {
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
      const draftId = unsentDraft(ref);
      const target: ComposerThreadTarget = draftId ?? ref;
      if (draftId) {
        void navigate({ to: "/draft/$draftId", params: buildDraftThreadRouteParams(draftId) });
      } else {
        // What the remote opens starts at the latest message, not where it was last left.
        rememberTimelineAtEnd(threadKey);
        scroll({ threadKey });
        void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(ref) });
      }
      if (command.type === "thread.open") {
        if (command.reveal !== false) void window.desktopBridge?.revealWindow?.();
        return;
      }
      if (command.type === "composer.attach") {
        void attach(environmentId, target, command);
        return;
      }
      const text = command.text.trim();
      if (text.length === 0) return;
      const store = useComposerDraftStore.getState();
      const key = resolveComposerDraftKey(store, target);
      const current = (key ? store.draftsByThreadKey[key]?.prompt : undefined) ?? "";
      const head = current.replace(/\s+$/, "");
      store.setPrompt(target, head.length > 0 ? `${head} ${text}` : text);
      dispatchSnapShotComposerFocus();
    });
  }, [createAssetUrl, navigate]);

  return null;
}
