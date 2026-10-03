import { AsyncResult } from "effect/unstable/reactivity";
import * as Device from "expo-device";

import { environmentCatalog } from "../../src/connection/catalog";
import { connectPairingUrl } from "../../src/connection/onboarding";
import { appAtomRegistry } from "../../src/state/atom-registry";
import type { TailnetPeer } from "./status";

// Helm fork: adds the owner's Helm computers on the tailnet as environments.
// For each online computer it looks for a Helm server on the desktop port,
// asks it to pair (apps/server/src/helm/tailnetPairRoute.ts), waits until the
// owner allows it in Helm on that Mac, then pairs with the one-time
// credential like a scanned QR code. Requests go through the in-app node.

/**
 * Where Helm desktop's backend may listen: it starts at 3773 and moves up when
 * the port is taken, which T3 Code running beside it does (apps/desktop/src/app/DesktopApp.ts).
 */
const HELM_PORTS = [3773, 3774, 3775, 3776, 3777];
const PROBE_TIMEOUT_MS = 4_000;
const ANSWER_POLL_MS = 2_000;
const ANSWER_WAIT_MS = 5 * 60_000;

export type AutoPairState =
  | "checking"
  | "not-helm"
  | "waiting"
  | "added"
  | "already-added"
  | "denied"
  | "failed";

const states = new Map<string, AutoPairState>();
const listeners = new Set<() => void>();
let snapshot: ReadonlyMap<string, AutoPairState> = new Map();

function setState(address: string, state: AutoPairState) {
  states.set(address, state);
  snapshot = new Map(states);
  for (const listener of listeners) listener();
}

export function subscribeAutoPair(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function readAutoPair(): ReadonlyMap<string, AutoPairState> {
  return snapshot;
}

async function request(url: string, init: RequestInit = {}, timeoutMs = PROBE_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Saved environments, once the catalog has loaded from secure storage. */
async function savedEnvironmentIds(): Promise<ReadonlySet<string>> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const catalog = appAtomRegistry.get(environmentCatalog.catalogValueAtom);
    if (catalog.isReady) return new Set(catalog.entries.keys());
    await sleep(250);
  }
  return new Set();
}

/**
 * The base URL of Helm on this computer. Only Helm answers the pairing route
 * with JSON (T3 Code serves its web app there), so asking about a request id
 * that does not exist finds it without leaving a request behind.
 */
async function findHelm(address: string): Promise<string | null> {
  for (const port of HELM_PORTS) {
    const base = `http://${address}:${port}`;
    const probe = await request(`${base}/api/helm/tailnet-pair?id=probe`).catch(() => null);
    if (!probe?.ok || !probe.headers.get("content-type")?.includes("json")) continue;
    return base;
  }
  return null;
}

async function pairPeer(address: string): Promise<AutoPairState> {
  const base = await findHelm(address);
  if (!base) return "not-helm";
  let environmentId: string;
  try {
    const descriptor = await request(`${base}/.well-known/t3/environment`);
    if (!descriptor.ok) return "not-helm";
    environmentId = ((await descriptor.json()) as { environmentId: string }).environmentId;
  } catch {
    return "not-helm";
  }
  if ((await savedEnvironmentIds()).has(environmentId)) return "already-added";

  const asked = await request(`${base}/api/helm/tailnet-pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label: Device.deviceName ?? "iPhone" }),
  });
  if (!asked.ok) return asked.status === 403 || asked.status === 404 ? "not-helm" : "failed";
  const { requestId } = (await asked.json()) as { requestId: string };

  setState(address, "waiting");
  const deadline = Date.now() + ANSWER_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(ANSWER_POLL_MS);
    const answer = await request(
      `${base}/api/helm/tailnet-pair?id=${encodeURIComponent(requestId)}`,
    ).catch(() => null);
    if (!answer?.ok) continue;
    const body = (await answer.json()) as { status: string; credential?: string };
    if (body.status === "denied" || body.status === "expired") return "denied";
    if (body.status === "approved" && body.credential) {
      const result = await connectPairingUrl.run(
        appAtomRegistry,
        `${base}/#token=${encodeURIComponent(body.credential)}`,
      );
      return AsyncResult.isSuccess(result) ? "added" : "failed";
    }
  }
  return "denied";
}

/** Starts pairing every online computer not already tried in this session. */
export function pairTailnetComputers(peers: ReadonlyArray<TailnetPeer>) {
  for (const peer of peers) {
    if (!peer.isComputer || !peer.online || !peer.ip || states.has(peer.ip)) continue;
    const address = peer.ip;
    setState(address, "checking");
    void pairPeer(address)
      .catch(() => "failed" as const)
      .then((state) => setState(address, state));
  }
}

/** Lets a computer be tried again (after a denial or failure). */
export function retryTailnetComputer(peer: TailnetPeer) {
  if (!peer.ip) return;
  states.delete(peer.ip);
  pairTailnetComputers([peer]);
}
