/**
 * Variables, modes and styles in the editor (docs/editor.md "Variables and
 * styles"): the file's local collections, variables and styles (the internal
 * canvas `0:2`'s children, re-read after a change touches them), and every
 * action the Local variables window, the Design panel and the menus share —
 * Figma's (docs/research/figma/R3-variables.md).
 *
 * Each action runs the engine's command once abi.ts names it (the names
 * docs/engine-build.md publishes, `VARIABLE_COMMAND`); until then it writes
 * the schema's fields itself (docs/schema.md §6): VARIABLE_SET / VARIABLE /
 * style nodes created and removed under the internal canvas with
 * `applyChanges`, values with the generic setter — one undo step each. The
 * engine keeps those fields (round-trips since E3) but doesn't resolve them
 * yet, so the fallback also writes every binding's resolved copy (the bound
 * field, a paint's colour, a styled layer's fields) in the same step, and
 * again after any change a value, a mode or a style depends on.
 */
import { showToast } from "@/ds";
import { Status } from "@/engine/abi";
import type { Color, Guid, Message, NodeChange, NodeFields, Paint } from "@/engine/codec";
import type { EditorController } from "./controller";
import { engineMethod, hasCommand, runEngineCommand, type CommandArgs } from "./engineCompat";
import { sameData } from "./model/mixed";
import {
  aliasMakesCycle,
  boundPaint,
  byPosition,
  cleanName,
  detachedPaint,
  explicitModes,
  guidStr,
  guidVal,
  isCollectionNode,
  isVariableNode,
  LIMITS,
  modeAt,
  nextModeName,
  nextName,
  paintVariable,
  positionAfter,
  positionBetween,
  readCollection,
  readVariable,
  renameGroupIn,
  resolveVariable,
  resolvedFields,
  splitName,
  toData,
  VAR_TYPE_LABEL,
  variableBindings,
  withExplicitMode,
  withValue,
  withVariableBinding,
  type Collection,
  type Literal,
  type ModeEntry,
  type Variable,
  type VariableLookup,
  type VarType,
  type VarValue,
  type VNode,
} from "./model/variables";
import { applyStyleFields, isStyleNode, readStyle, STYLE_KIND_SINGULAR, STYLE_NODE_TYPE, STYLE_SLOT, styleContent, styleFieldsFrom, styleIdOf, type Style, type StyleKind, type StyleNode, type StyleSlot } from "./model/styles";

/**
 * The engine's variable and style commands (docs/engine-build.md, "variables / modes / styles" — names checked
 * there midway and at the end of the round); each one runs only once abi.ts names it.
 */
export const VARIABLE_COMMAND = {
  createCollection: "CREATE_VARIABLE_COLLECTION",
  renameCollection: "RENAME_VARIABLE_COLLECTION",
  deleteCollection: "DELETE_VARIABLE_COLLECTION",
  moveCollection: "MOVE_VARIABLE_COLLECTION",
  duplicateCollection: "DUPLICATE_VARIABLE_COLLECTION",
  addMode: "ADD_VARIABLE_MODE",
  renameMode: "RENAME_VARIABLE_MODE",
  deleteMode: "DELETE_VARIABLE_MODE",
  moveMode: "MOVE_VARIABLE_MODE",
  duplicateMode: "DUPLICATE_VARIABLE_MODE",
  createVariable: "CREATE_VARIABLE",
  renameVariable: "RENAME_VARIABLE",
  deleteVariables: "DELETE_VARIABLES",
  moveVariables: "MOVE_VARIABLES",
  duplicateVariables: "DUPLICATE_VARIABLES",
  setValue: "SET_VARIABLE_VALUE",
  setScopes: "SET_VARIABLE_SCOPES",
  setCodeSyntax: "SET_VARIABLE_CODE_SYNTAX",
  setDescription: "SET_VARIABLE_DESCRIPTION",
  setHidden: "SET_VARIABLE_HIDDEN",
  groupVariables: "GROUP_VARIABLES",
  renameGroup: "RENAME_VARIABLE_GROUP",
  ungroup: "UNGROUP_VARIABLES",
  deleteGroup: "DELETE_VARIABLE_GROUP",
  duplicateGroup: "DUPLICATE_VARIABLE_GROUP",
  bind: "BIND_VARIABLE",
  detach: "DETACH_VARIABLE",
  setMode: "SET_VARIABLE_MODE",
  createStyle: "CREATE_STYLE",
  deleteStyle: "DELETE_STYLE",
  applyStyle: "APPLY_STYLE",
  detachStyle: "DETACH_STYLE",
  moveStyle: "MOVE_STYLE",
  groupStyles: "GROUP_STYLES",
  renameStyleGroup: "RENAME_STYLE_GROUP",
  ungroupStyles: "UNGROUP_STYLES",
} as const;

const variableBuilds = new WeakMap<object, boolean>();

/**
 * Is the engine in hand its variables build? The facade's reads exist and the wasm answers them (a facade ahead of
 * its wasm throws: probed once, by reading the collections).
 */
export function engineHasVariables(ed: EditorController): boolean {
  let known = variableBuilds.get(ed.engine);
  if (known === undefined) {
    const read = engineMethod<() => unknown>(ed.engine, "variableCollections");
    try {
      known = !!read && !ed.engine.destroyed && Array.isArray(read());
    } catch {
      known = false;
    }
    variableBuilds.set(ed.engine, known);
  }
  return known;
}

/** Does the engine resolve bindings itself (its variables build)? Then the editor never writes resolved copies. */
export function engineResolves(ed: EditorController): boolean {
  return hasCommand(VARIABLE_COMMAND.bind) && engineHasVariables(ed);
}

/** Runs one of the engine's commands when the build has it: ran OK, and the ids it created (`engine.runCommand`). */
function engineRun(ed: EditorController, name: string, args?: CommandArgs): { ok: boolean; created: Guid[] } {
  if (!hasCommand(name) || !engineHasVariables(ed)) return { ok: false, created: [] };
  const run = engineMethod<(n: string, a?: CommandArgs) => { status: number; created?: Guid[] }>(ed.engine, "runCommand");
  if (run) {
    const r = run(name, args);
    return { ok: r.status === Status.OK, created: r.created ?? [] };
  }
  return { ok: runEngineCommand(ed.engine, name, args) === Status.OK, created: [] };
}

function engineDid(ed: EditorController, name: string, args?: CommandArgs): boolean {
  return engineRun(ed, name, args).ok;
}

/** A value as the engine's commands take it (Figma's plugin shapes: RGBA, {type: "VARIABLE_ALIAS", id}, …). */
const engineValue = (value: VarValue): unknown => (value.kind === "alias" ? { type: "VARIABLE_ALIAS", id: value.id } : value.value);

const asFields = (f: Record<string, unknown>): NodeFields => f as NodeFields;

// ---- The index ---------------------------------------------------------------------------------------------------

