import {
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationMessage,
  type OrchestrationThreadShell,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { listAgents, replySinceLastUserMessage, resolveModel, threadStatus } from "./handlers.ts";
import { MAX_REPLY_CHARS } from "./tools.ts";

function makeProvider(
  instanceId: string,
  models: ReadonlyArray<{
    readonly slug: string;
    readonly name: string;
    readonly isDefault?: boolean;
    readonly aliases?: ReadonlyArray<string>;
  }>,
  overrides: Partial<ServerProvider> = {},
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: instanceId as ServerProvider["driver"],
    displayName: instanceId === "codex" ? "Codex" : "Claude",
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-01T00:00:00.000Z",
    models: models.map((model) => ({ isCustom: false, capabilities: null, ...model })),
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

const PROVIDERS = [
  makeProvider("codex", [
    { slug: "gpt-6-astra", name: "GPT-6 Astra", isDefault: true },
    { slug: "gpt-6-luna", name: "GPT-6 Luna" },
  ]),
  makeProvider("claudeAgent", [
    { slug: "claude-opus-5-5", name: "Claude Opus 5.5", aliases: ["opus"] },
    { slug: "claude-sonnet-5", name: "Claude Sonnet 5", isDefault: true },
  ]),
  makeProvider("cursor", [{ slug: "composer", name: "Composer" }], { enabled: false }),
];

function makeThread(overrides: Partial<OrchestrationThreadShell> = {}): OrchestrationThreadShell {
  return {
    id: ThreadId.make("thread-1"),
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-astra" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    pullRequests: [],
    latestTurn: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: "2026-09-01T00:00:10.000Z",
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

const turn = (
  state: "running" | "completed" | "interrupted" | "error",
  requestedAt = "2026-09-01T00:00:10.000Z",
): OrchestrationThreadShell["latestTurn"] => ({
  turnId: TurnId.make("turn-1"),
  state,
  requestedAt,
  startedAt: requestedAt,
  completedAt: state === "running" ? null : "2026-09-01T00:01:00.000Z",
  assistantMessageId: null,
});

const message = (role: "user" | "assistant", text: string): OrchestrationMessage => ({
  id: MessageId.make(`${role}-${text}`),
  role,
  text,
  turnId: null,
  streaming: false,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
});

describe("listAgents", () => {
  it("lists enabled providers with their models", () => {
    expect(listAgents(PROVIDERS).map((agent) => agent.instanceId)).toEqual([
      "codex",
      "claudeAgent",
    ]);
    expect(listAgents(PROVIDERS)[0]?.models[0]).toEqual({
      model: "gpt-6-astra",
      name: "GPT-6 Astra",
      isDefault: true,
    });
  });
});

describe("resolveModel", () => {
  it("finds a model by slug, name, alias or a unique part of its name", () => {
    const astra = { _tag: "found", instanceId: "codex", model: "gpt-6-astra" };
    expect(resolveModel(PROVIDERS, { model: "gpt-6-astra" })).toEqual(astra);
    expect(resolveModel(PROVIDERS, { model: "GPT-6 Astra" })).toEqual(astra);
    expect(resolveModel(PROVIDERS, { model: "astra" })).toEqual(astra);
    expect(resolveModel(PROVIDERS, { model: "opus" })).toEqual({
      _tag: "found",
      instanceId: "claudeAgent",
      model: "claude-opus-5-5",
    });
  });

  it("reports an ambiguous or unknown model", () => {
    expect(resolveModel(PROVIDERS, { model: "gpt-6" })._tag).toBe("ambiguous");
    expect(resolveModel(PROVIDERS, { model: "composer" })._tag).toBe("none");
  });

  it("narrows to an instance and falls back to its default model", () => {
    expect(resolveModel(PROVIDERS, { model: "gpt-6", instanceId: "claudeAgent" })._tag).toBe(
      "none",
    );
    expect(resolveModel(PROVIDERS, { instanceId: "claudeAgent" })).toEqual({
      _tag: "found",
      instanceId: "claudeAgent",
      model: "claude-sonnet-5",
    });
  });
});

describe("threadStatus", () => {
  it("counts a thread as working until a turn for the last message settles", () => {
    expect(threadStatus(makeThread()).status).toBe("working");
    expect(threadStatus(makeThread({ latestTurn: turn("running") })).status).toBe("working");
    expect(threadStatus(makeThread({ latestTurn: turn("completed") })).status).toBe("completed");
    expect(
      threadStatus(makeThread({ latestTurn: turn("completed", "2026-09-01T00:00:05.000Z") }))
        .status,
    ).toBe("working");
  });

  it("ignores a settled earlier turn when this call just sent a message", () => {
    const thread = makeThread({ latestTurn: turn("completed") });
    expect(threadStatus(thread, "2026-09-01T00:02:00.000Z").status).toBe("working");
  });

  it("surfaces approvals, interruptions and failures", () => {
    expect(
      threadStatus(makeThread({ latestTurn: turn("running"), hasPendingApprovals: true })).status,
    ).toBe("needs-attention");
    expect(threadStatus(makeThread({ latestTurn: turn("interrupted") })).status).toBe(
      "interrupted",
    );
    expect(
      threadStatus(
        makeThread({
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "error",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: "Codex is not signed in.",
            updatedAt: "2026-09-01T00:00:11.000Z",
          },
        }),
      ),
    ).toEqual({ status: "error", error: "Codex is not signed in." });
  });
});

describe("replySinceLastUserMessage", () => {
  it("joins the assistant messages after the last user message", () => {
    expect(
      replySinceLastUserMessage([
        message("user", "first"),
        message("assistant", "old answer"),
        message("user", "second"),
        message("assistant", "part one"),
        message("assistant", "part two"),
      ]),
    ).toEqual({ reply: "part one\n\npart two", replyTruncated: false });
    expect(replySinceLastUserMessage([message("user", "hi")]).reply).toBeNull();
  });

  it("keeps the end of a long reply", () => {
    const long = `${"a".repeat(MAX_REPLY_CHARS)}conclusion`;
    const result = replySinceLastUserMessage([message("user", "go"), message("assistant", long)]);
    expect(result.replyTruncated).toBe(true);
    expect(result.reply?.endsWith("conclusion")).toBe(true);
  });
});
