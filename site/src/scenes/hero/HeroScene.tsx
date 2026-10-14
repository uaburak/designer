// The home page's top (docs/site.md §2.1): the editor around a frame, and in the frame this page's own poster — a
// grainy gradient card, vector shapes, the headline, Try it — as real DOM laid out at the page's width (index.html,
// `[data-hero-frame]`; the frame is that page-top at a smaller scale). Burak draws the frame and the card and sets its
// fill (the app's ColorPicker, a gradient) and grain (Effects › Noise) in the Design panel; six teammates make the
// rest under their own cursors at once (pen and shape tools, typing); then Burak asks the agent in the Agents panel,
// and its cursors-in-the-gradient appear as skeletons resolving while its steps tick. Scrolling opens the frame into
// the page (the panels slide away, its transform goes to none, the toolbar becomes the dock) — and back.
//
// Everything is a function of two numbers, so scroll scrubs it both ways:
//   t  the build, s: it plays by itself while the visitor doesn't scroll, and scrolling moves it — down pushes it on,
//      up rewinds it (t = scroll's share + what played by itself; going up spends what played first)
//   r  the reveal, 0…1: the scroll through the track's second part, both ways
// Under reduced motion nothing of this runs: the poster is simply the page's top.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button, IconButton, ToggleIconButton } from "@/ds/components/Button";
import { ColorInput } from "@/ds/components/ColorInput";
import { ColorPicker } from "@/ds/components/ColorPicker";
import { EditorToolbar, type ToolId } from "@/ds/components/EditorToolbar";
import { Avatar } from "@/ds/components/Misc";
import { PanelSection } from "@/ds/components/PanelSection";
import { PropertyGrid, PropertyRow } from "@/ds/components/PropertyGrid";
import { Rail, RailItem, RailSeparator } from "@/ds/components/Rail";
import { Select } from "@/ds/components/Select";
import { Tabs } from "@/ds/components/Tabs";
import { Icon } from "@/ds/icons/Icon";
import type { PickerPaint } from "@/ds/util/paint";
import mp from "@/editor/multiplayer/Multiplayer.module.css";
import panels from "@/editor/panels/Panels.module.css";
import { agents, AgentText, ChatPanel, Steps, UserMessage, type Step } from "../ai/chat";
import ai from "../ai/ai.module.css";
import { FileHeader, FillSection, Layers, noop, Num, type Row } from "../collage/ui";
import { ARROW, ARROW_EDGE, CURSOR, SIZE, TOOL_ART, type CursorTool } from "../runtime/cursorArt";
import { prefersReduced } from "../runtime/reduced";
import styles from "./hero.module.css";

// ── The timeline ─────────────────────────────────────────────────────────────────────────────────────────────────

const T_BUILD = 18;
/** The track (scroll progress 0…1): [0, BUILD_P] moves the build, [REVEAL_P0, REVEAL_P1] the reveal. */
const BUILD_P = 0.45;
const REVEAL_P0 = 0.5;
const REVEAL_P1 = 0.92;

const ASK = "Draw our cursors in the gradient";
const AGENT = { ask: 11.6, send: 13.45, steps: [13.7, 14.3, 16.0], resolve: [14.9, 15.4, 15.9], done: 16.1, back: 16.75 };
const PICKER = { open: 5.85, linear: 6.65, drag: [7.2, 7.85] as const, close: 8.65 };
const FX = { add: 9.35, noise: 10.05 };
const TAB_AGENTS = 10.85;

/** The vector parts, in the art's 600 × 600 user space. */
const BLOB = [
  [150, 150],
  [330, 105],
  [440, 250],
  [320, 370],
  [150, 320],
] as const;
const WAVE = { p: [[40, 540], [320, 530], [570, 540]] as const, h: [[140, 450], [410, 450], [640, 600]] as const };

type PartId = "card" | "gradient" | "grain" | "blob" | "ring" | "star" | "wave" | "cursors" | "title" | "try" | "trylabel" | "link";
const PART_SEL: Record<PartId, string> = {
  card: ".poster-card",
  gradient: ".poster-fill",
  grain: ".poster-grain",
  blob: "#pa-blob",
  ring: "#pa-ring",
  star: "#pa-star",
  wave: "#pa-wave",
  cursors: "#pa-cursors",
  title: "#hero-title",
  try: '[data-part="try"]',
  trylabel: '[data-part="trylabel"]',
  link: '[data-part="link"]',
};
const SVG_PARTS: PartId[] = ["blob", "ring", "star", "wave", "cursors"];
const INTERACTIVE: PartId[] = ["try", "link"];

type Rect = { x: number; y: number; w: number; h: number };
type Plan =
  | { kind: "appear"; t: number }
  | { kind: "type"; t: number; ms: number; c: string }
  | { kind: "draw"; t: number; t1: number; c: string }
  | { kind: "pen"; clicks: number[]; c: string }
  | { kind: "curve"; drags: [number, number][]; c: string }
  | { kind: "agent"; t: number; resolve: number[] };

type UiSpot = "frameTool" | "rectTool" | "fill" | "pickerType" | "pickerStop" | "pickerClose" | "fxAdd" | "fxType" | "agents" | "file" | "composer" | "send" | "start" | "side";
type Spot = { part: PartId | "frame"; fx: number; fy: number; dx?: number; dy?: number } | { art: readonly [number, number]; dx?: number; dy?: number } | { ui: UiSpot; dx?: number; dy?: number };
interface Key {
  t: number;
  at: Spot;
  tool?: CursorTool;
}
interface Person {
  name: string;
  color: string;
  join: number;
  keys: Key[];
  press: [number, number][];
}

const ease = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;

interface Geo {
  W: number;
  H: number;
  panels: boolean;
  toolbar: boolean;
  s0: number;
  x0: number;
  y0: number;
  parts: Partial<Record<PartId, Rect>>;
  /** The art's box (its 600 user units fill it). */
  art: Rect | null;
  ui: Partial<Record<UiSpot, [number, number]>>;
}

