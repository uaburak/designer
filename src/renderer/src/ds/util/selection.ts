import { useCallback, useMemo, useState } from "react";
import { IS_MAC } from "./keys";

/**
 * Multi-selection over an ordered list of ids, as Figma's file browser and
 * layer list do it: a click selects one; ⌘-click (Ctrl elsewhere) toggles;
 * ⇧-click selects the range from the anchor (added to the selection when ⌘
 * is held too). The anchor is the last item clicked without ⇧.
 */
export type SelectionState = { selected: string[]; anchor: string | null };
export type SelectionModifiers = { shift?: boolean; toggle?: boolean };

/** ⌘ on a Mac, Ctrl elsewhere — the "toggle this one" modifier. */
export function isToggleModifier(e: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return IS_MAC ? e.metaKey : e.ctrlKey;
}

/** The modifiers of a click or key event. */
export function selectionModifiers(e: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }): SelectionModifiers {
  return { shift: e.shiftKey, toggle: isToggleModifier(e) };
}

function range(order: readonly string[], a: string, b: string): string[] {
  const i = order.indexOf(a);
  const j = order.indexOf(b);
  if (i < 0 || j < 0) return [b];
  return order.slice(Math.min(i, j), Math.max(i, j) + 1);
}

/** Keeps `ids` in list order, without duplicates or ids that are no longer listed. */
export function inOrder(order: readonly string[], ids: Iterable<string>): string[] {
  const set = new Set(ids);
  return order.filter((id) => set.has(id));
}

/** The selection after a click on `id`. */
export function clickSelection(order: readonly string[], state: SelectionState, id: string, mods: SelectionModifiers = {}): SelectionState {
  if (mods.shift && state.anchor !== null && order.includes(state.anchor)) {
    const span = range(order, state.anchor, id);
    return { selected: inOrder(order, mods.toggle ? [...state.selected, ...span] : span), anchor: state.anchor };
  }
  if (mods.toggle) {
    const has = state.selected.includes(id);
    return { selected: inOrder(order, has ? state.selected.filter((s) => s !== id) : [...state.selected, id]), anchor: id };
  }
  return { selected: [id], anchor: id };
}

/** The selection after the keyboard moved focus to `id` (arrows): plain moves select it, ⇧ extends from the anchor. */
export function moveSelection(order: readonly string[], state: SelectionState, id: string, extend: boolean): SelectionState {
  if (extend) return clickSelection(order, state, id, { shift: true });
  return { selected: [id], anchor: id };
}

/** The ids whose boxes meet a rectangle (marquee selection). */
export function idsInRect(items: readonly { id: string; rect: { left: number; top: number; right: number; bottom: number } }[], r: { left: number; top: number; right: number; bottom: number }): string[] {
  return items.filter(({ rect }) => rect.left < r.right && rect.right > r.left && rect.top < r.bottom && rect.bottom > r.top).map((i) => i.id);
}

/**
 * Selection state for a list or grid of ids. `select(id, event)` applies a
 * click (with its modifiers); `extendTo(id, extend)` follows the arrow keys.
 * Ids that leave `order` drop out of the selection.
 */
export function useSelection(order: readonly string[], initial: string[] = []) {
  const [state, setState] = useState<SelectionState>({ selected: initial, anchor: initial[initial.length - 1] ?? null });
  const selected = useMemo(() => inOrder(order, state.selected), [order, state.selected]);
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const select = useCallback((id: string, e?: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }) => setState((s) => clickSelection(order, s, id, e ? selectionModifiers(e) : {})), [order]);
  const extendTo = useCallback((id: string, extend: boolean) => setState((s) => moveSelection(order, s, id, extend)), [order]);
  const selectAll = useCallback(() => setState((s) => ({ selected: [...order], anchor: s.anchor ?? order[0] ?? null })), [order]);
  const clear = useCallback(() => setState({ selected: [], anchor: null }), []);
  const set = useCallback((ids: string[], anchor?: string | null) => setState((s) => ({ selected: inOrder(order, ids), anchor: anchor === undefined ? s.anchor : anchor })), [order]);
  return { selected, isSelected: (id: string) => selectedSet.has(id), anchor: state.anchor, select, extendTo, selectAll, clear, set };
}
