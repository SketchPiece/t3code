import { AuthAccessWriteScope } from "@t3tools/contracts";
import { isTailscaleIpv4Address } from "@t3tools/tailscale";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { deriveAuthClientMetadata } from "../auth/utils.ts";

// Helm fork: a phone on the owner's tailnet asks to pair, and Helm on the Mac
// asks the owner. The request is only taken straight from a tailnet address
// whose node belongs to this Mac's Tailscale user (`tailscale whois`), and no
// credential leaves the server until someone signed in to Helm with
// access:write answers "Allow". The phone then pairs with that one-time
// credential the usual way. Requests live in memory for five minutes.
export const HELM_TAILNET_PAIR_PATH = "/api/helm/tailnet-pair";
export const HELM_TAILNET_PAIR_REQUESTS_PATH = "/api/helm/tailnet-pair-requests";

// Finder-launched apps miss the shell PATH, so the usual install spots follow.
const TAILSCALE_EXECUTABLES = [
  "tailscale",
  "/usr/local/bin/tailscale",
  "/opt/homebrew/bin/tailscale",
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
];
const TAILSCALE_TIMEOUT = Duration.seconds(3);
const REQUEST_TTL_MS = 5 * 60_000;
const LONG_POLL = Duration.seconds(25);

const Status = Schema.Struct({ Self: Schema.Struct({ UserID: Schema.Number }) });
const Whois = Schema.Struct({
  UserProfile: Schema.Struct({ ID: Schema.Number }),
  Node: Schema.optional(Schema.Struct({ ComputedName: Schema.optional(Schema.String) })),
});
const AskBody = Schema.Struct({ label: Schema.optional(Schema.String) });
const AnswerBody = Schema.Struct({ id: Schema.String, approve: Schema.Boolean });

/** Why a pairing request is refused, or null when its node belongs to this Mac's user. */
export function tailnetPairRefusal(input: {
  readonly address: string | undefined;
  readonly ownerUserId?: number;
  readonly callerUserId?: number;
}): string | null {
  if (!input.address || !isTailscaleIpv4Address(input.address)) return "not a tailnet address";
  if (input.ownerUserId === undefined || input.callerUserId === undefined) return null;
  return input.callerUserId === input.ownerUserId ? null : "another tailnet user";
}

interface PairRequest {
  readonly id: string;
  readonly address: string;
  /** What the phone calls itself, then its tailnet name. */
  readonly label: string;
  readonly nodeName: string;
  readonly createdAt: number;
  status: "pending" | "approved" | "denied";
  credential?: string;
}

/** Pending requests and the change counter the Mac's prompt long-polls on. */
export class TailnetPairRequests {
  readonly #requests = new Map<string, PairRequest>();
  #version = 0;
  #waiters: Array<Deferred.Deferred<void>> = [];
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  get version(): number {
    return this.#version;
  }

