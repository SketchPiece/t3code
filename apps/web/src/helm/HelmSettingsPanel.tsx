import type { HelmClientSettingsFields, HelmServerSettingsFields } from "@t3tools/contracts";
import { useState } from "react";

import { refreshTheme } from "../hooks/useTheme";
import { ScopedSwitch } from "../components/settings/ScopedSwitch";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "../components/settings/settingsLayout";
import { searchableSetting } from "../components/settings/settingsSearch";
import {
  useScopedSettings,
  useUpdateScopedSettings,
} from "../components/settings/useScopedSettings";
import { Switch } from "../components/ui/switch";
import { isHelmLookEnabled, setHelmLookEnabled } from "./look";

// Helm fork: Settings → Helm. What Helm adds to T3 Code, each with a switch, and what it turned
// off. The name, icon, data folder, port and update source stay Helm's; they let it run beside
// T3 Code.
export function HelmSettingsPanel() {
  return (
    <SettingsPageContainer>
      <SettingsSection id="helm-device" title="This device">
        <HelmLookRow />
        <ClientRow
          id="helm-dictation"
          settingKey="helmDictationEnabled"
          description="The microphone in the composer that transcribes through helm-cloud. Needs the helm-push secret on the server."
        />
        <ClientRow
          id="t3-dictation"
          settingKey="t3LocalDictationEnabled"
          description="T3 Code's own dictation with local speech models. Set it up in Settings → Voice."
        />
        <ClientRow
          id="helm-remote"
          settingKey="helmRemoteEnabled"
          description="Helm Mobile can open threads here, type and send in the composer, and scroll the timeline."
        />
        <ClientRow
          id="helm-draft-sync"
          settingKey="helmDraftSyncEnabled"
          description="Unsent drafts follow you between this window and Helm Mobile."
        />
      </SettingsSection>
      <SettingsSection id="helm-server" title="This server">
        <ServerRow
          id="helm-nearby"
          settingKey="helmNearbyEnabled"
          description="Announce this Mac over Bonjour, so Helm Mobile on the same Wi-Fi finds it and can pair with a code."
        />
        <ServerRow
          id="helm-tailnet-pairing"
          settingKey="helmTailnetPairingEnabled"
          description="Phones on your tailnet can ask to pair, and this Mac asks you first."
        />
        <ServerRow
          id="helm-screen-remote"
          settingKey="helmScreenRemoteEnabled"
          description="Helm Mobile can watch this Mac's screen and drive its mouse and keyboard. Experimental."
        />
        <ServerRow
          id="helm-touch-id-password"
          settingKey="helmTouchIdPasswordEnabled"
          description="With an external display connected, Touch ID prompts on this Mac (1Password unlocking, apps asking for your login password) go straight to the password field."
        />
        <ServerRow
          id="helm-cloud-alerts"
          settingKey="helmCloudAlertsEnabled"
          description="Agent alerts and Live Activities go to Helm Mobile through helm-cloud. Off hands them back to T3 Connect."
        />
      </SettingsSection>
      <SettingsSection id="helm-removed" title="Turned off in Helm">
        <ServerRow
          id="t3-usage-analytics"
          settingKey="t3UsageAnalyticsEnabled"
          description="T3 Code collects anonymous usage data. Helm sends none unless this is on."
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}

function HelmLookRow() {
  const [enabled, setEnabled] = useState(isHelmLookEnabled);
  return (
    <SettingsRow
      {...searchableSetting("helm-look")}
      description="The Bakelite palette and IBM Plex type. Off shows T3 Code's stock theme and fonts. A theme or font picked in Appearance wins either way."
      control={
        <Switch
          checked={enabled}
          onCheckedChange={(checked) => {
            setHelmLookEnabled(Boolean(checked));
            setEnabled(Boolean(checked));
            refreshTheme();
          }}
          aria-label="Helm look"
        />
      }
    />
  );
}

function ClientRow(props: {
  readonly id: Parameters<typeof searchableSetting>[0];
  readonly settingKey: keyof typeof HelmClientSettingsFields;
  readonly description: string;
}) {
  const checked = useScopedSettings((settings) => settings[props.settingKey]);
  const updateSettings = useUpdateScopedSettings();
  const searchable = searchableSetting(props.id);
  return (
    <SettingsRow
      {...searchable}
      description={props.description}
      control={
        <Switch
          checked={checked}
          onCheckedChange={(next) => updateSettings({ [props.settingKey]: Boolean(next) })}
          aria-label={searchable.title}
        />
      }
    />
  );
}

function ServerRow(props: {
  readonly id: Parameters<typeof searchableSetting>[0];
  readonly settingKey: keyof typeof HelmServerSettingsFields;
  readonly description: string;
}) {
  const checked = useScopedSettings((settings) => settings[props.settingKey]);
  const updateSettings = useUpdateScopedSettings();
  const searchable = searchableSetting(props.id);
  return (
    <SettingsRow
      serverScoped
      {...searchable}
      settingKeys={[props.settingKey]}
      description={props.description}
      control={
        <ScopedSwitch
          settingKeys={[props.settingKey]}
          checked={checked}
          onCheckedChange={(next) => updateSettings({ [props.settingKey]: Boolean(next) })}
          aria-label={searchable.title}
        />
      }
    />
  );
}