const COLORS = { burak: CURSOR.ink, kamila: CURSOR.red, oguz: CURSOR.green, yasin: "#0FA3A3", ozge: CURSOR.orange, gorkem: CURSOR.blue, ece: CURSOR.purple };
const TEAM = [
  { name: "Kamila", color: COLORS.kamila, join: 4.6 },
  { name: "Oğuz", color: COLORS.oguz, join: 5.2 },
  { name: "Yasin", color: COLORS.yasin, join: 5.8 },
  { name: "Özge", color: COLORS.ozge, join: 6.4 },
  { name: "Görkem", color: COLORS.gorkem, join: 7.0 },
  { name: "Ece", color: COLORS.ece, join: 7.6 },
];

/** Who makes what, when (seconds), on this screen. */
function plan(g: Geo): { people: Person[]; parts: Partial<Record<PartId, Plan>>; draw: [number, number]; card: [number, number] } {
  const parts: Partial<Record<PartId, Plan>> = {};
  const people: Person[] = [];
  const P = (name: string, color: string, join: number) => {
    const p: Person = { name, color, join, keys: [], press: [] };
    people.push(p);
    return p;
  };
  const at = (p: Person, t: number, s: Spot, tool?: CursorTool) => p.keys.push({ t, at: s, tool });
  const click = (p: Person, t: number) => p.press.push([t, t + 0.12]);
  const ui = g.panels;

  // Burak: the frame, the card, its fill and grain (the Design panel), then the agent
  const b = P("Burak", COLORS.burak, 0);
  at(b, 0, { ui: "start" });
  if (g.toolbar) {
    at(b, 0.3, { ui: "start" });
    at(b, 0.9, { ui: "frameTool" });
    click(b, 1.05);
    at(b, 1.15, { ui: "frameTool" }, "crosshair");
  } else at(b, 0.8, { ui: "start" }, "crosshair");
  at(b, 1.7, { part: "frame", fx: 0, fy: 0 });
  at(b, 1.82, { part: "frame", fx: 0, fy: 0 });
  at(b, 2.8, { part: "frame", fx: 1, fy: 1 });
  b.press.push([1.8, 2.85]);
  at(b, 2.9, { part: "frame", fx: 1, fy: 1 }, "arrow");
  if (g.toolbar) {
    at(b, 3.4, { ui: "rectTool" });
    click(b, 3.55);
    at(b, 3.65, { ui: "rectTool" }, "crosshair");
  } else at(b, 3.6, { part: "frame", fx: 1, fy: 1, dx: -30, dy: -30 }, "crosshair");
  at(b, 4.1, { part: "card", fx: 0, fy: 0 });
  at(b, 4.17, { part: "card", fx: 0, fy: 0 });
  at(b, 4.95, { part: "card", fx: 1, fy: 1 });
  b.press.push([4.15, 5.0]);
  at(b, 5.05, { part: "card", fx: 1, fy: 1 }, "arrow");
  if (ui) {
    at(b, 5.6, { ui: "fill" });
    click(b, 5.75);
    at(b, 6.4, { ui: "pickerType" });
    click(b, 6.55);
    at(b, 7.05, { ui: "pickerStop" });
    at(b, 7.2, { ui: "pickerStop" });
    at(b, 7.85, { ui: "pickerStop", dx: 46 });
    b.press.push([7.2, 7.9]);
    at(b, 8.4, { ui: "pickerClose" });
    click(b, 8.55);
    at(b, 9.1, { ui: "fxAdd" });
    click(b, 9.25);
    at(b, 9.8, { ui: "fxType" });
    click(b, 9.95);
    at(b, 10.6, { ui: "agents" });
    click(b, 10.75);
    at(b, 11.3, { ui: "composer" });
    click(b, 11.45);
    at(b, 13.3, { ui: "send" });
    click(b, 13.45);
    at(b, 16.6, { ui: "file" });
    click(b, 16.75);
    at(b, 17.4, { part: "frame", fx: 1, fy: 1, dx: -80, dy: 30 });
  } else at(b, 5.6, { part: "frame", fx: 1, fy: 1, dx: -60, dy: 24 });
  parts.card = { kind: "draw", t: 4.17, t1: 4.95, c: COLORS.burak };
  parts.gradient = { kind: "appear", t: PICKER.linear };
  parts.grain = { kind: "appear", t: FX.noise };
  parts.cursors = { kind: "agent", t: AGENT.steps[1], resolve: AGENT.resolve };

  // Kamila: the headline
  const [kam, ogu, yas, ozg, gor, ece] = TEAM.map((m) => P(m.name, m.color, m.join));
  at(kam, kam.join, { ui: "side", dx: -120, dy: 160 }, "text");
  at(kam, 5.4, { part: "title", fx: 0, fy: 0.1, dx: 2 });
  click(kam, 5.5);
  at(kam, 5.55, { part: "title", fx: 0, fy: 0.1, dx: 2 });
  at(kam, 5.8, { part: "title", fx: 0, fy: 0, dx: -34, dy: -26 });
  parts.title = { kind: "type", t: 5.8, ms: 55, c: kam.color };
  at(kam, 7.9, { part: "title", fx: 0, fy: 0, dx: -34, dy: -26 }, "arrow");

  // Oğuz: the blob, anchor by anchor with the pen
  at(ogu, ogu.join, { ui: "side", dx: 160, dy: -140 }, "pen");
  const clicks: number[] = [];
  [...BLOB, BLOB[0]].forEach((pt, i) => {
    const go = 6.0 + i * 0.4;
    at(ogu, go - 0.05, { art: pt });
    at(ogu, go + 0.05, { art: pt });
    click(ogu, go);
    clicks.push(go + 0.05);
  });
  parts.blob = { kind: "pen", clicks, c: ogu.color };
  at(ogu, 8.4, { art: [210, 120], dx: 0, dy: 0 }, "arrow");

  // Yasin: the ring, with the ellipse tool
  at(yas, yas.join, { ui: "side", dx: 220, dy: 80 }, "crosshair");
  at(yas, 6.6, { art: [335, 325] });
  at(yas, 6.72, { art: [335, 325] });
  at(yas, 7.35, { art: [545, 535] });
  yas.press.push([6.7, 7.4]);
  parts.ring = { kind: "draw", t: 6.72, t1: 7.35, c: yas.color };
  at(yas, 7.5, { art: [545, 535] }, "arrow");
  at(yas, 8.1, { art: [560, 470] });

  // Özge: Try it — drawn, then labelled — and the link under it
  at(ozg, ozg.join, { ui: "side", dx: -60, dy: 220 }, "crosshair");
  at(ozg, 7.2, { part: "try", fx: 0, fy: 0 });
  at(ozg, 7.27, { part: "try", fx: 0, fy: 0 });
  at(ozg, 7.7, { part: "try", fx: 1, fy: 1 });
  ozg.press.push([7.25, 7.75]);
  parts.try = { kind: "draw", t: 7.27, t1: 7.7, c: ozg.color };
  at(ozg, 7.9, { part: "try", fx: 1, fy: 1 }, "text");
  at(ozg, 8.05, { part: "try", fx: 0.35, fy: 0.5 });
  click(ozg, 8.1);
  at(ozg, 8.2, { part: "try", fx: 0.35, fy: 0.5 });
  at(ozg, 8.35, { part: "try", fx: 0.5, fy: 1, dx: 0, dy: 26 });
  parts.trylabel = { kind: "type", t: 8.3, ms: 80, c: ozg.color };
  parts.link = { kind: "appear", t: 9.1 };
  at(ozg, 9.2, { part: "try", fx: 0.5, fy: 1, dx: 0, dy: 26 }, "arrow");

  // Görkem: the wave, three anchors dragged into curves with the pen
  at(gor, gor.join, { ui: "side", dx: 260, dy: 240 }, "pen");
  const drags: [number, number][] = [];
  WAVE.p.forEach((pt, i) => {
    const go = 7.8 + i * 0.85;
    at(gor, go, { art: pt });
    at(gor, go + 0.06, { art: pt });
    at(gor, go + 0.4, { art: WAVE.h[i] });
    gor.press.push([go + 0.05, go + 0.45]);
    drags.push([go + 0.06, go + 0.4]);
  });
  parts.wave = { kind: "curve", drags, c: gor.color };
  at(gor, 10.4, { art: [600, 590] }, "arrow");

  // Ece: the star
  at(ece, ece.join, { ui: "side", dx: -200, dy: -60 }, "crosshair");
  at(ece, 8.4, { art: [93, 373] });
  at(ece, 8.52, { art: [93, 373] });
  at(ece, 9.1, { art: [257, 520] });
  ece.press.push([8.5, 9.15]);
  parts.star = { kind: "draw", t: 8.52, t1: 9.1, c: ece.color };
  at(ece, 9.3, { art: [257, 520] }, "arrow");
  at(ece, 9.9, { art: [60, 330] });

  for (const p of people) p.keys.sort((x, y) => x.t - y.t);
  return { people, parts, draw: [1.82, 2.8], card: [4.17, 4.95] };
}

