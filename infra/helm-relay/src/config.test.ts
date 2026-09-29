import { describe, expect, it } from "@effect/vitest";

import { resolvePublicOrigin, unescapePem } from "./config.ts";

describe("resolvePublicOrigin", () => {
  it("prefers the explicit origin and drops trailing slashes", () => {
    expect(
      resolvePublicOrigin({
        publicOrigin: "https://relay.example.com/",
        railwayPublicDomain: "helm-relay.up.railway.app",
      }),
    ).toBe("https://relay.example.com");
  });

  it("falls back to Railway's public domain", () => {
    expect(
      resolvePublicOrigin({
        publicOrigin: " ",
        railwayPublicDomain: "helm-relay.up.railway.app",
      }),
    ).toBe("https://helm-relay.up.railway.app");
  });

  it("is undefined without either", () => {
    expect(
      resolvePublicOrigin({ publicOrigin: undefined, railwayPublicDomain: undefined }),
    ).toBeUndefined();
  });
});

describe("unescapePem", () => {
  it("restores newlines pasted as \\n escapes", () => {
    expect(unescapePem("-----BEGIN KEY-----\\nabc\\n-----END KEY-----")).toBe(
      "-----BEGIN KEY-----\nabc\n-----END KEY-----",
    );
  });

  it("leaves a real multi-line PEM alone", () => {
    const pem = "-----BEGIN KEY-----\nabc\n-----END KEY-----";
    expect(unescapePem(pem)).toBe(pem);
  });
});
