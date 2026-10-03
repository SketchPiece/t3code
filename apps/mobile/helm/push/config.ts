// Helm fork: where the phone registers for agent notifications and Live
// Activities. Read at prebuild from the repo's .env (HELM_PUSH_URL is the
// Volna core, HELM_PUSH_TOKEN its relay token) into extra.helmPush; the
// token ships inside this personal build. No Node or React Native imports.

export interface HelmPushConfig {
  readonly url: string;
  readonly token: string;
}

export function helmPushConfigFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): HelmPushConfig | null {
  const url = env.HELM_PUSH_URL?.trim().replace(/\/+$/, "");
  const token = env.HELM_PUSH_TOKEN?.trim();
  return url && token ? { url: `${url}/helm`, token } : null;
}

export function readHelmPushConfig(extra: unknown): HelmPushConfig | null {
  const value = (extra as { helmPush?: Partial<HelmPushConfig> } | undefined)?.helmPush;
  return value?.url && value.token ? { url: value.url, token: value.token } : null;
}
