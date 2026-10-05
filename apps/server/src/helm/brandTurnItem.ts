// Helm fork: stores Helm's name on items for calls to its own MCP server, so
// every client (and the pending-work pill) reads "Helm Worktree Handoff"
// instead of the provider's "T3 Worktree Handoff".
import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import { helmBrandTurnItem } from "@t3tools/shared/helmBrand";
import { resolveT3McpToolDefinition } from "@t3tools/shared/t3McpToolPresentation";

const isT3McpTool = (toolName: string | null | undefined) =>
  resolveT3McpToolDefinition(toolName) !== null;

export function helmBrandIngestedTurnItem(item: OrchestrationV2TurnItem): OrchestrationV2TurnItem {
  return helmBrandTurnItem(item, isT3McpTool);
}
