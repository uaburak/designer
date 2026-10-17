/**
 * The right panel's Animations section in Motion mode (docs/motion.md §6.5; round 8h): **+** opens the preset types
 * (Figma's catalogue, §4.6 — Path only for layers with strokes, Text and Text stagger only for text layers) and adds
 * the chosen one at the playhead; **Animations** opens the composite styles and applies one. One row per preset clip
 * of the selected layer (its type's glyph and name, the style that made it, an eye, remove); a row clicked opens its
 * settings — Type, the type's props (Figma's: "Available settings vary depending on the animation type"), Delay (the
 * clip's start), Duration and Easing (the Easing menu). Each change runs the preset's code again in the same step
 * (presets.ts). The clip selected here is the timeline's selected clip too (`ui.motion.selectedClip`).
 *
 * Not yet: the hover preview of a style on the canvas, Delay / Duration / Easing bound to TIMING and EASING variables.
 */
import { useEffect, useMemo, useState } from "react";
import { Checkbox, Icon, IconButton, MenuButton, NumericInput, PanelSection, PropertyGrid, PropertyRow, Select, cx, type IconName, type MenuEntry } from "@/ds";
import { t, useT } from "@/i18n";
import { ANIMATION_PRESETS, ANIMATION_STYLES, EASING_LABELS, type MotionEasing, type PresetKey, type PresetPropDef, type PresetPropValue, type TimelineClip, type TimelineModel } from "@shared/motion/types";
import { useEditor } from "../../controller";
import { useTopics, useUI } from "../../hooks";
import { PANEL_MENU_GAP, type PanelNode } from "../../panels/design/shared";
import { EasingMenu } from "../easing/EasingEditor";
import { motionRead, setMotionUi } from "../motionState";
import { addPreset, applyStyle, clipProps, detachStyle, editPreset, presetAllowed, presetDef, removePresets, type PresetTarget } from "../presets";
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
  if (!nodes.length || !model) return null;
  const types: MenuEntry[] = ANIMATION_PRESETS.map((p) => ({ id: p.key, label: t(p.name), icon: PRESET_ICON[p.key], disabled: !presetAllowed(p, targets) }));
  const text = targets.every((n) => n.type === "TEXT");
  const stylesMenu: MenuEntry[] = ANIMATION_STYLES.filter((s) => !s.textOnly || text).map((s) => ({ id: s.key, label: t(s.name) }));
  const select = (id: string | null) => setMotionUi(ed, { selectedClip: id });
  return (
    <PanelSection
      title={t("Animations")}
      empty={!clips.length}
      data-animations-section
      actions={
        <>
          <MenuButton label={t("Animation styles")} tooltip={t("Animations")} entries={stylesMenu} className={styles.iconMenu} align="end" gap={PANEL_MENU_GAP} onSelect={(id) => applyStyle(ed, id, refs, targets[0])}>
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
          <ClipRow key={clip.id} clip={clip} open={selected === clip.id} target={targets[0]} onToggle={() => select(selected === clip.id ? null : clip.id)} />
        ))}
    </PanelSection>
  );
}

function ClipRow({ clip, open, target, onToggle }: { clip: TimelineClip; open: boolean; target: PresetTarget; onToggle(): void }) {
  useT();
  const ed = useEditor();
  const style = clip.style ? ANIMATION_STYLES.find((s) => s.key === clip.style!.key) : undefined;
  return (
    <>
      <div className={cx(styles.clipRow, clip.disabled && styles.clipOff)} data-clip-row={clip.id} data-open={open || undefined}>
        <button type="button" className={styles.clipName} aria-expanded={open} aria-label={t("Animation settings")} onClick={onToggle}>
          <Icon name={PRESET_ICON[clip.preset] ?? "24.motion"} />
          <span className={styles.label}>{t(presetDef(clip.preset)?.name ?? clip.name)}</span>
          {style && <span className={styles.value}>{t(style.name)}</span>}
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
          <NumericInput label={t("Delay")} unit="ms" precision={0} min={0} value={Math.round(clip.startUs / 1000)} onChange={(v, info) => {
            if (info.final !== false) editPreset(ed, clip, { startUs: v * 1000 }, target);
          }} />
          <NumericInput label={t("Duration")} unit="ms" precision={0} min={10} value={Math.round(clip.durationUs / 1000)} onChange={(v, info) => {
            if (info.final !== false) editPreset(ed, clip, { durationUs: Math.max(10, v) * 1000 }, target);
          }} />
        </PropertyRow>
        <PropertyRow labels={[t("Easing")]}>
          <button type="button" className={styles.easingField} data-clip-easing onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setEasingAt({ x: r.left, y: r.top, width: r.width, height: r.height });
          }}>
            {t(EASING_LABELS[easing.type])}
          </button>
        </PropertyRow>
      </PropertyGrid>
      {easingAt && (
        <EasingMenu
          value={easing}
          anchor={easingAt}
          onChange={(next, commit) => {
            if (commit && "type" in next) editPreset(ed, clip, { easing: next }, target);
          }}
          onClose={() => setEasingAt(null)}
        />
      )}
    </div>
  );
}
