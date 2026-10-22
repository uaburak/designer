/**
 * The Libraries modal (UI3; help.figma.com "Enable libraries", "Review and accept updates", R5; atlas 12 §5–§7), laid
 * out as live Figma's Manage libraries (docs/research/figma/live/2026-10-18/menus.txt "MANAGE LIBRARIES": 591 × 641,
 * a 40 header, a 200 nav, the content 16 in) and draggable by its header: a nav — search first ("/" focuses it), This
 * file, Updates, then Browse libraries (Teams, the organization; no UI kits: Wecra has none) — and the tab's content. This file: the current file (publish it, or "Move to a folder to publish" in Drafts), the
 * libraries added to it (Remove from file — what is used stays), the others it can add, View missing libraries. A
 * library's view: its components, styles and variables, how many of them are used here, Swap library. Updates: what
 * the libraries changed for the assets used here, by publish, for the current page or all pages; each one's review
 * in its own window (before / after side by side or overlaid, zoom, instance by instance, Update instance, Update
 * all); removed assets (Restore component) and moved ones (accepted with the update).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Banner, Button, Checkbox, EmptyState, Icon, IconButton, Portal, SearchField, SegmentedControl, Select, Slider, Spinner, Switch, showToast, dismissToast, cx, Dialog, startHeaderDrag, tooltipProps } from "@/ds";
import type { LibraryAsset, LibraryVersion } from "../../../../../shared/store/types";
import { useEditor, type EditorController } from "../../controller";
import { useDocumentVersion, useLibraries, useUI } from "../../hooks";
import {
  acceptUpdates,
  instancesOfUpdate,
  missingLibraries,
  restoreRemovedComponent,
  setLibraryEnabled,
  swapLibrary,
  swapPlan,
  updateGroups,
  updateId,
  updateInstances,
  type SwapPlan,
  type UpdateItem,
} from "../../libraries";
import type { LibraryEntry } from "../../documentSource";
import type { UIState } from "../../uiStore";
import { NodeThumb, RemoteThumb, kindGlyph } from "./Thumbs";
import styles from "./Libraries.module.css";
import { EditorLibraryAnalytics } from "../../analytics/EditorAnalytics";
import { intlLocale, t, tp, useT } from "@/i18n";

type View = NonNullable<UIState["librariesDialog"]>;
type Tab = View["tab"];

export function LibrariesDialog() {
  const view = useUI((s) => s.librariesDialog);
  return (
    <>
      {view ? view.update ? <ReviewWindow id={view.update} /> : <Libraries /> : null}
      <EditorLibraryAnalytics />
    </>
  );
}

const countsText = (c: { components: number; styles: number; variables: number }) => {
  const parts = [c.components && tp(c.components, "{n} component", "{n} components"), c.styles && tp(c.styles, "{n} style", "{n} styles"), c.variables && tp(c.variables, "{n} variable", "{n} variables")].filter(Boolean);
  return parts.length ? parts.join(" · ") : t("No assets");
};

/** Moves the Libraries modal (the update a review shows, a library, the tab…); the rest of its state stays. */
const setView = (ed: EditorController, patch: Partial<View>) => {
  const view = ed.ui.get().librariesDialog;
  if (view) ed.ui.set({ librariesDialog: { ...view, ...patch } });
};

function Libraries() {
  useT();
  const ed = useEditor();
  const view = useUI((s) => s.librariesDialog)!;
  const state = useLibraries();
  const pending = ed.libraries.pendingCount();
  const [query, setQuery] = useState("");
  const close = () => {
    ed.ui.set({ librariesDialog: null });
    ed.focusCanvas();
  };
  const set = (patch: Partial<View>) => setView(ed, patch);
  // Moving between the list, a preview and a review unmounts the focused control: keep focus in the dialog (Esc).
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const box = body.current?.closest<HTMLElement>('[role="dialog"]');
    if (box && !box.contains(document.activeElement)) box.focus({ preventScroll: true });
  }, [view.tab, view.library, view.swap, view.missing]);
  // "/" focuses the search (atlas 12 §5.3): no modifiers, not while typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable='true']")) return;
      const input = body.current?.querySelector<HTMLInputElement>("[data-libraries-search] input");
      if (!input) return;
      e.preventDefault();
      input.focus();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);
  const tab = (value: Tab, label: string, badge?: number) => (
    <button
      type="button"
      role="tab"
      aria-selected={!query && view.tab === value}
      className={styles.sideTab}
      data-libraries-tab={value}
      onClick={() => {
        setQuery("");
        set({ tab: value, library: null, swap: null, missing: false });
      }}
    >
      {/* Live 2026-10-18 (menus.txt): This file and Updates with their 24 glyphs */}
      {value === "libraries" && <Icon name="24.library.this-file" />}
      {value === "updates" && <Icon name="24.library.updates" />}
      <span className={cx(styles.sideTabLabel, value !== "libraries" && value !== "updates" && styles.sideTabLabelBare)}>{label}</span>
      {badge ? <span className={styles.sideBadge}>{badge}</span> : null}
    </button>
  );
  const org = state.org?.orgName ?? null;
  const content = !state.on ? (
    <EmptyState icon="24.library" title={t("Libraries aren't available here")} body={t("Open a file from your workspace to publish and use libraries.")} />
  ) : query.trim() ? (
    <SearchResults query={query.trim()} onOpen={(lib) => set({ library: lib })} />
  ) : view.swap ? (
    <SwapView from={view.swap} onBack={() => set({ swap: null })} />
  ) : view.library ? (
    <LibraryPreview lib={view.library} onBack={() => set({ library: null })} onSwap={() => set({ swap: view.library })} />
  ) : view.missing ? (
    <MissingLibraries onBack={() => set({ missing: false })} onSwap={(lib) => set({ swap: lib })} />
  ) : view.tab === "updates" ? (
    <Updates scope={view.scope ?? "current"} onScope={(scope) => set({ scope })} onOpen={(id) => set({ update: id })} />
  ) : view.tab === "teams" ? (
    <TeamLibraries org={false} onOpen={(lib) => set({ library: lib })} />
  ) : view.tab === "org" ? (
    <TeamLibraries org onOpen={(lib) => set({ library: lib })} />
  ) : (
    <LibraryList onOpen={(lib) => set({ library: lib })} onMissing={() => set({ missing: true })} onPublish={() => ed.ui.set({ publishOpen: true, librariesDialog: null })} />
  );
  return (
    <Dialog title={t("Manage libraries")} size="large" header="small" className={styles.modal} draggable open onClose={close}>
      <div ref={body} className={styles.libraries} data-libraries-dialog="">
        <nav className={styles.sidebar} aria-label={t("Libraries")}>
          <SearchField value={query} onChange={setQuery} placeholder={t("Search all libraries")} label={t("Search all libraries")} autoFocus selectOnFocus data-libraries-search="" />
          <div role="tablist" aria-orientation="vertical" aria-label={t("Libraries")} className={styles.sideTabs}>
            {tab("libraries", t("This file"))}
            {tab("updates", t("Updates"), pending || undefined)}
            <div className={styles.sideDivider} />
            <div className={styles.sideHeading}>{t("Browse libraries")}</div>
            {tab("teams", org ? t("Your teams") : t("Teams"))}
            {org !== null && tab("org", org)}
          </div>
        </nav>
        <div className={styles.tabContent}>{content}</div>
      </div>
    </Dialog>
  );
}

