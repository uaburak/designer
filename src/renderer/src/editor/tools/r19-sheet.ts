/**
 * Round 19's side-by-side sheets (docs/research/figma/live/owner-2026-10-19/after/boolean-*.png, pathfinder-*.png):
 * the real engine (headless Wasm) exports each case as SVG; the sheet sets it beside the reference —
 * - booleans: Figma's own exported outlines (docs/research/figma/live/2026-10-18/boolean-radius.txt; where the file
 *   describes a case without its SVG — Union, Exclude, Intersect — the outline it describes), then the two overlaid
 *   (Figma's outline red over Wecra's fill);
 * - Pathfinders: the input, Illustrator's documented result for it (helpx.adobe.com, drawn from its rules), Wecra's —
 *   every piece outlined so the pieces show.
 *
 *   npx vite-node --config vitest.config.ts src/renderer/src/editor/tools/r19-sheet.ts
 */
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { Engine } from "@/engine/Engine";
import { loadEngine } from "@/engine/loadEngine";
import type { Message, NodeChange } from "@/engine/codec";

const OUT = join(process.cwd(), "docs/research/figma/live/owner-2026-10-19/after");
const WASM = join(process.cwd(), "src/renderer/src/engine/wasm/engine.wasm");

const FIGMA_SUBTRACT_20 =
  "M300 220C300 231.046 291.046 240 280 240H20C8.95 240 0 231.046 0 220V20C0 8.95 8.95 0 20 0H100C111.046 0 120 8.95 120 20V150C120 161.046 128.954 170 140 170H160C171.046 170 180 161.046 180 150V20C180 8.95 188.954 0 200 0H280C291.046 0 300 8.95 300 20V220Z";
const FIGMA_SUBTRACT_999 =
  "M300 120C300 186.274 246.274 240 180 240H120C53.73 240 0 186.274 0 120V60C0 26.86 26.86 0 60 0C93.14 0 120 26.86 120 60V140C120 156.569 133.431 170 150 170C166.569 170 180 156.569 180 140V60C180 26.86 206.86 0 240 0C273.14 0 300 26.86 300 60V120Z";

type Vec = [number, number];
const K = 0.5522847498;
/** Horizontal / vertical edges, each corner a quarter circle of its radius (as Figma's outlines are written). */
function orthogonal(pts: Vec[], radii: number[], dx = 0, dy = 0): string {
  const n = pts.length;
  let d = "";
  for (let i = 0; i < n; i++) {
    const V = pts[i],
      P = pts[(i + n - 1) % n],
      N = pts[(i + 1) % n];
    const u = unit([V[0] - P[0], V[1] - P[1]]),
      v = unit([N[0] - V[0], N[1] - V[1]]);
    const r = radii[i],
      k = K * r;
    const S: Vec = [V[0] - u[0] * r, V[1] - u[1] * r],
      E: Vec = [V[0] + v[0] * r, V[1] + v[1] * r];
    d += `${i ? "L" : "M"}${f(S[0] + dx)} ${f(S[1] + dy)}C${f(S[0] + u[0] * k + dx)} ${f(S[1] + u[1] * k + dy)} ${f(E[0] - v[0] * k + dx)} ${f(E[1] - v[1] * k + dy)} ${f(E[0] + dx)} ${f(E[1] + dy)}`;
  }
  return d + "Z";
}
const unit = (v: Vec): Vec => {
  const l = Math.hypot(v[0], v[1]);
  return [v[0] / l, v[1] / l];
};
const f = (n: number) => String(Math.round(n * 1000) / 1000);

const hex = (rgb: number) => ({
  r: ((rgb >> 16) & 255) / 255,
  g: ((rgb >> 8) & 255) / 255,
  b: (rgb & 255) / 255,
  a: 1,
});
const solid = (rgb: number) => [{ type: "SOLID" as const, color: hex(rgb), opacity: 1, visible: true }];
const at = (x: number, y: number) => ({
  m00: 1,
  m01: 0,
  m02: x,
  m10: 0,
  m11: 1,
  m12: y,
});
const pos = (i: number) => String.fromCharCode(33 + i);

