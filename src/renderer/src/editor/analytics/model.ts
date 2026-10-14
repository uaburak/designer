/**
 * The Library analytics modal's pure parts (docs/data.md §17, docs/research/figma/R22-library-analytics.md): its
 * choices in Figma's words, the statistics table's columns and sorting, the insertions graph's weeks, the CSV rule.
 */
import { intlLocale } from "@/i18n";
import type { AnalyticsAssetType, AnalyticsRange, AssetStatsRow, ModeUsageRow, WeeklyActions } from "../../../../shared/libraries/orgTypes";

export const TYPE_OPTIONS: { value: AnalyticsAssetType; label: string }[] = [
  { value: "component", label: "Components" },
  { value: "style", label: "Styles" },
  { value: "variable", label: "Variables" },
];

/** Figma's durations: 30, 60, 90 days or "last year" (a rolling 12 months) */
export const RANGE_OPTIONS: { value: AnalyticsRange; label: string }[] = [
  { value: 30, label: "Last 30 days" },
  { value: 60, label: "Last 60 days" },
  { value: 90, label: "Last 90 days" },
  { value: 365, label: "Last year" },
];

/** "Download CSV" appears only when more than five teams use the library (otherwise the data is copied from the modal). */
export const canDownloadCsv = (teamsUsing: number): boolean => teamsUsing > 5;

/** Styles and variables are tracked since 2024-10-10 (Figma): earlier weeks are "unavailable" (grey). */
export const TRACKED_SINCE: Record<AnalyticsAssetType, string | null> = { component: null, style: "2024-10-10", variable: "2024-10-10" };

export type SortDir = "asc" | "desc";
export type Column = { id: string; label: string; numeric: boolean; value: (r: AssetStatsRow) => string | number };

const COL = {
  name: { id: "name", label: "Name", numeric: false, value: (r: AssetStatsRow) => r.name },
  variants: { id: "variants", label: "Variants", numeric: true, value: (r: AssetStatsRow) => r.variants ?? 0 },
  collection: { id: "collection", label: "Collection", numeric: false, value: (r: AssetStatsRow) => r.collectionName ?? "" },
  instances: { id: "instances", label: "Instances", numeric: true, value: (r: AssetStatsRow) => r.instances },
  inserts: { id: "inserts", label: "Inserts", numeric: true, value: (r: AssetStatsRow) => r.insertions },
  detaches: { id: "detaches", label: "Detaches", numeric: true, value: (r: AssetStatsRow) => r.detachments },
} satisfies Record<string, Column>;

/** The statistics table's columns per Type (help "View library analytics": names, variants, instances, inserts, detaches; variables add the collection). */
export const COLUMNS: Record<AnalyticsAssetType, Column[]> = {
  component: [COL.name, COL.variants, COL.instances, COL.inserts, COL.detaches],
  style: [COL.name, COL.instances, COL.inserts, COL.detaches],
  variable: [COL.name, COL.collection, COL.instances, COL.inserts, COL.detaches],
};

/** "Click the name of each column to sort the data by ascending or descending values" — ties by name. */
export function sortRows<T extends AssetStatsRow>(rows: readonly T[], column: Column, dir: SortDir): T[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = column.value(a);
    const y = column.value(b);
    const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
    return c !== 0 ? sign * c : a.name.localeCompare(b.name);
  });
}

export const MODE_COLUMNS: { id: string; label: string; numeric: boolean; value: (r: ModeUsageRow) => string | number }[] = [
  { id: "mode", label: "Mode", numeric: false, value: (r) => r.modeName },
  { id: "collection", label: "Collection", numeric: false, value: (r) => r.collectionName },
  { id: "instances", label: "Instances", numeric: true, value: (r) => r.instances },
];

// ---- Weeks ------------------------------------------------------------------------------------------------------------

const DAY = 86_400_000;
const parseDay = (day: string): number => Date.parse(`${day}T00:00:00Z`);
export const formatDay = (t: number): string => new Date(t).toISOString().slice(0, 10);

/** The Sunday (UTC) starting the week of `day` — Figma's API weeks */
export function weekOf(day: string): string {
  const t = parseDay(day);
  return formatDay(t - new Date(t).getUTCDay() * DAY);
}

export interface GraphWeek {
  week: string;
  /** null: no point (a week after the data, up to the end of the current week) */
  insertions: number | null;
  compare: number | null;
  /** Before tracking began (grey) */
  unavailable: boolean;
  /** The week isn't over at the data's last day (its segment dashed) */
  incomplete: boolean;
}

/**
 * The graph's weeks: the series' (zero-filled by the server), then the weeks up to the one holding `today` — the graph
 * "runs to the end of the current week" — without points. The data's last week is incomplete unless `throughDay` is
 * its Saturday.
 */
export function graphWeeks(type: AnalyticsAssetType, series: readonly WeeklyActions[], compare: readonly WeeklyActions[] | null, throughDay: string, today: string): GraphWeek[] {
  const since = TRACKED_SINCE[type];
  const lastData = weekOf(throughDay);
  const compareBy = new Map((compare ?? []).map((w) => [w.week, w.insertions]));
  const out: GraphWeek[] = series.map((w) => ({
    week: w.week,
    insertions: w.insertions,
    compare: compare ? (compareBy.get(w.week) ?? 0) : null,
    unavailable: !!since && parseDay(w.week) + 7 * DAY <= parseDay(since),
    incomplete: w.week === lastData && new Date(parseDay(throughDay)).getUTCDay() !== 6,
  }));
  const end = weekOf(today);
  let t = parseDay(out.length ? out[out.length - 1].week : lastData) + 7 * DAY;
  for (let i = 0; t <= parseDay(end) && i < 60; i++, t += 7 * DAY) out.push({ week: formatDay(t), insertions: null, compare: null, unavailable: false, incomplete: false });
  return out;
}

/** "Oct 5" */
export const shortDate = (day: string): string => new Date(parseDay(day)).toLocaleDateString(intlLocale(), { month: "short", day: "numeric", timeZone: "UTC" });

/** 1,234 */
export const count = (n: number): string => n.toLocaleString(intlLocale());

/** 0.425 → "43%" */
export const percent = (share: number): string => `${Math.round(share * 100)}%`;

// ---- CSV --------------------------------------------------------------------------------------------------------------

/** Rows of a CSV (Figma's REST columns, quoted where needed) as objects by header. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  const [head, ...body] = rows.filter((r) => r.length > 1 || r[0] !== "");
  if (!head) return [];
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}

/** A component set's variants from the component CSV (the views list sets, the CSV each variant with its set). */
export function variantsFromCsv(text: string, setKey: string): AssetStatsRow[] {
  return parseCsv(text)
    .filter((r) => r.component_set_key === setKey && r.component_key && r.component_key !== setKey)
    .map((r) => ({
      key: r.component_key,
      name: r.component_name,
      type: "component" as const,
      description: "",
      componentSetKey: setKey,
      componentSetName: r.component_set_name,
      instances: Number(r.instances) || 0,
      insertions: Number(r.insertions) || 0,
      detachments: Number(r.detachments) || 0,
      teamsUsing: Number(r.teams_using) || 0,
      filesUsing: Number(r.files_using) || 0,
    }));
}

/** The file name a CSV download gets: "‹Library› components.csv" */
export const csvFileName = (library: string, type: AnalyticsAssetType): string => `${library.replace(/[\\/:*?"<>|]/g, "-")} ${TYPE_OPTIONS.find((t) => t.value === type)!.label.toLowerCase()}.csv`;
