/**
 * Safe areas (docs/social.md §6.4, §30): over each post its safe area's bands (`safeAreaOf`: the platform's UI over
 * stories and reels, what Instagram's profile grid crops, the margin every post keeps) — hatched with a dashed edge, so
 * nothing important is put there. Red, unless the design under the bands is red itself: then blue, else purple (read off
 * the post's render a moment after it changes). DOM over the canvas like the agents' image placeholders: placed
 * straight from the camera (no React render per camera change), a band below 8 px on screen left out. On by default in
 * Social, in the grid view and the asset view; the toolbar's Safe areas (`social.toggle-safe-areas`) turns them off.
 * Canvas chrome: never a layer of the document.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { Guid, Pixels } from "@/engine/codec";
import { safeAreaOf } from "@shared/social/formats";
import type { Insets } from "@shared/social/types";
import { useEditor, type EditorController } from "../controller";
import { useUI } from "../hooks";
import { useSocialBoard, type PostRow } from "./socialState";
import { useFocusedPost } from "./focus";
import styles from "./SafeAreaOverlay.module.css";

/** A band thinner than this on screen (px) isn't drawn */
const MIN_BAND = 8;

const SIDES = ["top", "right", "bottom", "left"] as const;

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

function placeBands(el: HTMLElement, row: PostRow, cam: { x: number; y: number; zoom: number }): void {
  const z = cam.zoom;
  el.style.transform = `translate(${row.x * z + cam.x}px, ${row.y * z + cam.y}px)`;
  el.style.width = `${row.width * z}px`;
  el.style.height = `${row.height * z}px`;
  const bands = bandsOf(row);
  for (const band of Array.from(el.children) as HTMLElement[]) {
    const side = band.dataset.band as (typeof SIDES)[number];
    const px = (bands?.[side] ?? 0) * z;
    band.hidden = px < MIN_BAND;
    band.style.setProperty(side === "top" || side === "bottom" ? "height" : "width", `${px}px`);
    // The side bands run between the top and bottom ones.
    if (side === "left" || side === "right") {
      band.style.top = `${(bands?.top ?? 0) * z}px`;
      band.style.bottom = `${(bands?.bottom ?? 0) * z}px`;
    }
  }
}

export function SafeAreaOverlay() {
  const ed = useEditor();
  const on = useUI((s) => s.socialSafeAreas !== false);
  const board = useSocialBoard(ed);
  // In the asset view (a Social file's single post, docs/social.md §20) only that post is drawn: only its bands; in
  // the grid view every post's (§30).
  const focus = useFocusedPost(ed);
  const rows = useMemo(() => (on ? board.posts.filter((p) => !focus || p.id === focus) : []), [on, board, focus]);
  const tones = useBandTones(ed, rows);
  const layer = useRef<HTMLDivElement>(null);
  useCameraPlacement(ed, layer, rows, placeBands);
  if (!rows.length) return null;
  return (
    <div ref={layer} className={styles.layer} aria-hidden data-safe-areas="">
      {rows.map((p) => (
        <div key={p.id} className={styles.post} data-post={p.id} data-tone={tones.get(p.id) ?? "red"}>
          {SIDES.map((side) => (
            <div key={side} className={styles.band} data-band={side} />
          ))}
        </div>
      ))}
    </div>
  );
}
