// @vitest-environment happy-dom
// The Plugin API's wave 7 parity (docs/research/atlas/17-plugins.md §13 "As built (2026-10-18, wave 7)") through
// QuickJS and figma.js on the real engine: the members each node type has and hasn't (Figma's prototype lists),
// `[Node <id>]`, fetch as a global only, dynamic-page's texts, notify's times and dequeue reasons, the UI window's size,
// place and errors, plugin data's limits, the underline's properties, grids, measurements, nodechange, documentchange's
// "stokeTopWeight", dev resources, explicit variable modes, and the checks before the code runs.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { currentToast, dismissToast } from "@/ds";
import { Engine } from "@/engine/Engine";
import { EngineStore } from "@/engine/EngineStore";
import { loadEngine } from "@/engine/loadEngine";
import { SAMPLE_DOCUMENT } from "@/engine/sampleDocument";
import type { DevResourceRecord } from "@shared/devmode/types";
import { EditorController } from "../../controller";
import { memoryDocumentSource } from "../../documentSource";
import { codeRefusal, PluginRun, type RunEnv, type RunSpec } from "../host";
import { PluginUiStore } from "../ui/store";

const wasm = join(process.cwd(), "src/renderer/src/engine/wasm/engine.wasm");

beforeAll(async () => {
  globalThis.fetch = async () => new Response(null, { status: 404 });
  const bytes = readFileSync(wasm);
  await loadEngine({ wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), printErr: () => {} });
});

afterEach(() => {
  for (let i = 0; i < 20 && currentToast(); i++) dismissToast();
  localStorage.clear();
});

async function editor() {
  const source = memoryDocumentSource(SAMPLE_DOCUMENT, { fileName: "Parity" });
  const engine = await Engine.create(null, { sessionID: 1 });
  engine.load(await source.load());
  engine.setViewport(1280, 800, 1, 1280, 800);
  const ed = new EditorController(engine, new EngineStore(engine), source);
  return { ed, engine };
}

const inline = (code: string, extra: Partial<RunSpec> = {}): RunSpec => ({
  pluginId: "parity",
  name: "Parity",
  manifest: { name: "Parity", id: "parity", api: "1.0.0", main: "code.js", editorType: ["figma"], networkAccess: { allowedDomains: ["none"] } },
  code,
  ui: {},
  development: true,
  command: "",
  ...extra,
});

