// The image tools scene's picture, drawn (no photo is fetched): a product shot in a 1000 × 1000 world — a wall, a
// table, the subject and a cup — so a crop of it is the image layer, Expand reveals more of the same world, and the
// tools' results are the same drawing with parts hidden, re-lit or filtered. Design content: its own colours.
import { useId, useMemo, type ReactNode } from "react";

export type Subject = "vase" | "teapot" | "lamp" | "bowl";
export type Light = "day" | "golden" | "dusk" | "winter";
export type Part = "background" | "subject" | "cup";

export interface ArtState {
  subject: Subject;
  light: Light;
  blossoms: boolean;
  hidden: Part[];
}

export const FIRST_ART: ArtState = { subject: "vase", light: "day", blossoms: false, hidden: [] };

const LIGHTS: Record<Light, { wall: [string, string]; table: [string, string]; edge: string; spot: string; glaze: [string, string]; cup: string; leaf: string; shadow: number }> = {
  day: { wall: ["#f4dccb", "#e6bea2"], table: ["#d8b08c", "#bf916b"], edge: "#e7c6a6", spot: "#ffffff", glaze: ["#3f7479", "#1d3d42"], cup: "#f7f3ec", leaf: "#6f9070", shadow: 0.28 },
  golden: { wall: ["#f9cf96", "#ea9f62"], table: ["#d79c5f", "#b0713c"], edge: "#ebb47a", spot: "#fff1c9", glaze: ["#467a73", "#22423d"], cup: "#fbefdc", leaf: "#7f9a5d", shadow: 0.34 },
  dusk: { wall: ["#5d5b92", "#34325f"], table: ["#6f5b7d", "#433651"], edge: "#86719a", spot: "#ffcf8a", glaze: ["#5b8c99", "#24414b"], cup: "#e9e2f0", leaf: "#7f9f8a", shadow: 0.45 },
  winter: { wall: ["#eef3f8", "#cfdcea"], table: ["#e2e8ef", "#c0ccda"], edge: "#f1f5f9", spot: "#ffffff", glaze: ["#3e5577", "#1f2f47"], cup: "#ffffff", leaf: "#7d9a92", shadow: 0.2 },
};

export type TraceMode = "FULL_COLOR" | "GRAYSCALE" | "BLACK_AND_WHITE";
/** Vectorize's look: flat shapes in `n` colours (or greys), or black and white at a threshold (0–100) */
export interface Trace {
  mode: TraceMode;
  n: number;
}

// ---- colours ----
const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const hex = (c: number[]) => `#${c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("")}`;
const mix = (a: string, b: string, t: number) => hex(rgb(a).map((v, i) => v + (rgb(b)[i] - v) * t));
const lum = (h: string) => {
  const [r, g, b] = rgb(h);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
};
const d2 = (a: number[], b: number[]) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

/** Every colour the drawing uses in a light (the tracer's input, known up front here) */
function coloursOf(art: ArtState): string[] {
  const L = LIGHTS[art.light];
  const out = [L.wall[0], L.wall[1], mix(L.wall[0], L.wall[1], 0.5), L.table[0], L.table[1], mix(L.table[0], L.table[1], 0.5), L.edge, mix(L.wall[0], L.spot, 0.22), mix(L.table[0], "#000000", L.shadow), L.cup, "#5b3a26"];
  if (art.subject === "vase") out.push(L.leaf, mix(L.glaze[0], L.glaze[1], 0.4), "#183337", ...(art.blossoms ? ["#f6a5c0", "#f7d27a"] : []));
  if (art.subject === "teapot") out.push("#c96f4a", "#d77b55", "#b8603e");
  if (art.subject === "lamp") out.push("#e8dccb", "#f4ead9", "#d9c9b0", mix(L.wall[0], L.spot, 0.35));
  if (art.subject === "bowl") out.push("#f2994a", "#f6ad55", mix(L.glaze[0], L.glaze[1], 0.4));
  return [...new Set(out)];
}

