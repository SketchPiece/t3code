import { type HelmDraft, type HelmDraftAttachment, helmDraftIsEmpty } from "@t3tools/contracts";
import { collectComposerContextReferences } from "@t3tools/shared/composerContextReferences";

import { stripInlineContextReferences } from "../lib/composerContextReferences";

// Helm fork: the pure half of draft sync (draftSync.ts). What a local draft looks like to the
// other device, when it counts as edited since it was last in sync, and what to do with each draft
// the server reports.

/** One picture or file of a local draft, as the server would know it. */
export interface LocalAttachmentView {
  readonly localId: string;
  readonly type: "image" | "file";
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  /** Its upload on the draft's server; null while it uploads or when it can't be uploaded. */
  readonly attachmentId: string | null;
  /** Still uploading: the draft is not in sync until it lands. */
  readonly pending: boolean;
}

/** The shared part of a local draft: its words and its pictures and files. */
export interface LocalDraftView {
  readonly text: string;
  readonly attachments: ReadonlyArray<LocalAttachmentView>;
}

export interface DraftContent {
  readonly text: string;
  readonly attachments: ReadonlyArray<HelmDraftAttachment>;
}

export const EMPTY_DRAFT_CONTENT: DraftContent = { text: "", attachments: [] };

const CONTEXT_LINK_MARK = "](t3-context:";

/**
 * The prompt as the phone sees it: chips for terminal output, review comments and other local
 * context are left out, they only mean something on this machine.
 */
