import { AuthAccessWriteScope } from "@t3tools/contracts";
import { isTailscaleIpv4Address } from "@t3tools/tailscale";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { deriveAuthClientMetadata } from "../auth/utils.ts";

// Helm fork: a phone on the owner's tailnet asks to pair, and Helm on the Mac
// asks the owner. The request is only taken straight from a tailnet address
// whose node belongs to this Mac's Tailscale user (`tailscale whois`), and no
// credential leaves the server until someone signed in to Helm with
// access:write answers "Allow". The phone then pairs with that one-time
// credential the usual way. Requests live in memory for five minutes.
//
// A device on the local network (no Tailscale) may ask too, the way AirPlay
// pairs: after "Allow" the Mac shows a four-digit code, and the credential
// goes only to a request that sends that code back. Whoever reads the code is
// at the Mac, so a stranger on the same Wi-Fi gets nothing from a misplaced
// "Allow"; five wrong codes end the request.
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
const ConfirmBody = Schema.Struct({ id: Schema.String, code: Schema.String });
export const HELM_TAILNET_PAIR_CONFIRM_PATH = "/api/helm/tailnet-pair/confirm";
const CODE_ATTEMPTS = 5;

/** Four random digits for the Mac to show. */
const randomCode = () =>
  String((globalThis.crypto.getRandomValues(new Uint32Array(1))[0] ?? 0) % 10_000).padStart(4, "0");

/** A private address on the local network: 10/8, 172.16/12, 192.168/16, link-local, IPv6 ULA. */
export function isLocalNetworkAddress(address: string | undefined): boolean {
  if (!address) return false;
  const ip = address.toLowerCase().replace(/^::ffff:/, "");
  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    );
  }
  return /^fe[89ab][0-9a-f]:/.test(ip) || /^f[cd][0-9a-f]{2}:/.test(ip);
}

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
  /** Asked from the local network: the credential waits for the code the Mac shows. */
  readonly needsCode: boolean;
  readonly createdAt: number;
  status: "pending" | "approved" | "denied";
  credential?: string | undefined;
  code?: string | undefined;
  attempts: number;
}

