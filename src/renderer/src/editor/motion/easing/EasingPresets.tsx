/**
 * The Easing page's presets popover (docs/motion.md §6.14; Figma's, 2026-10-18/motion-easing.txt): a floating panel
 * left of the right panel, level with the preset select — its header the **Presets | Libraries** tabs, **+** (New
 * variable: the current easing saved as an Easing variable and applied) and Close; dragged by its header (the DS
 * Popover's). Presets lists Figma's rows for the current kind — Hold, Linear, Ease in, Ease out, Ease in and out, the
 * back curves, Custom bezier (a spring: Gentle, Quick, Bouncy, Slow, Custom spring) — each with Figma's glyph (a 4 × 4
 * dot grid and the curve; none for the custom ones), the current one lit. **Libraries** lists the file's and its
 * libraries' Easing variables (Wecra's easing styles), the applied one ticked.
 */
import { useState } from "react";
import { IconButton, Popover, Tabs } from "@/ds";
import { t, useT } from "@/i18n";
import { EASING_LABELS, type MotionEasing, type MotionEasingType } from "@shared/motion/types";
import { VariableList } from "../../panels/variables/VariablePicker";
import { easingMenuTypes, easingOfType } from "./EasingEditor";
import { GLYPH_DOTS, presetGlyphPath } from "./easingMaths";
import styles from "./EasingPage.module.css";

/** The popover's width (Figma's: 232). */
export const PRESETS_WIDTH = 232;

export interface EasingPresetsProps {
  anchor: HTMLElement;
  /** The segments' easing (null: Mixed) and the kind the page shows */
  current: MotionEasing | null;
  kind: "bezier" | "spring";
  /** The applied Easing variable, if any */
  bound: string | null;
  /** The layer the variables' values are shown for */
  consumer: string | null;
  onPick(e: MotionEasing): void;
  onHover(e: MotionEasing | null): void;
  onBind(variable: string): void;
  onCreate(): void;
  onClose(): void;
}

/** A preset's glyph; the custom rows have none in the list (Figma's), but the select draws one (`always`). */
export function PresetGlyph({ type, easing, always }: { type: MotionEasingType; easing?: MotionEasing; always?: boolean }) {
  const custom = !always && (type === "CUSTOM_CUBIC_BEZIER" || type === "CUSTOM_SPRING");
  return (
    <svg className={styles.presetGlyph} viewBox="0 0 24 24" aria-hidden>
      {!custom && GLYPH_DOTS.flatMap((y) => GLYPH_DOTS.map((x) => <circle key={`${x},${y}`} className={styles.glyphDot} cx={x} cy={y} r={0.5} />))}
      {!custom && <path className={styles.glyphCurve} d={presetGlyphPath(type, easing)} />}
    </svg>
  );
}

export function EasingPresets({ anchor, current, kind, bound, consumer, onPick, onHover, onBind, onCreate, onClose }: EasingPresetsProps) {
  useT();
  const [tab, setTab] = useState<"presets" | "libraries">("presets");
  const base: MotionEasing = current ?? { type: kind === "spring" ? "GENTLE" : "LINEAR" };
  const types = easingMenuTypes(base.type);
  return (
    <Popover
      anchor={anchor}
      width={PRESETS_WIDTH}
      offsetX={8}
      label={t("Easing presets")}
      onClose={() => {
        onHover(null);
        onClose();
      }}
      header={<Tabs label={t("Easing source")} value={tab} onChange={(v) => setTab(v as "presets" | "libraries")} tabs={[{ value: "presets", label: t("Presets") }, { value: "libraries", label: t("Libraries") }]} />}
      headerActions={<IconButton icon="24.plus.small" label={t("New variable")} data-new-easing-variable onClick={onCreate} />}
    >
      {tab === "presets" ? (
        <ul className={styles.presets} role="listbox" aria-label={t("Presets")} data-easing-presets onMouseLeave={() => onHover(null)}>
          {types.map((type) => (
            <li
              key={type}
              role="option"
              aria-selected={!bound && current?.type === type}
              data-easing={type}
              className={styles.preset}
              onMouseEnter={() => onHover(easingOfType(type, base))}
              onClick={() => {
                onHover(null);
                onPick(easingOfType(type, base));
              }}
            >
              <PresetGlyph type={type} easing={current ?? undefined} />
              <span className={styles.presetLabel}>{t(EASING_LABELS[type])}</span>
            </li>
          ))}
        </ul>
      ) : (
        <div className={styles.libraries} data-easing-libraries>
          <VariableList types={["EASING"]} current={bound} consumer={consumer} label={t("Libraries")} onPick={(v) => onBind(v.id)} />
        </div>
      )}
    </Popover>
  );
}
