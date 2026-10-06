import { createContext, useContext } from "react";
import type { DesignVariable, TextStyle, Typography, VariableKind } from "@/types/design";
import { cssValue } from "./designVariables";

/**
 * The site's text styles (see TextStyle): the starting ones — the typography
 * the site's texts already have, bound to the starting variables — and the
 * ones added in the editor. Each is a CSS rule on the texts using it
 * (`data-text-style`), inside `[data-design-scope]`.
 */

const style = (id: string, name: string, fontSize: string, fontWeight: string, lineHeight: string, color: string, letterSpacing?: number): TextStyle => ({
  id,
  name,
  fontSize: { alias: fontSize },
  fontWeight: { alias: fontWeight },
  lineHeight: { alias: lineHeight },
  color: { alias: color },
  ...(letterSpacing !== undefined ? { letterSpacing: { value: letterSpacing } } : {}),
});

/**
 * The typography the site's texts already have (the components' texts, see
 * starting library), as the first text styles — so nothing changes until
 * they are edited. Their names are paths ("Tipografi/Başlıklar/Başlık"): the
 * editor's Styles list groups them by these, as Figma's does.
 */
export const STARTING_TEXT_STYLES: TextStyle[] = [
  { ...style("section-title", "Tipografi/Başlıklar/Bölüm başlığı", "font-size-m", "weight-medium", "line-height-s", "text-title"), tag: "h2" },
  style("subtitle", "Tipografi/Başlıklar/Alt başlık", "font-size-m", "weight-regular", "line-height-m", "text-subtitle"),
  { ...style("heading", "Tipografi/Başlıklar/Başlık", "font-size-m", "weight-medium", "line-height-m", "text-title"), tag: "h3" },
  style("strong", "Tipografi/Başlıklar/Vurgulu", "font-size-m", "weight-medium", "line-height-m", "text-title"),
  { ...style("text", "Tipografi/Metin/Metin", "font-size-m", "weight-light", "line-height-l", "text-p"), tag: "p" },
  { ...style("body", "Tipografi/Metin/Gövde", "font-size-m", "weight-light", "line-height-m", "text-p"), tag: "p" },
  style("label", "Tipografi/Etiketler/Etiket", "font-size-s", "weight-regular", "line-height-s", "text-subtitle"),
  style("value", "Tipografi/Etiketler/Değer", "font-size-m", "weight-regular", "line-height-m", "text-title"),
  style("caption", "Tipografi/Etiketler/Açıklama", "font-size-s", "weight-light", "line-height-s", "text-subtitle"),
  style("metric", "Tipografi/Vurgu/Metrik", "font-size-xl", "weight-medium", "line-height-xl", "text-title", -0.56),
  { ...style("quote", "Tipografi/Vurgu/Alıntı", "font-size-l", "weight-regular", "line-height-xl", "text-title", -0.22), small: { fontSize: { value: 20 }, lineHeight: { value: 32 }, letterSpacing: { value: -0.2 } } },
  style("small", "Tipografi/Metin/Küçük", "font-size-s", "weight-regular", "line-height-s", "text-p"),
  style("small-strong", "Tipografi/Metin/Küçük vurgulu", "font-size-s", "weight-medium", "line-height-s", "text-title"),
  style("small-light", "Tipografi/Metin/Küçük ince", "font-size-s", "weight-light", "line-height-m", "text-p"),
  style("chip", "Tipografi/Etiketler/Çip", "font-size-xs", "weight-medium", "line-height-s", "text-p"),
  style("micro", "Tipografi/Etiketler/Mikro", "font-size-xs", "weight-regular", "line-height-s", "text-subtitle"),
  style("micro-light", "Tipografi/Etiketler/Mikro ince", "font-size-xs", "weight-light", "line-height-s", "text-subtitle"),
];

/** The site's text styles: the starting ones — as stored, when changed — in their place, then the added ones. */
export function withStartingTextStyles(stored: TextStyle[]): TextStyle[] {
  const byId = new Map(stored.map((s) => [s.id, s]));
  const starting = new Set(STARTING_TEXT_STYLES.map((s) => s.id));
  // A starting style stored under its old flat name ("Başlık") takes its grouped one; a name the user gave it stays.
  const leaf = (name: string) => name.slice(name.lastIndexOf("/") + 1);
  return [
    ...STARTING_TEXT_STYLES.map((s) => {
      const st = byId.get(s.id);
      // (A stored one without a tag of its own keeps the starting one's.)
      return st ? { ...(st.tag === undefined && s.tag ? { tag: s.tag } : {}), ...(st.name === leaf(s.name) ? { ...st, name: s.name } : st) } : s;
    }),
    ...stored.filter((s) => !starting.has(s.id)),
  ];
}

/** A new text style: the look of an ordinary text (the Metin style's, bound to the same variables). */
export function newTextStyle(id: string, name: string): TextStyle {
  const base = STARTING_TEXT_STYLES.find((s) => s.id === "text")!;
  return { ...base, id, name };
}

/** The kind of variable each typography value can be bound to. */
export const TYPOGRAPHY_KINDS: Record<keyof Typography, VariableKind> = {
  fontSize: "number",
  fontWeight: "weight",
  lineHeight: "number",
  color: "color",
  letterSpacing: "number",
};

const CSS_PROPERTY: Record<keyof Typography, string> = {
  fontSize: "font-size",
  fontWeight: "font-weight",
  lineHeight: "line-height",
  color: "color",
  letterSpacing: "letter-spacing",
};

/**
 * The text styles as CSS: each one's typography on the texts using it. Its
 * colour gives way to the editor's own while a text is being typed in.
 */
export function textStylesCss(styles: TextStyle[], variables: DesignVariable[]): string {
  const byId = new Map(variables.map((v) => [v.id, v]));
  return styles
    .map((textStyle) => {
      const at = `[data-design-scope] [data-text-style=${JSON.stringify(textStyle.id)}]`;
      const set = (key: keyof Typography) => {
        const value = textStyle[key] ? cssValue(textStyle[key], TYPOGRAPHY_KINDS[key], byId) : null;
        return value ? `${CSS_PROPERTY[key]}: ${value};` : "";
      };
      const small = (key: "fontSize" | "lineHeight" | "letterSpacing") => {
        const value = textStyle.small?.[key] ? cssValue(textStyle.small[key]!, "number", byId) : null;
        return value ? `${CSS_PROPERTY[key]}: ${value};` : "";
      };
      const phone = textStyle.small ? `\n@media (max-width: 639px) { ${at} { ${small("fontSize")} ${small("lineHeight")} ${small("letterSpacing")} } }` : "";
      return `${at} { ${set("fontSize")} ${set("fontWeight")} ${set("lineHeight")} ${set("letterSpacing")} }\n${at}:not([contenteditable]) { ${set("color")} }${phone}`;
    })
    .join("\n");
}

/** The site's text styles — the editor's working copy while editing. */
export const TextStylesContext = createContext<TextStyle[]>(STARTING_TEXT_STYLES);

export const useTextStyles = () => useContext(TextStylesContext);
