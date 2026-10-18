/**
 * Version history mode (docs/research/atlas/16-comments-versions.md §3.3; docs/data.md §6): File › Show version history
 * puts the history panel in the right panel's place and deselects everything. The panel: "Version history" with a filter
 * (All / Only yours, Show autosave versions — on by default), + (Add to version history) and close; "Current version",
 * then the versions newest first, 30 at a time (Show older), consecutive autosaves folded into "N autosave versions".
 * A click shows that version on the canvas, read-only, in an engine of its own over the editor's ("Viewing …"); a
 * double-click names it; ↑ / ↓ step through them; Esc leaves. Each row's ••• (or right-click): Name this version /
 * Edit version info, Restore this version, Duplicate, Delete version info, Copy link — branching's own versions:
 * Restore, Duplicate, Copy link (and Undo merge on main's "Branch merged").
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ContextMenu, currentTheme, Icon, IconButton, MenuButton, Spinner, showToast, type MenuEntry } from "@/ds";
import { Engine } from "@/engine/Engine";
import type { Guid, Message } from "@/engine/codec";
import { t, tp, useT } from "@/i18n";
import { attachViewerCanvas } from "../../../viewer/ViewerCanvas";
import { ViewerDoc } from "../../../viewer/viewerDoc";
import { openFile } from "../files/desktop";
import { useEditor, type EditorController } from "./controller";
import type { VersionInfo } from "./documentSource";
import { applyEngineBytes } from "./engineCompat";
import { useUI } from "./hooks";
import { RESTORE_VERSION } from "./libraries";
import { historyRows, isAutosave, isBranchingVersion, linkedVersion, SELECT_DEBOUNCE_MS, steppable, versionLink, versionTime, VERSIONS_PAGE, viewingLabel } from "./versionList";
import styles from "./VersionHistory.module.css";

const KIND_TITLE: Record<VersionInfo["kind"], string> = { autosave: "Autosave", named: "Autosave", restore: "Restored version", publish: "Library published", import: "Imported", branch: "Branch created", update: "Updated from main", merge: "Branch merged" };

/** A version's title: its label, else what made it */
export const versionTitle = (v: VersionInfo) => v.title || t(KIND_TITLE[v.kind]);

// The list changes from outside the panel (the savepoint modal, a restore): the panel reads it again.
const changed = new Set<() => void>();
export function versionsChanged(): void {
  for (const l of changed) l();
}

/** Leaves history mode: the current version back on the canvas */
export function exitVersionHistory(ed: EditorController): void {
  ed.ui.set({ versionDialog: null, historyVersion: null });
  ed.focusCanvas();
}

/** Restores a version as one undoable edit ("Restore version"), recorded as a restore version. */
export async function restoreVersion(ed: EditorController, v: VersionInfo): Promise<boolean> {
  if (!ed.source.restoreVersion) return false;
  try {
    await ed.source.flush();
    // "restore": the store's diff written exactly (library copies included, docs/engine-build.md "Libraries — review
    // fixes" (d)), one undo step.
    await ed.source.restoreVersion(v.id, (diff, bytes) =>
      ed.batch(RESTORE_VERSION, () => {
        // The store's diff as it is for an engine that reads kiwi; converted for one that doesn't.
        if (!bytes || applyEngineBytes(ed.engine, bytes, "restore") === null) ed.engine.applyChanges(diff, "restore");
      }),
    );
    // Assets the version brings back carry the bookkeeping they had then: checked against the latest publish.
    void ed.libraries.reconcile();
    showToast({ message: t("Version restored") });
    versionsChanged();
    return true;
  } catch {
    showToast({ message: t("The version couldn't be restored"), kind: "error" });
    return false;
  }
}

