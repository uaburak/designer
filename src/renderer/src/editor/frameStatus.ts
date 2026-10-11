/**
 * Frame status (ours, not Figma's — docs/editor.md "Frame status (ours)"): a workflow status on a top-level frame or
 * section (and a frame inside a section), shown as a chip over the frame's top-right corner on the canvas and in the
 * Design panel's header. Not Figma's `sectionStatusInfo` (Ready for dev, a fixed enum): stored in the node's
 * `pluginData` (schema 204) under the reserved plugin ID `designer.workflow`, key `status` — written through the
 * engine's normal property path, so it is journaled, one undo step ("Set status"), copied with the layer and synced
 * like any field. Plugins never see that plugin ID (plugins/api/nodes.ts).
 */
import type { Guid, NodeChange, NodeFields } from "@/engine/codec";
import type { EditorController } from "./controller";
import { modeOf } from "./devmode/devMode";
import { presenceOf } from "./multiplayer/presence";

export const WORKFLOW_PLUGIN_ID = "designer.workflow";
export const WORKFLOW_KEY = "status";

/** The owner's list, in his order. */
export const FRAME_STATUSES = [
  { id: "done", label: "Done" },
  { id: "r-to-merge", label: "R to Merge" },
  { id: "ready-to-dev", label: "Ready to Dev" },
  { id: "to-be-done", label: "To be done" },
  { id: "process", label: "Process" },
  { id: "revised", label: "Revised" },
  { id: "cancelled", label: "Cancelled" },
] as const;

export type FrameStatus = (typeof FRAME_STATUSES)[number]["id"];

/**
 * Each status's colour, the dot before its label (the owner's mapping, 2026-10-12; ds tokens, light and dark): Done
 * blue, R to Merge cyan, Ready to Dev Dev Mode's green, Process red, To be done orange, Revised purple, Cancelled grey
 * (and its chip muted, like disabled).
 */
export const FRAME_STATUS_COLOR: Record<FrameStatus, string> = {
  done: "var(--figma-color-bg-brand)",
  "r-to-merge": "var(--ds-color-folder-teal)",
  "ready-to-dev": "var(--figma-color-bg-success)",
  "to-be-done": "var(--ds-color-folder-orange)",
  process: "var(--figma-color-bg-danger)",
  revised: "var(--figma-color-bg-component)",
  cancelled: "var(--figma-color-bg-disabled)",
};

export const frameStatusLabel = (s: FrameStatus): string => FRAME_STATUSES.find((x) => x.id === s)?.label ?? s;

const isStatus = (v: unknown): v is FrameStatus => FRAME_STATUSES.some((s) => s.id === v);

type Entry = { pluginID?: string; key?: string; value?: string };
type Row = NodeChange & { pluginData?: Entry[]; resizeToFit?: boolean };

/** The status stored in a node's pluginData entries, or null. */
export function statusIn(entries: readonly Entry[] | undefined): FrameStatus | null {
  const v = entries?.find((e) => e.pluginID === WORKFLOW_PLUGIN_ID && e.key === WORKFLOW_KEY)?.value;
  return isStatus(v) ? v : null;
}

export function frameStatusOf(ed: EditorController, id: Guid): FrameStatus | null {
  if (ed.engine.destroyed) return null;
  return statusIn((ed.engine.readNode(id, { fields: ["pluginData"] }) as Row | null)?.pluginData);
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

/** Sets (or, with null, removes) the status of these nodes — one undo step, "Set status". */
export function setFrameStatus(ed: EditorController, ids: readonly Guid[], status: FrameStatus | null): void {
  if (!ids.length || ed.engine.destroyed || !canSetStatus(ed)) return;
  const rows = ed.engine.readNodes(ids, { fields: ["pluginData"] }) as Row[];
  const write = () => {
    ed.engine.txnBegin("Set status");
    try {
      rows.forEach((r, i) => {
        const rest = (r?.pluginData ?? []).filter((e) => !(e.pluginID === WORKFLOW_PLUGIN_ID && e.key === WORKFLOW_KEY));
        const next = status ? [...rest, { pluginID: WORKFLOW_PLUGIN_ID, key: WORKFLOW_KEY, value: status }] : rest;
        ed.engine.setProps([ids[i]], { pluginData: next } as unknown as NodeFields);
      });
    } finally {
      ed.engine.txnCommit();
    }
  };
  if (modeOf(ed) !== "dev") return write();
  // Dev Mode puts the engine in viewer mode with only Dev Mode's own fields writable (annotations, measurements,
  // statuses: engine_set_props' list, which has no `pluginData`): the write is made with it lifted for the call.
  // TODO(engine): add "pluginData" to that list at the next engine build and drop this.
  const tool = ed.store.tool;
  ed.engine.setViewerMode(false);
  try {
    write();
  } finally {
    ed.engine.setViewerMode(true, { devEdits: true });
    if (tool !== "MOVE") ed.engine.setTool(tool as Parameters<typeof ed.engine.setTool>[0]);
  }
}

/** A status-carrying node on the page: its status and its rectangle in page coordinates. */
export interface StatusedFrame {
  id: Guid;
  status: FrameStatus | null;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The page's frames that can carry a status, with their place: those with a status, and `also` (the selection) when
 * they can have one. Top-level nodes' transforms are in page coordinates; a section's children add the section's.
 */
export function statusedFrames(ed: EditorController, also: readonly Guid[] = []): StatusedFrame[] {
  if (ed.engine.destroyed) return [];
  const page = ed.store.page;
  const top = ed.engine.readNode(page, { childIds: true })?.childIds ?? [];
  if (!top.length) return [];
  const fields = ["type", "transform", "size", "pluginData", "visible", "resizeToFit"];
  const out: StatusedFrame[] = [];
  const want = new Set(also);
  const visit = (ids: readonly Guid[], dx: number, dy: number, inSection: boolean) => {
    const rows = ed.engine.readNodes(ids, { fields, childIds: true }) as (Row & { childIds?: Guid[] })[];
    for (const raw of rows) {
      if (!raw || raw.visible === false) continue;
      const n = ed.withRealType(raw) as typeof raw;
      const t = n.transform as { m02?: number; m12?: number } | undefined;
      const x = dx + (t?.m02 ?? 0);
      const y = dy + (t?.m12 ?? 0);
      if (FRAMEISH.has(n.type ?? "")) {
        const status = statusIn(n.pluginData);
        if (status || want.has(n.guid)) out.push({ id: n.guid, status, x, y, width: n.size?.x ?? 0, height: n.size?.y ?? 0 });
      }
      if (n.type === "SECTION" && !inSection && n.childIds?.length) visit(n.childIds, x, y, true);
    }
  };
  visit(top, 0, 0, false);
  return out;
}
