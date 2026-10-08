/**
 * Dev Mode statuses set from Design (help.figma.com 26781702258583 "Dev Mode statuses and notifications": "select a
 * section, frame, or component … click Mark as ready for dev"; the status menu's "Mark as completed", "Remove
 * status"). Stored as the schema's `sectionStatusInfo` (BUILD = "Ready for dev", COMPLETED) on the design, which the
 * developer preview viewer lists ("Ready for development") and shows in Inspect. Figma offers it on the canvas label
 * and the toolbar; here it is in the canvas menu (unverified placement).
 */
import type { Guid, NodeChange, NodeFields } from "@/engine/codec";
import type { EditorController } from "./controller";

type StatusNode = NodeChange & { sectionStatusInfo?: { status?: string } };

/** The selected designs a status applies to: top-level frames, sections, components (and frames inside sections). */
export function statusTargets(ed: EditorController): Guid[] {
  if (ed.engine.destroyed || !ed.selection.length) return [];
  const page = ed.store.page;
  const rows = ed.engine.readNodes(ed.selection, { fields: ["type", "parentIndex", "resizeToFit", "sectionStatusInfo"] }) as (StatusNode & { resizeToFit?: boolean })[];
  const out: Guid[] = [];
  for (const r of rows) {
    const n = ed.withRealType(r) as typeof r;
    const designish = (n.type === "FRAME" && !n.resizeToFit) || n.type === "SECTION" || n.type === "SYMBOL";
    if (!designish) return [];
    const parent = n.parentIndex?.guid;
    if (parent !== page) {
      const p = parent ? (ed.withRealType(ed.engine.readNode(parent, { fields: ["type"] }) as NodeChange) as NodeChange) : null;
      if (p?.type !== "SECTION") return [];
    }
    out.push(n.guid);
  }
  return out;
}

/** The status the targets share ("BUILD", "COMPLETED"), "mixed", or null. */
export function statusOfTargets(ed: EditorController, ids: readonly Guid[]): string | null {
  if (!ids.length) return null;
  const rows = ed.engine.readNodes(ids, { fields: ["sectionStatusInfo"] }) as StatusNode[];
  const list = rows.map((r) => r?.sectionStatusInfo?.status ?? "NONE");
  const first = list[0];
  if (list.some((s) => s !== first)) return "mixed";
  return first === "NONE" ? null : first;
}

/** Sets (or, with null, removes) the targets' status — one undo step. */
export function setDevStatus(ed: EditorController, status: "BUILD" | "COMPLETED" | null): void {
  const ids = statusTargets(ed);
  if (!ids.length) return;
  const before = statusOfTargets(ed, ids);
  const info = status
    ? { status, lastUpdateUnixTimestamp: Math.floor(Date.now() / 1000), ...(before && before !== "mixed" && before !== status ? { prevStatus: before } : {}) }
    : null;
  const label = status === "BUILD" ? "Mark as ready for dev" : status === "COMPLETED" ? "Mark as completed" : "Remove status";
  ed.setProps(ids, { sectionStatusInfo: info } as unknown as NodeFields, label);
}
