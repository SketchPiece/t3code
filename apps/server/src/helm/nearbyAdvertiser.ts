import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as OS from "node:os";

import { ServerConfig } from "../config.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";

// Helm fork: the server announces itself on the local network over Bonjour, so
// Helm Mobile can tell when it sits on the same Wi-Fi as this Mac and offer its
// remote only then. Only presence is announced (the environment id in the TXT
// record); the phone keeps talking to the server over its usual connection.
export const HELM_NEARBY_SERVICE_TYPE = "_helm._tcp";

const DNS_SD = "/usr/bin/dns-sd";

export function nearbyRegistrationArgs(input: {
  readonly name: string;
  readonly port: number;
  readonly environmentId: string;
}): ReadonlyArray<string> {
  return [
    "-R",
    input.name,
    HELM_NEARBY_SERVICE_TYPE,
    "local",
    String(input.port),
    `environmentId=${input.environmentId}`,
  ];
}

export const nearbyAdvertiserLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    if (process.platform !== "darwin") return;
    const config = yield* ServerConfig;
    const environment = yield* ServerEnvironment;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const environmentId = yield* environment.getEnvironmentId;
    const args = nearbyRegistrationArgs({
      name: `Helm on ${OS.hostname().replace(/\.local$/, "")}`,
      port: config.port,
      environmentId,
    });
    // dns-sd keeps the registration while it runs; the scope kills it on shutdown.
    yield* Effect.gen(function* () {
      const child = yield* spawner.spawn(ChildProcess.make(DNS_SD, [...args]));
      yield* child.exitCode;
      return yield* Effect.fail("dns-sd exited");
    }).pipe(
      Effect.scoped,
      Effect.retry(Schedule.spaced(Duration.seconds(30))),
      Effect.catchCause((cause) => Effect.logWarning("helm nearby advertising stopped", cause)),
      Effect.forkScoped,
    );
  }),
);
