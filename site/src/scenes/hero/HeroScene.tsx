// The home page's top (docs/site.md §2.1): the editor around a frame, and in the frame this page's own poster — a
// grainy gradient card, a dozen grainy vector shapes, the headline, Try it — as real DOM laid out at the page's width
// (index.html, `[data-hero-frame]`; the frame is that page-top at a smaller scale). Burak draws the frame and the card
// and sets its fill (the app's ColorPicker, a gradient) and grain (Effects › Noise) in the Design panel; six
// teammates make the rest at once under their own cursors (pen and shape tools, typing), each drawing a second shape
// and nudging things after their first job. Then Burak asks the agent to make the shapes react, and from then on they
// are physical: they drift, and cursors push them (the teammates', then the visitor's own mouse), they collide with
// each other, the poster's edges and the text, and settle back home. Scrolling opens the frame into the page (the
// panels slide away, its transform goes to none, the toolbar becomes the dock) — and back.
//
// Everything but the physics is a function of two numbers, so scroll scrubs it both ways:
//   t  the build, s: it plays by itself while the visitor doesn't scroll; scrolling nudges it on (gently: the build
//      range of the track adds only part of it) or back, and it never races (t moves at most RATE s per second)
//   r  the reveal, 0…1: the scroll through the track's second part, both ways, once the build is done
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
import { SHAPES, type ShapeDef } from "./shapes";
import styles from "./hero.module.css";

// ── The timeline ─────────────────────────────────────────────────────────────────────────────────────────────────

const T_BUILD = 18;
/** The track (scroll progress 0…1): [0, BUILD_P] nudges the build by up to T_SCROLL s; [REVEAL_P0, REVEAL_P1] the reveal. */
const BUILD_P = 0.5;
const T_SCROLL = 7;
const REVEAL_P0 = 0.56;
const REVEAL_P1 = 0.93;
/** The build never moves faster than this (s per s), the reveal than R_RATE per s: scrolling helps, never races. */
const RATE = 3;
const R_RATE = 1.6;

const ASK = "Make the shapes react to the cursor";
const AGENT = { ask: 11.6, send: 13.45, steps: [13.7, 14.3, 15.1], done: 16.1, back: 16.75 };
const PICKER = { open: 5.85, linear: 6.4, drag: [6.75, 7.2] as const, close: 7.7 };
const FX = { add: 8.35, noise: 9.05 };
const TAB_AGENTS = 10.85;

type PartId = "card" | "gradient" | "grain" | "title" | "try" | "trylabel" | "link" | string;
const PART_SEL: Record<string, string> = {
  card: ".poster-card",
  gradient: ".poster-fill",
  grain: ".poster-grain",
  title: "#hero-title",
  try: '[data-part="try"]',
  trylabel: '[data-part="trylabel"]',
  link: '[data-part="link"]',
  ...Object.fromEntries(SHAPES.map((s) => [s.id, `#ps-${s.id} > .ps-in`])),
};
const SHAPE_OF = new Map(SHAPES.map((s) => [s.id, s]));
const INTERACTIVE: PartId[] = ["try", "link"];

type Rect = { x: number; y: number; w: number; h: number };
type Plan =
  | { kind: "appear"; t: number }
  | { kind: "type"; t: number; ms: number; c: string }
  | { kind: "draw"; t: number; t1: number; c: string }
  | { kind: "pen"; clicks: number[]; c: string }
  | { kind: "curve"; drags: [number, number][]; c: string };

type UiSpot = "frameTool" | "rectTool" | "fill" | "pickerType" | "pickerStop" | "pickerClose" | "fxAdd" | "fxType" | "agents" | "file" | "composer" | "send" | "start" | "side";
type Spot =
  | { part: PartId | "frame"; fx: number; fy: number; dx?: number; dy?: number }
  /** On a shape: a point in its local units (≈ ±50) */
  | { shape: string; lx: number; ly: number; dx?: number; dy?: number }
  | { ui: UiSpot; dx?: number; dy?: number };
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
  /** After the build: the shapes this one keeps playing with */
  plays: string[];
}
/** A shape moved by someone: its home shifts by (dx, dy) local units over [t0, t1] */
interface Nudge {
  id: string;
  t0: number;
  t1: number;
  dx: number;
  dy: number;
}

/** Oğuz's comments: a pin by a shape (local units from its home) and a thread typed into a bubble, maybe answered. */
interface Comment {
  on: string;
  lx: number;
  ly: number;
  t: number;
  text: string;
  typing: [number, number];
  close: number;
  reply?: { name: string; color: string; text: string; t: number };
}

const ease = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const toward = (v: number, target: number, max: number) => (Math.abs(target - v) <= max ? target : v + Math.sign(target - v) * max);

