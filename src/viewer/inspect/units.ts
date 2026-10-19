/**
 * Dev Mode's units (help.figma.com 15023202277399 "Use code snippets in Dev Mode"; docs/research/atlas/14-dev-mode.md
 * §5.2, §6, §8, §10): each language has px and its scaled unit — rem (CSS), pt (iOS), dp (Android; text in sp) — and
 * its own scale factor ("Set unit scale…"): CSS's is the rem root, iOS's and Android's are chosen from 3, 2, 1, ½, ⅓.
 *
 * - CSS: only the box, spacing, radius and text lengths turn into rem (never borders, shadows, blurs or transforms),
 *   each `Npx` as N / factor to 5 decimals, the `/* … *\/` comment of a line too; "Only apply rem on text" limits it
 *   to font-size, letter-spacing and line-height.
 * - SwiftUI / UIKit: the scaled unit divides every length by the factor (5 decimals); px leaves them.
 * - Compose / XML: lengths keep `.dp` and text `.sp` whatever the unit — scaling only changes the numbers.
 */
export type Language = "css" | "swiftui" | "uikit" | "compose" | "xml";
export type Unit = "px" | "rem" | "pt" | "dp";

export const UNITS: Record<Language, { value: Unit; label: string }[]> = {
  css: [
    { value: "px", label: "px" },
    { value: "rem", label: "rem" },
  ],
  swiftui: [
    { value: "px", label: "px" },
    { value: "pt", label: "pt" },
  ],
  uikit: [
    { value: "px", label: "px" },
    { value: "pt", label: "pt" },
  ],
  compose: [
    { value: "px", label: "px" },
    { value: "dp", label: "dp" },
  ],
  xml: [
    { value: "px", label: "px" },
    { value: "dp", label: "dp" },
  ],
};

/** The scaled unit of a language (the unit menu's "Use {unit}"). */
export const SCALED_UNIT: Record<Language, Unit> = { css: "rem", swiftui: "pt", uikit: "pt", compose: "dp", xml: "dp" };

export const DEFAULT_UNIT: Record<Language, Unit> = { css: "px", swiftui: "pt", uikit: "pt", compose: "dp", xml: "dp" };

/** The native languages' scale factors (the Unit scale select). */
export const NATIVE_SCALES: { value: number; label: string }[] = [
  { value: 3, label: "3" },
  { value: 2, label: "2" },
  { value: 1, label: "1" },
  { value: 1 / 2, label: "1/2" },
  { value: 1 / 3, label: "1/3" },
];

export interface UnitSettings {
  /** The chosen unit per language */
  unit: Record<Language, Unit>;
  /** The scale factor per language: CSS's rem root (px per rem), the px per pt / dp of iOS and Android */
  scale: Record<Language, number>;
  /** CSS: "Only apply rem on text" */
  remOnText: boolean;
}

/** The help's 1rem = 16px; Figma's own first value when rem is picked is unverified (atlas 14 §18 question 1). */
export const DEFAULT_UNITS: UnitSettings = { unit: { ...DEFAULT_UNIT }, scale: { css: 16, swiftui: 1, uikit: 1, compose: 1, xml: 1 }, remOnText: false };

const round = (v: number, digits = 3) => {
  const k = 10 ** digits;
  const r = Math.round(v * k) / k;
  return Object.is(r, -0) ? "0" : String(r);
};

/** The properties rem applies to (`tx`), and the ones "Only apply rem on text" keeps. */
const REM = new Set(["width", "height", "left", "top", "right", "bottom", "padding", "padding-left", "padding-right", "padding-bottom", "padding-top", "gap", "font-size", "letter-spacing", "line-height", "min-width", "max-width", "min-height", "max-height", "row-gap", "border-radius"]);
const REM_TEXT = new Set(["font-size", "letter-spacing", "line-height"]);

const factor = (s: UnitSettings, l: Language) => (s.scale[l] > 0 ? s.scale[l] : 1);

