/**
 * Dev Mode statuses set from Design (help.figma.com 26781702258583 "Dev Mode statuses and notifications": "select a
 * section, frame, or component … click Mark as ready for dev"; the status menu's "Mark as completed", "Remove
 * status"). Stored as the schema's `sectionStatusInfo` (BUILD = "Ready for dev", COMPLETED) on the design, which the
 * developer preview viewer lists ("Ready for development") and shows in Inspect. Figma offers it on the canvas label
 * and the toolbar; here it is in the canvas menu (unverified placement).
 */
import { t } from "@/i18n";
import type { Guid, NodeChange, NodeFields } from "@/engine/codec";
import { getStoreClient } from "@/store";
import type { DevModeRepository, DevStatusReport } from "@shared/devmode/types";
import type { EditorController } from "./controller";
import { CHANGE_TRACKED, frameStatusForDev, frameStatusLabel, withStatus, type DevStatusValue, type FrameStatus, type PluginDataEntry } from "./workflowStatus";

type StatusNode = NodeChange & { sectionStatusInfo?: { status?: string } };

/** The selected designs a status applies to: top-level frames, groups, sections, components, instances (and those inside sections). */
export function statusTargets(ed: EditorController): Guid[] {
  if (ed.engine.destroyed || !ed.selection.length) return [];
  const page = ed.store.page;
  const rows = ed.engine.readNodes(ed.selection, { fields: ["type", "parentIndex", "resizeToFit", "sectionStatusInfo"] }) as (StatusNode & { resizeToFit?: boolean })[];
  const out: Guid[] = [];
  for (const r of rows) {
    const n = ed.withRealType(r) as typeof r;
    // Frames, groups, sections, components and instances (live: an instance's More actions starts with Toggle ready for
    // dev status; design/group.txt has it enabled for a group on the page).
    const designish = n.type === "FRAME" || n.type === "GROUP" || n.type === "SECTION" || n.type === "SYMBOL" || n.type === "INSTANCE";
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
  setDevStatusOf(ed, statusTargets(ed), status);
}

/**
 * Sets (or removes) the status of these designs — one undo step. A status set again ("Done with changes", with an
 * optional `description`: the reason) restarts its clock, which clears "Changed" (the design's editInfo is older now).
 *
 * The owner's workflow status (workflowStatus.ts) is written in the same step: `opts.workflow` when the status menu
 * chose one of his (`status` is then its Figma counterpart, or null), else the one Figma's status stands for (Ready for
 * dev → Ready to Dev, Completed → Done, none → none).
 */
export function setDevStatusOf(
  ed: EditorController,
  ids: readonly Guid[],
  status: DevStatusValue | null,
  opts: { description?: string; label?: string; workflow?: FrameStatus | null } = {},
): void {
  if (!ids.length || ed.engine.destroyed) return;
  const before = statusOfTargets(ed, ids);
  const info = status
    ? {
        status,
        lastUpdateUnixTimestamp: Math.floor(Date.now() / 1000),
        ...(opts.description ? { description: opts.description } : {}),
        ...(before && before !== "mixed" ? { prevStatus: before } : {}),
      }
    : null;
  const workflow = opts.workflow !== undefined ? opts.workflow : frameStatusForDev(status);
  const label =
    opts.label ?? (opts.workflow !== undefined ? "Set status" : status === "BUILD" ? "Mark as ready for dev" : status === "COMPLETED" ? "Mark as completed" : "Remove status");
  const rows = ed.engine.readNodes(ids, { fields: ["pluginData", "sectionStatusInfo"] }) as (StatusNode & { pluginData?: PluginDataEntry[] })[];
  // Figma's field is written when it changes: set, or cleared where there was one (and kept as it is when ours moves
  // between two statuses Figma has no word for). Writing the same status again restarts its clock.
  const hadDev = (r: StatusNode | undefined) => !!r?.sectionStatusInfo?.status && r.sectionStatusInfo.status !== "NONE";
  const now = Math.floor(Date.now() / 1000);
  ed.batch(label, () => {
    rows.forEach((r, i) => {
      const change: Record<string, unknown> = { pluginData: withStatus(r?.pluginData, workflow, now) };
      if (status || hadDev(r)) change.sectionStatusInfo = info;
      ed.engine.setProps([ids[i]], change as unknown as NodeFields);
    });
  });
  saveStatusVersion(ed, ids, workflow);
  if (!status && !before) return;
  reportDevStatus(ed, ids, status, label === "Done with changes" ? "changed_done" : status === "BUILD" ? "ready" : status === "COMPLETED" ? "completed" : "removed", opts.description);
}

/**
 * A design given a status that tracks changes (Done, R to Merge, Ready to Dev) is compared with the file as it was then
 * (its Changed square opens Compare changes): a version saved now (unverified: whether Figma saves one for Ready for
 * dev, or keeps its own snapshot).
 */
function saveStatusVersion(ed: EditorController, ids: readonly Guid[], workflow: FrameStatus | null): void {
  if (!workflow || !CHANGE_TRACKED.has(workflow) || !ed.source.saveVersion) return;
  const names = ids.map((id) => ed.engine.readNode(id, { fields: ["name"] })?.name ?? "").filter(Boolean);
  const status = t(frameStatusLabel(workflow));
  const title = names.length === 1 ? t("“{name}” marked {status}", { name: names[0], status }) : t("{n} designs marked {status}", { n: names.length, status });
  void ed.source.saveVersion({ title }).catch(() => {});
}

/**
 * The status change, told to the file's server (docs/editor.md D-4: `POST /files/:key/dev-status`, through the store's
 * `devMode.reportStatus`): the server raises DEV_MODE_STATUS_UPDATE and tells the people who viewed the file in Dev
 * Mode. Local files report nothing (the store answers at once). Never fails the edit.
 */
export function reportDevStatus(ed: EditorController, ids: readonly Guid[], status: "BUILD" | "COMPLETED" | null, kind: DevStatusReport["kind"], changeMessage?: string, given?: Pick<DevModeRepository, "reportStatus"> | null): void {
  const fileKey = (ed.source as { fileKey?: string }).fileKey;
  if (!fileKey) return;
  const repo = given === undefined ? storeDevMode() : given;
  if (!repo) return;
  const wire: DevStatusReport["status"] = status === "BUILD" ? "READY_FOR_DEV" : status === "COMPLETED" ? "COMPLETED" : "NONE";
  for (const id of ids) {
    const nodeName = ed.engine.readNode(id, { fields: ["name"] })?.name ?? "";
    void repo.reportStatus(fileKey, { nodeId: id, nodeName, status: wire, kind, ...(changeMessage ? { changeMessage } : {}) }).catch(() => {});
  }
}

function storeDevMode(): Pick<DevModeRepository, "reportStatus"> | null {
  try {
    return (getStoreClient() as { devMode?: DevModeRepository }).devMode ?? null;
  } catch {
    return null;
  }
}
