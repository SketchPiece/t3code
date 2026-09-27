import type { SVGProps } from "react";

// Shturval fork: the helm's signal line, from the app icon.
export const HELM_SIGNAL_PATH =
  "M26 60 Q30 50 34 60 Q38 70 42 60 Q46 50 50 60 Q54 70 58 60 L58 47 L70 47 L70 73 L82 73 L82 60 L93 60";

/**
 * The header mark: a square screen with the amber signal. Its colors are the
 * brand's own in every theme and live in shturval.css ([data-helm-mark]).
 */
export function HelmMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg" data-helm-mark {...props}>
      <rect x="4" y="4" width="112" height="112" rx="26" strokeWidth="4" />
      <path
        d={HELM_SIGNAL_PATH}
        fill="none"
        strokeWidth="9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
