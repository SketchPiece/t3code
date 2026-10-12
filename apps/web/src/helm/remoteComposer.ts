import { useSyncExternalStore } from "react";

// Helm fork: what Helm Mobile's remote does to a thread's composer beyond typing into it.
// - Dictation: the phone is listening for this thread, so the window shows that in place of the
//   draft and holds typing until the words arrive.
// - Send: the phone asks the window to send the draft as it stands.

/** Long enough for a take and its transcription; the phone repeats itself well within it. */
const DICTATION_TIMEOUT_MS = 45_000;

const dictating = new Map<string, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** Marks the phone as listening for the thread (`threadKey`), or no longer. */
export function setRemoteDictation(threadKey: string, active: boolean): void {
  const timer = dictating.get(threadKey);
  if (timer !== undefined) clearTimeout(timer);
  if (!active) {
    if (dictating.delete(threadKey)) notify();
    return;
  }
  const wasActive = timer !== undefined;
  // Should the phone go away mid-sentence, the draft comes back on its own.
  dictating.set(
    threadKey,
    setTimeout(() => setRemoteDictation(threadKey, false), DICTATION_TIMEOUT_MS),
  );
  if (!wasActive) notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useRemoteDictation(threadKey: string): boolean {
  return useSyncExternalStore(subscribe, () => dictating.has(threadKey));
}

const REMOTE_SEND_EVENT = "helm:remote-send";

export function requestRemoteSend(threadKey: string): void {
  window.dispatchEvent(new CustomEvent<string>(REMOTE_SEND_EVENT, { detail: threadKey }));
}

/** Calls `send` when the remote asks to send the draft of the thread `threadKey`. */
export function onRemoteSend(threadKey: string, send: () => void): () => void {
  const listener = (event: Event) => {
    if ((event as CustomEvent<string>).detail === threadKey) send();
  };
  window.addEventListener(REMOTE_SEND_EVENT, listener);
  return () => window.removeEventListener(REMOTE_SEND_EVENT, listener);
}
