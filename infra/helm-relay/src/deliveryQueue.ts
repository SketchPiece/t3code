import * as Cause from "effect/Cause";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

export interface DeliveryQueue<A> {
  readonly send: (job: A) => Effect.Effect<void>;
  /** Processes jobs until interrupted. */
  readonly consume: <E, R>(
    process: (job: A) => Effect.Effect<void, E, R>,
  ) => Effect.Effect<void, never, R>;
}

/**
 * Stands in for a Cloudflare Queue. A failed job is retried like the Worker's
 * consumer does it (5 retries, 30 seconds apart) and then dropped with a log
 * line where Cloudflare would dead-letter it. Jobs live in memory, so the ones
 * still queued are lost on restart; APNs jobs expire within minutes anyway.
 *
 * `send` exists before `consume` so the services that enqueue jobs can be
 * built first and then handed to the consumer.
 */
export const makeDeliveryQueue = <A>(options: {
  readonly name: string;
  readonly concurrency?: number;
  readonly maxRetries?: number;
  readonly retryDelay?: Duration.Input;
}): Effect.Effect<DeliveryQueue<A>> =>
  Effect.map(Queue.unbounded<A>(), (queue) => ({
    send: (job) => Queue.offer(queue, job).pipe(Effect.asVoid),
    consume: (process) =>
      Stream.fromQueue(queue).pipe(
        Stream.mapEffect(
          (job) =>
            process(job).pipe(
              Effect.retry({
                schedule: Schedule.spaced(options.retryDelay ?? "30 seconds"),
                times: options.maxRetries ?? 5,
              }),
              Effect.catchCause((cause) =>
                Cause.hasInterrupts(cause)
                  ? Effect.interrupt
                  : Effect.logError(`Dropping ${options.name} job after retries`, { cause }),
              ),
              Effect.withSpan(`helm_relay.${options.name}.process_message`),
            ),
          { concurrency: options.concurrency ?? 10, unordered: true },
        ),
        Stream.runDrain,
      ),
  }));
