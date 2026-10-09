/**
 * Effects and Layout guide (UI3), and the effect / guide settings popovers — as live Figma draws them
 * (docs/research/figma/live/popovers/effect-*.txt, effects-add-shader-effects.txt).
 *
 * Effects: each row, top first: the effect's glyph (opens its settings), its type's name, eye, minus. "+" adds a
 * Drop shadow with Figma's defaults (X 0, Y 4, Blur 4, Spread 0, #000000 25%); until its onboarding card is
 * dismissed it opens Figma's "Shader effects (Beta)" browser instead (the card's "Got it"), as live Figma does.
 * The settings popover: the type dropdown in its header (Inner shadow, Drop shadow, Layer blur, Background blur,
 * Noise, Texture, Glass, then Shader), a blend mode button for shadows and noise, then per type —
 * - shadows: Position X / Y, Blur, Spread, Color (and "Show behind transparent areas" on a drop shadow when the
 *   layer isn't opaque);
 * - blurs: Type Uniform / Progressive; Blur, or Start and End;
 * - Noise: Noise type Mono / Duo / Multi; Noise size X / Y, Density, then Color (Mono), two colours (Duo) or
 *   Opacity (Multi);
 * - Texture: Size X / Y, Radius, Clip to shape;
 * - Glass: Light (a dial, Angle, Intensity), Refraction, Depth, Dispersion, Frost, Splay.
 * Stored as `effects` (schema Effect: FOREGROUND_BLUR = Layer blur, GRAIN = Texture; the newer fields — blurOpType,
 * startRadius, noiseType, … — as the engine keeps them, JSON members of the effect).
 *
 * Layout guide (frames): "+" adds Figma's "Grid 10px" (#FF0000 at 10%); each
 * row: the guide's glyph (settings), its name ("Grid 10px", "Columns 5",
 * "Rows 5"), eye, minus. Settings: Grid / Columns / Rows; a grid's size; for
 * columns and rows the count, the type (Stretch / Left / Center / Right for
 * columns, Top / Center / Bottom for rows), width (Auto when stretched),
 * margin or offset, gutter; the colour. Stored as `layoutGrids`.
 */
import { useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { BLEND_LABEL, BLEND_MODES, Button, Checkbox, ColorInput, Icon, IconButton, MenuButton, NumericInput, PanelSection, Popover, SearchField, SegmentedControl, Select, cx, type ChangeInfo, type IconName, type PopoverPlacement } from "@/ds";
import type { BlendMode, Color, Guid } from "@/engine/codec";
import { useEditor, type EditorController } from "../../controller";
import { colorToHex, hexToColor, toPercent } from "../../model/color";
import { mixed, sameData } from "../../model/mixed";
import { fields, useKeeps, type Effect, type LayoutGrid, type PanelNode } from "./shared";
import styles from "./Design.module.css";
import { AppliedStyle, StylesButton, sharedStyle } from "./Styles";
import { Grip, moved, useReorder } from "./reorder";

// ---- Effects ---------------------------------------------------------------------------------------

/** The type menu's order (live Figma): shadows, blurs, then Noise, Texture, Glass. */
export const EFFECT_TYPES: { value: Effect["type"]; label: string; icon: IconName }[] = [
  { value: "INNER_SHADOW", label: "Inner shadow", icon: "24.inner.shadow.top.left.small" },
  { value: "DROP_SHADOW", label: "Drop shadow", icon: "24.drop.shadow.mid.small" },
  { value: "FOREGROUND_BLUR", label: "Layer blur", icon: "24.layer.blur.small" },
  { value: "BACKGROUND_BLUR", label: "Background blur", icon: "24.background.blur.small" },
  { value: "NOISE", label: "Noise", icon: "24.noise.small" },
  { value: "GRAIN", label: "Texture", icon: "24.texture.small" },
  { value: "GLASS", label: "Glass", icon: "24.glass.small" },
];

export const isShadow = (e: Effect) => e.type === "DROP_SHADOW" || e.type === "INNER_SHADOW";
export const isBlur = (e: Effect) => e.type === "FOREGROUND_BLUR" || e.type === "BACKGROUND_BLUR";
/** The effects with a blend mode of their own (the header's button): shadows and noise. */
export const hasEffectBlend = (e: Effect) => isShadow(e) || e.type === "NOISE";

type V2 = { x: number; y: number };
const BLACK_25: Color = { r: 0, g: 0, b: 0, a: 0.25 };

/**
 * Figma's new effect of a type: shadows 0 4 4 0 #000 25%; blurs radius 4 (Uniform); Noise Mono #000 25%, size 0.5,
 * density 100 %; Texture size 0.5, radius 4; Glass light −45° at 80 %, refraction 80, depth 20, dispersion 50,
 * frost 4, splay 0 (live popovers).
 */
export function defaultEffect(type: Effect["type"] = "DROP_SHADOW"): Effect {
  if (type === "DROP_SHADOW" || type === "INNER_SHADOW")
    return { type, color: { ...BLACK_25 }, offset: { x: 0, y: 4 }, radius: 4, spread: 0, visible: true, blendMode: "NORMAL", ...(type === "DROP_SHADOW" ? { showShadowBehindNode: false } : {}) };
  if (type === "NOISE")
    return { type, color: { ...BLACK_25 }, visible: true, blendMode: "NORMAL", noiseType: "MONOTONE", noiseSize: { x: 0.5, y: 0.5 }, density: 1 };
  if (type === "GRAIN") return { type, radius: 4, visible: true, noiseSize: { x: 0.5, y: 0.5 }, clipToShape: false };
  if (type === "GLASS")
    return { type, radius: 4, visible: true, specularAngle: -45, specularIntensity: 0.8, refractionIntensity: 0.8, bevelSize: 20, chromaticAberration: 0.5, refractionRadius: 0 };
  return { type, radius: 4, visible: true };
}

/** The effect as another type: a shadow keeps its numbers as a shadow, a blur its radius and type; others start fresh. */
export function withEffectType(e: Effect, type: Effect["type"]): Effect {
  if (type === e.type) return e;
  const base = defaultEffect(type);
  if (isShadow(e) && (type === "DROP_SHADOW" || type === "INNER_SHADOW")) {
    const out: Effect = { ...e, type };
    if (type === "INNER_SHADOW") delete out.showShadowBehindNode;
    else out.showShadowBehindNode ??= false;
    return out;
  }
  if (isBlur(e) && (type === "FOREGROUND_BLUR" || type === "BACKGROUND_BLUR")) return { ...e, type };
  if (isShadow(base) || isBlur(base)) return { ...base, radius: e.radius ?? base.radius, visible: e.visible ?? true };
  return { ...base, visible: e.visible ?? true };
}

/** A blur made progressive: Start 0, End = its radius, from the top of the layer to its bottom (Figma's default). */
export function withBlurType(e: Effect, progressive: boolean): Effect {
  if (!progressive) return { ...e, blurOpType: "NORMAL" };
  return { ...e, blurOpType: "PROGRESSIVE", startRadius: (e.startRadius as number | undefined) ?? 0, startOffset: (e.startOffset as V2 | undefined) ?? { x: 0.5, y: 0 }, endOffset: (e.endOffset as V2 | undefined) ?? { x: 0.5, y: 1 } };
}

export const effectLabel = (e: Effect) => EFFECT_TYPES.find((t) => t.value === e.type)?.label ?? "Effect";

function writeEffects(ed: EditorController, refs: readonly Guid[], effects: Effect[], label: string, info: ChangeInfo = { final: true, source: "pick" }) {
  ed.edit(label, info, () => void ed.engine.setProps(refs, fields({ effects })));
}

/** Whether every visible fill and stroke of the layers is opaque (then "Show behind transparent areas" means nothing). */
const opaqueLayers = (nodes: PanelNode[]) =>
  nodes.every((n) =>
    [...((n.fillPaints ?? []) as { type?: string; visible?: boolean; opacity?: number; color?: Color }[])].every(
      (p) => p.visible === false || ((p.opacity ?? 1) >= 1 && (p.type !== "SOLID" || (p.color?.a ?? 1) >= 1)),
    ),
  );

// The "Shader effects (Beta)" onboarding card: dismissed once per viewer ("Got it").
const ONBOARDING_KEY = "designer.effects.shaderOnboarding";
function onboardingDone(): boolean {
  try {
    return localStorage.getItem(ONBOARDING_KEY) === "done";
  } catch {
    return false;
  }
}
function finishOnboarding() {
  try {
    localStorage.setItem(ONBOARDING_KEY, "done");
  } catch {
    // private window: the card shows again next time
  }
}

export function EffectsSection({ nodes }: { nodes: PanelNode[] }) {
  const ed = useEditor();
  const kept = useKeeps("effects");
  const refs = nodes.map((n) => n.guid);
  const shared = mixed(nodes.map((n) => n.effects ?? []), sameData);
  const isMixedList = shared !== undefined && typeof shared === "symbol";
  const effects = (shared === undefined || isMixedList ? [] : [...(shared as Effect[])]) as Effect[];
  const [open, setOpen] = useState<{ index: number; anchor: HTMLElement } | null>(null);
  const [shaders, setShaders] = useState<{ anchor: HTMLElement; onboarding: boolean } | null>(null);
  const addButton = useRef<HTMLDivElement>(null);
  const add = () => {
    if (!onboardingDone()) {
      const anchor = addButton.current;
      if (anchor) setShaders({ anchor, onboarding: true });
      return;
    }
    writeEffects(ed, refs, isMixedList ? [defaultEffect()] : [...effects, defaultEffect()], "Add effect");
  };
  const empty = !isMixedList && effects.length === 0;
  const styled = sharedStyle(nodes, "effect");
  const hasStyle = !!styled && styled !== "mixed";
  // Rows show the top effect first: display index d is effect n − 1 − d (as Fill's rows).
  const n = effects.length;
  const { container: reorderRef, grip, dragging, line: dropLine } = useReorder((from, to) => writeEffects(ed, refs, moved(effects, n - 1 - from, n - 1 - to), "Reorder effects"));
  return (
    <PanelSection
      title="Effects"
      empty={empty}
      actions={
        <>
          <StylesButton nodes={nodes} slot="effect" />
          {!hasStyle && (
            <div ref={addButton} className={styles.inlineAnchor}>
              <IconButton icon="24.plus.small" label="Add effect" tone="secondary" disabled={!kept} aria-expanded={!!shaders} onClick={add} />
            </div>
          )}
        </>
      }
    >
      {hasStyle && <AppliedStyle nodes={nodes} slot="effect" />}
      {!hasStyle && isMixedList && <div className={styles.note}>Click + to replace mixed effects</div>}
      {!hasStyle && n > 0 && (
        <div ref={reorderRef} className={styles.reorderList}>
      {effects
        .map((e, i) => ({ e, i }))
        .reverse()
        .map(({ e, i }, d) => {
          const type = EFFECT_TYPES.find((t) => t.value === e.type) ?? EFFECT_TYPES[1];
          const set = (next: Effect, label: string, info?: ChangeInfo) => writeEffects(ed, refs, effects.map((x, j) => (j === i ? next : x)), label, info);
          return (
            <div key={i} className={cx(styles.paintRow, e.visible === false && styles.rowHidden, dragging === d && styles.rowDragging)} data-effect-row={e.type} data-reorder-row="">
              {n > 1 && <Grip {...grip(d)} />}
              <div className={styles.effectField}>
                <IconButton icon={type.icon} label="Effect settings" aria-expanded={open?.index === i} onClick={(ev) => setOpen(open?.index === i ? null : { index: i, anchor: ev.currentTarget })} />
                <span className={cx(styles.effectLabel, styles.effectName)}>{type.label}</span>
              </div>
              <IconButton icon={e.visible === false ? "24.hidden.small" : "24.eye.small"} label="Toggle visibility" tone="secondary" onClick={() => set({ ...e, visible: e.visible === false }, e.visible === false ? "Show effect" : "Hide effect")} />
              <IconButton icon="24.minus.small" label="Remove" tone="secondary" onClick={() => writeEffects(ed, refs, effects.filter((_, j) => j !== i), "Remove effect")} />
            </div>
          );
        })}
          {dropLine !== null && <div className={styles.dropLine} style={{ top: dropLine }} />}
        </div>
      )}
      {open && effects[open.index] && (
        <EffectSettings
          effect={effects[open.index]}
          anchor={open.anchor}
          opaque={opaqueLayers(nodes)}
          onClose={() => setOpen(null)}
          onChange={(next, info) => writeEffects(ed, refs, effects.map((x, j) => (j === open.index ? next : x)), "Effect", info)}
          onCancel={() => ed.cancelEdit()}
          onShaders={(anchor) => setShaders({ anchor, onboarding: !onboardingDone() })}
        />
      )}
      {shaders && (
        <ShaderEffects
          anchor={shaders.anchor}
          onboarding={shaders.onboarding}
          onGotIt={() => {
            finishOnboarding();
            setShaders(null);
          }}
          onClose={() => setShaders(null)}
        />
      )}
    </PanelSection>
  );
}

/** The blend mode button of a popover's header: Normal, then Figma's groups. */
function EffectBlend({ value, onChange }: { value: BlendMode; onChange: (b: BlendMode) => void }) {
  const entries = BLEND_MODES.map((m) => (m === "-" ? ("-" as const) : { id: m, label: BLEND_LABEL[m], checked: value === m }));
  const active = value !== "NORMAL" && value !== "PASS_THROUGH";
  return (
    <MenuButton label="Blend mode" entries={entries} className={styles.iconMenu} onSelect={(id) => onChange(id as BlendMode)}>
      <Icon name={active ? "24.blendmode.active.small" : "24.blendmode.small"} />
    </MenuButton>
  );
}

const pct = (v: number | undefined, fallback: number) => Math.round((v ?? fallback) * 1000) / 10;

/**
 * The effect's settings popover: the type dropdown in its header (and the blend mode for shadows and noise), the
 * type's fields in Figma's label / field columns.
 */
export function EffectSettings({
  effect,
  anchor,
  opaque = true,
  onChange,
  onCancel,
  onClose,
  onShaders,
}: {
  effect: Effect;
  anchor: HTMLElement;
  opaque?: boolean;
  onChange: (next: Effect, info: ChangeInfo) => void;
  onCancel: () => void;
  onClose: () => void;
  onShaders?: (anchor: HTMLElement) => void;
}) {
  const title = effectLabel(effect);
  const pick: ChangeInfo = { final: true, source: "pick" };
  const color = (effect.color as Color | undefined) ?? BLACK_25;
  const typeOptions = [...EFFECT_TYPES.map((t) => ({ value: t.value as string, label: t.label, icon: t.icon })), "-" as const, { value: "SHADER", label: "Shader", icon: "24.shader.small" as IconName }];
  const header = (
    <Select
      label="Effect settings"
      variant="ghost"
      width="hug"
      className={styles.fxType}
      noCheck
      prefix={EFFECT_TYPES.find((t) => t.value === effect.type)?.icon ?? "24.drop.shadow.mid.small"}
      value={effect.type}
      options={typeOptions}
      onChange={(v) => {
        if (v === "SHADER") onShaders?.(anchor);
        else onChange(withEffectType(effect, v as Effect["type"]), pick);
      }}
    />
  );
  const blend = hasEffectBlend(effect) ? <EffectBlend value={(effect.blendMode as BlendMode | undefined) ?? "NORMAL"} onChange={(b) => onChange({ ...effect, blendMode: b }, pick)} /> : undefined;
  const set = (patch: Partial<Effect>, info: ChangeInfo) => onChange({ ...effect, ...patch }, info);
  const vec = (key: string, fallback: V2) => (effect[key] as V2 | undefined) ?? fallback;
  const num = (key: string, fallback: number) => (effect[key] as number | undefined) ?? fallback;
  const colorRow = (label: string, key: "color" | "secondaryColor", value: Color, aria = "Color") => (
    <>
      <span className={styles.settingsLabel}>{label}</span>
      <ColorInput
        label={aria}
        swatchLabel={`Solid color hex: ${colorToHex(value).replace("#", "").toUpperCase()}`}
        color={colorToHex(value)}
        opacity={toPercent(value.a ?? 1)}
        onColor={(hex, info) => set({ [key]: hexToColor(hex, value.a ?? 1) }, info)}
        onOpacity={(o, info) => set({ [key]: { ...value, a: o / 100 } }, info)}
      />
    </>
  );
  const xy = (label: string, key: string, aria: string, fallback: V2, min?: number) => {
    const v = vec(key, fallback);
    return (
      <>
        <span className={styles.settingsLabel}>{label}</span>
        <NumericInput label={`${aria} X`} prefix="X" min={min} value={v.x} onChange={(x, info) => set({ [key]: { x, y: v.y } }, info)} onCancel={onCancel} />
        <span />
        <NumericInput label={`${aria} Y`} prefix="Y" min={min} value={v.y} onChange={(y, info) => set({ [key]: { x: v.x, y } }, info)} onCancel={onCancel} />
      </>
    );
  };
  let body: ReactNode = null;
  if (isShadow(effect)) {
    const offset = (effect.offset as V2 | undefined) ?? { x: 0, y: 0 };
    body = (
      <>
        <span className={styles.settingsLabel}>Position</span>
        <NumericInput label="Position X" prefix="X" value={offset.x} onChange={(x, info) => set({ offset: { x, y: offset.y } }, info)} onCancel={onCancel} />
        <span />
        <NumericInput label="Position Y" prefix="Y" value={offset.y} onChange={(y, info) => set({ offset: { x: offset.x, y } }, info)} onCancel={onCancel} />
        <span className={styles.settingsLabel}>Blur</span>
        <NumericInput scrubHandle="previous" label="Blur radius" min={0} value={effect.radius ?? 0} onChange={(v, info) => set({ radius: v }, info)} onCancel={onCancel} />
        <span className={styles.settingsLabel}>Spread</span>
        <NumericInput scrubHandle="previous" label="Spread" value={effect.spread ?? 0} onChange={(v, info) => set({ spread: v }, info)} onCancel={onCancel} />
        {colorRow("Color", "color", color)}
        {effect.type === "DROP_SHADOW" && !opaque && (
          <div className={styles.fxWide}>
            <Checkbox label="Show behind transparent areas" checked={effect.showShadowBehindNode === true} onChange={(on) => set({ showShadowBehindNode: on }, pick)} />
          </div>
        )}
      </>
    );
  } else if (isBlur(effect)) {
    const progressive = effect.blurOpType === "PROGRESSIVE";
    body = (
      <>
        <div className={cx(styles.fxWide, styles.fxLegended)}>
          {/* Live: the control's "Type" legend (read by assistive tech, clipped from view) */}
          <span className={styles.fxLegend}>Type</span>
          <SegmentedControl
            label="Type"
            fullWidth
            value={progressive ? "PROGRESSIVE" : "NORMAL"}
            options={[
              { value: "NORMAL", label: "Uniform" },
              { value: "PROGRESSIVE", label: "Progressive" },
            ]}
            onChange={(v) => onChange(withBlurType(effect, v === "PROGRESSIVE"), pick)}
          />
        </div>
        {progressive ? (
          <>
            <span className={styles.settingsLabel}>Start</span>
            <NumericInput label="Start" min={0} value={num("startRadius", 0)} onChange={(v, info) => set({ startRadius: v }, info)} onCancel={onCancel} />
            <span className={styles.settingsLabel}>End</span>
            <NumericInput label="End" min={0} value={effect.radius ?? 0} onChange={(v, info) => set({ radius: v }, info)} onCancel={onCancel} />
          </>
        ) : (
          <>
            <span className={styles.settingsLabel}>Blur</span>
            <NumericInput scrubHandle="previous" label="Blur radius" min={0} value={effect.radius ?? 0} onChange={(v, info) => set({ radius: v }, info)} onCancel={onCancel} />
          </>
        )}
      </>
    );
  } else if (effect.type === "NOISE") {
    const kind = (effect.noiseType as string | undefined) ?? "MONOTONE";
    const second = (effect.secondaryColor as Color | undefined) ?? { r: 1, g: 1, b: 1, a: 0.25 };
    body = (
      <>
        <div className={cx(styles.fxWide, styles.fxSegmented)}>
          <SegmentedControl
            label="Noise type"
            fullWidth
            value={kind}
            options={[
              { value: "MONOTONE", label: "Mono" },
              { value: "DUOTONE", label: "Duo" },
              { value: "MULTITONE", label: "Multi" },
            ]}
            onChange={(v) => set({ noiseType: v, ...(v === "DUOTONE" && !effect.secondaryColor ? { secondaryColor: second } : {}), ...(v === "MULTITONE" && effect.opacity === undefined ? { opacity: 0.25 } : {}) }, pick)}
          />
        </div>
        {xy("Noise size", "noiseSize", "Noise size", { x: 0.5, y: 0.5 }, 0)}
        <span className={styles.settingsLabel}>Density</span>
        <NumericInput label="Density" min={0} max={100} unit="%" value={pct(num("density", 1), 1)} onChange={(v, info) => set({ density: v / 100 }, info)} onCancel={onCancel} />
        {kind === "MULTITONE" ? (
          <>
            <span className={styles.settingsLabel}>Opacity</span>
            <NumericInput label="Opacity" min={0} max={100} unit="%" value={pct(num("opacity", 0.25), 0.25)} onChange={(v, info) => set({ opacity: v / 100 }, info)} onCancel={onCancel} />
          </>
        ) : (
          colorRow("Color", "color", color)
        )}
        {kind === "DUOTONE" && colorRow("", "secondaryColor", second, "Secondary color")}
      </>
    );
  } else if (effect.type === "GRAIN") {
    body = (
      <>
        {xy("Size", "noiseSize", "Size", { x: 0.5, y: 0.5 }, 0)}
        <span className={styles.settingsLabel}>Radius</span>
        <NumericInput label="Radius" min={0} value={effect.radius ?? 0} onChange={(v, info) => set({ radius: v }, info)} onCancel={onCancel} />
        <div className={cx(styles.fxWide, styles.fxCheck)}>
          <Checkbox label="Clip to shape" checked={effect.clipToShape === true} onChange={(on) => set({ clipToShape: on }, pick)} />
        </div>
      </>
    );
  } else if (effect.type === "GLASS") {
    const slider = (label: string, value: number, max: number, write: (v: number, info: ChangeInfo) => void) => (
      <>
        <span className={styles.settingsLabel}>{label}</span>
        {/* Live (popovers/effect-settings-glass.txt): the track 80 × 24, the slider over it 96 × 44 (its 12 thumb 22 in
            from each end), the value 56 beside — its number 48 × 15 at 7 in */}
        <div className={styles.fxSlider}>
          <span className={styles.fxTrack} />
          <input type="range" className={styles.fxRange} aria-label={label} min={0} max={max} step={1} value={value} onChange={(e) => write(Number(e.currentTarget.value), { final: false, source: "scrub" })} onPointerUp={(e) => write(Number(e.currentTarget.value), pick)} />
          <NumericInput className={styles.fxValue} label={label} min={0} max={max} precision={0} value={value} onChange={write} onCancel={onCancel} />
        </div>
      </>
    );
    body = (
      <>
        <span className={cx(styles.settingsLabel, styles.fxTop)}>Light</span>
        <div className={cx(styles.fxLight, styles.fxLegended)}>
          <span className={styles.fxLegend}>Light</span>
          <LightDial angle={num("specularAngle", -45)} onChange={(a, info) => set({ specularAngle: a }, info)} />
          <div className={styles.fxLightFields}>
            <NumericInput label="Angle" unit="°" min={-180} max={180} precision={0} value={Math.round(num("specularAngle", -45))} onChange={(v, info) => set({ specularAngle: v }, info)} onCancel={onCancel} />
            <NumericInput label="Intensity" unit="%" min={0} max={100} precision={0} value={pct(num("specularIntensity", 0.8), 0.8)} onChange={(v, info) => set({ specularIntensity: v / 100 }, info)} onCancel={onCancel} />
          </div>
        </div>
        <span className={cx(styles.fxWide, styles.fxGap)} />
        {slider("Refraction", Math.round(num("refractionIntensity", 0.8) * 100), 100, (v, info) => set({ refractionIntensity: v / 100 }, info))}
        {slider("Depth", Math.round(num("bevelSize", 20)), 100, (v, info) => set({ bevelSize: v }, info))}
        {slider("Dispersion", Math.round(num("chromaticAberration", 0.5) * 100), 100, (v, info) => set({ chromaticAberration: v / 100 }, info))}
        {slider("Frost", Math.round(effect.radius ?? 4), 100, (v, info) => set({ radius: v }, info))}
        {slider("Splay", Math.round(num("refractionRadius", 0)), 100, (v, info) => set({ refractionRadius: v }, info))}
      </>
    );
  }
  return (
    <Popover anchor={anchor} header={header} headerActions={blend} width={240} offsetX={-1} onClose={onClose} label={title}>
      <div className={cx(styles.fxSettings, (isBlur(effect) || effect.type === "NOISE") && styles.fxSettingsSegmented)} data-effect-settings={effect.type}>
        {body}
      </div>
    </Popover>
  );
}

/**
 * Glass's light: a dial whose dot sits toward the light (the angle counter-clockwise from the right, the way the
 * light travels: −45° lights the top-left edges); dragging it turns the light.
 */
function LightDial({ angle, onChange }: { angle: number; onChange: (a: number, info: ChangeInfo) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const rad = (angle * Math.PI) / 180;
  // Toward the light, in the dial's own space (y down).
  const dx = -Math.cos(rad), dy = Math.sin(rad);
  const at = (e: ReactPointerEvent | PointerEvent) => {
    const r = box.current?.getBoundingClientRect();
    if (!r) return angle;
    const x = e.clientX - (r.left + r.width / 2), y = e.clientY - (r.top + r.height / 2);
    // The dot toward (x, y): the light travels the other way.
    return Math.round((Math.atan2(y, -x) * 180) / Math.PI);
  };
  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    onChange(at(e), { final: false, source: "scrub" });
    const move = (ev: PointerEvent) => onChange(at(ev), { final: false, source: "scrub" });
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      onChange(at(ev), { final: true, source: "scrub" });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return (
    <div ref={box} className={styles.fxDial} role="slider" aria-label="Light" aria-valuemin={-180} aria-valuemax={180} aria-valuenow={Math.round(angle)} tabIndex={0} onPointerDown={down}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 15 : 1;
        if (e.key === "ArrowLeft" || e.key === "ArrowDown") onChange(Math.max(-180, Math.round(angle) - step), { final: true, source: "step" });
        else if (e.key === "ArrowRight" || e.key === "ArrowUp") onChange(Math.min(180, Math.round(angle) + step), { final: true, source: "step" });
      }}>
      <span className={styles.fxDialRing} />
      <span className={styles.fxDialDot} style={{ left: `calc(50% + ${dx} * var(--ds-space-4))`, top: `calc(50% + ${dy} * var(--ds-space-4))` }} />
    </div>
  );
}

