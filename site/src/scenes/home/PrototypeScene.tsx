// Prototype: two frames on the canvas joined by the blue connection Figma draws, the Prototype tab's interaction
// (trigger, Navigate to, animation, direction, curve, duration — the app's own lists and panel styles), and the
// inline preview playing it: the demo taps the card and the frames change with the chosen animation; Smart animate matches the
// layers by name and moves them (FLIP with the Web Animations API, transform and opacity only); Back reverses it.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { IconButton } from "@/ds/components/Button";
import { Checkbox } from "@/ds/components/Checkbox";
import { NumericInput } from "@/ds/components/NumericInput";
import { PanelSection } from "@/ds/components/PanelSection";
import { SegmentedControl } from "@/ds/components/SegmentedControl";
import { Select } from "@/ds/components/Select";
import { Tabs } from "@/ds/components/Tabs";
import { Icon } from "@/ds/icons/Icon";
import { ANIMATIONS, EASINGS, isDirectional, type Animation, type Direction } from "@/editor/model/prototype";
import panels from "@/editor/panels/Panels.module.css";
import proto from "@/editor/panels/prototype/Prototype.module.css";
import { FrameLabel, Panel, SceneBody, SceneCanvas, SceneWindow, Selection } from "../kit/kit";
import { DemoCursor, useDemo, type SceneRun } from "../runtime/useDemo";
import { CARD, DetailScreen, ProductScreen, SCREEN_H, SCREEN_W } from "./protoScreens";
import { timingOf, type Timing } from "./motion";
import { clamp, useSize } from "./shared";
import styles from "./prototype.module.css";

type Trigger = "ON_CLICK" | "MOUSE_ENTER";
type Screen = "product" | "detail";

interface Proto {
  selected: boolean;
  trigger: Trigger;
  dest: "DETAIL" | "NONE";
  animation: Animation;
  direction: Direction;
  matching: boolean;
  easing: string;
  duration: number;
}

const FIRST: Proto = { selected: true, trigger: "ON_CLICK", dest: "DETAIL", animation: "DISSOLVE", direction: "LEFT", matching: false, easing: "OUT_CUBIC", duration: 300 };

const TRIGGERS = [
  { value: "ON_CLICK", label: "On click", icon: "24.proto.click" as const },
  { value: "MOUSE_ENTER", label: "Mouse enter", icon: "24.proto.mouse.enter" as const },
];
const TRIGGER_SHORT: Record<Trigger, string> = { ON_CLICK: "Click", MOUSE_ENTER: "Mouse enter" };
const CURVE_OPTIONS = EASINGS.filter((e) => e === "-" || (e.value !== "CUSTOM_CUBIC" && e.value !== "CUSTOM_SPRING"));
const SPRINGS = new Set(["GENTLE_SPRING", "SPRING_PRESET_ONE", "SPRING_PRESET_TWO", "SPRING_PRESET_THREE"]);
const DIRECTION_OPTIONS = [
  { value: "LEFT", icon: "24.arrow.left" as const, tooltip: "Left" },
  { value: "RIGHT", icon: "24.arrow.right" as const, tooltip: "Right" },
  { value: "UP", icon: "16.arrow.up" as const, tooltip: "Up" },
  { value: "DOWN", icon: "16.arrow.down" as const, tooltip: "Down" },
];

// The canvas: Product at 0,0 and Detail at 300,0 (world px); the preview's device is the frame plus its bezel
const DETAIL_X = 300;
const WORLD_W = DETAIL_X + SCREEN_W;
const BEZEL = 8;
const DEVICE_W = SCREEN_W + BEZEL * 2;
const DEVICE_H = SCREEN_H + BEZEL * 2;
const PREVIEW_HEAD = 36;
const PREVIEW_PAD = 12;

// ---- Playing a transition -------------------------------------------------------------------------------------

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function rectIn(el: Element, viewport: HTMLElement, scale: number): Rect {
  const r = el.getBoundingClientRect();
  const v = viewport.getBoundingClientRect();
  return { x: (r.left - v.left) / scale, y: (r.top - v.top) / scale, w: r.width / scale, h: r.height / scale };
}

/** Where an incoming screen starts (Move in, Push, Slide in) for a direction: the side opposite to where it moves. */
const offsetOf = (d: Direction): [number, number] => (d === "LEFT" ? [SCREEN_W, 0] : d === "RIGHT" ? [-SCREEN_W, 0] : d === "UP" ? [0, SCREEN_H] : [0, -SCREEN_H]);
const tr = (x: number, y: number) => `translate3d(${x}px, ${y}px, 0)`;