interface Geo {
  W: number;
  H: number;
  panels: boolean;
  toolbar: boolean;
  s0: number;
  x0: number;
  y0: number;
  parts: Partial<Record<PartId, Rect>>;
  /** The card (natural px) and the text's boxes inside it (card px): the shapes' world and its obstacles */
  card: Rect | null;
  text: Rect[];
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

/** A shape's home on a card of w × h (card px) and its scale (px per local unit). */
function homeOf(s: ShapeDef, w: number, h: number): { x: number; y: number; k: number } {
  const [fx, fy] = w >= h ? s.L : s.P;
  return { x: fx * w, y: fy * h, k: (s.size * Math.min(w, h)) / 788 };
}
/** Curves' anchors and handles (local units), as the pen drags them out. */
const CURVE: Record<string, { p: [number, number][]; h: [number, number][] }> = {
  wave: { p: [[-100, 0], [0, 0], [100, 0]], h: [[-60, -40], [40, -40], [140, 40]] },
  squig: { p: [[-80, 0], [0, 0], [80, 0]], h: [[-60, -30], [20, -30], [100, 30]] },
};

/** Who makes what, when (seconds), on this screen. */
function plan(g: Geo): { people: Person[]; parts: Partial<Record<PartId, Plan>>; nudges: Nudge[]; comments: Comment[]; draw: [number, number]; card: [number, number] } {
  const parts: Partial<Record<PartId, Plan>> = {};
  const people: Person[] = [];
  const nudges: Nudge[] = [];
  const P = (name: string, color: string, join: number) => {
    const p: Person = { name, color, join, keys: [], press: [], plays: [] };
    people.push(p);
    return p;
  };
  const at = (p: Person, t: number, s: Spot, tool?: CursorTool) => p.keys.push({ t, at: s, tool });
  const click = (p: Person, t: number) => p.press.push([t, t + 0.12]);
  const ui = g.panels;

  // ── Burak: the frame, the card, its fill and grain (the Design panel), then the agent ──
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
    at(b, 6.15, { ui: "pickerType" });
    click(b, 6.28);
    at(b, 6.6, { ui: "pickerStop" });
    at(b, 6.75, { ui: "pickerStop" });
    at(b, 7.2, { ui: "pickerStop", dx: 40 });
    b.press.push([6.72, 7.25]);
    at(b, 7.45, { ui: "pickerClose" });
    click(b, 7.56);
    at(b, 8.05, { ui: "fxAdd" });
    click(b, 8.22);
    at(b, 8.75, { ui: "fxType" });
    click(b, 8.92);
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

  // ── The shapes' makers' moves ──
  /** A shape dragged out from its box's top-left to bottom-right (rectangle, ellipse, star tools). */
  const drag = (p: Person, id: string, t0: number) => {
    const s = SHAPE_OF.get(id)!;
    const [bx, by, bw, bh] = s.box;
    at(p, t0 - 0.05, { shape: id, lx: bx, ly: by }, "crosshair");
    at(p, t0 + 0.08, { shape: id, lx: bx, ly: by });
    at(p, t0 + 0.6, { shape: id, lx: bx + bw, ly: by + bh });
    p.press.push([t0 + 0.05, t0 + 0.65]);
    parts[id] = { kind: "draw", t: t0 + 0.08, t1: t0 + 0.6, c: p.color };
    at(p, t0 + 0.7, { shape: id, lx: bx + bw, ly: by + bh }, "arrow");
    return t0 + 0.7;
  };
  /** A shape placed anchor by anchor with the pen, then closed on the first. */
  const pen = (p: Person, id: string, t0: number, step = 0.34) => {
    const s = SHAPE_OF.get(id)!;
    const pts = [...(s.pts ?? []), (s.pts ?? [])[0]];
    const clicks: number[] = [];
    pts.forEach(([x, y], i) => {
      const go = t0 + i * step;
      at(p, go - 0.06, { shape: id, lx: x, ly: y }, "pen");
      at(p, go + 0.05, { shape: id, lx: x, ly: y });
      click(p, go);
      clicks.push(go + 0.05);
    });
    parts[id] = { kind: "pen", clicks, c: p.color };
    const end = t0 + pts.length * step;
    at(p, end, { shape: id, lx: 0, ly: 60 }, "arrow");
    return end;
  };
  /** A curve: three anchors, each dragged into its handle with the pen. */
  const curve = (p: Person, id: string, t0: number) => {
    const c = CURVE[id];
    const drags: [number, number][] = [];
    c.p.forEach(([x, y], i) => {
      const go = t0 + i * 0.7;
      at(p, go, { shape: id, lx: x, ly: y }, "pen");
      at(p, go + 0.06, { shape: id, lx: x, ly: y });
      at(p, go + 0.38, { shape: id, lx: c.h[i][0], ly: c.h[i][1] });
      p.press.push([go + 0.05, go + 0.42]);
      drags.push([go + 0.06, go + 0.38]);
    });
    parts[id] = { kind: "curve", drags, c: p.color };
    const end = t0 + 2.2;
    at(p, end, { shape: id, lx: 0, ly: 50 }, "arrow");
    return end;
  };
  /** Someone picks a shape up and sets it down a little further (it moves with the cursor). */
  const nudge = (p: Person, id: string, t0: number, dx: number, dy: number) => {
    at(p, t0 - 0.05, { shape: id, lx: 0, ly: 0 }, "arrow");
    at(p, t0 + 0.08, { shape: id, lx: 0, ly: 0 });
    at(p, t0 + 0.6, { shape: id, lx: 0, ly: 0 });
    p.press.push([t0 + 0.05, t0 + 0.65]);
    nudges.push({ id, t0: t0 + 0.08, t1: t0 + 0.6, dx, dy });
    return t0 + 0.7;
  };
  /** Someone passes a shape, looking (or, once they react, brushing it). */
  const visit = (p: Person, id: string, t0: number, lx = 40, ly = 30) => {
    at(p, t0, { shape: id, lx, ly });
    at(p, t0 + 0.5, { shape: id, lx: lx * 0.4, ly: ly * 0.4 });
  };

  const [kam, ogu, yas, ozg, gor, ece] = TEAM.map((m) => P(m.name, m.color, m.join));
  // Kamila: the headline, a dot, a diamond
  at(kam, kam.join, { ui: "side", dx: -120, dy: 160 }, "text");
  at(kam, 5.4, { part: "title", fx: 0, fy: 0.1, dx: 2 });
  click(kam, 5.5);
  at(kam, 5.55, { part: "title", fx: 0, fy: 0.1, dx: 2 });
  at(kam, 5.8, { part: "title", fx: 0, fy: 0, dx: -34, dy: -26 });
  parts.title = { kind: "type", t: 5.8, ms: 55, c: kam.color };
  at(kam, 7.9, { part: "title", fx: 0, fy: 0, dx: -34, dy: -26 }, "arrow");
  drag(kam, "dot", 8.5);
  pen(kam, "dia", 9.7);
  nudge(kam, "dot", 12.0, 30, -20);
  visit(kam, "pent", 13.4);
  visit(kam, "ring", 15.4);
  kam.plays = ["dot", "pent", "dia"];

  // Oğuz: goes round what the others made and leaves comments (pins and a short thread, typed)
  at(ogu, ogu.join, { ui: "side", dx: 160, dy: -140 }, "comment");
  const comments: Comment[] = [];
  const comment = (on: string, t0: number, text: string, lx: number, ly: number, reply?: { by: Person; text: string; t: number }) => {
    at(ogu, t0 - 0.5, { shape: on, lx: lx + 30, ly: ly - 30 }, "comment");
    at(ogu, t0 - 0.05, { shape: on, lx, ly });
    click(ogu, t0);
    at(ogu, t0 + 0.1, { shape: on, lx, ly });
    at(ogu, t0 + 0.45, { shape: on, lx: lx - 20, ly: ly + 70 });
    const typed = t0 + 0.35 + text.length * 0.045;
    const close = (reply ? reply.t + reply.text.length * 0.07 : typed) + 1.4;
    comments.push({ on, lx, ly, t: t0 + 0.05, text, typing: [t0 + 0.35, typed], close, reply: reply && { name: reply.by.name, color: reply.by.color, text: reply.text, t: reply.t } });
    at(ogu, close, { shape: on, lx: lx - 20, ly: ly + 70 });
  };
  ogu.plays = ["star", "circ", "wave"];

  // Yasin: the ellipse, a rounded square, a pill
  at(yas, yas.join, { ui: "side", dx: 220, dy: 80 }, "crosshair");
  drag(yas, "circ", 6.6);
  drag(yas, "rsq", 8.1);
  drag(yas, "pill", 9.2);
  nudge(yas, "circ", 10.4, -30, 10);
  // …and answers Oğuz's comment on his ellipse
  at(yas, 13.2, { shape: "circ", lx: 120, ly: 40 });
  at(yas, 14.4, { shape: "circ", lx: 120, ly: 40 });
  visit(yas, "ring", 15.6);
  visit(yas, "pent", 16.8, -40, 30);
  yas.plays = ["circ", "rsq", "pill"];


  // Özge: Try it — drawn, then labelled — the link, then a pill
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
  pen(ozg, "pent", 9.7);
  visit(ozg, "dia", 13.1);
  visit(ozg, "squig", 15.1);
  ozg.plays = ["pent", "dia", "squig"];

  // Görkem: the wave, then a squiggle, dragged into curves with the pen
  at(gor, gor.join, { ui: "side", dx: 260, dy: 240 }, "pen");
  curve(gor, "wave", 7.8);
  curve(gor, "squig", 10.4);
  visit(gor, "tri", 13.6);
  visit(gor, "dot", 15.6);
  gor.plays = ["wave", "squig", "tri"];

  // Ece: the star, then a ring
  at(ece, ece.join, { ui: "side", dx: -200, dy: -60 }, "crosshair");
  drag(ece, "star", 8.4);
  drag(ece, "ring", 9.5);
  pen(ece, "tri", 10.5);
  visit(ece, "rsq", 12.9);
  visit(ece, "circ", 14.9);
  ece.plays = ["star", "ring", "tri"];

  // Oğuz's round, once there's something to tease
  comment("star", 9.7, "Bu yıldız mı, patates mi?", 40, -50);
  comment("circ", 12.3, "Rengi kim seçti, a**na koyayım.", 45, -45, { by: yas, text: "Tamam abi 😅", t: 13.5 });
  comment("wave", 15.0, "Maşallah kardeşim, bir s*kten de anlamıyorsun.", 60, -30);

  for (const p of people) p.keys.sort((x, y) => x.t - y.t);
  return { people, parts, nudges, comments, draw: [1.82, 2.8], card: [4.17, 4.95] };
}

// ── The physics: a dozen discs (each shape's collider), a pointer that pushes, the text as walls ─────────────────

interface Body {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  a: number;
  va: number;
  r: number;
}
const STEP = 1 / 120;
const RESTITUTION = 0.4;
const DAMP = 2.4;
const HOME_K = 2.2;
const MAX_V = 900;

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
  ...Object.fromEntries(SHAPES.map((s) => [s.id, { name: s.name, icon: s.icon }])),
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
  const surface = useRef<HTMLDivElement>(null);
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
    const outers = new Map(SHAPES.map((s) => [s.id, frame.querySelector<SVGGElement>(`#ps-${s.id}`)]));
    const cardEl = frame.querySelector<HTMLElement>(".poster-card");
    /** Places every shape at its home for this card's size (also what reduced motion shows). */
    const placeHome = () => {
      if (!cardEl) return;
      const w = cardEl.offsetWidth;
      const h = cardEl.offsetHeight;
      for (const s of SHAPES) {
        const o = outers.get(s.id);
        const hm = homeOf(s, w, h);
        o?.setAttribute("transform", `translate(${hm.x.toFixed(1)} ${hm.y.toFixed(1)}) scale(${hm.k.toFixed(3)})`);
      }
    };
    if (prefersReduced() || !html.classList.contains("hero-anim")) {
      html.classList.remove("hero-anim");
      placeHome();
      window.addEventListener("resize", placeHome);
      return () => window.removeEventListener("resize", placeHome);
    }