function LibraryList({ onOpen, onMissing, onPublish }: { onOpen: (lib: string) => void; onMissing: () => void; onPublish: () => void }) {
  useT();
  const ed = useEditor();
  const state = useLibraries();
  useDocumentVersion();
  const [busy, setBusy] = useState<string | null>(null);
  const byKey = new Map(state.available.map((e) => [e.fileKey, e]));
  const added = pinApproved(state.enabled.map((lib) => byKey.get(lib) ?? { fileKey: lib, name: state.names.get(lib) ?? t("Missing library"), location: "", record: null }) as LibraryEntry[]);
  const others = state.available.filter((e) => !state.enabled.includes(e.fileKey));
  const sections = otherSections(others, state.org?.orgName ?? null);
  const missing = missingLibraries(state, ed.libraries.copies(), ed.source.libraries?.libraryKey);
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
  const [unpublishing, setUnpublishing] = useState(false);
  return (
    <div className={styles.listBody}>
      {state.loading && (
        <div className={styles.loading}>
          <Spinner /> {t("Loading libraries…")}
        </div>
      )}
      <section aria-label={t("Current file")}>
        {own ? (
          // Published: the file as a row of its own (atlas 12 §5.4 current_file_is_published), Publish changes and Unpublish.
          <div className={styles.libRow} data-library-row="current">
            <LibraryThumb lib={ed.source.libraries?.libraryKey ?? null} />
            <div className={styles.libText}>
              <span className={styles.rowName}>{fileName}</span>
              <span className={styles.meta}>{state.inDrafts ? t("In Drafts · Move to a folder to publish") : t("{counts} · Version {version}", { counts: countsText(own.counts), version: own.latestVersion })}</span>
              {/* (two buttons beside the 102 thumbnail leave the name no room: under it) */}
              <div className={styles.rowActions}>
                {own.status === "published" && ed.source.libraries?.unpublish && (
                  <Button variant="secondary" onClick={() => setUnpublishing(true)}>
                    {t("Unpublish")}
                  </Button>
                )}
                <Button variant="secondary" disabled={state.inDrafts} tooltip={state.inDrafts ? t("Move to a folder to publish") : undefined} onClick={onPublish}>
                  {t("Publish changes…")}
                </Button>
              </div>
            </div>
          </div>
        ) : (
          // Not published: live's banner (359 × 128, #383838, r 5) — the title, a line with a link, Publish this file.
          <div className={styles.publishBanner} data-library-row="current" data-publish-banner="">
            <Icon name="24.library" className={styles.publishBannerIcon} />
            <div className={styles.publishBannerText}>
              <span className={styles.publishBannerTitle}>{t("Publish your components as a library")}</span>
              <span className={styles.meta2}>
                {t("Share this file's components, styles and variables with your other files.")}{" "}
                <a className={styles.link} href={LEARN_MORE} target="_blank" rel="noreferrer">
                  {t("Learn more")}
                </a>
              </span>
              <Button variant="primary" className={styles.publishBannerButton} disabled={state.inDrafts} tooltip={state.inDrafts ? t("Move to a folder to publish") : undefined} onClick={onPublish}>
                {t("Publish this file")}
              </Button>
              {/* A draft can't be a library (Figma's rule): say so here, not only in the disabled button's tooltip */}
              {state.inDrafts && <span className={styles.meta2} data-publish-drafts-hint="">{t("Move to a folder to publish")}</span>}
            </div>
          </div>
        )}
      </section>
      {unpublishing && <UnpublishConfirm onClose={() => setUnpublishing(false)} />}
      <section aria-label={t("Libraries added to this file")}>
        <div className={styles.sectionTitle}>{t("Libraries added to this file")}</div>
        {added.length === 0 && <div className={styles.none}>{t("No libraries added to this file")}</div>}
        {added.map((e) => (
          <LibraryRow key={e.fileKey} entry={e} orgName={state.org?.orgName ?? null} missing={!byKey.has(e.fileKey)} onOpen={byKey.has(e.fileKey) ? () => onOpen(e.fileKey) : undefined}>
            <Button variant="secondary" loading={busy === e.fileKey} onClick={() => void toggle(e.fileKey, false, e.name)}>
              {t("Remove")}
            </Button>
          </LibraryRow>
        ))}
      </section>
      {sections.map((s, i) => (
        <section key={s.title} aria-label={s.title}>
          <div className={styles.sectionTitle}>{s.title}</div>
          {i === 0 && others.length === 0 && <div className={styles.none}>{state.available.length ? t("Every library is added to this file") : t("No other files are published as libraries yet")}</div>}
          {s.entries.map((e) => (
            <LibraryRow key={e.fileKey} entry={e} orgName={state.org?.orgName ?? null} onOpen={() => onOpen(e.fileKey)}>
              <Button variant="primary" loading={busy === e.fileKey} onClick={() => void toggle(e.fileKey, true, e.name)}>
                {t("Add to file")}
              </Button>
            </LibraryRow>
          ))}
        </section>
      ))}
      {missing.length > 0 && (
        <Banner tone="warning" action={{ label: t("View missing libraries"), onClick: onMissing }} data-missing-libraries-banner="">
          {tp(missing.length, "This file uses {n} missing library", "This file uses {n} missing libraries")}
        </Banner>
      )}
    </div>
  );
}

