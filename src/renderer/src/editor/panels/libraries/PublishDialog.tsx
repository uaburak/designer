/**
 * Publish library (UI3; help.figma.com "Publish a library", R5; atlas 12 §3): a search, the description subscribers
 * see with the update (while the search is empty), then the assets in Figma's sections — Invalid (property errors,
 * too many modes or variables: they can't be chosen), Changes (new, modified and removed, by kind: variable
 * collections, styles, components — each with a checkbox, ⇧-click for a range; deselecting a modified asset keeps its
 * last published version; a removed one stays published; what a selected asset uses goes with it: "Used by …", its
 * checkbox locked), Unchanged and Hidden (collapsed; Include in publish takes a flag-hidden one back) — components
 * pasted from another library (Move to this file / Publish as a copy) and the ones moved out ("Moved to …"); in an
 * org, Publish to (everyone at the organization or the team) and the warning when that widens who can see the file.
 * ⌘Enter publishes. Files in Drafts can't publish ("Move to a folder to publish").
 *
 * Publish closes the dialog at once and the publish runs in the background with a progress toast
 * (libraryPublishJob.ts); opened again meanwhile, the dialog shows that run. On a big file (a design kit's thousands
 * of components) the changes are looked for in slices that hand the event loop back, each component's property
 * errors are read once, and the rows are drawn a few hundred per frame.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Banner, Button, Checkbox, Dialog, EmptyState, Icon, IconButton, MIXED, SearchField, Select, Spinner, TextArea } from "@/ds";
import type { LibraryAsset } from "../../../../../shared/store/types";
import { useEditor } from "../../controller";
import { useLibraries, useUI } from "../../hooks";
import { draftPublish, publishLimitErrors, publishPlan, setHiddenWhenPublishing, slicer, type PublishDraft, type PublishItem, type PublishLimitError } from "../../libraries";
import { publishInBackground, publishRun, subscribePublishRun } from "../../libraryPublishJob";
import { componentPublishErrors, publishErrorLine } from "../../components";
import type { PropertyPublishError } from "../../model/components";
import type { LocalAsset } from "../../model/libraries";
import { NodeThumb, RemoteThumb } from "./Thumbs";
import styles from "./Libraries.module.css";
import { intlLocale, t, tp, useT } from "@/i18n";

type Section = "invalid" | "changes" | "unchanged" | "hidden";
type Row = {
  key: string;
  name: string;
  kind: LibraryAsset["kind"];
  section: Section;
  status: "created" | "modified" | "removed" | "unchanged" | "hidden";
  item?: PublishItem;
  removed?: LibraryAsset;
  hidden?: LocalAsset;
  errors: PropertyPublishError[];
  limit?: PublishLimitError;
};

/** "Used by Button", "Used by Button and Chip", "Used by Button and 2 others". */
export const usedByText = (names: readonly string[]): string =>
  names.length <= 1 ? t("Used by {name}", { name: names[0] ?? "" }) : names.length === 2 ? t("Used by {a} and {b}", { a: names[0], b: names[1] }) : tp(names.length - 1, "Used by {name} and {n} other", "Used by {name} and {n} others", { name: names[0] });

const STATUS_LABEL: Record<Row["status"], string> = { created: "New", modified: "Modified", removed: "Removed", unchanged: "No changes", hidden: "Hidden" };
const isComponentKind = (k: LibraryAsset["kind"]) => k === "COMPONENT" || k === "COMPONENT_SET";
/** Figma's group order inside Changes (atlas 12 §3.2): variable collections, styles, components */
const GROUPS: { title: string; kinds: LibraryAsset["kind"][] }[] = [
  { title: "Variable collections", kinds: ["VARIABLE_COLLECTION", "VARIABLE"] },
  { title: "Styles", kinds: ["STYLE"] },
  { title: "Components", kinds: ["COMPONENT", "COMPONENT_SET"] },
];
const LIMIT_TEXT: Record<PublishLimitError, string> = { TOO_MANY_MODES_ERROR: "This collection has more modes than your plan allows", TOO_MANY_VARIABLES_ERROR: "This collection has more than 5,000 variables" };