  /** One open request per address; asking again keeps the first. */
  ask(input: { id: string; address: string; label: string; nodeName: string }): PairRequest {
    this.#expire();
    for (const request of this.#requests.values()) {
      if (request.address === input.address && request.status === "pending") return request;
    }
    const request: PairRequest = { ...input, createdAt: this.#now(), status: "pending" };
    this.#requests.set(request.id, request);
    this.#changed();
    return request;
  }

  /** The asker's view. A granted credential is handed out once, then forgotten. */
  check(
    id: string,
    address: string,
  ): { status: "pending" | "denied" | "expired" } | { status: "approved"; credential: string } {
    this.#expire();
    const request = this.#requests.get(id);
    if (!request || request.address !== address) return { status: "expired" };
    if (request.status === "approved" && request.credential) {
      this.#requests.delete(id);
      return { status: "approved", credential: request.credential };
    }
    if (request.status === "denied") this.#requests.delete(id);
    return { status: request.status === "denied" ? "denied" : "pending" };
  }

  pending(): ReadonlyArray<{
    id: string;
    label: string;
    nodeName: string;
    address: string;
    createdAt: number;
  }> {
    this.#expire();
    return [...this.#requests.values()]
      .filter((request) => request.status === "pending")
      .map(({ id, label, nodeName, address, createdAt }) => ({
        id,
        label,
        nodeName,
        address,
        createdAt,
      }));
  }

  answer(
    id: string,
    decision: { approve: false } | { approve: true; credential: string },
  ): boolean {
    this.#expire();
    const request = this.#requests.get(id);
    if (!request || request.status !== "pending") return false;
    request.status = decision.approve ? "approved" : "denied";
    if (decision.approve) request.credential = decision.credential;
    this.#changed();
    return true;
  }

  /** Resolves once the pending list changes after `version`, or after `timeoutMs`. */
  waitForChange(version: number, timeout: Duration.Duration): Effect.Effect<void> {
    return Effect.suspend(() => {
      if (this.#version !== version) return Effect.void;
      const waiter = Deferred.makeUnsafe<void>();
      this.#waiters.push(waiter);
      return Deferred.await(waiter).pipe(Effect.timeout(timeout), Effect.ignore);
    });
  }

  #expire(): void {
    let expired = false;
    for (const [id, request] of this.#requests) {
      if (this.#now() - request.createdAt > REQUEST_TTL_MS) {
        this.#requests.delete(id);
        expired = true;
      }
    }
    if (expired) this.#changed();
  }

  #changed(): void {
    this.#version += 1;
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const waiter of waiters) Deferred.doneUnsafe(waiter, Effect.void);
  }
}

const requests = new TailnetPairRequests();

class TailnetPairRefused extends Schema.TaggedError<TailnetPairRefused>()("TailnetPairRefused", {
  reason: Schema.String,
}) {}

const runTailscaleJson = <S extends Schema.Top>(schema: S, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    for (const executable of TAILSCALE_EXECUTABLES) {
      const output = yield* Effect.gen(function* () {
        const child = yield* spawner.spawn(ChildProcess.make(executable, [...args]));
        const [stdout, exitCode] = yield* Effect.all(
          [
            Stream.mkString(Stream.decodeText(child.stdout)),
            child.exitCode.pipe(Effect.map(Number)),
          ],
          { concurrency: "unbounded" },
        );
        return exitCode === 0 ? stdout : null;
      }).pipe(
        Effect.scoped,
        Effect.timeout(TAILSCALE_TIMEOUT),
        Effect.catchCause(() => Effect.succeed(null)),
      );
      if (output !== null) {
        return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(output).pipe(
          Effect.mapError(() => new TailnetPairRefused({ reason: "unreadable tailscale output" })),
        );
      }
    }
    return yield* new TailnetPairRefused({ reason: "tailscale CLI unavailable" });
  });

/** The tailnet caller, checked to be a node of this Mac's own Tailscale user. */
const ownTailnetCaller = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const address = deriveAuthClientMetadata({ request }).ipAddress;
  const notTailnet = tailnetPairRefusal({ address });
  if (notTailnet || !address) return yield* new TailnetPairRefused({ reason: notTailnet ?? "" });
  const [status, whois] = yield* Effect.all(
    [
      runTailscaleJson(Status, ["status", "--json"]),
      runTailscaleJson(Whois, ["whois", "--json", address]),
    ],
    { concurrency: "unbounded" },
  );
  const otherUser = tailnetPairRefusal({
    address,
    ownerUserId: status.Self.UserID,
    callerUserId: whois.UserProfile.ID,
  });
  if (otherUser) return yield* new TailnetPairRefused({ reason: otherUser });
  return { address, nodeName: whois.Node?.ComputedName ?? address };
});

