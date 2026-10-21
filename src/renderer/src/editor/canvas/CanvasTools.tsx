/**
 * Round 8's canvas pieces in React (editor/canvasTools.ts has the logic): an auto-layout bar's value edited in place
 * (REQUEST_INLINE_EDIT), the eyedropper's card (the canvas's pixels under the pointer, magnified, the colour's swatch
 * and hex, "Click to sample"), and Preferences › Nudge amount….
 */
import { t, useT } from "@/i18n";
import { useEffect, useMemo, useRef, useState } from "react";
import { evaluate, FloatingPanel, Icon, NumericInput, size, Swatch, TextInput } from "@/ds";
import { useTool } from "@/engine/hooks";
import { useEditor } from "../controller";
import { useLocalAssets, useUI } from "../hooks";
import { applyPickedColor, canvasColorAt, canvasPixelsAround, commitInlineValue, DEFAULT_NUDGE, setNudge } from "../canvasTools";
import { colorFormat, formatColor, nextEyedropperFormat, useColorFormat } from "../colorFormat";
import { matchColor, setEyedropperChoice } from "../eyedropper";
import { presentationHasKeys } from "../keyboard";
import styles from "./CanvasTools.module.css";

/** The padding or gap value typed over its pill (Enter or leaving keeps it, Esc puts it back). */
export function InlineValueEdit() {
  useT();
  const ed = useEditor();
  const at = useUI((s) => s.inlineValueEdit);
  if (!at) return null;
  const close = () => {
    ed.ui.set({ inlineValueEdit: null });
    ed.focusCanvas();
  };
  return (
    <div className={styles.inline} style={{ left: at.x, top: at.y, width: at.width, height: at.height }} data-inline-value={at.field}>
      <TextInput
        label={at.field === "GAP" ? t("Gap") : t("Padding")}
        value={String(Math.round(at.value * 100) / 100)}
        autoFocus
        onCommit={(v) => {
          const n = evaluate(v);
          if (Number.isFinite(n)) commitInlineValue(ed, at.ref, at.field, n);
        }}
        onExit={close}
      />
    </div>
  );
}

/** The loupe's grid: 7 × 7 device pixels round the pointer, 8 CSS px a cell, in a 48 × 48 square (live Figma, 43.png). */
export const LOUPE_CELLS = 7;
const LOUPE_CELL = 8;
const LOUPE_BOX = 48;
/** The card's size and its offset from the pointer (below right of it, kept on the canvas). */
const CARD_W = 260, CARD_H = 64, CARD_OFFSET = 16, CARD_MARGIN = 2;

/**
 * The eyedropper's card (Pick color, ⌃C / I), as live Figma's (docs/research/chrome-cursors/figma-eyedropper.png): a
 * 260 × 64 card following the pointer with the canvas's pixels under it magnified (the middle one framed), the colour
 * there as a swatch and its hex, and "Click to sample". A click samples it (canvasTools.ts COLOR_PICK), Enter too
 * (Figma's eyedropper keys, atlas 07 §6); Esc cancels (the engine's tool goes back to Move).
 */
export function EyedropperLoupe() {
  const ed = useEditor();
  const tool = useTool(ed.store);
  return tool === "EYEDROPPER" ? <Loupe /> : null;
}

