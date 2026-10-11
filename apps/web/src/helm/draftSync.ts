import {
  parseScopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import { request, subscribe } from "@t3tools/client-runtime/rpc";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  DEFAULT_SERVER_SETTINGS,
  type EnvironmentId,
  HELM_PROJECT_DRAFT_KEY_PREFIX,
  type HelmDraft,
  type HelmDraftAttachment,
  type HelmDraftEvent,
  type HelmDraftSetInput,
  type ProjectId,
  type ScopedProjectRef,
  type ThreadId,
  WS_METHODS,
  helmDraftIsEmpty,
  helmProjectDraftKey,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import {
  type ComposerFileAttachment,
  type ComposerThreadDraftState,
  type ComposerThreadTarget,
  type DraftId,
  useComposerDraftStore,
} from "../composerDraftStore";
import { getClientSettings } from "../hooks/useSettings";
import {
  adoptAttachmentUpload,
  forgetAttachmentUpload,
  startAttachmentUpload,
  useAttachmentUploadStore,
} from "../lib/attachmentUploadQueue";
import type { AttachmentUploadState } from "../lib/attachmentUploadState";
import { resolveNewDraftStartFromOrigin } from "../lib/chatThreadActions";
import { readFileAsDataUrl } from "../lib/imageCompression";
import { newDraftId, newThreadId, randomUUID } from "../lib/utils";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "../logicalProject";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { assetEnvironment } from "../state/assets";
import { readProjects } from "../state/entities";
import { environmentProjects } from "../state/projects";
import { environmentServerConfigsAtom } from "../state/server";
import { readEnvironmentScope, readPreparedConnection } from "../state/session";
import {
  type LocalAttachmentView,
  type LocalDraftView,
  contentSignature,
  decideChange,
  decideSnapshotKey,
  isDirty,
  localFingerprint,
  mergeIncomingPrompt,
  outgoingContent,
  reconcileAttachments,
  syncedPromptText,
  viewIsEmpty,
  viewIsSettled,
} from "./draftSyncLogic";

// Helm fork: unsent drafts shared by Helm and Helm Mobile (contracts/helmDrafts.ts). Every
// environment's `helm.drafts.subscribe` feeds its drafts into the composer draft store, and local
// edits go back with `helm.drafts.set` a moment after typing stops.
// - A server thread's draft is keyed by its thread id; a project's new thread not sent yet (its
//   newest draft session with something in it) by "project:<projectId>".
// - Words, pictures and files are shared. Terminal output, review comments, preview annotations,
//   thread contexts and model or mode picks stay on this machine.
// - Each environment remembers (localStorage) a stamp of every draft as it was when last in sync.
//   A draft whose stamp changed was edited here since and wins; otherwise the server's is the truth.

const PUSH_DELAY_MS = 400;
const SEND_TIMEOUT = "20 seconds";
const RETRY_DELAY_MS = 5_000;
const FETCH_TIMEOUT_MS = 60_000;
const STORAGE_PREFIX = "helm:draft-sync:v1:";

/** This window, so its own writes coming back are told apart from the phone's. */
const clientId = randomUUID();

interface LocalEntry {
  readonly target: ComposerThreadTarget;
  readonly draft: ComposerThreadDraftState;
  readonly view: LocalDraftView;
}

interface EnvironmentSync {
  /** A snapshot arrived on the current subscription: the server's drafts are known. */
  live: boolean;
  /** The server's drafts as last heard (non-empty ones), including this window's own writes. */
  readonly server: Map<string, HelmDraft>;
  /** Stamp of each draft as it was when last in sync (persisted). */
  readonly synced: Record<string, string>;
  readonly inFlight: Set<string>;
  readonly applying: Map<string, Promise<void>>;
}

const environments = new Map<EnvironmentId, EnvironmentSync>();
let sendDraft:
  | ((environmentId: EnvironmentId, input: HelmDraftSetInput) => Promise<boolean>)
  | null = null;
let pushTimer: ReturnType<typeof setTimeout> | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
const unsavedEnvironments = new Set<EnvironmentId>();
/** Project drafts that came before their project was known here, retried as projects arrive. */
const waitingForProject = new Map<string, { environmentId: EnvironmentId; key: string }>();

function environment(environmentId: EnvironmentId): EnvironmentSync {
  const existing = environments.get(environmentId);
  if (existing) return existing;
  let synced: Record<string, string> = {};
  try {
    const raw = localStorage.getItem(`${STORAGE_PREFIX}${environmentId}`);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === "object") synced = parsed as Record<string, string>;
  } catch {
    // Unreadable: every local draft counts as never synced and is offered to the server.
  }
  const created: EnvironmentSync = {
    live: false,
    server: new Map(),
    synced,
    inFlight: new Set(),
    applying: new Map(),
  };
  environments.set(environmentId, created);
  return created;
}