/** The colour each colour becomes: k-means into n colours, n greys, or black and white at the threshold */
function quantizer(art: ArtState, t: Trace): (h: string) => string {
  if (t.mode === "GRAYSCALE") {
    const n = Math.max(2, t.n);
    return (h) => {
      const v = Math.round(lum(h) * (n - 1)) / (n - 1);
      return hex([v * 255, v * 255, v * 255]);
    };
  }
  if (t.mode === "BLACK_AND_WHITE") return (h) => (lum(h) * 100 < t.n ? "#141414" : "#ffffff");
  const list = coloursOf(art).map(rgb);
  const k = Math.min(t.n, list.length);
  // Farthest-first seeds, then a few rounds of k-means
  const centres = [list[0]];
  while (centres.length < k) {
    let best = list[0];
    let far = -1;
    for (const c of list) {
      const d = Math.min(...centres.map((x) => d2(c, x)));
      if (d > far) {
        far = d;
        best = c;
      }
    }
    centres.push(best);
  }
  for (let round = 0; round < 6; round++) {
    const sums = centres.map(() => [0, 0, 0, 0]);
    for (const c of list) {
      const i = centres.reduce((bi, x, j) => (d2(c, x) < d2(c, centres[bi]) ? j : bi), 0);
      sums[i][0] += c[0];
      sums[i][1] += c[1];
      sums[i][2] += c[2];
      sums[i][3]++;
    }
    sums.forEach((sm, i) => {
      if (sm[3]) centres[i] = [sm[0] / sm[3], sm[1] / sm[3], sm[2] / sm[3]];
    });
  }
  return (h) => {
    const c = rgb(h);
    return hex(centres.reduce((b, x) => (d2(c, x) < d2(c, b) ? x : b), centres[0]));
  };
}

interface Ink {
  /** A colour as drawn (the trace's colour when traced) */
  c: (h: string) => string;
  /** A gradient's fill, or its flat middle when traced */
  g: (name: string, a: string, b: string) => string;
  flat: boolean;
  id: (n: string) => string;
}

/** The picture: `view` is the crop of the 1000 × 1000 world the layer shows; `trace` draws it the way Vectorize does. */
export function ProductArt({ art, view, trace, blurs = [], width = "100%", height = "100%", children }: { art: ArtState; view: { x: number; y: number; w: number; h: number }; trace?: Trace | null; blurs?: { x: number; y: number }[][]; width?: number | string; height?: number | string; children?: ReactNode }) {
  const uid = useId().replace(/:/g, "");
  const L = LIGHTS[art.light];
  const id = (n: string) => `${uid}-${n}`;
  const flat = !!trace;
  const q = useMemo(() => (trace ? quantizer(art, trace) : (h: string) => h), [art, trace]);
  const ink: Ink = { c: q, g: (name, a, b) => (flat ? q(mix(a, b, 0.5)) : `url(#${id(name)})`), flat, id };
  const shown = (p: Part) => !art.hidden.includes(p);
  const shadow = (cx: number, cy: number, rx: number, ry: number, o: number) =>
    flat ? <ellipse cx={cx} cy={cy} rx={rx} ry={ry * 0.8} fill={q(mix(L.table[0], "#000000", L.shadow))} /> : <ellipse cx={cx} cy={cy} rx={rx} ry={ry} fill="#000" opacity={o} filter={`url(#${id("soft")})`} />;
  return (
    <svg viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`} width={width} height={height} preserveAspectRatio="none" aria-hidden="true" style={{ display: "block" }}>
      <defs>
        <linearGradient id={id("wall")} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={L.wall[0]} />
          <stop offset="1" stopColor={L.wall[1]} />
        </linearGradient>
        <linearGradient id={id("table")} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={L.table[0]} />
          <stop offset="1" stopColor={L.table[1]} />
        </linearGradient>
        <radialGradient id={id("spot")} cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor={L.spot} stopOpacity={art.light === "dusk" ? 0.75 : 0.55} />
          <stop offset="1" stopColor={L.spot} stopOpacity="0" />
        </radialGradient>
        <linearGradient id={id("glaze")} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor={L.glaze[1]} />
          <stop offset="0.38" stopColor={L.glaze[0]} />
          <stop offset="0.62" stopColor={L.glaze[0]} />
          <stop offset="1" stopColor={L.glaze[1]} />
        </linearGradient>
        <linearGradient id={id("sheen")} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#fff" stopOpacity="0" />
          <stop offset="0.5" stopColor="#fff" stopOpacity="0.35" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <filter id={id("soft")} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="14" />
        </filter>
        <filter id={id("blur")} x="-10%" y="-10%" width="120%" height="120%">
          <feGaussianBlur stdDeviation="9" />
        </filter>
        {blurs.map((poly, i) => (
          <clipPath key={i} id={id(`area${i}`)}>
            <path d={`M${poly.map((p) => `${p.x} ${p.y}`).join(" L")} Z`} />
          </clipPath>
        ))}
      </defs>
      <g id={id("pic")}>
        {shown("background") && (
          <g data-part="background">
            <rect x="-10" y="-10" width="1020" height="660" fill={ink.g("wall", L.wall[0], L.wall[1])} />
            {!flat && <circle cx="700" cy="250" r="330" fill={`url(#${id("spot")})`} />}
            <rect x="-10" y="640" width="1020" height="370" fill={ink.g("table", L.table[0], L.table[1])} />
            <rect x="-10" y="636" width="1020" height="8" fill={q(L.edge)} />
            {/* a window's light on the wall */}
            <g opacity={flat ? 1 : art.light === "dusk" ? 0.1 : 0.22} fill={flat ? q(mix(L.wall[0], L.spot, 0.22)) : L.spot}>
              <path d="M760 90 L900 90 L840 430 L700 430 Z" />
              <path d="M920 90 L980 90 L920 430 L860 430 Z" />
            </g>
          </g>
        )}
        {shown("cup") && (
          <g data-part="cup">
            {shadow(300, 782, 78, 14, L.shadow)}
            <path d="M236 690 L364 690 Q360 770 300 776 Q240 770 236 690 Z" fill={q(L.cup)} />
            <path d="M364 708 Q398 712 392 736 Q386 756 356 752" fill="none" stroke={q(L.cup)} strokeWidth="11" />
            <ellipse cx="300" cy="690" rx="64" ry="12" fill={q("#5b3a26")} />
            {!flat && <path d="M246 700 Q252 760 290 770" fill="none" stroke="#000" strokeOpacity="0.06" strokeWidth="10" />}
          </g>
        )}
        {shown("subject") && (
          <g data-part="subject">
            {shadow(540, 800, 150, 22, L.shadow + 0.06)}
            {art.subject === "vase" && <Vase ink={ink} glaze={L.glaze} leaf={L.leaf} blossoms={art.blossoms} />}
            {art.subject === "teapot" && <Teapot ink={ink} />}
            {art.subject === "lamp" && <Lamp ink={ink} glow={L.spot} wall={L.wall[0]} />}
            {art.subject === "bowl" && <Bowl ink={ink} glaze={L.glaze} />}
          </g>
        )}
      </g>
      {/* Blur: the picture again, blurred, inside each lasso */}
      {blurs.map((_, i) => (
        <g key={i} clipPath={`url(#${id(`area${i}`)})`}>
          <use href={`#${id("pic")}`} filter={`url(#${id("blur")})`} />
        </g>
      ))}
      {children}
    </svg>
  );
}

