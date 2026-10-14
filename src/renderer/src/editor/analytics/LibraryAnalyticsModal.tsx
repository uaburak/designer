/**
 * Library analytics (help.figma.com "View and explore library analytics", docs/research/figma/R22-library-analytics.md;
 * the data: docs/data.md §17): one org library's use, from the store's `analytics` views.
 *
 * - **Overview**: "Teams using the library", "Total components", "Total styles", "Total variables", "Activity this
 *   week" (the last seven days), then every component, style and variable collection.
 * - **Analytics**: Type (Components / Styles / Variables), Duration (30, 60, 90 days, Last year), the insertions graph
 *   (current data blue, unavailable grey, comparison black, a dashed line for an incomplete week; it runs to the end
 *   of the current week), Compare with another library, Top teams (insertions and share), the statistics table
 *   (click a column's name to sort), Download CSV when more than five teams use the library. Variables have a Modes
 *   tab (mode, collection, instances; filtered by Collection; no drill-down).
 * - **Usage view** of an asset: Description, Total, Used by, Used in, a set's variants, the files (file, team,
 *   instances, last modified; "File not visible" where the viewer can't see its team).
 *
 * Home renders it from a library's context menu (round 3f); the editor from the file name menu's "Library analytics".
 */
import { useEffect, useMemo, useState } from "react";
import { Button, Dialog, EmptyState, IconButton, Select, Spinner, Tabs, cx, showToast } from "@/ds";
import type { AnalyticsAssetType, AnalyticsRange, AssetStatsRow, AssetUsage, LibraryActions, LibraryAnalyticsRepository, LibraryKey, LibraryOverview, ModeUsageRow, OrgLibrariesRepository } from "../../../../shared/libraries/orgTypes";
import type { LibraryRecord } from "../../../../shared/store/types";
import { intlLocale, t, tp, useT } from "@/i18n";
import { InsertionsGraph } from "./InsertionsGraph";
import { COLUMNS, MODE_COLUMNS, RANGE_OPTIONS, TYPE_OPTIONS, canDownloadCsv, count, csvFileName, percent, shortDate, sortRows, variantsFromCsv, type Column, type SortDir } from "./model";
import styles from "./Analytics.module.css";

/** What the modal reads: the store's analytics views; with `orgLibraries` (and the org) it offers "Compare with". */
export interface AnalyticsStore {
  analytics: LibraryAnalyticsRepository;
  orgLibraries?: OrgLibrariesRepository;
  libraries?: { getRecord(key: LibraryKey): Promise<LibraryRecord | null> };
}

export interface LibraryAnalyticsModalProps {
  store: AnalyticsStore;
  libraryKey: LibraryKey;
  /** The title (else read from the library's record) */
  name?: string;
  /** The org, for "Compare with" (else read from the library's record) */
  orgId?: string;
  onClose?: () => void;
  /** Today ('YYYY-MM-DD', UTC), for the graph's current week (tests) */
  today?: string;
}

type View = { tab: "overview" | "analytics"; asset: AssetStatsRow | null; back: AssetStatsRow[] };

