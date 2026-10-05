// Helm fork: user-visible product naming. Upstream text says "T3 Code" or "T3";
// Helm shows its own name instead. Identifiers (the `t3-code` MCP server id,
// `t3_*` tool names, `@t3tools/*`, T3CODE_* env vars) are protocol and stay.

export const HELM_PRODUCT_NAME = "Helm";

// "T3 Code" or a standalone "T3" word, but not identifier-like spellings such
// as "T3Code", "T3-Code", "t3_thread" or "T3_X".
const T3_PRODUCT_WORD = /\bT3(?: Code)?\b(?![-_])/g;

/** "T3 Worktree Handoff" -> "Helm Worktree Handoff", "a T3 thread" -> "a Helm thread". */
export function helmBrandText(text: string): string {
  return text.replace(T3_PRODUCT_WORD, HELM_PRODUCT_NAME);
}

/** Helm names on the T3 MCP tool inventory's labels ("Create Helm threads"). */
export function helmBrandToolDefinition<
  Definition extends {
    readonly displayName: string;
    readonly labels: readonly [string, string, string, string];
  },
>(definition: Definition): Definition {
  const [action, running, completed, detail] = definition.labels;
  return {
    ...definition,
    displayName: helmBrandText(definition.displayName),
    labels: [
      helmBrandText(action),
      helmBrandText(running),
      helmBrandText(completed),
      helmBrandText(detail),
    ],
  };
}

const T3_SERVER_NAME = /^(?:mcp[-_ ])?t3[-_ ]?code$/i;

interface BrandableTurnItem {
  readonly type: string;
  readonly title: string | null;
  readonly toolName?: string | null;
  readonly toolSource?: { readonly name: string } | undefined;
}

/**
 * Provider-supplied labels for calls to Helm's own MCP server: Claude Code
 * sends the humanized tool name ("T3 Worktree Handoff") and the server name as
 * the item title and source. Other tools keep their titles untouched.
 */
export function helmBrandTurnItem<Item extends BrandableTurnItem>(
  item: Item,
  isT3McpTool: (toolName: string | null | undefined) => boolean,
): Item {
  if (item.type !== "dynamic_tool") return item;
  const fromT3Server =
    item.toolSource !== undefined && T3_SERVER_NAME.test(item.toolSource.name.trim());
  if (!fromT3Server && !isT3McpTool(item.toolName)) return item;
  const title = item.title === null ? null : helmBrandText(item.title);
  const toolSource =
    item.toolSource !== undefined && fromT3Server
      ? { ...item.toolSource, name: HELM_PRODUCT_NAME }
      : item.toolSource;
  if (title === item.title && toolSource === item.toolSource) return item;
  return { ...item, title, ...(toolSource === undefined ? {} : { toolSource }) };
}
