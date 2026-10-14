// The home page's first screen (docs/site.md §2.1, the hero v4): the editor itself on the white page — Layers on the
// left, the Design panel on the right, the bottom toolbar, the canvas between — and one story told in it, then
// again (the owner's choice for the hero only: it rests, the canvas clears, the story starts over while it's in view):
//
//   Frame        you pick the Frame tool and drag a frame, "Home" (the frame, the outline, W × H grow with the drag)
//   Multiplayer  teammates join one by one (their cursors and avatars arrive): Kerem types the headline, Ada drops a
//                picture in, Mia draws two buttons — each part appears under the cursor that makes it
//   Auto layout  you select the buttons, Use auto layout, and drag the gap down: the second button follows
//   Components   Create component: the row turns purple
//   AI agents    the Agents panel: you ask Claude Code for a forecast, and its cursor lays the cards in the frame
//   Dev Mode     you switch the toolbar to Dev Mode: the selection turns green, Inspect shows the code, a distance
//
// One thing happens at a time, each click rests on its control first, and a small mono caption names the beat. Under
// reduced motion the script runs straight to its end state and stays there.
import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { Button, IconButton, ToggleIconButton } from "@/ds/components/Button";
import { EditorToolbar, type EditorMode, type ToolId } from "@/ds/components/EditorToolbar";
import { Avatar, CodeBlock } from "@/ds/components/Misc";
import { PanelSection } from "@/ds/components/PanelSection";
import { PropertyGrid, PropertyRow } from "@/ds/components/PropertyGrid";
import { SegmentedControl } from "@/ds/components/SegmentedControl";
import { Tabs } from "@/ds/components/Tabs";
import { Icon } from "@/ds/icons/Icon";
import mp from "@/editor/multiplayer/Multiplayer.module.css";
import panels from "@/editor/panels/Panels.module.css";
import { agents, AgentText, ChatPanel, Steps, UserMessage, type Step } from "../ai/chat";
import ai from "../ai/ai.module.css";
import { Collage, CURSOR, Cursor, Dims, FrameName, Piece, Reveal, Selection, useFlip, usePointer } from "../collage/kit";
import { FileHeader, FillSection, Layers, noop, Num, PanelColumn, type Row } from "../collage/ui";
import { BEZIER, css, ease } from "../runtime/easing";
import type { Run } from "../runtime/motion";
import { arcPoints, type Point } from "../runtime/path";
import { prefersReduced } from "../runtime/reduced";
import { Sky } from "../home/art";
import styles from "./hero.module.css";

/** The stage: the editor's proportions. */
const W = 1440;
const H = 800;
/** The frame "Home" on the canvas. */
const F = { x: 400, y: 152, w: 640, h: 360 };
/** What lands in it (stage px). */
const HEAD = { x: F.x + 40, y: F.y + 108, w: 300 };
const IMG = { x: F.x + 352, y: F.y + 40, w: 248, h: 280 };
const BTN1 = { x: F.x + 40, y: F.y + 216, w: 128, h: 40 };
const BTN2_W = 112;
const GAPS = [24, 12] as const;
/** The headline's height (two lines of 38). */
const HEAD_H = 76;

/** The controls the cursors press (stage px, measured on the rendered panels). */
const FRAME_TOOL: Point = [538, 742];
const AL_TOGGLE: Point = [1398, 254];
const GAP_FIELD: Point = [1227, 402];
const MAKE_COMPONENT: Point = [1398, 128];
const DEV_MODE: Point = [962, 742];
const COMPOSER: Point = [1212, 708];
const SEND: Point = [1389, 749];

/** The frame drag, the marquee and the gap scrub: their length and curve (what they change moves in step). */
const DRAW = 1000;
const MARQUEE = 700;
const SCRUB = 800;
const BUTTON_DRAW = 450;
const DRAG_EASE = BEZIER.standard;

const HEADLINE = "Weather that plans your week.";
const CSS_CODE = [".buttons {", "  display: flex;", "  gap: 12px;", "  align-items: center;", "}"].join("\n");