function doc(nodes: NodeChange[]): Message {
  return {
    type: "NODE_CHANGES",
    sessionID: 0,
    nodeChanges: [
      { guid: "0:0", phase: "CREATED", type: "DOCUMENT", name: "Document" },
      {
        guid: "0:1",
        phase: "CREATED",
        type: "CANVAS",
        name: "Page 1",
        parentIndex: { guid: "0:0", position: "!" },
        backgroundColor: hex(0xffffff),
        backgroundEnabled: true,
      },
      ...nodes,
    ],
  };
}

async function engineWith(nodes: NodeChange[]) {
  const engine = await Engine.create(null, { sessionID: 1 });
  engine.load(doc(nodes));
  return engine;
}

/** The paths an exported SVG draws: d, fill, stroke. */
function pathsOf(svg: string) {
  return [...svg.matchAll(/<path\b[^>]*>/g)].map((m) => {
    const a = (k: string) => new RegExp(`\\s${k}="([^"]*)"`).exec(m[0])?.[1];
    return {
      d: a("d") ?? "",
      fill: a("fill") ?? "none",
      stroke: a("stroke") ?? "none",
    };
  });
}
async function exportSvg(engine: Engine, id: string): Promise<string> {
  const r = engine.exportNodes([id], { imageType: "SVG" } as never, {
    allowPending: true,
  });
  if (r.status !== "ok" || r.format !== "SVG") throw new Error(`export ${id}: ${JSON.stringify(r)}`);
  return new TextDecoder().decode(r.bytes);
}

const CELL = 340;
const TITLE = 28;
const text = (x: number, y: number, s: string, size = 13, weight = 500, fill = "#1e1e1e") =>
  `<text x="${x}" y="${y}" font-family="Inter, Helvetica, Arial, sans-serif" font-size="${size}" font-weight="${weight}" fill="${fill}">${s.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</text>`;
/** A cell: its drawing scaled into the cell, centred (content in its own units within `box`). */
const cell = (col: number, row: number, label: string, body: string, box: { x: number; y: number; w: number; h: number }) => {
  const s = Math.min((CELL - 60) / box.w, (CELL - 80) / box.h);
  const ox = col * CELL + (CELL - box.w * s) / 2 - box.x * s,
    oy = TITLE + row * CELL + 40 + (CELL - 80 - box.h * s) / 2 - box.y * s;
  return `<g>${text(col * CELL + 16, TITLE + row * CELL + 24, label, 12, 500, "#555")}<g transform="translate(${f(ox)} ${f(oy)}) scale(${f(s)})">${body}</g></g>`;
};

