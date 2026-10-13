// Stand-in for src/renderer/src/engine/webFonts.ts (vite.config.ts SHIMS). The real module is the web app's font
// source (its account, its server's Google Fonts catalog). The site's documents use Figma's Inter only, which the
// engine's fonts.ts serves itself (bundled), so there is no other source and nothing is fetched from anyone else.
export function webFontSource(): null {
  return null;
}
