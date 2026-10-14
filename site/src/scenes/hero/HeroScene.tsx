// The home page's top (docs/site.md §2.1): the editor around a frame, and in the frame the page's own, real header and
// hero (index.html: they live in `[data-hero-frame]`, laid out by site.css at the page's width — the frame is simply
// that page-top at a smaller scale). People build it together, each part made under its maker's cursor; then
// scrolling opens it: the panels slide away, the frame grows to the page (its transform goes to none, so the fixed
// header is the viewport's again) and the editor's toolbar becomes the page's dock.
//
// The whole story is a function of two numbers, so it can be scrubbed:
//   t  the build, in seconds: it plays by itself while the hero is in view, and scrolling the first part of the
//      track pushes it ahead (t = max(played, scrolled)); scrolling back never rewinds it
//   r  the reveal, 0…1: purely the scroll through the second part of the track
// Cursors, typed text, drawn boxes, Layers, the panels and the dock are all derived from (t, r) on each frame.
// Under reduced motion nothing of this runs: the page's top is simply there (no `hero-anim` class, no transform).
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button, IconButton, ToggleIconButton } from "@/ds/components/Button";
import { EditorToolbar, type ToolId } from "@/ds/components/EditorToolbar";
import { Avatar } from "@/ds/components/Misc";
import { PanelSection } from "@/ds/components/PanelSection";
import { PropertyGrid, PropertyRow } from "@/ds/components/PropertyGrid";
import { Rail, RailItem, RailSeparator } from "@/ds/components/Rail";
import { Tabs } from "@/ds/components/Tabs";
import { Icon } from "@/ds/icons/Icon";
import mp from "@/editor/multiplayer/Multiplayer.module.css";
import panels from "@/editor/panels/Panels.module.css";
import { FileHeader, FillSection, Layers, noop, Num, type Row } from "../collage/ui";
import { ARROW, ARROW_EDGE, CURSOR, SIZE, TOOL_ART, type CursorTool } from "../runtime/cursorArt";
import { prefersReduced } from "../runtime/reduced";
import styles from "./hero.module.css";

// ── The timeline ─────────────────────────────────────────────────────────────────────────────────────────────────

/** When the build is done, s. */
const T_BUILD = 12.6;
/** The track (scroll progress 0…1): the build can be pushed through [0, BUILD_P], the reveal runs [REVEAL_P0, REVEAL_P1]. */
const BUILD_P = 0.42;
const REVEAL_P0 = 0.48;
const REVEAL_P1 = 0.92;

type PartId = "logo" | "nav0" | "nav1" | "nav2" | "toggle" | "hdl" | "menu" | "head" | "lede" | "cta" | "cta2" | "meta";
const INTERACTIVE: PartId[] = ["logo", "nav0", "nav1", "nav2", "toggle", "hdl", "menu", "cta", "cta2"];

type Rect = { x: number; y: number; w: number; h: number };
type Plan =
  | { kind: "appear"; t: number }
  | { kind: "type"; t: number; ms: number; c: string }
  | { kind: "draw"; t: number; t1: number; c: string };

/** A point a cursor goes to: on a part of the page (fractions of its box, plus screen px), or on the screen. */
type Spot = { part: PartId | "frame"; fx: number; fy: number; dx?: number; dy?: number } | { screen: "frameTool" | "start" | "side"; dx?: number; dy?: number };
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
  /** Pressed between these times. */
  press: [number, number][];
}

const ease = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;

/** Geometry measured on the page: the stage, the canvas area, the frame's place in it, the parts' boxes. */
interface Geo {
  W: number;
  H: number;
  /** Side panels (wide screens) and the toolbar (not on phones). */
  panels: boolean;
  toolbar: boolean;
  s0: number;
  x0: number;
  y0: number;
  parts: Partial<Record<PartId, Rect>>;
  frameTool: [number, number];
}

const PEOPLE_COLORS = { burak: CURSOR.ink, yasin: CURSOR.green, ozge: CURSOR.orange, bilal: CURSOR.purple, kamila: CURSOR.red, gorkem: CURSOR.blue };