/** The right panel in history mode */
export function VersionHistoryPanel() {
  useT();
  const ed = useEditor();
  const selected = useUI((s) => s.historyVersion ?? null);
  const [versions, setVersions] = useState<VersionInfo[] | null>(null);
  const [error, setError] = useState(false);
  const [showAutosaves, setShowAutosaves] = useState(true);
  const [onlyYours, setOnlyYours] = useState(false);
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const [shown, setShown] = useState(VERSIONS_PAGE);
  const [menu, setMenu] = useState<{ x: number; y: number; v: VersionInfo } | null>(null);
  const clickTimer = useRef<number | null>(null);
  const list = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    void ed.source
      .listVersions?.()
      .then((l) => {
        setVersions(l);
        setError(false);
      })
      .catch(() => setError(true));
  }, [ed]);
  useEffect(() => {
    load();
    changed.add(load);
    return () => void changed.delete(load);
  }, [load]);
  // The heading takes the focus as the panel opens (Figma's h2), so ↑ / ↓ and Esc work at once.
  useEffect(() => list.current?.focus({ preventScroll: true }), []);

  const select = (id: string | null) => {
    ed.ui.set({ historyVersion: id });
    const v = id ? versions?.find((x) => x.id === id) : null;
    // Figma: after two animation frames, "Viewing …" with the version's label or time.
    if (v) requestAnimationFrame(() => requestAnimationFrame(() => showToast({ message: t("Viewing {version}", { version: viewingLabel(v.title || versionTime(v.createdAt)) }) })));
  };
  const click = (id: string | null) => {
    if (clickTimer.current) clearTimeout(clickTimer.current);
    clickTimer.current = window.setTimeout(() => select(id), SELECT_DEBOUNCE_MS);
  };
  const edit = (v: VersionInfo) => {
    if (clickTimer.current) clearTimeout(clickTimer.current);
    if (!isBranchingVersion(v) && ed.source.updateVersion) ed.ui.set({ savepoint: { version: v } });
  };

  const filter = { showAutosaves };
  // Only yours keeps every version: a file's history doesn't record its editors yet (one author locally; Phase 6's
  // server will name them), so every version is yours.
  const all = versions ?? [];
  const rows = historyRows(all, filter, opened, selected, shown);
  const order = steppable(all, filter, shown);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape" && !menu) {
      e.preventDefault();
      exitVersionHistory(ed);
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const at = selected ? order.findIndex((v) => v.id === selected) : -1;
    const next = Math.max(-1, Math.min(order.length - 1, at + (e.key === "ArrowDown" ? 1 : -1)));
    if (next !== at) select(next < 0 ? null : order[next].id);
  };

  const entriesFor = (v: VersionInfo): MenuEntry[] => {
    const branching = isBranchingVersion(v);
    const named = !!v.title;
    return [
      ...(!branching && ed.source.updateVersion ? [{ id: "name", label: named ? t("Edit version info") : t("Name this version") }] : []),
      { id: "restore", label: branching ? t("Restore") : t("Restore this version"), disabled: !ed.source.restoreVersion },
      { id: "duplicate", label: t("Duplicate"), disabled: !ed.source.duplicateVersion },
      ...(!branching && ed.source.updateVersion ? [{ id: "clear", label: t("Delete version info"), disabled: !named && !v.description }] : []),
      { id: "link", label: t("Copy link") },
    ];
  };
  const onMenu = async (id: string, v: VersionInfo) => {
    setMenu(null);
    if (id === "name") edit(v);
    else if (id === "restore") {
      if (await restoreVersion(ed, v)) ed.ui.set({ historyVersion: null });
    } else if (id === "duplicate") {
      try {
        const file = await ed.source.duplicateVersion!(v.id);
        showToast({ message: t("Duplicated to Drafts"), action: { label: t("Open"), onAction: () => void openFile(file.fileKey, { newTab: true, title: file.name }) } });
      } catch {
        showToast({ message: t("The version couldn't be duplicated"), kind: "error" });
      }
    } else if (id === "clear") {
      await ed.source.updateVersion?.(v.id, { title: "", description: "" }).then(load, () => showToast({ message: t("The version couldn't be saved"), kind: "error" }));
    } else if (id === "link") {
      void navigator.clipboard?.writeText(versionLink(location.href, v.id)).then(
        () => showToast({ message: t("Copied link to clipboard") }),
        () => showToast({ message: t("Failed to copy link"), kind: "error" }),
      );
    }
  };

  const filterEntries: MenuEntry[] = [
    { id: "all", label: t("All"), checked: !onlyYours, radio: true },
    { id: "yours", label: t("Only yours"), checked: onlyYours, radio: true },
    "-",
    { id: "autosaves", label: t("Show autosave versions"), checked: showAutosaves },
  ];
  const filtering = onlyYours || !showAutosaves;

  const row = (v: VersionInfo) => (
    <VersionRow
      key={v.id}
      v={v}
      selected={selected === v.id}
      onClick={() => click(v.id)}
      onDoubleClick={() => edit(v)}
      onMenu={(x, y) => setMenu({ x, y, v })}
    />
  );

  return (
    <aside className={styles.panel} aria-label={t("Version history")} data-panel="history">
      <header className={styles.header}>
        <h2 className={styles.heading}>{t("Version history")}</h2>
        <span className={styles.grow} />
        <MenuButton
          label={filtering ? t("Filters enabled") : t("Filter")}
          entries={filterEntries}
          align="end"
          className={styles.headerButton}
          onSelect={(id) => (id === "autosaves" ? setShowAutosaves((s) => !s) : setOnlyYours(id === "yours"))}
        >
          <span className={styles.headerGlyph} data-on={filtering || undefined}>
            <Icon name="24.filter" />
          </span>
        </MenuButton>
        <IconButton icon="24.plus" label={t("Add to version history")} disabled={!ed.source.saveVersion} onClick={() => ed.ui.set({ savepoint: { version: null } })} />
        <IconButton icon="24.close.small" label={t("Close")} onClick={() => exitVersionHistory(ed)} />
      </header>
      <div ref={list} className={styles.list} role="listbox" aria-label={t("Version history")} tabIndex={-1} onKeyDown={onKeyDown}>
        <button type="button" role="option" aria-selected={selected === null} className={styles.row} data-selected={selected === null || undefined} id="current_version" onClick={() => click(null)}>
          <span className={styles.dot} data-current="" />
          <span className={styles.rowMain}>
            <span className={styles.title}>{t("Current version")}</span>
          </span>
        </button>
        {versions === null && !error && (
          <div className={styles.loading}>
            <Spinner size={24} />
          </div>
        )}
        {error && <p className={styles.error}>{t("Version history couldn't be loaded")}</p>}
        {rows.map((r) =>
          r.type === "version" ? (
            row(r.version)
          ) : (
            <div key={r.id} className={styles.group} data-open={r.open || undefined}>
              <button
                type="button"
                className={styles.groupHead}
                aria-expanded={r.open}
                onClick={() =>
                  setOpened((o) => {
                    const next = new Set(o);
                    if (r.open) next.delete(r.id);
                    else next.add(r.id);
                    return next;
                  })
                }
              >
                <span className={styles.disclosure} aria-hidden>
                  <Icon name={r.open ? "16.chevron.down" : "16.chevron.right"} />
                </span>
                {tp(r.versions.length, "{n} autosave version", "{n} autosave versions")}
              </button>
              {r.open && r.versions.map(row)}
            </div>
          ),
        )}
        {versions && versions.length > shown && (
          <button type="button" className={styles.older} onClick={() => setShown((n) => n + VERSIONS_PAGE)}>
            {t("Show older")}
          </button>
        )}
      </div>
      {menu && <ContextMenu at={{ x: menu.x, y: menu.y }} entries={entriesFor(menu.v)} label={t("More options")} onClose={() => setMenu(null)} onSelect={(id) => void onMenu(id, menu.v)} />}
    </aside>
  );
}

