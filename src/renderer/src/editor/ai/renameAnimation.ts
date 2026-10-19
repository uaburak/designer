/**
 * Rename layers' animation in the Layers panel (atlas 18 §4.3): as each name streams in, the row's old name is deleted
 * at 0.03 s a character, then the new one typed at 0.07 s a character, both linear. The document has the new name at
 * once (the row only shows it being typed); with reduced motion the row shows it at once too.
 */
import { useEffect, useState } from "react";
import { prefersReducedMotion } from "@/ds";

/** Figma's pace (s per character) */
export const RENAME_DELETE_S = 0.03;
export const RENAME_TYPE_S = 0.07;

interface Animation {
  from: string;
  to: string;
  /** performance.now() when it began */
  start: number;
}

const running = new Map<string, Animation>();
const listeners = new Set<() => void>();
const tell = () => listeners.forEach((l) => l());

/** What the row shows `ms` after the animation began; null once the new name is typed out. */
export function renameFrame(from: string, to: string, ms: number): string | null {
  const deleting = from.length * RENAME_DELETE_S * 1000;
  if (ms < deleting) return from.slice(0, from.length - Math.floor(ms / (RENAME_DELETE_S * 1000)));
  const typed = Math.floor((ms - deleting) / (RENAME_TYPE_S * 1000));
  return typed >= to.length ? null : to.slice(0, typed);
}

/** A row's name typed over from `from` to `to`. */
export function animateRename(id: string, from: string, to: string, now = performance.now()): void {
  if (from === to || prefersReducedMotion()) return;
  running.set(id, { from, to, start: now });
  tell();
}

/** Every animation dropped (a cancelled run puts the old names back at once). */
export function clearRenameAnimations(): void {
  if (!running.size) return;
  running.clear();
  tell();
}

/** The rows being renamed and what each shows now, following the animation frame by frame while any runs. */
export function useRenameAnimations(): ReadonlyMap<string, string> {
  const [shown, setShown] = useState<ReadonlyMap<string, string>>(new Map());
  useEffect(() => {
    let frame = 0;
    const tick = () => {
      frame = 0;
      const now = performance.now();
      const next = new Map<string, string>();
      for (const [id, a] of running) {
        const text = renameFrame(a.from, a.to, now - a.start);
        if (text === null) running.delete(id);
        else next.set(id, text);
      }
      setShown(next);
      if (running.size) frame = requestAnimationFrame(tick);
    };
    const start = () => {
      if (!frame) frame = requestAnimationFrame(tick);
    };
    listeners.add(start);
    if (running.size) start();
    return () => {
      listeners.delete(start);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);
  return shown;
}