/** Who makes what, when (seconds), on this screen's geometry. */
function plan(g: Geo): { people: Person[]; parts: Partial<Record<PartId, Plan>>; draw: [number, number] } {
  const has = (p: PartId) => !!g.parts[p];
  const parts: Partial<Record<PartId, Plan>> = {};
  const people: Person[] = [];
  const P = (name: string, color: string, join: number): Person => {
    const p: Person = { name, color, join, keys: [], press: [] };
    people.push(p);
    return p;
  };
  const at = (p: Person, t: number, at: Spot, tool?: CursorTool) => p.keys.push({ t, at, tool });
  const click = (p: Person, t: number) => p.press.push([t, t + 0.12]);

  // Burak: the Frame tool, then the frame, quickly
  const burak = P("Burak", PEOPLE_COLORS.burak, 0);
  at(burak, 0, { screen: "start" });
  let d0 = 1.2;
  if (g.toolbar) {
    at(burak, 0.4, { screen: "start" });
    at(burak, 1.0, { screen: "frameTool" });
    click(burak, 1.25);
    at(burak, 1.35, { screen: "frameTool" }, "crosshair");
    d0 = 2.1;
  } else at(burak, 0.6, { screen: "start" }, "crosshair");
  at(burak, d0 - 0.1, { part: "frame", fx: 0, fy: 0 });
  at(burak, d0 + 0.1, { part: "frame", fx: 0, fy: 0 });
  at(burak, d0 + 1.1, { part: "frame", fx: 1, fy: 1 }, "crosshair");
  burak.press.push([d0 + 0.05, d0 + 1.15]);
  at(burak, d0 + 1.2, { part: "frame", fx: 1, fy: 1 }, "arrow");
  at(burak, d0 + 1.8, { part: "frame", fx: 1, fy: 1, dx: -60, dy: 26 });
  const draw: [number, number] = [d0 + 0.1, d0 + 1.1];
  const built = d0 + 1.2;

  // Yasin: the logo, then the theme toggle
  const yasin = P("Yasin", PEOPLE_COLORS.yasin, built + 0.1);
  let t = yasin.join;
  at(yasin, t, { screen: "side", dx: -40, dy: -120 });
  at(yasin, t + 0.7, { part: "logo", fx: 0.3, fy: 0.5 });
  click(yasin, t + 0.85);
  parts.logo = { kind: "appear", t: t + 0.97 };
  if (has("toggle")) {
    at(yasin, t + 1.4, { part: "toggle", fx: 0.5, fy: 0.5 });
    at(yasin, t + 1.5, { part: "toggle", fx: 0.5, fy: 0.5 });
    click(yasin, t + 1.5);
    parts.toggle = { kind: "appear", t: t + 1.62 };
    t += 0.8;
  }
  at(yasin, t + 1.6, { part: "logo", fx: 1, fy: 0.5, dx: 70, dy: 18 });

  // Özge: the nav, link by link (or the menu, on a phone)
  const ozge = P("Özge", PEOPLE_COLORS.ozge, built + 0.6);
  t = ozge.join;
  at(ozge, t, { screen: "side", dx: 20, dy: -40 }, "text");
  if (has("nav0")) {
    (["nav0", "nav1", "nav2"] as const).forEach((id, i) => {
      const go = t + 0.6 + i * 0.95;
      at(ozge, go, { part: id, fx: 0.15, fy: 0.5 });
      click(ozge, go + 0.08);
      at(ozge, go + 0.12, { part: id, fx: 0.15, fy: 0.5 });
      at(ozge, go + 0.3, { part: id, fx: 0.4, fy: 1, dx: 0, dy: 22 });
      parts[id] = { kind: "type", t: go + 0.3, ms: id === "nav2" ? 55 : 65, c: ozge.color };
    });
    at(ozge, t + 3.5, { part: "nav2", fx: 1, fy: 1, dx: 20, dy: 30 }, "arrow");
  } else if (has("menu")) {
    at(ozge, t + 0.7, { part: "menu", fx: 0.5, fy: 0.5 }, "arrow");
    click(ozge, t + 0.85);
    parts.menu = { kind: "appear", t: t + 0.97 };
    at(ozge, t + 1.6, { part: "menu", fx: 0, fy: 1, dx: -40, dy: 30 });
  }

  // Bilal: the header's Download, then the hero's (both drawn with the crosshair)
  const bilal = P("Bilal", PEOPLE_COLORS.bilal, built + 1.1);
  t = bilal.join;
  at(bilal, t, { screen: "side", dx: 60, dy: 60 }, "crosshair");
  const drawBox = (id: PartId, go: number) => {
    at(bilal, go, { part: id, fx: 0, fy: 0 });
    at(bilal, go + 0.12, { part: id, fx: 0, fy: 0 });
    at(bilal, go + 0.62, { part: id, fx: 1, fy: 1 });
    bilal.press.push([go + 0.1, go + 0.66]);
    parts[id] = { kind: "draw", t: go + 0.12, t1: go + 0.62, c: bilal.color };
    return go + 0.7;
  };
  let next = t + 0.8;
  if (has("hdl")) next = drawBox("hdl", next) + 0.6;
  next = drawBox("cta", next);
  if (has("cta2")) parts.cta2 = { kind: "appear", t: next + 0.25 };
  if (has("meta")) parts.meta = { kind: "appear", t: next + 0.45 };
  at(bilal, next + 0.1, { part: "cta", fx: 1, fy: 1 }, "arrow");
  at(bilal, next + 0.7, { part: "cta", fx: 1, fy: 1, dx: 26, dy: 40 });

  // Kamila: the headline
  const kamila = P("Kamila", PEOPLE_COLORS.kamila, built + 1.6);
  t = kamila.join;
  at(kamila, t, { screen: "side", dx: -60, dy: 140 }, "text");
  at(kamila, t + 0.8, { part: "head", fx: 0, fy: 0.12, dx: 2 });
  click(kamila, t + 0.9);
  at(kamila, t + 0.95, { part: "head", fx: 0, fy: 0.12, dx: 2 });
  at(kamila, t + 1.25, { part: "head", fx: 0, fy: 1, dx: -36, dy: 28 });
  parts.head = { kind: "type", t: t + 1.25, ms: 62, c: kamila.color };
  at(kamila, t + 1.25 + 2.3, { part: "head", fx: 0, fy: 1, dx: -36, dy: 28 }, "arrow");

  // Görkem: the lede
  const gorkem = P("Görkem", PEOPLE_COLORS.gorkem, built + 2.1);
  t = gorkem.join;
  at(gorkem, t, { screen: "side", dx: 120, dy: 40 }, "text");
  at(gorkem, t + 0.8, { part: "lede", fx: 0, fy: 0.1, dx: 2 });
  click(gorkem, t + 0.9);
  at(gorkem, t + 0.95, { part: "lede", fx: 0, fy: 0.1, dx: 2 });
  at(gorkem, t + 1.25, { part: "lede", fx: 0.5, fy: 1, dx: 0, dy: 26 });
  parts.lede = { kind: "type", t: t + 1.25, ms: 30, c: gorkem.color };
  at(gorkem, T_BUILD - 0.4, { part: "lede", fx: 0.5, fy: 1, dx: 0, dy: 26 }, "arrow");

  for (const p of people) p.keys.sort((a, b) => a.t - b.t);
  return { people, parts, draw };
}