function markSynced(environmentId: EnvironmentId, key: string, fingerprint: string | null): void {
  const sync = environment(environmentId);
  if ((sync.synced[key] ?? null) === fingerprint) return;
  if (fingerprint === null) delete sync.synced[key];
  else sync.synced[key] = fingerprint;
  unsavedEnvironments.add(environmentId);
  saveTimer ??= setTimeout(() => {
    saveTimer = null;
    for (const id of unsavedEnvironments) {
      try {
        localStorage.setItem(`${STORAGE_PREFIX}${id}`, JSON.stringify(environment(id).synced));
      } catch {
        // Storage full or unavailable: the stamps live on in memory for this session.
      }
    }
    unsavedEnvironments.clear();
  }, 500);
}

function rememberServerDraft(sync: EnvironmentSync, draft: HelmDraft): void {
  if (helmDraftIsEmpty(draft)) sync.server.delete(draft.key);
  else sync.server.set(draft.key, draft);
}

// ── Local drafts ────────────────────────────────────────────────────────────

const viewCache = new WeakMap<
  ComposerThreadDraftState,
  {
    readonly environmentId: EnvironmentId;
    readonly uploads: Readonly<Record<string, AttachmentUploadState>>;
    readonly view: LocalDraftView | null;
  }
>();

function readyUploadId(
  upload: AttachmentUploadState | undefined,
  environmentId: EnvironmentId,
): string | null {
  return upload?.status === "ready" && upload.environmentId === environmentId
    ? upload.attachmentId
    : null;
}

function fileUploadId(
  file: ComposerFileAttachment,
  environmentId: EnvironmentId,
  uploads: Readonly<Record<string, AttachmentUploadState>>,
): string | null {
  if (file.uploadedAttachmentId !== undefined && file.uploadEnvironmentId === environmentId) {
    return file.uploadedAttachmentId;
  }
  return readyUploadId(uploads[file.id], environmentId);
}

/** The shared part of a composer draft (null when it has none), cached per draft object. */
function viewOf(
  draft: ComposerThreadDraftState,
  environmentId: EnvironmentId,
  uploads: Readonly<Record<string, AttachmentUploadState>>,
): LocalDraftView | null {
  const hasAttachments = draft.images.length > 0 || draft.files.length > 0;
  const cached = viewCache.get(draft);
  if (
    cached &&
    cached.environmentId === environmentId &&
    (!hasAttachments || cached.uploads === uploads)
  ) {
    return cached.view;
  }
  const attachments: LocalAttachmentView[] = [];
  for (const image of draft.images) {
    const upload = uploads[image.id];
    const attachmentId = readyUploadId(upload, environmentId);
    attachments.push({
      localId: image.id,
      type: "image",
      name: image.name,
      mimeType: image.mimeType,
      sizeBytes: image.sizeBytes,
      attachmentId,
      // No upload yet (or one to another environment) gets started before the push.
      pending:
        attachmentId === null &&
        !(upload?.status === "failed" && upload.environmentId === environmentId),
    });
  }
  for (const file of draft.files) {
    const attachmentId = fileUploadId(file, environmentId, uploads);
    const upload = uploads[file.id];
    attachments.push({
      localId: file.id,
      type: "file",
      name: file.name,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
      attachmentId,
      // Files upload from the open composer; one not uploading now is not waited for.
      pending:
        attachmentId === null &&
        upload?.status === "uploading" &&
        upload.environmentId === environmentId,
    });
  }
  const candidate: LocalDraftView = { text: syncedPromptText(draft.prompt), attachments };
  const view = viewIsEmpty(candidate) ? null : candidate;
  viewCache.set(draft, { environmentId, uploads, view });
  return view;
}

