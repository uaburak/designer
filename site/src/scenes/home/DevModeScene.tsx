// Dev Mode: a profile card on the canvas, inspected as the app's Inspect panel does it. Each layer is a NodeChange
// (the document's own fields), and the panel reads it with the viewer's own code: the CSS / SwiftUI / Compose
// generators (src/viewer/inspect), the redlines between the selection and the hovered layer, the panel's styles. The
// selection is Dev Mode's green; the bottom toolbar's mode switch is the app's.
import { useMemo, useRef, useState, type ReactNode } from "react";
import { EditorToolbar, type ToolId } from "@/ds/components/EditorToolbar";
import { CodeBlock } from "@/ds/components/Misc";
import { PanelSection } from "@/ds/components/PanelSection";
import { Tabs } from "@/ds/components/Tabs";
import panels from "@/editor/panels/Panels.module.css";
import { Select } from "@/ds/components/Select";
import { Swatch } from "@/ds/components/Swatch";
import { showToast } from "@/ds/components/Toast";
import { Icon, type IconName } from "@/ds/icons/Icon";
import type { Color, NodeChange } from "@/engine/codec";
import { StatusTag } from "@/editor/devmode/StatusTag";
import { cssLines, cssSnippet } from "../../../../src/viewer/inspect/css";
import { redlines, type Redline } from "../../../../src/viewer/inspect/measure";
import { cornersOf, hexOf, isAutoLayout, num, paddingOf, sizingOf, typeLabel, typographyOf, visiblePaints, type InspectInput } from "../../../../src/viewer/inspect/model";
import { compose, swiftUI } from "../../../../src/viewer/inspect/native";
import { composeInUnit, cssInUnit, DEFAULT_UNITS, swiftUIInUnit, type Language } from "../../../../src/viewer/inspect/units";
import viewer from "../../../../src/viewer/Viewer.module.css";
import { FrameLabel, Panel, SceneBody, SceneCanvas, SceneWindow, Selection, type Box } from "../kit/kit";
import { DemoCursor, useDemo, type SceneRun } from "../runtime/useDemo";
import { clamp, useSize } from "./shared";
import styles from "./devmode.module.css";

// ---- The design: layers as the document holds them (positions in the card) ------------------------------------

const rgb = (hex: string): Color => ({ r: parseInt(hex.slice(1, 3), 16) / 255, g: parseInt(hex.slice(3, 5), 16) / 255, b: parseInt(hex.slice(5, 7), 16) / 255, a: 1 });
const solid = (hex: string) => [{ type: "SOLID", color: rgb(hex), opacity: 1, visible: true }];
const inter = (style: string) => ({ family: "Inter", style, postscript: `Inter-${style.replace(/\s/g, "")}` });

interface Layer {
  id: string;
  icon: IconName;
  parent: string | null;
  box: Box;
  node: NodeChange;
}

const N = (n: Omit<NodeChange, "guid">) => n as NodeChange;

const CARD_W = 288;
const CARD_H = 228;
const BIO = "Designs calm interfaces for busy people. Writes about type, colour and the systems behind them.";

