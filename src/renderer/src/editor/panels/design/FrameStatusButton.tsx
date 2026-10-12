/**
 * The status menu's rows and the Design panel header's status button (ours: editor/frameStatus.ts, docs/editor.md
 * "Frame status (ours)"). On the canvas the engine draws the status where Ready for dev shows and its click opens the
 * same rows (devmode/DevOverlays.tsx StatusMenu).
 */
import { MenuButton, type MenuEntry } from "@/ds";
import type { Guid } from "@/engine/codec";
import { useEditor, type EditorController } from "../../controller";
import { usePresence } from "../../multiplayer/presence";
import { FRAME_STATUS_COLOR, FRAME_STATUSES, frameStatusLabel, frameStatusOf, frameStatusTargets, setFrameStatus, type FrameStatus } from "../../frameStatus";
import styles from "./FrameStatus.module.css";

export const NO_STATUS = "none";

/** The status menu's rows: the statuses with their dots (the current one checked), then "No status". */
export function frameStatusMenu(current: FrameStatus | null, opts: { disabled?: boolean } = {}): MenuEntry[] {
  const disabled = opts.disabled || undefined;
  return [
    ...FRAME_STATUSES.map((s) => ({ id: s.id, label: s.label, swatch: FRAME_STATUS_COLOR[s.id], checked: s.id === current, disabled })),
    "-",
    { id: NO_STATUS, label: "No status", checked: current === null, disabled },
  ];
}

/** Whether a menu row is one of the status rows. */
export const isStatusRow = (id: string): boolean => id === NO_STATUS || FRAME_STATUSES.some((s) => s.id === id);

export function pickFrameStatus(ed: EditorController, ids: readonly Guid[], id: string): void {
  setFrameStatus(ed, ids, id === NO_STATUS ? null : (id as FrameStatus));
}

/** A status's dot and label. */
function Face({ status, text }: { status: FrameStatus | null; text: string }) {
  return (
    <>
      <span className={styles.dot} style={status ? { background: FRAME_STATUS_COLOR[status] } : undefined} aria-hidden />
      <span className={styles.text}>{text}</span>
    </>
  );
}

/** The Design panel header's status button (a frame or section's header): the current status, the menu under it. */
export function FrameStatusButton() {
  const ed = useEditor();
  const p = usePresence(ed);
  const viewer = p.shared && p.role === "viewer";
  const targets = frameStatusTargets(ed);
  if (!targets.length) return null;
  const list = targets.map((id) => frameStatusOf(ed, id));
  const mixed = !list.every((s) => s === list[0]);
  const status = mixed ? null : list[0];
  const text = mixed ? "Mixed" : status ? frameStatusLabel(status) : "Status";
  const chip = (
    <span className={styles.face} data-frame-status={mixed || !status ? NO_STATUS : status}>
      <Face status={status} text={text} />
    </span>
  );
  if (viewer) return chip;
  return (
    <MenuButton label="Status" entries={() => frameStatusMenu(status)} className={styles.headerButton} onSelect={(id) => pickFrameStatus(ed, targets, id)}>
      {chip}
    </MenuButton>
  );
}