type Beat = "frame" | "multiplayer" | "autolayout" | "components" | "ai" | "devmode";
const CAPTIONS: [Beat, string][] = [
  ["frame", "Frame"],
  ["multiplayer", "Multiplayer"],
  ["autolayout", "Auto layout"],
  ["components", "Components"],
  ["ai", "AI agents"],
  ["devmode", "Dev Mode"],
];

const PEOPLE = [
  { name: "Kerem Aydın", color: CURSOR.green },
  { name: "Ada Lin", color: CURSOR.purple },
  { name: "Mia Park", color: CURSOR.orange },
] as const;

type Sel = "none" | "frame" | "pair" | "row";

/** Ada's picture, carried in from her desktop: where the drag starts and ends, and the way between. */
const ADA_FROM: Point = [1112, 640];
const ADA_TO: Point = [IMG.x + IMG.w / 2, IMG.y + IMG.h / 2];
const CARRY_PATH = arcPoints(ADA_FROM, ADA_TO, 0.06, 24);
const CARRY_MS = 1000;
/** The thumbnail sits under the name pill. */
const CARRY_AT: Point = [14, 34];

/** The agent's ask, and the forecast cards it lays under the buttons (stage px). */
const ASK = "Add a 3-day forecast";
const DAYS: [string, string][] = [
  ["Mon", "18°"],
  ["Tue", "21°"],
  ["Wed", "16°"],
];
const CARD = { x: BTN1.x, y: BTN1.y + BTN1.h + 24, w: 76, h: 56, gap: 8 };
const cardX = (i: number) => CARD.x + i * (CARD.w + CARD.gap);
/** How long the canvas takes to clear before the story starts over, ms. */
const CLEAR = 1100;

