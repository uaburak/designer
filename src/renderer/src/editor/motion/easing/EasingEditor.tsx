/**
 * The Easing menu and editor of Motion mode (docs/motion.md §6.3), increment 1: a popover anchored to the clicked
 * segment or field with Figma's easing list — Hold first, then the bezier curves and the springs, no dividers; when
 * the current easing is a spring only the springs are listed — a Bezier | Spring switch (CUSTOM_CUBIC / CUSTOM_SPRING),
 * each row with a small curve preview; Custom bezier takes "x1, y1, x2, y2" in a field, Custom spring its Bounce (0–1).
 *
 * Not in this increment: the 200 × 200 curve editor and the spring's response-curve handle, the hover preview dot, the
 * EASING variable binding (`allowVariable` is accepted and ignored), the prototype context's physical fields.
 */
import { useState } from "react";
import { Popover, SegmentedControl, TextInput } from "@/ds";
import { t, useT } from "@/i18n";
import { BEZIER_PRESETS, DEFAULT_KEYFRAME_EASING, EASING_LABELS, MOTION_EASING_TYPES, type EasingEditorProps, type EasingRef, type MotionEasing, type MotionEasingType } from "@shared/motion/types";
import styles from "./EasingEditor.module.css";

const SPRINGS: readonly MotionEasingType[] = ["GENTLE", "QUICK", "BOUNCY", "SLOW", "CUSTOM_SPRING"];
const isSpring = (type: MotionEasingType) => SPRINGS.includes(type);
/** The spring presets' bounce as shown (clamp(1 − ζ, 0, 1) of SPRING_PRESETS). */
const PRESET_BOUNCE: Partial<Record<MotionEasingType, number>> = { GENTLE: 0.25, QUICK: 0.42, BOUNCY: 0.69, SLOW: 0 };

/** The list for the current easing: springs only while it is a spring, else Hold and the curves (Figma's menu). */
export function easingMenuTypes(current: MotionEasingType): MotionEasingType[] {
  return isSpring(current) ? [...SPRINGS] : MOTION_EASING_TYPES.filter((x) => !isSpring(x));
}

/** The easing chosen by name: a preset's values load; a custom type keeps the current custom values when they match. */
export function easingOfType(type: MotionEasingType, current: MotionEasing): MotionEasing {
  if (type === "CUSTOM_CUBIC_BEZIER") {
    const b = current.type === "CUSTOM_CUBIC_BEZIER" && current.easingFunctionCubicBezier ? current.easingFunctionCubicBezier : BEZIER_PRESETS[current.type] ? toBezier(BEZIER_PRESETS[current.type]!) : DEFAULT_KEYFRAME_EASING.easingFunctionCubicBezier!;
    return { type, easingFunctionCubicBezier: b };
  }
  if (type === "CUSTOM_SPRING") {
    const bounce = current.type === "CUSTOM_SPRING" && current.easingFunctionSpring ? current.easingFunctionSpring.bounce : PRESET_BOUNCE[current.type] ?? 0.3;
    return { type, easingFunctionSpring: { bounce } };
  }
  return { type };
}

const toBezier = (b: [number, number, number, number]) => ({ x1: b[0], y1: b[1], x2: b[2], y2: b[3] });

/** The row's curve preview: the bezier in a 24 × 16 box (y may leave 0–1 for the back curves), a damped sine for springs, a step for Hold. */
export function previewPath(type: MotionEasingType, easing?: MotionEasing): string {
  const w = 24;
  const h = 16;
  const y = (v: number) => (h - 2 - v * (h - 4)).toFixed(1);
  if (type === "HOLD") return `M1 ${y(0)} H${w - 1} V${y(1)}`;
  if (isSpring(type)) {
    const bounce = type === "CUSTOM_SPRING" ? easing?.easingFunctionSpring?.bounce ?? 0.3 : PRESET_BOUNCE[type] ?? 0.3;
    const zeta = Math.max(0.05, 1 - bounce);
    const pts: string[] = [];
    for (let i = 0; i <= 24; i++) {
      const u = i / 24;
      const v = 1 - Math.exp(-6 * zeta * u) * Math.cos(Math.PI * 2.5 * u * (1 - zeta * 0.5));
      pts.push(`${(1 + u * (w - 2)).toFixed(1)} ${y(Math.min(1.5, Math.max(-0.5, v)))}`);
    }
    return `M${pts.join(" L")}`;
  }
  const b = type === "CUSTOM_CUBIC_BEZIER" ? easing?.easingFunctionCubicBezier ?? DEFAULT_KEYFRAME_EASING.easingFunctionCubicBezier! : toBezier(BEZIER_PRESETS[type] ?? [0, 0, 1, 1]);
  const x = (v: number) => (1 + v * (w - 2)).toFixed(1);
  return `M${x(0)} ${y(0)} C${x(b.x1)} ${y(b.y1)} ${x(b.x2)} ${y(b.y2)} ${x(1)} ${y(1)}`;
}

