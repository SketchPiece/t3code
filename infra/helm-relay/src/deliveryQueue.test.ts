import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import { makeDeliveryQueue } from "./deliveryQueue.ts";

describe("makeDeliveryQueue", () => {
  it.effect("retries a failing job until it succeeds", () =>
    Effect.gen(function* () {
      const queue = yield* makeDeliveryQueue<string>({ name: "test", retryDelay: "30 seconds" });
      const attempts = yield* Ref.make(0);
      const delivered = yield* Deferred.make<string>();
      const consumer = yield* queue
        .consume((job) =>
          Ref.updateAndGet(attempts, (count) => count + 1).pipe(
            Effect.flatMap((count) =>
              count < 3 ? Effect.fail("apns unavailable") : Deferred.succeed(delivered, job),
            ),
          ),
        )
        .pipe(Effect.forkChild);

      yield* queue.send("job-1");
      yield* TestClock.adjust("30 seconds");
      yield* TestClock.adjust("30 seconds");

      expect(yield* Deferred.await(delivered)).toBe("job-1");
      expect(yield* Ref.get(attempts)).toBe(3);
      yield* Fiber.interrupt(consumer);
    }),
  );

  it.effect("drops a job after its retries and keeps consuming", () =>
    Effect.gen(function* () {
      const queue = yield* makeDeliveryQueue<string>({ name: "test", maxRetries: 2 });
      const attempts = yield* Ref.make<ReadonlyArray<string>>([]);
      const delivered = yield* Deferred.make<string>();
      const consumer = yield* queue
        .consume((job) =>
          Ref.update(attempts, (all) => [...all, job]).pipe(
            Effect.andThen(
              job === "poison" ? Effect.fail("rejected") : Deferred.succeed(delivered, job),
            ),
          ),
        )
        .pipe(Effect.forkChild);

      yield* queue.send("poison");
      yield* TestClock.adjust("30 seconds");
      yield* TestClock.adjust("30 seconds");
      yield* queue.send("next");

      expect(yield* Deferred.await(delivered)).toBe("next");
      expect(yield* Ref.get(attempts)).toEqual(["poison", "poison", "poison", "next"]);
      yield* Fiber.interrupt(consumer);
    }),
  );
});
