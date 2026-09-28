import {
  CommandId,
  MessageId,
  type ModelSelection,
  type OrchestrationMessage,
  type OrchestrationThreadShell,
  ProviderInstanceId,
  type RuntimeMode,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProviderRegistry from "../../../provider/Services/ProviderRegistry.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  type AgentEntry,
  AgentModelNotFoundError,
  AgentThreadBusyError,
  AgentThreadFailedError,
  AgentThreadIsSelfError,
  AgentThreadNotFoundError,
  type AgentThreadResult,
  type AgentThreadStatus,
  DEFAULT_WAIT_SECONDS,
  MAX_REPLY_CHARS,
  ThreadsToolkit,
} from "./tools.ts";

const POLL_INTERVAL = "1 second";
const MAX_TITLE_CHARS = 60;

const isUsable = (provider: ServerProvider) =>
  provider.enabled && provider.installed && provider.availability !== "unavailable";

/** What the tools report for list_agents; exported so the shape is testable without a layer. */
export function listAgents(providers: ReadonlyArray<ServerProvider>): ReadonlyArray<AgentEntry> {
  return providers.filter(isUsable).map((provider) => ({
    instanceId: provider.instanceId,
    driver: provider.driver,
    displayName: provider.displayName ?? provider.driver,
    models: provider.models.map((model) => ({
      model: model.slug,
      name: model.name,
      isDefault: model.isDefault === true,
    })),
  }));
}

type ModelMatch =
  | { readonly _tag: "found"; readonly instanceId: string; readonly model: string }
  | { readonly _tag: "none" }
  | { readonly _tag: "ambiguous"; readonly candidates: ReadonlyArray<string> };

/**
 * Finds the model an agent named. An exact slug, name or alias wins; otherwise
 * a unique substring does, so "astra" finds gpt-6-astra. Without a model the
 * instance's default is used.
 */
export function resolveModel(
  providers: ReadonlyArray<ServerProvider>,
  input: { readonly model?: string | undefined; readonly instanceId?: string | undefined },
): ModelMatch {
  const usable = providers
    .filter(isUsable)
    .filter(
      (provider) => input.instanceId === undefined || provider.instanceId === input.instanceId,
    );
  const entries = usable.flatMap((provider) =>
    provider.models.map((model) => ({ instanceId: provider.instanceId as string, model })),
  );
  const found = (entry: (typeof entries)[number]): ModelMatch => ({
    _tag: "found",
    instanceId: entry.instanceId,
    model: entry.model.slug,
  });
  const pick = (matches: typeof entries): ModelMatch | undefined => {
    if (matches.length === 1) return found(matches[0]!);
    if (matches.length > 1) {
      return {
        _tag: "ambiguous",
        candidates: matches.map((entry) => `${entry.model.slug} (instanceId ${entry.instanceId})`),
      };
    }
    return undefined;
  };

  if (input.model === undefined) {
    const inInstance = entries.filter((entry) => entry.instanceId === input.instanceId);
    const chosen = inInstance.find((entry) => entry.model.isDefault === true) ?? inInstance[0];
    return chosen === undefined ? { _tag: "none" } : found(chosen);
  }
  const wanted = input.model.toLowerCase();
  const namesOf = (entry: (typeof entries)[number]) =>
    [entry.model.slug, entry.model.name, entry.model.shortName, ...(entry.model.aliases ?? [])]
      .filter((name): name is string => name !== undefined)
      .map((name) => name.toLowerCase());
  return (
    pick(entries.filter((entry) => namesOf(entry).includes(wanted))) ??
    pick(entries.filter((entry) => namesOf(entry).some((name) => name.includes(wanted)))) ?? {
      _tag: "none",
    }
  );
}

const isAfterOrAt = (a: string, b: string) => Date.parse(a) >= Date.parse(b);

/**
 * Where a thread stands on the last message sent to it. A turn requested
 * before that message belongs to an earlier exchange, so the thread still
 * counts as working until the provider picks the new message up. `sentAt`
 * covers a message this call just sent, which the projection may not show yet.
 */