/**
 * Remove library (atlas 12 §3.9): Figma's 400-wide confirm — "Remove library", what it does, Remove library. The
 * library is unpublished; files using it keep their copies.
 */
function UnpublishConfirm({ onClose }: { onClose: () => void }) {
  useT();
  const ed = useEditor();
  const [busy, setBusy] = useState(false);
  const remove = async () => {
    setBusy(true);
    try {
      await ed.source.libraries?.unpublish?.();
      await ed.libraries.refresh();
      showToast({ message: t("Library unpublished"), kind: "success" });
      onClose();
    } catch {
      showToast({ message: t("The library couldn't be unpublished"), kind: "error" });
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={t("Remove library")}
      size="small"
      open
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t("Cancel")}
          </Button>
          <Button variant="destructive" loading={busy} onClick={() => void remove()}>
            {t("Remove library")}
          </Button>
        </>
      }
    >
      <div className={styles.unpublishConfirm} data-unpublish-confirm="">
        {t("This action will remove all of the components in this file from the library. Files that use them keep their copies.")}
      </div>
    </Dialog>
  );
}

/** "Learn more" on the publish banner (help.figma.com "Guide to libraries") */
const LEARN_MORE = "https://help.figma.com/hc/en-us/search?query=guide%20to%20libraries";

/** Each library's thumbnail (its latest manifest's first component, else first asset with one), per editor. */
const thumbUrls = new WeakMap<EditorController, Map<string, Promise<string>>>();
function libraryThumbUrl(ed: EditorController, lib: string): Promise<string> {
  let byLib = thumbUrls.get(ed);
  if (!byLib) thumbUrls.set(ed, (byLib = new Map()));
  let url = byLib.get(lib);
  if (!url) {
    url = ed.libraries
      .manifest(lib)
      .then((v) => {
        const assets = v?.assets ?? [];
        const a = assets.find((x) => (x.kind === "COMPONENT" || x.kind === "COMPONENT_SET") && x.thumbnail) ?? assets.find((x) => x.thumbnail);
        return a?.thumbnail ? (ed.source.libraries?.blobUrl(a.thumbnail.sha1) ?? "") : "";
      })
      .catch(() => "");
    byLib.set(lib, url);
  }
  return url;
}

/**
 * A library's 102 × 58 thumbnail (live: r 5, #FFFFFF1A, a 1 px #0000000D ring): Figma draws the file's cover; Wecra
 * the library's first component (the editor has no other file's cover), the library glyph until then or without one.
 */
