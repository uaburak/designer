/**
 * The colour format (Figma's `colorFormat` user preference, atlas 07 §5.3): Hex, RGB, CSS, HSL or HSB — one choice
 * shared by every colour picker and the eyedropper's card, kept per machine (localStorage, like Nudge amount). The
 * eyedropper's Tab cycles it, skipping CSS (Figma also skips UIColor and CMYK, which Wecra doesn't offer).
 */
import { useSyncExternalStore } from "react";
import { rgbToHex, rgbToHsl, rgbToHsv, type ColorModel, type RGBA } from "@/ds";

const KEY = "designer.colorFormat";
const FORMATS: readonly ColorModel[] = ["hex", "rgb", "css", "hsl", "hsb"];
const listeners = new Set<() => void>();
let current: ColorModel | null = null;

function load(): ColorModel {
  try {
    const v = typeof localStorage !== "undefined" ? localStorage.getItem(KEY) : null;
    return FORMATS.includes(v as ColorModel) ? (v as ColorModel) : "hex";
  } catch {
    return "hex";
  }
}

export function colorFormat(): ColorModel {
  current ??= load();
  return current;
}

export function setColorFormat(format: ColorModel): void {
  if (format === colorFormat()) return;
  current = format;
  try {
    localStorage.setItem(KEY, format);
  } catch {
    // no storage (a test, a private window): this session only
  }
  for (const cb of [...listeners]) cb();
}

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => void listeners.delete(cb);
};

/** The colour format and its setter, for a picker's `colorModel` / `onColorModelChange`. */
export function useColorFormat(): [ColorModel, (format: ColorModel) => void] {
  return [useSyncExternalStore(subscribe, colorFormat), setColorFormat];
}

/** The eyedropper's Tab: the next format, CSS skipped. */
export function nextEyedropperFormat(format: ColorModel): ColorModel {
  const order = FORMATS.filter((f) => f !== "css");
  return order[(order.indexOf(format === "css" ? "rgb" : format) + 1) % order.length];
}

/** A colour as text in a format (the eyedropper's first row): "#0C8CE9", "12, 140, 233", "205°, 90%, 48%"… */
export function formatColor(c: Pick<RGBA, "r" | "g" | "b">, format: ColorModel): string {
  const byte = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255);
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  switch (format) {
    case "rgb":
      return `${byte(c.r)}, ${byte(c.g)}, ${byte(c.b)}`;
    case "css":
      return `rgb(${byte(c.r)}, ${byte(c.g)}, ${byte(c.b)})`;
    case "hsl": {
      const v = rgbToHsl(c);
      return `${Math.round(v.h) % 360}°, ${pct(v.s)}, ${pct(v.l)}`;
    }
    case "hsb": {
      const v = rgbToHsv(c);
      return `${Math.round(v.h) % 360}°, ${pct(v.s)}, ${pct(v.v)}`;
    }
    default:
      return rgbToHex(c).toUpperCase();
  }
}
