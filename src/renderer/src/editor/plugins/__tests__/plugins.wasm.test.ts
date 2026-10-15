// @vitest-environment happy-dom
// The plugin host on the real engine and QuickJS (docs/plugins.md §5's fixture plugins): rectangles made and selected,
// a run as one undo step (commitUndo splits it), plugin data and relaunch data stored in the document, the UI round
// trip, network refused outside the manifest, clientStorage, dynamic-page rules, parameters, codegen, the sandbox's
// escapes refused, Stop ending a runaway loop, and createSandbox for templates.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { Engine } from "@/engine/Engine";
import { EngineStore } from "@/engine/EngineStore";
import { loadEngine } from "@/engine/loadEngine";
import { SAMPLE_DOCUMENT } from "@/engine/sampleDocument";
import type { Guid, NodeChange } from "@/engine/codec";
import { parseManifest } from "@shared/plugins/manifest";
import { allowedUrl, refusedMessage } from "@shared/plugins/network";
import type { PluginFetchResponse } from "@shared/ipc";
import { EditorController } from "../../controller";
import { setExportAllowed } from "../../exporting";
import { memoryDocumentSource } from "../../documentSource";
import { PluginRun, type RunSpec } from "../host";
import { createSandbox } from "../index";
import type { PluginDesktop } from "../desktop";
import { PluginUiStore } from "../ui/store";

const wasm = join(process.cwd(), "src/renderer/src/engine/wasm/engine.wasm");
const FIXTURES = join(process.cwd(), "src/renderer/src/editor/plugins/__tests__/fixtures");

beforeAll(async () => {
  globalThis.fetch = async () => new Response(null, { status: 404 });
  const bytes = readFileSync(wasm);
  await loadEngine({ wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), printErr: () => {} });
});

async function editor() {
  const source = memoryDocumentSource(SAMPLE_DOCUMENT, { fileName: "Plugins test" });
  const engine = await Engine.create(null, { sessionID: 1 });
  engine.load(await source.load());
  engine.setViewport(1280, 800, 1, 1280, 800);
  const ed = new EditorController(engine, new EngineStore(engine), source);
  return { ed, engine };
}

/** A fake main: fetch checks the manifest the way main does (src/shared/plugins/network.ts), storage in memory. */
function fakeDesktop(manifestOf: () => RunSpec["manifest"]): PluginDesktop & { fetched: string[]; storageMap: Map<string, unknown> } {
  const storageMap = new Map<string, unknown>();
  const fetched: string[] = [];
  return {
    fetched,
    storageMap,
    listDevelopment: async () => [],
    importManifest: async () => ({ cancelled: true }),
    removeDevelopment: async () => [],
    read: async () => {
      throw new Error("not in tests");
    },
    newPlugin: async () => ({ cancelled: true }),
    beginRun: async () => {},
    endRun: async () => {},
    openUi: async ({ runId }) => ({ url: `plugin://${runId}/ui.html` }),
    closeUi: async () => {},
    fetch: async ({ url }): Promise<PluginFetchResponse> => {
      if (!allowedUrl(manifestOf().networkAccess, url)) throw new Error(refusedMessage(url));
      fetched.push(url);
      return { status: 200, statusText: "OK", headers: { "content-type": "application/json" }, body: new TextEncoder().encode(JSON.stringify({ hello: "world" })) };
    },
    storage: async ({ op, pluginId, key, value }) => {
      const k = `${pluginId}/${key}`;
      if (op === "get") return storageMap.get(k);
      if (op === "set") return void storageMap.set(k, value);
      if (op === "delete") return void storageMap.delete(k);
      return [...storageMap.keys()].filter((x) => x.startsWith(`${pluginId}/`)).map((x) => x.slice(pluginId.length + 1));
    },
    openConsole: async () => {},
    onChanged: () => () => {},
  };
}

