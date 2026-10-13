/**
 * How far the file's open is, for the loader (Figma's: its logo over a bar that fills while the file comes in). One
 * value per editor page (a tab is a process), only ever moving forward. Each step of the open sets the floor it reached
 * and the ceiling of the next; between them the bar creeps on (most steps say nothing while they run).
 *
 *   0.05 the tab is up — 0.65 the document downloaded (a shared copy's first open, by its bytes) — 0.72 stored here —
 *   0.8 the store's file open — 0.9 the engine up, the document handed over — 1 the first frame.
 */
import { useSyncExternalStore } from "react";

let value = 0;
let ceiling = 0.6;
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function creep(): void {
  if (value >= ceiling) return;
  // A twentieth of what's left to the ceiling each tick: fast at first, never quite there
  value = Math.min(ceiling, value + Math.max(0.002, (ceiling - value) / 20));
  emit();
}

/** The open reached `at`; the bar may creep up to `next` until the next step says more */
export function setOpenProgress(at: number, next = at): void {
  if (at > value) value = Math.min(1, at);
  ceiling = Math.max(ceiling, next, value);
  emit();
}

export function openProgress(): number {
  return value;
}

export function useOpenProgress(): number {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      if (!timer && typeof setInterval === "function") timer = setInterval(creep, 100);
      return () => {
        listeners.delete(l);
        if (!listeners.size && timer) {
          clearInterval(timer);
          timer = null;
        }
      };
    },
    () => value,
  );
}

/** The document coming down (a shared copy's first open): its share of the bar */
export function downloadProgress(received: number, total: number | null): void {
  if (!total) return setOpenProgress(0.05, 0.6);
  setOpenProgress(0.05 + 0.6 * Math.min(1, received / total), 0.66);
}
