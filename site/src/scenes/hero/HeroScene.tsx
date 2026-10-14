// The home page's first screen (docs/site.md §2.1, the hero v4): the editor itself on the white page — the navigation
// bar and Layers on the left, the Design panel on the right, the bottom toolbar, the canvas between — and one story
// told in it, then again (the owner's choice for the hero only: it rests, the canvas clears, the story starts over
// while it's in view):
//
//   Frame        you pick the Frame tool and drag "Landing", a web page
//   Multiplayer  four people join one by one (cursors, avatars) and build the page where their cursors are: Kerem
//                types the logo and the nav, Ada drops the banner in, Lena types the headline and its line, Mia
//                draws the buttons — each part lands in Layers
//   AI agents    you open Agents in the navigation bar (the left panel becomes the chat), ask for the mobile version
//                and send; the canvas zooms out and Claude Code's cursor builds "Mobile" beside the page while its
//                steps tick in the chat
//   Prototype    you press Present: the mobile page opens in the viewer, a tap on its button slides to the next
//                screen, and the viewer closes
//   Closing      everyone rests around the two frames: "Design, together."
//
// Cursors take the look of the tool in hand (crosshair while drawing, I-beam while typing). One thing happens at a
// time (the agent's chat ticks along with its cursor), each click rests on its control first, and a small mono
// caption names the beat. Under reduced motion the script runs straight to its end state and stays there.
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
/** The canvas zoomed out to show both: scale, then the offset. */
const ZOOM = { z: 0.74, tx: 94, ty: 112 };
const ZOOM_MS = 1000;

/** Landing's parts (canvas px). */
const LOGO = { x: L.x + 32, y: L.y + 22 };
const NAV = { x: L.x + 448, y: L.y + 26 };
const BANNER = { x: L.x + 328, y: L.y + 80, w: 240, h: 280 };
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
  nav: "Maps    Pricing",
  head: "Weather that plans your week.",
  sub: "Hour by hour, for every plan.",
};
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
  { name: "Kerem Aydın", color: CURSOR.green },
  { name: "Ada Lin", color: CURSOR.purple },
  { name: "Lena Vogel", color: CURSOR.blue },
  { name: "Mia Park", color: CURSOR.orange },
] as const;

/** Where each one starts (stage px). */
const START = {
  me: [700, 640] as Point,
  ken: [372, 620] as Point,
  ada: [1112, 640] as Point,
  lena: [380, 260] as Point,
  mia: [420, 640] as Point,
  claude: [1110, 120] as Point,
};

/** Ada's banner, carried in from her desktop. */
const ADA_TO: Point = [BANNER.x + BANNER.w / 2, BANNER.y + BANNER.h / 2];
const CARRY_PATH = arcPoints(START.ada, ADA_TO, 0.06, 24);
const CARRY_MS = 1000;
const CARRY_AT: Point = [14, 34];

/** A canvas point on the stage, at the canvas's zoom. */
const at = (p: Point, zoomed: boolean): Point => (zoomed ? [ZOOM.tx + p[0] * ZOOM.z, ZOOM.ty + p[1] * ZOOM.z] : p);
const boxAt = (b: Box, zoomed: boolean): Box => (zoomed ? { x: ZOOM.tx + b.x * ZOOM.z, y: ZOOM.ty + b.y * ZOOM.z, w: b.w * ZOOM.z, h: b.h * ZOOM.z } : b);

