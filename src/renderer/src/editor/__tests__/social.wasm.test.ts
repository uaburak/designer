// @vitest-environment happy-dom
// Social's shell (docs/social.md §10, round 18a) on the real engine: a post's record read and written through pluginData
// keeping the other entries and surviving bad JSON; the posts index by campaign after create / duplicate / delete /
// undo; the board's placement (a campaign's row to the right, a new row under); each action one undo step.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { Engine } from "@/engine/Engine";
import { EngineStore } from "@/engine/EngineStore";
import { loadEngine } from "@/engine/loadEngine";
import { SAMPLE_DOCUMENT } from "@/engine/sampleDocument";
import { SOCIAL_PLUGIN_ID } from "@shared/social/types";
import { EditorController } from "../controller";
import { memoryDocumentSource } from "../documentSource";
import { WORKFLOW_PLUGIN_ID } from "../frameStatus";
import { editorWriter, newCampaign, newPost, resizePost, setCampaign, setPost } from "../social/actions";
import { placePost, placePosts, POST_GAP, ROW_GAP } from "../social/board";
import { readPost, writePost } from "../social/posts";
import { readBoard, socialOf } from "../social/socialState";

const wasm = join(process.cwd(), "src/renderer/src/engine/wasm/engine.wasm");

beforeAll(async () => {
  globalThis.fetch = async () => new Response(null, { status: 404 });
  const bytes = readFileSync(wasm);
  await loadEngine({ wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), printErr: () => {} });
});

async function setup() {
  const source = memoryDocumentSource(SAMPLE_DOCUMENT, { fileName: "Test" });
  const engine = await Engine.create(null, { sessionID: 1 });
  engine.load(await source.load());
  engine.setViewport(1280, 800, 1, 1280, 800);
  const ed = new EditorController(engine, new EngineStore(engine), source);
  return { ed, engine, w: editorWriter(ed) };
}

type Entries = { pluginID?: string; key?: string; value?: string }[];
const entries = (engine: Engine, id: string) => (engine.readNode(id, { fields: ["pluginData"] }) as { pluginData?: Entries } | null)?.pluginData ?? [];
const undoLabel = (ed: EditorController) => ed.store.undo.undoLabel;