/** The unsent new-thread draft that stands for a project: the newest one with something in it. */
function projectDraftSession(
  environmentId: EnvironmentId,
  projectId: ProjectId,
): { readonly draftId: DraftId; readonly view: LocalDraftView } | null {
  const state = useComposerDraftStore.getState();
  const uploads = useAttachmentUploadStore.getState().uploadsByImageId;
  let best: { draftId: DraftId; view: LocalDraftView; createdAt: string } | null = null;
  for (const [draftId, session] of Object.entries(state.draftThreadsByThreadKey)) {
    if (session.promotedTo || session.environmentId !== environmentId) continue;
    if (session.projectId !== projectId) continue;
    const draft = state.draftsByThreadKey[draftId];
    const view = draft ? viewOf(draft, environmentId, uploads) : null;
    if (view === null || (best !== null && best.createdAt >= session.createdAt)) continue;
    best = { draftId: draftId as DraftId, view, createdAt: session.createdAt };
  }
  return best;
}

/** Every local draft with something to share, by environment and draft key. */
function collectLocalDrafts(): Map<EnvironmentId, Map<string, LocalEntry>> {
  const state = useComposerDraftStore.getState();
  const uploads = useAttachmentUploadStore.getState().uploadsByImageId;
  const result = new Map<EnvironmentId, Map<string, LocalEntry>>();
  const add = (environmentId: EnvironmentId, key: string, entry: LocalEntry): void => {
    let entries = result.get(environmentId);
    if (!entries) {
      entries = new Map();
      result.set(environmentId, entries);
    }
    entries.set(key, entry);
  };
  const newestProjectDrafts = new Map<string, { createdAt: string; entry: LocalEntry }>();
  for (const [composerKey, draft] of Object.entries(state.draftsByThreadKey)) {
    const session = state.draftThreadsByThreadKey[composerKey];
    if (session) {
      // A draft mid-send belongs to neither its project nor its thread for that moment.
      if (session.promotedTo) continue;
      const view = viewOf(draft, session.environmentId, uploads);
      if (view === null) continue;
      const id = `${session.environmentId}\u0000${session.projectId}`;
      const current = newestProjectDrafts.get(id);
      if (current && current.createdAt >= session.createdAt) continue;
      newestProjectDrafts.set(id, {
        createdAt: session.createdAt,
        entry: { target: composerKey as DraftId, draft, view },
      });
      continue;
    }
    const ref = parseScopedThreadKey(composerKey);
    if (!ref) continue;
    const view = viewOf(draft, ref.environmentId, uploads);
    if (view !== null) add(ref.environmentId, ref.threadId, { target: ref, draft, view });
  }
  for (const { entry } of newestProjectDrafts.values()) {
    const session = state.draftThreadsByThreadKey[entry.target as string]!;
    add(session.environmentId, helmProjectDraftKey(session.projectId), entry);
  }
  return result;
}

const fingerprints = new WeakMap<LocalDraftView, string | null>();

/** `localFingerprint`, worked out once per view (views are cached per draft object). */
function fingerprintOf(view: LocalDraftView | null): string | null {
  if (view === null) return null;
  let fingerprint = fingerprints.get(view);
  if (fingerprint === undefined) {
    fingerprint = localFingerprint(view);
    fingerprints.set(view, fingerprint);
  }
  return fingerprint;
}

function localEntry(environmentId: EnvironmentId, key: string): LocalEntry | null {
  return collectLocalDrafts().get(environmentId)?.get(key) ?? null;
}

// ── Outgoing ────────────────────────────────────────────────────────────────

function schedulePush(): void {
  pushTimer ??= setTimeout(() => {
    pushTimer = null;
    pushDirtyDrafts();
  }, PUSH_DELAY_MS);
}

