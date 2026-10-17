/**
 * Effects and Layout guide (UI3), and the effect / guide settings popovers — as live Figma draws them
 * (docs/research/figma/live/popovers/effect-*.txt, effects-add-shader-effects.txt).
 *
 * Effects: each row, top first: the effect's glyph (opens its settings), its type's name, eye, minus. "+" adds a
 * Drop shadow with Figma's defaults (X 0, Y 4, Blur 4, Spread 0, #000000 25%); until its onboarding card is
 * dismissed it opens Figma's "Shader effects (Beta)" browser instead (the card's "Got it"), as live Figma does.
 * The settings popover: the type dropdown in its header (Inner shadow, Drop shadow, Layer blur, Background blur,
 * Noise, Texture, Glass, then Shader; a type the layer already has its most of — 8 shadows, 1 blur of each kind,
 * 2 noises, 1 texture, 1 glass — is greyed, "Already applied"), a blend mode button for shadows and noise, then per
 * type (atlas 08 §6) —
 * - shadows: Position X / Y and Spread (±30000), Blur (0–250), Color (and "Show behind transparent areas" on a drop
 *   shadow when the layer isn't opaque); Spread is off, saying why, where it can't draw;
 * - blurs: Type Uniform / Progressive; Blur, or Start and End (0–100);
 * - Noise: Noise type Mono / Duo / Multi; Noise size X / Y (Y following X while equal), Density, then Color (Mono),
 *   two colours (Duo) or Opacity (Multi);
 * - Texture: Size X / Y, Radius, Clip to shape;
 * - Glass: Light (a dial snapping to 45°, Angle −180…180°, Intensity), Refraction, Depth (refractionRadius 1–100),
 *   Dispersion, Frost, Splay (reflectionDistance 0–1); bevelSize stays 1 (model/glass.ts).
 * A type change keeps every field and fills in the new type's (Figma's UF); editing a hidden effect shows it.
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
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { BLEND_LABEL, BLEND_MODES, Button, Checkbox, ColorInput, Icon, IconButton, MenuButton, NumericInput, PanelSection, Popover, SearchField, SegmentedControl, Select, cx, tooltipProps, type ChangeInfo, type IconName, type PopoverPlacement } from "@/ds";
import { guidStr, guidVal, resolveVariable } from "../../model/variables";
import { VariablePicker } from "../variables/VariablePicker";
import type { BlendMode, Color, Guid } from "@/engine/codec";
import { useEditor, type EditorController } from "../../controller";
import { engineMethod } from "../../engineCompat";
import { Status } from "@/engine/abi";
import { colorToHex, hexToColor, toPercent } from "../../model/color";
import { mixed, sameData } from "../../model/mixed";
import { PANEL_MENU_GAP, fields, useKeeps, type Effect, type LayoutGrid, type PanelNode } from "./shared";
import styles from "./Design.module.css";
import { AppliedStyle, StylesButton, sharedStyle } from "./Styles";
import { Grip, moved, useReorder } from "./reorder";
import { SHADER_EFFECTS, SHADER_FILLS, presetOf, shaderEffect, type ShaderFields, type ShaderPreset } from "../../model/shaders";
import { ShaderParams } from "./ShaderSettings";
import { DrawSlider, SLIDER_RANGE, useDrawMode } from "../../draw/panels/DrawSliders";
import { t, tx, useT } from "@/i18n";
import { GLASS_DEFAULTS, figmaGlass, shownAngle } from "../../model/glass";

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
/** A field the effect doesn't hold reads as Figma's Effect reads it: noise / texture size 0, Multi opacity 0. */
const NO_SIZE: V2 = { x: 0, y: 0 };
/** Figma's Multi noise opacity when Multi is picked. */
const MULTI_OPACITY = 0.15;
/** A shadow's Position and Spread fields (±), its Blur field (atlas 08 §6.1: the Plugin API's clamp too). */
const SHADOW_MAX = 30000;
const SHADOW_BLUR_MAX = 250;
/** A noise's or texture's size field. */
const NOISE_SIZE_MAX = 100;

/** A new noise's or texture's random pattern: Figma's floor(10⁴ · random), so two of them don't look the same. */
export const randomSeed = () => Math.floor(Math.random() * 10000);

/**
 * Figma's new effect of a type: shadows 0 4 4 0 #000 25%; blurs radius 4 (Uniform); Noise Mono #000 25%, size 0.5,
 * density 100 %; Texture size 4, radius 4; both a random seed; Glass light −45° at 80 %, refraction 80, depth 20,
 * dispersion 50, frost 4, splay 0 (live popovers; Figma's effect panel defaults, docs/research/rea/effects.md §2.14,
 * §2.18).
 */
export function defaultEffect(type: Effect["type"] = "DROP_SHADOW"): Effect {
  // Figma's template (its `j()` then `IK(type)`, atlas 08 §4.1): every type starts from the drop shadow's fields — a
  // blur or a texture keeps the colour, offset and spread unseen — then the type's own, then the type's fill-ins.
  const base: Effect = { type, blendMode: "NORMAL", color: { ...BLACK_25 }, offset: { x: 0, y: 4 }, radius: 4, spread: 0, visible: true, showShadowBehindNode: false };
  if (type === "NOISE") Object.assign(base, { opacity: 0.25 });
  if (type === "GLASS") Object.assign(base, { ...GLASS_DEFAULTS, radius: base.radius, secondaryColor: { r: 1, g: 1, b: 1, a: 0 } });
  return { ...base, ...fillIns(base, type, false) };
}

/**
 * Figma's fill-ins when an effect becomes a type (its `UF`, atlas 08 §4.2): only the fields that are missing or falsy
 * (so a stored angle or intensity of 0 goes back to the default) — Texture its size, clip and seed; Noise Mono, size
 * 0.5, opacity 0.15, density 1, the white secondary colour and a seed; Glass its light, refraction, depth, dispersion
 * and splay; a progressive blur its radii clamped to 100 and its line top-centre → bottom-centre (along a line,
 * (0, −0.5) → (1, −0.5)); a shader clips to its shape.
 */