// ── The scene ────────────────────────────────────────────────────────────────────────────────────────────────────

interface UI {
  tool: ToolId;
  people: number;
  rows: string;
  sel: "none" | "frame" | "card";
  w: number;
  h: number;
  caption: "frame" | "multiplayer" | "ai" | "scroll" | null;
  picker: boolean;
  gradient: boolean;
  stop: number;
  fx: "none" | "shadow" | "noise";
  tab: "file" | "agents";
  ask: string;
  sent: boolean;
  steps: string;
  done: boolean;
}

const ROW_OF: Record<string, { name: string; icon: Row["icon"] }> = {
  card: { name: "Poster", icon: "16.rectangle" },
  blob: { name: "Blob", icon: "16.vector" },
  ring: { name: "Ellipse", icon: "16.ellipse" },
  star: { name: "Star", icon: "16.star" },
  wave: { name: "Wave", icon: "16.vector" },
  cursors: { name: "Cursors", icon: "16.group" },
  title: { name: "Design, together, on your desktop.", icon: "16.text" },
  try: { name: "Try it", icon: "16.frame" },
  link: { name: "Or download it…", icon: "16.text" },
};

export default function HeroScene() {
  const root = useRef<HTMLDivElement>(null);
  const left = useRef<HTMLDivElement>(null);
  const right = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const sel = useRef<HTMLDivElement>(null);
  const caption = useRef<HTMLDivElement>(null);
  const cursors = useRef<HTMLDivElement>(null);
  const pickerBox = useRef<HTMLDivElement>(null);
  const [geo, setGeo] = useState<Geo | null>(null);
  const [ui, setUI] = useState<UI>({ tool: "move", people: 0, rows: "", sel: "none", w: 0, h: 0, caption: null, picker: false, gradient: false, stop: 0.5, fx: "none", tab: "file", ask: "", sent: false, steps: "", done: false });

  useEffect(() => {
    const el = root.current;
    const hero = document.querySelector<HTMLElement>("[data-hero]");
    const sticky = document.querySelector<HTMLElement>("[data-hero-sticky]");
    const frame = document.querySelector<HTMLElement>("[data-hero-frame]");
    const bg = document.querySelector<HTMLElement>("[data-hero-bg]");
    const dock = document.querySelector<HTMLElement>("[data-dock]");
    const edit = document.querySelector<SVGGElement>("#pa-edit");
    const html = document.documentElement;
    if (!el || !hero || !sticky || !frame || !bg) return;
    if (prefersReduced() || !html.classList.contains("hero-anim")) {
      html.classList.remove("hero-anim");
      return;
    }

    // ── Measuring ──
    let k = { s: 1, x: 0, y: 0 };
    let g: Geo | null = null;
    let story = plan({ W: 1, H: 1, panels: false, toolbar: false, s0: 1, x0: 0, y0: 0, parts: {}, art: null, ui: {} });
    const els: Partial<Record<PartId, HTMLElement | SVGElement>> = {};
    const uiSpots: Partial<Record<UiSpot, [number, number]>> = {};
    const UI_SEL: Partial<Record<UiSpot, string>> = {
      frameTool: '[data-ds="EditorToolbar"] button[aria-label="Frame"]',
      rectTool: '[data-ds="EditorToolbar"] button[aria-label="Rectangle"]',
      fill: '[data-hero-ui="fill"] button[aria-label$="pick colour"]',
      pickerType: '[data-hero-ui="picker"] [role="radiogroup"][aria-label="Fill type"] [role="radio"]:nth-child(2)',
      pickerStop: '[data-hero-ui="picker"] [aria-label="Stop 2"]',
      pickerClose: '[data-hero-ui="picker"] button[aria-label="Close"]',
      fxAdd: '[data-hero-ui="fx"] button[aria-label="Add effect"]',
      fxType: '[data-hero-ui="fx-type"]',
      agents: 'button[aria-label="Agents"]',
      file: 'button[aria-label="File"]',
      composer: `.${ai.composerText}`,
      send: `.${ai.send}`,
    };
    const measure = () => {
      const W = sticky.clientWidth;
      const H = sticky.clientHeight;
      const panelsOn = W >= 1024;
      const toolbarOn = W >= 640;
      const A = panelsOn ? { x: 345, y: 96, w: W - 345 - 288, h: H - 96 - 112 } : { x: 16, y: 72, w: W - 32, h: H - 72 - 72 };
      const s0 = Math.min(A.w / W, A.h / H);
      const fr = frame.getBoundingClientRect();
      const nat = (r: DOMRect): Rect => ({ x: (r.left - fr.left) / k.s, y: (r.top - fr.top) / k.s, w: r.width / k.s, h: r.height / k.s });
      const parts: Partial<Record<PartId, Rect>> = {};
      for (const id of Object.keys(PART_SEL) as PartId[]) {
        const e = frame.querySelector<HTMLElement | SVGElement>(PART_SEL[id]);
        if (!e) continue;
        els[id] = e;
        if (!SVG_PARTS.includes(id)) parts[id] = nat(e.getBoundingClientRect());
      }
      const svg = frame.querySelector<SVGSVGElement>(".poster-art");
      const art = svg ? nat(svg.getBoundingClientRect()) : null;
      if (art) {
        const u = art.w / 600;
        for (const id of SVG_PARTS) {
          const e = els[id] as SVGGraphicsElement | undefined;
          if (!e) continue;
          const bb = e.getBBox();
          parts[id] = { x: art.x + bb.x * u, y: art.y + bb.y * u, w: bb.width * u, h: bb.height * u };
        }
      }
      const sr = sticky.getBoundingClientRect();
      for (const [spot, q] of Object.entries(UI_SEL) as [UiSpot, string][]) {
        const e = el.querySelector<HTMLElement>(q);
        const r = e?.getBoundingClientRect();
        if (r && r.width) uiSpots[spot] = [r.left - sr.left + Math.min(r.width / 2, 14) + 2, r.top - sr.top + r.height / 2 + 2];
      }
      if (uiSpots.composer) uiSpots.composer = [uiSpots.composer[0] - 6, uiSpots.composer[1]];
      const next: Geo = { W, H, panels: panelsOn, toolbar: toolbarOn, s0, x0: Math.round(A.x + (A.w - W * s0) / 2), y0: Math.round(A.y + (A.h - H * s0) / 2), parts, art, ui: { ...uiSpots } };
      const changed = !g || g.W !== W || g.H !== H || JSON.stringify([g.parts, g.ui]) !== JSON.stringify([parts, next.ui]);
      g = next;
      if (changed) {
        story = plan(g);
        setGeo(g);
      }
    };

    // ── Cursors (plain DOM, placed on each frame) ──
    const curEls = new Map<string, { el: HTMLElement; art: HTMLElement; tool: CursorTool | null }>();
    const cursorOf = (p: Person) => {
      let c = curEls.get(p.name);
      if (!c) {
        const e = document.createElement("div");
        e.className = styles.cursor;
        const art = document.createElement("span");
        art.className = styles.art;
        const pill = document.createElement("span");
        pill.className = styles.pill;
        pill.style.background = p.color;
        pill.textContent = p.name;
        e.append(art, pill);
        cursors.current?.append(e);
        c = { el: e, art, tool: null };
        curEls.set(p.name, c);
      }
      return c;
    };
    const setTool = (c: { art: HTMLElement; tool: CursorTool | null }, tool: CursorTool, color: string) => {
      if (c.tool === tool) return;
      c.tool = tool;
      c.art.innerHTML =
        tool === "arrow"
          ? `<svg class="${styles.arrow}" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}"><path d="${ARROW_EDGE}" fill="#fff"/><path d="${ARROW}" fill="${color}"/></svg>`
          : `<svg class="${styles.toolArt}" width="24" height="24" viewBox="0 0 24 24" style="left:${-TOOL_ART[tool].hot[0]}px;top:${-TOOL_ART[tool].hot[1]}px">${TOOL_ART[tool].body}</svg>`;
    };

    // ── The parts (real elements), set from their state string only when it changes ──
    const states = new Map<PartId, string>();
    const typed = new Map<PartId, { span: HTMLElement; text: string }>();
    let blobD = "";
    const artPt = (p: readonly [number, number]) => `${p[0]} ${p[1]}`;
    const setPart = (id: PartId, state: string) => {
      const e = els[id];
      if (!e || states.get(id) === state) return;
      states.set(id, state);
      const [kind, arg] = state.split(":");
      const n = Number(arg);
      const plan = story.parts[id];
      const color = plan && "c" in plan ? plan.c : "#0d99ff";
      if (kind !== "type" && typed.has(id)) {
        typed.get(id)!.span.remove();
        typed.delete(id);
      }
      e.dataset.hp = kind === "pen" || kind === "curve" || kind === "agent" ? "shown" : kind;
      if (INTERACTIVE.includes(id) && e instanceof HTMLElement) e.inert = kind !== "shown";
      const style = e.style;
      style.clipPath = "";
      style.transform = "";
      if (id === "blob") {
        if (!blobD) blobD = e.getAttribute("d") ?? "";
        if (kind === "pen") {
          const pts = BLOB.slice(0, Math.min(BLOB.length, n));
          e.setAttribute("d", pts.length ? "M" + pts.map(artPt).join(" L") : "M0 0");
          e.setAttribute("fill", "none");
          e.setAttribute("stroke", color);
          e.setAttribute("stroke-width", "4");
        } else {
          e.setAttribute("d", blobD);
          e.setAttribute("fill", "#7B61FF");
          e.removeAttribute("stroke");
        }
        return;
      }
      if (id === "wave") {
        if (kind === "curve") {
          style.strokeDasharray = "1 1";
          style.strokeDashoffset = String(1 - n);
        } else {
          style.strokeDasharray = "";
          style.strokeDashoffset = "";
        }
        return;
      }
      if (id === "cursors") {
        const [, skel, res] = state.split(":");
        for (const c of e.querySelectorAll<SVGGElement>(".pa-cursor")) {
          const i = Number(c.dataset.i);
          const real = c.querySelector<SVGGElement>(".pa-real");
          const sk = c.querySelector<SVGElement>(".pa-skel");
          if (real) real.style.opacity = kind === "agent" ? (i < Number(res) ? "1" : "0") : kind === "off" ? "0" : "1";
          if (sk) sk.setAttribute("data-on", kind === "agent" && skel === "1" && i >= Number(res) ? "" : "x");
          if (sk) sk.style.opacity = kind === "agent" && skel === "1" && i >= Number(res) ? "1" : "0";
        }
        e.dataset.hp = kind === "off" ? "off" : "shown";
        return;
      }
      if (kind === "draw") {
        e.style.setProperty("--hp-c", color);
        if (e instanceof SVGElement) {
          style.transformBox = "fill-box";
          style.transformOrigin = "0 0";
          style.transform = `scale(${Math.max(0.001, n)})`;
          e.setAttribute("stroke", color);
          e.setAttribute("stroke-width", "3");
          e.setAttribute("vector-effect", "non-scaling-stroke");
        } else style.clipPath = `inset(0 ${(1 - n) * 100}% ${(1 - n) * 100}% 0 round 2px)`;
      } else if (e instanceof SVGElement) {
        e.removeAttribute("stroke");
        e.removeAttribute("stroke-width");
      }
      if (kind === "type" && e instanceof HTMLElement) {
        let tp = typed.get(id);
        if (!tp) {
          const span = document.createElement("span");
          span.className = "hero-typed";
          span.setAttribute("aria-hidden", "true");
          tp = { span, text: (e.textContent ?? "").replace(/[ \t\n\r]+/g, " ").trim() };
          e.append(span);
          typed.set(id, tp);
        }
        tp.span.textContent = "";
        tp.span.append(tp.text.slice(0, n));
        const caret = document.createElement("i");
        caret.className = "hero-caret";
        if (n < tp.text.length) caret.dataset.typing = "";
        const rest = document.createElement("span");
        rest.className = "hero-rest";
        rest.textContent = tp.text.slice(n);
        tp.span.append(caret, rest);
        e.style.setProperty("--hp-c", color);
      }
    };
    const textLen = (id: PartId) => typed.get(id)?.text.length ?? (els[id]?.textContent ?? "").replace(/[ \t\n\r]+/g, " ").trim().length;
    const partState = (id: PartId, t: number): string => {
      const p = story.parts[id];
      if (!p) return "shown";
      switch (p.kind) {
        case "appear":
          return t >= p.t ? "shown" : "off";
        case "draw":
          if (t < p.t) return "off";
          if (t >= p.t1 + 0.1) return "shown";
          return `draw:${ease(clamp((t - p.t) / (p.t1 - p.t))).toFixed(3)}`;
        case "type": {
          if (t < p.t - 0.05) return "off";
          const n = Math.floor((t - p.t) / (p.ms / 1000));
          const len = textLen(id);
          return n >= len + 4 ? "shown" : `type:${Math.min(len, Math.max(0, n))}`;
        }
        case "pen": {
          const n = p.clicks.filter((c) => t >= c).length;
          if (n === 0) return "off";
          return n > BLOB.length ? "shown" : `pen:${n}`;
        }
        case "curve": {
          const [a, b] = [p.drags[1], p.drags[2]];
          if (t < p.drags[0][0]) return "off";
          if (t >= b[1] + 0.1) return "shown";
          const q = t < a[0] ? 0 : t < a[1] ? (t - a[0]) / (a[1] - a[0]) * 0.5 : t < b[0] ? 0.5 : 0.5 + ((t - b[0]) / (b[1] - b[0])) * 0.5;
          return `curve:${ease(clamp(q)).toFixed(3)}`;
        }
        case "agent": {
          if (t < p.t) return "off";
          const res = p.resolve.filter((x) => t >= x).length;
          return res >= p.resolve.length ? "shown" : `agent:1:${res}`;
        }
      }
    };
    /** The pen's marks: the anchors placed so far (and the handle being dragged). */
    let lastEdit = "";
    const drawEdit = (t: number) => {
      if (!edit) return;
      let svg = "";
      const blob = story.parts.blob;
      if (blob && blob.kind === "pen") {
        const n = blob.clicks.filter((c) => t >= c).length;
        if (n > 0 && n <= BLOB.length) svg += BLOB.slice(0, n).map((p) => `<rect x="${p[0] - 7}" y="${p[1] - 7}" width="14" height="14" />`).join("");
      }
      const wave = story.parts.wave;
      if (wave && wave.kind === "curve") {
        wave.drags.forEach(([a, b], i) => {
          if (t < a || t > b + 0.3) return;
          const q = ease(clamp((t - a) / (b - a)));
          const p = WAVE.p[i];
          const h = [lerp(p[0], WAVE.h[i][0], q), lerp(p[1], WAVE.h[i][1], q)];
          const m = [2 * p[0] - h[0], 2 * p[1] - h[1]];
          svg += `<line x1="${m[0]}" y1="${m[1]}" x2="${h[0]}" y2="${h[1]}" /><rect x="${p[0] - 7}" y="${p[1] - 7}" width="14" height="14" /><circle cx="${h[0]}" cy="${h[1]}" r="6" fill="#0d99ff" /><circle cx="${m[0]}" cy="${m[1]}" r="6" fill="#0d99ff" />`;
        });
      }
      if (svg !== lastEdit) {
        lastEdit = svg;
        edit.innerHTML = svg;
      }
    };

    // ── Points ──
    const point = (s: Spot): [number, number] => {
      if (!g) return [0, 0];
      if ("ui" in s) {
        const base: [number, number] =
          s.ui === "start" ? [g.W / 2 + 80, g.H - 150] : s.ui === "side" ? [g.x0 + g.W * g.s0 * 0.5, g.y0 + g.H * g.s0 * 0.5] : g.ui[s.ui] ?? [g.W / 2, g.H / 2];
        return [base[0] + (s.dx ?? 0), base[1] + (s.dy ?? 0)];
      }
      if ("art" in s) {
        if (!g.art) return [k.x, k.y];
        const u = g.art.w / 600;
        return [k.x + (g.art.x + s.art[0] * u) * k.s + (s.dx ?? 0), k.y + (g.art.y + s.art[1] * u) * k.s + (s.dy ?? 0)];
      }
      const r = s.part === "frame" ? { x: 0, y: 0, w: g.W, h: g.H } : g.parts[s.part];
      if (!r) return [k.x, k.y];
      return [k.x + (r.x + r.w * s.fx) * k.s + (s.dx ?? 0), k.y + (r.y + r.h * s.fy) * k.s + (s.dy ?? 0)];
    };

    // ── The clock: t = the scroll's share + what played by itself (spent first when scrolling back) ──
    let played = 0;
    let lastP = -1;
    let last = performance.now();
    let visible = true;
    const io = new IntersectionObserver(([e]) => (visible = e.isIntersecting), { threshold: 0.05 });
    io.observe(sticky);
    let raf = 0;
    let lastUI = "";
    let open: boolean | null = null;
    let measuredAt = 0;

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      if (!g || now - measuredAt > 300) {
        measuredAt = now;
        measure();
      }
      if (!g) return;
      const track = hero.offsetHeight - g.H;
      const p = track > 0 ? clamp((window.scrollY - hero.offsetTop) / track) : 0;
      const rate = T_BUILD / BUILD_P;
      if (lastP >= 0 && p < lastP) played = Math.max(0, played - (lastP - p) * rate);
      lastP = p;
      const scrolled = Math.min(p, BUILD_P) * rate;
      if (visible && !document.hidden && p < BUILD_P && scrolled + played < T_BUILD) played += dt;
      const t = clamp(scrolled + played, 0, T_BUILD);
      const r = clamp((p - REVEAL_P0) / (REVEAL_P1 - REVEAL_P0));
      const e = ease(r);

      // The frame: the page-top at the canvas's scale, opening to the page
      k = { s: lerp(g.s0, 1, e), x: lerp(g.x0, 0, e), y: lerp(g.y0, 0, e) };
      const isOpen = r >= 1;
      if (isOpen !== open) {
        open = isOpen;
        html.classList.toggle("hero-open", open);
        sticky.toggleAttribute("data-you-tile", !open);
      }
      frame.style.transform = open ? "none" : `translate(${k.x}px, ${k.y}px) scale(${k.s})`;
      if (!("ready" in frame.dataset)) {
        frame.dataset.ready = "";
        requestAnimationFrame(() => requestAnimationFrame(() => (frame.dataset.live = "")));
      }
      const [d0, d1] = story.draw;
      const dp = ease(clamp((t - d0) / (d1 - d0)));
      bg.style.transform = dp >= 1 ? "none" : `scale(${Math.max(0.001, dp)})`;
      bg.style.opacity = dp > 0 ? "1" : "0";
      bg.style.boxShadow = r < 1 ? `0 0 0 ${1 / k.s}px var(--site-piece-line)` : "";
      for (const id of Object.keys(PART_SEL) as PartId[]) setPart(id, r > 0 ? "shown" : partState(id, t));
      drawEdit(r > 0 ? 99 : t);

      // The editor around it
      const out = ease(clamp(r / 0.8));
      if (left.current) left.current.style.transform = `translateX(${-340 * out}px)`;
      if (right.current) right.current.style.transform = `translateX(${280 * out}px)`;
      if (pickerBox.current) pickerBox.current.style.transform = `translateX(${280 * out}px)`;
      const fadeChrome = 1 - clamp(r / 0.25);
      const [c0, c1] = story.card;
      const onCard = t >= c0 && g.parts.card;
      if (sel.current) {
        const show = t >= d0 && fadeChrome > 0;
        sel.current.style.opacity = show ? String(fadeChrome) : "0";
        let box: Rect;
        if (onCard && g.parts.card) {
          const c = g.parts.card;
          const q = t < c1 ? ease(clamp((t - c0) / (c1 - c0))) : 1;
          box = { x: k.x + c.x * k.s, y: k.y + c.y * k.s, w: c.w * k.s * q, h: c.h * k.s * q };
        } else box = { x: k.x, y: k.y, w: g.W * k.s * (t < d1 ? dp : 1), h: g.H * k.s * (t < d1 ? dp : 1) };
        sel.current.style.transform = `translate(${box.x}px, ${box.y}px)`;
        sel.current.style.width = `${box.w}px`;
        sel.current.style.height = `${box.h}px`;
      }
      if (caption.current) caption.current.style.opacity = String(fadeChrome);

      // The toolbar becomes the dock (and back)
      const m = clamp((r - 0.45) / 0.55);
      const tbEl = bar.current?.querySelector<HTMLElement>('[data-ds="EditorToolbar"]');
      const tbW = tbEl?.offsetWidth || 530;
      const dkW = dock?.offsetWidth || 480;
      if (bar.current) {
        bar.current.style.opacity = String(1 - clamp(m * 1.6));
        bar.current.style.transform = `translateX(-50%) scaleX(${lerp(1, dkW / tbW, ease(m))})`;
      }
      if (dock) {
        if (open) {
          dock.style.opacity = "";
          dock.style.transform = "";
          dock.style.pointerEvents = "";
          dock.inert = false;
        } else {
          const shown = g.toolbar ? clamp(m * 1.6 - 0.6) : clamp(r * 2 - 1);
          dock.style.opacity = String(shown);
          dock.style.transform = g.toolbar ? `translateX(-50%) scaleX(${lerp(tbW / dkW, 1, ease(m))})` : "";
          dock.style.pointerEvents = shown > 0.5 ? "auto" : "none";
          dock.inert = shown < 0.5;
        }
      }

      // Cursors
      for (const person of story.people) {
        const c = cursorOf(person);
        const keys = person.keys;
        let i = 0;
        while (i < keys.length - 1 && keys[i + 1].t <= t) i++;
        const a = keys[i];
        const b = keys[i + 1];
        let pt = point(a.at);
        if (b && t > a.t) {
          const q = ease(clamp((t - a.t) / (b.t - a.t)));
          const pb = point(b.at);
          const bow = Math.sin(q * Math.PI) * 0.06;
          const dx = pb[0] - pt[0];
          const dy = pb[1] - pt[1];
          pt = [pt[0] + dx * q - dy * bow, pt[1] + dy * q + dx * bow];
        }
        let tool: CursorTool = "arrow";
        for (const key of keys) if (key.t <= t && key.tool) tool = key.tool;
        setTool(c, tool, person.color);
        c.el.style.opacity = String(clamp((t - person.join) / 0.25) * fadeChrome);
        c.el.style.transform = `translate3d(${pt[0]}px, ${pt[1]}px, 0)`;
        c.el.toggleAttribute("data-press", person.press.some(([p0, p1]) => t >= p0 && t <= p1));
      }

      // What the panels show (only when it changes)
      const made = (Object.keys(ROW_OF) as PartId[]).filter((id) => story.parts[id] && partState(id, t) !== "off");
      const at0 = (id: PartId) => {
        const pl = story.parts[id]!;
        return "t" in pl ? pl.t : pl.kind === "pen" ? pl.clicks[0] : pl.kind === "curve" ? pl.drags[0][0] : 0;
      };
      made.sort((x, y) => at0(y) - at0(x));
      const stopQ = ease(clamp((t - PICKER.drag[0]) / (PICKER.drag[1] - PICKER.drag[0])));
      const steps = t < AGENT.steps[0] ? "" : AGENT_STEP_NAMES.map((n, j) => (t >= AGENT.steps[j] ? `${n}${j < AGENT.steps.length - 1 && t >= AGENT.steps[j + 1] ? "+" : t >= AGENT.done ? "+" : ""}` : "")).filter(Boolean).join(",");
      const next: UI = {
        tool: !g.toolbar ? "move" : t >= 1.1 && t < 2.9 ? "frame" : t >= 3.6 && t < 5.05 ? "rectangle" : "move",
        people: TEAM.filter((x) => t >= x.join).length,
        rows: made.join(","),
        sel: t >= c0 ? "card" : t >= d0 ? "frame" : "none",
        w: Math.round(t >= c0 && g.parts.card ? g.parts.card.w * (t < c1 ? ease(clamp((t - c0) / (c1 - c0))) : 1) : g.W * (t < d1 ? dp : 1)),
        h: Math.round(t >= c0 && g.parts.card ? g.parts.card.h * (t < c1 ? ease(clamp((t - c0) / (c1 - c0))) : 1) : g.H * (t < d1 ? dp : 1)),
        caption: t < 0.2 ? null : t < 4.5 ? "frame" : t < 10.5 ? "multiplayer" : t < T_BUILD - 0.6 ? "ai" : "scroll",
        picker: g.panels && t >= PICKER.open && t < PICKER.close && r === 0,
        gradient: t >= PICKER.linear,
        stop: Math.round((0.5 + 0.2 * stopQ) * 100) / 100,
        fx: t >= FX.noise ? "noise" : t >= FX.add ? "shadow" : "none",
        tab: t >= TAB_AGENTS && t < AGENT.back ? "agents" : "file",
        ask: t < AGENT.ask ? "" : t >= AGENT.send ? "" : ASK.slice(0, Math.floor((t - AGENT.ask) / 0.04)),
        sent: t >= AGENT.send,
        steps,
        done: t >= AGENT.done,
      };
      const key = JSON.stringify(next);
      if (key !== lastUI) {
        lastUI = key;
        setUI(next);
      }
    };
    raf = requestAnimationFrame(tick);
    const onResize = () => (measuredAt = 0);
    window.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
      window.removeEventListener("resize", onResize);
      for (const c of curEls.values()) c.el.remove();
      for (const tp of typed.values()) tp.span.remove();
    };
  }, []);

  const g = geo;
  const rowIds = ui.rows ? ui.rows.split(",") : [];
  const rows: Row[] = [
    { id: "home", name: "Home", icon: "16.frame", strong: true, expanded: rowIds.length > 0, selected: ui.sel === "frame", hidden: ui.sel === "none" },
    ...rowIds.map((id) => ({ id, name: ROW_OF[id].name, icon: ROW_OF[id].icon, depth: 1, selected: id === "card" && ui.sel === "card" })),
    ...Object.keys(ROW_OF)
      .filter((id) => !rowIds.includes(id))
      .map((id) => ({ id, name: ROW_OF[id].name, icon: ROW_OF[id].icon, depth: 1, hidden: true })),
  ];
  const steps: Step[] = ui.steps ? ui.steps.split(",").map((s) => ({ name: s.replace("+", ""), done: s.endsWith("+") })) : [];
  const paint: PickerPaint = ui.gradient
    ? { type: "GRADIENT_LINEAR", stops: [{ position: 0, color: { r: 1, g: 0.82, b: 0.9, a: 1 } }, { position: ui.stop, color: { r: 0.79, g: 0.83, b: 1, a: 1 } }, { position: 1, color: { r: 1, g: 0.88, b: 0.69, a: 1 } }] }
    : { type: "SOLID", color: { r: 0.9, g: 0.9, b: 0.9, a: 1 } };

  const label: Record<NonNullable<UI["caption"]>, string> = { frame: "Frame", multiplayer: "Multiplayer", ai: "AI agents", scroll: "Scroll to open it" };
  return (
    <div ref={root} className={styles.root}>
      {g && (
        <div ref={caption} className={styles.captions} style={{ left: g.x0, top: Math.max(16, g.y0 - 52) }}>
          {(Object.keys(label) as NonNullable<UI["caption"]>[]).map((id) => (
            <span key={id} className={styles.caption} data-on={ui.caption === id || undefined}>
              {label[id]}
            </span>
          ))}
        </div>
      )}

      <div ref={sel} className={styles.selection}>
        <span className={styles.frameName}>{ui.sel === "card" ? "Poster" : "Home"}</span>
        <b data-h="tl" />
        <b data-h="tr" />
        <b data-h="bl" />
        <b data-h="br" />
        <span className={styles.size}>
          {ui.w} × {ui.h}
        </span>
      </div>

      {g?.panels && (
        <>
          <div ref={left} className={`${styles.piece} ${styles.leftPiece}`} style={{ left: 24, top: 24, width: 297, height: g.H - 48 }}>
            <Rail label="Navigation" labels={false}>
              <RailItem compact icon="24.figma" label="Main menu" active={false} />
              <RailSeparator />
              <RailItem icon="24.page" label="File" active={ui.tab === "file"} />
              <RailItem icon="24.agents" label="Agents" active={ui.tab === "agents"} />
              <RailItem icon="24.assets" label="Assets" active={false} />
              <RailItem icon="24.tools" label="Tools" active={false} />
              <RailSeparator />
              <RailItem icon="24.variables" label="Variables" active={false} />
            </Rail>
            <div className={styles.leftCol}>
              {ui.tab === "file" ? (
                <>
                  <FileHeader name="Wecra — Website" />
                  <Layers rows={rows} />
                </>
              ) : (
                <ChatPanel composer={ui.ask || "Ask for changes, or describe what to make"} agent="Claude Code">
                  {ui.sent && <UserMessage>{ASK}</UserMessage>}
                  {steps.length > 0 && (
                    <div className={agents.agent}>
                      <span className={agents.agentName}>Claude Code</span>
                      <Steps steps={steps} />
                      {ui.done && <AgentText>Drew three cursors with name pills in the gradient, as vectors in a “Cursors” group.</AgentText>}
                    </div>
                  )}
                </ChatPanel>
              )}
            </div>
          </div>
          <div ref={right} className={styles.piece} style={{ left: g.W - 264, top: 24, width: 240, height: g.H - 48 }}>
            <div className={styles.rightCol}>
              <div className={panels.rightHeader}>
                <span className={`${mp.facepile} ${styles.pile}`}>
                  {TEAM.slice(0, ui.people).slice(-4).map((p) => (
                    <span key={p.name} className={`${mp.face} ${styles.face}`} style={{ ["--peer" as string]: p.color }}>
                      <span className={mp.bar} />
                      <span className={mp.ring}>
                        <Avatar name={p.name} size={24} />
                      </span>
                    </span>
                  ))}
                  {ui.people > 4 && <span className={styles.more}>+{ui.people - 4}</span>}
                  <span className={`${mp.face} ${styles.me}`}>
                    <span className={mp.ring}>
                      <Avatar name="Burak" size={24} />
                    </span>
                  </span>
                </span>
                <span className={panels.grow} />
                <Button variant="primary" size="large" className={panels.share}>
                  Share
                </Button>
              </div>
              <div className={panels.rightTabs}>
                <Tabs label="Panels" value="design" tabs={[{ value: "design", label: "Design" }, { value: "prototype", label: "Prototype" }]} onChange={noop} />
                <span className={panels.zoom}>
                  <span>{Math.round(g.s0 * 100)}%</span>
                  <Icon name="16.chevron.down" />
                </span>
              </div>
              <DesignBody ui={ui} />
            </div>
          </div>
          {ui.picker && (
            <div ref={pickerBox} className={styles.picker} data-hero-ui="picker" style={{ left: g.W - 264 - 248, top: 180 }}>
              <ColorPicker static value={paint} anchor={null} onChange={noop} onClose={noop} stop={1} />
            </div>
          )}
        </>
      )}

      {g?.toolbar && (
        <div ref={bar} className={styles.bar}>
          <EditorToolbar floating tool={ui.tool} mode="design" onMode={noop} onTool={noop} />
        </div>
      )}

      <div ref={cursors} className={styles.cursors} />
    </div>
  );
}

