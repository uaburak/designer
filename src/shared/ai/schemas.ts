/**
 * The AI actions' answers (docs/ai.md §3): one JSON Schema per action, sent with the run (`AiRunRequest.schema`, which
 * main checks and repairs once — src/main/ai/run.ts), and a reader per action that turns the checked JSON into typed
 * values and refuses what the schema can't say (ids that aren't in the request, a group's values that repeat). A
 * reader throws `AnswerError`; the editor shows it as `bad-output`.
 */

export class AnswerError extends Error {}

const fail = (message: string): never => {
  throw new AnswerError(message);
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

/** Names are cut to this (Figma's renamed layers are short). */
export const MAX_LAYER_NAME = 60;

const idText = (key: string, extra: Obj = {}) => ({
  type: "object",
  additionalProperties: false,
  required: ["id", key],
  properties: { id: { type: "string" }, [key]: { type: "string", ...extra } },
});

/** Rename layers: `{names: {id, name}[]}` */
export const RENAME_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["names"],
  properties: { names: { type: "array", items: idText("name", { minLength: 1 }) } },
} as const;

/** Rewrite this… / Shorten / Translate to… / Replace content: `{texts: {id, characters}[]}` */
export const TEXTS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["texts"],
  properties: { texts: { type: "array", items: idText("characters") } },
} as const;

/** Add interactions: `{interactions: {sourceId, trigger: "ON_CLICK", action: "NAVIGATE" | "BACK", destinationId?}[]}` */
export const INTERACTIONS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["interactions"],
  properties: {
    interactions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["sourceId", "trigger", "action"],
        properties: {
          sourceId: { type: "string" },
          trigger: { type: "string", enum: ["ON_CLICK"] },
          action: { type: "string", enum: ["NAVIGATE", "BACK"] },
          destinationId: { type: "string" },
        },
      },
    },
  },
} as const;

/** First Draft: `{name, platform, blocks: {block, props}[]}` — `blockIds` are the kit's (an enum in the schema). */
export function draftSchema(blockIds: readonly string[]) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["name", "platform", "blocks"],
    properties: {
      name: { type: "string", minLength: 1 },
      platform: { type: "string", enum: ["app", "web"] },
      blocks: {
        type: "array",
        minItems: 1,
        maxItems: 24,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["block", "props"],
          properties: {
            block: { type: "string", enum: [...blockIds] },
            props: {
              type: "object",
              additionalProperties: { anyOf: [{ type: "string" }, { type: "number" }, { type: "array", items: { type: "string" } }] },
            },
          },
        },
      },
    },
  } as const;
}

// ---- Readers ----------------------------------------------------------------------------------------------------------

function list(json: unknown, key: string): unknown[] {
  if (!isObj(json) || !Array.isArray(json[key])) return fail(`The answer has no "${key}" list.`);
  return json[key] as unknown[];
}

/** `{names}` → id → name, only for `ids`; names trimmed, one line, ≤ 60 characters. Unknown ids are left out. */
export function readRename(json: unknown, ids: ReadonlySet<string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const x of list(json, "names")) {
    if (!isObj(x) || typeof x.id !== "string" || typeof x.name !== "string") return fail("Each name needs an id and a name.");
    if (!ids.has(x.id)) continue;
    const name = x.name.replace(/\s+/g, " ").trim().slice(0, MAX_LAYER_NAME).trim();
    if (name) out.set(x.id, name);
  }
  if (!out.size && ids.size) fail("The answer renamed none of the layers.");
  return out;
}

/**
 * `{texts}` → id → characters, only for `ids`. `groups` (Replace content: each group's ids — repeated siblings) must
 * get different values: a group whose texts came back the same is refused.
 */
export function readTexts(json: unknown, ids: ReadonlySet<string>, groups: readonly (readonly string[])[] = []): Map<string, string> {
  const out = new Map<string, string>();
  for (const x of list(json, "texts")) {
    if (!isObj(x) || typeof x.id !== "string" || typeof x.characters !== "string") return fail("Each text needs an id and its characters.");
    if (ids.has(x.id)) out.set(x.id, x.characters.replace(/\r\n?/g, "\n"));
  }
  if (!out.size && ids.size) fail("The answer changed none of the texts.");
  for (const g of groups) {
    const values = g.map((id) => out.get(id)).filter((v): v is string => v !== undefined);
    if (values.length > 1 && new Set(values).size < values.length) fail("Repeated layers got the same text.");
  }
  return out;
}

export interface AiInteraction {
  sourceId: string;
  trigger: "ON_CLICK";
  action: "NAVIGATE" | "BACK";
  destinationId?: string;
}

/**
 * `{interactions}` → the ones whose source is in `sources` and whose destination (NAVIGATE) is one of `frames`, not
 * the source's own frame; one per source (the first).
 */
export function readInteractions(json: unknown, sources: ReadonlySet<string>, frames: ReadonlySet<string>, frameOf: (id: string) => string | null): AiInteraction[] {
  const out: AiInteraction[] = [];
  const seen = new Set<string>();
  for (const x of list(json, "interactions")) {
    if (!isObj(x) || typeof x.sourceId !== "string" || (x.action !== "NAVIGATE" && x.action !== "BACK")) return fail("Each interaction needs a sourceId and an action.");
    if (!sources.has(x.sourceId) || seen.has(x.sourceId)) continue;
    if (x.action === "NAVIGATE") {
      const dest = typeof x.destinationId === "string" ? x.destinationId : "";
      if (!frames.has(dest) || frameOf(x.sourceId) === dest) continue;
      out.push({ sourceId: x.sourceId, trigger: "ON_CLICK", action: "NAVIGATE", destinationId: dest });
    } else out.push({ sourceId: x.sourceId, trigger: "ON_CLICK", action: "BACK" });
    seen.add(x.sourceId);
  }
  return out;
}

export type DraftPropValue = string | number | string[];
export interface DraftPlan {
  name: string;
  platform: "app" | "web";
  blocks: { block: string; props: Record<string, DraftPropValue> }[];
}

/** `{name, platform, blocks}` → the plan, blocks the kit doesn't have left out (at least one must remain). */
export function readDraft(json: unknown, blockIds: ReadonlySet<string>): DraftPlan {
  if (!isObj(json)) return fail("The answer isn't a plan.");
  const platform = json.platform === "web" ? "web" : json.platform === "app" ? "app" : fail("The plan has no platform.");
  const name = typeof json.name === "string" && json.name.trim() ? json.name.trim().slice(0, MAX_LAYER_NAME) : "First Draft";
  const blocks: DraftPlan["blocks"] = [];
  for (const b of list(json, "blocks")) {
    if (!isObj(b) || typeof b.block !== "string" || !blockIds.has(b.block)) continue;
    const props: Record<string, DraftPropValue> = {};
    if (isObj(b.props))
      for (const [k, v] of Object.entries(b.props)) {
        if (typeof v === "string" || (typeof v === "number" && Number.isFinite(v))) props[k] = v;
        else if (Array.isArray(v)) props[k] = v.filter((s): s is string => typeof s === "string").slice(0, 12);
      }
    blocks.push({ block: b.block, props });
  }
  if (!blocks.length) fail("The plan has no blocks this library has.");
  return { name, platform, blocks: blocks.slice(0, 24) };
}
