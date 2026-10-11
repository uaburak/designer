/**
 * `POST /v1/files/:key/variables` on the client (docs/multiplayer.md §16.8): the body — its shape already checked by
 * the Worker (`src/shared/rest/variablesPost.ts validateShape`, checked again here) — checked against the document
 * (`validateAgainst`, pure: ids, temporary ids, remote copies, extended collections, names, types, values, alias
 * cycles, limits), then applied in Figma's order as **one actor write** labelled "REST API: Update variables" that
 * goes to the user's history (`undoTo: 0`) without touching their selection or page. All or nothing: a command the
 * engine refuses cancels the whole write. The answer is `{status: 200, error: false, meta: {tempIdToRealId}}`.
 */
import { Status, type CommandName } from "@/engine/abi";
import type { CommandArgValue, VariableValue } from "@/engine/codec";
import type { Engine } from "@/engine/Engine";
import type { RestResolvedType, RestVariableValue, VariablesPostBody } from "../../../../shared/rest/types";
import { MAX_MODES_PER_COLLECTION, MAX_VARIABLES_PER_COLLECTION, validateShape } from "../../../../shared/rest/variablesPost";
import { guidOf, restCollectionId, restVariableId } from "./ids";

/** The actor REST writes run as (agents count theirs from 1) */
export const REST_ACTOR = 0x7e57_0001;
export const REST_LABEL = "REST API: Update variables";

// ---- the document as the checks see it ----------------------------------------------------------------------------

export interface ModelCollection {
  id: string;
  name: string;
  remote: boolean;
  isExtension: boolean;
  parent: string | null;
  modes: { id: string; name: string; parentModeId?: string }[];
  deleted?: boolean;
}

export interface ModelVariable {
  id: string;
  name: string;
  collection: string;
  type: RestResolvedType;
  remote: boolean;
  /** mode → the variable it aliases */
  aliases: Map<string, string>;
  deleted?: boolean;
}

export interface VariablesModel {
  collections: Map<string, ModelCollection>;
  variables: Map<string, ModelVariable>;
}

export function modelOf(engine: Engine): VariablesModel {
  const collections = new Map<string, ModelCollection>();
  for (const c of engine.variableCollections({ includeRemote: true })) collections.set(c.id, { id: c.id, name: c.name, remote: c.remote, isExtension: c.isExtension, parent: c.parentCollectionId, modes: c.modes.map((m) => ({ id: m.modeId, name: m.name, ...(m.parentModeId ? { parentModeId: m.parentModeId } : {}) })) });
  const variables = new Map<string, ModelVariable>();
  for (const v of engine.variables(undefined, { includeRemote: true })) {
    const aliases = new Map<string, string>();
    for (const [mode, value] of Object.entries(v.valuesByMode)) {
      const a = aliasOf(value);
      if (a) aliases.set(mode, a);
    }
    variables.set(v.id, { id: v.id, name: v.name, collection: v.collectionId ?? "", type: v.resolvedType as RestResolvedType, remote: v.remote, aliases });
  }
  return { collections, variables };
}

function aliasOf(v: VariableValue | null | undefined): string | null {
  if (!v || typeof v !== "object") return null;
  if ("type" in v && v.type === "VARIABLE_ALIAS") return v.id;
  if ("color" in v && v.color && typeof v.color === "object" && "type" in v.color) return v.color.id;
  return null;
}

// ---- the checks -----------------------------------------------------------------------------------------------------

export type CheckResult = { ok: true; plan: Plan } | { ok: false; message: string };

/** What the write does, with every id resolved to the model's (temporary ids as `temp:<id>`) */
interface Plan {
  body: VariablesPostBody;
  /** body id → model id (real GUIDs, or `temp:<id>` for what this body creates) */
  ids: Map<string, string>;
}

const isColor = (v: unknown): v is { r: number; g: number; b: number; a?: number } => !!v && typeof v === "object" && "r" in v;

/**
 * The body against the document, simulated on a copy of the model in Figma's order. Messages follow Figma's style
 * (its exact wording per case is unpublished).
 */
