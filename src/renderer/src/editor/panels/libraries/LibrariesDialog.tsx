/**
 * The Libraries modal (UI3; help.figma.com "Enable libraries", "Review and accept updates", R5): the current file
 * (publish it, or "Move to a folder to publish" in Drafts), the libraries added to this file (Remove from file —
 * what is used stays), the workspace's other published libraries (Add to file), search, and a preview of a
 * library's components, styles and variables. The Updates tab lists what the enabled libraries changed for the
 * assets used here, and each one's review: before / after side by side or overlaid, Update selected instance,
 * Update, Update all; removed assets (Restore component) and moved ones (accepted with the update).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Button, EmptyState, Icon, IconButton, SearchField, SegmentedControl, Spinner, showToast, cx, Dialog, tooltipProps, type IconName } from "@/ds";
import type { LibraryAsset, LibraryVersion } from "../../../../../shared/store/types";
import { useEditor } from "../../controller";
import { useDocumentVersion, useLibraries, useUI } from "../../hooks";
import { acceptUpdates, restoreRemovedComponent, selectedInstancesOf, setLibraryEnabled, updateId, updateSelectedInstances, type UpdateItem } from "../../libraries";
import type { LibraryEntry } from "../../documentSource";
import { NodeThumb, RemoteThumb, kindGlyph } from "./Thumbs";
import styles from "./Libraries.module.css";
import { EditorLibraryAnalytics } from "../../analytics/EditorAnalytics";
import { t, tp, useT } from "@/i18n";

export function LibrariesDialog() {
  const open = useUI((s) => s.librariesDialog);
  return (
    <>
      {open ? <Libraries /> : null}
      <EditorLibraryAnalytics />
    </>
  );
}

const countsText = (c: { components: number; styles: number; variables: number }) => {
  const parts = [c.components && tp(c.components, "{n} component", "{n} components"), c.styles && tp(c.styles, "{n} style", "{n} styles"), c.variables && tp(c.variables, "{n} variable", "{n} variables")].filter(Boolean);
  return parts.length ? parts.join(" · ") : t("No assets");
};

function Libraries() {
  useT();
  const ed = useEditor();
  const view = useUI((s) => s.librariesDialog)!;
  const state = useLibraries();
  const pending = ed.libraries.pendingCount();
  const close = () => {
    ed.ui.set({ librariesDialog: null });
    ed.focusCanvas();
  };
  const set = (patch: Partial<NonNullable<typeof view>>) => ed.ui.set({ librariesDialog: { ...view, ...patch } });
  // Moving between the list, a preview and a review unmounts the focused control: keep focus in the dialog (Esc).
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const box = body.current?.closest<HTMLElement>('[role="dialog"]');
    if (box && !box.contains(document.activeElement)) box.focus({ preventScroll: true });
  }, [view.tab, view.library, view.update]);
  const [query, setQuery] = useState("");
  const tabs: { value: "libraries" | "updates"; label: string; icon: IconName; badge?: number }[] = [
    { value: "libraries", label: t("This file"), icon: "24.library.this-file" },
    { value: "updates", label: t("Updates"), icon: "24.library.updates", badge: pending || undefined },
  ];
  // Live 2026-10-18 (menus.txt): "Manage libraries", 591 × 641 — a 200 left nav (search, This file, Updates) and the
  // content from 216.
  return (
    <Dialog title={t("Manage libraries")} size="libraries" compact open onClose={close}>
      <div ref={body} className={styles.libraries} data-libraries-dialog="">
        <nav className={styles.libNav} aria-label={t("Manage libraries")}>
          <SearchField value={query} onChange={setQuery} placeholder={t("Search all libraries")} autoFocus />
          <div role="tablist" aria-orientation="vertical" className={styles.libTabs}>
            {tabs.map((tab) => (
              <button
                key={tab.value}
                type="button"
                role="tab"
                aria-selected={view.tab === tab.value}
                className={styles.libTab}
                onClick={() => set({ tab: tab.value, library: null, update: null })}
              >
                <Icon name={tab.icon} />
                <span className={styles.libTabLabel}>{tab.label}</span>
                {tab.badge ? <span className={styles.libTabBadge}>{tab.badge}</span> : null}
              </button>
            ))}
          </div>
        </nav>
        <div className={styles.libContent}>
        {!state.on ? (
          <EmptyState icon="24.library" title={t("Libraries aren't available here")} body={t("Open a file from your workspace to publish and use libraries.")} />
        ) : view.tab === "updates" ? (
          view.update ? <ReviewUpdate id={view.update} onBack={() => set({ update: null })} /> : <Updates onOpen={(id) => set({ update: id })} />
        ) : view.library ? (
          <LibraryPreview lib={view.library} onBack={() => set({ library: null })} />
        ) : (
          <LibraryList query={query} onOpen={(lib) => set({ library: lib })} onPublish={() => ed.ui.set({ publishOpen: true, librariesDialog: null })} />
        )}
        </div>
      </div>
    </Dialog>
  );
}

function LibraryList({ query, onOpen, onPublish }: { query: string; onOpen: (lib: string) => void; onPublish: () => void }) {
  useT();
  const ed = useEditor();
  const state = useLibraries();
  const [busy, setBusy] = useState<string | null>(null);
  const q = query.trim().toLowerCase();
  const match = (name: string) => !q || name.toLowerCase().includes(q);
  const byKey = new Map(state.available.map((e) => [e.fileKey, e]));
  const added = pinApproved(state.enabled.map((lib) => byKey.get(lib) ?? { fileKey: lib, name: state.names.get(lib) ?? t("Missing library"), location: "", record: null }).filter((e) => match(e.name)) as LibraryEntry[]);
  const others = state.available.filter((e) => !state.enabled.includes(e.fileKey) && match(e.name));
  const sections = otherSections(others, state.org?.orgName ?? null);
  const toggle = async (lib: string, on: boolean, name: string) => {
    setBusy(lib);
    try {
      await setLibraryEnabled(ed, lib, on);
      showToast({ message: on ? t("Added {name} to this file", { name }) : t("Removed {name} from this file", { name }) });
    } catch {
      showToast({ message: on ? t("The library couldn't be added") : t("The library couldn't be removed"), kind: "error" });
    } finally {
      setBusy(null);
    }
  };
  const own = state.own;
  const fileName = useUI((s) => s.fileName);
  return (
    <div className={styles.listBody}>
      {state.loading && (
        <div className={styles.loading}>
          <Spinner /> {t("Loading libraries…")}
        </div>
      )}
      <section aria-label={t("Current file")}>
        <div className={styles.sectionTitle}>{t("Current file")}</div>
        <div className={styles.libRow} data-library-row="current">
          <LibIcon />
          <div className={styles.libText}>
            <span className={styles.libName}>{fileName}</span>
            <span className={styles.meta}>{state.inDrafts ? t("In Drafts · Move to a folder to publish") : own ? t("{counts} · Version {version}", { counts: countsText(own.counts), version: own.latestVersion }) : t("Not published")}</span>
          </div>
          <Button variant="secondary" disabled={state.inDrafts} tooltip={state.inDrafts ? t("Move to a folder to publish") : undefined} onClick={onPublish}>
            {own ? t("Publish changes…") : t("Publish…")}
          </Button>
        </div>
      </section>
      <section aria-label={t("Libraries added to this file")}>
        <div className={styles.sectionTitle}>{t("Libraries added to this file")}</div>
        {added.length === 0 && <div className={styles.none}>{q ? t("No results for “{query}”", { query }) : t("No libraries added to this file")}</div>}
        {added.map((e) => (
          <LibraryRow key={e.fileKey} entry={e} orgName={state.org?.orgName ?? null} missing={!byKey.has(e.fileKey)} onOpen={byKey.has(e.fileKey) ? () => onOpen(e.fileKey) : undefined}>
            <Button variant="secondary" loading={busy === e.fileKey} onClick={() => void toggle(e.fileKey, false, e.name)}>
              {t("Remove from file")}
            </Button>
          </LibraryRow>
        ))}
      </section>
      {sections.map((s, i) => (
        <section key={s.title} aria-label={s.title}>
          <div className={styles.sectionTitle}>{s.title}</div>
          {i === 0 && others.length === 0 && <div className={styles.none}>{q ? t("No results for “{query}”", { query }) : state.available.length ? t("Every library is added to this file") : t("No other files are published as libraries yet")}</div>}
          {s.entries.map((e) => (
            <LibraryRow key={e.fileKey} entry={e} orgName={state.org?.orgName ?? null} onOpen={() => onOpen(e.fileKey)}>
              <Button variant="primary" loading={busy === e.fileKey} onClick={() => void toggle(e.fileKey, true, e.name)}>
                {t("Add to file")}
              </Button>
            </LibraryRow>
          ))}
        </section>
      ))}
    </div>
  );
}

function LibIcon() {
  return (
    <span className={styles.libIcon}>
      <Icon name="24.library" />
    </span>
  );
}

/** Approved libraries first (help "Help people find and use libraries": "pinned to the top"), each list's order kept. */
export function pinApproved(list: readonly LibraryEntry[]): LibraryEntry[] {
  return [...list.filter((e) => e.org?.approved), ...list.filter((e) => !e.org?.approved)];
}

