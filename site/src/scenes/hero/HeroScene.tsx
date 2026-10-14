// The home page's first screen (docs/site.md §2.1, the hero v4): the editor itself on the white page — the navigation
// bar and Layers on the left, the Design panel on the right, the bottom toolbar, the canvas between — and one story
// told in it, over and over while it's in view (the owner's choice for the hero only):
//
//   Frame        You pick the Frame tool and drag "Landing", a web page
//   Multiplayer  four people join a beat apart and then work at once, each where their cursor is: Burak types the
//                logo and the nav (and adds a link), Bilal drops the banner in and aligns it, Görkem types the
//                headline and its line, Kamila draws the buttons — each part lands in Layers
//   AI agents    You open Agents in the navigation bar (the left panel becomes the chat) and ask for the mobile
//                version; the canvas zooms out and "Mobile" builds itself beside the page: skeletons first, each
//                resolving into its part as the chat's step ticks done (the agent has no cursor)
//   Prototype    You press Present: the mobile page opens in the viewer, a tap slides to the next screen, it closes
//   Closing      everyone rests around the two frames, "Design, together."; then the camera flies into Landing until
//                its white is the whole canvas, its content fades, the panels go back — and that white is the empty
//                canvas the story starts on, so the loop has no cut
//
// Cursors take the look of the tool in hand (crosshair while drawing, I-beam while typing). Clicks rest on their
// control first; a small mono caption names the beat. Under reduced motion the script runs straight to its end
// state and stays there.
import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
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
import { agents, AgentText, ChatPanel, Steps, UserMessage, type Step } from "../ai/chat";
import { Collage, CURSOR, Cursor, Dims, FrameName, Piece, Reveal, Selection, useFlip, usePointer, type Box, type Pointer } from "../collage/kit";
import { FileHeader, FillSection, Layers, noop, Num, type Row } from "../collage/ui";
import { BEZIER, css, ease } from "../runtime/easing";
import type { Run } from "../runtime/motion";
import { arcPoints, type Point } from "../runtime/path";
import { prefersReduced } from "../runtime/reduced";
import { Tween } from "../runtime/ticker";
import { Sky } from "../home/art";
import styles from "./hero.module.css";

/** The stage: the editor's proportions. */
const W = 1440;
const H = 800;
/** The left piece (the navigation bar, 57, and the panel, 240) and the canvas's centre between the panels. */
const LEFT_W = 297;
const CANVAS_CX = (24 + LEFT_W + W - 264) / 2;

/** "Landing" and "Mobile", in canvas coordinates (at 100% they are the stage's). */
const L = { x: 448, y: 136, w: 600, h: 400 };
const M = { x: L.x + L.w + 72, y: L.y, w: 200, h: 400 };
/** The camera: zoomed out to show both frames, and flown into Landing at the end (its white covers the stage). */
const ZOOM_OUT = { z: 0.74, tx: 94, ty: 112 };
const ZOOM_IN_Z = 2.7;
const ZOOM_IN = { z: ZOOM_IN_Z, tx: CANVAS_CX - (L.x + L.w / 2) * ZOOM_IN_Z, ty: 400 - (L.y + L.h / 2) * ZOOM_IN_Z };
const ZOOM_MS = 1000;
const FLY_MS = 1500;
type Camera = "none" | "out" | "in";

/** Landing's parts (canvas px). */
const LOGO = { x: L.x + 32, y: L.y + 22 };
const NAV = { x: L.x + 400, y: L.y + 26 };
const BANNER = { x: L.x + 328, y: L.y + 80, w: 240, h: 280 };
/** Where Bilal drops the banner, before he aligns it. */
const DROP_OFF: Point = [12, 8];
const HEAD = { x: L.x + 32, y: L.y + 120, w: 280 };
const SUB = { x: L.x + 32, y: L.y + 208 };
const BTN1 = { x: L.x + 32, y: L.y + 256, w: 128, h: 40 };
const BTN2 = { x: BTN1.x + BTN1.w + 12, y: BTN1.y, w: 112, h: 40 };

