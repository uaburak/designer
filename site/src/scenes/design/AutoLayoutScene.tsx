// Auto layout: a frame of cards laid out by the same rules as the engine's (flow, gap, padding, alignment), edited
// with the app's own Auto layout and Fill sections — the gap scrubbed in the panel or dragged on the canvas, the
// direction switched, the fill picked in the real colour picker.
import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { AlignmentMatrix, type Alignment } from "@/ds/components/AlignmentMatrix";
import { IconButton } from "@/ds/components/Button";
import { ColorInput } from "@/ds/components/ColorInput";
import { ColorPicker } from "@/ds/components/ColorPicker";
import { NumericInput } from "@/ds/components/NumericInput";
import { PanelSection } from "@/ds/components/PanelSection";
import { PropertyGrid, PropertyRow } from "@/ds/components/PropertyGrid";
import { SegmentedControl } from "@/ds/components/SegmentedControl";
import type { ChangeInfo } from "@/ds/types";
import { hexToRgba, rgbToHex } from "@/ds/util/color";
import type { PickerPaint } from "@/ds/util/paint";
import { boxIn, FrameLabel, Panel, SceneBody, SceneCanvas, SceneWindow, Selection, type Box } from "../kit/kit";
import { DemoCursor, useDemo, type SceneRun } from "../runtime/useDemo";
import styles from "./autolayout.module.css";

type Flow = "VERTICAL" | "HORIZONTAL" | "WRAP";

interface Layout {
  flow: Flow;
  gap: number;
  padH: number;
  padV: number;
  align: Alignment;
  fill: string;
  radius: number;
}

const FIRST: Layout = { flow: "HORIZONTAL", gap: 16, padH: 24, padV: 24, align: { primary: "MIN", counter: "MIN" }, fill: "#ffffff", radius: 16 };

const CARDS = [
  { name: "Starter", price: "$0", note: "For one designer", tint: "#e5f4ff", mark: "#0d99ff" },
  { name: "Pro", price: "$12", note: "Unlimited files", tint: "#f1e8ff", mark: "#9747ff" },
  { name: "Team", price: "$24", note: "Libraries and sharing", tint: "#ffeedb", mark: "#ffa629" },
];

const css = (a: Alignment["primary"]) => (a === "MIN" ? "flex-start" : a === "MAX" ? "flex-end" : a === "CENTER" ? "center" : "space-between");

