import type { ColorValue } from "react-native";
import Svg, { Path } from "react-native-svg";
import { withUniwind } from "uniwind";

import { helmAppName } from "../appName";
import { HELM_SIGNAL_PATH } from "./HelmMark";

// Helm fork: replaces src/components/T3Wordmark.tsx (see ../metro.cjs).
// The signal line stands in for the "T3" letters wherever upstream draws its
// mark; it takes the same props and keeps the same aspect ratio.

const ThemedPath = withUniwind(Path);

export function T3Wordmark(props: {
  readonly height: number;
  readonly color?: ColorValue;
  readonly colorClassName?: string;
}) {
  const aspectRatio = 94.3941 / 56.96;
  return (
    <Svg
      accessibilityLabel={helmAppName}
      height={props.height}
      width={props.height * aspectRatio}
      viewBox="21 36 78 48"
    >
      <ThemedPath
        d={HELM_SIGNAL_PATH}
        color={props.color}
        colorClassName={props.colorClassName}
        fill="none"
        stroke="currentColor"
        strokeWidth={9}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}