/**
 * Product → Detail with the interaction's animation; `reverse` plays it backwards (Back). Resolves once the screens
 * rest; each animation is cancelled then, leaving the DOM as the React state draws it.
 */
async function transition(viewport: HTMLElement, a: HTMLElement, b: HTMLElement, p: Proto, t: Timing, reverse: boolean): Promise<void> {
  const scale = viewport.getBoundingClientRect().width / viewport.offsetWidth || 1;
  const opts: KeyframeAnimationOptions = { duration: t.duration, easing: t.easing, fill: "both", direction: reverse ? "reverse" : "normal" };
  const anims: Animation_[] = [];
  const play = (el: HTMLElement, frames: Keyframe[]) => anims.push(el.animate(frames, opts));
  const [ox, oy] = offsetOf(p.direction);
  a.style.visibility = "visible";
  b.style.visibility = "visible";
  const hidden: HTMLElement[] = [];
  switch (p.animation) {
    case "INSTANT":
      break;
    case "DISSOLVE":
      b.style.zIndex = "2";
      play(b, [{ opacity: 0 }, { opacity: 1 }]);
      break;
    case "MOVE_IN":
      b.style.zIndex = "2";
      play(b, [{ transform: tr(ox, oy) }, { transform: tr(0, 0) }]);
      break;
    case "MOVE_OUT":
      a.style.zIndex = "2";
      play(a, [{ transform: tr(0, 0) }, { transform: tr(-ox, -oy) }]);
      break;
    case "PUSH":
      b.style.zIndex = "2";
      play(b, [{ transform: tr(ox, oy) }, { transform: tr(0, 0) }]);
      play(a, [{ transform: tr(0, 0) }, { transform: tr(-ox, -oy) }]);
      break;
    case "SLIDE_IN":
      b.style.zIndex = "2";
      play(b, [{ transform: tr(ox, oy) }, { transform: tr(0, 0) }]);
      play(a, [{ transform: tr(0, 0) }, { transform: tr(-ox * 0.3, -oy * 0.3) }]);
      break;
    case "SLIDE_OUT":
      a.style.zIndex = "2";
      play(a, [{ transform: tr(0, 0) }, { transform: tr(-ox, -oy) }]);
      play(b, [{ transform: tr(ox * 0.3, oy * 0.3) }, { transform: tr(0, 0) }]);
      break;
    case "SMART_ANIMATE":
      break;
  }
  // Smart animate, or a directional animation with "Animate matching layers": layers of the same name move from
  // where they are in one frame to where they are in the other (Figma: "matches layers by name"); the rest dissolves,
  // or moves with the transition.
  const directional = isDirectional(p.animation);
  if (p.animation === "SMART_ANIMATE" || (directional && p.matching)) {
    for (const x of anims) x.cancel();
    anims.length = 0;
    const moving = directional && p.animation !== "MOVE_OUT" && p.animation !== "SLIDE_OUT";
    const leaving = directional && p.animation !== "MOVE_IN";
    b.style.zIndex = "2";
    for (const child of [...b.children] as HTMLElement[]) {
      const name = child.dataset.layer;
      const twin = name ? a.querySelector<HTMLElement>(`[data-layer="${name}"]`) : null;
      if (!twin) {
        play(child, moving ? [{ transform: tr(ox, oy) }, { transform: tr(0, 0) }] : [{ opacity: 0 }, { opacity: 1 }]);
        continue;
      }
      const from = rectIn(twin, viewport, scale);
      const to = rectIn(child, viewport, scale);
      child.style.transformOrigin = "0 0";
      play(child, [{ transform: `${tr(from.x - to.x, from.y - to.y)} scale(${from.w / to.w}, ${from.h / to.h})` }, { transform: "none" }]);
      twin.style.visibility = "hidden";
      hidden.push(twin);
    }
    for (const child of [...a.children] as HTMLElement[]) play(child, leaving ? [{ transform: tr(0, 0) }, { transform: tr(-ox, -oy) }] : [{ opacity: 1 }, { opacity: 0 }]);
  }
  await Promise.all(anims.map((x) => x.finished.catch(() => undefined)));
  (reverse ? b : a).style.visibility = "hidden";
  for (const el of [a, b]) el.style.zIndex = "";
  for (const el of hidden) el.style.visibility = "";
  for (const x of anims) x.cancel();
}
type Animation_ = globalThis.Animation;