export function threadStatus(
  thread: OrchestrationThreadShell,
  sentAt: string | null = null,
): {
  readonly status: AgentThreadStatus;
  readonly error: string | null;
} {
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) {
    return { status: "needs-attention", error: null };
  }
  const session = thread.session;
  if (session?.status === "starting" || session?.status === "running") {
    return { status: "working", error: null };
  }
  const turn = thread.latestTurn;
  const turnIsCurrent =
    turn !== null &&
    [thread.latestUserMessageAt, sentAt].every(
      (messageAt) => messageAt === null || isAfterOrAt(turn.requestedAt, messageAt),
    );
  if (!turnIsCurrent) {
    return session?.status === "error"
      ? { status: "error", error: session.lastError ?? "The agent failed to start." }
      : { status: "working", error: null };
  }
  switch (turn.state) {
    case "running":
      return { status: "working", error: null };
    case "completed":
      return { status: "completed", error: null };
    case "interrupted":
      return { status: "interrupted", error: null };
    case "error":
      return { status: "error", error: session?.lastError ?? "The turn failed." };
  }
}

/** The assistant's messages after the last user message, trimmed from the front to fit. */
export function replySinceLastUserMessage(messages: ReadonlyArray<OrchestrationMessage>): {
  readonly reply: string | null;
  readonly replyTruncated: boolean;
} {
  let lastUser = -1;
  messages.forEach((message, index) => {
    if (message.role === "user") lastUser = index;
  });
  const text = messages
    .slice(lastUser + 1)
    .filter((message) => message.role === "assistant" && message.text.trim().length > 0)
    .map((message) => message.text.trim())
    .join("\n\n");
  if (text.length === 0) return { reply: null, replyTruncated: false };
  return text.length > MAX_REPLY_CHARS
    ? { reply: `…${text.slice(-MAX_REPLY_CHARS)}`, replyTruncated: true }
    : { reply: text, replyTruncated: false };
}