export function validateAgainst(body: VariablesPostBody, model: VariablesModel): CheckResult {
  const cols = new Map([...model.collections].map(([k, c]) => [k, { ...c, modes: c.modes.map((m) => ({ ...m })) }]));
  const vars = new Map([...model.variables].map(([k, v]) => [k, { ...v, aliases: new Map(v.aliases) }]));
  const ids = new Map<string, string>();
  const fail = (message: string): CheckResult => ({ ok: false, message });
  const real = (id: string, kind: "collection" | "variable" | "mode"): string | null => {
    if (ids.has(id)) return ids.get(id)!;
    const g = guidOf(id);
    if (!g) return null;
    if (kind === "collection") return cols.get(g) && !cols.get(g)!.deleted ? g : null;
    if (kind === "variable") return vars.get(g) && !vars.get(g)!.deleted ? g : null;
    return g;
  };
  const extensionsOf = (cid: string) => [...cols.values()].filter((c) => !c.deleted && c.parent === cid);
  const live = (cid: string) => [...vars.values()].filter((v) => !v.deleted && v.collection === cid);
  const rootOf = (c: ModelCollection): ModelCollection => {
    let at = c;
    for (let i = 0; at.parent && i < 32; i++) at = cols.get(at.parent) ?? at;
    return at;
  };

  for (const c of body.variableCollections ?? []) {
    if (c.action === "CREATE") {
      const id = `temp:${c.id}`;
      if (c.parentVariableCollectionId !== undefined) {
        const parent = real(c.parentVariableCollectionId, "collection");
        if (!parent) return fail(`Variable collection ${c.parentVariableCollectionId} not found`);
        const p = cols.get(parent)!;
        const mapping = c.initialModeIdToParentModeIdMapping ?? {};
        const modes = p.modes.map((m) => ({ id: `temp-mode:${id}:${m.id}`, name: m.name, parentModeId: m.id }));
        for (const [temp, parentMode] of Object.entries(mapping)) {
          const pm = real(parentMode, "mode");
          const mode = modes.find((m) => m.parentModeId === pm);
          if (!mode) return fail(`Mode ${parentMode} is not a mode of the parent collection`);
          if (ids.has(temp)) return fail(`Duplicate temporary id ${temp}`);
          ids.set(temp, mode.id);
        }
        cols.set(id, { id, name: c.name!, remote: false, isExtension: true, parent, modes });
      } else {
        const mode = `temp-mode:${id}`;
        if (c.initialModeId !== undefined) {
          if (ids.has(c.initialModeId)) return fail(`Duplicate temporary id ${c.initialModeId}`);
          ids.set(c.initialModeId, mode);
        }
        cols.set(id, { id, name: c.name!, remote: false, isExtension: false, parent: null, modes: [{ id: mode, name: "Mode 1" }] });
      }
      ids.set(c.id, id);
      continue;
    }
    const id = real(c.id, "collection");
    if (!id) return fail(`Variable collection ${c.id} not found`);
    const col = cols.get(id)!;
    if (col.remote) return fail(`Cannot modify remote variable collection ${c.id}`);
    if (c.action === "UPDATE") {
      if (c.name !== undefined) col.name = c.name;
    } else {
      col.deleted = true;
      const gone = [id];
      for (let i = 0; i < gone.length; i++) {
        for (const e of extensionsOf(gone[i])) {
          e.deleted = true;
          gone.push(e.id);
        }
      }
      for (const v of live(id)) v.deleted = true;
    }
  }

  for (const m of body.variableModes ?? []) {
    const cid = real(m.variableCollectionId, "collection");
    if (!cid) return fail(`Variable collection ${m.variableCollectionId} not found`);
    const col = cols.get(cid)!;
    if (col.remote) return fail(`Cannot modify remote variable collection ${m.variableCollectionId}`);
    if (col.isExtension) return fail("Cannot add, rename or delete modes of an extended collection");
    if (m.action === "CREATE") {
      if (col.modes.length >= MAX_MODES_PER_COLLECTION) return fail(`A collection can have at most ${MAX_MODES_PER_COLLECTION} modes`);
      const id = `temp-mode:${cid}:${m.id}`;
      col.modes.push({ id, name: m.name! });
      ids.set(m.id, id);
      // Its extensions follow with a mode of their own (as the engine does)
      for (const e of extensionsOf(cid)) e.modes.push({ id: `temp-mode:${e.id}:${id}`, name: m.name!, parentModeId: id });
      continue;
    }
    const id = real(m.id, "mode");
    const mode = col.modes.find((x) => x.id === id);
    if (!id || !mode) return fail(`Mode ${m.id} not found in collection ${m.variableCollectionId}`);
    if (m.action === "UPDATE") {
      if (m.name !== undefined) mode.name = m.name;
    } else {
      if (col.modes.length < 2) return fail("A collection must have at least one mode");
      col.modes = col.modes.filter((x) => x.id !== id);
    }
  }

  for (const v of body.variables ?? []) {
    if (v.action === "CREATE") {
      const cid = real(v.variableCollectionId!, "collection");
      if (!cid) return fail(`Variable collection ${v.variableCollectionId} not found`);
      const col = cols.get(cid)!;
      if (col.remote) return fail(`Cannot modify remote variable collection ${v.variableCollectionId}`);
      if (col.isExtension) return fail("Cannot create variables in an extended collection");
      if (live(cid).some((x) => x.name === v.name)) return fail(`A variable named ${v.name} already exists in this collection`);
      if (live(cid).length >= MAX_VARIABLES_PER_COLLECTION) return fail(`A collection can have at most ${MAX_VARIABLES_PER_COLLECTION} variables`);
      const id = `temp:${v.id}`;
      vars.set(id, { id, name: v.name!, collection: cid, type: v.resolvedType!, remote: false, aliases: new Map() });
      ids.set(v.id, id);
      continue;
    }
    const id = real(v.id, "variable");
    if (!id) return fail(`Variable ${v.id} not found`);
    const variable = vars.get(id)!;
    if (variable.remote) return fail(`Cannot modify remote variable ${v.id}`);
    if (v.variableCollectionId !== undefined && real(v.variableCollectionId, "collection") !== variable.collection) return fail(`A variable can't move to another collection (${v.id})`);
    if (v.action === "UPDATE") {
      if (v.name !== undefined) {
        if (live(variable.collection).some((x) => x.id !== id && x.name === v.name)) return fail(`A variable named ${v.name} already exists in this collection`);
        variable.name = v.name;
      }
    } else variable.deleted = true;
  }

  const reaches = (from: string, to: string): boolean => {
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length) {
      const at = stack.pop()!;
      if (at === to) return true;
      if (seen.has(at)) continue;
      seen.add(at);
      for (const t of vars.get(at)?.aliases.values() ?? []) stack.push(t);
    }
    return false;
  };
  for (const [i, mv] of (body.variableModeValues ?? []).entries()) {
    const vid = real(mv.variableId, "variable");
    if (!vid) return fail(`Variable ${mv.variableId} not found`);
    const variable = vars.get(vid)!;
    const mode = real(mv.modeId, "mode");
    const own = cols.get(variable.collection);
    const ext = [...cols.values()].find((c) => !c.deleted && c.isExtension && c.modes.some((m) => m.id === mode) && own && rootOf(c).id === rootOf(own).id);
    const inOwn = own?.modes.some((m) => m.id === mode);
    if (!mode || (!inOwn && !ext)) return fail(`Mode ${mv.modeId} not found for variable ${mv.variableId} (variableModeValues[${i}])`);
    if (inOwn && variable.remote) return fail(`Cannot modify remote variable ${mv.variableId}`);
    if (!inOwn && ext?.remote) return fail(`Cannot modify remote variable collection ${ext.id}`);
    const value = mv.value as RestVariableValue;
    if (value === null) {
      if (inOwn) return fail(`A null value only removes an extended collection's override (variableModeValues[${i}])`);
      variable.aliases.delete(mode);
      continue;
    }
    if (typeof value === "object" && "type" in value) {
      const target = real(value.id, "variable");
      if (!target) return fail(`Variable ${value.id} not found (variableModeValues[${i}])`);
      if (vars.get(target)!.type !== variable.type) return fail(`An alias must point to a variable of the same type (variableModeValues[${i}])`);
      if (target === vid || reaches(target, vid)) return fail(`Alias cycles are not allowed (variableModeValues[${i}])`);
      variable.aliases.set(mode, target);
      continue;
    }
    const ok = variable.type === "BOOLEAN" ? typeof value === "boolean" : variable.type === "FLOAT" ? typeof value === "number" : variable.type === "STRING" ? typeof value === "string" : isColor(value);
    if (!ok) return fail(`Invalid value for a ${variable.type} variable (variableModeValues[${i}])`);
    variable.aliases.delete(mode);
  }
  return { ok: true, plan: { body, ids } };
}

