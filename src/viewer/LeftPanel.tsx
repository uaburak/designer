/**
 * Dev Mode's left panel, read-only: the file's name with "Developer preview" under it, the pages, and the current
 * page's layers (top layer first; a click selects, ⇧ adds; the chevron opens a layer). Selecting a layer here shows
 * it on the canvas.
 */
import { useMemo, useState } from "react";
import { LayerRow, PageRow, PanelSection, ScrollArea, type IconName } from "@/ds";
import { useCurrentPage, useSelection } from "@/engine/hooks";
import type { Guid } from "@/engine/codec";
import { useViewer } from "./context";
import type { LayerNode, PageTree } from "./viewerDoc";
import { STATUS_LABEL } from "./inspect/devMode";
import styles from "./Viewer.module.css";

export function layerIcon(n: LayerNode): IconName {
  if (n.group) return "16.group";
  if (n.stateGroup) return "16.component.set";
  switch (n.type) {
    case "FRAME":
      if (n.stackMode === "HORIZONTAL") return n.stackWrap === "WRAP" ? "16.autolayout.wrap" : "16.autolayout.horizontal";
      if (n.stackMode === "VERTICAL") return "16.autolayout.vertical";
      if (n.stackMode === "GRID") return "16.autolayout.grid";
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
    default:
      return "16.rectangle";
  }
}

export function LeftPanel() {
  const { preview, host } = useViewer();
  return (
    <aside className={styles.left} aria-label="Layers panel">
      <div className={styles.fileHeader}>
        <span className={styles.fileName} title={preview.manifest.fileName}>
          {preview.manifest.fileName || "Untitled"}
        </span>
        <span className={styles.fileSub}>{host?.subtitle ?? "Developer preview"}</span>
      </div>
      <Pages />
      <Statuses />
      <Layers />
    </aside>
  );
}

function Pages() {
  const { engine, store, preview } = useViewer();
  const current = useCurrentPage(store);
  const [open, setOpen] = useState(true);
  if (preview.manifest.pages.length < 2) return null;
  return (
    <PanelSection title="Pages" collapsible open={open} onOpenChange={setOpen} pad="none" className={styles.pages}>
      {open && (
        <div role="listbox" aria-label="Pages" className={styles.pageList}>
          {preview.manifest.pages.map((p) => (
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
      )}
    </PanelSection>
  );
}

/**
 * "Ready for development" (help.figma.com 15023124644247 / 26781702258583): the page's designs marked "Ready for dev"
 * or "Completed"; a row selects and zooms to its design.
 */
function Statuses() {
  const { engine, store, doc, host } = useViewer();
  const page = useCurrentPage(store);
  const list = useMemo(() => doc.statuses(page), [doc, page]);
  const [open, setOpen] = useState(true);
  if (!list.length) return null;
  return (
    <PanelSection title="Ready for development" collapsible open={open} onOpenChange={setOpen} pad="none" className={styles.pages}>
      {open &&
        list.map((s) => (
          <button
            key={s.id}
            type="button"
            className={styles.statusRow}
            data-status-row={s.status}
            onClick={() => {
              // The editor's Dev Mode opens the design in focus view (help.figma.com 23918228264855); the viewer zooms to it.
              if (host?.onFocus) return host.onFocus(s.id);
              engine.setSelection([s.id]);
              engine.command("ZOOM_TO_SELECTION");
            }}
          >
            <span>{s.name}</span>
            <span className={styles.statusLabel} data-status={s.status}>
              {STATUS_LABEL[s.status]}
            </span>
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
  return (
    <section className={styles.layers} aria-label="Layers">
      <div className={styles.sectionTitle}>Layers</div>
      <ScrollArea className={styles.layerScroll}>
        <div role="tree" aria-label="Layers" aria-multiselectable>
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
                if (e.shiftKey || e.metaKey) engine.setSelection(selected.has(node.id) ? selection.refs.filter((r) => r !== node.id) : [...selection.refs, node.id]);
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
