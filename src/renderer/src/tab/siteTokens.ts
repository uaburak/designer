import type { CSSProperties } from "react";

/**
 * The site's own colours (burakkoc.net's globals.css), light and dark — for
 * what is shown as the site shows it (a draft's preview, the CV's): the app's
 * chrome keeps Figma's.
 */
export const SITE_TOKENS: Record<"light" | "dark", CSSProperties> = {
  light: { "--bg-1": "#ffffff", "--bg-2": "#fefefe", "--bg-3": "#fcfcfc", "--bg-4": "#f2f2f2", "--bg-5": "#e4e4e4", "--bg-code": "#fcfcfc", "--text-title": "#1a1a1a", "--text-p": "#2a2a2a", "--text-subtitle": "#6e6e6e", "--border": "#f2f2f2", "--border-hover": "#e4e4e4" } as CSSProperties,
  dark: { "--bg-1": "#000000", "--bg-2": "#0a0a0a", "--bg-3": "#0f0f0f", "--bg-4": "#1e1e1e", "--bg-5": "#343434", "--bg-code": "#0f0f0f", "--text-title": "#f2f2f2", "--text-p": "#e5e5e5", "--text-subtitle": "#a0a0a0", "--border": "#1e1e1e", "--border-hover": "#343434" } as CSSProperties,
};
