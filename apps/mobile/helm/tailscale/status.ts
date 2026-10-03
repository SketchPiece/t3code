// Helm fork: the parts of tailscale's ipnstate.Status the Tailscale screen shows.

export interface TailnetPeer {
  readonly id: string;
  readonly name: string;
  readonly ip: string | null;
  readonly online: boolean;
  /** Desktops and servers can run Helm; phones and tablets cannot. */
  readonly isComputer: boolean;
}

export interface TailnetStatus {
  /** NoState, NeedsLogin, NeedsMachineAuth, Starting, Running or Stopped. */
  readonly state: string;
  readonly authUrl: string | null;
  readonly tailnetName: string | null;
  readonly selfName: string | null;
  readonly selfIp: string | null;
  readonly peers: ReadonlyArray<TailnetPeer>;
}

interface RawPeer {
  readonly ID?: string;
  readonly HostName?: string;
  readonly DNSName?: string;
  readonly TailscaleIPs?: ReadonlyArray<string> | null;
  readonly Online?: boolean;
  readonly OS?: string;
}

interface RawStatus {
  readonly BackendState?: string;
  readonly AuthURL?: string;
  readonly Self?: RawPeer;
  readonly CurrentTailnet?: { readonly Name?: string } | null;
  readonly Peer?: Record<string, RawPeer> | null;
}

const COMPUTER_OS = new Set(["macOS", "linux", "windows", "freebsd", "openbsd"]);

const ipv4 = (peer: RawPeer | undefined) =>
  peer?.TailscaleIPs?.find((ip) => !ip.includes(":")) ?? peer?.TailscaleIPs?.[0] ?? null;

/** MagicDNS short name, falling back to the OS hostname. */
const displayName = (peer: RawPeer) => peer.DNSName?.split(".")[0] || peer.HostName || "Unnamed";

export function parseTailnetStatus(json: string): TailnetStatus {
  const raw = JSON.parse(json) as RawStatus;
  const peers = Object.entries(raw.Peer ?? {})
    .map(([key, peer]) => ({
      id: peer.ID ?? key,
      name: displayName(peer),
      ip: ipv4(peer),
      online: peer.Online === true,
      isComputer: COMPUTER_OS.has(peer.OS ?? ""),
    }))
    .toSorted((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
  return {
    state: raw.BackendState ?? "NoState",
    authUrl: raw.AuthURL || null,
    tailnetName: raw.CurrentTailnet?.Name || null,
    selfName: raw.Self ? displayName(raw.Self) : null,
    selfIp: ipv4(raw.Self),
    peers,
  };
}