const AGENT_STEP_NAMES = ["get_metadata", "create_nodes", "apply_style"];

/** The Design panel for Burak's selection: the frame, then the card (its fill and effects as he sets them). */
function DesignBody({ ui }: { ui: UI }): ReactNode {
  if (ui.sel === "none") return <FillSection title="Page" label="Page colour" hex="F5F5F5" />;
  const card = ui.sel === "card";
  return (
    <>
      <PanelSection title={card ? "Rectangle" : "Frame"} pad="none" actions={<IconButton icon="24.component.small" label="Create component" tone="secondary" />} />
      <PanelSection title="Layout" actions={card ? undefined : <ToggleIconButton icon="24.autolayout-add-vertical" label="Use auto layout" tone="secondary" pressed={false} onPressedChange={noop} />}>
        <PropertyGrid>
          <PropertyRow>
            <Num label="Width" prefix="W" value={ui.w} ms={0} />
            <Num label="Height" prefix="H" value={ui.h} ms={0} />
          </PropertyRow>
        </PropertyGrid>
      </PanelSection>
      <div data-hero-ui="fill">
        <PanelSection title="Fill" actions={<IconButton icon="24.plus.small" label="Add fill" tone="secondary" />}>
          <PropertyGrid>
            <PropertyRow span={2} action={<IconButton icon="24.eye.small" label="Hide fill" tone="secondary" />}>
              {card && ui.gradient ? (
                <ColorInput label="Fill" color="FFD1E6" opacity={100} valueLabel="Linear" onColor={noop} onOpacity={noop} />
              ) : (
                <ColorInput label="Fill" color={card ? "E6E6E6" : "FFFFFF"} opacity={100} onColor={noop} onOpacity={noop} />
              )}
            </PropertyRow>
          </PropertyGrid>
        </PanelSection>
      </div>
      {card && (
        <div data-hero-ui="fx">
          <PanelSection title="Effects" actions={<IconButton icon="24.plus.small" label="Add effect" tone="secondary" />}>
            {ui.fx !== "none" && (
              <PropertyGrid>
                <PropertyRow span={2} action={<IconButton icon="24.eye.small" label="Hide effect" tone="secondary" />}>
                  <span data-hero-ui="fx-type" className={styles.fxType}>
                    <Select
                      label="Effect type"
                      value={ui.fx === "noise" ? "NOISE" : "DROP_SHADOW"}
                      options={[
                        { value: "DROP_SHADOW", label: "Drop shadow" },
                        { value: "NOISE", label: "Noise" },
                      ]}
                      onChange={noop}
                    />
                  </span>
                </PropertyRow>
              </PropertyGrid>
            )}
          </PanelSection>
        </div>
      )}
    </>
  );
}
