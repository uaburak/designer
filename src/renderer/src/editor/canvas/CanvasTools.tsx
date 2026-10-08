/**
 * Round 8's canvas pieces in React (editor/canvasTools.ts has the logic): an auto-layout bar's value edited in place
 * (REQUEST_INLINE_EDIT), the eyedropper's loupe (the canvas's pixels under the pointer, magnified, with the colour's
 * hex), and Preferences › Nudge amount….
 */
import { useEffect, useRef, useState } from "react";
import { Button, Dialog, evaluate, TextInput } from "@/ds";
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

const LOUPE_CELLS = 11;
const LOUPE_CELL = 8;

/** The eyedropper's loupe: 11 × 11 screen pixels around the pointer, magnified, the middle one framed, its hex below. */
export function EyedropperLoupe() {
  const ed = useEditor();
  const tool = useTool(ed.store);
  return tool === "EYEDROPPER" ? <Loupe /> : null;
}

function Loupe() {
  const ed = useEditor();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [at, setAt] = useState<{ x: number; y: number; hex: string } | null>(null);
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
      const image = new ImageData(new Uint8ClampedArray(px.pixels), px.width, px.height);
      const tmp = document.createElement("canvas");
      tmp.width = px.width;
      tmp.height = px.height;
      tmp.getContext("2d")?.putImageData(image, 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, out.width, out.height);
      ctx.drawImage(tmp, 0, 0, out.width, out.height);
      const mid = Math.floor(LOUPE_CELLS / 2) * 4 * (LOUPE_CELLS + 1);
      const hex = [px.pixels[mid], px.pixels[mid + 1], px.pixels[mid + 2]].map((c) => c.toString(16).padStart(2, "0")).join("").toUpperCase();
      setAt({ x: e.clientX, y: e.clientY, hex });
    };
    const onMove = (e: PointerEvent) => {
      last = e;
      if (!frame) frame = requestAnimationFrame(draw);
    };
    const onLeave = () => setAt(null);
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerleave", onLeave);
    return () => {
      cancelAnimationFrame(frame);
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerleave", onLeave);
    };
  }, [ed]);
  const size = LOUPE_CELLS * LOUPE_CELL;
  return (
    <div className={styles.loupe} style={at ? { left: at.x + 16, top: at.y + 16 } : { display: "none" }} data-loupe="" aria-hidden>
      <canvas ref={canvasRef} width={size} height={size} className={styles.loupePixels} />
      <span className={styles.loupeCell} style={{ left: Math.floor(LOUPE_CELLS / 2) * LOUPE_CELL, top: Math.floor(LOUPE_CELLS / 2) * LOUPE_CELL, width: LOUPE_CELL, height: LOUPE_CELL }} />
      {at && <span className={styles.loupeHex}>#{at.hex}</span>}
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