function Loupe() {
  useT();
  const ed = useEditor();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [at, setAt] = useState<{ left: number; top: number; hex: string } | null>(null);
  // Figma's card (atlas 07 §6): the colour in the colour format (Tab cycles it, CSS skipped); the second row names a
  // colour variable or fill style of that colour (⇧ applies it bound) or says what a click does.
  const [format, setFormat] = useColorFormat();
  const [shift, setShift] = useState(false);
  const assets = useLocalAssets();
  const hex = at?.hex ?? null;
  const rgb = useMemo(() => (hex ? { r: parseInt(hex.slice(0, 2), 16) / 255, g: parseInt(hex.slice(2, 4), 16) / 255, b: parseInt(hex.slice(4, 6), 16) / 255 } : null), [hex]);
  // (Read once per colour under the pointer, not per pointer move.)
  const match = useMemo(() => (rgb ? matchColor(assets, rgb) : null), [assets, rgb]);
  // Dev Mode's pick copies (no binding, no sample onto the selection).
  const dev = useUI((s) => s.mode === "dev");
  const choice = shift && !dev ? match : null;
  useEffect(() => {
    setEyedropperChoice(ed, choice);
    return () => setEyedropperChoice(ed, null);
  }, [ed, choice]);
  // The pointer over the canvas (canvas CSS px): Enter picks there, as a click would.
  const pointerAt = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (presentationHasKeys(ed, e.target)) return;  // a prototype playing over the editor has the keys
      if (e.key === "Shift") setShift(e.type === "keydown");
      if (e.key === "Enter" && e.type === "keydown" && pointerAt.current) {
        e.preventDefault();
        e.stopPropagation();
        const color = canvasColorAt(ed, pointerAt.current.x, pointerAt.current.y);
        if (color) applyPickedColor(ed, color);
        ed.setTool("MOVE");
      }
      if (e.key === "Tab" && e.type === "keydown") {
        e.preventDefault();
        e.stopPropagation();
        setFormat(nextEyedropperFormat(colorFormat()));
      }
    };
    window.addEventListener("keydown", key, true);
    window.addEventListener("keyup", key, true);
    return () => {
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("keyup", key, true);
    };
  }, [ed, setFormat]);
  useEffect(() => {
    const target = ed.canvas;
    if (!target) return;
    let frame = 0;
    let last: PointerEvent | null = null;
    const draw = () => {
      frame = 0;
      const e = last;
      const out = canvasRef.current;
      if (!e || !out) return;
      const r = target.getBoundingClientRect();
      pointerAt.current = { x: e.clientX - r.left, y: e.clientY - r.top };
      const px = canvasPixelsAround(ed, e.clientX - r.left, e.clientY - r.top, LOUPE_CELLS);
      if (!px) return;
      const ctx = out.getContext("2d");
      if (!ctx) return;
      ctx.putImageData(new ImageData(new Uint8ClampedArray(px.pixels), px.width, px.height), 0, 0);
      const mid = Math.floor(LOUPE_CELLS / 2) * 4 * (LOUPE_CELLS + 1);
      const hex = [px.pixels[mid], px.pixels[mid + 1], px.pixels[mid + 2]].map((c) => c.toString(16).padStart(2, "0")).join("").toUpperCase();
      // Below right of the pointer, kept on the canvas between the panels: slid left along its right edge (live Figma's
      // card sits 2–3 px off the right panel in 43.png), above the pointer where it would leave the bottom.
      const v = document.querySelector("[data-canvas-view]")?.getBoundingClientRect() ?? r;
      let left = e.clientX + CARD_OFFSET, top = e.clientY + CARD_OFFSET;
      if (left + CARD_W > v.right - CARD_MARGIN) left = Math.max(v.left + CARD_MARGIN, v.right - CARD_MARGIN - CARD_W);
      if (top + CARD_H > v.bottom - CARD_MARGIN) top = Math.max(v.top + CARD_MARGIN, e.clientY - CARD_OFFSET - CARD_H);
      setAt({ left, top, hex });
    };
    const onMove = (e: PointerEvent) => {
      last = e;
      if (!frame) frame = requestAnimationFrame(draw);
    };
    const onLeave = () => {
      last = null;
      pointerAt.current = null;
      setAt(null);
    };
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerleave", onLeave);
    return () => {
      cancelAnimationFrame(frame);
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerleave", onLeave);
    };
  }, [ed]);
  const grid = LOUPE_CELLS * LOUPE_CELL;
  const cell = (LOUPE_BOX - LOUPE_CELL) / 2;
  return (
    <div className={styles.loupe} style={at ? { left: at.left, top: at.top } : { display: "none" }} data-loupe="" data-hex={at ? `#${at.hex}` : undefined} aria-hidden>
      <div className={styles.loupePreview}>
        <canvas
          ref={canvasRef}
          width={LOUPE_CELLS}
          height={LOUPE_CELLS}
          className={styles.loupePixels}
          style={{ width: grid, height: grid, left: (LOUPE_BOX - grid) / 2, top: (LOUPE_BOX - grid) / 2 }}
        />
        <span className={styles.loupeCell} style={{ left: cell, top: cell, width: LOUPE_CELL, height: LOUPE_CELL }} />
      </div>
      <div className={styles.loupeRows}>
        <div className={styles.loupeRow}>
          <span className={styles.loupeLead}>
            <Swatch color={at ? `#${at.hex}` : "#000000"} size={16} className={styles.loupeSwatch} />
          </span>
          <span className={styles.loupeHex} data-format={format}>{rgb ? formatColor(rgb, format) : "#000000"}</span>
        </div>
        <div className={styles.loupeRow} data-chosen={choice ? "" : undefined}>
          <span className={styles.loupeLead}>
            <Icon name="24.interaction.click.small" className={styles.loupeIcon} />
          </span>
          {match && !dev ? (
            <>
              <span className={styles.loupeHint}>{match.name}</span>
              <span className={styles.loupeKey}>⇧</span>
            </>
          ) : (
            <span className={styles.loupeHint}>{ed.selectedNodes().length && !dev ? t("Click to sample") : t("Click to copy")}</span>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Figma's Nudge amount fields (atlas 21 §3.1, `NudgeAmountPicker`): Small nudge at least 0.1, Big nudge at least 1, no
 * upper bound; each field's own ↑ ↓ by 1, ⇧ by 10.
 */
export const NUDGE_FIELDS = [
  { key: "small", label: "Small nudge", min: 0.1 },
  { key: "big", label: "Big nudge", min: 1 },
] as const;

/**
 * Preferences › Nudge amount… (atlas 21 §3.1): Figma's draggable window, not a modal — 180 wide, opened at the window's
 * middle a third of the way down. Each committed value is kept at once (no Save); Enter in either field, Esc or × close
 * it.
 */
export function NudgeDialog() {
  const open = useUI((s) => !!s.nudgeDialog);
  return open ? <NudgeWindow /> : null;
}

function NudgeWindow() {
  useT();
  const ed = useEditor();
  const current = useUI((s) => s.nudge) ?? DEFAULT_NUDGE;
  const at = useMemo(() => new DOMRect(window.innerWidth / 2 - size["nudge-window"] / 2, window.innerHeight / 3, 0, 0), []);
  const close = () => {
    ed.ui.set({ nudgeDialog: false });
    ed.focusCanvas();
  };
  return (
    <FloatingPanel title={t("Nudge amount")} anchor={at} placement="bottom-start" gap={0} width={size["nudge-window"]} onClose={close}>
      <div className={styles.nudgeForm} data-nudge-window="">
        {NUDGE_FIELDS.map((f) => (
          <div key={f.key} className={styles.nudgeRow}>
            <span className={styles.rowLabel}>{t(f.label)}</span>
            <NumericInput
              data-nudge-input={f.key}
              label={t(f.label)}
              value={current[f.key]}
              min={f.min}
              step={1}
              bigStep={10}
              scrub={false}
              onChange={(v) => setNudge(ed, { ...current, [f.key]: Math.max(f.min, v) })}
              onExit={(r) => r === "enter" && close()}
            />
          </div>
        ))}
      </div>
    </FloatingPanel>
  );
}
