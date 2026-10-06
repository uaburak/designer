/**
 * The chrome's icon registry (docs/design-system.md §1.13), generated from SVG sources:
 *
 *   src/renderer/src/ds/icons/svg/<box>/<name>.svg  →  src/renderer/src/ds/icons/registry.ts ("<box>.<name>")
 *
 *   npm run icons              write registry.ts
 *   npm run icons -- --check   exit 1 if registry.ts is not what the SVGs give (the DS tests run the same check)
 *   npm run icons -- --export  one-off: write the SVGs from the current registry.ts
 *
 * An SVG is read as Figma exports it, or as --export writes it:
 * - filled glyphs: `<path d fill-rule? fill-opacity?>` — even-odd if any path is; `fill-opacity` is the
 *   kit's tone (0.9 primary — the icon's colour —, 0.3 secondary);
 * - stroked glyphs: `stroke="currentColor"` on the <svg> or the paths, 1px round strokes, drawn in the
 *   viewBox's own box centred in the icon's (a viewBox of "-4 -4 24 24" is a 16px drawing in a 24 box);
 *   a path with `fill="currentColor" stroke="none"` inside a stroked icon is filled.
 * Run with vite-node (plain `node` cannot resolve the DS's extensionless imports).
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type IconEntry = readonly [box: 16 | 24, mode: 0 | 1 | `s${number}`, ...paths: string[]];

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const SVG_DIR = join(root, "src/renderer/src/ds/icons/svg");
export const REGISTRY = join(root, "src/renderer/src/ds/icons/registry.ts");

const attr = (tag: string, name: string): string | undefined => {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m ? m[1] : undefined;
};
const round = (n: number, d = 4) => Math.round(n * 10 ** d) / 10 ** d;

/** One SVG source → its registry entry. */
export function svgToEntry(svg: string, box: 16 | 24): IconEntry {
  const open = /<svg\b[^>]*>/.exec(svg)?.[0] ?? "";
  const viewBox = (attr(open, "viewBox") ?? `0 0 ${box} ${box}`).trim().split(/[\s,]+/).map(Number);
  const svgStroked = attr(open, "stroke") === "currentColor";
  const paths = [...svg.matchAll(/<path\b[^>]*?\/?>/g)].map((m) => m[0]);
  const stroked = svgStroked || paths.some((p) => attr(p, "stroke") === "currentColor" && attr(p, "fill") !== "currentColor");
  if (stroked) {
    // The drawing's own box: a viewBox of "-4 -4 24 24" is a 16px drawing centred in a 24 box
    const view = round(viewBox[2] + 2 * viewBox[0]);
    const out = paths.map((p) => {
      const d = attr(p, "d") ?? "";
      const filled = attr(p, "fill") === "currentColor" && attr(p, "stroke") === "none";
      return filled ? `f|${d}` : d;
    });
    return [box, `s${view}`, ...out];
  }
  const evenOdd = paths.some((p) => attr(p, "fill-rule") === "evenodd");
  const out = paths.map((p) => {
    const d = attr(p, "d") ?? "";
    const tone = Number(attr(p, "fill-opacity") ?? attr(p, "opacity") ?? "0.9");
    return tone < 0.9 ? `${round(tone, 2)}|${d}` : d;
  });
  return [box, evenOdd ? 1 : 0, ...out];
}

