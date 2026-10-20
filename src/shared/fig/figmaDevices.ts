/**
 * Prototype device presets between Wecra's ids (`<DEVICE>[_<MODEL>]`, editor/model/prototype.ts DEVICE_PRESETS /
 * DEVICE_MODELS) and Figma's own `presetIdentifier`s (`<VENDOR>_<DEVICE>_<COLOUR>`, read from Figma's web app bundle,
 * 2026-10-20, e.g. "APPLE_IPHONE_16_PRO_MAX_BLACKTITANIUM" — the one in the owner's "Front End Demo Project 2.fig").
 * Figma's presentation crashes on an identifier it doesn't know ("DESKTOP OS could not be inferred", then "Cannot read
 * properties of undefined (reading 'deviceName')"): an export writes Figma's, or no device where Figma has none.
 */

/** Wecra's device → Figma's identifier prefix and its colours (Wecra's model → Figma's), the first the default. */
const DEVICES: Record<string, { figma: string; models: [string, string][] }> = {
  IPHONE_16: { figma: "APPLE_IPHONE_16", models: [["BLACK", "BLACK"], ["WHITE", "WHITE"], ["PINK", "PINK"], ["TEAL", "TEAL"], ["ULTRAMARINE", "ULTRAMARINE"]] },
  IPHONE_16_PLUS: { figma: "APPLE_IPHONE_16_PLUS", models: [["BLACK", "BLACK"], ["WHITE", "WHITE"], ["PINK", "PINK"], ["TEAL", "TEAL"], ["ULTRAMARINE", "ULTRAMARINE"]] },
  IPHONE_16_PRO: { figma: "APPLE_IPHONE_16_PRO", models: [["BLACK_TITANIUM", "BLACKTITANIUM"], ["WHITE_TITANIUM", "WHITETITANIUM"], ["NATURAL_TITANIUM", "NATURALTITANIUM"], ["DESERT_TITANIUM", "DESERTTITANIUM"]] },
  IPHONE_16_PRO_MAX: { figma: "APPLE_IPHONE_16_PRO_MAX", models: [["BLACK_TITANIUM", "BLACKTITANIUM"], ["WHITE_TITANIUM", "WHITETITANIUM"], ["NATURAL_TITANIUM", "NATURALTITANIUM"], ["DESERT_TITANIUM", "DESERTTITANIUM"]] },
  IPHONE_15: { figma: "APPLE_IPHONE_15", models: [["BLACK", "BLACK"], ["BLUE", "BLUE"], ["GREEN", "GREEN"], ["YELLOW", "YELLOW"], ["PINK", "PINK"]] },
  IPHONE_15_PRO: { figma: "APPLE_IPHONE_15_PRO", models: [["BLACK_TITANIUM", "BLACKTITANIUM"], ["WHITE_TITANIUM", "WHITETITANIUM"], ["BLUE_TITANIUM", "BLUETITANIUM"], ["NATURAL_TITANIUM", "NATURALTITANIUM"]] },
  IPHONE_15_PRO_MAX: { figma: "APPLE_IPHONE_15_PRO_MAX", models: [["BLACK_TITANIUM", "BLACKTITANIUM"], ["WHITE_TITANIUM", "WHITETITANIUM"], ["BLUE_TITANIUM", "BLUETITANIUM"], ["NATURAL_TITANIUM", "NATURALTITANIUM"]] },
  IPHONE_SE: { figma: "APPLE_IPHONE_SE", models: [["MIDNIGHT", "SPACE_GREY"], ["STARLIGHT", "SILVER"], ["PRODUCT_RED", "ROSE_GOLD"]] },
  ANDROID_COMPACT: { figma: "ANDROID_COMPACT", models: [["BLACK", "BLACK"]] },
  ANDROID_MEDIUM: { figma: "ANDROID_MEDIUM", models: [["BLACK", "BLACK"]] },
  IPAD_MINI: { figma: "APPLE_IPAD_MINI_83", models: [["SPACE_GRAY", "SPACE_GREY"]] },
  IPAD_PRO_11: { figma: "APPLE_IPAD_PRO_11", models: [["SPACE_BLACK", "SILVER"], ["SILVER", "SILVER"]] },
  IPAD_PRO_13: { figma: "APPLE_IPAD_PRO_129", models: [["SPACE_BLACK", "SILVER"], ["SILVER", "SILVER"]] },
  SURFACE_PRO_8: { figma: "MICROSOFT_SURFACE_PRO_8", models: [["PLATINUM", "PLATNUM"], ["GRAPHITE", "GRAPHITE"]] },
  MACBOOK_AIR: { figma: "APPLE_MACBOOK_AIR_M2", models: [["MIDNIGHT", "MIDNIGHT"], ["STARLIGHT", "STARLIGHT"], ["SPACE_GRAY", "SPACE_GREY"], ["SILVER", "SILVER"]] },
  MACBOOK_PRO_14: { figma: "APPLE_MACBOOK_PRO_14IN", models: [["SPACE_BLACK", "SPACE_GREY"], ["SILVER", "SILVER"]] },
  MACBOOK_PRO_16: { figma: "APPLE_MACBOOK_PRO_16IN", models: [["SPACE_BLACK", "SPACE_GREY"], ["SILVER", "SILVER"]] },
};

/** Wecra's presetIdentifier as Figma's, or null when Figma has no such device (Desktop, Pixel 8, Galaxy S24, Watch …). */
export function figmaPresetIdentifier(id: string | undefined): string | null {
  if (!id) return null;
  if (isFigmaPresetIdentifier(id)) return id;
  let best: string | null = null;
  for (const k of Object.keys(DEVICES)) if ((id === k || id.startsWith(`${k}_`)) && (!best || k.length > best.length)) best = k;
  if (!best) return null;
  const d = DEVICES[best];
  const model = id.slice(best.length + 1);
  const m = d.models.find(([ours]) => ours === model) ?? d.models[0];
  return `${d.figma}_${m[1]}`;
}

/** Already one of Figma's (a `.fig` import keeps them): a vendor prefix Wecra's own ids never have. */
export function isFigmaPresetIdentifier(id: string): boolean {
  return /^(APPLE|GOOGLE|MICROSOFT|SAMSUNG)_/.test(id) || /^ANDROID_(COMPACT|MEDIUM|EXPANDED)_/.test(id);
}

/** A prototype device as Figma's presentation reads it: PRESET only with one of Figma's identifiers, else no device. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the kiwi PrototypeDevice record
export function figmaPrototypeDevice(d: any): any {
  if (!d || d.type !== "PRESET") return d;
  const id = figmaPresetIdentifier(d.presetIdentifier);
  return id ? { ...d, presetIdentifier: id } : { ...d, type: "NONE", presetIdentifier: "" };
}
