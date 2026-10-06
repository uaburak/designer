import type { DesignVariable, TextStyle, VariableKind } from "@/types/design";
import type { DeletedComponent } from "@/lib/firestore";
import { STARTING_VARIABLES, withStartingVariables } from "@/components/project/designVariables";
import { STARTING_TEXT_STYLES, newTextStyle, withStartingTextStyles } from "@/components/project/textStyles";
import { findNode, freeName, libraryOf, nid, removeNodes, type FigmaDocument, type SceneNode } from "./model";
import { componentIds, frozenValues, keptTombstones, tombstoneOf, withDetached, withoutTextStyles, withoutVariables } from "./systemLibrary";

/**
 * What the editor edits, all of it in memory until Save: the file (the
 * project's own, the site's library in it — see systemLibrary.ts) and the
 * site's design system — its variables and text styles (as stored: the
 * starting ones are added over them), and what was deleted of it (kept for
 * the projects still using it). One undo step is a change of any of it.
 */
export interface EditState {
  file: FigmaDocument;
  variables: DesignVariable[];
  deletedVariables: DesignVariable[];
  textStyles: TextStyle[];
  deletedTextStyles: TextStyle[];
  deletedComponents: DeletedComponent[];
}

/** The site's design system as the editor's panels change it (see designSystemOf). */
export interface DesignSystem {
  /** All of the variables, the starting ones included (see DesignVariable) */
  variables: DesignVariable[];
  /** One of the starting variables: it can only go back to its value, not be deleted */
  isStartingVariable: (id: string) => boolean;
  setVariable: (variable: DesignVariable) => void;
  /** Adds a variable of that kind (in `collection`); returns its id */
  addVariable: (kind: VariableKind, collection?: string) => string;
  /** Deletes an added variable — what is bound to it keeps its value, as its own; a starting one goes back to its value */
  removeVariable: (id: string) => void;
  /** All of the text styles, the starting ones included (see TextStyle) */
  textStyles: TextStyle[];
  isStartingTextStyle: (id: string) => boolean;
  setTextStyle: (style: TextStyle) => void;
  /** Adds a text style; returns its id */
  addTextStyle: () => string;
  /** Deletes an added text style — its texts keep its typography, as their own; a starting one goes back to its look */
  removeTextStyle: (id: string) => void;
  /** Deletes a component (or a set) from the library — its instances, everywhere, become frames of their own */
  deleteComponent: (id: string) => void;
}

/** `entry` in the place of the one with its id — at the end when there is none. */
function upsert<T extends { id: string }>(list: T[], entry: T): T[] {
  return list.some((e) => e.id === entry.id) ? list.map((e) => (e.id === entry.id ? entry : e)) : [...list, entry];
}

const NEW_VARIABLE: Record<VariableKind, { name: string; value: string | number }> = {
  color: { name: "Color", value: "#000000" },
  number: { name: "Number", value: 16 },
  weight: { name: "Weight", value: 400 },
};

const isStartingVariable = (id: string) => STARTING_VARIABLES.some((v) => v.id === id);
const isStartingTextStyle = (id: string) => STARTING_TEXT_STYLES.some((s) => s.id === id);

/** Every page's nodes of the file through `fix` (the library's page too). */
function withNodes(file: FigmaDocument, fix: (nodes: SceneNode[]) => SceneNode[]): FigmaDocument {
  const nodes = fix(file.nodes);
  const pages = file.pages?.map((p) => {
    const next = fix(p.nodes);
    return next === p.nodes ? p : { ...p, nodes: next };
  });
  const same = nodes === file.nodes && (pages ?? []).every((p, i) => p === file.pages![i]);
  return same ? file : { ...file, nodes, pages };
}

/** The design system's operations on the edit state, through `update` (one undo step each). */
export function designSystemOf(state: EditState, update: (change: (state: EditState) => EditState) => void): DesignSystem {
  const variables = withStartingVariables(state.variables);
  const textStyles = withStartingTextStyles(state.textStyles);
  return {
    variables,
    isStartingVariable,
    setVariable: (variable) => update((s) => ({ ...s, variables: upsert(s.variables, variable) })),
    addVariable: (kind, collection) => {
      const id = nid("v");
      update((s) => {
        const all = withStartingVariables(s.variables);
        return { ...s, variables: [...s.variables, { id, name: freeName(NEW_VARIABLE[kind].name, all), kind, light: { value: NEW_VARIABLE[kind].value }, ...(collection ? { collection } : {}) }] };
      });
      return id;
    },
    removeVariable: (id) =>
      update((s) => {
        // A starting one: back to its value (its own stays bound).
        if (isStartingVariable(id)) return { ...s, variables: s.variables.filter((v) => v.id !== id) };
        const gone = s.variables.find((v) => v.id === id);
        if (!gone) return s;
        const frozen = frozenValues([gone], withStartingVariables(s.variables));
        return {
          ...s,
          file: withoutVariables(s.file, frozen),
          variables: withoutVariables(s.variables.filter((v) => v.id !== id), frozen),
          textStyles: withoutVariables(s.textStyles, frozen),
          deletedVariables: keptTombstones(s.deletedVariables, [gone]),
        };
      }),
    textStyles,
    isStartingTextStyle,
    setTextStyle: (style) => update((s) => ({ ...s, textStyles: upsert(s.textStyles, style) })),
    addTextStyle: () => {
      const id = nid("ts");
      update((s) => ({ ...s, textStyles: [...s.textStyles, newTextStyle(id, freeName("Text style", withStartingTextStyles(s.textStyles)))] }));
      return id;
    },
    removeTextStyle: (id) =>
      update((s) => {
        if (isStartingTextStyle(id)) return { ...s, textStyles: s.textStyles.filter((t) => t.id !== id) };
        const gone = withStartingTextStyles(s.textStyles).find((t) => t.id === id);
        if (!gone) return s;
        return {
          ...s,
          file: withNodes(s.file, (nodes) => withoutTextStyles(nodes, new Map([[id, gone]]))),
          textStyles: s.textStyles.filter((t) => t.id !== id),
          deletedTextStyles: keptTombstones(s.deletedTextStyles, [gone]),
        };
      }),
    deleteComponent: (id) =>
      update((s) => {
        const lib = libraryOf(s.file);
        const holder = findNode(lib, id)?.node;
        if (!holder) return s;
        const ids = new Set(componentIds(holder));
        // Its instances — on the project's pages, inside the library's other components — drawn as frames of their own, then it goes.
        const detached = withNodes(s.file, (nodes) => withDetached(nodes, ids, lib));
        const removed = withNodes(detached, (nodes) => (findNode(nodes, id) ? removeNodes(nodes, new Set([id])) : nodes));
        return { ...s, file: removed, deletedComponents: keptTombstones(s.deletedComponents, [tombstoneOf(holder)]) };
      }),
  };
}