function fixture(name: string, extra: Partial<RunSpec> = {}): RunSpec {
  const dir = join(FIXTURES, name);
  const parsed = parseManifest(readFileSync(join(dir, "manifest.json"), "utf8"), { development: true, path: dir });
  if ("errors" in parsed) throw new Error(parsed.errors.join("; "));
  const m = parsed.manifest;
  const ui: Record<string, string> = typeof m.ui === "string" ? { "": readFileSync(join(dir, m.ui), "utf8") } : {};
  return { pluginId: m.id, name: m.name, manifest: m, code: readFileSync(join(dir, m.main), "utf8"), ui, development: true, command: "", ...extra };
}

async function run(ed: EditorController, spec: RunSpec, opts: { ui?: PluginUiStore; logs?: string[][]; desktop?: PluginDesktop | null } = {}) {
  const ui = opts.ui ?? new PluginUiStore();
  const logs = opts.logs ?? [];
  const desktop = opts.desktop === undefined ? fakeDesktop(() => spec.manifest) : opts.desktop;
  const r = new PluginRun(spec, { ed, desktop, ui, console: (level, args) => logs.push([level, ...args]) });
  await r.start();
  return { r, ui, logs };
}

const settle = () => new Promise((r) => setTimeout(r, 0));
async function untilEnded(r: PluginRun, ms = 2000) {
  await Promise.race([r.ended, new Promise((_, rej) => setTimeout(() => rej(new Error("the run didn't end")), ms))]);
}
const rootData = (engine: Engine, key: string) => (engine.readNode("0:0")?.pluginData ?? []).find((e) => e.key === key)?.value;
const pageChildren = (ed: EditorController): NodeChange[] => ed.engine.readNodes((ed.engine.readNode(ed.store.page, { childIds: true })?.childIds ?? []) as Guid[]);

