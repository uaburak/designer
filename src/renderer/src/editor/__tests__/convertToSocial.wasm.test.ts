// @vitest-environment happy-dom
// Convert to Social file (docs/social.md §18.1) on the real engine: a Design page with a container of 1080 × 1440
// designs, a 1080 × 1350 post and a tiny frame, and a Thumbnail page — read for the rules, then applied as ONE undo
// step: the container unwrapped (its children top-level where they were, in reading order), the posts' records
// written with the page's brand, the thumbnail page dropped; undone in one step. A Social copy applies the conversion
// waiting in its UI state once as it opens.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { Engine } from "@/engine/Engine";
import { EngineStore } from "@/engine/EngineStore";
import { loadEngine } from "@/engine/loadEngine";
import { SAMPLE_DOCUMENT } from "@/engine/sampleDocument";
import type { Message, NodeChange } from "@/engine/codec";
import { keyBetween } from "@shared/schema/fractionalIndex";
import { conversionPlan, defaultChoices, type SocialConversion } from "@shared/social/convert";
import { EditorController } from "../controller";
import { memoryDocumentSource, type EditorUiState } from "../documentSource";
import { defaults, IDENTITY } from "../agents/nodeSpec";
import { editorWriter } from "../social/actions";
import { applyConversion, applyPendingConversion, findInEditor } from "../social/convert/convert";
import { readPost } from "../social/posts";
import { attachArranger, layoutOf } from "../social/arrange";

const wasm = join(process.cwd(), "src/renderer/src/engine/wasm/engine.wasm");

beforeAll(async () => {
  globalThis.fetch = async () => new Response(null, { status: 404 });
  const bytes = readFileSync(wasm);
  await loadEngine({ wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), printErr: () => {} });
});

const keys: Record<string, string> = {};
function nextKey(parent: string): string {
  keys[parent] = keyBetween(keys[parent] ?? "", null);
  return keys[parent];
}

const frameOf = (guid: string, parent: string, name: string, x: number, y: number, w: number, h: number): NodeChange => frame(guid, parent, name, x, y, w, h);
const frame = (guid: string, parent: string, name: string, x: number, y: number, w: number, h: number): NodeChange =>
  ({ guid, type: "FRAME", ...defaults("FRAME"), phase: "CREATED", name, transform: { ...IDENTITY, m02: x, m12: y }, size: { x: w, y: h }, parentIndex: { guid: parent, position: nextKey(parent) } }) as NodeChange;

/** "MTM Agro" (the sample's page renamed): container "Post" at (100, 200) with six 1080 × 1440 designs drawn out of order, "PostA", "Frame 25"; a "Thumbnail" page. */
function document(extra: (frame: typeof frameOf) => NodeChange[] = () => []): Message {
  for (const k of Object.keys(keys)) delete keys[k];
  const base = SAMPLE_DOCUMENT.nodeChanges.map((n) => (n.guid === "0:1" ? { ...n, name: "MTM Agro" } : n));
  // Leave room after the sample's own children on its page.
  keys["0:1"] = "x";
  const cells = [5, 2, 0, 4, 1, 3].map((i) => frame(`9:${10 + i}`, "9:1", `Design ${i}`, (i % 3) * 1088, Math.floor(i / 3) * 1448, 1080, 1440));
  const nodes: NodeChange[] = [
    frame("9:1", "0:1", "Post", 100, 200, 3456, 3000),
    ...cells,
    frame("9:2", "0:1", "PostA", 5000, 0, 1080, 1350),
    frame("9:3", "0:1", "Frame 25", 6200, 0, 189, 100),
    { guid: "9:4", phase: "CREATED", type: "CANVAS", name: "Thumbnail", parentIndex: { guid: "0:0", position: "#" } } as NodeChange,
    frame("9:5", "9:4", "Cover", 0, 0, 1920, 1080),
    ...extra(frameOf),
  ];
  return { ...SAMPLE_DOCUMENT, nodeChanges: [...base, ...nodes] };
}

async function setup(options: { editorType?: "design" | "buzz"; uiState?: EditorUiState; extra?: Parameters<typeof document>[0] } = {}) {
  const source = memoryDocumentSource(document(options.extra), { fileName: "Sosyal Medya", ...options });
  const engine = await Engine.create(null, { sessionID: 1 });
  engine.load(await source.load());
  engine.setViewport(1280, 800, 1, 1280, 800);
  const ed = new EditorController(engine, new EngineStore(engine), source);
  return { ed, engine, source };
}

const parentOf = (engine: Engine, id: string) => engine.readNode(id, { fields: ["parentIndex"] })?.parentIndex?.guid;
const at = (engine: Engine, id: string) => {
  const tr = engine.readNode(id, { fields: ["transform"] })?.transform;
  return { x: Math.round(tr?.m02 ?? NaN), y: Math.round(tr?.m12 ?? NaN) };
};

function planFor(ed: EditorController, removeOthers: boolean): SocialConversion {
  const found = findInEditor(ed, [{ id: "b:mtm", name: "MTM AGRO" }]);
  return conversionPlan(found, defaultChoices(found), removeOthers ? { allPages: ed.store.pages.map((p) => p.guid) } : {});
}

