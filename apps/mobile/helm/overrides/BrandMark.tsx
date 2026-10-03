import Constants from "expo-constants";
import { View } from "react-native";

import { AppText as Text } from "../../src/components/AppText";
import { helmAppName } from "../appName";
import { HelmMark } from "./HelmMark";

// Helm fork: replaces src/components/BrandMark.tsx (see ../metro.cjs).

const appVariant = Constants.expoConfig?.extra?.appVariant;
const DEFAULT_STAGE_LABEL =
  appVariant === "development" ? "Dev" : appVariant === "preview" ? "Preview" : undefined;

export function BrandMark(props: { readonly compact?: boolean; readonly stageLabel?: string }) {
  const compact = props.compact ?? false;
  const stageLabel = props.stageLabel ?? DEFAULT_STAGE_LABEL;

  return (
    <View className="flex-row items-center gap-3">
      <HelmMark size={compact ? 34 : 44} />
      <View className="gap-1">
        <View className="flex-row items-center gap-2">
          <Text className="font-brand text-xl text-foreground">{helmAppName}</Text>
          {stageLabel ? (
            <View className="rounded-full bg-subtle px-2 py-1">
              <Text className="text-3xs font-t3-bold tracking-[1.1px] uppercase text-foreground-muted">
                {stageLabel}
              </Text>
            </View>
          ) : null}
        </View>
        {!compact ? (
          <Text className="text-xs font-medium text-foreground-muted">
            Mission control for agents on your machines
          </Text>
        ) : null}
      </View>
    </View>
  );
}
