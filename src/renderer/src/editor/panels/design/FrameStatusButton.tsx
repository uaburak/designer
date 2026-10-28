/**
 * The status menu's rows and the Design panel header's status button (ours: editor/frameStatus.ts, docs/editor.md
 * "Frame status (ours)"). On the canvas the engine draws the status where Ready for dev shows and its click opens the
 * same rows (devmode/DevOverlays.tsx StatusMenu).
 */
import { Icon, MenuButton, type MenuEntry } from "@/ds";
import type { Guid } from "@/engine/codec";
import { useEditor, type EditorController } from "../../controller";
import { usePresence } from "../../multiplayer/presence";
import { FRAME_STATUS_COLOR, FRAME_STATUSES, frameStatusLabel, frameStatusOf, frameStatusTargets, setFrameStatus, type FrameStatus } from "../../frameStatus";
import { t, useT } from "@/i18n";
import styles from "./FrameStatus.module.css";

export const NO_STATUS = "none";

/**
 * The status menu's rows (the owner, 2026-10-28): each status with its own glyph in its colour — no check column, no
 * dots — the row lit in that colour under the pointer; then "No status".
 */
export function frameStatusMenu(opts: { disabled?: boolean } = {}): MenuEntry[] {
  const disabled = opts.disabled || undefined;
  return [
    ...FRAME_STATUSES.map((s) => ({ id: s.id, label: t(s.label), icon: `24.status.${s.id}` as const, tint: FRAME_STATUS_COLOR[s.id], disabled })),
    "-",
    { id: NO_STATUS, label: t("No status"), disabled },
  ];
}

/** Whether a menu row is one of the status rows. */
export const isStatusRow = (id: string): boolean => id === NO_STATUS || FRAME_STATUSES.some((s) => s.id === id);

export function pickFrameStatus(ed: EditorController, ids: readonly Guid[], id: string): void {
  setFrameStatus(ed, ids, id === NO_STATUS ? null : (id as FrameStatus));
}

/**
 * A status's glyph and label: the glyph white in a 16 square of the status's colour, as the canvas draws it (the owner,
 * 2026-10-28: Figma's Ready for dev button); no status, the `</>` alone.
 */
function Face({ status, text }: { status: FrameStatus | null; text: string }) {
  return (
    <>
      <span className={styles.glyph} style={status ? { background: FRAME_STATUS_COLOR[status] } : undefined} aria-hidden>
        <Icon name={status ? `24.status.${status}` : "24.dev-brackets"} size={24} />
      </span>
      <span className={styles.text}>{text}</span>
    </>
  );
}

/**
 * The Design panel header's status button (a frame or section's header): the current status, the menu under it. It is
 * the header's Ready for dev button too (Ready to Dev is one of the statuses), so the row shows no `</>` beside it.
 */
export function FrameStatusButton() {
  useT();
  const ed = useEditor();
  const p = usePresence(ed);
  const viewer = p.shared && p.role === "viewer";
  const targets = frameStatusTargets(ed);
  if (!targets.length) return null;
  const list = targets.map((id) => frameStatusOf(ed, id));
  const mixed = !list.every((s) => s === list[0]);
  const status = mixed ? null : list[0];
  const text = mixed ? t("Mixed") : status ? t(frameStatusLabel(status)) : t("Status");
  const chip = (
    <span className={styles.face} data-frame-status={mixed || !status ? NO_STATUS : status}>
      <Face status={status} text={text} />
    </span>
  );
  if (viewer) return chip;
  return (
    <MenuButton label={t("Status")} entries={() => frameStatusMenu()} className={styles.headerButton} onSelect={(id) => pickFrameStatus(ed, targets, id)}>
      {chip}
    </MenuButton>
  );
}
