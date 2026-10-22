import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { cx } from "../util/cx";
import { hexDigits, hexToRgba, hslToRgb, hsvToRgb, parseColor, parseCssColor, rgbToHex, rgbToHsl, rgbToHsv, rgbaToCss, sameRgba, type HSV, type RGBA } from "../util/color";
import {
  addStop,
  BLEND_LABEL,
  BLEND_MODES,
  colorAt,
  convertPaint,
  duplicateStop,
  flipGradient,
  hasHue,
  HUE_METHODS,
  INTERPOLATION_SPACES,
  isGradient,
  magnetStop,
  MIN_STOPS,
  moveStop,
  nextStopPosition,
  paintCss,
  GRADIENT_TYPES,
  PAINT_TABS,
  isMedia,
  paintTab,
  type PaintTab,
  redistributeStops,
  removeStop,
  snapStop,
  targetColor,
  withInterpolation,
  withTargetColor,
  type ImageScaleMode,
  type InterpolationColorSpace,
  type InterpolationHueMethod,
  type PaintType,
  type PatternAlignment,
  type PickerPaint,
} from "../util/paint";
import { autoCorrect, contrastLines, contrastOf, CONTRAST_RATIOS, type ContrastCategory, type ContrastLevel } from "../util/contrast";
import { rovingTarget } from "../util/rovingFocus";
import { tooltipProps } from "../overlay/TooltipManager";
import type { ChangeInfo } from "../types";
import { Icon, type IconName } from "../icons/Icon";
import { Popover, type PopoverPlacement } from "./Popover";
import { Tabs } from "./Tabs";
import { SegmentedControl } from "./SegmentedControl";
import { Select } from "./Select";
import { NumericInput } from "./NumericInput";
import { ColorInput } from "./ColorInput";
import { Button, IconButton, ToggleIconButton } from "./Button";
import { ContextMenu, MenuButton, type MenuEntry } from "./Menu";
import { EmptyState } from "./Misc";
import { selectAllOnClick } from "../util/selectAll";
import { Portal } from "../overlay/Portal";
import { Swatch } from "./Swatch";
import menu from "./Menu.module.css";
import { t, useT } from "@/i18n";
import field from "./Field.module.css";
import buttons from "./Button.module.css";
import styles from "./ColorPicker.module.css";

export type ColorModel = "hex" | "rgb" | "css" | "hsl" | "hsb";

const MODELS: { value: ColorModel; label: string }[] = [
  { value: "hex", label: "Hex" },
  { value: "rgb", label: "RGB" },
  { value: "css", label: "CSS" },
  { value: "hsl", label: "HSL" },
  { value: "hsb", label: "HSB" },
];

const SCALE_MODES: { value: ImageScaleMode; label: string }[] = [
  { value: "FILL", label: "Fill" },
  { value: "FIT", label: "Fit" },
  { value: "CROP", label: "Crop" },
  { value: "TILE", label: "Tile" },
];

const HUE_TRACK = "linear-gradient(to right, #ff0000, #ffff00, #00ff00, #00ffff, #0000ff, #ff00ff, #ff0000)";
/** Figma's user settings for the contrast check (on or off, the level), kept per machine. */
const CONTRAST_SHOWN_KEY = "color_picker_show_color_contrast";
const CONTRAST_LEVEL_KEY = "color_picker_color_contrast_level";
const readSetting = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const writeSetting = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // no storage: this session only
  }
};
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const byte = (n: number) => Math.round(clamp01(n) * 255);
const pct = (n: number) => Math.round(clamp01(n) * 100);
/** A slider's thumb centre travels 12 in from each end (live: the 16 thumb inside the track 4 in from the 180 slider). */
const INSET = 12;
/** A pointer's x as a fraction of a track inset by `inset` px on each side. */
const fractionX = (clientX: number, r: DOMRect, inset: number) => {
  const w = r.width - 2 * inset;
  return clamp01((clientX - r.left - inset) / (w > 0 ? w : 1));
};
/** A thumb's `left` on an inset track. */
const insetLeft = (f: number) => `calc(${INSET}px + (100% - ${2 * INSET}px) * ${clamp01(f)})`;
/** How far a press on a gradient stop moves before it drags it (Figma's GradientControl THRESHOLD). */
const STOP_DRAG_THRESHOLD = 5;
/** The wheel over the square (atlas 07 §5.5): (−dx + dy) / 2000 of the hue circle, or with ⌥ of the opacity. */
const WHEEL_SCALE = 2000;
/** A wheel turn's edits end (one undo step) once the wheel rests this long (ms). */
const WHEEL_SETTLE = 300;

/**
 * The opacity after a ⌥-wheel step on the square: rounded to 0.001 and pulled onto the nearest 10 % when within
 * 0.3 % of it, kept in 0..1 (atlas 07 §5.5).
 */
export function wheelAlpha(a: number, delta: number): number {
  const v = Math.round((a + delta) * 1000) / 1000;
  const tens = Math.round(v * 10) / 10;
  return clamp01(Math.abs(v - tens) <= 0.003 ? tens : v);
}
/** The hue (degrees) after a wheel step on the square: round the circle. */
export const wheelHue = (h: number, delta: number) => (((h + delta * 360) % 360) + 360) % 360;

/**
 * Follows a pointer from a press until release (pointer captured on the
 * pressed element): `onMove` gets its position as fractions of `area`'s box
 * (x measured `inset` px in from each side);
 * `onEnd(cancelled)` runs once — Esc or a lost pointer cancels.
 */
function trackPointer(e: React.PointerEvent<HTMLElement>, area: HTMLElement, onMove: (fx: number, fy: number, dy: number, ev: { clientX: number; shiftKey: boolean; altKey: boolean }) => void, onEnd: (cancelled: boolean) => void, inset = 0) {
  const el = e.currentTarget;
  const r = area.getBoundingClientRect();
  const at = (ev: { clientX: number; clientY: number; shiftKey: boolean; altKey: boolean }) => onMove(fractionX(ev.clientX, r, inset), clamp01((ev.clientY - r.top) / (r.height || 1)), ev.clientY - (r.top + r.height / 2), ev);
  try {
    el.setPointerCapture?.(e.pointerId);
  } catch {
    /* not capturable (tests) */
  }
  const move = (ev: PointerEvent) => at(ev);
  const finish = (cancelled: boolean) => {
    el.removeEventListener("pointermove", move);
    el.removeEventListener("pointerup", up);
    el.removeEventListener("pointercancel", lost);
    window.removeEventListener("keydown", esc, true);
    try {
      el.releasePointerCapture?.(e.pointerId);
    } catch {
      /* released */
    }
    onEnd(cancelled);
  };
  const up = () => finish(false);
  const lost = () => finish(true);
  const esc = (ev: KeyboardEvent) => {
    if (ev.key !== "Escape") return;
    ev.preventDefault();
    ev.stopPropagation();
    finish(true);
  };
  el.addEventListener("pointermove", move);
  el.addEventListener("pointerup", up);
  el.addEventListener("pointercancel", lost);
  window.addEventListener("keydown", esc, true);
  at(e);
}

/** A colour variable the hex field offers as one types: its id, full name ("Grey/800") and colour. */
export interface ColorVariableOption {
  id: string;
  name: string;
  color: RGBA;
}

/**
 * The hex field with Figma's suggestions: as one types, a menu under the field — the typed colour, the variables of
 * that colour, a line, then the variables whose name or hex starts like it (their group dimmed). ↑ / ↓ move through
 * it, Enter takes the row (or the text when none is highlighted), a click takes it, Esc closes it with the edit.
 */