function LibraryThumb({ lib }: { lib: string | null }) {
  const ed = useEditor();
  const [url, setUrl] = useState("");
  useEffect(() => {
    if (!lib) return;
    let live = true;
    void libraryThumbUrl(ed, lib).then((u) => live && setUrl(u));
    return () => {
      live = false;
    };
  }, [ed, lib]);
  return (
    <span className={styles.libThumb} data-library-thumb="">
      {url ? <img src={url} alt="" className={styles.libThumbImage} /> : <Icon name="24.library" className={styles.thumbGlyph} />}
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

/**
 * Why a library is in this file (atlas 12 §4.2): added by an admin (org / workspace defaults: "Added by ‹group›
 * admin"), by an editor of the file, or by the person's drafts defaults — from the org listing's `via`.
 */
function originText(entry: LibraryEntry | undefined, enabled: boolean): string | null {
  if (!enabled || !entry?.org) return null;
  const via = entry.org.via;
  if (via.includes("org") && entry.org.approved) return t("Added by {group} admin", { group: entry.org.teamName ?? t("organization") });
  if (via.includes("file")) return t("Added by a file editor");
  return null;
}

function LibraryRow({ entry, orgName = null, missing, onOpen, children }: { entry: LibraryEntry; orgName?: string | null; missing?: boolean; onOpen?: () => void; children: React.ReactNode }) {
  useT();
  return (
    <div className={styles.libRow} data-library-row={entry.name}>
      <LibraryThumb lib={missing ? null : entry.fileKey} />
      <button type="button" className={styles.libOpen} onClick={onOpen} disabled={!onOpen} aria-label={t("Preview {name}", { name: entry.name })}>
        <span className={styles.libNameRow}>
          <span className={styles.rowName}>{entry.name}</span>
          <ApprovedMark entry={entry} orgName={orgName} />
        </span>
        <span className={styles.meta}>{missing ? t("Missing library · assets used here keep working") : [entry.location, countsText(entry.record.counts)].filter(Boolean).join(" · ")}</span>
      </button>
      {children}
    </div>
  );
}

/** Teams (atlas 12 §5.4): a section per team (or the organization's), three library cards and "See more". */
function TeamLibraries({ org, onOpen }: { org: boolean; onOpen: (lib: string) => void }) {
  useT();
  const state = useLibraries();
  const [more, setMore] = useState<Set<string>>(new Set());
  const orgName = state.org?.orgName ?? null;
  const sections = otherSections(state.available, orgName).filter((s) => (orgName === null ? true : org ? s.title === orgName : s.title !== orgName));
  if (!sections.some((s) => s.entries.length)) return <EmptyState icon="24.library" title={t("No libraries yet")} body={t("Libraries your teams publish show up here.")} />;
  return (
    <div className={styles.listBody} data-team-libraries={org ? "org" : "teams"}>
      {sections.map((s) => {
        const open = more.has(s.title);
        const shown = open ? s.entries : s.entries.slice(0, TEAM_CARDS);
        return (
          <section key={s.title} aria-label={s.title}>
            <div className={styles.sectionTitle}>
              <span className={styles.grow}>{s.title}</span>
              {s.entries.length > TEAM_CARDS && (
                <Button variant="ghost" onClick={() => setMore((m) => new Set(m).add(s.title))} disabled={open}>
                  {t("See more")}
                </Button>
              )}
            </div>
            <div className={styles.cards}>
              {shown.map((e) => (
                <button key={e.fileKey} type="button" className={styles.card} data-library-card={e.name} onClick={() => onOpen(e.fileKey)}>
                  <LibraryThumb lib={e.fileKey} />
                  <span className={styles.libNameRow}>
                    <span className={styles.libName}>{e.name}</span>
                    <ApprovedMark entry={e} orgName={orgName} />
                  </span>
                  <span className={styles.meta}>{countsText(e.record.counts)}</span>
                  {state.enabled.includes(e.fileKey) && <span className={styles.meta}>{t("Added to this file")}</span>}
                </button>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

/** Figma's Teams cards per team before "See more" (atlas 12 §5.4) */
const TEAM_CARDS = 3;

/** Search results (atlas 12 §5.3): every library known here whose name matches. */
function SearchResults({ query, onOpen }: { query: string; onOpen: (lib: string) => void }) {
  useT();
  const state = useLibraries();
  const q = query.toLowerCase();
  const byKey = new Map(state.available.map((e) => [e.fileKey, e]));
  const all = [...state.available, ...state.enabled.filter((lib) => !byKey.has(lib)).map((lib) => ({ fileKey: lib, name: state.names.get(lib) ?? t("Missing library"), location: "", record: null }) as unknown as LibraryEntry)];
  const hits = pinApproved(all.filter((e) => e.name.toLowerCase().includes(q)));
  return (
    <div className={styles.listBody} data-library-search="">
      <div className={styles.sectionTitle}>{hits.length ? t("Results for “{query}”", { query }) : t("No results for “{query}”", { query })}</div>
      {hits.map((e) => (
        <LibraryRow key={e.fileKey} entry={e} orgName={state.org?.orgName ?? null} missing={!byKey.has(e.fileKey)} onOpen={byKey.has(e.fileKey) ? () => onOpen(e.fileKey) : undefined}>
          {state.enabled.includes(e.fileKey) ? <span className={styles.meta}>{t("Added to this file")}</span> : null}
        </LibraryRow>
      ))}
    </div>
  );
}

/** Figma's library view shows this many components before the rest (atlas 12 §5.4 `maxShownItems`) */
const MAX_SHOWN = 28;

/**
 * A library's components (thumbnails), styles and variables, with Add to file / Remove from file; the footer says how
 * many of its assets are used here and offers Swap library (atlas 12 §5.4, §7.1).
 */
function LibraryPreview({ lib, onBack, onSwap }: { lib: string; onBack: () => void; onSwap: () => void }) {
  useT();
  const ed = useEditor();
  const state = useLibraries();
  useDocumentVersion();
  const entry = state.available.find((e) => e.fileKey === lib);
  const [manifest, setManifest] = useState<LibraryVersion | null>(null);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [all, setAll] = useState(false);
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
  const used = ed.libraries.copies().filter((c) => c.library === lib && c.kind !== "VARIABLE").length;
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
  const origin = originText(entry, enabled);
  return (
    <div className={styles.libraryView} data-library-preview={entry?.name ?? ""}>
      <div className={styles.listBody}>
        <div className={styles.previewHeader}>
          <IconButton icon="24.arrow.left" label={t("Back to libraries")} onClick={onBack} />
          <div className={styles.libText}>
            <span className={styles.libName}>{entry?.name ?? state.names.get(lib) ?? t("Library")}</span>
            <span className={styles.meta}>{[entry?.location, entry ? countsText(entry.record.counts) : "", origin].filter(Boolean).join(" · ")}</span>
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
              {(all ? components : components.slice(0, MAX_SHOWN)).map((a) => (
                <div key={a.key} className={styles.previewTile} title={a.description ? `${a.name}\n${a.description}` : a.name}>
                  <RemoteThumb asset={a} size={88} className={styles.previewThumb} />
                  <span className={styles.tileName}>{a.name}</span>
                </div>
              ))}
            </div>
            {!all && components.length > MAX_SHOWN && (
              <Button variant="ghost" onClick={() => setAll(true)}>
                {t("See all {n} components", { n: components.length })}
              </Button>
            )}
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
      <div className={styles.libraryFooter} data-library-footer="">
        <span className={styles.meta}>{used ? tp(used, "{n} asset used in this file", "{n} assets used in this file") : t("No assets used in this file")}</span>
        {used > 0 && (
          <Button variant="secondary" onClick={onSwap}>
            {t("Swap library")}
          </Button>
        )}
      </div>
    </div>
  );
}

/** Missing libraries (atlas 12 §7.2): libraries copies here come from that are gone, each with Swap library. */
function MissingLibraries({ onBack, onSwap }: { onBack: () => void; onSwap: (lib: string) => void }) {
  useT();
  const ed = useEditor();
  const state = useLibraries();
  useDocumentVersion();
  const missing = missingLibraries(state, ed.libraries.copies(), ed.source.libraries?.libraryKey);
  return (
    <div className={styles.listBody} data-missing-libraries="">
      <div className={styles.previewHeader}>
        <IconButton icon="24.arrow.left" label={t("Back to libraries")} onClick={onBack} />
        <Icon name="24.warning" className={styles.warningIcon} />
        <span className={styles.libName}>{tp(missing.length, "{n} missing library", "{n} missing libraries")}</span>
      </div>
      {!missing.length && <div className={styles.none}>{t("No missing libraries")}</div>}
      {missing.map((m) => (
        <div key={m.library} className={styles.libRow} data-missing-library={m.name}>
          <LibraryThumb lib={null} />
          <div className={styles.libText}>
            <span className={styles.rowName}>{m.name}</span>
            <span className={styles.meta}>{tp(m.assets, "{n} asset used in this file", "{n} assets used in this file")}</span>
          </div>
          <Button variant="secondary" onClick={() => onSwap(m.library)}>
            {t("Swap library")}
          </Button>
        </div>
      ))}
    </div>
  );
}

/**
 * Swap library (atlas 12 §7.1): the target chosen among the published libraries; the used assets on the left, their
 * matches on the right ("None found"), a checkbox each, a collection's target from a dropdown; "Swap default styles
 * and collections in instances" (on); Swap.
 */
function SwapView({ from, onBack }: { from: string; onBack: () => void }) {
  useT();
  const ed = useEditor();
  const state = useLibraries();
  const targets = state.available.filter((e) => e.fileKey !== from);
  const [to, setTo] = useState<string>("");
  // The plan for the target it was read for (another target chosen meanwhile: none yet).
  const [loaded, setLoaded] = useState<{ to: string; plan: SwapPlan | null } | null>(null);
  const plan = loaded?.to === to ? loaded.plan : null;
  const [keys, setKeys] = useState<Set<string>>(new Set());
  const [collections, setCollections] = useState<Map<string, string>>(new Map());
  const [swapDefaults, setSwapDefaults] = useState(true);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    if (!to) return;
    void swapPlan(ed, from, to).then((p) => {
      if (!live) return;
      setLoaded({ to, plan: p });
      setKeys(new Set((p?.rows ?? []).filter((r) => r.match).map((r) => r.copy.key)));
      setCollections(new Map());
    });
    return () => {
      live = false;
    };
  }, [ed, from, to]);
  const fromName = state.names.get(from) ?? state.available.find((e) => e.fileKey === from)?.name ?? tp(1, "{n} missing library", "{n} missing libraries");
  const hasStyles = !!plan?.rows.some((r) => r.copy.kind === "STYLE");
  const hasCollections = !!plan?.rows.some((r) => r.copy.kind === "VARIABLE_COLLECTION");
  const optionLabel = hasStyles && hasCollections ? t("Swap default styles and collections in instances") : hasCollections ? t("Swap default collections in instances") : t("Swap default styles in instances");
  const matchOf = (r: SwapPlan["rows"][number]) => (r.copy.kind === "VARIABLE_COLLECTION" && collections.has(r.copy.key) ? (plan?.collections.find((c) => c.key === collections.get(r.copy.key)) ?? null) : r.match);
  const run = async () => {
    if (!plan) return;
    setBusy(true);
    try {
      const done = await swapLibrary(ed, plan, { keys, collections, swapDefaults });
      showToast({ message: tp(done.assets, "Swapped {n} asset", "Swapped {n} assets"), kind: "success" });
      if (done.variables) showToast({ message: tp(done.variables, "Swapped {n} variable", "Swapped {n} variables") });
      onBack();
    } catch {
      showToast({ message: t("The library couldn't be swapped"), kind: "error" });
    } finally {
      setBusy(false);
    }
  };
  const used = (kind: string) => (kind === "STYLE" ? t("Used style") : kind === "VARIABLE_COLLECTION" ? t("Used variable collection") : t("Used component"));
  return (
    <div className={styles.libraryView} data-swap-library="">
      <div className={styles.listBody}>
        <div className={styles.previewHeader}>
          <IconButton icon="24.arrow.left" label={t("Back")} onClick={onBack} />
          <div className={styles.libText}>
            <span className={styles.libName}>{t("Swap library")}</span>
            <span className={styles.meta}>{fromName}</span>
          </div>
          <Select label={t("Swap to")} width="hug" placeholder={t("Choose a library")} value={to} options={targets.map((e) => ({ value: e.fileKey, label: e.name }))} onChange={setTo} disabled={!targets.length} />
        </div>
        {!to && <div className={styles.none}>{targets.length ? t("Choose the library to swap to") : t("No other libraries to swap to")}</div>}
        {to && loaded?.to !== to && (
          <div className={styles.loading}>
            <Spinner /> {t("Loading…")}
          </div>
        )}
        {plan && (
          <div className={styles.swapTable} role="table" aria-label={t("Swap library")}>
            {plan.rows.map((r) => {
              const match = matchOf(r);
              return (
                <div key={r.copy.guid} className={styles.swapRow} role="row" data-swap-row={r.copy.name}>
                  <Checkbox label={t("Swap {name}", { name: r.copy.name })} hideLabel checked={keys.has(r.copy.key) && !!match} disabled={!match} onChange={(on) => setKeys((k) => (on ? new Set(k).add(r.copy.key) : new Set([...k].filter((x) => x !== r.copy.key))))} />
                  <span className={styles.swapCell} role="cell" aria-label={used(r.copy.kind)}>
                    <NodeThumb node={r.copy.guid} kind={r.copy.kind} size={32} />
                    <span className={styles.changeName}>{r.copy.name}</span>
                  </span>
                  <Icon name="24.arrow.right" className={styles.caret} />
                  <span className={styles.swapCell} role="cell">
                    {r.copy.kind === "VARIABLE_COLLECTION" ? (
                      <Select label={t("New variable collection")} width="hug" placeholder={t("None found")} value={match?.key ?? ""} options={plan.collections.map((c) => ({ value: c.key, label: c.name }))} onChange={(v) => setCollections((m) => new Map(m).set(r.copy.key, v))} />
                    ) : match ? (
                      <>
                        <RemoteThumb asset={match} size={32} />
                        <span className={styles.changeName}>{match.name}</span>
                      </>
                    ) : (
                      <span className={styles.meta}>{t("None found")}</span>
                    )}
                  </span>
                </div>
              );
            })}
            {!plan.rows.length && <div className={styles.none}>{t("Nothing from this library is used in this file")}</div>}
          </div>
        )}
      </div>
      <div className={styles.libraryFooter}>
        {(hasStyles || hasCollections) && <Checkbox label={optionLabel} checked={swapDefaults} onChange={setSwapDefaults} />}
        <span className={styles.grow} />
        <Button variant="primary" loading={busy} disabled={!plan || ![...keys].some((k) => plan.rows.some((r) => r.copy.key === k && matchOf(r)))} onClick={() => void run()}>
          {t("Swap library")}
        </Button>
      </div>
    </div>
  );
}

const KIND_TEXT: Record<UpdateItem["kind"], string> = { modified: "Modified", removed: "Removed from library", moved: "Moved" };

/** Figma's Updates placeholder rows (atlas 12 §6.3): row i at opacity 1 − 0.2·i, its shimmer 1.5·i s later */
const SKELETON_ROWS = 5;
/** Figma shows the ALL scope's list one frame plus 250 ms after the switch (atlas 12 §6.3) */
const ALL_PAGES_DELAY = 250;
/** "Updates are taking longer than expected" after this long loading (ours: Figma's timer wasn't read) */
const SLOW_LOADING = 5000;

function Updates({ scope, onScope, onOpen }: { scope: "current" | "all"; onScope: (scope: "current" | "all") => void; onOpen: (id: string) => void }) {
  useT();
  const ed = useEditor();
  const state = useLibraries();
  useDocumentVersion();
  const [shown, setShown] = useState(scope);
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (shown === scope) return;
    // All pages: one frame, then 250 ms (Figma loads every page first).
    let timer = 0;
    const frame = requestAnimationFrame(() => {
      timer = window.setTimeout(() => setShown(scope), ALL_PAGES_DELAY);
    });
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, [scope, shown]);
  useEffect(() => {
    if (!state.loading) return;
    const timer = window.setTimeout(() => setSlow(true), SLOW_LOADING);
    return () => {
      clearTimeout(timer);
      setSlow(false);
    };
  }, [state.loading]);
  const updates = ed.libraries.updatesIn(shown);
  const total = scope === "current" ? ed.libraries.updates().length : updates.length;
  const groups = updateGroups(updates);
  const acceptable = updates.filter((u) => u.kind !== "removed");
  const all = async () => {
    // Update all closes the modal first (atlas 12 §6.4); the progress bell says the rest.
    ed.ui.set({ librariesDialog: null });
    ed.focusCanvas();
    await updateAllWithBell(ed, acceptable);
  };
  const loading = state.loading || shown !== scope;
  const footer = (
    <div className={styles.updatesFooter}>
      <Switch showLabel label={t("Show updates for all pages")} checked={scope === "all"} onChange={(on) => onScope(on ? "all" : "current")} />
    </div>
  );
  if (loading && !updates.length) {
    return (
      <div className={styles.libraryView}>
        <div className={styles.listBody} data-updates-loading="">
          {Array.from({ length: SKELETON_ROWS }, (_, i) => (
            <div key={i} className={styles.skeletonRow} style={{ opacity: 1 - 0.2 * i, animationDelay: `${1.5 * i}s` }} aria-hidden />
          ))}
          {slow && (
            <div className={styles.loading}>
              <Spinner /> {t("Updates are taking longer than expected")}
            </div>
          )}
        </div>
        {footer}
      </div>
    );
  }
  if (!updates.length) {
    return (
      <div className={styles.libraryView}>
        {scope === "current" && total > 0 ? (
          <EmptyState icon="24.library" title={t("No updates available on this page")} body={t("There may be updates on other pages.")} action={{ label: t("View all pages"), onClick: () => onScope("all") }} />
        ) : (
          <EmptyState icon="24.library" title={t("No updates available")} body={t("Updates to components or styles will show up here.")} />
        )}
        {footer}
      </div>
    );
  }
  return (
    <div className={styles.libraryView}>
      <div className={styles.listBody} data-updates="">
        <div className={styles.updatesHeader}>
          <span className={styles.meta}>{tp(acceptable.length, "{n} update available", "{n} updates available")}</span>
          <Button variant="primary" disabled={!acceptable.length} onClick={() => void all()}>
            {t("Update all")}
          </Button>
        </div>
        {groups.map((g) => (
          <section key={g.id} aria-label={t("Updates from {name}", { name: g.libraryName })} data-update-group={g.publish?.version ?? ""}>
            <div className={styles.groupHeader}>
              <span className={styles.libName}>{t("Updates from {name}", { name: g.libraryName })}</span>
              {g.publish && <span className={styles.meta}>{new Date(g.publish.publishedAt).toLocaleDateString(intlLocale(), { month: "short", day: "numeric", year: "numeric" })}</span>}
              {g.publish?.description && <span className={styles.groupDescription}>{g.publish.description}</span>}
            </div>
            {g.items.map((u) => (
              <div key={updateId(u)} className={styles.updateRowWrap}>
                <button type="button" className={styles.updateRow} data-update={u.copy.name} aria-label={t("Review updates for {name}", { name: u.copy.name })} onClick={() => onOpen(updateId(u))}>
                  {u.asset ? <RemoteThumb asset={u.asset} size={64} /> : <NodeThumb node={u.copy.guid} kind={u.copy.kind} size={64} />}
                  <span className={styles.libText}>
                    <span className={styles.libName}>{u.copy.name}</span>
                    <span className={styles.meta}>
                      {u.kind === "moved" ? t("Moved from {name}", { name: u.libraryName }) : t(KIND_TEXT[u.kind])}
                      {shown === "all" && u.kind !== "removed" ? ` · ${tp(ed.libraries.usageOf(u), "{n} outdated instance", "{n} outdated instances")}` : ""}
                    </span>
                  </span>
                </button>
                {u.kind !== "removed" && (
                  <Button variant="secondary" aria-label={t("Update instances of {name}", { name: u.copy.name })} onClick={() => void updateAllWithBell(ed, [u])}>
                    {t("Update")}
                  </Button>
                )}
              </div>
            ))}
          </section>
        ))}
      </div>
      {footer}
    </div>
  );
}

/**
 * Accepts updates with Figma's progress bell (atlas 12 §6.4, `library-update`): "Updating assets…" with the count as
 * batches come in, then "Assets updated" or the failure.
 */
async function updateAllWithBell(ed: EditorController, items: readonly UpdateItem[]): Promise<number> {
  let bell = -1;
  const progress = (done: number, total: number) => {
    if (bell >= 0) dismissToast(bell);
    bell = showToast({ message: t("Updating assets… {done}/{total}", { done, total }), duration: Infinity, icon: "24.library" });
  };
  try {
    const n = await acceptUpdates(ed, items, progress);
    if (bell >= 0) dismissToast(bell);
    if (n) showToast({ message: tp(n, "Updated {n} asset", "Updated {n} assets"), kind: "success" });
    return n;
  } catch {
    if (bell >= 0) dismissToast(bell);
    showToast({ message: t("An error occurred while updating the instances of this component."), kind: "error" });
    return 0;
  }
}

/** Figma's review zoom presets (atlas 12 §6.5) */
const ZOOMS = [25, 50, 100, 150, 200, 300, 400];
/** The review window: default 800 × 580, at least 600 × 580, 12 under the toolbar (atlas 12 §6.5) */
const REVIEW = { width: 800, height: 580, minWidth: 600, minHeight: 580, gap: 12 };
/** The previews' size at 100 % */
const PREVIEW = 200;

/**
 * Review updates (atlas 12 §6.5): its own draggable window, not a modal (a click outside doesn't close it) — Back to
 * all updates, the asset's name; Current | Updated side by side, or overlaid with an opacity slider (0.5); zoom
 * presets; with more than one instance, ◀ ▶ (← →), "i/N" and Go to current instance; Update instance, Update all, then
 * Updated and Next component. Styles: Update style; removed and moved assets: their own actions.
 */
function ReviewWindow({ id }: { id: string }) {
  useT();
  const ed = useEditor();
  useLibraries();
  const docVersion = useDocumentVersion();
  const view = useUI((s) => s.librariesDialog)!;
  const scope = view.scope ?? "current";
  const [mode, setMode] = useState<"side" | "overlay">("side");
  const [opacity, setOpacity] = useState(0.5);
  const [zoom, setZoom] = useState(100);
  const [busy, setBusy] = useState(false);
  const [index, setIndex] = useState(0);
  const [done, setDone] = useState(false);
  const [pos, setPos] = useState(() => ({ x: Math.max(0, (window.innerWidth - REVIEW.width) / 2), y: REVIEW.gap + toolbarHeight() }));
  const box = useRef<HTMLDivElement>(null);
  const list = ed.libraries.updatesIn(scope);
  const order = updateGroups(list).flatMap((g) => g.items);
  const u = order.find((x) => updateId(x) === id) ?? null;
  const [updated, setUpdated] = useState<UpdateItem | null>(null);
  const shownItem = u ?? updated;
  // The instances (one subtree read per page): again when the document changes.
  const instances = useMemo(() => {
    const it = docVersion >= 0 ? ed.libraries.updatesIn(scope).find((x) => updateId(x) === id) : undefined;
    return it && (it.copy.kind === "COMPONENT" || it.copy.kind === "COMPONENT_SET") ? instancesOfUpdate(ed, it, scope) : [];
  }, [ed, id, scope, docVersion]);
  const current = instances[Math.min(index, Math.max(0, instances.length - 1))];
  const back = () => setView(ed, { update: null });
  const close = () => {
    ed.ui.set({ librariesDialog: null });
    ed.focusCanvas();
  };
  const next = order.find((x, i) => i > order.findIndex((y) => updateId(y) === id) && x.kind !== "removed");
  useEffect(() => {
    box.current?.focus({ preventScroll: true });
  }, []);
  const go = (step: number) => instances.length > 1 && setIndex((i) => (i + step + instances.length) % instances.length);
  const run = async <T,>(f: () => Promise<T>, after: (result: T) => void) => {
    setBusy(true);
    try {
      after(await f());
    } finally {
      setBusy(false);
    }
  };
  const drag = (e: React.PointerEvent<HTMLElement>) => startHeaderDrag(e, box.current, (x, y) => setPos({ x, y }));
  const isComponent = !!shownItem && (shownItem.copy.kind === "COMPONENT" || shownItem.copy.kind === "COMPONENT_SET");
  const isStyle = shownItem?.copy.kind === "STYLE";
  const size = Math.round((PREVIEW * zoom) / 100);
  const hidden = current ? (ed.engine.readNode(current.id) as { visible?: boolean } | null)?.visible === false : false;
  return (
    <Portal>
      <div
        ref={box}
        role="dialog"
        aria-label={t("Review updates")}
        tabIndex={-1}
        className={styles.reviewWindow}
        style={{ left: pos.x, top: pos.y, width: REVIEW.width, height: REVIEW.height, minWidth: REVIEW.minWidth, minHeight: REVIEW.minHeight }}
        data-review-update={shownItem?.copy.name ?? ""}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            close();
          } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
            if ((e.target as Element).closest("input, [role=slider]")) return;
            e.preventDefault();
            go(e.key === "ArrowLeft" ? -1 : 1);
          } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            if (!(e.target as Element).closest("input, [role=slider], [role=listbox]")) e.preventDefault(); // swallowed (Figma)
          }
        }}
      >
        <div className={styles.reviewHeader} onPointerDown={drag}>
          <IconButton icon="24.arrow.left" label={t("Back to updates")} onClick={back} />
          <span className={styles.libName}>{shownItem?.copy.name ?? t("Review updates")}</span>
          {hidden && <Icon name="24.hidden.small" className={styles.caret} aria-label={t("This instance is hidden")} />}
          <span className={styles.grow} />
          <IconButton icon="24.close.small" label={t("Close")} onClick={close} />
        </div>
        {!shownItem ? (
          <EmptyState icon="24.check" title={t("This asset is up to date")} />
        ) : (
          <>
            {shownItem.kind === "modified" && (
              <div className={styles.reviewTools}>
                {isComponent && <SegmentedControl label={t("Compare")} value={mode} options={[{ value: "side", label: t("Side by side") }, { value: "overlay", label: t("Overlay") }]} onChange={(v) => setMode(v as "side" | "overlay")} />}
                {mode === "overlay" && isComponent && <Slider label={t("Overlay opacity")} value={opacity} min={0} max={1} step={0.01} onChange={(v) => setOpacity(v)} className={styles.opacitySlider} />}
                <span className={styles.grow} />
                <Select label={t("Zoom")} width="hug" value={String(zoom)} options={ZOOMS.map((z) => ({ value: String(z), label: `${z}%` }))} onChange={(v) => setZoom(Number(v))} />
              </div>
            )}
            <div className={styles.reviewBody}>
              {shownItem.kind === "modified" &&
                (done || !u ? (
                  <figure className={styles.compareSide}>
                    <RemoteThumb asset={shownItem.asset as LibraryAsset} size={size} className={styles.compareThumb} />
                    <figcaption className={styles.meta}>{t("Updated")}</figcaption>
                  </figure>
                ) : (
                  <div className={cx(styles.compare, mode === "overlay" && styles.compareOverlay)} data-compare={mode} style={mode === "overlay" ? ({ "--overlay-opacity": opacity } as React.CSSProperties) : undefined}>
                    <figure className={styles.compareSide}>
                      <NodeThumb node={current?.id ?? shownItem.copy.guid} kind={shownItem.copy.kind} size={size} className={styles.compareThumb} />
                      <figcaption className={styles.meta}>{t("Current")}</figcaption>
                    </figure>
                    <figure className={styles.compareSide}>
                      <RemoteThumb asset={shownItem.asset as LibraryAsset} size={size} className={styles.compareThumb} />
                      <figcaption className={styles.meta}>{t("Updated")}</figcaption>
                    </figure>
                  </div>
                ))}
              {shownItem.kind === "removed" && (
                <div className={styles.notice}>
                  {isComponent ? t("This component was removed from {library}. What uses it here keeps working.", { library: shownItem.libraryName }) : t("This asset was removed from {library}. What uses it here keeps working.", { library: shownItem.libraryName })}
                  {isComponent ? ` ${t("Restore it to keep it as a component of this file.")}` : ""}
                </div>
              )}
              {shownItem.kind === "moved" && <div className={styles.notice}>{t("This component moved to {library}. Accepting keeps every instance linked and adds that library to this file.", { library: ed.libraries.get().names.get(shownItem.redirect!.toLibraryFileKey) ?? t("another library") })}</div>}
              {shownItem.asset?.description && <div className={styles.meta}>{shownItem.asset.description}</div>}
            </div>
            <div className={styles.reviewFooter}>
              {isComponent && instances.length > 1 && !done && (
                <div className={styles.instanceNav}>
                  <IconButton icon="24.arrow.left" label={t("Previous instance")} onClick={() => go(-1)} />
                  <span className={styles.meta}>{t("{index}/{total}", { index: Math.min(index, instances.length - 1) + 1, total: instances.length })}</span>
                  <IconButton icon="24.arrow.right" label={t("Next instance")} onClick={() => go(1)} />
                  <Button
                    variant="ghost"
                    onClick={() => {
                      if (!current) return;
                      if (current.page !== ed.store.page) ed.engine.setCurrentPage(current.page);
                      ed.engine.setSelection([current.id]);
                      ed.engine.command("ZOOM_TO_SELECTION");
                    }}
                  >
                    {t("Go to current instance")}
                  </Button>
                </div>
              )}
              <span className={styles.grow} />
              {done || (!u && updated) ? (
                <>
                  <Button variant="secondary" disabled icon="16.check">
                    {t("Updated")}
                  </Button>
                  {next && (
                    <Button
                      variant="primary"
                      onClick={() => {
                        setDone(false);
                        setUpdated(null);
                        setIndex(0);
                        setView(ed, { update: updateId(next) });
                      }}
                    >
                      {t("Next component")}
                    </Button>
                  )}
                </>
              ) : u?.kind === "modified" && isComponent ? (
                <>
                  <Button
                    variant={instances.length > 1 ? "secondary" : "primary"}
                    disabled={busy || (instances.length > 1 && !current)}
                    onClick={() =>
                      void run(
                        // The only instance: its copy updated in place (no second copy left behind); one of several: a copy of its own.
                        () => (instances.length <= 1 ? acceptUpdates(ed, [u]) : updateInstances(ed, u, current ? [current.id] : [])),
                        (n) => {
                          if (!n) return;
                          showToast({ message: t("Updated"), kind: "success" });
                          if (instances.length <= 1) {
                            setUpdated(u);
                            setDone(true);
                          }
                        }
                      )
                    }
                  >
                    {t("Update instance")}
                  </Button>
                  {instances.length > 1 && (
                    <Button
                      variant="primary"
                      loading={busy}
                      onClick={() =>
                        void run(
                          () => acceptUpdates(ed, [u]),
                          (n) => {
                            if (!n) return;
                            setUpdated(u);
                            setDone(true);
                          }
                        )
                      }
                    >
                      {t("Update all")}
                    </Button>
                  )}
                </>
              ) : u && u.kind !== "removed" ? (
                <Button
                  variant="primary"
                  loading={busy}
                  onClick={() =>
                    void run(
                      () => acceptUpdates(ed, [u]),
                      (n) => {
                        if (!n) return;
                        showToast({ message: u.kind === "moved" ? t("Moved to the new library") : t("Updated"), kind: "success" });
                        setUpdated(u);
                        setDone(true);
                      }
                    )
                  }
                >
                  {u.kind === "moved" ? t("Accept") : isStyle ? t("Update style") : t("Update")}
                </Button>
              ) : u?.kind === "removed" && isComponent ? (
                <Button
                  variant="secondary"
                  onClick={() => {
                    if (restoreRemovedComponent(ed, u.copy.guid)) {
                      showToast({ message: t("Component restored") });
                      close();
                    }
                  }}
                >
                  {t("Restore component")}
                </Button>
              ) : null}
            </div>
          </>
        )}
      </div>
    </Portal>
  );
}

/** The toolbar's height (the review opens 12 under it): the design system's size. */
function toolbarHeight(): number {
  const v = typeof getComputedStyle === "function" ? parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--ds-size-toolbar")) : NaN;
  return Number.isFinite(v) ? v : 48;
}
