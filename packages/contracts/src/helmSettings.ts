import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

// Helm fork: switches for what Helm adds to T3 Code (Settings → Helm). Every one
// defaults to on, so an install keeps working as before until its owner turns one off.
const on = Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true)));
const off = Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false)));
const patch = Schema.optionalKey(Schema.Boolean);

/** Per device. */
export const HelmClientSettingsFields = {
  helmDictationEnabled: on,
  t3DictationEnabled: on,
  helmRemoteEnabled: on,
  helmDraftSyncEnabled: on,
};

export const HelmClientSettingsPatchFields = {
  helmDictationEnabled: patch,
  t3DictationEnabled: patch,
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
