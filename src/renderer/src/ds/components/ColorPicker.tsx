import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { cx } from "../util/cx";
import { hexDigits, hexToRgba, hslToRgb, hsvToRgb, parseCssColor, rgbToHex, rgbToHsl, rgbToHsv, rgbaToCss, sameRgba, type HSV, type RGBA } from "../util/color";
import {
  addStop,
  BLEND_LABEL,
  BLEND_MODES,
  convertPaint,
  flipStops,
  isGradient,
  moveStop,
  paintCss,
  GRADIENT_TYPES,
  PAINT_TABS,
  isMedia,
  paintTab,
  type PaintTab,
  removeStop,
  sortStops,
  targetColor,
  withTargetColor,
  type ImageScaleMode,
  type PaintType,
  type PickerPaint,
} from "../util/paint";
import type { ChangeInfo } from "../types";
import { Icon, type IconName } from "../icons/Icon";
import { Popover, type PopoverPlacement } from "./Popover";
import { Tabs } from "./Tabs";
import { SegmentedControl } from "./SegmentedControl";
import { Select } from "./Select";
import { NumericInput } from "./NumericInput";
import { ColorInput } from "./ColorInput";
import { Button, IconButton } from "./Button";
import { MenuButton, type MenuEntry } from "./Menu";
import { Swatch } from "./Swatch";
import { EmptyState } from "./Misc";
import { selectAllOnClick } from "../util/selectAll";
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
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const byte = (n: number) => Math.round(clamp01(n) * 255);
const pct = (n: number) => Math.round(clamp01(n) * 100);
/** Half a slider thumb / gradient stop (12px wide): their centres travel from 6px to width − 6px, so they never hang off the track. */
const INSET = 6;
/** A pointer's x as a fraction of a track inset by `inset` px on each side. */
const fractionX = (clientX: number, r: DOMRect, inset: number) => {
  const w = r.width - 2 * inset;
  return clamp01((clientX - r.left - inset) / (w > 0 ? w : 1));
};
/** A thumb's `left` on an inset track. */
const insetLeft = (f: number) => `calc(${INSET}px + (100% - ${2 * INSET}px) * ${clamp01(f)})`;

/**
 * Follows a pointer from a press until release (pointer captured on the
 * pressed element): `onMove` gets its position as fractions of `area`'s box
 * (x measured `inset` px in from each side);
 * `onEnd(cancelled)` runs once — Esc or a lost pointer cancels.
 */
function trackPointer(e: React.PointerEvent<HTMLElement>, area: HTMLElement, onMove: (fx: number, fy: number, dy: number) => void, onEnd: (cancelled: boolean) => void, inset = 0) {
  const el = e.currentTarget;
  const r = area.getBoundingClientRect();
  const at = (ev: { clientX: number; clientY: number }) => onMove(fractionX(ev.clientX, r, inset), clamp01((ev.clientY - r.top) / (r.height || 1)), ev.clientY - (r.top + r.height / 2));
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
  /** "On this page": the document's colours (hex or rgba()) */
  documentColors?: string[];
  /** The Libraries tab: the editor's variables and styles */
  libraries?: ReactNode;
  initialTab?: "custom" | "libraries";
  /** IMAGE: what to preview, and the "Choose image…" action */
  imageUrl?: string | null;
  onChooseImage?: () => void;
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
  /** Drawn in place (the Gallery) */
  static?: boolean;
}

/**
 * Figma UI3's colour picker (contract §4.6), a 240px popover: Custom /
 * Libraries tabs; the paint type (Solid, Linear, Radial, Angular, Diamond,
 * Image) and blend mode; for gradients the stop bar (click adds a stop, drag
 * moves it, drag it off the bar or Delete removes it) and the stops list;
 * the saturation/brightness square, hue and opacity sliders, eyedropper;
 * the colour model (Hex, RGB, CSS, HSL, HSB) with its values; "On this
 * page". Controlled: `value` in, `onChange(next, { final })` out.
 */
