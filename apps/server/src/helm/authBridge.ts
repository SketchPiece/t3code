// @effect-diagnostics nodeBuiltinImport:off globalTimers:off preferSchemaOverJson:off globalDate:off globalRandom:off globalFetch:off -- a Unix
// socket for the PAM module and a long-lived helper on stdin/stdout, both line-delimited JSON.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as OS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

import type {
  HelmAuthEvent,
  HelmAuthOutcome,
  HelmAuthRegisterApproverInput,
  HelmAuthRequest,
  HelmAuthRespondInput,
  HelmAuthRespondResult,
  HelmAuthSecretKind,
  HelmAuthSudoSetup,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { ServerConfig } from "../config.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { readHelmPushConfig } from "./pushConfig.ts";

// Helm fork: Face ID on the phone for the Mac (contracts/helmAuth.ts).
//
// - sudo: pam_helm connects to `~/.helm/sudo.sock`, sends one JSON line and waits for one back.
//   The server only passes the phone's signature through; pam_helm checks it.
// - prompts: `helm-auth` (native/helm-auth) watches the screen for Touch ID / password sheets
//   and types a password the phone sealed to it.
//
// Only the server on the real `~/.helm` takes part: dev servers on other base dirs would
// otherwise fight over the socket.

const PAM_MODULE_PATH = "/usr/local/lib/pam/pam_helm.so.2";
const SUDO_LOCAL_PATH = "/etc/pam.d/sudo_local";
const APPROVERS_PATH = "/etc/helm/sudo-approvers";
const SUDO_TIMEOUT_CAP_S = 120;
const FILL_TIMEOUT_MS = 25_000;

type Listener = (event: HelmAuthEvent) => void;

interface SudoEntry {
  readonly request: HelmAuthRequest;
  readonly reply: (line: object) => void;
}

const state = {
  enabled: false,
  requests: new Map<string, HelmAuthRequest>(),
  sudoReplies: new Map<string, SudoEntry["reply"]>(),
  fills: new Map<string, (result: HelmAuthRespondResult) => void>(),
  listeners: new Set<Listener>(),
  helper: null as NodeChildProcess.ChildProcess | null,
  promptsAvailable: false,
  pendingApproversPath: "",
  setupCommand: "",
  notify: null as ((request: HelmAuthRequest) => void) | null,
};

function broadcast(event: HelmAuthEvent): void {
  for (const listener of state.listeners) listener(event);
}

function add(request: HelmAuthRequest): void {
  state.requests.set(request.id, request);
  broadcast({ type: "added", request });
  state.notify?.(request);
}

function remove(id: string, outcome: HelmAuthOutcome, message?: string): void {
  if (!state.requests.delete(id)) return;
  broadcast({ type: "removed", id, outcome, ...(message ? { message } : {}) });
}

// MARK: sudo setup

function readApprovers(path: string): string[] {
  try {
    return NodeFS.readFileSync(path, "utf8")
      .split("\n")
      .map((line) => line.trim().split(/\s+/)[0] ?? "")
      .filter((key) => key.length > 0 && !key.startsWith("#"));
  } catch {
    return [];
  }
}

export function sudoSetup(): HelmAuthSudoSetup {
  let installed = false;
  try {
    installed =
      NodeFS.existsSync(PAM_MODULE_PATH) &&
      NodeFS.readFileSync(SUDO_LOCAL_PATH, "utf8")
        .split("\n")
        .some((line) => !line.trimStart().startsWith("#") && line.includes("pam_helm.so"));
  } catch {
    installed = false;
  }
  return { installed, approvers: readApprovers(APPROVERS_PATH), setupCommand: state.setupCommand };
}

export const registerApprover = (
  input: HelmAuthRegisterApproverInput,
): Effect.Effect<HelmAuthSudoSetup> =>
  Effect.sync(() => {
    if (state.pendingApproversPath) {
      const keys = readApprovers(state.pendingApproversPath);
      if (!keys.includes(input.publicKey)) {
        const name = input.deviceName.replace(/[\r\n]/g, " ");
        NodeFS.appendFileSync(state.pendingApproversPath, `${input.publicKey} ${name}\n`, {
          mode: 0o600,
        });
      }
    }
    const setup = sudoSetup();
    broadcast({ type: "sudo", sudo: setup });
    return setup;
  });

/** Runs as root (`sudo ~/.helm/bin/helm-sudo-setup`): installs pam_helm and the approved keys. */
function setupScript(modulePath: string, pendingApproversPath: string): string {
  return `#!/bin/bash
# Helm: approve sudo with Face ID on your phone. Written by Helm; run it again after adding a phone.
# Undo: sudo ${"$0"} --uninstall
set -euo pipefail
if [ "$(id -u)" != 0 ]; then exec sudo "$0" "$@"; fi
LINE="auth       sufficient     ${PAM_MODULE_PATH}"
if [ "\${1:-}" = "--uninstall" ]; then
  [ -f ${SUDO_LOCAL_PATH} ] && sed -i '' '/pam_helm\\.so/d' ${SUDO_LOCAL_PATH}
  rm -f ${PAM_MODULE_PATH} ${APPROVERS_PATH}
  echo "Helm: sudo approval removed."
  exit 0
fi
MODULE=${JSON.stringify(modulePath)}
PENDING=${JSON.stringify(pendingApproversPath)}
[ -f "$MODULE" ] || { echo "Helm: $MODULE is missing." >&2; exit 1; }
[ -s "$PENDING" ] || { echo "Helm: no phone has asked to approve sudo yet. Open Helm on the phone first." >&2; exit 1; }
install -d -m 755 -o root -g wheel /usr/local/lib/pam /etc/helm
install -m 444 -o root -g wheel "$MODULE" ${PAM_MODULE_PATH}
install -m 644 -o root -g wheel "$PENDING" ${APPROVERS_PATH}
if [ ! -f ${SUDO_LOCAL_PATH} ]; then
  printf '# sudo_local: local config file which survives system update and is included for sudo\\n' > ${SUDO_LOCAL_PATH}
fi
grep -q 'pam_helm\\.so' ${SUDO_LOCAL_PATH} || echo "$LINE" >> ${SUDO_LOCAL_PATH}
echo "Helm: sudo now asks your phone first. Approved phones:"
cut -d' ' -f2- ${APPROVERS_PATH} | sed 's/^/  /'
`;
}

// MARK: sudo socket

function handleSudoConnection(socket: NodeNet.Socket): void {
  socket.setEncoding("utf8");
  let buffer = "";
  let id: string | null = null;
  const reply = (line: object) => {
    if (!socket.destroyed) socket.end(`${JSON.stringify(line)}\n`);
  };
  socket.on("data", (chunk: string) => {
    if (id) return;
    buffer += chunk;
    if (buffer.length > 16_384) return socket.destroy();
    const newline = buffer.indexOf("\n");
    if (newline < 0) return;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(buffer.slice(0, newline));
    } catch {
      return socket.destroy();
    }
    const text = (key: string) =>
      typeof message[key] === "string" ? (message[key] as string) : "";
    // Without a phone listening or a push to wake one, don't keep sudo waiting.
    if (state.listeners.size === 0 && !state.notify) return reply({ status: "unavailable" });
    const timeout = Math.min(Number(message.timeout) || 45, SUDO_TIMEOUT_CAP_S);
    const now = Date.now();
    id = `sudo-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const requestId = id;
    const command = text("command");
    const request: HelmAuthRequest = {
      id: requestId,
      kind: "sudo",
      app: "sudo",
      title: command.replace(/^sudo\s+/, "") || "sudo",
      detail: `${text("user")}@${text("host")}`,
      createdAt: now,
      expiresAt: now + timeout * 1000,
      sudo: { nonce: text("nonce"), user: text("user"), host: text("host"), command },
      secretKinds: [],
    };
    state.sudoReplies.set(requestId, reply);
    add(request);
    // pam_helm tells the terminal to look at the phone only now.
    socket.write(`${JSON.stringify({ status: "pending" })}\n`);
    const timer = setTimeout(() => {
      state.sudoReplies.delete(requestId);
      remove(requestId, "expired");
      socket.destroy();
    }, timeout * 1000);
    socket.on("close", () => {
      clearTimeout(timer);
      // Ctrl-C in the terminal, or sudo gave up: the phone stops asking.
      if (state.sudoReplies.delete(requestId)) remove(requestId, "gone");
    });
  });
  socket.on("error", () => undefined);
}

export function listenForSudo(socketPath: string): NodeNet.Server {
  try {
    NodeFS.unlinkSync(socketPath);
  } catch {
    // Not there: fine.
  }
  const server = NodeNet.createServer(handleSudoConnection);
  server.on("error", () => undefined);
  server.listen(socketPath, () => {
    try {
      NodeFS.chmodSync(socketPath, 0o600);
    } catch {
      // The PAM module also checks the owner.
    }
  });
  return server;
}

// MARK: prompts helper

function startHelper(helperPath: string): void {
  const child = NodeChildProcess.spawn(helperPath, [], { stdio: ["pipe", "pipe", "ignore"] });
  state.helper = child;
  const lines = NodeReadline.createInterface({ input: child.stdout! });
  lines.on("line", (line) => {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    const id = typeof event.id === "string" ? event.id : "";
    switch (event.event) {
      case "ready":
        state.promptsAvailable = event.trusted === true;
        break;
      case "prompt": {
        const kinds = (Array.isArray(event.kinds) ? event.kinds : []).filter(
          (kind): kind is HelmAuthSecretKind => kind === "mac" || kind === "onepassword",
        );
        add({
          id,
          kind: "prompt",
          app: String(event.app ?? ""),
          title: String(event.title ?? ""),
          detail: String(event.detail ?? ""),
          createdAt: Date.now(),
          secretKinds: kinds,
          ...(typeof event.sealingKey === "string" ? { sealingKey: event.sealingKey } : {}),
        });
        break;
      }
      case "gone":
        remove(id, "gone");
        break;
      case "result": {
        const result = { ok: event.ok === true, message: String(event.message ?? "") };
        const waiter = state.fills.get(id);
        state.fills.delete(id);
        waiter?.(result);
        if (result.ok) remove(id, "approved", result.message);
        break;
      }
    }
  });
  child.on("exit", () => {
    if (state.helper !== child) return;
    state.helper = null;
    state.promptsAvailable = false;
    for (const [id, request] of state.requests) if (request.kind === "prompt") remove(id, "gone");
    // It crashed or was killed: try again in a while.
    setTimeout(() => startHelper(helperPath), 10_000).unref();
  });
}

function tellHelper(command: object): boolean {
  const stdin = state.helper?.stdin;
  if (!stdin || stdin.destroyed) return false;
  stdin.write(`${JSON.stringify(command)}\n`);
  return true;
}

// MARK: RPC

export const respond = (input: HelmAuthRespondInput): Effect.Effect<HelmAuthRespondResult> =>
  Effect.promise(async () => {
    const request = state.requests.get(input.id);
    if (!request) return { ok: false, message: "The Mac isn't waiting for this anymore." };
    if (request.kind === "sudo") {
      const reply = state.sudoReplies.get(input.id);
      state.sudoReplies.delete(input.id);
      if (!reply) return { ok: false, message: "sudo stopped waiting." };
      if (input.action === "deny") {
        reply({ status: "denied" });
        remove(input.id, "denied");
        return { ok: true, message: "Declined." };
      }
      if (!input.signature) return { ok: false, message: "No signature." };
      reply({ status: "approved", signature: input.signature });
      remove(input.id, "approved");
      return { ok: true, message: "Approved." };
    }
    if (input.action === "deny") {
      tellHelper({ command: "cancel", id: input.id });
      remove(input.id, "denied");
      return { ok: true, message: "Cancelled on the Mac." };
    }
    if (!input.secret) return { ok: false, message: "No password." };
    const result = new Promise<HelmAuthRespondResult>((resolve) => {
      state.fills.set(input.id, resolve);
      setTimeout(() => {
        if (state.fills.delete(input.id)) resolve({ ok: false, message: "The Mac didn't answer." });
      }, FILL_TIMEOUT_MS).unref();
    });
    if (
      !tellHelper({
        command: "fill",
        id: input.id,
        kind: input.secret.kind,
        ephemeralKey: input.secret.ephemeralKey,
        box: input.secret.box,
      })
    ) {
      state.fills.delete(input.id);
      return { ok: false, message: "The prompt watcher isn't running." };
    }
    return result;
  });

export const authEvents: Stream.Stream<HelmAuthEvent> = Stream.callback<HelmAuthEvent>((queue) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      Queue.offerUnsafe(queue, {
        type: "snapshot",
        requests: [...state.requests.values()],
        sudo: sudoSetup(),
        promptsAvailable: state.promptsAvailable,
      });
      const listener: Listener = (event) => Queue.offerUnsafe(queue, event);
      state.listeners.add(listener);
      return listener;
    }),
    (listener) => Effect.sync(() => state.listeners.delete(listener)),
  ),
);

// MARK: Layer

function helperDirectory(resourceMonitorPath: string | undefined): string | undefined {
  const candidates = [
    process.env.HELM_AUTH_DIR,
    resourceMonitorPath && NodePath.dirname(resourceMonitorPath),
    NodePath.resolve(import.meta.dirname, "../../../../native/helm-auth/build"),
    NodePath.resolve(import.meta.dirname, "../../../native/helm-auth/build"),
  ];
  return candidates.find(
    (dir): dir is string => !!dir && NodeFS.existsSync(NodePath.join(dir, "helm-auth")),
  );
}

export const authBridgeLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    if (process.platform !== "darwin") return;
    const config = yield* ServerConfig;
    const home = OS.homedir();
    const isMainInstance =
      config.baseDir === NodePath.join(home, ".helm") &&
      NodePath.basename(config.stateDir) === "userdata";
    if (!isMainInstance && !process.env.HELM_AUTH_FORCE) return;

    const directory = helperDirectory(config.resourceMonitorPath);
    state.enabled = true;
    state.pendingApproversPath = NodePath.join(config.stateDir, "sudo-approvers.pending");
    const scriptPath = NodePath.join(config.baseDir, "bin", "helm-sudo-setup");
    state.setupCommand = scriptPath.replace(home, "~");
    if (directory) {
      NodeFS.mkdirSync(NodePath.dirname(scriptPath), { recursive: true });
      NodeFS.writeFileSync(
        scriptPath,
        setupScript(NodePath.join(directory, "pam_helm.so.2"), state.pendingApproversPath),
        { mode: 0o755 },
      );
    }

    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const push = yield* readHelmPushConfig(secrets);
    if (push) {
      const environmentId = yield* (yield* ServerEnvironment).getEnvironmentId;
      state.notify = (request) => {
        void fetch(`${push.url}/v1/environments/${environmentId}/auth-requests`, {
          method: "POST",
          headers: { authorization: `Bearer ${push.token}`, "content-type": "application/json" },
          body: JSON.stringify({
            id: request.id,
            kind: request.kind,
            app: request.app,
            title: request.title,
            environmentId,
          }),
        }).catch(() => undefined);
      };
    }

    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const server = listenForSudo(NodePath.join(config.baseDir, "sudo.sock"));
        if (directory) startHelper(NodePath.join(directory, "helm-auth"));
        return server;
      }),
      (server) =>
        Effect.sync(() => {
          server.close();
          const helper = state.helper;
          state.helper = null;
          helper?.kill();
        }),
    );
  }),
);
