// @vitest-environment happy-dom
// The agents' Social tools (round 18c, docs/social.md §7.2) on the real engine: every tool listed with an object schema;
// get_board by campaign; list_formats with a brand's sizes; new_post with and without a template (18b's: one this file
// can't use refused, nothing left behind; save_as_template, fill_slots and apply_template through them); set_post's caption counts and marking a frame as a post;
// resize_post's duplicate; fill_slots refusing a locked slot; check_posts finding a caption overrun, a text in a story's
// bottom band and a video longer than its format, then clearing what was fixed; logos; a turn's writes one undo step.
import { readFileSync } from "node:fs";
import { slotTexts } from "../social/templates/templates";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Engine } from "@/engine/Engine";
import { EngineStore } from "@/engine/EngineStore";
import { loadEngine } from "@/engine/loadEngine";
import { SAMPLE_DOCUMENT } from "@/engine/sampleDocument";
import { TOOL_BY_NAME, WAITING_TOOLS, type ToolResult } from "@shared/agents/tools";
import { brandsUnavailable, type Brand } from "@shared/studio/types";
import { SOCIAL_PLUGIN_ID } from "@shared/social/types";
import { EditorController } from "../controller";
import { memoryDocumentSource } from "../documentSource";
import { runTool, type ToolEnv } from "../agents/mcpTools";
import { AgentTurns } from "../agents/turns";
import { readPost } from "../social/posts";
import { readBoard } from "../social/socialState";
import { setBrandsRepository } from "../studio/forms";

const wasm = join(process.cwd(), "src/renderer/src/engine/wasm/engine.wasm");

const brand: Brand = {
  id: "b1",
  name: "Partner Agro",
  colors: [],
  fonts: [],
  tone: "",
  logos: [],
  formats: [{ id: "banner", name: "Banner", width: 1500, height: 500 }],
  libraryFileKey: null,
  products: [],
  created: 0,
  updated: 0,
};

beforeAll(async () => {
  globalThis.fetch = async () => new Response(null, { status: 404 });
  const bytes = readFileSync(wasm);
  await loadEngine({ wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), printErr: () => {} });
});

afterEach(() => setBrandsRepository(null));

async function editor() {
  setBrandsRepository({ ...brandsUnavailable(), list: async () => [brand], get: async (id) => (id === brand.id ? brand : null) });
  const source = memoryDocumentSource(SAMPLE_DOCUMENT, { fileName: "Social" });
  const engine = await Engine.create(null, { sessionID: 1 });
  engine.load(await source.load());
  engine.setViewport(1280, 800, 1, 1280, 800);
  const ed = new EditorController(engine, new EngineStore(engine), source);
  const turns = new AgentTurns(ed);
  const env: ToolEnv = { ed, write: (_l, fn, refs) => turns.write("t1", "Claude Code", fn, refs) };
  const call = async (name: string, args: Record<string, unknown>) => runTool(env, name, args);
  return { ed, engine, turns, call };
}

const text = (r: ToolResult) => r.content.map((c) => (c.type === "text" ? c.text : "")).join("");
const json = (r: ToolResult) => {
  expect(r.isError, text(r)).toBeFalsy();
  return JSON.parse(text(r));
};
const error = (r: ToolResult) => {
  expect(r.isError, text(r)).toBe(true);
  return text(r);
};

const SOCIAL_TOOLS = ["get_board", "list_formats", "list_templates", "new_post", "apply_template", "fill_slots", "set_post", "resize_post", "set_campaign", "check_posts", "save_as_template", "export_posts"];