type CheckResult =
  | { status: "pending" | "denied" | "expired" | "enterCode" | "wrongCode" }
  | { status: "approved"; credential: string };

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
  ask(input: {
    id: string;
    address: string;
    label: string;
    nodeName: string;
    needsCode?: boolean;
  }): PairRequest {
    this.#expire();
    for (const request of this.#requests.values()) {
      if (request.address === input.address && request.status === "pending") return request;
    }
    const request: PairRequest = {
      ...input,
      needsCode: input.needsCode ?? false,
      createdAt: this.#now(),
      status: "pending",
      attempts: 0,
    };
    this.#requests.set(request.id, request);
    this.#changed();
    return request;
  }

  /** The asker's view. A granted credential is handed out once, then forgotten. */
  check(id: string, address: string): CheckResult {
    this.#expire();
    const request = this.#requests.get(id);
    if (!request || request.address !== address) return { status: "expired" };
    if (request.status === "approved" && request.code) return { status: "enterCode" };
    if (request.status === "approved" && request.credential) {
      this.#requests.delete(id);
      return { status: "approved", credential: request.credential };
    }
    if (request.status === "denied") this.#requests.delete(id);
    return { status: request.status === "denied" ? "denied" : "pending" };
  }

  /** A local-network request sends back the code the Mac shows; the credential follows a match. */
  confirm(id: string, address: string, code: string): CheckResult {
    this.#expire();
    const request = this.#requests.get(id);
    if (!request || request.address !== address) return { status: "expired" };
    if (request.status !== "approved" || !request.code || !request.credential) {
      return this.check(id, address);
    }
    if (code.trim() === request.code) {
      this.#requests.delete(id);
      this.#changed();
      return { status: "approved", credential: request.credential };
    }
    request.attempts += 1;
    if (request.attempts >= CODE_ATTEMPTS) {
      this.#requests.delete(id);
      this.#changed();
      return { status: "expired" };
    }
    return { status: "wrongCode" };
  }

  pending(): ReadonlyArray<{
    id: string;
    label: string;
    nodeName: string;
    address: string;
    needsCode: boolean;
    createdAt: number;
  }> {
    this.#expire();
    return [...this.#requests.values()]
      .filter((request) => request.status === "pending")
      .map(({ id, label, nodeName, address, needsCode, createdAt }) => ({
        id,
        label,
        nodeName,
        address,
        needsCode,
        createdAt,
      }));
  }

  /** Allowed local-network requests whose code the Mac shows until the device sends it back. */
  awaitingCode(): ReadonlyArray<{ id: string; label: string; address: string; code: string }> {
    this.#expire();
    return [...this.#requests.values()].flatMap((request) =>
      request.status === "approved" && request.code
        ? [{ id: request.id, label: request.label, address: request.address, code: request.code }]
        : [],
    );
  }

  /**
   * The owner's answer. Allowing a local-network request returns the code to show; denying
   * also takes back a code still on screen.
   */
  answer(
    id: string,
    decision: { approve: false } | { approve: true; credential: string },
    newCode: () => string = randomCode,
  ): { ok: boolean; code?: string } {
    this.#expire();
    const request = this.#requests.get(id);
    const awaiting = request?.status === "approved" && request.code !== undefined;
    if (!request || (request.status !== "pending" && !(awaiting && !decision.approve))) {
      return { ok: false };
    }
    if (!decision.approve) {
      request.status = "denied";
      request.code = undefined;
      request.credential = undefined;
      this.#changed();
      return { ok: true };
    }
    request.status = "approved";
    request.credential = decision.credential;
    if (request.needsCode) request.code = newCode();
    this.#changed();
    return request.code ? { ok: true, code: request.code } : { ok: true };
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

/** Who may ask: a node of the owner's tailnet, or (with a code to come) a device on the local network. */
const pairCaller = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const address = deriveAuthClientMetadata({ request }).ipAddress;
  if (address && isLocalNetworkAddress(address)) {
    return { address, nodeName: address, needsCode: true };
  }
  return { ...(yield* ownTailnetCaller), needsCode: false };
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
        const caller = yield* pairCaller;
        const request = yield* HttpServerRequest.HttpServerRequest;
        const body = yield* request.json.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(AskBody)),
          Effect.orElseSucceed(() => ({ label: undefined })),
        );
        const label = body.label?.trim().slice(0, 80) || caller.nodeName;
        const id = yield* (yield* Crypto.Crypto).randomUUIDv4().pipe(Effect.orDie);
        const asked = requests.ask({ ...caller, id, label });
        yield* Effect.logInfo("helm tailnet pairing requested", {
          node: caller.nodeName,
          localNetwork: caller.needsCode,
        });
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
        const caller = yield* pairCaller;
        const request = yield* HttpServerRequest.HttpServerRequest;
        const id = searchParam(request.url, "id") ?? "";
        return HttpServerResponse.jsonUnsafe(requests.check(id, caller.address));
      }),
    ),
  ),
  // Device on the local network: the code the Mac shows.
  HttpRouter.add(
    "POST",
    HELM_TAILNET_PAIR_CONFIRM_PATH,
    refuse(
      Effect.gen(function* () {
        const caller = yield* pairCaller;
        const request = yield* HttpServerRequest.HttpServerRequest;
        const body = yield* request.json.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(ConfirmBody)),
        );
        const result = requests.confirm(body.id, caller.address, body.code);
        yield* Effect.logInfo("helm local pairing code", { status: result.status });
        return HttpServerResponse.jsonUnsafe(result);
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
          codes: requests.awaitingCode(),
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
          return HttpServerResponse.jsonUnsafe(requests.answer(body.id, { approve: false }));
        }
        const auth = yield* EnvironmentAuth.EnvironmentAuth;
        const issued = yield* auth.issuePairingCredential();
        const answered = requests.answer(body.id, { approve: true, credential: issued.credential });
        yield* Effect.logInfo("helm tailnet pairing answered", {
          approved: true,
          ok: answered.ok,
          code: answered.code !== undefined,
        });
        return HttpServerResponse.jsonUnsafe(answered);
      }),
    ),
  ),
);