const LAYERS: Layer[] = [
  {
    id: "card",
    icon: "16.frame",
    parent: null,
    box: { x: 0, y: 0, w: CARD_W, h: CARD_H },
    node: N({
      type: "FRAME",
      name: "Profile card",
      size: { x: CARD_W, y: CARD_H },
      fillPaints: solid("#ffffff"),
      cornerRadius: 16,
      stackMode: "VERTICAL",
      stackSpacing: 16,
      stackHorizontalPadding: 24,
      stackVerticalPadding: 24,
      stackCounterSizing: "FIXED",
      effects: [{ type: "DROP_SHADOW", color: { r: 0, g: 0, b: 0, a: 0.08 }, offset: { x: 0, y: 4 }, radius: 16, spread: 0, visible: true }],
    }),
  },
  {
    id: "header",
    icon: "16.frame",
    parent: "card",
    box: { x: 24, y: 24, w: 240, h: 48 },
    node: N({ type: "FRAME", name: "Header", size: { x: 240, y: 48 }, stackMode: "HORIZONTAL", stackSpacing: 12, stackCounterAlignItems: "CENTER", stackChildAlignSelf: "STRETCH" }),
  },
  { id: "avatar", icon: "16.ellipse", parent: "header", box: { x: 24, y: 24, w: 48, h: 48 }, node: N({ type: "ELLIPSE", name: "Avatar", size: { x: 48, y: 48 }, fillPaints: solid("#f4b9a2") }) },
  {
    id: "title",
    icon: "16.frame",
    parent: "header",
    box: { x: 84, y: 28, w: 104, h: 40 },
    node: N({ type: "FRAME", name: "Title", size: { x: 104, y: 40 }, stackMode: "VERTICAL", stackSpacing: 2 }),
  },
  {
    id: "name",
    icon: "16.text",
    parent: "title",
    box: { x: 84, y: 28, w: 78, h: 20 },
    node: N({ type: "TEXT", name: "Mina Park", size: { x: 78, y: 20 }, textData: { characters: "Mina Park" }, fontName: inter("Semi Bold"), fontSize: 16, lineHeight: { value: 20, units: "PIXELS" }, textAutoResize: "WIDTH_AND_HEIGHT", fillPaints: solid("#1e1e1e") }),
  },
  {
    id: "role",
    icon: "16.text",
    parent: "title",
    box: { x: 84, y: 50, w: 104, h: 18 },
    node: N({ type: "TEXT", name: "Product designer", size: { x: 104, y: 18 }, textData: { characters: "Product designer" }, fontName: inter("Regular"), fontSize: 13, lineHeight: { value: 18, units: "PIXELS" }, textAutoResize: "WIDTH_AND_HEIGHT", fillPaints: solid("#7a7a7a") }),
  },
  {
    id: "bio",
    icon: "16.text",
    parent: "card",
    box: { x: 24, y: 88, w: 240, h: 60 },
    node: N({ type: "TEXT", name: "Bio", size: { x: 240, y: 60 }, textData: { characters: BIO }, fontName: inter("Regular"), fontSize: 14, lineHeight: { value: 20, units: "PIXELS" }, textAutoResize: "HEIGHT", stackChildAlignSelf: "STRETCH", fillPaints: solid("#4a4a4a") }),
  },
  {
    id: "button",
    icon: "16.frame",
    parent: "card",
    box: { x: 24, y: 164, w: 240, h: 40 },
    node: N({
      type: "FRAME",
      name: "Button",
      size: { x: 240, y: 40 },
      stackMode: "HORIZONTAL",
      stackPrimarySizing: "FIXED",
      stackPrimaryAlignItems: "CENTER",
      stackCounterAlignItems: "CENTER",
      stackHorizontalPadding: 16,
      stackVerticalPadding: 10,
      stackChildAlignSelf: "STRETCH",
      cornerRadius: 8,
      fillPaints: solid("#5b5bd6"),
    }),
  },
  {
    id: "label",
    icon: "16.text",
    parent: "button",
    box: { x: 122, y: 174, w: 44, h: 20 },
    node: N({ type: "TEXT", name: "Follow", size: { x: 44, y: 20 }, textData: { characters: "Follow" }, fontName: inter("Semi Bold"), fontSize: 14, lineHeight: { value: 20, units: "PIXELS" }, textAutoResize: "WIDTH_AND_HEIGHT", fillPaints: solid("#ffffff") }),
  },
];
const BY_ID = new Map(LAYERS.map((l) => [l.id, l]));

const inputOf = (l: Layer): InspectInput => ({ node: l.node, parentStackMode: l.parent ? (BY_ID.get(l.parent)!.node.stackMode ?? null) : null });

// Dev Mode keeps Move, Hand, Comment, Annotation and Measurement (the app's BottomToolbar)
const NOT_IN_DEV: ToolId[] = ["scale", "frame", "section", "slice", "rectangle", "line", "arrow", "ellipse", "polygon", "star", "image", "pen", "pencil", "brush", "text", "text-on-path"];

const LANGUAGES = [
  { value: "css", label: "CSS" },
  { value: "swiftui", label: "iOS (SwiftUI)" },
  { value: "compose", label: "Android (Compose)" },
];

function copy(text: string) {
  void navigator.clipboard?.writeText(text).then(
    () => showToast({ message: "Copied to clipboard" }),
    () => showToast({ message: "Couldn't copy" }),
  );
}

/** A value Dev Mode copies when clicked (the Inspect panel's own). */
function Value({ label, value, copyText, lead, sub }: { label?: string; value: ReactNode; copyText: string; lead?: ReactNode; sub?: string | null }) {
  return (
    <button type="button" className={viewer.value} onClick={() => copy(copyText)} title="Copy">
      {lead}
      {label && <span className={viewer.valueLabel}>{label}</span>}
      <span className={viewer.valueText}>{value}</span>
      {sub && <span className={viewer.valueSub}>{sub}</span>}
    </button>
  );
}

// ---- The scene --------------------------------------------------------------------------------------------------

interface State {
  selected: string | null;
  hovered: string | null;
  language: Language;
}
const FIRST: State = { selected: "button", hovered: null, language: "css" };

