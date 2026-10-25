// @vitest-environment happy-dom
// A Social file's board (docs/social.md §19) on the real engine: posts laid out in platform › format grids of three
// columns, as auto layout would — a new post at its grid's end, a post dragged among the others reordering it, each in
// the step that made it (one ⌘Z takes the edit and the reflow back); the focus view follows the selection.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { Engine } from "@/engine/Engine";
import { EngineStore } from "@/engine/EngineStore";
import { loadEngine } from "@/engine/loadEngine";
import { SAMPLE_DOCUMENT } from "@/engine/sampleDocument";
import { EditorController } from "../controller";
import { memoryDocumentSource } from "../documentSource";
import { editorWriter, newPost } from "../social/actions";
import { attachArranger, layoutOf } from "../social/arrange";
import { BOARD, boardLayout } from "../social/board";
import { focusedPost, postsInOrder, setSocialView, shownPost } from "../social/focus";
import { setMode } from "../devmode/devMode";
import { readBoard } from "../social/socialState";
import { readPost } from "../social/posts";
import { planAdapt } from "../social/adapt";
import { attachAutoCheck } from "../social/autoCheck";
import { PointerType } from "@/engine/abi";
import { IDENTITY } from "../agents/nodeSpec";

beforeAll(async () => {
  globalThis.fetch = async () => new Response(null, { status: 404 });
  const bytes = readFileSync(join(process.cwd(), "src/renderer/src/engine/wasm/engine.wasm"));
  await loadEngine({ wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), printErr: () => {} });
});

async function social(editorType: "buzz" | "design" = "buzz") {
  const source = memoryDocumentSource(SAMPLE_DOCUMENT, { fileName: "Posts", editorType });
  const engine = await Engine.create(null, { sessionID: 1 });
  engine.load(await source.load());
  engine.setViewport(1280, 800, 1, 1280, 800);
  const ed = new EditorController(engine, new EngineStore(engine), source);
  const detach = attachArranger(ed);
  return { ed, engine, detach };
}

const at = (ed: EditorController, id: string) => {
  const t = ed.engine.readNode(id, { fields: ["transform"] })?.transform;
  return { x: t?.m02 ?? NaN, y: t?.m12 ?? NaN };
};
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("the board's layout (pure)", () => {
  const order = { platformOf: (f: string) => f.split(".")[0], rank: (f: string) => ["instagram.portrait", "instagram.story", "linkedin.square"].indexOf(f), platforms: ["instagram", "linkedin"] };

  it("a section per platform, a grid per format side by side, three columns in reading order, the next cell", () => {
    const post = (id: string, formatId: string, x: number, y: number, w = 1080, h = 1440) => ({ id, formatId, x, y, width: w, height: h });
    const items = [post("li", "linkedin.square", 0, 0, 1080, 1080), post("s1", "instagram.story", 9e6, 0, 1080, 1920), post("b", "instagram.portrait", 500, 0), post("a", "instagram.portrait", 0, 0), post("c", "instagram.portrait", 0, 5000), post("d", "instagram.portrait", 1e6, 1e6)];
    const { sections, places } = boardLayout(items, order);
    expect(sections.map((s) => s.platform)).toEqual(["instagram", "linkedin"]);
    const [ig, li] = sections;
    expect(ig.grids.map((g) => g.formatId)).toEqual(["instagram.portrait", "instagram.story"]);
    // Reading order: a and b on the first row (a left of b), then c, then d (a new post: last)
    expect(ig.grids[0].ids).toEqual(["a", "b", "c", "d"]);
    // Inside each grid's container (§24): its padding round the posts, the posts tiling, the next cell kept
    const col = 1080 + BOARD.gap;
    const top = BOARD.sectionHead + BOARD.pad;
    expect(places.get("a")).toEqual({ x: BOARD.pad, y: top });
    expect(places.get("b")).toEqual({ x: BOARD.pad + col, y: top });
    expect(places.get("c")).toEqual({ x: BOARD.pad + 2 * col, y: top });
    expect(places.get("d")).toEqual({ x: BOARD.pad, y: top + 1440 + BOARD.gap });
    expect(ig.grids[0].next).toEqual({ x: BOARD.pad + col, y: top + 1440 + BOARD.gap });
    expect(ig.grids[0].frame).toEqual({ x: 0, y: BOARD.sectionHead, width: 3 * 1080 + 2 * BOARD.gap + 2 * BOARD.pad, height: 2 * 1440 + BOARD.gap + 2 * BOARD.pad });
    // The story grid's container beside the first, after the grid gap
    expect(places.get("s1")).toEqual({ x: ig.grids[0].frame.width + BOARD.gridGap + BOARD.pad, y: top });
    // One story: its next cell beside it in the container
    expect(ig.grids[1].next).toEqual({ x: ig.grids[0].frame.width + BOARD.gridGap + BOARD.pad + 1080 + BOARD.gap, y: top });
    // LinkedIn under Instagram's tallest container, after the section gap
    expect(li.y).toBe(ig.y + ig.height + BOARD.sectionGap);
    expect(places.get("li")).toEqual({ x: BOARD.pad, y: li.y + BOARD.sectionHead + BOARD.pad });
  });
});

