/**
 * Round 10's pieces for the Figma menu's commands (docs/editor.md "Round 10 — Menus, commands, left side and toolbar"):
 * File › Move to project… (a dialog of the workspace's places), Cursor chat (/ : a bubble at the pointer), View ›
 * Memory usage (a chip at the canvas's bottom left), Vector › Simplify vector (a slider, help.figma.com "Simplify a
 * vector path") and Offset vector (Amount, Join, ✓, "Offset a vector path"). Their looks are unverified (no live
 * capture); they use the DS's own parts.
 */
import { useEffect, useRef, useState } from "react";
import { Button, Dialog, IconButton, NumericInput, RadioGroup, SegmentedControl, showToast } from "@/ds";
import { useEditor } from "../controller";
import { useUI } from "../hooks";
import { lastPointer } from "../commands";
import { fileOps } from "../objectCommands";
import styles from "./CommandOverlays.module.css";

export function CommandOverlays() {
  const ed = useEditor();
  // The pointer over the canvas, for Cursor chat.
  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (e.target === ed.canvas) lastPointer.set(ed, { x: e.clientX, y: e.clientY });
    };
    window.addEventListener("pointermove", move, { passive: true });
    return () => window.removeEventListener("pointermove", move);
  }, [ed]);
  const move = useUI((s) => !!s.moveFileDialog);
  const chat = useUI((s) => s.cursorChat ?? null);
  const memory = useUI((s) => !!s.memoryUsage);
  const op = useUI((s) => s.vectorOp ?? null);
  return (
    <>
      {move && <MoveFileDialog />}
      {chat && <CursorChat at={chat} />}
      {memory && <MemoryUsage />}
      {op && <VectorOperation op={op} />}
    </>
  );
}

/** File › Move to project…: Drafts and the workspace's folders; the file moves to the one picked. */
function MoveFileDialog() {
  const ed = useEditor();
  const ops = fileOps(ed);
  const [places, setPlaces] = useState<{ id: string | null; name: string }[] | null>(null);
  const [to, setTo] = useState<string>("");
  useEffect(() => {
    let live = true;
    void ops?.folders().then((list) => live && setPlaces(list));
    return () => {
      live = false;
    };
  }, [ops]);
  const close = () => {
    ed.ui.set({ moveFileDialog: false });
    ed.focusCanvas();
  };
  const value = (id: string | null) => id ?? "drafts";
  return (
    <Dialog
      title="Move to project"
      open
      onClose={close}
      footer={
        <>
          <Button variant="secondary" onClick={close}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!to || !ops}
            onClick={() => {
              const place = places?.find((p) => value(p.id) === to);
              if (!ops || !place) return;
              void ops.moveTo(place.id).then(() => showToast({ message: `Moved to ${place.name}` }));
              close();
            }}
          >
            Move
          </Button>
        </>
      }
    >
      <div className={styles.places} data-move-file="">
        {places ? <RadioGroup label="Projects" value={to} options={places.map((p) => ({ value: value(p.id), label: p.name }))} onChange={setTo} /> : null}
      </div>
    </Dialog>
  );
}

/** Cursor chat (/): a bubble by the pointer; Enter sends (it stays a moment), Esc closes. */
function CursorChat({ at }: { at: { x: number; y: number } }) {
  const ed = useEditor();
  const [text, setText] = useState("");
  const [sent, setSent] = useState<string | null>(null);
  const [pos, setPos] = useState(at);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    const move = (e: PointerEvent) => setPos({ x: e.clientX, y: e.clientY });
    window.addEventListener("pointermove", move, { passive: true });
    return () => window.removeEventListener("pointermove", move);
  }, []);
  useEffect(() => {
    if (sent === null) return;
    const t = window.setTimeout(() => ed.ui.set({ cursorChat: null }), 4000);
    return () => window.clearTimeout(t);
  }, [sent, ed]);
  const close = () => {
    ed.ui.set({ cursorChat: null });
    ed.focusCanvas();
  };
  return (
    <div className={styles.chat} style={{ left: pos.x + 12, top: pos.y + 12 }} data-cursor-chat="">
      {sent !== null ? (
        <span className={styles.chatText}>{sent}</span>
      ) : (
        <input
          ref={input}
          className={styles.chatInput}
          aria-label="Cursor chat"
          placeholder="Say something"
          value={text}
          maxLength={50}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => sent === null && close()}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Escape") close();
            else if (e.key === "Enter" && text.trim()) setSent(text.trim());
          }}
        />
      )}
    </div>
  );
}

/** View › Memory usage: the engine's memory and the page's JS heap, at the canvas's bottom left, every second. */
function MemoryUsage() {
  const ed = useEditor();
  const read = () => {
    const heap = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0;
    return (ed.engine.destroyed ? 0 : ed.engine.memoryBytes()) + heap;
  };
  const [bytes, setBytes] = useState(read);
  useEffect(() => {
    const t = window.setInterval(() => setBytes(read()), 1000);
    return () => window.clearInterval(t);
    // read() reads the engine
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ed]);
  const r = ed.canvas?.getBoundingClientRect();
  return (
    <div className={styles.memory} style={r ? { left: r.left + 12, top: r.bottom - 36 } : undefined} role="status" data-memory-usage="">
      <span className={styles.memoryLabel}>Memory usage</span>
      <span>{Math.round(bytes / (1024 * 1024))} MB</span>
    </div>
  );
}

/** Simplify vector (a slider, 0–100) / Offset vector (Amount, Join): ✓ or Enter applies (one undo step), Esc closes. */
function VectorOperation({ op }: { op: "simplify" | "offset" }) {
  const ed = useEditor();
  const [amount, setAmount] = useState(op === "simplify" ? 50 : 10);
  const [join, setJoin] = useState<"MITER" | "ROUND">("MITER");
  const close = () => {
    ed.ui.set({ vectorOp: null });
    ed.focusCanvas();
  };
  const apply = () => {
    if (op === "simplify") ed.engine.command("VECTOR_SIMPLIFY", { amount: amount / 100 });
    else ed.engine.command("VECTOR_OFFSET", { amount, join });
    close();
  };
  const r = ed.canvas?.getBoundingClientRect();
  return (
    <div
      className={styles.vectorOp}
      role="dialog"
      aria-label={op === "simplify" ? "Simplify vector" : "Offset vector"}
      data-vector-op={op}
      style={r ? { left: r.left + r.width / 2, top: r.bottom - 76 } : undefined}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") close();
        else if (e.key === "Enter") apply();
      }}
    >
      {op === "simplify" ? (
        <label className={styles.slider}>
          <span className={styles.caption}>Simplify</span>
          <input type="range" min={0} max={100} value={amount} aria-label="Simplify" autoFocus onChange={(e) => setAmount(Number(e.target.value))} />
        </label>
      ) : (
        <>
          <span className={styles.caption}>Amount</span>
          <NumericInput label="Amount" value={amount} min={-1000} max={1000} onChange={(v) => setAmount(v)} className={styles.amount} />
          <span className={styles.caption}>Join:</span>
          <SegmentedControl
            label="Join"
            value={join}
            options={[
              { value: "MITER", icon: "24.join.miter", tooltip: "Square" },
              { value: "ROUND", icon: "24.join.round", tooltip: "Round" },
            ]}
            onChange={(v) => setJoin(v as "MITER" | "ROUND")}
          />
        </>
      )}
      <IconButton icon="24.check" label="Apply" onClick={apply} />
      <IconButton icon="24.close.small" label="Close" onClick={close} />
    </div>
  );
}