function pushDirtyDrafts(): void {
  const local = collectLocalDrafts();
  for (const [environmentId, sync] of environments) {
    // A connection that may only read keeps its drafts to itself.
    if (!sync.live || !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) continue;
    const entries = local.get(environmentId);
    const keys = new Set([...(entries?.keys() ?? []), ...Object.keys(sync.synced)]);
    for (const key of keys) pushIfDirty(environmentId, sync, key, entries?.get(key) ?? null);
  }
}

/** Pictures of a draft not uploaded to its server yet start uploading; the push follows them. */
function startMissingUploads(environmentId: EnvironmentId, entry: LocalEntry): void {
  const uploads = useAttachmentUploadStore.getState().uploadsByImageId;
  for (const image of entry.draft.images) {
    const upload = uploads[image.id];
    if (upload && upload.environmentId === environmentId) continue;
    startAttachmentUpload({ environmentId, image, draftTarget: entry.target });
  }
}

function pushIfDirty(
  environmentId: EnvironmentId,
  sync: EnvironmentSync,
  key: string,
  entry: LocalEntry | null,
): void {
  if (sync.inFlight.has(key) || sync.applying.has(key)) return;
  const view = entry?.view ?? null;
  const fingerprint = fingerprintOf(view);
  if (fingerprint === (sync.synced[key] ?? null)) return;
  if (entry) startMissingUploads(environmentId, entry);
  const settled = viewIsSettled(view);
  const outgoing = outgoingContent(view);
  const known = sync.server.get(key);
  if (contentSignature(outgoing) === contentSignature(known)) {
    if (settled) markSynced(environmentId, key, fingerprint);
    return;
  }
  if (!sendDraft) return;
  sync.inFlight.add(key);
  rememberServerDraft(sync, {
    key,
    ...outgoing,
    clientId,
    updatedAt: known?.updatedAt ?? 0,
  });
  void sendDraft(environmentId, {
    key,
    text: outgoing.text,
    attachments: [...outgoing.attachments],
    clientId,
  }).then((sent) => {
    sync.inFlight.delete(key);
    if (sent) {
      if (settled) markSynced(environmentId, key, fingerprint);
      schedulePush();
      return;
    }
    // Not taken: forget the guess and try again in a while (a reconnect's snapshot also does).
    if ((sync.server.get(key)?.clientId ?? clientId) === clientId) {
      if (known) sync.server.set(key, known);
      else sync.server.delete(key);
    }
    setTimeout(schedulePush, RETRY_DELAY_MS);
  });
}

// ── Incoming ────────────────────────────────────────────────────────────────

/** Opens a project's new-thread draft the way the sidebar's "new thread" does, minus navigating. */
function createProjectDraftSession(projectRef: ScopedProjectRef): DraftId | null {
  const project = readProjects().find(
    (candidate) =>
      candidate.id === projectRef.projectId && candidate.environmentId === projectRef.environmentId,
  );
  if (!project) return null;
  const store = useComposerDraftStore.getState();
  const logicalProjectKey = deriveLogicalProjectKeyFromSettings(
    project,
    selectProjectGroupingSettings(getClientSettings()),
  );
  // An empty draft already waiting for this project is the one to fill.
  const waiting = store.getDraftSessionByLogicalProjectKey(logicalProjectKey);
  if (
    waiting &&
    waiting.environmentId === projectRef.environmentId &&
    waiting.projectId === projectRef.projectId
  ) {
    return waiting.draftId;
  }
  const serverSettings =
    appAtomRegistry.get(environmentServerConfigsAtom).get(projectRef.environmentId)?.settings ??
    DEFAULT_SERVER_SETTINGS;
  const { settings } = resolveProjectSettings(serverSettings, project.id, project);
  const envMode = settings.defaultThreadEnvMode ?? "local";
  const draftId = newDraftId();
  store.setLogicalProjectDraftThreadId(logicalProjectKey, projectRef, draftId, {
    threadId: newThreadId(),
    createdAt: new Date().toISOString(),
    branch: null,
    worktreePath: null,
    envMode,
    startFromOrigin: resolveNewDraftStartFromOrigin({
      envMode,
      newWorktreesStartFromOrigin: settings.newWorktreesStartFromOrigin,
    }),
    runtimeMode: settings.defaultRuntimeMode,
  });
  store.applyStickyState(draftId);
  if (settings.defaultModelSelection) {
    store.setModelSelection(draftId, settings.defaultModelSelection, { replaceOptions: true });
  }
  return draftId;
}

