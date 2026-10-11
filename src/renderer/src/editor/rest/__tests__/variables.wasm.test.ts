// The REST API's variables on the client (docs/multiplayer.md §16.7, §16.8), on the committed wasm: GET local in
// Figma's shape (ids, modes, aliases, extended collections), POST checked against the document and applied as one
// undoable actor write in Figma's order (temporary ids, extended collections, null removing an override), all or
// nothing; and `validateAgainst` alone on models with remote copies.
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { Engine } from "@/engine/Engine";
import { loadEngine } from "@/engine/loadEngine";
import { VARIABLES_DOCUMENT } from "../../fixtures";
import type { VariablesPostBody } from "../../../../../shared/rest/types";
import { variablesLocalJson } from "../variablesJson";
import { applyVariablesPost, modelOf, validateAgainst, type VariablesModel } from "../variablesPost";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

beforeAll(async () => {
  const g = globalThis as Record<string, unknown>;
  g.window ??= globalThis;
  g.document ??= { querySelector: () => null };
  const bytes = readFileSync("src/renderer/src/engine/wasm/engine.wasm");
  await loadEngine({ wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), printErr: () => {} });
});

async function engine(): Promise<Engine> {
  const e = await Engine.create(null, { sessionID: 1 });
  e.load(VARIABLES_DOCUMENT);
  return e;
}

const local = (e: Engine) => variablesLocalJson(e).meta;
const byName = (e: Engine, name: string): Any => Object.values(local(e).variables).find((v) => v.name === name);

describe("GET …/variables/local", () => {
  it("collections and variables in Figma's shape: prefixed ids, modes, the default mode, aliases as VARIABLE_ALIAS", async () => {
    const e = await engine();
    const j = variablesLocalJson(e);
    expect(j).toMatchObject({ status: 200, error: false });
    expect(j.meta.variableCollections["VariableCollectionId:7:2"]).toMatchObject({ id: "VariableCollectionId:7:2", name: "Theme", modes: [{ modeId: "5:200", name: "Light" }, { modeId: "5:201", name: "Dark" }], defaultModeId: "5:200", remote: false, hiddenFromPublishing: false });
    expect(j.meta.variableCollections["VariableCollectionId:7:2"].variableIds).toContain("VariableID:5:20");
    expect(j.meta.variables["VariableID:5:20"]).toMatchObject({ name: "bg/primary", variableCollectionId: "VariableCollectionId:7:2", resolvedType: "COLOR", valuesByMode: { "5:200": { type: "VARIABLE_ALIAS", id: "VariableID:5:4" } }, remote: false, scopes: expect.any(Array), codeSyntax: {} });
    expect(j.meta.variables["VariableID:5:24"].valuesByMode).toEqual({ "5:200": "Sign up", "5:201": "Join now" });
    expect(j.meta.variables["VariableID:5:13"].description).toBe("Space between a card's blocks");
  });
});