/**
 * The libraries this file can add, in sections: a local file's workspace ("Libraries in this workspace"); an org
 * file's per team — the person's teams (or the file shared with them) by team name, then the libraries published to
 * the whole organization under its name (the headings are ours: Figma's UI3 modal wasn't captured). Approved first.
 */
export function otherSections(others: readonly LibraryEntry[], orgName: string | null): { title: string; entries: LibraryEntry[] }[] {
  // An org file (its org known) keeps its org heading even when every library is added (no entry left to tell).
  if (orgName === null && !others.some((e) => e.org)) return [{ title: t("Libraries in this workspace"), entries: [...others] }];
  const teams = new Map<string, LibraryEntry[]>();
  const org: LibraryEntry[] = [];
  for (const e of others) {
    const mine = !e.org || e.org.via.includes("team") || e.org.via.includes("file");
    if (mine && e.org?.teamName) teams.set(e.org.teamName, [...(teams.get(e.org.teamName) ?? []), e]);
    else org.push(e);
  }
  const out = [...teams].sort(([a], [b]) => a.localeCompare(b)).map(([title, entries]) => ({ title, entries: pinApproved(entries) }));
  out.push({ title: orgName ?? t("Organization"), entries: pinApproved(org) });
  return out.filter((s, i) => i === 0 || s.entries.length);
}

