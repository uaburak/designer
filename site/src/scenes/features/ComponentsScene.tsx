// Components and variants: a "Button" component set (State × Size, with an Icon boolean and a Label text property)
// and two instances in a card. The right panel is the app's instance and component panels — Component.module.css's
// rows with the ds Select, Switch, IconButton and the Text property's field — and Selection colors with the ds
// ColorInput and ColorPicker: a variant's colour changed in the set reaches every instance of it.
// The canvas is DOM (one live engine per page: Draw's), laid out at the engine's look (purple component chrome).
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { IconButton } from "@/ds/components/Button";
import { ColorInput } from "@/ds/components/ColorInput";
import { ColorPicker } from "@/ds/components/ColorPicker";
import { PanelSection } from "@/ds/components/PanelSection";
import { PropertyGrid, PropertyRow } from "@/ds/components/PropertyGrid";
import { Select } from "@/ds/components/Select";
import { Switch } from "@/ds/components/Switch";
import { Icon } from "@/ds/icons/Icon";
import type { ChangeInfo } from "@/ds/types";
import { hexToRgba, rgbToHex } from "@/ds/util/color";
import type { PickerPaint } from "@/ds/util/paint";
import c from "@/editor/panels/design/Component.module.css";
import { boxIn, FrameLabel, Panel, SceneBody, SceneCanvas, SceneWindow, Selection, type Box } from "../kit/kit";
import { DemoCursor, useDemo, type SceneRun } from "../runtime/useDemo";
import styles from "./components.module.css";

type State = "Default" | "Hover" | "Pressed";
type Size = "Small" | "Large";
interface Instance {
  id: string;
  state: State;
  size: Size;
  icon: boolean;
  label: string;
}
interface Colors {
  Default: string;
  Hover: string;
  Pressed: string;
  Label: string;
}

const STATES: State[] = ["Default", "Hover", "Pressed"];
const SIZES: Size[] = ["Small", "Large"];
const FIRST_COLORS: Colors = { Default: "#1e1e1e", Hover: "#444444", Pressed: "#000000", Label: "#ffffff" };
const FIRST_INSTANCES: Instance[] = [
  { id: "i1", state: "Default", size: "Large", icon: true, label: "Get started" },
  { id: "i2", state: "Default", size: "Small", icon: false, label: "Details" },
];
type Sel = { kind: "instance"; id: string } | { kind: "set" } | null;