/** Figma's shader fill presets ("By Figma", live popovers/fill-picker-custom.txt), in the browser's order. */
export const SHADER_FILL_PRESETS = ["Moving gradient", "Mesh gradient", "Nebula", "Water caustic", "Fractal noise", "Clouds", "Moire", "Glowing wave", "Concentric patterns", "Pattern grid"];

/** Figma's shader presets ("By Figma"), in the browser's order. */
export const SHADER_PRESETS = [
  "Shape-based particles", "Pattern refraction", "Halftone", "Chromatic metal", "Lens distortion", "Dither", "Gradient map", "Warp", "Pixelate", "Bokeh blur",
  "Outlines", "CRT screen", "Bloom", "Glowing particles", "Color adjust", "Pixel stretch", "Gooey merge", "Moving blobs", "Slice shift", "Light rays",
  "Hatching", "Colored edges", "Duotone filter", "Channel mixer", "Filter presets",
];

/**
 * The "Shader effects (Beta)" browser (live: the Effects "+" while its onboarding card is up): search, the card,
 * "Created by you" (Create new, AI) and Figma's presets. Shaders aren't drawn by this engine: the presets and the
 * agent are shown, not applied.
 */
export function ShaderEffects({
  anchor,
  onboarding,
  onGotIt,
  onClose,
  title = "Shader effects",
  list = SHADER_PRESETS,
  placement,
}: {
  anchor: HTMLElement;
  onboarding: boolean;
  onGotIt?: () => void;
  onClose: () => void;
  /** "Shader fills" for the fill picker's Shader tab (live popovers/fill-picker-custom.txt) */
  title?: string;
  list?: readonly string[];
  placement?: PopoverPlacement;
}) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const presets = list.filter((p) => !q || p.toLowerCase().includes(q));
  const header = (
    <div className={styles.shaderTitle}>
      <span className={styles.shaderName}>{title}</span>
      <span className={styles.shaderBeta}>Beta</span>
    </div>
  );
  return (
    <Popover anchor={anchor} placement={placement} header={header} headerActions={<IconButton icon="24.shader.small" label="Create with agents" disabled />} width={240} offsetX={-1} onClose={onClose} label={title}>
      <div className={styles.shaderBody} data-shader-effects="">
        <div className={styles.shaderSearch}>
          <SearchField label="Search" value={query} onChange={setQuery} />
        </div>
        {onboarding && !q && (
          <div className={styles.shaderCard} data-shader-onboarding="">
            <div className={styles.shaderArt} aria-hidden="true" />
            <p className={styles.shaderText}>Add animated shaders that respond to mouse movement, right on canvas, or create your own with the Figma agent.</p>
            <div className={styles.shaderActions}>
              <Button variant="ghost" onClick={onGotIt}>Got it</Button>
              {/* Live: enabled (#0c8ce9). Shaders aren't drawn here, so it closes the card like Got it (unverified what it adds) */}
              <Button variant="primary" onClick={onGotIt}>Try an example</Button>
            </div>
          </div>
        )}
        {!q && (
          <>
            <div className={styles.shaderSection}>Created by you</div>
            <div className={styles.shaderGrid}>
              <button type="button" className={styles.shaderTile} disabled>
                <span className={styles.shaderThumb}><Icon name="24.plus.small" /></span>
                <span className={styles.shaderTileName}>Create new <strong className={styles.shaderAi}>AI</strong></span>
              </button>
            </div>
          </>
        )}
        <div className={styles.shaderSection}>By Figma</div>
        <div className={styles.shaderGrid}>
          {presets.map((p) => (
            <button key={p} type="button" className={styles.shaderTile} disabled data-shader-preset={p}>
              <span className={styles.shaderThumb} />
              <span className={styles.shaderTileName}>{p}</span>
            </button>
          ))}
        </div>
      </div>
    </Popover>
  );
}

