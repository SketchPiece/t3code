import { describe, expect, it } from "vite-plus/test";

import { parseTailnetStatus } from "./status";
import { isTailnetHost, rewriteTailnetUrl } from "./urls";

const forwarder = {
  forward: (host: string, port: number) =>
    host === "100.101.102.103" && port === 3773 ? 51000 : 52000,
};

describe("tailnet URLs", () => {
  it("recognizes tailnet addresses and MagicDNS names only", () => {
    expect(isTailnetHost("100.101.102.103")).toBe(true);
    expect(isTailnetHost("100.64.0.1")).toBe(true);
    expect(isTailnetHost("100.128.0.1")).toBe(false);
    expect(isTailnetHost("192.168.1.20")).toBe(false);
    expect(isTailnetHost("helm-mac.tail1234.ts.net")).toBe(true);
    expect(isTailnetHost("[fd7a:115c:a1e0::1]")).toBe(true);
    expect(isTailnetHost("example.com")).toBe(false);
  });

  it("tunnels tailnet http and ws through a loopback port, keeping the path", () => {
    expect(rewriteTailnetUrl("http://100.101.102.103:3773/api/auth/session?x=1", forwarder)).toBe(
      "http://127.0.0.1:51000/api/auth/session?x=1",
    );
    expect(rewriteTailnetUrl("ws://100.101.102.103:3773/ws?wsTicket=a", forwarder)).toBe(
      "ws://127.0.0.1:51000/ws?wsTicket=a",
    );
    expect(rewriteTailnetUrl("http://helm-mac.tail1234.ts.net/pair", forwarder)).toBe(
      "http://127.0.0.1:52000/pair",
    );
  });

  it("leaves TLS, other hosts and a stopped node alone", () => {
    expect(rewriteTailnetUrl("https://helm-mac.tail1234.ts.net/", forwarder)).toBe(
      "https://helm-mac.tail1234.ts.net/",
    );
    expect(rewriteTailnetUrl("http://192.168.1.20:3773/", forwarder)).toBe(
      "http://192.168.1.20:3773/",
    );
    expect(rewriteTailnetUrl("http://100.101.102.103:3773/", null)).toBe(
      "http://100.101.102.103:3773/",
    );
  });
});

describe("parseTailnetStatus", () => {
  it("reads login state, self and computers from ipnstate.Status", () => {
    const status = parseTailnetStatus(
      JSON.stringify({
        BackendState: "Running",
        AuthURL: "",
        CurrentTailnet: { Name: "andrey@example.com" },
        Self: {
          HostName: "helm-phone",
          DNSName: "helm-phone.tail1234.ts.net.",
          TailscaleIPs: ["100.80.0.2", "fd7a:115c:a1e0::2"],
        },
        Peer: {
          a: {
            ID: "a",
            HostName: "Mac",
            DNSName: "helm-mac.tail1234.ts.net.",
            TailscaleIPs: ["100.101.102.103"],
            Online: true,
            OS: "macOS",
          },
          b: {
            ID: "b",
            HostName: "iPad",
            DNSName: "ipad.tail1234.ts.net.",
            TailscaleIPs: ["100.80.0.9"],
            Online: true,
            OS: "iOS",
          },
          c: {
            ID: "c",
            HostName: "box",
            DNSName: "box.tail1234.ts.net.",
            TailscaleIPs: ["100.80.0.7"],
            Online: false,
            OS: "linux",
          },
        },
      }),
    );
    expect(status.state).toBe("Running");
    expect(status.authUrl).toBeNull();
    expect(status.selfIp).toBe("100.80.0.2");
    expect(
      status.peers.filter((peer) => peer.isComputer).map((peer) => [peer.name, peer.online]),
    ).toEqual([
      ["helm-mac", true],
      ["box", false],
    ]);
  });

  it("surfaces the login URL while the node needs login", () => {
    const status = parseTailnetStatus(
      JSON.stringify({
        BackendState: "NeedsLogin",
        AuthURL: "https://login.tailscale.com/a/xyz",
        Peer: null,
      }),
    );
    expect(status.authUrl).toBe("https://login.tailscale.com/a/xyz");
    expect(status.peers).toEqual([]);
  });
});