/** The component as the engine would draw it: a variant's fill, size, icon and label. */
function ButtonView({ state, size, icon, label, colors, style, className, ...rest }: { state: State; size: Size; icon: boolean; label: string; colors: Colors; style?: CSSProperties } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={`${styles.button} ${className ?? ""}`} data-size={size} style={{ ...style, background: colors[state], color: colors.Label }} {...rest}>
      <span>{label}</span>
      {icon && (
        <svg className={styles.arrow} viewBox="0 0 16 16" aria-hidden="true">
          <path d="M3 8h9.5M8.5 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </div>
  );
}

export default function ComponentsScene() {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const setRef = useRef<HTMLDivElement>(null);
  const [colors, setColors] = useState<Colors>(FIRST_COLORS);
  const [instances, setInstances] = useState<Instance[]>(FIRST_INSTANCES);
  const [sel, setSel] = useState<Sel>({ kind: "instance", id: "i1" });
  const [box, setBox] = useState<Box | null>(null);
  const [scale, setScale] = useState(1);
  const [picker, setPicker] = useState<{ key: keyof Colors; anchor: DOMRect } | null>(null);
  const reset = () => {
    setColors(FIRST_COLORS);
    setInstances(FIRST_INSTANCES);
    setSel({ kind: "instance", id: "i1" });
    setPicker(null);
  };
  const patch = (id: string, p: Partial<Instance>) => setInstances((is) => is.map((i) => (i.id === id ? { ...i, ...p } : i)));
  const instance = sel?.kind === "instance" ? (instances.find((i) => i.id === sel.id) ?? null) : null;

  // The content scales down to fit a small canvas (a phone), as zooming out would
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const content = contentRef.current;
    if (!canvas || !content) return;
    const fit = () => setScale(Math.min(1, (canvas.clientWidth - 32) / content.offsetWidth, (canvas.clientHeight - 40) / content.offsetHeight));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, []);

  // The selection follows what is selected, after layout (a variant swap resizes the instance)
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const target = sel?.kind === "set" ? setRef.current : sel ? canvas?.querySelector(`[data-instance="${sel.id}"]`) : null;
    const measure = () => setBox(target ? boxIn(target, canvas) : null);
    measure();
    const t = setTimeout(measure, 240);
    return () => clearTimeout(t);
  }, [sel, instances, scale]);

  const { cursor } = useDemo(rootRef, (run) => componentsDemo(run, { patch, setSel, setColors }), { onStart: reset});

  const paint = (hex: string): PickerPaint => ({ type: "SOLID", color: { ...(hexToRgba(hex) ?? { r: 0, g: 0, b: 0, a: 1 }), a: 1 }, opacity: 1 });
  const instanceSize = (i: Instance) => (i.size === "Large" ? "Large" : "Small");

  return (
    <SceneWindow ref={rootRef} title="Design system — Components" className={styles.window}>
      <SceneBody>
        <SceneCanvas ref={canvasRef} className={styles.canvas} onPointerDown={(e) => e.target === e.currentTarget && setSel(null)}>
          <div ref={contentRef} className={styles.content} style={{ transform: `translate(-50%, -50%) scale(${scale})` }} onPointerDown={(e) => e.target === e.currentTarget && setSel(null)}>
            <div className={styles.setWrap}>
              <button type="button" className={styles.setLabel} data-selected={sel?.kind === "set" || undefined} data-demo="set" onClick={() => setSel({ kind: "set" })}>
                <Icon name="16.component.set" />
                Button
              </button>
              <div ref={setRef} className={styles.set} data-selected={sel?.kind === "set" || undefined} onClick={() => setSel({ kind: "set" })}>
                {SIZES.map((size) =>
                  STATES.map((state) => (
                    <div key={`${size}-${state}`} className={styles.variant}>
                      <ButtonView state={state} size={size} icon label="Button" colors={colors} />
                    </div>
                  )),
                )}
              </div>
            </div>
            <div className={styles.cardWrap}>
              <FrameLabel x={0} y={0}>
                Welcome
              </FrameLabel>
              <div className={styles.card}>
                <span className={styles.cardTitle}>Start your free trial</span>
                <span className={styles.cardBody}>Thirty days, every feature, no card.</span>
                <div className={styles.cardActions}>
                  {instances.map((i) => (
                    <ButtonView
                      key={i.id}
                      data-instance={i.id}
                      data-selected={(sel?.kind === "instance" && sel.id === i.id) || undefined}
                      className={styles.instance}
                      state={i.state}
                      size={instanceSize(i)}
                      icon={i.icon}
                      label={i.label}
                      colors={colors}
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        setSel({ kind: "instance", id: i.id });
                      }}
                    />
                  ))}
                </div>
              </div>
            </div>
          </div>
          <Selection box={box} tone="component" instant={false} label={box ? `${Math.round(box.w / scale)} × ${Math.round(box.h / scale)}` : undefined} />
        </SceneCanvas>
        <Panel>
          {instance ? (
            <InstancePanel key={instance.id} instance={instance} onPatch={(p) => patch(instance.id, p)} />
          ) : sel?.kind === "set" ? (
            <SetPanel colors={colors} onColor={(k, hex) => setColors((cs) => ({ ...cs, [k]: hex }))} onSwatch={(key, anchor) => setPicker({ key, anchor })} />
          ) : (
            <PanelSection title="Page">
              <span className={styles.hint}>Select an instance or the component set.</span>
            </PanelSection>
          )}
          {picker && sel?.kind === "set" && (
            <ColorPicker
              value={paint(colors[picker.key])}
              anchor={picker.anchor}
              paintTypes={["SOLID"]}
              documentColors={["#1e1e1e", "#0d99ff", "#14ae5c", "#ffa629", "#f24822", "#ffffff"]}
              onChange={(p: PickerPaint, _info: ChangeInfo) => p.color && setColors((cs) => ({ ...cs, [picker.key]: rgbToHex(p.color!) }))}
              onClose={() => setPicker(null)}
            />
          )}
        </Panel>
      </SceneBody>
      <DemoCursor cursor={cursor} />
    </SceneWindow>
  );
}