export interface LocalAssets {
  /** The internal canvas (null: the file has none yet) */
  internal: Guid | null;
  /** This file's own collections (library copies left out) */
  collections: Collection[];
  /** Every live variable of this file (soft-deleted ones and library copies left out), by collection then sortPosition */
  variables: Variable[];
  /** This file's own styles (library copies left out) */
  styles: Style[];
  /** Library copies used here (docs/schema.md §8.2): read-only, listed under their library */
  library: { collections: Collection[]; variables: Variable[]; styles: Style[] };
  /** Local and library variables / collections */
  lookup: VariableLookup;
  /** A local or library style */
  style(id: Guid): Style | undefined;
}

const EMPTY: LocalAssets = { internal: null, collections: [], variables: [], styles: [], library: { collections: [], variables: [], styles: [] }, lookup: { variable: () => undefined, collection: () => undefined }, style: () => undefined };

/** A library copy (its library's FileKey on the node). */
export const libraryOf = (x: { node: unknown }): string | null => ((x.node as { sourceLibraryKey?: string }).sourceLibraryKey ?? null) || null;

export class VariableIndex {
  private cache: { version: number; assets: LocalAssets } | null = null;
  private version = 0;
  private known = new Set<Guid>();
  private readonly offs: (() => void)[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(private readonly ed: EditorController) {
    const bump = () => {
      this.version++;
      this.listeners.forEach((l) => l());
    };
    this.offs.push(
      ed.engine.on("DOCUMENT_CHANGED", (e) => {
        const internal = this.cache?.assets.internal ?? null;
        const touches = e.message.nodeChanges.some((c) => {
          const f = c as unknown as Record<string, unknown>;
          return (
            this.known.has(c.guid) ||
            (internal !== null && c.parentIndex?.guid === internal) ||
            c.type === "VARIABLE" ||
            c.type === "VARIABLE_SET" ||
            "styleType" in f ||
            (c.type === "CANVAS" && f.internalOnly === true)
          );
        });
        if (touches) bump();
      }),
      ed.engine.onAny((e) => {
        if ((e as { type: string }).type === "VARIABLES_CHANGED" || (e as { type: string }).type === "STYLES_CHANGED") bump();
      })
    );
  }

  dispose(): void {
    this.offs.splice(0).forEach((off) => off());
    this.listeners.clear();
  }

  readonly subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  readonly getVersion = (): number => this.version;

  /** Forgets the cached read (a write inside an open step: DOCUMENT_CHANGED only comes at its commit). */
  invalidate(): void {
    this.cache = null;
  }

  /** Everything local, read again only after a change touched it. */
  get(): LocalAssets {
    if (this.cache?.version === this.version) return this.cache.assets;
    const assets = this.read();
    this.known = new Set([...(assets.internal ? [assets.internal] : []), ...assets.collections.map((c) => c.id), ...assets.variables.map((v) => v.id), ...assets.styles.map((s) => s.id)]);
    this.cache = { version: this.version, assets };
    return assets;
  }

  private read(): LocalAssets {
    const engine = this.ed.engine;
    if (engine.destroyed) return EMPTY;
    const internal = internalCanvasOf(this.ed);
    if (!internal) return EMPTY;
    const kids = engine.readNodes([internal], { childIds: true })[0]?.childIds ?? [];
    const nodes = kids.length ? (engine.readNodes(kids) as unknown as VNode[]) : [];
    const collections = nodes
      .filter((n) => isCollectionNode(n) && !n.isSoftDeleted)
      .map(readCollection)
      .sort(byPosition);
    const order = new Map(collections.map((c, i) => [c.id, i]));
    const variables = nodes
      .filter((n) => isVariableNode(n) && !n.isSoftDeleted)
      .map(readVariable)
      .filter((v) => order.has(v.collection))
      .sort((a, b) => order.get(a.collection)! - order.get(b.collection)! || byPosition(a, b));
    const styles = (nodes as unknown as StyleNode[])
      .filter((n) => isStyleNode(n) && !n.isSoftDeleted)
      .map(readStyle)
      .sort(byPosition);
    const byId = new Map(variables.map((v) => [v.id, v]));
    const cById = new Map(collections.map((c) => [c.id, c]));
    const sById = new Map(styles.map((s) => [s.id, s]));
    const own = <T extends { node: unknown }>(list: T[]) => list.filter((x) => !libraryOf(x));
    const copies = <T extends { node: unknown }>(list: T[]) => list.filter((x) => !!libraryOf(x));
    return {
      internal,
      collections: own(collections),
      variables: own(variables),
      styles: own(styles),
      library: { collections: copies(collections), variables: copies(variables), styles: copies(styles) },
      lookup: { variable: (id) => byId.get(id), collection: (id) => cById.get(id) },
      style: (id) => sById.get(id),
    };
  }
}

/** The internal canvas's id (the CANVAS with `internalOnly`), or null. */
export function internalCanvasOf(ed: EditorController): Guid | null {
  const doc = ed.engine.readNode("0:0", { childIds: true });
  const kids = doc?.childIds ?? [];
  if (!kids.length) return null;
  const found = ed.engine.readNodes(kids).find((n) => n.type === "CANVAS" && n.internalOnly === true);
  return found?.guid ?? null;
}

// ---- Node ids and structural writes (the fallback) ---------------------------------------------------------------

/** New nodes' local ids: a range of their own above the engine's (it allocates from the bottom, skipping taken ids). */
const NODE_ID_BASE = 0x40000000;
let nextLocal = NODE_ID_BASE;

/** A fresh node GUID in this session's editor range (library copies use it too). */
export const newNodeGuid = (ed: EditorController): Guid => newGuid(ed);

function newGuid(ed: EditorController): Guid {
  const session = ed.source.sessionID ?? 1;
  for (;;) {
    const id = `${session}:${nextLocal++}`;
    if (!ed.engine.readNode(id)) return id;
  }
}

/** Mode ids: GUIDs unique among the file's modes (not node ids), counted down from the top of the session's range. */
function newModeId(ed: EditorController, collections: readonly Collection[]): Guid {
  const session = ed.source.sessionID ?? 1;
  const used = new Set(collections.flatMap((c) => c.modes.map((m) => m.id)));
  for (let local = 0x7fefffff; ; local--) {
    const id = `${session}:${local}`;
    if (!used.has(id)) return id;
  }
}

function apply(ed: EditorController, changes: NodeChange[]): number {
  const message: Message = { type: "NODE_CHANGES", sessionID: ed.source.sessionID ?? 1, nodeChanges: changes };
  return ed.engine.applyChanges(message, "user");
}

/** The internal canvas, created (in the current step) when the file has none. */
export function ensureInternal(ed: EditorController): Guid {
  const found = internalCanvasOf(ed);
  if (found) return found;
  const id = newGuid(ed);
  apply(ed, [{ guid: id, phase: "CREATED", type: "CANVAS", name: "Internal Only Canvas", parentIndex: { guid: "0:0", position: "~" }, internalOnly: true, visible: false } as NodeChange]);
  return id;
}

const assets = (ed: EditorController) => ed.variables.get();
/** The index read again (after a write in the current step). */
const fresh = (ed: EditorController) => {
  ed.variables.invalidate();
  return ed.variables.get();
};

// ---- Collections ---------------------------------------------------------------------------------------------------

/** "Create collection": a collection named "Collection" (or "Collection 2"…) with "Mode 1". Returns its id. */
export function createCollection(ed: EditorController, name?: string): Guid | null {
  const a = assets(ed);
  const finalName = name ?? nextName("Collection", a.collections.map((c) => c.name));
  const run = engineRun(ed, VARIABLE_COMMAND.createCollection, { name: finalName });
  if (run.ok) return run.created[0] ?? assets(ed).collections.find((c) => c.name === finalName)?.id ?? null;
  let id: Guid | null = null;
  ed.batch("Create collection", () => {
    const internal = ensureInternal(ed);
    id = newGuid(ed);
    const mode = newModeId(ed, a.collections);
    apply(ed, [
      {
        guid: id,
        phase: "CREATED",
        type: "VARIABLE_SET",
        name: finalName,
        parentIndex: { guid: internal, position: positionAfter(childPositions(ed, internal)) },
        sortPosition: positionAfter(a.collections.map((c) => c.sortPosition)),
        variableSetModes: [{ id: guidVal(mode), name: "Mode 1", sortPosition: positionBetween("", null) }],
        visible: false,
      } as unknown as NodeChange,
    ]);
  });
  return id;
}

function childPositions(ed: EditorController, parent: Guid): string[] {
  const kids = ed.engine.readNodes([parent], { childIds: true })[0]?.childIds ?? [];
  return kids.length ? ed.engine.readNodes(kids).map((n) => n.parentIndex?.position ?? "") : [];
}

export function renameCollection(ed: EditorController, id: Guid, name: string): void {
  const clean = name.trim();
  if (!clean || assets(ed).lookup.collection(id)?.name === clean) return;
  if (engineDid(ed, VARIABLE_COMMAND.renameCollection, { collection: id, name: clean })) return;
  ed.setProps([id], asFields({ name: clean }), "Rename collection");
}

/** "Delete collection": the collection and its variables (bindings keep their last value). */
export function deleteCollection(ed: EditorController, id: Guid): void {
  if (engineDid(ed, VARIABLE_COMMAND.deleteCollection, { collection: id })) return;
  const a = assets(ed);
  const vars = a.variables.filter((v) => v.collection === id).map((v) => v.id);
  ed.batch("Delete collection", () => {
    apply(ed, [...vars, id].map((guid) => ({ guid, phase: "REMOVED" }) as NodeChange));
  });
}

/** "Duplicate collection": a copy of the collection, its modes and its variables (aliases inside it point at the copies). */
export function duplicateCollection(ed: EditorController, id: Guid): Guid | null {
  const a = assets(ed);
  const c = a.lookup.collection(id);
  if (!c) return null;
  const run = engineRun(ed, VARIABLE_COMMAND.duplicateCollection, { collection: id });
  if (run.ok) return run.created[0] ?? null;
  let copy: Guid | null = null;
  ed.batch("Duplicate collection", () => {
    const internal = ensureInternal(ed);
    copy = newGuid(ed);
    const index = a.collections.indexOf(c);
    const next = a.collections[index + 1];
    apply(ed, [
      {
        ...stripNode(c.node),
        guid: copy,
        phase: "CREATED",
        name: nextName(`${c.name} copy`, a.collections.map((x) => x.name)),
        parentIndex: { guid: internal, position: positionAfter(childPositions(ed, internal)) },
        sortPosition: positionBetween(c.sortPosition, next?.sortPosition ?? null),
      } as unknown as NodeChange,
    ]);
    const vars = a.variables.filter((v) => v.collection === id);
    const ids = new Map(vars.map((v) => [v.id, newGuid(ed)]));
    apply(
      ed,
      vars.map((v) => ({
        ...stripNode(v.node),
        guid: ids.get(v.id)!,
        phase: "CREATED",
        parentIndex: { guid: internal, position: positionAfter(childPositions(ed, internal)) },
        variableSetID: { guid: guidVal(copy!) },
        variableDataValues: {
          entries: (v.node.variableDataValues?.entries ?? []).map((e) => {
            const target = e.variableData?.dataType === "ALIAS" && e.variableData.value?.alias?.guid ? ids.get(guidStr(e.variableData.value.alias.guid)) : undefined;
            return target ? { ...e, variableData: toData(v.type, { kind: "alias", id: target }) } : e;
          }),
        },
      })) as unknown as NodeChange[]
    );
  });
  return copy;
}

/** A node's own fields for a copy (no id, no children, no parent). */
function stripNode(n: VNode): Record<string, unknown> {
  const { guid: _g, childIds: _c, parentIndex: _p, phase: _ph, ...rest } = n as VNode & { childIds?: unknown; phase?: unknown };
  void _g;
  void _c;
  void _p;
  void _ph;
  return rest;
}

// ---- Modes ---------------------------------------------------------------------------------------------------------

/** "New variable mode" (+ right of the mode headers): "Mode N", every variable's value copied from the default mode. */
export function addMode(ed: EditorController, collection: Guid, copyFrom?: Guid, name?: string): Guid | null {
  const a = assets(ed);
  const c = a.lookup.collection(collection);
  if (!c) return null;
  if (c.modes.length >= LIMITS.modes) {
    showToast({ message: `A collection can have up to ${LIMITS.modes} modes`, kind: "error" });
    return null;
  }
  const modeName = (name ?? nextModeName(c)).slice(0, LIMITS.modeName);
  const run = copyFrom ? engineRun(ed, VARIABLE_COMMAND.duplicateMode, { collection, mode: copyFrom }) : engineRun(ed, VARIABLE_COMMAND.addMode, { collection, name: modeName });
  if (run.ok) {
    const now = assets(ed).lookup.collection(collection);
    return run.created[0] ?? now?.modes.find((m) => !c.modes.some((x) => x.id === m.id))?.id ?? null;
  }
  const id = newModeId(ed, a.collections);
  const source = copyFrom ?? c.defaultMode;
  const at = copyFrom ? c.modes.findIndex((m) => m.id === copyFrom) : c.modes.length - 1;
  const position = positionBetween(c.modes[at]?.sortPosition ?? "", c.modes[at + 1]?.sortPosition ?? null);
  ed.batch(copyFrom ? "Duplicate mode" : "New variable mode", () => {
    ed.engine.setProps([collection], asFields({ variableSetModes: [...(c.node.variableSetModes ?? []), { id: guidVal(id), name: modeName, sortPosition: position }] }));
    for (const v of a.variables.filter((x) => x.collection === collection)) {
      const value = v.values.get(source) ?? v.values.get(c.defaultMode);
      if (value) ed.engine.setProps([v.id], asFields({ variableDataValues: withValue(v, id, value) }));
    }
  });
  return id;
}

export function renameMode(ed: EditorController, collection: Guid, mode: Guid, name: string): void {
  const c = assets(ed).lookup.collection(collection);
  const clean = name.trim().slice(0, LIMITS.modeName);
  if (!c || !clean || c.modes.find((m) => m.id === mode)?.name === clean) return;
  if (engineDid(ed, VARIABLE_COMMAND.renameMode, { collection, mode, name: clean })) return;
  ed.setProps([collection], asFields({ variableSetModes: (c.node.variableSetModes ?? []).map((m) => (guidStr(m.id) === mode ? { ...m, name: clean } : m)) }), "Rename mode");
}

/** "Delete mode" (never the last one): its values go; layers set to it fall back to the default mode. */
export function deleteMode(ed: EditorController, collection: Guid, mode: Guid): void {
  const a = assets(ed);
  const c = a.lookup.collection(collection);
  if (!c || c.modes.length < 2) return;
  if (engineDid(ed, VARIABLE_COMMAND.deleteMode, { collection, mode })) return;
  ed.batch("Delete mode", () => {
    ed.engine.setProps([collection], asFields({ variableSetModes: (c.node.variableSetModes ?? []).filter((m) => guidStr(m.id) !== mode) }));
    for (const v of a.variables.filter((x) => x.collection === collection)) {
      const entries = (v.node.variableDataValues?.entries ?? []).filter((e) => guidStr(e.modeID) !== mode);
      if (entries.length !== (v.node.variableDataValues?.entries ?? []).length) ed.engine.setProps([v.id], asFields({ variableDataValues: { entries } }));
    }
    refreshResolved(ed);
  });
}

/** "Set as default": the mode becomes the first column. */
export function setDefaultMode(ed: EditorController, collection: Guid, mode: Guid): void {
  const c = assets(ed).lookup.collection(collection);
  if (!c || c.defaultMode === mode) return;
  if (engineDid(ed, VARIABLE_COMMAND.moveMode, { collection, mode, index: 0 })) return;
  const position = positionBetween("", c.modes[0].sortPosition);
  ed.batch("Set as default", () => {
    ed.engine.setProps([collection], asFields({ variableSetModes: (c.node.variableSetModes ?? []).map((m) => (guidStr(m.id) === mode ? { ...m, sortPosition: position } : m)) }));
    refreshResolved(ed);
  });
}

/** "Move left" / "Move right": one column over. */
export function moveMode(ed: EditorController, collection: Guid, mode: Guid, step: -1 | 1): void {
  const c = assets(ed).lookup.collection(collection);
  if (!c) return;
  const i = c.modes.findIndex((m) => m.id === mode);
  const j = i + step;
  if (i < 0 || j < 0 || j >= c.modes.length) return;
  if (engineDid(ed, VARIABLE_COMMAND.moveMode, { collection, mode, index: j })) return;
  const position = step < 0 ? positionBetween(c.modes[j - 1]?.sortPosition ?? "", c.modes[j].sortPosition) : positionBetween(c.modes[j].sortPosition, c.modes[j + 1]?.sortPosition ?? null);
  ed.batch(step < 0 ? "Move mode left" : "Move mode right", () => {
    ed.engine.setProps([collection], asFields({ variableSetModes: (c.node.variableSetModes ?? []).map((m) => (guidStr(m.id) === mode ? { ...m, sortPosition: position } : m)) }));
    refreshResolved(ed);
  });
}

// ---- Variables -------------------------------------------------------------------------------------------------------

/** "+ Create variable" of `type` in `collection` (inside `group`): Figma's default value and name. Returns its id. */
export function createVariable(ed: EditorController, collection: Guid, type: VarType, group = "", value?: VarValue): Guid | null {
  const a = assets(ed);
  const c = a.lookup.collection(collection);
  if (!c) return null;
  const inCollection = a.variables.filter((v) => v.collection === collection);
  if (inCollection.length >= LIMITS.variables) {
    showToast({ message: `A collection can have up to ${LIMITS.variables.toLocaleString("en-US")} variables`, kind: "error" });
    return null;
  }
  const name = (group ? `${group}/` : "") + nextName(VAR_TYPE_LABEL[type], inCollection.filter((v) => splitName(v.name).group === group).map((v) => splitName(v.name).leaf));
  const run = engineRun(ed, VARIABLE_COMMAND.createVariable, { collection, type, name, ...(value ? { value: engineValue(value) } : {}) });
  if (run.ok) return run.created[0] ?? assets(ed).variables.find((v) => v.collection === collection && v.name === name)?.id ?? null;
  const initial = value ?? { kind: "literal", value: newValue(type) };
  let id: Guid | null = null;
  ed.batch("Create variable", () => {
    const internal = ensureInternal(ed);
    id = newGuid(ed);
    apply(ed, [
      {
        guid: id,
        phase: "CREATED",
        type: "VARIABLE",
        name,
        parentIndex: { guid: internal, position: positionAfter(childPositions(ed, internal)) },
        variableSetID: { guid: guidVal(collection) },
        variableResolvedType: type,
        variableDataValues: { entries: c.modes.map((m) => ({ modeID: guidVal(m.id), variableData: toData(type, initial) })) },
        sortPosition: positionAfter(inCollection.map((v) => v.sortPosition)),
        visible: false,
      } as unknown as NodeChange,
    ]);
  });
  return id;
}

/** A new variable's value: white, 0, "", false (Figma's). */
function newValue(type: VarType): Literal {
  switch (type) {
    case "COLOR":
      return { r: 1, g: 1, b: 1, a: 1 };
    case "FLOAT":
      return 0;
    case "STRING":
      return "";
    case "BOOLEAN":
      return false;
  }
}

/** Rename (a slash path moves it into groups). False when the name is refused (empty, ".", "{", "}", or taken). */
export function renameVariable(ed: EditorController, id: Guid, name: string): boolean {
  const a = assets(ed);
  const v = a.lookup.variable(id);
  const clean = cleanName(name);
  if (!v || !clean || /[.{}]/.test(clean)) return false;
  if (clean === v.name) return true;
  if (a.variables.some((x) => x.collection === v.collection && x.id !== id && x.name === clean)) {
    showToast({ message: `A variable named “${clean}” already exists`, kind: "error" });
    return false;
  }
  if (engineDid(ed, VARIABLE_COMMAND.renameVariable, { variable: id, name: clean })) return true;
  ed.setProps([id], asFields({ name: clean }), "Rename variable");
  return true;
}

/** A value of one mode (a literal of the variable's type, or an alias — never a cycle). One step; a drag one open step. */
export function setVariableValue(ed: EditorController, id: Guid, mode: Guid, value: VarValue, info?: { final: boolean; source?: string }): boolean {
  const a = assets(ed);
  const v = a.lookup.variable(id);
  if (!v) return false;
  if (value.kind === "alias") {
    const target = a.lookup.variable(value.id);
    if (!target || target.type !== v.type || aliasMakesCycle(id, value.id, a.lookup)) {
      showToast({ message: "This would create a circular reference", kind: "error" });
      return false;
    }
  }
  // A drag's live values share one open step (written as fields; the engine re-resolves at its commit).
  if (!info && engineDid(ed, VARIABLE_COMMAND.setValue, { variable: id, mode, value: engineValue(value) })) return true;
  const write = () => {
    ed.engine.setProps([id], asFields({ variableDataValues: withValue(v, mode, value) }));
    refreshResolved(ed);
  };
  if (info) ed.edit("Edit variable", { final: info.final, source: (info.source ?? "type") as "type" }, write);
  else ed.batch("Edit variable", write);
  return true;
}

/** Fields of the Edit variable modal: description, scopes, code syntax, Hide from publishing. */
export function updateVariable(ed: EditorController, id: Guid, patch: { description?: string; scopes?: string[]; codeSyntax?: { platform: "WEB" | "ANDROID" | "iOS"; value: string }[]; hidden?: boolean }, label = "Edit variable"): void {
  if (hasCommand(VARIABLE_COMMAND.setDescription) && engineHasVariables(ed)) {
    if (patch.description !== undefined) engineDid(ed, VARIABLE_COMMAND.setDescription, { variable: id, description: patch.description });
    if (patch.scopes !== undefined) engineDid(ed, VARIABLE_COMMAND.setScopes, { variables: [id], scopes: patch.scopes });
    if (patch.hidden !== undefined) engineDid(ed, VARIABLE_COMMAND.setHidden, { variables: [id], hidden: patch.hidden });
    if (patch.codeSyntax !== undefined) {
      const was = assets(ed).lookup.variable(id)?.codeSyntax ?? [];
      for (const platform of ["WEB", "ANDROID", "iOS"] as const) {
        const next = patch.codeSyntax.find((e) => e.platform === platform)?.value ?? "";
        if ((was.find((e) => e.platform === platform)?.value ?? "") !== next) engineDid(ed, VARIABLE_COMMAND.setCodeSyntax, { variable: id, platform, value: next });
      }
    }
    return;
  }
  const f: Record<string, unknown> = {};
  if (patch.description !== undefined) f.description = patch.description;
  if (patch.scopes !== undefined) f.variableScopes = patch.scopes;
  if (patch.codeSyntax !== undefined) f.codeSyntax = { entries: patch.codeSyntax.filter((e) => e.value.trim()) };
  if (patch.hidden !== undefined) f.isPublishable = !patch.hidden;
  ed.setProps([id], asFields(f), label);
}

/** "Duplicate" (⇧Enter): copies right after each original, named "… copy". Returns the copies' ids. */
export function duplicateVariables(ed: EditorController, ids: readonly Guid[]): Guid[] {
  const a = assets(ed);
  const run = engineRun(ed, VARIABLE_COMMAND.duplicateVariables, { variables: [...ids] });
  if (run.ok) return run.created;
  const out: Guid[] = [];
  ed.batch(ids.length > 1 ? "Duplicate variables" : "Duplicate variable", () => {
    const internal = ensureInternal(ed);
    for (const id of ids) {
      const v = a.lookup.variable(id);
      if (!v) continue;
      const siblings = a.variables.filter((x) => x.collection === v.collection);
      const next = siblings[siblings.indexOf(v) + 1];
      const copy = newGuid(ed);
      const { group, leaf } = splitName(v.name);
      const taken = siblings.map((x) => x.name);
      apply(ed, [
        {
          ...stripNode(v.node),
          guid: copy,
          phase: "CREATED",
          name: nextName((group ? `${group}/` : "") + `${leaf} copy`, taken),
          parentIndex: { guid: internal, position: positionAfter(childPositions(ed, internal)) },
          sortPosition: positionBetween(v.sortPosition, next?.sortPosition ?? null),
        } as unknown as NodeChange,
      ]);
      out.push(copy);
    }
  });
  return out;
}

/**
 * "Delete variable(s)": a variable still used (by a layer, a style or another variable's alias) stays as a
 * soft-deleted node so the uses keep resolving (REST's `deletedButReferenced`); an unused one is removed.
 */
export function deleteVariables(ed: EditorController, ids: readonly Guid[]): void {
  if (!ids.length) return;
  if (engineDid(ed, VARIABLE_COMMAND.deleteVariables, { variables: [...ids] })) return;
  const used = usedVariables(ed, new Set(ids));
  ed.batch(ids.length > 1 ? "Delete variables" : "Delete variable", () => {
    const remove = ids.filter((id) => !used.has(id));
    const soft = ids.filter((id) => used.has(id));
    if (remove.length) apply(ed, remove.map((guid) => ({ guid, phase: "REMOVED" }) as NodeChange));
    if (soft.length) ed.engine.setProps(soft, asFields({ isSoftDeleted: true }));
  });
}

/** Which of `ids` something references (a layer's binding, a style's paint, an alias). */
function usedVariables(ed: EditorController, ids: ReadonlySet<Guid>): Set<Guid> {
  const out = new Set<Guid>();
  const a = assets(ed);
  for (const v of a.variables) {
    if (ids.has(v.id)) continue;
    for (const value of v.values.values()) if (value.kind === "alias" && ids.has(value.id)) out.add(value.id);
  }
  const note = (n: Record<string, unknown>) => {
    for (const id of variableBindings(n).values()) if (ids.has(id)) out.add(id);
    for (const f of ["fillPaints", "strokePaints"] as const) for (const p of (n[f] as Paint[] | undefined) ?? []) {
      const id = paintVariable(p);
      if (id && ids.has(id)) out.add(id);
    }
  };
  for (const s of a.styles) note(s.node);
  walkDocument(ed, (n) => note(n as unknown as Record<string, unknown>));
  return out;
}

/** Drag to reorder: `ids` placed before `before` (null: at the end), taking its group (the table's row it was dropped on). */
export function moveVariables(ed: EditorController, ids: readonly Guid[], before: Guid | null, group?: string): void {
  const a = assets(ed);
  const moving = ids.map((id) => a.lookup.variable(id)).filter((v): v is Variable => !!v);
  if (!moving.length) return;
  const collection = moving[0].collection;
  const rest = a.variables.filter((v) => v.collection === collection && !ids.includes(v.id));
  const at = before ? rest.findIndex((v) => v.id === before) : rest.length;
  if (engineDid(ed, VARIABLE_COMMAND.moveVariables, { variables: moving.map((v) => v.id), index: at < 0 ? rest.length : at, ...(group !== undefined ? { group } : {}) })) return;
  const lo = at > 0 ? rest[at - 1].sortPosition : "";
  const hi = at >= 0 && at < rest.length ? rest[at].sortPosition : null;
  ed.batch(moving.length > 1 ? "Move variables" : "Move variable", () => {
    let low = lo;
    for (const v of moving) {
      const position = positionBetween(low, hi);
      low = position;
      const f: Record<string, unknown> = { sortPosition: position };
      if (group !== undefined && splitName(v.name).group !== group) f.name = cleanName(`${group}/${splitName(v.name).leaf}`);
      ed.engine.setProps([v.id], asFields(f));
    }
  });
}

/** "New group with selection": the variables move into a group named "Group" (or "Group 2"…) at their common place. */
export function groupVariables(ed: EditorController, ids: readonly Guid[]): string | null {
  const a = assets(ed);
  const vars = ids.map((id) => a.lookup.variable(id)).filter((v): v is Variable => !!v);
  if (!vars.length) return null;
  const parent = splitName(vars[0].name).group;
  const siblings = a.variables.filter((v) => v.collection === vars[0].collection);
  const takenGroups = new Set(siblings.map((v) => splitName(v.name).group));
  const groupName = nextName("Group", [...takenGroups].map((g) => (parent ? g.slice(parent.length + 1) : g)));
  const path = parent ? `${parent}/${groupName}` : groupName;
  // The engine's name is relative to the group the variables share.
  if (engineDid(ed, VARIABLE_COMMAND.groupVariables, { variables: vars.map((v) => v.id), name: groupName })) return path;
  ed.batch("New group with selection", () => {
    for (const v of vars) ed.engine.setProps([v.id], asFields({ name: `${path}/${splitName(v.name).leaf}` }));
  });
  return path;
}

/** A group renamed: every variable under it follows (and any sub-group). */
export function renameGroup(ed: EditorController, collection: Guid, from: string, to: string): void {
  const clean = cleanName(to);
  if (!clean || clean === from) return;
  // The engine renames a group in place (its last segment); a move to another parent is the editor's.
  const parentOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
  if (parentOf(clean) === parentOf(from) && engineDid(ed, VARIABLE_COMMAND.renameGroup, { collection, group: from, name: clean.slice(clean.lastIndexOf("/") + 1) })) return;
  const vars = assets(ed).variables.filter((v) => v.collection === collection);
  ed.batch("Rename group", () => {
    for (const v of vars) {
      const name = renameGroupIn(v.name, from, clean);
      if (name) ed.engine.setProps([v.id], asFields({ name }));
    }
  });
}

/** "Delete group": its variables. */
export function deleteGroup(ed: EditorController, collection: Guid, group: string): void {
  if (engineDid(ed, VARIABLE_COMMAND.deleteGroup, { collection, group })) return;
  const ids = assets(ed)
    .variables.filter((v) => v.collection === collection && v.name.startsWith(group + "/"))
    .map((v) => v.id);
  deleteVariables(ed, ids);
}

// ---- Binding ---------------------------------------------------------------------------------------------------------

/** Binds a node field (VariableField) on every ref to `variable` (null: "Detach variable" — the value stays). */
export function bindVariable(ed: EditorController, refs: readonly Guid[], field: string | readonly string[], variable: Guid | null): void {
  const a = assets(ed);
  const v = variable ? a.lookup.variable(variable) : null;
  if (variable && !v) return;
  const fields = typeof field === "string" ? [field] : [...field];
  if (engineResolves(ed)) {
    let ok = true;
    for (const target of fields) ok = (v ? engineDid(ed, VARIABLE_COMMAND.bind, { refs: [...refs], target, variable: v.id }) : engineDid(ed, VARIABLE_COMMAND.detach, { refs: [...refs], target })) && ok;
    if (ok) return;
  }
  ed.batch(variable ? "Apply variable" : "Detach variable", () => {
    for (const n of ed.engine.readNodes(refs)) {
      let map: unknown = n;
      for (const f of fields) map = { parameterConsumptionMap: withVariableBinding(map as never, f, v ? { id: v.id, type: v.type } : null) };
      ed.engine.setProps([n.guid], asFields(map as Record<string, unknown>));
    }
    if (v) refreshSubtrees(ed, refs);
  });
}

type PaintField = "fillPaints" | "strokePaints";

/**
 * Binds paint `index` of `field` (a fill or a stroke) to a colour variable; `index` past the list adds a solid
 * paint; `replace` makes it the only paint (the section's "Apply variable"). null detaches (the colour stays).
 */
export function bindPaint(ed: EditorController, refs: readonly Guid[], field: PaintField, index: number, variable: Guid | null, replace = false): void {
  const a = assets(ed);
  const v = variable ? a.lookup.variable(variable) : null;
  if (variable && (!v || v.type !== "COLOR")) return;
  if (engineResolves(ed)) {
    // The engine binds a paint that is there: a new or replacing paint is added first (its own step).
    const nodes = ed.engine.readNodes(refs);
    if (v && (replace || nodes.some((n) => ((n[field] ?? []) as Paint[]).length <= index))) {
      ed.batch("Add fill", () => {
        for (const n of nodes) {
          const paints = (n[field] ?? []) as Paint[];
          const solid: Paint = { type: "SOLID", color: { r: 1, g: 1, b: 1, a: 1 }, opacity: 1, visible: true };
          if (replace) ed.engine.setProps([n.guid], asFields({ [field]: [solid] }));
          else if (paints.length <= index) ed.engine.setProps([n.guid], asFields({ [field]: [...paints, solid] }));
        }
      });
      if (replace) index = 0;
    }
    const target = `${field}[${index}].color`;
    if (v ? engineDid(ed, VARIABLE_COMMAND.bind, { refs: [...refs], target, variable: v.id }) : engineDid(ed, VARIABLE_COMMAND.detach, { refs: [...refs], target })) return;
  }
  ed.batch(variable ? "Apply variable" : "Detach variable", () => {
    for (const n of ed.engine.readNodes(refs)) {
      const paints = [...((n[field] ?? []) as Paint[])];
      const color = v ? (resolveVariable(v.id, a.lookup) as Color | null) : null;
      const base: Paint = paints[index] ?? { type: "SOLID", opacity: 1, visible: true, color: { r: 1, g: 1, b: 1, a: 1 } };
      const next = v ? boundPaint(base.type === "SOLID" ? base : { type: "SOLID", opacity: 1, visible: true }, v.id, color) : detachedPaint(base);
      const list = replace ? [next] : index < paints.length ? paints.map((p, i) => (i === index ? next : p)) : [...paints, next];
      // A bound paint leaves a colour style (the layer no longer looks like it).
      const slot = field === "fillPaints" ? "fill" : "stroke";
      const styled = styleIdOf(n as never, slot);
      ed.engine.setProps([n.guid], asFields({ [field]: list, ...(styled && v ? { [STYLE_SLOT[slot].ref]: {} } : {}) }));
    }
    if (v) refreshSubtrees(ed, refs);
  });
}

/** "Apply variable mode": collection `c` on every ref set to `mode` (null: Auto). */
export function setExplicitMode(ed: EditorController, refs: readonly Guid[], c: Guid, mode: Guid | null): void {
  if (engineDid(ed, VARIABLE_COMMAND.setMode, { refs: [...refs], collection: c, mode: mode ?? "" })) return;
  ed.variables.invalidate();
  ed.batch("Apply variable mode", () => {
    for (const n of ed.engine.readNodes(refs)) ed.engine.setProps([n.guid], asFields({ variableModeBySetMap: withExplicitMode(n as never, c, mode) }));
    refreshSubtrees(ed, refs);
  });
}

/** The mode each collection resolves to at `ref` (its own, an ancestor's, the page's, else the default) and whether it's set there. */
export function modesAt(ed: EditorController, ref: Guid): Map<Guid, { mode: Guid; explicit: boolean; inherited: Guid }> {
  const read = engineHasVariables(ed) ? engineMethod<(ref: Guid) => { collectionId: Guid; explicitModeId: Guid | null; resolvedModeId: Guid }[]>(ed.engine, "variableModes") : null;
  if (read) {
    const n = ed.engine.readNode(ref);
    const parent = n && n.type !== "CANVAS" ? n.parentIndex?.guid : undefined;
    const up = parent ? new Map(read(parent).map((m) => [m.collectionId, m.resolvedModeId])) : null;
    const out = new Map<Guid, { mode: Guid; explicit: boolean; inherited: Guid }>();
    for (const m of read(ref)) out.set(m.collectionId, { mode: m.resolvedModeId, explicit: m.explicitModeId !== null, inherited: m.explicitModeId === null ? m.resolvedModeId : (up?.get(m.collectionId) ?? assets(ed).lookup.collection(m.collectionId)?.defaultMode ?? m.resolvedModeId) });
    return out;
  }
  const chain = chainOf(ed, ref);
  const out = new Map<Guid, { mode: Guid; explicit: boolean; inherited: Guid }>();
  const own = explicitModes(chain[0]);
  for (const c of assets(ed).collections) {
    const inherited = modeAt(chain.slice(1), c);
    const mine = own.get(c.id);
    const explicit = !!mine && c.modes.some((m) => m.id === mine);
    out.set(c.id, { mode: explicit ? mine! : inherited, explicit, inherited });
  }
  return out;
}

/** `ref` and its ancestors (innermost first, its page last), each with its explicit modes. */
function chainOf(ed: EditorController, ref: Guid): { guid: Guid; variableModeBySetMap?: { entries?: ModeEntry[] } }[] {
  const out: { guid: Guid; variableModeBySetMap?: { entries?: ModeEntry[] } }[] = [];
  let id: Guid | undefined = ref;
  for (let i = 0; id && i < 256; i++) {
    const n = ed.engine.readNode(id) as (NodeChange & { variableModeBySetMap?: { entries?: ModeEntry[] } }) | null;
    if (!n || n.type === "DOCUMENT") break;
    out.push(n);
    if (n.type === "CANVAS") break;
    id = n.parentIndex?.guid;
  }
  return out;
}

// ---- Resolution (the fallback: the engine resolves once it has variables) ---------------------------------------------

type AnyNode = NodeChange & Record<string, unknown>;

/** Every real node of every page (parents before children) with its ancestors' explicit modes. */
function walkDocument(ed: EditorController, visit: (n: AnyNode, chain: readonly AnyNode[]) => void, roots?: { id: Guid; chain: AnyNode[] }[]): void {
  const engine = ed.engine;
  let level: { id: Guid; chain: readonly AnyNode[] }[] = roots ?? engine.pages().map((p) => ({ id: p.guid, chain: [] }));
  while (level.length) {
    const ids = level.map((l) => l.id).filter((id) => !id.startsWith("I"));
    const read = new Map((ids.length ? (engine.readNodes(ids, { childIds: true }) as AnyNode[]) : []).map((n) => [n.guid, n]));
    const next: { id: Guid; chain: readonly AnyNode[] }[] = [];
    for (const l of level) {
      const n = read.get(l.id);
      if (!n) continue;
      visit(n, l.chain);
      const chain = [n, ...l.chain];
      for (const c of n.childIds ?? []) if (!c.startsWith("I")) next.push({ id: c, chain });
    }
    level = next;
  }
}

/** What a node's bindings and styles make its fields now (only the fields that differ). */
function resolvedPatch(a: LocalAssets, n: AnyNode, chain: readonly AnyNode[]): Record<string, unknown> | null {
  const modeFor = (c: Guid) => {
    const col = a.lookup.collection(c);
    return col ? modeAt([n, ...chain] as never, col) : undefined;
  };
  const patch: Record<string, unknown> = {};
  const now = (k: string) => (k in patch ? patch[k] : n[k]);
  // Styles: the style's fields are the layer's.
  for (const slot of Object.keys(STYLE_SLOT) as StyleSlot[]) {
    const id = styleIdOf(n, slot);
    const s = id ? a.style(id) : undefined;
    if (!s) continue;
    const content = styleContent(s, slot);
    for (const [k, v] of Object.entries(content)) if (!sameData(n[k], v)) patch[k] = v;
  }
  // Paints bound to colour variables.
  for (const f of ["fillPaints", "strokePaints"] as const) {
    const paints = now(f) as Paint[] | undefined;
    if (!paints?.some((p) => paintVariable(p))) continue;
    const next = paints.map((p) => {
      const id = paintVariable(p);
      const color = id ? (resolveVariable(id, a.lookup, modeFor) as Paint["color"] | null) : null;
      return color ? { ...p, color } : p;
    });
    if (!sameData(next, n[f])) patch[f] = next;
  }
  // Effect colours.
  const effects = now("effects") as ({ colorVar?: unknown; color?: unknown } & Record<string, unknown>)[] | undefined;
  if (effects?.some((e) => e.colorVar)) {
    const next = effects.map((e) => {
      const id = paintVariable(e as unknown as Paint);
      const color = id ? resolveVariable(id, a.lookup, modeFor) : null;
      return color ? { ...e, color } : e;
    });
    if (!sameData(next, n.effects)) patch.effects = next;
  }
  // Node fields.
  for (const [field, id] of variableBindings(n as never)) {
    const value = resolveVariable(id, a.lookup, modeFor);
    if (value === null) continue;
    const f = resolvedFields(field, value, { ...n, ...patch } as never);
    if (!f) continue;
    if (field === "TEXT_DATA") {
      const text = n.textData as { characters?: string } | undefined;
      if (text?.characters !== (f.textData as { characters: string }).characters) patch.textData = { ...(text ?? {}), characters: (f.textData as { characters: string }).characters, characterStyleIDs: undefined };
      continue;
    }
    for (const [k, v] of Object.entries(f)) if (!sameData(now(k), v)) patch[k] = v;
  }
  return Object.keys(patch).length ? patch : null;
}

/**
 * Writes every binding's and style's resolved copy that is stale, in the current step (call inside a batch or an
 * edit). Styles under the internal canvas are refreshed first (with the collections' default modes), then every page.
 */
export function refreshResolved(ed: EditorController): void {
  if (engineResolves(ed)) return;
  const a = fresh(ed);
  if (!a.collections.length && !a.styles.length) return;
  let touched = false;
  for (const s of a.styles) {
    const patch = resolvedPatch(a, s.node as AnyNode, []);
    if (patch) {
      ed.engine.setProps([s.id], asFields(patch));
      touched = true;
    }
  }
  const now = touched ? fresh(ed) : a;
  walkDocument(ed, (n, chain) => {
    const patch = resolvedPatch(now, n, chain);
    if (patch) ed.engine.setProps([n.guid], asFields(patch));
  });
}

/** The same for `refs` and everything under them (a binding or a mode set on them). */
export function refreshSubtrees(ed: EditorController, refs: readonly Guid[]): void {
  if (engineResolves(ed)) return;
  const a = fresh(ed);
  const roots = refs.map((id) => ({ id, chain: chainOf(ed, id).slice(1) as AnyNode[] }));
  walkDocument(
    ed,
    (n, chain) => {
      const patch = resolvedPatch(a, n, chain);
      if (patch) ed.engine.setProps([n.guid], asFields(patch));
    },
    roots
  );
}

/** A variable's value as a layer at `ref` sees it (the panel's pills and previews). */
export function resolveAt(ed: EditorController, variable: Guid, ref: Guid | null): Literal | null {
  const read = engineHasVariables(ed) ? engineMethod<(id: Guid, consumer?: Guid) => Literal | null>(ed.engine, "resolveVariable") : null;
  if (read) return read(variable, ref ?? undefined);
  const a = assets(ed);
  if (!ref) return resolveVariable(variable, a.lookup);
  const chain = chainOf(ed, ref);
  return resolveVariable(variable, a.lookup, (c) => {
    const col = a.lookup.collection(c);
    return col ? modeAt(chain as never, col) : undefined;
  });
}

// ---- Styles -------------------------------------------------------------------------------------------------------------

/**
 * "Create style": a style of `kind` named `name`, taking the look of `from` (a selected layer) or Figma's
 * defaults; `apply` also applies it to those layers (creating from a selection). Returns its id.
 */
export function createStyle(ed: EditorController, kind: StyleKind, name: string, from: Guid | null = null, slot?: StyleSlot, applyTo: readonly Guid[] = []): Guid | null {
  const clean = cleanName(name) || nextName(STYLE_KIND_SINGULAR[kind].replace(" style", ""), assets(ed).styles.map((s) => s.name));
  const run = engineRun(ed, VARIABLE_COMMAND.createStyle, { type: kind, name: clean, ...(from ? { from, apply: applyTo.includes(from) } : {}), ...(slot === "stroke" ? { target: "STROKE" } : slot === "fill" ? { target: "FILL" } : {}) });
  if (run.ok) {
    const id = run.created[0] ?? assets(ed).styles.find((s) => s.name === clean && s.kind === kind)?.id ?? null;
    const others = applyTo.filter((r) => r !== from);
    if (id && slot && others.length) applyStyle(ed, others, slot, id);
    return id;
  }
  const a = assets(ed);
  const source = from ? (ed.engine.readNode(from) as AnyNode | null) : null;
  // A stroke's paints make a color style's fill.
  const look = source && slot === "stroke" ? ({ ...source, fillPaints: source.strokePaints } as AnyNode) : source;
  let id: Guid | null = null;
  ed.batch(`Create ${STYLE_KIND_SINGULAR[kind].toLowerCase()}`, () => {
    const internal = ensureInternal(ed);
    id = newGuid(ed);
    apply(ed, [
      {
        guid: id,
        phase: "CREATED",
        type: STYLE_NODE_TYPE[kind],
        name: clean,
        parentIndex: { guid: internal, position: positionAfter(childPositions(ed, internal)) },
        styleType: kind,
        sortPosition: positionAfter(a.styles.filter((s) => s.kind === kind).map((s) => s.sortPosition)),
        size: { x: 100, y: 100 },
        visible: false,
        ...styleFieldsFrom(kind, look),
      } as unknown as NodeChange,
    ]);
    if (applyTo.length && slot) {
      const style = fresh(ed).style(id);
      if (style) ed.engine.setProps(applyTo, asFields(applyStyleFields(style, slot)));
    }
  });
  return id;
}

/** Applies a style to every ref in `slot` (null: "Detach style" — the layer keeps how it looks). */
export function applyStyle(ed: EditorController, refs: readonly Guid[], slot: StyleSlot, style: Guid | null): void {
  const s = style ? assets(ed).style(style) : null;
  if (style && !s) return;
  const target = slot === "fill" ? "FILL" : slot === "stroke" ? "STROKE" : undefined;
  if (s ? engineDid(ed, VARIABLE_COMMAND.applyStyle, { refs: [...refs], style: s.id, ...(target ? { target } : {}) }) : engineDid(ed, VARIABLE_COMMAND.detachStyle, { refs: [...refs], target: slot.toUpperCase() })) return;
  ed.batch(s ? "Apply style" : "Detach style", () => {
    ed.engine.setProps(refs, asFields(s ? applyStyleFields(s, slot) : { [STYLE_SLOT[slot].ref]: {} }));
    if (s) refreshSubtrees(ed, refs);
  });
}

/** Edits a style (name, description, its fields): every layer using it follows, in the same step (a drag: one open step). */
export function updateStyle(ed: EditorController, id: Guid, fields: Record<string, unknown>, label = "Edit style", info?: { final: boolean; source?: string }): void {
  const write = () => {
    ed.engine.setProps([id], asFields(fields));
    refreshResolved(ed);
  };
  if (info) ed.edit(label, { final: info.final, source: (info.source ?? "type") as "type" }, write);
  else ed.batch(label, write);
}

export function renameStyle(ed: EditorController, id: Guid, name: string): void {
  const clean = cleanName(name);
  if (!clean || assets(ed).style(id)?.name === clean) return;
  ed.setProps([id], asFields({ name: clean }), "Rename style");
}

/** "Delete style": layers using it keep how they look (their reference cleared). */
export function deleteStyle(ed: EditorController, id: Guid): void {
  if (engineDid(ed, VARIABLE_COMMAND.deleteStyle, { style: id })) return;
  ed.batch("Delete style", () => {
    walkDocument(ed, (n) => {
      for (const slot of Object.keys(STYLE_SLOT) as StyleSlot[]) if (styleIdOf(n, slot) === id) ed.engine.setProps([n.guid], asFields({ [STYLE_SLOT[slot].ref]: {} }));
    });
    apply(ed, [{ guid: id, phase: "REMOVED" } as NodeChange]);
  });
}

/** "Duplicate style": right after it, "… copy". */
export function duplicateStyle(ed: EditorController, id: Guid): Guid | null {
  const a = assets(ed);
  const s = a.style(id);
  if (!s) return null;
  let copy: Guid | null = null;
  ed.batch("Duplicate style", () => {
    const internal = ensureInternal(ed);
    copy = newGuid(ed);
    const same = a.styles.filter((x) => x.kind === s.kind);
    const next = same[same.indexOf(s) + 1];
    apply(ed, [
      {
        ...stripNode(s.node as VNode),
        guid: copy,
        phase: "CREATED",
        name: nextName(`${s.name} copy`, a.styles.map((x) => x.name)),
        parentIndex: { guid: internal, position: positionAfter(childPositions(ed, internal)) },
        sortPosition: positionBetween(s.sortPosition, next?.sortPosition ?? null),
      } as unknown as NodeChange,
    ]);
  });
  return copy;
}

/** Drag to reorder styles of one kind: `id` placed before `before` (null: at the end). */
export function moveStyle(ed: EditorController, id: Guid, before: Guid | null): void {
  const a = assets(ed);
  const s = a.style(id);
  if (!s) return;
  const rest = a.styles.filter((x) => x.kind === s.kind && x.id !== id);
  const at = before ? rest.findIndex((x) => x.id === before) : rest.length;
  if (engineDid(ed, VARIABLE_COMMAND.moveStyle, { style: id, index: at < 0 ? rest.length : at })) return;
  const position = positionBetween(at > 0 ? rest[at - 1].sortPosition : "", at >= 0 && at < rest.length ? rest[at].sortPosition : null);
  ed.setProps([id], asFields({ sortPosition: position }), "Move style");
}