/** Where a draft key's content lives here; a project's draft is opened when `create` asks. */
function resolveTarget(
  environmentId: EnvironmentId,
  key: string,
  create: boolean,
): ComposerThreadTarget | null {
  if (!key.startsWith(HELM_PROJECT_DRAFT_KEY_PREFIX)) {
    return scopeThreadRef(environmentId, key as ThreadId);
  }
  const projectId = key.slice(HELM_PROJECT_DRAFT_KEY_PREFIX.length) as ProjectId;
  const projectRef = scopeProjectRef(environmentId, projectId);
  const invested = projectDraftSession(environmentId, projectId);
  if (invested) return invested.draftId;
  const mapped = useComposerDraftStore.getState().getDraftSessionByProjectRef(projectRef);
  if (mapped) return mapped.draftId;
  return create ? createProjectDraftSession(projectRef) : null;
}

/** Brings a picture of the remote draft over and adds it, linked to its upload. */
async function addRemoteImage(
  environmentId: EnvironmentId,
  target: ComposerThreadTarget,
  attachment: HelmDraftAttachment,
): Promise<void> {
  const connection = readPreparedConnection(environmentId);
  if (!connection) return;
  const result = await executeAtomQuery(
    appAtomRegistry,
    assetEnvironment.createUrl({
      environmentId,
      input: { resource: { _tag: "attachment", attachmentId: attachment.attachmentId } },
    }),
    { reportFailure: false, reportDefect: false },
  );
  if (result._tag !== "Success") return;
  const url = resolveAssetUrl(connection.httpBaseUrl, result.value.relativeUrl);
  if (!url) return;
  const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) return;
  const blob = await response.blob();
  const mimeType = attachment.mimeType || blob.type;
  if (!mimeType.startsWith("image/")) return;
  const file = new File([blob], attachment.name, { type: mimeType });
  const dataUrl = await readFileAsDataUrl(file);
  const id = randomUUID();
  adoptAttachmentUpload({ id, environmentId, attachmentId: attachment.attachmentId });
  const store = useComposerDraftStore.getState();
  const accepted = store.addImage(target, {
    type: "image",
    id,
    name: attachment.name,
    mimeType,
    sizeBytes: file.size,
    previewUrl: dataUrl,
    file,
  });
  if (!accepted) {
    forgetAttachmentUpload(id);
    return;
  }
  // Kept with the draft across reloads, the way the open composer keeps pictures.
  const persisted = store.getComposerDraft(target)?.persistedAttachments ?? [];
  await store.syncPersistedAttachments(target, [
    ...persisted.filter((entry) => entry.id !== id),
    { id, name: attachment.name, mimeType, sizeBytes: file.size, dataUrl },
  ]);
}