/** The controls the cursors press (stage px, measured on the rendered panels). */
const FRAME_TOOL: Point = [566, 742];
const AGENTS_TAB: Point = [53, 140];
const COMPOSER: Point = [104, 712];
const SEND: Point = [296, 749];
const PRESENT: Point = [1333, 51];
const VIEWER = { x: 345, y: 40, w: 807, h: 652 };
const CLOSE: Point = [VIEWER.x + VIEWER.w - 22, VIEWER.y + 22];
/** The phone in the viewer: the mobile page at 1.1×. */
const PHONE = { s: 1.1, x: CANVAS_CX - 110, y: VIEWER.y + 40 + (VIEWER.h - 40 - 440) / 2 };

const DRAW = 900;
const BUTTON_DRAW = 420;
const DRAG_EASE = BEZIER.standard;

const TEXT = {
  logo: "Orbit",
  nav: "Maps    Pricing    Help",
  head: "Weather that plans your week.",
  sub: "Hour by hour, for every plan.",
};
/** Burak types the nav up to here first, and adds the last link later. */
const NAV_FIRST = "Maps    Pricing".length;
type TextId = keyof typeof TEXT;
const ASK = "Make the mobile version";

type Beat = "frame" | "multiplayer" | "ai" | "prototype" | "closing";
const CAPTIONS: [Beat, string][] = [
  ["frame", "Frame"],
  ["multiplayer", "Multiplayer"],
  ["ai", "AI agents"],
  ["prototype", "Prototype"],
  ["closing", "Design, together."],
];

const PEOPLE = [
  { name: "Burak", color: CURSOR.green },
  { name: "Bilal", color: CURSOR.purple },
  { name: "Görkem", color: CURSOR.blue },
  { name: "Kamila", color: CURSOR.orange },
] as const;

/** Where each one starts (stage px). */
const START = {
  me: [700, 640] as Point,
  burak: [372, 600] as Point,
  bilal: [1112, 640] as Point,
  gorkem: [380, 250] as Point,
  kamila: [460, 660] as Point,
};

/** Bilal's banner, carried in from his desktop. */
const DROP: Point = [BANNER.x + BANNER.w / 2 + DROP_OFF[0], BANNER.y + BANNER.h / 2 + DROP_OFF[1]];
const CARRY_PATH = arcPoints(START.bilal, DROP, 0.06, 24);
const CARRY_MS = 1000;
const CARRY_AT: Point = [14, 34];

const cam = (c: Camera) => (c === "out" ? ZOOM_OUT : c === "in" ? ZOOM_IN : { z: 1, tx: 0, ty: 0 });
/** A canvas point on the stage, through the camera. */
const at = (p: Point, c: Camera): Point => {
  const k = cam(c);
  return [k.tx + p[0] * k.z, k.ty + p[1] * k.z];
};
const boxAt = (b: Box, c: Camera): Box => {
  const k = cam(c);
  return { x: k.tx + b.x * k.z, y: k.ty + b.y * k.z, w: b.w * k.z, h: b.h * k.z };
};

/** The agent's steps, in order: what each makes appear (as skeletons) and resolve. */
const AGENT_STEPS = ["get_metadata", "duplicate_nodes", "create_nodes", "set_auto_layout"] as const;