// ── The scene ────────────────────────────────────────────────────────────────────────────────────────────────────

interface UI {
  tool: ToolId;
  people: number;
  rows: string;
  selected: boolean;
  w: number;
  h: number;
  caption: "frame" | "multiplayer" | "scroll" | null;
}

const PART_SEL: Record<PartId, string> = {
  logo: ".site-header .brand",
  nav0: ".site-header .nav a:nth-child(1)",
  nav1: ".site-header .nav a:nth-child(2)",
  nav2: ".site-header .nav a:nth-child(3)",
  toggle: ".site-header .theme-toggle",
  hdl: ".site-header .header-download",
  menu: ".site-header .menu",
  head: "#hero-title",
  lede: ".hero-side .lede",
  cta: "[data-download] .dl-buttons a:not([hidden])",
  cta2: "[data-download] .dl-buttons a:not([hidden]) ~ a:not([hidden])",
  meta: "[data-download] .dl-meta",
};
const ROW_OF: Record<PartId, { name: string; icon: Row["icon"] }> = {
  logo: { name: "Logo", icon: "16.image" },
  nav0: { name: "Features", icon: "16.text" },
  nav1: { name: "AI", icon: "16.text" },
  nav2: { name: "Changelog", icon: "16.text" },
  toggle: { name: "Theme", icon: "16.frame" },
  hdl: { name: "Download", icon: "16.frame" },
  menu: { name: "Menu", icon: "16.frame" },
  head: { name: "Design, together, on your desktop.", icon: "16.text" },
  lede: { name: "A design app for macOS and Windows…", icon: "16.text" },
  cta: { name: "Download for macOS", icon: "16.frame" },
  cta2: { name: "Download for Windows", icon: "16.frame" },
  meta: { name: "Version", icon: "16.text" },
};