/** Makes the local draft say what the server's says (null: clears the shared part). */
async function applyServerDraft(
  environmentId: EnvironmentId,
  key: string,
  draft: HelmDraft | null,
): Promise<void> {
  const remote = draft !== null && !helmDraftIsEmpty(draft) ? draft : null;
  const target = resolveTarget(environmentId, key, remote !== null);
  if (target === null) {
    if (remote !== null)
      waitingForProject.set(`${environmentId}\u0000${key}`, { environmentId, key });
    return;
  }
  const store = useComposerDraftStore.getState();
  const current = store.getComposerDraft(target);
  const uploads = useAttachmentUploadStore.getState().uploadsByImageId;
  const view = current ? viewOf(current, environmentId, uploads) : null;
  const plan = reconcileAttachments(view?.attachments ?? [], remote?.attachments ?? []);
  for (const entry of plan.remove) {
    if (entry.type === "image") {
      forgetAttachmentUpload(entry.localId);
      store.removeImage(target, entry.localId);
    } else {
      forgetAttachmentUpload(entry.localId);
      store.removeFile(target, entry.localId);
    }
  }
  for (const { local, attachmentId } of plan.adopt) {
    if (local.type === "image") {
      adoptAttachmentUpload({ id: local.localId, environmentId, attachmentId });
    } else {
      store.setFileUpload(target, local.localId, environmentId, attachmentId);
    }
  }
  const files: ComposerFileAttachment[] = plan.add
    .filter((entry) => entry.type === "file")
    .map((entry) => ({
      type: "file",
      id: randomUUID(),
      name: entry.name,
      mimeType: entry.mimeType,
      sizeBytes: entry.sizeBytes,
      // Like a file restored after a reload: no bytes here, its upload is on the server.
      file: null,
      uploadedAttachmentId: entry.attachmentId,
      uploadEnvironmentId: environmentId,
    }));
  if (files.length > 0) store.addFiles(target, files);
  const prompt = store.getComposerDraft(target)?.prompt ?? "";
  const nextPrompt = mergeIncomingPrompt(prompt, remote?.text ?? "");
  if (nextPrompt !== prompt) store.setPrompt(target, nextPrompt);
  for (const entry of plan.add) {
    if (entry.type !== "image") continue;
    try {
      await addRemoteImage(environmentId, target, entry);
    } catch {
      // Not reachable now: the draft goes on without it.
    }
  }
}

/** Applies one draft after any still being applied to the same key; then records it as synced. */
function queueApply(environmentId: EnvironmentId, key: string, draft: HelmDraft | null): void {
  const sync = environment(environmentId);
  const previous = sync.applying.get(key) ?? Promise.resolve();
  const next: Promise<void> = previous
    .then(() => applyServerDraft(environmentId, key, draft))
    .catch(() => undefined)
    .finally(() => {
      if (sync.applying.get(key) !== next) return;
      sync.applying.delete(key);
      const view = localEntry(environmentId, key)?.view ?? null;
      // In line with the server now; anything typed meanwhile stays a local edit and goes out.
      if (
        viewIsSettled(view) &&
        contentSignature(outgoingContent(view)) === contentSignature(sync.server.get(key))
      ) {
        markSynced(environmentId, key, localFingerprint(view));
      }
      schedulePush();
    });
  sync.applying.set(key, next);
}

function receiveSnapshot(environmentId: EnvironmentId, drafts: ReadonlyArray<HelmDraft>): void {
  const sync = environment(environmentId);
  sync.server.clear();
  for (const draft of drafts) rememberServerDraft(sync, draft);
  sync.live = true;
  const local = collectLocalDrafts().get(environmentId);
  const keys = new Set([
    ...(local?.keys() ?? []),
    ...sync.server.keys(),
    ...Object.keys(sync.synced),
  ]);
  for (const key of keys) {
    const view = local?.get(key)?.view ?? null;
    const server = sync.server.get(key) ?? null;
    const decision = decideSnapshotKey({
      local: view,
      syncedFingerprint: sync.synced[key],
      server,
    });
    if (decision === "apply") queueApply(environmentId, key, server);
    else if (decision === "clear") queueApply(environmentId, key, null);
    else if (decision === "none" && view === null && server === null) {
      markSynced(environmentId, key, null);
    }
    // "push": the next pass sends it.
  }
  schedulePush();
}

function receiveChange(environmentId: EnvironmentId, draft: HelmDraft): void {
  const sync = environment(environmentId);
  rememberServerDraft(sync, draft);
  if (!sync.live) return;
  const view = localEntry(environmentId, draft.key)?.view ?? null;
  const localDirty = sync.inFlight.has(draft.key) || isDirty(view, sync.synced[draft.key]);
  if (decideChange({ ownClientId: clientId, draft, localDirty }) === "apply") {
    queueApply(environmentId, draft.key, draft);
  } else if (localDirty) {
    // Local edits win: the push that follows overwrites the server's draft.
    schedulePush();
  }
}