// ---- the write -------------------------------------------------------------------------------------------------------

export type PostAnswer = { ok: true; answer: { status: 200; error: false; meta: { tempIdToRealId: Record<string, string> } } } | { ok: false; status: number; message: string };

class Refused extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The POST, checked and applied. `flush`: resolves once the write's frames are with the store (the source's flush),
 * so the job's answer reaches the room after them.
 */
export async function applyVariablesPost(engine: Engine, raw: unknown): Promise<PostAnswer> {
  const shape = validateShape(raw);
  if (!shape.ok) return { ok: false, status: 400, message: shape.message };
  const checked = validateAgainst(shape.body, modelOf(engine));
  if (!checked.ok) return { ok: false, status: 400, message: checked.message };
  // A user's gesture or panel scrub holds the engine: the write waits for it (a while)
  for (let i = 0; i < 100 && !engine.idle(); i++) await sleep(50);
  const begun = engine.actorBegin(REST_ACTOR, { label: REST_LABEL, undoTo: 0 });
  if (begun === Status.E_READONLY) return { ok: false, status: 403, message: "This file is read-only" };
  if (begun !== Status.OK) return { ok: false, status: 503, message: "The file is busy. Try again." };
  let done = false;
  try {
    const result = write(engine, shape.body);
    done = true;
    return { ok: true, answer: { status: 200, error: false, meta: { tempIdToRealId: result } } };
  } catch (e) {
    return { ok: false, status: 400, message: e instanceof Refused ? e.message : `The variables couldn't be changed: ${e instanceof Error ? e.message : String(e)}` };
  } finally {
    engine.actorEnd(!done);
  }
}