describe("agents' Social tools", () => {
  it("lists every Social tool with an object schema; reads are read tools; export_posts waits long", () => {
    for (const name of SOCIAL_TOOLS) {
      const t = TOOL_BY_NAME.get(name);
      expect(t, name).toBeDefined();
      expect(t!.inputSchema.type).toBe("object");
    }
    for (const name of ["get_board", "list_formats", "list_templates", "check_posts", "export_posts"]) expect(TOOL_BY_NAME.get(name)!.write, name).toBe(false);
    for (const name of ["new_post", "apply_template", "fill_slots", "set_post", "resize_post", "set_campaign", "save_as_template"]) expect(TOOL_BY_NAME.get(name)!.write, name).toBe(true);
    expect((TOOL_BY_NAME.get("new_post")!.inputSchema as { required: string[] }).required).toEqual(["formatId"]);
    expect((TOOL_BY_NAME.get("set_post")!.inputSchema as { properties: { status: { enum: string[] } } }).properties.status.enum).toEqual(["draft", "reviewed", "approved", "exported"]);
    expect(WAITING_TOOLS.has("export_posts")).toBe(true);
  });

  it("new_post makes a post in a new campaign; get_board reads it by campaign; list_formats adds the brand's sizes", async () => {
    const { ed, call } = await editor();
    const made = json(await call("new_post", { formatId: "instagram.post", campaign: "Liq Humus — October", brandId: "b1" }));
    expect(made.size).toEqual({ width: 1080, height: 1350 });
    expect(made.slots).toEqual([]);
    const story = json(await call("new_post", { formatId: "instagram.story", campaignId: made.campaignId }));
    const board = json(await call("get_board", {}));
    expect(board.campaigns).toHaveLength(1);
    expect(board.campaigns[0]).toMatchObject({ id: made.campaignId, name: "Liq Humus — October", brandId: "b1" });
    expect(board.campaigns[0].posts.map((p: { nodeId: string }) => p.nodeId)).toEqual([made.nodeId, story.nodeId]);
    expect(board.campaigns[0].posts[1]).toMatchObject({ formatId: "instagram.story", format: { name: "Instagram story", width: 1080, height: 1920, platform: "instagram" }, status: "draft", animated: false });
    // The story went to the right of the post, in its campaign's row.
    const rows = readBoard(ed, ed.store.page).posts;
    expect(rows.find((p) => p.id === story.nodeId)!.x).toBe(rows.find((p) => p.id === made.nodeId)!.x + 1080 + 120);
    const formats = json(await call("list_formats", { platform: "linkedin", brandId: "b1" }));
    expect(formats.formats.every((f: { platform: string }) => f.platform === "linkedin")).toBe(true);
    expect(formats.brand).toEqual([{ id: "brand:b1:banner", name: "Banner", width: 1500, height: 500 }]);
    // A brand's own size makes a post too.
    const banner = json(await call("new_post", { formatId: "brand:b1:banner" }));
    expect(banner.size).toEqual({ width: 1500, height: 500 });
    expect(error(await call("new_post", { formatId: "myspace.post" }))).toContain("Unknown format");
  });

  it("new_post from a template this file can't use is refused, leaving nothing behind; list_templates says there are none", async () => {
    const { ed, call } = await editor();
    expect(error(await call("new_post", { formatId: "instagram.post", templateKey: "abc", campaign: "Nope" }))).toContain("The template abc isn't in this file yet");
    expect(readBoard(ed, ed.store.page).posts).toEqual([]);
    expect(readBoard(ed, ed.store.page).campaigns).toEqual([]);
    expect(json(await call("list_templates", {})).templates).toEqual([]);
    // export_posts is round 18d's (socialExport.wasm.test.ts): it names the posts or a campaign.
    expect(error(await call("export_posts", {}))).toContain("export_posts: no nodes given");
  });

  it("save_as_template, new_post from it, fill_slots and apply_template work through 18b's templates", async () => {
    const { ed, call } = await editor();
    const post = json(await call("new_post", { formatId: "instagram.post" })).nodeId;
    json(await call("create_nodes", { parentId: post, nodes: [{ type: "TEXT", name: "Title", characters: "Hello", fontSize: 72 }, { type: "TEXT", name: "Copy", characters: "World", fontSize: 30, y: 300 }] }));
    const { templateKey } = json(await call("save_as_template", { nodeId: post, name: "Hero" }));
    expect(templateKey).toMatch(/^[0-9a-f]{40}$/);
    const made = json(await call("new_post", { formatId: "instagram.post", templateKey, brandId: "b1" })).nodeId;
    expect(readPost(ed, made)).toMatchObject({ brandId: "b1", template: { key: templateKey, variant: "Instagram post" } });
    json(await call("fill_slots", { nodeId: made, values: { headline: "Merhaba", body: "Dünya" } }));
    expect(slotTexts(ed, made)).toEqual({ headline: "Merhaba", body: "Dünya" });
    const plain = json(await call("new_post", { formatId: "instagram.post" })).nodeId;
    const applied = json(await call("apply_template", { nodeId: plain, templateKey })).posts;
    expect(applied).toHaveLength(1);
    expect(readPost(ed, applied[0].nodeId)?.template?.key).toBe(templateKey);
  });

  it("set_post returns the caption count against the format; formatId marks a frame as a post", async () => {
    const { ed, engine, call } = await editor();
    const post = json(await call("new_post", { formatId: "instagram.post" })).nodeId;
    const r = json(await call("set_post", { nodeId: post, caption: "Toprağınız için 🌱 @partneragro", hashtags: ["#tarım", "gübre"], altText: "A bottle", status: "reviewed" }));
    expect(r.posts[0]).toMatchObject({ status: "reviewed", caption: { max: 2200, unit: "grapheme", over: false }, hashtags: { count: 2, max: 30 }, mentions: { count: 1 } });
    expect(readPost(ed, post)).toMatchObject({ hashtags: ["tarım", "gübre"], altText: "A bottle" });
    // A frame that isn't a post: refused without formatId, marked with it.
    const frame = json(await call("create_nodes", { nodes: [{ type: "FRAME", name: "Hand drawn", width: 1200, height: 628 }] })).created[0].id;
    expect(error(await call("set_post", { nodeId: frame, caption: "x" }))).toContain("isn't a post");
    json(await call("set_post", { nodeId: frame, formatId: "linkedin.landscape", caption: "Hi" }));
    expect(readPost(ed, frame)).toMatchObject({ formatId: "linkedin.landscape", caption: "Hi", status: "draft" });
    expect(engine.readNode(frame, { fields: ["size"] })!.size).toEqual({ x: 1200, y: 628 });
    expect(error(await call("set_post", { caption: "x" }))).toContain("no nodes given");
  });

  it("resize_post with duplicate makes a fresh draft copy in the new format; in place it resizes", async () => {
    const { ed, engine, call } = await editor();
    const post = json(await call("new_post", { formatId: "instagram.post" })).nodeId;
    json(await call("set_post", { nodeId: post, caption: "Hello", status: "approved" }));
    const copy = json(await call("resize_post", { nodeId: post, formatId: "linkedin.landscape", duplicate: true })).posts[0];
    expect(copy.nodeId).not.toBe(post);
    expect(engine.readNode(copy.nodeId, { fields: ["size"] })!.size).toEqual({ x: 1200, y: 628 });
    expect(readPost(ed, copy.nodeId)).toMatchObject({ formatId: "linkedin.landscape", caption: "Hello", status: "draft" });
    expect(readPost(ed, post)).toMatchObject({ formatId: "instagram.post", status: "approved" });
    json(await call("resize_post", { nodeId: post, formatId: "instagram.square" }));
    expect(engine.readNode(post, { fields: ["size"] })!.size).toEqual({ x: 1080, y: 1080 });
  });

  it("set_campaign adds, renames and removes; a removed campaign's posts stay without one", async () => {
    const { ed, call } = await editor();
    const c = json(await call("set_campaign", { name: "Spring", brandId: "b1" })).campaignId;
    const post = json(await call("new_post", { formatId: "instagram.post", campaignId: c })).nodeId;
    json(await call("set_campaign", { campaignId: c, name: "Spring sale" }));
    expect(json(await call("get_board", {})).campaigns[0].name).toBe("Spring sale");
    json(await call("set_campaign", { campaignId: c, remove: true }));
    expect(readPost(ed, post)!.campaignId).toBeNull();
    expect(json(await call("get_board", {})).unplaced[0].nodeId).toBe(post);
  });

  it("fill_slots refuses a locked slot (by the template's tag), before anything is written", async () => {
    const { ed, engine, call } = await editor();
    const post = json(await call("new_post", { formatId: "instagram.post" })).nodeId;
    const headline = json(await call("create_nodes", { parentId: post, nodes: [{ type: "TEXT", name: "Headline", characters: "Hi" }] })).created[0].id;
    // A slot as 18b's templates tag it (docs/social.md §3.3), locked by its author.
    ed.batch("Tag", () => engine.setProps([headline], { pluginData: [{ pluginID: SOCIAL_PLUGIN_ID, key: "slot", value: JSON.stringify({ v: 1, role: "headline", property: null, locked: true, maxChars: 20 }) }] } as never));
    expect(error(await call("fill_slots", { nodeId: post, values: { headline: "New" } }))).toContain("headline is locked in this template");
    expect(error(await call("fill_slots", { nodeId: post }))).toContain("values");
  });

  it("check_posts finds a caption overrun, a text in a story's bottom band and a 20 s video on a 15 s format, writes them as pins, and clears what is fixed", async () => {
    const { ed, engine, call } = await editor();
    const post = json(await call("new_post", { formatId: "linkedin.landscape" })).nodeId;
    json(await call("set_post", { nodeId: post, caption: "a".repeat(3100) }));
    const story = json(await call("new_post", { formatId: "instagram.story" })).nodeId;
    // A text in the story's bottom 672 px (the reply bar and buttons cover it), one inside the safe area.
    const low = json(await call("create_nodes", { parentId: story, nodes: [{ type: "TEXT", name: "CTA", characters: "Shop now", x: 100, y: 1700, fontSize: 48 }] })).created[0].id;
    json(await call("create_nodes", { parentId: story, nodes: [{ type: "TEXT", name: "Title", characters: "Hello", x: 100, y: 600, fontSize: 48 }] }));
    // An animated story longer than the format takes (§10 says "20 s on a 15 s format"; the catalogue's story video is 3–60 s, §5.2).
    const reel = json(await call("new_post", { formatId: "instagram.story" })).nodeId;
    const dot = json(await call("create_nodes", { parentId: reel, nodes: [{ type: "RECTANGLE", name: "Dot", x: 400, y: 800, width: 100, height: 100 }] })).created[0].id;
    json(await call("add_animation", { nodeId: dot, style: "Opacity", duration: 1 }));
    json(await call("set_timeline", { nodeId: reel, duration: 61 }));
    const r = json(await call("check_posts", {}));
    const of = (id: string) => r.posts.find((p: { nodeId: string }) => p.nodeId === id).problems;
    expect(of(post)).toEqual([expect.objectContaining({ kind: "caption", fix: "rewrite", detail: expect.stringContaining("3000") })]);
    expect(of(story)).toEqual([expect.objectContaining({ kind: "safe-area", fix: "relayout", detail: expect.stringContaining("“CTA”"), box: expect.objectContaining({ y: 1700 }) })]);
    expect(of(reel)).toEqual([expect.objectContaining({ kind: "video", fix: "retime", detail: expect.stringContaining("61 s") })]);
    expect(r.ok).toBe(false);
    // Written as pins, the review's kept apart.
    expect(readPost(ed, story)!.problems).toEqual([expect.objectContaining({ id: `check:safe-area:${low}`, source: "check" })]);
    // Fixed: the CTA moved up, the caption cut; the next check clears both.
    json(await call("update_nodes", { updates: [{ nodeId: low, y: 1000 }] }));
    json(await call("set_post", { nodeId: post, caption: "Short" }));
    json(await call("check_posts", { nodeIds: [post, story] }));
    expect(readPost(ed, story)!.problems).toEqual([]);
    expect(readPost(ed, post)!.problems).toEqual([]);
    void engine;
  });

  it("a post with a brand and no logo, or two logos, is a logo problem", async () => {
    const { ed, call } = await editor();
    const post = json(await call("new_post", { formatId: "instagram.square", brandId: "b1" })).nodeId;
    expect(json(await call("check_posts", { nodeIds: [post] })).posts[0].problems).toEqual([expect.objectContaining({ kind: "logo", detail: "The post has no logo." })]);
    json(await call("create_nodes", { parentId: post, nodes: [{ type: "FRAME", name: "Logo", x: 160, y: 80, width: 200, height: 80, children: [{ type: "RECTANGLE", name: "Logo mark" }] }, { type: "RECTANGLE", name: "logo copy", x: 800, y: 80 }] }));
    expect(json(await call("check_posts", { nodeIds: [post] })).posts[0].problems).toEqual([expect.objectContaining({ kind: "logo", detail: "The post has 2 logos." })]);
    void ed;
  });

  it("a turn's Social writes are one undo step", async () => {
    const { ed, turns, call } = await editor();
    turns.start("t1", "Claude Code");
    const post = json(await call("new_post", { formatId: "instagram.post", campaign: "One step" })).nodeId;
    json(await call("set_post", { nodeId: post, caption: "Hi" }));
    json(await call("resize_post", { nodeId: post, formatId: "linkedin.square", duplicate: true }));
    turns.finish("t1");
    expect(readBoard(ed, ed.store.page).posts).toHaveLength(2);
    // The turn is one step of its own (the chat's Undo), not the user's history.
    expect(ed.store.undo.canUndo).toBe(false);
    expect(turns.undo("t1")).toBe(true);
    expect(readBoard(ed, ed.store.page).posts).toHaveLength(0);
    expect(readBoard(ed, ed.store.page).campaigns).toEqual([]);
  });
});
