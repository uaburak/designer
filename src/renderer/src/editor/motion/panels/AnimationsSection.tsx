/**
 * The right panel's Animations section in Motion mode (docs/motion.md §6.5; round 8h): **+** opens the preset types
 * (Figma's catalogue, §4.6 — Path only for layers with strokes, Text and Text stagger only for text layers) and adds
 * the chosen one at the playhead; **Animations** opens the composite styles and applies one. One row per preset clip
 * of the selected layer (its type's glyph and name, the style that made it, an eye, remove); a row clicked opens its
 * settings — Type, the type's props (Figma's: "Available settings vary depending on the animation type"), Delay (the
 * clip's start), Duration and Easing (the Easing menu). Each change runs the preset's code again in the same step
 * (presets.ts). The clip selected here is the timeline's selected clip too (`ui.motion.selectedClip`).
 *
 * Round 8i: Delay and Duration bound to TIMING variables ("Apply variable" beside each; the bound one's pill shows the
 * variable, Detach puts its value back as the clip's own), Easing to an EASING one (the Easing menu's binding). The
 * **Animations** menu lists the file's custom styles after Figma's (applied the same way), "Create animation style"
 * from the selected layer's clips, and per custom style "Update from selection" and "Delete style" (presets.ts).
 *
 * Round 8j: a style's row lit in the Animations menu plays it on the canvas (stylePreview.ts), never written.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Checkbox, Icon, IconButton, MenuButton, NumericInput, PanelSection, PropertyGrid, PropertyRow, Select, cx, tooltipProps, type IconName, type MenuEntry } from "@/ds";
import { t, useT } from "@/i18n";
import { ANIMATION_PRESETS, ANIMATION_STYLES, EASING_LABELS, type GuidString, type MotionEasing, type PresetKey, type PresetPropDef, type PresetPropValue, type PresetVariables, type TimelineClip, type TimelineModel } from "@shared/motion/types";
import { useEditor } from "../../controller";
import { useLocalAssets, useTopics, useUI } from "../../hooks";
import { BoundPill } from "../../panels/design/Variables";
import { PANEL_MENU_GAP, type PanelNode } from "../../panels/design/shared";
import { VariablePicker } from "../../panels/variables/VariablePicker";
import vstyles from "../../panels/variables/Variables.module.css";
import { EasingMenu } from "../easing/EasingEditor";
import { motionRead, setMotionUi } from "../motionState";
import { addPreset, applyStyle, clipProps, createCustomStyle, customStyles, deleteCustomStyle, detachStyle, editPreset, presetAllowed, presetDef, removePresets, updateCustomStyle, type CustomStyle, type PresetTarget } from "../presets";
import { previewStyle, stopStylePreview } from "../stylePreview";
import { hasStroke } from "./PathTrimSection";
import styles from "./MotionPanels.module.css";

/** Each preset type's glyph (the Animations section's rows, the timeline's clips). */
export const PRESET_ICON: Record<PresetKey, IconName> = {
  new: "24.motion",
  opacity: "24.animation-fade",
  position: "24.animation-move",
  scale: "24.animation-scale",
  rotation: "24.animation-rotate",
  size: "24.animation-scale",
  cornerRadius: "24.animation-scale",
  path: "24.animation-path",
  text: "24.animation-text",
  textStagger: "24.animation-text",
};

/** The timeline model, read again when the document, the selection or Motion changed. */
export function useMotionModel(): TimelineModel | null {
  const ed = useEditor();
  const version = useTopics(ed.store, ["selection", "structure", "undo"]);
  const [motionVersion, setMotionVersion] = useState(0);
  useEffect(() => ed.engine.on("MOTION_CHANGED", () => setMotionVersion((v) => v + 1)), [ed]);
  useEffect(() => ed.engine.on("DOCUMENT_CHANGED", () => setMotionVersion((v) => v + 1)), [ed]);
  return useMemo(() => {
    void version;
    void motionVersion;
    return motionRead(() => ed.engine.motionTimeline(), null);
  }, [ed, version, motionVersion]);
}

const targetOf = (n: PanelNode): PresetTarget => ({ type: n.type ?? "FRAME", strokes: hasStroke(n) });