function fillIns(e: Effect, type: Effect["type"], lineOnly: boolean): Partial<Effect> {
  const missing = (k: string) => !e[k];
  const out: Record<string, unknown> = {};
  const fill = (k: string, v: unknown) => missing(k) && (out[k] = v);
  if (type === "GRAIN") {
    fill("noiseSize", { x: 4, y: 4 });
    if (e.clipToShape === undefined) out.clipToShape = false;
    fill("seed", randomSeed());
  } else if (type === "NOISE") {
    fill("noiseType", "MONOTONE");
    fill("noiseSize", { x: 0.5, y: 0.5 });
    fill("opacity", MULTI_OPACITY);
    fill("density", 1);
    fill("secondaryColor", { r: 1, g: 1, b: 1, a: 0.25 });
    fill("seed", randomSeed());
  } else if (type === "GLASS") {
    for (const [k, v] of Object.entries(GLASS_DEFAULTS)) if (k !== "radius") fill(k, v);
    fill("secondaryColor", { r: 1, g: 1, b: 1, a: 0 });
  } else if ((type === "FOREGROUND_BLUR" || type === "BACKGROUND_BLUR") && e.blurOpType === "PROGRESSIVE") {
    out.radius = Math.min(e.radius ?? 0, PROGRESSIVE_MAX);
    out.startRadius = Math.min((e.startRadius as number | undefined) ?? 0, PROGRESSIVE_MAX);
    fill("startOffset", lineOnly ? { x: 0, y: -0.5 } : { x: 0.5, y: 0 });
    fill("endOffset", lineOnly ? { x: 1, y: -0.5 } : { x: 0.5, y: 1 });
  } else if (type === "CUSTOM") {
    if (e.clipToShape === undefined) out.clipToShape = true;
  }
  return out as Partial<Effect>;
}

/**
 * The effect as another type, as Figma's type menu writes it: every field kept (a shadow turned layer blur keeps its
 * colour and offset unseen, and has them back when turned into a shadow again), the new type's missing ones filled in.
 */
export function withEffectType(e: Effect, type: Effect["type"], lineOnly = false): Effect {
  if (type === e.type) return e;
  return { ...e, type, ...fillIns(e, type, lineOnly) };
}

/**
 * Uniform ↔ Progressive: progressive clamps both radii to 100 and gives a line from the top of the layer to its bottom
 * when it has none (along a line: its length); back to Uniform keeps Start and the line in the data.
 */
export function withBlurType(e: Effect, progressive: boolean, lineOnly = false): Effect {
  if (!progressive) return { ...e, blurOpType: "NORMAL" };
  const p: Effect = { ...e, blurOpType: "PROGRESSIVE" };
  return { ...p, ...fillIns(p, p.type, lineOnly) };
}

/** A progressive blur's Start and End (and the radii it clamps to on the switch). */
export const PROGRESSIVE_MAX = 100;

/** Figma's cap on one layer's effects of each type (atlas 08 §3.2); the renderer draws up to eight shadows. */
export const EFFECT_LIMITS: Partial<Record<Effect["type"], number>> = { DROP_SHADOW: 8, INNER_SHADOW: 8, FOREGROUND_BLUR: 1, BACKGROUND_BLUR: 1, NOISE: 2, GRAIN: 1, GLASS: 1, CUSTOM: 10 };

/** The types the list can't take another of (greyed in the type menu, "Already applied"); `own` keeps its own type. */
export function fullTypes(effects: readonly Effect[], own?: number): Set<Effect["type"]> {
  const out = new Set<Effect["type"]>();
  for (const [type, limit] of Object.entries(EFFECT_LIMITS) as [Effect["type"], number][]) if (effects.filter((x) => x.type === type).length >= limit) out.add(type);
  if (own !== undefined && effects[own]) out.delete(effects[own].type);
  return out;
}

/**
 * Why a shadow's Spread is off for these layers (Figma draws it on rectangles, ellipses and frames that clip and have a
 * visible fill — the engine's shadowSpread), first cause first; null when every layer takes it.
 */
export function spreadBlocker(nodes: readonly PanelNode[]): "fills" | "clip" | "shape" | null {
  for (const n of nodes) {
    if (n.type === "RECTANGLE" || n.type === "ROUNDED_RECTANGLE" || n.type === "ELLIPSE") continue;
    if (n.type === "FRAME" || n.type === "SYMBOL" || n.type === "INSTANCE") {
      const fills = ((n.fillPaints ?? []) as { visible?: boolean; opacity?: number; type?: string; color?: Color }[]).some((p) => p.visible !== false && (p.opacity ?? 1) * (p.type === "SOLID" ? (p.color?.a ?? 1) : 1) >= 0.01);
      if (!fills) return "fills";
      if (n.frameMaskDisabled === true) return "clip";
      continue;
    }
    return "shape";
  }
  return null;
}

/**
 * Spread's disabled tooltip by cause (Figma's `spread_fills_warning`, `spread_clip_warning`,
 * `spread_rect_ellipse_warning`; their English is unattested — this wording is Wecra's).
 */
const SPREAD_WARNING = {
  fills: "Spread only applies to frames with a visible fill",
  clip: "Spread only applies to frames that clip content",
  shape: "Spread only applies to rectangles, ellipses and frames",
} as const;

/** The glass light's angle as the field shows it: −180…180° (a stored angle past 180 less 360, atlas 08 §6.5). */
export const shownLightAngle = (a: number) => {
  const w = shownAngle(a);
  return w > 180 ? w - 360 : w;
};

/**
 * The light dial's angle while dragging (atlas 08 §6.5): ⇧ snaps to multiples of 45°; otherwise a multiple of 45° within
 * 4° pulls it on; ⌃ turns snapping off.
 */
export function snapLightAngle(a: number, mods: { shiftKey: boolean; ctrlKey: boolean }): number {
  if (mods.ctrlKey) return a;
  const near = Math.round(a / 45) * 45;
  if (mods.shiftKey || Math.abs(a - near) <= 4) return near;
  return a;
}

/** Large-preview rows (Draw): the effect's values after its name (atlas 08 §5.1), numbers to two decimals. */
export function effectSummary(e: Effect): string {
  const n = (v: number | undefined) => String(Math.round((v ?? 0) * 100) / 100);
  const size = (s: V2 | undefined) => (s && s.x !== s.y ? `${t("Size X")} ${n(s.x)} ${t("Size Y")} ${n(s.y)}` : `${t("Size")} ${n(s?.x)}`);
  if (isShadow(e)) {
    const o = (e.offset as V2 | undefined) ?? { x: 0, y: 0 };
    return `X ${n(o.x)} Y ${n(o.y)} B ${n(e.radius)} S ${n(e.spread)}`;
  }
  if (isBlur(e)) return e.blurOpType === "PROGRESSIVE" ? `${t("Progressive")} ${n(e.startRadius as number | undefined)} → ${n(e.radius)}` : `${t("Uniform")} ${n(e.radius)}`;
  if (e.type === "GRAIN") return `${size(e.noiseSize as V2 | undefined)} R ${n(e.radius)}`;
  if (e.type === "NOISE") {
    const kind = { MONOTONE: "Mono", DUOTONE: "Duo", MULTITONE: "Multi" }[(e.noiseType as string | undefined) ?? "MONOTONE"] ?? "Mono";
    return `${t(kind)} ${size(e.noiseSize as V2 | undefined)} D ${Math.round(((e.density as number | undefined) ?? 1) * 100)}%`;
  }
  if (e.type === "GLASS") return `A ${n(e.specularAngle as number | undefined)}° I ${Math.round(((e.specularIntensity as number | undefined) ?? 0.8) * 100)}%`;
  return "";
}

