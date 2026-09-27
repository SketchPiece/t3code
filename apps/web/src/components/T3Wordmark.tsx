import type { SVGProps } from "react";

import { HELM_SIGNAL_PATH } from "../shturval/HelmMark";

// Shturval fork: the helm's signal line stands in for the "T3" letters; same
// props and aspect, drawn in the current text color.
export function T3Wordmark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...props} viewBox="21 36 78 48" xmlns="http://www.w3.org/2000/svg">
      <path
        d={HELM_SIGNAL_PATH}
        fill="none"
        stroke="currentColor"
        strokeWidth="9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
