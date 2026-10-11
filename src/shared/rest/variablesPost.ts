/**
 * `POST /v1/files/:key/variables` (docs/multiplayer.md §16.8): the body's **shape**, checked by the Worker before the job
 * goes to a client (which checks it against the document, `editor/rest/variablesPost.ts`). Pure.
 *
 * Messages follow Figma's style ("Invalid …"); Figma's exact wording for each case is unpublished (unverified).
 */
import type { VariablesPostBody } from "./types";

/** Figma's body limit */
export const VARIABLES_POST_MAX_BYTES = 4 * 1024 * 1024;
/** Figma's limits per collection (ours caps modes at 1,000 — docs/data.md §16.8) */
export const MAX_MODES_PER_COLLECTION = 1000;
export const MAX_VARIABLES_PER_COLLECTION = 5000;

const ACTIONS = ["CREATE", "UPDATE", "DELETE"] as const;
const TYPES = ["BOOLEAN", "FLOAT", "STRING", "COLOR"] as const;
const SCOPES = [
  "ALL_SCOPES", "TEXT_CONTENT", "CORNER_RADIUS", "WIDTH_HEIGHT", "GAP", "ALL_FILLS", "FRAME_FILL", "SHAPE_FILL", "TEXT_FILL", "STROKE_COLOR",
  "STROKE_FLOAT", "EFFECT_FLOAT", "EFFECT_COLOR", "OPACITY", "FONT_FAMILY", "FONT_STYLE", "FONT_WEIGHT", "FONT_SIZE", "LINE_HEIGHT",
  "LETTER_SPACING", "PARAGRAPH_SPACING", "PARAGRAPH_INDENT", "FONT_VARIATIONS",
] as const;

export type ShapeResult = { ok: true; body: VariablesPostBody } | { ok: false; message: string };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown, max = 256): v is string => typeof v === "string" && v.length > 0 && v.length <= max;

/** A variable's or collection's name: non-empty, no `.`, `{` or `}` (Figma's rule), ≤ 255 characters */
export function validName(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0 && v.length <= 255 && !/[.{}]/.test(v);
}

function value(v: unknown): boolean {
  if (v === null || typeof v === "boolean" || typeof v === "string") return true;
  if (typeof v === "number") return Number.isFinite(v);
  if (!isObj(v)) return false;
  if (v.type === "VARIABLE_ALIAS") return str(v.id);
  const n = (x: unknown) => typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 1;
  return n(v.r) && n(v.g) && n(v.b) && (v.a === undefined || n(v.a));
}