function Vase({ ink, glaze, leaf, blossoms }: { ink: Ink; glaze: [string, string]; leaf: string; blossoms: boolean }) {
  const stems = [
    { d: "M540 420 C 520 330, 470 260, 420 190", leaves: [[470, 260, -40], [440, 215, -60], [500, 320, -20]] },
    { d: "M548 420 C 560 320, 600 240, 640 160", leaves: [[600, 240, 40], [625, 190, 55], [570, 320, 20]] },
    { d: "M544 420 C 548 330, 540 240, 548 130", leaves: [[542, 250, -10], [550, 180, 15]] },
  ] as const;
  const c = ink.c;
  return (
    <g>
      {stems.map((st, i) => (
        <g key={i}>
          <path d={st.d} fill="none" stroke={c(leaf)} strokeWidth="5" strokeLinecap="round" />
          {st.leaves.map(([x, y, r], j) => (
            <ellipse key={j} cx={x} cy={y} rx="30" ry="15" fill={c(leaf)} opacity={ink.flat ? 1 : 0.92 - j * 0.08} transform={`rotate(${r} ${x} ${y})`} />
          ))}
        </g>
      ))}
      {blossoms &&
        [[420, 190], [640, 160], [548, 130], [470, 258], [610, 232]].map(([x, y], i) => (
          <g key={i} transform={`translate(${x} ${y})`}>
            {[0, 72, 144, 216, 288].map((a) => (
              <ellipse key={a} cx="0" cy="-14" rx="10" ry="15" fill={c("#f6a5c0")} transform={`rotate(${a})`} />
            ))}
            <circle r="7" fill={c("#f7d27a")} />
          </g>
        ))}
      <path d="M492 418 Q484 456 500 486 Q430 560 450 680 Q462 770 540 796 Q618 770 630 680 Q650 560 580 486 Q596 456 588 418 Z" fill={ink.flat ? c(mix(glaze[0], glaze[1], 0.4)) : `url(#${ink.id("glaze")})`} />
      <ellipse cx="540" cy="418" rx="48" ry="9" fill={c("#183337")} />
      {!ink.flat && <path d="M470 600 Q470 700 520 760" fill="none" stroke={`url(#${ink.id("sheen")})`} strokeWidth="18" strokeLinecap="round" opacity="0.7" />}
    </g>
  );
}

