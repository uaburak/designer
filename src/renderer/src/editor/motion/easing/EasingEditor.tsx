/**
 * The Easing menu and editor of Motion mode (docs/motion.md §6.3): a popover anchored to the clicked segment, clip or
 * field with Figma's easing list — Hold first, then the bezier curves and the springs, no dividers; when the current
 * easing is a spring only the springs are listed — a Bezier | Spring switch (CUSTOM_CUBIC / CUSTOM_SPRING), each row
 * with a small curve preview; Custom bezier also takes "x1, y1, x2, y2" in a field, Custom spring its Bounce (0–1).
 *
 * Round 8i: the 200 × 200 graph above the list (CurveEditor.tsx) — the current curve, a custom bezier's handles and
 * corner points, a custom spring's bounce handle; hovering a row shows its curve there and runs a dot along a track
 * with it (the hover preview [ours]); with `allowVariable`, the EASING variable binding — "Apply variable" (the picker
 * filtered to Easing), the bound variable's pill with Detach, and "Create variable", which saves the current easing as
 * a new Easing variable and binds it (help: "Custom curves and springs can be saved as variables").
 *
 * The Prototype panel (round 8j) puts the graph (CurveEditor) over its own Curve list and numbers — a custom bezier's
 * handles, a custom spring's bounce as its damping; its physical spring fields and Duration stay there.
 */
import { useState } from "react";
import { Icon, IconButton, Popover, SegmentedControl, TextInput, showToast, tooltipProps } from "@/ds";
import { t, useT } from "@/i18n";
import { easingCss, isSpringEasing } from "@shared/motion/easing";
import { BEZIER_PRESETS, DEFAULT_KEYFRAME_EASING, EASING_LABELS, MOTION_EASING_TYPES, type EasingEditorProps, type EasingRef, type MotionEasing, type MotionEasingType } from "@shared/motion/types";
import { useEditor, type EditorController } from "../../controller";
import { useLocalAssets } from "../../hooks";
import { VariablePicker } from "../../panels/variables/VariablePicker";
import { createCollection, createVariable } from "../../variables";
import { CurveEditor } from "./CurveEditor";
import styles from "./EasingEditor.module.css";

const SPRINGS: readonly MotionEasingType[] = ["GENTLE", "QUICK", "BOUNCY", "SLOW", "CUSTOM_SPRING"];
const isSpring = isSpringEasing;
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

const asMotion = (v: EasingRef, resolved?: MotionEasing): MotionEasing => ("variable" in v ? resolved ?? DEFAULT_KEYFRAME_EASING : v);

/** The Easing popover: the graph, the list, the Bezier | Spring switch, the custom fields and (allowVariable) the binding. */
export function EasingEditor({ value, resolved, onChange, anchor, onClose, allowVariable }: EasingEditorProps) {
  useT();
  const [current, setCurrent] = useState<MotionEasing>(() => asMotion(value, resolved));
  const [bound, setBound] = useState<string | null>("variable" in value ? value.variable : null);
  const [hovered, setHovered] = useState<MotionEasing | null>(null);
  const choose = (e: MotionEasing, commit = true) => {
    setCurrent(e);
    setBound(null);
    onChange(e, commit);
  };
  const rect = typeof DOMRect !== "undefined" ? new DOMRect(anchor.x, anchor.y, anchor.width, anchor.height) : null;
  const bezierText = current.easingFunctionCubicBezier ? [current.easingFunctionCubicBezier.x1, current.easingFunctionCubicBezier.y1, current.easingFunctionCubicBezier.x2, current.easingFunctionCubicBezier.y2].map((v) => String(Math.round(v * 100) / 100)).join(", ") : "";
  const shown = hovered ?? current;
  const custom = !hovered && !bound && (current.type === "CUSTOM_CUBIC_BEZIER" || current.type === "CUSTOM_SPRING");
  return (
    <Popover anchor={rect} placement="top" title={t("Easing")} onClose={onClose} width={240}>
      <div className={styles.body} data-easing-editor>
        <SegmentedControl label={t("Easing kind")} value={isSpring(current.type) ? "spring" : "bezier"} fullWidth options={[{ value: "bezier", label: t("Bezier") }, { value: "spring", label: t("Spring") }]} onChange={(v) => {
          if (v === "spring" && !isSpring(current.type)) choose(easingOfType("CUSTOM_SPRING", current));
          if (v === "bezier" && isSpring(current.type)) choose(easingOfType("CUSTOM_CUBIC_BEZIER", current));
        }} />
        <div className={styles.graphBox}>
          <CurveEditor easing={shown} editable={custom} onChange={(e, commit) => choose(e, commit)} />
          {/* The hover preview: a dot running across with the hovered curve [ours]. */}
          <div className={styles.track} aria-hidden data-easing-preview={hovered ? hovered.type : undefined}>
            {hovered && <span key={hovered.type} className={styles.dot} style={{ animationTimingFunction: easingCss(hovered) }} />}
          </div>
        </div>
        <ul className={styles.list} role="listbox" aria-label={t("Easing")} onMouseLeave={() => setHovered(null)}>
          {easingMenuTypes(current.type).map((type) => (
            <li key={type} role="option" aria-selected={!bound && current.type === type} data-easing={type} className={styles.item} onMouseEnter={() => setHovered(easingOfType(type, current))} onClick={() => {
              setHovered(null);
              choose(easingOfType(type, current));
            }}>
              <svg className={styles.preview} viewBox="0 0 24 16" aria-hidden><path d={previewPath(type, current)} /></svg>
              <span className={styles.itemLabel}>{t(EASING_LABELS[type])}</span>
            </li>
          ))}
        </ul>
        {current.type === "CUSTOM_CUBIC_BEZIER" && !bound && (
          <TextInput label={t("Cubic bezier")} value={bezierText} placeholder="x1, y1, x2, y2" onCommit={(v) => {
            const b = parseBezier(v);
            if (b) choose({ type: "CUSTOM_CUBIC_BEZIER", easingFunctionCubicBezier: b });
          }} />
        )}
        {current.type === "CUSTOM_SPRING" && !bound && (
          <TextInput label={t("Bounce")} value={String(current.easingFunctionSpring?.bounce ?? 0.3)} onCommit={(v) => {
            const n = Number(v);
            if (Number.isFinite(n)) choose({ type: "CUSTOM_SPRING", easingFunctionSpring: { bounce: Math.min(1, Math.max(0, n)) } });
          }} />
        )}
        {allowVariable && (
          <EasingVariable bound={bound} current={current} onBind={(id) => {
            setBound(id);
            onChange({ variable: id }, true);
          }} onDetach={() => choose(current)} />
        )}
      </div>
    </Popover>
  );
}

