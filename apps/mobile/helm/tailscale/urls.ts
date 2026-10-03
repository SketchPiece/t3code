// Helm fork: routes tailnet addresses through the in-app Tailscale node.
//
// The node is not a VPN, so the system cannot reach 100.x addresses on its
// own. Instead every http/ws URL that points into the tailnet is rewritten to
// a loopback port the native module tunnels to the same host and port. TLS
// URLs stay as they are: a certificate for the tailnet name cannot match a
// loopback address, so Helm pairs over plain http on the tailnet (WireGuard
// already encrypts it).

export interface TailnetForwarder {
  forward(host: string, port: number): number;
}

const URL_PATTERN = /^(https?|wss?):\/\/(\[[^\]]+\]|[^/:?#]+)(?::(\d+))?(.*)$/i;
const DEFAULT_PORT: Record<string, number> = { http: 80, ws: 80 };

/** Tailscale's CGNAT range 100.64.0.0/10, its IPv6 prefix, and MagicDNS names. */
export function isTailnetHost(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (bare.endsWith(".ts.net")) return true;
  if (bare.startsWith("fd7a:115c:a1e0:")) return true;
  const octets = bare.split(".");
  if (octets.length !== 4 || octets.some((part) => !/^\d{1,3}$/.test(part))) return false;
  const [first, second] = octets.map(Number);
  return first === 100 && second !== undefined && second >= 64 && second <= 127;
}

/** The URL to actually open: a loopback tunnel for tailnet http/ws, else unchanged. */
export function rewriteTailnetUrl(url: string, forwarder: TailnetForwarder | null): string {
  if (forwarder === null) return url;
  const match = URL_PATTERN.exec(url);
  if (!match) return url;
  const [, rawScheme = "", host = "", rawPort, rest = ""] = match;
  const scheme = rawScheme.toLowerCase();
  const defaultPort = DEFAULT_PORT[scheme];
  if (defaultPort === undefined || !isTailnetHost(host)) return url;
  const port = rawPort ? Number(rawPort) : defaultPort;
  try {
    const localPort = forwarder.forward(host.replace(/^\[|\]$/g, ""), port);
    return `${scheme}://127.0.0.1:${localPort}${rest}`;
  } catch {
    return url;
  }
}
