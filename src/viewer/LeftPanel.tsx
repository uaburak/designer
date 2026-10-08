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
  const { preview } = useViewer();
  return (
    <aside className={styles.left} aria-label="Layers panel">
      <div className={styles.fileHeader}>
        <span className={styles.fileName} title={preview.manifest.fileName}>
          {preview.manifest.fileName || "Untitled"}
        </span>
        <span className={styles.fileSub}>Developer preview</span>
      </div>
      <Pages />
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
  const [expanded, setExpanded] = useState<ReadonlySet<Guid>>(new Set());
  // The selection's ancestors open, as Figma's Layers panel does when the canvas selects deep.
  const shown = useMemo(() => {
    const next = new Set(expanded);
    for (const id of selection.refs) for (let p = doc.parentOf(id); p; p = doc.parentOf(p)) next.add(p);
    return next;
  }, [expanded, selection.refs, doc]);
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
                setExpanded((s) => {
                  const next = new Set(s);
                  if (shown.has(node.id)) {
                    next.delete(node.id);
                    // closing a row the selection opened keeps it closed
                    for (const id of selection.refs) if (id !== node.id && isUnder(doc, id, node.id)) engine.setSelection([node.id]);
                  } else next.add(node.id);
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

function isUnder(doc: { parentOf(id: Guid): Guid | null }, id: Guid, ancestor: Guid): boolean {
  for (let p = doc.parentOf(id); p; p = doc.parentOf(p)) if (p === ancestor) return true;
  return false;
}
