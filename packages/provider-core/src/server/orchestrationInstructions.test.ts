import { assert, describe, it } from "@effect/vitest";

import { T3_CODE_ORCHESTRATION_INSTRUCTIONS } from "./orchestrationInstructions.ts";

// Helm fork: helmBrandText renames the product in this prose; tool names and ids must survive.
describe("Helm orchestration instructions", () => {
  it("names Helm in its prose but keeps tool names and ids exact", () => {
    assert.notMatch(T3_CODE_ORCHESTRATION_INSTRUCTIONS, /\bT3(?: Code)?\b(?![-_])/);
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "does not update Helm's thread binding");
    for (const id of ["`t3_worktree_handoff`", "mcp__t3_code__delegate_task", "T3_ACP_MCP_NODE"]) {
      assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, id);
    }
  });
});
