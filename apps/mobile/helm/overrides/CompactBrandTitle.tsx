import Constants from "expo-constants";
import type { NativeStackNavigationOptions } from "@react-navigation/native-stack";
import { Platform, View } from "react-native";

import { AppText as Text } from "../../src/components/AppText";
import { useAndroidControlSizing } from "../../src/components/useAndroidControlSizing";
import { IPAD_HOME_TITLE_OFFSET } from "../../src/lib/layoutMetrics";
import { helmAppName } from "../appName";

// Helm fork: replaces src/components/CompactBrandTitle.tsx (see ../metro.cjs).
// The navigation bar shows the app's name; builds other than production keep a
// stage pill so a dev build is never mistaken for the real one.

export function brandTitleOffset(): number {
  if (Platform.OS !== "ios") return 0;
  return Platform.isPad ? IPAD_HOME_TITLE_OFFSET : 0;
}

const STAGE_LABELS: Readonly<Record<string, string>> = { development: "Dev", preview: "Preview" };

export function CompactBrandTitle(
  props: {
    readonly allowFontScaling?: boolean;
  } = {},
) {
  const stageLabel = STAGE_LABELS[String(Constants.expoConfig?.extra?.appVariant)];
  const { scale } = useAndroidControlSizing();

  return (
    <View
      aria-level={1}
      accessibilityLabel={`${helmAppName}, threads`}
      accessible
      role="heading"
      className="flex-row items-center gap-1.5"
      style={{ marginLeft: brandTitleOffset() }}
    >
      <Text
        allowFontScaling={props.allowFontScaling}
        className="font-brand text-foreground"
        style={{ fontSize: 19 * scale, letterSpacing: 0.2 * scale }}
      >
        {helmAppName}
      </Text>
      {stageLabel ? (
        <View className="rounded-full bg-subtle px-1.5 py-0.5">
          <Text
            allowFontScaling={props.allowFontScaling}
            className="font-t3-bold text-foreground-muted uppercase"
            style={{ fontSize: 9 * scale, letterSpacing: 0.9 * scale }}
          >
            {stageLabel}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

export function renderCompactBrandTitle() {
  return <CompactBrandTitle allowFontScaling={Platform.OS === "ios"} />;
}

export function getCompactBrandHeaderOptions(
  fallbackTitleStyle?: NativeStackNavigationOptions["headerTitleStyle"],
): NativeStackNavigationOptions {
  return {
    headerTitle: renderCompactBrandTitle,
    headerTitleStyle: fallbackTitleStyle,
    title: "Threads",
    unstable_headerLeftItems: undefined,
  };
}