describe("a post adapted to another format (docs/social.md §32, pure)", () => {
  it("a 3:4 post to a story: the background stretched, the title under the story's top band, the button over its bottom band, the product's middle kept, nothing stretched", () => {
    const margin = { top: 64, right: 64, bottom: 64, left: 64 };
    const story = { top: 269, right: 65, bottom: 672, left: 65 };
    const steps = planAdapt(
      [
        { id: "bg", x: 0, y: 0, w: 1080, h: 1440 },
        { id: "title", x: 80, y: 80, w: 700, h: 120 },
        { id: "product", x: 290, y: 520, w: 500, h: 500 },
        { id: "button", x: 80, y: 1300, w: 300, h: 80 },
      ],
      { w: 1080, h: 1440 },
      { w: 1080, h: 1920 },
      margin,
      story,
    );
    const of = (id: string) => steps.find((s) => s.id === id)!;
    expect(of("bg")).toMatchObject({ x: 0, y: 0, w: 1080, h: 1920 });
    // Same width: no scaling
    expect(of("title")).toMatchObject({ scale: 1, y: 269 + 16 });
    expect(of("button").scale).toBe(1);
    expect(of("button").y).toBe(1920 - 672 - 80);
    // The middle third: its centre at the same place across the safe area
    expect(of("product").y + 250).toBeCloseTo(269 + ((770 - 64) / (1440 - 128)) * (1920 - 269 - 672));
  });
});