describe("Social posts (round 18a)", () => {
  it("reads and writes a post's record, keeping other plugin data and surviving bad JSON", async () => {
    const { ed, engine, w } = await setup();
    const id = newPost(ed, w, { formatId: "instagram.post" });
    expect(readPost(ed, id)).toMatchObject({ formatId: "instagram.post", status: "draft", campaignId: null });
    // Another plugin ID's entry (the owner's frame status) stays through our writes.
    ed.batch("Status", () => engine.setProps([id], { pluginData: [...entries(engine, id), { pluginID: WORKFLOW_PLUGIN_ID, key: "status", value: "done" }] }));
    setPost(ed, w, [id], { caption: "Merhaba", hashtags: ["#tarım", "tarım", " gübre "] });
    expect(readPost(ed, id)).toMatchObject({ caption: "Merhaba", hashtags: ["tarım", "gübre"] });
    expect(entries(engine, id).find((e) => e.pluginID === WORKFLOW_PLUGIN_ID)?.value).toBe("done");
    expect(entries(engine, id).filter((e) => e.pluginID === SOCIAL_PLUGIN_ID)).toHaveLength(1);
    // Bad JSON: not a post (and nothing throws); the board leaves it out.
    ed.batch("Break", () => engine.setProps([id], { pluginData: entries(engine, id).map((e) => (e.pluginID === SOCIAL_PLUGIN_ID ? { ...e, value: "{oops" } : e)) }));
    expect(readPost(ed, id)).toBeNull();
    expect(readBoard(ed, ed.store.page).posts).toEqual([]);
    // Written again: one entry, the other plugin's kept.
    ed.batch("Fix", () => writePost(ed, id, { v: 1, formatId: "instagram.story", brandId: null, productIds: [], campaignId: null, template: null, group: null, caption: "", hashtags: [], altText: "", status: "draft", problems: [], exportedAt: null }));
    expect(readPost(ed, id)?.formatId).toBe("instagram.story");
    expect(entries(engine, id).map((e) => e.pluginID).sort()).toEqual([SOCIAL_PLUGIN_ID, WORKFLOW_PLUGIN_ID].sort());
  });

  it("makes a post of the format's size, named after it, as one undo step", async () => {
    const { ed, engine, w } = await setup();
    const before = engine.readNode(ed.store.page, { childIds: true })?.childIds?.length ?? 0;
    const id = newPost(ed, w, { formatId: "instagram.story", brandId: "b1" });
    const n = engine.readNode(id, { fields: ["name", "size", "type", "parentIndex"] })!;
    expect(n).toMatchObject({ name: "Instagram story", type: "FRAME", size: { x: 1080, y: 1920 } });
    expect(n.parentIndex?.guid).toBe(ed.store.page);
    expect(readPost(ed, id)?.brandId).toBe("b1");
    expect(undoLabel(ed)).toBe("New post");
    engine.command("UNDO");
    expect(engine.readNode(id)).toBeNull();
    expect(engine.readNode(ed.store.page, { childIds: true })?.childIds?.length ?? 0).toBe(before);
    // A brand's own size comes with its dimensions.
    const own = newPost(ed, w, { formatId: "brand:b1:banner", format: { id: "banner", name: "Banner", width: 1500, height: 500 } });
    expect(engine.readNode(own, { fields: ["size", "name"] })).toMatchObject({ name: "Banner", size: { x: 1500, y: 500 } });
    expect(() => newPost(ed, w, { formatId: "nope.nope" })).toThrow(/Unknown format/);
  });

  it("lists posts by campaign after create, duplicate, delete and undo", async () => {
    const { ed, engine, w } = await setup();
    const index = socialOf(ed);
    const seen: number[] = [];
    const off = index.subscribe(() => seen.push(1));
    expect(index.get().posts).toEqual([]);
    const page = ed.store.page;
    const october = newCampaign("Liq Humus — October", "b1");
    setCampaign(ed, w, page, october);
    expect(undoLabel(ed)).toBe("Edit campaign");
    const a = newPost(ed, w, { formatId: "instagram.post", campaignId: october.id });
    const b = newPost(ed, w, { formatId: "instagram.story", campaignId: october.id });
    const loose = newPost(ed, w, { formatId: "linkedin.square" });
    let board = index.get();
    expect(board.groups.map((g) => [g.campaign?.name ?? null, g.posts.map((p) => p.id)])).toEqual([
      ["Liq Humus — October", [a, b]],
      [null, [loose]],
    ]);
    await Promise.resolve(); // listeners hear of it in a microtask (deferred.ts)
    expect(seen.length).toBeGreaterThan(0);

    // Duplicate for › LinkedIn landscape: a fresh draft in the same campaign, at the row's end; one undo step.
    setPost(ed, w, [a], { status: "approved" });
    const [copy] = resizePost(ed, w, [a], "linkedin.landscape", { duplicate: true });
    expect(undoLabel(ed)).toBe("Duplicate post");
    expect(readPost(ed, copy)).toMatchObject({ formatId: "linkedin.landscape", status: "draft", campaignId: october.id });
    expect(engine.readNode(copy, { fields: ["size", "name"] })).toMatchObject({ name: "LinkedIn landscape", size: { x: 1200, y: 628 } });
    board = index.get();
    expect(board.groups[0].posts.map((p) => p.id)).toEqual([a, b, copy]);
    const rowB = board.posts.find((p) => p.id === b)!;
    expect(board.posts.find((p) => p.id === copy)).toMatchObject({ x: rowB.x + rowB.width + POST_GAP, y: rowB.y });

    // Delete, then undo: the index follows.
    engine.setSelection([b]);
    engine.command("DELETE");
    expect(index.get().groups[0].posts.map((p) => p.id)).toEqual([a, copy]);
    engine.command("UNDO");
    expect(index.get().groups[0].posts.map((p) => p.id)).toEqual([a, b, copy]);

    // Removing the campaign moves its posts to "No campaign", one step; undone, they are back.
    setCampaign(ed, w, page, { id: october.id, remove: true });
    expect(undoLabel(ed)).toBe("Remove campaign");
    expect(index.get().groups.map((g) => g.campaign)).toEqual([null]);
    expect(index.get().groups[0].posts).toHaveLength(4);
    engine.command("UNDO");
    expect(index.get().groups[0].campaign?.id).toBe(october.id);
    off();
  });

  it("resizes a post in place to another format, one undo step", async () => {
    const { ed, engine, w } = await setup();
    const id = newPost(ed, w, { formatId: "instagram.post" });
    expect(resizePost(ed, w, [id], "instagram.square", { duplicate: false })).toEqual([id]);
    expect(engine.readNode(id, { fields: ["size"] })?.size).toEqual({ x: 1080, y: 1080 });
    expect(readPost(ed, id)?.formatId).toBe("instagram.square");
    expect(undoLabel(ed)).toBe("Resize post");
    engine.command("UNDO");
    expect(engine.readNode(id, { fields: ["size"] })?.size).toEqual({ x: 1080, y: 1350 });
    expect(readPost(ed, id)?.formatId).toBe("instagram.post");
  });

  it("flags a twin record left by a plain duplicate", async () => {
    const { ed, engine, w } = await setup();
    const id = newPost(ed, w, { formatId: "instagram.post" });
    engine.setSelection([id]);
    engine.command("DUPLICATE");
    const twin = engine.getSelection().refs[0];
    const board = readBoard(ed, ed.store.page);
    expect(board.posts.find((p) => p.id === twin)?.duplicateOf).toBe(id);
    expect(board.posts.find((p) => p.id === id)?.duplicateOf).toBeNull();
  });
});

describe("the board's placement", () => {
  const post = (campaignId: string | null, x: number, y: number, width = 1080, height = 1350) => ({ campaignId, x, y, width, height });

  it("puts a post right of its campaign's row", () => {
    const posts = [post("a", 0, 0), post("a", 1200, 0, 1080, 1920), post("b", 0, 2200)];
    expect(placePost(posts, "a")).toEqual({ x: 1200 + 1080 + POST_GAP, y: 0 });
    expect(placePost(posts, "b")).toEqual({ x: 1080 + POST_GAP, y: 2200 });
  });

  it("starts a new campaign's row under the lowest post, left-aligned with the first row", () => {
    const posts = [post("a", 100, 0), post("a", 1300, 0, 1080, 1920)];
    expect(placePost(posts, "new")).toEqual({ x: 100, y: 1920 + ROW_GAP });
    expect(placePost([], "new")).toEqual({ x: 0, y: 0 });
  });

  it("places several posts one after another", () => {
    expect(placePosts([], "a", [{ width: 100, height: 100 }, { width: 200, height: 100 }])).toEqual([{ x: 0, y: 0 }, { x: 100 + POST_GAP, y: 0 }]);
  });
});