function Teapot({ ink }: { ink: Ink }) {
  const c = ink.c;
  return (
    <g>
      <path d="M640 600 Q720 560 740 500" fill="none" stroke={c("#c96f4a")} strokeWidth="26" strokeLinecap="round" />
      <path d="M420 590 Q350 600 370 680 Q380 720 440 700" fill="none" stroke={c("#c96f4a")} strokeWidth="20" />
      <ellipse cx="540" cy="660" rx="150" ry="130" fill={c("#d77b55")} />
      {!ink.flat && <ellipse cx="540" cy="660" rx="150" ry="130" fill={`url(#${ink.id("sheen")})`} opacity="0.5" />}
      <ellipse cx="540" cy="540" rx="74" ry="18" fill={c("#b8603e")} />
      <circle cx="540" cy="516" r="16" fill={c("#b8603e")} />
    </g>
  );
}

function Lamp({ ink, glow, wall }: { ink: Ink; glow: string; wall: string }) {
  const c = ink.c;
  return (
    <g>
      {ink.flat ? <circle cx="540" cy="470" r="170" fill={c(mix(wall, glow, 0.35))} /> : <circle cx="540" cy="470" r="200" fill={glow} opacity="0.35" filter={`url(#${ink.id("soft")})`} />}
      <rect x="526" y="520" width="28" height="250" fill={c("#e8dccb")} />
      <ellipse cx="540" cy="782" rx="96" ry="18" fill={c("#e8dccb")} />
      <path d="M390 520 Q400 380 540 370 Q680 380 690 520 Z" fill={c("#f4ead9")} />
      <path d="M390 520 L690 520" stroke={c("#d9c9b0")} strokeWidth="6" />
    </g>
  );
}

function Bowl({ ink, glaze }: { ink: Ink; glaze: [string, string] }) {
  const c = ink.c;
  return (
    <g>
      {[[470, 600], [540, 580], [610, 604], [505, 545], [575, 548]].map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r="46" fill={c(i % 2 ? "#f2994a" : "#f6ad55")} />
      ))}
      <path d="M380 620 Q392 780 540 790 Q688 780 700 620 Z" fill={ink.flat ? c(mix(glaze[0], glaze[1], 0.4)) : `url(#${ink.id("glaze")})`} />
      {!ink.flat && <ellipse cx="540" cy="620" rx="160" ry="16" fill="#163236" opacity="0.4" />}
    </g>
  );
}

/** Where the movable objects sit in the world (Select area's hit test) */
export const OBJECT_AT: Record<Exclude<Part, "background">, { x: number; y: number; box: { x: number; y: number; w: number; h: number } }> = {
  cup: { x: 300, y: 730, box: { x: 226, y: 676, w: 176, h: 112 } },
  subject: { x: 540, y: 560, box: { x: 380, y: 120, w: 320, h: 690 } },
};

/** The prompt card's edits: the words a prompt uses pick the light, the flowers or the subject. */
export function editFor(prompt: string, art: ArtState): ArtState {
  const p = prompt.toLowerCase();
  if (/night|evening|dusk|lamp ?light|moody/.test(p)) return { ...art, light: "dusk" };
  if (/snow|winter|cold|cool|blue/.test(p)) return { ...art, light: "winter" };
  if (/flower|bloom|blossom|pink|spring/.test(p)) return { ...art, blossoms: true };
  if (/day|morning|bright|neutral/.test(p)) return { ...art, light: "day" };
  return { ...art, light: "golden" };
}

export function makeFor(prompt: string): ArtState {
  const p = prompt.toLowerCase();
  const subject: Subject = /tea|pot|kettle/.test(p) ? "teapot" : /lamp|light|glow/.test(p) ? "lamp" : /bowl|fruit|orange|citrus/.test(p) ? "bowl" : "vase";
  const light: Light = /night|evening|dusk/.test(p) ? "dusk" : /winter|snow/.test(p) ? "winter" : /golden|sunset|warm/.test(p) ? "golden" : "day";
  return { subject, light, blossoms: /flower|bloom|blossom/.test(p), hidden: [] };
}