// ---- The scene --------------------------------------------------------------------------------------------------

export default function PrototypeScene() {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const productRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const [p, setP] = useState<Proto>(FIRST);
  const [screen, setScreen] = useState<Screen>("product");
  const busy = useRef(false);
  const pRef = useRef(p);
  pRef.current = p;
  const set = useCallback((patch: Partial<Proto>) => setP((s) => ({ ...s, ...patch })), []);
  const timing = useMemo(() => timingOf(p.easing, p.duration), [p.easing, p.duration]);
  const timingRef = useRef(timing);
  timingRef.current = timing;

  const go = useCallback(async (to: Screen) => {
    const viewport = viewportRef.current;
    const a = productRef.current;
    const b = detailRef.current;
    if (busy.current || !viewport || !a || !b) return;
    busy.current = true;
    try {
      await transition(viewport, a, b, pRef.current, timingRef.current, to === "product");
      setScreen(to);
    } finally {
      busy.current = false;
    }
  }, []);
  const goRef = useRef(go);
  goRef.current = go;

  // The frames' visibility follows the state (transition() only moves them while it plays)
  useEffect(() => {
    if (productRef.current) productRef.current.style.visibility = screen === "product" ? "visible" : "hidden";
    if (detailRef.current) detailRef.current.style.visibility = screen === "detail" ? "visible" : "hidden";
  }, [screen]);

  const linked = p.dest === "DETAIL";

  const { cursor } = useDemo(rootRef, (run) => demo(run, set, (s) => goRef.current(s)), {
    onStart: () => {
      setP({ ...FIRST, selected: false });
      setScreen("product");
    },
  });

  // Fit the canvas: the preview takes the right, the frames the rest (the engine's zoom to fit)
  const size = useSize(canvasRef);
  const ps = clamp(Math.min((size.h - 32 - PREVIEW_HEAD - PREVIEW_PAD * 2) / DEVICE_H, (size.w * 0.48 - PREVIEW_PAD * 2) / DEVICE_W), 0.3, 1.1);
  const previewW = DEVICE_W * ps + PREVIEW_PAD * 2;
  const areaW = Math.max(0, size.w - previewW - 32);
  const ws = clamp(Math.min((areaW - 32) / WORLD_W, (size.h - 72) / SCREEN_H), 0.12, 0.9);
  const wx = Math.round((areaW - WORLD_W * ws) / 2) + 8;
  const wy = Math.round((size.h - SCREEN_H * ws) / 2) + 6;
  const W = (x: number) => wx + x * ws;
  const H = (y: number) => wy + y * ws;
  const cardBox = { x: W(CARD.x), y: H(CARD.y), w: CARD.w * ws, h: CARD.h * ws };
  // The connection: from the card's right edge to Detail's left edge, as Figma draws it
  const x1 = cardBox.x + cardBox.w;
  const y1 = cardBox.y + cardBox.h / 2;
  const x2 = W(DETAIL_X) - 2;
  const y2 = clamp(y1, H(40), H(SCREEN_H - 40));
  const bend = Math.max(24, (x2 - x1) * 0.6);

  return (
    <SceneWindow ref={rootRef} title="Shop — Prototype" className={styles.root}>
      <SceneBody>
        <SceneCanvas ref={canvasRef} className={styles.canvas}>
          {size.w > 0 && (
            <>
              <span className={styles.flowLabel} style={{ left: W(0), top: H(0) }}>
                <span className={styles.flow}>
                  <Icon name="16.play" />
                  Flow 1
                </span>
                {ws > 0.36 && "Product"}
              </span>
              <FrameLabel x={W(DETAIL_X)} y={H(0)}>
                Detail
              </FrameLabel>
              <div className={styles.world} style={{ transform: `translate(${wx}px, ${wy}px) scale(${ws})` }}>
                <div className={styles.frame} style={{ left: 0 }}>
                  <ProductScreen demo="canvas-card" />
                </div>
                <div className={styles.frame} style={{ left: DETAIL_X }}>
                  <DetailScreen />
                </div>
              </div>
              {linked && (
                <svg className={styles.noodle} data-selected={p.selected || undefined} aria-hidden="true">
                  <path d={`M${x1} ${y1} C${x1 + bend} ${y1} ${x2 - bend} ${y2} ${x2 - 6} ${y2}`} />
                  <circle cx={x1} cy={y1} r={3.5} />
                  <path className={styles.arrow} d={`M${x2 - 7} ${y2 - 4.5} L${x2} ${y2} L${x2 - 7} ${y2 + 4.5} Z`} />
                </svg>
              )}
              <Selection box={p.selected ? cardBox : null} label={p.selected && ws > 0.36 ? `${CARD.w} × ${CARD.h}` : undefined} handles={ws > 0.25} instant />
              <div className={styles.preview} style={{ width: previewW }}>
                <div className={styles.previewHead}>
                  <Icon name="16.play" />
                  <span className={styles.previewTitle}>{screen === "product" ? "Product" : "Detail"}</span>
                  <IconButton icon="24.rotate" label="Restart" tooltip={false} />
                </div>
                <div className={styles.deviceWrap} style={{ height: DEVICE_H * ps }}>
                  <div className={styles.device} style={{ transform: `scale(${ps})` }}>
                    <div ref={viewportRef} className={styles.viewport}>
                      <div ref={productRef} className={styles.screen}>
                        <ProductScreen demo="preview-card" />
                      </div>
                      <div ref={detailRef} className={styles.screen} style={{ visibility: "hidden" }}>
                        <DetailScreen demo="preview-back" />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </>
          )}
          <DemoCursor cursor={cursor} />
        </SceneCanvas>
        <Panel>
          <div className={panels.rightTabs}>
            <Tabs
              label="Properties"
              value="prototype"
              tabs={[
                { value: "design", label: "Design", width: 53 },
                { value: "prototype", label: "Prototype", width: 69 },
              ]}
              onChange={() => {}}
            />
          </div>
          {p.selected ? <InteractionPanel p={p} set={set} timing={timing} /> : <PageSettings />}
        </Panel>
      </SceneBody>
    </SceneWindow>
  );
}

