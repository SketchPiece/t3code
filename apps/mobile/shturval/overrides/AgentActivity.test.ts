import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@expo/ui/swift-ui", () => ({
  HStack: "HStack",
  Image: "Image",
  Spacer: "Spacer",
  Text: "Text",
  VStack: "VStack",
  ZStack: "ZStack",
}));

vi.mock("@expo/ui/swift-ui/modifiers", () => {
  const passthrough = (value: unknown) => value;
  return {
    activityBackgroundTint: passthrough,
    background: passthrough,
    clipShape: passthrough,
    font: passthrough,
    foregroundStyle: passthrough,
    frame: passthrough,
    kerning: passthrough,
    layoutPriority: passthrough,
    lineLimit: passthrough,
    padding: passthrough,
    resizable: passthrough,
    shadow: passthrough,
    widgetURL: (value: unknown) => ({ widgetURL: value }),
  };
});

vi.mock("expo-widgets", () => ({
  createLiveActivity: vi.fn((name: string, layout: unknown) => ({ layout, name })),
}));

import { AgentActivity, type AgentActivityRowProps } from "./AgentActivity";

const row = (overrides: Partial<AgentActivityRowProps>): AgentActivityRowProps => ({
  environmentId: "env-1",
  threadId: "thread-1",
  projectTitle: "Random",
  threadTitle: "Thread",
  modelTitle: "Opus 5.5",
  phase: "running",
  status: "Agent is working",
  updatedAt: "2026-09-27T20:45:00.000Z",
  deepLink: "/threads/env-1/thread-1",
  ...overrides,
});

// Every string rendered anywhere in a layout tree.
function texts(node: unknown): string[] {
  if (node === null || node === undefined || typeof node === "boolean") return [];
  if (typeof node === "string" || typeof node === "number") return [String(node)];
  if (Array.isArray(node)) return node.flatMap(texts);
  const element = node as { props?: { children?: unknown } };
  return texts(element.props?.children);
}

const environment = { colorScheme: "dark", isLuminanceReduced: false } as never;

describe("AgentActivity (Shturval)", () => {
  it("leads with the thread that waits on you, in Russian", () => {
    const layout = AgentActivity(
      {
        title: "",
        subtitle: "",
        activeCount: 2,
        updatedAt: "2026-09-27T20:48:00.000Z",
        activities: [
          row({ threadId: "a", threadTitle: "Ребрендинг в Штурвал" }),
          row({ threadId: "b", threadTitle: "Аудит места", phase: "waiting_for_approval" }),
        ],
      },
      environment,
    );
    const banner = texts(layout.banner);
    expect(banner.indexOf("Аудит места")).toBeLessThan(banner.indexOf("Ребрендинг в Штурвал"));
    expect(banner).toContain("ЖДЁТ РАЗРЕШЕНИЯ · RANDOM");
    expect(texts(layout.compactTrailing)).toContain("Ждёт разрешения");
  });

  it("reports the outcome once nothing is active", () => {
    const layout = AgentActivity(
      {
        title: "",
        subtitle: "",
        activeCount: 0,
        updatedAt: "2026-09-27T20:48:00.000Z",
        activities: [row({ phase: "failed", threadTitle: "Иконка" })],
      },
      environment,
    );
    expect(texts(layout.compactTrailing)).toContain("Ошибка");
    expect(texts(layout.banner)).toContain("есть ошибка");
  });
});
