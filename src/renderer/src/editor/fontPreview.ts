/**
 * The font picker's rows in their own face (Figma's font previews): the chrome is DOM, so a row's name is drawn by
 * the browser in that family —
 * - an installed family: by its name (Chromium finds the computer's fonts itself);
 * - Figma's Inter: the bundled file, as a FontFace;
 * - a Google family: a tiny subset of its Regular holding just the name's letters (main fetches it through Google's
 *   css2 `text=`, `fonts:preview`), as a FontFace — a few KB, never the whole family.
 * Asked only for the rows on screen; at most a few previews load at once. While one loads the row shows a skeleton.
 */
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { BUNDLED_URLS, desktopFonts, type FontFamily } from "@/engine/fonts";

type State = { css: string } | { failed: true };

const done = new Map<string, State>();
const waiting = new Map<string, Set<() => void>>();
const queue: (() => Promise<void>)[] = [];
let running = 0;
const PARALLEL = 4;

function pump(): void {
  while (running < PARALLEL && queue.length) {
    const job = queue.shift()!;
    running++;
    void job().finally(() => {
      running--;
      pump();
    });
  }
}

let serial = 0;

async function loadFace(family: FontFamily): Promise<State> {
  if (family.source === "local") return { css: `"${family.family.replace(/"/g, '\\"')}"` };
  if (typeof FontFace === "undefined" || typeof document === "undefined") return { failed: true };
  const name = `__fontPreview${++serial}`;
  let source: ArrayBuffer | string;
  if (family.source === "bundled") {
    const url = BUNDLED_URLS[family.faces[0]?.id ?? ""];
    if (!url) return { failed: true };
    source = `url(${url})`;
  } else {
    const preview = desktopFonts()?.preview;
    if (!preview) return { failed: true };
    const bytes = await preview(family.family, family.family);
    source = (bytes instanceof Uint8Array ? bytes.slice().buffer : bytes) as ArrayBuffer;
  }
  const face = new FontFace(name, source);
  await face.load();
  document.fonts.add(face);
  return { css: `"${name}"` };
}

function request(family: FontFamily, key: string): void {
  queue.push(async () => {
    // Scrolled past before its turn: nothing to load (a row showing it again asks again).
    if (!waiting.get(key)?.size) {
      waiting.delete(key);
      return;
    }
    let state: State;
    try {
      state = await loadFace(family);
    } catch {
      state = { failed: true };
    }
    done.set(key, state);
    for (const cb of waiting.get(key) ?? []) cb();
    waiting.delete(key);
  });
  pump();
}

function watch(family: FontFamily, key: string, cb: () => void): () => void {
  if (done.has(key)) return () => {};
  let set = waiting.get(key);
  const first = !set;
  if (!set) waiting.set(key, (set = new Set()));
  set.add(cb);
  if (first) request(family, key);
  return () => {
    set.delete(cb);
  };
}

/**
 * The CSS font-family that draws `family`'s name in its own face: undefined while it loads, null when it can't
 * (the row then shows the name in the UI font).
 */
export function useFontPreview(family: FontFamily | undefined): string | null | undefined {
  const key = family ? `${family.source}\n${family.family}` : "";
  // The family object is new on every list read; its key is what counts.
  const latest = useRef(family);
  useEffect(() => {
    latest.current = family;
  });
  const subscribe = useCallback((cb: () => void) => (key && latest.current ? watch(latest.current, key, cb) : () => {}), [key]);
  const state = useSyncExternalStore(subscribe, () => (key ? done.get(key) : undefined));
  if (!family) return null;
  if (!state) return undefined;
  return "css" in state ? state.css : null;
}