/** Handles one event of an environment's `helm.drafts.subscribe`, in arrival order. */
export function receiveDraftEvent(environmentId: EnvironmentId, event: HelmDraftEvent): void {
  if (event.type === "snapshot") receiveSnapshot(environmentId, event.drafts);
  else receiveChange(environmentId, event.draft);
}

function followEnvironments(environmentIds: ReadonlyArray<EnvironmentId>): void {
  const current = new Set(environmentIds);
  for (const [environmentId, sync] of environments) {
    if (!current.has(environmentId)) sync.live = false;
  }
}

function retryWaitingProjectDrafts(): void {
  if (waitingForProject.size === 0) return;
  const waiting = [...waitingForProject.values()];
  waitingForProject.clear();
  for (const { environmentId, key } of waiting) {
    const sync = environment(environmentId);
    const server = sync.server.get(key);
    if (!server || !sync.live) continue;
    const view = localEntry(environmentId, key)?.view ?? null;
    if (!isDirty(view, sync.synced[key])) queueApply(environmentId, key, server);
  }
}

/** Starts pushing local edits; returns the stop. Mounted once (DraftSyncCoordinator). */
export function startDraftSync(): () => void {
  const stopDrafts = useComposerDraftStore.subscribe((state, previous) => {
    if (
      state.draftsByThreadKey !== previous.draftsByThreadKey ||
      state.draftThreadsByThreadKey !== previous.draftThreadsByThreadKey
    ) {
      schedulePush();
    }
  });
  // A finished upload is what lets a picture or file go out.
  const stopUploads = useAttachmentUploadStore.subscribe(schedulePush);
  const stopProjects = appAtomRegistry.subscribe(
    environmentProjects.projectsAtom,
    retryWaitingProjectDrafts,
  );
  schedulePush();
  return () => {
    stopDrafts();
    stopUploads();
    stopProjects();
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = null;
  };
}

// ── Connection ──────────────────────────────────────────────────────────────

interface OutgoingDraft {
  readonly environmentId: EnvironmentId;
  readonly input: HelmDraftSetInput;
  readonly done: (sent: boolean) => void;
}

const sameIds = (left: ReadonlyArray<EnvironmentId>, right: ReadonlyArray<EnvironmentId>) =>
  left.length === right.length && left.every((id, index) => id === right[index]);

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    if (typeof window === "undefined") return;
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    const outbox = yield* Queue.unbounded<OutgoingDraft>();
    sendDraft = (environmentId, input) =>
      new Promise((done) => {
        Queue.offerUnsafe(outbox, { environmentId, input, done });
      });
    yield* Stream.fromQueue(outbox).pipe(
      Stream.mapEffect(
        ({ environmentId, input, done }) =>
          registry
            .run(environmentId, request(WS_METHODS.helmDraftsSet, input))
            .pipe(
              Effect.timeout(SEND_TIMEOUT),
              Effect.match({ onFailure: () => done(false), onSuccess: () => done(true) }),
            ),
        { concurrency: "unbounded" },
      ),
      Stream.runDrain,
      Effect.forkScoped,
    );
    yield* SubscriptionRef.changes(registry.entries).pipe(
      Stream.map((entries) => Array.from(entries.keys()).toSorted()),
      // Only a change in which environments exist restarts the subscriptions.
      Stream.changesWith(sameIds),
      Stream.tap((environmentIds) => Effect.sync(() => followEnvironments(environmentIds))),
      Stream.switchMap((environmentIds) =>
        Stream.mergeAll(
          environmentIds.map((environmentId) =>
            registry.runStream(environmentId, subscribe(WS_METHODS.helmDraftsSubscribe, {})).pipe(
              Stream.map((event) => [environmentId, event] as const),
              // Servers without shared drafts end the stream; nothing to sync there.
              Stream.catchCause(() => Stream.empty),
            ),
          ),
          { concurrency: "unbounded" },
        ),
      ),
      Stream.runForEach(([environmentId, event]) =>
        Effect.sync(() => receiveDraftEvent(environmentId, event)),
      ),
      Effect.forkScoped,
    );
  }),
);
