// @vitest-environment happy-dom
// The Plugin API for Draw (docs/draw.md §7) through QuickJS and figma.js on the real engine: what works on today's
// engine (the stroke kind read from the document, variable width written as points, the API's shape), and — skipped
// until round 7b's engine lands its Draw commands — text paths, transform groups and brushes end to end.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { Engine } from "@/engine/Engine";
import { EngineStore } from "@/engine/EngineStore";
import { loadEngine } from "@/engine/loadEngine";
import { SAMPLE_DOCUMENT } from "@/engine/sampleDocument";
import type { NodeFields } from "@/engine/codec";
import { EditorController } from "../../controller";
import { memoryDocumentSource } from "../../documentSource";
import { PluginRun, type RunSpec } from "../host";
import { PluginUiStore } from "../ui/store";

const wasm = join(process.cwd(), "src/renderer/src/engine/wasm/engine.wasm");

beforeAll(async () => {
  globalThis.fetch = async () => new Response(null, { status: 404 });
  const bytes = readFileSync(wasm);
  await loadEngine({ wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), printErr: () => {} });
});

async function editor() {
  const source = memoryDocumentSource(SAMPLE_DOCUMENT, { fileName: "Draw plugin test" });
  const engine = await Engine.create(null, { sessionID: 1 });
  engine.load(await source.load());
  engine.setViewport(1280, 800, 1, 1280, 800);
  const ed = new EditorController(engine, new EngineStore(engine), source);
  return { ed, engine };
}

const inline = (code: string): RunSpec => ({
  pluginId: "inline",
  name: "Inline",
  manifest: { name: "Inline", id: "inline", api: "1.0.0", main: "code.js", networkAccess: { allowedDomains: ["none"] } },
  code,
  ui: {},
  development: true,
  command: "",
});

/** Runs `code` (which ends with figma.closePlugin) and gives back what it stored as JSON under "result". */
async function runFor(ed: EditorController, engine: Engine, code: string): Promise<{ result: unknown; logs: string[][] }> {
  const logs: string[][] = [];
  const body = `(async () => {\n${code}\n})().catch((e) => { console.error(String(e && e.message ? e.message : e)); figma.closePlugin(); });`;
  const r = new PluginRun(inline(body), { ed, desktop: null, ui: new PluginUiStore(), console: (level, args) => logs.push([level, ...args]) });
  await r.start();
  await Promise.race([r.ended, new Promise((_, rej) => setTimeout(() => rej(new Error("the run didn't end")), 3000))]);
  const raw = (engine.readNode("0:0")?.pluginData ?? []).find((e) => e.key === "result")?.value;
  return { result: raw ? JSON.parse(raw) : undefined, logs };
}