    // ── Measuring ──
    let k = { s: 1, x: 0, y: 0 };
    let g: Geo | null = null;
    let story = plan({ W: 1, H: 1, panels: false, toolbar: false, s0: 1, x0: 0, y0: 0, parts: {}, card: null, text: [], ui: {} });
    void story.comments;
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
      for (const id of Object.keys(PART_SEL)) {
        const e = frame.querySelector<HTMLElement | SVGElement>(PART_SEL[id]);
        if (!e) continue;
        els[id] = e;
        if (!SHAPE_OF.has(id)) parts[id] = nat(e.getBoundingClientRect());
      }
      const card = parts.card ?? null;
      const text: Rect[] = [];
      if (card)
        for (const q of ["#hero-title", ".poster-cta"]) {
          const e = frame.querySelector<HTMLElement>(q);
          if (!e) continue;
          const r = nat(e.getBoundingClientRect());
          text.push({ x: r.x - card.x - 6, y: r.y - card.y - 6, w: r.w + 12, h: r.h + 12 });
        }
      const sr = sticky.getBoundingClientRect();
      for (const [spot, q] of Object.entries(UI_SEL) as [UiSpot, string][]) {
        const e = el.querySelector<HTMLElement>(q);
        const r = e?.getBoundingClientRect();
        if (r && r.width) uiSpots[spot] = [r.left - sr.left + Math.min(r.width / 2, 14) + 2, r.top - sr.top + r.height / 2 + 2];
      }
      if (uiSpots.composer) uiSpots.composer = [uiSpots.composer[0] - 6, uiSpots.composer[1]];
      const next: Geo = { W, H, panels: panelsOn, toolbar: toolbarOn, s0, x0: Math.round(A.x + (A.w - W * s0) / 2), y0: Math.round(A.y + (A.h - H * s0) / 2), parts, card, text, ui: { ...uiSpots } };
      const changed = !g || g.W !== W || g.H !== H || JSON.stringify([g.parts, g.ui, g.text]) !== JSON.stringify([parts, next.ui, text]);
      g = next;
      if (changed) {
        story = plan(g);
        setGeo(g);
      }
    };

    // ── Cursors (plain DOM, placed on each frame) ──
    const curEls = new Map<string, { el: HTMLElement; art: HTMLElement; tool: CursorTool | null; x: number; y: number }>();
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
        c = { el: e, art, tool: null, x: 0, y: 0 };
        curEls.set(p.name, c);
      }
      return c;
    };
    const commentEls = new Map<number, { pin: HTMLElement; bubble: HTMLElement; text: HTMLElement; reply?: HTMLElement; replyText?: HTMLElement }>();
    const commentOf = (i: number, cm: Comment) => {
      let c = commentEls.get(i);
      if (!c) {
        const pin = document.createElement("div");
        pin.className = styles.cpin;
        pin.style.setProperty("--c", COLORS.oguz);
        pin.textContent = "OĞ";
        const bubble = document.createElement("div");
        bubble.className = styles.bubble;
        const msg = (name: string, color: string) => {
          const row = document.createElement("div");
          row.className = styles.msg;
          const av = document.createElement("span");
          av.className = styles.av;
          av.style.background = color;
          av.textContent = name.slice(0, 2).toLocaleUpperCase("tr");
          const body = document.createElement("div");
          const who = document.createElement("b");
          who.textContent = name;
          const text = document.createElement("p");
          body.append(who, text);
          row.append(av, body);
          bubble.append(row);
          return { row, text };
        };
        const first = msg("Oğuz", COLORS.oguz);
        const second = cm.reply ? msg(cm.reply.name, cm.reply.color) : null;
        cursors.current?.parentElement?.insertBefore(pin, cursors.current);
        cursors.current?.parentElement?.insertBefore(bubble, cursors.current);
        c = { pin, bubble, text: first.text, reply: second?.row, replyText: second?.text };
        commentEls.set(i, c);
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
      e.dataset.hp = kind === "pen" ? "off" : kind === "curve" ? "shown" : kind;
      if (INTERACTIVE.includes(id) && e instanceof HTMLElement) e.inert = kind !== "shown";
      const style = e.style;
      style.clipPath = "";
      style.transform = "";
      style.transformBox = "";
      style.transformOrigin = "";
      if (SHAPE_OF.has(id)) {
        // A shape's inner group: grown from its corner while dragged out, its stroke drawn on while a curve is pulled
        const paths = e.querySelectorAll<SVGPathElement>("path");
        if (kind === "draw") {
          style.transformBox = "fill-box";
          style.transformOrigin = "0 0";
          style.transform = `scale(${Math.max(0.001, n)})`;
          style.outline = "none";
        }
        for (const path of paths) {
          if (!path.hasAttribute("pathLength")) continue;
          path.style.strokeDasharray = kind === "curve" ? "1 1" : "";
          path.style.strokeDashoffset = kind === "curve" ? String(1 - n) : "";
        }
        return;
      }
      if (kind === "draw") {
        e.style.setProperty("--hp-c", color);
        style.clipPath = `inset(0 ${(1 - n) * 100}% ${(1 - n) * 100}% 0 round 2px)`;
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
    const curveQ = (p: { drags: [number, number][] }, t: number) => {
      // How much of the curve is drawn: each anchor's drag pulls its share
      const n = p.drags.length;
      let q = 0;
      p.drags.forEach(([a, b], i) => {
        if (i === 0) return;
        q += clamp((t - a) / (b - a)) / (n - 1);
      });
      return q;
    };
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
          return n >= p.clicks.length ? "shown" : `pen:${n}`;
        }
        case "curve": {
          if (t < p.drags[0][0]) return "off";
          const last = p.drags[p.drags.length - 1];
          if (t >= last[1] + 0.1) return "shown";
          return `curve:${curveQ(p, t).toFixed(3)}`;
        }
      }
    };

    // ── Where the shapes are (card px): home (with the nudges so far), or their body once they're physical ──
    const bodies = new Map<string, Body>();
    let physical = false;
    const homeAt = (s: ShapeDef, t: number) => {
      const card = g?.card;
      const hm = homeOf(s, card?.w ?? 1, card?.h ?? 1);
      let x = hm.x;
      let y = hm.y;
      for (const nd of story.nudges)
        if (nd.id === s.id && t > nd.t0) {
          const q = ease(clamp((t - nd.t0) / (nd.t1 - nd.t0)));
          x += nd.dx * hm.k * q;
          y += nd.dy * hm.k * q;
        }
      return { x, y, k: hm.k };
    };
    const shapePos = (id: string, t: number) => {
      const s = SHAPE_OF.get(id)!;
      const hm = homeAt(s, t);
      const b = physical ? bodies.get(id) : undefined;
      return b ? { x: b.x, y: b.y, k: hm.k } : hm;
    };

    /** The pen's marks: anchors placed so far (and the handle being dragged), in card px. */
    let lastEdit = "";
    const drawEdit = (t: number) => {
      if (!edit) return;
      let svg = "";
      for (const s of SHAPES) {
        const p = story.parts[s.id];
        if (!p) continue;
        const pos = shapePos(s.id, t);
        const P = (lx: number, ly: number) => [pos.x + lx * pos.k, pos.y + ly * pos.k];
        if (p.kind === "pen") {
          const n = p.clicks.filter((c) => t >= c).length;
          if (n > 0 && n < p.clicks.length) {
            const pts = (s.pts ?? []).slice(0, n).map(([x, y]) => P(x, y));
            svg += `<polyline points="${pts.map((q) => q.join(",")).join(" ")}" fill="none" stroke="${p.c}" stroke-width="2" />`;
            svg += pts.map(([x, y]) => `<rect x="${x - 4}" y="${y - 4}" width="8" height="8" />`).join("");
          }
        } else if (p.kind === "curve") {
          const c = CURVE[s.id];
          p.drags.forEach(([a, b], i) => {
            if (t < a || t > b + 0.3) return;
            const q = ease(clamp((t - a) / (b - a)));
            const [ax, ay] = P(...c.p[i]);
            const [hx, hy] = P(lerp(c.p[i][0], c.h[i][0], q), lerp(c.p[i][1], c.h[i][1], q));
            svg += `<line x1="${2 * ax - hx}" y1="${2 * ay - hy}" x2="${hx}" y2="${hy}" /><rect x="${ax - 4}" y="${ay - 4}" width="8" height="8" /><circle cx="${hx}" cy="${hy}" r="3.5" /><circle cx="${2 * ax - hx}" cy="${2 * ay - hy}" r="3.5" />`;
          });
        }
      }
      if (svg !== lastEdit) {
        lastEdit = svg;
        edit.innerHTML = svg;
      }
    };

    // ── Points ──
    const toScreen = (cx: number, cy: number): [number, number] => {
      const c = g?.card;
      return c ? [k.x + (c.x + cx) * k.s, k.y + (c.y + cy) * k.s] : [k.x, k.y];
    };
    let tNow = 0;
    const point = (s: Spot): [number, number] => {
      if (!g) return [0, 0];
      if ("ui" in s) {
        const base: [number, number] =
          s.ui === "start" ? [g.W / 2 + 80, g.H - 150] : s.ui === "side" ? [g.x0 + g.W * g.s0 * 0.5, g.y0 + g.H * g.s0 * 0.5] : g.ui[s.ui] ?? [g.W / 2, g.H / 2];
        return [base[0] + (s.dx ?? 0), base[1] + (s.dy ?? 0)];
      }
      if ("shape" in s) {
        // Cursors aim at a shape's home (where it settles), not at it as it's pushed: nobody chases a shape
        const pos = homeAt(SHAPE_OF.get(s.shape)!, tNow);
        const [x, y] = toScreen(pos.x + s.lx * pos.k, pos.y + s.ly * pos.k);
        return [x + (s.dx ?? 0), y + (s.dy ?? 0)];
      }
      const r = s.part === "frame" ? { x: 0, y: 0, w: g.W, h: g.H } : g.parts[s.part];
      if (!r) return [k.x, k.y];
      return [k.x + (r.x + r.w * s.fx) * k.s + (s.dx ?? 0), k.y + (r.y + r.h * s.fy) * k.s + (s.dy ?? 0)];
    };

    // ── The physics ──
    const mouse = { x: 0, y: 0, px: 0, py: 0, on: false, touch: false };
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerType === "touch" && !ev.buttons) return;
      mouse.x = ev.clientX;
      mouse.y = ev.clientY;
      if (!mouse.on) {
        mouse.px = mouse.x;
        mouse.py = mouse.y;
      }
      mouse.on = true;
      mouse.touch = ev.pointerType === "touch";
    };
    const onLeave = () => (mouse.on = false);
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerType === "touch") mouse.on = false;
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("pointerdown", onMove, { passive: true });
    window.addEventListener("pointerup", onUp, { passive: true });
    document.documentElement.addEventListener("pointerleave", onLeave);
    let acc = 0;
    /** One fixed step: drift home, pointer pushes, discs collide, walls and text stop them. */
    const step = (pointers: { x: number; y: number; vx: number; vy: number; r: number; f: number }[], w: number, h: number, t: number, clock: number) => {
      const list = [...bodies.values()];
      const u = Math.min(w, h) / 788;
      const damp = Math.exp(-DAMP * STEP);
      for (const [i, b] of list.entries()) {
        const s = SHAPE_OF.get(b.id)!;
        const hm = homeAt(s, t);
        // A slow drift around home, and a weak spring back to it
        const hx = hm.x + Math.sin(clock * 0.35 + i * 1.7) * 7 * u;
        const hy = hm.y + Math.cos(clock * 0.3 + i * 2.3) * 6 * u;
        b.vx += (hx - b.x) * HOME_K * STEP;
        b.vy += (hy - b.y) * HOME_K * STEP;
        b.va += (Math.sin(clock * 0.2 + i) * 0.15 - b.a) * 1.2 * STEP;
        for (const p of pointers) {
          const dx = b.x - p.x;
          const dy = b.y - p.y;
          const d = Math.hypot(dx, dy) || 0.001;
          const R = b.r + p.r;
          if (d >= R) continue;
          const nx = dx / d;
          const ny = dy / d;
          const over = R - d;
          b.x += nx * over * 0.5;
          b.y += ny * over * 0.5;
          // Flicked: the pointer's own motion, and a push out of it
          const vn = (p.vx - b.vx) * nx + (p.vy - b.vy) * ny;
          if (vn > 0) {
            b.vx += nx * vn * p.f;
            b.vy += ny * vn * p.f;
          }
          b.vx += nx * over * 14 * p.f;
          b.vy += ny * over * 14 * p.f;
          b.va += ((p.vx * ny - p.vy * nx) / Math.max(40, b.r * 4)) * 0.6 * p.f;
        }
        b.vx *= damp;
        b.vy *= damp;
        b.va *= Math.exp(-3 * STEP);
        const sp = Math.hypot(b.vx, b.vy);
        if (sp > MAX_V * u) {
          b.vx *= (MAX_V * u) / sp;
          b.vy *= (MAX_V * u) / sp;
        }
      }
      // Discs against discs
      for (let i = 0; i < list.length; i++)
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i];
          const c = list[j];
          const dx = c.x - a.x;
          const dy = c.y - a.y;
          const d = Math.hypot(dx, dy) || 0.001;
          const R = a.r + c.r;
          if (d >= R) continue;
          const nx = dx / d;
          const ny = dy / d;
          const over = (R - d) / 2;
          a.x -= nx * over;
          a.y -= ny * over;
          c.x += nx * over;
          c.y += ny * over;
          const rel = (c.vx - a.vx) * nx + (c.vy - a.vy) * ny;
          if (rel < 0) {
            const j2 = (-(1 + RESTITUTION) * rel) / 2;
            a.vx -= j2 * nx;
            a.vy -= j2 * ny;
            c.vx += j2 * nx;
            c.vy += j2 * ny;
          }
        }
      // The text (walls) and the poster's edges
      for (const b of list) {
        for (const T of g?.text ?? []) {
          const cx = clamp(b.x, T.x, T.x + T.w);
          const cy = clamp(b.y, T.y, T.y + T.h);
          let dx = b.x - cx;
          let dy = b.y - cy;
          let d = Math.hypot(dx, dy);
          if (d >= b.r) continue;
          if (d < 0.001) {
            // The centre got inside: out by the nearest side
            const sides = [b.x - T.x, T.x + T.w - b.x, b.y - T.y, T.y + T.h - b.y];
            const m = sides.indexOf(Math.min(...sides));
            dx = m === 0 ? -1 : m === 1 ? 1 : 0;
            dy = m === 2 ? -1 : m === 3 ? 1 : 0;
            d = 0;
          } else {
            dx /= d;
            dy /= d;
          }
          const push = b.r - d;
          b.x += dx * push;
          b.y += dy * push;
          const vn = b.vx * dx + b.vy * dy;
          if (vn < 0) {
            b.vx -= (1 + RESTITUTION) * vn * dx;
            b.vy -= (1 + RESTITUTION) * vn * dy;
          }
        }
        if (b.x < b.r) (b.x = b.r), (b.vx = Math.abs(b.vx) * RESTITUTION);
        if (b.x > w - b.r) (b.x = w - b.r), (b.vx = -Math.abs(b.vx) * RESTITUTION);
        if (b.y < b.r) (b.y = b.r), (b.vy = Math.abs(b.vy) * RESTITUTION);
        if (b.y > h - b.r) (b.y = h - b.r), (b.vy = -Math.abs(b.vy) * RESTITUTION);
        b.x += b.vx * STEP;
        b.y += b.vy * STEP;
        b.a += b.va * STEP;
      }
    };
    /** The shapes' outer groups: home (and nudges) before they're physical, their bodies after. */
    const placeShapes = (t: number, r: number, dt: number, pointersScreen: { x: number; y: number; vx: number; vy: number; f: number }[]) => {
      const card = g?.card;
      if (!card || !cardEl) return;
      const on = t >= AGENT.done || r > 0;
      if (on && !physical) {
        // They come alive where they are
        for (const s of SHAPES) {
          const hm = homeAt(s, t);
          bodies.set(s.id, { id: s.id, x: hm.x, y: hm.y, vx: 0, vy: 0, a: 0, va: 0, r: s.r * hm.k });
        }
        physical = true;
      } else if (!on && physical) {
        physical = false;
        bodies.clear();
      }
      if (physical) {
        // Screen → card px (the card is drawn at the frame's scale)
        const cr = cardEl.getBoundingClientRect();
        const sc = cr.width / card.w || 1;
        const u = Math.min(card.w, card.h) / 788;
        const pointers = pointersScreen.map((p) => ({ x: (p.x - cr.left) / sc, y: (p.y - cr.top) / sc, vx: p.vx / sc, vy: p.vy / sc, r: 26 * u, f: p.f }));
        acc = Math.min(acc + dt, 0.05);
        const clock = performance.now() / 1000;
        while (acc >= STEP) {
          step(pointers, card.w, card.h, t, clock);
          acc -= STEP;
        }
      }
      for (const s of SHAPES) {
        const o = outers.get(s.id);
        if (!o) continue;
        const b = physical ? bodies.get(s.id) : undefined;
        const hm = homeAt(s, t);
        const x = b ? b.x : hm.x;
        const y = b ? b.y : hm.y;
        const a = b ? (b.a * 180) / Math.PI : 0;
        o.setAttribute("transform", `translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${a.toFixed(2)}) scale(${hm.k.toFixed(3)})`);
      }
    };

    // ── The clock ──
    let played = 0;
    let lastP = -1;
    let t = 0;
    let r = 0;
    let last = performance.now();
    let visible = true;
    const io = new IntersectionObserver(([e]) => (visible = e.isIntersecting), { threshold: 0.02 });
    io.observe(sticky);
    let raf = 0;
    let lastUI = "";
    let open: boolean | null = null;
    let measuredAt = 0;
    let first = true;

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      if (!g || now - measuredAt > 300) {
        measuredAt = now;
        measure();
      }
      if (!g || !visible) return;
      const track = hero.offsetHeight - g.H;
      const p = track > 0 ? clamp((window.scrollY - hero.offsetTop) / track) : 0;
      // Scrolling back spends what played by itself first
      const share = T_SCROLL / BUILD_P;
      if (lastP >= 0 && p < lastP) played = Math.max(0, played - (lastP - p) * share * 2);
      lastP = p;
      const scrolled = Math.min(p, BUILD_P) * share;
      if (!document.hidden && p < BUILD_P && scrolled + played < T_BUILD) played += dt;
      const tTarget = p >= BUILD_P ? T_BUILD : clamp(scrolled + played, 0, T_BUILD);
      const rTarget = clamp((p - REVEAL_P0) / (REVEAL_P1 - REVEAL_P0));
      if (first) {
        // A page opened partway down: start where the scroll says
        t = tTarget;
        r = t >= T_BUILD ? rTarget : 0;
        first = false;
      }
      t = toward(t, tTarget, RATE * dt);
      r = toward(r, t >= T_BUILD - 1e-3 ? rTarget : 0, R_RATE * dt);
      tNow = t;
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
      for (const id of Object.keys(PART_SEL)) setPart(id, r > 0 ? "shown" : partState(id, t));
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

      // The toolbar becomes the dock (and back): one surface between them changes size and look (never the text);
      // the toolbar's items leave from the edges in, the dock's arrive from the centre out
      const smooth = (x: number) => x * x * (3 - 2 * x);
      const m = smooth(clamp((r - 0.45) / 0.4));
      const tbEl = bar.current?.querySelector<HTMLElement>('[data-ds="EditorToolbar"]');
      const tbW = tbEl?.offsetWidth || 530;
      const dkW = dock?.offsetWidth || 480;
      const morphing = g.toolbar && m > 0 && m < 1;
      if (bar.current) {
        bar.current.toggleAttribute("data-morph", morphing);
        bar.current.style.visibility = g.toolbar && m >= 1 ? "hidden" : "";
        const items = tbEl ? [...tbEl.children] : [];
        const mid = (items.length - 1) / 2;
        items.forEach((it, i) => {
          const edge = mid ? Math.abs(i - mid) / mid : 0;
          const q = clamp((m - (1 - edge) * 0.22) / 0.26);
          (it as HTMLElement).style.opacity = q > 0 ? String(1 - q) : "";
          (it as HTMLElement).style.transform = q > 0 ? `translateY(${Math.round(q * 6)}px)` : "";
        });
      }
      if (surface.current) {
        const sw = Math.round(lerp(tbW, dkW, m) / 2) * 2;
        surface.current.style.display = morphing ? "block" : "none";
        surface.current.style.width = `${sw}px`;
        surface.current.style.left = `${Math.round(g.W / 2 - sw / 2)}px`;
        surface.current.style.setProperty("--m", m.toFixed(4));
      }
      if (dock) {
        dock.toggleAttribute("data-morph", morphing);
        const items = [...dock.children].filter((x) => (x as HTMLElement).offsetWidth > 0) as HTMLElement[];
        const mid = (items.length - 1) / 2;
        if (open || !g.toolbar) {
          const shown = open ? 1 : clamp(r * 2 - 1);
          dock.style.opacity = open ? "" : String(shown);
          dock.style.pointerEvents = open ? "" : shown > 0.5 ? "auto" : "none";
          dock.inert = !open && shown < 0.5;
          for (const it of items) (it.style.opacity = ""), (it.style.transform = "");
        } else {
          dock.style.opacity = m > 0 ? "1" : "0";
          dock.style.pointerEvents = m >= 1 ? "auto" : "none";
          dock.inert = m < 1;
          items.forEach((it, i) => {
            const centre = mid ? Math.abs(i - mid) / mid : 0;
            const q = clamp((m - 0.5 - centre * 0.22) / 0.28);
            it.style.opacity = q < 1 ? String(q) : "";
            it.style.transform = q < 1 ? `translateY(${Math.round((1 - q) * 6)}px)` : "";
          });
        }
      }

      // Cursors: the timeline's, then — once the build is done — each keeps playing with its shapes
      const sr = sticky.getBoundingClientRect();
      const pointers: { x: number; y: number; vx: number; vy: number; f: number }[] = [];
      const clock = now / 1000;
      for (const [pi, person] of story.people.entries()) {
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
        if (t >= T_BUILD && person.plays.length) {
          // Playing: from shape to shape, brushing past each (it's their own clock, not the scroll's)
          const ph = clock * 0.16 + pi * 0.37;
          const n = person.plays.length;
          const from = point({ shape: person.plays[Math.floor(ph) % n], lx: 70, ly: 40 });
          const to = point({ shape: person.plays[(Math.floor(ph) + 1) % n], lx: -60, ly: 30 });
          const q = ease(clamp((ph % 1) * 1.4));
          const blend = clamp((t - T_BUILD) * 2 + 1);
          pt = [lerp(pt[0], lerp(from[0], to[0], q), blend), lerp(pt[1], lerp(from[1], to[1], q), blend)];
          tool = "arrow";
        }
        setTool(c, tool, person.color);
        const alpha = clamp((t - person.join) / 0.25) * fadeChrome;
        c.el.style.opacity = String(alpha);
        c.el.style.transform = `translate3d(${pt[0]}px, ${pt[1]}px, 0)`;
        c.el.toggleAttribute("data-press", t < T_BUILD && person.press.some(([p0, p1]) => t >= p0 && t <= p1));
        const seen = c.x !== 0 || c.y !== 0;
        if (seen && alpha > 0.5 && dt > 0) pointers.push({ x: sr.left + pt[0], y: sr.top + pt[1], vx: (pt[0] - c.x) / dt, vy: (pt[1] - c.y) / dt, f: 0.5 });
        c.x = pt[0];
        c.y = pt[1];
      }
      // Oğuz's comments: pins by the shapes, one thread open at a time
      for (const [ci, cm] of story.comments.entries()) {
        const el2 = commentOf(ci, cm);
        const [px, py] = point({ shape: cm.on, lx: cm.lx, ly: cm.ly });
        const shown = t >= cm.t && fadeChrome > 0;
        el2.pin.style.opacity = shown ? String(fadeChrome) : "0";
        el2.pin.style.transform = `translate3d(${Math.round(px)}px, ${Math.round(py - 22)}px, 0) scale(${shown ? 1 : 0.6})`;
        const open2 = shown && t >= cm.typing[0] - 0.1 && t < cm.close;
        el2.bubble.style.opacity = open2 ? String(fadeChrome) : "0";
        const flip = px + 30 + (el2.bubble.offsetWidth || 230) > g.W - (g.panels ? 270 : 8);
        const bw = el2.bubble.offsetWidth || 230;
        const bx = clamp(flip ? px - bw - 6 : px + 30, 8, g.W - bw - 8);
        el2.bubble.style.transform = `translate3d(${Math.round(bx)}px, ${Math.round(py - 30)}px, 0)`;
        const n = Math.max(0, Math.floor((t - cm.typing[0]) / 0.045));
        el2.text.textContent = cm.text.slice(0, Math.min(cm.text.length, n));
        if (cm.reply && el2.reply) {
          const rn = Math.max(0, Math.floor((t - cm.reply.t) / 0.07));
          el2.reply.style.display = t >= cm.reply.t ? "" : "none";
          el2.replyText!.textContent = [...cm.reply.text].slice(0, rn).join("");
        }
      }

      if (mouse.on && dt > 0) {
        pointers.push({ x: mouse.x, y: mouse.y, vx: (mouse.x - mouse.px) / dt, vy: (mouse.y - mouse.py) / dt, f: mouse.touch ? 0.5 : 1 });
        mouse.px = mouse.x;
        mouse.py = mouse.y;
      }
      placeShapes(r > 0 ? T_BUILD : t, r, dt, pointers);

      // What the panels show (only when it changes)
      const made = Object.keys(ROW_OF).filter((id) => story.parts[id] && partState(id, t) !== "off");
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
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerdown", onMove);
      window.removeEventListener("pointerup", onUp);
      document.documentElement.removeEventListener("pointerleave", onLeave);
      for (const c of curEls.values()) c.el.remove();
      for (const c of commentEls.values()) (c.pin.remove(), c.bubble.remove());
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
                      {ui.done && <AgentText>The shapes are physical now: they drift, a cursor pushes them, and they bump into each other, the edges and the text before settling back.</AgentText>}
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
            <div ref={pickerBox} className={styles.picker} data-hero-ui="picker" style={{ left: g.W - 264, top: 24 + 82 }}>
              <ColorPicker static value={paint} anchor={null} onChange={noop} onClose={noop} stop={1} />
            </div>
          )}
        </>
      )}

      {/* The one surface the toolbar and the dock share while one becomes the other */}
      <div ref={surface} className={styles.surface}>
        <i />
        <b />
      </div>
      {g?.toolbar && (
        <div ref={bar} className={styles.bar}>
          <EditorToolbar floating tool={ui.tool} mode="design" onMode={noop} onTool={noop} />
        </div>
      )}

      <div ref={cursors} className={styles.cursors} />
    </div>
  );
}

const AGENT_STEP_NAMES = ["get_selection", "get_design_context", "update_nodes"];

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
                <ColorInput label="Fill" color="linear-gradient(90deg, #ffd1e6, #c9d4ff 60%, #ffe1b0)" opacity={100} valueLabel="Linear" onColor={noop} onOpacity={noop} />
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
