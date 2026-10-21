/**
 * Selecting Fill / Stroke / Effect rows in the Design panel and what acts on them, as Figma (live 2026-10-19,
 * docs/research/figma/live/2026-10-18/property-rows-copy.txt; the pure part is model/propertyRows.ts):
 *
 * - A click on a row's empty part (not its swatch, field, eye or minus) selects the row, ⇧ a range; rows of one
 *   section at a time; the layer selection stays. Selecting other layers, or a press on the canvas, clears them; Esc
 *   is Esc (it deselects the layer, and the rows with it).
 * - Delete / Backspace removes the selected items from every selected layer, one undo step.
 * - ⌘C writes Figma's STYLE_PROPERTIES_* clipboard Message (⌘X: that, then Delete — unverified in Figma); without a
 *   selected row ⌘C copies the layers as before.
 * - ⌘V of such a clipboard: nothing selected, nothing; else the items on top of each selected layer's list (a group:
 *   its layers, for fills and strokes, as the panel shows them) — directly above the selected row of that section,
 *   whose place the pasted rows then take; layers whose lists differ (the panel's Mixed) get nothing. One undo step.
 */
import type { MouseEvent as ReactMouseEvent } from "react";
import { useEditor, type EditorController } from "./controller";
import { useUI } from "./hooks";
import type { Guid, NodeChange } from "@/engine/codec";
import { encodeMessage } from "../../../shared/schema/codec";
import { encodeClipboardKiwi } from "./model/clipboard";
import { inOverlay, isEditable, presentationHasKeys } from "./keyboard";
import { clickRow, insertRows, ROW_FIELD, rowsMessage, sameLists, withoutRows, type PropertyRows, type RowItem, type RowSection } from "./model/propertyRows";
import { firstStrokeFields } from "./panels/design/Stroke";
import { fields, isGroupNode, type PanelNode } from "./panels/design/shared";

const LABEL: Record<RowSection, { remove: string; paste: string }> = {
  fill: { remove: "Remove fill", paste: "Paste fill" },
  stroke: { remove: "Remove stroke", paste: "Paste stroke" },
  effect: { remove: "Remove effect", paste: "Paste effect" },
};

/** The rows selected now, or null. */
export const selectedRows = (ed: EditorController): PropertyRows | null => ed.ui.get().propertyRows ?? null;

export function clearRows(ed: EditorController): void {
  if (ed.ui.get().propertyRows) ed.ui.set({ propertyRows: null });
}

/**
 * The layers a section's items belong to: the selection — for fills and strokes with every group replaced by its
 * layers (nested groups too), as the panel's Fill and Stroke show them (`usePaintTargets`).
 */
export function rowTargets(ed: EditorController, section: RowSection): NodeChange[] {
  const nodes = ed.selectedNodes().map(ed.withRealType);
  if (section === "effect" || !nodes.some((n) => isGroupNode(n as PanelNode))) return nodes;
  const out: NodeChange[] = [];
  const expand = (n: NodeChange, depth: number) => {
    if (!isGroupNode(n as PanelNode) || depth > 64) return void out.push(n);
    const children = (ed.engine.readNodes([n.guid], { childIds: true })[0]?.childIds ?? []) as Guid[];
    for (const c of ed.engine.readNodes(children)) expand(ed.withRealType(c), depth + 1);
  };
  for (const n of nodes) expand(n, 0);
  return out;
}

const listOf = (n: NodeChange, section: RowSection): RowItem[] => [...(((n as unknown as Record<string, unknown>)[ROW_FIELD[section]] as RowItem[] | undefined) ?? [])];

/** The selected rows' items, bottom first (the list's order), with the section; null when no row is selected. */
function copiedItems(ed: EditorController): { section: RowSection; items: RowItem[] } | null {
  const rows = selectedRows(ed);
  const [first] = rows ? rowTargets(ed, rows.section) : [];
  if (!rows || !first) return null;
  const list = listOf(first, rows.section);
  const items = rows.rows.filter((i) => i < list.length).map((i) => list[i]);
  return items.length ? { section: rows.section, items } : null;
}

/** ⌘C on rows: the clipboard's formats (Figma's STYLE_PROPERTIES_* Message in the fig-kiwi archive), or null with no row selected. */
export function rowsClipboardFormats(ed: EditorController): Record<string, string> | null {
  const copied = copiedItems(ed);
  if (!copied) return null;
  const fileKey = ed.source.libraries?.libraryKey ?? null;
  const message = rowsMessage(copied.section, copied.items, { layers: ed.selection, page: ed.store.page ?? null, fileKey });
  // No layer names as text: the temporary rectangle isn't a layer of the file.
  return encodeClipboardKiwi(encodeMessage(message), { fileKey, pasteID: message.pasteID, plain: "" });
}