describe("plugins: the figma API on the engine", () => {
  it("rectangles: five orange rectangles, selected, one undo step labelled with the plugin's name", async () => {
    const { ed, engine } = await editor();
    const before = pageChildren(ed).length;
    const { r } = await run(ed, fixture("rectangles"));
    await untilEnded(r);
    const kids = pageChildren(ed);
    expect(kids.length).toBe(before + 5);
    const made = kids.slice(-5);
    expect(made.map((n) => n.transform?.m02)).toEqual([0, 150, 300, 450, 600]);
    expect(made.every((n) => n.type === "ROUNDED_RECTANGLE" && n.fillPaints?.[0]?.color?.g === 0.5)).toBe(true);
    expect([...ed.selection].sort()).toEqual(made.map((n) => n.guid).sort());
    expect(ed.store.undo.undoLabel).toBe("Rectangles");
    engine.undo();
    expect(pageChildren(ed).length).toBe(before);
  });

  it("run once: auto layout, text, plugin data and shared plugin data in the document", async () => {
    const { ed, engine } = await editor();
    const { r } = await run(ed, fixture("run-once"));
    await untilEnded(r);
    const card = pageChildren(ed).find((n) => n.name === "Card")!;
    expect(card.stackMode).toBe("VERTICAL");
    expect(card.stackSpacing).toBe(8);
    expect(card.pluginData).toEqual(expect.arrayContaining([{ pluginID: "fixture-run-once", key: "kind", value: "card" }, { pluginID: "shared:fixtures.shared", key: "made", value: "yes" }]));
    const text = engine.readNode((engine.readNode(card.guid, { childIds: true })!.childIds as Guid[])[0])!;
    expect(text.textData?.characters).toBe("Hello from a plugin");
    expect(text.fontSize).toBe(20);
    // Plugin data is a document field: it is in the change Messages (journal) and the snapshot.
    const snapshot = engine.encodeDocument();
    expect(snapshot.nodeChanges.find((n) => n.guid === card.guid)?.pluginData?.length).toBe(2);
    expect(r.closeMessage).toBe("Made a card");
  });

  it("custom UI: showUI with themeColors, messages both ways, queued until the frame loads", async () => {
    const { ed } = await editor();
    const spec = fixture("custom-ui");
    const { r, ui } = await run(ed, spec);
    const w = ui.window(r.runId)!;
    expect(w).toMatchObject({ width: 232, height: 208, visible: true, title: "Custom UI" });
    await settle();
    expect(ui.window(r.runId)!.src).toEqual({ url: `plugin://${r.runId}/ui.html` });
    const posted: unknown[] = [];
    ui.frames.set(r.runId, { post: (m) => posted.push(m) });
    ui.handlers.get(r.runId)!.loaded();
    ui.handlers.get(r.runId)!.message({ type: "create-shapes", count: 3 }, "null");
    await settle();
    await settle();
    expect(posted).toHaveLength(1);
    const msg = posted[0] as { pluginMessage: { type: string; ids: string[] }; pluginId: string };
    expect(msg.pluginMessage.type).toBe("created");
    expect(msg.pluginMessage.ids).toHaveLength(3);
    expect(msg.pluginId).toBe("fixture-custom-ui");
    expect(ed.selection).toEqual(msg.pluginMessage.ids);
    // No "Running" toast while the UI shows.
    expect(ui.get().running).toEqual([]);
    ui.handlers.get(r.runId)!.message({ type: "cancel" }, "null");
    await untilEnded(r);
    expect(ui.window(r.runId)).toBeUndefined();
  });

  it("the browser build's UI is srcdoc with the manifest's CSP first", async () => {
    const { ed } = await editor();
    const { r, ui } = await run(ed, fixture("custom-ui"), { desktop: null });
    const src = ui.window(r.runId)!.src as { srcdoc: string };
    const csp = src.srcdoc.indexOf('<meta http-equiv="Content-Security-Policy" content="default-src \'none\';');
    expect(csp).toBeGreaterThan(-1);
    expect(csp).toBeLessThan(src.srcdoc.indexOf("<script"));
    expect(src.srcdoc).toContain('<style id="figma-style">');
    expect(src.srcdoc).toContain("connect-src 'none'");
    expect(src.srcdoc).toContain('class="figma-');
    r.stop();
  });

  it("selection colors: reads fills off the selection, figma.getSelectionColors", async () => {
    const { ed, engine } = await editor();
    const rect = pageChildren(ed).find((n) => n.fillPaints?.some((p) => p.type === "SOLID"))!;
    engine.setSelection([rect.guid]);
    const { r } = await run(ed, fixture("selection-colors"));
    await untilEnded(r);
    const result = JSON.parse(rootData(engine, "result")!);
    expect(result.found.length).toBeGreaterThan(0);
    expect(result.found[0]).toMatch(/^#[0-9A-F]{6}$/);
    expect(result.paints).toBeGreaterThan(0);
  });

  it("rename layers: the menu command, commitUndo splits the run into two steps", async () => {
    const { ed, engine } = await editor();
    const kids = pageChildren(ed).slice(0, 2);
    const names = kids.map((n) => n.name);
    engine.setSelection(kids.map((n) => n.guid));
    const { r } = await run(ed, fixture("rename-layers", { command: "number" }));
    await untilEnded(r);
    expect(engine.readNode(kids[0].guid)!.name).toBe("Layer 1 (first)");
    expect(engine.readNode(kids[1].guid)!.name).toBe("Layer 2");
    engine.undo();
    expect(engine.readNode(kids[0].guid)!.name).toBe("Layer 1");
    engine.undo();
    expect(kids.map((n) => engine.readNode(n.guid)!.name)).toEqual(names);
  });

  it("network: allowed inside networkAccess through main; refused outside with Figma's message", async () => {
    const { ed, engine } = await editor();
    const spec = fixture("network");
    const desktop = fakeDesktop(() => spec.manifest);
    const { r } = await run(ed, spec, { desktop });
    await untilEnded(r);
    const result = JSON.parse(rootData(engine, "result")!);
    expect(result.allowed).toEqual({ status: 200, body: { hello: "world" } });
    expect(result.refused).toBe(refusedMessage("https://evil.example.org/steal"));
    expect(desktop.fetched).toEqual(["https://api.example.com/v1/hello"]);
  });

  it("network: plugin code without main (the browser build) can't fetch", async () => {
    const { ed, engine } = await editor();
    const { r } = await run(ed, fixture("network"), { desktop: null });
    await untilEnded(r);
    expect(JSON.parse(rootData(engine, "result")!).allowed.error).toBe("Network access from plugin code needs the desktop app");
  });

  it("clientStorage: values and bytes kept per plugin across runs", async () => {
    const { ed, engine } = await editor();
    const spec = fixture("storage");
    const desktop = fakeDesktop(() => spec.manifest);
    for (let i = 0; i < 2; i++) await untilEnded((await run(ed, spec, { desktop })).r);
    expect(JSON.parse(rootData(engine, "result")!)).toEqual({ runs: 2, bytes: [1, 2, 3], keys: ["bytes", "runs"] });
  });

  it("dynamic-page: the sync lookups and currentPage = throw Figma's errors; the async ones work", async () => {
    const { ed, engine } = await editor();
    const { r } = await run(ed, fixture("dynamic-page"));
    await untilEnded(r);
    const result = JSON.parse(rootData(engine, "result")!);
    expect(result.sync).toContain("documentAccess: dynamic-page");
    expect(result.setPage).toContain("setCurrentPageAsync");
    expect(result.async).toBe(true);
    expect(result.pages).toBe(engine.pages().length);
  });

  it("parameters: suggestions for the key being typed, an error, then the run with the values", async () => {
    const { ed } = await editor();
    const before = pageChildren(ed).length;
    // The palette starts the run, asks for suggestions while the person types (figma.on("run") waits), then submits.
    const { r } = await run(ed, fixture("parameters", { awaitParameters: true }));
    expect(await r.parameterInput("shape", "el", {})).toEqual({ suggestions: ["Ellipse"] });
    expect(await r.parameterInput("count", "x", { shape: "Ellipse" })).toEqual({ error: "Type a number" });
    expect(pageChildren(ed).length).toBe(before);
    await r.submitParameters({ shape: "Ellipse", count: "3" });
    await untilEnded(r);
    const made = pageChildren(ed).slice(before);
    expect(made.map((n) => n.type)).toEqual(["ELLIPSE", "ELLIPSE", "ELLIPSE"]);
  });

  it("relaunch: buttons stored on the selected nodes; a relaunched run gets its command", async () => {
    const { ed, engine } = await editor();
    const node = pageChildren(ed)[0];
    engine.setSelection([node.guid]);
    const { r } = await run(ed, fixture("relaunch"));
    await untilEnded(r);
    expect(engine.readNode(node.guid)!.pluginRelaunchData).toEqual([
      { pluginID: "fixture-relaunch", command: "edit", message: "Change this shape", isDeleted: false },
      { pluginID: "fixture-relaunch", command: "open", message: "", isDeleted: false },
    ]);
    const again = await run(ed, fixture("relaunch", { command: "edit" }));
    await untilEnded(again.r);
    expect(rootData(engine, "relaunched")).toBe("edit");
  });

  it("codegen: generate answers CodegenResult[] for a node", async () => {
    const { ed } = await editor();
    const node = pageChildren(ed).find((n) => n.fillPaints?.some((p) => p.type === "SOLID"))!;
    const { r } = await run(ed, fixture("codegen-css", { mode: "codegen", editorType: "dev" }));
    const answer = await r.generate(node.guid, "css");
    expect(answer.error).toBeNull();
    const [block] = answer.result as { language: string; code: string; title: string }[];
    expect(block.language).toBe("CSS");
    expect(block.code).toContain(`width: ${node.size!.x}px;`);
    expect(block.code).toMatch(/background: rgb\(\d+, \d+, \d+\);/);
    r.stop();
  });
});

describe("plugins: the sandbox", () => {
  const inline = (code: string, extra: Partial<RunSpec> = {}): RunSpec => ({
    pluginId: "inline",
    name: "Inline",
    manifest: { name: "Inline", id: "inline", api: "1.0.0", main: "code.js", networkAccess: { allowedDomains: ["none"] } },
    code,
    ui: {},
    development: true,
    command: "",
    ...extra,
  });

  it("has no browser, editor or host globals; Figma's minimal globals are there", async () => {
    const { ed, engine } = await editor();
    const { r } = await run(
      ed,
      inline(`
        const out = {};
        for (const name of ["window", "document", "XMLHttpRequest", "WebSocket", "importScripts", "__hostCall", "__bridge", "require", "process", "indexedDB", "localStorage"]) out[name] = typeof globalThis[name];
        out.figmaFrozen = Object.isFrozen(figma);
        out.clone = structuredClone({ a: [1, { b: 2 }] }).a[1].b;
        out.timeoutType = typeof setTimeout;
        out.mixed = typeof figma.mixed;
        try { figma.foo = 1; } catch (e) { /* strict code throws */ } out.extend = figma.foo === undefined ? "refused" : "extended";
        figma.root.setPluginData("result", JSON.stringify(out));
        figma.closePlugin();
      `)
    );
    await untilEnded(r);
    const out = JSON.parse(rootData(engine, "result")!);
    for (const name of ["window", "document", "XMLHttpRequest", "WebSocket", "importScripts", "__hostCall", "__bridge", "require", "process", "indexedDB", "localStorage"]) expect(out[name], name).toBe("undefined");
    expect(out).toMatchObject({ figmaFrozen: true, clone: 2, timeoutType: "function", mixed: "symbol", extend: "refused" });
  });

  it("node handles are frozen; writes are checked as Figma's (types, read-only properties)", async () => {
    const { ed, engine } = await editor();
    const { r } = await run(
      ed,
      inline(`
        const rect = figma.createRectangle();
        const out = { same: figma.getNodeById(rect.id) === rect, type: rect.type, children: "children" in rect, frameChildren: "children" in figma.createFrame() };
        try { rect.width = 10; } catch (e) { out.width = e.message; }
        try { rect.fills = [{ type: "SOLID", color: { r: 2, g: 0, b: 0 } }]; } catch (e) { out.fills = e.message; }
        const fills = rect.fills; try { fills[0].opacity = 0.5; } catch (e) { /* strict code throws */ } out.frozenFill = fills[0].opacity === 1 && Object.isFrozen(fills) ? "frozen" : "changed";
        rect.resize(40, 30);
        out.size = [rect.width, rect.height];
        rect.cornerRadius = 6;
        rect.topLeftRadius = 2;
        out.mixed = rect.cornerRadius === figma.mixed;
        figma.root.setPluginData("result", JSON.stringify(out));
        figma.closePlugin();
      `)
    );
    await untilEnded(r);
    const out = JSON.parse(rootData(engine, "result")!);
    expect(out).toMatchObject({ same: true, type: "RECTANGLE", children: false, frameChildren: true, frozenFill: "frozen", size: [40, 30], mixed: true });
    expect(out.width).toContain("read only");
    expect(out.fills).toContain("between 0 and 1");
  });

  it("reactions: Figma's Reaction shape both ways (side swapped for every direction, EASE_IN, mouse delays)", async () => {
    const { ed, engine } = await editor();
    const { r } = await run(
      ed,
      inline(`
       (async () => { try {
        const a = figma.createFrame(), b = figma.createFrame();
        b.x = 400;
        const button = figma.createRectangle();
        a.appendChild(button);
        await button.setReactionsAsync([
          { trigger: { type: "ON_CLICK" }, actions: [{ type: "NODE", destinationId: b.id, navigation: "NAVIGATE", transition: { type: "MOVE_OUT", direction: "LEFT", matchLayers: false, duration: 0.4, easing: { type: "EASE_IN" } } }] },
          { trigger: { type: "MOUSE_ENTER", delay: 0.5 }, actions: [{ type: "BACK" }] },
        ]);
        let bad = null;
        try { await button.setReactionsAsync([{ trigger: { type: "ON_CLICK" }, actions: [{ type: "BACK", transition: { type: "DISSOLVE", easing: { type: "EASE_OUT", easingFunctionSpring: { mass: 1, stiffness: 1, damping: 1 } } } }] }]); } catch (e) { bad = e.message; }
        figma.root.setPluginData("result", JSON.stringify({ id: button.id, reactions: button.reactions, bad }));
       } catch (e) { figma.root.setPluginData("result", JSON.stringify({ error: String(e && e.message || e) })); }
        figma.closePlugin(); })();
      `),
    );
    await untilEnded(r);
    const out = JSON.parse(rootData(engine, "result")!);
    expect(out.error).toBeUndefined();
    expect(out.reactions).toHaveLength(2);
    expect(out.reactions[0]).toMatchObject({ trigger: { type: "ON_CLICK" }, actions: [{ type: "NODE", transition: { type: "MOVE_OUT", direction: "LEFT", duration: 0.4, easing: { type: "EASE_IN" } } }] });
    expect(out.reactions[0].action).toEqual(out.reactions[0].actions[0]);
    expect(out.reactions[0].id).toBeUndefined();
    expect(out.reactions[1].trigger).toEqual({ type: "MOUSE_ENTER", delay: 0.5 });
    expect(out.bad).toContain("easingFunctionSpring");
    const doc = (engine.readNode(out.id) as { prototypeInteractions?: { stateManagementVersion?: number; event?: Record<string, unknown>; actions?: Record<string, unknown>[] }[] }).prototypeInteractions!;
    expect(doc[0].actions![0]).toMatchObject({ transitionType: "MOVE_OUT_TO_RIGHT", easingType: "EASE_IN" });
    expect(doc[0].stateManagementVersion).toBe(1);
    expect(doc[1].event).toMatchObject({ interactionType: "MOUSE_ENTER", interactionMaintained: true });
    expect(doc[1].event!.interactionDuration).toBeCloseTo(0.5);
  });

  it("new nodes are centred in the view, not at the page's 0,0 (Figma: like R and a click)", async () => {
    const { ed, engine } = await editor();
    engine.centerOn(1000, -500, 1);
    const { r } = await run(
      ed,
      inline(`
        const c = figma.viewport.center;
        const rect = figma.createRectangle();
        const frame = figma.createFrame();
        frame.resize(200, 50);
        figma.root.setPluginData("result", JSON.stringify({ c, rect: [rect.x, rect.y, rect.width, rect.height], frame: [frame.x, frame.y] }));
        figma.closePlugin();
      `),
    );
    await untilEnded(r);
    const out = JSON.parse(rootData(engine, "result")!);
    expect(out.c).toEqual({ x: 1000, y: -500 });
    expect(out.rect).toEqual([950, -550, 100, 100]);
    expect(out.frame).toEqual([950, -550]);
  });

  it("a runaway slice is interrupted (the interrupt handler's limit); Stop ends a run between slices", async () => {
    const { ed } = await editor();
    const ui = new PluginUiStore();
    const runaway = new PluginRun(inline(`figma.createRectangle(); setTimeout(() => { while (true) {} }, 0);`), { ed, desktop: null, ui, console: () => {}, sliceTimeoutMs: 200 });
    await runaway.start();
    expect(ui.get().running).toEqual([{ runId: runaway.runId, name: "Inline" }]);
    const t0 = Date.now();
    await untilEnded(runaway, 5000);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(ui.get().running).toEqual([]);
    // A run waiting on a timer: Stop (the toast's ✕) ends it at once.
    const ticking = new PluginRun(inline(`setInterval(() => figma.createRectangle(), 10);`), { ed, desktop: null, ui, console: () => {} });
    await ticking.start();
    await new Promise((r) => setTimeout(r, 40));
    ticking.stop();
    await untilEnded(ticking);
    const count = pageChildren(ed).length;
    await new Promise((r) => setTimeout(r, 40));
    expect(pageChildren(ed).length).toBe(count);
  });

  it("exportAsync (SVG as bytes and as a string), text ranges, group / ungroup, clone and components", async () => {
    const { ed, engine } = await editor();
    const { r } = await run(
      ed,
      inline(`
        (async () => {
          const out = {};
          const rect = figma.createRectangle();
          rect.resize(40, 20);
          const svg = await rect.exportAsync({ format: "SVG_STRING" });
          out.svg = svg.startsWith("<svg") && svg.includes('width="40"');
          const bytes = await rect.exportAsync({ format: "SVG" });
          out.bytes = bytes instanceof Uint8Array && bytes.length > 20;
          const text = figma.createText();
          text.characters = "Hello world";
          text.setRangeFontSize(6, 11, 24);
          out.mixed = text.fontSize === figma.mixed;
          out.range = [text.getRangeFontSize(0, 5), text.getRangeFontSize(6, 11)];
          text.insertCharacters(5, ",");
          out.chars = text.characters;
          const other = figma.createEllipse();
          const g = figma.group([rect, other], figma.currentPage);
          out.group = [g.type, g.children.length];
          const kids = figma.ungroup(g);
          out.ungroup = kids.length;
          const copy = rect.clone();
          out.clone = copy.id !== rect.id && copy.width === 40;
          const comp = figma.createComponentFromNode(copy);
          out.component = comp.type;
          const inst = comp.createInstance();
          out.instance = [inst.type, inst.mainComponent && inst.mainComponent.id === comp.id];
          figma.root.setPluginData("result", JSON.stringify(out));
          figma.closePlugin();
        })();
      `)
    );
    await untilEnded(r);
    expect(JSON.parse(rootData(engine, "result")!)).toEqual({ svg: true, bytes: true, mixed: true, range: [12, 24], chars: "Hello, world", group: ["GROUP", 2], ungroup: 2, clone: true, component: "COMPONENT", instance: ["INSTANCE", true] });
  });

  it("exportAsync is refused for a viewer the file's export setting restricts (governance §2.7)", async () => {
    const { ed, engine } = await editor();
    setExportAllowed(ed, false);
    const { r } = await run(
      ed,
      inline(`
        (async () => {
          const rect = figma.createRectangle();
          let msg = "";
          try { await rect.exportAsync({ format: "PNG" }); msg = "exported"; } catch (e) { msg = String(e && e.message || e); }
          figma.root.setPluginData("result", msg);
          figma.closePlugin();
        })();
      `)
    );
    await untilEnded(r);
    expect(rootData(engine, "result")).toContain("export is not allowed in this file");
  });

  it("a plugin's error is reported and the run ends", async () => {
    const { ed } = await editor();
    const logs: string[][] = [];
    const { r } = await run(ed, inline(`figma.createRectangle(); throw new Error("boom");`), { logs });
    await untilEnded(r);
    expect(logs.some((l) => l[0] === "error" && l[1].includes("boom"))).toBe(true);
  });

  it("documentchange and selectionchange reach the plugin", async () => {
    const { ed, engine } = await editor();
    const { r } = await run(
      ed,
      inline(`
        const seen = [];
        figma.on("documentchange", (e) => { for (const c of e.documentChanges) seen.push(c.type + ":" + (c.properties || []).join(",")); figma.root.setPluginData("result", JSON.stringify(seen)); });
        figma.on("selectionchange", () => figma.root.setPluginData("sel", String(figma.currentPage.selection.length)));
      `)
    );
    const target = pageChildren(ed)[0];
    ed.setProps([target.guid], { opacity: 0.5 });
    engine.setSelection([target.guid]);
    await settle();
    await settle();
    await settle();
    const seen = JSON.parse(rootData(engine, "result") ?? "[]") as string[];
    expect(seen.some((s) => s.startsWith("PROPERTY_CHANGE:") && s.includes("opacity"))).toBe(true);
    expect(rootData(engine, "sel")).toBe("1");
    r.stop();
  });
});

describe("plugins: createSandbox (Code Connect templates)", () => {
  it("runs a template with its API: functions, values, async host functions; errors and timeouts", async () => {
    const sandbox = await createSandbox({
      kind: "template",
      code: `
        function render(props) { return figma.tsx(props.name) + ":" + figma.properties.size + ":" + figma.count; }
        async function later() { return await figma.load("x"); }
        function spin() { while (true) {} }
        function fail() { throw new Error("nope"); }
      `,
      api: { figma: { tsx: (s: unknown) => `<${String(s)}/>`, properties: { size: "Large" }, count: 3, load: async (k: unknown) => `loaded ${String(k)}` } },
      timeoutMs: 200,
    });
    expect(await sandbox.call("render", { name: "Button" })).toBe("<Button/>:Large:3");
    expect(await sandbox.call("later")).toBe("loaded x");
    await expect(sandbox.call("fail")).rejects.toThrow("nope");
    await expect(sandbox.call("spin")).rejects.toThrow(/took too long/);
    sandbox.dispose();
  });
});