export default function HeroScene() {
  const [beat, setBeat] = useState<Beat | null>(null);
  const [tool, setTool] = useState<ToolId>("move");
  const [mode, setMode] = useState<EditorMode>("design");
  const [drawn, setDrawn] = useState(false);
  const [sel, setSel] = useState<Sel>("none");
  const [people, setPeople] = useState(0);
  const [editing, setEditing] = useState(false);
  const [typed, setTyped] = useState("");
  const [headline, setHeadline] = useState(false);
  const [carry, setCarry] = useState<"off" | "held" | "moving">("off");
  const [image, setImage] = useState(false);
  const [buttons, setButtons] = useState(0);
  const [miaDrawing, setMiaDrawing] = useState(0);
  const [labels, setLabels] = useState(0);
  const [marquee, setMarquee] = useState(false);
  const [auto, setAuto] = useState(false);
  const [gap, setGap] = useState<number>(GAPS[0]);
  const [component, setComponent] = useState(false);
  const [agentPanel, setAgentPanel] = useState(false);
  const [ask, setAsk] = useState("");
  const [sent, setSent] = useState(false);
  const [steps, setSteps] = useState<Step[]>([]);
  const [cards, setCards] = useState(0);
  const [agentDone, setAgentDone] = useState(false);
  const [agentOn, setAgentOn] = useState(false);
  const [measure, setMeasure] = useState(false);
  const [clearing, setClearing] = useState(false);

  const me = usePointer([640, 640]);
  const ken = usePointer([316, 620]);
  const ada = usePointer(ADA_FROM);
  const mia = usePointer([360, 610]);
  const claude = usePointer([1110, 600]);

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

  /** Back to the empty page: everything the story changed, at once (the canvas is faded out meanwhile). */
  const reset = () => {
    setBeat(null);
    setTool("move");
    setMode("design");
    setDrawn(false);
    setSel("none");
    setPeople(0);
    setEditing(false);
    setTyped("");
    setHeadline(false);
    setCarry("off");
    setImage(false);
    setButtons(0);
    setMiaDrawing(0);
    setLabels(0);
    setMarquee(false);
    setAuto(false);
    setGap(GAPS[0]);
    setComponent(false);
    setAgentPanel(false);
    setAsk("");
    setSent(false);
    setSteps([]);
    setCards(0);
    setAgentDone(false);
    setAgentOn(false);
    setMeasure(false);
  };

  const story = async (run: Run) => {
    await run.wait(400);

    // Frame: the tool, then a quick drag
    setBeat("frame");
    await run.wait(300);
    await me.click(run, FRAME_TOOL, { beat: 260 });
    setTool("frame");
    me.use("crosshair");
    await run.wait(250);
    await me.to(run, [F.x, F.y], { ms: 650 });
    await run.wait(150);
    // The press makes the frame (0 × 0, in the panel too); the drag sizes it
    setSel("frame");
    await me.drag(run, [F.x + F.w, F.y + F.h], DRAW, {
      ease: DRAG_EASE,
      bend: 0.02,
      start: () => setDrawn(true),
    });
    setTool("move");
    me.use("arrow");
    await run.wait(650);

    // Multiplayer: Kerem joins and types the headline
    setBeat("multiplayer");
    setPeople(1);
    await run.wait(300);
    ken.use("text");
    await ken.click(run, [HEAD.x + 2, HEAD.y + 4], { ms: 600, beat: 260 });
    setEditing(true);
    // The hand leaves the text while he types
    await ken.to(run, [HEAD.x + 12, F.y + 48], { ms: 420 });
    await run.type(HEADLINE, setTyped, 7);
    await run.wait(250);
    setEditing(false);
    setHeadline(true);
    ken.use("arrow");
    await run.wait(300);

    // Ada brings a picture in from her desktop and drops it
    setPeople(2);
    setCarry("held");
    await run.wait(300);
    await ada.drag(run, ADA_TO, CARRY_MS, { ease: DRAG_EASE, path: CARRY_PATH, start: () => setCarry("moving") });
    setCarry("off");
    setImage(true);
    await run.wait(400);

    // Mia draws the two buttons
    setPeople(3);
    await run.wait(250);
    mia.use("crosshair");
    await mia.to(run, [BTN1.x, BTN1.y], { ms: 500 });
    await run.wait(120);
    await mia.drag(run, [BTN1.x + BTN1.w, BTN1.y + BTN1.h], BUTTON_DRAW, { ease: DRAG_EASE, bend: 0, start: () => (setButtons(1), setMiaDrawing(1)) });
    setLabels(1);
    await run.wait(200);
    const b2 = BTN1.x + BTN1.w + GAPS[0];
    await mia.to(run, [b2, BTN1.y], { ms: 300 });
    await run.wait(100);
    await mia.drag(run, [b2 + BTN2_W, BTN1.y + BTN1.h], BUTTON_DRAW, { ease: DRAG_EASE, bend: 0, start: () => (setButtons(2), setMiaDrawing(2)) });
    setLabels(2);
    await run.wait(200);
    setMiaDrawing(0);
    mia.use("arrow");
    await mia.to(run, [HEAD.x + 200, F.y + 44], { ms: 650 });
    await run.wait(600);

    // Auto layout: select both, Use auto layout, then drag the gap down
    setBeat("autolayout");
    await run.wait(300);
    await me.to(run, [BTN1.x - 16, BTN1.y - 16], { ms: 650 });
    await run.wait(120);
    await me.drag(run, [b2 + BTN2_W + 16, BTN1.y + BTN1.h + 14], MARQUEE, { ease: DRAG_EASE, bend: 0, start: () => setMarquee(true) });
    setMarquee(false);
    setSel("pair");
    await run.wait(500);
    await me.click(run, AL_TOGGLE, { ms: 700, beat: 260 });
    setAuto(true);
    setSel("row");
    await run.wait(500);
    await me.to(run, GAP_FIELD, { ms: 400 });
    await run.wait(150);
    await me.drag(run, [GAP_FIELD[0] - 40, GAP_FIELD[1]], SCRUB, { ease: DRAG_EASE, bend: 0, start: () => setGap(GAPS[1]) });
    await run.wait(600);

    // Components
    setBeat("components");
    await run.wait(250);
    await me.click(run, MAKE_COMPONENT, { ms: 450, beat: 260 });
    setComponent(true);
    await run.wait(800);

    // AI agents: the Agents panel; you ask, Claude Code lays the cards where its cursor is
    setBeat("ai");
    setAgentPanel(true);
    await run.wait(500);
    await me.click(run, COMPOSER, { ms: 650, beat: 260 });
    await run.type(ASK, setAsk, 3);
    await run.wait(250);
    await me.click(run, SEND, { ms: 380, beat: 220 });
    setSent(true);
    setAsk("");
    await run.wait(400);
    setSteps([{ name: "get_metadata", done: false }]);
    setAgentOn(true);
    await claude.to(run, [CARD.x + 20, CARD.y + 20], { ms: 650 });
    setSteps([{ name: "get_metadata", done: true }, { name: "create_nodes", done: false }]);
    for (let i = 0; i < DAYS.length; i++) {
      if (i) await claude.to(run, [cardX(i) + 20, CARD.y + 20], { ms: 320 });
      await run.wait(140);
      setCards(i + 1);
      await run.wait(260);
    }
    setSteps([{ name: "get_metadata", done: true }, { name: "create_nodes", done: true }]);
    await claude.to(run, [cardX(2) + CARD.w + 28, CARD.y + 30], { ms: 400 });
    setAgentDone(true);
    await run.wait(900);

    // Dev Mode: the toolbar's switch, then a distance
    setBeat("devmode");
    await run.wait(250);
    await me.click(run, DEV_MODE, { ms: 750, beat: 260 });
    setMode("dev");
    setAgentPanel(false);
    await run.wait(600);
    await me.to(run, [HEAD.x + 180, HEAD.y + 30], { ms: 600 });
    await run.wait(120);
    setMeasure(true);
  };

  const script = async (run: Run) => {
    for (;;) {
      await story(run);
      if (run.reduced) return;
      // Rest on the finished file, then clear the canvas and start over
      await run.wait(2500);
      setClearing(true);
      setAgentOn(false);
      setPeople(0);
      await run.wait(400);
      reset();
      for (const p of [me, ken, ada, mia, claude]) p.use("arrow");
      void me.to(run, [640, 640], { ms: 900, ease: BEZIER.standard });
      await Promise.all([ken, ada, mia, claude].map((p, i) => p.to(run, [[316, 620], ADA_FROM, [360, 610], [1110, 600]][i] as Point, { ms: 1 })));
      await run.wait(CLEAR - 400);
      setClearing(false);
      await run.wait(300);
    }
  };

  // ── What the state draws ──
  const x2 = BTN1.x + BTN1.w + gap;
  const pair = { x: BTN1.x, y: BTN1.y, w: BTN1.w + gap + BTN2_W, h: BTN1.h };
  const frame = drawn ? F : { x: F.x, y: F.y, w: 0, h: 0 };
  const drawing = { ms: DRAW, ease: ease.standard };
  const scrubbing = { ms: SCRUB, ease: ease.standard };
  const selTone = mode === "dev" ? "dev" : component ? "component" : "brand";

  const rows: Row[] = [
    { id: "home", name: "Home", icon: "16.frame", strong: true, expanded: headline, selected: sel === "frame", hidden: !drawn },
    { id: "forecast", name: "Forecast", icon: "16.autolayout.horizontal", depth: 1, expanded: true, hidden: cards < 1 },
    // Newest first, as Layers lists them
    ...DAYS.map(([day], i) => ({ id: day, name: day, icon: "16.frame" as const, depth: 2, hidden: cards < i + 1 })).reverse(),
    { id: "buttons", name: "Buttons", icon: component ? "16.component" : "16.autolayout.horizontal", kind: component ? "component" : "default", depth: 1, expanded: true, selected: sel === "row", hidden: !auto },
    { id: "plans", name: "See plans", icon: "16.frame", depth: auto ? 2 : 1, selected: sel === "pair", hidden: labels < 2 },
    { id: "get", name: "Get the app", icon: "16.frame", depth: auto ? 2 : 1, selected: sel === "pair", hidden: labels < 1 },
    { id: "image", name: "Hero image", icon: "16.image", depth: 1, hidden: !image },
    { id: "headline", name: HEADLINE, icon: "16.text", depth: 1, hidden: !headline },
  ];

  return (
    <Collage size={[W, H]} focus={[0.5, 0.42]} safe={720} script={script} className={styles.stage}>
      {/* The caption: which feature this is */}
      <div className={styles.captions} style={{ left: F.x, top: F.y - 72 }}>
        {CAPTIONS.map(([id, label]) => (
          <span key={id} className={styles.caption} data-on={beat === id || undefined}>
            {label}
          </span>
        ))}
      </div>

      {/* ── The canvas (faded out while it clears for the next round) ── */}
      <div className={styles.canvas} data-clearing={clearing || undefined}>
      <FrameName x={F.x} y={F.y} selected={sel === "frame"} show={drawn}>
        <span className={styles.frameName} data-selected={sel === "frame" || undefined}>
          Home
        </span>
      </FrameName>
      <div className={styles.frame} data-drawn={drawn || undefined} style={{ left: F.x, top: F.y, width: F.w, height: F.h, transition: `transform ${DRAW}ms ${css(DRAG_EASE)}` }} />

      {/* Kerem's headline: a text box in his colour while he types */}
      <div className={styles.headline} data-editing={editing || undefined} style={{ left: HEAD.x, top: HEAD.y, width: HEAD.w, ["--c" as string]: CURSOR.green }}>
        {typed}
        {editing && <span className={styles.caret} data-typing={(typed.length > 0 && typed.length < HEADLINE.length) || undefined} />}
      </div>

      {/* Ada's picture */}
      <div className={styles.image} data-on={image || undefined} style={{ left: IMG.x, top: IMG.y, width: IMG.w, height: IMG.h }}>
        <Reveal on={image}>
          <Sky />
        </Reveal>
      </div>

      {/* Mia's buttons, each drawn by her drag (grown from its corner), then labelled */}
      <div className={styles.button} data-drawn={buttons >= 1 || undefined} data-dark="" style={{ left: BTN1.x, top: BTN1.y, width: BTN1.w, height: BTN1.h, ["--c" as string]: CURSOR.orange }}>
        <i data-drawing={miaDrawing === 1 || undefined} style={{ transitionDuration: `${BUTTON_DRAW}ms` }} />
        <span data-on={labels >= 1 || undefined}>Get the app</span>
      </div>
      <div
        className={styles.button}
        data-drawn={buttons >= 2 || undefined}
        style={{ left: 0, top: BTN1.y, width: BTN2_W, height: BTN1.h, transform: `translateX(${x2}px)`, transition: `transform ${SCRUB}ms ${css(DRAG_EASE)}`, ["--c" as string]: CURSOR.orange }}
      >
        <i data-drawing={miaDrawing === 2 || undefined} style={{ transitionDuration: `${BUTTON_DRAW}ms` }} />
        <span data-on={labels >= 2 || undefined}>See plans</span>
      </div>
      {auto && (
        <FrameName x={pair.x} y={pair.y - 2} show={component} tone="component">
          <span className={styles.compName}>
            <Icon name="16.component" /> Buttons
          </span>
        </FrameName>
      )}

      {/* The marquee */}
      <div className={styles.marquee} data-on={marquee || undefined} style={{ left: BTN1.x - 16, top: BTN1.y - 16, width: BTN1.w + GAPS[0] + BTN2_W + 32, height: BTN1.h + 30, transitionDuration: `${MARQUEE}ms` }} />

      {/* Your selection */}
      <Selection box={frame} ms={DRAW} ease={DRAG_EASE} size={<Dims w={frame.w} h={frame.h} {...drawing} />} show={sel === "frame"} />
      <Selection box={pair} tone={selTone} ms={SCRUB} ease={DRAG_EASE} show={sel === "pair" || sel === "row"} size={auto ? <Dims w={pair.w} h="Hug" {...scrubbing} /> : `${pair.w} × ${pair.h}`} />

      {/* Dev Mode: the distance from the headline to the buttons */}
      <span className={styles.measure} data-out={!measure || undefined} style={{ left: BTN1.x + BTN1.w + GAPS[1] + BTN2_W / 2, top: HEAD.y + HEAD_H, height: BTN1.y - HEAD.y - HEAD_H }}>
        <i />
        <b>{BTN1.y - HEAD.y - HEAD_H}</b>
      </span>

      {/* Claude Code's forecast cards, in auto layout under the buttons */}
      {DAYS.map(([day, temp], i) => (
        <div key={day} className={styles.card} data-on={cards > i || undefined} style={{ left: cardX(i), top: CARD.y, width: CARD.w, height: CARD.h }}>
          <span>{day}</span>
          <strong>{temp}</strong>
        </div>
      ))}
      </div>

      {/* ── The panels ── */}
      <Piece surface x={24} y={24} w={240} h={H - 48} d={60} from="left" z={4}>
        <FileHeader name="Orbit — Website" />
        <Layers rows={rows} />
      </Piece>

      <Piece surface x={W - 264} y={24} w={240} h={H - 48} d={120} from="right" z={4}>
        <PanelColumn>
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
              <span className={`${mp.face} ${styles.me}`} data-flip="" style={{ ["--peer" as string]: "var(--figma-color-bg-brand)" }}>
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
            <Tabs
              label="Panels"
              value={mode === "dev" ? "inspect" : "design"}
              tabs={mode === "dev" ? [{ value: "inspect", label: "Inspect" }, { value: "plugins", label: "Plugins" }] : [{ value: "design", label: "Design" }, { value: "prototype", label: "Prototype" }]}
              onChange={noop}
            />
            <span className={panels.zoom}>
              <span>100%</span>
              <Icon name="16.chevron.down" />
            </span>
          </div>
          <DesignBody sel={sel} mode={mode} auto={auto} gap={gap} component={component} frame={frame} pair={pair} drawing={drawing} scrubbing={scrubbing} />
        </PanelColumn>
      </Piece>

      {/* The Agents panel, over the Design panel for the AI beat */}
      <Piece surface x={W - 264} y={24} w={240} h={H - 48} show={agentPanel} from="fade" z={5} className={ai.chatPiece}>
        <ChatPanel composer={ask || "Ask for changes, or describe what to make"} agent="Claude Code">
          {sent && <UserMessage>{ASK}</UserMessage>}
          {steps.length > 0 && (
            <div className={agents.agent}>
              <span className={agents.agentName}>Claude Code</span>
              <Steps steps={steps} />
              {agentDone && <AgentText>Added “Forecast” under the buttons: three day cards in auto layout.</AgentText>}
            </div>
          )}
        </ChatPanel>
      </Piece>

      <Piece x={(264 + W - 264) / 2 - 300} y={H - 24 - 76} w={600} h={76} d={180} z={4}>
        <div className={styles.toolbarSlot}>
          <EditorToolbar floating tool={tool} mode={mode} onMode={noop} onTool={noop} />
        </div>
      </Piece>

      {/* Ada's picture on its way in, under her cursor */}
      <div ref={thumb} className={styles.thumb} data-on={carry !== "off" || undefined} style={{ transform: `translate3d(${(carry === "off" && image ? ADA_TO : ADA_FROM)[0] + CARRY_AT[0]}px, ${(carry === "off" && image ? ADA_TO : ADA_FROM)[1] + CARRY_AT[1]}px, 0)` } as CSSProperties}>
        <Sky />
      </div>

      <Cursor {...claude.state} color={CURSOR.red} name="Claude Code" show={agentOn} z={30} />
      <Cursor {...mia.state} color={CURSOR.orange} name="Mia" show={people >= 3} z={30} />
      <Cursor {...ada.state} color={CURSOR.purple} name="Ada" show={people >= 2} z={30} />
      <Cursor {...ken.state} color={CURSOR.green} name="Kerem" show={people >= 1} z={30} />
      <Cursor {...me.state} color={CURSOR.ink} d={300} z={31} />
    </Collage>
  );
}

