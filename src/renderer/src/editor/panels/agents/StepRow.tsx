/** A step on its line (a step group's, a task card's): its icon, what it did, and quieter what it said of it. */
import { useState } from "react";
import { Icon, Spinner, cx, tooltipProps } from "@/ds";
import { readableError } from "@shared/agents/errors";
import { toolLabel } from "../../agents/service";
import { toolActiveLabel, type ToolPart } from "../../agents/activity";
import styles from "./Agents.module.css";

/**
 * A step's detail on its line: the first line of what the tool said, short — a JSON answer by its own "summary" (else
 * nothing: its fields aren't words).
 */
export function stepDetail(summary: string | undefined): string {
  const line = (summary ?? "").split("\n").find((l) => l.trim())?.trim() ?? "";
  if (!/^[[{]/.test(line)) return line.slice(0, 140);
  try {
    const v = JSON.parse(line) as { summary?: unknown };
    return typeof v?.summary === "string" ? v.summary.slice(0, 140) : "";
  } catch {
    return "";
  }
}

/**
 * A step in its group: ✓ and what it did, a spinner and what it does, and quieter what it said of it (its whole text on
 * hover); a failed one opens to its whole error.
 */
export function ToolRow({ p }: { p: ToolPart }) {
  const [open, setOpen] = useState(false);
  const icon = <span className={styles.toolIcon}>{p.state === "running" ? <Spinner size={16} /> : p.state === "error" ? <Icon name="16.warning" /> : <Icon name="16.check" />}</span>;
  if (p.state !== "error" || !p.summary) {
    const detail = p.state === "running" ? "" : stepDetail(p.summary);
    return (
      <div className={styles.tool} data-tool={p.name} data-tool-state={p.state} {...tooltipProps(p.summary)}>
        {icon}
        <span className={cx(styles.toolLabel, detail && styles.toolLabelLead)}>{p.state === "running" ? toolActiveLabel(p.name) : toolLabel(p.name)}</span>
        {detail && <span className={styles.toolDetail} data-tool-detail="">{detail}</span>}
      </div>
    );
  }
  return (
    <div className={styles.toolFailed} data-tool={p.name} data-tool-state={p.state}>
      <button type="button" className={styles.tool} data-tool-state={p.state} aria-expanded={open} onClick={() => setOpen(!open)} data-tool-toggle="">
        {icon}
        <span className={styles.toolLabel}>{toolLabel(p.name)}</span>
        <span className={cx(styles.toolChevron, open && styles.toolChevronOpen)}><Icon name="16.chevron.right" /></span>
      </button>
      {open && <div className={styles.toolError} data-tool-error="">{readableError(p.summary)}</div>}
    </div>
  );
}
