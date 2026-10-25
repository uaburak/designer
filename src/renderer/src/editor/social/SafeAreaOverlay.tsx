/**
 * Safe areas (docs/social.md §6.4, §30): over each post its safe area's bands (`safeAreaOf`: the platform's UI over
 * stories and reels, what Instagram's profile grid crops, the margin every post keeps), so nothing important is put
 * there — drawn by the engine inside the post as a layout guide's columns are (a flat fill, no band over another), so
 * they move with it wherever it goes (dragged, sliding through its grid). Their opacity (20 % by default) and colour are
 * the toolbar button's right-click (`safeAreaLook`); the colour "auto" is red, unless the design under the bands is red
 * itself: then blue, else purple (read off the post's render a moment after it changes). On by default in Social,
 * in the grid view and the asset view; the toolbar's Safe areas (`social.toggle-safe-areas`) turns them off. Canvas
 * chrome: never a layer of the document, never in an export.
 */
import { useEffect, useLayoutEffect, useMemo, useState, type RefObject } from "react";
import { parseCssColor } from "@/ds";
import type { Guid, Pixels } from "@/engine/codec";
import { safeAreaOf } from "@shared/social/formats";
import type { Insets } from "@shared/social/types";
import { useEditor, type EditorController } from "../controller";
import { useUI } from "../hooks";
import { useSocialBoard, type PostRow } from "./socialState";
import { useFocusedPost } from "./focus";
import { safeAreaLook, type SafeAreaColor } from "./SocialMode";

/**
 * Places a layer's children (each `data-post` names its post's row) from the camera now and on every camera change;
 * `zooming` is set on the layer while the zoom moves. `place` positions one child at the camera.
 */
export function useCameraPlacement(ed: EditorController, layer: RefObject<HTMLElement | null>, rows: readonly PostRow[], place: (el: HTMLElement, row: PostRow, cam: { x: number; y: number; zoom: number }) => void): void {
  useLayoutEffect(() => {
    const run = () => {
      const el = layer.current;
      if (!el) return;
      const cam = ed.store.camera;
      for (const child of Array.from(el.children) as HTMLElement[]) {
        const row = rows.find((r) => r.id === child.dataset.post);
        if (row) place(child, row, cam);
      }
    };
    run();
    return ed.store.subscribe("camera", run);
  }, [ed, layer, rows, place]);
}

/** A post's safe area's bands, in its own px. */
export function bandsOf(row: PostRow): Insets {
  return safeAreaOf(row.data.formatId, row.width, row.height).insets;
}

/** The hatch's colours, in the order tried: one the design under the bands isn't of */
export type BandTone = "red" | "blue" | "purple";
const TONES: readonly { tone: BandTone; hue: (h: number) => boolean }[] = [
  { tone: "red", hue: (h) => h < 25 || h >= 335 },
  { tone: "blue", hue: (h) => h >= 190 && h < 240 },
  { tone: "purple", hue: (h) => h >= 255 && h < 300 },
];
/** A tone is taken when less of the bands' pixels than this are of its hue (vivid ones) */
const TONE_SHARE = 0.12;

/**
 * The hatch's tone for a post from its render (`px`, the post's size `size` in post px): the first of red, blue and
 * purple that under a tenth of the bands' vivid-enough pixels are of; else the rarest.
 */