// ---- Layout guide ------------------------------------------------------------------------------------

/** Figma's guide colour: #FF0000 at 10%. */
const GUIDE_RED = { r: 1, g: 0, b: 0, a: 0.1 };

export type GuideKind = "GRID" | "COLUMNS" | "ROWS";

export const guideKind = (g: LayoutGrid): GuideKind => (g.pattern === "GRID" ? "GRID" : g.axis === "Y" ? "ROWS" : "COLUMNS");

/** Figma's new guide of a kind: Grid 10px; Columns / Rows 5, stretch, margin 0, gutter 20. */
export function defaultGuide(kind: GuideKind = "GRID"): LayoutGrid {
  if (kind === "GRID") return { pattern: "GRID", sectionSize: 10, color: GUIDE_RED, visible: true, axis: "X", type: "STRETCH" };
  return { pattern: "STRIPES", axis: kind === "ROWS" ? "Y" : "X", numSections: 5, type: "STRETCH", offset: 0, gutterSize: 20, sectionSize: 10, color: GUIDE_RED, visible: true };
}

/** The row's name: "Grid 10px", "Columns 5", "Rows 5" (Figma; "Columns 5 (Auto)" isn't shown). */
export function guideLabel(g: LayoutGrid): string {
  const kind = guideKind(g);
  if (kind === "GRID") return `Grid ${Math.round((g.sectionSize ?? 10) * 100) / 100}px`;
  return `${kind === "ROWS" ? "Rows" : "Columns"} ${g.numSections ?? 5}`;
}