export default function DevModeScene() {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const [s, setS] = useState<State>(FIRST);
  const set = (patch: Partial<State>) => setS((x) => ({ ...x, ...patch }));

  const size = useSize(canvasRef);
  const narrow = size.w < 520;
  const ws = clamp(Math.min((size.w - 64) / CARD_W, (size.h - (narrow ? 72 : 140)) / CARD_H), 0.5, 1.5);
  const wx = Math.round((size.w - CARD_W * ws) / 2);
  const wy = Math.round((size.h - (narrow ? 0 : 56) - CARD_H * ws) / 2) + 8;
  const toCanvas = (b: Box): Box => ({ x: wx + b.x * ws, y: wy + b.y * ws, w: b.w * ws, h: b.h * ws });

  const sel = s.selected ? BY_ID.get(s.selected)! : null;
  const hov = s.hovered && s.hovered !== s.selected ? BY_ID.get(s.hovered)! : null;
  const lines = useMemo(() => {
    if (!sel || !hov) return [];
    const b = (l: Layer) => ({ x: l.box.x, y: l.box.y, width: l.box.w, height: l.box.h });
    return redlines(b(sel), b(hov));
  }, [sel, hov]);

  const { cursor } = useDemo(rootRef, (run) => demo(run, set), {
    onStart: () => {
      setS({ ...FIRST, selected: null });
    },
  });

  return (
    <SceneWindow ref={rootRef} title="Profile — Dev Mode" className={styles.root}>
      <SceneBody>
        <SceneCanvas ref={canvasRef} className={styles.canvas}>
          {size.w > 0 && (
            <>
              <FrameLabel x={wx} y={wy} selected={s.selected === "card"}>
                <span className={styles.frameLabel}>
                  Profile card
                  <span className={styles.ready}>
                    <StatusTag workflow="ready-to-dev" variant="chip" />
                  </span>
                </span>
              </FrameLabel>
              <div className={styles.world} style={{ transform: `translate(${wx}px, ${wy}px) scale(${ws})` }}>
                <Card />
              </div>
              {hov && <div className={styles.hover} data-measure style={boxStyle(toCanvas(hov.box))} />}
              <Selection box={sel ? toCanvas(sel.box) : null} tone="dev" handles={false} label={sel ? `${num(sel.box.w)} × ${num(sel.box.h)}` : undefined} instant />
              <Redlines lines={lines} map={(x, y) => [wx + x * ws, wy + y * ws]} />
              {!narrow && (
                <div className={styles.toolbar}>
                  <EditorToolbar floating tool="move" mode="dev" onMode={() => {}} onTool={() => {}} disabledModes={["draw", "motion"]} disabledTools={NOT_IN_DEV} />
                </div>
              )}
            </>
          )}
          <DemoCursor cursor={cursor} />
        </SceneCanvas>
        <Panel>
          <div className={panels.rightTabs}>
            <Tabs
              label="Dev Mode"
              value="inspect"
              tabs={[
                { value: "inspect", label: "Inspect" },
                { value: "plugins", label: "Plugins" },
              ]}
              onChange={() => {}}
            />
          </div>
          {sel ? (
            <Inspect layer={sel} language={s.language} onLanguage={(language) => set({ language })} />
          ) : (
            <>
              <div className={viewer.layerHeader}>
                <Icon name="16.page" />
                <div className={viewer.layerTitle}>
                  <span className={viewer.layerName}>Profile</span>
                  <span className={viewer.layerType}>Page</span>
                </div>
              </div>
              <PanelSection title="Code" actions={<LanguageSelect value={s.language} onChange={(language) => set({ language })} />}>
                <div className={viewer.hint}>Select a layer to see its code.</div>
              </PanelSection>
            </>
          )}
        </Panel>
      </SceneBody>
    </SceneWindow>
  );
}

const boxStyle = (b: Box) => ({ left: b.x, top: b.y, width: b.w, height: b.h });

/** The card as it's drawn: each layer flat and absolutely placed, in its document order (hit-testing picks the top one). */
function Card() {
  const at = (id: string) => {
    const b = BY_ID.get(id)!.box;
    return { "data-id": id, style: boxStyle(b) };
  };
  return (
    <>
      <div className={styles.card} {...at("card")} />
      <div className={styles.group} {...at("header")} />
      <div className={styles.avatar} {...at("avatar")}>
        <svg viewBox="0 0 48 48" width="48" height="48" aria-hidden="true">
          <circle cx="24" cy="19" r="9" fill="#8a4b3a" />
          <path d="M8 44c2-10 9-14 16-14s14 4 16 14" fill="#8a4b3a" />
        </svg>
      </div>
      <div className={styles.group} {...at("title")} />
      <div className={styles.name} {...at("name")}>
        Mina Park
      </div>
      <div className={styles.role} {...at("role")}>
        Product designer
      </div>
      <div className={styles.bio} {...at("bio")}>
        {BIO}
      </div>
      <div className={styles.button} {...at("button")} />
      <div className={styles.label} {...at("label")}>
        Follow
      </div>
    </>
  );
}