export function bandTone(px: Pixels, size: { width: number; height: number }, bands: Insets): BandTone {
  const kx = px.width / Math.max(1, size.width);
  const ky = px.height / Math.max(1, size.height);
  const counts = TONES.map(() => 0);
  let total = 0;
  for (let y = 0; y < px.height; y++)
    for (let x = 0; x < px.width; x++) {
      const inBand = x < bands.left * kx || x >= px.width - bands.right * kx || y < bands.top * ky || y >= px.height - bands.bottom * ky;
      if (!inBand) continue;
      const i = (y * px.width + x) * 4;
      const [r, g, b] = [px.pixels[i], px.pixels[i + 1], px.pixels[i + 2]].map((v) => v / 255);
      total++;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      // Vivid: saturated and not dark
      if (max < 0.3 || max - min < 0.35 * max) continue;
      const d = max - min;
      const h = (max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60;
      const hue = (h + 360) % 360;
      TONES.forEach((t, k) => t.hue(hue) && counts[k]++);
    }
  if (!total) return "red";
  const free = TONES.findIndex((_, k) => counts[k] / total < TONE_SHARE);
  if (free >= 0) return TONES[free].tone;
  return TONES[counts.indexOf(Math.min(...counts))].tone;
}

/** Each post's hatch tone, read off its render a moment after the board last changed (not on every keystroke) */
function useBandTones(ed: EditorController, rows: readonly PostRow[]): ReadonlyMap<Guid, BandTone> {
  const [tones, setTones] = useState<ReadonlyMap<Guid, BandTone>>(new Map());
  useEffect(() => {
    if (!rows.length) return;
    const timer = setTimeout(() => {
      if (ed.engine.destroyed) return;
      const next = new Map<Guid, BandTone>();
      for (const row of rows) {
        let px: Pixels | null = null;
        try {
          px = ed.engine.renderNodeThumbnailPixels({ node: row.id, maxSize: TONE_RENDER });
        } catch {
          px = null;
        }
        next.set(row.id, px ? bandTone(px, row, bandsOf(row)) : "red");
      }
      setTones((was) => ([...next].every(([id, tone]) => was.get(id) === tone) && was.size === next.size ? was : next));
    }, TONE_DELAY);
    return () => clearTimeout(timer);
  }, [ed, rows]);
  return tones;
}

/** The render the tone is read from (its long side, px) and how long after a change */
const TONE_RENDER = 64;
const TONE_DELAY = 300;

/** The colours' tokens */
const TONE_TOKEN: Record<SafeAreaColor | BandTone, string> = {
  auto: "--figma-color-bg-danger",
  red: "--figma-color-bg-danger",
  blue: "--figma-color-bg-brand",
  purple: "--figma-color-bg-component",
  yellow: "--figma-color-bg-warning",
  green: "--figma-color-bg-success",
};

/** A colour's token as RGBA at `alpha` (red when the token can't be read) */
export function safeAreaColor(color: SafeAreaColor | BandTone, alpha: number): { r: number; g: number; b: number; a: number } {
  const raw = typeof getComputedStyle === "function" ? getComputedStyle(document.documentElement).getPropertyValue(TONE_TOKEN[color]).trim() : "";
  const c = parseCssColor(raw) ?? { r: 1, g: 0, b: 0, a: 1 };
  return { r: c.r, g: c.g, b: c.b, a: alpha };
}

const NO_ROWS: readonly PostRow[] = [];

export function SafeAreaOverlay() {
  const ed = useEditor();
  const on = useUI((s) => s.socialSafeAreas !== false);
  const board = useSocialBoard(ed);
  // In the asset view (a Social file's single post, docs/social.md §20) only that post is drawn: only its bands; in
  // the grid view every post's (§30).
  const focus = useFocusedPost(ed);
  const rows = useMemo(() => (on ? board.posts.filter((p) => !focus || p.id === focus) : []), [on, board, focus]);
  // Their look (the toolbar button's right-click): a colour of its own, or each post's tone read off its design
  const opacity = useUI((s) => safeAreaLook(s).opacity);
  const color = useUI((s) => safeAreaLook(s).color);
  const tones = useBandTones(ed, color === "auto" ? rows : NO_ROWS);
  useEffect(() => {
    if (ed.engine.destroyed) return;
    ed.engine.setSafeAreas(rows.map((p) => ({ id: p.id, insets: bandsOf(p), color: safeAreaColor(color === "auto" ? (tones.get(p.id) ?? "red") : color, opacity) })));
  }, [ed, rows, tones, color, opacity]);
  // Gone with Social (or the editor)
  useEffect(() => () => void (!ed.engine.destroyed && ed.engine.setSafeAreas([])), [ed]);
  return null;
}
