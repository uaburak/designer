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
import { focusedPost } from "../social/focus";
import { readBoard } from "../social/socialState";
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
    const col = 1080 + BOARD.gap;
    expect(places.get("a")).toEqual({ x: 0, y: BOARD.sectionHead });
    expect(places.get("b")).toEqual({ x: col, y: BOARD.sectionHead });
    expect(places.get("c")).toEqual({ x: 2 * col, y: BOARD.sectionHead });
    expect(places.get("d")).toEqual({ x: 0, y: BOARD.sectionHead + 1440 + BOARD.gap });
    expect(ig.grids[0].next).toEqual({ x: col, y: BOARD.sectionHead + 1440 + BOARD.gap });
    // The story grid beside the first, after the grid gap
    expect(places.get("s1")).toEqual({ x: 3 * 1080 + 2 * BOARD.gap + BOARD.gridGap, y: BOARD.sectionHead });
    // LinkedIn under Instagram's tallest grid, after the section gap
    expect(li.y).toBe(BOARD.sectionHead + 1440 + BOARD.gap + 1440 + BOARD.sectionGap);
    expect(places.get("li")).toEqual({ x: 0, y: li.y + BOARD.sectionHead });
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
    expect(at(ed, ids[3])).toEqual({ x: 2 * col, y: BOARD.sectionHead });
    expect(at(ed, ids[4])).toEqual({ x: 0, y: BOARD.sectionHead + 1440 + BOARD.gap });
    // One ⌘Z: the last post goes, nothing else moves
    expect(ed.store.undo.undoLabel).toBe("New post");
    ed.engine.undo();
    expect(ed.engine.readNode(ids[4], { fields: ["type"] })).toBeNull();
    expect(at(ed, ids[3])).toEqual({ x: 2 * col, y: BOARD.sectionHead });
  });

  it("a post moved among the others is reordered and the grid reflows, in the move's step", async () => {
    const { ed } = await social();
    const w = editorWriter(ed);
    const ids = [0, 1, 2, 3].map(() => newPost(ed, w, { formatId: "instagram.portrait" }));
    const before = ids.map((id) => at(ed, id));
    // The fourth dropped before the first (as a drag on the canvas commits it)
    const t = ed.engine.readNode(ids[3], { fields: ["transform"] })!.transform!;
    ed.setProps([ids[3]], { transform: { ...t, m02: -400, m12: BOARD.sectionHead } }, "Move");
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
});