function VersionRow({ v, selected, onClick, onDoubleClick, onMenu }: { v: VersionInfo; selected: boolean; onClick(): void; onDoubleClick(): void; onMenu(x: number, y: number): void }) {
  useT();
  const [more, setMore] = useState(false);
  const autosave = isAutosave(v);
  const long = (v.description?.length ?? 0) > 120;
  return (
    <div
      role="option"
      aria-selected={selected}
      tabIndex={-1}
      className={styles.row}
      data-selected={selected || undefined}
      data-version={v.id}
      data-autosave={autosave || undefined}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(e.clientX, e.clientY);
      }}
    >
      <span className={styles.dot} />
      <span className={styles.rowMain}>
        <span className={styles.title}>{versionTitle(v)}</span>
        <span className={styles.time}>{versionTime(v.createdAt)}</span>
        {v.description && (
          <span className={styles.description} data-clamped={(long && !more) || undefined}>
            {v.description}
          </span>
        )}
        {long && (
          <button
            type="button"
            className={styles.more}
            onClick={(e) => {
              e.stopPropagation();
              setMore(!more);
            }}
          >
            {more ? t("Show less") : t("Show more")}
          </button>
        )}
      </span>
      <IconButton
        className={styles.rowMenu}
        icon="24.more"
        label={t("More options")}
        onClick={(e) => {
          e.stopPropagation();
          const r = e.currentTarget.getBoundingClientRect();
          onMenu(r.left, r.bottom + 4);
        }}
      />
    </div>
  );
}

