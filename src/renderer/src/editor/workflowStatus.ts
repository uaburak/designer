/**
 * The owner's workflow statuses (ours, docs/editor.md "Frame status (ours)"): the list, colours, and how they sit in a
 * node — pure, shared by frameStatus.ts (the menu's writes) and devStatus.ts (Figma's Ready for dev, kept in step).
 *
 * Stored in the node's `pluginData` (schema 204) under the reserved plugin ID `designer.workflow`, key `status`. Two of
 * them are also Figma's `sectionStatusInfo`, so Dev Mode (the Ready for dev view, notifications, REST, "Changed") keeps
 * working: Ready to Dev ↔ BUILD, Done ↔ COMPLETED; every other status clears it. Reading, pluginData wins; a node with
 * only Figma's field (an imported .fig) reads as Ready to Dev / Done (the engine's Editor::workflowStatus does the same).
 */
export const WORKFLOW_PLUGIN_ID = "designer.workflow";
export const WORKFLOW_KEY = "status";
/**
 * When the status was set (unix seconds, as a string) — kept for the statuses that track changes (the owner,
 * 2026-10-28: Done, R to Merge, Ready to Dev). The design edited later (its editInfo) shows "Changed" beside its status
 * (the engine's Editor::workflowChanged); its changes are compared with the version saved then.
 */
export const WORKFLOW_SINCE_KEY = "since";
export const CHANGE_TRACKED: ReadonlySet<FrameStatus> = new Set<FrameStatus>(["done", "r-to-merge", "ready-to-dev"]);

/** The owner's list, in his order (the engine's kWorkflowLabels, 1–7). */
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
 * Each status's colour, its dot in the chrome (the owner's mapping, 2026-10-12; ds tokens, light and dark — the canvas
 * chips use the same values from the chrome palette, ds/tokens.ts `statusDone` …): Done blue, R to Merge cyan, Ready to
 * Dev Dev Mode's green, Process red, To be done orange, Revised purple, Cancelled grey (muted, like disabled).
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

export const isFrameStatus = (v: unknown): v is FrameStatus => FRAME_STATUSES.some((s) => s.id === v);

export type PluginDataEntry = { pluginID?: string; key?: string; value?: string };
export type DevStatusValue = "BUILD" | "COMPLETED";

/** Figma's status for one of ours: Ready to Dev is Ready for dev, Done is Completed; the rest have none. */
export function devStatusFor(s: FrameStatus | null): DevStatusValue | null {
  return s === "ready-to-dev" ? "BUILD" : s === "done" ? "COMPLETED" : null;
}

/** Ours for Figma's status (a status set from Dev Mode's own menus). */
export function frameStatusForDev(s: string | null | undefined): FrameStatus | null {
  return s === "BUILD" ? "ready-to-dev" : s === "COMPLETED" ? "done" : null;
}

/** Our entry in a node's pluginData, if any. */
function entryIn(entries: readonly PluginDataEntry[] | undefined): PluginDataEntry | undefined {
  return entries?.find((e) => e.pluginID === WORKFLOW_PLUGIN_ID && e.key === WORKFLOW_KEY);
}

/** A node's status: its pluginData entry, else Figma's sectionStatusInfo (BUILD / COMPLETED). */
export function statusIn(entries: readonly PluginDataEntry[] | undefined, sectionStatus?: string | null): FrameStatus | null {
  const e = entryIn(entries);
  if (e) return isFrameStatus(e.value) ? e.value : null;
  return frameStatusForDev(sectionStatus);
}

/**
 * pluginData with our entry set to `status` (or removed, with null) and, for a status that tracks changes, `since`
 * (unix seconds) beside it; other plugins' entries kept.
 */
export function withStatus(entries: readonly PluginDataEntry[] | undefined, status: FrameStatus | null, since?: number): PluginDataEntry[] {
  const rest = (entries ?? []).filter((e) => !(e.pluginID === WORKFLOW_PLUGIN_ID && (e.key === WORKFLOW_KEY || e.key === WORKFLOW_SINCE_KEY)));
  if (!status) return rest;
  const out = [...rest, { pluginID: WORKFLOW_PLUGIN_ID, key: WORKFLOW_KEY, value: status }];
  if (since !== undefined && CHANGE_TRACKED.has(status)) out.push({ pluginID: WORKFLOW_PLUGIN_ID, key: WORKFLOW_SINCE_KEY, value: String(since) });
  return out;
}

/** When a design's status was set (unix seconds): our `since`, else Figma's sectionStatusInfo; null if neither. */
export function statusSince(entries: readonly PluginDataEntry[] | undefined, sectionStatus?: { status?: string; lastUpdateUnixTimestamp?: number } | null): number | null {
  const e = entries?.find((x) => x.pluginID === WORKFLOW_PLUGIN_ID && x.key === WORKFLOW_SINCE_KEY);
  const n = e?.value !== undefined ? Number(e.value) : NaN;
  if (Number.isFinite(n)) return n;
  return sectionStatus?.status && sectionStatus.status !== "NONE" && sectionStatus.lastUpdateUnixTimestamp !== undefined ? sectionStatus.lastUpdateUnixTimestamp : null;
}

/**
 * How a design's status shows wherever it is listed (Dev Mode's left list and Inspect header, developer previews, the
 * Ready for dev cards, focus view): always the owner's label and colour; Figma's "Changed" (yellow) is a marker beside
 * Ready to Dev when the design was edited since it was marked — never in its place (2026-10-12). `dev` is Figma's own
 * status as read (the viewer's "CHANGED", or the engine's).
 */
export function statusShown(workflow: FrameStatus, dev?: string | null): { label: string; color: string; changed: boolean } {
  return { label: frameStatusLabel(workflow), color: FRAME_STATUS_COLOR[workflow], changed: workflow === "ready-to-dev" && dev === "CHANGED" };
}
