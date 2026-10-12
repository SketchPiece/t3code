import type { ComposerContextId, HelmDraft } from "@t3tools/contracts";
import { formatComposerContextReference } from "@t3tools/shared/composerContextReferences";
import { describe, expect, it } from "vite-plus/test";

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
  viewIsSettled,
} from "./draftSyncLogic";

const image = (overrides: Partial<LocalAttachmentView> = {}): LocalAttachmentView => ({
  localId: "img-1",
  type: "image",
  name: "shot.png",
  mimeType: "image/png",
  sizeBytes: 100,
  attachmentId: "att-1",
  pending: false,
  ...overrides,
});

const view = (text: string, attachments: LocalAttachmentView[] = []): LocalDraftView => ({
  text,
  attachments,
});

const server = (text: string, attachments: HelmDraft["attachments"] = []): HelmDraft => ({
  key: "thread-1",
  text,
  attachments,
  clientId: "phone",
  updatedAt: 1,
});

const remoteImage = {
  attachmentId: "att-1",
  type: "image" as const,
  name: "shot.png",
  mimeType: "image/png",
  sizeBytes: 100,
};

const chip = formatComposerContextReference({
  kind: "terminal",
  contextId: "terminal_abc" as ComposerContextId,
  label: "zsh",
});

describe("syncedPromptText", () => {
  it("leaves plain prompts alone and drops local-only chips", () => {
    expect(syncedPromptText("hello  there ")).toBe("hello  there ");
    expect(syncedPromptText(`look at ${chip} please`)).toBe("look at please");
  });
});

describe("outgoing content", () => {
  it("leaves out attachments still uploading until they land", () => {
    const local = view("hi", [
      image(),
      image({ localId: "img-2", attachmentId: null, pending: true }),
    ]);
    expect(outgoingContent(local).attachments.map((entry) => entry.attachmentId)).toEqual([
      "att-1",
    ]);
    expect(viewIsSettled(local)).toBe(false);
  });

  it("treats whitespace-only drafts as empty", () => {
    expect(contentSignature(outgoingContent(view("  ")))).toBe("");
    expect(localFingerprint(view("  "))).toBeNull();
  });
});

describe("decideSnapshotKey", () => {
  const synced = view("hello", [image()]);
  const syncedFingerprint = localFingerprint(synced)!;

  it("adopts the server's draft when nothing changed here since the last sync", () => {
    expect(
      decideSnapshotKey({
        local: synced,
        syncedFingerprint,
        server: server("hello again", [remoteImage]),
      }),
    ).toBe("apply");
  });

  it("clears a synced draft the server dropped (sent or cleared on the phone)", () => {
    expect(decideSnapshotKey({ local: synced, syncedFingerprint, server: null })).toBe("clear");
  });

  it("pushes a draft edited while offline, even over a newer server draft", () => {
    const edited = view("hello, edited offline", [image()]);
    expect(
      decideSnapshotKey({ local: edited, syncedFingerprint, server: server("phone text") }),
    ).toBe("push");
    expect(decideSnapshotKey({ local: edited, syncedFingerprint, server: null })).toBe("push");
  });

  it("pushes a draft that was never synced (from before sync existed)", () => {
    expect(
      decideSnapshotKey({ local: view("old draft"), syncedFingerprint: undefined, server: null }),
    ).toBe("push");
  });

  it("pushes a local clear made while offline", () => {
    expect(
      decideSnapshotKey({ local: null, syncedFingerprint, server: server("hello", [remoteImage]) }),
    ).toBe("push");
  });

  it("adopts server drafts this device has nothing for", () => {
    expect(
      decideSnapshotKey({
        local: null,
        syncedFingerprint: undefined,
        server: server("from phone"),
      }),
    ).toBe("apply");
  });

  it("does nothing when both sides already agree", () => {
    expect(
      decideSnapshotKey({
        local: synced,
        syncedFingerprint,
        server: server("hello", [remoteImage]),
      }),
    ).toBe("none");
    expect(decideSnapshotKey({ local: null, syncedFingerprint: undefined, server: null })).toBe(
      "none",
    );
  });

  it("re-links a picture whose upload was forgotten after a reload instead of pushing", () => {
    const reloaded = view("hello", [image({ attachmentId: null, pending: true })]);
    expect(isDirty(reloaded, syncedFingerprint)).toBe(false);
    expect(
      decideSnapshotKey({
        local: reloaded,
        syncedFingerprint,
        server: server("hello", [remoteImage]),
      }),
    ).toBe("apply");
  });
});

describe("decideChange", () => {
  it("ignores this window's own writes coming back", () => {
    expect(
      decideChange({
        ownClientId: "me",
        draft: { ...server("x"), clientId: "me" },
        localDirty: false,
      }),
    ).toBe("ignore");
  });

  it("applies another device's write unless local edits are on their way out", () => {
    expect(decideChange({ ownClientId: "me", draft: server("x"), localDirty: false })).toBe(
      "apply",
    );
    expect(decideChange({ ownClientId: "me", draft: server("x"), localDirty: true })).toBe(
      "ignore",
    );
  });
});

describe("reconcileAttachments", () => {
  it("keeps matches, removes what the remote dropped and adds what it gained", () => {
    const kept = image();
    const dropped = image({ localId: "img-2", attachmentId: "att-2" });
    const gained = { ...remoteImage, attachmentId: "att-3", name: "new.png" };
    const result = reconcileAttachments([kept, dropped], [remoteImage, gained]);
    expect(result.remove).toEqual([dropped]);
    expect(result.adopt).toEqual([]);
    expect(result.add).toEqual([gained]);
  });

  it("links an unlinked local picture to the remote one with the same name and size", () => {
    const unlinked = image({ attachmentId: null, pending: true });
    const result = reconcileAttachments([unlinked], [remoteImage]);
    expect(result.adopt).toEqual([{ local: unlinked, attachmentId: "att-1" }]);
    expect(result.add).toEqual([]);
    expect(result.remove).toEqual([]);
  });

  it("clears everything for an empty remote draft", () => {
    const unlinked = image({ localId: "img-2", attachmentId: null });
    expect(reconcileAttachments([image(), unlinked], []).remove).toHaveLength(2);
  });
});

describe("mergeIncomingPrompt", () => {
  it("keeps the local prompt when it already says the same", () => {
    const local = `hello ${chip} `;
    expect(mergeIncomingPrompt(local, "hello")).toBe(local);
  });

  it("takes the remote text and keeps local-only chips", () => {
    expect(mergeIncomingPrompt(`hello ${chip} `, "hello from phone")).toBe(
      `hello from phone ${chip} `,
    );
    expect(mergeIncomingPrompt("old", "new")).toBe("new");
    expect(syncedPromptText(mergeIncomingPrompt(`x ${chip}`, ""))).toBe("");
  });
});