export function syncedPromptText(prompt: string): string {
  if (!prompt.includes(CONTEXT_LINK_MARK)) return prompt;
  return stripInlineContextReferences(prompt)
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export function viewIsEmpty(view: LocalDraftView): boolean {
  return view.text.trim().length === 0 && view.attachments.length === 0;
}

function hash(value: string): string {
  let forward = 0x811c9dc5;
  let reverse = 0x9dc5811c;
  for (let index = 0; index < value.length; index += 1) {
    forward ^= value.charCodeAt(index);
    forward = Math.imul(forward, 0x01000193) >>> 0;
    reverse ^= value.charCodeAt(value.length - 1 - index);
    reverse = Math.imul(reverse, 0x01000193) >>> 0;
  }
  return `${value.length.toString(36)}.${forward.toString(36)}.${reverse.toString(36)}`;
}

/**
 * A short stamp of a local draft (null when there is nothing to share). Stored when the draft was
 * last in sync with the server; a different stamp now means it was edited since.
 */
export function localFingerprint(view: LocalDraftView | null): string | null {
  if (view === null || viewIsEmpty(view)) return null;
  return hash(`${view.text}\u0000${view.attachments.map((entry) => entry.localId).join(",")}`);
}

export function isDirty(view: LocalDraftView | null, syncedFingerprint: string | undefined) {
  return localFingerprint(view) !== (syncedFingerprint ?? null);
}

/** Nothing still uploading: what goes out now is the whole draft. */
export function viewIsSettled(view: LocalDraftView | null): boolean {
  return view === null || !view.attachments.some((entry) => entry.pending);
}

/** What `helm.drafts.set` gets for a local draft. Attachments not uploaded yet are left out. */
export function outgoingContent(view: LocalDraftView | null): DraftContent {
  if (view === null || viewIsEmpty(view)) return EMPTY_DRAFT_CONTENT;
  const attachments: HelmDraftAttachment[] = [];
  for (const entry of view.attachments) {
    if (entry.attachmentId === null) continue;
    attachments.push({
      attachmentId: entry.attachmentId,
      type: entry.type,
      name: entry.name,
      mimeType: entry.mimeType,
      sizeBytes: entry.sizeBytes,
    });
  }
  return { text: view.text, attachments };
}

/** Equal for two drafts the other device would show the same. */
export function contentSignature(content: DraftContent | null | undefined): string {
  if (!content || helmDraftIsEmpty(content)) return "";
  return `${content.text}\u0000${content.attachments.map((entry) => entry.attachmentId).join(",")}`;
}

export type SnapshotDecision =
  /** Edited here since the last sync: this draft wins (the push goes out with the next pass). */
  | "push"
  /** The server's draft replaces the local one. */
  | "apply"
  /** Synced before and gone from the server (sent or cleared elsewhere): clear it here too. */
  | "clear"
  | "none";

/**
 * What a reconnect does with one draft key. The server is the truth for anything already synced;
 * a local draft only wins when it changed since it was last in sync, or was never synced (drafts
 * from before sync existed).
 */
export function decideSnapshotKey(input: {
  readonly local: LocalDraftView | null;
  readonly syncedFingerprint: string | undefined;
  readonly server: HelmDraft | null;
}): SnapshotDecision {
  const local = input.local !== null && !viewIsEmpty(input.local) ? input.local : null;
  const server = input.server !== null && !helmDraftIsEmpty(input.server) ? input.server : null;
  const same = contentSignature(outgoingContent(local)) === contentSignature(server);
  if (isDirty(local, input.syncedFingerprint)) return same ? "none" : "push";
  if (server !== null) return same ? "none" : "apply";
  return local !== null ? "clear" : "none";
}

/**
 * A live change from the server. Our own writes coming back change nothing; another device's
 * write replaces the local draft unless the local one has edits on their way out, which then win.
 */
export function decideChange(input: {
  readonly ownClientId: string;
  readonly draft: HelmDraft;
  readonly localDirty: boolean;
}): "apply" | "ignore" {
  if (input.draft.clientId === input.ownClientId) return "ignore";
  return input.localDirty ? "ignore" : "apply";
}

export interface AttachmentReconciliation {
  /** Local attachments the remote draft no longer has. */
  readonly remove: ReadonlyArray<LocalAttachmentView>;
  /** Local attachments not linked to an upload yet that are the remote's one (same name, size). */
  readonly adopt: ReadonlyArray<{
    readonly local: LocalAttachmentView;
    readonly attachmentId: string;
  }>;
  /** Remote attachments this device does not have yet. */
  readonly add: ReadonlyArray<HelmDraftAttachment>;
}

/** Brings the local pictures and files in line with the remote draft's. */
export function reconcileAttachments(
  local: ReadonlyArray<LocalAttachmentView>,
  remote: ReadonlyArray<HelmDraftAttachment>,
): AttachmentReconciliation {
  const remoteIds = new Set(remote.map((entry) => entry.attachmentId));
  const matched = new Set<string>();
  const remove: LocalAttachmentView[] = [];
  const adopt: Array<{ local: LocalAttachmentView; attachmentId: string }> = [];
  const unlinked: LocalAttachmentView[] = [];
  for (const entry of local) {
    if (entry.attachmentId === null) {
      unlinked.push(entry);
    } else if (remoteIds.has(entry.attachmentId) && !matched.has(entry.attachmentId)) {
      matched.add(entry.attachmentId);
    } else {
      remove.push(entry);
    }
  }
  for (const entry of unlinked) {
    // After a reload a picture's upload is forgotten while the server still has it: same name and
    // size is the same picture, so it is linked instead of downloaded again.
    const twin = remote.find(
      (candidate) =>
        !matched.has(candidate.attachmentId) &&
        candidate.type === entry.type &&
        candidate.name === entry.name &&
        candidate.sizeBytes === entry.sizeBytes,
    );
    if (twin) {
      matched.add(twin.attachmentId);
      adopt.push({ local: entry, attachmentId: twin.attachmentId });
    } else {
      remove.push(entry);
    }
  }
  return {
    remove,
    adopt,
    add: remote.filter((entry) => !matched.has(entry.attachmentId)),
  };
}

/**
 * The local prompt after the remote text arrives. Unchanged when it already says the same; else
 * the remote text with the local-only chips (terminal output, review comments…) kept at its end.
 */
export function mergeIncomingPrompt(localPrompt: string, remoteText: string): string {
  if (syncedPromptText(localPrompt) === remoteText) return localPrompt;
  const chips = collectComposerContextReferences(localPrompt).map((entry) => entry.source);
  if (chips.length === 0) return remoteText;
  const head = remoteText.replace(/\s+$/, "");
  return `${head.length > 0 ? `${head} ` : ""}${chips.join(" ")} `;
}