/**
 * The custom styles' part of the Animations menu (round 8i): each style applied by its id, then "Create animation
 * style" from the selected layer's clips, and each style's "Update from selection" / "Delete style" in a submenu.
 */
function customStylesMenu(custom: readonly CustomStyle[], fromLayer: boolean): MenuEntry[] {
  const out: MenuEntry[] = ["-"];
  if (custom.length) out.push({ header: t("Custom styles") }, ...custom.map((s) => ({ id: s.id, label: s.name, disabled: !s.templates.length })));
  out.push({ id: "create|", label: t("Create animation style"), disabled: !fromLayer });
  if (custom.length)
    out.push({
      id: "edit|",
      label: t("Edit animation styles"),
      items: custom.map((s) => ({
        id: `style|${s.id}`,
        label: s.name,
        items: [
          { id: `update|${s.id}`, label: t("Update from selection"), disabled: !fromLayer },
          { id: `delete|${s.id}`, label: t("Delete style") },
        ],
      })),
    });
  return out;
}

/** "Animation style", "Animation style 2"… */
function nextStyleName(custom: readonly CustomStyle[]): string {
  const base = t("Animation style");
  const taken = new Set(custom.map((s) => s.name));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`)) return `${base} ${n}`;
}

/** A prop shown for the clip's current settings (its `type`, its sub-animation switch). */
const shown = (d: PresetPropDef, props: Record<string, PresetPropValue>) =>
  (!d.shownFor || d.shownFor.includes(String(props.type))) && (!d.shownWith || props[d.shownWith] === true);

export function AnimationsSection({ nodes }: { nodes: PanelNode[] }) {
  useT();
  const ed = useEditor();
  const model = useMotionModel();
  const selected = useUI((s) => s.motion?.selectedClip ?? null);
  const refs = nodes.map((n) => n.guid);
  const targets = nodes.map(targetOf);
  // Rows: the clips of the one selected layer (several layers: + and Animations still add to each).
  const clips = useMemo(() => (refs.length === 1 ? model?.layers.find((l) => l.node === refs[0])?.clips ?? [] : []), [model, refs]);
  // The file's custom styles (read again with the model: a create, update or delete is a commit).
  const custom = useMemo(() => {
    void model;
    return customStyles(ed);
  }, [ed, model]);
  // A preview never outlives the section.
  useEffect(() => () => stopStylePreview(ed), [ed]);
  if (!nodes.length || !model) return null;
  const types: MenuEntry[] = ANIMATION_PRESETS.map((p) => ({ id: p.key, label: t(p.name), icon: PRESET_ICON[p.key], disabled: !presetAllowed(p, targets) }));
  const text = targets.every((n) => n.type === "TEXT");
  const stylesMenu: MenuEntry[] = [
    ...ANIMATION_STYLES.filter((s) => !s.textOnly || text).map((s) => ({ id: s.key, label: t(s.name) })),
    ...customStylesMenu(custom, clips.length > 0),
  ];
  const select = (id: string | null) => setMotionUi(ed, { selectedClip: id });
  return (
    <PanelSection
      title={t("Animations")}
      empty={!clips.length}
      data-animations-section
      className={styles.animations}
      actions={
        <>
          <MenuButton label={t("Animation styles")} tooltip={t("Animations")} entries={stylesMenu} className={styles.iconMenu} align="end" gap={PANEL_MENU_GAP} onHighlight={(id) => {
            // A style's row lit: it plays on the canvas (round 8j); the create / edit rows aren't styles.
            previewStyle(ed, id && !id.includes("|") ? id : null, refs, targets[0]);
          }} onSelect={(id) => {
            stopStylePreview(ed);
            const [verb, style] = id.split("|");
            if (verb === "create") createCustomStyle(ed, refs[0], nextStyleName(custom));
            else if (verb === "update") updateCustomStyle(ed, style, refs[0], clips);
            else if (verb === "delete") deleteCustomStyle(ed, style);
            else applyStyle(ed, id, refs, targets[0]);
          }}>
            <Icon name="24.styles" />
          </MenuButton>
          <MenuButton label={t("Add animation")} tooltip entries={types} className={styles.iconMenu} align="end" gap={PANEL_MENU_GAP} onSelect={(id) => {
            const made = addPreset(ed, id as PresetKey, refs, targets[0]);
            if (made.length === 1) select(made[0]);
          }}>
            <Icon name="24.plus.small" />
          </MenuButton>
        </>
      }
    >
      {clips
        .slice()
        .reverse()
        .map((clip) => (
          <ClipRow key={clip.id} clip={clip} open={selected === clip.id} target={targets[0]} custom={custom} onToggle={() => select(selected === clip.id ? null : clip.id)} />
        ))}
    </PanelSection>
  );
}

function ClipRow({ clip, open, target, onToggle, custom }: { clip: TimelineClip; open: boolean; target: PresetTarget; onToggle(): void; custom: readonly CustomStyle[] }) {
  useT();
  const ed = useEditor();
  // Figma's style by its key, a custom one (round 8i) by its id.
  const firstParty = clip.style ? ANIMATION_STYLES.find((s) => s.key === clip.style!.key) : undefined;
  const style = firstParty ? { name: t(firstParty.name) } : clip.style ? (custom.find((s) => s.id === clip.style!.key) ?? null) : null;
  return (
    <>
      <div className={cx(styles.clipRow, clip.disabled && styles.clipOff)} data-clip-row={clip.id} data-open={open || undefined}>
        <button type="button" className={styles.clipName} aria-expanded={open} aria-label={t("Animation settings")} onClick={onToggle}>
          <Icon name={PRESET_ICON[clip.preset] ?? "24.motion"} />
          <span className={styles.label}>{t(presetDef(clip.preset)?.name ?? clip.name)}</span>
          {style && <span className={styles.value}>{style.name}</span>}
        </button>
        {clip.style && <IconButton icon="24.detach.small" label={t("Detach animation style")} tone="secondary" onClick={() => detachStyle(ed, clip.style!.id)} />}
        <IconButton icon={clip.disabled ? "24.hidden.small" : "24.eye.small"} label={t("Toggle visibility")} tone="secondary" onClick={() => editPreset(ed, clip, { disabled: !clip.disabled })} />
        <IconButton icon="24.minus.small" label={t("Remove animation")} tone="secondary" onClick={() => removePresets(ed, [clip.id])} />
      </div>
      {open && <ClipSettings clip={clip} target={target} />}
    </>
  );
}

const UNIT: Record<string, string> = { "%": "%", "°": "°", px: "" };

/** A variable's name (or "Missing variable"). */
function VariableName({ id }: { id: GuidString }) {
  useT();
  const v = useLocalAssets().lookup.variable(id);
  return <>{v?.name ?? t("Missing variable")}</>;
}

/**
 * Delay or Duration with its TIMING variable (round 8i): the field and "Apply variable" on hover, or the bound
 * variable's pill — Detach keeps the value the clip plays now as its own.
 */
function TimingField({ clip, prop, label, valueMs, node, children }: { clip: TimelineClip; prop: keyof PresetVariables & ("delay" | "duration"); label: string; valueMs: number; node: PresetTarget; children: ReactNode }) {
  useT();
  const ed = useEditor();
  const [open, setOpen] = useState<HTMLElement | null>(null);
  const bound = clip.variables?.[prop] ?? null;
  const picker = open && (
    <VariablePicker anchor={open} types={["TIMING"]} current={bound} onPick={(v) => editPreset(ed, clip, { variables: { [prop]: v.id } }, node)} onClose={() => setOpen(null)} />
  );
  if (bound)
    return (
      <div className={vstyles.bindWrap} data-timing-field={prop}>
        <BoundPill id={bound} label={label} value={`${valueMs}ms`} onOpen={setOpen} onDetach={() => editPreset(ed, clip, { variables: { [prop]: null }, ...(prop === "delay" ? { startUs: valueMs * 1000 } : { durationUs: valueMs * 1000 }) }, node)} />
        {picker}
      </div>
    );
  return (
    <div className={vstyles.bindWrap} data-timing-field={prop}>
      {children}
      <button type="button" className={vstyles.applyButton} aria-label={t("Apply variable")} aria-expanded={!!open} tabIndex={-1} {...tooltipProps(t("Apply variable"))} onClick={(e) => setOpen(e.currentTarget)}>
        <Icon name="24.variable.small" />
      </button>
      {picker}
    </div>
  );
}

/** A clip's settings: Type, its props, Delay, Duration, Easing. */
export function ClipSettings({ clip, target }: { clip: TimelineClip; target: PresetTarget }) {
  useT();
  const ed = useEditor();
  const def = presetDef(clip.preset);
  const props = clipProps(clip);
  const [easingAt, setEasingAt] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const easing: MotionEasing = "type" in clip.easing ? clip.easing : { type: "EASE_OUT" };
  const set = (patch: Record<string, PresetPropValue>) => editPreset(ed, clip, { props: patch }, target);
  const typeOptions = ANIMATION_PRESETS.filter((p) => p.key === clip.preset || presetAllowed(p, [target])).map((p) => ({ value: p.key, label: t(p.name) }));
  return (
    <div className={styles.clipSettings} data-clip-settings={clip.id}>
      <PropertyGrid labels>
        <PropertyRow labels={[t("Animation")]}>
          <Select label={t("Animation")} value={clip.preset} options={typeOptions} onChange={(v) => editPreset(ed, clip, { preset: v as PresetKey }, target)} />
        </PropertyRow>
        {(def?.props ?? [])
          .filter((d) => d.kind !== "easing" && d.key !== "delay" && d.key !== "duration" && shown(d, props))
          .map((d) => (
            <PropertyRow key={d.key} labels={[t(d.label)]}>
              {d.kind === "enum" ? (
                <Select label={t(d.label)} value={String(props[d.key])} options={(d.options ?? []).map(([value, label]) => ({ value, label: t(label) }))} onChange={(v) => set({ [d.key]: v })} />
              ) : d.kind === "bool" ? (
                <Checkbox label={t(d.label)} hideLabel checked={props[d.key] === true} onChange={(c) => set({ [d.key]: c })} />
              ) : (
                <NumericInput label={t(d.label)} unit={UNIT[d.unit ?? ""] || undefined} min={d.min} max={d.max} value={Number(props[d.key])} onChange={(v, info) => {
                  if (info.final !== false) set({ [d.key]: v });
                }} />
              )}
            </PropertyRow>
          ))}
        <PropertyRow labels={[t("Delay"), t("Duration")]}>
          <TimingField clip={clip} prop="delay" label={t("Delay")} valueMs={Math.round(clip.startUs / 1000)} node={target}>
            <NumericInput label={t("Delay")} unit="ms" precision={0} min={0} value={Math.round(clip.startUs / 1000)} onChange={(v, info) => {
              if (info.final !== false) editPreset(ed, clip, { startUs: v * 1000 }, target);
            }} />
          </TimingField>
          <TimingField clip={clip} prop="duration" label={t("Duration")} valueMs={Math.round(clip.durationUs / 1000)} node={target}>
            <NumericInput label={t("Duration")} unit="ms" precision={0} min={10} value={Math.round(clip.durationUs / 1000)} onChange={(v, info) => {
              if (info.final !== false) editPreset(ed, clip, { durationUs: Math.max(10, v) * 1000 }, target);
            }} />
          </TimingField>
        </PropertyRow>
        <PropertyRow labels={[t("Easing")]}>
          <button type="button" className={styles.easingField} data-clip-easing data-variable={clip.variables?.easing ? "" : undefined} onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setEasingAt({ x: r.left, y: r.top, width: r.width, height: r.height });
          }}>
            {clip.variables?.easing ? <VariableName id={clip.variables.easing} /> : t(EASING_LABELS[easing.type])}
          </button>
        </PropertyRow>
      </PropertyGrid>
      {easingAt && (
        <EasingMenu
          value={clip.variables?.easing ? { variable: clip.variables.easing } : easing}
          resolved={easing}
          allowVariable
          anchor={easingAt}
          onChange={(next, commit) => {
            if (!commit) return;
            if ("variable" in next) editPreset(ed, clip, { variables: { easing: next.variable } }, target);
            else editPreset(ed, clip, { easing: next, ...(clip.variables?.easing ? { variables: { easing: null } } : {}) }, target);
          }}
          onClose={() => setEasingAt(null)}
        />
      )}
    </div>
  );
}