export default function HeroScene() {
  const [beat, setBeat] = useState<Beat | null>(null);
  const [tool, setTool] = useState<ToolId>("move");
  const [drawn, setDrawn] = useState(false);
  const [selected, setSelected] = useState(false);
  const [people, setPeople] = useState(0);
  const [texts, setTexts] = useState<Partial<Record<TextId, string>>>({});
  const [editing, setEditing] = useState<TextId[]>([]);
  const [carry, setCarry] = useState<"off" | "held" | "moving">("off");
  const [banner, setBanner] = useState(false);
  const [aligned, setAligned] = useState(false);
  const [navRow, setNavRow] = useState(false);
  const [buttons, setButtons] = useState(0);
  const [drawing, setDrawing] = useState(0);
  const [labels, setLabels] = useState(0);
  const [tab, setTab] = useState<"file" | "agents">("file");
  const [ask, setAsk] = useState("");
  const [sent, setSent] = useState(false);
  const [steps, setSteps] = useState<Step[]>([]);
  const [camera, setCamera] = useState<Camera>("none");
  /** Mobile: 0 nothing, 1 the frame and its skeletons; then how many parts have resolved (2…5). */
  const [mobile, setMobile] = useState(0);
  const [agentDone, setAgentDone] = useState(false);
  const [viewer, setViewer] = useState(false);
  const [tapped, setTapped] = useState(false);
  /** The closing: the frames' content fading under the camera; `snap` puts the camera back with no transition. */
  const [fading, setFading] = useState(false);
  const [snap, setSnap] = useState(false);

  const me = usePointer(START.me);
  const burak = usePointer(START.burak);
  const bilal = usePointer(START.bilal);
  const gorkem = usePointer(START.gorkem);
  const kamila = usePointer(START.kamila);
  /** Where each teammate rests on the canvas (canvas px), so the camera can carry them along. */
  const rests = useRef(new Map<Pointer, Point>());

  const thumb = useRef<HTMLDivElement>(null);
  const carried = useRef<Animation | null>(null);
  useLayoutEffect(() => {
    const el = thumb.current;
    if (!el) return;
    if (carry === "held") carried.current?.cancel();
    if (carry !== "moving" || prefersReduced() || typeof el.animate !== "function") return;
    carried.current = el.animate(
      CARRY_PATH.map(([x, y]) => ({ transform: `translate3d(${x + CARRY_AT[0]}px, ${y + CARRY_AT[1]}px, 0)` })),
      { duration: CARRY_MS, easing: css(DRAG_EASE), fill: "forwards" },
    );
  }, [carry]);

  const pile = useRef<HTMLSpanElement>(null);
  useFlip(pile, people);

  /** Types text layer `id` on from what it holds up to `upto` characters (a box in the typist's colour meanwhile). */
  const type = async (run: Run, id: TextId, seed: number, upto = TEXT[id].length, from = 0) => {
    setEditing((e) => [...e, id]);
    await run.wait(120);
    await run.type(TEXT[id].slice(from, upto), (s) => setTexts((t) => ({ ...t, [id]: TEXT[id].slice(0, from) + s })), seed);
    await run.wait(200);
    setEditing((e) => e.filter((x) => x !== id));
  };
  const rest = async (run: Run, p: Pointer, spot: Point, ms = 450) => {
    rests.current.set(p, spot);
    await p.to(run, spot, { ms });
  };

  // ── The four teammates, each on its own clock ──
  const burakWork = async (run: Run) => {
    setPeople((n) => Math.max(n, 1));
    await run.wait(300);
    burak.use("text");
    await burak.click(run, [LOGO.x + 1, LOGO.y + 2], { ms: 600, beat: 240 });
    await burak.to(run, [LOGO.x + 30, LOGO.y + 56], { ms: 300 });
    await type(run, "logo", 3);
    await burak.click(run, [NAV.x + 1, NAV.y + 2], { ms: 520, beat: 200 });
    await burak.to(run, [NAV.x - 20, NAV.y + 52], { ms: 300 });
    await type(run, "nav", 5, NAV_FIRST);
    setNavRow(true);
    // A last link, added at the end of the nav
    await burak.click(run, [NAV.x + 112, NAV.y + 8], { ms: 400, beat: 200 });
    await burak.to(run, [NAV.x + 60, NAV.y + 52], { ms: 280 });
    await type(run, "nav", 9, TEXT.nav.length, NAV_FIRST);
    burak.use("arrow");
    await rest(run, burak, [L.x + 170, L.y + 40]);
  };
  const bilalWork = async (run: Run) => {
    await run.wait(1200);
    setPeople((n) => Math.max(n, 2));
    setCarry("held");
    await run.wait(300);
    await bilal.drag(run, DROP, CARRY_MS, { ease: DRAG_EASE, path: CARRY_PATH, start: () => setCarry("moving") });
    setCarry("off");
    setBanner(true);
    await run.wait(700);
    // Then he aligns it with the frame's padding: a short drag, the banner moving with it
    await bilal.drag(run, [DROP[0] - DROP_OFF[0], DROP[1] - DROP_OFF[1]], 500, { ease: DRAG_EASE, bend: 0, start: () => setAligned(true) });
    await run.wait(300);
    await rest(run, bilal, [L.x + L.w - 40, L.y + L.h + 22], 700);
  };
  const gorkemWork = async (run: Run) => {
    await run.wait(2400);
    setPeople((n) => Math.max(n, 3));
    await run.wait(300);
    gorkem.use("text");
    await gorkem.click(run, [HEAD.x + 1, HEAD.y + 3], { ms: 600, beat: 240 });
    await gorkem.to(run, [HEAD.x - 60, HEAD.y + 120], { ms: 380 });
    await type(run, "head", 7);
    await gorkem.click(run, [SUB.x + 1, SUB.y + 2], { ms: 420, beat: 200 });
    await gorkem.to(run, [SUB.x + 40, SUB.y + 150], { ms: 380 });
    await type(run, "sub", 11);
    gorkem.use("arrow");
    rests.current.set(gorkem, [SUB.x + 40, SUB.y + 150]);
  };
  const kamilaWork = async (run: Run) => {
    await run.wait(3600);
    setPeople((n) => Math.max(n, 4));
    await run.wait(250);
    kamila.use("crosshair");
    await kamila.to(run, [BTN1.x, BTN1.y], { ms: 620 });
    await run.wait(120);
    await kamila.drag(run, [BTN1.x + BTN1.w, BTN1.y + BTN1.h], BUTTON_DRAW, { ease: DRAG_EASE, bend: 0, start: () => (setButtons(1), setDrawing(1)) });
    setLabels(1);
    await run.wait(250);
    await kamila.to(run, [BTN2.x, BTN2.y], { ms: 320 });
    await run.wait(100);
    await kamila.drag(run, [BTN2.x + BTN2.w, BTN2.y + BTN2.h], BUTTON_DRAW, { ease: DRAG_EASE, bend: 0, start: () => (setButtons(2), setDrawing(2)) });
    setLabels(2);
    await run.wait(200);
    setDrawing(0);
    kamila.use("arrow");
    await rest(run, kamila, [BTN2.x + 30, BTN2.y + 84], 420);
  };

  const story = async (run: Run) => {
    await run.wait(400);

    // ── Frame: the tool, then a quick drag ──
    setBeat("frame");
    await run.wait(300);
    await me.click(run, FRAME_TOOL, { beat: 260 });
    setTool("frame");
    me.use("crosshair");
    await run.wait(250);
    await me.to(run, [L.x, L.y], { ms: 650 });
    await run.wait(150);
    setSelected(true);
    await me.drag(run, [L.x + L.w, L.y + L.h], DRAW, { ease: DRAG_EASE, bend: 0.02, start: () => setDrawn(true) });
    setTool("move");
    me.use("arrow");
    await me.to(run, [L.x + L.w + 60, L.y + L.h + 70], { ms: 500 });
    await run.wait(500);

    // ── Multiplayer: they join a beat apart, then all work at once ──
    setBeat("multiplayer");
    await Promise.all([burakWork(run), bilalWork(run), gorkemWork(run), kamilaWork(run)]);
    await run.wait(700);

    // ── AI agents: Agents in the navigation bar, the ask; the page builds itself beside Landing ──
    setBeat("ai");
    await run.wait(300);
    await me.click(run, AGENTS_TAB, { ms: 700, beat: 260 });
    setTab("agents");
    await run.wait(350);
    await me.click(run, COMPOSER, { ms: 650, beat: 240 });
    await run.type(ASK, setAsk, 5);
    await run.wait(250);
    await me.click(run, SEND, { ms: 400, beat: 220 });
    setSent(true);
    setAsk("");
    const tick = (i: number) => setSteps(AGENT_STEPS.slice(0, i + 1).map((name, j) => ({ name, done: j < i })));
    const done = (i: number) => setSteps(AGENT_STEPS.slice(0, i + 1).map((name) => ({ name, done: true })));
    await run.wait(350);
    tick(0);
    // Room for the new frame: the canvas zooms out, everyone on it carried along
    setCamera("out");
    for (const [p, spot] of rests.current) void p.to(run, at(spot, "out"), { ms: ZOOM_MS, ease: BEZIER.standard, wait: false });
    await run.wait(ZOOM_MS);
    done(0);
    await run.wait(200);
    tick(1);
    setMobile(1);
    await run.wait(900);
    done(1);
    await run.wait(200);
    tick(2);
    for (let i = 2; i <= 4; i++) {
      await run.wait(650);
      setMobile(i);
    }
    await run.wait(300);
    done(2);
    await run.wait(200);
    tick(3);
    await run.wait(700);
    setMobile(5);
    await run.wait(250);
    done(3);
    setAgentDone(true);
    await run.wait(900);

    // ── Prototype: Present, a tap, the next screen, close ──
    setBeat("prototype");
    await run.wait(300);
    await me.click(run, PRESENT, { ms: 800, beat: 260 });
    setViewer(true);
    await run.wait(550);
    await me.click(run, [PHONE.x + 100 * PHONE.s, PHONE.y + 313 * PHONE.s], { ms: 700, beat: 300 });
    setTapped(true);
    await run.wait(1300);
    await me.click(run, CLOSE, { ms: 750, beat: 260 });
    setViewer(false);
    await run.wait(400);

    // ── Closing: everyone settles around the two frames ──
    setBeat("closing");
    setSelected(false);
    const around: [Pointer, Point][] = [
      [burak, [L.x + 120, L.y - 40]],
      [bilal, [M.x + M.w + 36, M.y + 120]],
      [gorkem, [L.x - 50, L.y + 220]],
      [kamila, [M.x + 40, M.y + M.h + 40]],
      [me, [L.x + L.w / 2, L.y + L.h + 56]],
    ];
    await Promise.all(around.map(([p, spot], i) => run.wait(i * 120).then(() => (p !== me && rests.current.set(p, spot), p.to(run, at(spot, "out"), { ms: 1100, ease: BEZIER.standard })))));
  };

  const script = async (run: Run) => {
    for (;;) {
      await story(run);
      if (run.reduced) return;
      await run.wait(1800);
      // The camera flies into Landing: its white becomes the canvas; the teammates leave, the content fades, the
      // panels go back — and the white left over is the empty canvas the story starts on
      setCamera("in");
      setFading(true);
      setPeople(0);
      void me.to(run, START.me, { ms: FLY_MS, ease: BEZIER.standard });
      await run.wait(1100);
      reset();
      await run.wait(FLY_MS - 1100);
      setSnap(true);
      setCamera("none");
      setDrawn(false);
      setMobile(0);
      setBeat(null);
      await run.wait(60);
      setSnap(false);
      setFading(false);
      for (const [p, s] of [
        [burak, START.burak],
        [bilal, START.bilal],
        [gorkem, START.gorkem],
        [kamila, START.kamila],
      ] as [Pointer, Point][]) {
        p.use("arrow");
        void p.to(run, s, { ms: 1, wait: false });
      }
      me.use("arrow");
      await run.wait(200);
    }
  };

  /** Everything but the camera and the frames themselves (they stay until the snap, under the white). */
  const reset = () => {
    setTool("move");
    setSelected(false);
    setTexts({});
    setEditing([]);
    setCarry("off");
    setBanner(false);
    setAligned(false);
    setNavRow(false);
    setButtons(0);
    setDrawing(0);
    setLabels(0);
    setTab("file");
    setAsk("");
    setSent(false);
    setSteps([]);
    setAgentDone(false);
    setViewer(false);
    setTapped(false);
    rests.current.clear();
  };

  // ── What the state draws ──
  const k = cam(camera);
  const world: CSSProperties = {
    transform: camera === "none" ? "none" : `translate(${k.tx}px, ${k.ty}px) scale(${k.z})`,
    transition: snap ? "none" : `transform ${camera === "in" ? FLY_MS : ZOOM_MS}ms ${css(BEZIER.standard)}`,
  };
  const moving = `transform ${camera === "in" ? FLY_MS : ZOOM_MS}ms ${css(BEZIER.standard)}`;
  const landing = boxAt(drawn ? L : { ...L, w: 0, h: 0 }, camera);
  const mobileBox = boxAt(M, camera);
  const named = (b: Box, children: ReactNode, show: boolean, sel?: boolean) => (
    <div className={styles.named} style={{ transform: `translate(${b.x}px, ${b.y}px)`, transition: snap ? "none" : moving }}>
      <FrameName x={0} y={0} selected={sel} show={show}>
        <span className={styles.frameName} data-selected={sel || undefined}>
          {children}
        </span>
      </FrameName>
    </div>
  );
  const box = (id: TextId, x: number, y: number, className: string, c: string, w?: number) => {
    const on = editing.includes(id);
    const n = texts[id]?.length ?? 0;
    return (
      <div className={`${styles.text} ${className}`} data-editing={on || undefined} style={{ left: x, top: y, width: w, ["--c" as string]: c }}>
        {texts[id] ?? ""}
        {on && <span className={styles.caret} data-typing={(n > 0 && n < TEXT[id].length) || undefined} />}
      </div>
    );
  };

  const has = (id: TextId) => (texts[id]?.length ?? 0) >= TEXT[id].length && !editing.includes(id);
  const rows: Row[] = [
    { id: "landing", name: "Landing", icon: "16.frame", strong: true, expanded: has("logo"), selected, hidden: !drawn || fading },
    { id: "plans", name: "See plans", icon: "16.frame", depth: 1, hidden: labels < 2 },
    { id: "get", name: "Get the app", icon: "16.frame", depth: 1, hidden: labels < 1 },
    { id: "sub", name: TEXT.sub, icon: "16.text", depth: 1, hidden: !has("sub") },
    { id: "head", name: TEXT.head, icon: "16.text", depth: 1, hidden: !has("head") },
    { id: "banner", name: "Banner", icon: "16.image", depth: 1, hidden: !banner },
    { id: "nav", name: "Nav", icon: "16.text", depth: 1, hidden: !navRow },
    { id: "logo", name: "Orbit", icon: "16.text", depth: 1, hidden: !has("logo") },
  ];

  return (
    <Collage size={[W, H]} focus={[0.52, 0.42]} safe={720} script={script} className={styles.stage}>
      {/* ── The canvas ── */}
      <div className={styles.canvas} data-snap={snap || undefined}>
        <div className={styles.world} style={world} data-fading={fading || undefined}>
          {/* Landing */}
          <div className={styles.frame} data-drawn={drawn || undefined} style={{ left: L.x, top: L.y, width: L.w, height: L.h, transition: `transform ${DRAW}ms ${css(DRAG_EASE)}` }} />
          <div className={styles.content} data-fading={fading || undefined}>
            <span className={styles.logoDot} data-on={has("logo") || undefined} style={{ left: LOGO.x - 2, top: LOGO.y + 3 }} />
            {box("logo", LOGO.x + 20, LOGO.y, styles.logo, CURSOR.green)}
            {box("nav", NAV.x, NAV.y, styles.nav, CURSOR.green)}
            <div
              className={styles.image}
              style={{ left: BANNER.x, top: BANNER.y, width: BANNER.w, height: BANNER.h, transform: aligned ? "none" : `translate(${DROP_OFF[0]}px, ${DROP_OFF[1]}px)`, transition: `transform 500ms ${css(DRAG_EASE)}` }}
            >
              <Reveal on={banner}>
                <Sky />
              </Reveal>
            </div>
            {box("head", HEAD.x, HEAD.y, styles.headline, CURSOR.blue, HEAD.w)}
            {box("sub", SUB.x, SUB.y, styles.sub, CURSOR.blue)}
            {[BTN1, BTN2].map((b, i) => (
              <div key={i} className={styles.button} data-drawn={buttons > i || undefined} data-dark={i === 0 || undefined} style={{ left: b.x, top: b.y, width: b.w, height: b.h, ["--c" as string]: CURSOR.orange }}>
                <i data-drawing={drawing === i + 1 || undefined} style={{ transitionDuration: `${BUTTON_DRAW}ms` }} />
                <span data-on={labels > i || undefined}>{i === 0 ? "Get the app" : "See plans"}</span>
              </div>
            ))}

            {/* Mobile, made by the agent: skeletons that resolve into its parts */}
            <div className={styles.mobileFrame} data-on={mobile > 0 || undefined} style={{ left: M.x, top: M.y, width: M.w, height: M.h }}>
              <MobilePage skeleton={mobile > 0} resolved={Math.max(0, mobile - 1)} />
            </div>
          </div>
        </div>

        {/* Frame names and your selection stay screen-sized: they follow the camera by position */}
        {named(landing, "Landing", drawn && camera !== "in", selected)}
        {named(mobileBox, "Mobile", mobile > 0 && camera !== "in")}
        <Selection box={landing} ms={camera === "out" ? ZOOM_MS : DRAW} ease={DRAG_EASE} size={<Dims w={drawn ? L.w : 0} h={drawn ? L.h : 0} ms={DRAW} ease={ease.standard} />} show={selected && !viewer} />
      </div>

      {/* The caption: which feature this is */}
      <div className={styles.captions} style={{ left: L.x, top: 64 }}>
        {CAPTIONS.map(([id, label]) => (
          <span key={id} className={styles.caption} data-on={beat === id || undefined}>
            {label}
          </span>
        ))}
      </div>

      {/* ── The panels ── */}
      <Piece surface x={24} y={24} w={LEFT_W} h={H - 48} d={60} from="left" z={4} className={styles.leftPiece}>
        <Rail label="Navigation" labels={false}>
          <RailItem compact icon="24.figma" label="Main menu" active={false} />
          <RailSeparator />
          <RailItem icon="24.page" label="File" active={tab === "file"} />
          <RailItem icon="24.agents" label="Agents" active={tab === "agents"} />
          <RailItem icon="24.assets" label="Assets" active={false} />
          <RailItem icon="24.tools" label="Tools" active={false} />
          <RailSeparator />
          <RailItem icon="24.variables" label="Variables" active={false} />
        </Rail>
        <div className={styles.leftCol}>
          {tab === "file" ? (
            <>
              <FileHeader name="Orbit — Website" />
              <Layers rows={rows} />
            </>
          ) : (
            <ChatPanel composer={ask || "Ask for changes, or describe what to make"} agent="Claude Code">
              {sent && <UserMessage>{ASK}</UserMessage>}
              {steps.length > 0 && (
                <div className={agents.agent}>
                  <span className={agents.agentName}>Claude Code</span>
                  <Steps steps={steps} />
                  {agentDone && <AgentText>Made “Mobile” beside Landing: the header, the banner, the headline and the two buttons, stacked in auto layout.</AgentText>}
                </div>
              )}
            </ChatPanel>
          )}
        </div>
      </Piece>

      <Piece surface x={W - 264} y={24} w={240} h={H - 48} d={120} from="right" z={4}>
        <div className={styles.rightCol}>
          <div className={panels.rightHeader}>
            <span ref={pile} className={`${mp.facepile} ${styles.pile}`}>
              {PEOPLE.map((p, i) =>
                people > i ? (
                  <span key={p.name} className={`${mp.face} ${styles.face}`} data-flip="" style={{ ["--peer" as string]: p.color }}>
                    <span className={mp.bar} />
                    <span className={mp.ring}>
                      <Avatar name={p.name} size={24} />
                    </span>
                  </span>
                ) : null,
              )}
              <span className={`${mp.face} ${styles.me}`} data-flip="">
                <span className={mp.ring}>
                  <Avatar name="You" size={24} />
                </span>
              </span>
            </span>
            <span className={panels.grow} />
            <IconButton icon="24.play" label="Present" size="large" />
            <Button variant="primary" size="large" className={panels.share}>
              Share
            </Button>
          </div>
          <div className={panels.rightTabs}>
            <Tabs label="Panels" value="design" tabs={[{ value: "design", label: "Design" }, { value: "prototype", label: "Prototype" }]} onChange={noop} />
            <span className={panels.zoom}>
              <span>
                <Tween value={camera === "out" ? Math.round(ZOOM_OUT.z * 100) : 100} ms={camera === "out" ? ZOOM_MS : 0} />%
              </span>
              <Icon name="16.chevron.down" />
            </span>
          </div>
          {selected ? (
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
                    <Num label="Width" prefix="W" value={drawn ? L.w : 0} ms={DRAW} ease={ease.standard} />
                    <Num label="Height" prefix="H" value={drawn ? L.h : 0} ms={DRAW} ease={ease.standard} />
                  </PropertyRow>
                </PropertyGrid>
              </PanelSection>
              <PanelSection title="Appearance">
                <PropertyGrid>
                  <PropertyRow>
                    <Num label="Opacity" prefix="24.opacity" value={100} unit="%" />
                    <Num label="Corner radius" prefix="24.corners" value={0} />
                  </PropertyRow>
                </PropertyGrid>
              </PanelSection>
              <FillSection hex="FFFFFF" />
            </>
          ) : (
            <FillSection title="Page" label="Page colour" hex="FFFFFF" />
          )}
        </div>
      </Piece>

      <Piece x={CANVAS_CX - 300} y={H - 24 - 76} w={600} h={76} d={180} z={4}>
        <div className={styles.toolbarSlot}>
          <EditorToolbar floating tool={tool} mode="design" onMode={noop} onTool={noop} />
        </div>
      </Piece>

      {/* The prototype viewer, over the canvas (and over the others' cursors: it's your screen) */}
      <Piece x={VIEWER.x} y={VIEWER.y} w={VIEWER.w} h={VIEWER.h} show={viewer} from="fade" z={32} className={styles.viewer}>
        <div className={styles.viewerBar}>
          <span>Mobile</span>
          <span className={styles.viewerClose} data-pressable="">
            <Icon name="24.close.small" />
          </span>
        </div>
        <div className={styles.phone} style={{ left: PHONE.x - VIEWER.x, top: PHONE.y - VIEWER.y, width: M.w, height: M.h, transform: `scale(${PHONE.s})` }}>
          <div className={styles.screen} data-out={tapped || undefined}>
            <MobilePage resolved={4} />
          </div>
          <div className={styles.screen} data-next="" data-on={tapped || undefined}>
            <NextScreen />
          </div>
        </div>
      </Piece>

      {/* Bilal's banner on its way in, under his cursor */}
      <div
        ref={thumb}
        className={styles.thumb}
        data-on={carry !== "off" || undefined}
        style={{ transform: `translate3d(${(carry === "off" && banner ? DROP : START.bilal)[0] + CARRY_AT[0]}px, ${(carry === "off" && banner ? DROP : START.bilal)[1] + CARRY_AT[1]}px, 0)` }}
      >
        <Sky />
      </div>

      <Cursor {...kamila.state} color={CURSOR.orange} name="Kamila" show={people >= 4} z={30} />
      <Cursor {...gorkem.state} color={CURSOR.blue} name="Görkem" show={people >= 3} z={30} />
      <Cursor {...bilal.state} color={CURSOR.purple} name="Bilal" show={people >= 2} z={30} />
      <Cursor {...burak.state} color={CURSOR.green} name="Burak" show={people >= 1} z={30} />
      <Cursor {...me.state} color={CURSOR.ink} name="You" d={300} z={40} />
    </Collage>
  );
}

