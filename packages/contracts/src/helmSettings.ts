import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

// Helm fork: switches for what Helm adds to T3 Code (Settings → Helm). Helm's own features
// default to on. Upstream features that duplicate one of Helm's default to off.
const on = Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true)));
const off = Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false)));
const patch = Schema.optionalKey(Schema.Boolean);

/** Per device. */
export const HelmClientSettingsFields = {
  helmDictationEnabled: on,
  // Renamed from t3DictationEnabled so installs that saved the old default of true start off.
  t3LocalDictationEnabled: off,
  helmRemoteEnabled: on,
  helmDraftSyncEnabled: on,
};

export const HelmClientSettingsPatchFields = {
  helmDictationEnabled: patch,
  t3LocalDictationEnabled: patch,
  helmRemoteEnabled: patch,
  helmDraftSyncEnabled: patch,
};

/** Per server. */
export const HelmServerSettingsFields = {
  helmNearbyEnabled: on,
  helmTailnetPairingEnabled: on,
  helmScreenRemoteEnabled: on,
  helmTouchIdPasswordEnabled: on,
  helmCloudAlertsEnabled: on,
  /** Upstream sends anonymous usage data to T3 Code; Helm does not unless this is on. */
  t3UsageAnalyticsEnabled: off,
};

export const HelmServerSettingsPatchFields = {
  helmNearbyEnabled: patch,
  helmTailnetPairingEnabled: patch,
  helmScreenRemoteEnabled: patch,
  helmTouchIdPasswordEnabled: patch,
  helmCloudAlertsEnabled: patch,
  t3UsageAnalyticsEnabled: patch,
};
