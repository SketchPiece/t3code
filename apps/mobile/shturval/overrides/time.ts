// Shturval fork: replaces src/lib/time.ts (see ../metro.cjs) with Russian units.
export function relativeTime(input: string): string {
  const timestamp = Date.parse(input);
  if (Number.isNaN(timestamp)) {
    return "<1 мин";
  }

  // Anything under a minute renders as "<1 мин" rather than a live seconds count:
  // a ticking seconds label changes width and reflows the row.
  const deltaSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (deltaSeconds < 60) return "<1 мин";

  const deltaMinutes = Math.floor(deltaSeconds / 60);
  if (deltaMinutes < 60) return `${deltaMinutes} мин`;

  const deltaHours = Math.floor(deltaMinutes / 60);
  if (deltaHours < 24) return `${deltaHours} ч`;

  const deltaDays = Math.floor(deltaHours / 24);
  return `${deltaDays} д`;
}