/** The body's writes in Figma's order; throws Refused when the engine refuses one (the actor write is then cancelled) */
function write(engine: Engine, body: VariablesPostBody): Record<string, string> {
  const ids = new Map<string, string>();
  const temp: Record<string, string> = {};
  const run = (name: CommandName, args: Record<string, CommandArgValue>, what: string): string[] => {
    const r = engine.runCommand(name, args);
    if (r.status !== Status.OK) throw new Refused(`${what} was refused (status ${r.status})`);
    return r.created;
  };
  const collection = (id: string) => ids.get(id) ?? guidOf(id)!;
  const variable = (id: string) => ids.get(id) ?? guidOf(id)!;
  const mode = (id: string) => ids.get(id) ?? guidOf(id) ?? id;
  const modesOf = (cid: string) => engine.variableCollections({ includeRemote: true }).find((c) => c.id === cid)?.modes ?? [];
  const setHidden = (ref: string, hidden: boolean) => engine.setProps([ref], { isPublishable: !hidden } as never);

  for (const c of body.variableCollections ?? []) {
    if (c.action === "CREATE") {
      let id: string;
      if (c.parentVariableCollectionId !== undefined) {
        const parent = collection(c.parentVariableCollectionId);
        id = run("EXTEND_VARIABLE_COLLECTION", { collection: parent, name: c.name! }, `Extending ${c.parentVariableCollectionId}`)[0];
        if (!id) throw new Refused("The extended collection wasn't created");
        const modes = modesOf(id);
        for (const [t, parentMode] of Object.entries(c.initialModeIdToParentModeIdMapping ?? {})) {
          const m = modes.find((x) => x.parentModeId === mode(parentMode));
          if (!m) throw new Refused(`Mode ${parentMode} is not a mode of the parent collection`);
          ids.set(t, m.modeId);
          temp[t] = m.modeId;
        }
      } else {
        id = run("CREATE_VARIABLE_COLLECTION", { name: c.name! }, `Creating collection ${c.name}`)[0];
        if (!id) throw new Refused("The collection wasn't created");
        const first = modesOf(id)[0];
        if (c.initialModeId !== undefined && first) {
          ids.set(c.initialModeId, first.modeId);
          temp[c.initialModeId] = first.modeId;
        }
      }
      ids.set(c.id, id);
      temp[c.id] = restCollectionId(id);
      if (c.hiddenFromPublishing) setHidden(id, true);
    } else if (c.action === "UPDATE") {
      const id = collection(c.id);
      if (c.name !== undefined) run("RENAME_VARIABLE_COLLECTION", { collection: id, name: c.name }, `Renaming collection ${c.id}`);
      if (c.hiddenFromPublishing !== undefined) setHidden(id, c.hiddenFromPublishing);
    } else run("DELETE_VARIABLE_COLLECTION", { collection: collection(c.id) }, `Deleting collection ${c.id}`);
  }

  for (const m of body.variableModes ?? []) {
    const cid = collection(m.variableCollectionId);
    if (m.action === "CREATE") {
      const before = new Set(modesOf(cid).map((x) => x.modeId));
      const created = run("ADD_VARIABLE_MODE", { collection: cid, name: m.name! }, `Adding mode ${m.name}`);
      const id = created.find((x) => !before.has(x) && modesOf(cid).some((y) => y.modeId === x)) ?? modesOf(cid).find((x) => !before.has(x.modeId))?.modeId;
      if (!id) throw new Refused(`Mode ${m.name} wasn't created`);
      // The engine names a new mode "Mode N": the body's name
      if (modesOf(cid).find((x) => x.modeId === id)?.name !== m.name) run("RENAME_VARIABLE_MODE", { collection: cid, mode: id, name: m.name! }, `Naming mode ${m.name}`);
      ids.set(m.id, id);
      temp[m.id] = id;
    } else if (m.action === "UPDATE") {
      if (m.name !== undefined) run("RENAME_VARIABLE_MODE", { collection: cid, mode: mode(m.id), name: m.name }, `Renaming mode ${m.id}`);
    } else run("DELETE_VARIABLE_MODE", { collection: cid, mode: mode(m.id) }, `Deleting mode ${m.id}`);
  }

  for (const v of body.variables ?? []) {
    let id: string;
    if (v.action === "CREATE") {
      id = run("CREATE_VARIABLE", { collection: collection(v.variableCollectionId!), type: v.resolvedType!, name: v.name! }, `Creating variable ${v.name}`)[0];
      if (!id) throw new Refused(`Variable ${v.name} wasn't created`);
      ids.set(v.id, id);
      temp[v.id] = restVariableId(id);
    } else if (v.action === "DELETE") {
      run("DELETE_VARIABLES", { variables: [variable(v.id)] }, `Deleting variable ${v.id}`);
      continue;
    } else {
      id = variable(v.id);
      if (v.name !== undefined) run("RENAME_VARIABLE", { variable: id, name: v.name }, `Renaming variable ${v.id}`);
    }
    if (v.description !== undefined) run("SET_VARIABLE_DESCRIPTION", { variable: id, description: v.description }, `The description of ${v.id}`);
    if (v.hiddenFromPublishing !== undefined) run("SET_VARIABLE_HIDDEN", { variables: [id], hidden: v.hiddenFromPublishing }, `Hide from publishing of ${v.id}`);
    if (v.scopes !== undefined) run("SET_VARIABLE_SCOPES", { variables: [id], scopes: v.scopes }, `The scopes of ${v.id}`);
    for (const [platform, value] of Object.entries(v.codeSyntax ?? {})) run("SET_VARIABLE_CODE_SYNTAX", { variable: id, platform, value }, `The code syntax of ${v.id}`);
  }

  const collections = () => engine.variableCollections({ includeRemote: true });
  for (const mv of body.variableModeValues ?? []) {
    const vid = variable(mv.variableId);
    const m = mode(mv.modeId);
    const value = mv.value;
    if (value === null) {
      const ext = collections().find((c) => c.isExtension && c.modes.some((x) => x.modeId === m));
      if (!ext) throw new Refused(`Mode ${mv.modeId} isn't a mode of an extended collection`);
      run("RESET_VARIABLE_OVERRIDE", { collection: ext.id, variables: [vid], mode: m }, `Removing the override of ${mv.variableId}`);
      continue;
    }
    const engineValue: CommandArgValue = typeof value === "object" ? ("type" in value ? { type: "VARIABLE_ALIAS", id: variable(value.id) } : { r: value.r, g: value.g, b: value.b, a: value.a ?? 1 }) : value;
    run("SET_VARIABLE_VALUE", { variable: vid, mode: m, value: engineValue }, `The value of ${mv.variableId} in mode ${mv.modeId}`);
  }
  return temp;
}
