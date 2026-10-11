/**
 * The Ready for dev view's model (docs/editor.md D-4; help.figma.com 23918228264855): every page's designs with a
 * status, read from the document (`sectionStatusInfo` + `editInfo`), filtered All / Ready / Completed and sorted by
 * Recent activity, Pages or Name (A-Z). "Ready" holds the designs marked ready for dev, edited since ("Changed") too.
 */
import type { Guid } from "@/engine/codec";
import type { DevStatus } from "../../../../viewer/inspect/devMode";
import type { ReadyFilter, ReadySort } from "./round5";

export interface ReadyItem {
  id: Guid;
  name: string;
  page: Guid;
  pageName: string;
  /** Page order, then the Layers panel's order within it */
  order: number;
  status: DevStatus;
  /** Seconds: the last edit (editInfo.lastEditedAt) */
  editedAt: number;
  /** Seconds: when the status was set */
  statusAt: number;
}

export interface ReadySource {
  pages(): { guid: Guid; name: string }[];
  statuses(page: Guid): { id: Guid; name: string; status: DevStatus }[];
  times(ids: Guid[]): { editedAt: number; statusAt: number }[];
}

export function readyItems(src: ReadySource): ReadyItem[] {
  const out: ReadyItem[] = [];
  let order = 0;
  for (const p of src.pages()) {
    const list = src.statuses(p.guid);
    const times = list.length ? src.times(list.map((s) => s.id)) : [];
    list.forEach((s, i) => out.push({ id: s.id, name: s.name, page: p.guid, pageName: p.name, order: order++, status: s.status, editedAt: times[i]?.editedAt ?? 0, statusAt: times[i]?.statusAt ?? 0 }));
  }
  return out;
}

export function filterReady(items: readonly ReadyItem[], filter: ReadyFilter): ReadyItem[] {
  if (filter === "all") return [...items];
  if (filter === "completed") return items.filter((i) => i.status === "COMPLETED");
  return items.filter((i) => i.status === "READY_FOR_DEV" || i.status === "CHANGED");
}

export function sortReady(items: readonly ReadyItem[], sort: ReadySort): ReadyItem[] {
  const list = [...items];
  if (sort === "name") return list.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }) || a.order - b.order);
  if (sort === "pages") return list.sort((a, b) => a.order - b.order);
  const at = (i: ReadyItem) => Math.max(i.editedAt, i.statusAt);
  return list.sort((a, b) => at(b) - at(a) || a.order - b.order);
}

export const FILTERS: { value: ReadyFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "ready", label: "Ready" },
  { value: "completed", label: "Completed" },
];
export const SORTS: { value: ReadySort; label: string }[] = [
  { value: "recent", label: "Recent activity" },
  { value: "pages", label: "Pages" },
  { value: "name", label: "Name (A-Z)" },
];