/**
 * The EASING variable binding: the bound variable's pill (its name, Detach) or "Apply variable" (the picker, Easing
 * variables only) and "Create variable" (a new Easing variable holding the current easing, bound at once — in the
 * file's first collection, or a new one when it has none).
 */
function EasingVariable({ bound, current, onBind, onDetach }: { bound: string | null; current: MotionEasing; onBind(id: string): void; onDetach(): void }) {
  useT();
  const ed = useEditor();
  const a = useLocalAssets();
  const [picker, setPicker] = useState<HTMLElement | null>(null);
  const variable = bound ? a.lookup.variable(bound) : undefined;
  const create = () => {
    const id = createEasingVariable(ed, a.collections[0]?.id ?? null, current);
    if (id) onBind(id);
  };
  return (
    <div className={styles.variableRow} data-easing-variable={bound ?? ""}>
      {bound ? (
        <>
          <span className={styles.variablePill}>
            <Icon name="16.easing" />
            <span className={styles.itemLabel}>{variable?.name ?? t("Missing variable")}</span>
          </span>
          <IconButton icon="24.detach.small" label={t("Detach variable")} tone="secondary" onClick={onDetach} />
        </>
      ) : (
        <>
          <button type="button" className={styles.variableButton} {...tooltipProps(t("Apply variable"))} aria-expanded={!!picker} onClick={(e) => setPicker(e.currentTarget)}>
            <Icon name="24.variable.small" />
            <span>{t("Apply variable")}</span>
          </button>
          <button type="button" className={styles.variableButton} data-create-easing-variable onClick={create}>
            <Icon name="24.plus.small" />
            <span>{t("Create variable")}</span>
          </button>
        </>
      )}
      {picker && <VariablePicker anchor={picker} placement="bottom-start" types={["EASING"]} current={bound} onPick={(v) => onBind(v.id)} onClose={() => setPicker(null)} />}
    </div>
  );
}

/**
 * A new Easing variable holding `value`, in `collection` (the file's first; a new one when it has none) — the Easing
 * popover's "Create variable" and the Easing page's presets "New variable". null (a toast said why) when it failed.
 */
export function createEasingVariable(ed: EditorController, collection: string | null, value: MotionEasing): string | null {
  const into = collection ?? createCollection(ed);
  const id = into ? createVariable(ed, into, "EASING", "", { kind: "literal", value }) : null;
  if (!id) showToast({ message: t("Couldn't create the variable"), kind: "error" });
  return id;
}

/** The dropdown alone (a segment's or clip's easing): the same popover. */
export function EasingMenu(props: EasingEditorProps) {
  return <EasingEditor {...props} />;
}