/** A CSS snippet's lengths in the chosen unit: each converted line's `Npx` as N / factor rem. */
export function cssInUnit(code: string, s: UnitSettings): string {
  if (s.unit.css !== "rem") return code;
  const k = factor(s, "css");
  const only = s.remOnText ? REM_TEXT : REM;
  return code
    .split("\n")
    .map((line) => {
      const property = /^\s*([-a-z]+):/.exec(line)?.[1];
      return property && only.has(property) ? line.replace(/(-?\d*\.?\d+)px\b/g, (_, n: string) => `${round(Number(n) / k, 5)}rem`) : line;
    })
    .join("\n");
}

/** A single CSS value (the List view's) in the chosen unit. */
export function cssValueInUnit(property: string, value: string, s: UnitSettings): string {
  return cssInUnit(`${property}: ${value}`, s).slice(property.length + 2);
}

const SWIFT_LENGTH = /\b(width|height|minWidth|maxWidth|minHeight|maxHeight|spacing|size|lineWidth|radius|cornerRadius|x|y|by|kerning|equalToConstant|constant)(:\s*)(-?\d*\.?\d+)/g;

/** SwiftUI / UIKit: pt divides every length by the factor; px leaves them. */
export function swiftUIInUnit(code: string, s: UnitSettings, language: "swiftui" | "uikit" = "swiftui"): string {
  const k = factor(s, language);
  if (s.unit[language] === "px" || k === 1) return code;
  return code
    .split("\n")
    .map((line) =>
      // A gradient's unit points are fractions of the box, not lengths.
      line.includes("UnitPoint")
        ? line
        : line
            .replace(SWIFT_LENGTH, (_, key: string, sep: string, n: string) => `${key}${sep}${round(Number(n) / k, 5)}`)
            .replace(/\.(padding|cornerRadius|kerning|blur)\(((?:\.[a-z]+,\s*)?)(-?\d*\.?\d+)\)/g, (_, fn: string, edge: string, n: string) => `.${fn}(${edge}${round(Number(n) / k, 5)})`),
    )
    .join("\n");
}

/** Compose / XML: dp keeps `.dp` / `.sp` (or `dp` / `sp`) and divides the numbers by the factor; px leaves them. */
export function composeInUnit(code: string, s: UnitSettings, language: "compose" | "xml" = "compose"): string {
  const k = factor(s, language);
  if (s.unit[language] === "px" || k === 1) return code;
  return code.replace(/(-?\d*\.?\d+)(\.?)(dp|sp)\b/g, (_, n: string, dot: string, u: string) => `${round(Number(n) / k, 5)}${dot}${u}`);
}

/** A length as the List view shows it (px in, the chosen unit out). */
export function lengthIn(px: number, language: Language, s: UnitSettings): string {
  const u = s.unit[language];
  if (u === "px") return `${round(px)}px`;
  return `${round(px / factor(s, language), language === "css" ? 5 : 3)}${u}`;
}

/** The unit settings kept between visits (this browser); the older shape (one rem root, one scale) is read too. */
const KEY = "designer-viewer-units";
export function storedUnits(): UnitSettings {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null") as (Partial<UnitSettings> & { rootFontSize?: number; scale?: number | Partial<Record<Language, number>> }) | null;
    if (!v) return DEFAULT_UNITS;
    const unit = { ...DEFAULT_UNIT, ...(v.unit ?? {}) };
    for (const l of Object.keys(UNITS) as Language[]) if (!UNITS[l].some((x) => x.value === unit[l])) unit[l] = DEFAULT_UNIT[l];
    const scale = { ...DEFAULT_UNITS.scale };
    if (typeof v.scale === "object" && v.scale) for (const l of Object.keys(scale) as Language[]) if (Number(v.scale[l]) > 0) scale[l] = Number(v.scale[l]);
    if (Number(v.rootFontSize) > 0) scale.css = Number(v.rootFontSize);
    return { unit, scale, remOnText: v.remOnText === true };
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
