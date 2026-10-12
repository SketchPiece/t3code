// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { draftAttachmentIds, draftEvents, setDraft } from "./drafts.ts";

const tempStateDir = () => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "helm-drafts-"));

const picture = {
  attachmentId: "pending-1",
  type: "image" as const,
  name: "shot.jpg",
  mimeType: "image/jpeg",
  sizeBytes: 10,
};

describe("helm drafts", () => {
  it.effect("hands a new subscriber what is kept, then the next change", () =>
    Effect.gen(function* () {
      const stateDir = tempStateDir();
      yield* setDraft(stateDir, {
        key: "thread-1",
        text: "hello",
        attachments: [],
        clientId: "mac",
      });
      const [snapshot, change] = yield* draftEvents(stateDir).pipe(
        // Cleared on the phone once the subscriber has what was kept.
        Stream.tap((event) =>
          event.type === "snapshot"
            ? setDraft(stateDir, { key: "thread-1", text: "", attachments: [], clientId: "phone" })
            : Effect.void,
        ),
        Stream.take(2),
        Stream.runCollect,
      );
      assert.deepStrictEqual(
        snapshot?.type === "snapshot" ? snapshot.drafts.map((draft) => draft.text) : null,
        ["hello"],
      );
      assert.deepStrictEqual(
        change?.type === "changed" ? [change.draft.text, change.draft.clientId] : null,
        ["", "phone"],
      );
    }),
  );

  it.effect("drops a cleared draft and orders writes by the server's clock", () =>
    Effect.gen(function* () {
      const stateDir = tempStateDir();
      const first = yield* setDraft(stateDir, {
        key: "project:p",
        text: "",
        attachments: [picture],
        clientId: "phone",
      });
      const second = yield* setDraft(stateDir, {
        key: "project:p",
        text: "words",
        attachments: [picture],
        clientId: "mac",
      });
      assert.isTrue(second.updatedAt > first.updatedAt);
      assert.deepStrictEqual([...draftAttachmentIds(stateDir)], ["pending-1"]);
      yield* setDraft(stateDir, { key: "project:p", text: " ", attachments: [], clientId: "mac" });
      assert.strictEqual(draftAttachmentIds(stateDir).size, 0);
    }),
  );
});
