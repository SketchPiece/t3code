import type { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { buildHomeListFilterMenu } from "./home-list-filter-menu";

const macbook = "environment-1" as EnvironmentId;
const base = {
  environments: [{ environmentId: macbook, label: "MacBook Pro" }],
  projects: [{ key: "environment-1:project-1", label: "t3code" }],
  selectedEnvironmentId: null,
  selectedProjectKey: null,
  onEnvironmentChange: vi.fn(),
  onProjectChange: vi.fn(),
};

describe("buildHomeListFilterMenu (Helm)", () => {
  it("switches environments and opens their settings when the chips own projects", () => {
    const onEnvironmentChange = vi.fn();
    const onOpenEnvironments = vi.fn();
    const menu = buildHomeListFilterMenu({ ...base, onEnvironmentChange, onOpenEnvironments });

    expect(menu.items.map((item) => item.title)).toEqual([
      "Все окружения",
      "MacBook Pro",
      "Настроить окружения…",
    ]);
    for (const item of menu.items.slice(1)) {
      if (item.type === "action") item.onPress();
    }
    expect(onEnvironmentChange).toHaveBeenCalledWith(macbook);
    expect(onOpenEnvironments).toHaveBeenCalledOnce();
  });

  it("keeps the project submenu where there are no chips", () => {
    const menu = buildHomeListFilterMenu(base);
    expect(menu.items.map((item) => item.title)).toEqual(["Окружение", "Проект"]);
  });
});
