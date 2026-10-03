import { useNavigation } from "@react-navigation/native";
import * as WebBrowser from "expo-web-browser";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Alert, Platform, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../src/components/AndroidScreenHeader";
import { AppText as Text } from "../../src/components/AppText";
import { SettingsActionRow } from "../../src/features/settings/components/SettingsActionRow";
import { SettingsSection } from "../../src/features/settings/components/SettingsSection";
import { NativeStackScreenOptions } from "../../src/native/StackHeader";
import {
  type AutoPairState,
  pairTailnetComputers,
  readAutoPair,
  retryTailnetComputer,
  subscribeAutoPair,
} from "./autoPair";
import { HelmTailscale } from "./native";
import { HELM_TAILNET_HOSTNAME, setTailnetRouting } from "./routing";
import { parseTailnetStatus, type TailnetStatus } from "./status";

const STATUS_INTERVAL_MS = 1500;

// Helm fork: Settings → Tailscale. Logs the in-app node into the user's
// tailnet and adds the Helm computers on it as environments (autoPair.ts),
// so pairing a Helm machine needs neither the Tailscale VPN app nor a code.

function autoPairLabel(state: AutoPairState): string {
  switch (state) {
    case "checking":
      return "looking for Helm";
    case "not-helm":
      return "no Helm";
    case "waiting":
      return "allow it in Helm on this computer";
    case "added":
    case "already-added":
      return "added";
    case "denied":
      return "not allowed, tap to ask again";
    case "failed":
      return "failed, tap to retry";
  }
}
export function TailscaleSettingsScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const [status, setStatus] = useState<TailnetStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const openedAuthUrl = useRef<string | null>(null);
  const waitingForLogin = useRef(false);

  const refresh = useCallback(async () => {
    if (!HelmTailscale) return;
    try {
      const json = await HelmTailscale.statusJson();
      const next = json === null ? null : parseTailnetStatus(json);
      setStatus(next);
      if (next?.state === "Running") setTailnetRouting(true);
      if (waitingForLogin.current && next?.authUrl && openedAuthUrl.current !== next.authUrl) {
        openedAuthUrl.current = next.authUrl;
        await WebBrowser.openBrowserAsync(next.authUrl);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  // The node's status is an in-process call; while this screen is open it
  // is the only way to see a login finish in the browser.
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), STATUS_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const login = useCallback(async () => {
    if (!HelmTailscale) return;
    setBusy(true);
    setError(null);
    try {
      waitingForLogin.current = true;
      await HelmTailscale.start(HELM_TAILNET_HOSTNAME);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const logout = useCallback(() => {
    Alert.alert(
      "Log out of Tailscale?",
      "Computers on your tailnet stay unreachable until you log in again. The phone stays in your Tailscale machine list until you remove it there.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Log out",
          style: "destructive",
          onPress: () => {
            void (async () => {
              await HelmTailscale?.logout();
              setTailnetRouting(false);
              waitingForLogin.current = false;
              openedAuthUrl.current = null;
              setStatus(null);
            })();
          },
        },
      ],
    );
  }, []);

  const running = status?.state === "Running";
  const computers = status?.peers.filter((peer) => peer.isComputer) ?? [];
  const autoPair = useSyncExternalStore(subscribeAutoPair, readAutoPair, readAutoPair);

  // Each online computer is looked at once per app session; rows show how far
  // it got, and a denied or failed one can be asked again with a tap.
  useEffect(() => {
    if (running) pairTailnetComputers(computers);
  }, [running, computers]);

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title="Tailscale" onBack={() => navigation.goBack()} />
        </>
      ) : null}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-4 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {!HelmTailscale ? (
          <Text className="px-2 text-sm text-foreground-muted">
            Built-in Tailscale is only in the iPhone app.
          </Text>
        ) : running && status ? (
          <>
            <SettingsSection title="Tailnet">
              <View className="gap-1 rounded-2xl bg-grouped-card px-4 py-3">
                <Text className="text-base font-t3-medium text-foreground">
                  {status.tailnetName ?? "Connected"}
                </Text>
                <Text className="text-sm text-foreground-muted">
                  Phone: {status.selfName ?? HELM_TAILNET_HOSTNAME}
                  {status.selfIp ? ` · ${status.selfIp}` : ""}
                </Text>
              </View>
            </SettingsSection>
            <SettingsSection title="Computers">
              {computers.length === 0 ? (
                <Text className="px-2 text-sm text-foreground-muted">
                  No other computers on your tailnet.
                </Text>
              ) : (
                computers.map((peer) =>
                  peer.ip ? (
                    <SettingsActionRow
                      key={peer.id}
                      icon={peer.online ? "desktopcomputer" : "wifi.slash"}
                      label={
                        !peer.online
                          ? `${peer.name} · offline`
                          : `${peer.name} · ${autoPairLabel(autoPair.get(peer.ip) ?? "checking")}`
                      }
                      onPress={() => {
                        const state = autoPair.get(peer.ip ?? "");
                        if (state === "denied" || state === "failed") retryTailnetComputer(peer);
                      }}
                    />
                  ) : null,
                )
              )}
            </SettingsSection>
            <Text className="px-2 text-sm text-foreground-muted">
              Helm computers here are added on their own: turn on Settings → Connections → Network
              access in Helm on the computer, then allow this phone when Helm asks.
            </Text>
            <SettingsActionRow
              icon="xmark.circle.fill"
              label="Log out of Tailscale"
              tone="danger"
              onPress={logout}
            />
          </>
        ) : (
          <>
            <Text className="px-2 text-sm text-foreground-muted">
              Join your tailnet to reach your computers directly, without the Tailscale app. The
              connection works while the app is open.
            </Text>
            <SettingsActionRow
              icon={{ ios: "network", android: "public" }}
              label={status?.authUrl ? "Open login again" : "Log in to Tailscale"}
              loading={busy || (status !== null && !status.authUrl && !running)}
              disabled={busy}
              onPress={() => {
                openedAuthUrl.current = null;
                void login();
              }}
            />
            {status ? (
              <Text className="px-2 text-sm text-foreground-muted">State: {status.state}</Text>
            ) : null}
          </>
        )}
        {error ? <Text className="px-2 text-sm text-danger-foreground">{error}</Text> : null}
      </ScrollView>
    </View>
  );
}
