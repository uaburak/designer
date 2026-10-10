/**
 * The Layers panel (Figma's rules, docs/research/figma/R7-editor.md; geometry from the live capture,
 * docs/research/figma/live): the current page's layers, top first (an auto layout's in flow order), rows on a 32
 * pitch (VirtualList + DS LayerRow). Click selects (⇧ a range from the anchor, ⌘ toggles), hovering a row outlines
 * the layer on the canvas (Preferences › Highlight layers on hover), double-click or ⌘R renames — Tab goes on to
 * the next row —, Enter / ⇧Enter after a row click act as on the canvas (live: the row keeps no key focus of its
 * own; the shortcut layer forwards them to the engine — children, vector or text edit, parent), the lock and eye
 * toggle on press and a drag
 * from one goes on over the rows it crosses, a chevron opens (⌥ opens every level), "Collapse layers" (⌥L) closes
 * all but the selection's branch, a drag reorders and reparents (Engine.moveNodes; the list scrolls near its
 * edges), and a canvas selection opens its ancestors and scrolls into view.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { IconButton, LayerRow, PanelSection, VirtualList, showToast, type IconName } from "@/ds";
import { useHover, useSelection } from "@/engine/hooks";
import type { Guid } from "@/engine/codec";
import { useEditor, type EditorController } from "../controller";
import { writeOn } from "../components";
import { command, shortcutOf } from "../commands";
import { parseDerivedId } from "../model/components";
import { useLayerTree, useUI } from "../hooks";
import {
  ancestorsOf,
  collapsedLayers,
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
  type LayerTree,
  type TreeNode,
} from "../model/layerTree";
import styles from "./Panels.module.css";

/** The live capture's pitch (rows 32 apart, a 24 highlight). */
const ROW = 32;
/** Live: a level of nesting moves a row's glyph and name 24; a top-level row's name starts 52 from the panel's edge, its highlight 8 from either edge. */
const INDENT = 24;
const NAME_LEFT = 52;
const INSET = 8;
/** A selection revealed in the list scrolls it sideways when less of its name than this would show. */
const NAME_MIN = 96;
/** How near the list's top or bottom edge a drag scrolls it, and how far per frame. */
const EDGE = 24;
const EDGE_STEP = 8;

/** The row's glyph: the layer's type (its real one, even when the engine can't draw it yet), auto layout's direction, groups, masks, slots, images. */
export function layerIcon(node: TreeNode): IconName {
  if (node.mask) return "16.mask";
  if (node.group) return "16.group";
  if (node.stateGroup) return "16.component.set";
  switch (node.type) {
    case "FRAME":
      if (node.slot) return "16.slot";
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
    case "RECTANGLE":
    case "ROUNDED_RECTANGLE":
      // A rectangle filled with an image or a video reads as one (Figma's Image / Animated GIF or video glyphs).
      if (node.media === "VIDEO") return "16.play";
      if (node.media === "IMAGE") return "16.image";
      return "16.rectangle";
    default:
      return "16.rectangle";
  }
}

/**
 * A row glyph's name, as live Figma reads it out (left/layers-row-hover.txt: img [Frame], [Auto layout], [Component],
 * [Variant], [Instance], [Text], [Section], [Group], [Rectangle], [Union], [Ellipse], [Vector], [Line], [Star], [Polygon]
 * — an arrow is a Line, a component set a Component; Mask, Slot, Image and Video unverified).
 */
export function layerKind(node: TreeNode, parent?: TreeNode | null): string {
  if (node.mask) return "Mask";
  if (node.group) return "Group";
  if (node.stateGroup) return "Component";
  switch (node.type) {
    case "FRAME":
      if (node.slot) return "Slot";
      return node.stackMode && node.stackMode !== "NONE" ? "Auto layout" : "Frame";
    case "SECTION":
      return "Section";
    case "ELLIPSE":
      return "Ellipse";
    case "TEXT":
      return "Text";
    case "LINE":
      return "Line";
    case "VECTOR":
      return "Vector";
    case "STAR":
      return "Star";
    case "REGULAR_POLYGON":
      return "Polygon";
    case "BOOLEAN_OPERATION":
      return ({ SUBTRACT: "Subtract", INTERSECT: "Intersect", XOR: "Exclude" } as Record<string, string>)[node.booleanOperation ?? ""] ?? "Union";
    case "SYMBOL":
      return parent?.stateGroup ? "Variant" : "Component";
    case "INSTANCE":
      return "Instance";
    default:
      if (node.media === "VIDEO") return "Video";
      if (node.media === "IMAGE") return "Image";
      return "Rectangle";
  }
}

