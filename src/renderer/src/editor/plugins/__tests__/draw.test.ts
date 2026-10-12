// The Plugin API for Draw (docs/draw.md §7, api/draw.ts) on a fake engine: the readers over the document's fields,
// the writers' engine calls (CommandId 310–321, round 7b's — stubs until then) and Figma's validation.
import { describe, expect, it } from "vitest";
import { Status } from "@/engine/abi";
import type { NodeChange } from "@/engine/codec";
import { BUILTIN_BRUSHES } from "@shared/draw/brushes";
import type { ApiContext } from "../api/context";
import { apiType } from "../api/convert";
import {
  brushNameOf,
  complexStrokeProperties,
  createTextPath,
  loadBrushes,
  modifierFromApi,
  modifierToApi,
  setComplexStrokeProperties,
  setTextPathStartData,
  setTransformModifiers,
  setVariableWidthStrokeProperties,
  textPathStartData,
  transformGroup,
  transformModifiers,
  variableWidthStrokeProperties,
} from "../api/draw";
import { getProp } from "../api/nodes";

type Obj = Record<string, unknown>;

/** A tiny document and an engine that records what the API asks of it. */
function fakeCtx(nodes: Obj[], opts: { stubs?: boolean; onDraw?: (id: string, args: Obj, doc: Map<string, Obj>) => void } = {}) {
  const doc = new Map(nodes.map((n) => [n.guid as string, { ...n }]));
  const calls: { id: string; args: Obj }[] = [];
  const props: { refs: string[]; fields: Obj }[] = [];
  const installed: { guid: string; name: string; type: string }[] = [];
  const childIds = (id: string) => [...doc.values()].filter((n) => (n.parentIndex as { guid?: string } | undefined)?.guid === id).map((n) => n.guid as string);
  const notBuilt = (name: string) => () => {
    throw new Error(`engine: ${name} not built (round 7b)`);
  };
  const engine = {
    readNode: (id: string, o?: { childIds?: boolean }) => {
      const n = doc.get(id);
      return n ? ({ ...n, ...(o?.childIds ? { childIds: childIds(id) } : {}) } as unknown as NodeChange) : null;
    },
    setProps: (refs: string[], fields: Obj) => {
      props.push({ refs, fields });
      for (const r of refs) Object.assign(doc.get(r)!, fields);
      return Status.OK;
    },
    moveNodes: (ids: string[], parent: string) => {
      for (const id of ids) doc.get(id)!.parentIndex = { guid: parent, position: "z" };
      return true;
    },
    runDrawCommand: opts.stubs
      ? notBuilt("runDrawCommand")
      : (id: string, args: Obj) => {
          calls.push({ id, args });
          opts.onDraw?.(id, args, doc);
          return Status.OK;
        },
    listBrushes: opts.stubs ? notBuilt("listBrushes") : () => installed,
    installBrush: opts.stubs
      ? notBuilt("installBrush")
      : (b: { name: string; type: string }) => {
          const guid = `0:${100 + installed.length}`;
          installed.push({ guid, name: b.name, type: b.type });
          return guid;
        },
  };
  let writes = 0;
  const ctx = {
    ed: { engine, withRealType: (n: NodeChange) => n },
    editorType: "figma",
    write: () => void writes++,
  } as unknown as ApiContext;
  return { ctx, doc, calls, props, installed, writes: () => writes };
}

const node = (guid: string, fields: Obj = {}): Obj => ({ guid, type: "VECTOR", name: guid, parentIndex: { guid: "0:1", position: "a" }, ...fields });

describe("Draw plugin API: node types", () => {
  it("TEXT_PATH keeps its name, the engine's TRANSFORM reads as TRANSFORM_GROUP", () => {
    expect(apiType({ type: "TEXT_PATH" as never })).toBe("TEXT_PATH");
    expect(apiType({ type: "TRANSFORM" as never })).toBe("TRANSFORM_GROUP");
  });
});

