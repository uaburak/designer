/**
 * The Ready for dev view's model (docs/editor.md D-4; help.figma.com 23918228264855): every page's designs with a
 * status, read from the document, filtered All or by one status and sorted by Recent activity, Pages or Name (A-Z).
 * Since the owner's statuses replace Ready for dev's (docs/editor.md "Frame status (ours)"), an item's status is his
 * (`workflow`: pluginData, else the one Figma's sectionStatusInfo stands for) and the filters are All + his statuses;
 * Figma's own (`status`, with "Changed" from editInfo) is kept for "Changed" and Dev Mode's other parts.
 */
import type { Guid } from "@/engine/codec";
import type { DevStatus } from "../../../../viewer/inspect/devMode";
import { FRAME_STATUSES, frameStatusForDev, type FrameStatus } from "../workflowStatus";
import type { ReadyFilter, ReadySort } from "./round5";

export interface ReadyItem {
  id: Guid;
  name: string;
  page: Guid;
  pageName: string;
  /** Page order, then the Layers panel's order within it */
  order: number;
  /** The owner's status */
  workflow: FrameStatus;
  /** Figma's Ready for dev status, if any */
  status: DevStatus | null;
  /** Seconds: the last edit (editInfo.lastEditedAt) */
  editedAt: number;
  /** Seconds: when the status was set */
  statusAt: number;
}

export interface ReadySource {
  pages(): { guid: Guid; name: string }[];
  /** A page's designs with a status: Figma's (`status`) and/or the owner's (`workflow`; derived from Figma's when absent). */
  statuses(page: Guid): { id: Guid; name: string; status?: DevStatus | null; workflow?: FrameStatus | null }[];
  times(ids: Guid[]): { editedAt: number; statusAt: number }[];
}

const workflowOf = (s: { status?: DevStatus | null; workflow?: FrameStatus | null }): FrameStatus | null =>
  s.workflow !== undefined ? s.workflow : frameStatusForDev(s.status === "COMPLETED" ? "COMPLETED" : s.status ? "BUILD" : null);

export function readyItems(src: ReadySource): ReadyItem[] {
  const out: ReadyItem[] = [];
  let order = 0;
  for (const p of src.pages()) {
    const list = src.statuses(p.guid).flatMap((s) => {
      const workflow = workflowOf(s);
      return workflow ? [{ ...s, workflow }] : [];
    });
    const times = list.length ? src.times(list.map((s) => s.id)) : [];
    list.forEach((s, i) =>
      out.push({
        id: s.id,
        name: s.name,
        page: p.guid,
        pageName: p.name,
        order: order++,
        workflow: s.workflow,
        status: s.status ?? null,
        editedAt: times[i]?.editedAt ?? 0,
        statusAt: times[i]?.statusAt ?? 0,
      }),
    );
  }
  return out;
}

export function filterReady(items: readonly ReadyItem[], filter: ReadyFilter): ReadyItem[] {
  return filter === "all" ? [...items] : items.filter((i) => i.workflow === filter);
}

export function sortReady(items: readonly ReadyItem[], sort: ReadySort): ReadyItem[] {
  const list = [...items];
  if (sort === "name") return list.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }) || a.order - b.order);
  if (sort === "pages") return list.sort((a, b) => a.order - b.order);
  const at = (i: ReadyItem) => Math.max(i.editedAt, i.statusAt);
  return list.sort((a, b) => at(b) - at(a) || a.order - b.order);
}

/** What a card says: "Changed" for a Ready to Dev design edited since (Figma's), else the owner's status. */
export function readyItemLabel(item: ReadyItem): string {
  if (item.workflow === "ready-to-dev" && item.status === "CHANGED") return "Changed";
  return FRAME_STATUSES.find((s) => s.id === item.workflow)?.label ?? item.workflow;
}

export const FILTERS: { value: ReadyFilter; label: string }[] = [{ value: "all", label: "All" }, ...FRAME_STATUSES.map((s) => ({ value: s.id, label: s.label }))];
export const SORTS: { value: ReadySort; label: string }[] = [
  { value: "recent", label: "Recent activity" },
  { value: "pages", label: "Pages" },
  { value: "name", label: "Name (A-Z)" },
];