export default function HeroScene() {
  const [beat, setBeat] = useState<Beat | null>(null);
  const [tool, setTool] = useState<ToolId>("move");
  const [drawn, setDrawn] = useState(false);
  const [selected, setSelected] = useState(false);
  const [people, setPeople] = useState(0);
  const [texts, setTexts] = useState<Partial<Record<TextId, string>>>({});
  const [editing, setEditing] = useState<TextId | null>(null);
  const [carry, setCarry] = useState<"off" | "held" | "moving">("off");
  const [banner, setBanner] = useState(false);
  const [buttons, setButtons] = useState(0);
  const [miaDrawing, setMiaDrawing] = useState(0);
  const [labels, setLabels] = useState(0);
  const [tab, setTab] = useState<"file" | "agents">("file");
  const [ask, setAsk] = useState("");
  const [sent, setSent] = useState(false);
  const [steps, setSteps] = useState<Step[]>([]);
  const [agentOn, setAgentOn] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const [mobile, setMobile] = useState(0);
  const [agentDone, setAgentDone] = useState(false);
  const [viewer, setViewer] = useState(false);
  const [tapped, setTapped] = useState(false);
  const [clearing, setClearing] = useState(false);

  const me = usePointer(START.me);
  const ken = usePointer(START.ken);
  const ada = usePointer(START.ada);
  const lena = usePointer(START.lena);
  const mia = usePointer(START.mia);
  const claude = usePointer(START.claude);
  /** Where each teammate rests on the canvas (canvas px), so the zoom can carry them along. */
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

  /** Types `text` into text layer `id` (a text box in the typist's colour while it's being typed). */
  const type = async (run: Run, id: TextId, seed: number) => {
    setEditing(id);
    await run.wait(120);
    await run.type(TEXT[id], (s) => setTexts((t) => ({ ...t, [id]: s })), seed);
    await run.wait(220);
    setEditing(null);
  };
  /** A teammate moves aside onto an empty spot of the canvas and rests there. */
  const rest = async (run: Run, p: Pointer, spot: Point, ms = 450) => {
    rests.current.set(p, spot);
    await p.to(run, spot, { ms });
  };

  const reset = () => {
    setBeat(null);
    setTool("move");
    setDrawn(false);
    setSelected(false);
    setPeople(0);
    setTexts({});
    setEditing(null);
    setCarry("off");
    setBanner(false);
    setButtons(0);
    setMiaDrawing(0);
    setLabels(0);
    setTab("file");
    setAsk("");
    setSent(false);
    setSteps([]);
    setAgentOn(false);
    setZoomed(false);
    setMobile(0);
    setAgentDone(false);
    setViewer(false);
    setTapped(false);
    rests.current.clear();
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
    await run.wait(600);

    // ── Multiplayer: four people build the page ──
    setBeat("multiplayer");
    // Kerem: the logo and the nav
    setPeople(1);
    await run.wait(300);
    ken.use("text");
    await ken.click(run, [LOGO.x + 1, LOGO.y + 2], { ms: 600, beat: 240 });
    // The hand leaves the text while he types
    await ken.to(run, [LOGO.x + 30, LOGO.y + 56], { ms: 300 });
    await type(run, "logo", 3);
    await ken.click(run, [NAV.x + 1, NAV.y + 2], { ms: 520, beat: 200 });
    await ken.to(run, [NAV.x - 20, NAV.y + 52], { ms: 300 });
    await type(run, "nav", 5);
    ken.use("arrow");
    await rest(run, ken, [L.x + 150, L.y + 40]);
    await run.wait(200);

    // Ada: the banner, dragged in from her desktop
    setPeople(2);
    setCarry("held");
    await run.wait(300);
    await ada.drag(run, ADA_TO, CARRY_MS, { ease: DRAG_EASE, path: CARRY_PATH, start: () => setCarry("moving") });
    setCarry("off");
    setBanner(true);
    await run.wait(350);
    await rest(run, ada, [L.x + L.w - 40, L.y + L.h + 22]);
    await run.wait(200);

    // Lena: the headline and its line
    setPeople(3);
    await run.wait(300);
    lena.use("text");
    await lena.click(run, [HEAD.x + 1, HEAD.y + 3], { ms: 600, beat: 240 });
    await lena.to(run, [HEAD.x - 60, HEAD.y + 120], { ms: 380 });
    await type(run, "head", 7);
    await lena.click(run, [SUB.x + 1, SUB.y + 2], { ms: 420, beat: 200 });
    await lena.to(run, [SUB.x + 40, SUB.y + 150], { ms: 380 });
    await type(run, "sub", 11);
    lena.use("arrow");
    rests.current.set(lena, [SUB.x + 40, SUB.y + 150]);
    await run.wait(200);

    // Mia: the two buttons
    setPeople(4);
    await run.wait(250);
    mia.use("crosshair");
    await mia.to(run, [BTN1.x, BTN1.y], { ms: 520 });
    await run.wait(120);
    await mia.drag(run, [BTN1.x + BTN1.w, BTN1.y + BTN1.h], BUTTON_DRAW, { ease: DRAG_EASE, bend: 0, start: () => (setButtons(1), setMiaDrawing(1)) });
    setLabels(1);
    await run.wait(200);
    await mia.to(run, [BTN2.x, BTN2.y], { ms: 300 });
    await run.wait(100);
    await mia.drag(run, [BTN2.x + BTN2.w, BTN2.y + BTN2.h], BUTTON_DRAW, { ease: DRAG_EASE, bend: 0, start: () => (setButtons(2), setMiaDrawing(2)) });
    setLabels(2);
    await run.wait(200);
    setMiaDrawing(0);
    mia.use("arrow");
    await rest(run, mia, [BTN2.x + 30, BTN2.y + 84], 420);
    await run.wait(650);

    // ── AI agents: Agents in the navigation bar, the ask, then the agent builds the mobile page ──
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
    await run.wait(350);
    setSteps([{ name: "get_metadata", done: false }]);
    await run.wait(500);
    // Room for the new frame: the canvas zooms out, everyone on it carried along
    setZoomed(true);
    setSteps([{ name: "get_metadata", done: true }]);
    for (const [p, spot] of rests.current) void p.to(run, at(spot, true), { ms: ZOOM_MS, ease: BEZIER.standard, wait: false });
    await run.wait(ZOOM_MS + 100);
    const m = boxAt(M, true);
    setSteps((s) => [...s, { name: "duplicate_nodes", done: false }]);
    setAgentOn(true);
    claude.use("crosshair");
    await claude.to(run, [m.x, m.y], { ms: 650 });
    await run.wait(120);
    await claude.drag(run, [m.x + m.w, m.y + m.h], 700, { ease: DRAG_EASE, bend: 0.02, start: () => setMobile(1) });
    claude.use("arrow");
    setSteps((s) => [...s.slice(0, -1), { name: "duplicate_nodes", done: true }, { name: "create_nodes", done: false }]);
    const build: [Point, "arrow" | "text" | "crosshair"][] = [
      [[M.x + 20, M.y + 22], "arrow"],
      [[M.x + 40, M.y + 80], "arrow"],
      [[M.x + 17, M.y + 202], "text"],
      [[M.x + 17, M.y + 297], "crosshair"],
    ];
    for (let i = 0; i < build.length; i++) {
      claude.use(build[i][1]);
      await claude.to(run, at(build[i][0], true), { ms: 420 });
      await run.wait(80);
      setMobile(i + 2);
      await run.wait(260);
    }
    setSteps((s) => [...s.slice(0, -1), { name: "create_nodes", done: true }, { name: "set_auto_layout", done: false }]);
    claude.use("arrow");
    await run.wait(600);
    setSteps((s) => [...s.slice(0, -1), { name: "set_auto_layout", done: true }]);
    await claude.to(run, at([M.x + M.w + 40, M.y + M.h - 60], true), { ms: 450 });
    setAgentDone(true);
    await run.wait(800);

    // ── Prototype: Present, a tap, the next screen, close ──
    setBeat("prototype");
    await run.wait(300);
    await me.click(run, PRESENT, { ms: 800, beat: 260 });
    setViewer(true);
    await run.wait(550);
    const tap: Point = [PHONE.x + 100 * PHONE.s, PHONE.y + 313 * PHONE.s];
    await me.click(run, tap, { ms: 700, beat: 300 });
    setTapped(true);
    await run.wait(1300);
    await me.click(run, CLOSE, { ms: 750, beat: 260 });
    setViewer(false);
    await run.wait(500);

    // ── Closing ──
    setBeat("closing");
    await me.to(run, at([L.x + L.w / 2 + 40, L.y + L.h + 60], true), { ms: 900, ease: BEZIER.standard });
  };

  const script = async (run: Run) => {
    for (;;) {
      await story(run);
      if (run.reduced) return;
      // Rest on the finished file, then clear the canvas and start over
      await run.wait(2600);
      setClearing(true);
      setAgentOn(false);
      setPeople(0);
      await run.wait(400);
      reset();
      for (const p of [me, ken, ada, lena, mia, claude]) p.use("arrow");
      void me.to(run, START.me, { ms: 900, ease: BEZIER.standard });
      await Promise.all(
        ([
          [ken, START.ken],
          [ada, START.ada],
          [lena, START.lena],
          [mia, START.mia],
          [claude, START.claude],
        ] as [Pointer, Point][]).map(([p, s]) => p.to(run, s, { ms: 1 })),
      );
      await run.wait(ZOOM_MS);
      setClearing(false);
      await run.wait(300);
    }
  };

  // ── What the state draws ──
  const world: CSSProperties = {
    transform: zoomed ? `translate(${ZOOM.tx}px, ${ZOOM.ty}px) scale(${ZOOM.z})` : "none",
    transition: `transform ${ZOOM_MS}ms ${css(BEZIER.standard)}`,
  };
  const landing = boxAt(drawn ? L : { ...L, w: 0, h: 0 }, zoomed);
  const mobileBox = boxAt(mobile ? M : { ...M, w: 0, h: 0 }, zoomed);
  const named = (b: Box, children: ReactNode, show: boolean, sel?: boolean) => (
    <div className={styles.named} style={{ transform: `translate(${b.x}px, ${b.y}px)`, transition: `transform ${ZOOM_MS}ms ${css(BEZIER.standard)}` }}>
      <FrameName x={0} y={0} selected={sel} show={show}>
        <span className={styles.frameName} data-selected={sel || undefined}>
          {children}
        </span>
      </FrameName>
    </div>
  );
  const box = (id: TextId, x: number, y: number, className: string, c: string, w?: number) => (
    <div className={`${styles.text} ${className}`} data-editing={editing === id || undefined} style={{ left: x, top: y, width: w, ["--c" as string]: c }}>
      {texts[id] ?? ""}
      {editing === id && <span className={styles.caret} data-typing={((texts[id]?.length ?? 0) > 0 && (texts[id]?.length ?? 0) < TEXT[id].length) || undefined} />}
    </div>
  );

  const has = (id: TextId) => (texts[id]?.length ?? 0) === TEXT[id].length && editing !== id;
  const rows: Row[] = [
    { id: "landing", name: "Landing", icon: "16.frame", strong: true, expanded: has("logo"), selected: selected && !!drawn, hidden: !drawn },
    { id: "plans", name: "See plans", icon: "16.frame", depth: 1, hidden: labels < 2 },
    { id: "get", name: "Get the app", icon: "16.frame", depth: 1, hidden: labels < 1 },
    { id: "sub", name: TEXT.sub, icon: "16.text", depth: 1, hidden: !has("sub") },
    { id: "head", name: TEXT.head, icon: "16.text", depth: 1, hidden: !has("head") },
    { id: "banner", name: "Banner", icon: "16.image", depth: 1, hidden: !banner },
    { id: "nav", name: "Nav", icon: "16.text", depth: 1, hidden: !has("nav") },
    { id: "logo", name: "Orbit", icon: "16.text", depth: 1, hidden: !has("logo") },
  ];

  return (
    <Collage size={[W, H]} focus={[0.52, 0.42]} safe={720} script={script} className={styles.stage}>
      {/* The caption: which feature this is */}
      <div className={styles.captions} style={{ left: L.x, top: 64 }}>
        {CAPTIONS.map(([id, label]) => (
          <span key={id} className={styles.caption} data-on={beat === id || undefined}>
            {label}
          </span>
        ))}
      </div>

      {/* ── The canvas (faded out while it clears for the next round) ── */}
      <div className={styles.canvas} data-clearing={clearing || undefined}>
        <div className={styles.world} style={world}>
          {/* Landing */}
          <div className={styles.frame} data-drawn={drawn || undefined} style={{ left: L.x, top: L.y, width: L.w, height: L.h, transition: `transform ${DRAW}ms ${css(DRAG_EASE)}` }} />
          <span className={styles.logoDot} data-on={has("logo") || undefined} style={{ left: LOGO.x - 2, top: LOGO.y + 3 }} />
          {box("logo", LOGO.x + 20, LOGO.y, styles.logo, CURSOR.green)}
          {box("nav", NAV.x, NAV.y, styles.nav, CURSOR.green)}
          <div className={styles.image} style={{ left: BANNER.x, top: BANNER.y, width: BANNER.w, height: BANNER.h }}>
            <Reveal on={banner}>
              <Sky />
            </Reveal>
          </div>
          {box("head", HEAD.x, HEAD.y, styles.headline, CURSOR.blue, HEAD.w)}
          {box("sub", SUB.x, SUB.y, styles.sub, CURSOR.blue)}
          {[BTN1, BTN2].map((b, i) => (
            <div key={i} className={styles.button} data-drawn={buttons > i || undefined} data-dark={i === 0 || undefined} style={{ left: b.x, top: b.y, width: b.w, height: b.h, ["--c" as string]: CURSOR.orange }}>
              <i data-drawing={miaDrawing === i + 1 || undefined} style={{ transitionDuration: `${BUTTON_DRAW}ms` }} />
              <span data-on={labels > i || undefined}>{i === 0 ? "Get the app" : "See plans"}</span>
            </div>
          ))}

          {/* Mobile, built by the agent */}
          <div className={styles.frame} data-drawn={mobile > 0 || undefined} style={{ left: M.x, top: M.y, width: M.w, height: M.h, transition: `transform 700ms ${css(DRAG_EASE)}` }} />
          <div className={styles.mobile} style={{ left: M.x, top: M.y, width: M.w, height: M.h }}>
            <MobilePage step={mobile} />
          </div>
        </div>

        {/* Frame names and your selection stay screen-sized: they follow the zoom by position */}
        {named(landing, "Landing", drawn, selected)}
        {named(mobileBox, "Mobile", mobile > 0)}
        <Selection box={landing} ms={zoomed ? ZOOM_MS : DRAW} ease={DRAG_EASE} size={<Dims w={drawn ? L.w : 0} h={drawn ? L.h : 0} ms={DRAW} ease={ease.standard} />} show={selected && !viewer} />
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
                  <Avatar name="Sam Rivera" size={24} />
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
                <Tween value={zoomed ? Math.round(ZOOM.z * 100) : 100} ms={ZOOM_MS} />%
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

      {/* The prototype viewer, over the canvas */}
      <Piece x={VIEWER.x} y={VIEWER.y} w={VIEWER.w} h={VIEWER.h} show={viewer} from="fade" z={32} className={styles.viewer}>
        <div className={styles.viewerBar}>
          <span>Mobile</span>
          <span className={styles.viewerClose} data-pressable="">
            <Icon name="24.close.small" />
          </span>
        </div>
        <div className={styles.phone} style={{ left: PHONE.x - VIEWER.x, top: PHONE.y - VIEWER.y, width: M.w, height: M.h, transform: `scale(${PHONE.s})` }}>
          <div className={styles.screen} data-out={tapped || undefined}>
            <MobilePage step={6} />
          </div>
          <div className={styles.screen} data-next="" data-on={tapped || undefined}>
            <NextScreen />
          </div>
        </div>
      </Piece>

      {/* Ada's banner on its way in, under her cursor */}
      <div
        ref={thumb}
        className={styles.thumb}
        data-on={carry !== "off" || undefined}
        style={{ transform: `translate3d(${(carry === "off" && banner ? ADA_TO : START.ada)[0] + CARRY_AT[0]}px, ${(carry === "off" && banner ? ADA_TO : START.ada)[1] + CARRY_AT[1]}px, 0)` }}
      >
        <Sky />
      </div>

      <Cursor {...claude.state} color={CURSOR.red} name="Claude Code" show={agentOn} z={30} />
      <Cursor {...mia.state} color={CURSOR.orange} name="Mia" show={people >= 4} z={30} />
      <Cursor {...lena.state} color={CURSOR.blue} name="Lena" show={people >= 3} z={30} />
      <Cursor {...ada.state} color={CURSOR.purple} name="Ada" show={people >= 2} z={30} />
      <Cursor {...ken.state} color={CURSOR.green} name="Kerem" show={people >= 1} z={30} />
      <Cursor {...me.state} color={CURSOR.ink} d={300} z={40} />
    </Collage>
  );
}

/** The mobile page, its parts landing in order (1: the empty frame … 5: the buttons). */
function MobilePage({ step }: { step: number }) {
  return (
    <div className={styles.mPage}>
      <div className={styles.mHeader} data-on={step >= 2 || undefined}>
        <span className={styles.mLogo}>
          <i /> Orbit
        </span>
        <span className={styles.mMenu}>
          <i />
          <i />
          <i />
        </span>
      </div>
      <div className={styles.mBanner} data-on={step >= 3 || undefined}>
        <Sky />
      </div>
      <div className={styles.mText} data-on={step >= 4 || undefined}>
        <strong>{TEXT.head}</strong>
        <span>{TEXT.sub}</span>
      </div>
      <div className={styles.mButtons} data-on={step >= 5 || undefined}>
        <span data-dark="">Get the app</span>
        <span>See plans</span>
      </div>
    </div>
  );
}

/** Where the button leads in the prototype. */
function NextScreen() {
  return (
    <div className={styles.mPage}>
      <div className={styles.mHeader} data-on="">
        <span className={styles.mLogo}>
          <i /> Orbit
        </span>
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