/** Delete / Backspace with rows selected: those items go from every selected layer (one undo step); false when none is selected. */
export function deleteRows(ed: EditorController): boolean {
  const rows = selectedRows(ed);
  if (!rows) return false;
  const targets = rowTargets(ed, rows.section);
  ed.ui.set({ propertyRows: null });
  if (!targets.length) return true;
  ed.batch(LABEL[rows.section].remove, () => {
    for (const n of targets) ed.engine.setProps([n.guid], fields({ [ROW_FIELD[rows.section]]: withoutRows(listOf(n, rows.section), rows.rows) } as never));
  });
  return true;
}

/**
 * ⌘V of copied rows: the items onto the selected layers (see the file's comment). Returns whether anything was added.
 */
export function pasteRows(ed: EditorController, section: RowSection, items: readonly RowItem[]): boolean {
  if (!ed.selection.length || !items.length) return false;
  const targets = rowTargets(ed, section);
  if (!targets.length) return false;
  const lists = targets.map((n) => listOf(n, section));
  if (!sameLists(lists)) return false;
  const field = ROW_FIELD[section];
  const current = selectedRows(ed);
  const above = current?.section === section && current.rows.length ? Math.max(...current.rows) : undefined;
  let added: number[] = [];
  ed.batch(LABEL[section].paste, () => {
    targets.forEach((n, k) => {
      const next = insertRows(lists[k], items.map((x) => ({ ...x })), above !== undefined && above < lists[k].length ? above : undefined);
      added = next.rows;
      // A layer's first stroke gets a weight (and Inside on a closed shape), as "+" gives it.
      const stroke = section === "stroke" && !lists[k].length ? firstStrokeFields(n as PanelNode, n.strokeWeight || 1) : {};
      ed.engine.setProps([n.guid], fields({ [field]: next.list, ...stroke } as never));
    });
  });
  // Above a selected row, the pasted rows become the selection; on top, none is selected (live).
  if (above !== undefined) {
    const count = lists[0].length + items.length;
    ed.ui.set({ propertyRows: { section, rows: added, anchor: count - 1 - Math.max(...added) } });
  } else clearRows(ed);
  return true;
}

/**
 * Clears the rows when the layer selection changes or the canvas is pressed; Delete / Backspace with rows selected
 * removes them — before the canvas or the shortcuts see the key, which would delete the layer.
 */
export function attachPropertyRows(ed: EditorController, canvas: HTMLElement): () => void {
  const key = (e: KeyboardEvent) => {
    if ((e.key !== "Backspace" && e.key !== "Delete") || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.isComposing) return;
    if (isEditable(e.target) || inOverlay(e.target) || presentationHasKeys(ed, e.target) || !deleteRows(ed)) return;
    e.preventDefault();
    e.stopPropagation();
  };
  window.addEventListener("keydown", key, true);
  let refs = ed.store.selection.refs.join(",");
  const offSelection = ed.store.subscribe("selection", () => {
    const next = ed.store.selection.refs.join(",");
    if (next === refs) return;
    refs = next;
    clearRows(ed);
  });
  const down = () => clearRows(ed);
  canvas.addEventListener("pointerdown", down);
  return () => {
    offSelection();
    canvas.removeEventListener("pointerdown", down);
    window.removeEventListener("keydown", key, true);
  };
}

/** What a press on a row hits that is the row's own control (swatch, field, eye, minus, grip): it doesn't select. */
const CONTROL = "button, input, textarea, select, a[href], [role='button'], [role='slider'], [contenteditable], [data-reorder-grip]";

/**
 * A section's row selection for its rows (`count`, display index d is item count − 1 − d): whether an item's row is
 * selected, and the props a row takes — role row, aria-selected, the click that selects it.
 */
export function useRowSelection(section: RowSection, count: number) {
  const ed = useEditor();
  const rows = useUI((s) => s.propertyRows);
  const mine = rows?.section === section ? rows.rows : null;
  return {
    isSelected: (item: number) => !!mine?.includes(item),
    rowProps: (display: number) => ({
      role: "row",
      tabIndex: -1,
      "aria-selected": !!mine?.includes(count - 1 - display),
      onClick: (e: ReactMouseEvent<HTMLElement>) => {
        if (e.button !== 0 || (e.target instanceof Element && e.target.closest(CONTROL))) return;
        ed.ui.set({ propertyRows: clickRow(ed.ui.get().propertyRows, section, display, count, e.shiftKey) });
        // The keys (Delete, ⌘C, ⌘V) go to the panel now, not to a field or the canvas.
        e.currentTarget.focus({ preventScroll: true });
      },
    }),
  };
}
