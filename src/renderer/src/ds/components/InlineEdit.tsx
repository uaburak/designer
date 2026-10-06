import { useLayoutEffect, useRef, useState, type HTMLAttributes } from "react";
import { cx } from "../util/cx";
import { exitKey } from "../util/selectAll";
import type { ExitReason } from "../types";
import styles from "./InlineEdit.module.css";

export interface InlineEditProps extends Omit<HTMLAttributes<HTMLSpanElement>, "onChange"> {
  /** aria-label of the field ("Rename") */
  label: string;
  value: string;
  /** Show the field (controlled) */
  editing: boolean;
  /** Asks to start (double-click, when `editOnDoubleClick`) or reports that editing ended */
  onEditingChange?: (editing: boolean) => void;
  /** A kept edit: trimmed, not empty, and different from `value` */
  onCommit: (next: string) => void;
  /** Editing ended with nothing kept (Esc, empty, or unchanged) */
  onCancel?: () => void;
  /** Enter, Esc, Tab or blur, after the commit */
  onExit?: (r: ExitReason) => void;
  /** What is selected when the field opens: all of it, or the name without its extension ("Logo" of "Logo.svg") */
  select?: "all" | "name" | "end";
  /** Double-click the text to start renaming (default false: the parent decides, e.g. F2 or the context menu) */
  editOnDoubleClick?: boolean;
  placeholder?: string;
  maxLength?: number;
}

/**
 * Rename in place (files, folders, pages, layers): the text in the current
 * font, swapped for a field in the same font and box when `editing`, so
 * nothing jumps. The field opens focused with the text selected; Enter, Tab
 * or leaving keeps it, Esc puts it back. Keys stop at the field.
 */
export function InlineEdit({ label, value, editing, onEditingChange, onCommit, onExit, onCancel, select = "all", editOnDoubleClick, placeholder, maxLength, className, ...rest }: InlineEditProps) {
  return (
    <span data-ds="InlineEdit" data-editing={editing || undefined} className={cx(styles.root, className)} {...rest}>
      {editing ? (
        <Field label={label} value={value} select={select} placeholder={placeholder} maxLength={maxLength} onDone={(next, reason) => {
          if (next !== null) onCommit(next);
          else onCancel?.();
          onEditingChange?.(false);
          onExit?.(reason);
        }} />
      ) : (
        <span className={styles.text} onDoubleClick={editOnDoubleClick ? (e) => { e.stopPropagation(); onEditingChange?.(true); } : undefined}>
          {value || placeholder}
        </span>
      )}
    </span>
  );
}

/** The selection range `select` asks for. */
export function renameSelection(value: string, select: "all" | "name" | "end"): [number, number] {
  if (select === "end") return [value.length, value.length];
  if (select === "name") {
    const dot = value.lastIndexOf(".");
    if (dot > 0) return [0, dot];
  }
  return [0, value.length];
}

function Field({ label, value, select, placeholder, maxLength, onDone }: { label: string; value: string; select: "all" | "name" | "end"; placeholder?: string; maxLength?: number; onDone: (next: string | null, reason: ExitReason) => void }) {
  const [draft, setDraft] = useState(value);
  const input = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  const reason = useRef<ExitReason>("blur");
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    el.setSelectionRange(...renameSelection(el.value, select));
    // Mount only: the selection is set once when the field opens
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const finish = (keep: boolean) => {
    if (done.current) return;
    done.current = true;
    const next = draft.trim();
    onDone(keep && next && next !== value ? next : null, reason.current);
  };
  return (
    <>
      {/* The hidden twin sizes the field to its text (min: the original) */}
      <span className={styles.sizer} aria-hidden>{(draft.length >= value.length ? draft : value) || placeholder || " "}</span>
      <input
        ref={input}
        aria-label={label}
        className={styles.input}
        // size 1: no intrinsic width of its own — the twin sizes it
        size={1}
        value={draft}
        placeholder={placeholder}
        maxLength={maxLength}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          const r = exitKey(e);
          if (!r) return;
          reason.current = r;
          if (r === "enter" || r === "escape") e.preventDefault();
          finish(r !== "escape");
        }}
        onBlur={() => finish(true)}
      />
    </>
  );
}