async function sheet(name: string, title: string, rows: string[], cols: number) {
  const w = cols * CELL,
    h = TITLE + Math.ceil(rows.length / cols) * CELL;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="#ffffff"/>${text(16, 20, title, 14, 600)}${rows.join("")}</svg>`;
  await sharp(Buffer.from(svg))
    .png()
    .toFile(join(OUT, `${name}.png`));
  console.log(`wrote ${name}.png`);
}

// ---- Booleans ----------------------------------------------------------------------------------------------------

interface BoolCase {
  file: string;
  label: string;
  op: string;
  radius: number;
  smoothing?: number;
  childRadius?: number;
  figma: string | null; // Figma's outline in A's space (A 300 × 240 at the origin, B 60 × 200 at (120, −30))
  figmaNote: string;
}

const BOOL_CASES: BoolCase[] = [
  {
    file: "boolean-subtract-20",
    label: "Subtract, radius 20",
    op: "SUBTRACT",
    radius: 20,
    figma: FIGMA_SUBTRACT_20,
    figmaNote: "Figma (its SVG)",
  },
  {
    file: "boolean-subtract-999",
    label: "Subtract, radius 999",
    op: "SUBTRACT",
    radius: 999,
    figma: FIGMA_SUBTRACT_999,
    figmaNote: "Figma (its SVG)",
  },
  {
    file: "boolean-union-20",
    label: "Union, radius 20",
    op: "UNION",
    radius: 20,
    figma: orthogonal(
      [
        [0, 0],
        [120, 0],
        [120, -30],
        [180, -30],
        [180, 0],
        [300, 0],
        [300, 240],
        [0, 240],
      ],
      [20, 15, 15, 15, 15, 20, 20, 20]
    ),
    figmaNote: "Figma (as described)",
  },
  {
    file: "boolean-exclude-20",
    label: "Exclude, radius 20",
    op: "XOR",
    radius: 20,
    figma:
      FIGMA_SUBTRACT_20 +
      orthogonal(
        [
          [120, -30],
          [180, -30],
          [180, 0],
          [120, 0],
        ],
        [15, 15, 15, 15]
      ),
    figmaNote: "Figma (as described)",
  },
  {
    file: "boolean-intersect-999",
    label: "Intersect, radius 999",
    op: "INTERSECT",
    radius: 999,
    figma: orthogonal(
      [
        [120, 0],
        [180, 0],
        [180, 170],
        [120, 170],
      ],
      [30, 30, 30, 30]
    ),
    figmaNote: "Figma (as described)",
  },
  {
    file: "boolean-subtract-20-smooth",
    label: "Subtract, radius 20, smoothing 60 %",
    op: "SUBTRACT",
    radius: 20,
    smoothing: 0.6,
    figma: FIGMA_SUBTRACT_20,
    figmaNote: "Figma at 0 % (for contrast)",
  },
  {
    file: "boolean-child-radius",
    label: "Subtract 0, child A radius 40",
    op: "SUBTRACT",
    radius: 0,
    childRadius: 40,
    figma: null,
    figmaNote: "",
  },
];

async function booleans() {
  const rows: string[] = [];
  for (const [i, c] of BOOL_CASES.entries()) {
    const engine = await engineWith([
      {
        guid: "1:1",
        phase: "CREATED",
        type: "BOOLEAN_OPERATION" as never,
        booleanOperation: c.op as never,
        name: c.label,
        parentIndex: { guid: "0:1", position: "!" },
        size: { x: 300, y: 270 },
        transform: at(0, 0),
        fillPaints: solid(0x0c8ce9),
        cornerRadius: c.radius,
        cornerSmoothing: c.smoothing ?? 0,
      } as NodeChange,
      {
        guid: "1:2",
        phase: "CREATED",
        type: "ROUNDED_RECTANGLE",
        name: "A",
        parentIndex: { guid: "1:1", position: "!" },
        size: { x: 300, y: 240 },
        transform: at(0, 30),
        fillPaints: solid(0xd9d9d9),
        cornerRadius: c.childRadius ?? 0,
      } as NodeChange,
      {
        guid: "1:3",
        phase: "CREATED",
        type: "ROUNDED_RECTANGLE",
        name: "B",
        parentIndex: { guid: "1:1", position: '"' },
        size: { x: 60, y: 200 },
        transform: at(120, 0),
        fillPaints: solid(0xd9d9d9),
      } as NodeChange,
    ]);
    const svg = await exportSvg(engine, "1:1");
    engine.destroy?.();
    const ours = pathsOf(svg)[0]?.d ?? "";
    // Both in A's space: the export's file starts at the result's top-left; Figma's at A's (y −30 for B's bump).
    const top = c.op === "UNION" || c.op === "XOR" ? -30 : 0;
    const left = c.op === "INTERSECT" ? 120 : 0;
    const oursG = `<g transform="translate(${left} ${top})">`;
    const box = { x: -10, y: -40, w: 320, h: 290 };
    const figmaCell = c.figma ? `<path d="${c.figma}" fill="#d9d9d9" fill-rule="nonzero" stroke="#f24822" stroke-width="1.5"/>` : "";
    const oursCell = `${oursG}<path d="${ours}" fill="#0c8ce9"/></g>`;
    const overlay = `${oursG}<path d="${ours}" fill="#0c8ce9" fill-opacity="0.55"/></g>${c.figma ? `<path d="${c.figma}" fill="none" stroke="#f24822" stroke-width="1.5"/>` : ""}`;
    const row = [
      cell(0, 0, c.figma ? c.figmaNote : "(no Figma SVG for this case)", figmaCell, box),
      cell(1, 0, "Wecra", oursCell, box),
      cell(2, 0, "Overlay: Figma red outline, Wecra blue", overlay, box),
    ];
    await sheet(c.file, `${c.label} — A 300 × 240, B 60 × 200 (30 above A)`, row, 3);
    rows.push(...[0, 1, 2].map((col) => cell(col, i, [c.figma ? c.figmaNote : "(none)", `Wecra — ${c.label}`, "Overlay"][col], [figmaCell, oursCell, overlay][col], box)));
  }
  await sheet("boolean-sheet", "Round 19a — boolean groups' corner radius: Figma (left), Wecra (middle), overlaid (right)", rows, 3);
}

// ---- Pathfinders -------------------------------------------------------------------------------------------------

const RED = 0xf24822,
  BLUE = 0x0d99ff;
const red = "#F24822",
  blue = "#0D99FF";
type Piece = { d: string; fill?: string; stroke?: string };
interface PfCase {
  file: string;
  label: string;
  command: string;
  inputs: { fill: number; x: number; y: number; ellipse?: boolean }[];
  illustrator: Piece[]; // Illustrator's documented result for these inputs (two 100 squares, 50 apart)
}
const rect = (x: number, y: number, w: number, h: number) => `M${x} ${y}H${x + w}V${y + h}H${x}Z`;
const PF_CASES: PfCase[] = [
  {
    file: "pathfinder-divide",
    label: "Divide",
    command: "PATHFINDER_DIVIDE",
    inputs: [
      { fill: RED, x: 0, y: 0 },
      { fill: BLUE, x: 50, y: 50 },
    ],
    illustrator: [
      { d: "M0 0H100V50H50V100H0Z", fill: red },
      { d: rect(50, 50, 50, 50), fill: blue },
      { d: "M100 50H150V150H50V100H100Z", fill: blue },
    ],
  },
  {
    file: "pathfinder-trim",
    label: "Trim",
    command: "PATHFINDER_TRIM",
    inputs: [
      { fill: RED, x: 0, y: 0 },
      { fill: BLUE, x: 50, y: 50 },
    ],
    illustrator: [
      { d: "M0 0H100V50H50V100H0Z", fill: red },
      { d: rect(50, 50, 100, 100), fill: blue },
    ],
  },
  {
    file: "pathfinder-merge",
    label: "Merge (the same fill)",
    command: "PATHFINDER_MERGE",
    inputs: [
      { fill: RED, x: 0, y: 0 },
      { fill: RED, x: 50, y: 50 },
    ],
    illustrator: [{ d: "M0 0H100V50H150V150H50V100H0Z", fill: red }],
  },
  {
    file: "pathfinder-crop",
    label: "Crop",
    command: "PATHFINDER_CROP",
    inputs: [
      { fill: RED, x: 0, y: 0 },
      { fill: BLUE, x: 50, y: 50 },
    ],
    illustrator: [{ d: rect(50, 50, 50, 50), fill: red }],
  },
  {
    file: "pathfinder-outline",
    label: "Outline",
    command: "PATHFINDER_OUTLINE",
    inputs: [
      { fill: RED, x: 0, y: 0 },
      { fill: BLUE, x: 50, y: 50 },
    ],
    illustrator: [
      { d: "M100 50V0H0V100H50", stroke: red },
      { d: "M50 100H100V50", stroke: red },
      { d: "M100 50H50V100", stroke: blue },
      { d: "M50 100V150H150V50H100", stroke: blue },
    ],
  },
  {
    file: "pathfinder-minus-back",
    label: "Minus Back",
    command: "PATHFINDER_MINUS_BACK",
    inputs: [
      { fill: RED, x: 0, y: 0 },
      { fill: BLUE, x: 50, y: 50 },
    ],
    illustrator: [{ d: "M100 50H150V150H50V100H100Z", fill: blue }],
  },
  {
    file: "pathfinder-divide-curves",
    label: "Divide (a square and a circle: curves kept)",
    command: "PATHFINDER_DIVIDE",
    inputs: [
      { fill: RED, x: 0, y: 0 },
      { fill: BLUE, x: 50, y: 50, ellipse: true },
    ],
    illustrator: [],
  },
];

const draw = (pieces: Piece[], outlined: boolean) =>
  pieces
    .map((p) =>
      p.stroke && p.stroke !== "none" && (!p.fill || p.fill === "none")
        ? `<path d="${p.d}" fill="none" stroke="${p.stroke}" stroke-width="3" stroke-linecap="round"/>`
        : `<path d="${p.d}" fill="${p.fill ?? "none"}" ${outlined ? 'stroke="#1e1e1e" stroke-width="1.2" stroke-linejoin="round"' : ""}/>`
    )
    .join("");
/** Pieces pulled apart from their common centre a little, so separate pieces read as separate. */
const exploded = (pieces: Piece[], centre: Vec, by = 8) =>
  pieces
    .map((p) => {
      const nums = [...p.d.matchAll(/-?\d+(\.\d+)?(e-?\d+)?/g)].map((m) => Number(m[0]));
      let sx = 0,
        sy = 0;
      for (let i = 0; i + 1 < nums.length; i += 2) {
        sx += nums[i];
        sy += nums[i + 1];
      }
      const c: Vec = [sx / (nums.length / 2), sy / (nums.length / 2)];
      const d = Math.hypot(c[0] - centre[0], c[1] - centre[1]);
      const o: Vec = d > 1 ? [((c[0] - centre[0]) / d) * by, ((c[1] - centre[1]) / d) * by] : [0, 0];
      return `<g transform="translate(${f(o[0])} ${f(o[1])})">${draw([p], true)}</g>`;
    })
    .join("");

async function pathfinders() {
  const rows: string[] = [];
  for (const [i, c] of PF_CASES.entries()) {
    const nodes: NodeChange[] = c.inputs.map(
      (s, k) =>
        ({
          guid: `1:${k + 1}`,
          phase: "CREATED",
          type: s.ellipse ? "ELLIPSE" : "ROUNDED_RECTANGLE",
          name: `Shape ${k + 1}`,
          parentIndex: { guid: "0:1", position: pos(k) },
          size: { x: 100, y: 100 },
          transform: at(s.x, s.y),
          fillPaints: solid(s.fill),
        }) as NodeChange
    );
    const engine = await engineWith(nodes);
    const input = draw(
      c.inputs.map((s) => ({
        d: s.ellipse ? `M${s.x + 50} ${s.y}A50 50 0 1 1 ${s.x + 49.99} ${s.y}Z` : rect(s.x, s.y, 100, 100),
        fill: `#${s.fill.toString(16).padStart(6, "0")}`,
      })),
      true
    );
    engine.setSelection(nodes.map((n) => n.guid));
    const status = engine.command(c.command as never, {
      precision: 0.028,
      removeRedundantPoints: true,
      removeUnpainted: false,
    });
    if (status !== 0) throw new Error(`${c.command}: ${status}`);
    const result = engine.getSelection().refs[0];
    const svg = await exportSvg(engine, result);
    // The exported file is at the result's bounds: back to the page (the result's own position).
    const n = engine.readNode(result)!;
    const ox = n.transform?.m02 ?? 0,
      oy = n.transform?.m12 ?? 0;
    const pieces = pathsOf(svg).map((p) => ({
      d: p.d,
      fill: p.fill,
      stroke: p.stroke,
    }));
    engine.destroy?.();
    const ours = `<g transform="translate(${f(ox)} ${f(oy)})">${exploded(pieces, [75 - ox, 75 - oy])}</g>`;
    const ref = c.illustrator.length ? exploded(c.illustrator, [75, 75]) : "";
    const box = { x: -15, y: -15, w: 180, h: 180 };
    const row = [
      cell(0, 0, "Input (red below, blue on top)", input, box),
      cell(1, 0, c.illustrator.length ? "Illustrator (its documented result)" : "(no hand-drawn reference: curves)", ref, box),
      cell(2, 0, `Wecra — ${pieces.length} piece${pieces.length === 1 ? "" : "s"}`, ours, box),
    ];
    await sheet(c.file, `Pathfinder › ${c.label} — pieces pulled 8 px apart to show them`, row, 3);
    rows.push(cell(0, i, `${c.label}: input`, input, box), cell(1, i, "Illustrator", ref, box), cell(2, i, `Wecra (${pieces.length})`, ours, box));
  }
  await sheet("pathfinder-sheet", "Round 19b — Illustrator's Pathfinders: input, Illustrator's documented result, Wecra's (pieces pulled apart)", rows, 3);
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  // The engine's glue looks for a page (as the wasm tests give it).
  const g = globalThis as Record<string, unknown>;
  g.window ??= globalThis;
  g.document ??= { querySelector: () => null };
  const bytes = readFileSync(WASM);
  await loadEngine({
    wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    printErr: () => {},
  });
  await booleans();
  await pathfinders();
}

await main();
