// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- a small file store the startup
// attachment sweep also reads synchronously; writes coalesce on a plain timer.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  HelmDraft,
  type HelmDraftEvent,
  type HelmDraftSetInput,
  helmDraftIsEmpty,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

// Helm fork: unsent drafts shared by Helm on the Mac and Helm Mobile (contracts/helmDrafts.ts).
// Kept in memory and in `<stateDir>/helm-drafts.json`, so they outlive restarts; a cleared draft
// is dropped. Their attachments are pending uploads, which the sweep keeps while a draft holds them.

const FILE_NAME = "helm-drafts.json";
/** Old drafts give way past this many; one per thread a user left half-written. */
const MAX_DRAFTS = 500;
const WRITE_DELAY_MS = 1_000;

const decodeFile = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ drafts: Schema.Array(HelmDraft) })),
);

type Listener = (draft: HelmDraft) => void;

interface Store {
  readonly path: string;
  readonly drafts: Map<string, HelmDraft>;
  readonly listeners: Set<Listener>;
  writeTimer: ReturnType<typeof setTimeout> | null;
}

const stores = new Map<string, Store>();

function store(stateDir: string): Store {
  const existing = stores.get(stateDir);
  if (existing) return existing;
  const path = NodePath.join(stateDir, FILE_NAME);
  const drafts = new Map<string, HelmDraft>();
  try {
    const decoded = decodeFile(NodeFS.readFileSync(path, "utf8"));
    if (decoded._tag === "Some") {
      for (const draft of decoded.value.drafts) drafts.set(draft.key, draft);
    }
  } catch {
    // No file yet, or unreadable: start empty.
  }
  const created: Store = { path, drafts, listeners: new Set(), writeTimer: null };
  stores.set(stateDir, created);
  return created;
}

function scheduleWrite(target: Store): void {
  if (target.writeTimer) return;
  target.writeTimer = setTimeout(() => {
    target.writeTimer = null;
    const body = JSON.stringify({ drafts: [...target.drafts.values()] });
    const temporary = `${target.path}.tmp`;
    NodeFS.promises
      .writeFile(temporary, body, "utf8")
      .then(() => NodeFS.promises.rename(temporary, target.path))
      .catch(() => undefined);
  }, WRITE_DELAY_MS);
  target.writeTimer.unref?.();
}

/** Takes a client's draft (empty: clears it) and passes it to every subscriber. */
export const setDraft = (stateDir: string, input: HelmDraftSetInput): Effect.Effect<HelmDraft> =>
  Effect.map(Clock.currentTimeMillis, (now) => {
    const target = store(stateDir);
    const previous = target.drafts.get(input.key);
    // The server's clock orders writes; never let it step back.
    const updatedAt = Math.max(now, (previous?.updatedAt ?? 0) + 1);
    const draft: HelmDraft = {
      key: input.key,
      text: input.text,
      attachments: input.attachments,
      clientId: input.clientId,
      updatedAt,
    };
    target.drafts.delete(input.key);
    if (!helmDraftIsEmpty(draft)) {
      target.drafts.set(input.key, draft);
      // Map order is insertion order: the first entries are the longest untouched.
      for (const key of target.drafts.keys()) {
        if (target.drafts.size <= MAX_DRAFTS) break;
        target.drafts.delete(key);
      }
    }
    scheduleWrite(target);
    for (const listener of target.listeners) listener(draft);
    return draft;
  });

/** Every draft kept now, then each change. */
export const draftEvents = (stateDir: string): Stream.Stream<HelmDraftEvent> =>
  Stream.callback<HelmDraftEvent>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const target = store(stateDir);
        Queue.offerUnsafe(queue, { type: "snapshot", drafts: [...target.drafts.values()] });
        const listener: Listener = (draft) => Queue.offerUnsafe(queue, { type: "changed", draft });
        target.listeners.add(listener);
        return { target, listener };
      }),
      ({ target, listener }) => Effect.sync(() => target.listeners.delete(listener)),
    ),
  );

/** Pending uploads a kept draft still holds, which the stale-upload sweep must leave alone. */
export function draftAttachmentIds(stateDir: string): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const draft of store(stateDir).drafts.values()) {
    for (const attachment of draft.attachments) ids.add(attachment.attachmentId);
  }
  return ids;
}