/** Dev Mode's measurements: red lines and their values (the viewer's Measurements, over a DOM canvas). */
function Redlines({ lines, map }: { lines: Redline[]; map: (x: number, y: number) => [number, number] }) {
  if (!lines.length) return null;
  return (
    <svg className={viewer.measure} aria-hidden="true" style={{ zIndex: 6 }} data-measurements={lines.filter((l) => !l.guide).map((l) => num(l.value)).join(",")}>
      {lines.map((l, i) => {
        const [x1, y1] = map(l.x1, l.y1);
        const [x2, y2] = map(l.x2, l.y2);
        if (l.guide) return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} className={viewer.measureGuide} />;
        const text = num(l.value);
        const w = Math.max(20, text.length * 7 + 8);
        const vertical = Math.abs(x1 - x2) < Math.abs(y1 - y2);
        const mx = (x1 + x2) / 2;
        const my = (y1 + y2) / 2;
        const lx = vertical ? mx + 4 : mx - w / 2;
        const ly = vertical ? my - 8 : my + 4;
        return (
          <g key={i}>
            <line x1={x1} y1={y1} x2={x2} y2={y2} className={viewer.measureLine} />
            {vertical ? (
              <>
                <line x1={x1 - 3} y1={y1} x2={x1 + 3} y2={y1} className={viewer.measureLine} />
                <line x1={x2 - 3} y1={y2} x2={x2 + 3} y2={y2} className={viewer.measureLine} />
              </>
            ) : (
              <>
                <line x1={x1} y1={y1 - 3} x2={x1} y2={y1 + 3} className={viewer.measureLine} />
                <line x1={x2} y1={y2 - 3} x2={x2} y2={y2 + 3} className={viewer.measureLine} />
              </>
            )}
            <rect x={lx} y={ly} width={w} height={16} rx={2} className={viewer.measureLabel} />
            <text x={lx + w / 2} y={ly + 8} className={viewer.measureText}>
              {text}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function LanguageSelect({ value, onChange }: { value: Language; onChange: (l: Language) => void }) {
  return <Select label="Language" variant="ghost" value={value} options={LANGUAGES} onChange={(v) => onChange(v as Language)} menuWidth={150} data-demo="language" />;
}

/** The Inspect panel for one layer: header and status, Layout, Code, Colors, Typography. */
function Inspect({ layer, language, onLanguage }: { layer: Layer; language: Language; onLanguage: (l: Language) => void }) {
  const input = inputOf(layer);
  const n = layer.node;
  const blocks = useMemo(() => {
    const input = inputOf(layer);
    if (language === "swiftui") return [{ title: "SwiftUI", code: swiftUIInUnit(swiftUI(input), DEFAULT_UNITS) }];
    if (language === "compose") return [{ title: "Compose", code: composeInUnit(compose(input), DEFAULT_UNITS) }];
    const s = cssSnippet(input);
    return [
      { title: "Layout", code: cssInUnit(cssLines(s.layout), DEFAULT_UNITS) },
      { title: "Style", code: cssInUnit(cssLines(s.style), DEFAULT_UNITS) },
      { title: "Typography", code: s.typography.length ? cssInUnit(cssLines(s.typography), DEFAULT_UNITS) : "" },
    ].filter((b) => b.code);
  }, [layer, language]);
  const sizing = sizingOf(input);
  const parent = layer.parent ? BY_ID.get(layer.parent)! : null;
  const left = parent ? layer.box.x - parent.box.x : 0;
  const top = parent ? layer.box.y - parent.box.y : 0;
  const p = isAutoLayout(n) ? paddingOf(n) : null;
  const corners = cornersOf(n);
  const fills = visiblePaints(n.fillPaints);
  const text = n.type === "TEXT" ? typographyOf(n) : null;
  return (
    <div className={styles.inspect} key={layer.id}>
      <div className={viewer.layerHeader}>
        <Icon name={layer.icon} />
        <div className={viewer.layerTitle}>
          <span className={viewer.layerName}>{n.name}</span>
          <span className={viewer.layerType}>{typeLabel(n)}</span>
        </div>
        <span className={viewer.devStatus}>
          <StatusTag workflow="ready-to-dev" variant="chip" />
        </span>
      </div>
      <PanelSection title="Layout">
        <div className={viewer.boxModel} aria-label="Box model">
          {p && (
            <>
              <span className={viewer.boxModelLabel}>Padding</span>
              <button type="button" className={viewer.boxTop} onClick={() => copy(`${num(p.top)}px`)}>
                {num(p.top)}
              </button>
              <button type="button" className={viewer.boxRight} onClick={() => copy(`${num(p.right)}px`)}>
                {num(p.right)}
              </button>
              <button type="button" className={viewer.boxBottom} onClick={() => copy(`${num(p.bottom)}px`)}>
                {num(p.bottom)}
              </button>
              <button type="button" className={viewer.boxLeft} onClick={() => copy(`${num(p.left)}px`)}>
                {num(p.left)}
              </button>
            </>
          )}
          <button type="button" className={viewer.boxSize} onClick={() => copy(`width: ${num(layer.box.w)}px;\nheight: ${num(layer.box.h)}px;`)}>
            {num(layer.box.w)} × {num(layer.box.h)}
          </button>
        </div>
        <div className={viewer.grid2}>
          <Value label="Width" value={`${num(layer.box.w)}px`} sub={sizing.width !== "Fixed" ? sizing.width : null} copyText={`${num(layer.box.w)}px`} />
          <Value label="Height" value={`${num(layer.box.h)}px`} sub={sizing.height !== "Fixed" ? sizing.height : null} copyText={`${num(layer.box.h)}px`} />
          <Value label="Left" value={`${num(left)}px`} copyText={`${num(left)}px`} />
          <Value label="Top" value={`${num(top)}px`} copyText={`${num(top)}px`} />
          {corners && <Value label="Radius" value={`${num(corners.tl)}px`} copyText={`${num(corners.tl)}px`} />}
        </div>
      </PanelSection>
      <PanelSection title="Code" actions={<LanguageSelect value={language} onChange={onLanguage} />}>
        <div className={viewer.code} data-language={language}>
          {blocks.map((b) => (
            <div key={b.title} className={viewer.codeGroup}>
              {blocks.length > 1 && <div className={viewer.codeTitle}>{b.title}</div>}
              <CodeBlock code={b.code} label="Copy" />
            </div>
          ))}
        </div>
      </PanelSection>
      {fills.length > 0 && (
        <PanelSection title="Colors">
          <div className={viewer.subTitle}>{text ? "Text" : "Fill"}</div>
          {fills.map((f, i) => {
            const hex = hexOf(f.color!);
            return <Value key={i} lead={<Swatch color={hex} opacity={100} />} value={hex} copyText={hex} />;
          })}
        </PanelSection>
      )}
      {text && (
        <PanelSection title="Typography">
          <div className={viewer.typePreview}>
            <span>
              {text.family} · {text.style}
            </span>
          </div>
          <div className={viewer.grid2}>
            <Value label="Font" value={text.family} copyText={text.family} />
            <Value label="Weight" value={`${text.weight}`} sub={text.style} copyText={String(text.weight)} />
            <Value label="Size" value={`${num(text.size)}px`} copyText={`${num(text.size)}px`} />
            <Value label="Line height" value={text.lineHeightPx === null ? "Auto" : `${num(text.lineHeightPx)}px`} copyText={text.lineHeightPx === null ? "normal" : `${num(text.lineHeightPx)}px`} />
          </div>
        </PanelSection>
      )}
    </div>
  );
}

async function demo(run: SceneRun, set: (p: Partial<State>) => void) {
  await run.wait(700);
  // Select the button
  await run.click(run.$('[data-id="button"]'), { dx: -60 });
  set({ selected: "button" });
  await run.wait(1100);
  // Hover the avatar: the distances between the two
  await run.move(run.$('[data-id="avatar"]'));
  set({ hovered: "avatar" });
  await run.wait(1400);
  await run.move(run.$('[data-id="bio"]'), { dx: 30 });
  set({ hovered: "bio" });
  await run.wait(1200);
  set({ hovered: null });
  // SwiftUI
  await run.click(run.$('[data-demo="language"]'));
  set({ language: "swiftui" });
  await run.wait(1500);
  await run.click(run.$('[data-id="name"]'));
  set({ selected: "name" });
  await run.wait(1500);
  await run.click(run.$('[data-demo="language"]'));
  set({ language: "compose" });
  await run.wait(1500);
  set({ language: "css" });
  run.hide();
  await run.wait(1000);
}