export { publishErrorText, publishRetryable } from "./publishErrors";

export function PublishDialog() {
  const open = useUI((s) => s.publishOpen);
  return open ? <Publish /> : null;
}

/**
 * Shift held (Figma tracks it with keydown / keyup on the document, atlas 12 §3.3): a checkbox's change doesn't
 * carry the click's modifiers.
 */
function useShift(): React.MutableRefObject<boolean> {
  const shift = useRef(false);
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      shift.current = e.shiftKey;
    };
    document.addEventListener("keydown", on, true);
    document.addEventListener("keyup", on, true);
    return () => {
      document.removeEventListener("keydown", on, true);
      document.removeEventListener("keyup", on, true);
    };
  }, []);
  return shift;
}

function Publish() {
  useT();
  const ed = useEditor();
  const state = useLibraries();
  const [draft, setDraft] = useState<PublishDraft | null>(null);
  // Each new / modified asset's checks, read once per draft: a collection past the limits, a component's property errors.
  const [checks, setChecks] = useState<Checks | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [description, setDescription] = useState("");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [moveModes, setMoveModes] = useState<Map<string, "move" | "copy">>(new Map());
  // A publish of this file running in the background (this dialog's, or one started before it was opened again).
  const progress = useSyncExternalStore(subscribePublishRun, () => publishRun(ed));
  const [open, setOpen] = useState<Record<Section, boolean>>({ invalid: true, changes: true, unchanged: false, hidden: false });
  const last = useRef<string | null>(null);
  const shift = useShift();
  // An org file (docs/data.md §16.6; atlas 12 §3.2): Publish to — everyone at the organization or the team; a change of
  // the file's link access, so only for people who can share it.
  const org = state.org;
  const [scope, setScope] = useState<"team" | "org" | null>(null);
  const publishTo = scope ?? (org?.scope === "org" ? "org" : "team");
  const close = () => {
    ed.ui.set({ publishOpen: false });
    ed.focusCanvas();
  };
  const inDrafts = state.inDrafts;
  const [reload, setReload] = useState(0);
  // While a publish runs, the changes aren't looked for (the run's result changes them): once it ends, they are.
  const running = !!progress;
  useEffect(() => {
    if (inDrafts || running) return;
    let live = true;
    void (async () => {
      const d = await draftPublish(ed);
      if (!live) return;
      const c = await checksOf(ed, d);
      if (!live) return;
      setDraft(d);
      setChecks(c);
      // A component with property errors (Figma's publish errors) or a collection past the limits isn't published:
      // left out until it is fixed.
      const publishable = (i: PublishItem) => !c.limits.has(i.key) && !c.errors.get(i.key)?.length;
      setSelected(new Set([...d.items.filter((i) => (i.status === "created" || i.status === "modified") && publishable(i)).map((i) => i.key), ...d.removed.map((r) => r.key)]));
      setMoveModes(new Map(d.moves.map((m) => [m.fromKey, "move" as const])));
    })().catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [ed, inDrafts, reload, running]);

  const rows = useMemo<Row[]>(() => {
    if (!draft || !checks) return [];
    const changed = draft.items
      .filter((i) => i.status === "created" || i.status === "modified")
      .map((i): Row => {
        const errors = checks.errors.get(i.key) ?? [];
        const limit = checks.limits.get(i.key);
        return { key: i.key, name: i.asset.name, kind: i.asset.kind, section: errors.length || limit ? "invalid" : "changes", status: i.status as Row["status"], item: i, errors, ...(limit ? { limit } : {}) };
      });
    return [
      ...changed,
      ...draft.removed.map((r): Row => ({ key: r.key, name: r.name, kind: r.kind, section: "changes", status: "removed", removed: r, errors: [] })),
      ...draft.items.filter((i) => i.status === "unchanged" && i.asset.kind !== "VARIABLE").map((i): Row => ({ key: i.key, name: i.asset.name, kind: i.asset.kind, section: "unchanged", status: "unchanged", item: i, errors: [] })),
      ...draft.hidden.map((h): Row => ({ key: h.guid, name: h.name, kind: h.kind, section: "hidden", status: "hidden", hidden: h, errors: [] })),
    ];
  }, [draft, checks]);
  const plan = useMemo(() => (draft ? publishPlan(draft, selected) : null), [draft, selected]);
  const q = query.trim().toLowerCase();
  const matches = (r: Row) => !q || r.name.toLowerCase().includes(q);
  const changes = rows.filter((r) => r.section === "changes");
  // A new or modified asset a published one uses goes with it: checked, and locked while that one is selected.
  const locked = (r: Row) => r.status !== "removed" && !!plan?.usedBy.has(r.key);
  const checked = (r: Row) => (r.status === "removed" ? selected.has(r.key) : !!plan?.chosen.has(r.key));
  const toggle = (keys: string[], on: boolean) =>
    setSelected((s) => {
      const next = new Set(s);
      for (const k of keys) {
        if (on) next.add(k);
        else next.delete(k);
      }
      return next;
    });
  // ⇧-click: every row between the last clicked one and this one takes this one's new state (atlas 12 §3.3).
  const visible = GROUPS.flatMap((g) => changes.filter((r) => g.kinds.includes(r.kind) && matches(r)));
  const click = (r: Row, on: boolean) => {
    const from = last.current ? visible.findIndex((x) => x.key === last.current) : -1;
    const to = visible.findIndex((x) => x.key === r.key);
    last.current = r.key;
    if (shift.current && from >= 0 && to >= 0) toggle(visible.slice(Math.min(from, to), Math.max(from, to) + 1).filter((x) => !locked(x)).map((x) => x.key), on);
    else toggle([r.key], on);
  };
  // Publish closes the dialog; the run goes on in the background with its toast (libraryPublishJob.ts).
  const publish = () => {
    if (!draft || !canPublish) return;
    const run = publishInBackground(ed, draft, { description: description.trim(), selected, moveModes, ...(org?.canShare ? { scope: publishTo } : {}) }, { name: ed.ui.get().fileName });
    if (run.started) close();
  };
  const includeHidden = (h: LocalAsset) => {
    setHiddenWhenPublishing(ed, h.guid, false);
    setDraft(null);
    setChecks(null);
    setReload((n) => n + 1);
  };
  // A long list is drawn a few hundred rows per frame (the first ones at once), not thousands in one go.
  const shown = useProgressiveCount(rows.length);
  const firstPublish = !state.own;
  const count = changes.filter(checked).length;
  const movedOut = draft?.movedOut ?? [];
  const nothing = !!draft && !!checks && changes.length === 0 && !draft.moves.length && !movedOut.length;
  // Publish is off with nothing checked, while publishing, or before the changes are known (atlas 12 §3.2).
  const canPublish = !!draft && !!checks && !progress && (count > 0 || draft.moves.length > 0 || movedOut.length > 0);
  // Publishing to the organization widens who can see a team file (atlas 12 §3.2's warning banner).
  const widens = !!org && publishTo === "org" && org.scope !== "org";

  if (inDrafts) {
    return (
      <Dialog title={t("Publish library")} size="medium" open onClose={close} footer={<Button variant="secondary" onClick={close}>{t("Close")}</Button>}>
        <div className={styles.publishEmpty} data-publish-drafts="">
          <EmptyState icon="24.library" title={t("Move to a folder to publish")} body={t("Files in Drafts can't be published as libraries. Move this file to a folder, then publish its components, styles and variables for your team's files.")} />
        </div>
      </Dialog>
    );
  }

  const header = (section: Section, title: string, list: Row[], extra?: React.ReactNode) => (
    <div className={styles.publishSectionHeader} data-publish-section={section}>
      <IconButton icon={open[section] ? "24.chevron.down" : "24.chevron.right"} label={open[section] ? t("Collapse {name}", { name: title }) : t("Expand {name}", { name: title })} onClick={() => setOpen((o) => ({ ...o, [section]: !o[section] }))} />
      {extra}
      <span className={styles.publishSectionTitle}>{t("{title} ({n})", { title, n: list.length })}</span>
    </div>
  );
  const thumb = (r: Row) => (r.item ? <NodeThumb node={r.item.asset.guid} kind={r.kind} size={32} /> : r.removed ? <RemoteThumb asset={r.removed} size={32} /> : <NodeThumb node={r.hidden!.guid} kind={r.kind} size={32} />);
  const drawn = shown >= rows.length ? null : new Set(rows.slice(0, shown).map((r) => r.key));
  const draw = (r: Row) => !drawn || drawn.has(r.key);
  const invalid = rows.filter((r) => r.section === "invalid" && matches(r));
  const unchanged = rows.filter((r) => r.section === "unchanged" && matches(r));
  const hidden = rows.filter((r) => r.section === "hidden" && matches(r));
  const shownChanges = changes.filter(matches);
  const choosable = shownChanges.filter((r) => !locked(r));
  const shownCount = shownChanges.filter(checked).length;

  return (
    <Dialog
      title={t("Publish library")}
      size="medium"
      open
      onClose={close}
      footer={
        <>
          {progress ? (
            <span className={styles.progress} role="status">
              <Spinner /> {t("This library is being published… {done}/{total}", { done: progress.done, total: progress.total })}
            </span>
          ) : org ? (
            <span className={styles.publishTo}>
              <Select
                label={t("Publish to")}
                width="hug"
                value={publishTo}
                disabled={!org.canShare}
                options={[
                  { value: "org", label: t("Everyone at {org}", { org: org.orgName }) },
                  { value: "team", label: t("Everyone on this file's team") },
                ]}
                onChange={(v) => setScope(v as "team" | "org")}
                data-publish-org-scope=""
              />
            </span>
          ) : null}
          <Button variant="secondary" onClick={close}>
            {t("Cancel")}
          </Button>
          <Button variant="primary" loading={!!progress} disabled={!canPublish} onClick={publish}>
            {t("Publish")}
          </Button>
        </>
      }
    >
      <div
        className={styles.publish}
        data-publish-dialog=""
        onKeyDown={(e) => {
          // ⌘Enter / Ctrl+Enter publishes (atlas 12 §3.3), from the description too.
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            e.stopPropagation();
            publish();
          }
        }}
      >
        <div className={styles.publishFile}>
          <Icon name="24.library" className={styles.publishFileIcon} />
          <div className={styles.publishFileText}>
            <span className={styles.publishFileName}>{ed.ui.get().fileName}</span>
            <span className={styles.meta}>{firstPublish ? t("Not published yet") : t("Version {version} · published {date}", { version: state.own!.latestVersion, date: new Date(state.own!.lastPublishedAt).toLocaleDateString(intlLocale(), { month: "short", day: "numeric" }) })}</span>
          </div>
        </div>
        <SearchField value={query} onChange={setQuery} placeholder={t("Search")} data-publish-search="" />
        {!q && <TextArea label={t("Description")} placeholder={t("Describe what changed (optional)")} value={description} onChange={setDescription} />}
        {org && !org.canShare && <span className={styles.orgScopeHint}>{t("Only people who can share this file can change who can access it")}</span>}
        {widens && (
          <Banner tone="warning" data-publish-audience="">
            {t("Publishing to {org} changes this file's settings: anyone in {org} will be able to view it.", { org: org.orgName })}
          </Banner>
        )}
        {error && <div className={styles.error}>{error}</div>}
        {(!draft || !checks) && !error && !progress && (
          <div className={styles.loading}>
            <Spinner /> {t("Looking for changes…")}
          </div>
        )}
        {nothing && !invalid.length && <div className={styles.none}>{t("No changes to publish")}</div>}
        {draft && checks && (
          <div className={styles.changes} role="group" aria-label={t("Changes")}>
            {invalid.length > 0 && (
              <div className={styles.publishSection} data-section="invalid">
                {header("invalid", t("Invalid components"), invalid)}
                {open.invalid &&
                  invalid.filter(draw).map((r) => (
                    <div key={r.key} className={styles.changeRow} data-change={r.name} data-status={r.status} data-invalid="">
                      <Checkbox label={r.name} hideLabel checked={false} disabled onChange={() => {}} />
                      {thumb(r)}
                      <span className={styles.changeText}>
                        <span className={styles.changeName}>{r.name}</span>
                        <span className={styles.publishError} data-publish-error={r.limit ?? r.errors[0]?.kind}>
                          {r.limit ? t(LIMIT_TEXT[r.limit]) : publishErrorLine(r.errors[0])}
                          {r.errors.length > 1 ? ` ${t("(+{n} more)", { n: r.errors.length - 1 })}` : ""}
                        </span>
                      </span>
                    </div>
                  ))}
              </div>
            )}
            {shownChanges.length > 0 && (
              <div className={styles.publishSection} data-section="changes">
                {header(
                  "changes",
                  t("Changes"),
                  shownChanges,
                  <Checkbox
                    label={tp(changes.length, "{count} of {n} change selected", "{count} of {n} changes selected", { count })}
                    hideLabel
                    checked={shownCount > 0 && shownCount === shownChanges.length ? true : shownCount === 0 ? false : MIXED}
                    // With a search, only the rows it shows (atlas 12 §3.3).
                    onChange={(on) => toggle(choosable.map((r) => r.key), on)}
                  />
                )}
                {open.changes &&
                  GROUPS.map((g) => {
                    const list = shownChanges.filter((r) => g.kinds.includes(r.kind));
                    if (!list.length) return null;
                    return (
                      <div key={g.title} className={styles.changeGroup}>
                        <div className={styles.changeGroupTitle}>
                          {t(g.title)} <span className={styles.meta}>{list.length}</span>
                        </div>
                        {list.filter(draw).map((r) => {
                          const users = plan?.usedBy.get(r.key);
                          return (
                            <label key={r.key} className={styles.changeRow} data-change={r.name} data-status={r.status} data-locked={locked(r) ? "" : undefined}>
                              <Checkbox label={r.name} hideLabel checked={checked(r)} disabled={locked(r)} onChange={(on) => click(r, on)} />
                              {thumb(r)}
                              <span className={styles.changeText}>
                                <span className={styles.changeName}>{r.name}</span>
                                {users?.length ? <span className={styles.meta}>{usedByText(users)}</span> : null}
                              </span>
                              <span className={styles[`status_${r.status}`]}>{t(STATUS_LABEL[r.status])}</span>
                            </label>
                          );
                        })}
                      </div>
                    );
                  })}
              </div>
            )}
            {unchanged.length > 0 && (
              <div className={styles.publishSection} data-section="unchanged">
                {header("unchanged", t("Unchanged"), unchanged)}
                {open.unchanged &&
                  unchanged.filter(draw).map((r) => (
                    <div key={r.key} className={styles.changeRow} data-change={r.name} data-status="unchanged">
                      {thumb(r)}
                      <span className={styles.changeName}>{r.name}</span>
                      <span className={styles.status_unchanged}>{t(STATUS_LABEL.unchanged)}</span>
                    </div>
                  ))}
              </div>
            )}
            {hidden.length > 0 && (
              <div className={styles.publishSection} data-section="hidden">
                {header("hidden", t("Hidden"), hidden)}
                {open.hidden && (
                  <>
                    <div className={styles.publishCaption}>{t("These won't be published")}</div>
                    {hidden.filter(draw).map((r) => (
                      <label key={r.key} className={styles.changeRow} data-change={r.name} data-status="hidden">
                        <Checkbox
                          label={t("Include in publish")}
                          hideLabel
                          checked={false}
                          disabled={!r.hidden!.hiddenByFlag || !!progress}
                          onChange={(on) => on && includeHidden(r.hidden!)}
                        />
                        {thumb(r)}
                        <span className={styles.changeText}>
                          <span className={styles.changeName}>{r.name}</span>
                          {!r.hidden!.hiddenByFlag && <span className={styles.meta}>{t("Names starting with _ or . aren't published")}</span>}
                        </span>
                      </label>
                    ))}
                  </>
                )}
              </div>
            )}
            {q && !invalid.length && !shownChanges.length && !unchanged.length && !hidden.length && <div className={styles.none}>{t("No results for “{query}”", { query })}</div>}
          </div>
        )}
        {draft && (draft.moves.length > 0 || movedOut.length > 0) && (
          <div className={styles.changeGroup} role="group" aria-label={t("Moved components")}>
            <div className={styles.changeGroupTitle}>{t("Moved components")}</div>
            {movedOut.map((m) => (
              <div key={m.key} className={styles.moveRow} data-moved-out={m.name}>
                <RemoteThumb asset={m.asset ?? { kind: m.kind, thumbnail: null }} size={32} />
                <div className={styles.moveText}>
                  <span className={styles.changeName}>{m.name}</span>
                  <span className={styles.meta}>{t("Moved to {name}", { name: m.toName })}</span>
                </div>
              </div>
            ))}
            {draft.moves.map((m) => (
              <div key={m.fromKey} className={styles.moveRow} data-move={m.item.asset.name}>
                <NodeThumb node={m.item.asset.guid} kind={m.item.asset.kind} size={32} />
                <div className={styles.moveText}>
                  <span className={styles.changeName}>{m.item.asset.name}</span>
                  <span className={styles.meta}>{t("From {name}", { name: m.fromName })}</span>
                </div>
                <Select
                  width="hug"
                  label={t("{name}: move or copy", { name: m.item.asset.name })}
                  value={moveModes.get(m.fromKey) ?? "move"}
                  options={[
                    { value: "move", label: t("Move to this file") },
                    { value: "copy", label: t("Publish as a copy") },
                  ]}
                  onChange={(v) => setMoveModes((x) => new Map(x).set(m.fromKey, v as "move" | "copy"))}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </Dialog>
  );
}

type Checks = { limits: Map<string, PublishLimitError>; errors: Map<string, PropertyPublishError[]> };

/**
 * What keeps a new or modified asset out of the publish, read once per draft (the selection and the rows both use
 * it): a collection past the limits, a component's property errors — in slices that hand the event loop back.
 */
async function checksOf(ed: ReturnType<typeof useEditor>, d: PublishDraft): Promise<Checks> {
  const limits = publishLimitErrors(ed, d);
  const errors = new Map<string, PropertyPublishError[]>();
  const slice = slicer();
  for (const i of d.items) {
    if ((i.status !== "created" && i.status !== "modified") || !isComponentKind(i.asset.kind)) continue;
    if (slice.due()) await slice.breathe();
    const e = componentPublishErrors(ed, i.asset.guid);
    if (e.length) errors.set(i.key, e);
  }
  return { limits, errors };
}

/** Rows drawn at first, and added per frame after that. */
const ROWS_FIRST = 200;
const ROWS_PER_FRAME = 400;

/** How many of `total` rows to draw: ROWS_FIRST at once, ROWS_PER_FRAME more each frame until all are. */
function useProgressiveCount(total: number): number {
  const [count, setCount] = useState(ROWS_FIRST);
  useEffect(() => {
    if (count >= total) return;
    const raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (f: () => void) => setTimeout(f, 16) as unknown as number;
    const cancel = typeof cancelAnimationFrame === "function" ? cancelAnimationFrame : (id: number) => clearTimeout(id);
    const id = raf(() => setCount((c) => c + ROWS_PER_FRAME));
    return () => cancel(id);
  }, [count, total]);
  return count;
}
