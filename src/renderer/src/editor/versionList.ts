/**
 * Version history's rules (docs/research/atlas/16-comments-versions.md §3): which versions are autosaves, how the
 * panel lists them — newest first, 30 a page, consecutive autosaves folded into "N autosave versions" — its filters,
 * the rows' times and the "Viewing …" toast's text. Pure: VersionHistory.tsx draws what these say.
 */
import { intlLocale } from "@/i18n";
import type { VersionInfo } from "./documentSource";

/** Rows fetched per page (`/api/versions/:key`, 30) */
export const VERSIONS_PAGE = 30;
/** The "Viewing …" toast cuts its label to 34 characters and "…" */
export const VIEWING_MAX = 34;
/** A click selects after 300 ms (a double-click names the version instead) */
export const SELECT_DEBOUNCE_MS = 300;

/** Branching's own versions: Branch created, Updated from main, Branch merged (never folded, never named) */
export const isBranchingVersion = (v: VersionInfo) => v.kind === "branch" || v.kind === "update" || v.kind === "merge";

/**
 * Figma's rule: a version with a label, any branching version and a restore are named; everything else is an
 * autosave — ours: a checkpoint, or a version whose info was deleted (publish and import are named by their kind).
 */
export const isAutosave = (v: VersionInfo) => !v.title && (v.kind === "autosave" || v.kind === "named");

export type HistoryRow = { type: "version"; version: VersionInfo } | { type: "group"; id: string; versions: VersionInfo[]; open: boolean };

export interface HistoryFilter {
  /** "Show autosave versions" (on by default) */
  showAutosaves: boolean;
  /** "Only yours": the versions this account edited (its id) — those that don't record their editors kept */
  onlyYours?: string | null;
}

/** Whether "Only yours" keeps a version: it records this account among its editors, or records none. */
export const isYours = (v: VersionInfo, me: string | null | undefined) => !me || !v.editors?.length || v.editors.includes(me);

/**
 * The panel's rows: the first `shown` versions, newest first, autosaves hidden or — two or more in a row — folded into a
 * group, open when the user opened it, when it holds the selected version, or while no named version exists at all.
 */
export function historyRows(versions: VersionInfo[], filter: HistoryFilter, opened: ReadonlySet<string>, selected: string | null, shown = VERSIONS_PAGE): HistoryRow[] {
  const list = [...versions]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, shown)
    .filter((v) => filter.onlyYours === undefined || isYours(v, filter.onlyYours));
  const anyNamed = list.some((v) => !isAutosave(v));
  const rows: HistoryRow[] = [];
  let run: VersionInfo[] = [];
  const flush = () => {
    if (run.length === 1) rows.push({ type: "version", version: run[0] });
    else if (run.length > 1) {
      const id = `group-${run[0].id}`;
      rows.push({ type: "group", id, versions: run, open: !anyNamed || opened.has(id) || run.some((v) => v.id === selected) });
    }
    run = [];
  };
  for (const v of list) {
    if (isAutosave(v)) {
      if (filter.showAutosaves) run.push(v);
      continue;
    }
    flush();
    rows.push({ type: "version", version: v });
  }
  flush();
  return rows;
}

/** The versions Up / Down step through, in the panel's order (those inside closed groups too: stepping opens them) */
export function steppable(versions: VersionInfo[], filter: HistoryFilter, shown = VERSIONS_PAGE): VersionInfo[] {
  return [...versions]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, shown)
    .filter((v) => (filter.showAutosaves || !isAutosave(v)) && (filter.onlyYours === undefined || isYours(v, filter.onlyYours)));
}

/** A row's time: "3:41 PM" today, "Oct 12, 3:41 PM" this year, "Oct 12, 2025, 3:41 PM" before */
export function versionTime(at: number, now = Date.now()): string {
  const d = new Date(at);
  const n = new Date(now);
  const locale = intlLocale();
  if (d.toDateString() === n.toDateString()) return d.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
  if (d.getFullYear() === n.getFullYear()) return d.toLocaleString(locale, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  return d.toLocaleString(locale, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

/** The label the "Viewing …" toast shows, cut to 34 characters and "…" */
export function viewingLabel(label: string): string {
  return label.length > VIEWING_MAX ? `${label.slice(0, VIEWING_MAX)}…` : label;
}

/** A link to a version: the editor's address with `version-id` (opening it shows that version in the history) */
export function versionLink(href: string, id: string): string {
  const url = new URL(href);
  url.hash = "";
  url.searchParams.set("version-id", id);
  return url.toString();
}

/** The version a link asks for (`version-id`), or null */
export function linkedVersion(search: string): string | null {
  return new URLSearchParams(search).get("version-id");
}
