/**
 * The Libraries modal (UI3; help.figma.com "Enable libraries", "Review and accept updates", R5): the current file
 * (publish it, or "Move to a folder to publish" in Drafts), the libraries added to this file (Remove from file —
 * what is used stays), the workspace's other published libraries (Add to file), search, and a preview of a
 * library's components, styles and variables. The Updates tab lists what the enabled libraries changed for the
 * assets used here, and each one's review: before / after side by side or overlaid, Update selected instance,
 * Update, Update all; removed assets (Restore component) and moved ones (accepted with the update).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Button, EmptyState, Icon, IconButton, SearchField, SegmentedControl, Spinner, Tabs, showToast, cx, Dialog } from "@/ds";
import type { LibraryAsset, LibraryVersion } from "../../../../../shared/store/types";
import { useEditor } from "../../controller";
import { useDocumentVersion, useLibraries, useUI } from "../../hooks";
import { acceptUpdates, restoreRemovedComponent, selectedInstancesOf, setLibraryEnabled, updateId, updateSelectedInstances, type UpdateItem } from "../../libraries";
import type { LibraryEntry } from "../../documentSource";
import { NodeThumb, RemoteThumb, kindGlyph } from "./Thumbs";
import styles from "./Libraries.module.css";

export function LibrariesDialog() {
  const open = useUI((s) => s.librariesDialog);
  return open ? <Libraries /> : null;
}

const countsText = (c: { components: number; styles: number; variables: number }) => {
  const parts = [c.components && `${c.components} ${c.components === 1 ? "component" : "components"}`, c.styles && `${c.styles} ${c.styles === 1 ? "style" : "styles"}`, c.variables && `${c.variables} ${c.variables === 1 ? "variable" : "variables"}`].filter(Boolean);
  return parts.length ? parts.join(" · ") : "No assets";
};

function Libraries() {
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
  return (
    <Dialog title="Libraries" size="large" open onClose={close}>
      <div ref={body} className={styles.libraries} data-libraries-dialog="">
        <Tabs
          label="Libraries"
          value={view.tab}
          tabs={[
            { value: "libraries", label: "Libraries" },
            { value: "updates", label: "Updates", badge: pending || undefined },
          ]}
          onChange={(tab) => set({ tab: tab as "libraries" | "updates", library: null, update: null })}
        />
        {!state.on ? (
          <EmptyState icon="24.library" title="Libraries aren't available here" body="Open a file from your workspace to publish and use libraries." />
        ) : view.tab === "updates" ? (
          view.update ? <ReviewUpdate id={view.update} onBack={() => set({ update: null })} /> : <Updates onOpen={(id) => set({ update: id })} />
        ) : view.library ? (
          <LibraryPreview lib={view.library} onBack={() => set({ library: null })} />
        ) : (
          <LibraryList onOpen={(lib) => set({ library: lib })} onPublish={() => ed.ui.set({ publishOpen: true, librariesDialog: null })} />
        )}
      </div>
    </Dialog>
  );
}

function LibraryList({ onOpen, onPublish }: { onOpen: (lib: string) => void; onPublish: () => void }) {
  const ed = useEditor();
  const state = useLibraries();
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const q = query.trim().toLowerCase();
  const match = (name: string) => !q || name.toLowerCase().includes(q);
  const byKey = new Map(state.available.map((e) => [e.fileKey, e]));
  const added = state.enabled.map((lib) => byKey.get(lib) ?? { fileKey: lib, name: state.names.get(lib) ?? "Missing library", location: "", record: null }).filter((e) => match(e.name));
  const others = state.available.filter((e) => !state.enabled.includes(e.fileKey) && match(e.name));
  const toggle = async (lib: string, on: boolean, name: string) => {
    setBusy(lib);
    try {
      await setLibraryEnabled(ed, lib, on);
      showToast({ message: on ? `Added ${name} to this file` : `Removed ${name} from this file` });
    } catch {
      showToast({ message: on ? "The library couldn't be added" : "The library couldn't be removed", kind: "error" });
    } finally {
      setBusy(null);
    }
  };
  const own = state.own;
  const fileName = useUI((s) => s.fileName);
  return (
    <div className={styles.listBody}>
      <SearchField value={query} onChange={setQuery} placeholder="Search libraries" autoFocus />
      {state.loading && (
        <div className={styles.loading}>
          <Spinner /> Loading libraries…
        </div>
      )}
      <section aria-label="Current file">
        <div className={styles.sectionTitle}>Current file</div>
        <div className={styles.libRow} data-library-row="current">
          <LibIcon />
          <div className={styles.libText}>
            <span className={styles.libName}>{fileName}</span>
            <span className={styles.meta}>{state.inDrafts ? "In Drafts · Move to a folder to publish" : own ? `${countsText(own.counts)} · Version ${own.latestVersion}` : "Not published"}</span>
          </div>
          <Button variant="secondary" disabled={state.inDrafts} tooltip={state.inDrafts ? "Move to a folder to publish" : undefined} onClick={onPublish}>
            {own ? "Publish changes…" : "Publish…"}
          </Button>
        </div>
      </section>
      <section aria-label="Added to this file">
        <div className={styles.sectionTitle}>Added to this file</div>
        {added.length === 0 && <div className={styles.none}>{q ? `No results for “${query}”` : "No libraries added to this file"}</div>}
        {added.map((e) => (
          <LibraryRow key={e.fileKey} entry={e as LibraryEntry} missing={!byKey.has(e.fileKey)} onOpen={byKey.has(e.fileKey) ? () => onOpen(e.fileKey) : undefined}>
            <Button variant="secondary" loading={busy === e.fileKey} onClick={() => void toggle(e.fileKey, false, e.name)}>
              Remove from file
            </Button>
          </LibraryRow>
        ))}
      </section>
      <section aria-label="Libraries in this workspace">
        <div className={styles.sectionTitle}>Libraries in this workspace</div>
        {others.length === 0 && <div className={styles.none}>{q ? `No results for “${query}”` : state.available.length ? "Every library is added to this file" : "No other files are published as libraries yet"}</div>}
        {others.map((e) => (
          <LibraryRow key={e.fileKey} entry={e} onOpen={() => onOpen(e.fileKey)}>
            <Button variant="primary" loading={busy === e.fileKey} onClick={() => void toggle(e.fileKey, true, e.name)}>
              Add to file
            </Button>
          </LibraryRow>
        ))}
      </section>
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

function LibraryRow({ entry, missing, onOpen, children }: { entry: LibraryEntry; missing?: boolean; onOpen?: () => void; children: React.ReactNode }) {
  return (
    <div className={styles.libRow} data-library-row={entry.name}>
      <LibIcon />
      <button type="button" className={styles.libOpen} onClick={onOpen} disabled={!onOpen} aria-label={`Preview ${entry.name}`}>
        <span className={styles.libName}>{entry.name}</span>
        <span className={styles.meta}>{missing ? "Missing library · assets used here keep working" : `${entry.location} · ${countsText(entry.record.counts)}`}</span>
      </button>
      {children}
    </div>
  );
}

/** A library's components (thumbnails), styles and variables, with Add to file / Remove from file. */
function LibraryPreview({ lib, onBack }: { lib: string; onBack: () => void }) {
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
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={styles.listBody} data-library-preview={entry?.name ?? ""}>
      <div className={styles.previewHeader}>
        <IconButton icon="24.arrow.left" label="Back to libraries" onClick={onBack} />
        <div className={styles.libText}>
          <span className={styles.libName}>{entry?.name ?? state.names.get(lib) ?? "Library"}</span>
          <span className={styles.meta}>{entry ? `${entry.location} · ${countsText(entry.record.counts)}` : ""}</span>
        </div>
        <Button variant={enabled ? "secondary" : "primary"} loading={busy} onClick={() => void toggle()}>
          {enabled ? "Remove from file" : "Add to file"}
        </Button>
      </div>
      <SearchField value={query} onChange={setQuery} placeholder="Search assets" />
      {!manifest && (
        <div className={styles.loading}>
          <Spinner /> Loading…
        </div>
      )}
      {manifest && manifest.description && <div className={styles.meta}>Version {manifest.version}: {manifest.description}</div>}
      {components.length > 0 && (
        <section aria-label="Components">
          <div className={styles.sectionTitle}>Components</div>
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
        <section aria-label="Styles">
          <div className={styles.sectionTitle}>Styles</div>
          {styleAssets.map((a) => (
            <div key={a.key} className={styles.assetRow}>
              <Icon name={kindGlyph(a.kind, a)} className={styles.thumbGlyph} />
              <span className={styles.changeName}>{a.name}</span>
              <span className={styles.meta}>{a.styleType === "FILL" ? "Color" : a.styleType === "TEXT" ? "Text" : a.styleType === "EFFECT" ? "Effect" : "Layout guide"}</span>
            </div>
          ))}
        </section>
      )}
      {variables.length > 0 && (
        <section aria-label="Variables">
          <div className={styles.sectionTitle}>Variables</div>
          {variables.map((a) => (
            <div key={a.key} className={styles.assetRow}>
              <Icon name={kindGlyph(a.kind, a)} className={styles.thumbGlyph} />
              <span className={styles.changeName}>{a.name}</span>
              <span className={styles.meta}>{collections.get(a.collectionKey ?? "") ?? ""}</span>
            </div>
          ))}
        </section>
      )}
      {manifest && !listed.length && <div className={styles.none}>{q ? `No results for “${query}”` : "This library has no assets"}</div>}
    </div>
  );
}