/** The row's name: the type's ("Drop shadow"), a shader's preset ("Halftone"). */
export const effectLabel = (e: Effect) => (e.type === "CUSTOM" ? (presetOf(e as ShaderFields)?.name ?? "Shader") : (EFFECT_TYPES.find((t) => t.value === e.type)?.label ?? "Effect"));
/** The type's glyph (a shader's: the shader icon). */
export const effectIcon = (e: Effect): IconName => (e.type === "CUSTOM" ? "24.shader.small" : (EFFECT_TYPES.find((t) => t.value === e.type) ?? EFFECT_TYPES[1]).icon);

/**
 * A progressive blur's Start and End handles on the canvas (Figma's PROGRESSIVE_BLUR edit mode, atlas 08 §6.2): on while
 * its settings are open on one layer; returns how the panel's Start / End fields mark their handle.
 */
function useBlurHandles(ed: EditorController, ref: Guid | null, index: number | null, progressive: boolean): (handle: "START" | "END" | "NONE") => void {
  useEffect(() => {
    if (!ref || index === null || !progressive) return;
    const start = engineMethod<(ref: Guid, index: number) => number>(ed.engine, "startBlurEdit");
    if (!start || start(ref, index) !== Status.OK) return;
    return () => {
      if (!ed.engine.destroyed) engineMethod<() => void>(ed.engine, "endPaintEdit")?.();
    };
  }, [ed, ref, index, progressive]);
  return (handle) => {
    if (ref && progressive && !ed.engine.destroyed) engineMethod<(h: string) => number>(ed.engine, "setBlurEditHandle")?.(handle);
  };
}

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
  useT();
  const ed = useEditor();
  const kept = useKeeps("effects");
  const drawMode = useDrawMode();
  const refs = nodes.map((n) => n.guid);
  const shared = mixed(nodes.map((n) => n.effects ?? []), sameData);
  const isMixedList = shared !== undefined && typeof shared === "symbol";
  const effects = (shared === undefined || isMixedList ? [] : [...(shared as Effect[])]) as Effect[];
  const [open, setOpen] = useState<{ index: number; anchor: HTMLElement } | null>(null);
  // The Shader effects browser: from "+" (a pick adds the shader) or an effect's type menu (a pick replaces it).
  const [shaders, setShaders] = useState<{ anchor: HTMLElement; onboarding: boolean; replace?: number } | null>(null);
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
  const openEffect = open ? effects[open.index] : undefined;
  const markHandle = useBlurHandles(ed, refs.length === 1 ? refs[0] : null, open?.index ?? null, !!openEffect && isBlur(openEffect) && openEffect.blurOpType === "PROGRESSIVE");
  const { container: reorderRef, grip, dragging, line: dropLine } = useReorder((from, to) => writeEffects(ed, refs, moved(effects, n - 1 - from, n - 1 - to), "Reorder effects"));
  return (
    <PanelSection
      title={t("Effects")}
      empty={empty}
      actions={
        <>
          <StylesButton nodes={nodes} slot="effect" />
          {!hasStyle && (
            <div ref={addButton} className={styles.inlineAnchor}>
              <IconButton icon="24.plus.small" label={t("Add effect")} tone="secondary" disabled={!kept} aria-expanded={!!shaders} onClick={add} />
            </div>
          )}
        </>
      }
    >
      {hasStyle && <AppliedStyle nodes={nodes} slot="effect" />}
      {!hasStyle && isMixedList && <div className={styles.note}>{t("Click + to replace mixed effects")}</div>}
      {!hasStyle && n > 0 && (
        <div ref={reorderRef} className={styles.reorderList}>
      {effects
        .map((e, i) => ({ e, i }))
        .reverse()
        .map(({ e, i }, d) => {
          const type = { icon: effectIcon(e), label: t(effectLabel(e)) };
          const set = (next: Effect, label: string, info?: ChangeInfo) => writeEffects(ed, refs, effects.map((x, j) => (j === i ? next : x)), label, info);
          return (
            <div key={i} className={cx(styles.paintRow, e.visible === false && styles.rowHidden, dragging === d && styles.rowDragging)} data-effect-row={e.type} data-reorder-row="">
              {n > 1 && <Grip {...grip(d)} />}
              <div className={styles.effectField}>
                <IconButton icon={type.icon} label={t("Effect settings")} aria-expanded={open?.index === i} onClick={(ev) => setOpen(open?.index === i ? null : { index: i, anchor: ev.currentTarget })} />
                <span className={cx(styles.effectLabel, styles.effectName)}>{type.label}</span>
                {/* Draw's large-preview rows: the values after the name (atlas 08 §5.1) */}
                {drawMode && <span className={styles.effectSummary}>{effectSummary(e)}</span>}
              </div>
              <IconButton icon={e.visible === false ? "24.hidden.small" : "24.eye.small"} label={t("Toggle visibility")} tone="secondary" onClick={() => set({ ...e, visible: e.visible === false }, e.visible === false ? "Show effect" : "Hide effect")} />
              <IconButton icon="24.minus.small" label={t("Remove")} tone="secondary" onClick={() => writeEffects(ed, refs, effects.filter((_, j) => j !== i), "Remove effect")} />
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
          full={fullTypes(effects, open.index)}
          lineOnly={nodes.length > 0 && nodes.every((x) => x.type === "LINE")}
          spreadBlocked={spreadBlocker(nodes)}
          onHandle={markHandle}
          sliders={drawMode}
          onClose={() => setOpen(null)}
          onChange={(next, info) => writeEffects(ed, refs, effects.map((x, j) => (j === open.index ? next : x)), "Effect", info)}
          onCancel={() => ed.cancelEdit()}
          onShaders={(anchor) => setShaders({ anchor, onboarding: !onboardingDone(), replace: open.index })}
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
          onPick={(preset, example) => {
            // A preset adds a shader effect (or turns the effect whose type menu opened the browser into it).
            const at = shaders.replace;
            const next = at !== undefined && effects[at] ? effects.map((x, j) => (j === at ? (shaderEffect(x, preset) as Effect) : x)) : [...(isMixedList ? [] : effects), shaderEffect(null, preset) as Effect];
            writeEffects(ed, refs, next, at !== undefined ? "Effect" : "Add effect");
            if (example) finishOnboarding();
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
  useT();
  const entries = BLEND_MODES.map((m) => (m === "-" ? ("-" as const) : { id: m, label: t(BLEND_LABEL[m]), checked: value === m }));
  const active = value !== "NORMAL" && value !== "PASS_THROUGH";
  return (
    <MenuButton label={t("Blend mode")} entries={entries} className={styles.iconMenu} gap={PANEL_MENU_GAP} flush onSelect={(id) => onChange(id as BlendMode)}>
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
  effect: given,
  anchor,
  opaque = true,
  full,
  lineOnly = false,
  spreadBlocked = null,
  onChange: write,
  onCancel,
  onClose,
  onShaders,
  onHandle,
  sliders = false,
}: {
  /** A progressive blur's Start / End field hovered or focused: its handle on the canvas is marked */
  onHandle?: (handle: "START" | "END" | "NONE") => void;
  effect: Effect;
  anchor: HTMLElement;
  opaque?: boolean;
  /** The types the layer's list can't take another of (fullTypes: one glass, eight drop shadows…): greyed in the type menu */
  full?: ReadonlySet<Effect["type"]>;
  /** The selection is lines only: a progressive blur runs along them */
  lineOnly?: boolean;
  /** Why Spread is off for the selection (spreadBlocker), or null */
  spreadBlocked?: ReturnType<typeof spreadBlocker>;
  /** Draw (docs/draw.md §5.3): a slider under blur, spread, density, opacity and radius */
  sliders?: boolean;
  onChange: (next: Effect, info: ChangeInfo) => void;
  onCancel: () => void;
  onClose: () => void;
  onShaders?: (anchor: HTMLElement) => void;
}) {
  useT();
  // A glass Wecra wrote before round 17 shows (and is written back) in Figma's fields.
  const effect = figmaGlass(given);
  // Editing any field of a hidden effect shows it again (Figma's onChange sets visible, atlas 08 §5.1).
  const onChange = (next: Effect, info: ChangeInfo) => write(next.visible === false ? { ...next, visible: true } : next, info);
  const title = t(effectLabel(effect));
  const pick: ChangeInfo = { final: true, source: "pick" };
  const color = (effect.color as Color | undefined) ?? BLACK_25;
  const typeOptions = [
    ...EFFECT_TYPES.map((o) => {
      const taken = !!full?.has(o.value) && o.value !== effect.type;
      return { value: o.value as string, label: t(o.label), icon: o.icon, disabled: taken, ...(taken ? { hint: t("Already applied") } : {}) };
    }),
    "-" as const,
    { value: "CUSTOM", label: t("Shader"), icon: "24.shader.small" as IconName, disabled: !!full?.has("CUSTOM") && effect.type !== "CUSTOM" },
  ];
  const header = (
    <Select
      label={t("Effect settings")}
      variant="ghost"
      width="hug"
      className={styles.fxType}
      noCheck
      prefix={effectIcon(effect)}
      value={effect.type}
      options={typeOptions}
      onChange={(v) => {
        // Shader: the browser picks the preset (the effect becomes it).
        if (v === "CUSTOM") {
          if (effect.type !== "CUSTOM") onShaders?.(anchor);
        } else onChange(withEffectType(effect, v as Effect["type"], lineOnly), pick);
      }}
    />
  );
  const blend = hasEffectBlend(effect) ? <EffectBlend value={(effect.blendMode as BlendMode | undefined) ?? "NORMAL"} onChange={(b) => onChange({ ...effect, blendMode: b }, pick)} /> : undefined;
  const set = (patch: Partial<Effect>, info: ChangeInfo) => onChange({ ...effect, ...patch }, info);
  const vec = (key: string, fallback: V2) => (effect[key] as V2 | undefined) ?? fallback;
  const num = (key: string, fallback: number) => (effect[key] as number | undefined) ?? fallback;
  // Draw's slider under a field (an empty label cell keeps the grid's pairs).
  const slide = (label: string, value: number, [min, max]: readonly [number, number], write: (v: number, info: ChangeInfo) => void) =>
    sliders ? (
      <>
        <span />
        <DrawSlider spec={{ label: t(label), value, min, max, onChange: write, onCancel }} />
      </>
    ) : null;
  const colorRow = (label: string, key: "color" | "secondaryColor", value: Color, aria = "Color") => (
    <>
      <span className={styles.settingsLabel}>{label && t(label)}</span>
      <ColorInput
        label={t(aria)}
        swatchLabel={t("Solid color hex: {hex}", { hex: colorToHex(value).replace("#", "").toUpperCase() })}
        color={colorToHex(value)}
        opacity={toPercent(value.a ?? 1)}
        onColor={(hex, info) => set({ [key]: hexToColor(hex, value.a ?? 1) }, info)}
        onOpacity={(o, info) => set({ [key]: { ...value, a: o / 100 } }, info)}
      />
    </>
  );
  // A noise's or texture's size (atlas 08 §6.3–6.4): up to 100; Y follows X while the two are equal — it shows X as
  // its placeholder — and emptying Y links it again.
  const xy = (label: string, key: string, aria: string, fallback: V2) => {
    const v = vec(key, fallback);
    const linked = v.x === v.y;
    return (
      <>
        <span className={styles.settingsLabel}>{t(label)}</span>
        <NumericInput label={t("{name} X", { name: t(aria) })} prefix="X" min={0} max={NOISE_SIZE_MAX} value={v.x} onChange={(x, info) => set({ [key]: { x, y: linked ? x : v.y } }, info)} onCancel={onCancel} />
        <span />
        <NumericInput
          label={t("{name} Y", { name: t(aria) })}
          prefix="Y"
          min={0}
          max={NOISE_SIZE_MAX}
          value={linked ? null : v.y}
          placeholder={linked ? String(Math.round(v.x * 100) / 100) : undefined}
          onChange={(y, info) => set({ [key]: { x: v.x, y } }, info)}
          onClear={() => set({ [key]: { x: v.x, y: v.x } }, pick)}
          onCancel={onCancel}
        />
      </>
    );
  };
  let body: ReactNode = null;
  if (isShadow(effect)) {
    const offset = (effect.offset as V2 | undefined) ?? { x: 0, y: 0 };
    body = (
      <>
        {/* Figma's limits (atlas 08 §6.1): Position and Spread ±30000 (Draw's sliders ±300), Blur 0–250 (slider 0–100) */}
        <span className={styles.settingsLabel}>{t("Position")}</span>
        <NumericInput label={t("Position X")} prefix="X" min={-SHADOW_MAX} max={SHADOW_MAX} value={offset.x} onChange={(x, info) => set({ offset: { x, y: offset.y } }, info)} onCancel={onCancel} />
        <span />
        <NumericInput label={t("Position Y")} prefix="Y" min={-SHADOW_MAX} max={SHADOW_MAX} value={offset.y} onChange={(y, info) => set({ offset: { x: offset.x, y } }, info)} onCancel={onCancel} />
        <span className={styles.settingsLabel}>{t("Blur")}</span>
        <NumericInput scrubHandle="previous" label={t("Blur radius")} min={0} max={SHADOW_BLUR_MAX} value={effect.radius ?? 0} onChange={(v, info) => set({ radius: v }, info)} onCancel={onCancel} />
        {slide("Blur radius", effect.radius ?? 0, [0, 100], (v, info) => set({ radius: v }, info))}
        <span className={styles.settingsLabel}>{t("Spread")}</span>
        {/* Off where it can't draw (a text, a frame without a fill or clip…), saying why; the stored value stays */}
        <span className={styles.fxSpread} {...(spreadBlocked ? tooltipProps(t(SPREAD_WARNING[spreadBlocked])) : {})}>
          <NumericInput scrubHandle="previous" label={t("Spread")} min={-SHADOW_MAX} max={SHADOW_MAX} disabled={!!spreadBlocked} value={effect.spread ?? 0} onChange={(v, info) => set({ spread: v }, info)} onCancel={onCancel} />
        </span>
        {!spreadBlocked && slide("Spread", effect.spread ?? 0, [-300, 300], (v, info) => set({ spread: v }, info))}
        {colorRow("Color", "color", color)}
        {slide("Color opacity", toPercent(color.a ?? 1), SLIDER_RANGE.percent, (o, info) => set({ color: { ...color, a: o / 100 } }, info))}
        {effect.type === "DROP_SHADOW" && !opaque && (
          <div className={styles.fxWide}>
            <Checkbox label={t("Show behind transparent areas")} checked={effect.showShadowBehindNode === true} onChange={(on) => set({ showShadowBehindNode: on }, pick)} />
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
          <span className={styles.fxLegend}>{t("Type")}</span>
          <SegmentedControl
            label={t("Type")}
            fullWidth
            value={progressive ? "PROGRESSIVE" : "NORMAL"}
            options={[
              { value: "NORMAL", label: t("Uniform") },
              { value: "PROGRESSIVE", label: t("Progressive") },
            ]}
            onChange={(v) => onChange(withBlurType(effect, v === "PROGRESSIVE", lineOnly), pick)}
          />
        </div>
        {progressive ? (
          <>
            {/* Start and End 0–100 (atlas 08 §6.2); hovering or focusing one marks its handle on the canvas */}
            <span className={styles.settingsLabel}>{t("Start")}</span>
            <span className={styles.fxHandleField} onPointerEnter={() => onHandle?.("START")} onPointerLeave={() => onHandle?.("NONE")} onFocus={() => onHandle?.("START")} onBlur={() => onHandle?.("NONE")}>
              <NumericInput label={t("Start")} min={0} max={PROGRESSIVE_MAX} value={num("startRadius", 0)} onChange={(v, info) => set({ startRadius: v }, info)} onCancel={onCancel} />
            </span>
            {slide("Start", num("startRadius", 0), [0, PROGRESSIVE_MAX], (v, info) => set({ startRadius: v }, info))}
            <span className={styles.settingsLabel}>{t("End")}</span>
            <span className={styles.fxHandleField} onPointerEnter={() => onHandle?.("END")} onPointerLeave={() => onHandle?.("NONE")} onFocus={() => onHandle?.("END")} onBlur={() => onHandle?.("NONE")}>
              <NumericInput label={t("End")} min={0} max={PROGRESSIVE_MAX} value={effect.radius ?? 0} onChange={(v, info) => set({ radius: v }, info)} onCancel={onCancel} />
            </span>
            {slide("End", effect.radius ?? 0, [0, PROGRESSIVE_MAX], (v, info) => set({ radius: v }, info))}
          </>
        ) : (
          <>
            {/* No input max; the slider goes to 500 for a layer blur, 100 for a background blur */}
            <span className={styles.settingsLabel}>{t("Blur")}</span>
            <NumericInput scrubHandle="previous" label={t("Blur radius")} min={0} value={effect.radius ?? 0} onChange={(v, info) => set({ radius: v }, info)} onCancel={onCancel} />
            {slide("Blur radius", effect.radius ?? 0, [0, effect.type === "FOREGROUND_BLUR" ? 500 : 100], (v, info) => set({ radius: v }, info))}
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
            label={t("Noise type")}
            fullWidth
            value={kind}
            options={[
              { value: "MONOTONE", label: t("Mono") },
              { value: "DUOTONE", label: t("Duo") },
              { value: "MULTITONE", label: t("Multi") },
            ]}
            onChange={(v) => set({ noiseType: v, ...(v === "DUOTONE" && !effect.secondaryColor ? { secondaryColor: second } : {}), ...(v === "MULTITONE" && effect.opacity === undefined ? { opacity: MULTI_OPACITY } : {}) }, pick)}
          />
        </div>
        {xy("Noise size", "noiseSize", "Noise size", NO_SIZE)}
        <span className={styles.settingsLabel}>{t("Density")}</span>
        <NumericInput label={t("Density")} min={0} max={100} unit="%" value={pct(num("density", 1), 1)} onChange={(v, info) => set({ density: v / 100 }, info)} onCancel={onCancel} />
        {slide("Density", pct(num("density", 1), 1), SLIDER_RANGE.percent, (v, info) => set({ density: v / 100 }, info))}
        {kind === "MULTITONE" ? (
          <>
            <span className={styles.settingsLabel}>{t("Opacity")}</span>
            <NumericInput label={t("Opacity")} min={0} max={100} unit="%" value={pct(num("opacity", 0), 0)} onChange={(v, info) => set({ opacity: v / 100 }, info)} onCancel={onCancel} />
            {slide("Opacity", pct(num("opacity", 0), 0), SLIDER_RANGE.percent, (v, info) => set({ opacity: v / 100 }, info))}
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
        {xy("Size", "noiseSize", "Size", NO_SIZE)}
        <span className={styles.settingsLabel}>{t("Radius")}</span>
        <NumericInput label={t("Radius")} min={0} value={effect.radius ?? 0} onChange={(v, info) => set({ radius: v }, info)} onCancel={onCancel} />
        {slide("Radius", effect.radius ?? 0, SLIDER_RANGE.blur, (v, info) => set({ radius: v }, info))}
        <div className={cx(styles.fxWide, styles.fxCheck)}>
          <Checkbox label={t("Clip to shape")} checked={effect.clipToShape === true} onChange={(on) => set({ clipToShape: on }, pick)} />
        </div>
      </>
    );
  } else if (effect.type === "GLASS") {
    const slider = (label: string, value: number, max: number, write: (v: number, info: ChangeInfo) => void, min = 0) => (
      <>
        <span className={styles.settingsLabel}>{t(label)}</span>
        {/* Live (popovers/effect-settings-glass.txt): the track 80 × 24, the slider over it 96 × 44 (its 12 thumb 22 in
            from each end), the value 56 beside — its number 48 × 15 at 7 in */}
        <div className={styles.fxSlider}>
          <span className={styles.fxTrack} />
          <input type="range" className={styles.fxRange} aria-label={t(label)} min={min} max={max} step={1} value={value} onChange={(e) => write(Number(e.currentTarget.value), { final: false, source: "scrub" })} onPointerUp={(e) => write(Number(e.currentTarget.value), pick)} />
          <NumericInput className={styles.fxValue} label={t(label)} min={min} max={max} precision={0} value={value} onChange={write} onCancel={onCancel} />
        </div>
      </>
    );
    body = (
      <>
        <span className={cx(styles.settingsLabel, styles.fxTop)}>{tx("glass", "Light")}</span>
        <div className={cx(styles.fxLight, styles.fxLegended)}>
          <span className={styles.fxLegend}>{tx("glass", "Light")}</span>
          {/* The angle shows −180…180° and is written 0…359° (atlas 08 §6.5) */}
          <LightDial angle={num("specularAngle", -45)} onChange={(a, info) => set({ specularAngle: shownAngle(a) }, info)} />
          <div className={styles.fxLightFields}>
            <NumericInput label={t("Angle")} unit="°" min={-180} max={180} precision={0} value={shownLightAngle(num("specularAngle", -45))} onChange={(v, info) => set({ specularAngle: shownAngle(v) }, info)} onCancel={onCancel} />
            <NumericInput label={t("Intensity")} unit="%" min={0} max={100} precision={0} value={pct(num("specularIntensity", 0.8), 0.8)} onChange={(v, info) => set({ specularIntensity: v / 100 }, info)} onCancel={onCancel} />
          </div>
        </div>
        <span className={cx(styles.fxWide, styles.fxGap)} />
        {slider("Refraction", Math.round(num("refractionIntensity", 0.8) * 100), 100, (v, info) => set({ refractionIntensity: v / 100 }, info))}
        {slider("Depth", Math.round(num("refractionRadius", GLASS_DEFAULTS.refractionRadius)), 100, (v, info) => set({ refractionRadius: Math.max(1, v), bevelSize: 1 }, info), 1)}
        {slider("Dispersion", Math.round(num("chromaticAberration", 0.5) * 100), 100, (v, info) => set({ chromaticAberration: v / 100 }, info))}
        {slider("Frost", Math.round(effect.radius ?? 4), 100, (v, info) => set({ radius: v }, info))}
        {slider("Splay", Math.round(num("reflectionDistance", 0) * 100), 100, (v, info) => set({ reflectionDistance: v / 100 }, info))}
      </>
    );
  }
  return (
    <Popover anchor={anchor} header={header} headerActions={blend} width={240} offsetX={-1} onClose={onClose} label={title}>
      {effect.type === "CUSTOM" ? (
        <div data-effect-settings={effect.type}>
          <ShaderParams target={effect as Effect & ShaderFields} onChange={(next, info) => onChange(next as Effect, info)} onCancel={onCancel} onChoose={onShaders} />
        </div>
      ) : (
        <div className={cx(styles.fxSettings, (isBlur(effect) || effect.type === "NOISE") && styles.fxSettingsSegmented)} data-effect-settings={effect.type}>
          {body}
        </div>
      )}
    </Popover>
  );
}

/**
 * Glass's light: a dial whose dot sits toward the light (the angle counter-clockwise from the right, the way the
 * light travels: −45° lights the top-left edges); dragging it turns the light — ⇧ in 45° steps, otherwise pulled onto a
 * 45° step within 4°, ⌃ free (atlas 08 §6.5).
 */
function LightDial({ angle, onChange }: { angle: number; onChange: (a: number, info: ChangeInfo) => void }) {
  useT();
  const box = useRef<HTMLDivElement>(null);
  const rad = (angle * Math.PI) / 180;
  // Toward the light, in the dial's own space (y down).
  const dx = -Math.cos(rad), dy = Math.sin(rad);
  const at = (e: ReactPointerEvent | PointerEvent) => {
    const r = box.current?.getBoundingClientRect();
    if (!r) return angle;
    const x = e.clientX - (r.left + r.width / 2), y = e.clientY - (r.top + r.height / 2);
    // The dot toward (x, y): the light travels the other way.
    return Math.round(snapLightAngle((Math.atan2(y, -x) * 180) / Math.PI, e));
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
    <div ref={box} className={styles.fxDial} role="slider" aria-label={tx("glass", "Light")} aria-valuemin={-180} aria-valuemax={180} aria-valuenow={shownLightAngle(angle)} tabIndex={0} onPointerDown={down}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 15 : 1;
        if (e.key === "ArrowLeft" || e.key === "ArrowDown") onChange(shownAngle(angle - step), { final: true, source: "step" });
        else if (e.key === "ArrowRight" || e.key === "ArrowUp") onChange(shownAngle(angle + step), { final: true, source: "step" });
      }}>
      <span className={styles.fxDialRing} />
      <span className={styles.fxDialDot} style={{ left: `calc(50% + ${dx} * var(--ds-space-4))`, top: `calc(50% + ${dy} * var(--ds-space-4))` }} />
    </div>
  );
}

/** Figma's shader fill presets ("By Figma", live popovers/fill-picker-custom.txt), in the browser's order. */
export const SHADER_FILL_PRESETS = SHADER_FILLS.map((p) => p.name);

/** Figma's shader effect presets ("By Figma", live popovers/effects-add-shader-effects.txt), in the browser's order. */
export const SHADER_PRESETS = SHADER_EFFECTS.map((p) => p.name);

/**
 * The "Shader effects (Beta)" browser (live: the Effects "+" while its onboarding card is up): search, the card,
 * "Created by you" (Create new, AI) and Figma's presets; a preset's tile applies it (round 11: the engine draws them,
 * src/shared/shaders/presets.json). "Try an example" applies the first preset (unverified which live applies);
 * "Create with agents" / "Create new" stay disabled (AI).
 */
export function ShaderEffects({
  anchor,
  onboarding,
  onGotIt,
  onPick,
  onClose,
  title = "Shader effects",
  list = SHADER_EFFECTS,
  placement,
}: {
  anchor: HTMLElement;
  onboarding: boolean;
  onGotIt?: () => void;
  /** A tile picked (`example`: the card's "Try an example") */
  onPick?: (preset: ShaderPreset, example?: boolean) => void;
  onClose: () => void;
  /** "Shader fills" for the fill picker's Shader tab (live popovers/fill-picker-custom.txt) */
  title?: string;
  list?: readonly ShaderPreset[];
  placement?: PopoverPlacement;
}) {
  useT();
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const presets = list.filter((p) => !q || p.name.toLowerCase().includes(q));
  const header = (
    <div className={styles.shaderTitle}>
      <span className={styles.shaderName}>{t(title)}</span>
      <span className={styles.shaderBeta}>{t("Beta")}</span>
    </div>
  );
  return (
    <Popover anchor={anchor} placement={placement} header={header} headerActions={<IconButton icon="24.shader.small" label={t("Create with agents")} disabled />} width={240} offsetX={-1} onClose={onClose} label={t(title)}>
      <div className={styles.shaderBody} data-shader-effects="">
        <div className={styles.shaderSearch}>
          <SearchField label={t("Search")} value={query} onChange={setQuery} />
        </div>
        {onboarding && !q && (
          <div className={styles.shaderCard} data-shader-onboarding="">
            <div className={styles.shaderArt} aria-hidden="true" />
            <p className={styles.shaderText}>{t("Add animated shaders that respond to mouse movement, right on canvas, or create your own with the Figma agent.")}</p>
            <div className={styles.shaderActions}>
              <Button variant="ghost" onClick={onGotIt}>{t("Got it")}</Button>
              {/* Live: enabled (#0c8ce9); applies the first preset (unverified which live applies) */}
              <Button variant="primary" onClick={() => (onPick && list[0] ? onPick(list[0], true) : onGotIt?.())}>{t("Try an example")}</Button>
            </div>
          </div>
        )}
        {!q && (
          <>
            <div className={styles.shaderSection}>{t("Created by you")}</div>
            <div className={styles.shaderGrid}>
              <button type="button" className={styles.shaderTile} disabled>
                <span className={styles.shaderThumb}><Icon name="24.plus.small" /></span>
                <span className={styles.shaderTileName}>{t("Create new")} <strong className={styles.shaderAi}>{t("AI")}</strong></span>
              </button>
            </div>
          </>
        )}
        <div className={styles.shaderSection}>{t("By Figma")}</div>
        <div className={styles.shaderGrid}>
          {presets.map((p) => (
            <button key={p.key} type="button" className={styles.shaderTile} disabled={!onPick} data-shader-preset={p.name} onClick={() => onPick?.(p)}>
              <span className={styles.shaderThumb} />
              <span className={styles.shaderTileName}>{p.name}</span>
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
  if (kind === "GRID") return t("Grid {size}px", { size: Math.round((g.sectionSize ?? 10) * 100) / 100 });
  const n = g.numSections ?? 5;
  return kind === "ROWS" ? t("Rows {n}", { n }) : t("Columns {n}", { n });
}

export const GUIDE_ICON: Record<GuideKind, IconName> = { GRID: "24.grid", COLUMNS: "24.grid-column", ROWS: "24.grid-row" };

export function LayoutGuideSection({ nodes }: { nodes: PanelNode[] }) {
  useT();
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
    <PanelSection title={t("Layout guide")} empty={empty} actions={<><StylesButton nodes={nodes} slot="grid" />{!hasStyle && <IconButton icon="24.plus.small" label={t("Add layout guide")} tone="secondary" disabled={!kept} onClick={() => write(isMixedList ? [defaultGuide()] : [...grids, defaultGuide()], "Add layout guide")} />}</>}>
      {hasStyle && <AppliedStyle nodes={nodes} slot="grid" />}
      {!hasStyle && grids
        .map((g, i) => ({ g, i }))
        .reverse()
        .map(({ g, i }) => (
          <div key={i} className={cx(styles.paintRow, g.visible === false && styles.rowHidden)} data-guide-row={guideKind(g)}>
            <div className={styles.effectField}>
              <IconButton icon={GUIDE_ICON[guideKind(g)]} label={t("Layout guide settings")} aria-expanded={open?.index === i} onClick={(ev) => setOpen(open?.index === i ? null : { index: i, anchor: ev.currentTarget })} />
              {/* Live (design/frame-with-layout-guide.txt): the guide's name a 124 wide button at 48 (its text 9 in) under a
                  hidden "Layout guide type"; a click opens its settings (unverified beyond the capture) */}
              <span className={styles.guideName}>
                <span className={styles.guideNameLabel}>{t("Layout guide type")}</span>
                <button type="button" className={styles.guideNameButton} onClick={(ev) => setOpen(open?.index === i ? null : { index: i, anchor: ev.currentTarget.parentElement?.previousElementSibling as HTMLElement ?? ev.currentTarget })}>
                  {guideLabel(g)}
                </button>
              </span>
            </div>
            <IconButton icon={g.visible === false ? "24.hidden.small" : "24.eye.small"} label={t("Toggle visibility")} tone="secondary" onClick={() => write(grids.map((x, j) => (j === i ? { ...x, visible: x.visible === false } : x)), "Layout guide")} />
            <IconButton icon="24.minus.small" label={t("Remove layout guide")} tone="secondary" onClick={() => write(grids.filter((_, j) => j !== i), "Remove layout guide")} />
          </div>
        ))}
      {open && grids[open.index] && (
        <GuideSettings grid={grids[open.index]} anchor={open.anchor} onClose={() => setOpen(null)} onCancel={() => ed.cancelEdit()} onChange={(next, info) => write(grids.map((x, j) => (j === open.index ? next : x)), "Layout guide", info)} />
      )}
    </PanelSection>
  );
}

/**
 * "Apply variable" on a layout guide's number (schema LayoutGrid.sectionSizeVar…): a number variable, its value written
 * with the binding (the guide keeps it when the mode changes — variables.ts re-resolves it).
 */
function GuideVariableButton({ grid, field, onChange }: { grid: LayoutGrid; field: "sectionSize"; onChange: (next: LayoutGrid) => void }) {
  useT();
  const ed = useEditor();
  const [open, setOpen] = useState<HTMLElement | null>(null);
  const key = `${field}Var` as const;
  const bound = guideVariable(grid, key);
  return (
    <>
      <button type="button" className={styles.guideVariable} aria-label={t("Apply variable")} aria-expanded={!!open} {...tooltipProps(t("Apply variable"))} onClick={(e) => setOpen(open ? null : e.currentTarget)}>
        <Icon name="24.variable.small" />
      </button>
      {open && (
        <VariablePicker
          anchor={open}
          types={["FLOAT"]}
          current={bound}
          onPick={(v) => {
            const value = resolveVariable(v.id, ed.variables.get().lookup);
            onChange({ ...grid, ...(typeof value === "number" ? { [field]: value } : {}), [key]: { dataType: "ALIAS", resolvedDataType: "FLOAT", value: { alias: { guid: guidVal(v.id) } } } } as LayoutGrid);
            setOpen(null);
          }}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  );
}

/** The variable a layout guide's number is bound to, or null. */
export function guideVariable(grid: LayoutGrid, key: "sectionSizeVar" | "numSectionsVar" | "offsetVar" | "gutterSizeVar"): Guid | null {
  const d = (grid as Record<string, unknown>)[key] as { value?: { alias?: { guid?: { sessionID: number; localID: number } } } } | undefined;
  const g = d?.value?.alias?.guid;
  return g ? guidStr(g) : null;
}

export function GuideSettings({ grid, anchor, onChange, onCancel, onClose }: { grid: LayoutGrid; anchor: HTMLElement; onChange: (next: LayoutGrid, info: ChangeInfo) => void; onCancel: () => void; onClose: () => void }) {
  useT();
  const kind = guideKind(grid);
  const color = grid.color ?? GUIDE_RED;
  const pick: ChangeInfo = { final: true, source: "pick" };
  const typeOptions =
    kind === "ROWS"
      ? [
          { value: "STRETCH", label: t("Stretch") },
          { value: "MIN", label: t("Top") },
          { value: "CENTER", label: t("Center") },
          { value: "MAX", label: t("Bottom") },
        ]
      : [
          { value: "STRETCH", label: t("Stretch") },
          { value: "MIN", label: t("Left") },
          { value: "CENTER", label: t("Center") },
          { value: "MAX", label: t("Right") },
        ];
  const stretch = (grid.type ?? "STRETCH") === "STRETCH";
  return (
    // Figma's live popover: the type dropdown in its header, then Count, Color, Type, Width, Margin / Offset, Gutter
    // (Grid: Size, Color) — labels 64, fields 136.
    <Popover
      anchor={anchor}
      width={240}
      onClose={onClose}
      label={t("Layout guide")}
      header={
        <Select
          label={t("Layout guide type")}
          variant="ghost"
          below
          width="hug"
          className={styles.guideType}
          value={kind}
          options={[
            { value: "GRID", label: t("Grid") },
            { value: "COLUMNS", label: t("Columns") },
            { value: "ROWS", label: t("Rows") },
          ]}
          onChange={(k) => onChange({ ...defaultGuide(k as GuideKind), color: grid.color ?? GUIDE_RED, visible: grid.visible ?? true }, pick)}
        />
      }
    >
      <div className={`${styles.settings} ${styles.settingsGuide} ${styles.guideBody}`} data-guide-settings="">
        {kind === "GRID" ? (
          <>
            <span className={styles.settingsLabel}>{t("Size")}</span>
            {/* Live (design/frame-with-layout-guide.txt): the number 98 wide at 15, "Apply variable" 20 × 22 at the field's end */}
            <span className={styles.guideSize}>
              <NumericInput scrubHandle="previous" label={t("Width")} min={1} value={grid.sectionSize ?? 10} onChange={(v, info) => onChange({ ...grid, sectionSize: v } as LayoutGrid, info)} onCancel={onCancel} />
              <GuideVariableButton grid={grid} field="sectionSize" onChange={(next) => onChange(next, pick)} />
            </span>
          </>
        ) : (
          <>
            <span className={styles.settingsLabel}>{t("Count")}</span>
            <NumericInput scrubHandle="previous" label={t("Count")} min={1} precision={0} value={grid.numSections ?? 5} onChange={(v, info) => onChange({ ...grid, numSections: Math.round(v) }, info)} onCancel={onCancel} />
          </>
        )}
        <span className={styles.settingsLabel}>{t("Color")}</span>
        <ColorInput
          label={t("Layout guide color")}
          swatchLabel={t("Solid color hex: {hex}", { hex: colorToHex(color).replace("#", "").toUpperCase() })}
          color={colorToHex(color)}
          opacity={toPercent(color.a ?? 0.1)}
          onColor={(hex, info, o) => onChange({ ...grid, color: hexToColor(hex, o !== undefined ? o / 100 : (color.a ?? 0.1)) }, info)}
          onOpacity={(o, info) => onChange({ ...grid, color: { ...color, a: o / 100 } }, info)}
        />
        {kind !== "GRID" && (
          <>
            <span className={styles.settingsLabel}>{t("Type")}</span>
            <Select label={t("Type")} value={grid.type ?? "STRETCH"} options={typeOptions} onChange={(v) => onChange({ ...grid, type: v as LayoutGrid["type"] }, pick)} />
            <span className={styles.settingsLabel}>{kind === "ROWS" ? t("Height") : t("Width")}</span>
            <NumericInput scrubHandle="previous" label={kind === "ROWS" ? t("Height") : t("Width")} min={1} value={stretch ? null : (grid.sectionSize ?? 10)} valueLabel={stretch ? t("Auto") : undefined} disabled={stretch} onChange={(v, info) => onChange({ ...grid, sectionSize: v }, info)} onCancel={onCancel} />
            <span className={styles.settingsLabel}>{stretch ? t("Margin") : t("Offset")}</span>
            <NumericInput className={styles.guideInset} scrubHandle="previous" label={t("Offset")} min={0} value={grid.offset ?? 0} onChange={(v, info) => onChange({ ...grid, offset: v }, info)} onCancel={onCancel} />
            <span className={styles.settingsLabel}>{t("Gutter")}</span>
            <NumericInput className={styles.guideInset} scrubHandle="previous" label={t("Gutter")} min={0} value={grid.gutterSize ?? 20} onChange={(v, info) => onChange({ ...grid, gutterSize: v }, info)} onCancel={onCancel} />
          </>
        )}
      </div>
    </Popover>
  );
}