describe("Draw plugin API: text on a path", () => {
  it("textPathStartData splits tValue into {segment, position}; setting it sends SET_TEXT_PATH_START", () => {
    const { ctx, calls } = fakeCtx([node("1:1", { type: "TEXT_PATH", textPathStart: { tValue: 2.25, forward: true } })]);
    const n = ctx.ed.engine.readNode("1:1")!;
    expect(textPathStartData(n)).toEqual({ segment: 2, position: 0.25 });
    expect(getProp(ctx, "1:1", "textPathStartData")).toEqual({ segment: 2, position: 0.25 });
    expect(textPathStartData({ guid: "x" } as NodeChange)).toEqual({ segment: 0, position: 0 });
    setTextPathStartData(ctx, n, { segment: 1, position: 0.5 });
    expect(calls).toEqual([{ id: "SET_TEXT_PATH_START", args: { ref: "1:1", segment: 1, position: 0.5 } }]);
    expect(() => setTextPathStartData(ctx, n, { segment: -1, position: 0 })).toThrow(/segment/);
    expect(() => setTextPathStartData(ctx, n, { segment: 0, position: 2 })).toThrow(/position/);
  });

  it("createTextPath: CREATE_TEXT_PATH with replace, the TEXT_PATH in the source's place is returned", () => {
    const { ctx, calls } = fakeCtx([node("0:1", { type: "CANVAS", parentIndex: undefined }), node("1:1", { type: "ELLIPSE", name: "Circle" })], {
      onDraw: (id, args, doc) => {
        if (id !== "CREATE_TEXT_PATH") return;
        const src = doc.get(args.ref as string)!;
        doc.delete(args.ref as string);
        doc.set("1:9", { ...src, guid: "1:9", type: "TEXT_PATH" });
      },
    });
    const made = createTextPath(ctx, "1:1", 2, 0.5);
    expect(calls).toEqual([{ id: "CREATE_TEXT_PATH", args: { ref: "1:1", segment: 2, position: 0.5, replace: true } }]);
    expect(made).toEqual({ $node: "1:9", $type: "TEXT_PATH" });
  });

  it("createTextPath refuses other node types and bad starts; the stub reads as not supported yet", () => {
    const { ctx } = fakeCtx([node("1:1", { type: "TEXT" }), node("1:2")]);
    expect(() => createTextPath(ctx, "1:1", 0, 0)).toThrow(/vector, rectangle, ellipse/);
    expect(() => createTextPath(ctx, "1:2", 0.5, 0)).toThrow(/segment/);
    const stub = fakeCtx([node("1:2")], { stubs: true });
    expect(() => createTextPath(stub.ctx, "1:2", 0, 0)).toThrow("createTextPath is not supported in Wecra yet");
  });
});

describe("Draw plugin API: transform groups", () => {
  const linear = { type: "REPEAT", count: 3, unitType: "PIXELS", offset: 16, repeatType: "LINEAR", axis: "VERTICAL" };
  const radial = { type: "REPEAT", count: 8, unitType: "RELATIVE", offset: 0.5, repeatType: "RADIAL" };

  it("modifiers convert both ways (HORIZONTAL ↔ X, VERTICAL ↔ Y; offset ↔ offset.x)", () => {
    const docLinear = modifierFromApi(linear, "m");
    expect(docLinear).toEqual({ type: "REPEAT", visible: true, count: 3, repeatType: "LINEAR", unitType: "PIXELS", offset: { x: 16, y: 0 }, order: "FORWARD", axis: "Y" });
    expect(modifierToApi(docLinear)).toEqual(linear);
    expect(modifierToApi(modifierFromApi(radial, "m"))).toEqual(radial);
    expect(modifierToApi({ type: "SKEW" })).toBeNull();
    expect(() => modifierFromApi({ ...linear, type: "SKEW" }, "m")).toThrow(/only 'REPEAT'/);
    expect(() => modifierFromApi({ ...linear, axis: "DIAGONAL" }, "m")).toThrow(/axis/);
    expect(() => modifierFromApi({ ...linear, count: 0 }, "m")).toThrow(/count/);
  });

  it("transformModifiers reads REPEATs only; setting replaces them and keeps the file's SYMMETRY / SKEW", () => {
    const { ctx, props } = fakeCtx([node("1:1", { type: "TRANSFORM", transformModifiers: [{ type: "SKEW", skewX: 1 }, modifierFromApi(radial, "m")] })]);
    const n = ctx.ed.engine.readNode("1:1")!;
    expect(transformModifiers(n)).toEqual([radial]);
    setTransformModifiers(ctx, n, [linear]);
    expect(props[0].fields.transformModifiers).toEqual([modifierFromApi(linear, "m"), { type: "SKEW", skewX: 1 }]);
    expect(() => setTransformModifiers(ctx, n, "nope")).toThrow(/array/);
  });

  it("figma.transformGroup wraps the nodes (ADD_TRANSFORM_MODIFIER), writes the modifiers in order and returns the group", () => {
    const { ctx, calls, props } = fakeCtx([node("0:1", { type: "CANVAS", parentIndex: undefined }), node("1:1"), node("1:2")], {
      onDraw: (id, args, doc) => {
        if (id !== "ADD_TRANSFORM_MODIFIER") return;
        doc.set("1:9", node("1:9", { type: "TRANSFORM", name: "Repeat group 1" }));
        for (const r of args.refs as string[]) doc.get(r)!.parentIndex = { guid: "1:9", position: "a" };
      },
    });
    const made = transformGroup(ctx, ["1:1", "1:2"], "0:1", -1, [linear, radial]);
    expect(made).toEqual({ $node: "1:9", $type: "TRANSFORM_GROUP" });
    expect(calls[0].id).toBe("ADD_TRANSFORM_MODIFIER");
    expect(calls[0].args).toMatchObject({ refs: ["1:1", "1:2"], modifier: { repeatType: "LINEAR", count: 3, offset: 16, unitType: "PIXELS", axis: "Y" } });
    expect(props.at(-1)!.fields.transformModifiers).toEqual([modifierFromApi(linear, "m"), modifierFromApi(radial, "m")]);
    expect(() => transformGroup(ctx, [], "0:1", -1, [])).toThrow(/at least one node/);
  });
});

