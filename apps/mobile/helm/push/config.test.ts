import { describe, expect, it } from "vite-plus/test";

import { helmPushConfigFromEnv, readHelmPushConfig } from "./config";

describe("Helm push config", () => {
  it("points at the core's /helm routes only when both values are set", () => {
    expect(
      helmPushConfigFromEnv({ HELM_PUSH_URL: "https://core.example.app/", HELM_PUSH_TOKEN: "t" }),
    ).toEqual({ url: "https://core.example.app/helm", token: "t" });
    expect(helmPushConfigFromEnv({ HELM_PUSH_URL: "https://core.example.app" })).toBeNull();
    expect(readHelmPushConfig({ helmPush: null })).toBeNull();
    expect(readHelmPushConfig({ helmPush: { url: "https://x/helm", token: "t" } })).toEqual({
      url: "https://x/helm",
      token: "t",
    });
  });
});
