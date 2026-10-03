// Helm fork: one step above upstream, matching global.css.
export const MOBILE_TYPOGRAPHY = {
  micro: { fontSize: 12, lineHeight: 15 },
  caption: { fontSize: 13, lineHeight: 17 },
  label: { fontSize: 14, lineHeight: 18 },
  footnote: { fontSize: 15, lineHeight: 20 },
  body: { fontSize: 17, lineHeight: 24 },
  headline: { fontSize: 19, lineHeight: 24 },
  title: { fontSize: 22, lineHeight: 28 },
  largeTitle: { fontSize: 27, lineHeight: 33 },
  display: { fontSize: 31, lineHeight: 37 },
} as const;

/** Shared geometry for dense, horizontally scrolling code surfaces. */
export const MOBILE_CODE_SURFACE = {
  rowHeight: 22,
  gutterWidth: 46,
  codePadding: 7,
  textVerticalInset: 2,
  // Helm fork: code keeps upstream's sizes; only the Plex interface text moved up.
  fontSize: 12,
  lineNumberFontSize: 11,
} as const;