export default function HeroScene() {
  const root = useRef<HTMLDivElement>(null);
  const left = useRef<HTMLDivElement>(null);
  const right = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const sel = useRef<HTMLDivElement>(null);
  const caption = useRef<HTMLDivElement>(null);
  const cursors = useRef<HTMLDivElement>(null);
  const [geo, setGeo] = useState<Geo | null>(null);
  const [ui, setUI] = useState<UI>({ tool: "move", people: 0, rows: "", selected: false, w: 0, h: 0, caption: null });

  useEffect(() => {
    const el = root.current;
    const hero = document.querySelector<HTMLElement>("[data-hero]");
    const sticky = document.querySelector<HTMLElement>("[data-hero-sticky]");
    const frame = document.querySelector<HTMLElement>("[data-hero-frame]");
    const bg = document.querySelector<HTMLElement>("[data-hero-bg]");
    const dock = document.querySelector<HTMLElement>("[data-dock]");
    const html = document.documentElement;
    if (!el || !hero || !sticky || !frame || !bg) return;

    // The dock steps aside for the download band and the footer, always
    let away = false;
    const awayIO = new IntersectionObserver((entries) => {
      for (const e of entries) (e.target as HTMLElement).dataset.near = e.isIntersecting ? "1" : "";
      away = [...document.querySelectorAll<HTMLElement>("#download, .site-footer")].some((x) => x.dataset.near === "1");
      if (!html.classList.contains("hero-anim")) dock?.toggleAttribute("data-away", away);
    });
    for (const x of document.querySelectorAll("#download, .site-footer")) awayIO.observe(x);

    if (prefersReduced() || !html.classList.contains("hero-anim")) {
      html.classList.remove("hero-anim");
      return () => awayIO.disconnect();
    }

    // ── Measuring ──
    let g: Geo | null = null;
    let story = plan({ W: 1, H: 1, panels: false, toolbar: false, s0: 1, x0: 0, y0: 0, parts: {}, frameTool: [0, 0] });
    const els: Partial<Record<PartId, HTMLElement>> = {};
    const nat = (e: HTMLElement): Rect | null => {
      if (!e.offsetWidth || e.getClientRects().length === 0) return null;
      let x = 0;
      let y = 0;
      let n: HTMLElement | null = e;
      while (n && n !== frame) {
        x += n.offsetLeft;
        y += n.offsetTop;
        n = n.offsetParent as HTMLElement | null;
      }
      return { x, y, w: e.offsetWidth, h: e.offsetHeight };
    };
    const measure = () => {
      const W = sticky.clientWidth;
      const H = sticky.clientHeight;
      const panelsOn = W >= 1024;
      const toolbarOn = W >= 640;
      const A = panelsOn ? { x: 345, y: 96, w: W - 345 - 288, h: H - 96 - 112 } : { x: 16, y: 72, w: W - 32, h: H - 72 - (toolbarOn ? 112 : 56) };
      const s0 = Math.min(A.w / W, A.h / H);
      const parts: Partial<Record<PartId, Rect>> = {};
      for (const id of Object.keys(PART_SEL) as PartId[]) {
        const e = frame.querySelector<HTMLElement>(PART_SEL[id]);
        if (!e) continue;
        els[id] = e;
        const r = nat(e);
        if (r) parts[id] = r;
      }
      const tb = el.querySelector<HTMLElement>('[data-ds="EditorToolbar"] button[aria-label="Frame"]');
      const sr = sticky.getBoundingClientRect();
      const br = tb?.getBoundingClientRect();
      const next: Geo = {
        W,
        H,
        panels: panelsOn,
        toolbar: toolbarOn,
        s0,
        x0: Math.round(A.x + (A.w - W * s0) / 2),
        y0: Math.round(A.y + (A.h - H * s0) / 2),
        parts,
        frameTool: br && br.width ? [br.left - sr.left + br.width / 2 + 2, br.top - sr.top + br.height / 2 + 2] : [W / 2, H - 48],
      };
      const changed = !g || g.W !== W || g.H !== H || JSON.stringify(g.parts) !== JSON.stringify(parts) || g.frameTool.join() !== next.frameTool.join();
      g = next;
      if (changed) {
        story = plan(g);
        setGeo(g);
      }
    };

    // ── The cursors (plain DOM: placed on each frame) ──
    const curEls = new Map<string, { el: HTMLElement; art: HTMLElement; tool: CursorTool | null }>();
    const cursorOf = (p: Person) => {
      let c = curEls.get(p.name);
      if (!c) {
        const e = document.createElement("div");
        e.className = styles.cursor;
        e.style.setProperty("--c", p.color);
        const art = document.createElement("span");
        art.className = styles.art;
        const pill = document.createElement("span");
        pill.className = styles.pill;
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

    // ── The parts of the page (real elements) ──
    const shownState = new Map<PartId, string>();
    const typed = new Map<PartId, { span: HTMLElement; text: string }>();
    const setPart = (id: PartId, state: string, t: number) => {
      const e = els[id];
      if (!e) return;
      const prev = shownState.get(id);
      if (prev === state && !state.startsWith("draw") && !state.startsWith("type")) return;
      shownState.set(id, state);
      const kind = state.split(":")[0];
      if (kind !== "type" && typed.has(id)) {
        typed.get(id)!.span.remove();
        typed.delete(id);
      }
      e.dataset.hp = kind;
      if (INTERACTIVE.includes(id)) e.inert = kind !== "shown";
      if (kind === "type") {
        let tp = typed.get(id);
        if (!tp) {
          const span = document.createElement("span");
          span.className = "hero-typed";
          span.setAttribute("aria-hidden", "true");
          tp = { span, text: (e.textContent ?? "").replace(/[ \t\n\r]+/g, " ").trim() };
          e.append(span);
          typed.set(id, tp);
        }
        const n = Number(state.split(":")[1]);
        const plain = tp.text.slice(0, n);
        void plain;
        if (tp.span.dataset.n !== String(n)) {
          tp.span.dataset.n = String(n);
          // The whole text is laid out (so it wraps as the finished text will); what isn't typed yet is invisible
          tp.span.innerHTML = "";
          tp.span.append(plain);
          const caret = document.createElement("i");
          caret.className = "hero-caret";
          if (n < tp.text.length) caret.dataset.typing = "";
          const rest = document.createElement("span");
          rest.className = "hero-rest";
          rest.textContent = tp.text.slice(n);
          tp.span.append(caret, rest);
        }
        e.style.setProperty("--hp-c", (story.parts[id] as { c: string }).c);
      } else if (kind === "draw") {
        const p = Number(state.split(":")[1]);
        e.style.clipPath = `inset(0 ${(1 - p) * 100}% ${(1 - p) * 100}% 0)`;
        e.style.setProperty("--hp-c", (story.parts[id] as { c: string }).c);
      } else {
        e.style.clipPath = "";
      }
      void t;
    };
    const partState = (id: PartId, t: number): string => {
      const p = story.parts[id];
      if (!p) return "shown";
      if (p.kind === "appear") return t >= p.t ? "shown" : "off";
      if (p.kind === "draw") {
        if (t < p.t) return "off";
        if (t >= p.t1 + 0.12) return "shown";
        return `draw:${ease(clamp((t - p.t) / (p.t1 - p.t))).toFixed(3)}`;
      }
      const e = els[id];
      const len = typed.get(id)?.text.length ?? (e?.textContent ?? "").replace(/[ \t\n\r]+/g, " ").trim().length;
      if (t < p.t - 0.05) return "off";
      const n = Math.floor((t - p.t) / (p.ms / 1000));
      if (n >= len + 4) return "shown";
      return `type:${Math.min(len, Math.max(0, n))}`;
    };

    // ── Points ──
    const point = (s: Spot, k: { s: number; x: number; y: number }): [number, number] => {
      if (!g) return [0, 0];
      if ("screen" in s) {
        const base: [number, number] = s.screen === "frameTool" ? g.frameTool : s.screen === "start" ? [g.W / 2 + 80, g.H - 150] : [g.x0 + g.W * g.s0 * 0.5, g.y0 + g.H * g.s0 * 0.5];
        return [base[0] + (s.dx ?? 0), base[1] + (s.dy ?? 0)];
      }
      const r = s.part === "frame" ? { x: 0, y: 0, w: g.W, h: g.H } : g.parts[s.part];
      if (!r) return [k.x, k.y];
      return [k.x + (r.x + r.w * s.fx) * k.s + (s.dx ?? 0), k.y + (r.y + r.h * s.fy) * k.s + (s.dy ?? 0)];
    };

    // ── The clock ──
    let played = 0;
    let last = performance.now();
    let visible = true;
    const io = new IntersectionObserver(([e]) => (visible = e.isIntersecting), { threshold: 0.05 });
    io.observe(sticky);
    let raf = 0;
    let lastUI = "";
    let open: boolean | null = null;
    let lastR = -1;
    let lastT = -1;
    let measuredAt = 0;

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      if (!g || now - measuredAt > 700) {
        measuredAt = now;
        measure();
      }
      if (!g) return;
      const track = hero.offsetHeight - g.H;
      const p = track > 0 ? clamp((window.scrollY - hero.offsetTop) / track) : 0;
      if (visible && !document.hidden) played = Math.min(T_BUILD, played + dt);
      const scrolled = clamp(p / BUILD_P) * T_BUILD;
      played = Math.max(played, scrolled);
      const t = played;
      const r = clamp((p - REVEAL_P0) / (REVEAL_P1 - REVEAL_P0));
      if (r === lastR && Math.abs(t - lastT) < 1e-4 && t >= T_BUILD) return;
      lastR = r;
      lastT = t;
      const e = ease(r);

      // The frame: the page-top at the canvas's scale, opening to the page
      const k = { s: lerp(g.s0, 1, e), x: lerp(g.x0, 0, e), y: lerp(g.y0, 0, e) };
      const isOpen = r >= 1;
      if (isOpen !== open) {
        open = isOpen;
        html.classList.toggle("hero-open", open);
        sticky.toggleAttribute("data-you-tile", !open);
      }
      frame.style.transform = open ? "none" : `translate(${k.x}px, ${k.y}px) scale(${k.s})`;
      if (!("ready" in frame.dataset)) {
        frame.dataset.ready = "";
        // The parts' fades start only once their first state is on screen (not from the page's own look)
        requestAnimationFrame(() => requestAnimationFrame(() => (frame.dataset.live = "")));
      }
      const [d0, d1] = story.draw;
      const dp = ease(clamp((t - d0) / (d1 - d0)));
      bg.style.transform = dp >= 1 ? "none" : `scale(${Math.max(0.001, dp)})`;
      bg.style.opacity = dp > 0 ? "1" : "0";
      bg.style.boxShadow = r < 1 ? `0 0 0 ${1 / k.s}px var(--site-piece-line)` : "";
      const parts = Object.keys(PART_SEL) as PartId[];
      for (const id of parts) setPart(id, r > 0 ? "shown" : partState(id, t), t);

      // The editor around it
      const out = ease(clamp(r / 0.8));
      if (left.current) left.current.style.transform = `translateX(${-340 * out}px)`;
      if (right.current) right.current.style.transform = `translateX(${280 * out}px)`;
      const fadeChrome = 1 - clamp(r / 0.25);
      if (sel.current) {
        const show = t >= d0 && fadeChrome > 0;
        sel.current.style.opacity = show ? String(fadeChrome) : "0";
        const w = g.W * k.s * (t < d1 ? dp : 1);
        const h = g.H * k.s * (t < d1 ? dp : 1);
        sel.current.style.transform = `translate(${k.x}px, ${k.y}px)`;
        sel.current.style.width = `${w}px`;
        sel.current.style.height = `${h}px`;
      }
      if (caption.current) caption.current.style.opacity = String(fadeChrome);

      // The toolbar becomes the dock
      const m = clamp((r - 0.45) / 0.55);
      const tbEl = bar.current?.querySelector<HTMLElement>('[data-ds="EditorToolbar"]');
      const tbW = tbEl?.offsetWidth || 530;
      const dkW = dock?.offsetWidth || 480;
      if (bar.current) {
        bar.current.style.opacity = String(1 - clamp(m * 1.6));
        bar.current.style.transform = `translateX(-50%) scaleX(${lerp(1, dkW / tbW, ease(m))})`;
      }
      if (dock) {
        const shown = g.toolbar ? clamp(m * 1.6 - 0.6) : 0;
        dock.style.opacity = String(away ? 0 : shown);
        dock.style.transform = `translateX(-50%) scaleX(${lerp(tbW / dkW, 1, ease(m))})`;
        dock.style.pointerEvents = shown > 0.5 && !away ? "" : "none";
        dock.inert = shown < 0.5 || away;
      }

      // Cursors
      for (const person of story.people) {
        const c = cursorOf(person);
        const keys = person.keys;
        let i = 0;
        while (i < keys.length - 1 && keys[i + 1].t <= t) i++;
        const a = keys[i];
        const b = keys[i + 1];
        let pt = point(a.at, k);
        if (b && t > a.t) {
          const q = ease(clamp((t - a.t) / (b.t - a.t)));
          const pb = point(b.at, k);
          // A gentle bow, as a wrist moves
          const bow = Math.sin(q * Math.PI) * 0.08;
          const dx = pb[0] - pt[0];
          const dy = pb[1] - pt[1];
          pt = [pt[0] + dx * q - dy * bow, pt[1] + dy * q + dx * bow];
        }
        let tool: CursorTool = "arrow";
        for (const key of keys) if (key.t <= t && key.tool) tool = key.tool;
        setTool(c, tool, person.color);
        const joined = clamp((t - person.join) / 0.25);
        const alpha = joined * fadeChrome;
        c.el.style.opacity = String(alpha);
        c.el.style.transform = `translate3d(${pt[0]}px, ${pt[1]}px, 0)`;
        c.el.toggleAttribute("data-press", person.press.some(([p0, p1]) => t >= p0 && t <= p1));
      }

      // What the panels show (only when it changes)
      const made = parts.filter((id) => story.parts[id] && partState(id, t) !== "off");
      made.sort((x, y) => (story.parts[y]!.t ?? 0) - (story.parts[x]!.t ?? 0));
      const caps: UI["caption"] = t < story.draw[1] + 0.2 ? "frame" : t < T_BUILD - 0.6 ? "multiplayer" : "scroll";
      const next: UI = {
        tool: g.toolbar && t >= 1.3 && t < story.draw[1] + 0.1 ? "frame" : "move",
        people: story.people.filter((x) => x.name !== "Burak" && t >= x.join).length,
        rows: made.join(","),
        selected: t >= d0,
        w: Math.round(g.W * (t < d1 ? dp : 1)),
        h: Math.round(g.H * (t < d1 ? dp : 1)),
        caption: t < 0.2 ? null : caps,
      };
      const key = JSON.stringify(next);
      if (key !== lastUI) {
        lastUI = key;
        setUI(next);
      }
    };
    raf = requestAnimationFrame(tick);
    const onResize = () => {
      measuredAt = 0;
      lastR = -1;
    };
    window.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
      awayIO.disconnect();
      window.removeEventListener("resize", onResize);
      for (const c of curEls.values()) c.el.remove();
      for (const tp of typed.values()) tp.span.remove();
    };
  }, []);

  const g = geo;
  const rowIds = ui.rows ? (ui.rows.split(",") as PartId[]) : [];
  const rows: Row[] = [
    { id: "home", name: "Home", icon: "16.frame", strong: true, expanded: rowIds.length > 0, selected: ui.selected, hidden: !ui.selected },
    ...(Object.keys(ROW_OF) as PartId[]).map((id) => ({ id, name: ROW_OF[id].name, icon: ROW_OF[id].icon, depth: 1, hidden: !rowIds.includes(id) })),
  ];
  // Newest first, as Layers lists them
  rows.splice(1, rows.length - 1, ...[...rows.slice(1)].sort((a, b) => (rowIds.indexOf(a.id as PartId) + 1 || 99) - (rowIds.indexOf(b.id as PartId) + 1 || 99)));
  const people = [
    { name: "Yasin", color: PEOPLE_COLORS.yasin },
    { name: "Özge", color: PEOPLE_COLORS.ozge },
    { name: "Bilal", color: PEOPLE_COLORS.bilal },
    { name: "Kamila", color: PEOPLE_COLORS.kamila },
    { name: "Görkem", color: PEOPLE_COLORS.gorkem },
  ];

  const label: Record<NonNullable<UI["caption"]>, string> = { frame: "Frame", multiplayer: "Multiplayer", scroll: "Scroll to open it" };
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

      {/* Your selection: the frame, its size */}
      <div ref={sel} className={styles.selection}>
        <span className={styles.frameName}>Home</span>
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
              <RailItem icon="24.page" label="File" active />
              <RailItem icon="24.agents" label="Agents" active={false} />
              <RailItem icon="24.assets" label="Assets" active={false} />
              <RailItem icon="24.tools" label="Tools" active={false} />
              <RailSeparator />
              <RailItem icon="24.variables" label="Variables" active={false} />
            </Rail>
            <div className={styles.leftCol}>
              <FileHeader name="Wecra — Website" />
              <Layers rows={rows} />
            </div>
          </div>
          <div ref={right} className={styles.piece} style={{ left: g.W - 264, top: 24, width: 240, height: g.H - 48 }}>
            <div className={styles.rightCol}>
              <div className={panels.rightHeader}>
                <span className={`${mp.facepile} ${styles.pile}`}>
                  {people.slice(0, ui.people).map((p) => (
                    <span key={p.name} className={`${mp.face} ${styles.face}`} style={{ ["--peer" as string]: p.color }}>
                      <span className={mp.bar} />
                      <span className={mp.ring}>
                        <Avatar name={p.name} size={24} />
                      </span>
                    </span>
                  ))}
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
              {ui.selected ? <FrameBody w={ui.w} h={ui.h} /> : <FillSection title="Page" label="Page colour" hex="F5F5F5" />}
            </div>
          </div>
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

function FrameBody({ w, h }: { w: number; h: number }): ReactNode {
  return (
    <>
      <PanelSection title="Frame" pad="none" actions={<><IconButton icon="24.dev-brackets" label="Mark as ready for dev" tone="secondary" /><IconButton icon="24.component.small" label="Create component" tone="secondary" /></>} />
      <PanelSection title="Position">
        <PropertyGrid>
          <PropertyRow>
            <Num label="X-position" prefix="X" value={0} />
            <Num label="Y-position" prefix="Y" value={0} />
          </PropertyRow>
        </PropertyGrid>
      </PanelSection>
      <PanelSection title="Layout" actions={<ToggleIconButton icon="24.autolayout-add-vertical" label="Use auto layout" tone="secondary" pressed={false} onPressedChange={noop} />}>
        <PropertyGrid>
          <PropertyRow>
            <Num label="Width" prefix="W" value={w} ms={0} />
            <Num label="Height" prefix="H" value={h} ms={0} />
          </PropertyRow>
        </PropertyGrid>
      </PanelSection>
      <FillSection hex="FFFFFF" />
    </>
  );
}
