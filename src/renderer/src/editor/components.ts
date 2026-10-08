/**
 * Components and instances in the editor (docs/editor.md "Components"): the
 * file's local components (every page, cached per document change), what an
 * instance points at, and the actions the menus, the Design panel and Assets
 * share — Figma's (docs/research/figma/R4-components.md).
 *
 * Everything goes through the engine's E6 commands (docs/engine-build.md
 * "E6 components + instances API"; `COMPONENT_COMMAND`) once abi.ts names
 * them. The structural ones (Create component, Create multiple components,
 * Combine as variants, Add variant, Detach instance, Push changes to main
 * component, Restore component) are disabled until then. What is document
 * data the engine already keeps (round-trips since E3) has a fallback that
 * writes the schema's fields through the generic setter, one undo step each:
 * property definitions, values and bindings, a swap or variant switch
 * (`symbolData`), Reset (`symbolOverrides`), exposing a nested instance; "Go
 * to main component" falls back to navigating itself (page, selection, zoom).
 * Reads prefer `engine.componentInfo(ref)`.
 */
import { showToast } from "@/ds";
import { Status } from "@/engine/abi";
import type { Guid, Message, NodeChange, NodeFields } from "@/engine/codec";
import type { EditorController } from "./controller";
import { engineCall, engineCommandEnabled, engineMethod, hasCommand, runEngineCommand, type CommandArgs } from "./engineCompat";
import { frameAt, toPage } from "./placeImages";
import { libraryOfMain, openLibraryFile } from "./libraries";
import { positionBetween } from "./model/variables";
import {
  assignedValue,
  bindingsOf,
  changedGroups,
  defaultVariant,
  derivedId,
  effectiveKey,
  formatVariantName,
  groupChanges,
  guidStr,
  guidVal,
  isComponent,
  isComponentSet,
  isInstance,
  newPropertyDef,
  newPropertyName,
  nextDefId,
  overrideAt,
  parseDerivedId,
  parseVariantName,
  renameInVariantName,
  sortedDefs,
  sameGuid,
  unbindAll,
  variantFor,
  variantProperties,
  variantValues,
  withAssignment,
  withBinding,
  withOverride,
  withoutOverrides,
  type BindableField,
  type CNode,
  type ComponentAsset,
  type ComponentPropDef,
  type ComponentPropType,
  type ComponentPropValue,
  type GuidValue,
  type SymbolData,
} from "./model/components";

/** The engine's E6 commands (docs/engine-build.md); each one runs only once abi.ts names it. */
export const COMPONENT_COMMAND = {
  /** args { mode?: "SINGLE" | "MULTIPLE" | "SET" } */
  create: "CREATE_COMPONENT",
  combine: "COMBINE_AS_VARIANTS",
  addVariant: "ADD_VARIANT",
  detach: "DETACH_INSTANCE",
  /** args { ref?, field? } */
  reset: "RESET_OVERRIDES",
  push: "PUSH_CHANGES_TO_MAIN",
  goToMain: "GO_TO_MAIN_COMPONENT",
  returnToInstance: "RETURN_TO_INSTANCE",
  /** args { main, ref? } */
  swap: "SWAP_INSTANCE",
  /** args { ref?, prop: defId | name, value } */
  setProperty: "SET_COMPONENT_PROPERTY",
  /** args { ref?, name, type, defaultValue?, bind?, preferredValues? } */
  addProperty: "ADD_COMPONENT_PROPERTY",
  /** args { ref?, prop, name?, defaultValue?, preferredValues?, oldValue?, newValue? } */
  editProperty: "EDIT_COMPONENT_PROPERTY",
  /** args { ref?, prop } */
  deleteProperty: "DELETE_COMPONENT_PROPERTY",
  /** args { refs?, field, prop } ("" unbinds) */
  bindProperty: "BIND_COMPONENT_PROPERTY",
  /** args { ref? } */
  restore: "RESTORE_COMPONENT",
  /** args { ref?, exposed } */
  expose: "SET_EXPOSED_INSTANCE",
  resetSlot: "RESET_SLOT",
  /** args { ref?: Guid | Guid[] } (round 6) */
  convertToSlot: "CONVERT_TO_SLOT",
  wrapInSlot: "WRAP_IN_NEW_SLOT",
  /** args { ref? }: "Delete contents" */
  clearSlot: "CLEAR_SLOT",
} as const;

const asFields = (f: Record<string, unknown>): NodeFields => f as NodeFields;

/** Runs an E6 command when the build has it: true when it ran OK (false: absent or refused — the caller falls back). */
function engineDid(ed: EditorController, name: string, args?: CommandArgs): boolean {
  return hasCommand(name) && runEngineCommand(ed.engine, name, args) === Status.OK;
}

// ---- The engine's component read (E6) ---------------------------------------------------------------------------

export interface EngineComponentProperty {
  id: Guid;
  name: string;
  apiName?: string;
  type: ComponentPropType;
  defaultValue: boolean | string | null;
  value: boolean | string | null;
  overridden?: boolean;
  preferredValues?: Guid[];
  variantOptions?: string[];
  boundLayers?: Guid[];
  /** The variable an instance's variant (or a main's default) is bound to. */
  boundVariable?: Guid | null;
}

export interface EngineComponentInfo {
  ref: Guid;
  kind: "COMPONENT" | "VARIANT" | "COMPONENT_SET" | "INSTANCE" | "NESTED_INSTANCE" | "INSTANCE_SUBLAYER" | "COMPONENT_SUBLAYER" | "NONE";
  main: { ref: Guid; name: string; page: Guid | null; set: Guid | null; softDeleted: boolean } | null;
  instance: Guid | null;
  path: Guid[];
  overrides: { ref: Guid; fields: string[] }[];
  properties: EngineComponentProperty[];
  exposedInstances: { ref: Guid; name: string; properties: EngineComponentProperty[] }[];
  variantProperties: Record<string, string> | null;
  canPush: boolean;
  canReset: boolean;
  canDetach: boolean;
  isExposed: boolean;
  mainDeleted: boolean;
  instanceCount: number;
}

/**
 * `engine.componentInfo(ref)` when the build has it (E6), else undefined (null: the engine says nothing). Read once
 * per (ref, document version) through the ComponentIndex: the instance header, its properties, the bind button,
 * the command states and the Reset ▸ menu all ask for the same instance in one render (five reads of a whole-
 * document walk per render was most of a variant instance's selection cost).
 */
export function engineInfo(ed: EditorController, ref: Guid): EngineComponentInfo | null | undefined {
  return ed.components.info(ref);
}

