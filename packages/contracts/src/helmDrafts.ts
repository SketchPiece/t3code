import * as Schema from "effect/Schema";

// Helm fork: unsent composer drafts shared by Helm on the Mac and Helm Mobile. The server keeps
// the last draft written for each thread (and for each project's new thread) and tells every
// subscribed client when one changes; the last write wins.

/** An upload on this server (`attachments.createUploadUrl`) the draft carries. */
export const HelmDraftAttachment = Schema.Struct({
  attachmentId: Schema.String.check(Schema.isMaxLength(256)),
  type: Schema.Literals(["image", "file"]),
  name: Schema.String.check(Schema.isMaxLength(256)),
  mimeType: Schema.String.check(Schema.isMaxLength(256)),
  sizeBytes: Schema.Number,
});
export type HelmDraftAttachment = typeof HelmDraftAttachment.Type;

/** The draft of a thread: its id. The draft of a new thread not sent yet: "project:<projectId>". */
export const HelmDraftKey = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512));

export const HELM_PROJECT_DRAFT_KEY_PREFIX = "project:";
export const helmProjectDraftKey = (projectId: string): string =>
  `${HELM_PROJECT_DRAFT_KEY_PREFIX}${projectId}`;

export const HelmDraftSetInput = Schema.Struct({
  key: HelmDraftKey,
  /** Empty text and no attachments clear the draft. */
  text: Schema.String.check(Schema.isMaxLength(200_000)),
  attachments: Schema.Array(HelmDraftAttachment).check(Schema.isMaxLength(64)),
  /** The writing client, so it can tell its own writes from others' when they come back. */
  clientId: Schema.String.check(Schema.isMaxLength(128)),
});
export type HelmDraftSetInput = typeof HelmDraftSetInput.Type;

export const HelmDraft = Schema.Struct({
  ...HelmDraftSetInput.fields,
  /** When the server took this write (ms since epoch); the server's clock orders writes. */
  updatedAt: Schema.Number,
});
export type HelmDraft = typeof HelmDraft.Type;

export const helmDraftIsEmpty = (draft: {
  readonly text: string;
  readonly attachments: ReadonlyArray<unknown>;
}): boolean => draft.text.trim().length === 0 && draft.attachments.length === 0;

/** What `helm.drafts.subscribe` streams: every draft kept now, then each change as it lands. */
export const HelmDraftEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("snapshot"), drafts: Schema.Array(HelmDraft) }),
  /** A cleared draft comes as an empty one. */
  Schema.Struct({ type: Schema.Literal("changed"), draft: HelmDraft }),
]);
export type HelmDraftEvent = typeof HelmDraftEvent.Type;