function PageSettings() {
  const [device, setDevice] = useState("iphone-16");
  return (
    <>
      <PanelSection title="Device">
        <div className={proto.row}>
          <Select
            label="Device"
            className={proto.grow}
            value={device}
            options={[
              { value: "none", label: "None" },
              "-",
              { value: "iphone-16", label: "iPhone 16" },
              { value: "iphone-16-pro", label: "iPhone 16 Pro" },
              { value: "android", label: "Android Large" },
            ]}
            onChange={setDevice}
          />
        </div>
      </PanelSection>
      <PanelSection title="Flows">
        <div className={proto.flowRow}>
          <button type="button" className={proto.flowName}>
            <Icon name="16.play" />
            <span>Flow 1</span>
          </button>
        </div>
      </PanelSection>
    </>
  );
}

function Labelled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className={proto.fieldRow}>
      <span className={proto.fieldLabel}>{label}</span>
      {children}
    </div>
  );
}

function InteractionPanel({ p, set, timing }: { p: Proto; set: (patch: Partial<Proto>) => void; timing: Timing }) {
  const spring = SPRINGS.has(p.easing);
  return (
    <>
      <PanelSection title="Interactions" actions={<IconButton icon="24.plus.small" label="Add interaction" tone="secondary" />}>
        <div className={`${proto.interaction} ${proto.interactionOpen}`}>
          <button type="button" className={proto.interactionButton}>
            <span className={proto.trigger}>{TRIGGER_SHORT[p.trigger]}</span>
            <span className={proto.actionIcon}>
              <Icon name="24.proto.navigate" />
            </span>
            <span className={proto.target}>{p.dest === "DETAIL" ? "Detail" : "None"}</span>
          </button>
        </div>
        <div className={proto.details} data-interaction-details>
          <Labelled label="Trigger">
            <Select
              label="Trigger"
              variant="outlined"
              className={proto.iconField}
              prefix={p.trigger === "ON_CLICK" ? "24.proto.click" : "24.proto.mouse.enter"}
              value={p.trigger}
              options={TRIGGERS}
              onChange={(v) => set({ trigger: v as Trigger })}
            />
          </Labelled>
          <div className={proto.divider} />
          <Labelled label="Action">
            <Select label="Action" variant="outlined" className={proto.iconField} prefix="24.proto.navigate" value="NAVIGATE" options={[{ value: "NAVIGATE", label: "Navigate to", icon: "24.proto.navigate" }]} onChange={() => {}} />
          </Labelled>
          <Labelled label="Destination">
            <Select
              label="Destination"
              variant="outlined"
              className={proto.field}
              value={p.dest}
              options={[{ value: "NONE", label: "None" }, "-", { value: "DETAIL", label: "Detail" }]}
              onChange={(v) => set({ dest: v as Proto["dest"] })}
            />
          </Labelled>
          <div className={proto.divider} />
          <Labelled label="Animation">
            <Select label="Animation" variant="outlined" className={proto.field} value={p.animation} options={ANIMATIONS} onChange={(v) => set({ animation: v as Animation })} data-demo="animation" />
          </Labelled>
          {isDirectional(p.animation) && (
            <>
              <div className={proto.row}>
                <SegmentedControl label="Direction" fullWidth value={p.direction} options={DIRECTION_OPTIONS} onChange={(v) => set({ direction: v as Direction })} data-demo="direction" />
              </div>
              <div className={proto.checkRow}>
                <Checkbox label="Animate matching layers" checked={p.matching} onChange={(matching) => set({ matching })} />
              </div>
            </>
          )}
          {p.animation !== "INSTANT" && (
            <>
              <div className={proto.row}>
                <Select label="Curve" variant="outlined" className={proto.grow} value={p.easing} options={CURVE_OPTIONS} onChange={(easing) => set({ easing })} data-demo="curve" />
                {!spring && <NumericInput label="Duration" className={proto.duration} value={p.duration} unit="ms" min={1} max={10000} precision={0} onChange={(duration) => set({ duration })} data-demo="duration" />}
              </div>
              <CurveGraph timing={timing} spring={spring} />
            </>
          )}
        </div>
      </PanelSection>
    </>
  );
}