const KIND_TEXT: Record<UpdateItem["kind"], string> = { modified: "Modified", removed: "Removed from library", moved: "Moved" };

const instancesText = (n: number) => (n ? ` · ${n} ${n === 1 ? "instance" : "instances"}` : "");

function Updates({ onOpen }: { onOpen: (id: string) => void }) {
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
      if (n) showToast({ message: n === 1 ? "Updated 1 asset" : `Updated ${n} assets`, kind: "success" });
    } finally {
      setBusy(false);
    }
  };
  if (!updates.length) return <EmptyState icon="24.library" title="You're up to date" body="Updates to the libraries this file uses show up here." />;
  return (
    <div className={styles.listBody} data-updates="">
      <div className={styles.updatesHeader}>
        <span className={styles.meta}>{acceptable.length === 1 ? "1 update available" : `${acceptable.length} updates available`}</span>
        <Button variant="primary" loading={busy} disabled={!acceptable.length} onClick={() => void all()}>
          Update all
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
                  {u.kind === "moved" ? `Moved to ${u.redirect?.toLibraryFileKey ? (ed.libraries.get().names.get(u.redirect.toLibraryFileKey) ?? "another library") : "another library"}` : KIND_TEXT[u.kind]}
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
          <IconButton icon="24.arrow.left" label="Back to updates" onClick={onBack} />
          <span className={styles.libName}>Updated</span>
        </div>
        <EmptyState icon="24.check" title="This asset is up to date" />
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
        <IconButton icon="24.arrow.left" label="Back to updates" onClick={onBack} />
        <div className={styles.libText}>
          <span className={styles.libName}>{u.copy.name}</span>
          <span className={styles.meta}>
            {u.libraryName} · {u.kind === "modified" ? "Modified" : u.kind === "removed" ? "Removed from library" : "Moved"}
            {usage ? ` · ${usage} ${usage === 1 ? "instance" : "instances"} in this file` : ""}
          </span>
        </div>
        {u.kind === "modified" && isComponent && <SegmentedControl label="Compare" value={mode} options={[{ value: "side", label: "Side by side" }, { value: "overlay", label: "Overlay" }]} onChange={(v) => setMode(v as "side" | "overlay")} />}
      </div>
      {u.kind === "modified" && (
        <div className={cx(styles.compare, mode === "overlay" && styles.compareOverlay)} data-compare={mode}>
          <figure className={styles.compareSide}>
            <NodeThumb node={u.copy.guid} kind={u.copy.kind} size={200} className={styles.compareThumb} />
            <figcaption className={styles.meta}>Current</figcaption>
          </figure>
          <figure className={styles.compareSide}>
            <RemoteThumb asset={u.asset as LibraryAsset} size={200} className={styles.compareThumb} />
            <figcaption className={styles.meta}>Updated</figcaption>
          </figure>
        </div>
      )}
      {u.kind === "removed" && (
        <div className={styles.notice}>
          This {isComponent ? "component" : "asset"} was removed from {u.libraryName}. What uses it here keeps working.
          {isComponent ? " Restore it to keep it as a component of this file." : ""}
        </div>
      )}
      {u.kind === "moved" && <div className={styles.notice}>This component moved to {ed.libraries.get().names.get(u.redirect!.toLibraryFileKey) ?? "another library"}. Accepting keeps every instance linked and adds that library to this file.</div>}
      {u.asset?.description && <div className={styles.meta}>{u.asset.description}</div>}
      <div className={styles.reviewActions}>
        {u.kind === "modified" && isComponent && (
          <Button variant="secondary" disabled={busy || !selected.length} tooltip={selected.length ? undefined : "Select instances of this component on the canvas"} onClick={() => void run(() => updateSelectedInstances(ed, u), (n) => (n === 1 ? "Updated 1 instance" : n ? `Updated ${n} instances` : null))}>
            {selected.length > 1 ? `Update ${selected.length} selected instances` : "Update selected instance"}
          </Button>
        )}
        {u.kind !== "removed" && (
          <Button variant="primary" loading={busy} onClick={() => void run(() => acceptUpdates(ed, [u]), (n) => (!n ? null : u.kind === "moved" ? "Moved to the new library" : "Updated"), true)}>
            {u.kind === "moved" ? "Accept" : "Update"}
          </Button>
        )}
        {u.kind === "removed" && isComponent && (
          <Button
            variant="secondary"
            onClick={() => {
              if (restoreRemovedComponent(ed, u.copy.guid)) {
                showToast({ message: "Component restored" });
                ed.ui.set({ librariesDialog: null });
              }
            }}
          >
            Restore component
          </Button>
        )}
      </div>
    </div>
  );
}