/** The Mac side: someone signed in to Helm who may manage access. */
const requireAccessWrite = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const session = yield* auth
    .authenticateHttpRequest(request)
    .pipe(Effect.mapError(() => new TailnetPairRefused({ reason: "not signed in" })));
  if (!session.scopes.includes(AuthAccessWriteScope)) {
    return yield* new TailnetPairRefused({ reason: "access:write required" });
  }
});

const refuse = <A, E, R>(effect: Effect.Effect<A, E | TailnetPairRefused, R>) =>
  effect.pipe(
    Effect.catchIf(Schema.is(TailnetPairRefused), (refused) =>
      Effect.logInfo("helm tailnet pairing refused", { reason: refused.reason }).pipe(
        Effect.as(HttpServerResponse.text("Forbidden", { status: 403 })),
      ),
    ),
    Effect.catchCause((cause) =>
      Effect.logWarning("helm tailnet pairing failed", { cause }).pipe(
        Effect.as(HttpServerResponse.text("Pairing failed.", { status: 500 })),
      ),
    ),
  );

const searchParam = (url: string, name: string) =>
  new URL(url, "http://helm.invalid").searchParams.get(name);

export const tailnetPairRouteLayer = Layer.mergeAll(
  // Phone: ask to pair.
  HttpRouter.add(
    "POST",
    HELM_TAILNET_PAIR_PATH,
    refuse(
      Effect.gen(function* () {
        const caller = yield* ownTailnetCaller;
        const request = yield* HttpServerRequest.HttpServerRequest;
        const body = yield* request.json.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(AskBody)),
          Effect.orElseSucceed(() => ({ label: undefined })),
        );
        const label = body.label?.trim().slice(0, 80) || caller.nodeName;
        const id = yield* (yield* Crypto.Crypto).randomUUIDv4;
        const asked = requests.ask({ ...caller, id, label });
        yield* Effect.logInfo("helm tailnet pairing requested", { node: caller.nodeName });
        return HttpServerResponse.jsonUnsafe({ requestId: asked.id });
      }),
    ),
  ),
  // Phone: is it answered?
  HttpRouter.add(
    "GET",
    HELM_TAILNET_PAIR_PATH,
    refuse(
      Effect.gen(function* () {
        const caller = yield* ownTailnetCaller;
        const request = yield* HttpServerRequest.HttpServerRequest;
        const id = searchParam(request.url, "id") ?? "";
        return HttpServerResponse.jsonUnsafe(requests.check(id, caller.address));
      }),
    ),
  ),
  // Mac: wait for requests to show (long poll on `after`, the last version seen).
  HttpRouter.add(
    "GET",
    HELM_TAILNET_PAIR_REQUESTS_PATH,
    refuse(
      Effect.gen(function* () {
        yield* requireAccessWrite;
        const request = yield* HttpServerRequest.HttpServerRequest;
        const after = Number(searchParam(request.url, "after") ?? Number.NaN);
        if (Number.isFinite(after)) {
          yield* requests.waitForChange(after, LONG_POLL);
        }
        return HttpServerResponse.jsonUnsafe({
          version: requests.version,
          requests: requests.pending(),
        });
      }),
    ),
  ),
  // Mac: allow or deny.
  HttpRouter.add(
    "POST",
    HELM_TAILNET_PAIR_REQUESTS_PATH,
    refuse(
      Effect.gen(function* () {
        yield* requireAccessWrite;
        const request = yield* HttpServerRequest.HttpServerRequest;
        const body = yield* request.json.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(AnswerBody)),
        );
        if (!body.approve) {
          return HttpServerResponse.jsonUnsafe({
            ok: requests.answer(body.id, { approve: false }),
          });
        }
        const auth = yield* EnvironmentAuth.EnvironmentAuth;
        const issued = yield* auth.issuePairingCredential();
        const ok = requests.answer(body.id, { approve: true, credential: issued.credential });
        yield* Effect.logInfo("helm tailnet pairing answered", { approved: true, ok });
        return HttpServerResponse.jsonUnsafe({ ok });
      }),
    ),
  ),
);
