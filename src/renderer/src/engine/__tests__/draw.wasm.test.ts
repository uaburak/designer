// Figma Draw through Engine.ts on the real engine (the committed release Wasm; docs/draw.md §4.5, §4.7; round 7b):
// installBrush / listBrushes / brushPreview / setDrawToolSettings, the commands 310–321 with their DrawCommandArgs,
// the Brush tool's stroke, ⌘-click sampling (DRAW_TOOL_SAMPLED), the Text on path tool and the cursors.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { MOD_META, MOD_PRIMARY, PointerType, Status } from "../abi";
import type { EngineEvent, Message, NodeChange } from "../codec";
import { Engine } from "../Engine";
import { loadEngine } from "../loadEngine";
import { BUILTIN_BRUSHES } from "../../../../shared/draw/brushes";
import { BUILTIN_SCATTER_SETTINGS, DRAW_TOOL_DEFAULTS, REPEAT_DEFAULTS, splitTValue } from "../../../../shared/draw/types";

const wasm = fileURLToPath(new URL("../wasm/engine.wasm", import.meta.url));

beforeAll(async () => {
  const g = globalThis as Record<string, unknown>;
  g.window ??= globalThis;
  g.document ??= { querySelector: () => null };
  const bytes = readFileSync(wasm);
  await loadEngine({ wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), printErr: () => {} });
});

type Any = Record<string, unknown>;

const black = { type: "SOLID", color: { r: 0, g: 0, b: 0, a: 1 }, opacity: 1, visible: true };
const at = (x: number, y: number) => ({ m00: 1, m01: 0, m02: x, m10: 0, m11: 1, m12: y });

// A page with two rectangles (1:1 at 0,0 and 1:2 at 100,0, 20 × 20) and an ellipse 1:3 (300, 0, 100 × 100) with a
// stroke; the camera puts world (0, 0) at screen (100, 100).
const DOC: Message = {
  type: "NODE_CHANGES",
  sessionID: 0,
  nodeChanges: [
    { guid: "0:0", phase: "CREATED", type: "DOCUMENT", name: "Document" },
    { guid: "0:1", phase: "CREATED", type: "CANVAS", name: "Page 1", parentIndex: { guid: "0:0", position: "!" } },
    { guid: "0:2", phase: "CREATED", type: "CANVAS", name: "Internal Only Canvas", parentIndex: { guid: "0:0", position: "~" }, internalOnly: true, visible: false },
    { guid: "1:1", phase: "CREATED", type: "ROUNDED_RECTANGLE", name: "A", parentIndex: { guid: "0:1", position: "!" }, size: { x: 20, y: 20 }, transform: at(0, 0), fillPaints: [black] },
    { guid: "1:2", phase: "CREATED", type: "ROUNDED_RECTANGLE", name: "B", parentIndex: { guid: "0:1", position: '"' }, size: { x: 20, y: 20 }, transform: at(100, 0), fillPaints: [black] },
    {
      guid: "1:3",
      phase: "CREATED",
      type: "ELLIPSE",
      name: "Circle",
      parentIndex: { guid: "0:1", position: "#" },
      size: { x: 100, y: 100 },
      transform: at(300, 0),
      strokePaints: [{ ...black, color: { r: 1, g: 0, b: 0, a: 1 } }],
      strokeWeight: 5,
    },
  ] as NodeChange[],
};

async function engine(): Promise<{ e: Engine; events: EngineEvent[] }> {
  const e = await Engine.create(null, { sessionID: 1 });
  e.load(DOC);
  e.setViewport(1200, 900, 1, 1200, 900);
  e.setCamera({ x: 100, y: 100, zoom: 1 });
  const events: EngineEvent[] = [];
  e.onAny((ev) => events.push(ev));
  return { e, events };
}

const labels = (events: EngineEvent[]) => events.flatMap((ev) => (ev.type === "DOCUMENT_CHANGED" && ev.label !== "Install brush" ? [ev.label] : []));  // installing is a system write
const node = (e: Engine, id: string) => e.readNode(id, { childIds: true }) as (NodeChange & Any) | null;

