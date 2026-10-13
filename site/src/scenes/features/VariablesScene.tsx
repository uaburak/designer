// Variables and modes: the collection "Theme" (modes Light and Dark) in the app's Local variables table
// (editor/panels/variables/LocalVariables.module.css: its header, glyphs, value cells — a colour's swatch and hex, a
// number, a string, a boolean, each with the ds control ValueEditor.tsx uses), and two frames on the canvas bound to
// it. A frame's mode is set in the Appearance section (the ds Select, as the app's variable mode row); a value edited
// in the table reaches every layer bound to it, in the frames using that mode.
// The canvas is DOM (one live engine per page: Draw's).
import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { IconButton } from "@/ds/components/Button";
import { Checkbox } from "@/ds/components/Checkbox";
import { ColorPicker } from "@/ds/components/ColorPicker";
import { NumericInput } from "@/ds/components/NumericInput";
import { PanelSection } from "@/ds/components/PanelSection";
import { PropertyGrid, PropertyRow } from "@/ds/components/PropertyGrid";
import { Select, type SelectEntry } from "@/ds/components/Select";
import { Swatch } from "@/ds/components/Swatch";
import { TextInput } from "@/ds/components/TextInput";
import { Icon } from "@/ds/icons/Icon";
import { hexToRgba, rgbToHex } from "@/ds/util/color";
import type { PickerPaint } from "@/ds/util/paint";
import lv from "@/editor/panels/variables/LocalVariables.module.css";
import { boxIn, FrameLabel, Panel, SceneCanvas, SceneWindow, Selection, type Box } from "../kit/kit";
import { DemoCursor, useDemo, type SceneRun } from "../runtime/useDemo";
import styles from "./variables.module.css";

type Mode = "light" | "dark";
type VarType = "COLOR" | "FLOAT" | "STRING" | "BOOLEAN";
type Value = string | number | boolean;
interface Variable {
  id: string;
  name: string;
  type: VarType;
  values: Record<Mode, Value>;
}

const TYPE_ICON = { COLOR: "16.variable.color", FLOAT: "16.number", STRING: "16.text", BOOLEAN: "16.variable.boolean" } as const;
const MODES: { id: Mode; name: string }[] = [
  { id: "light", name: "Light" },
  { id: "dark", name: "Dark" },
];
const FIRST: Variable[] = [
  { id: "bg", name: "background", type: "COLOR", values: { light: "#ffffff", dark: "#1e1e1e" } },
  { id: "surface", name: "surface", type: "COLOR", values: { light: "#f1f1f1", dark: "#2c2c2c" } },
  { id: "text", name: "text", type: "COLOR", values: { light: "#1e1e1e", dark: "#ffffff" } },
  { id: "accent", name: "accent", type: "COLOR", values: { light: "#0d99ff", dark: "#7cc4fa" } },
  { id: "radius", name: "radius", type: "FLOAT", values: { light: 16, dark: 16 } },
  { id: "greeting", name: "greeting", type: "STRING", values: { light: "Good morning", dark: "Good evening" } },
  { id: "badge", name: "show-badge", type: "BOOLEAN", values: { light: true, dark: false } },
];
const MODE_OPTIONS: SelectEntry[] = [{ value: "auto", label: "Auto (Light)" }, "-", { value: "light", label: "Light" }, { value: "dark", label: "Dark" }];
const FIRST_FRAMES: Record<string, Mode | "auto"> = { a: "auto", b: "dark" };