describe("Draw plugin API: complex strokes", () => {
  const brushes = [node("0:50", { type: "BRUSH", name: "Spaghetti Western", brushType: "STRETCH" }), node("0:51", { type: "BRUSH", name: "Oi", brushType: "SCATTER" }), node("0:52", { type: "BRUSH", name: "My brush", brushType: "STRETCH" })];

  it("reads BASIC, DYNAMIC and BRUSH (built-in key or CUSTOM) from the document's implicit kind", () => {
    const { ctx } = fakeCtx([
      ...brushes,
      node("1:1"),
      node("1:2", { dynamicStrokeSettings: { frequency: 4, wiggle: 2, smoothen: 0.2 } }),
      node("1:3", { strokeBrushGuid: { sessionID: 0, localID: 50 }, stretchStrokeSettings: { orientation: "REVERSE" } }),
      node("1:4", { strokeBrushGuid: "0:51", scatterStrokeSettings: { gap: 2, rotation: 45 } }),
      node("1:5", { strokeBrushGuid: "0:52" }),
    ]);
    const read = (id: string) => complexStrokeProperties(ctx, ctx.ed.engine.readNode(id)!);
    expect(read("1:1")).toEqual({ type: "BASIC" });
    expect(read("1:2")).toEqual({ type: "DYNAMIC", frequency: 4, wiggle: 2, smoothen: 0.2 });
    expect(read("1:3")).toEqual({ type: "BRUSH", brushType: "STRETCH", brushName: "SPAGHETTI_WESTERN", direction: "BACKWARD" });
    expect(read("1:4")).toEqual({ type: "BRUSH", brushType: "SCATTER", brushName: "OI", gap: 2, wiggle: 0, angularJitter: 0, rotation: 45, sizeJitter: 0 });
    expect(read("1:5")).toEqual({ type: "BRUSH", brushType: "STRETCH", brushName: "CUSTOM", direction: "FORWARD" });
    expect(brushNameOf("Heist", "SCATTER")).toBe("CUSTOM");
  });

  it("writes BASIC / DYNAMIC through SET_STROKE_KIND, checking Figma's ranges", () => {
    const { ctx, calls } = fakeCtx([node("1:1")]);
    const n = ctx.ed.engine.readNode("1:1")!;
    setComplexStrokeProperties(ctx, n, { type: "DYNAMIC", frequency: 3, wiggle: 1, smoothen: 0.5 });
    setComplexStrokeProperties(ctx, n, { type: "BASIC" });
    expect(calls).toEqual([
      { id: "SET_STROKE_KIND", args: { refs: ["1:1"], kind: "DYNAMIC", dynamic: { frequency: 3, wiggle: 1, smoothen: 0.5 } } },
      { id: "SET_STROKE_KIND", args: { refs: ["1:1"], kind: "BASIC" } },
    ]);
    expect(() => setComplexStrokeProperties(ctx, n, { type: "DYNAMIC", frequency: 0, wiggle: 1, smoothen: 0.5 })).toThrow(/frequency: must be between 0.01 and 20/);
    expect(() => setComplexStrokeProperties(ctx, n, { type: "DYNAMIC", frequency: 1, wiggle: 1, smoothen: 2 })).toThrow(/smoothen/);
    expect(() => setComplexStrokeProperties(ctx, n, { type: "WOBBLY" })).toThrow(/invalid enum value 'WOBBLY'/);
  });

  it("writes a loaded built-in brush (SET_STROKE_BRUSH then SET_BRUSH_SETTINGS); CUSTOM and unloaded brushes throw", () => {
    const { ctx, calls } = fakeCtx([node("1:1")]);
    const n = ctx.ed.engine.readNode("1:1")!;
    expect(() => setComplexStrokeProperties(ctx, n, { type: "BRUSH", brushType: "STRETCH", brushName: "HEIST", direction: "FORWARD" })).toThrow("The brush HEIST isn't loaded: call figma.loadBrushesAsync('STRETCH') first");
    expect(() => setComplexStrokeProperties(ctx, n, { type: "BRUSH", brushType: "STRETCH", brushName: "CUSTOM", direction: "FORWARD" })).toThrow("Setting a custom brush is not supported yet");
    expect(() => setComplexStrokeProperties(ctx, n, { type: "BRUSH", brushType: "SCATTER", brushName: "HEIST" })).toThrow(/invalid enum value 'HEIST' for a scatter brush/);
    loadBrushes(ctx, "STRETCH");
    setComplexStrokeProperties(ctx, n, { type: "BRUSH", brushType: "STRETCH", brushName: "HEIST", direction: "BACKWARD" });
    expect(calls).toEqual([
      { id: "SET_STROKE_BRUSH", args: { refs: ["1:1"], brush: "0:100" } },
      { id: "SET_BRUSH_SETTINGS", args: { refs: ["1:1"], stretch: { direction: "BACKWARD" } } },
    ]);
    loadBrushes(ctx, "SCATTER");
    calls.length = 0;
    setComplexStrokeProperties(ctx, n, { type: "BRUSH", brushType: "SCATTER", brushName: "OI", gap: 1, wiggle: 0, sizeJitter: 1, angularJitter: -30, rotation: 10 });
    expect(calls[1]).toEqual({ id: "SET_BRUSH_SETTINGS", args: { refs: ["1:1"], scatter: { gap: 1, wiggle: 0, sizeJitter: 1, angularJitter: -30, rotation: 10 } } });
    expect(() => setComplexStrokeProperties(ctx, n, { type: "BRUSH", brushType: "SCATTER", brushName: "OI", gap: 1, wiggle: 0, sizeJitter: 4, angularJitter: 0, rotation: 0 })).toThrow(/sizeJitter: must be between 0 and 3/);
  });

  it("loadBrushesAsync installs every built-in of the type (our artwork, Figma's names); the stub reads as not supported", () => {
    const { ctx, installed } = fakeCtx([]);
    loadBrushes(ctx, "STRETCH");
    expect(installed.map((b) => b.name)).toEqual(BUILTIN_BRUSHES.filter((b) => b.type === "STRETCH").map((b) => b.name));
    loadBrushes(ctx, "SCATTER");
    expect(installed).toHaveLength(25);
    expect(() => loadBrushes(ctx, "CUSTOM")).toThrow(/invalid brush type/);
    expect(() => loadBrushes(fakeCtx([], { stubs: true }).ctx, "STRETCH")).toThrow("loadBrushesAsync is not supported in Wecra yet");
  });

  it("variableWidthStrokeProperties: presets and custom points (width = ascent + descent), null for dynamic strokes", () => {
    const { ctx, props } = fakeCtx([node("1:1"), node("1:2", { dynamicStrokeSettings: { frequency: 1, wiggle: 1, smoothen: 1 } })]);
    const n = ctx.ed.engine.readNode("1:1")!;
    expect(variableWidthStrokeProperties(ctx, n)).toEqual({ widthProfile: "UNIFORM" });
    setVariableWidthStrokeProperties(ctx, n, { widthProfile: "EYE" });
    expect(variableWidthStrokeProperties(ctx, ctx.ed.engine.readNode("1:1")!)).toEqual({ widthProfile: "EYE" });
    setVariableWidthStrokeProperties(ctx, n, { widthProfile: "CUSTOM", variableWidthPoints: [{ position: 1, width: 0.5 }, { position: 0, width: 2 }] });
    expect(props.at(-1)!.fields.variableWidthPoints).toEqual([
      { position: 0, ascent: 1, descent: 1 },
      { position: 1, ascent: 0.25, descent: 0.25 },
    ]);
    expect(variableWidthStrokeProperties(ctx, ctx.ed.engine.readNode("1:1")!)).toEqual({ widthProfile: "CUSTOM", variableWidthPoints: [{ position: 0, width: 2 }, { position: 1, width: 0.5 }] });
    setVariableWidthStrokeProperties(ctx, n, null);
    expect(props.at(-1)!.fields.variableWidthPoints).toEqual([]);
    const dyn = ctx.ed.engine.readNode("1:2")!;
    expect(variableWidthStrokeProperties(ctx, dyn)).toBeNull();
    expect(() => setVariableWidthStrokeProperties(ctx, dyn, { widthProfile: "EYE" })).toThrow(/dynamic strokes/);
    expect(() => setVariableWidthStrokeProperties(ctx, n, { widthProfile: "BLOB" })).toThrow(/invalid enum value 'BLOB'/);
  });
});
