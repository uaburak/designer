/**
 * Dev Mode's units (help.figma.com 15023202277399 "Use code snippets in Dev Mode"; docs/research/figma/R9-dev-mode.md):
 * each language has its own — CSS px or rem ("Relative to the root font size (e.g. 1rem = 16px by default)"), iOS pt
 * ("Resolution-independent points") or px ("Canvas pixels"), Android dp ("density-independent pixels"), sp
 * ("scale-independent pixels") or px ("Physical screen pixels") — and "Set unit scale…" sets the root font size (rem)
 * or the scale factor (pt / dp / sp ↔ px).
 *
 * The snippets are written in Figma's px as CSS px, SwiftUI points and Compose dp (text sizes in sp); these
 * functions rewrite their lengths into the chosen unit. Exactly which values Figma converts in native snippets is
 * unverified: here every length (frames, padding, spacing, radii, borders, font sizes) is, never colours or opacity.
 */
export type Language = "css" | "swiftui" | "compose";
export type Unit = "px" | "rem" | "pt" | "dp" | "sp";

export const UNITS: Record<Language, { value: Unit; label: string }[]> = {
  css: [
    { value: "px", label: "px" },
    { value: "rem", label: "rem" },
  ],
  swiftui: [
    { value: "pt", label: "pt" },
    { value: "px", label: "px" },
  ],
  compose: [
    { value: "dp", label: "dp" },
    { value: "sp", label: "sp" },
    { value: "px", label: "px" },
  ],
};

export const DEFAULT_UNIT: Record<Language, Unit> = { css: "px", swiftui: "pt", compose: "dp" };

export interface UnitSettings {
  /** The chosen unit per language */
  unit: Record<Language, Unit>;
  /** CSS: px per rem */
  rootFontSize: number;
  /** iOS / Android: px per pt / dp / sp */
  scale: number;
}

export const DEFAULT_UNITS: UnitSettings = { unit: { ...DEFAULT_UNIT }, rootFontSize: 16, scale: 1 };

const round = (v: number) => {
  const r = Math.round(v * 1000) / 1000;
  return Object.is(r, -0) ? "0" : String(r);
};

/** A CSS snippet's px lengths in the chosen unit. */
export function cssInUnit(code: string, s: UnitSettings): string {
  if (s.unit.css !== "rem") return code;
  const root = s.rootFontSize > 0 ? s.rootFontSize : 16;
  return code.replace(/(-?\d*\.?\d+)px\b/g, (_, n: string) => `${round(Number(n) / root)}rem`);
}

/** SwiftUI: points, or px (× the scale factor) — the lengths in frame / padding / spacing / radius / size / width. */
export function swiftUIInUnit(code: string, s: UnitSettings): string {
  if (s.unit.swiftui !== "px" || s.scale === 1) return code;
  const k = s.scale;
  return code
    .replace(/\b(width|height|minWidth|maxWidth|minHeight|maxHeight|spacing|size|lineWidth|radius|cornerRadius)(:\s*)(-?\d*\.?\d+)/g, (_, key: string, sep: string, n: string) => `${key}${sep}${round(Number(n) * k)}`)
    .replace(/\.(padding|cornerRadius)\(((?:\.[a-z]+,\s*)?)(-?\d*\.?\d+)\)/g, (_, fn: string, edge: string, n: string) => `.${fn}(${edge}${round(Number(n) * k)})`);
}

/** Compose: dp lengths and sp text — or all sp, or px (× the scale factor). */
export function composeInUnit(code: string, s: UnitSettings): string {
  const u = s.unit.compose;
  if (u === "dp") return code;
  if (u === "sp") return code.replace(/(-?\d*\.?\d+)\.dp\b/g, "$1.sp");
  return code.replace(/(-?\d*\.?\d+)\.(dp|sp)\b/g, (_, n: string) => `${round(Number(n) * s.scale)}.px`);
}

/** A length as the List view shows it (px in, the chosen unit out). */
export function lengthIn(px: number, language: Language, s: UnitSettings): string {
  const u = s.unit[language];
  if (u === "rem") return `${round(px / (s.rootFontSize || 16))}rem`;
  if (u === "px") return `${round(language === "css" ? px : px * s.scale)}px`;
  return `${round(px)}${u}`;
}

/** The unit settings kept between visits (this browser). */
const KEY = "designer-viewer-units";
export function storedUnits(): UnitSettings {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<UnitSettings> | null;
    if (!v) return DEFAULT_UNITS;
    const unit = { ...DEFAULT_UNIT, ...(v.unit ?? {}) };
    for (const l of Object.keys(UNITS) as Language[]) if (!UNITS[l].some((x) => x.value === unit[l])) unit[l] = DEFAULT_UNIT[l];
    return { unit, rootFontSize: Number(v.rootFontSize) > 0 ? Number(v.rootFontSize) : 16, scale: Number(v.scale) > 0 ? Number(v.scale) : 1 };
  } catch {
    return DEFAULT_UNITS;
  }
}
export function storeUnits(s: UnitSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // kept for this visit only
  }
}