/** An approved library's check mark and its tooltip ("Approved by ‹org› admin", the help's screenshot) */
export function ApprovedMark({ entry, orgName }: { entry: LibraryEntry | undefined; orgName: string | null }) {
  useT();
  const approved = entry?.org?.approved;
  if (!approved) return null;
  // The workspace's wording is ours (unverified): Figma's article shows only the organization's.
  const text = approved === "org" ? (orgName ? t("Approved by {org} admin", { org: orgName }) : t("Approved by organization admin")) : t("Approved by workspace admin");
  return (
    <span className={styles.approved} data-approved={approved} aria-label={text} {...tooltipProps(text)}>
      <Icon name="16.check" />
    </span>
  );
}

function LibraryRow({ entry, orgName = null, missing, onOpen, children }: { entry: LibraryEntry; orgName?: string | null; missing?: boolean; onOpen?: () => void; children: React.ReactNode }) {
  useT();
  return (
    <div className={styles.libRow} data-library-row={entry.name}>
      <LibIcon />
      <button type="button" className={styles.libOpen} onClick={onOpen} disabled={!onOpen} aria-label={t("Preview {name}", { name: entry.name })}>
        <span className={styles.libNameRow}>
          <span className={styles.libName}>{entry.name}</span>
          <ApprovedMark entry={entry} orgName={orgName} />
        </span>
        <span className={styles.meta}>{missing ? t("Missing library · assets used here keep working") : [entry.location, countsText(entry.record.counts)].filter(Boolean).join(" · ")}</span>
      </button>
      {children}
    </div>
  );
}