export function ColorPicker<P extends PickerPaint>(props: ColorPickerProps<P>) {
  const { value, onChange, onCancel, onClose, anchor, placement = "left-of-panel", paintTypes, documentColors = [], libraries, initialTab = "custom", imageUrl, onChooseImage, onRotateGradient, imageControls, colorModel, onColorModelChange, stop: controlledStop, onStopChange, headerActions, static: isStatic } = props;
  const [tab, setTab] = useState(initialTab);
  const [ownModel, setOwnModel] = useState<ColorModel>("hex");
  const model = colorModel ?? ownModel;
  const [ownStop, setOwnStop] = useState(0);
  const [localHsv, setLocalHsv] = useState<HSV | null>(null);
  const [dragging, setDragging] = useState(false);
  const [removing, setRemoving] = useState<number | null>(null);
  const bar = useRef<HTMLDivElement>(null);
  const latest = useRef({ value, onChange, onCancel });
  useLayoutEffect(() => {
    latest.current = { value, onChange, onCancel };
  });
  const gesture = useRef<{ start: P; last: P } | null>(null);

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
    setRemoving(null);
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

  // ── gradient stops ──
  const setStops = (stops: NonNullable<P["stops"]>, info: ChangeInfo) => onChange({ ...value, stops }, info);
  const pressBar = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || (e.target !== e.currentTarget.firstElementChild && e.target !== e.currentTarget)) return;
    e.preventDefault();
    const el = bar.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const { stops, index } = addStop(value.stops ?? [], fractionX(e.clientX, r, INSET));
    begin();
    selectStop(index);
    const start = { ...gesture.current!.start, stops };
    preview(start);
    trackPointer(e, el, (fx) => preview({ ...start, stops: moveStop(stops, index, fx) }), end, INSET);
  };
  const pressStop = (e: React.PointerEvent<HTMLButtonElement>, i: number) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.focus({ preventScroll: true });
    selectStop(i);
    const el = bar.current;
    if (!el) return;
    begin();
    const start = gesture.current!.start;
    const stops = start.stops ?? [];
    trackPointer(e, el, (fx, _fy, dy) => {
      // Dragged off the bar: it goes (there are always two)
      const off = Math.abs(dy) > 32 && stops.length > 2;
      setRemoving(off ? i : null);
      preview({ ...start, stops: off ? removeStop(stops, i) : moveStop(stops, i, fx) });
    }, (cancelled) => {
      if (!cancelled && gesture.current && (gesture.current.last.stops?.length ?? 0) < stops.length) selectStop(0);
      end(cancelled);
    }, INSET);
  };

  // The tabs with at least one type offered; Gradient keeps the gradient's own type (or Linear for a new one).
  const offered = (t: PaintType) => !paintTypes || paintTypes.includes(t);
  const gradientTypes = GRADIENT_TYPES.filter((g) => offered(g.value));
  const typeOptions = PAINT_TABS.filter((t) => (t.value === "GRADIENT" ? gradientTypes.length > 0 : offered(t.value))).map((t) => ({ value: t.value, icon: t.icon as IconName, tooltip: t.label }));
  const pickTab = (tab: PaintTab) => {
    const type: PaintType = tab === "GRADIENT" ? (isGradient(value.type) ? value.type : (gradientTypes[0]?.value ?? "GRADIENT_LINEAR")) : tab;
    if (type === value.type) return;
    setLocalHsv(null);
    onChange(convertPaint(value, type), { final: true, source: "pick" });
  };
  const blendEntries: MenuEntry[] = BLEND_MODES.map((m) => (m === "-" ? "-" : { id: m, label: BLEND_LABEL[m], checked: (value.blendMode ?? "NORMAL") === m }));
  const opacityPart = (
    <span className={cx(styles.part, styles.partOpacity)}>
      <NumericInput bare label="Opacity" value={pct(target.a)} min={0} max={100} precision={0} unit="%" onChange={(v, info) => setColor({ ...target, a: v / 100 }, info, hsv)} />
    </span>
  );
  const channel = (label: string, v: number, max: number, apply: (n: number) => RGBA, nextHsv?: (n: number) => HSV) => (
    <span className={styles.part}>
      <NumericInput bare label={label} value={v} min={0} max={max} precision={0} onChange={(n, info) => setColor(apply(n), info, nextHsv?.(n))} />
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
            <CommitText label="CSS color" value={rgbaToCss(target)} onCommit={(raw) => { const c = parseCssColor(raw); if (c) setColor(c, { final: true, source: "type" }); }} />
          </span>
        );
      default:
        return (
          <>
            <span className={styles.part}>
              <CommitText
                label="Hex"
                upper
                value={hexDigits(rgbToHex(target))}
                onCommit={(raw) => {
                  const c = hexToRgba(raw);
                  if (!c) return;
                  const eight = raw.trim().replace(/^#/, "").length === 8;
                  setColor({ ...c, a: eight ? c.a : target.a }, { final: true, source: "type" });
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

  return (
    <Popover
      anchor={anchor}
      placement={placement}
      onClose={onClose}
      static={isStatic}
      width={240}
      label="Color picker"
      header={<Tabs label="Color source" value={tab} onChange={(t) => setTab(t as "custom" | "libraries")} tabs={[{ value: "custom", label: "Custom" }, { value: "libraries", label: "Libraries" }]} />}
      headerActions={headerActions}
    >
      <div data-ds="ColorPicker" className={styles.body}>
        {tab === "libraries" ? (
          <div className={styles.libraries}>{libraries ?? <EmptyState icon="24.library" title="No libraries" body="Colors and styles from your libraries show here." />}</div>
        ) : (
          <>
            <div className={styles.typeRow}>
              <SegmentedControl label="Fill type" value={paintTab(value.type)} options={typeOptions} onChange={(t) => pickTab(t as PaintTab)} />
              <MenuButton label="Blend mode" className={buttons.icon} entries={blendEntries} onSelect={(id) => onChange({ ...value, blendMode: id as P["blendMode"] }, { final: true, source: "pick" })}>
                <Icon name={(value.blendMode ?? "NORMAL") === "NORMAL" ? "24.blendmode.small" : "24.blendmode.active.small"} />
              </MenuButton>
            </div>

            {gradient && (
              // Figma's live picker: the gradient's "Paint type" (96 wide), Flip gradient at 180, Rotate gradient at 208.
              <div className={styles.gradientTypeRow}>
                <Select label="Paint type" width={96} value={value.type} options={gradientTypes} onChange={(t) => { setLocalHsv(null); onChange(convertPaint(value, t as PaintType), { final: true, source: "pick" }); }} />
                <span className={styles.gradientActions}>
                  <IconButton icon="24.flip.horizontal.small" label="Flip gradient" onClick={() => setStops(flipStops(value.stops ?? []) as NonNullable<P["stops"]>, { final: true, source: "pick" })} />
                  {onRotateGradient && <IconButton icon="24.rotate" label="Rotate gradient" onClick={onRotateGradient} />}
                </span>
              </div>
            )}
            {gradient && (
              <div className={styles.gradientRow}>
                <div ref={bar} className={styles.bar} onPointerDown={pressBar} data-ds="GradientBar">
                  <span className={styles.barFill} style={{ background: paintCss(value, "bar") }} />
                  {(value.stops ?? []).map((s, i) => (
                    <button
                      key={i}
                      type="button"
                      role="slider"
                      aria-label={`Stop ${i + 1}`}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={pct(s.position)}
                      aria-selected={i === stop}
                      data-removing={removing === i || undefined}
                      className={styles.stop}
                      style={{ left: insetLeft(s.position), background: rgbaToCss({ ...s.color, a: 1 }) }}
                      onPointerDown={(e) => pressStop(e, i)}
                      onFocus={() => i !== stop && selectStop(i)}
                      onKeyDown={(e) => {
                        if (e.key === "Delete" || e.key === "Backspace") {
                          e.preventDefault();
                          e.stopPropagation();
                          if (stopCount > 2) {
                            setStops(removeStop(value.stops ?? [], i) as NonNullable<P["stops"]>, { final: true, source: "type" });
                            selectStop(0);
                          }
                          return;
                        }
                        keyStep(e, (dx) => setStops(moveStop(value.stops ?? [], i, s.position + dx) as NonNullable<P["stops"]>, { final: true, source: "step" }));
                      }}
                    />
                  ))}
                </div>
              </div>
            )}

            {isMedia(value.type) ? (
              <>
                <div
                  className={styles.image}
                  role="img"
                  aria-label={imageUrl ? "Image preview" : "No image"}
                  style={imageUrl ? { backgroundImage: `url("${imageUrl}")`, backgroundSize: value.imageScaleMode === "FIT" ? "contain" : value.imageScaleMode === "TILE" ? "auto" : "cover", backgroundRepeat: value.imageScaleMode === "TILE" ? "repeat" : "no-repeat" } : undefined}
                >
                  {!imageUrl && <Icon name="24.image" />}
                </div>
                <div className={styles.imageRow}>
                  <Select label="Image scale mode" value={value.imageScaleMode ?? "FILL"} options={SCALE_MODES} onChange={(m) => onChange({ ...value, imageScaleMode: m as ImageScaleMode }, { final: true, source: "pick" })} />
                  <Button variant="secondary" disabled={!onChooseImage} onClick={onChooseImage}>{value.type === "VIDEO" ? "Choose video…" : "Choose image…"}</Button>
                </div>
                {imageControls}
                <div style={{ width: 88 }}>
                  <NumericInput label="Opacity" prefix="24.opacity" value={pct(value.opacity ?? 1)} min={0} max={100} precision={0} unit="%" onChange={(v, info) => onChange({ ...value, opacity: v / 100 }, info)} />
                </div>
              </>
            ) : (
              <>
                <div
                  className={styles.sv}
                  role="slider"
                  aria-label="Saturation and brightness"
                  aria-valuetext={`Saturation ${Math.round(hsv.s * 100)}%, brightness ${Math.round(hsv.v * 100)}%`}
                  aria-valuenow={Math.round(hsv.s * 100)}
                  tabIndex={0}
                  data-autofocus=""
                  style={{ background: svBackground }}
                  onPointerDown={(e) => dragColor(e, (fx, fy) => ({ hsv: { h: hsv.h, s: fx, v: 1 - fy }, a: target.a }))}
                  onKeyDown={(e) => keyStep(e, (dx, dy) => { const next = { h: hsv.h, s: clamp01(hsv.s + dx), v: clamp01(hsv.v + dy) }; setColor({ ...hsvToRgb(next), a: target.a }, { final: true, source: "step" }, next); })}
                >
                  <span className={styles.thumb} style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: opaque }} />
                </div>
                <div className={styles.sliders}>
                  <IconButton icon="24.eyedropper.small" label="Pick color from screen" disabled={!eyedropper} onClick={() => void pickFromScreen()} />
                  <div className={styles.sliderStack}>
                    <div
                      className={styles.slider}
                      role="slider"
                      aria-label="Hue"
                      aria-valuemin={0}
                      aria-valuemax={360}
                      aria-valuenow={Math.round(hsv.h)}
                      tabIndex={0}
                      style={{ background: HUE_TRACK }}
                      onPointerDown={(e) => dragColor(e, (fx) => ({ hsv: { ...hsv, h: fx * 360 }, a: target.a }), INSET)}
                      onKeyDown={(e) => keyStep(e, (dx, dy) => { const next = { ...hsv, h: Math.min(360, Math.max(0, hsv.h + (dx + dy) * 360)) }; setColor({ ...hsvToRgb(next), a: target.a }, { final: true, source: "step" }, next); })}
                    >
                      <span className={styles.thumb} style={{ left: insetLeft(hsv.h / 360), background: rgbToHex(hsvToRgb({ h: hsv.h, s: 1, v: 1 })) }} />
                    </div>
                    <div
                      className={cx(styles.slider, styles.checker)}
                      role="slider"
                      aria-label="Opacity"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={pct(target.a)}
                      tabIndex={0}
                      onPointerDown={(e) => dragColor(e, (fx) => ({ hsv, a: fx }), INSET)}
                      onKeyDown={(e) => keyStep(e, (dx, dy) => setColor({ ...target, a: clamp01(target.a + dx + dy) }, { final: true, source: "step" }, hsv))}
                    >
                      <span className={styles.barFill} style={{ background: `linear-gradient(to right, transparent, ${opaque})` }} />
                      <span className={styles.thumb} style={{ left: insetLeft(target.a), background: rgbaToCss(target) }} />
                    </div>
                  </div>
                </div>
                <div className={styles.modelRow}>
                  <Select label="Color model" value={model} options={MODELS} width={64} onChange={(m) => { setOwnModel(m as ColorModel); onColorModelChange?.(m as ColorModel); }} />
                  <div className={cx(field.field, styles.joined)}>{modelFields}</div>
                </div>
              </>
            )}

            {gradient && (
              <div className={styles.section}>
                <div className={styles.stopsHeader}>
                  <span>Stops</span>
                  <IconButton
                    icon="24.plus.small"
                    label="Add stop"
                    tone="secondary"
                    onClick={() => {
                      const s = sortStops(value.stops ?? []);
                      const at = s.findIndex((x) => x.position >= (value.stops?.[stop]?.position ?? 0));
                      const a = s[Math.max(0, at)]?.position ?? 0;
                      const b = s[Math.min(s.length - 1, Math.max(0, at) + 1)]?.position ?? 1;
                      const { stops, index } = addStop(value.stops ?? [], a === b ? Math.min(1, a + 0.1) : (a + b) / 2);
                      setStops(stops as NonNullable<P["stops"]>, { final: true, source: "pick" });
                      selectStop(index);
                    }}
                  />
                </div>
                {sorted.map((s) => (
                  <div key={s.i} className={styles.stopRow} aria-selected={s.i === stop} onPointerDown={() => s.i !== stop && selectStop(s.i)}>
                    <span className={styles.stopPosition}>
                      <NumericInput label={`Stop ${s.i + 1} position`} value={pct(s.position)} min={0} max={100} precision={0} unit="%" onChange={(v, info) => setStops(moveStop(value.stops ?? [], s.i, v / 100) as NonNullable<P["stops"]>, info)} />
                    </span>
                    <span className={styles.stopColor}>
                      <ColorInput
                        label={`Stop ${s.i + 1} color`}
                        color={rgbToHex(s.color)}
                        opacity={pct(s.color.a)}
                        onSwatchClick={() => selectStop(s.i)}
                        onColor={(hex, info) => { const c = hexToRgba(hex); if (c) setStops((value.stops ?? []).map((x, k) => (k === s.i ? { ...x, color: { ...c, a: x.color.a } } : x)) as NonNullable<P["stops"]>, info); }}
                        onOpacity={(o, info) => setStops((value.stops ?? []).map((x, k) => (k === s.i ? { ...x, color: { ...x.color, a: o / 100 } } : x)) as NonNullable<P["stops"]>, info)}
                      />
                    </span>
                    <IconButton icon="24.minus.small" label="Remove stop" tone="secondary" disabled={stopCount <= 2} onClick={() => { setStops(removeStop(value.stops ?? [], s.i) as NonNullable<P["stops"]>, { final: true, source: "pick" }); selectStop(0); }} />
                  </div>
                ))}
              </div>
            )}

            {!isMedia(value.type) && (
              <div className={styles.section}>
                <span className={styles.sectionTitle}>On this page</span>
                {documentColors.length ? (
                  <div className={styles.swatches}>
                    {documentColors.map((c) => (
                      <button
                        key={c}
                        type="button"
                        aria-label={c}
                        className={styles.swatchButton}
                        data-tooltip={c.startsWith("#") ? c.slice(1).toUpperCase() : c}
                        onClick={() => { const rgba = parseCssColor(c); if (rgba) setColor(rgba, { final: true, source: "pick" }); }}
                      >
                        <Swatch color={c.startsWith("#") ? c : rgbToHex(parseCssColor(c) ?? { r: 0, g: 0, b: 0, a: 1 })} opacity={pct(parseCssColor(c)?.a ?? 1)} shape="round" />
                      </button>
                    ))}
                  </div>
                ) : (
                  <span className={styles.empty}>No colors on this page yet</span>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </Popover>
  );
}