function click(e: Engine, x: number, y: number, mods = 0): void {
  e.pointer(PointerType.DOWN, x, y, 0, 1, mods);
  e.pointer(PointerType.UP, x, y, 0, 0, mods);
}

describe("Draw (wasm, headless)", () => {
  it("brushes: installed once by name and type, listed, previewed as RGBA", async () => {
    const { e } = await engine();
    const heist = BUILTIN_BRUSHES.find((b) => b.key === "HEIST")!;
    const guid = e.installBrush({ name: heist.name, type: heist.type, artwork: heist.artwork });
    expect(guid).toMatch(/^\d+:\d+$/);
    expect(e.installBrush({ name: heist.name, type: heist.type, artwork: heist.artwork })).toBe(guid);
    expect(e.listBrushes()).toEqual([{ guid, name: "Heist", type: "STRETCH" }]);
    expect(node(e, guid!)!.parentIndex?.guid).toBe("0:2");
    // Bad artwork: refused.
    expect(e.installBrush({ name: "X", type: "STRETCH", artwork: { width: 10, height: 10, d: "nonsense", windingRule: "NONZERO" } })).toBeNull();
    for (const src of [{ brush: guid! }, { artwork: BUILTIN_BRUSHES.find((b) => b.key === "BUBBLEGUM")!.artwork, type: "SCATTER" as const }]) {
      const px = e.brushPreview(src, 96, 24, 6)!;
      expect(px.width).toBe(96);
      expect(px.height).toBe(24);
      let inked = 0;
      for (let i = 3; i < px.pixels.length; i += 4) if (px.pixels[i] > 128) inked++;
      expect(inked).toBeGreaterThan(20);
    }
    expect(e.brushPreview({ brush: "9:9" }, 96, 24, 6)).toBeNull();
    e.destroy();
  });

  it("repeats: Add / Change / Remove repeat and Apply transforms through runDrawCommand, one undo step each", async () => {
    const { e, events } = await engine();
    e.setSelection(["1:1", "1:2"]);
    expect(e.runDrawCommand("ADD_TRANSFORM_MODIFIER", { modifier: REPEAT_DEFAULTS.LINEAR })).toBe(Status.OK);
    const group = e.getSelection().refs[0];
    const g = node(e, group)!;
    expect(g.type).toBe("TRANSFORM");
    expect(g.name).toBe("Repeat group 1");
    expect(g.childIds).toEqual(["1:1", "1:2"]);
    expect((g.transformModifiers as Any[])[0]).toMatchObject({ type: "REPEAT", repeatType: "LINEAR", count: 3, axis: "X", unitType: "PIXELS", offset: { x: 16 } });
    expect(g.size?.x).toBeCloseTo(120 * 3 + 2 * 16);
    expect(e.runDrawCommand("SET_TRANSFORM_MODIFIER", { ref: group, index: 0, modifier: { count: 2 } })).toBe(Status.OK);
    expect((node(e, group)!.transformModifiers as Any[])[0]).toMatchObject({ count: 2 });
    expect(e.runDrawCommand("APPLY_TRANSFORMS", {})).toBe(Status.OK);
    const applied = node(e, e.getSelection().refs[0])!;
    expect(applied.type).toBe("FRAME");
    expect(applied.childIds).toHaveLength(4);
    expect(labels(events)).toEqual(["Add repeat", "Change repeat", "Apply transforms"]);
    e.command("UNDO");
    expect(node(e, group)!.type).toBe("TRANSFORM");
    expect(e.runDrawCommand("REMOVE_TRANSFORM_MODIFIER", { ref: group, index: 0 })).toBe(Status.OK);
    expect(node(e, group)!.transformModifiers ?? []).toEqual([]);
    expect(e.runDrawCommand("MOVE_TRANSFORM_MODIFIER", { ref: group, from: 0, to: 1 })).toBe(Status.E_INVALID);
    e.destroy();
  });

  it("stroke kinds and brushes: SET_STROKE_KIND, SET_STROKE_BRUSH, SET_BRUSH_SETTINGS, CREATE_BRUSH", async () => {
    const { e, events } = await engine();
    e.setSelection(["1:3"]);
    expect(e.runDrawCommand("SET_STROKE_KIND", { kind: "DYNAMIC", dynamic: { wiggle: 2 } })).toBe(Status.OK);
    expect(node(e, "1:3")!.dynamicStrokeSettings).toMatchObject({ frequency: 0.75, wiggle: 2, smoothen: 0.5 });
    expect(Number(node(e, "1:3")!.strokeSeed)).toBeGreaterThan(0);
    const bubble = BUILTIN_BRUSHES.find((b) => b.key === "BUBBLEGUM")!;
    // Installed with Figma's own settings (rea/vector.md §5): applying it writes them over the base gap 0.9.
    const guid = e.installBrush({ name: bubble.name, type: bubble.type, artwork: bubble.artwork, settings: BUILTIN_SCATTER_SETTINGS.BUBBLEGUM })!;
    expect(node(e, guid)!.scatterStrokeSettings).toMatchObject({ angularJitter: 95, rotation: 45 });
    expect(e.runDrawCommand("SET_STROKE_BRUSH", { brush: guid })).toBe(Status.OK);
    const n = node(e, "1:3")!;
    expect(n.dynamicStrokeSettings).toBeUndefined();
    const sc = n.scatterStrokeSettings as { gap: number; angularJitter: number; rotation: number };
    expect(sc.gap).toBeCloseTo(0.25, 5);
    expect(sc).toMatchObject({ angularJitter: 95, rotation: 45 });
    expect(e.runDrawCommand("SET_BRUSH_SETTINGS", { scatter: { gap: 3 } })).toBe(Status.OK);
    expect(node(e, "1:3")!.scatterStrokeSettings).toMatchObject({ gap: 3 });
    // Create brush: the circle is closed; it stays, a third BRUSH node appears.
    expect(e.commandState("CREATE_BRUSH") & 1).toBe(1);
    const made = e.runCommand("CREATE_BRUSH", { ref: "1:3", brushType: "STRETCH" });
    expect(made.status).toBe(Status.OK);
    expect(e.listBrushes().map((b) => b.name)).toContain("Circle");
    expect(labels(events)).toEqual(["Change stroke", "Change stroke", "Change stroke", "Create brush"]);
    e.destroy();
  });

  it("the Brush tool draws with its settings; ⌘-click with the Pencil samples a stroke", async () => {
    const { e, events } = await engine();
    const heist = BUILTIN_BRUSHES.find((b) => b.key === "HEIST")!;
    const guid = e.installBrush({ name: heist.name, type: heist.type, artwork: heist.artwork })!;
    expect(e.setDrawToolSettings({ ...DRAW_TOOL_DEFAULTS, brush: { color: "#0000FF", opacity: 1, weight: 10, brush: guid } })).toBe(Status.OK);
    expect(e.setTool("BRUSH")).toBe(Status.OK);
    e.pointer(PointerType.DOWN, 200, 500, 0, 1, 0);
    for (let i = 1; i <= 10; i++) e.pointer(PointerType.MOVE, 200 + i * 30, 500 + (i % 2) * 20, 0, 1, 0);
    e.pointer(PointerType.UP, 500, 500, 0, 0, 0);
    expect(labels(events)).toEqual(["Brush"]);
    const stroke = node(e, e.getSelection().refs[0])!;
    expect(stroke.type).toBe("VECTOR");
    expect(stroke.strokeWeight).toBe(10);
    expect(stroke.strokeBrushGuid).toBeDefined();
    // ⌘-click with the Pencil on the circle's stroke (its right edge: world 400, 50 → screen 500, 150).
    const sampled: Any[] = [];
    e.on("DRAW_TOOL_SAMPLED", (ev) => sampled.push(ev as unknown as Any));
    e.setTool("PENCIL");
    click(e, 500, 150, MOD_PRIMARY | MOD_META);
    expect(sampled).toEqual([expect.objectContaining({ type: "DRAW_TOOL_SAMPLED", tool: "PENCIL", color: "#FF0000", weight: 5, kind: "BASIC" })]);
    expect(labels(events)).toEqual(["Brush"]);  // no stroke drawn
    e.destroy();
  });

  it("text on a path: CREATE_TEXT_PATH (and the plugin's replace), FLIP, SET_TEXT_PATH_START; the tool's cursor", async () => {
    const { e, events } = await engine();
    const made = e.runCommand("CREATE_TEXT_PATH", { ref: "1:3", segment: 1, position: 0.5, replace: false });
    expect(made.status).toBe(Status.OK);
    const t = made.created[0];
    const tp = node(e, t)!;
    expect(tp.type).toBe("TEXT_PATH");
    expect(tp.textPathStart).toMatchObject({ tValue: 1.5, forward: true });
    expect(node(e, "1:3")).not.toBeNull();
    expect(e.runDrawCommand("FLIP_TEXT_PATH", { refs: [t] })).toBe(Status.OK);
    expect(node(e, t)!.textPathStart).toMatchObject({ forward: false });
    expect(e.runDrawCommand("SET_TEXT_PATH_START", { ref: t, segment: 2, position: 0.25 })).toBe(Status.OK);
    expect(splitTValue((node(e, t)!.textPathStart as { tValue: number }).tValue)).toEqual({ segment: 2, position: 0.25 });
    const replaced = e.runCommand("CREATE_TEXT_PATH", { ref: "1:1", segment: 0, position: 0, replace: true });
    expect(replaced.status).toBe(Status.OK);
    expect(node(e, "1:1")).toBeNull();
    expect(node(e, replaced.created[0])!.name).toBe("A");
    expect(labels(events)).toEqual(["Text on path", "Flip text path", "Move text start", "Text on path"]);
    // The tool over the circle's edge: the Text on path cursor (world 350, 0 → screen 450, 100).
    const cursors: string[] = [];
    e.on("CURSOR", (ev) => cursors.push(ev.kind));
    e.setTool("TEXT_PATH");
    e.pointer(PointerType.MOVE, 450, 101, 0, 0, 0);
    expect(cursors.at(-1)).toBe("TEXT_PATH");
    e.pointer(PointerType.MOVE, 1000, 800, 0, 0, 0);
    expect(cursors.at(-1)).toBe("IBEAM");
    e.destroy();
  });

  it("TEXT_PATH and TRANSFORM nodes survive applyChanges and read back", async () => {
    const { e } = await engine();
    e.applyChanges(
      {
        type: "NODE_CHANGES",
        sessionID: 1,
        nodeChanges: [
          { guid: "1:30", phase: "CREATED", type: "TRANSFORM", name: "Repeat group 1", parentIndex: { guid: "0:1", position: "z" }, size: { x: 80, y: 80 }, transform: at(0, 400), transformModifiers: [{ type: "REPEAT", repeatType: "RADIAL", count: 6, unitType: "PIXELS", offset: { x: 10, y: 0 }, visible: true }] },
          { guid: "1:31", phase: "CREATED", type: "ELLIPSE", name: "Dot", parentIndex: { guid: "1:30", position: "!" }, size: { x: 20, y: 20 }, transform: at(0, 0) },
          { guid: "1:32", phase: "CREATED", type: "TEXT_PATH", name: "Around", parentIndex: { guid: "0:1", position: "zz" }, size: { x: 100, y: 100 }, textData: { characters: "Around" }, fontSize: 12, textPathStart: { tValue: 1.5, forward: true } },
        ] as unknown as NodeChange[],
      },
      "user"
    );
    expect(node(e, "1:30")).toMatchObject({ type: "TRANSFORM", childIds: ["1:31"] });
    expect(node(e, "1:32")).toMatchObject({ type: "TEXT_PATH", textPathStart: { tValue: 1.5, forward: true } });
    e.destroy();
  });
});