/** The instance's header and properties, as editor/panels/design/Component.tsx draws them. */
function InstancePanel({ instance, onPatch }: { instance: Instance; onPatch: (p: Partial<Instance>) => void }) {
  return (
    <>
      <div className={c.instanceHead} data-instance-header="">
        <div className={c.instanceTitleRow}>
          <div tabIndex={0} className={c.instanceName}>
            <span className={c.headerText}>Button</span>
            <Icon name="16.chevron.down" className={c.nameChevron} />
          </div>
          <div className={c.headerActions}>
            <IconButton icon="24.more" label="More actions" tone="secondary" />
          </div>
        </div>
        <button type="button" className={c.fromRow} aria-label="Go to main component">
          <span className={c.fromText}>From this file</span>
        </button>
        <div className={c.instanceBody} data-instance-properties="">
          <div className={c.propRow} data-property="State">
            <span className={c.propLabel}>State</span>
            <div className={c.propControl}>
              <Select label="State" variant="outlined" value={instance.state} options={STATES.map((v) => ({ value: v, label: v }))} onChange={(v) => onPatch({ state: v as State })} />
            </div>
          </div>
          <div className={c.propRow} data-property="Size">
            <span className={c.propLabel}>Size</span>
            <div className={c.propControl}>
              <Select label="Size" variant="outlined" value={instance.size} options={SIZES.map((v) => ({ value: v, label: v }))} onChange={(v) => onPatch({ size: v as Size })} />
            </div>
          </div>
          <div className={c.propRow} data-property="Icon">
            <span className={c.propLabel}>Icon</span>
            <div className={c.propControl}>
              <Switch label="Icon" className={c.propSwitch} checked={instance.icon} onChange={(icon) => onPatch({ icon })} />
            </div>
            <IconButton icon="24.variable.small" label="Apply boolean variable" tone="secondary" />
          </div>
          <div className={c.propRow} data-property="Label">
            <span className={c.propLabel}>Label</span>
            <div className={c.propControl}>
              <PropertyText value={instance.label} onCommit={(label) => onPatch({ label })} />
            </div>
            <IconButton icon="24.variable.small" label="Apply string variable" tone="secondary" />
          </div>
        </div>
      </div>
      <PanelSection title="Effects" empty actions={<IconButton icon="24.plus.small" label="Add effect" tone="secondary" />} />
      <PanelSection title="Export" empty actions={<IconButton icon="24.plus.small" label="Add export settings" tone="secondary" />} />
    </>
  );
}

/** The Text property's field (Component.tsx's PropertyText): types live, Enter keeps it, Esc puts it back. */
function PropertyText({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const before = useRef(value);
  useEffect(() => {
    if (draft === null) before.current = value;
  }, [value, draft]);
  return (
    <textarea
      className={c.propText}
      aria-label="Label"
      data-demo="label"
      rows={1}
      spellCheck={false}
      value={draft ?? value}
      style={{ height: 24 }}
      onChange={(e) => {
        setDraft(e.target.value);
        onCommit(e.target.value);
      }}
      onBlur={() => setDraft(null)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          setDraft(null);
          e.currentTarget.blur();
        } else if (e.key === "Escape") {
          e.preventDefault();
          onCommit(before.current);
          setDraft(null);
          e.currentTarget.blur();
        }
      }}
    />
  );
}