/** The engine's property value as the schema's ComponentPropValue. */
export function toPropValue(type: ComponentPropType, v: boolean | string | null | undefined): ComponentPropValue | undefined {
  if (v === null || v === undefined) return undefined;
  if (type === "BOOL") return { boolValue: v === true || v === "true" };
  if (type === "INSTANCE_SWAP" || type === "SLOT") return typeof v === "string" && v.includes(":") ? { guidValue: guidVal(v) } : undefined;
  return { textValue: { characters: String(v) } };
}

/** A ComponentPropValue as the engine's command argument (boolean, text, a GUID string). */
export function fromPropValue(type: ComponentPropType, v: ComponentPropValue | undefined): boolean | string | undefined {
  if (!v) return undefined;
  if (type === "BOOL") return v.boolValue !== false;
  if (type === "INSTANCE_SWAP" || type === "SLOT") return v.guidValue ? guidStr(v.guidValue) : undefined;
  return v.textValue?.characters ?? "";
}

/** The engine's property as a def (what the panel edits through). */
function defFromEngine(p: EngineComponentProperty): ComponentPropDef {
  return {
    id: guidVal(p.id),
    name: p.name,
    type: p.type,
    initialValue: toPropValue(p.type, p.defaultValue),
    preferredValues: p.preferredValues?.length ? { instanceSwapValues: p.preferredValues.map((key) => ({ type: "COMPONENT" as const, key })) } : undefined,
  };
}

// ---- Reads -------------------------------------------------------------------------------------------------------

/** One node with its real type and its component fields (null: missing). */
export function readC(ed: EditorController, id: Guid): CNode | null {
  if (!id || ed.engine.destroyed) return null;
  const n = ed.store.readNode(id) ?? ed.engine.readNode(id);
  return n ? (ed.withRealType(n) as CNode) : null;
}

/** The page a node is on (null: not on a page — the internal canvas, or missing). */
export function pageOf(ed: EditorController, id: Guid): Guid | null {
  let n = readC(ed, id);
  for (let depth = 0; n && depth < 512; depth++) {
    if (n.type === "CANVAS") return n.internalOnly ? null : n.guid;
    const parent = n.parentIndex?.guid;
    n = parent ? readC(ed, parent) : null;
  }
  return null;
}

/** The node's ancestors (nearest first), up to and without the page. */
export function ancestors(ed: EditorController, id: Guid): CNode[] {
  const out: CNode[] = [];
  let n = readC(ed, id);
  for (let depth = 0; n && depth < 512; depth++) {
    const parent = n.parentIndex?.guid ? readC(ed, n.parentIndex.guid) : null;
    if (!parent || parent.type === "CANVAS" || parent.type === "DOCUMENT") break;
    out.push(parent);
    n = parent;
  }
  return out;
}

/** The component an instance shows (its swap for a nested one), or null when it is missing. */
export function mainOf(ed: EditorController, instance: CNode): CNode | null {
  const id = guidStr(instance.overriddenSymbolID) || guidStr(instance.symbolData?.symbolID);
  return id ? readC(ed, id) : null;
}

/** A component's set (the state group it is a variant of), or null. */
export function setOf(ed: EditorController, component: CNode | null): CNode | null {
  if (!component || !isComponent(component)) return null;
  const parent = component.parentIndex?.guid ? readC(ed, component.parentIndex.guid) : null;
  return isComponentSet(parent) ? parent : null;
}

/** A set's variants (its SYMBOL children). */
export function variantsOf(ed: EditorController, set: CNode): CNode[] {
  const withKids = ed.engine.readNodes([set.guid], { childIds: true })[0];
  return (withKids?.childIds ?? []).map((id) => readC(ed, id)).filter((n): n is CNode => isComponent(n));
}

/** Where a component's properties are defined: the set for a variant, else the component itself. */
export function definer(ed: EditorController, component: CNode): CNode {
  return setOf(ed, component) ?? component;
}

/**
 * The component a layer sits in and where its properties live, for binding: the nearest SYMBOL ancestor (the
 * layer itself excluded) and its definer. Null for layers outside components and for instance sublayers.
 */
export function owningComponent(ed: EditorController, layer: CNode): { component: CNode; definer: CNode } | null {
  if (parseDerivedId(layer.guid)) return null;
  for (const a of ancestors(ed, layer.guid)) {
    if (isInstance(a)) return null;
    if (isComponent(a)) return { component: a, definer: definer(ed, a) };
  }
  return null;
}

/** The subtree's nodes (the root included), real ones only. */
export function subtree(ed: EditorController, root: Guid, limit = 5000): CNode[] {
  const out: CNode[] = [];
  let level: Guid[] = [root];
  while (level.length && out.length < limit) {
    const read = ed.engine.readNodes(level, { childIds: true });
    const next: Guid[] = [];
    for (const n of read) {
      out.push(ed.withRealType(n) as CNode);
      next.push(...(n.childIds ?? []));
    }
    level = next;
  }
  return out;
}

// ---- The file's components ---------------------------------------------------------------------------------------

/** NODES_CHANGED field groups that can change what `componentInfo` says before the change commits (engine.md §10.4). */
const COMPONENT_GROUPS = 64 | 128; // G_COMPONENT | G_BINDINGS

