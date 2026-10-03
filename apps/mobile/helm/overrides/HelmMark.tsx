import Svg, { Path, Rect } from "react-native-svg";
import { helmAppName } from "../appName";

// The desktop header's mark: a square screen with the amber signal.
export const HELM_SIGNAL_PATH =
  "M26 60 Q30 50 34 60 Q38 70 42 60 Q46 50 50 60 Q54 70 58 60 L58 47 L70 47 L70 73 L82 73 L82 60 L93 60";

export function HelmMark(props: { readonly size: number }) {
  return (
    <Svg
      width={props.size}
      height={props.size}
      viewBox="0 0 120 120"
      accessibilityLabel={helmAppName}
    >
      <Rect
        x={4}
        y={4}
        width={112}
        height={112}
        rx={26}
        fill="#26211D"
        stroke="rgba(239,231,214,0.18)"
        strokeWidth={4}
      />
      <Path
        d={HELM_SIGNAL_PATH}
        fill="none"
        stroke="#E8A33D"
        strokeWidth={9}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}
