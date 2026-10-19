/**
 * Dev Mode's left panel, read-only (the owner's capture docs/research/figma/live/owner-2026-10-18/figma-devmode-inspect):
 * the file's name with "Developer preview" under it (the editor's Dev Mode puts its own header — name ▾, location,
 * Minimize UI — in its place), "Pages" with a search, "Ready for development" with "Mark as ready for dev", and the
 * current page's layers (top layer first; a click selects, ⇧ adds; the chevron opens a layer) — full-width rows, the
 * selected one and the layers inside it in Dev Mode's green. Selecting a layer here shows it on the canvas.
 */
import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { Button, Icon, IconButton, LayerRow, MenuButton, PageRow, PanelSection, ScrollArea, SearchField, type IconName } from "@/ds";
import { t, useT } from "@/i18n";
import { useCurrentPage, useSelection } from "@/engine/hooks";
import type { Guid } from "@/engine/codec";
import { useViewer } from "./context";
import type { LayerNode, PageTree } from "./viewerDoc";
import { StatusTag } from "@/editor/devmode/StatusTag";
import styles from "./Viewer.module.css";

export function layerIcon(n: LayerNode): IconName {
  if (n.group) return "16.group";
  if (n.stateGroup) return "16.component.set";
  switch (n.type) {
    // Dev Mode names a frame "#" with or without auto layout (the owner's capture owner-2026-10-18: an auto-layout
    // frame's row and Inspect's type row both "# Frame").
    case "FRAME":
      return "16.frame";
    case "SECTION":
      return "16.section";
    case "ELLIPSE":
      return "16.ellipse";
    case "TEXT":
      return "16.text";
    case "LINE":
      return "16.line";
    case "VECTOR":
      return "16.vector";
    case "STAR":
      return "16.star";
    case "REGULAR_POLYGON":
      return "16.polygon";
    case "BOOLEAN_OPERATION":
      return n.booleanOperation === "SUBTRACT" ? "16.boolean.subtract" : n.booleanOperation === "INTERSECT" ? "16.boolean.intersect" : n.booleanOperation === "XOR" ? "16.boolean.exclude" : "16.boolean.union";
    case "SYMBOL":
      return "16.component";
    case "INSTANCE":
      return "16.instance";
    case "GROUP":
      return "16.group";
    // Draw (docs/draw.md §9's layer icons)
    case "TEXT_PATH":
      return "16.text-path";
    case "TRANSFORM":
      return "16.repeat";
    default:
      return "16.rectangle";
  }
}

/** `header`: the editor's own file header in place of the viewer's; `style` / `children`: its width and resize handle. */
export function LeftPanel({ header, style, children }: { header?: ReactNode; style?: CSSProperties; children?: ReactNode } = {}) {
  useT();
  return (
    <aside className={styles.left} style={style} aria-label={t("Layers panel")} data-panel="left" data-dev-left="">
      {header ?? <FileHeader />}
      <Pages />
      <Statuses />
      <Layers />
      {children}
    </aside>
  );
}

function FileHeader() {
  const { preview, host } = useViewer();
  return (
    <div className={styles.fileHeader}>
      {host?.fileMenu ? (
        <MenuButton label="File" entries={() => host.fileMenu!.entries()} onSelect={(id) => host.fileMenu!.onSelect(id)} className={styles.fileMenu}>
          <span className={styles.fileName} title={preview.manifest.fileName}>
            {preview.manifest.fileName || "Untitled"}
          </span>
          <Icon name="16.chevron.down" />
        </MenuButton>
      ) : (
        <span className={styles.fileName} title={preview.manifest.fileName}>
          {preview.manifest.fileName || "Untitled"}
        </span>
      )}
      <span className={styles.fileSub}>{host?.subtitle ?? "Developer preview"}</span>
    </div>
  );
}

function Pages() {
  useT();
  const { engine, store, preview } = useViewer();
  const current = useCurrentPage(store);
  // Figma's Dev Mode: "Pages" with a search at its right (no fold); the search filters the list by name.
  const [query, setQuery] = useState<string | null>(null);
  if (preview.manifest.pages.length < 2) return null;
  const q = query?.trim().toLowerCase() ?? "";
  const pages = q ? preview.manifest.pages.filter((p) => p.name.toLowerCase().includes(q)) : preview.manifest.pages;
  return (
    <PanelSection
      title={t("Pages")}
      pad="none"
      className={styles.pages}
      actions={<IconButton icon="24.search.small" label={t("Search pages")} aria-pressed={query !== null} onClick={() => setQuery((v) => (v === null ? "" : null))} />}
    >
      {query !== null && (
        <div className={styles.pageSearch}>
          <SearchField label={t("Search pages")} value={query} autoFocus onChange={setQuery} onExit={() => setQuery(null)} />
        </div>
      )}
      <div role="listbox" aria-label={t("Pages")} className={styles.pageList}>
        {pages.map((p) => (
          <PageRow
            key={p.id}
            id={p.id}
            name={p.name}
            current={p.id === current}
            tabIndex={0}
            onSelect={() => {
              if (p.id === current) return;
              engine.setCurrentPage(p.id);
              engine.command("ZOOM_TO_FIT");
            }}
          />
        ))}
      </div>
    </PanelSection>
  );
}

/**
 * "Ready for development" (help.figma.com 15023124644247 / 26781702258583): the page's designs with a status — the
 * owner's labels and dots (docs/editor.md "Frame status (ours)"), Figma's "Changed" beside Ready to Dev; a row selects
 * and zooms to its design.
 */