const titleFrom = (prompt: string) => {
  const firstLine =
    prompt
      .split("\n")
      .find((line) => line.trim().length > 0)
      ?.trim() ?? prompt;
  return firstLine.length > MAX_TITLE_CHARS
    ? `${firstLine.slice(0, MAX_TITLE_CHARS - 1).trimEnd()}…`
    : firstLine;
};

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const registry = yield* ProviderRegistry.ProviderRegistry;
  const crypto = yield* Crypto.Crypto;

  const uuid = crypto.randomUUIDv4.pipe(Effect.orDie);
  const commandId = (tag: string, threadId: ThreadId) =>
    uuid.pipe(Effect.map((id) => CommandId.make(`server:${tag}:${threadId}:${id}`)));
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  const failed = (operation: string) => (cause: unknown) =>
    new AgentThreadFailedError({ operation, cause });

  const dispatchFailure =
    (operation: string) =>
    <E>(cause: Cause.Cause<E>): Effect.Effect<never, AgentThreadFailedError> =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause as Cause.Cause<never>)
        : Effect.fail(new AgentThreadFailedError({ operation, cause }));

  const findThread = (threadId: ThreadId) =>
    snapshots.getThreadShellById(threadId).pipe(Effect.mapError(failed("read the thread")));

  const requireThread = Effect.fn("ThreadsToolkit.requireThread")(function* (threadId: ThreadId) {
    const thread = yield* findThread(threadId);
    if (Option.isNone(thread)) {
      return yield* new AgentThreadNotFoundError({ threadId });
    }
    return thread.value;
  });

  const callerThread = Effect.fn("ThreadsToolkit.callerThread")(function* () {
    const scope = yield* McpInvocationContext.requireMcpCapability("threads");
    return yield* requireThread(scope.threadId);
  });

  const report = Effect.fn("ThreadsToolkit.report")(function* (
    threadId: ThreadId,
    waitSeconds: number,
    sentAt: string | null = null,
  ) {
    const deadline = (yield* Clock.currentTimeMillis) + waitSeconds * 1_000;
    let thread = yield* requireThread(threadId);
    let state = threadStatus(thread, sentAt);
    while (state.status === "working" && (yield* Clock.currentTimeMillis) < deadline) {
      yield* Effect.sleep(POLL_INTERVAL);
      thread = yield* requireThread(threadId);
      state = threadStatus(thread, sentAt);
    }
    const detail = yield* snapshots
      .getThreadDetailById(threadId, { activityKinds: [] })
      .pipe(Effect.mapError(failed("read the thread")));
    const reply = Option.match(detail, {
      onNone: () => ({ reply: null, replyTruncated: false }),
      onSome: (full) => replySinceLastUserMessage(full.messages),
    });
    return {
      threadId: thread.id,
      title: thread.title,
      instanceId: thread.modelSelection.instanceId,
      model: thread.modelSelection.model,
      status: state.status,
      error: state.error,
      ...reply,
    } satisfies AgentThreadResult;
  });

  const startTurn = Effect.fn("ThreadsToolkit.startTurn")(function* (input: {
    readonly threadId: ThreadId;
    readonly text: string;
    readonly runtimeMode: RuntimeMode;
    readonly interactionMode: OrchestrationThreadShell["interactionMode"];
    readonly titleSeed?: string;
    readonly createdAt: string;
  }) {
    yield* engine
      .dispatch({
        type: "thread.turn.start",
        commandId: yield* commandId("mcp-agent-turn", input.threadId),
        threadId: input.threadId,
        message: {
          messageId: MessageId.make(yield* uuid),
          role: "user",
          text: input.text,
          attachments: [],
        },
        ...(input.titleSeed === undefined ? {} : { titleSeed: input.titleSeed }),
        runtimeMode: input.runtimeMode,
        interactionMode: input.interactionMode,
        createdAt: input.createdAt,
      })
      .pipe(Effect.catchCause(dispatchFailure("send the message")));
  });

  return ThreadsToolkit.of({
    list_agents: () =>
      Effect.gen(function* () {
        yield* McpInvocationContext.requireMcpCapability("threads");
        return { agents: listAgents(yield* registry.getProviders) };
      }),
    start_agent_thread: (input) =>
      Effect.gen(function* () {
        const parent = yield* callerThread();
        let modelSelection: ModelSelection = parent.modelSelection;
        if (input.model !== undefined || input.instanceId !== undefined) {
          const match = resolveModel(yield* registry.getProviders, input);
          if (match._tag !== "found") {
            return yield* new AgentModelNotFoundError({
              model: input.model ?? input.instanceId ?? "",
              candidates: match._tag === "ambiguous" ? match.candidates : [],
            });
          }
          const sameAsParent =
            match.instanceId === parent.modelSelection.instanceId &&
            match.model === parent.modelSelection.model;
          modelSelection = sameAsParent
            ? parent.modelSelection
            : { instanceId: ProviderInstanceId.make(match.instanceId), model: match.model };
        }

        const threadId = ThreadId.make(yield* uuid);
        const title = input.title ?? titleFrom(input.prompt);
        const runtimeMode = input.runtimeMode ?? parent.runtimeMode;
        const createdAt = yield* nowIso;
        yield* engine
          .dispatch({
            type: "thread.create",
            commandId: yield* commandId("mcp-agent-thread-create", threadId),
            threadId,
            projectId: parent.projectId,
            title,
            modelSelection,
            runtimeMode,
            interactionMode: "default",
            // The new agent works in the same checkout as the one that asked for it.
            branch: parent.branch,
            worktreePath: parent.worktreePath,
            createdAt,
          })
          .pipe(Effect.catchCause(dispatchFailure("create the thread")));
        yield* startTurn({
          threadId,
          text: input.prompt,
          runtimeMode,
          interactionMode: "default",
          titleSeed: title,
          createdAt,
        });
        return yield* report(threadId, input.waitSeconds ?? DEFAULT_WAIT_SECONDS, createdAt);
      }),
    message_agent_thread: (input) =>
      Effect.gen(function* () {
        const parent = yield* callerThread();
        const threadId = ThreadId.make(input.threadId);
        if (threadId === parent.id) {
          return yield* new AgentThreadIsSelfError({});
        }
        const target = yield* requireThread(threadId);
        if (threadStatus(target).status === "working") {
          return yield* new AgentThreadBusyError({ threadId });
        }
        const sentAt = yield* nowIso;
        yield* startTurn({
          threadId,
          text: input.message,
          runtimeMode: target.runtimeMode,
          interactionMode: target.interactionMode,
          createdAt: sentAt,
        });
        return yield* report(threadId, input.waitSeconds ?? DEFAULT_WAIT_SECONDS, sentAt);
      }),
    read_agent_thread: (input) =>
      Effect.gen(function* () {
        yield* McpInvocationContext.requireMcpCapability("threads");
        return yield* report(
          ThreadId.make(input.threadId),
          input.waitSeconds ?? DEFAULT_WAIT_SECONDS,
        );
      }),
  });
});

export const ThreadsToolkitHandlersLive = ThreadsToolkit.toLayer(make);