export default function AutoLayoutScene() {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const [l, setL] = useState<Layout>(FIRST);
  const [box, setBox] = useState<Box | null>(null);
  const [gaps, setGaps] = useState<Box[]>([]);
  const [showGap, setShowGap] = useState(false);
  const [picker, setPicker] = useState<DOMRect | null>(null);
  const set = (patch: Partial<Layout>) => setL((s) => ({ ...s, ...patch }));

  // The selection and the gap highlights follow the laid-out DOM, as the engine's overlay follows its layout
  useLayoutEffect(() => {
    const frame = frameRef.current;
    const canvas = canvasRef.current;
    if (!frame || !canvas) return;
    const measure = () => {
      setBox(boxIn(frame, canvas));
      const kids = [...frame.children] as HTMLElement[];
      const out: Box[] = [];
      for (let i = 0; i < kids.length - 1; i++) {
        const a = boxIn(kids[i], canvas)!;
        const b = boxIn(kids[i + 1], canvas)!;
        if (l.flow === "VERTICAL") out.push({ x: Math.min(a.x, b.x), y: a.y + a.h, w: Math.max(a.w, b.w), h: Math.max(0, b.y - a.y - a.h) });
        else if (Math.abs(a.y - b.y) < 2) out.push({ x: a.x + a.w, y: Math.min(a.y, b.y), w: Math.max(0, b.x - a.x - a.w), h: Math.max(a.h, b.h) });
      }
      setGaps(out);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(frame);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [l]);

  // Dragging a gap on the canvas (Figma's spacing handles): along the flow, one px per px
  const dragGap = (e: React.PointerEvent) => {
    e.preventDefault();
    const start = { x: e.clientX, y: e.clientY, gap: l.gap };
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    setShowGap(true);
    const move = (ev: PointerEvent) => {
      const d = l.flow === "VERTICAL" ? ev.clientY - start.y : ev.clientX - start.x;
      set({ gap: Math.max(0, Math.min(96, Math.round(start.gap + d))) });
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      setShowGap(false);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };

  const { cursor } = useDemo(rootRef, (run) => demo(run, set, setShowGap, setPicker), { onStart: () => { setL(FIRST); setPicker(null); } });

  const frameStyle: CSSProperties = {
    flexDirection: l.flow === "VERTICAL" ? "column" : "row",
    flexWrap: l.flow === "WRAP" ? "wrap" : "nowrap",
    width: l.flow === "WRAP" ? 420 : undefined,
    gap: l.gap,
    padding: `${l.padV}px ${l.padH}px`,
    justifyContent: css(l.align.primary),
    alignItems: l.align.counter === "MIN" ? "flex-start" : l.align.counter === "MAX" ? "flex-end" : "center",
    alignContent: "flex-start",
    background: l.fill,
    borderRadius: l.radius,
  };
  const dir = l.flow === "VERTICAL" ? "vertical" : "horizontal";
  const size = box ? `${Math.round(box.w)} × ${Math.round(box.h)}` : "";
  const paint: PickerPaint = { type: "SOLID", color: { ...(hexToRgba(l.fill) ?? { r: 1, g: 1, b: 1, a: 1 }), a: 1 }, opacity: 1 };

  return (
    <SceneWindow ref={rootRef} title="Pricing — Auto layout">
      <SceneBody>
        <SceneCanvas ref={canvasRef} className={styles.canvas}>
          <div className={styles.center}>
            <div className={styles.frameWrap}>
              <FrameLabel x={0} y={0} selected>
                Plans
              </FrameLabel>
              <div ref={frameRef} className={styles.frame} style={frameStyle} data-flow={l.flow}>
                {CARDS.map((c) => (
                  <div key={c.name} className={styles.card} style={{ ["--tint" as string]: c.tint, ["--mark" as string]: c.mark }}>
                    <span className={styles.mark} />
                    <span className={styles.cardName}>{c.name}</span>
                    <span className={styles.price}>
                      {c.price}
                      <small>/mo</small>
                    </span>
                    <span className={styles.note}>{c.note}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
          {gaps.map((g, i) => (
            <div
              key={i}
              className={styles.gap}
              data-shown={showGap || undefined}
              data-dir={dir}
              style={{ left: g.x, top: g.y, width: Math.max(g.w, l.flow === "VERTICAL" ? 0 : 1), height: Math.max(g.h, 1) }}
            >
              <span className={styles.gapHandle} onPointerDown={dragGap} onPointerEnter={() => setShowGap(true)} onPointerLeave={(e) => e.buttons === 0 && setShowGap(false)} aria-label="Gap" role="slider" aria-valuenow={l.gap} />
            </div>
          ))}
          <Selection box={box} label={size} />
          <DemoCursor cursor={cursor} />
        </SceneCanvas>
        <Panel>
          <PanelSection title="Auto layout" actions={<IconButton icon="24.minus.small" label="Remove auto layout" tone="secondary" />}>
            <PropertyGrid labels>
              <PropertyRow label="Flow" span={2}>
                <SegmentedControl
                  label="Layout"
                  fullWidth
                  value={l.flow}
                  data-demo="flow"
                  options={[
                    { value: "VERTICAL", icon: "24.layout.vertical", tooltip: "Vertical" },
                    { value: "HORIZONTAL", icon: "24.layout.horizontal", tooltip: "Horizontal" },
                    { value: "WRAP", icon: "24.layout.wrap", tooltip: "Wrap" },
                  ]}
                  onChange={(v) => set({ flow: v as Flow })}
                />
              </PropertyRow>
              <PropertyRow label="Dimensions">
                <NumericInput label="Width" prefix="W" value={box ? Math.round(box.w) : 0} modeLabel={l.flow === "WRAP" ? undefined : "Hug"} dimValue={l.flow !== "WRAP"} onChange={() => {}} />
                <NumericInput label="Height" prefix="H" value={box ? Math.round(box.h) : 0} modeLabel="Hug" dimValue onChange={() => {}} />
              </PropertyRow>
              <PropertyRow labels={["Alignment", "Gap"]}>
                <AlignmentMatrix direction={dir} value={l.align} onChange={(align) => set({ align })} data-demo="align" />
                <NumericInput
                  label="Gap"
                  data-demo="gap"
                  prefix={l.flow === "VERTICAL" ? "24.al.spacing-vertical" : "24.al.spacing-horizontal"}
                  min={0}
                  max={200}
                  value={l.gap}
                  valueLabel={l.align.primary === "SPACE_BETWEEN" ? "Auto" : undefined}
                  onChange={(gap) => set({ gap, ...(l.align.primary === "SPACE_BETWEEN" ? { align: { ...l.align, primary: "MIN" } } : {}) })}
                  onFocusChange={setShowGap}
                />
              </PropertyRow>
              <PropertyRow label="Padding">
                <NumericInput label="Horizontal padding" prefix="24.al.padding-horizontal" min={0} value={l.padH} onChange={(padH) => set({ padH })} />
                <NumericInput label="Vertical padding" prefix="24.al.padding-vertical" min={0} value={l.padV} onChange={(padV) => set({ padV })} />
              </PropertyRow>
            </PropertyGrid>
          </PanelSection>
          <PanelSection title="Appearance">
            <PropertyGrid labels>
              <PropertyRow labels={["Opacity", "Corner radius"]}>
                <NumericInput label="Opacity" prefix="24.opacity" unit="%" value={100} min={0} max={100} onChange={() => {}} />
                <NumericInput label="Corner radius" prefix="24.corners" min={0} max={64} value={l.radius} onChange={(radius) => set({ radius })} />
              </PropertyRow>
            </PropertyGrid>
          </PanelSection>
          <PanelSection title="Fill" actions={<IconButton icon="24.plus.small" label="Add fill" tone="secondary" />}>
            <PropertyGrid>
              <PropertyRow span={2} action={<IconButton icon="24.minus.small" label="Remove fill" tone="secondary" />}>
                <ColorInput label="Fill" data-demo="fill" color={l.fill} opacity={100} onColor={(hex) => set({ fill: hex })} onOpacity={() => {}} onSwatchClick={setPicker} />
              </PropertyRow>
            </PropertyGrid>
          </PanelSection>
          {picker && (
            <ColorPicker
              value={paint}
              anchor={picker}
              paintTypes={["SOLID"]}
              documentColors={["#ffffff", "#1e1e1e", "#e5f4ff", "#f1e8ff", "#ffeedb", "#0d99ff"]}
              onChange={(p: PickerPaint, _info: ChangeInfo) => p.color && set({ fill: rgbToHex(p.color) })}
              onClose={() => setPicker(null)}
            />
          )}
        </Panel>
      </SceneBody>
    </SceneWindow>
  );
}

async function demo(run: SceneRun, set: (p: Partial<Layout>) => void, setShowGap: (on: boolean) => void, setPicker: (r: DOMRect | null) => void) {
  await run.wait(700);
  // Scrub the gap from its icon
  const gapIcon = run.$('[data-demo="gap"] [data-ds-scrub-handle], [data-demo="gap"] svg');
  await run.move(gapIcon);
  run.press(true);
  setShowGap(true);
  for (let g = 16; g <= 44; g += 2) {
    set({ gap: g });
    await run.move(run.at(gapIcon, (g - 16) * 2), { ms: 45 });
  }
  run.press(false);
  await run.wait(700);
  setShowGap(false);
  // Vertical
  await run.click(run.$('[data-demo="flow"] [role="radio"]:nth-child(1), [data-demo="flow"] button:nth-child(1)'));
  set({ flow: "VERTICAL", gap: 12 });
  await run.wait(1300);
  // Centre the cards across
  await run.click(run.$('[data-demo="align"] button:nth-child(2), [data-demo="align"] [role="radio"]:nth-child(2)'));
  set({ align: { primary: "MIN", counter: "CENTER" } });
  await run.wait(900);
  // Back to horizontal
  await run.click(run.$('[data-demo="flow"] [role="radio"]:nth-child(2), [data-demo="flow"] button:nth-child(2)'));
  set({ flow: "HORIZONTAL", gap: 20, align: { primary: "MIN", counter: "MIN" } });
  await run.wait(900);
  // A fill from the picker
  const swatch = run.$('[data-demo="fill"] button, [data-demo="fill"] [role="button"]');
  await run.click(swatch);
  if (swatch) setPicker(swatch.getBoundingClientRect());
  await run.wait(700);
  for (const fill of ["#f5f5f5", "#eaf6ef", "#1e1e1e"]) {
    set({ fill });
    await run.wait(650);
  }
  await run.wait(900);
  setPicker(null);
  set({ fill: "#ffffff" });
  run.hide();
  await run.wait(800);
}