export default function VariablesScene() {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const [vars, setVars] = useState<Variable[]>(FIRST);
  const [frames, setFrames] = useState(FIRST_FRAMES);
  const [selected, setSelected] = useState<string | null>("a");
  const [row, setRow] = useState<string | null>(null);
  const [box, setBox] = useState<Box | null>(null);
  const [picker, setPicker] = useState<{ id: string; mode: Mode; anchor: DOMRect } | null>(null);
  const reset = () => {
    setVars(FIRST);
    setFrames(FIRST_FRAMES);
    setSelected("a");
    setRow(null);
    setPicker(null);
  };
  const setValue = (id: string, mode: Mode, v: Value) => setVars((vs) => vs.map((x) => (x.id === id ? { ...x, values: { ...x.values, [mode]: v } } : x)));

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const target = selected ? canvas?.querySelector(`[data-frame="${selected}"]`) : null;
    const measure = () => setBox(target ? boxIn(target, canvas) : null);
    measure();
    const ro = new ResizeObserver(measure);
    if (canvas) ro.observe(canvas);
    const t = setTimeout(measure, 260);
    return () => {
      ro.disconnect();
      clearTimeout(t);
    };
  }, [selected, vars, frames]);

  const { cursor } = useDemo(rootRef, (run) => variablesDemo(run, { setFrames, setSelected, setValue, setRow }), { onStart: reset});

  const modeOf = (f: string): Mode => (frames[f] === "auto" ? "light" : (frames[f] as Mode));
  const frameMode = selected ? frames[selected] : null;
  const paint = (hex: string): PickerPaint => ({ type: "SOLID", color: { ...(hexToRgba(hex) ?? { r: 0, g: 0, b: 0, a: 1 }), a: 1 }, opacity: 1 });

  return (
    <SceneWindow ref={rootRef} title="Lumen app — Variables" className={styles.window}>
      <div className={styles.body}>
        <div className={styles.top}>
          <SceneCanvas ref={canvasRef} className={styles.canvas} onPointerDown={(e) => e.target === e.currentTarget && setSelected(null)}>
            <div className={styles.frames} onPointerDown={(e) => e.target === e.currentTarget && setSelected(null)}>
              {(["a", "b"] as const).map((f) => (
                <div key={f} className={styles.frameWrap}>
                  <FrameLabel x={0} y={0} selected={selected === f}>
                    {f === "a" ? "Home" : "Home — Night"}
                  </FrameLabel>
                  <AppFrame id={f} vars={vars} mode={modeOf(f)} highlight={row} onSelect={() => setSelected(f)} />
                </div>
              ))}
            </div>
            <Selection box={box} label={box ? `${Math.round(box.w)} × ${Math.round(box.h)}` : undefined} />
            {selected && frameMode && (
              // A phone has no room for the Design panel: the frame's mode, over the canvas
              <div className={styles.phoneMode}>
                <Select label="Theme mode" prefix="24.variable.mode.small" value={frameMode} options={MODE_OPTIONS} onChange={(v) => setFrames((fs) => ({ ...fs, [selected]: v as Mode | "auto" }))} />
              </div>
            )}
          </SceneCanvas>
          <Panel>
            {selected && frameMode ? (
              <>
                <PanelSection title="Frame" pad="none" />
                <PanelSection title="Appearance" actions={<IconButton icon="24.variable.mode.small" label="Apply variable mode" tone="secondary" />}>
                  <PropertyGrid labels>
                    <PropertyRow label="Theme" span={2}>
                      <Select
                        label="Theme mode"
                        data-demo="mode"
                        prefix="24.variable.mode.small"
                        value={frameMode}
                        options={MODE_OPTIONS}
                        onChange={(v) => setFrames((fs) => ({ ...fs, [selected]: v as Mode | "auto" }))}
                      />
                    </PropertyRow>
                    <PropertyRow labels={["Opacity", "Corner radius"]}>
                      <NumericInput label="Opacity" prefix="24.opacity" unit="%" value={100} min={0} max={100} onChange={() => {}} />
                      <BoundRadius value={Number(vars.find((v) => v.id === "radius")?.values[modeOf(selected)] ?? 16)} />
                    </PropertyRow>
                  </PropertyGrid>
                </PanelSection>
                <PanelSection title="Fill" actions={<IconButton icon="24.plus.small" label="Add fill" tone="secondary" />}>
                  <PropertyGrid>
                    <PropertyRow span={2} action={<IconButton icon="24.minus.small" label="Remove fill" tone="secondary" />}>
                      <div className={styles.boundFill}>
                        <Swatch color={String(vars[0].values[modeOf(selected)])} size={14} />
                        <span>background</span>
                      </div>
                    </PropertyRow>
                  </PropertyGrid>
                </PanelSection>
              </>
            ) : (
              <PanelSection title="Page">
                <span className={styles.hint}>Select a frame to set its mode.</span>
              </PanelSection>
            )}
          </Panel>
        </div>
        <section className={styles.table} aria-label="Local variables">
          <div className={styles.tableBar}>
            <Icon name="24.variables" />
            <span className={`${lv.collectionTitle} ${styles.title}`}>Theme</span>
            <span className={styles.count}>{vars.length} variables</span>
          </div>
          <div className={styles.scroll}>
            <div className={lv.table} role="grid" aria-label="Theme" style={{ gridTemplateColumns: "minmax(132px, 1fr) minmax(156px, 1.2fr) minmax(156px, 1.2fr) 40px", minWidth: "100%" }}>
              <div className={lv.row} role="row">
                <div className={`${lv.cell} ${lv.head} ${lv.headName}`} role="columnheader">
                  Name
                </div>
                {MODES.map((m, i) => (
                  <div key={m.id} className={`${lv.cell} ${lv.head} ${lv.modeHead}`} role="columnheader" data-default={i === 0 ? "" : undefined}>
                    <span className={lv.modeLabel}>{m.name}</span>
                  </div>
                ))}
                <div className={`${lv.cell} ${lv.head} ${lv.addMode}`} role="columnheader">
                  <IconButton icon="24.plus.small" label="New variable mode" tone="secondary" />
                </div>
              </div>
              {vars.map((v) => (
                <div key={v.id} className={`${lv.row} ${row === v.id ? lv.rowSelected : ""}`} role="row" aria-selected={row === v.id} data-variable={v.id}>
                  <div className={`${lv.cell} ${lv.nameCell}`} role="rowheader" onClick={() => setRow(row === v.id ? null : v.id)}>
                    <span className={lv.glyph}>
                      <Icon name={TYPE_ICON[v.type]} />
                    </span>
                    <span className={lv.nameText}>{v.name}</span>
                  </div>
                  {MODES.map((m) => (
                    <ValueCell key={m.id} v={v} mode={m.id} onValue={(x) => setValue(v.id, m.id, x)} onSwatch={(anchor) => setPicker({ id: v.id, mode: m.id, anchor })} />
                  ))}
                  <div className={`${lv.cell} ${lv.addMode}`} />
                </div>
              ))}
            </div>
          </div>
        </section>
      </div>
      {picker && (
        <ColorPicker
          value={paint(String(vars.find((v) => v.id === picker.id)?.values[picker.mode] ?? "#000000"))}
          anchor={picker.anchor}
          placement="bottom-start"
          paintTypes={["SOLID"]}
          onChange={(p) => p.color && setValue(picker.id, picker.mode, rgbToHex(p.color))}
          onClose={() => setPicker(null)}
        />
      )}
      <DemoCursor cursor={cursor} />
    </SceneWindow>
  );
}