interface BodyProps {
  sel: Sel;
  mode: EditorMode;
  auto: boolean;
  gap: number;
  component: boolean;
  frame: { w: number; h: number };
  pair: { w: number; h: number };
  drawing: { ms: number; ease: (t: number) => number };
  scrubbing: { ms: number; ease: (t: number) => number };
}

/** The Design panel for what you have selected (Inspect in Dev Mode). */
function DesignBody({ sel, mode, auto, gap, component, frame, pair, drawing, scrubbing }: BodyProps) {
  const devToggle = <IconButton icon="24.dev-brackets" label="Mark as ready for dev" tone="secondary" />;
  const makeComponent = <IconButton icon="24.component.small" label="Create component" tone="secondary" />;
  const useAuto = <ToggleIconButton icon="24.autolayout-add-vertical" label={auto ? "Remove auto layout" : "Use auto layout"} tone="secondary" pressed={auto} onPressedChange={noop} />;

  if (mode === "dev")
    return (
      <>
        <PanelSection title="Buttons" pad="none" />
        <PanelSection title="Code">
          <div className={styles.code}>
            <CodeBlock code={CSS_CODE} />
          </div>
        </PanelSection>
      </>
    );
  if (sel === "none") return <FillSection title="Page" label="Page colour" hex="FFFFFF" />;
  if (sel === "frame")
    return (
      <>
        <PanelSection title="Frame" pad="none" actions={<>{devToggle}{makeComponent}</>} />
        <Position x={0} y={0} />
        <PanelSection title="Layout" actions={useAuto}>
          <PropertyGrid>
            <PropertyRow>
              <Num label="Width" prefix="W" value={frame.w} {...drawing} />
              <Num label="Height" prefix="H" value={frame.h} {...drawing} />
            </PropertyRow>
          </PropertyGrid>
        </PanelSection>
        <Appearance />
        <FillSection hex="FFFFFF" />
      </>
    );
  if (sel === "pair")
    return (
      <>
        <PanelSection title="2 selected" pad="none" />
        <Position x={BTN1.x - F.x} y={BTN1.y - F.y} />
        <PanelSection title="Layout" actions={useAuto}>
          <PropertyGrid>
            <PropertyRow>
              <Num label="Width" prefix="W" value={pair.w} />
              <Num label="Height" prefix="H" value={pair.h} />
            </PropertyRow>
          </PropertyGrid>
        </PanelSection>
        <Appearance />
      </>
    );
  return (
    <>
      <PanelSection title={component ? "Component" : "Frame"} pad="none" actions={component ? devToggle : <>{devToggle}{makeComponent}</>} />
      <Position x={BTN1.x - F.x} y={BTN1.y - F.y} />
      <PanelSection title="Auto layout" actions={useAuto}>
        <PropertyGrid labels>
          <PropertyRow label="Flow" span={2}>
            <SegmentedControl
              label="Layout"
              fullWidth
              value="HORIZONTAL"
              onChange={noop}
              options={[
                { value: "NONE", icon: "24.layout.freeform", tooltip: "Freeform" },
                { value: "VERTICAL", icon: "24.layout.vertical", tooltip: "Vertical" },
                { value: "HORIZONTAL", icon: "24.layout.horizontal", tooltip: "Horizontal" },
                { value: "GRID", icon: "24.layout.grid", tooltip: "Grid" },
              ]}
            />
          </PropertyRow>
          <PropertyRow label="Dimensions">
            <Num label="Width" prefix="W" value={pair.w} modeLabel="Hug" dimValue {...scrubbing} />
            <Num label="Height" prefix="H" value={pair.h} modeLabel="Hug" dimValue />
          </PropertyRow>
          <PropertyRow label="Gap">
            <Num label="Gap" prefix="24.al.spacing-horizontal" value={gap} {...scrubbing} />
            <span />
          </PropertyRow>
        </PropertyGrid>
      </PanelSection>
      <Appearance />
    </>
  );
}

function Position({ x, y }: { x: number; y: number }) {
  return (
    <PanelSection title="Position">
      <PropertyGrid>
        <PropertyRow>
          <Num label="X-position" prefix="X" value={x} />
          <Num label="Y-position" prefix="Y" value={y} />
        </PropertyRow>
      </PropertyGrid>
    </PanelSection>
  );
}

function Appearance() {
  return (
    <PanelSection title="Appearance">
      <PropertyGrid>
        <PropertyRow>
          <Num label="Opacity" prefix="24.opacity" value={100} unit="%" />
          <Num label="Corner radius" prefix="24.corners" value={0} />
        </PropertyRow>
      </PropertyGrid>
    </PanelSection>
  );
}
