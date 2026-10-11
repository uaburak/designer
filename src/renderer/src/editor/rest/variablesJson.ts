/**
 * `GET /v1/files/:key/variables/local` (docs/multiplayer.md §16.7, developers.figma.com/docs/rest-api/variables-endpoints):
 * the file's collections and variables — its own and the library copies it uses (`remote: true`) — in Figma's shape,
 * extended collections with `isExtension`, their parent and root, the inherited variables and the overrides per mode.
 */
import type { Engine } from "@/engine/Engine";
import type { VariableCollectionInfo, VariableInfo, VariableValue } from "@/engine/codec";
import type { RestVariableValue } from "../../../../shared/rest/types";
import { restCollectionId, restVariableId } from "./ids";

export interface RestVariable {
  id: string;
  name: string;
  key: string;
  variableCollectionId: string;
  resolvedType: string;
  valuesByMode: Record<string, RestVariableValue>;
  remote: boolean;
  description: string;
  hiddenFromPublishing: boolean;
  scopes: string[];
  codeSyntax: Record<string, string>;
  deletedButReferenced?: boolean;
}

export interface RestCollection {
  id: string;
  name: string;
  key: string;
  modes: { modeId: string; name: string; parentModeId?: string }[];
  defaultModeId: string;
  remote: boolean;
  hiddenFromPublishing: boolean;
  variableIds: string[];
  isExtension?: boolean;
  parentVariableCollectionId?: string;
  rootVariableCollectionId?: string;
  inheritedVariableIds?: string[];
  localVariableIds?: string[];
  variableOverrides?: Record<string, Record<string, RestVariableValue>>;
}

/** Ids of the file's variables as REST names them (a library copy's carry its library) */
export function variableIdOf(v: Pick<VariableInfo, "id" | "remote" | "key" | "libraryKey">): string {
  return restVariableId(v.id, v.remote ? v.key || v.libraryKey : null);
}

export function collectionIdOf(c: Pick<VariableCollectionInfo, "id" | "remote" | "key" | "libraryKey">): string {
  return restCollectionId(c.id, c.remote ? c.key || c.libraryKey : null);
}

/** One value in Figma's shape: a colour `{r, g, b, a}`, an alias `{type: "VARIABLE_ALIAS", id}`, or the literal */
export function restValue(v: VariableValue | null | undefined, ids: Map<string, string>): RestVariableValue {
  if (v === null || v === undefined) return null;
  if (typeof v !== "object") return v;
  if ("type" in v && v.type === "VARIABLE_ALIAS") return v.id ? { type: "VARIABLE_ALIAS", id: ids.get(v.id) ?? restVariableId(v.id) } : null;
  if ("r" in v) return { r: v.r, g: v.g, b: v.b, a: v.a ?? 1 };
  // A composed colour ("Control opacity at scale"): its colour, with the opacity when that is a number
  const c = (v as { color: unknown; opacity: unknown }).color as VariableValue;
  const o = (v as { opacity: unknown }).opacity;
  const base = restValue(c, ids);
  if (base && typeof base === "object" && "r" in base && typeof o === "number") return { ...base, a: (base.a ?? 1) * o };
  return base;
}

export function variablesLocalJson(engine: Engine): { status: 200; error: false; meta: { variables: Record<string, RestVariable>; variableCollections: Record<string, RestCollection> } } {
  const collections = engine.variableCollections({ includeRemote: true });
  const vars = engine.variables(undefined, { includeRemote: true });
  const ids = new Map(vars.map((v) => [v.id, variableIdOf(v)]));
  const cids = new Map(collections.map((c) => [c.id, collectionIdOf(c)]));
  const byId = new Map(collections.map((c) => [c.id, c]));
  const variables: Record<string, RestVariable> = {};
  for (const v of vars) {
    const own = v.collectionId ? byId.get(v.collectionId) : undefined;
    const modes = new Set((own?.modes ?? []).map((m) => m.modeId));
    const valuesByMode: Record<string, RestVariableValue> = {};
    for (const [mode, value] of Object.entries(v.valuesByMode)) if (!own || modes.has(mode)) valuesByMode[mode] = restValue(value, ids);
    variables[ids.get(v.id)!] = {
      id: ids.get(v.id)!,
      name: v.name,
      key: v.key,
      variableCollectionId: v.collectionId ? (cids.get(v.collectionId) ?? restCollectionId(v.collectionId)) : "",
      resolvedType: v.resolvedType,
      valuesByMode,
      remote: v.remote,
      description: v.description,
      hiddenFromPublishing: v.hiddenFromPublishing,
      scopes: [...v.scopes],
      codeSyntax: { ...v.codeSyntax } as Record<string, string>,
      ...(v.deletedButReferenced ? { deletedButReferenced: true } : {}),
    };
  }
  const variableCollections: Record<string, RestCollection> = {};
  for (const c of collections) {
    const id = cids.get(c.id)!;
    const out: RestCollection = {
      id,
      name: c.name,
      key: c.key,
      modes: c.modes.map((m) => ({ modeId: m.modeId, name: m.name, ...(m.parentModeId ? { parentModeId: m.parentModeId } : {}) })),
      defaultModeId: c.defaultModeId ?? c.modes[0]?.modeId ?? "",
      remote: c.remote,
      hiddenFromPublishing: c.hiddenFromPublishing,
      variableIds: c.variableIds.map((v) => ids.get(v) ?? restVariableId(v)),
    };
    if (c.isExtension) {
      const root = byId.get(c.rootCollectionId);
      out.isExtension = true;
      if (c.parentCollectionId) out.parentVariableCollectionId = cids.get(c.parentCollectionId) ?? restCollectionId(c.parentCollectionId);
      out.rootVariableCollectionId = cids.get(c.rootCollectionId) ?? restCollectionId(c.rootCollectionId);
      out.inheritedVariableIds = (root?.variableIds ?? c.variableIds).map((v) => ids.get(v) ?? restVariableId(v));
      out.localVariableIds = [];
      out.variableIds = out.inheritedVariableIds;
      const overrides: Record<string, Record<string, RestVariableValue>> = {};
      const own = new Set(c.modes.map((m) => m.modeId));
      for (const v of vars) {
        const modes = v.overriddenModes.filter((m) => own.has(m));
        if (!modes.length) continue;
        overrides[ids.get(v.id)!] = Object.fromEntries(modes.map((m) => [m, restValue(v.valuesByMode[m], ids)]));
      }
      out.variableOverrides = overrides;
    }
    variableCollections[id] = out;
  }
  return { status: 200, error: false, meta: { variables, variableCollections } };
}