function Statuses() {
  useT();
  const { engine, store, doc, host } = useViewer();
  const page = useCurrentPage(store);
  const selection = useSelection(store);
  const list = useMemo(() => doc.statuses(page), [doc, page]);
  const [open, setOpen] = useState(true);
  // The editor's Dev Mode: "Ready for dev" with the file's count opens the view of every page's designs (D-4).
  const total = useMemo(() => (host?.onReadyView ? engine.pages().reduce((n, p) => n + doc.statuses(p.guid).length, 0) : 0), [engine, doc, host]);
  // "Mark as ready for dev" (Figma's Dev Mode, the owner's capture): the selection's design — a top-level frame,
  // component or section without a status — opens the status menu where its Ready to Dev is.
  const one = selection.refs.length === 1 ? selection.refs[0] : null;
  const design = one && doc.parentOf(one) === null && !list.some((s) => s.id === one) ? one : null;
  const mark = !!host?.onStatus;
  if (!list.length && !total && !mark) return null;
  return (
    <PanelSection title={t("Ready for development")} collapsible={!mark} open={open} onOpenChange={setOpen} pad="none" className={styles.pages} data-ready-section="">
      {mark && (
        <div className={styles.markReady}>
          <Button variant="secondary" icon="24.dev-brackets" disabled={!design} onClick={(e) => design && host.onStatus!(design, e.currentTarget.getBoundingClientRect())} data-mark-ready="">
            {t("Mark as ready for dev")}
          </Button>
        </div>
      )}
      {open && host?.onReadyView && total > 0 && (
        <button type="button" className={styles.statusRow} data-ready-view="" onClick={() => host.onReadyView!()}>
          <span>{t("Ready for dev")}</span>
          <span className={styles.statusLabel}>{total}</span>
        </button>
      )}
      {open &&
        list.map((s) => (
          <button
            key={s.id}
            type="button"
            className={styles.statusRow}
            data-status-row={s.workflow}
            onClick={() => {
              // The editor's Dev Mode opens the design in focus view (help.figma.com 23918228264855); the viewer zooms to it.
              if (host?.onFocus) return host.onFocus(s.id);
              engine.setSelection([s.id]);
              engine.command("ZOOM_TO_SELECTION");
            }}
          >
            <span>{s.name}</span>
            <StatusTag workflow={s.workflow} dev={s.status} variant="dot" />
          </button>
        ))}
    </PanelSection>
  );
}

interface Row {
  node: LayerNode;
  depth: number;
}

function visibleRows(tree: PageTree, expanded: ReadonlySet<Guid>): Row[] {
  const out: Row[] = [];
  const walk = (ids: readonly Guid[], depth: number) => {
    for (const id of ids) {
      const node = tree.nodes.get(id);
      if (!node) continue;
      out.push({ node, depth });
      if (expanded.has(id)) walk(node.children, depth + 1);
    }
  };
  walk(tree.roots, 0);
  return out;
}

function Layers() {
  const { engine, store, doc } = useViewer();
  const page = useCurrentPage(store);
  const selection = useSelection(store);
  const tree = useMemo(() => doc.tree(page), [doc, page]);
  // The selection's ancestors open when it changes, as Figma's Layers panel does when the canvas selects deep; a row
  // closed afterwards stays closed.
  const withAncestors = (base: ReadonlySet<Guid>, refs: readonly Guid[]) => {
    const next = new Set(base);
    for (const id of refs) for (let p = doc.parentOf(id); p; p = doc.parentOf(p)) next.add(p);
    return next;
  };
  const [shown, setShown] = useState<ReadonlySet<Guid>>(() => withAncestors(new Set(), selection.refs));
  const [seen, setSeen] = useState(selection.refs);
  if (seen !== selection.refs) {
    setSeen(selection.refs);
    setShown(withAncestors(shown, selection.refs));
  }
  const rows = useMemo(() => visibleRows(tree, shown), [tree, shown]);
  const selected = new Set(selection.refs);
  // A layer inside a selected one: the paler green (the owner's capture: the frame's rows under it).
  const inside = (id: Guid) => {
    for (let p = doc.parentOf(id); p; p = doc.parentOf(p)) if (selected.has(p)) return true;
    return false;
  };
  return (
    <section className={styles.layers} aria-label={t("Layers")}>
      <div className={styles.sectionTitle}>{t("Layers")}</div>
      <ScrollArea className={styles.layerScroll}>
        <div role="tree" aria-label={t("Layers")} aria-multiselectable className={styles.devLayers}>
          {rows.map(({ node, depth }) => (
            <LayerRow
              key={node.id}
              id={node.id}
              depth={depth}
              name={node.name}
              icon={layerIcon(node)}
              kind={node.type === "SYMBOL" || node.stateGroup ? "component" : node.type === "INSTANCE" ? "instance" : "default"}
              expanded={node.children.length ? shown.has(node.id) : undefined}
              selected={selected.has(node.id)}
              selectedAncestor={!selected.has(node.id) && inside(node.id)}
              hidden={!node.visible}
              onToggleExpand={() =>
                setShown((v) => {
                  const next = new Set(v);
                  if (!next.delete(node.id)) next.add(node.id);
                  return next;
                })
              }
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                if (e.shiftKey || e.metaKey || e.ctrlKey) engine.setSelection(selected.has(node.id) ? selection.refs.filter((r) => r !== node.id) : [...selection.refs, node.id]);
                else engine.setSelection([node.id]);
              }}
              onDoubleClick={() => engine.command("ZOOM_TO_SELECTION")}
            />
          ))}
        </div>
      </ScrollArea>
    </section>
  );
}
