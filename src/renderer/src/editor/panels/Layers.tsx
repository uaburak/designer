/**
 * The Layers panel (Figma's rules, docs/research/figma/R7-editor.md): the
 * current page's layers, top first, rows 24 high (VirtualList + DS LayerRow).
 * Click selects (⇧ a range from the anchor, ⌘ toggles), hovering a row
 * outlines the layer on the canvas, double-click (or ⌘R, or Enter) renames
 * — Tab goes on to the next row —, the lock and eye toggle, a chevron opens
 * (⌥ opens every level), a drag reorders and reparents (Engine.moveNodes),
 * and a canvas selection opens its ancestors and scrolls into view.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { LayerRow, PanelSection, VirtualList, showToast, type IconName } from "@/ds";
import { useHover, useSelection } from "@/engine/hooks";
import type { Guid } from "@/engine/codec";
import { useEditor, type EditorController } from "../controller";
import { writeOn } from "../components";
import { parseDerivedId } from "../model/components";
import { useLayerTree, useUI } from "../hooks";
import {
  ancestorsOf,
  detailsWindow,
  draggedLayers,
  dropTarget,
  rangeSelection,
  revealed,
  selectionRuns,
  toggleSelection,
  visibleRows,
  withSubtree,
  type DropTarget,
  type OutlineNode,
  type TreeNode,
} from "../model/layerTree";
import styles from "./Panels.module.css";

const ROW = 24;

/** The row's glyph: the layer's type (its real one, even when the engine can't draw it yet), auto layout's direction, groups. */
export function layerIcon(node: TreeNode): IconName {
  if (node.group) return "16.group";
  if (node.stateGroup) return "16.component.set";
  switch (node.type) {
    case "FRAME":
      if (node.stackMode === "HORIZONTAL") return node.stackWrap === "WRAP" ? "16.autolayout.wrap" : "16.autolayout.horizontal";
      if (node.stackMode === "VERTICAL") return "16.autolayout.vertical";
      if (node.stackMode === "GRID") return "16.autolayout.grid";
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
      switch (node.booleanOperation) {
        case "SUBTRACT":
          return "16.boolean.subtract";
        case "INTERSECT":
          return "16.boolean.intersect";
        case "XOR":
          return "16.boolean.exclude";
        default:
          return "16.boolean.union";
      }
    case "SYMBOL":
      return "16.component";
    case "INSTANCE":
      return "16.instance";
    default:
      return "16.rectangle";
  }
}

/** In the component purple: a component, a set or an instance — the outline knows (no details read for the rows between). */
const isComponentish = (n: OutlineNode | undefined) => !!n && (n.type === "SYMBOL" || n.type === "INSTANCE" || n.stateGroup === true);

/** Refs the engine can select: an instance's derived layer it doesn't know yet (before E6) selects the instance. */
export function selectable(ed: EditorController, refs: readonly Guid[]): Guid[] {
  const out: Guid[] = [];
  for (const id of refs) {
    const d = parseDerivedId(id);
    const ref = d && !ed.store.readNode(id) ? d.instance : id;
    if (!out.includes(ref)) out.push(ref);
  }
  return out;
}