/** The file's local components on its pages, read again after any change (Assets, the instance menu, swaps). */
export class ComponentIndex {
  private cache: { version: number; assets: ComponentAsset[] } | null = null;
  private version = 0;
  /** `engine.componentInfo` per ref, valid for one document version (and dropped by a live component-group change). */
  private infoCache = new Map<Guid, EngineComponentInfo | null>();
  private infoVersion = -1;
  private readonly offs: (() => void)[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(private readonly ed: EditorController) {
    const bump = () => {
      this.version++;
      this.listeners.forEach((l) => l());
    };
    this.offs.push(
      ed.engine.on("DOCUMENT_CHANGED", bump),
      ed.store.subscribe("structure", bump),
      ed.store.subscribe("pages", bump),
      ed.engine.on("NODES_CHANGED", (e) => {
        // A live change to properties or bindings (before its commit): the next read asks the engine again. A move
        // or a resize (GEOMETRY / LAYOUT) changes nothing an instance's panel shows until it commits.
        if (e.fieldGroupMask.some((m) => (m & COMPONENT_GROUPS) !== 0)) this.infoCache.clear();
      }),
      // E6: instances re-derived (a main's change reaching them); navigation clears the pill when the engine returns.
      ed.engine.onAny((e) => {
        const type = (e as { type: string }).type;
        if (type === "COMPONENTS_CHANGED") bump();
        if (type === "INSTANCE_NAVIGATION" && !(e as { returnTo?: string | null }).returnTo) ed.ui.set({ returnToInstance: null });
      })
    );
  }

  dispose(): void {
    this.offs.splice(0).forEach((off) => off());
    this.listeners.clear();
    this.infoCache.clear();
  }

  readonly subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  readonly getVersion = (): number => this.version;

  /**
   * `engine.componentInfo(ref)` (E6), read once per document version per ref; undefined when the build has no such
   * read, null when the engine says nothing about the ref.
   */
  info(ref: Guid): EngineComponentInfo | null | undefined {
    const read = engineMethod<(ref: Guid) => EngineComponentInfo | null>(this.ed.engine, "componentInfo");
    if (!read || this.ed.engine.destroyed) return undefined;
    if (this.infoVersion !== this.version) {
      this.infoCache.clear();
      this.infoVersion = this.version;
    }
    const cached = this.infoCache.get(ref);
    if (cached !== undefined || this.infoCache.has(ref)) return cached ?? null;
    const info = read(ref);
    this.infoCache.set(ref, info);
    return info;
  }

  /** Forgets the cached component reads (a write inside an open step, before its DOCUMENT_CHANGED). */
  invalidateInfo(): void {
    this.infoCache.clear();
  }

  /** Every local component and set on the file's pages (variants are reached through their set). */
  assets(): ComponentAsset[] {
    if (this.cache?.version === this.version) return this.cache.assets;
    const ed = this.ed;
    const assets: ComponentAsset[] = [];
    const indexed = ed.engine.destroyed ? null : this.assetsFromIndex();
    if (indexed) assets.push(...indexed);
    else if (!ed.engine.destroyed) {
      for (const page of ed.store.pages) {
        const walk = (ids: Guid[], frame: CNode | null) => {
          if (!ids.length) return;
          for (const raw of ed.engine.readNodes(ids, { childIds: true })) {
            const n = ed.withRealType(raw) as CNode;
            const top = frame ?? (n.type === "FRAME" && !isComponentSet(n) && n.parentIndex?.guid === page.guid ? n : null);
            if (isComponentSet(n)) {
              const variants = variantsOf(ed, n);
              const first = defaultVariant(variants);
              if (first) assets.push(asset(n, "set", first.guid, page, frame, variants.length));
              continue;
            }
            if (isComponent(n)) {
              if (!n.isSoftDeleted) assets.push(asset(n, "component", n.guid, page, frame));
              continue; // components inside components are reached by their own instances, not listed
            }
            if (isInstance(n)) continue;
            walk(raw.childIds ?? [], top);
          }
        };
        walk(ed.engine.readNodes([page.guid], { childIds: true })[0]?.childIds ?? [], null);
      }
    }
    this.cache = { version: this.version, assets };
    return assets;
  }

  /**
   * The assets from the engine's asset index (`localAssets`, docs/engine-build.md "E6 libraries API": every local
   * component and set with the page and top-level frame it sits in) — no walk over the document. Null without it.
   */
  private assetsFromIndex(): ComponentAsset[] | null {
    const ed = this.ed;
    const read = engineCall<() => { id: Guid; kind: string; name: string; description: string; key: string; componentSetId?: Guid; softDeleted: boolean; containingFrame: { pageId: Guid; pageName: string; frameId?: Guid; frameName?: string } | null }[]>(ed.engine, "localAssets", "local_assets");
    if (!read) return null;
    const infos = read().filter((a) => (a.kind === "COMPONENT" || a.kind === "COMPONENT_SET") && !a.softDeleted && a.containingFrame);
    const out: ComponentAsset[] = [];
    const variantsOfSet = new Map<Guid, number>();
    for (const a of infos) if (a.kind === "COMPONENT" && a.componentSetId) variantsOfSet.set(a.componentSetId, (variantsOfSet.get(a.componentSetId) ?? 0) + 1);
    for (const a of infos) {
      const where = a.containingFrame!;
      const page = { guid: where.pageId, name: where.pageName };
      const frame = where.frameId ? ({ guid: where.frameId, name: where.frameName ?? "" } as CNode) : null;
      if (a.kind === "COMPONENT_SET") {
        const set = readC(ed, a.id);
        if (!set) continue;
        const first = defaultVariant(variantsOf(ed, set));
        if (first) out.push(asset({ ...set, name: a.name, description: a.description, key: a.key || set.key } as CNode, "set", first.guid, page, frame, variantsOfSet.get(a.id) ?? 0));
        continue;
      }
      if (a.componentSetId) continue; // a variant: reached through its set
      out.push({ id: a.id, name: a.name, kind: "component", target: a.id, page: page.guid, pageName: page.name, frame: frame?.guid ?? null, frameName: frame?.name ?? null, description: a.description || undefined, key: a.key || undefined });
    }
    return out;
  }

  /** The asset a component belongs to (its own, or its set's). */
  assetOf(component: Guid): ComponentAsset | null {
    const n = readC(this.ed, component);
    const set = setOf(this.ed, n);
    const id = set?.guid ?? component;
    return this.assets().find((a) => a.id === id) ?? null;
  }
}

function asset(n: CNode, kind: "component" | "set", target: Guid, page: { guid: Guid; name: string }, frame: CNode | null, variantCount?: number): ComponentAsset {
  return {
    id: n.guid,
    name: n.name ?? "",
    kind,
    target,
    page: page.guid,
    pageName: page.name,
    frame: frame?.guid ?? null,
    frameName: frame?.name ?? null,
    description: n.description,
    key: n.key,
    variantCount,
  };
}

// ---- Instance children in Layers (until the engine materializes them) ---------------------------------------------

export interface DerivedRow {
  id: Guid;
  parent: Guid;
  node: CNode;
  children: Guid[];
}

/**
 * An instance's sublayers as Layers shows them, derived from its main component (docs/schema.md §5.1: ids
 * `I<instance>;<key>…`), names and visibility after the instance's overrides. Used only when the engine lists no
 * children for the instance (E6 materializes them itself). Nested instances recurse (depth 16).
 */
export function deriveInstanceRows(read: (ids: Guid[]) => CNode[], instance: CNode, depth = 0, path: GuidValue[] = [], root: CNode = instance, out: DerivedRow[] = []): Guid[] {
  const mainId = guidStr(instance.overriddenSymbolID) || guidStr(instance.symbolData?.symbolID);
  if (!mainId || depth > 16) return [];
  const [main] = read([mainId]);
  if (!main) return [];
  const kids = main.childIds ?? [];
  const parentId = path.length ? derivedId(root.guid, path) : root.guid;
  const ids: Guid[] = [];
  for (const child of read(kids)) {
    const p = [...path, effectiveKey(child)];
    const id = derivedId(root.guid, p);
    const o = overrideAt(root.symbolData, p);
    const node: CNode = { ...child, guid: id, ...(typeof o?.name === "string" ? { name: o.name } : {}), ...(typeof o?.visible === "boolean" ? { visible: o.visible } : {}) };
    const row: DerivedRow = { id, parent: parentId, node, children: [] };
    out.push(row);
    ids.push(id);
    if (isInstance(child)) row.children = deriveInstanceRows(read, child, depth + 1, p, root, out);
    else row.children = deriveChildren(read, child, depth + 1, p, root, out);
  }
  return ids;
}

function deriveChildren(read: (ids: Guid[]) => CNode[], node: CNode, depth: number, path: GuidValue[], root: CNode, out: DerivedRow[]): Guid[] {
  const kids = node.childIds ?? [];
  if (!kids.length || depth > 64) return [];
  const parentId = derivedId(root.guid, path);
  const ids: Guid[] = [];
  for (const child of read(kids)) {
    const p = [...path, effectiveKey(child)];
    const id = derivedId(root.guid, p);
    const o = overrideAt(root.symbolData, p);
    const derived: CNode = { ...child, guid: id, ...(typeof o?.name === "string" ? { name: o.name } : {}), ...(typeof o?.visible === "boolean" ? { visible: o.visible } : {}) };
    const row: DerivedRow = { id, parent: parentId, node: derived, children: [] };
    out.push(row);
    ids.push(id);
    row.children = isInstance(child) ? deriveInstanceRows(read, child, depth + 1, p, root, out) : deriveChildren(read, child, depth + 1, p, root, out);
  }
  return ids;
}

// ---- Instance properties (the Design panel) ------------------------------------------------------------------------

export interface PropertyRowData {
  def: ComponentPropDef;
  value: ComponentPropValue | undefined;
  /** Variant: the values to pick from */
  options?: string[];
  /** Variant: the current one */
  variantValue?: string;
  /** The variable that picks the variant (an instance's "Assign variable") or binds the default (a main's) */
  variable?: Guid | null;
}

export interface InstanceInfo {
  /** The selected instance (a real node or a derived sublayer) */
  instance: CNode;
  main: CNode | null;
  set: CNode | null;
  /** Variant properties first, then the rest (R4 §6) */
  rows: PropertyRowData[];
  /** Nested instances the main exposes ("Exposed nested instances"): each with its own rows */
  nested: { id: Guid; path: GuidValue[]; name: string; info: InstanceInfo }[];
}

/** What the instance panel shows for `instance` (exposed nested instances one level down, as Figma lists them). */
export function instanceInfo(ed: EditorController, instance: CNode, nestedDepth = 0): InstanceInfo {
  const info = engineInfo(ed, instance.guid);
  if (info) {
    const main = info.main ? readC(ed, info.main.ref) : mainOf(ed, instance);
    const set = info.main?.set ? readC(ed, info.main.set) : setOf(ed, main);
    const rows = (props: EngineComponentProperty[]): PropertyRowData[] => {
      const variant = props.filter((p) => p.type === "VARIANT");
      const rest = props.filter((p) => p.type !== "VARIANT");
      return [
        ...variant.map((p) => ({ def: defFromEngine(p), value: undefined, options: p.variantOptions ?? [], variantValue: typeof p.value === "string" ? p.value : undefined, variable: p.boundVariable ?? null })),
        ...rest.map((p) => ({ def: defFromEngine(p), value: toPropValue(p.type, p.value), variable: p.boundVariable ?? null })),
      ];
    };
    const nested = info.exposedInstances.map((x) => {
      const node = readC(ed, x.ref) ?? ({ guid: x.ref, type: "INSTANCE", name: x.name } as CNode);
      return { id: x.ref, path: parseDerivedId(x.ref)?.path ?? [], name: x.name, info: { instance: node, main: mainOf(ed, node), set: null, rows: rows(x.properties), nested: [] } };
    });
    return { instance, main, set, rows: rows(info.properties), nested };
  }
  const main = mainOf(ed, instance);
  const set = setOf(ed, main);
  const defs = (set ?? main)?.componentPropDefs ?? [];
  const rows: PropertyRowData[] = [];
  if (set && main) {
    const variants = variantsOf(ed, set);
    const current = variantValues(main, defs);
    for (const p of variantProperties(set, variants)) {
      const def = p.def ?? { id: { sessionID: 0, localID: 0 }, name: p.name, type: "VARIANT" as const };
      rows.push({ def, value: undefined, options: p.values, variantValue: current.get(p.name) });
    }
  }
  for (const def of defs) if (def.type !== "VARIANT") rows.push({ def, value: assignedValue(def, instance.componentPropAssignments) });
  const nested: InstanceInfo["nested"] = [];
  if (main && nestedDepth < 1) {
    const root = parseDerivedId(instance.guid);
    const rootId = root?.instance ?? instance.guid;
    const basePath = root?.path ?? [];
    const rootNode = root ? readC(ed, rootId) : instance;
    for (const n of subtree(ed, main.guid).slice(1)) {
      if (!isInstance(n) || !n.propsAreBubbled) continue;
      const path = [...basePath, ...pathInside(ed, main.guid, n)];
      const entry = overrideAt(rootNode?.symbolData, path);
      const id = derivedId(rootId, path);
      const live = readC(ed, id);
      const view: CNode = live ?? {
        ...n,
        guid: id,
        ...(entry?.overriddenSymbolID ? { overriddenSymbolID: entry.overriddenSymbolID as GuidValue } : {}),
        componentPropAssignments: (entry?.componentPropAssignments as CNode["componentPropAssignments"]) ?? n.componentPropAssignments,
      };
      nested.push({ id, path, name: n.name ?? "", info: instanceInfo(ed, view, nestedDepth + 1) });
    }
  }
  return { instance, main, set, rows, nested };
}

/** The key path from a component down to one of its nodes (keys of every node below the component). */
function pathInside(ed: EditorController, componentId: Guid, node: CNode): GuidValue[] {
  const chain = [node, ...ancestors(ed, node.guid)];
  const out: GuidValue[] = [];
  for (const n of chain) {
    if (n.guid === componentId) break;
    out.unshift(effectiveKey(n));
  }
  return out;
}

// ---- Writes ---------------------------------------------------------------------------------------------------------

/**
 * Writes `fields` on an instance or one of its sublayers: a real node through the setter; a derived one through
 * the engine when it takes derived refs (E6), else as an override entry of the top instance's `symbolData`.
 */
export function writeOn(ed: EditorController, ref: Guid, fields: Record<string, unknown>): void {
  const derived = parseDerivedId(ref);
  if (!derived) {
    ed.engine.setProps([ref], asFields(fields));
    return;
  }
  if (readC(ed, ref) && ed.engine.setProps([ref], asFields(fields)) === Status.OK) return;
  const top = readC(ed, derived.instance);
  if (!top?.symbolData) return;
  ed.engine.setProps([top.guid], asFields({ symbolData: withOverride(top.symbolData, derived.path, fields) }));
}

/** An instance's value for a property (Boolean, Text, Instance swap), as one undo step. */
export function setPropertyValue(ed: EditorController, instance: CNode, def: ComponentPropDef, value: ComponentPropValue): void {
  const v = fromPropValue(def.type, value);
  if (v !== undefined && engineDid(ed, COMPONENT_COMMAND.setProperty, { ref: instance.guid, prop: guidStr(def.id), value: v })) return;
  ed.batch(`Set ${def.name}`, () => {
    writeOn(ed, instance.guid, { componentPropAssignments: withAssignment(instance.componentPropAssignments, def, value) });
  });
}

/** A variant property's value: the instance switches to the variant with it (keeping the others where one does). */
export function setVariant(ed: EditorController, instance: CNode, property: string, value: string): boolean {
  if (engineDid(ed, COMPONENT_COMMAND.setProperty, { ref: instance.guid, prop: property, value })) return true;
  const main = mainOf(ed, instance);
  const set = setOf(ed, main);
  if (!main || !set) return false;
  const target = variantFor(main, variantsOf(ed, set), set.componentPropDefs ?? [], property, value);
  if (!target || target.guid === main.guid) return false;
  swapInstance(ed, [instance.guid], target.guid, `Set ${property}`);
  return true;
}

/**
 * "Assign variable" on an instance's variant property (R3-13, help "Modes for variables"): a string, number or boolean
 * variable picks the variant in every mode (null: detach). On a main's boolean / text property: its default ("Apply
 * variable" in the property's settings). One step.
 */
export function bindPropertyVariable(ed: EditorController, ref: Guid, property: string, variable: Guid | null): boolean {
  const args = { refs: [ref], target: `componentProperties.${property}`, variable: variable ?? "" };
  return runEngineCommand(ed.engine, "BIND_VARIABLE", args) === Status.OK;
}

/**
 * Reorders a property in the Properties section (help "Create and use component properties": hover, drag by the
 * handle): before `before` (null: last) within its own group — variant properties always stay above the others.
 */
export function reorderProperty(ed: EditorController, owner: CNode, def: ComponentPropDef, before: ComponentPropDef | null): void {
  const all = sortedDefs(owner.componentPropDefs ?? []);
  const isVariant = def.type === "VARIANT";
  const group = all.filter((d) => (d.type === "VARIANT") === isVariant && guidStr(d.id) !== guidStr(def.id));
  if (before && (before.type === "VARIANT") !== isVariant) return;
  const at = before ? group.findIndex((d) => guidStr(d.id) === guidStr(before.id)) : group.length;
  if (at < 0) return;
  // Every property of the owner gets a position in order (old files may lack them), the moved one at its new place.
  const order = [...group.slice(0, at), def, ...group.slice(at)];
  const others = all.filter((d) => (d.type === "VARIANT") !== isVariant);
  const sequence = isVariant ? [...order, ...others] : [...others, ...order];
  let pos = "";
  const positions = new Map<string, string>();
  for (const d of sequence) {
    pos = positionBetween(pos, null);
    positions.set(guidStr(d.id), pos);
  }
  const defs = (owner.componentPropDefs ?? []).map((d) => ({ ...d, sortPosition: positions.get(guidStr(d.id)) ?? d.sortPosition }));
  ed.setProps([owner.guid], asFields({ componentPropDefs: defs }), "Reorder properties");
}

/** A slot property's settings (help "Use slots": min / max layers, preferred instances only, empty, fill items). */
export function updateSlotSettings(ed: EditorController, owner: CNode, def: ComponentPropDef, patch: NonNullable<ComponentPropDef["slotPropConfig"]>): void {
  const defs = (owner.componentPropDefs ?? []).map((d) => (guidStr(d.id) === guidStr(def.id) ? { ...d, slotPropConfig: { ...(d.slotPropConfig ?? {}), ...patch } } : d));
  ed.setProps([owner.guid], asFields({ componentPropDefs: defs }), "Edit slot property");
}

/** The instance's root fields a swap brings from the new main (unless the instance overrode them). */
const SWAP_ROOT_FIELDS = ["name", "size"] as const;

/**
 * Swap instance (the instance menu, an Instance swap property, a variant switch): the engine's SWAP_INSTANCE on
 * the selection when it has it; else `symbolData.symbolID` (a nested one: its `overriddenSymbolID` override),
 * the overrides kept as they are.
 */
export function swapInstance(ed: EditorController, refs: readonly Guid[], component: Guid, label = "Swap instance"): void {
  const target = readC(ed, component);
  if (!target || !isComponent(target) || !refs.length) return;
  if (hasCommand(COMPONENT_COMMAND.swap)) {
    // One command per instance (each its own undo step): the engine keeps overrides by Figma's heuristics.
    const done = refs.filter((ref) => engineDid(ed, COMPONENT_COMMAND.swap, { main: component, ref }));
    if (done.length === refs.length) return;
  }
  ed.batch(label, () => {
    for (const ref of refs) {
      const n = readC(ed, ref);
      if (!n || !isInstance(n)) continue;
      if (parseDerivedId(ref)) {
        writeOn(ed, ref, { overriddenSymbolID: guidVal(component) });
        continue;
      }
      const sd: SymbolData = { ...(n.symbolData ?? {}), symbolID: guidVal(component) };
      const rootOverride = overrideAt(n.symbolData, []) ?? {};
      const fields: Record<string, unknown> = { symbolData: sd };
      for (const f of SWAP_ROOT_FIELDS) if (!(f in rootOverride) && target[f] !== undefined) fields[f] = target[f];
      ed.engine.setProps([ref], asFields(fields));
    }
  });
}

/** Reset all changes (`fields` null) or Reset ▸ one group: the engine's RESET_OVERRIDES, else the data rewrite. */
export function resetChanges(ed: EditorController, instance: CNode, fields: string[] | null): void {
  if (hasCommand(COMPONENT_COMMAND.reset)) {
    // The engine resets one field per command (Reset ▸ a group may be several).
    if (!fields ? engineDid(ed, COMPONENT_COMMAND.reset, { ref: instance.guid }) : fields.every((field) => engineDid(ed, COMPONENT_COMMAND.reset, { ref: instance.guid, field }))) return;
  }
  if (parseDerivedId(instance.guid)) return;
  const main = mainOf(ed, instance);
  ed.batch(fields ? `Reset ${changedGroups(instance).find((g) => g.fields.join() === fields.join())?.label ?? "changes"}` : "Reset all changes", () => {
    const out: Record<string, unknown> = {};
    const root = overrideAt(instance.symbolData, []) ?? {};
    if (instance.symbolData) out.symbolData = withoutOverrides(instance.symbolData, fields);
    if (!fields || fields.includes("componentPropAssignments")) out.componentPropAssignments = [];
    // The root's own values come back from the main (the engine re-materializes them once it has E6).
    if (main) for (const f of SWAP_ROOT_FIELDS) if (f in root && (!fields || fields.includes(f)) && main[f] !== undefined) out[f] = main[f];
    ed.engine.setProps([instance.guid], asFields(out));
  });
}

/** What "Reset ▸" lists for an instance: the engine's overrides (every sublayer's) when it reads them, else the data's. */
export function instanceChanges(ed: EditorController, instance: CNode): { label: string; fields: string[] }[] {
  const info = engineInfo(ed, instance.guid);
  if (info) {
    const fields = new Set<string>();
    for (const o of info.overrides) for (const f of o.fields) fields.add(f);
    if (info.properties.some((p) => p.overridden)) fields.add("componentPropAssignments");
    return groupChanges(fields);
  }
  return parseDerivedId(instance.guid) ? [] : changedGroups(instance);
}

// ---- Definitions (the main component's Properties) ------------------------------------------------------------------

const allDefIds = (ed: EditorController, owner: CNode): GuidValue[] => {
  const ids: GuidValue[] = [];
  for (const a of ed.components.assets()) {
    const n = readC(ed, a.id);
    for (const d of n?.componentPropDefs ?? []) ids.push(d.id);
  }
  for (const d of owner.componentPropDefs ?? []) ids.push(d.id);
  return ids;
};

/** Can a property of `type` be added here? (Variant needs a set — Figma turns a component into one, the engine's job.) */
export function canAddProperty(ed: EditorController, owner: CNode, type: ComponentPropType): boolean {
  if (type === "VARIANT") return isComponentSet(owner) || hasCommand(COMPONENT_COMMAND.addProperty);
  return isComponent(owner) || isComponentSet(owner);
}

/**
 * Adds a property to a component or set (one undo step) and returns it. A Variant property on a set gives every
 * variant the default value in its name; on a lone component the engine makes it a set first (Combine as variants).
 */
export function addProperty(ed: EditorController, owner: CNode, type: ComponentPropType, options: { name?: string; value?: ComponentPropValue; bind?: { layer: CNode; field: BindableField } } = {}): ComponentPropDef | null {
  const name = options.name?.trim() || newPropertyName(owner.componentPropDefs ?? []);
  if (hasCommand(COMPONENT_COMMAND.addProperty)) {
    const before = new Set((owner.componentPropDefs ?? []).map((d) => guidStr(d.id)));
    const args: CommandArgs = { ref: owner.guid, name, type };
    const value = fromPropValue(type, options.value);
    if (value !== undefined) args.defaultValue = value;
    if (options.bind) args.bind = [options.bind.layer.guid];
    if (engineDid(ed, COMPONENT_COMMAND.addProperty, args)) {
      // A Variant property on a lone component made it a set: its defs are the set's now.
      const fresh = readC(ed, owner.guid);
      const where = fresh && isComponent(fresh) ? definer(ed, fresh) : fresh;
      return (where?.componentPropDefs ?? []).find((d) => !before.has(guidStr(d.id)) && d.name === name) ?? null;
    }
  }
  let target = owner;
  if (type === "VARIANT" && !isComponentSet(owner)) {
    if (!isComponent(owner) || runEngineCommand(ed.engine, COMPONENT_COMMAND.combine) !== Status.OK) return null;
    const made = setOf(ed, readC(ed, owner.guid));
    if (!made) return null;
    target = made;
  }
  const defs = target.componentPropDefs ?? [];
  const id = nextDefId(ed.source.sessionID ?? 1, allDefIds(ed, target));
  const def = newPropertyDef(type, id, name, options.value);
  ed.batch(`Create ${type === "BOOL" ? "boolean" : type === "INSTANCE_SWAP" ? "instance swap" : type.toLowerCase()} property`, () => {
    ed.engine.setProps([target.guid], asFields({ componentPropDefs: [...defs, def] }));
    if (type === "VARIANT") {
      const value = def.initialValue?.textValue?.characters ?? "Default";
      for (const v of variantsOf(ed, target)) {
        const pairs = parseVariantName(v.name ?? "") ?? [];
        ed.engine.setProps([v.guid], asFields({ name: formatVariantName([...pairs, [def.name, value]]), variantPropSpecs: [...(v.variantPropSpecs ?? []), { propDefId: def.id, value }] }));
      }
    }
    if (options.bind) ed.engine.setProps([options.bind.layer.guid], asFields({ parameterConsumptionMap: withBinding(options.bind.layer, options.bind.field, def) }));
  });
  return def;
}

/** Edits a property: its name (a variant property's also in every variant's name), default, preferred values. */
export function updateProperty(ed: EditorController, owner: CNode, def: ComponentPropDef, patch: Partial<Pick<ComponentPropDef, "name" | "initialValue" | "preferredValues" | "description">>, label = "Edit property"): void {
  if (hasCommand(COMPONENT_COMMAND.editProperty) && patch.description === undefined) {
    const args: CommandArgs = { ref: owner.guid, prop: def.type === "VARIANT" ? def.name : guidStr(def.id) };
    if (patch.name !== undefined) args.name = patch.name;
    const value = fromPropValue(def.type, patch.initialValue);
    if (value !== undefined) args.defaultValue = value;
    if (patch.preferredValues) args.preferredValues = (patch.preferredValues.instanceSwapValues ?? []).map((p) => p.key);
    if (engineDid(ed, COMPONENT_COMMAND.editProperty, args)) return;
  }
  const defs = (owner.componentPropDefs ?? []).map((d) => (sameGuid(d.id, def.id) ? { ...d, ...patch } : d));
  ed.batch(label, () => {
    const extra: Record<string, unknown> = {};
    if (def.type === "VARIANT" && patch.name && patch.name !== def.name && isComponentSet(owner)) {
      for (const v of variantsOf(ed, owner)) {
        const name = renameInVariantName(v.name ?? "", def.name, { property: patch.name });
        if (name) ed.engine.setProps([v.guid], asFields({ name }));
      }
      if (owner.stateGroupPropertyValueOrders) extra.stateGroupPropertyValueOrders = owner.stateGroupPropertyValueOrders.map((o) => (o.property === def.name ? { ...o, property: patch.name } : o));
    }
    ed.engine.setProps([owner.guid], asFields({ componentPropDefs: defs, ...extra }));
  });
}

/** Renames one value of a variant property in every variant that has it. */
export function renameVariantValue(ed: EditorController, set: CNode, property: string, from: string, to: string): void {
  if (engineDid(ed, COMPONENT_COMMAND.editProperty, { ref: set.guid, prop: property, oldValue: from, newValue: to })) return;
  const def = set.componentPropDefs?.find((d) => d.type === "VARIANT" && d.name === property);
  ed.batch("Rename value", () => {
    for (const v of variantsOf(ed, set)) {
      const name = renameInVariantName(v.name ?? "", property, { value: [from, to] });
      if (!name) continue;
      const specs = (v.variantPropSpecs ?? []).map((s) => (def && sameGuid(s.propDefId, def.id) && s.value === from ? { ...s, value: to } : s));
      ed.engine.setProps([v.guid], asFields({ name, variantPropSpecs: specs }));
    }
    if (set.stateGroupPropertyValueOrders)
      ed.engine.setProps([set.guid], asFields({ stateGroupPropertyValueOrders: set.stateGroupPropertyValueOrders.map((o) => (o.property === property ? { ...o, values: o.values.map((x) => (x === from ? to : x)) } : o)) }));
  });
}

/** A variant's own value for a property (its name and spec): "Current variant" in the panel. */
export function setVariantValueOf(ed: EditorController, variant: CNode, set: CNode, property: string, value: string): void {
  const def = set.componentPropDefs?.find((d) => d.type === "VARIANT" && d.name === property);
  const pairs = parseVariantName(variant.name ?? "") ?? [];
  const next = pairs.some(([k]) => k === property) ? pairs.map(([k, v]) => [k, k === property ? value : v] as [string, string]) : [...pairs, [property, value] as [string, string]];
  const specs = def ? [...(variant.variantPropSpecs ?? []).filter((s) => !sameGuid(s.propDefId, def.id)), { propDefId: def.id, value }] : variant.variantPropSpecs;
  ed.setProps([variant.guid], asFields({ name: formatVariantName(next), ...(specs ? { variantPropSpecs: specs } : {}) }), `Set ${property}`);
}

/** Deletes a property: its definition and every binding to it in the component (variant values leave the names). */
export function deleteProperty(ed: EditorController, owner: CNode, def: ComponentPropDef): boolean {
  const defs = owner.componentPropDefs ?? [];
  if (def.type === "VARIANT" && defs.filter((d) => d.type === "VARIANT").length <= 1) return false;
  if (engineDid(ed, COMPONENT_COMMAND.deleteProperty, { ref: owner.guid, prop: def.type === "VARIANT" ? def.name : guidStr(def.id) })) return true;
  ed.batch("Delete property", () => {
    ed.engine.setProps([owner.guid], asFields({ componentPropDefs: defs.filter((d) => !sameGuid(d.id, def.id)) }));
    const roots = isComponentSet(owner) ? variantsOf(ed, owner) : [owner];
    for (const r of roots) {
      const nodes = subtree(ed, r.guid);
      for (const u of unbindAll(nodes, def)) ed.engine.setProps([u.guid], asFields({ parameterConsumptionMap: u.parameterConsumptionMap }));
      if (def.type === "VARIANT") {
        const pairs = (parseVariantName(r.name ?? "") ?? []).filter(([k]) => k !== def.name);
        ed.engine.setProps([r.guid], asFields({ name: formatVariantName(pairs), variantPropSpecs: (r.variantPropSpecs ?? []).filter((s) => !sameGuid(s.propDefId, def.id)) }));
      }
    }
  });
  return true;
}

/** Binds (or, with null, detaches) a layer's field to a property of its component. */
export function bindLayer(ed: EditorController, layer: CNode, field: BindableField, def: ComponentPropDef | null): void {
  if (field !== "SLOT_CONTENT_ID" && engineDid(ed, COMPONENT_COMMAND.bindProperty, { refs: [layer.guid], field, prop: def ? guidStr(def.id) : "" })) return;
  ed.setProps([layer.guid], asFields({ parameterConsumptionMap: withBinding(layer, field, def) }), def ? "Apply property" : "Detach property");
}

/** The property a layer's field is bound to (null: none). */
export function boundProperty(layer: CNode, field: BindableField, defs: readonly ComponentPropDef[]): ComponentPropDef | null {
  const id = bindingsOf(layer).get(field);
  return id ? (defs.find((d) => sameGuid(d.id, id)) ?? null) : null;
}

/** Exposes (or hides) a nested instance's properties on the component's instances ("Exposed nested instances"). */
export function setExposed(ed: EditorController, nested: CNode, exposed: boolean): void {
  if (engineDid(ed, COMPONENT_COMMAND.expose, { ref: nested.guid, exposed })) return;
  ed.setProps([nested.guid], asFields({ propsAreBubbled: exposed }), exposed ? "Expose properties" : "Hide properties");
}

/** The nested instances inside a component (or a set's variants) that can expose their properties. */
export function nestedInstancesOf(ed: EditorController, owner: CNode): CNode[] {
  const roots = isComponentSet(owner) ? variantsOf(ed, owner) : [owner];
  const out: CNode[] = [];
  for (const r of roots) {
    const nodes = subtree(ed, r.guid).slice(1);
    const inside = new Set<Guid>();
    for (const n of nodes) {
      const parent = n.parentIndex?.guid ?? "";
      if (inside.has(parent)) {
        inside.add(n.guid);
        continue;
      }
      if (isInstance(n)) {
        out.push(n);
        inside.add(n.guid);
      }
    }
  }
  return out;
}

export function setDescription(ed: EditorController, owner: CNode, description: string): void {
  ed.setProps([owner.guid], asFields({ description }), "Edit description");
}

// ---- Navigation -----------------------------------------------------------------------------------------------------

/**
 * Go to main component (⌃⌥⌘K): its page, selected and in view; the pill offers "Return to instance". A deleted
 * main offers Restore component instead.
 */
export function goToMainComponent(ed: EditorController, instanceRef: Guid = ed.selection[0]): boolean {
  const instance = readC(ed, instanceRef);
  if (!instance || !isInstance(instance)) return false;
  const main = mainOf(ed, instance);
  if (!main) {
    showToast({ message: "The main component isn't in this file" });
    return false;
  }
  // A library instance: its main lives in the library file (Figma opens that file).
  const lib = libraryOfMain(ed, main.guid);
  if (lib) {
    const name = ed.libraries.get().names.get(lib);
    void openLibraryFile(lib, name).catch(() => showToast({ message: `The main component is in ${name ?? "a library"}` }));
    return true;
  }
  const page = pageOf(ed, main.guid);
  if (page && !main.isSoftDeleted && (ed.engine.readNode(page) as { internalOnly?: boolean } | null)?.internalOnly) {
    // A main copied in from another file (kept on the internal canvas): nothing to show here.
    showToast({ message: "The main component is in another file" });
    return false;
  }
  if (!page || main.isSoftDeleted) {
    showToast({ message: "The main component was deleted", action: hasCommand(COMPONENT_COMMAND.restore) ? { label: "Restore component", onAction: () => void runEngineCommand(ed.engine, COMPONENT_COMMAND.restore, { ref: instanceRef }) } : undefined });
    return false;
  }
  const from = { instance: instanceRef, page: ed.store.page, camera: ed.engine.getCamera() };
  if (engineDid(ed, COMPONENT_COMMAND.goToMain, { ref: instanceRef })) {
    ed.ui.set({ returnToInstance: from });
    return true;
  }
  showComponent(ed, main.guid, page);
  ed.ui.set({ returnToInstance: from });
  return true;
}

/** A component (or a set) on its page: the page shown, it selected and zoomed into view. */
function showComponent(ed: EditorController, id: Guid, page: Guid): void {
  if (page !== ed.store.page) ed.engine.setCurrentPage(page);
  ed.engine.setSelection([id]);
  ed.engine.command("ZOOM_TO_SELECTION");
}

/**
 * Go to main component from Assets (a local component or set, not an instance): its page, selected and zoomed into
 * view. False when it isn't on a page of this file.
 */
export function goToComponent(ed: EditorController, id: Guid): boolean {
  const n = readC(ed, id);
  const page = n ? pageOf(ed, id) : null;
  if (!n || !page || n.isSoftDeleted || (ed.engine.readNode(page) as { internalOnly?: boolean } | null)?.internalOnly) return false;
  showComponent(ed, id, page);
  return true;
}

/** "Return to instance": the instance's page, the camera there before, the instance selected. */
export function returnToInstance(ed: EditorController): void {
  const back = ed.ui.get().returnToInstance;
  ed.ui.set({ returnToInstance: null });
  if (!back) return;
  if (engineDid(ed, COMPONENT_COMMAND.returnToInstance)) return;
  if (back.page !== ed.store.page && ed.store.pages.some((p) => p.guid === back.page)) ed.engine.setCurrentPage(back.page);
  ed.engine.setCamera(back.camera);
  const instance = readC(ed, back.instance) ?? readC(ed, parseDerivedId(back.instance)?.instance ?? "");
  if (instance) ed.engine.setSelection([instance.guid]);
}

// ---- Inserting instances (Assets) ---------------------------------------------------------------------------------

/** Root fields an instance takes from its main (docs/schema.md §5.2: the root's materialized values). */
const NOT_COPIED = new Set([
  "guid", "phase", "parentIndex", "childIds", "transform", "type", "componentPropDefs", "isStateGroup", "stateGroupPropertyValueOrders",
  "variantPropSpecs", "key", "description", "overrideKey", "symbolLinks", "isSymbolPublishable", "isPublishable", "publishedVersion", "parameterConsumptionMap",
  "isSoftDeleted", "ancestorPathBeforeDeletion", "libraryMoveInfo", "sortPosition", "fillGeometry", "strokeGeometry", "derivedSymbolData", "guidPath",
]);

/** The clipboard Message of one instance of `component` with its top-left at `origin` (page px). */
export function instanceMessage(component: CNode, origin: { x: number; y: number }): Message {
  const fields = Object.fromEntries(Object.entries(component).filter(([k, v]) => !NOT_COPIED.has(k) && v !== undefined));
  const node = {
    ...fields,
    guid: "4294967294:1",
    phase: "CREATED",
    type: "INSTANCE",
    name: component.name,
    parentIndex: { guid: "4294967294:0", position: "!" },
    transform: { m00: 1, m01: 0, m02: Math.round(origin.x), m10: 0, m11: 1, m12: Math.round(origin.y) },
    symbolData: { symbolID: guidVal(component.guid), symbolOverrides: [] },
  } as unknown as NodeChange;
  return { type: "NODE_CHANGES", sessionID: 0, nodeChanges: [node], clipboardSelectionRegions: [{ parent: "4294967294:0", nodes: [node.guid], enclosingFrameOffset: { x: 0, y: 0 } }] };
}

/**
 * Inserts an instance of `component` (a component, or a set's default variant): centred on a canvas point (CSS
 * px; a drop from Assets) in the innermost frame there, else in the middle of the view (a click). It goes in as
 * a paste of the INSTANCE node (fresh id, one undo step, selected; the engine materializes it). Returns the new layer.
 */
export function insertInstance(ed: EditorController, component: Guid, at?: { x: number; y: number }): Guid | null {
  const main = readC(ed, component);
  if (!main || !isComponent(main)) return null;
  const canvas = ed.canvas;
  const point = at ?? { x: (canvas?.clientWidth ?? 0) / 2, y: (canvas?.clientHeight ?? 0) / 2 };
  const centre = toPage(ed, point.x, point.y);
  const w = main.size?.x ?? 0;
  const h = main.size?.y ?? 0;
  const frame = at ? frameAt(ed, at.x, at.y) : null;
  ed.engine.setSelection(frame ? [frame] : []);
  const placed = ed.engine.paste(instanceMessage(main, { x: centre.x - w / 2, y: centre.y - h / 2 }), { inPlace: true });
  return placed > 0 ? (ed.selection[0] ?? null) : null;
}

// ---- Selection kinds (menus) ------------------------------------------------------------------------------------------

export function selectionNodes(ed: EditorController): CNode[] {
  return ed.selection.map((id) => readC(ed, id)).filter((n): n is CNode => !!n);
}

/** The one selected instance (a real one or a sublayer), or null. */
export function selectedInstance(ed: EditorController): CNode | null {
  const s = selectionNodes(ed);
  return s.length === 1 && isInstance(s[0]) ? s[0] : null;
}

/** Push changes to main component: the instance itself, a top-level one, its main in this file (R4 §3). */
export function canPushChanges(ed: EditorController): boolean {
  const inst = selectedInstance(ed);
  if (!inst || !hasCommand(COMPONENT_COMMAND.push)) return false;
  // The cached component read answers it; the engine's command state (a walk of the document on older builds) is
  // asked only when the build has no componentInfo.
  const info = engineInfo(ed, inst.guid);
  if (info) return info.canPush;
  if (info === null || !engineCommandEnabled(ed.engine, COMPONENT_COMMAND.push)) return false;
  if (parseDerivedId(inst.guid)) return false;
  const main = mainOf(ed, inst);
  return !!main && !!pageOf(ed, main.guid) && changedGroups(inst).length > 0;
}

/** Every selected layer is a component (Combine as variants needs two or more outside a set). */
export const allComponents = (nodes: readonly CNode[]) => nodes.length > 0 && nodes.every(isComponent);

/** The bindable value for `field` a new property takes from a layer (its visibility, text, main). */
export function valueFromLayer(layer: CNode, type: ComponentPropType): ComponentPropValue | undefined {
  if (type === "BOOL") return { boolValue: layer.visible !== false };
  if (type === "TEXT") return { textValue: { characters: layer.textData?.characters ?? "" } };
  if (type === "INSTANCE_SWAP") {
    const g = layer.overriddenSymbolID ?? layer.symbolData?.symbolID;
    return g ? { guidValue: g } : undefined;
  }
  return undefined;
}

export { isComponent, isComponentSet, isInstance };