export const GUIDE_ICON: Record<GuideKind, IconName> = { GRID: "24.grid", COLUMNS: "24.grid-column", ROWS: "24.grid-row" };

export function LayoutGuideSection({ nodes }: { nodes: PanelNode[] }) {
  const ed = useEditor();
  const kept = useKeeps("layoutGrids");
  const refs = nodes.map((n) => n.guid);
  const shared = mixed(nodes.map((n) => n.layoutGrids ?? []), sameData);
  const isMixedList = shared !== undefined && typeof shared === "symbol";
  const grids = (shared === undefined || isMixedList ? [] : [...(shared as LayoutGrid[])]) as LayoutGrid[];
  const [open, setOpen] = useState<{ index: number; anchor: HTMLElement } | null>(null);
  const write = (next: LayoutGrid[], label: string, info: ChangeInfo = { final: true, source: "pick" }) => ed.edit(label, info, () => void ed.engine.setProps(refs, fields({ layoutGrids: next })));
  const empty = !isMixedList && grids.length === 0;
  const styled = sharedStyle(nodes, "grid");
  const hasStyle = !!styled && styled !== "mixed";
  return (
    <PanelSection title="Layout guide" empty={empty} actions={<><StylesButton nodes={nodes} slot="grid" />{!hasStyle && <IconButton icon="24.plus.small" label="Add layout guide" tone="secondary" disabled={!kept} onClick={() => write(isMixedList ? [defaultGuide()] : [...grids, defaultGuide()], "Add layout guide")} />}</>}>
      {hasStyle && <AppliedStyle nodes={nodes} slot="grid" />}
      {!hasStyle && grids
        .map((g, i) => ({ g, i }))
        .reverse()
        .map(({ g, i }) => (
          <div key={i} className={cx(styles.paintRow, g.visible === false && styles.rowHidden)} data-guide-row={guideKind(g)}>
            <div className={styles.effectField}>
              <IconButton icon={GUIDE_ICON[guideKind(g)]} label="Layout guide settings" aria-expanded={open?.index === i} onClick={(ev) => setOpen(open?.index === i ? null : { index: i, anchor: ev.currentTarget })} />
              <span className={styles.effectLabel}>{guideLabel(g)}</span>
            </div>
            <IconButton icon={g.visible === false ? "24.hidden.small" : "24.eye.small"} label={g.visible === false ? "Show layout guide" : "Hide layout guide"} tone="secondary" onClick={() => write(grids.map((x, j) => (j === i ? { ...x, visible: x.visible === false } : x)), "Layout guide")} />
            <IconButton icon="24.minus.small" label="Remove layout guide" tone="secondary" onClick={() => write(grids.filter((_, j) => j !== i), "Remove layout guide")} />
          </div>
        ))}
      {open && grids[open.index] && (
        <GuideSettings grid={grids[open.index]} anchor={open.anchor} onClose={() => setOpen(null)} onCancel={() => ed.cancelEdit()} onChange={(next, info) => write(grids.map((x, j) => (j === open.index ? next : x)), "Layout guide", info)} />
      )}
    </PanelSection>
  );
}