/** A value cell, as ValueEditor.tsx edits it: swatch + hex, number, string, checkbox. */
function ValueCell({ v, mode, onValue, onSwatch }: { v: Variable; mode: Mode; onValue: (x: Value) => void; onSwatch: (anchor: DOMRect) => void }) {
  const value = v.values[mode];
  const label = `${v.name} in ${mode === "light" ? "Light" : "Dark"}`;
  let body: React.ReactNode;
  switch (v.type) {
    case "COLOR":
      body = (
        <>
          <button type="button" className={lv.swatchButton} aria-label={`${label}: colour`} onClick={(e) => onSwatch(e.currentTarget.getBoundingClientRect())}>
            <Swatch color={String(value)} size={14} />
          </button>
          <TextInput
            label={label}
            variant="ghost"
            value={String(value).replace("#", "").toUpperCase()}
            onCommit={(text) => {
              const m = /^\s*#?([0-9a-f]{6}|[0-9a-f]{3})\s*$/i.exec(text);
              if (m) onValue(`#${(m[1].length === 3 ? m[1].replace(/./g, (ch) => ch + ch) : m[1]).toLowerCase()}`);
            }}
          />
        </>
      );
      break;
    case "FLOAT":
      body = <NumericInput label={label} variant="ghost" value={Number(value)} min={0} max={48} onChange={(x) => onValue(x)} scrub={false} />;
      break;
    case "STRING":
      body = <TextInput label={label} variant="ghost" value={String(value)} placeholder="Empty" onCommit={(x) => onValue(x)} />;
      break;
    case "BOOLEAN":
      body = <Checkbox label={value === true ? "true" : "false"} checked={value === true} onChange={(on) => onValue(on)} aria-label={label} />;
      break;
  }
  return (
    <div className={`${lv.cell} ${lv.value}`} data-value-cell={`${v.id}|${mode}`}>
      {body}
    </div>
  );
}

