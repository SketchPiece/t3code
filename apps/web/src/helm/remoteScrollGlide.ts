// Helm fork: Helm Mobile's trackpad. Its moves arrive in uneven batches over the network, so the
// timeline doesn't jump by each one: it eases toward where they add up to, every frame.

/** How quickly the timeline catches up: a drag follows the finger, a fling glides out. */
export const DRAG_EASE_MS = 45;
export const FLING_EASE_MS = 150;

/** One frame of easing from `current` toward `target`, `elapsedMs` after the last one. */
export function easeToward(
  current: number,
  target: number,
  elapsedMs: number,
  easeMs: number,
): number {
  const remaining = target - current;
  if (Math.abs(remaining) < 0.5) return target;
  return target - remaining * Math.exp(-Math.max(0, elapsedMs) / easeMs);
}

export interface ScrollGlide {
  /** Moves the target by `by` pixels and keeps easing toward it. */
  readonly add: (by: number, fling: boolean) => void;
  readonly stop: () => void;
}

export function makeScrollGlide(node: () => HTMLElement | null | undefined): ScrollGlide {
  let target = 0;
  let easeMs = DRAG_EASE_MS;
  let frame: number | null = null;
  let last = 0;

  const step = (now: number) => {
    const element = node();
    if (!element) {
      frame = null;
      return;
    }
    const next = easeToward(element.scrollTop, target, now - last, easeMs);
    last = now;
    element.scrollTop = next;
    // The list may stop short (its end, or content still measuring): don't chase what can't be reached.
    if (next === target || Math.abs(element.scrollTop - next) > 2) {
      frame = null;
      return;
    }
    frame = requestAnimationFrame(step);
  };

  return {
    add: (by, fling) => {
      const element = node();
      if (!element) return;
      const max = Math.max(0, element.scrollHeight - element.clientHeight);
      if (frame === null) target = element.scrollTop;
      target = Math.min(max, Math.max(0, target + by));
      easeMs = fling ? FLING_EASE_MS : DRAG_EASE_MS;
      if (frame === null) {
        last = performance.now();
        frame = requestAnimationFrame(step);
      }
    },
    stop: () => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
    },
  };
}