/** The mobile page: with `skeleton`, grey placeholders where the parts go; each of the first `resolved` parts
 *  cross-fades from its placeholder into itself. */
function MobilePage({ skeleton, resolved }: { skeleton?: boolean; resolved: number }) {
  const part = (i: number, className: string, children: ReactNode) => (
    <div className={`${styles.mPart} ${className}`} data-on={resolved > i || undefined}>
      {skeleton && <span className={styles.skel} data-gone={resolved > i || undefined} />}
      <div className={styles.mReal}>{children}</div>
    </div>
  );
  return (
    <div className={styles.mPage}>
      {part(
        0,
        styles.mHeader,
        <>
          <span className={styles.mLogo}>
            <i /> Orbit
          </span>
          <span className={styles.mMenu}>
            <i />
            <i />
            <i />
          </span>
        </>,
      )}
      {part(1, styles.mBanner, <Sky />)}
      {part(
        2,
        styles.mText,
        <>
          <strong>{TEXT.head}</strong>
          <span>{TEXT.sub}</span>
        </>,
      )}
      {part(
        3,
        styles.mButtons,
        <>
          <span data-dark="">Get the app</span>
          <span>See plans</span>
        </>,
      )}
    </div>
  );
}

/** Where the button leads in the prototype. */
function NextScreen() {
  return (
    <div className={styles.mPage}>
      <div className={`${styles.mPart} ${styles.mHeader}`} data-on="">
        <div className={styles.mReal}>
          <span className={styles.mLogo}>
            <i /> Orbit
          </span>
        </div>
      </div>
      <div className={styles.nextBody}>
        <div className={styles.nextIcon}>
          <Sky />
        </div>
        <strong>Orbit for iPhone and Android</strong>
        <span>Free, with a forecast for every plan.</span>
        <span className={styles.nextButton}>Download</span>
      </div>
    </div>
  );
}
