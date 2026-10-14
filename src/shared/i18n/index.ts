/**
 * The UI's languages (Settings › Account › Language): English is the source — every string in code is its own
 * English text, the key — and Turkish is a dictionary from that English to Turkish (src/shared/i18n/tr). A key the
 * dictionary lacks shows in English, so nothing ever shows blank.
 *
 * - `t("Share")`, `t("Moved {name}", { name })`: the current language's text, `{name}` filled in.
 * - `tp(n, "{n} member", "{n} members")`: the English form a count picks (n === 1), translated, `{n}` filled in.
 * - `tx("seat", "View")`: a homonym, looked up as `"seat|View"` first.
 * - `setLocale` / `onLocaleChange`: main (src/main/locale.ts) and each view (renderer `i18n/useT.ts`) set it; the
 *   renderer re-renders through `useT()`.
 *
 * Main and every view hold the language themselves (no IPC per string): main keeps the choice in settings.json and
 * tells every view (`locale:changed`), as it does the theme.
 */

export type Locale = "en" | "tr";

export const LOCALES: readonly { id: Locale; label: string }[] = [
  { id: "en", label: "English" },
  { id: "tr", label: "Türkçe" },
];

export const parseLocale = (value: unknown): Locale => (value === "tr" ? "tr" : "en");

export type Dictionary = Readonly<Record<string, string>>;
export type Vars = Readonly<Record<string, string | number>>;

const dictionaries = new Map<Locale, Dictionary>();
let locale: Locale = "en";
let active: Dictionary | null = null;
const listeners = new Set<(l: Locale) => void>();

/** A language's dictionary (English needs none). */
export function registerDictionary(l: Locale, dict: Dictionary): void {
  dictionaries.set(l, dict);
  if (l === locale) active = dict;
}

export const hasDictionary = (l: Locale): boolean => l === "en" || dictionaries.has(l);

export const getLocale = (): Locale => locale;

/** Switch the language; listeners hear it only when it changed. */
export function setLocale(next: Locale): void {
  const l = parseLocale(next);
  active = l === "en" ? null : (dictionaries.get(l) ?? null);
  if (l === locale) return;
  locale = l;
  for (const cb of [...listeners]) cb(l);
}

export function onLocaleChange(cb: (l: Locale) => void): () => void {
  listeners.add(cb);
  return () => void listeners.delete(cb);
}

const fill = (text: string, vars?: Vars): string => (vars ? text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : text);

/** The current language's text for an English string (itself when there is no translation), `{var}`s filled in. */
export function t(english: string, vars?: Vars): string {
  return fill((active && active[english]) || english, vars);
}

/**
 * An English word that means different things in different places ("Zoom" the window vs the canvas, "View" the seat vs
 * the menu): the dictionary's `"<context>|<english>"` entry when there is one, else as `t`.
 */
export function tx(context: string, english: string, vars?: Vars): string {
  return fill((active && (active[`${context}|${english}`] || active[english])) || english, vars);
}

/** A count's text: the English singular when n is 1, else the plural — translated, `{n}` (and `vars`) filled in. */
export function tp(n: number, one: string, other: string, vars?: Vars): string {
  return t(n === 1 ? one : other, { n, ...vars });
}

/** BCP 47 tag for Intl / toLocaleString in the current language. */
export const intlLocale = (): string => (locale === "tr" ? "tr-TR" : "en-US");