/** In the component purple: a component, a set or an instance — the outline knows (no details read for the rows between). */
const isComponentish = (n: { type: string; stateGroup?: boolean } | undefined) => !!n && (n.type === "SYMBOL" || n.type === "INSTANCE" || n.stateGroup === true);

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

/** "Collapse layers" (⌥L, the Layers header): every expanded layer closes but the selection's ancestors (Figma). */
export function collapseLayers(ed: EditorController, tree: LayerTree = ed.getTree()): void {
  ed.ui.set((s) => ({ expanded: collapsedLayers(tree, ed.selection, s.expanded) }));
}

/** The list's scrolling element (the VirtualList's viewport). */
const viewport = () => document.querySelector<HTMLElement>('[data-layer-list] [data-ds="VirtualList"]')?.parentElement ?? null;

/** A lock / eye drag: the value the first row got, the rows done, the open undo step. */
type CellDrag = { kind: "lock" | "visible"; value: boolean; done: Set<Guid> };

export function Layers() {
  const ed = useEditor();
  const tree = useLayerTree();
  const expanded = useUI((s) => s.expanded);
  const renaming = useUI((s) => (s.renaming?.kind === "layer" ? s.renaming.id : null));
  const highlight = useUI((s) => s.highlightOnHover !== false);
  const selection = useSelection(ed.store).refs;
  const hover = useHover(ed.store);
  const [drop, setDrop] = useState<DropTarget | null>(null);
  const press = useRef<{ id: Guid; x: number; y: number; dragging: Guid[] | null; deferred: boolean } | null>(null);
  const cellDrag = useRef<CellDrag | null>(null);

  const rows = useMemo(() => visibleRows(tree, expanded), [tree, expanded]);
  const selected = useMemo(() => new Set(selection), [selection]);
  const insideSelected = useMemo(() => {
    const out = new Set<Guid>();
    for (const r of rows) if (!selected.has(r.id) && ancestorsOf(tree, r.id).some((a) => selected.has(a))) out.add(r.id);
    return out;
  }, [rows, selected, tree]);
  const runs = useMemo(() => selectionRuns(rows, (id) => selected.has(id) || insideSelected.has(id)), [rows, selected, insideSelected]);
  // Rows in a component, a set or an instance (or one itself): their lock and eye in the component purple (Figma).
  const componentRows = useMemo(() => {
    const out = new Set<Guid>();
    for (const r of rows) {
      const own = tree.nodes.get(r.id);
      if (isComponentish(own) || ancestorsOf(tree, r.id).some((a) => isComponentish(tree.nodes.get(a)))) out.add(r.id);
    }
    return out;
  }, [rows, tree]);
  const anyExpanded = rows.some((r) => r.expanded);
  // The rows are as wide as the list plus the deepest row's indent (live: 263 wide in a 240 panel with one level
  // open), so every row's name has a top-level row's room and a deep tree scrolls sideways.
  const deepest = rows.reduce((d, r) => Math.max(d, r.depth), 0);

  // A selection made on the canvas opens its ancestors (Figma reveals it) and scrolls to it.
  useEffect(() => {
    const now = ed.ui.get().expanded;
    const next = revealed(tree, selection, now);
    if (next !== now) ed.ui.set({ expanded: next });
  }, [ed, tree, selection]);
  const firstSelected = rows.findIndex((r) => selected.has(r.id));
  const firstSelectedDepth = firstSelected >= 0 ? rows[firstSelected].depth : -1;
  // …and sideways, when the list doesn't show enough of its name: scrolled by the row's indent it reads as a top-level row.
  useEffect(() => {
    const v = viewport();
    if (!v || firstSelectedDepth < 0) return;
    const want = firstSelectedDepth * INDENT;
    const room = v.scrollLeft + v.clientWidth - INSET - (NAME_LEFT + want);
    if (v.scrollLeft > want || room < NAME_MIN) v.scrollLeft = want;
  }, [firstSelected, firstSelectedDepth]);

  const select = (refs: Guid[]) => ed.engine.setSelection(selectable(ed, refs));

  /** Near the list's top or bottom edge a drag scrolls it (one step per pointer move). */
  const autoScroll = (y: number) => {
    const v = viewport();
    if (!v) return;
    const r = v.getBoundingClientRect();
    if (y < r.top + EDGE) v.scrollTop -= EDGE_STEP;
    else if (y > r.bottom - EDGE) v.scrollTop += EDGE_STEP;
  };

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
      autoScroll(ev.clientY);
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

  /** One row's lock or eye set to `value` (inside the drag's open undo step). */
  const setCell = (kind: "lock" | "visible", id: Guid, value: boolean) => {
    const node = tree.nodes.get(id);
    if (!node) return;
    if (kind === "lock") {
      if (node.derived || node.locked === value) return;
      ed.engine.setProps([id], { locked: value });
    } else {
      const visible = !value;
      if (node.visible === visible) return;
      if (node.derived) writeOn(ed, id, { visible });
      else ed.engine.setProps([id], { visible });
    }
  };

  /**
   * The lock or the eye pressed: that row toggles, and while the button is held every row the pointer crosses gets
   * the same value (Figma: "click on the lock or eye and drag across the layers") — one undo step.
   */
  const startCellDrag = (kind: "lock" | "visible", id: Guid) => {
    const node = tree.nodes.get(id);
    if (!node) return;
    const value = kind === "lock" ? !node.locked : node.visible; // the new "on" value (locked / hidden)
    const label = kind === "lock" ? (value ? "Lock" : "Unlock") : value ? "Hide" : "Show";
    ed.engine.txnBegin(label);
    const drag: CellDrag = { kind, value, done: new Set([id]) };
    cellDrag.current = drag;
    setCell(kind, id, value);
    const move = (ev: PointerEvent) => {
      autoScroll(ev.clientY);
      const el = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>('[data-ds="LayerRow"]');
      const at = el?.dataset.id;
      if (!at || drag.done.has(at)) return;
      drag.done.add(at);
      setCell(kind, at, value);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      cellDrag.current = null;
      ed.engine.txnCommit();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
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

  const collapse = command("view.collapse-layers");
  return (
    <PanelSection
      className={styles.layers}
      title="Layers"
      pad="none"
      actions={anyExpanded ? <IconButton icon="24.collapse-layers.small" label={collapse.label} shortcut={shortcutOf(collapse)} tone="secondary" data-collapse-layers="" onClick={() => collapseLayers(ed, tree)} /> : undefined}
    >
      <div
        className={styles.layerList}
        role="tree"
        aria-label="Layers"
        aria-multiselectable
        data-layer-list=""
        style={{ ["--layers-depth" as string]: deepest }}
        onPointerLeave={() => {
          if (!press.current) ed.engine.setHover([]);
        }}
      >
        <VirtualList
          count={rows.length}
          rowHeight={ROW}
          axis="both"
          // How far the list is scrolled sideways, for the names' fade at its visible edge (CSS only: no render).
          onScroll={(e) => e.currentTarget.style.setProperty("--layers-scroll-x", `${e.currentTarget.scrollLeft}px`)}
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
                iconLabel={layerKind(node, node.parent ? tree.nodes.get(node.parent) : null)}
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
                  if (!press.current && !cellDrag.current && highlight) ed.engine.setHover(selectable(ed, [row.id]));
                }}
                onDoubleClick={() => ed.ui.set({ renaming: { kind: "layer", id: row.id } })}
                onContextMenu={(e) => {
                  e.preventDefault();
                  if (!selected.has(row.id)) select([row.id]);
                  ed.ui.set({ contextMenu: { x: e.clientX, y: e.clientY, canvas: null } });
                }}
                onToggleExpand={(alt) => toggleExpand(row.id, alt)}
                onToggleLock={node.derived ? undefined : () => startCellDrag("lock", row.id)}
                onToggleVisible={() => startCellDrag("visible", row.id)}
                onRename={(name, exit) => rename(row.id, name, exit)}
              />
            );
          }}
        />
      </div>
    </PanelSection>
  );
}
