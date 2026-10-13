import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import {
  TailnetPairRequests,
  isLocalNetworkAddress,
  tailnetPairRefusal,
} from "./tailnetPairRoute.ts";

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

describe("isLocalNetworkAddress", () => {
  it("takes private and link-local addresses, not the internet, loopback or the tailnet", () => {
    for (const address of [
      "192.168.1.4",
      "10.0.0.7",
      "172.20.1.1",
      "169.254.3.3",
      "::ffff:192.168.1.4",
      "fe80::1",
      "fd12::3",
    ]) {
      assert.isTrue(isLocalNetworkAddress(address), address);
    }
    for (const address of [
      "8.8.8.8",
      "127.0.0.1",
      "::1",
      "100.80.0.2",
      "172.32.0.1",
      "2001:db8::1",
      undefined,
    ]) {
      assert.isFalse(isLocalNetworkAddress(address), String(address));
    }
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
    assert.deepStrictEqual(requests.answer(first.id, { approve: true, credential: "one-time" }), {
      ok: true,
    });
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
    assert.isTrue(requests.answer(denied.id, { approve: false }).ok);
    assert.isFalse(requests.answer(denied.id, { approve: true, credential: "late" }).ok);
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

  it("gives a local-network device the credential only for the code the Mac shows", () => {
    const requests = new TailnetPairRequests();
    const ipad = {
      address: "192.168.1.9",
      label: "iPad",
      nodeName: "192.168.1.9",
      needsCode: true,
    };
    const asked = requests.ask({ ...ipad, id: "local" });
    assert.isTrue(requests.pending()[0]?.needsCode);
    assert.deepStrictEqual(
      requests.answer(asked.id, { approve: true, credential: "secret" }, () => "0427"),
      { ok: true, code: "0427" },
    );
    assert.deepStrictEqual(requests.awaitingCode(), [
      { id: "local", label: "iPad", address: ipad.address, code: "0427" },
    ]);
    assert.deepStrictEqual(requests.check(asked.id, ipad.address), { status: "enterCode" });
    assert.deepStrictEqual(requests.confirm(asked.id, "192.168.1.66", "0427"), {
      status: "expired",
    });
    assert.deepStrictEqual(requests.confirm(asked.id, ipad.address, "1111"), {
      status: "wrongCode",
    });
    assert.deepStrictEqual(requests.confirm(asked.id, ipad.address, "0427"), {
      status: "approved",
      credential: "secret",
    });
    assert.deepStrictEqual(requests.awaitingCode(), []);
    assert.deepStrictEqual(requests.check(asked.id, ipad.address), { status: "expired" });
  });

  it("ends a local request after five wrong codes, or when the Mac takes the code back", () => {
    const requests = new TailnetPairRequests();
    const ipad = {
      address: "192.168.1.9",
      label: "iPad",
      nodeName: "192.168.1.9",
      needsCode: true,
    };
    const guessed = requests.ask({ ...ipad, id: "guessed" });
    requests.answer(guessed.id, { approve: true, credential: "secret" }, () => "0427");
    for (let i = 0; i < 4; i++) {
      assert.deepStrictEqual(requests.confirm(guessed.id, ipad.address, "9999"), {
        status: "wrongCode",
      });
    }
    assert.deepStrictEqual(requests.confirm(guessed.id, ipad.address, "9999"), {
      status: "expired",
    });
    assert.deepStrictEqual(requests.confirm(guessed.id, ipad.address, "0427"), {
      status: "expired",
    });

    const cancelled = requests.ask({ ...ipad, id: "cancelled" });
    requests.answer(cancelled.id, { approve: true, credential: "secret" }, () => "0427");
    assert.isTrue(requests.answer(cancelled.id, { approve: false }).ok);
    assert.deepStrictEqual(requests.awaitingCode(), []);
    assert.deepStrictEqual(requests.confirm(cancelled.id, ipad.address, "0427"), {
      status: "denied",
    });
  });
});