export function Layers() {
  const ed = useEditor();
  const tree = useLayerTree();
  const expanded = useUI((s) => s.expanded);
  const renaming = useUI((s) => (s.renaming?.kind === "layer" ? s.renaming.id : null));
  const selection = useSelection(ed.store).refs;
  const hover = useHover(ed.store);
  const [drop, setDrop] = useState<DropTarget | null>(null);
  const press = useRef<{ id: Guid; x: number; y: number; dragging: Guid[] | null; deferred: boolean } | null>(null);

  const rows = useMemo(() => visibleRows(tree, expanded), [tree, expanded]);
  const selected = useMemo(() => new Set(selection), [selection]);
  const insideSelected = useMemo(() => {
    const out = new Set<Guid>();
    for (const r of rows) if (!selected.has(r.id) && ancestorsOf(tree, r.id).some((a) => selected.has(a))) out.add(r.id);
    return out;
  }, [rows, selected, tree]);
  const runs = useMemo(() => selectionRuns(rows, (id) => selected.has(id) || insideSelected.has(id)), [rows, selected, insideSelected]);
  // Rows in a component, a set or an instance (or one itself) highlight in the component purple (Figma).
  const componentRows = useMemo(() => {
    const out = new Set<Guid>();
    for (const r of rows) {
      const own = tree.nodes.get(r.id);
      if (isComponentish(own) || ancestorsOf(tree, r.id).some((a) => isComponentish(tree.nodes.get(a)))) out.add(r.id);
    }
    return out;
  }, [rows, tree]);

  // A selection made on the canvas opens its ancestors (Figma reveals it) and scrolls to it.
  useEffect(() => {
    const now = ed.ui.get().expanded;
    const next = revealed(tree, selection, now);
    if (next !== now) ed.ui.set({ expanded: next });
  }, [ed, tree, selection]);
  const firstSelected = rows.findIndex((r) => selected.has(r.id));

  const select = (refs: Guid[]) => ed.engine.setSelection(selectable(ed, refs));

  const onPointerDown = (e: React.PointerEvent, id: Guid) => {
    if (e.button !== 0 || renaming === id) return;
    const mod = e.metaKey || e.ctrlKey;
    let deferred = false;
    if (e.shiftKey) select(rangeSelection(tree, rows, ed.ui.get().anchor ?? selection[0] ?? null, id));
    else if (mod) {
      select(toggleSelection(tree, selection, id));
      ed.ui.set({ anchor: id });
    } else if (!selected.has(id)) {
      select([id]);
      ed.ui.set({ anchor: id });
    } else deferred = true; // already selected: a click (not a drag) narrows to it on release
    press.current = { id, x: e.clientX, y: e.clientY, dragging: null, deferred };
    const move = (ev: PointerEvent) => {
      const p = press.current;
      if (!p) return;
      if (!p.dragging) {
        if (Math.hypot(ev.clientX - p.x, ev.clientY - p.y) < 4) return;
        if (tree.nodes.get(p.id)?.derived) return; // an instance's layers stay where the main has them
        p.dragging = draggedLayers(tree, rows, ed.selection, p.id);
      }
      setDrop(targetAt(ev.clientX, ev.clientY, p.dragging));
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const p = press.current;
      press.current = null;
      setDrop(null);
      if (!p) return;
      if (p.dragging) {
        const target = targetAt(ev.clientX, ev.clientY, p.dragging);
        if (!target) return;
        if (ed.engine.moveNodes(p.dragging, target.parent, target.index) <= 0) {
          showToast({ message: "The layers can't go there" });
          return;
        }
        if (target.position === "inside") ed.ui.set((s) => ({ expanded: new Set([...s.expanded, target.parent]) }));
      } else if (p.deferred) {
        select([p.id]);
        ed.ui.set({ anchor: p.id });
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  /** The drop under a pointer (the row it is over, and where on it). */
  const targetAt = (x: number, y: number, moving: Guid[]): DropTarget | null => {
    const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-ds="LayerRow"]');
    const list = document.querySelector<HTMLElement>("[data-layer-list]");
    if (!el) {
      const box = list?.getBoundingClientRect();
      if (box && x >= box.left && x <= box.right && y >= box.top && y <= box.bottom) return dropTarget(tree, rows, rows.length, 0, new Set(moving));
      return null;
    }
    const index = rows.findIndex((r) => r.id === el.dataset.id);
    const r = el.getBoundingClientRect();
    return index < 0 ? null : dropTarget(tree, rows, index, (y - r.top) / r.height, new Set(moving));
  };

  const rename = (id: Guid, name: string | null, exit: string) => {
    if (name && name !== tree.nodes.get(id)?.name) {
      if (tree.nodes.get(id)?.derived) ed.batch("Rename", () => writeOn(ed, id, { name }));
      else ed.setProps([id], { name }, "Rename");
    }
    const at = rows.findIndex((r) => r.id === id);
    const next = exit === "tab" ? rows[at + 1] : exit === "shift-tab" ? rows[at - 1] : undefined;
    ed.ui.set({ renaming: next ? { kind: "layer", id: next.id } : null });
    if (exit === "enter" || exit === "escape") ed.focusCanvas();
  };

  const toggleExpand = (id: Guid, alt: boolean) =>
    ed.ui.set((s) => {
      const open = !s.expanded.has(id);
      if (alt) return { expanded: withSubtree(tree, id, s.expanded, open) };
      const next = new Set(s.expanded);
      if (open) next.add(id);
      else next.delete(id);
      return { expanded: next };
    });

  return (
    <PanelSection className={styles.layers} title="Layers" pad="none">
      <div
        className={styles.layerList}
        role="tree"
        aria-label="Layers"
        aria-multiselectable
        data-layer-list=""
        onPointerLeave={() => {
          if (!press.current) ed.engine.setHover([]);
        }}
      >
        <VirtualList
          count={rows.length}
          rowHeight={ROW}
          scrollToIndex={firstSelected >= 0 ? firstSelected : undefined}
          label="Layers"
          renderRow={(i) => {
            const row = rows[i];
            const node = tree.nodes.get(row.id)!;
            // Pass 2 (Figma's two-pass panel): the row's name, eye, lock and icon are computed only now, for the rows
            // the list draws; a row without them in hand brings its whole window in one engine read.
            if (!tree.details.has(row.id)) tree.details.prefetch(detailsWindow(rows, i));
            return (
              <LayerRow
                id={row.id}
                depth={row.depth}
                name={node.name}
                icon={layerIcon(node)}
                kind={node.type === "SYMBOL" || node.stateGroup ? "component" : node.type === "INSTANCE" ? "instance" : "default"}
                tone={componentRows.has(row.id) ? "component" : "default"}
                expanded={row.expandable ? row.expanded : undefined}
                selected={selected.has(row.id)}
                selectedAncestor={insideSelected.has(row.id)}
                hovered={hover === row.id}
                locked={node.locked}
                hidden={!node.visible}
                strong={row.depth === 0 && ((node.type === "FRAME" && !node.group) || node.type === "SECTION" || node.type === "SYMBOL")}
                renaming={renaming === row.id}
                run={runs.get(row.id)}
                drop={drop?.row === row.id ? drop.position : undefined}
                tabIndex={selected.has(row.id) ? 0 : -1}
                onPointerDown={(e) => onPointerDown(e, row.id)}
                onPointerEnter={() => {
                  if (!press.current) ed.engine.setHover(selectable(ed, [row.id]));
                }}
                onDoubleClick={() => ed.ui.set({ renaming: { kind: "layer", id: row.id } })}
                onContextMenu={(e) => {
                  e.preventDefault();
                  if (!selected.has(row.id)) select([row.id]);
                  ed.ui.set({ contextMenu: { x: e.clientX, y: e.clientY, canvas: null } });
                }}
                onToggleExpand={(alt) => toggleExpand(row.id, alt)}
                onToggleLock={node.derived ? undefined : () => ed.setProps([row.id], { locked: !node.locked }, node.locked ? "Unlock" : "Lock")}
                onToggleVisible={() =>
                  node.derived ? ed.batch(node.visible ? "Hide" : "Show", () => writeOn(ed, row.id, { visible: !node.visible })) : ed.setProps([row.id], { visible: !node.visible }, node.visible ? "Hide" : "Show")
                }
                onRequestRename={() => ed.ui.set({ renaming: { kind: "layer", id: row.id } })}
                onRename={(name, exit) => rename(row.id, name, exit)}
              />
            );
          }}
        />
      </div>
    </PanelSection>
  );
}