/** Runs `code` and gives back what it passed to `done(…)` (the run then ends), and the console's errors. */
async function runFor(ed: EditorController, code: string, opts: { spec?: Partial<RunSpec>; env?: Partial<RunEnv>; ui?: PluginUiStore; keep?: boolean } = {}): Promise<{ result: unknown; errors: string[]; run: PluginRun; logs: string[][] }> {
  const logs: string[][] = [];
  let result: unknown;
  const body = `const done = (v) => { console.log("RESULT " + JSON.stringify(v)); ${opts.keep ? "" : "figma.closePlugin();"} };\nconst fails = (f) => { try { f(); return "no error"; } catch (e) { return String(e && e.message ? e.message : e); } };\n(async () => {\n${code}\n})().catch((e) => { console.error(String(e && e.message ? e.message : e)); figma.closePlugin(); });`;
  const run = new PluginRun(inline(body, opts.spec), { ed, desktop: null, ui: opts.ui ?? new PluginUiStore(), console: (level, args) => logs.push([level, ...args.map(String)]), ...opts.env });
  await run.start();
  const deadline = Date.now() + 3000;
  while (!logs.some((l) => l[1]?.startsWith("RESULT ")) && !logs.some((l) => l[0] === "error") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
  for (const l of logs) if (l[0] === "log" && l[1]?.startsWith("RESULT ")) result = JSON.parse(l[1].slice(7));
  return { result, errors: logs.filter((l) => l[0] === "error").map((l) => l.slice(1).join(" ")), run, logs };
}

describe("plugins: Figma's members per node type (§9.2, §13.2 D1, D11, D13–D16, §13.3)", () => {
  it("has what Figma's prototypes have, and not what they don't", async () => {
    const { ed } = await editor();
    const { result, errors } = await runFor(
      ed,
      `
      const has = (n, keys) => Object.fromEntries(keys.map((k) => [k, k in n]));
      const f = figma.createFrame();
      const g = figma.group([figma.createRectangle()], figma.currentPage);
      const s = figma.createSection();
      const c = figma.createComponent();
      const c2 = figma.createComponent();
      const set = figma.combineAsVariants([c, c2], figma.currentPage);
      const i = c.createInstance();
      done({
        frame: has(f, ["constraints", "devStatus", "annotations", "reactions", "backgrounds", "backgroundStyleId", "horizontalPadding", "verticalPadding", "appendChildAt", "reorderRows", "gridAutoTracks", "constrainProportions", "setGridChildPosition", "detachedInfo", "getRelatedLinksAsync", "setDevResourcePreviewAsync", "availableInferredVariables", "manualKeyframeTracks"]),
        group: has(g, ["constraints", "devStatus", "annotations", "backgrounds", "expanded", "reactions", "setGridChildPosition", "detachedInfo"]),
        section: has(s, ["cornerRadius", "topLeftRadius", "layoutAlign", "rotation", "reactions", "minWidth", "blendMode", "fills", "strokes", "devStatus", "resize", "constraints", "lockAspectRatio"]),
        slice: has(figma.createSlice(), ["reactions", "blendMode", "exportAsync", "annotations", "constraints", "devStatus", "manualKeyframeTracks"]),
        line: has(figma.createLine(), ["lockAspectRatio", "targetAspectRatio", "rotation", "constraints", "annotations"]),
        rect: has(figma.createRectangle(), ["lockAspectRatio", "targetAspectRatio", "devStatus", "annotations", "playbackSettings"]),
        text: has(figma.createText(), ["setRangeFontWeight", "getRangeFontWeight", "setRangeOpenTypeFeatures", "getRangeOpenTypeFeatures", "textDecorationStyle", "textDecorationColor", "textWrapStyle", "getRangeTextWrapStyle", "useNativeBidiSupport", "canUpgradeToNativeBidiSupport"]),
        component: has(c, ["setProperties", "instances", "getInstancesAsync", "createSlot", "reactions"]),
        set: has(set, ["reactions", "defaultVariant"]),
        page: has(figma.currentPage, ["setBackgroundsAsync", "exportAsync", "exportSettings", "explicitVariableModes", "setExplicitVariableModeForCollection", "getMeasurements", "on", "focusedNode", "detachedInfo"]),
        document: has(figma.root, ["clone", "detachedInfo"]),
        instances: c.instances.map((x) => x.id),
        master: i.masterComponent === i.mainComponent && i.mainComponent === c,
        toString: [String(f) === "[Node " + f.id + "]", String(figma.root)],
        fetch: [typeof figma.fetch, typeof fetch],
        relatedLinks: fails(() => figma.relatedLinks),
        createVideo: fails(() => figma.createVideo(new Uint8Array(1))),
      });
      `
    );
    expect(errors).toEqual([]);
    const r = result as Record<string, Record<string, boolean>> & { instances: string[]; master: boolean; toString: [boolean, string]; fetch: string[]; relatedLinks: string; createVideo: string };
    expect(Object.entries(r.frame).filter(([, v]) => !v)).toEqual([]);
    expect(r.group).toEqual({ constraints: false, devStatus: false, annotations: false, backgrounds: true, expanded: true, reactions: true, setGridChildPosition: true, detachedInfo: true });
    expect(r.section).toEqual({ cornerRadius: true, topLeftRadius: true, layoutAlign: false, rotation: false, reactions: false, minWidth: false, blendMode: false, fills: true, strokes: true, devStatus: true, resize: true, constraints: false, lockAspectRatio: true });
    expect(r.slice).toEqual({ reactions: false, blendMode: false, exportAsync: true, annotations: false, constraints: false, devStatus: false, manualKeyframeTracks: false });
    expect(r.line).toEqual({ lockAspectRatio: false, targetAspectRatio: false, rotation: true, constraints: true, annotations: true });
    expect(r.rect).toEqual({ lockAspectRatio: true, targetAspectRatio: true, devStatus: false, annotations: true, playbackSettings: false });
    expect(r.text).toEqual({ setRangeFontWeight: false, getRangeFontWeight: true, setRangeOpenTypeFeatures: false, getRangeOpenTypeFeatures: true, textDecorationStyle: true, textDecorationColor: true, textWrapStyle: true, getRangeTextWrapStyle: true, useNativeBidiSupport: true, canUpgradeToNativeBidiSupport: true });
    expect(r.component).toEqual({ setProperties: false, instances: true, getInstancesAsync: true, createSlot: true, reactions: true });
    expect(r.set).toEqual({ reactions: false, defaultVariant: true });
    expect(r.page).toEqual({ setBackgroundsAsync: false, exportAsync: true, exportSettings: true, explicitVariableModes: true, setExplicitVariableModeForCollection: true, getMeasurements: true, on: true, focusedNode: true, detachedInfo: true });
    expect(r.document).toEqual({ clone: true, detachedInfo: true });
    expect(r.instances).toHaveLength(1);
    expect(r.master).toBe(true);
    expect(r.toString).toEqual([true, "[Node 0:0]"]);
    expect(r.fetch).toEqual(["undefined", "function"]);
    expect(r.relatedLinks).toBe("figma.relatedLinks is not available for local plugins. Please use the figma.devResources API instead.");
    expect(r.createVideo).toBe("createVideo is not supported in Wecra yet");
  });

  it("dynamic-page: Figma's text for every synchronous API, documentchange only after loadAllPagesAsync", async () => {
    const { ed } = await editor();
    const { result, errors } = await runFor(
      ed,
      `
      const c = figma.createComponent();
      const i = c.createInstance();
      const r = figma.createRectangle();
      const out = {
        byId: fails(() => figma.getNodeById(r.id)),
        main: fails(() => i.mainComponent),
        instances: fails(() => c.instances),
        fillStyle: fails(() => { r.fillStyleId = ""; }),
        reactions: fails(() => { r.reactions = []; }),
        range: fails(() => figma.createText().setRangeTextStyleId(0, 1, "")),
        locals: fails(() => figma.variables.getLocalVariables()),
        documentchange: fails(() => figma.on("documentchange", () => {})),
      };
      out.mainAsync = (await i.getMainComponentAsync()) === c;
      await figma.loadAllPagesAsync();
      out.after = fails(() => figma.on("documentchange", () => {}));
      done(out);
      `,
      { spec: { manifest: { name: "Parity", id: "parity", api: "1.0.0", main: "code.js", editorType: ["figma"], documentAccess: "dynamic-page" } } }
    );
    expect(errors).toEqual([]);
    expect(result).toEqual({
      byId: "in getNodeById: Cannot call with documentAccess: dynamic-page. Use figma.getNodeByIdAsync instead.",
      main: "in get_mainComponent: Cannot call with documentAccess: dynamic-page. Use node.getMainComponentAsync instead.",
      instances: "in get_instances: Cannot call with documentAccess: dynamic-page. Use node.getInstancesAsync instead.",
      fillStyle: "in set_fillStyleId: Cannot call with documentAccess: dynamic-page. Use node.setFillStyleIdAsync instead.",
      reactions: "in set_reactions: Cannot call with documentAccess: dynamic-page. Use node.setReactionsAsync instead.",
      range: "in setRangeTextStyleId: Cannot call with documentAccess: dynamic-page. Use node.setRangeTextStyleIdAsync instead.",
      locals: "in getLocalVariables: Cannot call with documentAccess: dynamic-page. Use figma.variables.getLocalVariablesAsync instead.",
      documentchange: "Cannot register documentchange handler in incremental mode without calling figma.loadAllPagesAsync first.",
      mainAsync: true,
      after: "no error",
    });
  });
});

describe("plugins: notify (§6.4) and the UI window (§3.3)", () => {
  it("notify: 3000 ms, an error until dismissed, at least 100 ms; dequeue reasons; a button returning false keeps it", async () => {
    const { ed } = await editor();
    const { run } = await runFor(
      ed,
      `
      figma.notify("plain");
      done(true);
      `,
      { keep: true }
    );
    expect(currentToast()).toMatchObject({ message: "plain", duration: 3000 });
    dismissToast();
    await run.close(null);
    const { run: second, logs } = await runFor(
      ed,
      `
      const dequeued = (name) => (reason) => console.log("DEQUEUE " + name + ":" + reason);
      figma.notify("error", { error: true, onDequeue: dequeued("error") });
      figma.notify("short", { timeout: 1, onDequeue: dequeued("short") });
      figma.notify("kept", { button: { text: "Undo", action: () => false }, onDequeue: dequeued("kept") });
      figma.notify("taken", { button: { text: "Open", action: () => {} }, onDequeue: dequeued("taken") });
      figma.notify("cancelled", { onDequeue: dequeued("cancelled") }).cancel();
      done(true);
      `,
      { keep: true }
    );
    const dequeued = () => logs.flatMap((l) => (l[1]?.startsWith("DEQUEUE ") ? [l[1].slice(8)] : []));
    // The error stays until dismissed (0 = no time); "short" is given 100 ms.
    expect(currentToast()).toMatchObject({ message: "error", kind: "error", duration: 0 });
    dismissToast();
    expect(currentToast()).toMatchObject({ message: "short", duration: 100 });
    dismissToast();
    const kept = currentToast()!;
    expect(kept).toMatchObject({ message: "kept", keepOnAction: true });
    kept.action!.onAction();
    await new Promise((r) => setTimeout(r, 20));
    expect(currentToast()?.message).toBe("kept");
    dismissToast();
    currentToast()!.action!.onAction();
    await new Promise((r) => setTimeout(r, 150));
    expect(dequeued()).toEqual(expect.arrayContaining(["cancelled:dismiss", "short:timeout", "taken:action_button_click"]));
    expect(dequeued()).not.toContain("kept:action_button_click");
    await second.close(null);
  });

  it("showUI: 300 × 200 centred, clamped; the last place per plugin; windowSpace; Figma's texts before showUI", async () => {
    const { ed } = await editor();
    const ui = new PluginUiStore();
    const { result, run } = await runFor(
      ed,
      `
      const before = { post: fails(() => figma.ui.postMessage(1)), resize: fails(() => figma.ui.resize(10, 10)), at: fails(() => figma.ui.getPosition()) };
      figma.showUI("<p>hi</p>");
      before.zero = fails(() => figma.ui.resize(0, 10));
      done(before);
      `,
      { ui, keep: true }
    );
    expect(result).toEqual({
      post: "No UI to send a message to. Did you forget to create a UI by calling showUI?",
      resize: "No UI to resize. Did you forget to create a UI by calling showUI?",
      at: "Cannot get the UI position. Did you forget to create a UI by calling showUI?",
      zero: "in resize: Expected width and height to be positive integers",
    });
    const w = ui.window(run.runId)!;
    expect([w.width, w.height]).toEqual([300, 200]);
    expect(w.position).toEqual({ x: Math.round((window.innerWidth - 300) / 2), y: Math.round((window.innerHeight - 240) / 2) });
    await run.close(null);
    // reposition keeps the place for this plugin; the next run opens there. A huge width is clamped to the window.
    const second = await runFor(ed, `figma.showUI("<p/>", { width: 5000 }); figma.ui.reposition(figma.viewport.bounds.x + 10, figma.viewport.bounds.y + 20); done(1);`, { ui, keep: true });
    const placed = ui.window(second.run.runId)!;
    expect(placed.width).toBe(window.innerWidth - 50);
    const kept = placed.position!;
    await second.run.close(null);
    const third = await runFor(ed, `figma.showUI("<p/>", { width: 100, height: 50 }); done(1);`, { ui, keep: true });
    expect(ui.window(third.run.runId)!.position).toEqual({ x: Math.min(kept.x, window.innerWidth - 100), y: Math.min(kept.y, window.innerHeight - 90) });
    await third.run.close(null);
    const fourth = await runFor(ed, `figma.showUI("<p/>", { position: { windowSpace: true, x: 12, y: 34 } }); done(1);`, { ui, keep: true });
    expect(ui.window(fourth.run.runId)!.position).toEqual({ x: 12, y: 34 });
    await fourth.run.close(null);
  });
});

describe("plugins: properties and methods new in wave 7", () => {
  it("plugin data: UTF-8 bytes and Figma's namespace texts", async () => {
    const { ed } = await editor();
    const { result } = await runFor(
      ed,
      `
      const r = figma.createRectangle();
      done({
        ascii: fails(() => r.setPluginData("k", "a".repeat(100000))),
        wide: fails(() => r.setPluginData("k", "é".repeat(60000))),
        short: fails(() => r.setSharedPluginData("ab", "k", "v")),
        long: fails(() => r.setSharedPluginData("a".repeat(1001), "k", "v")),
        chars: fails(() => r.setSharedPluginData("my-ns", "k", "v")),
        ok: fails(() => r.setSharedPluginData("my_ns.v1", "k", "v")),
      });
      `
    );
    expect(result).toEqual({
      ascii: "no error",
      wide: "This pluginData entry exceeds 100 kB per entry limit.",
      short: "The namespace must be at least 3 characters",
      long: "The namespace can be at most 1000 characters",
      chars: "The namespace can only consist of alphanumeric characters, _ or .",
      ok: "no error",
    });
  });

  it("text: the underline's style, offset, thickness, colour and skip ink; wrap style; bidi", async () => {
    const { ed, engine } = await editor();
    const { result, errors } = await runFor(
      ed,
      `
      const t = figma.createText();
      t.characters = "Underlined";
      t.textDecoration = "UNDERLINE";
      t.textDecorationStyle = "WAVY";
      t.textDecorationOffset = { value: 2, unit: "PIXELS" };
      t.textDecorationThickness = { value: 10, unit: "PERCENT" };
      t.textDecorationColor = { value: { type: "SOLID", color: { r: 1, g: 0, b: 0 } } };
      t.textDecorationSkipInk = true;
      t.textWrapStyle = "BALANCE";
      done({
        id: t.id,
        style: t.textDecorationStyle, offset: t.textDecorationOffset, thickness: t.textDecorationThickness,
        color: t.textDecorationColor.value.color, skip: t.textDecorationSkipInk, wrap: t.textWrapStyle,
        range: t.getRangeTextDecorationStyle(0, 3),
        auto: figma.createText().textDecorationColor,
        gradient: fails(() => { t.textDecorationColor = { value: { type: "GRADIENT_LINEAR", gradientStops: [], gradientTransform: [[1, 0, 0], [0, 1, 0]] } }; }),
        badStyle: fails(() => { t.textDecorationStyle = "ZIGZAG"; }),
        bidi: t.canUpgradeToNativeBidiSupport,
      });
      `
    );
    expect(errors).toEqual([]);
    const r = result as Record<string, unknown> & { id: string };
    expect(r).toMatchObject({ style: "WAVY", offset: { value: 2, unit: "PIXELS" }, thickness: { value: 10, unit: "PERCENT" }, color: { r: 1, g: 0, b: 0 }, skip: true, wrap: "BALANCE", range: "WAVY", auto: { value: "AUTO" }, bidi: false });
    expect(r.gradient).toContain("Text decoration color must be a single solid paint");
    expect(r.badStyle).toContain("invalid enum value 'ZIGZAG'");
    const n = engine.readNode(r.id) as unknown as Record<string, unknown>;
    expect(n).toMatchObject({ textDecorationStyle: "WAVY", textUnderlineOffset: { value: 2, units: "PIXELS" }, textDecorationSkipInk: true, textWrapStyle: "BALANCE" });
  });

  it("grids: track sizes, automatic rows, a child placed at a cell (refused while the grid places its items), reordered tracks", async () => {
    const { ed, engine } = await editor();
    const first = await runFor(
      ed,
      `
      const g = figma.createFrame();
      g.layoutMode = "GRID";
      g.gridAutoTracks = "NONE";
      g.gridRowCount = 2;
      g.gridColumnCount = 3;
      g.gridColumnSizes = [{ type: "FIXED", value: 40 }, { type: "FLEX", value: 2 }, { type: "HUG" }];
      const r = figma.createRectangle();
      g.appendChild(r);
      done({
        id: g.id, child: r.id,
        sizes: g.gridColumnSizes, auto: g.gridAutoTracks,
        length: fails(() => { g.gridRowSizes = [{ type: "HUG" }]; }),
        negative: fails(() => { g.gridColumnSizes = [{ type: "FIXED", value: -1 }, { type: "HUG" }, { type: "HUG" }]; }),
        notGrid: fails(() => { figma.createFrame().gridAutoTracks = "ROWS"; }),
      });
      `
    );
    const r = first.result as Record<string, unknown> & { id: string; child: string };
    expect(r).toMatchObject({ sizes: [{ type: "FIXED", value: 40 }, { type: "FLEX", value: 2 }, { type: "HUG" }], auto: "NONE" });
    expect(r.length).toContain("Grid track sizes must be the same length as the grid row count");
    expect(r.negative).toContain("Grid track size value must be non-negative for FIXED tracks");
    expect(r.notGrid).toContain("gridAutoTracks requires layoutMode === 'GRID'");
    // A grid that places its items itself (the Grid panel's default) refuses a cell.
    engine.setProps([r.id], { gridReflowEnabled: true } as never);
    const placed = await runFor(ed, `done(fails(() => figma.getNodeById(${JSON.stringify(r.child)}).setGridChildPosition(1, 2)));`);
    expect(placed.result).toContain("cannot set grid child position directly inside of a grid with automatically positioned items, use parent.insertChild() instead to change the layer index.");
    // Items placed by hand: the cell is taken.
    engine.setProps([r.id], { gridReflowEnabled: false } as never);
    const second = await runFor(
      ed,
      `
      const g = figma.getNodeById(${JSON.stringify(r.id)});
      const r = figma.getNodeById(${JSON.stringify(r.child)});
      r.setGridChildPosition(1, 2);
      const at = [r.gridRowAnchorIndex, r.gridColumnAnchorIndex];
      const e = figma.createEllipse();
      g.appendChildAt(e, 0, 1);
      g.reorderColumns(0, 3);
      done({ at, e: [e.gridRowAnchorIndex, e.gridColumnAnchorIndex], sizes: g.gridColumnSizes.map((s) => s.type), out: fails(() => r.setGridChildPosition(5, 0)) });
      `
    );
    expect(second.errors).toEqual([]);
    expect(second.result).toMatchObject({ at: [1, 2], e: [0, 0], sizes: ["FLEX", "HUG", "FIXED"] });
    expect((second.result as { out: string }).out).toContain("Row index 5 is out of bounds");
  });

  it("measurements on the page: add, list per node, edit, delete — Figma's shape and refusals", async () => {
    const { ed } = await editor();
    const { result, errors } = await runFor(
      ed,
      `
      const a = figma.createRectangle();
      const b = figma.createRectangle();
      b.x = 200;
      const page = figma.currentPage;
      const m = page.addMeasurement({ node: a, side: "RIGHT" }, { node: b, side: "LEFT" }, { freeText: "Gap" });
      const listed = page.getMeasurementsForNode(b).length;
      const edited = page.editMeasurement(m.id, { offset: { type: "OUTER", fixed: 12 } });
      const out = {
        start: [m.start.node === a, m.start.side], end: [m.end.node === b, m.end.side], text: m.freeText, listed,
        offset: edited.offset, all: page.getMeasurements().length,
        self: fails(() => page.addMeasurement({ node: a, side: "LEFT" }, { node: a, side: "LEFT" })),
        axis: fails(() => page.addMeasurement({ node: a, side: "LEFT" }, { node: b, side: "TOP" })),
      };
      page.deleteMeasurement(m.id);
      out.after = page.getMeasurements().length;
      done(out);
      `
    );
    expect(errors).toEqual([]);
    expect(result).toMatchObject({ start: [true, "RIGHT"], end: [true, "LEFT"], text: "Gap", listed: 1, offset: { type: "OUTER", fixed: 12 }, all: 1, after: 0 });
    expect((result as { self: string }).self).toContain("Measurement can't point to itself");
    expect((result as { axis: string }).axis).toContain("Measurement start side LEFT and end side TOP must be on the same axis");
  });

  it("explicit variable modes on a frame and a page; getSubscribedVariables lists no local variable", async () => {
    const { ed } = await editor();
    const { result, errors } = await runFor(
      ed,
      `
      const coll = figma.variables.createVariableCollection("Theme");
      const dark = coll.addMode("Dark");
      figma.variables.createVariable("bg", coll, "COLOR");
      const f = figma.createFrame();
      f.setExplicitVariableModeForCollection(coll, dark);
      figma.currentPage.setExplicitVariableModeForCollection(coll, dark);
      const svg = await figma.currentPage.exportAsync({ format: "SVG_STRING" });
      done({ frame: f.explicitVariableModes, page: figma.currentPage.explicitVariableModes, coll: coll.id, dark, subscribed: figma.variables.getSubscribedVariables().length, svg: svg.slice(0, 4) });
      `
    );
    expect(errors).toEqual([]);
    const r = result as { frame: Record<string, string>; page: Record<string, string>; coll: string; dark: string; subscribed: number; svg: string };
    expect(r.frame).toEqual({ [r.coll]: r.dark });
    expect(r.page).toEqual({ [r.coll]: r.dark });
    expect(r.subscribed).toBe(0);
    expect(r.svg).toBe("<svg");
  });

  it("dev resources: added, listed (with children), edited and deleted through the file's store", async () => {
    const { ed } = await editor();
    const records: DevResourceRecord[] = [];
    let seq = 0;
    const devResources = {
      list: async (ids: string[]) => records.filter((r) => ids.includes(r.nodeId)),
      add: async (nodeId: string, input: { name: string; url: string }) => {
        const r = { id: `r${++seq}`, fileKey: "f", nodeId, ...input, createdBy: null, createdAt: 0, updatedAt: 0 };
        records.push(r);
        return r;
      },
      edit: async (id: string, patch: { name?: string; url?: string }) => Object.assign(records.find((r) => r.id === id)!, patch),
      remove: async (id: string) => void records.splice(records.findIndex((r) => r.id === id), 1),
    };
    const { result, errors } = await runFor(
      ed,
      `
      const f = figma.createFrame();
      const r = figma.createRectangle();
      f.appendChild(r);
      await f.addDevResourceAsync("https://example.com/spec", "Spec");
      await r.addDevResourceAsync("https://example.com/code");
      const own = await f.getDevResourcesAsync();
      const all = await f.getDevResourcesAsync({ includeChildren: true });
      await f.editDevResourceAsync("https://example.com/spec", { name: "Specification" });
      await r.deleteDevResourceAsync("https://example.com/code");
      done({ own: own.map((x) => x.name), all: all.map((x) => [x.name, x.nodeId === r.id]), after: (await f.getDevResourcesAsync({ includeChildren: true })).map((x) => x.name) });
      `,
      { env: { devResources } }
    );
    expect(errors).toEqual([]);
    expect(result).toEqual({ own: ["Spec"], all: [["Spec", false], ["https://example.com/code", true]], after: ["Specification"] });
  });
});

describe("plugins: events (§7)", () => {
  it("PageNode nodechange per page; documentchange names the top stroke weight stokeTopWeight (Figma's)", async () => {
    const { ed } = await editor();
    const { result, errors } = await runFor(
      ed,
      `
      const r = figma.createRectangle();
      await new Promise((ok) => setTimeout(ok, 10));
      const got = { node: [], doc: [] };
      figma.currentPage.on("nodechange", (e) => got.node.push(...e.nodeChanges.map((c) => c.type + ":" + (c.properties || []).join(","))));
      figma.on("documentchange", (e) => got.doc.push(...e.documentChanges.flatMap((c) => c.properties || [])));
      r.strokeTopWeight = 3;
      r.name = "Renamed";
      setTimeout(() => done(got), 30);
      `
    );
    expect(errors).toEqual([]);
    const got = result as { node: string[]; doc: string[] };
    expect(got.doc).toEqual(expect.arrayContaining(["stokeTopWeight", "name"]));
    expect(got.node.some((x) => x.startsWith("PROPERTY_CHANGE:") && x.includes("name"))).toBe(true);
  });
});

describe("plugins: the checks before the code runs (§2.1)", () => {
  it("api version, empty code, import expressions — Figma's texts", () => {
    const m = inline("").manifest;
    expect(codeRefusal({ code: "x", manifest: { ...m, api: "2.0.0" } })?.message).toBe('Unknown plugin api version "2.0.0"');
    expect(codeRefusal({ code: "", manifest: m })?.message).toBe("Code string cannot be empty");
    expect(codeRefusal({ code: "const a = 1;\nconst m = import('x');", manifest: m })?.message).toBe("possible import expression rejected around line 2");
    expect(codeRefusal({ code: "a.import('x'); figma.closePlugin();", manifest: m })).toBeNull();
    expect(codeRefusal({ code: "figma.closePlugin();", manifest: { ...m, api: "0.6.0" } })).toBeNull();
  });
});
