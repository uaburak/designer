/**
 * Frame status (ours, not Figma's — docs/editor.md "Frame status (ours)"): the owner's workflow status on a top-level
 * frame or section (and a frame inside a section). It replaces Ready for dev's own indicator: the engine draws it in the
 * frame's title where Ready for dev shows (render/Overlay.cpp, Editor::workflowStatus), and a click there opens the
 * status menu (devmode/DevOverlays.tsx StatusMenu); the Design panel's header has the same menu
 * (panels/design/FrameStatusButton.tsx).
 *
 * Stored in the node's `pluginData` under the reserved plugin ID `designer.workflow` (workflowStatus.ts), with Figma's
 * `sectionStatusInfo` kept in step (Ready to Dev ↔ Ready for dev, Done ↔ Completed) so Dev Mode keeps working — both in
 * one undo step through devStatus.ts `setDevStatusOf`. Plugins never see that plugin ID (plugins/api/nodes.ts).
 */
import type { Guid, NodeChange } from "@/engine/codec";
import type { EditorController } from "./controller";
import { setDevStatusOf } from "./devStatus";
import { presenceOf } from "./multiplayer/presence";
import { CHANGE_TRACKED, devStatusFor, statusIn, statusSince, type FrameStatus, type PluginDataEntry } from "./workflowStatus";

export { FRAME_STATUS_COLOR, FRAME_STATUSES, frameStatusLabel, statusIn, WORKFLOW_KEY, WORKFLOW_PLUGIN_ID, type FrameStatus } from "./workflowStatus";

type Row = NodeChange & {
  pluginData?: PluginDataEntry[];
  sectionStatusInfo?: { status?: string; lastUpdateUnixTimestamp?: number } | null;
  editInfo?: { lastEditedAt?: number } | null;
  resizeToFit?: boolean;
};

/** A node's status: ours in pluginData, else the one Figma's Ready for dev stands for. */
export function frameStatusOf(ed: EditorController, id: Guid): FrameStatus | null {
  if (ed.engine.destroyed) return null;
  const r = ed.engine.readNode(id, { fields: ["pluginData", "sectionStatusInfo"] }) as Row | null;
  return statusIn(r?.pluginData, r?.sectionStatusInfo?.status);
}

/** When a design's status was set (unix seconds; its pluginData `since`, else Figma's sectionStatusInfo), or null. */
export function frameStatusSince(ed: EditorController, id: Guid): number | null {
  if (ed.engine.destroyed) return null;
  const r = ed.engine.readNode(id, { fields: ["pluginData", "sectionStatusInfo"] }) as Row | null;
  return statusSince(r?.pluginData, r?.sectionStatusInfo);
}

/**
 * Whether a design was edited since its status was set — Done, R to Merge or Ready to Dev (the owner, 2026-10-28; the
 * engine's Editor::workflowChanged draws its Changed square).
 */
export function frameStatusChanged(ed: EditorController, id: Guid): boolean {
  if (ed.engine.destroyed) return false;
  const r = ed.engine.readNode(id, { fields: ["pluginData", "sectionStatusInfo", "editInfo"] }) as Row | null;
  const status = statusIn(r?.pluginData, r?.sectionStatusInfo?.status);
  if (!status || !CHANGE_TRACKED.has(status)) return false;
  const since = statusSince(r?.pluginData, r?.sectionStatusInfo);
  return since !== null && (r?.editInfo?.lastEditedAt ?? 0) > since;
}

const FRAMEISH = new Set(["FRAME", "SECTION", "SYMBOL", "INSTANCE"]);

/** Whether a node can carry a status: a frame, section, component or instance on the page or directly in a section. */
export function canHaveStatus(ed: EditorController, id: Guid): boolean {
  if (ed.engine.destroyed) return false;
  const r = ed.engine.readNode(id, { fields: ["type", "parentIndex", "resizeToFit"] }) as Row | null;
  if (!r) return false;
  const n = ed.withRealType(r) as Row;
  if (!FRAMEISH.has(n.type ?? "")) return false;
  const parent = n.parentIndex?.guid;
  if (parent === ed.store.page) return true;
  const p = parent ? (ed.withRealType(ed.engine.readNode(parent, { fields: ["type"] }) as NodeChange) as NodeChange) : null;
  return p?.type === "SECTION";
}

/** The selected nodes a status applies to (all of them, or none). */
export function frameStatusTargets(ed: EditorController): Guid[] {
  const sel = ed.selection;
  return sel.length && sel.every((id) => canHaveStatus(ed, id)) ? [...sel] : [];
}

/** Viewers ("can view" in a shared file) see statuses but don't change them. */
export function canSetStatus(ed: EditorController): boolean {
  const p = presenceOf(ed)?.state;
  return !(p?.shared && p.role === "viewer");
}

/**
 * Sets (or, with null, removes) the status of these nodes — one undo step, "Set status": ours in pluginData and
 * Figma's sectionStatusInfo with it (Ready to Dev: Ready for dev, Done: Completed, others: none), reported to the
 * file's server as Ready for dev's changes are. Works in Dev Mode too (the engine lets Dev Mode write pluginData).
 */
export function setFrameStatus(ed: EditorController, ids: readonly Guid[], status: FrameStatus | null): void {
  if (!ids.length || ed.engine.destroyed || !canSetStatus(ed)) return;
  setDevStatusOf(ed, ids, devStatusFor(status), { workflow: status });
}
