import { describe, expect, it } from "vite-plus/test";

import { helmBrandText, helmBrandTurnItem } from "./helmBrand.ts";
import { resolveT3McpToolDefinition } from "./t3McpToolPresentation.ts";

const isT3McpTool = (toolName: string | null | undefined) =>
  resolveT3McpToolDefinition(toolName) !== null;

describe("helmBrandText", () => {
  it("names Helm in product words and leaves identifiers alone", () => {
    expect(helmBrandText("T3 Worktree Handoff")).toBe("Helm Worktree Handoff");
    expect(helmBrandText("Restart T3 Code.")).toBe("Restart Helm.");
    expect(helmBrandText("T3 Code's threads in a T3 thread")).toBe(
      "Helm's threads in a Helm thread",
    );
    expect(helmBrandText("mcp__t3-code__t3_worktree_handoff")).toBe(
      "mcp__t3-code__t3_worktree_handoff",
    );
    expect(helmBrandText("T3Code T3-Code T3_HOME")).toBe("T3Code T3-Code T3_HOME");
  });
});

describe("helmBrandTurnItem", () => {
  const item = {
    type: "dynamic_tool",
    title: "T3 Worktree Handoff",
    toolName: "mcp__t3-code__t3_worktree_handoff",
    toolSource: { key: "mcp:t3 code", name: "T3 Code", kind: "integration" as const },
  };

  it("renames calls to Helm's own MCP server", () => {
    expect(helmBrandTurnItem(item, isT3McpTool)).toEqual({
      ...item,
      title: "Helm Worktree Handoff",
      toolSource: { ...item.toolSource, name: "Helm" },
    });
  });

  it("keeps other tools' titles", () => {
    const foreign = {
      type: "dynamic_tool",
      title: "T3 Chat Search",
      toolName: "mcp__t3-chat__search",
    };
    expect(helmBrandTurnItem(foreign, isT3McpTool)).toBe(foreign);
  });
});
