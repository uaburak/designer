/**
 * Round 8's canvas pieces in React (editor/canvasTools.ts has the logic): an auto-layout bar's value edited in place
 * (REQUEST_INLINE_EDIT), the eyedropper's card (the canvas's pixels under the pointer, magnified, the colour's swatch
 * and hex, "Click to sample"), and Preferences › Nudge amount….
 */
import { useEffect, useRef, useState } from "react";
import { Button, Dialog, evaluate, Icon, Swatch, TextInput } from "@/ds";
import { useTool } from "@/engine/hooks";
import { useEditor } from "../controller";
import { useUI } from "../hooks";
import { canvasPixelsAround, commitInlineValue, DEFAULT_NUDGE, setNudge } from "../canvasTools";
import styles from "./CanvasTools.module.css";

/** The padding or gap value typed over its pill (Enter or leaving keeps it, Esc puts it back). */
export function InlineValueEdit() {
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
        label={at.field === "GAP" ? "Gap" : "Padding"}
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
const CARD_W = 260, CARD_H = 64, CARD_OFFSET = 16, CARD_MARGIN = 4;

/**
 * The eyedropper's card (Pick color, ⌃C / I), as live Figma's (docs/research/chrome-cursors/figma-eyedropper.png): a
 * 260 × 64 card following the pointer with the canvas's pixels under it magnified (the middle one framed), the colour
 * there as a swatch and its hex, and "Click to sample". A click samples it (canvasTools.ts COLOR_PICK); Esc cancels
 * (the engine's tool goes back to Move).
 */
export function EyedropperLoupe() {
  const ed = useEditor();
  const tool = useTool(ed.store);
  return tool === "EYEDROPPER" ? <Loupe /> : null;
}

function Loupe() {
  const ed = useEditor();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [at, setAt] = useState<{ left: number; top: number; hex: string } | null>(null);
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
          <span className={styles.loupeHex}>#{at?.hex ?? "000000"}</span>
        </div>
        <div className={styles.loupeRow}>
          <span className={styles.loupeLead}>
            <Icon name="24.interaction.click.small" className={styles.loupeIcon} />
          </span>
          <span className={styles.loupeHint}>Click to sample</span>
        </div>
      </div>
    </div>
  );
}

/** Preferences › Nudge amount…: Small nudge (the arrows) and Big nudge (⇧ arrows), page units (unverified wording). */
export function NudgeDialog() {
  const open = useUI((s) => !!s.nudgeDialog);
  return open ? <NudgeForm /> : null;
}

function NudgeForm() {
  const ed = useEditor();
  const current = useUI((s) => s.nudge) ?? DEFAULT_NUDGE;
  const [small, setSmall] = useState(String(current.small));
  const [big, setBig] = useState(String(current.big));
  const close = () => {
    ed.ui.set({ nudgeDialog: false });
    ed.focusCanvas();
  };
  const s = evaluate(small), b = evaluate(big);
  const valid = Number.isFinite(s) && s > 0 && Number.isFinite(b) && b > 0;
  return (
    <Dialog
      title="Nudge amount"
      open
      onClose={close}
      footer={
        <>
          <Button variant="secondary" onClick={close}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!valid}
            onClick={() => {
              setNudge(ed, { small: s, big: b });
              close();
            }}
          >
            Save
          </Button>
        </>
      }
    >
      <div className={styles.form}>
        <div className={styles.row}>
          <span className={styles.rowLabel}>Small nudge</span>
          <TextInput label="Small nudge" value={small} onChange={setSmall} autoFocus />
        </div>
        <div className={styles.row}>
          <span className={styles.rowLabel}>Big nudge</span>
          <TextInput label="Big nudge" value={big} onChange={setBig} />
        </div>
      </div>
    </Dialog>
  );
}
