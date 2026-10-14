import { useState } from "react";

import { Switch } from "../ui/switch";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

/** Consent belongs to this desktop, not to an environment's remotely writable settings. */
export function ScreenUnlockSetting() {
  const bridge = window.desktopBridge;
  const [enabled, setEnabled] = useState(() => bridge?.getScreenUnlockEnabled?.() === true);
  const [updating, setUpdating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const update = bridge?.setScreenUnlockEnabled;
  if (bridge?.getClientPlatform?.() !== "darwin" || !update) return null;

  const apply = async (value: boolean) => {
    setUpdating(true);
    setError(null);
    try {
      await update(value);
      setEnabled(value);
    } catch {
      setError("Couldn't change this setting. Try again.");
    } finally {
      setUpdating(false);
    }
  };

  return (
    <SettingsRow
      {...searchableSetting("screen-unlock")}
      description={
        error ??
        "Allow paired devices with screen control to enter your Mac password while it is locked. Passwords aren't saved."
      }
      control={
        <Switch
          checked={enabled}
          disabled={updating}
          onCheckedChange={(value) => void apply(value)}
          aria-label="Unlock Mac from your phone"
        />
      }
    />
  );
}