describe("a Social file's board (docs/social.md §19)", () => {
  it("puts a new post at its grid's end, in the step that made it", async () => {
    const { ed } = await social();
    const w = editorWriter(ed);
    const ids = [newPost(ed, w, { formatId: "instagram.portrait" }), newPost(ed, w, { formatId: "instagram.portrait" }), newPost(ed, w, { formatId: "instagram.story" }), newPost(ed, w, { formatId: "instagram.portrait" }), newPost(ed, w, { formatId: "instagram.portrait" })];
    const grids = layoutOf(ed).sections[0].grids;
    expect(grids.map((g) => [g.formatId, g.ids])).toEqual([
      ["instagram.portrait", [ids[0], ids[1], ids[3], ids[4]]],
      ["instagram.story", [ids[2]]],
    ]);
    const col = 1080 + BOARD.gap;
    const top = BOARD.sectionHead + BOARD.pad;
    expect(at(ed, ids[3])).toEqual({ x: BOARD.pad + 2 * col, y: top });
    expect(at(ed, ids[4])).toEqual({ x: BOARD.pad, y: top + 1440 + BOARD.gap });
    // One ⌘Z: the last post goes, nothing else moves
    expect(ed.store.undo.undoLabel).toBe("New post");
    ed.engine.undo();
    expect(ed.engine.readNode(ids[4], { fields: ["type"] })).toBeNull();
    expect(at(ed, ids[3])).toEqual({ x: BOARD.pad + 2 * col, y: top });
  });

  it("a post moved among the others is reordered and the grid reflows, in the move's step", async () => {
    const { ed } = await social();
    const w = editorWriter(ed);
    const ids = [0, 1, 2, 3].map(() => newPost(ed, w, { formatId: "instagram.portrait" }));
    const before = ids.map((id) => at(ed, id));
    // The fourth dropped before the first (as a drag on the canvas commits it)
    const t = ed.engine.readNode(ids[3], { fields: ["transform"] })!.transform!;
    ed.setProps([ids[3]], { transform: { ...t, m02: -400, m12: BOARD.sectionHead + BOARD.pad } }, "Move");
    await tick();
    expect(layoutOf(ed).sections[0].grids[0].ids).toEqual([ids[3], ids[0], ids[1], ids[2]]);
    expect(at(ed, ids[3])).toEqual(before[0]);
    expect(at(ed, ids[0])).toEqual(before[1]);
    expect(ed.store.undo.undoLabel).toBe("Move");
    // One ⌘Z puts the order and the places back
    ed.engine.undo();
    await tick();
    expect(ids.map((id) => at(ed, id))).toEqual(before);
  });

  it("a story dragged into the 3:4 grid becomes a 3:4 post where it was dropped, in the drag's step (docs/social.md §29)", async () => {
    const { ed, engine } = await social();
    const w = editorWriter(ed);
    const p1 = newPost(ed, w, { formatId: "instagram.portrait" });
    const p2 = newPost(ed, w, { formatId: "instagram.portrait" });
    const s = newPost(ed, w, { formatId: "instagram.story" });
    // A band pinned to the story's bottom, a card under its top band
    const bar = "1:9998";
    const card = "1:9996";
    expect(engine.applyChanges({ type: "NODE_CHANGES", sessionID: 1, nodeChanges: [{ guid: bar, phase: "CREATED", type: "ROUNDED_RECTANGLE", name: "Bar", visible: true, opacity: 1, size: { x: 1000, y: 100 }, transform: { ...IDENTITY, m02: 40, m12: 1780 }, horizontalConstraint: "STRETCH", verticalConstraint: "MAX", parentIndex: { guid: s, position: "a" } } as never, { guid: card, phase: "CREATED", type: "FRAME", name: "Card", visible: true, opacity: 1, size: { x: 400, y: 200 }, transform: { ...IDENTITY, m02: 100, m12: 300 }, parentIndex: { guid: s, position: "b" } } as never] }, "user")).toBe(0);
    await tick();
    const before = [p1, p2, s].map((id) => at(ed, id));
    engine.setViewOptions({ pixelGrid: false, outlines: false, assetChrome: true });
    engine.setCamera({ x: 0, y: 0, zoom: 0.1 });
    // Held at its middle, dropped on p2's middle: p2 makes room, the story takes its cell
    const from = { x: (before[2].x + 540) * 0.1, y: (before[2].y + 960) * 0.1 };
    const to = { x: (before[1].x + 540) * 0.1, y: (before[1].y + 960) * 0.1 };
    engine.pointer(PointerType.MOVE, from.x, from.y, 0, 0, 0);
    engine.pointer(PointerType.DOWN, from.x, from.y, 0, 1, 0);
    for (let i = 1; i <= 10; i++) engine.pointer(PointerType.MOVE, from.x + ((to.x - from.x) * i) / 10, from.y + ((to.y - from.y) * i) / 10, 0, 1, 0);
    engine.pointer(PointerType.UP, to.x, to.y, 0, 0, 0);
    await tick();
    expect(readPost(ed, s)?.formatId).toBe("instagram.portrait");
    expect(engine.readNode(s, { fields: ["size"] })?.size).toEqual({ x: 1080, y: 1440 });
    expect(layoutOf(ed).sections[0].grids.map((g) => g.ids)).toEqual([[p1, s, p2]]);
    expect(at(ed, s)).toEqual(before[1]);
    // Its layers adapted (§32): the band across it still at the bottom, its height scaled with the post (¾); the card
    // under the story's top band now under the post's top margin, scaled ¾
    const b = engine.readNode(bar, { fields: ["transform", "size"] })!;
    expect(b.size!.x).toBeCloseTo(1000);
    expect(b.size!.y).toBeCloseTo(75);
    expect(b.transform!.m12).toBeCloseTo(1440 - (40 / 672) * 64 - 75, 1);
    const k = engine.readNode(card, { fields: ["transform", "size"] })!;
    expect(k.size!.x).toBeCloseTo(300);
    expect(k.transform!.m12).toBeCloseTo(64 + (300 - 269) * 0.75, 1);
    // One ⌘Z: a story in its own grid again
    ed.engine.undo();
    await tick();
    expect(readPost(ed, s)?.formatId).toBe("instagram.story");
    expect([p1, p2, s].map((id) => at(ed, id))).toEqual(before);
    expect(engine.readNode(bar, { fields: ["size"] })?.size).toEqual({ x: 1000, y: 100 });
    expect(engine.readNode(card, { fields: ["size"] })?.size).toEqual({ x: 400, y: 200 });
  });

  it("a post checks itself a moment after an edit, its pins as bookkeeping, not an undo step (docs/social.md §30)", async () => {
    const { ed, engine } = await social();
    const off = attachAutoCheck(ed);
    const w = editorWriter(ed);
    const s = newPost(ed, w, { formatId: "instagram.story" });
    await tick();
    // A text in the story's bottom band, as the user draws it
    expect(engine.applyChanges({ type: "NODE_CHANGES", sessionID: 1, nodeChanges: [{ guid: "1:9997", phase: "CREATED", type: "TEXT", name: "CTA", visible: true, opacity: 1, size: { x: 300, y: 80 }, transform: { ...IDENTITY, m02: 100, m12: 1700 }, parentIndex: { guid: s, position: "b" } } as never] }, "user")).toBe(0);
    const label = ed.store.undo.undoLabel;
    await new Promise((r) => setTimeout(r, 700));
    expect(readPost(ed, s)?.problems.map((p) => p.id)).toEqual(["check:safe-area:1:9997"]);
    expect(ed.store.undo.undoLabel).toBe(label);
    // Moved out of the band: the pin leaves
    const t = engine.readNode("1:9997", { fields: ["transform"] })!.transform!;
    ed.setProps(["1:9997"], { transform: { ...t, m12: 900 } }, "Move");
    await new Promise((r) => setTimeout(r, 700));
    expect(readPost(ed, s)?.problems).toEqual([]);
    off();
  });

  it("leaves a Design file's frames where they are", async () => {
    const { ed } = await social("design");
    const w = editorWriter(ed);
    const a = newPost(ed, w, { formatId: "instagram.portrait", at: { x: 77, y: 33 } });
    await tick();
    expect(at(ed, a)).toEqual({ x: 77, y: 33 });
  });

  it("the focus follows the selection: one post or layers inside it; none with two posts or nothing", async () => {
    const { ed } = await social();
    const w = editorWriter(ed);
    const a = newPost(ed, w, { formatId: "instagram.portrait" });
    const b = newPost(ed, w, { formatId: "instagram.story" });
    expect(readBoard(ed, ed.store.page).posts).toHaveLength(2);
    ed.engine.setSelection([a]);
    expect(focusedPost(ed)?.id).toBe(a);
    ed.engine.setSelection([a, b]);
    expect(focusedPost(ed)).toBeNull();
    ed.engine.setSelection([]);
    expect(focusedPost(ed)).toBeNull();
  });

  it("in focus a layer dragged towards another post or onto the canvas stays in its post (docs/social.md §20)", async () => {
    const { ed, engine } = await social();
    const w = editorWriter(ed);
    const a = newPost(ed, w, { formatId: "instagram.portrait" });
    const b = newPost(ed, w, { formatId: "instagram.portrait" });
    // A layer in post a
    const pa = at(ed, a);
    const pb = at(ed, b);
    const res = engine.applyChanges({ type: "NODE_CHANGES", sessionID: 1, nodeChanges: [{ guid: "1:9999", phase: "CREATED", type: "ROUNDED_RECTANGLE", name: "Card", visible: true, opacity: 1, size: { x: 200, y: 200 }, transform: { ...IDENTITY, m02: 100, m12: 100 }, parentIndex: { guid: a, position: "a" }, fillPaints: [{ type: "SOLID", color: { r: 1, g: 0, b: 0, a: 1 }, opacity: 1, visible: true, blendMode: "NORMAL" }] } as never] }, "user");
    expect(res).toBe(0);
    const rect = "1:9999";
    // The camera: page = screen (zoom 1 at the origin of post a)
    engine.setCamera({ x: -pa.x, y: -pa.y, zoom: 1 });
    engine.setFocus(a);
    engine.setSelection([rect]);
    const drag = (fx: number, fy: number, tx: number, ty: number) => {
      engine.pointer(PointerType.MOVE, fx, fy, 0, 0, 0);
      engine.pointer(PointerType.DOWN, fx, fy, 0, 1, 0);
      for (let i = 1; i <= 8; i++) engine.pointer(PointerType.MOVE, fx + ((tx - fx) * i) / 8, fy + ((ty - fy) * i) / 8, 0, 1, 0);
      engine.pointer(PointerType.UP, tx, ty, 0, 0, 0);
    };
    // Towards post b (right of a on the screen)
    const before = engine.readNode(rect, { fields: ["transform"] })?.transform?.m02;
    drag(150, 150, pb.x - pa.x + 150, 150);
    expect(engine.readNode(rect, { fields: ["transform"] })?.transform?.m02).not.toBe(before); // it did move
    expect(engine.readNode(rect, { fields: ["parentIndex"] })?.parentIndex?.guid).toBe(a);
    // Onto the empty canvas below the posts
    drag(pb.x - pa.x + 150, 150, 150, 3000);
    expect(engine.readNode(rect, { fields: ["parentIndex"] })?.parentIndex?.guid).toBe(a);
    // The board stays as it was: only post a and b, in place
    await tick();
    expect(readBoard(ed, ed.store.page).posts.map((p) => p.id)).toEqual([a, b]);
    expect(at(ed, b)).toEqual(pb);
  });

  it("grid view and asset view (docs/social.md §23): a selected post isn't shown alone on the grid; the asset view shows the selection's post, else the last one, else the first", async () => {
    const { ed } = await social();
    const w = editorWriter(ed);
    const a = newPost(ed, w, { formatId: "instagram.portrait" });
    const b = newPost(ed, w, { formatId: "instagram.portrait" });
    expect(postsInOrder(ed)).toEqual([a, b]);
    ed.engine.setSelection([b]);
    expect(focusedPost(ed)?.id).toBe(b);
    expect(shownPost(ed)).toBeNull();
    setSocialView(ed, "asset");
    expect(shownPost(ed)).toBe(b);
    ed.ui.set({ socialAsset: b });
    ed.engine.setSelection([]);
    expect(shownPost(ed)).toBe(b);
    ed.ui.set({ socialAsset: null });
    expect(shownPost(ed)).toBe(a);
    // Out of Social (Design, Motion): no asset view, the board isn't arranged
    setMode(ed, "design");
    expect(shownPost(ed)).toBeNull();
    const t = ed.engine.readNode(b, { fields: ["transform"] })!.transform!;
    ed.setProps([b], { transform: { ...t, m02: 99999, m12: 77 } }, "Move");
    await tick();
    expect(at(ed, b)).toEqual({ x: 99999, y: 77 });
    // Back in Social: arranged again
    setMode(ed, "social");
    await tick();
    expect(at(ed, b)).not.toEqual({ x: 99999, y: 77 });
  });
});