/** A registry entry → its SVG source (what --export writes; svgToEntry reads it back unchanged). */
export function entryToSvg([box, mode, ...paths]: IconEntry): string {
  if (typeof mode === "string") {
    const view = Number(mode.slice(1));
    const inset = round((box - view) / 2);
    const body = paths.map((p) => (p.startsWith("f|") ? `  <path d="${p.slice(2)}" fill="currentColor" stroke="none"/>` : `  <path d="${p}"/>`)).join("\n");
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${box}" height="${box}" viewBox="${-inset} ${-inset} ${box} ${box}" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round">\n${body}\n</svg>\n`;
  }
  const rule = mode === 1 ? ` fill-rule="evenodd" clip-rule="evenodd"` : "";
  const body = paths
    .map((p) => {
      const at = p.indexOf("|");
      const tone = at > 0 ? Number(p.slice(0, at)) : 0.9;
      const d = at > 0 ? p.slice(at + 1) : p;
      return `  <path${rule} d="${d}" fill="currentColor"${tone < 0.9 ? ` fill-opacity="${tone}"` : ""}/>`;
    })
    .join("\n");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${box}" height="${box}" viewBox="0 0 ${box} ${box}" fill="none">\n${body}\n</svg>\n`;
}

/** Every SVG source: "<box>.<name>" → its text. */
export function readSvgs(dir = SVG_DIR): Map<string, { box: 16 | 24; svg: string }> {
  const out = new Map<string, { box: 16 | 24; svg: string }>();
  for (const box of [16, 24] as const) {
    let files: string[] = [];
    try {
      files = readdirSync(join(dir, String(box))).filter((f) => f.endsWith(".svg"));
    } catch {
      continue;
    }
    for (const f of files) out.set(`${box}.${f.slice(0, -4)}`, { box, svg: readFileSync(join(dir, String(box), f), "utf8") });
  }
  return out;
}

/** registry.ts's source for these icons (sorted by name). */
export function renderRegistry(icons: Map<string, IconEntry>): string {
  const body = [...icons.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, entry]) => `  ${JSON.stringify(name)}: ${JSON.stringify(entry)},`)
    .join("\n");
  return `/**
 * GENERATED by scripts/gen-icons.ts from ds/icons/svg/<box>/<name>.svg — do not edit; add or change an SVG and run \`npm run icons\`.
 * The chrome's icons (contract §1.13): Figma's UI3 kit export (fileKey X1CtybE45PhEAXWF3GTSGa), glyphs drawn after
 * Figma's panels, and the shell's own. Kit glyphs are for this personal app only; do not redistribute.
 *
 * Entry: [box, mode, ...paths]. mode 0/1: filled (1 = even-odd); a path is "d", or "tone|d" for the kit's secondary
 * tone (0.3 of its 0.9 primary). mode "sN": 1px round strokes drawn in an N×N box centred in the icon's; "f|d" paths
 * are filled.
 */
export type IconEntry = readonly [box: 16 | 24, mode: 0 | 1 | \`s\${number}\`, ...paths: string[]];

export const ICONS = {
${body}
} as const satisfies Record<string, IconEntry>;

export type IconName = keyof typeof ICONS;
`;
}

/** The registry the SVG sources give. */
export function buildRegistry(dir = SVG_DIR): string {
  const icons = new Map<string, IconEntry>();
  for (const [name, { box, svg }] of readSvgs(dir)) icons.set(name, svgToEntry(svg, box));
  return renderRegistry(icons);
}

async function main(argv: string[]) {
  if (argv.includes("--export")) {
    const { ICONS } = await import("../src/renderer/src/ds/icons/registry");
    let n = 0;
    for (const [name, entry] of Object.entries(ICONS) as [string, IconEntry][]) {
      const at = name.indexOf(".");
      const dir = join(SVG_DIR, name.slice(0, at));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${name.slice(at + 1)}.svg`), entryToSvg(entry));
      n++;
    }
    console.log(`wrote ${n} SVGs to ${SVG_DIR}`);
    return;
  }
  const next = buildRegistry();
  if (argv.includes("--check")) {
    const current = readFileSync(REGISTRY, "utf8");
    if (current !== next) {
      console.error("registry.ts is out of date: run `npm run icons`");
      process.exit(1);
    }
    console.log("registry.ts is up to date");
    return;
  }
  writeFileSync(REGISTRY, next);
  console.log(`wrote ${REGISTRY}`);
}

// Run as a script (vite-node scripts/gen-icons.ts …), not when a test imports it.
if (!process.env.VITEST) void main(process.argv.filter((a) => a.startsWith("--")));
