import { requireOptionalNativeModule } from "expo";

// Helm fork: the in-app Tailscale node (modules/helm-tailscale, iOS only).
interface HelmTailscaleModule {
  /** A node has run on this phone; its tailnet login is kept on disk. */
  hasState(): boolean;
  /** Starts the node; one that needs login reports AuthURL in its status. */
  start(hostname: string): Promise<void>;
  /** ipnstate.Status as JSON, or null while the node is stopped. */
  statusJson(): Promise<string | null>;
  /** Stops the node and forgets its login. */
  logout(): Promise<void>;
  /** Loopback port tunnelled to host:port on the tailnet. */
  forward(host: string, port: number): number;
}

export const HelmTailscale = requireOptionalNativeModule<HelmTailscaleModule>("HelmTailscale");