function HexField({ value, onCommit, variables, onPickVariable }: { value: string; onCommit: (raw: string) => void; variables?: ColorVariableOption[]; onPickVariable?: (id: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [active, setActive] = useState(-1);
  const [at, setAt] = useState<{ left: number; top: number; width: number } | null>(null);
  const cancelled = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const q = draft === null ? "" : draft.trim().replace(/^#/, "").toLowerCase();
  const rows = useMemo(() => {
    if (!q || !variables?.length || !onPickVariable) return null;
    const hex = (c: RGBA) => hexDigits(rgbToHex(c)).toLowerCase();
    const typed = parseColor(q, { alpha: false });
    const same = typed ? variables.filter((v) => hex(v.color) === hex(typed.color)) : [];
    const named = variables.filter((v) => !same.includes(v) && (v.name.toLowerCase().includes(q) || hex(v.color).startsWith(q)));
    if (!typed && !named.length) return null;
    return { typed: typed?.color ?? null, same, named };
  }, [q, variables, onPickVariable]);
  const picks: (() => void)[] = rows ? [...(rows.typed ? [() => onCommit(draft ?? "")] : []), ...[...rows.same, ...rows.named].map((v) => () => onPickVariable?.(v.id))] : [];
  useLayoutEffect(() => {
    const field = input.current?.parentElement?.parentElement;
    if (!rows || !field) return setAt(null);
    const r = field.getBoundingClientRect();
    setAt({ left: r.left, top: r.bottom + 4, width: Math.max(r.width, 200) });
  }, [rows]);
  const finish = (pick?: () => void) => {
    cancelled.current = true;
    setDraft(null);
    setActive(-1);
    pick?.();
    input.current?.blur();
  };
  const row = (key: string, color: RGBA, label: ReactNode, i: number) => (
    <button
      key={key}
      type="button"
      role="option"
      aria-selected={active === i}
      tabIndex={-1}
      className={menu.item}
      data-highlighted={active === i ? "" : undefined}
      onPointerDown={(e) => e.preventDefault()}
      data-i={i}
      onPointerEnter={() => setActive(i)}
    >
      <Swatch color={rgbToHex(color)} opacity={Math.round((color.a ?? 1) * 100)} />
      <span className={menu.label}>{label}</span>
    </button>
  );
  const name = (n: string) => {
    const cut = n.lastIndexOf("/");
    return cut < 0 ? n : <><span className={styles.suggestGroup}>{n.slice(0, cut + 1)}</span>{n.slice(cut + 1)}</>;
  };
  let i = 0;
  return (
    <>
      <input
        ref={input}
        aria-label={t("Color")}
        aria-autocomplete={variables ? "list" : undefined}
        aria-expanded={rows ? true : undefined}
        value={draft ?? value}
        spellCheck={false}
        className={cx(styles.text, styles.upper)}
        {...selectAllOnClick}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => {
          setDraft(e.target.value);
          setActive(-1);
        }}
        onBlur={(e) => {
          const typed = draft !== null && !cancelled.current;
          cancelled.current = false;
          setDraft(null);
          setActive(-1);
          if (typed) onCommit(e.currentTarget.value);
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (rows && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            const n = picks.length;
            setActive((a) => (e.key === "ArrowDown" ? (a + 1) % n : (a <= 0 ? n : a) - 1));
          } else if (e.key === "Enter") {
            if (rows && active >= 0 && picks[active]) finish(picks[active]);
            else e.currentTarget.blur();
          } else if (e.key === "Escape") {
            finish();
          }
        }}
      />
      {rows && at && (
        <Portal theme="dark">
          <div
            role="listbox"
            aria-label={t("Color")}
            className={cx(menu.panel, styles.suggest)}
            style={{ left: at.left, top: at.top, width: at.width }}
            onClick={(e) => {
              const n = (e.target as Element).closest("[data-i]")?.getAttribute("data-i");
              if (n != null) finish(picks[Number(n)]);
            }}
          >
            {rows.typed && row("typed", rows.typed, `#${hexDigits(rgbToHex(rows.typed))}`, i++)}
            {rows.same.map((v) => row(v.id, v.color, name(v.name), i++))}
            {(rows.typed || rows.same.length > 0) && rows.named.length > 0 && <div role="separator" className={menu.separator} />}
            {rows.named.map((v) => row(v.id, v.color, name(v.name), i++))}
          </div>
        </Portal>
      )}
    </>
  );
}

/** A text value committed on Enter or blur (Esc reverts): the hex and CSS fields. */
function CommitText({ label, value, onCommit, upper }: { label: string; value: string; onCommit: (raw: string) => void; upper?: boolean }) {
  const [draft, setDraft] = useState<string | null>(null);
  const cancelled = useRef(false);
  return (
    <input
      aria-label={label}
      value={draft ?? value}
      spellCheck={false}
      className={cx(styles.text, upper && styles.upper)}
      {...selectAllOnClick}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={(e) => {
        const typed = draft !== null && !cancelled.current;
        cancelled.current = false;
        setDraft(null);
        if (typed) onCommit(e.currentTarget.value);
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          cancelled.current = true;
          setDraft(null);
          e.currentTarget.blur();
        }
      }}
    />
  );
}

export interface ColorPickerProps<P extends PickerPaint> {
  /** The paint being edited (Figma's names: type, color, opacity, stops, blendMode, imageScaleMode; other fields pass through) */
  value: P;
  /**
   * Every edit. A drag (the square, the sliders, a gradient stop) sends
   * `final: false` per move and exactly one `final: true` on release — one
   * undo step; typed, stepped and picked values are always final.
   */
  onChange: (next: P, info: ChangeInfo) => void;
  /** Esc during a drag: put back what it was before the drag (default: a final change back to it) */
  onCancel?: () => void;
  onClose: () => void;
  /** Where it opens from (a fill row's swatch) */
  anchor: DOMRect | HTMLElement | null;
  /** Default `left-of-panel`: left of the panel holding the anchor (`data-panel`), level with it */
  placement?: PopoverPlacement;
  /** The paint types offered (default all six) */
  paintTypes?: PaintType[];
  /** Offered but greyed out (Figma: Pattern while another paint of the list is one — one pattern per list) */
  disabledTypes?: PaintType[];
  /** "On this page": the document's colours (hex or rgba()) */
  documentColors?: string[];
  /**
   * The swatch sets after "On this page" (Figma's "Local assets": the file's colour variables, then its fill styles;
   * then one per enabled library); `separated`: a line above it in the menu
   */
  swatchSets?: { id: string; label: string; colors: string[]; separated?: boolean }[];
  /** The set shown ("page" or a set's id; the editor remembers it); uncontrolled without it */
  swatchSet?: string;
  onSwatchSetChange?: (id: string) => void;
  /** The Libraries tab: the editor's variables and styles */
  libraries?: ReactNode;
  /** The hex field's suggestions (Figma: the file's colour variables as one types); a pick binds `onPickVariable` */
  colorVariables?: ColorVariableOption[];
  onPickVariable?: (id: string) => void;
  initialTab?: "custom" | "libraries";
  /** IMAGE: what to preview, and the "Choose image…" action */
  imageUrl?: string | null;
  onChooseImage?: () => void;
  /** IMAGE without a picture yet: "Make an image" (AI) makes one for this fill (the image tools); with a picture it only says why it does nothing */
  onMakeImage?: () => void;
  /** "Check color contrast": what's behind the layer (a solid colour); the button shows only with it */
  contrastBackground?: RGBA | null;
  /** What the layers are read as for the contrast standard (their text sizes; null: mixed with normal text — none applies) */
  contrastCategory?: ContrastCategory | null;
  /** A gradient's "Rotate gradient" (its handles turn 90° about the middle — the editor owns the paint's transform) */
  onRotateGradient?: () => void;
  /** IMAGE: more controls under the scale mode (the editor's rotate and adjustment sliders) */
  imageControls?: ReactNode;
  /** The colour model (the editor remembers it per user); uncontrolled without it */
  colorModel?: ColorModel;
  onColorModelChange?: (model: ColorModel) => void;
  /** The selected gradient stop (index into `value.stops`); uncontrolled without it */
  stop?: number;
  onStopChange?: (index: number) => void;
  /** Header icon buttons left of × (Figma's "+" for a new style or variable) */
  headerActions?: ReactNode;
  /** IMAGE / VIDEO: the scale mode row's button at its right (Figma's "Rotate 90º") */
  imageAction?: ReactNode;
  /** PATTERN: the layer it tiles (its name and a preview) and "Select source…" (the next layer clicked) */
  pattern?: { source: string | null; previewUrl?: string | null; selecting?: boolean; onSelectSource: () => void };
  /**
   * Pixels added to its x left of the panel (default -1: live opens it at 959 from a paint's swatch; from the section's
   * "Apply styles and variables" at 960 — popovers/fill-styles-variables.txt)
   */
  offsetX?: number;
  /** The Shader tab (Figma's "Shader fills (Beta)" browser beside the picker); without it the tab is left out */
  onShaders?: (picker: HTMLElement) => void;
  /** A shader fill's settings (the editor's): the Shader tab is the selected one and this shows instead of the type's */
  shader?: ReactNode;
  /** Drawn in place (the Gallery) */
  static?: boolean;
}

/**
 * Figma UI3's colour picker (contract §4.6), a 240px popover: Custom /
 * Libraries tabs; the paint type (Solid, Linear, Radial, Angular, Diamond,
 * Image) and blend mode; for gradients the stop bar as Figma's GradientControl
 * (atlas 07 §7.2: a click adds a stop in the colour there and drags it, a stop
 * moves past 5 px, ⇧ in 5 % steps, dropped within 2 % of another it touches it
 * unless ⌥, ⌥-press copies it, double-click spreads the stops, right-click
 * Delete stop / Redistribute stops, ← / → 1 % or 5 %, Delete), the stops list
 * and "Color interpolation"; the saturation/brightness square (the wheel turns
 * the hue, ⌥-wheel the opacity), hue and opacity sliders, eyedropper; the colour
 * model (Hex, RGB, CSS, HSL, HSB) with its values; "On this page".
 * Controlled: `value` in, `onChange(next, { final })` out.
 */
export function ColorPicker<P extends PickerPaint>(props: ColorPickerProps<P>) {
  useT();
  const { value, onChange, onCancel, onClose, anchor, placement = "left-of-panel", paintTypes, disabledTypes, documentColors = [], swatchSets = [], swatchSet: controlledSet, onSwatchSetChange, libraries, colorVariables, onPickVariable, initialTab = "custom", imageUrl, onChooseImage, onMakeImage, onRotateGradient, contrastBackground, contrastCategory = "graphics", imageControls, imageAction, pattern, onShaders, shader, offsetX = -1, colorModel, onColorModelChange, stop: controlledStop, onStopChange, headerActions, static: isStatic } = props;
  const [tab, setTab] = useState(initialTab);
  // "Check color contrast" on or off and the level asked for: kept, as Figma's user settings
  // (`color_picker_show_color_contrast`, `color_picker_color_contrast_level`); the category is chosen per picker.
  const [contrast, setContrastState] = useState(() => readSetting(CONTRAST_SHOWN_KEY) === "1");
  const [contrastLevel, setContrastLevelState] = useState<ContrastLevel>(() => (readSetting(CONTRAST_LEVEL_KEY) === "AAA" ? "AAA" : "AA"));
  const [categoryChoice, setCategoryChoice] = useState<ContrastCategory | "auto">("auto");
  const [fixPreview, setFixPreview] = useState(false);
  const setContrast = (on: boolean) => {
    setContrastState(on);
    writeSetting(CONTRAST_SHOWN_KEY, on ? "1" : "0");
  };
  const setContrastLevel = (level: ContrastLevel) => {
    setContrastLevelState(level);
    writeSetting(CONTRAST_LEVEL_KEY, level);
  };
  const [ownModel, setOwnModel] = useState<ColorModel>("hex");
  const [ownSet, setOwnSet] = useState("page");
  const model = colorModel ?? ownModel;
  const [ownStop, setOwnStop] = useState(0);
  const [localHsv, setLocalHsv] = useState<HSV | null>(null);
  const [dragging, setDragging] = useState(false);
  // The stop bar: a ghost stop under the pointer (the colour there), a stop's context menu.
  const [ghost, setGhost] = useState<number | null>(null);
  const [stopMenu, setStopMenu] = useState<{ index: number; x: number; y: number } | null>(null);
  const wheel = useRef<{ timer: ReturnType<typeof setTimeout> | null }>({ timer: null });
  const bar = useRef<HTMLDivElement>(null);
  const latest = useRef({ value, onChange, onCancel });
  useLayoutEffect(() => {
    latest.current = { value, onChange, onCancel };
  });
  const gesture = useRef<{ start: P; last: P } | null>(null);
  // The paint before the interpolation menu's hover preview: previews and the pick start from it.
  const unpreviewed = useRef<P | null>(null);

  const gradient = isGradient(value.type);
  const stopCount = value.stops?.length ?? 0;
  const stop = gradient ? Math.min(Math.max(0, controlledStop ?? ownStop), Math.max(0, stopCount - 1)) : 0;
  const target = targetColor(value, stop);
  // The square and hue follow the value; while dragging (or for greys, whose hue is undefined) the picker's own HSV is kept.
  const derived = (): HSV => {
    const t = rgbToHsv(target);
    if (localHsv && (t.v === 0 || t.s === 0)) return { h: localHsv.h, s: t.v === 0 ? localHsv.s : t.s, v: t.v };
    return t;
  };
  const hsv = localHsv && (dragging || sameRgba({ ...hsvToRgb(localHsv), a: target.a }, target)) ? localHsv : derived();

  const selectStop = (i: number) => {
    setOwnStop(i);
    onStopChange?.(i);
    setLocalHsv(null);
  };
  /** A new colour for what is edited (SOLID's colour, or the selected stop's). */
  const setColor = (color: RGBA, info: ChangeInfo, nextHsv?: HSV) => {
    const keepHue = rgbToHsv(color);
    setLocalHsv(nextHsv ?? (keepHue.s === 0 || keepHue.v === 0 ? { ...keepHue, h: hsv.h } : keepHue));
    onChange(withTargetColor(value, stop, color), info);
  };

  // ── gestures: one final change per drag ──
  const begin = () => {
    gesture.current = { start: latest.current.value, last: latest.current.value };
    setDragging(true);
  };
  const preview = (next: P) => {
    if (!gesture.current) return;
    gesture.current.last = next;
    latest.current.onChange(next, { final: false, source: "drag" });
  };
  const end = (cancelled: boolean) => {
    const g = gesture.current;
    gesture.current = null;
    setDragging(false);
    if (!g) return;
    if (cancelled) {
      setLocalHsv(null);
      if (latest.current.onCancel) latest.current.onCancel();
      else latest.current.onChange(g.start, { final: true, source: "drag" });
    } else latest.current.onChange(g.last, { final: true, source: "drag" });
  };

  const dragColor = (e: React.PointerEvent<HTMLDivElement>, compute: (fx: number, fy: number) => { hsv: HSV; a: number }, inset = 0) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.focus({ preventScroll: true });
    begin();
    const start = gesture.current!.start;
    trackPointer(e, e.currentTarget, (fx, fy) => {
      const next = compute(fx, fy);
      setLocalHsv(next.hsv);
      preview(withTargetColor(start, stop, { ...hsvToRgb(next.hsv), a: next.a }));
    }, end, inset);
  };

  const keyStep = (e: React.KeyboardEvent, apply: (dx: number, dy: number) => void) => {
    const by = e.shiftKey ? 0.1 : 0.01;
    const d: Record<string, [number, number]> = { ArrowLeft: [-by, 0], ArrowRight: [by, 0], ArrowUp: [0, by], ArrowDown: [0, -by] };
    const step = d[e.key];
    if (!step) return;
    e.preventDefault();
    e.stopPropagation();
    apply(step[0], step[1]);
  };

  // ── the wheel over the square: the hue, or with ⌥ the opacity; one undo step per turn (⌃-wheel is the canvas's zoom) ──
  const wheelRun = useRef<{ hsv: HSV; a: number } | null>(null);
  const turnWheel = (e: WheelEvent) => {
    if (e.ctrlKey) return;
    e.preventDefault();
    const delta = (-e.deltaX + e.deltaY) / WHEEL_SCALE;
    if (!delta) return;
    if (!gesture.current || !wheelRun.current) {
      begin();
      wheelRun.current = { hsv, a: target.a };
    }
    const run = wheelRun.current;
    if (e.altKey) run.a = wheelAlpha(run.a, delta);
    else run.hsv = { ...run.hsv, h: wheelHue(run.hsv.h, delta) };
    setLocalHsv(run.hsv);
    preview(withTargetColor(gesture.current!.start, stop, { ...hsvToRgb(run.hsv), a: run.a }));
    if (wheel.current.timer) clearTimeout(wheel.current.timer);
    wheel.current.timer = setTimeout(settleWheel, WHEEL_SETTLE);
  };
  const settleWheel = () => {
    if (wheel.current.timer) clearTimeout(wheel.current.timer);
    wheel.current.timer = null;
    if (!wheelRun.current) return;
    wheelRun.current = null;
    end(false);
  };
  const onWheel = useRef(turnWheel);
  const settle = useRef(settleWheel);
  useLayoutEffect(() => {
    onWheel.current = turnWheel;
    settle.current = settleWheel;
  });
  // Closing the picker mid-turn keeps what the wheel did.
  useEffect(() => () => settle.current(), []);
  const svRef = useCallback((el: HTMLDivElement | null) => {
    if (!el) return;
    el.addEventListener("wheel", (e) => onWheel.current(e), { passive: false });
  }, []);

  // ── gradient stops (Figma's GradientControl, atlas 07 §7.2) ──
  const setStops = (stops: NonNullable<P["stops"]>, info: ChangeInfo) => onChange({ ...value, stops }, info);
  type Stops = NonNullable<P["stops"]>;
  /**
   * Follows a stop from a press: moved by the pointer (⇧ in 5 % steps) once it has gone `threshold` px, then on release
   * pulled onto a neighbour within 2 % (⌥ off) and put in order (the selection follows it).
   */
  const dragStop = (e: React.PointerEvent<HTMLElement>, stops: Stops, index: number, threshold: number) => {
    const el = bar.current;
    if (!el) return;
    const x0 = e.clientX;
    let moved = threshold === 0;
    let last = { stops, alt: e.altKey };
    const start = { ...gesture.current!.start, stops };
    if (threshold === 0) preview(start);
    trackPointer(e, el, (fx, _fy, _dy, ev) => {
      last = { stops: last.stops, alt: ev.altKey };
      if (!moved && Math.abs(ev.clientX - x0) < threshold) return;
      moved = true;
      last.stops = moveStop(stops, index, snapStop(fx, ev.shiftKey)) as Stops;
      preview({ ...start, stops: last.stops });
    }, (cancelled) => {
      const g = gesture.current;
      if (!cancelled && g && moved) {
        const dropped = last.stops[index]?.position ?? 0;
        const placed = ordered(moveStop(last.stops, index, last.alt ? dropped : magnetStop(last.stops, index, dropped)) as Stops, index);
        g.last = { ...start, stops: placed.stops };
        selectStop(placed.index);
      }
      end(cancelled);
    }, 0);
  };
  /** The stops in order of position (Figma re-sorts after every change), and where stop `i` went. */
  const ordered = (stops: Stops, i: number): { stops: Stops; index: number } => {
    const sorted = stops.map((s, k) => ({ s, k })).sort((a, b) => a.s.position - b.s.position || a.k - b.k);
    return { stops: sorted.map((x) => x.s) as Stops, index: Math.max(0, sorted.findIndex((x) => x.k === i)) };
  };
  const pressBar = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || (e.target !== e.currentTarget.firstElementChild && e.target !== e.currentTarget)) return;
    const el = bar.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // The bar's ends are the stops' 0 % and 100 % (live: the chips centred on 16 and 224); a press past them adds nothing.
    const f = (e.clientX - r.left) / (r.width || 1);
    if (f < 0 || f > 1) return;
    e.preventDefault();
    // A new stop there in the gradient's colour at that point, selected and dragged in the same gesture.
    const { stops, index } = addStop(value.stops ?? [], snapStop(f, e.shiftKey), value);
    setGhost(null);
    begin();
    selectStop(index);
    dragStop(e, stops as Stops, index, 0);
  };
  const pressStop = (e: React.PointerEvent<HTMLButtonElement>, i: number) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.focus({ preventScroll: true });
    setGhost(null);
    const el = bar.current;
    if (!el) return;
    begin();
    const own = (value.stops ?? []) as Stops;
    if (e.altKey) {
      // ⌥-press: a copy of the stop at the pointer, dragged from there.
      const r = el.getBoundingClientRect();
      const { stops, index } = duplicateStop(own, i, snapStop(fractionX(e.clientX, r, 0), e.shiftKey));
      selectStop(index);
      dragStop(e, stops as Stops, index, 0);
      return;
    }
    selectStop(i);
    dragStop(e, own, i, STOP_DRAG_THRESHOLD);
  };
  const deleteStop = (i: number, source: ChangeInfo["source"]) => {
    if (stopCount <= MIN_STOPS) return;
    setStops(removeStop(value.stops ?? [], i) as Stops, { final: true, source });
    selectStop(Math.max(0, Math.min(i, stopCount - 2)));
  };
  const redistribute = () => setStops(redistributeStops(value.stops ?? []) as Stops, { final: true, source: "pick" });

  // The tabs with at least one type offered; Gradient keeps the gradient's own type (or Linear for a new one).
  const offered = (t: PaintType) => !paintTypes || paintTypes.includes(t);
  const gradientTypes = GRADIENT_TYPES.filter((g) => offered(g.value)).map((g) => ({ ...g, label: t(g.label) }));
  const typeOptions = PAINT_TABS.filter((p) => (p.value === "GRADIENT" ? gradientTypes.length > 0 : offered(p.value))).map((p) => ({ value: p.value, icon: p.icon as IconName, tooltip: t(p.label), disabled: p.value !== paintTab(value.type) && !!disabledTypes?.includes(p.value as PaintType) }));
  const pickTab = (tab: PaintTab) => {
    const type: PaintType = tab === "GRADIENT" ? (isGradient(value.type) ? value.type : (gradientTypes[0]?.value ?? "GRADIENT_LINEAR")) : tab;
    // (A shader fill: any type tab leaves it, its own included.)
    if (type === value.type && !shader) return;
    setLocalHsv(null);
    onChange(convertPaint(value, type), { final: true, source: "pick" });
  };
  const blendEntries: MenuEntry[] = BLEND_MODES.map((m) => (m === "-" ? "-" : { id: m, label: t(BLEND_LABEL[m]), checked: (value.blendMode ?? "NORMAL") === m }));
  const opacityPart = (
    <span className={cx(styles.part, styles.partOpacity)}>
      <NumericInput bare label={t("Opacity")} value={pct(target.a)} min={0} max={100} precision={0} unit="%" onChange={(v, info) => setColor({ ...target, a: v / 100 }, info, hsv)} />
    </span>
  );
  const channel = (label: string, v: number, max: number, apply: (n: number) => RGBA, nextHsv?: (n: number) => HSV) => (
    <span className={styles.part}>
      <NumericInput bare label={t(label)} value={v} min={0} max={max} precision={0} onChange={(n, info) => setColor(apply(n), info, nextHsv?.(n))} />
    </span>
  );
  const hsl = rgbToHsl(target);
  const modelFields = (() => {
    switch (model) {
      case "rgb":
        return (
          <>
            {channel("Red", byte(target.r), 255, (n) => ({ ...target, r: n / 255 }))}
            {channel("Green", byte(target.g), 255, (n) => ({ ...target, g: n / 255 }))}
            {channel("Blue", byte(target.b), 255, (n) => ({ ...target, b: n / 255 }))}
            {opacityPart}
          </>
        );
      case "hsl":
        return (
          <>
            {channel("Hue", Math.round(hsv.h), 360, (n) => ({ ...hslToRgb({ ...hsl, h: n }), a: target.a }), (n) => ({ ...hsv, h: n }))}
            {channel("Saturation", Math.round(hsl.s * 100), 100, (n) => ({ ...hslToRgb({ ...hsl, h: hsv.h, s: n / 100 }), a: target.a }))}
            {channel("Lightness", Math.round(hsl.l * 100), 100, (n) => ({ ...hslToRgb({ ...hsl, h: hsv.h, l: n / 100 }), a: target.a }))}
            {opacityPart}
          </>
        );
      case "hsb":
        return (
          <>
            {channel("Hue", Math.round(hsv.h), 360, (n) => ({ ...hsvToRgb({ ...hsv, h: n }), a: target.a }), (n) => ({ ...hsv, h: n }))}
            {channel("Saturation", Math.round(hsv.s * 100), 100, (n) => ({ ...hsvToRgb({ ...hsv, s: n / 100 }), a: target.a }), (n) => ({ ...hsv, s: n / 100 }))}
            {channel("Brightness", Math.round(hsv.v * 100), 100, (n) => ({ ...hsvToRgb({ ...hsv, v: n / 100 }), a: target.a }), (n) => ({ ...hsv, v: n / 100 }))}
            {opacityPart}
          </>
        );
      case "css":
        return (
          <span className={styles.part}>
            <CommitText label={t("CSS color")} value={rgbaToCss(target)} onCommit={(raw) => { const c = parseCssColor(raw); if (c) setColor(c, { final: true, source: "type" }); }} />
          </span>
        );
      default:
        return (
          <>
            <span className={styles.part}>
              <HexField
                variables={colorVariables}
                onPickVariable={onPickVariable}
                value={hexDigits(rgbToHex(target))}
                onCommit={(raw) => {
                  // Figma's colour string: 1–8 hex digits, a name, rgb() / hsl() / oklch()…; its alpha only when typed.
                  const c = parseColor(raw);
                  if (c) setColor({ ...c.color, a: c.alpha ? c.color.a : target.a }, { final: true, source: "type" });
                }}
              />
            </span>
            {opacityPart}
          </>
        );
    }
  })();

  const eyedropper = typeof window !== "undefined" && "EyeDropper" in window;
  const pickFromScreen = async () => {
    try {
      const Dropper = (window as unknown as { EyeDropper: new () => { open: () => Promise<{ sRGBHex: string }> } }).EyeDropper;
      const { sRGBHex } = await new Dropper().open();
      const c = parseCssColor(sRGBHex);
      if (c) setColor({ ...c, a: target.a }, { final: true, source: "pick" });
    } catch {
      /* cancelled */
    }
  };

  const sorted = gradient ? (value.stops ?? []).map((s, i) => ({ ...s, i })).sort((a, b) => a.position - b.position) : [];
  const svBackground = `linear-gradient(to top, #000000, transparent), linear-gradient(to right, #ffffff, ${rgbToHex(hsvToRgb({ h: hsv.h, s: 1, v: 1 }))})`;
  const opaque = rgbToHex(hsvToRgb(hsv));
  const tab0 = paintTab(value.type);
  const showContrast = !!contrastBackground && value.type === "SOLID";
  // The contrast check (atlas 07 §5.7): the standard the layers' category asks for at the chosen level (graphics: AA
  // only), the ratio, the square's lines where it is met exactly, and — short of it — Figma's auto-correct: the nearest
  // colour of this hue and alpha that meets it.
  const contrastCategoryShown = categoryChoice === "auto" ? contrastCategory : categoryChoice;
  const contrastLevelShown: ContrastLevel = contrastCategoryShown === "graphics" ? "AA" : contrastLevel;
  const contrastNeed = contrastCategoryShown ? CONTRAST_RATIOS[contrastCategoryShown][contrastLevelShown] : null;
  const contrastOn = contrast && showContrast;
  const hsvH = hsv.h;
  const { r: fr, g: fg, b: fb, a: fa } = target;
  const bgKey = contrastBackground ? rgbaToCss(contrastBackground) : "";
  const contrastCheck = useMemo(() => {
    if (!contrastOn || !contrastBackground) return null;
    const fgc = { r: fr, g: fg, b: fb, a: fa };
    const ratio = contrastOf(fgc, contrastBackground);
    const met = contrastNeed !== null && ratio >= contrastNeed;
    const hue = hsvH / 360;
    return {
      ratio,
      met,
      lines: contrastNeed !== null ? contrastLines(contrastNeed, hue, fa, contrastBackground) : null,
      fix: contrastNeed !== null && !met ? autoCorrect({ ratio: contrastNeed, hue, alpha: fa, fg: fgc, bg: contrastBackground }) : null,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the background by value (bgKey)
  }, [contrastOn, bgKey, contrastNeed, fr, fg, fb, fa, hsvH]);
  const pickerBox = useRef<HTMLDivElement>(null);
  // A stop's swatch opens a Solid picker for that stop beside this one (unverified: the live capture has no stop picker).
  const [stopPickerAt, setStopPickerAt] = useState<{ index: number; anchor: HTMLElement | null } | null>(null);
  const stopPicker = stopPickerAt?.index ?? null;

  // ── the paint type tabs (live: six 24 × 24 radios 4 apart, the current one on #383838) ──
  const typeRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const typeTabs = typeOptions.map((t, i) => (
    <button
      key={t.value}
      ref={(el) => {
        typeRefs.current[i] = el;
      }}
      type="button"
      role="radio"
      aria-checked={t.value === tab0 && !shader}
      aria-label={t.tooltip}
      tabIndex={t.value === tab0 && !shader ? 0 : -1}
      className={styles.typeTab}
      disabled={t.disabled}
      onClick={() => pickTab(t.value as PaintTab)}
      onKeyDown={(e) => {
        const next = rovingTarget(e.key, typeOptions.length, (k) => !typeOptions[k].disabled, i, "horizontal");
        if (next === null || next < 0) return;
        e.preventDefault();
        typeRefs.current[next]?.focus();
        pickTab(typeOptions[next].value as PaintTab);
      }}
      {...tooltipProps(t.tooltip)}
    >
      <Icon name={t.icon} />
    </button>
  ));

  const square = (
    <div
      className={styles.sv}
      role="slider"
      aria-label={t("Color picker reticle")}
      aria-valuetext={t("Saturation {s}%, brightness {v}%", { s: Math.round(hsv.s * 100), v: Math.round(hsv.v * 100) })}
      aria-valuenow={Math.round(hsv.s * 100)}
      tabIndex={0}
      data-autofocus=""
      ref={svRef}
      style={{ background: svBackground }}
      onPointerDown={(e) => dragColor(e, (fx, fy) => ({ hsv: { h: hsv.h, s: fx, v: 1 - fy }, a: target.a }))}
      onKeyDown={(e) => {
        // PageUp / PageDown: the top / bottom edge; Home / End: the left / right edge (atlas 07 §5.5).
        const edge: Partial<HSV> | undefined = { PageUp: { v: 1 }, PageDown: { v: 0 }, Home: { s: 0 }, End: { s: 1 } }[e.key];
        const apply = (next: HSV) => setColor({ ...hsvToRgb(next), a: target.a }, { final: true, source: "step" }, next);
        if (edge) {
          e.preventDefault();
          e.stopPropagation();
          apply({ ...hsv, ...edge });
          return;
        }
        keyStep(e, (dx, dy) => apply({ h: hsv.h, s: clamp01(hsv.s + dx), v: clamp01(hsv.v + dy) }));
      }}
    >
      {contrastCheck?.lines && (() => {
        // Figma's dotted area: the colours that fail — under the lighter line and over the darker one
        const pts = (line: { s: number; v: number }[]) => line.map((p) => `${p.s * 100}% ${(1 - p.v) * 100}%`);
        const { lighter, darker } = contrastCheck.lines;
        const below = lighter ? `polygon(${[...pts(lighter), ...(lighter[lighter.length - 1].s < 1 ? ["100% 0%"] : []), "100% 100%", "0% 100%"].join(", ")})` : undefined;
        const above = darker ? `polygon(${[...pts(darker), "100% 0%", "0% 0%"].join(", ")})` : undefined;
        return (
          <span className={styles.contrastFail} style={{ clipPath: below }} aria-hidden>
            <span style={{ clipPath: above }} />
          </span>
        );
      })()}
      {contrastCheck?.lines && (
        // Where the contrast is exactly the standard's (Figma's lighter / darker luminance lines, white at 80 %).
        <svg className={styles.contrastLines} viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden>
          {[contrastCheck.lines.lighter, contrastCheck.lines.darker].map((line, i) =>
            line ? <polyline key={i} points={line.map((p) => `${p.s},${1 - p.v}`).join(" ")} vectorEffect="non-scaling-stroke" /> : null
          )}
        </svg>
      )}
      <span className={styles.thumb} style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: opaque }} />
      {fixPreview && contrastCheck?.fix && (() => {
        const at = rgbToHsv(contrastCheck.fix);
        return <span className={cx(styles.thumb, styles.contrastFix)} style={{ left: `${at.s * 100}%`, top: `${(1 - at.v) * 100}%`, background: rgbToHex(contrastCheck.fix) }} />;
      })()}
    </div>
  );
  const sliders = (
    <div className={styles.sliders}>
      <IconButton icon="24.eyedropper.small" label={t("Sample color")} disabled={!eyedropper} onClick={() => void pickFromScreen()} />
      <div className={styles.sliderStack}>
        <div
          className={styles.slider}
          role="slider"
          aria-label={t("Hue")}
          aria-valuemin={0}
          aria-valuemax={359}
          aria-valuenow={Math.round(hsv.h) % 360}
          aria-valuetext={`${Math.round(hsv.h) % 360}°`}
          tabIndex={0}
          onPointerDown={(e) => dragColor(e, (fx) => ({ hsv: { ...hsv, h: fx * 360 }, a: target.a }), INSET)}
          onKeyDown={(e) => {
            // 1° a press, 10° with ⇧, round the circle (atlas 07 §5.5: step 1, big step 10, loops).
            const d = ({ ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 } as Record<string, number>)[e.key];
            if (!d) return;
            e.preventDefault();
            e.stopPropagation();
            const next = { ...hsv, h: (((Math.round(hsv.h) + d * (e.shiftKey ? 10 : 1)) % 360) + 360) % 360 };
            setColor({ ...hsvToRgb(next), a: target.a }, { final: true, source: "step" }, next);
          }}
        >
          <span className={styles.track} style={{ background: HUE_TRACK }} />
          <span className={styles.thumb} style={{ left: insetLeft(hsv.h / 360), background: rgbToHex(hsvToRgb({ h: hsv.h, s: 1, v: 1 })) }} />
        </div>
        <div
          className={styles.slider}
          role="slider"
          aria-label={t("Opacity")}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct(target.a)}
          tabIndex={0}
          onPointerDown={(e) => dragColor(e, (fx) => ({ hsv, a: fx }), INSET)}
          onKeyDown={(e) => keyStep(e, (dx, dy) => setColor({ ...target, a: clamp01(target.a + dx + dy) }, { final: true, source: "step" }, hsv))}
        >
          <span className={cx(styles.track, styles.checker)}>
            <span className={styles.barFill} style={{ background: `linear-gradient(to right, transparent, ${opaque})` }} />
          </span>
          <span className={styles.thumb} style={{ left: insetLeft(target.a), background: rgbaToCss(target) }} />
        </div>
      </div>
    </div>
  );
  const modelRow = (
    <div className={styles.modelRow}>
      <Select label={t("Color format")} variant="ghost" value={model} options={MODELS} width={55} onChange={(m) => { setOwnModel(m as ColorModel); onColorModelChange?.(m as ColorModel); }} />
      <div className={cx(field.field, styles.joined)}>{modelFields}</div>
    </div>
  );
  // The check's settings (Figma's COLOR_CONTRAST_SETTINGS_DROPDOWN): the category — Auto (what the layers are read
  // as), or one chosen — and the level, each with its ratio.
  const categoryName = (c: ContrastCategory | null | undefined) => (c === "largeText" ? t("Large text") : c === "normalText" ? t("Normal text") : c === "graphics" ? t("Graphics") : t("Mixed"));
  // Live: "AA · Essential (3 : 1)", "AAA · Only for text" (graphics have no AAA)
  const ratioText = (level: ContrastLevel) => {
    const r = contrastCategoryShown ? CONTRAST_RATIOS[contrastCategoryShown][level] : null;
    if (level === "AAA" && contrastCategoryShown === "graphics") return t("AAA · Only for text");
    const name = level === "AA" ? t("AA · Essential") : t("AAA · Enhanced");
    return r === null ? name : `${name} (${r} : 1)`;
  };
  const contrastSettings: MenuEntry[] = [
    { header: t("Category") },
    { id: "category.auto", label: t("Auto ({category})", { category: categoryName(contrastCategory) }), checked: categoryChoice === "auto", radio: true },
    ...(["largeText", "normalText", "graphics"] as const).map((c) => ({ id: `category.${c}`, label: categoryName(c), checked: categoryChoice === c, radio: true })),
    "-",
    { header: t("Level") },
    ...(["AA", "AAA"] as const).map((l) => ({ id: `level.${l}`, label: ratioText(l), checked: contrastLevelShown === l, radio: true, disabled: contrastCategoryShown === "graphics" && l === "AAA" })),
  ];
  // Live (the owner's 116.png): over the square — the two colours in a circle, "2.13 : 1", ⊘ / ✓ and the level, and
  // the settings; a failing level is a button that puts in the nearest colour that passes (its thumb shown on hover).
  const contrastRow = contrastCheck && contrastBackground ? (
    <div className={styles.contrastRow} role="status" aria-label={t("Contrast")}>
      <svg className={styles.contrastGlyph} viewBox="0 0 16 16" aria-hidden>
        <circle cx="8" cy="8" r="7.5" fill={rgbaToCss({ ...contrastBackground, a: 1 })} />
        <path d="M0.6 6.2C2.5 3.6 5.6 3.8 7.2 6.6C8.6 9 10.5 11.4 14.6 11.4A7.5 7.5 0 1 0 0.6 6.2Z" fill={rgbaToCss(target)} />
      </svg>
      <span className={styles.contrastValue}>
        {contrastCheck.ratio}
        <span className={styles.contrastOf}> : 1</span>
      </span>
      {contrastNeed !== null &&
        (contrastCheck.met || !contrastCheck.fix ? (
          <span className={styles.contrastStatus} data-pass={contrastCheck.met || undefined}>
            <Icon name={contrastCheck.met ? "24.check" : "24.contrast.fail.small"} />
            {contrastLevelShown}
          </span>
        ) : (
          <button
            type="button"
            className={styles.contrastStatus}
            aria-label={t("Doesn't meet {standard}", { standard: contrastLevelShown })}
            {...tooltipProps(t("Auto-correct"))}
            onPointerEnter={() => setFixPreview(true)}
            onPointerLeave={() => setFixPreview(false)}
            onClick={() => {
              setFixPreview(false);
              setColor({ ...contrastCheck.fix!, a: target.a }, { final: true, source: "pick" });
            }}
          >
            <Icon name="24.contrast.fail.small" />
            {contrastLevelShown}
          </button>
        ))}
      <MenuButton
        label={t("Contrast settings")}
        className={buttons.icon}
        entries={contrastSettings}
        align="center"
        menuWidth={200}
        gap={6}
        flip
        onSelect={(id) => {
          if (id.startsWith("category.")) setCategoryChoice(id.slice(9) as ContrastCategory | "auto");
          else if (id.startsWith("level.")) setContrastLevel(id.slice(6) as ContrastLevel);
        }}
      >
        <Icon name="24.adjust.small" />
      </MenuButton>
    </div>
  ) : null;
  // "On this page" first, then the editor's sets (a set it no longer has falls back to the page's).
  const set = swatchSets.find((s) => s.id === (controlledSet ?? ownSet)) ?? null;
  const swatchColors = set ? set.colors : documentColors;
  const swatchSection = (
    <div className={styles.swatchSection}>
      <Select
        label={t("Color swatch set selector")}
        variant="ghost"
        value={set?.id ?? "page"}
        options={[{ value: "page", label: t("On this page") }, ...swatchSets.flatMap((s) => [...(s.separated ? ["-" as const] : []), { value: s.id, label: s.label }])]}
        width={208}
        onChange={(id) => {
          setOwnSet(id);
          onSwatchSetChange?.(id);
        }}
      />
      {swatchColors.length ? (
        <div className={styles.swatches}>
          {swatchColors.map((c) => {
            const rgba = parseCssColor(c);
            const hex = rgba ? hexDigits(rgbToHex(rgba)).toUpperCase() : c;
            return (
              <button
                key={c}
                type="button"
                aria-label={t("Solid color hex: {hex}", { hex })}
                className={styles.swatchButton}
                {...tooltipProps(hex)}
                onClick={() => { if (rgba) setColor(rgba, { final: true, source: "pick" }); }}
              >
                <span className={styles.swatchChip} style={{ background: rgba ? rgbaToCss(rgba) : c }} />
              </button>
            );
          })}
        </div>
      ) : (
        <span className={styles.empty}>{set ? t("No colors available") : t("No colors on this page yet")}</span>
      )}
    </div>
  );

  // ── gradient: the stops on their bar, then the Stops list ──
  const gradientBody = gradient && (
    <>
      <div className={styles.gradientTypeRow}>
        {/* Live (popovers/fill-picker-gradient_linear.txt): a 96 × 32 "Paint type" box around the 24-high dropdown */}
        <div role="group" aria-label={t("Paint type")} className={styles.paintType}>
          <Select label={t("Paint type")} variant="ghost" width={96} value={value.type} options={gradientTypes} onChange={(t) => { setLocalHsv(null); onChange(convertPaint(value, t as PaintType), { final: true, source: "pick" }); }} />
        </div>
        <span className={styles.gradientActions}>
          <IconButton icon="24.flip.horizontal.small" label={t("Flip gradient")} disabled={stopCount < 2} onClick={() => onChange(flipGradient(value), { final: true, source: "pick" })} />
          {onRotateGradient && <IconButton icon="24.rotate" label={t("Rotate gradient")} onClick={onRotateGradient} />}
        </span>
      </div>
      <div className={styles.gradientRow}>
        <div
          ref={bar}
          className={styles.bar}
          onPointerDown={pressBar}
          // Hovering the track: a ghost stop in the colour there (where a click adds one).
          onPointerMove={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            const f = (e.clientX - r.left) / (r.width || 1);
            const onTrack = !dragging && (e.target === e.currentTarget || e.target === e.currentTarget.firstElementChild) && f >= 0 && f <= 1;
            setGhost(onTrack ? f : null);
          }}
          onPointerLeave={() => setGhost(null)}
          data-ds="GradientBar"
        >
          <span className={styles.barFill} style={{ background: paintCss(value, "bar") }} />
          {ghost !== null && (
            <span className={cx(styles.stop, styles.ghostStop)} style={{ left: `${ghost * 100}%` }} aria-hidden data-ghost-stop="">
              <span className={styles.stopChip} style={{ background: rgbaToCss({ ...colorAt(value.stops ?? [], ghost, value.interpolationColorSpace, value.interpolationHueMethod), a: 1 }) }} />
            </span>
          )}
          {(value.stops ?? []).map((s, i) => (
            <button
              key={i}
              type="button"
              role="slider"
              aria-label={t("Stop {n}", { n: i + 1 })}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={pct(s.position)}
              aria-selected={i === stop}
              className={styles.stop}
              style={{ left: `${clamp01(s.position) * 100}%` }}
              onPointerDown={(e) => pressStop(e, i)}
              onFocus={() => i !== stop && selectStop(i)}
              // Double-click: the stops spread evenly; right-click: Delete stop / Redistribute stops (atlas 07 §7.2).
              onDoubleClick={() => !stopMenu && redistribute()}
              onContextMenu={(e) => {
                e.preventDefault();
                selectStop(i);
                setStopMenu({ index: i, x: e.clientX, y: e.clientY });
              }}
              onKeyDown={(e) => {
                if (e.key === "Delete" || e.key === "Backspace") {
                  e.preventDefault();
                  e.stopPropagation();
                  deleteStop(i, "type");
                  return;
                }
                // ← / → 1 %, with ⇧ 5 %; the stops stay in order and the selection follows the stop.
                const d = ({ ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 } as Record<string, number>)[e.key];
                if (!d) return;
                e.preventDefault();
                e.stopPropagation();
                const placed = ordered(moveStop(value.stops ?? [], i, Math.round((s.position + d * (e.shiftKey ? 0.05 : 0.01)) * 10000) / 10000) as Stops, i);
                setStops(placed.stops, { final: true, source: "step" });
                selectStop(placed.index);
              }}
            >
              <span className={styles.stopChip} style={{ background: rgbaToCss({ ...s.color, a: 1 }) }} />
            </button>
          ))}
        </div>
      </div>
      {stopMenu && (
        <ContextMenu
          at={{ x: stopMenu.x, y: stopMenu.y }}
          label={t("Gradient stop")}
          entries={[
            { id: "delete", label: t("Delete stop"), disabled: stopCount <= MIN_STOPS },
            ...(stopCount > MIN_STOPS ? [{ id: "redistribute", label: t("Redistribute stops") }] : []),
          ]}
          onSelect={(id) => (id === "delete" ? deleteStop(stopMenu.index, "pick") : redistribute())}
          onClose={() => setStopMenu(null)}
        />
      )}
      <div className={styles.stopsSection}>
        <div className={styles.stopsHeader}>
          <span>{t("Stops")}</span>
          <IconButton
            icon="24.plus.small"
            label={t("Add gradient stop")}
            tone="secondary"
            onClick={() => {
              // Halfway to the next stop (a lone stop: the far end), in the gradient's colour there.
              const added = addStop(value.stops ?? [], nextStopPosition(value.stops ?? [], stop), value);
              const placed = ordered(added.stops as Stops, added.index);
              setStops(placed.stops, { final: true, source: "pick" });
              selectStop(placed.index);
            }}
          />
        </div>
        {sorted.map((s, row) => (
          <div key={s.i} className={styles.stopRow} aria-selected={s.i === stop} onPointerDown={() => s.i !== stop && selectStop(s.i)}>
            <span
              className={styles.stopPosition}
              data-stop-row={row}
              // Tab / ⇧Tab: the next / previous stop's position (atlas 07 §7.3).
              onKeyDown={(e) => {
                if (e.key !== "Tab") return;
                const next = pickerBox.current?.querySelector<HTMLInputElement>(`[data-stop-row="${row + (e.shiftKey ? -1 : 1)}"] input`);
                if (!next) return;
                e.preventDefault();
                next.focus();
              }}
            >
              <NumericInput label={t("Gradient stop position")} value={pct(s.position)} min={0} max={100} precision={0} unit="%" scrub={false} onChange={(v, info) => setStops(moveStop(value.stops ?? [], s.i, v / 100) as Stops, info)} />
            </span>
            <span className={styles.stopColor}>
              <ColorInput
                label={t("Gradient Stop Color")}
                swatchLabel={t("Solid color hex: {hex}", { hex: hexDigits(rgbToHex(s.color)).toUpperCase() })}
                color={rgbToHex(s.color)}
                opacity={pct(s.color.a)}
                onSwatchClick={() => {
                  selectStop(s.i);
                  setStopPickerAt(stopPicker === s.i ? null : { index: s.i, anchor: pickerBox.current?.closest<HTMLElement>('[data-ds="Popover"]') ?? null });
                }}
                onColor={(hex, info, o) => { const c = hexToRgba(hex); if (c) setStops((value.stops ?? []).map((x, k) => (k === s.i ? { ...x, color: { ...c, a: o !== undefined ? o / 100 : x.color.a } } : x)) as NonNullable<P["stops"]>, info); }}
                onOpacity={(o, info) => setStops((value.stops ?? []).map((x, k) => (k === s.i ? { ...x, color: { ...x.color, a: o / 100 } } : x)) as NonNullable<P["stops"]>, info)}
              />
            </span>
            {/* Only while there are more stops than the least a gradient keeps (one; live shows it with two stops) */}
            {stopCount > MIN_STOPS && <IconButton icon="24.minus.small" label={t("Delete gradient stop")} tone="secondary" onClick={() => deleteStop(s.i, "pick")} />}
          </div>
        ))}
      </div>
      {/* "Color interpolation": the space the stops blend in, and for OKLCH / HSL the way round the hue */}
      <div className={styles.interpolationRow}>
        <span className={styles.interpolationLabel}>{t("Color interpolation")}</span>
        <Select
          label={t("Interpolation color space")}
          variant="ghost"
          width="hug"
          value={value.interpolationColorSpace ?? "DEFAULT"}
          options={INTERPOLATION_SPACES.map((o) => ({ ...o, label: t(o.label) }))}
          onChange={(v) => {
            const from = unpreviewed.current ?? value;
            onChange(withInterpolation(from, v as InterpolationColorSpace), { final: true, source: "pick" });
          }}
          // Hovering a space shows the gradient in it (Figma: "Hovering an option previews it", atlas 07 §7); leaving the
          // menu or picking puts back what it started from. Only where a change can be rolled back (`onCancel`).
          onPreview={
            onCancel
              ? (v) => {
                  if (v === null) {
                    if (!unpreviewed.current) return;
                    onCancel();
                    queueMicrotask(() => (unpreviewed.current = null));
                    return;
                  }
                  unpreviewed.current ??= value;
                  onChange(withInterpolation(unpreviewed.current, v as InterpolationColorSpace), { final: false, source: "pick" });
                }
              : undefined
          }
        />
        {hasHue(value.interpolationColorSpace) && (
          <Select
            label={t("Interpolation hue method")}
            variant="ghost"
            width="hug"
            value={value.interpolationHueMethod === "DECREASING" ? "DECREASING" : "INCREASING"}
            options={HUE_METHODS.map((o) => ({ ...o, label: t(o.label) }))}
            onChange={(v) => onChange({ ...value, interpolationHueMethod: v as InterpolationHueMethod }, { final: true, source: "pick" })}
          />
        )}
      </div>
    </>
  );

  // ── image / video: scale mode and its action, the preview with "Upload from computer", the editor's controls ──
  const mediaBody = isMedia(value.type) && (
    <>
      <div className={styles.mediaRow}>
        <Select label={t("Image scale mode")} variant="ghost" width={96} value={value.imageScaleMode ?? "FILL"} options={SCALE_MODES.map((o) => ({ ...o, label: t(o.label) }))} onChange={(m) => onChange({ ...value, imageScaleMode: m as ImageScaleMode }, { final: true, source: "pick" })} />
        {imageAction}
      </div>
      <div
        className={cx(styles.image, value.type === "VIDEO" && !imageControls && styles.media)}
        role="img"
        aria-label={imageUrl ? t("Image preview") : t("No image")}
        data-empty={!imageUrl || undefined}
        style={imageUrl ? { backgroundImage: `url("${imageUrl}")`, backgroundSize: value.imageScaleMode === "FIT" ? "contain" : value.imageScaleMode === "TILE" ? "auto" : "cover", backgroundRepeat: value.imageScaleMode === "TILE" ? "repeat" : "no-repeat" } : undefined}
      >
        <div className={styles.imageOverlay}>
          <Button variant="primary" className={value.type === "VIDEO" ? styles.uploadVideo : styles.upload} disabled={!onChooseImage} onClick={onChooseImage}>{t("Upload from computer")}</Button>
          {value.type === "IMAGE" && (
            <Button variant="secondary" className={cx(styles.upload, styles.makeImage)} {...(onMakeImage && !imageUrl ? { onClick: onMakeImage } : { "aria-disabled": true, tooltip: t("Current selection has a fill"), onClick: (e: { preventDefault(): void }) => e.preventDefault() })}>
              <Icon name="16.sparkle" />
              {t("Make an image")}
            </Button>
          )}
        </div>
      </div>
      {imageControls}
    </>
  );

  // ── pattern: the source's preview and "Select source…", Tile type, Scale, Spacing X / Y, Alignment ──
  const anchorCells: [PatternAlignment, PatternAlignment, string][] = [
    ["START", "START", "Align top left"], ["CENTER", "START", "Align top center"], ["END", "START", "Align top right"],
    ["START", "CENTER", "Align left"], ["CENTER", "CENTER", "Align center"], ["END", "CENTER", "Align right"],
    ["START", "END", "Align bottom left"], ["CENTER", "END", "Align bottom center"], ["END", "END", "Align bottom right"],
  ];
  const spacing = value.patternSpacing ?? { x: 0, y: 0 };
  const patternBody = value.type === "PATTERN" && (
    <>
      <div className={styles.patternPreview} data-empty={!pattern?.previewUrl || undefined} role="img" aria-label={pattern?.source ? t("Pattern source: {source}", { source: pattern.source }) : t("No pattern source")} style={pattern?.previewUrl ? { backgroundImage: `url("${pattern.previewUrl}")` } : undefined}>
        <div className={styles.patternShade}>
          {/* Live (popovers/fill-picker-pattern.txt): 117 wide, the label at 28 — a 24 glyph first (which one is unverified) */}
          <Button variant="secondary" icon="24.move" className={styles.selectSource} aria-pressed={pattern?.selecting || undefined} disabled={!pattern} onClick={pattern?.onSelectSource}>
            {pattern?.selecting ? t("Click a layer…") : pattern?.source ? pattern.source : t("Select source…")}
          </Button>
        </div>
      </div>
      <div className={styles.patternGrid}>
        <span className={styles.patternLabel}>{t("Tile type")}</span>
        <SegmentedControl
          label={t("Tile type")}
          fullWidth
          value={value.patternTileType === "RECTANGULAR" || !value.patternTileType ? "RECTANGULAR" : "HEXAGONAL"}
          options={[{ value: "RECTANGULAR", icon: "24.tile.rectangular", tooltip: t("Rectangular") }, { value: "HEXAGONAL", icon: "24.tile.hexagonal", tooltip: t("Hexagonal") }]}
          onChange={(t) => onChange({ ...value, patternTileType: t === "RECTANGULAR" ? "RECTANGULAR" : "HORIZONTAL_HEXAGONAL" }, { final: true, source: "pick" })}
        />
        <span className={styles.patternLabel}>{t("Scale")}</span>
        <NumericInput scrubHandle="previous" label={t("Scale")} prefix="24.scale" value={Math.round((value.scale ?? 1) * 100)} min={1} max={10000} precision={0} unit="%" onChange={(v, info) => onChange({ ...value, scale: v / 100 }, info)} />
        <span className={styles.patternLabel}>{t("Spacing")}</span>
        <NumericInput scrubHandle="previous" label={t("Spacing X")} prefix="X" value={Math.round(spacing.x * 100)} min={-100} max={10000} precision={0} unit="%" onChange={(v, info) => onChange({ ...value, patternSpacing: { x: v / 100, y: spacing.y } }, info)} />
        <span />
        <NumericInput label={t("Spacing Y")} prefix="Y" value={Math.round(spacing.y * 100)} min={-100} max={10000} precision={0} unit="%" onChange={(v, info) => onChange({ ...value, patternSpacing: { x: spacing.x, y: v / 100 } }, info)} />
        <span className={cx(styles.patternLabel, styles.patternLabelTop)}>{t("Alignment")}</span>
        <div role="radiogroup" aria-label={t("Anchor point")} className={styles.anchor}>
          {anchorCells.map(([h, v, name]) => {
            const on = (value.horizontalAlignment ?? "START") === h && (value.verticalAlignment ?? "START") === v;
            return (
              <button key={name} type="button" role="radio" aria-checked={on} aria-label={t(name)} className={styles.anchorCell} onClick={() => onChange({ ...value, horizontalAlignment: h, verticalAlignment: v }, { final: true, source: "pick" })}>
                <span className={on ? styles.anchorOn : styles.anchorDot} />
              </button>
            );
          })}
        </div>
      </div>
    </>
  );

  return (
    <Popover
      anchor={anchor}
      placement={placement}
      onClose={onClose}
      static={isStatic}
      width={240}
      offsetX={offsetX}
      label={t("Color picker")}
      header={<Tabs label={t("Color source")} value={tab} onChange={(v) => setTab(v as "custom" | "libraries")} tabs={[{ value: "custom", label: t("Custom") }, { value: "libraries", label: t("Libraries") }]} />}
      headerActions={headerActions && <span className={styles.headerActions}>{headerActions}</span>}
    >
      <div ref={pickerBox} data-ds="ColorPicker" className={styles.body}>
        {tab === "libraries" ? (
          <div className={styles.libraries}>{libraries ?? <EmptyState icon="24.library" title={t("No libraries")} body={t("Colors and styles from your libraries show here.")} />}</div>
        ) : (
          <>
            <div className={styles.typeRow}>
              <div role="radiogroup" aria-label={t("Fill type")} className={styles.typeTabs}>
                {typeTabs}
                {onShaders && (
                  <button type="button" role="radio" aria-checked={!!shader} aria-label={t("Shader")} tabIndex={shader ? 0 : -1} className={styles.typeTab} {...tooltipProps(t("Shader (Beta)"))} onClick={(e) => onShaders(e.currentTarget.closest<HTMLElement>('[data-ds="Popover"]') ?? e.currentTarget)}>
                    <Icon name="24.paint.shader.small" />
                  </button>
                )}
              </div>
              <span className={styles.typeActions}>
                <MenuButton label={t("Blend mode")} className={buttons.icon} entries={blendEntries} onSelect={(id) => onChange({ ...value, blendMode: id as P["blendMode"] }, { final: true, source: "pick" })}>
                  <Icon name={(value.blendMode ?? "NORMAL") === "NORMAL" ? "24.blendmode.small" : "24.blendmode.active.small"} />
                </MenuButton>
                {/* Figma's live picker: "Check color contrast" at 208, the blend mode before it (Solid) */}
                {showContrast && <ToggleIconButton icon="24.contrast.check" label={t("Check color contrast")} pressed={contrast} onPressedChange={setContrast} />}
              </span>
            </div>
            {shader}
            {!shader && gradientBody}
            {!shader && gradient && stopPicker !== null && value.stops?.[stopPicker] && (
              <ColorPicker
                value={{ type: "SOLID", color: { ...value.stops[stopPicker].color, a: 1 }, opacity: value.stops[stopPicker].color.a }}
                paintTypes={["SOLID"]}
                documentColors={documentColors}
                swatchSets={swatchSets}
                swatchSet={controlledSet ?? ownSet}
                onSwatchSetChange={(id) => {
                  setOwnSet(id);
                  onSwatchSetChange?.(id);
                }}
                anchor={stopPickerAt?.anchor ?? null}
                placement="left"
                colorModel={model}
                onColorModelChange={(m) => { setOwnModel(m); onColorModelChange?.(m); }}
                onChange={(next, info) => {
                  const c = next.color ?? value.stops![stopPicker].color;
                  setStops((value.stops ?? []).map((x, k) => (k === stopPicker ? { ...x, color: { r: c.r, g: c.g, b: c.b, a: next.opacity ?? 1 } } : x)) as NonNullable<P["stops"]>, info);
                }}
                onCancel={onCancel}
                onClose={() => setStopPickerAt(null)}
              />
            )}
            {!shader && mediaBody}
            {!shader && patternBody}
            {!shader && value.type === "SOLID" && (
              <>
                {contrastRow}
                {square}
                {sliders}
                {modelRow}
                {swatchSection}
              </>
            )}
          </>
        )}
      </div>
    </Popover>
  );
}
