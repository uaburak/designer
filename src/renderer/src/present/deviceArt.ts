/**
 * Device frames as pictures of the real devices (Wecra's): Apple's product bezels, prepared by
 * scripts/device-frames.mjs into public/device-frames/ (manifest.json: per preset and model, the picture, its size and
 * its screen — the transparent hole — in its pixels). The player leaves room for the picture around the screen
 * (presentSetOptions frameArt) and the page lays it over the canvas, the screen showing through. A preset without a
 * picture (Android, Surface, Desktop, iPhone SE), or no manifest (the script not run), keeps the drawn frame.
 */
import type { PresentState } from "@/engine/Engine";

export interface DeviceArt {
  /** The picture's URL (absolute: a pop-out window's document has no base of its own) */
  url: string;
  /** Its size and its screen's box (picture px, portrait as drawn) and the screen's corner radius */
  w: number;
  h: number;
  hole: { x: number; y: number; w: number; h: number };
  radius: number;
}

interface Manifest {
  frames: Record<string, Record<string, Omit<DeviceArt, "url"> & { file: string }>>;
}

let manifest: Promise<Manifest | null> | null = null;
function loadManifest(): Promise<Manifest | null> {
  manifest ??= fetch(new URL("device-frames/manifest.json", document.baseURI))
    .then((r) => (r.ok ? (r.json() as Promise<Manifest>) : null))
    .catch(() => null);
  return manifest;
}

/**
 * The picture for a presetIdentifier (`<DEVICE>` or `<DEVICE>_<MODEL>`, Figma's own with "APPLE_" before it): the
 * longest preset it starts with, its model (else the first), as the engine's findDevice reads it.
 */
export function artOf(m: Manifest, preset: string): DeviceArt | null {
  const id = preset.startsWith("APPLE_") && !m.frames[preset] ? preset.slice(6) : preset;
  let best = "";
  for (const key of Object.keys(m.frames)) if ((id === key || id.startsWith(`${key}_`)) && key.length > best.length) best = key;
  if (!best) return null;
  const models = m.frames[best]!;
  const pick = models[id.slice(best.length + 1)] ?? Object.values(models)[0];
  if (!pick) return null;
  const { file, ...rest } = pick;
  return { ...rest, url: new URL(`device-frames/${encodeURIComponent(file)}`, document.baseURI).href };
}

export async function deviceArt(preset: string | undefined): Promise<DeviceArt | null> {
  if (!preset) return null;
  const m = await loadManifest();
  return m ? artOf(m, preset) : null;
}

/** The room the player leaves around the screen: fractions of the portrait screen (presentSetOptions frameArt). */
export function artInsets(a: DeviceArt): { left: number; top: number; right: number; bottom: number; radius: number } {
  const { hole } = a;
  return {
    left: hole.x / hole.w,
    top: hole.y / hole.h,
    right: (a.w - hole.x - hole.w) / hole.w,
    bottom: (a.h - hole.y - hole.h) / hole.h,
    radius: a.radius / hole.w,
  };
}

/**
 * The picture's place over the canvas (CSS px from the canvas's top-left): its size and a transform that puts its
 * screen on the player's screen rect — turned a quarter left when the device is (the landscape screen of a portrait
 * picture: the device's top goes left, as the engine turns its drawn frame).
 */
export function artPlacement(a: DeviceArt, screen: NonNullable<PresentState["screenRect"]>): { width: number; height: number; transform: string } {
  const rotated = a.hole.w > a.hole.h !== screen.w > screen.h;
  const sx = (rotated ? screen.h : screen.w) / a.hole.w;
  const sy = (rotated ? screen.w : screen.h) / a.hole.h;
  const hx = a.hole.x * sx, hy = a.hole.y * sy, hw = a.hole.w * sx;
  const width = a.w * sx, height = a.h * sy;
  // rotate(-90deg) about the top-left takes (x, y) to (y, −x): the hole's left edge becomes its bottom.
  const transform = rotated ? `translate(${screen.x - hy}px, ${screen.y + hx + hw}px) rotate(-90deg)` : `translate(${screen.x - hx}px, ${screen.y - hy}px)`;
  return { width, height, transform };
}