/** The curve under the easing (Figma's preview of an animation's timing), its dot replaying it on each change. */
function CurveGraph({ timing, spring }: { timing: Timing; spring: boolean }) {
  const w = 208;
  const h = 64;
  const lo = Math.min(0, ...timing.points.map((q) => q[1]));
  const hi = Math.max(1, ...timing.points.map((q) => q[1]));
  const y = (v: number) => 6 + (h - 12) * (1 - (v - lo) / (hi - lo));
  const d = timing.points.map(([px, py], i) => `${i ? "L" : "M"}${(4 + px * (w - 8)).toFixed(1)} ${y(py).toFixed(1)}`).join(" ");
  const dot = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = dot.current;
    if (!el || typeof el.animate !== "function") return;
    const a = el.animate([{ transform: "translateX(0)" }, { transform: "translateX(100%)" }], { duration: timing.duration, easing: timing.easing, fill: "both", delay: 120 });
    return () => a.cancel();
  }, [timing]);
  return (
    <div className={styles.graph} aria-hidden="true">
      <svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
        <line x1={4} x2={w - 4} y1={y(0)} y2={y(0)} className={styles.graphAxis} />
        <line x1={4} x2={w - 4} y1={y(1)} y2={y(1)} className={styles.graphAxis} />
        <path d={d} className={styles.graphCurve} />
      </svg>
      <span className={styles.graphTrack}>
        <span ref={dot} className={styles.graphRail}>
          <span className={styles.graphDot} />
        </span>
      </span>
      <span className={styles.graphLabel}>{spring ? `${timing.duration}ms` : ""}</span>
    </div>
  );
}

async function demo(run: SceneRun, set: (p: Partial<Proto>) => void, go: (s: Screen) => Promise<void>) {
  await run.wait(600);
  // Select the card on the canvas
  await run.click(run.$('[data-demo="canvas-card"]'), { dy: -10 });
  set({ selected: true });
  await run.wait(800);
  // Smart animate, a gentle spring
  await run.click(run.$('[data-demo="animation"]'));
  set({ animation: "SMART_ANIMATE" });
  await run.wait(500);
  await run.click(run.$('[data-demo="curve"]'));
  set({ easing: "GENTLE_SPRING" });
  await run.wait(700);
  // Tap the card in the preview, then Back
  await run.click(run.$('[data-demo="preview-card"]'));
  await go("detail");
  await run.wait(1100);
  await run.click(run.$('[data-demo="preview-back"]'));
  await go("product");
  await run.wait(900);
  // Push from the right
  await run.click(run.$('[data-demo="animation"]'));
  set({ animation: "PUSH", direction: "LEFT", easing: "INOUT_CUBIC", duration: 450 });
  await run.wait(800);
  await run.click(run.$('[data-demo="preview-card"]'));
  await go("detail");
  await run.wait(1000);
  await run.click(run.$('[data-demo="preview-back"]'));
  await go("product");
  run.hide();
  await run.wait(1200);
}