describe("plugins: the Draw API on the engine (docs/draw.md §7)", () => {
  it("figma has createTextPath / transformGroup / loadBrushesAsync; geometry nodes have the ComplexStrokesMixin", async () => {
    const { ed, engine } = await editor();
    const { result } = await runFor(
      ed,
      engine,
      `const r = figma.createRectangle();
       figma.root.setPluginData("result", JSON.stringify({
         fns: ["createTextPath", "transformGroup", "loadBrushesAsync"].map((k) => typeof figma[k]),
         mixin: ["complexStrokeProperties", "variableWidthStrokeProperties", "setStrokesAsync", "setFillsAsync"].map((k) => k in r),
         basic: r.complexStrokeProperties,
       }));
       r.remove();
       figma.closePlugin();`
    );
    expect(result).toEqual({ fns: ["function", "function", "function"], mixin: [true, true, true, true], basic: { type: "BASIC" } });
  });

  it("complexStrokeProperties reads a dynamic stroke the document holds; variableWidthStrokeProperties writes points", async () => {
    const { ed, engine } = await editor();
    ed.setProps(["1:5"], { dynamicStrokeSettings: { frequency: 4, wiggle: 2, smoothen: 0.25 } } as unknown as NodeFields);
    const { result, logs } = await runFor(
      ed,
      engine,
      `const card = await figma.getNodeByIdAsync("1:5");
       const header = await figma.getNodeByIdAsync("1:2");
       header.variableWidthStrokeProperties = { widthProfile: "CUSTOM", variableWidthPoints: [{ position: 0, width: 2 }, { position: 1, width: 0.5 }] };
       let refused = "";
       try { card.variableWidthStrokeProperties = { widthProfile: "EYE" }; } catch (e) { refused = e.message; }
       figma.root.setPluginData("result", JSON.stringify({ card: card.complexStrokeProperties, width: header.variableWidthStrokeProperties, refused, dynWidth: card.variableWidthStrokeProperties }));
       figma.closePlugin();`
    );
    expect(logs.filter((l) => l[0] === "error")).toEqual([]);
    expect(result).toEqual({
      card: { type: "DYNAMIC", frequency: 4, wiggle: 2, smoothen: 0.25 },
      width: { widthProfile: "CUSTOM", variableWidthPoints: [{ position: 0, width: 2 }, { position: 1, width: 0.5 }] },
      refused: expect.stringMatching(/dynamic strokes/),
      dynWidth: null,
    });
    expect((engine.readNode("1:2") as unknown as { variableWidthPoints?: unknown[] }).variableWidthPoints).toHaveLength(2);
  });

  it("calls into the engine's Draw commands answer Figma-style until round 7b builds them", async () => {
    const { ed, engine } = await editor();
    // Only meaningful while Engine.ts's Draw calls are stubs; once 7b lands, the skipped tests below take over.
    let built = true;
    try {
      engine.listBrushes();
    } catch {
      built = false;
    }
    if (built) return;
    const { result } = await runFor(
      ed,
      engine,
      `const out = [];
       const v = figma.createVector();
       for (const f of [() => figma.createTextPath(v, 0, 0), () => figma.transformGroup([v], figma.currentPage, 0, [])]) {
         try { f(); out.push("ok"); } catch (e) { out.push(e.message); }
       }
       try { await figma.loadBrushesAsync("STRETCH"); out.push("ok"); } catch (e) { out.push(e.message); }
       v.remove();
       figma.root.setPluginData("result", JSON.stringify(out));
       figma.closePlugin();`
    );
    expect(result).toEqual(["createTextPath is not supported in DesignerV2 yet", "transformGroup is not supported in DesignerV2 yet", "loadBrushesAsync is not supported in DesignerV2 yet"]);
  });

  // TODO(7b): enable when round 7b's engine implements CREATE_TEXT_PATH / ADD_TRANSFORM_MODIFIER / INSTALL_BRUSH /
  // SET_STROKE_BRUSH (docs/roadmap.md "Round 7", step 7: "7e's plugin wasm tests are switched on").
  it.skip("createTextPath replaces an ellipse with a TEXT_PATH in its place; textPathStartData round-trips (7b)", async () => {
    const { ed, engine } = await editor();
    const { result } = await runFor(
      ed,
      engine,
      `const e = figma.createEllipse();
       const index = e.parent.children.indexOf(e);
       const t = figma.createTextPath(e, 2, 0.5);
       await figma.loadFontAsync({ family: "Inter", style: "Regular" });
       t.characters = "Around";
       t.textPathStartData = { segment: 1, position: 0.25 };
       figma.root.setPluginData("result", JSON.stringify({ type: t.type, removed: e.removed, same: t.parent.children.indexOf(t) === index, start: t.textPathStartData, chars: t.characters }));
       figma.closePlugin();`
    );
    expect(result).toEqual({ type: "TEXT_PATH", removed: true, same: true, start: { segment: 1, position: 0.25 }, chars: "Around" });
  });

  it.skip("transformGroup makes a TRANSFORM_GROUP with the modifiers; transformModifiers round-trips (7b)", async () => {
    const { ed, engine } = await editor();
    const { result } = await runFor(
      ed,
      engine,
      `const r = figma.createRectangle();
       const g = figma.transformGroup([r], figma.currentPage, 0, [{ type: "REPEAT", repeatType: "LINEAR", axis: "HORIZONTAL", count: 4, unitType: "PIXELS", offset: 10 }]);
       g.transformModifiers = [...g.transformModifiers, { type: "REPEAT", repeatType: "RADIAL", count: 6, unitType: "RELATIVE", offset: 0.5 }];
       figma.root.setPluginData("result", JSON.stringify({ type: g.type, child: g.children[0].id === r.id, modifiers: g.transformModifiers }));
       figma.closePlugin();`
    );
    expect(result).toEqual({
      type: "TRANSFORM_GROUP",
      child: true,
      modifiers: [
        { type: "REPEAT", repeatType: "LINEAR", axis: "HORIZONTAL", count: 4, unitType: "PIXELS", offset: 10 },
        { type: "REPEAT", repeatType: "RADIAL", count: 6, unitType: "RELATIVE", offset: 0.5 },
      ],
    });
  });

  it.skip("loadBrushesAsync installs the built-ins; a brush stroke reads back by name; DYNAMIC clears it (7b)", async () => {
    const { ed, engine } = await editor();
    const { result } = await runFor(
      ed,
      engine,
      `await figma.loadBrushesAsync("SCATTER");
       const v = figma.createVector();
       v.strokes = [figma.util.solidPaint("#000")];
       v.complexStrokeProperties = { type: "BRUSH", brushType: "SCATTER", brushName: "BUBBLEGUM", gap: 2, wiggle: 0, sizeJitter: 0, angularJitter: 0, rotation: 0 };
       const brush = v.complexStrokeProperties;
       v.complexStrokeProperties = { type: "DYNAMIC", frequency: 2, wiggle: 1, smoothen: 0.5 };
       figma.root.setPluginData("result", JSON.stringify({ brush, dynamic: v.complexStrokeProperties }));
       figma.closePlugin();`
    );
    expect(result).toEqual({
      brush: { type: "BRUSH", brushType: "SCATTER", brushName: "BUBBLEGUM", gap: 2, wiggle: 0, sizeJitter: 0, angularJitter: 0, rotation: 0 },
      dynamic: { type: "DYNAMIC", frequency: 2, wiggle: 1, smoothen: 0.5 },
    });
  });
});