describe("POST …/variables", () => {
  const body: VariablesPostBody = {
    variableCollections: [{ action: "CREATE", id: "c_new", name: "Brand", initialModeId: "m_one" }],
    variableModes: [{ action: "CREATE", id: "m_two", name: "Two", variableCollectionId: "c_new" }],
    variables: [
      { action: "CREATE", id: "v_bg", name: "bg", variableCollectionId: "c_new", resolvedType: "COLOR", description: "Background", scopes: ["FRAME_FILL"], codeSyntax: { WEB: "--bg" } },
      { action: "CREATE", id: "v_gap", name: "gap", variableCollectionId: "c_new", resolvedType: "FLOAT" },
      { action: "UPDATE", id: "VariableID:5:24", name: "label/primary" },
    ],
    variableModeValues: [
      { variableId: "v_bg", modeId: "m_one", value: { r: 1, g: 0, b: 0, a: 1 } },
      { variableId: "v_bg", modeId: "m_two", value: { r: 0, g: 0, b: 1 } as never }, // Figma's `a` is optional
      { variableId: "v_gap", modeId: "m_one", value: { type: "VARIABLE_ALIAS", id: "VariableID:5:12" } },
      { variableId: "v_gap", modeId: "m_two", value: 4 },
      { variableId: "VariableID:5:24", modeId: "5:201", value: "Start" },
    ],
  };

  it("applies in Figma's order with temporary ids, answers tempIdToRealId, and is one undo step", async () => {
    const e = await engine();
    const before = JSON.stringify(local(e));
    const r = await applyVariablesPost(e, body);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const map = r.answer.meta.tempIdToRealId;
    expect(Object.keys(map).sort()).toEqual(["c_new", "m_one", "m_two", "v_bg", "v_gap"]);
    expect(map.c_new).toMatch(/^VariableCollectionId:\d+:\d+$/);
    expect(map.v_bg).toMatch(/^VariableID:\d+:\d+$/);
    expect(map.m_one).toMatch(/^\d+:\d+$/);
    const meta = local(e);
    const c = meta.variableCollections[map.c_new];
    expect(c.name).toBe("Brand");
    expect(c.modes.map((m) => [m.modeId, m.name])).toEqual([[map.m_one, "Mode 1"], [map.m_two, "Two"]]);
    expect(meta.variables[map.v_bg]).toMatchObject({ name: "bg", description: "Background", scopes: ["FRAME_FILL"], codeSyntax: { WEB: "--bg" }, valuesByMode: { [map.m_one]: { r: 1, g: 0, b: 0, a: 1 }, [map.m_two]: { r: 0, g: 0, b: 1, a: 1 } } });
    expect(meta.variables[map.v_gap].valuesByMode).toEqual({ [map.m_one]: { type: "VARIABLE_ALIAS", id: "VariableID:5:12" }, [map.m_two]: 4 });
    expect(meta.variables["VariableID:5:24"]).toMatchObject({ name: "label/primary", valuesByMode: { "5:201": "Start" } });
    // one step in the user's history
    expect(e.undo()).toBe(true);
    expect(JSON.stringify(local(e))).toBe(before);
  });

  it("all or nothing: a bad value anywhere leaves the file as it was, with Figma's 400", async () => {
    const e = await engine();
    const before = JSON.stringify(local(e));
    const bad = { ...body, variableModeValues: [...body.variableModeValues!, { variableId: "v_gap", modeId: "m_one", value: "text" }] };
    const r = await applyVariablesPost(e, bad);
    expect(r).toMatchObject({ ok: false, status: 400, message: expect.stringMatching(/Invalid value for a FLOAT variable/) });
    expect(JSON.stringify(local(e))).toBe(before);
    expect((await applyVariablesPost(e, { variables: [{ action: "CREATE", id: "x", name: "a.b", variableCollectionId: "VariableCollectionId:7:1", resolvedType: "FLOAT" }] })).ok).toBe(false);
    expect(JSON.stringify(local(e))).toBe(before);
  });

  it("extended collections: created with the parent's mode mapping, overrides set and removed with null", async () => {
    const e = await engine();
    const r = await applyVariablesPost(e, {
      variableCollections: [{ action: "CREATE", id: "ext", name: "Theme (Sale)", parentVariableCollectionId: "VariableCollectionId:7:2", initialModeIdToParentModeIdMapping: { sale_light: "5:200", sale_dark: "5:201" } }],
      variableModeValues: [{ variableId: "VariableID:5:22", modeId: "sale_dark", value: { r: 1, g: 0.5, b: 0, a: 1 } }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const map = r.answer.meta.tempIdToRealId;
    const ext = local(e).variableCollections[map.ext];
    expect(ext).toMatchObject({ isExtension: true, parentVariableCollectionId: "VariableCollectionId:7:2", rootVariableCollectionId: "VariableCollectionId:7:2", localVariableIds: [] });
    expect(ext.modes.find((m) => m.modeId === map.sale_dark)?.parentModeId).toBe("5:201");
    expect(ext.variableOverrides).toEqual({ "VariableID:5:22": { [map.sale_dark]: { r: 1, g: 0.5, b: 0, a: 1 } } });
    // no variables of its own, no modes of its own
    expect((await applyVariablesPost(e, { variables: [{ action: "CREATE", id: "v", name: "x", variableCollectionId: map.ext, resolvedType: "FLOAT" }] })).ok).toBe(false);
    expect((await applyVariablesPost(e, { variableModes: [{ action: "CREATE", id: "m", name: "x", variableCollectionId: map.ext }] })).ok).toBe(false);
    // null removes the override
    expect((await applyVariablesPost(e, { variableModeValues: [{ variableId: "VariableID:5:22", modeId: map.sale_dark, value: null }] })).ok).toBe(true);
    expect(local(e).variableCollections[map.ext].variableOverrides).toEqual({});
    // a null in a collection's own mode is refused
    expect(await applyVariablesPost(e, { variableModeValues: [{ variableId: "VariableID:5:22", modeId: "5:200", value: null }] })).toMatchObject({ ok: false, status: 400 });
  });

  it("deletes and renames modes, collections and variables", async () => {
    const e = await engine();
    const r = await applyVariablesPost(e, {
      variableCollections: [{ action: "UPDATE", id: "VariableCollectionId:7:1", name: "Base", hiddenFromPublishing: true }],
      variableModes: [{ action: "UPDATE", id: "5:201", name: "Night", variableCollectionId: "VariableCollectionId:7:2" }],
      variables: [{ action: "DELETE", id: "VariableID:5:25" }],
    });
    expect(r.ok).toBe(true);
    const meta = local(e);
    expect(meta.variableCollections["VariableCollectionId:7:1"]).toMatchObject({ name: "Base", hiddenFromPublishing: true });
    expect(meta.variableCollections["VariableCollectionId:7:2"].modes[1].name).toBe("Night");
    expect(byName(e, "feature/beta")).toBeUndefined();
    expect((await applyVariablesPost(e, { variableModes: [{ action: "DELETE", id: "5:201", variableCollectionId: "VariableCollectionId:7:2" }] })).ok).toBe(true);
    expect(local(e).variableCollections["VariableCollectionId:7:2"].modes).toHaveLength(1);
    expect((await applyVariablesPost(e, { variableModes: [{ action: "DELETE", id: "5:200", variableCollectionId: "VariableCollectionId:7:2" }] })).ok).toBe(false);
  });
});

describe("validateAgainst (pure)", () => {
  const model = (): VariablesModel => ({
    collections: new Map([
      ["1:1", { id: "1:1", name: "Local", remote: false, isExtension: false, parent: null, modes: [{ id: "1:10", name: "A" }] }],
      ["2:1", { id: "2:1", name: "Library", remote: true, isExtension: false, parent: null, modes: [{ id: "2:10", name: "A" }] }],
    ]),
    variables: new Map([
      ["1:2", { id: "1:2", name: "a", collection: "1:1", type: "FLOAT", remote: false, aliases: new Map() }],
      ["1:3", { id: "1:3", name: "b", collection: "1:1", type: "FLOAT", remote: false, aliases: new Map([["1:10", "1:2"]]) }],
      ["2:2", { id: "2:2", name: "lib", collection: "2:1", type: "FLOAT", remote: true, aliases: new Map() }],
    ]),
  });
  const fails = (b: VariablesPostBody) => {
    const r = validateAgainst(b, model());
    return r.ok ? null : r.message;
  };

  it("refuses remote copies, unknown ids, taken names, alias cycles and type mismatches; accepts aliases to library variables", () => {
    expect(fails({ variableCollections: [{ action: "UPDATE", id: "VariableCollectionId:2:1", name: "x" }] })).toMatch(/remote/);
    expect(fails({ variables: [{ action: "DELETE", id: "VariableID:2:2" }] })).toMatch(/remote/);
    expect(fails({ variables: [{ action: "CREATE", id: "t", name: "x", variableCollectionId: "VariableCollectionId:2:1", resolvedType: "FLOAT" }] })).toMatch(/remote/);
    expect(fails({ variables: [{ action: "UPDATE", id: "VariableID:9:9", name: "x" }] })).toMatch(/not found/);
    expect(fails({ variables: [{ action: "CREATE", id: "t", name: "a", variableCollectionId: "VariableCollectionId:1:1", resolvedType: "FLOAT" }] })).toMatch(/already exists/);
    expect(fails({ variableModeValues: [{ variableId: "VariableID:1:2", modeId: "1:10", value: { type: "VARIABLE_ALIAS", id: "VariableID:1:3" } }] })).toMatch(/cycle/);
    expect(fails({ variableModeValues: [{ variableId: "VariableID:1:2", modeId: "1:10", value: true }] })).toMatch(/Invalid value/);
    expect(fails({ variableModeValues: [{ variableId: "VariableID:1:2", modeId: "2:10", value: 1 }] })).toMatch(/Mode 2:10 not found/);
    expect(fails({ variableModeValues: [{ variableId: "VariableID:1:2", modeId: "1:10", value: { type: "VARIABLE_ALIAS", id: "VariableID:lib_key/2:2" } }] })).toBeNull();
    // a temporary id can be used later in the same body, but not twice
    expect(fails({ variables: [{ action: "CREATE", id: "t", name: "c", variableCollectionId: "VariableCollectionId:1:1", resolvedType: "FLOAT" }], variableModeValues: [{ variableId: "t", modeId: "1:10", value: 3 }] })).toBeNull();
    expect(fails({ variableCollections: [{ action: "CREATE", id: "t", name: "x", initialModeId: "m" }], variableModes: [{ action: "CREATE", id: "m", name: "y", variableCollectionId: "t" }] })).toBeNull();
  });

  it("a collection deleted earlier in the body takes its variables with it", () => {
    expect(fails({ variableCollections: [{ action: "DELETE", id: "VariableCollectionId:1:1" }], variableModeValues: [{ variableId: "VariableID:1:2", modeId: "1:10", value: 1 }] })).toMatch(/not found/);
    expect(modelOf).toBeTypeOf("function");
  });
});