const DEFS: { icon: "16.variant" | "16.visible" | "16.text"; name: string; value: string }[] = [
  { icon: "16.variant", name: "State", value: "Default" },
  { icon: "16.variant", name: "Size", value: "Small" },
  { icon: "16.visible", name: "Icon", value: "True" },
  { icon: "16.text", name: "Label", value: "Button" },
];

/** The component set's block (name, Properties) and Selection colors: a colour used in the set, changed everywhere. */
function SetPanel({ colors, onColor, onSwatch }: { colors: Colors; onColor: (k: keyof Colors, hex: string) => void; onSwatch: (k: keyof Colors, anchor: DOMRect) => void }) {
  return (
    <>
      <div className={c.componentBlock} data-component-header="set">
        <div className={c.componentHeader}>
          <input className={c.nameField} aria-label="Component name" value="Button" readOnly />
          <IconButton icon="24.adjust.small" label="Component configuration" tone="secondary" />
        </div>
        <div className={c.properties}>
          <div className={c.blockTitle}>
            <span className={c.blockTitleText}>Properties</span>
            <IconButton icon="24.plus.small" label="Create property" tone="secondary" />
          </div>
          <div className={c.defs}>
            {DEFS.map((d) => (
              <div key={d.name} className={c.defRow}>
                <button type="button" className={c.defButton}>
                  <span className={c.defIcon}>
                    <Icon name={d.icon} />
                  </span>
                  <span className={c.defName}>{d.name}</span>
                  <span className={c.defSep}>・</span>
                  <span className={c.defValue}>{d.value}</span>
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
      <PanelSection title="Selection colors">
        <PropertyGrid>
          {(Object.keys(colors) as (keyof Colors)[]).map((k) => (
            <PropertyRow key={k} span={2} action={<IconButton icon="24.styles" label="Apply styles and variables" tone="secondary" />}>
              <ColorInput label={`${k} colour`} data-demo={`color-${k}`} color={colors[k]} opacity={100} onColor={(hex) => onColor(k, hex)} onSwatchClick={(r) => onSwatch(k, r)} />
            </PropertyRow>
          ))}
        </PropertyGrid>
      </PanelSection>
    </>
  );
}

interface ComponentsActions {
  patch: (id: string, p: Partial<Instance>) => void;
  setSel: (s: Sel) => void;
  setColors: (fn: (c: Colors) => Colors) => void;
}

/** Swap the instance's variant, turn its icon off and on, retype its label; then recolour the set and see both follow. */
async function componentsDemo(run: SceneRun, a: ComponentsActions) {
  await run.wait(800);
  const prop = (name: string) => run.$(`[data-property="${name}"] [data-ds="Select"], [data-property="${name}"] button, [data-property="${name}"] textarea`);
  await run.click(prop("State"));
  a.patch("i1", { state: "Hover" });
  await run.wait(800);
  a.patch("i1", { state: "Pressed" });
  await run.wait(800);
  a.patch("i1", { state: "Default" });
  await run.wait(500);
  await run.click(prop("Size"));
  a.patch("i1", { size: "Small" });
  await run.wait(900);
  a.patch("i1", { size: "Large" });
  await run.wait(500);
  await run.click(prop("Icon"));
  a.patch("i1", { icon: false });
  await run.wait(700);
  await run.click(prop("Icon"));
  a.patch("i1", { icon: true });
  await run.wait(500);
  await run.click(prop("Label"));
  const text = "Start free trial";
  for (let i = 0; i <= text.length; i++) {
    a.patch("i1", { label: text.slice(0, i) || " " });
    await run.wait(i === 0 ? 250 : 55);
  }
  await run.wait(900);
  // The set: its Default colour, changed once, reaches both instances
  await run.click(run.$('[data-demo="set"]'));
  a.setSel({ kind: "set" });
  await run.wait(700);
  await run.click(run.$('[data-demo="color-Default"] input'));
  for (const hex of ["#0d99ff", "#14ae5c"]) {
    a.setColors((cs) => ({ ...cs, Default: hex }));
    await run.wait(1000);
  }
  run.hide();
  await run.wait(900);
}