/** In history mode, the selected version on the canvas: an engine of its own over the editor's, read-only. */
export function VersionPreview() {
  const id = useUI((s) => (s.versionDialog === "history" ? (s.historyVersion ?? null) : null));
  return id ? <Preview id={id} /> : null;
}

function Preview({ id }: { id: string }) {
  useT();
  const ed = useEditor();
  const canvas = useRef<HTMLCanvasElement>(null);
  const engine = useRef<Engine | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const shown = useRef<string | null>(null);
  const detach = useRef<(() => void) | null>(null);

  // One engine while the mode lasts (each version loaded into it), gone with it.
  useEffect(
    () => () => {
      detach.current?.();
      engine.current?.destroy();
      engine.current = null;
    },
    [],
  );

  useEffect(() => {
    if (!ed.source.openVersion || !canvas.current) return;
    let off = false;
    setLoading(true);
    setFailed(false);
    void (async () => {
      try {
        const message = (await ed.source.openVersion!(id)) as Message;
        if (off) return;
        let e = engine.current;
        if (!e) {
          e = engine.current = await Engine.create(canvas.current!, { sessionID: 1, theme: currentTheme().resolved === "light" ? "LIGHT" : "DARK" });
          if (off) return;
          const images = ed.source.images;
          if (images) e.setImageSource((h) => images.get(h));
          const doc = new ViewerDoc(e);
          detach.current = attachViewerCanvas(canvas.current!, e, { parentOf: (g) => doc.parentOf(g) });
        }
        // The page and view the editor shows, when the version has that page.
        const page = ed.store.page;
        const first = shown.current === null;
        e.load(message);
        e.setViewerMode(true);
        if (page && e.readNode(page as Guid, { fields: ["type"] })) e.setCurrentPage(page as Guid);
        if (first) e.setCamera(ed.engine.getCamera());
        shown.current = id;
      } catch (err) {
        console.warn("version history: couldn't open the version", err);
        if (!off) setFailed(true);
      } finally {
        if (!off) setLoading(false);
      }
    })();
    return () => {
      off = true;
    };
  }, [ed, id]);

  return (
    <div className={styles.preview} data-version-preview={id}>
      <canvas ref={canvas} id="version-preview-canvas" className={styles.previewCanvas} aria-label={t("Version preview")} />
      {loading && (
        <div className={styles.previewState}>
          <Spinner size={24} />
        </div>
      )}
      {failed && <p className={styles.previewState}>{t("This version couldn't be opened")}</p>}
    </div>
  );
}

/** A link with `version-id` opens the history on that version (once, as the editor starts). */
export function VersionLinkOpener() {
  const ed = useEditor();
  useEffect(() => {
    const id = typeof location !== "undefined" ? linkedVersion(location.search) : null;
    if (id && ed.source.listVersions) ed.ui.set({ versionDialog: "history", historyVersion: id });
  }, [ed]);
  return null;
}