/** The corner radius field bound to a variable: the app shows the variable's pill in place of the number. */
function BoundRadius({ value }: { value: number }) {
  return (
    <div className={styles.boundField} aria-label={`Corner radius: radius (${value})`}>
      <Icon name="24.corners" />
      <span className={styles.boundPill}>radius</span>
    </div>
  );
}

/** A small app screen whose every colour, its radius, its greeting and its badge come from the variables. */
function AppFrame({ id, vars, mode, highlight, onSelect }: { id: string; vars: Variable[]; mode: Mode; highlight: string | null; onSelect: () => void }) {
  const get = (k: string) => vars.find((v) => v.id === k)?.values[mode];
  const r = Number(get("radius"));
  const style: CSSProperties = {
    ["--bg" as string]: String(get("bg")),
    ["--surface" as string]: String(get("surface")),
    ["--text" as string]: String(get("text")),
    ["--accent" as string]: String(get("accent")),
    ["--r" as string]: `${r}px`,
  };
  const hl = (k: string) => (highlight === k ? { "data-bound": "" } : {});
  return (
    <div className={styles.app} data-frame={id} style={style} onPointerDown={onSelect} {...hl("bg")}>
      <div className={styles.appTop}>
        <span className={styles.appTime}>9:41</span>
        {get("badge") === true && (
          <span className={styles.badge} {...hl("badge")}>
            New
          </span>
        )}
      </div>
      <span className={styles.greeting} {...hl("greeting")} {...(highlight === "text" ? { "data-bound": "" } : {})}>
        {String(get("greeting"))}
      </span>
      <span className={styles.sub}>3 rooms, all lights on</span>
      <div className={styles.surface} {...hl("surface")} {...(highlight === "radius" ? { "data-bound": "" } : {})}>
        <span className={styles.dot} />
        <span className={styles.lines}>
          <span />
          <span />
        </span>
      </div>
      <span className={styles.cta} {...hl("accent")}>
        Turn off all
      </span>
    </div>
  );
}

interface VariablesActions {
  setFrames: (fn: (f: Record<string, Mode | "auto">) => Record<string, Mode | "auto">) => void;
  setSelected: (id: string | null) => void;
  setValue: (id: string, mode: Mode, v: Value) => void;
  setRow: (id: string | null) => void;
}

/** Switch the first frame to Dark and back, recolour the accent in Light, change the greeting, turn the badge off. */
async function variablesDemo(run: SceneRun, a: VariablesActions) {
  await run.wait(800);
  await run.click(run.$('[data-frame="a"]'), { dy: -40 });
  a.setSelected("a");
  await run.wait(500);
  await run.click(run.$('[data-demo="mode"]'));
  a.setFrames((f) => ({ ...f, a: "dark" }));
  await run.wait(1300);
  await run.click(run.$('[data-demo="mode"]'));
  a.setFrames((f) => ({ ...f, a: "light" }));
  await run.wait(900);
  // The accent, in Light
  await run.click(run.$('[data-variable="accent"] [role="rowheader"]'));
  a.setRow("accent");
  await run.wait(400);
  await run.click(run.$('[data-value-cell="accent|light"] input'));
  for (const hex of ["#9747ff", "#14ae5c"]) {
    a.setValue("accent", "light", hex);
    await run.wait(900);
  }
  // The greeting, in Dark: the night frame changes
  a.setRow("greeting");
  await run.click(run.$('[data-value-cell="greeting|dark"] input'));
  const text = "Sleep well";
  for (let i = 1; i <= text.length; i++) {
    a.setValue("greeting", "dark", text.slice(0, i));
    await run.wait(60);
  }
  await run.wait(900);
  // The badge, off in Light
  a.setRow("badge");
  await run.click(run.$('[data-value-cell="badge|light"] [data-ds="Checkbox"], [data-value-cell="badge|light"] label'));
  a.setValue("badge", "light", false);
  await run.wait(1100);
  a.setRow(null);
  run.hide();
  await run.wait(900);
}