describe("Convert to Social file (docs/social.md §18.1)", () => {
  it("finds the container's designs in reading order, the posts, the brand, and leaves the Thumbnail page out", async () => {
    const { ed } = await setup();
    const found = findInEditor(ed, [{ id: "b:mtm", name: "MTM AGRO" }]);
    expect(found.pages.map((p) => [p.pageName, p.brand?.id])).toEqual([["MTM Agro", "b:mtm"]]);
    const post = found.pages[0].rows.find((r) => r.name === "Post")!;
    expect(post).toMatchObject({ kind: "container", count: 6, suggested: "instagram.portrait" });
    expect(post.children?.map((c) => c.id)).toEqual(["9:10", "9:11", "9:12", "9:13", "9:14", "9:15"]);
    expect(found.pages[0].rows.find((r) => r.name === "PostA")?.suggested).toBe("instagram.post");
    expect(found.pages[0].rows.find((r) => r.name === "Frame 25")?.suggested).toBeNull();
    expect(found.leftOut.map((p) => p.pageName)).toContain("Thumbnail");
  });

  it("applies the conversion as one undo step and undoes it in one", async () => {
    const { ed, engine } = await setup();
    const plan = planFor(ed, true);
    expect(plan.removePages).toEqual(["9:4"]);
    const made = applyConversion(ed, editorWriter(ed), plan);
    expect(made).toBe(7);
    expect(ed.store.undo.undoLabel).toBe("Convert to Social file");
    // The container is gone; its designs are top-level where they were on the page.
    expect(engine.readNode("9:1")).toBeNull();
    for (let i = 0; i < 6; i++) {
      const id = `9:${10 + i}`;
      expect(parentOf(engine, id)).toBe("0:1");
      expect(at(engine, id)).toEqual({ x: 100 + (i % 3) * 1088, y: 200 + Math.floor(i / 3) * 1448 });
      expect(readPost(ed, id)).toMatchObject({ formatId: "instagram.portrait", brandId: "b:mtm", status: "draft", campaignId: null });
    }
    // Layers top-down in reading order: the first design on top.
    const kids = (engine.readNode("0:1", { childIds: true })?.childIds ?? []) as string[];
    const order = kids.filter((k) => k.startsWith("9:1")).reverse();
    expect(order).toEqual(["9:10", "9:11", "9:12", "9:13", "9:14", "9:15"]);
    expect(readPost(ed, "9:2")).toMatchObject({ formatId: "instagram.post", brandId: "b:mtm" });
    expect(readPost(ed, "9:3")).toBeNull();
    // The thumbnail page is dropped.
    expect(ed.store.pages.map((p) => p.name)).toEqual(["MTM Agro"]);
    // Applied again: nothing changes (no second undo step).
    applyConversion(ed, editorWriter(ed), plan);
    // One undo puts everything back.
    engine.command("UNDO");
    expect(engine.readNode("9:1")).not.toBeNull();
    for (let i = 0; i < 6; i++) expect(parentOf(engine, `9:${10 + i}`)).toBe("9:1");
    expect(at(engine, "9:10")).toEqual({ x: 0, y: 0 });
    expect(readPost(ed, "9:10")).toBeNull();
    expect(readPost(ed, "9:2")).toBeNull();
    expect(ed.store.pages.map((p) => p.name)).toEqual(["MTM Agro", "Thumbnail"]);
  });

  it("a Social copy applies the conversion waiting in its UI state once, as it opens", async () => {
    const first = await setup();
    const plan = planFor(first.ed, true);
    const { ed, engine, source } = await setup({ editorType: "buzz", uiState: { currentPageId: "0:1", pages: {}, leftPanelWidth: 240, rightPanelWidth: 240, socialConvert: plan } });
    const setUi = vi.fn();
    (source as { setUiState?: (p: Partial<EditorUiState>) => void }).setUiState = setUi;
    expect(applyPendingConversion(ed)).toBe(7);
    expect(setUi).toHaveBeenCalledWith({ socialConvert: null });
    expect(parentOf(engine, "9:12")).toBe("0:1");
    expect(readPost(ed, "9:12")?.formatId).toBe("instagram.portrait");
    expect(ed.store.undo.undoLabel).toBe("Convert to Social file");
    // Once only.
    expect(applyPendingConversion(ed)).toBe(0);
    // A Design file doesn't apply one.
    const design = await setup({ uiState: { currentPageId: "0:1", pages: {}, leftPanelWidth: 240, rightPanelWidth: 240, socialConvert: plan } });
    expect(applyPendingConversion(design.ed)).toBe(0);
    expect(design.engine.readNode("9:1")).not.toBeNull();
  });

  it("two containers side by side stay apart on the board: the first's designs, then the second's (docs/social.md §19)", async () => {
    // A second container "test" right of "Post", three designs in one row
    const extra = (f: typeof frameOf) => [f("9:6", "0:1", "test", 3700, 200, 3456, 1500), ...[0, 1, 2].map((i) => f(`9:${20 + i}`, "9:6", `Test ${i}`, i * 1088, 0, 1080, 1440))];
    const first = await setup({ extra });
    const plan = planFor(first.ed, true);
    const { ed, source } = await setup({ editorType: "buzz", extra, uiState: { currentPageId: "0:1", pages: {}, leftPanelWidth: 240, rightPanelWidth: 240, socialConvert: plan } });
    (source as { setUiState?: (p: Partial<EditorUiState>) => void }).setUiState = () => {};
    attachArranger(ed);
    expect(applyPendingConversion(ed)).toBe(10);
    const grid = layoutOf(ed).sections[0].grids.find((g) => g.formatId === "instagram.portrait")!;
    expect(grid.ids).toEqual(["9:10", "9:11", "9:12", "9:13", "9:14", "9:15", "9:20", "9:21", "9:22"]);
    expect(ed.store.undo.undoLabel).toBe("Convert to Social file");
  });
});
