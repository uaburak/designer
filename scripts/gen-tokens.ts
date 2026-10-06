/**
 * The design system's generated artefacts, from src/renderer/src/ds/tokens.ts (docs/design-system.md §2.2):
 *
 *   src/renderer/src/ds/tokens.css                the custom properties, light and dark (renderTokensCss)
 *   src/renderer/public/boot.js                   only its "// <generated" block: the surfaces' backgrounds (renderBootSurfaces)
 *   engine/src/render/ChromePalette.generated.h   the canvas chrome palette and metrics for the engine (renderChromeHeader)
 *
 *   npm run tokens              write them
 *   npm run tokens -- --check   exit 1 if any is out of date (the DS tests run the same check)
 *
 * Run with vite-node (plain `node` cannot resolve the DS's extensionless imports).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { renderBootSurfaces, renderChromeHeader, renderTokensCss } from "../src/renderer/src/ds/tokensCss";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const TOKENS_CSS = join(root, "src/renderer/src/ds/tokens.css");
export const BOOT_JS = join(root, "src/renderer/public/boot.js");
export const CHROME_HEADER = join(root, "engine/src/render/ChromePalette.generated.h");

const BLOCK = /^([ \t]*)\/\/ <generated[^\n]*\n[\s\S]*?^[ \t]*\/\/ <\/generated>\n/m;

/** boot.js with its generated block replaced (the rest is the shell's and stays as written). */
export function updateBootJs(current: string): string {
  const m = BLOCK.exec(current);
  if (!m) throw new Error(`${BOOT_JS}: no "// <generated" … "// </generated>" block`);
  return current.slice(0, m.index) + renderBootSurfaces(m[1]) + current.slice(m.index + m[0].length);
}

/** Every artefact: its path, what is on disk, what tokens.ts gives. */
export function outputs(): { path: string; current: string | null; next: string }[] {
  const read = (p: string) => {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return null;
    }
  };
  const boot = read(BOOT_JS);
  return [
    { path: TOKENS_CSS, current: read(TOKENS_CSS), next: renderTokensCss() },
    { path: BOOT_JS, current: boot, next: boot === null ? "" : updateBootJs(boot) },
    { path: CHROME_HEADER, current: read(CHROME_HEADER), next: renderChromeHeader() },
  ];
}

function main(argv: string[]) {
  const check = argv.includes("--check");
  let stale = 0;
  for (const o of outputs()) {
    if (o.current === o.next) continue;
    const name = relative(root, o.path);
    if (check) {
      stale++;
      console.error(`${name} is out of date: run \`npm run tokens\``);
    } else {
      writeFileSync(o.path, o.next);
      console.log(`wrote ${name}`);
    }
  }
  if (check && stale) process.exit(1);
  if (check) console.log("tokens.css, boot.js and ChromePalette.generated.h are up to date");
}

// Run as a script (vite-node scripts/gen-tokens.ts …), not when a test imports it.
if (!process.env.VITEST) main(process.argv.filter((a) => a.startsWith("--")));