export function LibraryAnalyticsModal({ store, libraryKey, name: libraryName, orgId, onClose, today }: LibraryAnalyticsModalProps) {
  useT();
  const [open, setOpen] = useState(true);
  const close = () => {
    setOpen(false);
    onClose?.();
  };
  const [name, setName] = useState(libraryName ?? null);
  const [org, setOrg] = useState(orgId ?? null);
  useEffect(() => {
    if ((name && org) || !store.libraries) return;
    let live = true;
    void store.libraries
      .getRecord(libraryKey)
      .then((r) => {
        const o = (r as { org?: { name: string; orgId: string } } | null)?.org;
        if (!live || !o) return;
        if (!name) setName(o.name);
        if (!org) setOrg(o.orgId);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [store, libraryKey, name, org]);
  const [view, setView] = useState<View>({ tab: "overview", asset: null, back: [] });
  const openAsset = (asset: AssetStatsRow) => setView((v) => ({ ...v, asset, back: v.asset ? [...v.back, v.asset] : v.back }));
  const back = () => setView((v) => ({ ...v, asset: v.back[v.back.length - 1] ?? null, back: v.back.slice(0, -1) }));
  if (!open) return null;
  return (
    <Dialog title={t("Library analytics")} size="large" open onClose={close}>
      <div className={styles.modal} data-library-analytics={libraryKey}>
        {name && <div className={styles.libraryName} data-library-name="">{name}</div>}
        {view.asset ? (
          <UsageView store={store} libraryKey={libraryKey} asset={view.asset} onBack={back} onOpen={openAsset} />
        ) : (
          <>
            <Tabs
              label={t("Library analytics")}
              value={view.tab}
              tabs={[
                { value: "overview", label: t("Overview") },
                { value: "analytics", label: t("Analytics") },
              ]}
              onChange={(tab) => setView({ tab: tab as View["tab"], asset: null, back: [] })}
            />
            {view.tab === "overview" ? <Overview store={store} libraryKey={libraryKey} onOpen={openAsset} /> : <AnalyticsTab store={store} libraryKey={libraryKey} libraryName={name ?? t("Library")} orgId={org} onOpen={openAsset} today={today} />}
          </>
        )}
      </div>
    </Dialog>
  );
}

/** A read of the store, its loading and failed states */
function useRead<T>(read: () => Promise<T>, deps: readonly unknown[]): { data: T | null; error: string | null } {
  const [state, setState] = useState<{ data: T | null; error: string | null }>({ data: null, error: null });
  useEffect(() => {
    let live = true;
    read().then(
      (data) => live && setState({ data, error: null }),
      (e: unknown) => live && setState({ data: null, error: errorText(e) })
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}

function errorText(e: unknown): string {
  const code = (e as { code?: string }).code;
  if (code === "offline") return "Library analytics aren't available offline";
  if (code === "not-found" || code === "forbidden") return "You don't have access to this library's analytics";
  return "Library analytics couldn't be loaded";
}

function Loading({ error }: { error: string | null }) {
  useT();
  if (error) return <EmptyState icon="24.library" title={t(error)} />;
  return (
    <div className={styles.loading}>
      <Spinner /> {t("Loading…")}
    </div>
  );
}

function Stat({ label, value, id }: { label: string; value: React.ReactNode; id: string }) {
  return (
    <div className={styles.stat} data-stat={id}>
      <span className={styles.statLabel}>{label}</span>
      <span className={styles.statValue}>{value}</span>
    </div>
  );
}

// ---- Overview ---------------------------------------------------------------------------------------------------------

function Overview({ store, libraryKey, onOpen }: { store: AnalyticsStore; libraryKey: LibraryKey; onOpen: (a: AssetStatsRow) => void }) {
  useT();
  const { data, error } = useRead<LibraryOverview>(() => store.analytics.overview(libraryKey), [store, libraryKey]);
  if (!data) return <Loading error={error} />;
  const components = data.rows.filter((r) => r.type === "component" && !r.componentSetKey);
  const styleRows = data.rows.filter((r) => r.type === "style");
  const collections = new Map<string, { name: string; variables: number; instances: number }>();
  for (const r of data.rows) {
    if (r.type !== "variable") continue;
    const k = r.collectionKey ?? r.collectionName ?? "";
    const c = collections.get(k) ?? { name: r.collectionName ?? t("Collection"), variables: 0, instances: 0 };
    c.variables++;
    c.instances += r.instances;
    collections.set(k, c);
  }
  return (
    <div className={styles.body} data-analytics-overview="">
      <div className={styles.stats}>
        <Stat id="teams" label={t("Teams using the library")} value={count(data.teamsUsing)} />
        <Stat id="components" label={t("Total components")} value={count(data.counts.components)} />
        <Stat id="styles" label={t("Total styles")} value={count(data.counts.styles)} />
        <Stat id="variables" label={t("Total variables")} value={count(data.counts.variables)} />
        <Stat
          id="week"
          label={t("Activity this week")}
          value={
            <>
              {tp(data.thisWeek.insertions, "{count} insertion", "{count} insertions", { count: count(data.thisWeek.insertions) })} · {tp(data.thisWeek.detachments, "{count} detachment", "{count} detachments", { count: count(data.thisWeek.detachments) })}
            </>
          }
        />
      </div>
      <AssetList title={t("Components")} rows={components} onOpen={onOpen} />
      <AssetList title={t("Styles")} rows={styleRows} onOpen={onOpen} />
      {collections.size > 0 && (
        <section aria-label={t("Variable collections")} className={styles.section}>
          <div className={styles.sectionTitle}>{t("Variable collections")}</div>
          {[...collections].map(([k, c]) => (
            <div key={k} className={styles.listRow} data-collection={c.name}>
              <span className={styles.name}>{c.name}</span>
              <span className={styles.meta}>
                {tp(c.variables, "{count} variable", "{count} variables", { count: count(c.variables) })} · {tp(c.instances, "{count} instance", "{count} instances", { count: count(c.instances) })}
              </span>
            </div>
          ))}
        </section>
      )}
      {!data.rows.length && <EmptyState icon="24.library" title={t("Nothing published yet")} body={t("Components, styles and variables published from this file show up here.")} />}
      <Freshness throughDay={data.throughDay} />
    </div>
  );
}

function AssetList({ title, rows, onOpen }: { title: string; rows: AssetStatsRow[]; onOpen: (a: AssetStatsRow) => void }) {
  useT();
  if (!rows.length) return null;
  return (
    <section aria-label={title} className={styles.section}>
      <div className={styles.sectionTitle}>{title}</div>
      {[...rows]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((r) => (
          <button key={r.key} type="button" className={styles.listRow} data-asset={r.name} onClick={() => onOpen(r)}>
            <span className={styles.name}>{r.name}</span>
            <span className={styles.meta}>
              {tp(r.instances, "{count} instance", "{count} instances", { count: count(r.instances) })}
            </span>
          </button>
        ))}
    </section>
  );
}

/** "Analytics are updated daily": the last day included. */
function Freshness({ throughDay }: { throughDay: string }) {
  useT();
  return <div className={styles.freshness}>{t("Updated daily · data through {date}", { date: shortDate(throughDay) })}</div>;
}

// ---- Analytics --------------------------------------------------------------------------------------------------------

function AnalyticsTab({ store, libraryKey, libraryName, orgId, onOpen, today }: { store: AnalyticsStore; libraryKey: LibraryKey; libraryName: string; orgId: string | null; onOpen: (a: AssetStatsRow) => void; today?: string }) {
  useT();
  const [type, setType] = useState<AnalyticsAssetType>("component");
  const [range, setRange] = useState<AnalyticsRange>(30);
  const [compareWith, setCompareWith] = useState<string>("");
  const [variablesTab, setVariablesTab] = useState<"variables" | "modes">("variables");
  const [collection, setCollection] = useState<string>("");
  const { data, error } = useRead<LibraryActions>(() => store.analytics.actions(libraryKey, { type, range, ...(compareWith ? { compareWith } : {}) }), [store, libraryKey, type, range, compareWith]);
  const others = useRead<{ key: string; name: string }[]>(async () => (store.orgLibraries && orgId ? (await store.orgLibraries.list(orgId)).filter((l) => l.key !== libraryKey).map((l) => ({ key: l.key, name: l.name })) : []), [store, orgId, libraryKey]);
  const download = async () => {
    try {
      const text = await store.analytics.csv(libraryKey, { type, range });
      saveText(csvFileName(libraryName, type), text);
    } catch (e) {
      showToast({ message: t(errorText(e)), kind: "error" });
    }
  };
  const collections = useMemo(() => [...new Map((data?.rows ?? []).filter((r) => r.type === "variable").map((r) => [r.collectionKey ?? "", r.collectionName ?? ""])).entries()], [data]);
  return (
    <div className={styles.body} data-analytics-tab="">
      <div className={styles.controls}>
        <Select label={t("Type")} width="hug" value={type} options={TYPE_OPTIONS.map((o) => ({ ...o, label: t(o.label) }))} onChange={(v) => setType(v as AnalyticsAssetType)} />
        <Select label={t("Duration")} width="hug" value={String(range)} options={RANGE_OPTIONS.map((r) => ({ value: String(r.value), label: t(r.label) }))} onChange={(v) => setRange(Number(v) as AnalyticsRange)} />
        <Select
          label={t("Compare with")}
          width="hug"
          placeholder={t("Compare with")}
          value={compareWith}
          options={[{ value: "", label: t("No comparison") }, ...(others.data ?? []).map((l) => ({ value: l.key, label: l.name }))]}
          disabled={!others.data?.length}
          onChange={setCompareWith}
        />
        <span className={styles.spacer} />
        {data && canDownloadCsv(data.teamsUsing) && (
          <Button variant="secondary" onClick={() => void download()} data-download-csv="">
            {t("Download CSV")}
          </Button>
        )}
      </div>
      {!data ? (
        <Loading error={error} />
      ) : (
        <>
          <InsertionsGraph type={type} data={data} libraryName={libraryName} today={today} />
          <TopTeams rows={data.topTeams} />
          {type === "variable" && (
            <div className={styles.controls}>
              <Tabs
                label={t("Variables and modes")}
                value={variablesTab}
                tabs={[
                  { value: "variables", label: t("Variables") },
                  { value: "modes", label: t("Modes") },
                ]}
                onChange={(tab) => setVariablesTab(tab as "variables" | "modes")}
              />
              <span className={styles.spacer} />
              <Select label={t("Collection")} width="hug" value={collection} options={[{ value: "", label: t("All collections") }, ...collections.map(([k, n]) => ({ value: k, label: n }))]} onChange={setCollection} />
            </div>
          )}
          {type === "variable" && variablesTab === "modes" ? (
            <ModesTable store={store} libraryKey={libraryKey} collection={collection} />
          ) : (
            <StatsTable key={type} type={type} rows={data.rows.filter((r) => r.type === type && !r.componentSetKey && (type !== "variable" || !collection || r.collectionKey === collection))} onOpen={onOpen} />
          )}
          <Freshness throughDay={data.throughDay} />
        </>
      )}
    </div>
  );
}

/** "Download CSV": the text saved as a file (the browser's download; the desktop app asks where through its session). */
function saveText(fileName: string, text: string): void {
  if (typeof document === "undefined" || typeof URL.createObjectURL !== "function") return;
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function TopTeams({ rows }: { rows: LibraryActions["topTeams"] }) {
  useT();
  return (
    <section aria-label={t("Top teams")} className={styles.section}>
      <div className={styles.sectionTitle}>{t("Top teams")}</div>
      {!rows.length && <div className={styles.none}>{t("No insertions in this period")}</div>}
      {rows.slice(0, 5).map((team, i) => (
        <div key={`${team.teamId ?? "hidden"}-${i}`} className={styles.listRow} data-team={team.teamName}>
          <span className={styles.name}>{team.teamName}</span>
          <span className={styles.meta}>
            {tp(team.insertions, "{count} insertion", "{count} insertions", { count: count(team.insertions) })} · {percent(team.share)}
          </span>
        </div>
      ))}
    </section>
  );
}

function SortHeader({ label, numeric, active, dir, onSort }: { label: string; numeric: boolean; active: boolean; dir: SortDir; onSort: () => void }) {
  return (
    <th scope="col" className={cx(styles.th, numeric && styles.num)} aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}>
      <button type="button" className={styles.sort} onClick={onSort}>
        {label}
        {active && <span aria-hidden>{dir === "asc" ? " ↑" : " ↓"}</span>}
      </button>
    </th>
  );
}

function useSort(initial: string) {
  const [sort, setSort] = useState<{ col: string; dir: SortDir }>({ col: initial, dir: "desc" });
  const toggle = (col: string, numeric: boolean) => setSort((s) => (s.col === col ? { col, dir: s.dir === "asc" ? "desc" : "asc" } : { col, dir: numeric ? "desc" : "asc" }));
  return { sort, toggle };
}

function StatsTable({ type, rows, onOpen }: { type: AnalyticsAssetType; rows: AssetStatsRow[]; onOpen: (a: AssetStatsRow) => void }) {
  useT();
  const columns = COLUMNS[type];
  const { sort, toggle } = useSort("inserts");
  const column: Column = columns.find((c) => c.id === sort.col) ?? columns[0];
  const sorted = sortRows(rows, column, sort.dir);
  return (
    <div className={styles.tableBox}>
      <table className={styles.table} data-stats-table={type}>
        <thead>
          <tr>
            {columns.map((c) => (
              <SortHeader key={c.id} label={t(c.label)} numeric={c.numeric} active={c.id === column.id} dir={sort.dir} onSort={() => toggle(c.id, c.numeric)} />
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <tr key={r.key} className={styles.row} data-row={r.name} tabIndex={0} onClick={() => onOpen(r)} onKeyDown={(e) => e.key === "Enter" && onOpen(r)}>
              {columns.map((c) => (
                <td key={c.id} className={cx(styles.td, c.numeric && styles.num)}>
                  {c.numeric ? count(c.value(r) as number) : c.value(r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length && <div className={styles.none}>{t("Nothing to show")}</div>}
    </div>
  );
}

function ModesTable({ store, libraryKey, collection }: { store: AnalyticsStore; libraryKey: LibraryKey; collection: string }) {
  useT();
  const { data, error } = useRead<ModeUsageRow[]>(() => store.analytics.modes(libraryKey, collection || undefined), [store, libraryKey, collection]);
  const { sort, toggle } = useSort("instances");
  if (!data) return <Loading error={error} />;
  const column = MODE_COLUMNS.find((c) => c.id === sort.col) ?? MODE_COLUMNS[0];
  const sign = sort.dir === "asc" ? 1 : -1;
  const sorted = [...data].sort((a, b) => {
    const x = column.value(a);
    const y = column.value(b);
    const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
    return c ? sign * c : a.modeName.localeCompare(b.modeName);
  });
  return (
    <div className={styles.tableBox}>
      <table className={styles.table} data-modes-table="">
        <thead>
          <tr>
            {MODE_COLUMNS.map((c) => (
              <SortHeader key={c.id} label={t(c.label)} numeric={c.numeric} active={c.id === column.id} dir={sort.dir} onSort={() => toggle(c.id, c.numeric)} />
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((m) => (
            <tr key={`${m.collectionKey}/${m.modeId}`} data-mode={m.modeName}>
              {MODE_COLUMNS.map((c) => (
                <td key={c.id} className={cx(styles.td, c.numeric && styles.num)}>
                  {c.numeric ? count(c.value(m) as number) : c.value(m)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {!data.length && <div className={styles.none}>{t("No modes set in files yet")}</div>}
    </div>
  );
}

// ---- Usage view -------------------------------------------------------------------------------------------------------

function UsageView({ store, libraryKey, asset, onBack, onOpen }: { store: AnalyticsStore; libraryKey: LibraryKey; asset: AssetStatsRow; onBack: () => void; onOpen: (a: AssetStatsRow) => void }) {
  useT();
  const { data, error } = useRead<AssetUsage>(() => store.analytics.usage(libraryKey, asset.key), [store, libraryKey, asset.key]);
  const isSet = asset.type === "component" && (asset.variants ?? 0) > 0;
  const variants = useRead<AssetStatsRow[]>(async () => (isSet ? variantsFromCsv(await store.analytics.csv(libraryKey, { type: "component", range: 30 }), asset.key) : []), [store, libraryKey, asset.key, isSet]);
  const row = data?.row ?? asset;
  return (
    <div className={styles.body} data-usage-view={asset.name}>
      <div className={styles.usageHeader}>
        <IconButton icon="24.arrow.left" label={t("Back")} onClick={onBack} />
        <span className={styles.usageTitle}>{asset.name}</span>
      </div>
      {!data ? (
        <Loading error={error} />
      ) : (
        <>
          <div className={styles.usageFields}>
            <div className={styles.field}>
              <span className={styles.statLabel}>{t("Description")}</span>
              <span>{row.description || t("No description")}</span>
            </div>
          </div>
          <div className={styles.stats}>
            <Stat id="total" label={t("Total")} value={tp(row.instances, "{count} instance", "{count} instances", { count: count(row.instances) })} />
            <Stat id="used-by" label={t("Used by")} value={tp(row.teamsUsing, "{count} team", "{count} teams", { count: count(row.teamsUsing) })} />
            <Stat id="used-in" label={t("Used in")} value={tp(row.filesUsing, "{count} file", "{count} files", { count: count(row.filesUsing) })} />
          </div>
          {isSet && (
            <section aria-label={t("Variants")} className={styles.section}>
              <div className={styles.sectionTitle}>{t("Variants")}</div>
              {!variants.data ? (
                <Loading error={variants.error} />
              ) : (
                <div className={styles.tableBox}>
                  <table className={styles.table} data-variants-table="">
                    <thead>
                      <tr>
                        <th scope="col" className={styles.th}>{t("Variant")}</th>
                        <th scope="col" className={cx(styles.th, styles.num)}>{t("Instances")}</th>
                        <th scope="col" className={cx(styles.th, styles.num)}>{t("Inserts")}</th>
                        <th scope="col" className={cx(styles.th, styles.num)}>{t("Detaches")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {variants.data.map((v) => (
                        <tr key={v.key} className={styles.row} data-variant={v.name} tabIndex={0} onClick={() => onOpen(v)} onKeyDown={(e) => e.key === "Enter" && onOpen(v)}>
                          <td className={styles.td}>{v.name}</td>
                          <td className={cx(styles.td, styles.num)}>{count(v.instances)}</td>
                          <td className={cx(styles.td, styles.num)}>{count(v.insertions)}</td>
                          <td className={cx(styles.td, styles.num)}>{count(v.detachments)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}
          <section aria-label={t("Files")} className={styles.section}>
            <div className={styles.sectionTitle}>{t("Files")}</div>
            <div className={styles.tableBox}>
              <table className={styles.table} data-files-table="">
                <thead>
                  <tr>
                    <th scope="col" className={styles.th}>{t("File")}</th>
                    <th scope="col" className={styles.th}>{t("Team")}</th>
                    <th scope="col" className={cx(styles.th, styles.num)}>{t("Instances")}</th>
                    <th scope="col" className={cx(styles.th, styles.num)}>{t("Last modified")}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.files.map((f, i) => (
                    <tr key={f.fileKey ?? `hidden-${i}`} data-file={f.fileName}>
                      <td className={cx(styles.td, !f.fileKey && styles.hidden)}>{f.fileName}</td>
                      <td className={styles.td}>{f.teamName ?? ""}</td>
                      <td className={cx(styles.td, styles.num)}>{count(f.instances)}</td>
                      <td className={cx(styles.td, styles.num)}>{f.lastModified ? new Date(f.lastModified).toLocaleDateString(intlLocale(), { month: "short", day: "numeric", year: "numeric" }) : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!data.files.length && <div className={styles.none}>{t("Not used in any file yet")}</div>}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