const parseBezier = (text: string): MotionEasing["easingFunctionCubicBezier"] | null => {
  const parts = text.split(/[\s,]+/).filter(Boolean).map(Number);
  if (parts.length !== 4 || parts.some((v) => !Number.isFinite(v))) return null;
  const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
  const clampY = (v: number) => Math.min(1.5, Math.max(-0.5, v));
  return { x1: clamp01(parts[0]), y1: clampY(parts[1]), x2: clamp01(parts[2]), y2: clampY(parts[3]) };
};

const asMotion = (v: EasingRef): MotionEasing => ("variable" in v ? DEFAULT_KEYFRAME_EASING : v);

/** The Easing popover: the list, the Bezier | Spring switch and the custom fields. */
export function EasingEditor({ value, onChange, anchor, onClose }: EasingEditorProps) {
  useT();
  const [current, setCurrent] = useState<MotionEasing>(() => asMotion(value));
  const choose = (e: MotionEasing) => {
    setCurrent(e);
    onChange(e, true);
  };
  const rect = typeof DOMRect !== "undefined" ? new DOMRect(anchor.x, anchor.y, anchor.width, anchor.height) : null;
  const bezierText = current.easingFunctionCubicBezier ? [current.easingFunctionCubicBezier.x1, current.easingFunctionCubicBezier.y1, current.easingFunctionCubicBezier.x2, current.easingFunctionCubicBezier.y2].map((v) => String(Math.round(v * 100) / 100)).join(", ") : "";
  return (
    <Popover anchor={rect} placement="top" title={t("Easing")} onClose={onClose} width={240}>
      <div className={styles.body} data-easing-editor>
        <SegmentedControl label={t("Easing kind")} value={isSpring(current.type) ? "spring" : "bezier"} fullWidth options={[{ value: "bezier", label: t("Bezier") }, { value: "spring", label: t("Spring") }]} onChange={(v) => {
          if (v === "spring" && !isSpring(current.type)) choose(easingOfType("CUSTOM_SPRING", current));
          if (v === "bezier" && isSpring(current.type)) choose(easingOfType("CUSTOM_CUBIC_BEZIER", current));
        }} />
        <ul className={styles.list} role="listbox" aria-label={t("Easing")}>
          {easingMenuTypes(current.type).map((type) => (
            <li key={type} role="option" aria-selected={current.type === type} data-easing={type} className={styles.item} onClick={() => choose(easingOfType(type, current))}>
              <svg className={styles.preview} viewBox="0 0 24 16" aria-hidden><path d={previewPath(type, current)} /></svg>
              <span className={styles.itemLabel}>{t(EASING_LABELS[type])}</span>
            </li>
          ))}
        </ul>
        {current.type === "CUSTOM_CUBIC_BEZIER" && (
          <TextInput label={t("Cubic bezier")} value={bezierText} placeholder="x1, y1, x2, y2" onCommit={(v) => {
            const b = parseBezier(v);
            if (b) choose({ type: "CUSTOM_CUBIC_BEZIER", easingFunctionCubicBezier: b });
          }} />
        )}
        {current.type === "CUSTOM_SPRING" && (
          <TextInput label={t("Bounce")} value={String(current.easingFunctionSpring?.bounce ?? 0.3)} onCommit={(v) => {
            const n = Number(v);
            if (Number.isFinite(n)) choose({ type: "CUSTOM_SPRING", easingFunctionSpring: { bounce: Math.min(1, Math.max(0, n)) } });
          }} />
        )}
      </div>
    </Popover>
  );
}

/** The dropdown alone (a segment's or clip's easing): in this increment the same popover. */
export function EasingMenu(props: EasingEditorProps) {
  return <EasingEditor {...props} />;
}