/** A library's components (thumbnails), styles and variables, with Add to file / Remove from file. */
function LibraryPreview({ lib, onBack }: { lib: string; onBack: () => void }) {
  useT();
  const ed = useEditor();
  const state = useLibraries();
  const entry = state.available.find((e) => e.fileKey === lib);
  const [manifest, setManifest] = useState<LibraryVersion | null>(null);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  useEffect(() => {
    let live = true;
    void ed.libraries.manifest(lib).then((m) => live && setManifest(m));
    return () => {
      live = false;
    };
  }, [ed, lib]);
  const enabled = state.enabled.includes(lib);
  const q = query.trim().toLowerCase();
  const listed = (manifest?.assets ?? []).filter((a) => !a.dependencyOnly && (!q || a.name.toLowerCase().includes(q)));
  const components = listed.filter((a) => a.kind === "COMPONENT" || a.kind === "COMPONENT_SET");
  const styleAssets = listed.filter((a) => a.kind === "STYLE");
  const variables = listed.filter((a) => a.kind === "VARIABLE");
  const collections = new Map((manifest?.assets ?? []).filter((a) => a.kind === "VARIABLE_COLLECTION").map((a) => [a.key, a.name]));
  const toggle = async () => {
    setBusy(true);
    try {
      await setLibraryEnabled(ed, lib, !enabled);
    } catch {
      showToast({ message: enabled ? t("The library couldn't be removed") : t("The library couldn't be added"), kind: "error" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={styles.listBody} data-library-preview={entry?.name ?? ""}>
      <div className={styles.previewHeader}>
        <IconButton icon="24.arrow.left" label={t("Back to libraries")} onClick={onBack} />
        <div className={styles.libText}>
          <span className={styles.libName}>{entry?.name ?? state.names.get(lib) ?? t("Library")}</span>
          <span className={styles.meta}>{entry ? `${entry.location} · ${countsText(entry.record.counts)}` : ""}</span>
        </div>
        <Button variant={enabled ? "secondary" : "primary"} loading={busy} onClick={() => void toggle()}>
          {enabled ? t("Remove from file") : t("Add to file")}
        </Button>
      </div>
      <SearchField value={query} onChange={setQuery} placeholder={t("Search assets")} />
      {!manifest && (
        <div className={styles.loading}>
          <Spinner /> {t("Loading…")}
        </div>
      )}
      {manifest && manifest.description && <div className={styles.meta}>{t("Version {version}: {description}", { version: manifest.version, description: manifest.description })}</div>}
      {components.length > 0 && (
        <section aria-label={t("Components")}>
          <div className={styles.sectionTitle}>{t("Components")}</div>
          <div className={styles.previewGrid}>
            {components.map((a) => (
              <div key={a.key} className={styles.previewTile} title={a.description ? `${a.name}\n${a.description}` : a.name}>
                <RemoteThumb asset={a} size={88} className={styles.previewThumb} />
                <span className={styles.tileName}>{a.name}</span>
              </div>
            ))}
          </div>
        </section>
      )}
      {styleAssets.length > 0 && (
        <section aria-label={t("Styles")}>
          <div className={styles.sectionTitle}>{t("Styles")}</div>
          {styleAssets.map((a) => (
            <div key={a.key} className={styles.assetRow}>
              <Icon name={kindGlyph(a.kind, a)} className={styles.thumbGlyph} />
              <span className={styles.changeName}>{a.name}</span>
              <span className={styles.meta}>{a.styleType === "FILL" ? t("Color") : a.styleType === "TEXT" ? t("Text") : a.styleType === "EFFECT" ? t("Effect") : t("Layout guide")}</span>
            </div>
          ))}
        </section>
      )}
      {variables.length > 0 && (
        <section aria-label={t("Variables")}>
          <div className={styles.sectionTitle}>{t("Variables")}</div>
          {variables.map((a) => (
            <div key={a.key} className={styles.assetRow}>
              <Icon name={kindGlyph(a.kind, a)} className={styles.thumbGlyph} />
              <span className={styles.changeName}>{a.name}</span>
              <span className={styles.meta}>{collections.get(a.collectionKey ?? "") ?? ""}</span>
            </div>
          ))}
        </section>
      )}
      {manifest && !listed.length && <div className={styles.none}>{q ? t("No results for “{query}”", { query }) : t("This library has no assets")}</div>}
    </div>
  );
}

const KIND_TEXT: Record<UpdateItem["kind"], string> = { modified: "Modified", removed: "Removed from library", moved: "Moved" };

const instancesText = (n: number) => (n ? ` · ${tp(n, "{n} instance", "{n} instances")}` : "");

function Updates({ onOpen }: { onOpen: (id: string) => void }) {
  useT();
  const ed = useEditor();
  useLibraries();
  useDocumentVersion();
  const [busy, setBusy] = useState(false);
  const updates = ed.libraries.updates();
  const byLib = new Map<string, UpdateItem[]>();
  for (const u of updates) byLib.set(u.library, [...(byLib.get(u.library) ?? []), u]);
  const acceptable = updates.filter((u) => u.kind !== "removed");
  const all = async () => {
    setBusy(true);
    try {
      const n = await acceptUpdates(ed, acceptable);
      if (n) showToast({ message: tp(n, "Updated {n} asset", "Updated {n} assets"), kind: "success" });
    } finally {
      setBusy(false);
    }
  };
  if (!updates.length) return <EmptyState icon="24.library" title={t("You're up to date")} body={t("Updates to the libraries this file uses show up here.")} />;
  return (
    <div className={styles.listBody} data-updates="">
      <div className={styles.updatesHeader}>
        <span className={styles.meta}>{tp(acceptable.length, "{n} update available", "{n} updates available")}</span>
        <Button variant="primary" loading={busy} disabled={!acceptable.length} onClick={() => void all()}>
          {t("Update all")}
        </Button>
      </div>
      {[...byLib].map(([lib, list]) => (
        <section key={lib} aria-label={list[0].libraryName}>
          <div className={styles.sectionTitle}>{list[0].libraryName}</div>
          {list.map((u) => (
            <button key={updateId(u)} type="button" className={styles.updateRow} data-update={u.copy.name} onClick={() => onOpen(updateId(u))}>
              {u.asset ? <RemoteThumb asset={u.asset} size={32} /> : <NodeThumb node={u.copy.guid} kind={u.copy.kind} size={32} />}
              <span className={styles.libText}>
                <span className={styles.libName}>{u.copy.name}</span>
                <span className={styles.meta}>
                  {u.kind === "moved" ? t("Moved to {name}", { name: u.redirect?.toLibraryFileKey ? (ed.libraries.get().names.get(u.redirect.toLibraryFileKey) ?? t("another library")) : t("another library") }) : t(KIND_TEXT[u.kind])}
                  {instancesText(ed.libraries.usageOf(u))}
                </span>
              </span>
              <Icon name="16.chevron.right" className={styles.caret} />
            </button>
          ))}
        </section>
      ))}
    </div>
  );
}

/** One update: before (the copy here) and after (the published thumbnail), side by side or overlaid; its actions. */
function ReviewUpdate({ id, onBack }: { id: string; onBack: () => void }) {
  useT();
  const ed = useEditor();
  useLibraries();
  useDocumentVersion();
  const [mode, setMode] = useState<"side" | "overlay">("side");
  const [busy, setBusy] = useState(false);
  const u = ed.libraries.updates().find((x) => updateId(x) === id);
  const selected = useMemo(() => (u ? selectedInstancesOf(ed, u.copies.map((c) => c.guid)) : []), [ed, u]);
  if (!u) {
    return (
      <div className={styles.listBody}>
        <div className={styles.previewHeader}>
          <IconButton icon="24.arrow.left" label={t("Back to updates")} onClick={onBack} />
          <span className={styles.libName}>{t("Updated")}</span>
        </div>
        <EmptyState icon="24.check" title={t("This asset is up to date")} />
      </div>
    );
  }
  const run = async <T,>(f: () => Promise<T>, message: (result: T) => string | null, back = false) => {
    setBusy(true);
    try {
      const text = message(await f());
      if (text) showToast({ message: text, kind: "success" });
      if (back) onBack(); // the list again (Figma), what's left to review
    } finally {
      setBusy(false);
    }
  };
  const isComponent = u.copy.kind === "COMPONENT" || u.copy.kind === "COMPONENT_SET";
  const usage = ed.libraries.usageOf(u);
  return (
    <div className={styles.listBody} data-review-update={u.copy.name}>
      <div className={styles.previewHeader}>
        <IconButton icon="24.arrow.left" label={t("Back to updates")} onClick={onBack} />
        <div className={styles.libText}>
          <span className={styles.libName}>{u.copy.name}</span>
          <span className={styles.meta}>
            {u.libraryName} · {u.kind === "modified" ? t("Modified") : u.kind === "removed" ? t("Removed from library") : t("Moved")}
            {usage ? ` · ${tp(usage, "{n} instance in this file", "{n} instances in this file")}` : ""}
          </span>
        </div>
        {u.kind === "modified" && isComponent && <SegmentedControl label={t("Compare")} value={mode} options={[{ value: "side", label: t("Side by side") }, { value: "overlay", label: t("Overlay") }]} onChange={(v) => setMode(v as "side" | "overlay")} />}
      </div>
      {u.kind === "modified" && (
        <div className={cx(styles.compare, mode === "overlay" && styles.compareOverlay)} data-compare={mode}>
          <figure className={styles.compareSide}>
            <NodeThumb node={u.copy.guid} kind={u.copy.kind} size={200} className={styles.compareThumb} />
            <figcaption className={styles.meta}>{t("Current")}</figcaption>
          </figure>
          <figure className={styles.compareSide}>
            <RemoteThumb asset={u.asset as LibraryAsset} size={200} className={styles.compareThumb} />
            <figcaption className={styles.meta}>{t("Updated")}</figcaption>
          </figure>
        </div>
      )}
      {u.kind === "removed" && (
        <div className={styles.notice}>
          {isComponent ? t("This component was removed from {library}. What uses it here keeps working.", { library: u.libraryName }) : t("This asset was removed from {library}. What uses it here keeps working.", { library: u.libraryName })}
          {isComponent ? ` ${t("Restore it to keep it as a component of this file.")}` : ""}
        </div>
      )}
      {u.kind === "moved" && <div className={styles.notice}>{t("This component moved to {library}. Accepting keeps every instance linked and adds that library to this file.", { library: ed.libraries.get().names.get(u.redirect!.toLibraryFileKey) ?? t("another library") })}</div>}
      {u.asset?.description && <div className={styles.meta}>{u.asset.description}</div>}
      <div className={styles.reviewActions}>
        {u.kind === "modified" && isComponent && (
          <Button variant="secondary" disabled={busy || !selected.length} tooltip={selected.length ? undefined : t("Select instances of this component on the canvas")} onClick={() => void run(() => updateSelectedInstances(ed, u), (n) => (n ? tp(n, "Updated {n} instance", "Updated {n} instances") : null))}>
            {selected.length > 1 ? t("Update {n} selected instances", { n: selected.length }) : t("Update selected instance")}
          </Button>
        )}
        {u.kind !== "removed" && (
          <Button variant="primary" loading={busy} onClick={() => void run(() => acceptUpdates(ed, [u]), (n) => (!n ? null : u.kind === "moved" ? t("Moved to the new library") : t("Updated")), true)}>
            {u.kind === "moved" ? t("Accept") : t("Update")}
          </Button>
        )}
        {u.kind === "removed" && isComponent && (
          <Button
            variant="secondary"
            onClick={() => {
              if (restoreRemovedComponent(ed, u.copy.guid)) {
                showToast({ message: t("Component restored") });
                ed.ui.set({ librariesDialog: null });
              }
            }}
          >
            {t("Restore component")}
          </Button>
        )}
      </div>
    </div>
  );
}