/** The body's shape: arrays of the right items, actions, required fields per action, names, types, values. */
export function validateShape(raw: unknown): ShapeResult {
  if (!isObj(raw)) return { ok: false, message: "Invalid request body" };
  const keys = ["variableCollections", "variableModes", "variables", "variableModeValues"] as const;
  for (const k of Object.keys(raw)) if (!(keys as readonly string[]).includes(k)) return { ok: false, message: `Invalid request body: unknown field ${k}` };
  for (const k of keys) if (raw[k] !== undefined && !Array.isArray(raw[k])) return { ok: false, message: `Invalid request body: ${k} must be an array` };
  const fail = (message: string): ShapeResult => ({ ok: false, message });
  const temp = new Set<string>();
  const created = (id: string, what: string): string | null => {
    if (temp.has(id)) return `Duplicate temporary id ${id} for ${what}`;
    temp.add(id);
    return null;
  };

  for (const [i, c] of ((raw.variableCollections as unknown[]) ?? []).entries()) {
    if (!isObj(c)) return fail(`Invalid variableCollections[${i}]`);
    if (!ACTIONS.includes(c.action as (typeof ACTIONS)[number])) return fail(`Invalid action in variableCollections[${i}]`);
    if (!str(c.id)) return fail(`Invalid id in variableCollections[${i}]`);
    if (c.action === "CREATE") {
      if (!validName(c.name)) return fail(`Invalid name in variableCollections[${i}]: names can't be empty or contain ".", "{" or "}"`);
      const dup = created(c.id, "a variable collection");
      if (dup) return fail(dup);
      if (c.initialModeId !== undefined && !str(c.initialModeId)) return fail(`Invalid initialModeId in variableCollections[${i}]`);
      if (c.parentVariableCollectionId !== undefined && !str(c.parentVariableCollectionId)) return fail(`Invalid parentVariableCollectionId in variableCollections[${i}]`);
      if (c.initialModeIdToParentModeIdMapping !== undefined) {
        if (!isObj(c.initialModeIdToParentModeIdMapping) || !Object.values(c.initialModeIdToParentModeIdMapping).every((x) => str(x))) return fail(`Invalid initialModeIdToParentModeIdMapping in variableCollections[${i}]`);
        if (c.parentVariableCollectionId === undefined) return fail(`initialModeIdToParentModeIdMapping needs parentVariableCollectionId in variableCollections[${i}]`);
      }
    } else if (c.action === "UPDATE") {
      if (c.name !== undefined && !validName(c.name)) return fail(`Invalid name in variableCollections[${i}]: names can't be empty or contain ".", "{" or "}"`);
      if (c.parentVariableCollectionId !== undefined) return fail(`An extended collection's parent can't change (variableCollections[${i}])`);
    }
    if (c.hiddenFromPublishing !== undefined && typeof c.hiddenFromPublishing !== "boolean") return fail(`Invalid hiddenFromPublishing in variableCollections[${i}]`);
  }

  for (const [i, m] of ((raw.variableModes as unknown[]) ?? []).entries()) {
    if (!isObj(m)) return fail(`Invalid variableModes[${i}]`);
    if (!ACTIONS.includes(m.action as (typeof ACTIONS)[number])) return fail(`Invalid action in variableModes[${i}]`);
    if (!str(m.id)) return fail(`Invalid id in variableModes[${i}]`);
    if (!str(m.variableCollectionId)) return fail(`Invalid variableCollectionId in variableModes[${i}]`);
    if (m.action === "CREATE") {
      if (!(typeof m.name === "string" && m.name.trim() && m.name.length <= 255)) return fail(`Invalid name in variableModes[${i}]`);
      const dup = created(m.id, "a mode");
      if (dup) return fail(dup);
    }
    if (m.action === "UPDATE" && m.name !== undefined && !(typeof m.name === "string" && m.name.trim() && m.name.length <= 255)) return fail(`Invalid name in variableModes[${i}]`);
  }

  for (const [i, v] of ((raw.variables as unknown[]) ?? []).entries()) {
    if (!isObj(v)) return fail(`Invalid variables[${i}]`);
    if (!ACTIONS.includes(v.action as (typeof ACTIONS)[number])) return fail(`Invalid action in variables[${i}]`);
    if (!str(v.id)) return fail(`Invalid id in variables[${i}]`);
    if (v.action === "CREATE") {
      if (!validName(v.name)) return fail(`Invalid name in variables[${i}]: names can't be empty or contain ".", "{" or "}"`);
      if (!str(v.variableCollectionId)) return fail(`Invalid variableCollectionId in variables[${i}]`);
      if (!TYPES.includes(v.resolvedType as (typeof TYPES)[number])) return fail(`Invalid resolvedType in variables[${i}]`);
      const dup = created(v.id, "a variable");
      if (dup) return fail(dup);
    } else {
      if (v.name !== undefined && !validName(v.name)) return fail(`Invalid name in variables[${i}]: names can't be empty or contain ".", "{" or "}"`);
      if (v.action === "UPDATE" && v.resolvedType !== undefined) return fail(`A variable's resolvedType can't change (variables[${i}])`);
    }
    if (v.description !== undefined && typeof v.description !== "string") return fail(`Invalid description in variables[${i}]`);
    if (v.hiddenFromPublishing !== undefined && typeof v.hiddenFromPublishing !== "boolean") return fail(`Invalid hiddenFromPublishing in variables[${i}]`);
    if (v.scopes !== undefined && (!Array.isArray(v.scopes) || !v.scopes.every((s) => SCOPES.includes(s as (typeof SCOPES)[number])))) return fail(`Invalid scopes in variables[${i}]`);
    if (v.codeSyntax !== undefined) {
      if (!isObj(v.codeSyntax) || !Object.entries(v.codeSyntax).every(([k, x]) => ["WEB", "ANDROID", "iOS"].includes(k) && typeof x === "string")) return fail(`Invalid codeSyntax in variables[${i}]`);
    }
  }

  for (const [i, mv] of ((raw.variableModeValues as unknown[]) ?? []).entries()) {
    if (!isObj(mv)) return fail(`Invalid variableModeValues[${i}]`);
    if (!str(mv.variableId)) return fail(`Invalid variableId in variableModeValues[${i}]`);
    if (!str(mv.modeId)) return fail(`Invalid modeId in variableModeValues[${i}]`);
    if (!("value" in mv) || !value(mv.value)) return fail(`Invalid value in variableModeValues[${i}]`);
  }

  return { ok: true, body: raw as VariablesPostBody };
}
