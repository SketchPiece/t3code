import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import { TailnetPairRequests, tailnetPairRefusal } from "./tailnetPairRoute.ts";

describe("tailnetPairRefusal", () => {
  it("pairs only nodes of this Mac's own Tailscale user, reached over the tailnet", () => {
    assert.strictEqual(tailnetPairRefusal({ address: "127.0.0.1" }), "not a tailnet address");
    assert.strictEqual(tailnetPairRefusal({ address: "192.168.1.20" }), "not a tailnet address");
    assert.strictEqual(tailnetPairRefusal({ address: undefined }), "not a tailnet address");
    assert.isNull(tailnetPairRefusal({ address: "100.80.0.2" }));
    assert.strictEqual(
      tailnetPairRefusal({ address: "100.80.0.2", ownerUserId: 1, callerUserId: 2 }),
      "another tailnet user",
    );
    assert.isNull(tailnetPairRefusal({ address: "100.80.0.2", ownerUserId: 1, callerUserId: 1 }));
  });
});

describe("TailnetPairRequests", () => {
  const phone = { address: "100.80.0.2", label: "iPhone", nodeName: "helm-phone" };
  let next = 0;
  const ask = (requests: TailnetPairRequests) => requests.ask({ ...phone, id: `r${next++}` });

  it("keeps one request per phone until the owner answers, and hands the credential out once", () => {
    const requests = new TailnetPairRequests();
    const first = ask(requests);
    assert.strictEqual(ask(requests).id, first.id);
    assert.deepStrictEqual(requests.check(first.id, phone.address), { status: "pending" });
    assert.deepStrictEqual(
      requests.check(first.id, "100.80.0.9"),
      { status: "expired" },
      "only the asker sees it",
    );
    assert.isTrue(requests.answer(first.id, { approve: true, credential: "one-time" }));
    assert.deepStrictEqual(requests.pending(), []);
    assert.deepStrictEqual(requests.check(first.id, phone.address), {
      status: "approved",
      credential: "one-time",
    });
    assert.deepStrictEqual(requests.check(first.id, phone.address), { status: "expired" });
  });

  it("tells a denied phone once, and forgets requests after five minutes", () => {
    let now = 0;
    const requests = new TailnetPairRequests(() => now);
    const denied = ask(requests);
    assert.isTrue(requests.answer(denied.id, { approve: false }));
    assert.isFalse(requests.answer(denied.id, { approve: true, credential: "late" }));
    assert.deepStrictEqual(requests.check(denied.id, phone.address), { status: "denied" });
    const stale = ask(requests);
    now = 6 * 60_000;
    assert.deepStrictEqual(requests.pending(), []);
    assert.deepStrictEqual(requests.check(stale.id, phone.address), { status: "expired" });
  });

  it.effect("wakes the Mac's long poll when a request arrives", () =>
    Effect.gen(function* () {
      const requests = new TailnetPairRequests();
      const waiting = yield* Effect.forkChild(
        requests.waitForChange(requests.version, Duration.minutes(1)),
      );
      yield* Effect.yieldNow;
      ask(requests);
      yield* Fiber.join(waiting);
      assert.strictEqual(requests.pending().length, 1);
    }),
  );
});
