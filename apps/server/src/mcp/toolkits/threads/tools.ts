import {
  McpCapabilityUnavailableError,
  RuntimeMode,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProviderRegistry from "../../../provider/Services/ProviderRegistry.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  OrchestrationEngine.OrchestrationEngineService,
  ProjectionSnapshotQuery.ProjectionSnapshotQuery,
  ProviderRegistry.ProviderRegistry,
];

/** Most MCP clients give up on a call after a few minutes; a longer wait is a poll loop. */
export const DEFAULT_WAIT_SECONDS = 240;
export const MAX_WAIT_SECONDS = 1_800;

const WaitSeconds = Schema.optional(
  Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: MAX_WAIT_SECONDS })).annotate({
    description: `How long to wait for the agent to finish its turn, in seconds. 0 returns at once. Defaults to ${DEFAULT_WAIT_SECONDS}. If the agent is still working when it runs out, call read_agent_thread again later.`,
  }),
);

export class AgentThreadNotFoundError extends Schema.TaggedError<AgentThreadNotFoundError>()(
  "AgentThreadNotFoundError",
  { threadId: Schema.String },
) {
  override get message(): string {
    return `Thread ${this.threadId} was not found.`;
  }
}

export class AgentModelNotFoundError extends Schema.TaggedError<AgentModelNotFoundError>()(
  "AgentModelNotFoundError",
  { model: Schema.String, candidates: Schema.Array(Schema.String) },
) {
  override get message(): string {
    return this.candidates.length > 0
      ? `"${this.model}" matches several models: ${this.candidates.join(", ")}. Pass one of them exactly.`
      : `No enabled agent offers a model matching "${this.model}". Call list_agents to see what is available.`;
  }
}

export class AgentThreadIsSelfError extends Schema.TaggedError<AgentThreadIsSelfError>()(
  "AgentThreadIsSelfError",
  {},
) {
  override get message(): string {
    return "That is this thread. Messaging yourself would wait on your own turn forever.";
  }
}

export class AgentThreadBusyError extends Schema.TaggedError<AgentThreadBusyError>()(
  "AgentThreadBusyError",
  { threadId: Schema.String },
) {
  override get message(): string {
    return `Thread ${this.threadId} is still working. Wait for it with read_agent_thread before sending another message.`;
  }
}

export class AgentThreadFailedError extends Schema.TaggedError<AgentThreadFailedError>()(
  "AgentThreadFailedError",
  { operation: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not ${this.operation}.`;
  }
}

export const AgentThreadToolError = Schema.Union([
  McpCapabilityUnavailableError,
  AgentThreadNotFoundError,
  AgentModelNotFoundError,
  AgentThreadIsSelfError,
  AgentThreadBusyError,
  AgentThreadFailedError,
]);
export type AgentThreadToolError = typeof AgentThreadToolError.Type;

export const AgentModelEntry = Schema.Struct({
  model: Schema.String.annotate({ description: "Model slug to pass as model." }),
  name: Schema.String,
  isDefault: Schema.Boolean,
});

export const AgentEntry = Schema.Struct({
  instanceId: Schema.String.annotate({
    description: "Provider instance to pass as instanceId when a model slug is ambiguous.",
  }),
  driver: Schema.String,
  displayName: Schema.String,
  models: Schema.Array(AgentModelEntry),
});
export type AgentEntry = typeof AgentEntry.Type;

export const ListAgentsResult = Schema.Struct({
  agents: Schema.Array(AgentEntry),
});
export type ListAgentsResult = typeof ListAgentsResult.Type;

export const AgentThreadStatus = Schema.Literals([
  "working",
  "completed",
  "needs-attention",
  "interrupted",
  "error",
]);
export type AgentThreadStatus = typeof AgentThreadStatus.Type;

export const AgentThreadResult = Schema.Struct({
  threadId: Schema.String,
  title: Schema.String,
  instanceId: Schema.String,
  model: Schema.String,
  status: AgentThreadStatus.annotate({
    description:
      "working: still on its turn, call read_agent_thread again. completed: reply holds its answer. needs-attention: it is waiting on an approval or a question the user must answer in its thread. interrupted or error: the turn stopped early; error carries the reason.",
  }),
  reply: Schema.NullOr(Schema.String).annotate({
    description: "The agent's messages since the last message sent to it, oldest first.",
  }),
  replyTruncated: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
});
export type AgentThreadResult = typeof AgentThreadResult.Type;

const ListAgentsTool = Tool.make("list_agents", {
  description:
    "List the agents you can start a thread with: each enabled provider instance and its models. Use it to find a model slug for start_agent_thread, for example a Codex model for computer use.",
  success: ListAgentsResult,
  failure: AgentThreadToolError,
  dependencies,
})
  .annotate(Tool.Title, "List agents")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const StartAgentThreadTool = Tool.make("start_agent_thread", {
  description:
    "Start a new T3 Code thread with another agent in this project and hand it a task. The thread shows in the sidebar like any other, runs in this thread's checkout, and by default the call waits for the agent's answer. Use it to delegate work another model is better at, such as computer use. Write the prompt as a complete brief: the other agent sees nothing of this conversation.",
  parameters: Schema.Struct({
    prompt: TrimmedNonEmptyString.annotate({
      description: "The task for the other agent, self-contained.",
    }),
    model: Schema.optional(
      TrimmedNonEmptyString.annotate({
        description:
          "Model slug or name, for example gpt-6-astra or just astra. Defaults to this thread's model.",
      }),
    ),
    instanceId: Schema.optional(
      TrimmedNonEmptyString.annotate({
        description: "Provider instance from list_agents, when the model alone is ambiguous.",
      }),
    ),
    title: Schema.optional(
      TrimmedNonEmptyString.annotate({ description: "Sidebar title for the new thread." }),
    ),
    runtimeMode: Schema.optional(
      RuntimeMode.annotate({
        description: "Permission mode for the new thread. Defaults to this thread's mode.",
      }),
    ),
    waitSeconds: WaitSeconds,
  }),
  success: AgentThreadResult,
  failure: AgentThreadToolError,
  dependencies,
})
  .annotate(Tool.Title, "Start agent thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

const MessageAgentThreadTool = Tool.make("message_agent_thread", {
  description:
    "Send a follow-up message to a thread you started with start_agent_thread, for example to answer its question or give it the next step, and by default wait for its answer. The thread must not be mid-turn.",
  parameters: Schema.Struct({
    threadId: TrimmedNonEmptyString,
    message: TrimmedNonEmptyString,
    waitSeconds: WaitSeconds,
  }),
  success: AgentThreadResult,
  failure: AgentThreadToolError,
  dependencies,
})
  .annotate(Tool.Title, "Message agent thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

const ReadAgentThreadTool = Tool.make("read_agent_thread", {
  description:
    "Read where another thread stands and its reply to the last message sent to it. Waits for a working thread to finish, up to waitSeconds.",
  parameters: Schema.Struct({
    threadId: TrimmedNonEmptyString,
    waitSeconds: WaitSeconds,
  }),
  success: AgentThreadResult,
  failure: AgentThreadToolError,
  dependencies,
})
  .annotate(Tool.Title, "Read agent thread")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const ThreadsToolkit = Toolkit.make(
  ListAgentsTool,
  StartAgentThreadTool,
  MessageAgentThreadTool,
  ReadAgentThreadTool,
);

/** Replies past this are cut from the front so the agent keeps the conclusion. */
export const MAX_REPLY_CHARS = 20_000;
