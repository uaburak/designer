/**
 * A design's status as the chrome shows it (workflowStatus.ts `statusShown`): the owner's label with its colour — a
 * filled chip (`chip`: Inspect's header, focus view) or its glyph in a square of its colour and the label (`dot`: lists
 * and cards — the canvas's square, the owner, 2026-10-28) — and Figma's yellow "Changed" beside Ready to Dev edited since. Shared by the editor and the viewer
 * (src/viewer: Dev Mode's panels and developer previews).
 */
import type { CSSProperties, MouseEvent } from "react";
import { Icon } from "@/ds";
import { t, useT } from "@/i18n";
import { statusShown, type FrameStatus } from "../workflowStatus";
import styles from "./StatusTag.module.css";

export interface StatusTagProps {
  workflow: FrameStatus;
  /** Figma's status as read ("CHANGED" adds the marker) */
  dev?: string | null;
  variant: "chip" | "dot";
  /** A chip that opens the status menu */
  onClick?: (e: MouseEvent<HTMLButtonElement>) => void;
}

export function StatusTag({ workflow, dev, variant, onClick }: StatusTagProps) {
  useT();
  const shown = statusShown(workflow, dev);
  const s = { ...shown, label: t(shown.label) };
  const changed = s.changed && (
    <span className={variant === "chip" ? styles.changedChip : styles.changed} data-status-changed="">
      {t("Changed")}
    </span>
  );
  if (variant === "dot")
    return (
      <span className={styles.tag} data-status={workflow}>
        <span className={styles.glyph} style={{ background: s.color }} aria-hidden>
          <Icon name={`24.status.${workflow}`} size={24} />
        </span>
        <span className={styles.label}>{s.label}</span>
        {changed}
      </span>
    );
  const chip = { "--status-color": s.color } as CSSProperties;
  return (
    <span className={styles.tag} data-status={workflow}>
      {onClick ? (
        <button type="button" className={styles.chip} style={chip} data-status-chip={workflow} onClick={onClick}>
          {s.label}
        </button>
      ) : (
        <span className={styles.chip} style={chip} data-status-chip={workflow}>
          {s.label}
        </span>
      )}
      {changed}
    </span>
  );
}
