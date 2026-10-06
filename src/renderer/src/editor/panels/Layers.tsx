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
import { useEditor } from "../controller";
import { useLayerTree, useUI } from "../hooks";
import {
  ancestorsOf,
  draggedLayers,
  dropTarget,
  rangeSelection,
  revealed,
  selectionRuns,
  toggleSelection,
  visibleRows,
  withSubtree,
  type DropTarget,
  type TreeNode,
} from "../model/layerTree";
import styles from "./Panels.module.css";

const ROW = 24;

/** The row's glyph: the layer's type, auto layout's direction, groups. */
export function layerIcon(node: TreeNode): IconName {
  if (node.group) return "16.group";
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
    case "SYMBOL":
      return "16.component";
    case "INSTANCE":
      return "16.instance";
    default:
      return "16.rectangle";
  }
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

  // A selection made on the canvas opens its ancestors (Figma reveals it) and scrolls to it.
  useEffect(() => {
    const now = ed.ui.get().expanded;
    const next = revealed(tree, selection, now);
    if (next !== now) ed.ui.set({ expanded: next });
  }, [ed, tree, selection]);
  const firstSelected = rows.findIndex((r) => selected.has(r.id));

  const select = (refs: Guid[]) => ed.engine.setSelection(refs);

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
    if (name && name !== tree.nodes.get(id)?.name) ed.setProps([id], { name }, "Rename");
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
            return (
              <LayerRow
                id={row.id}
                depth={row.depth}
                name={node.name}
                icon={layerIcon(node)}
                kind={node.type === "SYMBOL" ? "component" : node.type === "INSTANCE" ? "instance" : "default"}
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
                  if (!press.current) ed.engine.setHover([row.id]);
                }}
                onDoubleClick={() => ed.ui.set({ renaming: { kind: "layer", id: row.id } })}
                onContextMenu={(e) => {
                  e.preventDefault();
                  if (!selected.has(row.id)) select([row.id]);
                  ed.ui.set({ contextMenu: { x: e.clientX, y: e.clientY, canvas: null } });
                }}
                onToggleExpand={(alt) => toggleExpand(row.id, alt)}
                onToggleLock={() => ed.setProps([row.id], { locked: !node.locked }, node.locked ? "Unlock" : "Lock")}
                onToggleVisible={() => ed.setProps([row.id], { visible: !node.visible }, node.visible ? "Hide" : "Show")}
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