export function GuideSettings({ grid, anchor, onChange, onCancel, onClose }: { grid: LayoutGrid; anchor: HTMLElement; onChange: (next: LayoutGrid, info: ChangeInfo) => void; onCancel: () => void; onClose: () => void }) {
  const kind = guideKind(grid);
  const color = grid.color ?? GUIDE_RED;
  const pick: ChangeInfo = { final: true, source: "pick" };
  const typeOptions =
    kind === "ROWS"
      ? [
          { value: "STRETCH", label: "Stretch" },
          { value: "MIN", label: "Top" },
          { value: "CENTER", label: "Center" },
          { value: "MAX", label: "Bottom" },
        ]
      : [
          { value: "STRETCH", label: "Stretch" },
          { value: "MIN", label: "Left" },
          { value: "CENTER", label: "Center" },
          { value: "MAX", label: "Right" },
        ];
  const stretch = (grid.type ?? "STRETCH") === "STRETCH";
  return (
    // Figma's live popover: the type dropdown in its header, then Count, Color, Type, Width, Margin / Offset, Gutter
    // (Grid: Size, Color) — labels 64, fields 136.
    <Popover
      anchor={anchor}
      width={240}
      onClose={onClose}
      label="Layout guide"
      header={
        <Select
          label="Layout guide type"
          variant="ghost"
          width="hug"
          className={styles.guideType}
          value={kind}
          options={[
            { value: "GRID", label: "Grid" },
            { value: "COLUMNS", label: "Columns" },
            { value: "ROWS", label: "Rows" },
          ]}
          onChange={(k) => onChange({ ...defaultGuide(k as GuideKind), color: grid.color ?? GUIDE_RED, visible: grid.visible ?? true }, pick)}
        />
      }
    >
      <div className={`${styles.settings} ${styles.settingsGuide} ${styles.guideBody}`} data-guide-settings="">
        {kind === "GRID" ? (
          <>
            <span className={styles.settingsLabel}>Size</span>
            <NumericInput scrubHandle="previous" label="Width" min={1} value={grid.sectionSize ?? 10} onChange={(v, info) => onChange({ ...grid, sectionSize: v }, info)} onCancel={onCancel} />
          </>
        ) : (
          <>
            <span className={styles.settingsLabel}>Count</span>
            <NumericInput scrubHandle="previous" label="Count" min={1} precision={0} value={grid.numSections ?? 5} onChange={(v, info) => onChange({ ...grid, numSections: Math.round(v) }, info)} onCancel={onCancel} />
          </>
        )}
        <span className={styles.settingsLabel}>Color</span>
        <ColorInput
          label="Layout guide color"
          swatchLabel={`Solid color hex: ${colorToHex(color).replace("#", "").toUpperCase()}`}
          color={colorToHex(color)}
          opacity={toPercent(color.a ?? 0.1)}
          onColor={(hex, info, o) => onChange({ ...grid, color: hexToColor(hex, o !== undefined ? o / 100 : (color.a ?? 0.1)) }, info)}
          onOpacity={(o, info) => onChange({ ...grid, color: { ...color, a: o / 100 } }, info)}
        />
        {kind !== "GRID" && (
          <>
            <span className={styles.settingsLabel}>Type</span>
            <Select label="Type" value={grid.type ?? "STRETCH"} options={typeOptions} onChange={(v) => onChange({ ...grid, type: v as LayoutGrid["type"] }, pick)} />
            <span className={styles.settingsLabel}>{kind === "ROWS" ? "Height" : "Width"}</span>
            <NumericInput scrubHandle="previous" label={kind === "ROWS" ? "Height" : "Width"} min={1} value={stretch ? null : (grid.sectionSize ?? 10)} valueLabel={stretch ? "Auto" : undefined} disabled={stretch} onChange={(v, info) => onChange({ ...grid, sectionSize: v }, info)} onCancel={onCancel} />
            <span className={styles.settingsLabel}>{stretch ? "Margin" : "Offset"}</span>
            <NumericInput scrubHandle="previous" label="Offset" min={0} value={grid.offset ?? 0} onChange={(v, info) => onChange({ ...grid, offset: v }, info)} onCancel={onCancel} />
            <span className={styles.settingsLabel}>Gutter</span>
            <NumericInput scrubHandle="previous" label="Gutter" min={0} value={grid.gutterSize ?? 20} onChange={(v, info) => onChange({ ...grid, gutterSize: v }, info)} onCancel={onCancel} />
          </>
        )}
      </div>
    </Popover>
  );
}
