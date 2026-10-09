/**
 * "Multi-edit variants" (the component set's and a variant's header, live design/component-set.txt, variant.txt; help
 * "Edit multiple variants at once", unverified in detail): on for a set (this session), selecting one layer inside one
 * of its variants selects the same layer in every variant — matched by its path of names from the variant (the n-th
 * of that name among its siblings) — so one edit reaches them all.
 */
import { useEffect, useSyncExternalStore } from "react";
import type { Guid } from "@/engine/codec";
import type { EditorController } from "../../controller";
import { useEditor } from "../../controller";
import { useTopics } from "../../hooks";
import { isComponent, isComponentSet, type CNode } from "../../model/components";
import { readC } from "../../components";

const sets = new Set<Guid>();
const listeners = new Set<() => void>();
let version = 0;

export function isMultiEdit(set: Guid | null | undefined): boolean {
  return !!set && sets.has(set);
}

export function setMultiEdit(set: Guid, on: boolean): void {
  if (on === sets.has(set)) return;
  if (on) sets.add(set);
  else sets.delete(set);
  version++;
  for (const l of listeners) l();
}

/** Is multi-edit on for this set (re-renders on a toggle)? */
export function useMultiEdit(set: Guid | null | undefined): boolean {
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => version
  );
  return isMultiEdit(set);
}

type Step = { name: string; nth: number };

const kids = (ed: EditorController, id: Guid): CNode[] => {
  const n = ed.engine.readNodes([id], { childIds: true })[0];
  return (n?.childIds ?? []).map((c) => readC(ed, c)).filter((c): c is CNode => !!c);
};

/**
 * The same layer in the other variants of a multi-edited set (with the layer itself first), or null when the layer
 * isn't inside a variant of one.
 */
export function matchingInVariants(ed: EditorController, layer: Guid): Guid[] | null {
  const path: Step[] = [];
  let n = readC(ed, layer);
  while (n) {
    const parent = n.parentIndex?.guid ? readC(ed, n.parentIndex.guid) : null;
    if (!parent) return null;
    if (isComponent(n) && isComponentSet(parent)) {
      if (!path.length || !isMultiEdit(parent.guid)) return null;
      const out = [layer];
      for (const variant of kids(ed, parent.guid)) {
        if (variant.guid === n.guid || !isComponent(variant)) continue;
        let at: CNode | undefined = variant;
        for (const step of path) {
          at = at ? kids(ed, at.guid).filter((c) => c.name === step.name)[step.nth] : undefined;
          if (!at) break;
        }
        if (at) out.push(at.guid);
      }
      return out;
    }
    const nth = kids(ed, parent.guid)
      .filter((c) => c.name === n?.name)
      .findIndex((c) => c.guid === n?.guid);
    path.unshift({ name: n.name ?? "", nth: Math.max(0, nth) });
    n = parent;
  }
  return null;
}

/** Extends a one-layer selection inside a multi-edited set's variant to the same layer in every variant. */
export function useMultiEditVariants(): void {
  const ed = useEditor();
  useTopics(ed.store, ["selection"]);
  const selection = ed.selection;
  const one = selection.length === 1 ? selection[0] : null;
  useEffect(() => {
    if (!one || !sets.size) return;
    const match = matchingInVariants(ed, one);
    if (match && match.length > 1) ed.engine.setSelection(match);
  }, [ed, one]);
}
