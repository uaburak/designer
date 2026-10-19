// @vitest-environment happy-dom
// Social's export (docs/social.md §8, §10's 18d row, round 18d) on the real engine: "auto" picking a still or animated
// post's preset, the plans (file names, size, frame rate, codec, bitrate, length checked against the format), a
// campaign's zip, the JPEG quality steps keeping a noisy thumbnail ≤ 2 MB, a PNG over LinkedIn's 5 MB becoming a JPEG,
// a 3-slide document's PDF in index order (the engine's own PDF), size checks warning, `export_posts` handing back its
// files, the posts marked exported in one undo step; the dialog's rows and presets, the Animated tab's Preset menu, the
// timeline's Social header, the canvas menu's post rows, Export campaign… and Space in Social. The static exports'
// PNG / JPEG encoding needs OffscreenCanvas (none headless): those renders are faked by size, PDF and video plans real.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { beforeAll, describe, expect, it } from "vitest";
import { Engine } from "@/engine/Engine";
import { EngineStore } from "@/engine/EngineStore";
import { loadEngine } from "@/engine/loadEngine";
import { SAMPLE_DOCUMENT } from "@/engine/sampleDocument";
import { $$, click, mount } from "@/ds/__tests__/dom";
import type { ToolResult } from "@shared/agents/tools";
import type { ExportSettings } from "@shared/schema/document.generated";
import { EditorContext, EditorController } from "../controller";
import { memoryDocumentSource } from "../documentSource";
import { runTool, type ToolEnv } from "../agents/mcpTools";
import { AgentTurns } from "../agents/turns";
import { command, isEnabled } from "../commands";
import { setMode } from "../devmode/devMode";
import { canvasMenu, runMenuItem } from "../menus";
import { animatedSettingOf, writeAnimatedSetting } from "../motion/export/animatedSettings";
import { ExportAnimatedTab } from "../panels/design/ExportAnimated";
import { editorWriter, newCampaign, newPost, setCampaign } from "../social/actions";
import { ExportPostsDialog, jpegQualityOf } from "../social/export/ExportPostsDialog";
import { animatedExportRunning, takeAnimatedExport } from "../motion/export/exportAnimated";
import { EDITOR_RENDERERS, JPEG_STEPS, autoPreset, exportPosts, fitStill, markExported, planExports, planPostExport, presetsFor, renderPlan, timelineHeader, type ExportRenderers } from "../social/export/exportPosts";
import { readPost, writePost } from "../social/posts";
import { campaignPosts } from "../social/SocialMode";

const wasm = join(process.cwd(), "src/renderer/src/engine/wasm/engine.wasm");
const MB = 1024 * 1024;

beforeAll(async () => {
  globalThis.fetch = async () => new Response(null, { status: 404 });
  const bytes = readFileSync(wasm);
  await loadEngine({ wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), printErr: () => {} });
});

async function editor() {
  const source = memoryDocumentSource(SAMPLE_DOCUMENT, { fileName: "Social" });
  const engine = await Engine.create(null, { sessionID: 1 });
  engine.load(await source.load());
  engine.setViewport(1280, 800, 1, 1280, 800);
  const ed = new EditorController(engine, new EngineStore(engine), source);
  const turns = new AgentTurns(ed);
  const env: ToolEnv = { ed, write: (_l, fn, refs) => turns.write("t1", "Claude Code", fn, refs) };
  const call = async (name: string, args: Record<string, unknown>) => runTool(env, name, args);
  return { ed, engine, call, w: editorWriter(ed) };
}

const json = (r: ToolResult) => {
  if (r.isError) throw new Error(r.content.map((c) => (c.type === "text" ? c.text : "")).join(""));
  return JSON.parse(r.content.map((c) => (c.type === "text" ? c.text : "")).join(""));
};

type Call = Awaited<ReturnType<typeof editor>>["call"];

/** An animated post: a dot fading for 1 s, the timeline `seconds` long. */
async function animatedPost(call: Call, formatId: string, seconds: number, campaign?: string): Promise<string> {
  const post = json(await call("new_post", { formatId, ...(campaign ? { campaign } : {}) })).nodeId;
  const dot = json(await call("create_nodes", { parentId: post, nodes: [{ type: "RECTANGLE", name: "Dot", x: 400, y: 800, width: 100, height: 100 }] })).created[0].id;
  json(await call("add_animation", { nodeId: dot, style: "Opacity", duration: 1 }));
  json(await call("set_timeline", { nodeId: post, duration: seconds }));
  return post;
}

/** Fakes for the two exports: a still's bytes by its format and quality (`size`), a video's by `video`; the calls kept. */
function fakes(size: (s: ExportSettings) => number = () => 1000, video = 1000) {
  const calls: { refs: string[]; settings: ExportSettings }[] = [];
  const renderers: ExportRenderers = {
    still: async (_ed, refs, settings) => {
      calls.push({ refs: [...refs], settings });
      return { bytes: new Uint8Array(size(settings)).fill(refs.length) };
    },
    animated: async () => ({ bytes: new Uint8Array(video) }),
  };
  return { renderers, calls };
}

/** A stored zip's entries (local headers in order): name and size. */
function unzip(bytes: Uint8Array): { name: string; size: number }[] {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: { name: string; size: number }[] = [];
  let at = 0;
  while (at + 30 <= bytes.length && v.getUint32(at, true) === 0x04034b50) {
    const size = v.getUint32(at + 18, true);
    const len = v.getUint16(at + 26, true);
    out.push({ name: new TextDecoder().decode(bytes.subarray(at + 30, at + 30 + len)), size });
    at += 30 + len + size;
  }
  return out;
}

describe("Social export (round 18d)", () => {
  it("auto picks the format's still preset for a still post and its video preset for an animated one", async () => {
    expect(autoPreset("instagram.post", false).id).toBe("instagram-image");
    expect(autoPreset("instagram.story", false).id).toBe("instagram-image");
    expect(autoPreset("instagram.story", true).id).toBe("instagram-reel");
    expect(autoPreset("linkedin.document", false).id).toBe("linkedin-document");
    expect(autoPreset("facebook.story", true).id).toBe("vertical-video");
    expect(autoPreset("facebook.post", false).id).toBe("generic-image");
    expect(autoPreset("brand:b1:banner", true).id).toBe("generic-video");
    // The menu: a still post only still presets; an animated one its video presets first.
    expect(presetsFor("instagram.story", false).map((p) => p.id)).toEqual(["instagram-image", "generic-image"]);
    expect(presetsFor("instagram.story", true).map((p) => p.id)).toEqual(["instagram-reel", "generic-video", "instagram-image", "generic-image"]);
    const { ed, call } = await editor();
    const still = json(await call("new_post", { formatId: "instagram.story" })).nodeId;
    const moving = await animatedPost(call, "instagram.story", 6);
    expect(planPostExport(ed, still)?.preset.id).toBe("instagram-image");
    expect(planPostExport(ed, moving)?.preset.id).toBe("instagram-reel");
    // Another preset by id; an unknown one is "auto".
    expect(planPostExport(ed, moving, "vertical-video")).toMatchObject({ auto: false, preset: { id: "vertical-video" } });
    expect(planPostExport(ed, moving, "nope")).toMatchObject({ auto: true, preset: { id: "instagram-reel" } });
  });

  it("plans the file, size, frame rate, codec and bitrate, and checks the length against the format", async () => {
    const { ed, call } = await editor();
    const reel = await animatedPost(call, "instagram.reel", 6, "Spring sale");
    const long = await animatedPost(call, "instagram.story", 61);
    const thumb = json(await call("new_post", { formatId: "youtube.thumbnail" })).nodeId;
    const plan = planPostExport(ed, reel)!;
    expect(plan).toMatchObject({ file: "Spring sale/Instagram reel — Instagram reel.mp4", width: 1080, height: 1920, fps: 30, codec: "H.264", durationSec: 6, maxBytes: 300 * MB, warnings: [] });
    // 1080 × 1920 × 30 fps × 0.2 bits (High): 12.4 Mbps, under the reel's 25.
    expect(plan.bitrate).toBe(Math.round(1080 * 1920 * 30 * 0.2));
    // A 61 s story: outside 3 s – 1 min; its limit is the story's 100 MB, not the preset's 300.
    const story = planPostExport(ed, long)!;
    expect(story.warnings).toEqual([expect.stringContaining("1 min 1 s is outside Instagram story's 3 s – 1 min")]);
    expect(story.maxBytes).toBe(100 * MB);
    // The thumbnail at 3× (3840 × 2160), a JPEG 0.92 in sRGB, ≤ 2 MB.
    expect(planPostExport(ed, thumb)).toMatchObject({ file: "YouTube thumbnail — YouTube thumbnail.jpg", width: 3840, height: 2160, maxBytes: 2 * MB, still: { imageType: "JPEG", quality: 0.92, colorProfile: "SRGB", constraint: { type: "CONTENT_SCALE", value: 3 } } });
    // The timeline's Social header: the format, its limits and the preset's rate.
    expect(timelineHeader(ed, reel)).toEqual({ text: "Instagram reel · 3 s – 15 min · 30 fps", minUs: 3e6, maxUs: 900e6 });
    expect(timelineHeader(ed, thumb)).toEqual({ text: "YouTube thumbnail · 30 fps" });
  });

  it("zips a campaign's files under its folder, and marks its posts exported in one undo step", async () => {
    const { ed, engine, call, w } = await editor();
    const a = json(await call("new_post", { formatId: "instagram.post", campaign: "Spring" })).nodeId;
    const campaignId = readPost(ed, a)!.campaignId!;
    const b = json(await call("new_post", { formatId: "linkedin.square", campaignId })).nodeId;
    const other = json(await call("new_post", { formatId: "instagram.square" })).nodeId;
    ed.engine.setSelection([b]);
    setMode(ed, "social");
    // Export campaign…: the selected post's campaign, not the post outside it.
    expect(campaignPosts(ed).sort()).toEqual([a, b].sort());
    const { renderers } = fakes();
    const r = await exportPosts(ed, campaignPosts(ed), { renderers });
    expect(r.files.map((f) => f.name)).toEqual(["Spring.zip"]);
    expect(unzip(r.files[0].bytes).map((e) => e.name).sort()).toEqual(["Spring/Instagram post — Instagram post.jpg", "Spring/LinkedIn square — LinkedIn square.png"]);
    expect(unzip(r.files[0].bytes).every((e) => e.size === 1000)).toBe(true);
    expect(r.exported.sort()).toEqual([a, b].sort());
    // One file alone leaves without its folder or a zip.
    const one = await exportPosts(ed, [a], { renderers });
    expect(one.files.map((f) => f.name)).toEqual(["Instagram post — Instagram post.jpg"]);
    markExported(ed, w, r.exported);
    expect(ed.store.undo.undoLabel).toBe("Export posts");
    expect(readPost(ed, a)).toMatchObject({ status: "exported", exportedAt: expect.any(Number) });
    expect(readPost(ed, other)?.status).toBe("draft");
    engine.command("UNDO");
    expect(readPost(ed, a)).toMatchObject({ status: "draft", exportedAt: null });
    expect(readPost(ed, b)?.status).toBe("draft");
  });

  it("lowers a noisy thumbnail's JPEG quality in steps until it is ≤ 2 MB; a PNG over LinkedIn's 5 MB becomes a JPEG", async () => {
    // A noisy 3840 × 2160 picture: its JPEG ~4.2 MB per unit of quality (a photo of grain barely compresses).
    const noisy = (s: ExportSettings) => Math.round(4.2e6 * (s.imageType === "JPEG" ? (s.quality ?? 1) : 2.5));
    const fit = await fitStill(async (s) => ({ bytes: new Uint8Array(noisy(s)) }), { imageType: "JPEG", quality: 0.92 }, 2 * MB, true);
    expect(fit).toMatchObject({ over: false, settings: { quality: 0.4 } });
    expect((fit as { bytes: Uint8Array }).bytes.length).toBeLessThanOrEqual(2 * MB);
    // Never above the first quality; the last step still over is a warning, not a failure.
    const tried: number[] = [];
    const hopeless = await fitStill(async (s) => (tried.push(s.quality ?? 1), { bytes: new Uint8Array(3 * MB) }), { imageType: "JPEG", quality: 0.92 }, 2 * MB, true);
    expect(tried).toEqual([...JPEG_STEPS]);
    expect(hopeless).toMatchObject({ over: true, settings: { quality: JPEG_STEPS[JPEG_STEPS.length - 1] } });
    const { ed, call } = await editor();
    const thumb = json(await call("new_post", { formatId: "youtube.thumbnail" })).nodeId;
    const done = await renderPlan(ed, planPostExport(ed, thumb)!, fakes(noisy).renderers);
    expect(done).toMatchObject({ file: { name: "YouTube thumbnail — YouTube thumbnail.jpg" }, warnings: ["JPEG quality lowered to 0.4 to fit 2.0 MB"] });
    // LinkedIn: the PNG over 5 MB, then JPEG 0.92 fits.
    const li = json(await call("new_post", { formatId: "linkedin.landscape" })).nodeId;
    const big = await renderPlan(ed, planPostExport(ed, li)!, fakes((s) => (s.imageType === "PNG" ? 6 * MB : MB)).renderers);
    expect(big).toMatchObject({ file: { name: "LinkedIn landscape — LinkedIn landscape.jpg" }, warnings: ["Saved as JPEG: the PNG was over 5.0 MB"] });
  });

  it("warns when a file is over its limit after rendering", async () => {
    const { ed, call } = await editor();
    const story = await animatedPost(call, "instagram.story", 6);
    const r = await renderPlan(ed, planPostExport(ed, story)!, fakes(undefined, 120 * MB).renderers);
    expect(r).toMatchObject({ file: { name: "Instagram story — Instagram story.mp4" }, warnings: ["120 MB is over the 100 MB limit"] });
    // A PDF can't step down: over is a warning too.
    const doc = json(await call("new_post", { formatId: "linkedin.document" })).nodeId;
    const pdf = await renderPlan(ed, planPostExport(ed, doc)!, fakes(() => 101 * MB).renderers);
    expect(pdf).toMatchObject({ warnings: ["101 MB is over the 100 MB limit"] });
  });

  it("exports a 3-slide document as one PDF of its slides in index order, with the engine's PDF writer", async () => {
    const { ed, engine, w } = await editor();
    const slides = [0, 1, 2].map((i) => newPost(ed, w, { formatId: "linkedin.document", name: `Slide ${i}` }));
    // Placed in the order 2, 0, 1: the file follows the index, not the board.
    ed.batch("Group", () => slides.forEach((id, i) => writePost(ed, id, { ...readPost(ed, id)!, group: { id: "g1", index: [2, 0, 1][i] } })));
    const { renderers, calls } = fakes();
    const plans = planExports(ed, slides, "auto");
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ post: slides[1], slides: [slides[1], slides[2], slides[0]], still: { imageType: "PDF", contentsOnly: true } });
    const r = await exportPosts(ed, slides, { renderers });
    expect(calls[0].refs).toEqual([slides[1], slides[2], slides[0]]);
    expect(r.files.map((f) => f.name)).toEqual(["Slide 1 — LinkedIn document.pdf"]);
    expect(r.exported).toEqual([slides[1], slides[2], slides[0]]);
    // The real renderer: a PDF with three pages.
    const real = await exportPosts(ed, slides, { renderers: EDITOR_RENDERERS });
    const text = new TextDecoder("latin1").decode(real.files[0].bytes);
    expect(text.startsWith("%PDF")).toBe(true);
    expect(text.match(/\/Type\s*\/Page\b/g)).toHaveLength(3);
    engine.destroy();
  });

  it("export_posts hands its files back and marks the posts exported in the turn's one step", async () => {
    const { ed, call } = await editor();
    const a = json(await call("new_post", { formatId: "linkedin.document", campaign: "Deck" })).nodeId;
    const campaignId = readPost(ed, a)!.campaignId!;
    const b = json(await call("new_post", { formatId: "linkedin.document", campaignId })).nodeId;
    const r = await call("export_posts", { campaignId });
    const out = json(r);
    // Two PDFs (no group: each its own document) in one zip.
    expect(out.files).toEqual([{ file: "Deck.zip", bytes: expect.any(Number) }]);
    expect(r.files).toHaveLength(1);
    expect(r.files![0]).toMatchObject({ name: "Deck.zip", mimeType: "application/zip" });
    expect(unzip(Uint8Array.from(atob(r.files![0].data), (c) => c.charCodeAt(0))).map((e) => e.name)).toHaveLength(2);
    expect(out.posts.map((p: { preset: string }) => p.preset)).toEqual(["linkedin-document", "linkedin-document"]);
    expect([readPost(ed, a)?.status, readPost(ed, b)?.status]).toEqual(["exported", "exported"]);
    // One post, no zip: the PDF itself.
    const single = await call("export_posts", { nodeIds: [a] });
    expect(single.files![0]).toMatchObject({ name: "LinkedIn document — LinkedIn document.pdf", mimeType: "application/pdf" });
    // An unknown preset or campaign is refused by name.
    expect((await call("export_posts", { nodeIds: [a], preset: "tiktok" })).isError).toBe(true);
    expect((await call("export_posts", { campaignId: "nope" })).isError).toBe(true);
  });

  it("the dialog lists each post with its preset, what it renders and its file; a preset picked changes the plan", async () => {
    const { ed, call } = await editor();
    const story = json(await call("new_post", { formatId: "instagram.story", campaign: "Launch" })).nodeId;
    const long = await animatedPost(call, "instagram.story", 61);
    ed.ui.set({ socialExport: { ids: [story, long] } });
    const view = mount(() => createElement(EditorContext.Provider, { value: ed }, createElement(ExportPostsDialog)), {});
    const rows = () => $$("[data-export-post]");
    expect(rows().map((r) => r.dataset.preset)).toEqual(["instagram-image", "instagram-reel"]);
    expect(rows()[0].textContent).toContain("1080 × 1920 · JPEG 0.92 · ≤ 8 MB");
    expect(rows()[0].textContent).toContain("Launch/Instagram story — Instagram story.jpg");
    expect(rows()[1].textContent).toContain("MP4 · H.264 · 30 fps · 12.4 Mbps · 1 min 1 s · ≤ 100 MB");
    expect($$("[data-export-warning]").map((e) => e.textContent)).toEqual([expect.stringContaining("outside Instagram story's 3 s – 1 min")]);
    expect(document.body.textContent).toContain("One zip of 2 files, by campaign");
    // The animated story as a still picture instead.
    click($$('[role="combobox"]').filter((c) => c.getAttribute("aria-label") === "Preset")[1]);
    click($$('[role="option"]').find((o) => o.textContent?.trim() === "Instagram image")!);
    expect(rows()[1].dataset.preset).toBe("instagram-image");
    expect($$("[data-export-warning]")).toHaveLength(0);
    view.unmount();
  });

  it("the Animated tab shows a post's Preset menu; picking one fills the fields", async () => {
    const { ed, call } = await editor();
    const story = await animatedPost(call, "instagram.story", 6);
    const view = mount(() => createElement(EditorContext.Provider, { value: ed }, createElement(ExportAnimatedTab, { targets: [{ guid: story, name: "Story" }], page: false })), {});
    const preset = () => $$('[role="combobox"]').find((c) => c.getAttribute("aria-label") === "Preset")!;
    expect(preset().textContent).toContain("Instagram reel");
    writeAnimatedSetting(ed, [story], { format: "GIF", size: { scale: 0.5 }, fps: 24, quality: "LOW", loop: true });
    view.rerender(() => createElement(EditorContext.Provider, { value: ed }, createElement(ExportAnimatedTab, { targets: [{ guid: story, name: "Story" }], page: false })), {});
    expect(preset().textContent).toContain("Custom");
    click(preset());
    click($$('[role="option"]').find((o) => o.textContent?.trim() === "Instagram reel")!);
    expect(animatedSettingOf(ed, story)).toMatchObject({ format: "MP4", fps: 30, quality: "HIGH", size: { width: 1080 } });
    view.unmount();
    // A frame that isn't a post: no menu.
    const plain = json(await call("create_nodes", { nodes: [{ type: "FRAME", name: "Plain", width: 200, height: 200 }] })).created[0].id;
    json(await call("create_nodes", { parentId: plain, nodes: [{ type: "RECTANGLE", name: "R", width: 10, height: 10 }] }));
    const other = mount(() => createElement(EditorContext.Provider, { value: ed }, createElement(ExportAnimatedTab, { targets: [{ guid: plain, name: "Plain" }], page: false })), {});
    expect($$('[role="combobox"]').some((c) => c.getAttribute("aria-label") === "Preset")).toBe(false);
    other.unmount();
  });

  it("the canvas menu over post frames has Resize to, Duplicate for, Save as template and Export; Export campaign and Space work in Social", async () => {
    const { ed, engine, w } = await editor();
    const post = newPost(ed, w, { formatId: "instagram.post" });
    setCampaign(ed, w, ed.store.page, newCampaign("Spring", null));
    engine.setSelection([post]);
    setMode(ed, "social");
    const ids = canvasMenu(ed, []).flatMap((e) => (e !== "-" && "id" in e ? [e.id] : []));
    expect(ids.slice(0, 4)).toEqual(["post:resize", "post:duplicate", "post:template", "post:export"]);
    runMenuItem(ed, "post:resize:instagram.square");
    expect(engine.readNode(post, { fields: ["size"] })?.size).toEqual({ x: 1080, y: 1080 });
    runMenuItem(ed, "post:export");
    expect(ed.ui.get().socialExport).toEqual({ ids: [post] });
    // Not in Design.
    setMode(ed, "design");
    expect(canvasMenu(ed, []).some((e) => e !== "-" && "id" in e && e.id.startsWith("post:"))).toBe(false);
    setMode(ed, "social");
    expect(isEnabled(ed, command("social.export-campaign"))).toBe(true);
    // Space plays only while the post's timeline shows.
    expect(isEnabled(ed, command("motion.play-pause"))).toBe(false);
    ed.ui.set({ socialTimeline: true });
    expect(isEnabled(ed, command("motion.play-pause"))).toBe(true);
  });
});

describe("Social export, the leftovers (docs/social.md §17)", () => {
  it("takes Motion's one-export-at-a-time lock for videos: refused while it is held, held while rendering", async () => {
    const { ed, call } = await editor();
    const reel = await animatedPost(call, "instagram.reel", 6);
    const still = json(await call("new_post", { formatId: "instagram.post" })).nodeId;
    const release = takeAnimatedExport(ed)!;
    const { renderers, calls } = fakes();
    const refused = await exportPosts(ed, [reel], { renderers });
    expect(refused).toMatchObject({ files: [], exported: [], posts: [{ post: reel, error: "An animation is already being exported" }] });
    // Stills don't need it.
    expect((await exportPosts(ed, [still], { renderers })).files).toHaveLength(1);
    expect(calls).toHaveLength(1);
    release();
    // Rendering a video holds it, and it is free again after.
    let during: boolean | null = null;
    const r = await exportPosts(ed, [reel], { renderers: { ...renderers, animated: async () => ((during = animatedExportRunning(ed)), { bytes: new Uint8Array(10) }) } });
    expect(r.files).toHaveLength(1);
    expect(during).toBe(true);
    expect(animatedExportRunning(ed)).toBe(false);
  });

  it("the dialog's quality fields go over the preset: a JPEG's quality, a video's quality and frame rate", async () => {
    const { ed, call } = await editor();
    const post = json(await call("new_post", { formatId: "instagram.post" })).nodeId;
    const reel = await animatedPost(call, "instagram.reel", 6);
    expect(planPostExport(ed, post, "auto", { jpegQuality: 0.7 })?.still).toMatchObject({ imageType: "JPEG", quality: 0.7 });
    const plan = planPostExport(ed, reel, "auto", { videoQuality: "LOW", fps: 60 })!;
    expect(plan.animated).toMatchObject({ quality: "LOW", fps: 60, size: { width: 1080, height: 1920 } });
    expect(plan.bitrate).toBeLessThan(planPostExport(ed, reel)!.bitrate!);
    expect(plan.warnings).toEqual([]);
    // The steps down start under the quality asked for.
    const { renderers, calls } = fakes((s) => ((s.quality ?? 1) > 0.6 ? 9 * MB : MB));
    await renderPlan(ed, planPostExport(ed, post, "auto", { jpegQuality: 0.7 })!, renderers);
    expect(calls.map((c) => c.settings.quality)).toEqual([0.7, 0.6]);
    expect(jpegQualityOf("85")).toBe(0.85);
    expect(jpegQualityOf("140 %")).toBe(1);
    expect(jpegQualityOf("")).toBeNull();
  });

  it("a carousel's slides export together in index order, in a folder named as its cover, videos within the Reel's limits", async () => {
    const { ed, call } = await editor();
    const a = json(await call("new_post", { formatId: "instagram.carousel", name: "Cover", campaign: "Spring" })).nodeId;
    const campaignId = readPost(ed, a)!.campaignId!;
    const b = await animatedPost(call, "instagram.carousel", 2);
    const c = json(await call("new_post", { formatId: "instagram.carousel", name: "Field", campaignId })).nodeId;
    ed.batch("Group", () => [a, b, c].forEach((id, i) => writePost(ed, id, { ...readPost(ed, id)!, campaignId, group: { id: "g1", index: [0, 2, 1][i] } })));
    // Asked for one slide, the whole carousel comes.
    const plans = planExports(ed, [b]);
    expect(plans.map((p) => p.post)).toEqual([a, c, b]);
    expect(plans.map((p) => p.file)).toEqual(["Spring/Cover — Instagram carousel/01 — Cover.jpg", "Spring/Cover — Instagram carousel/02 — Field.jpg", expect.stringMatching(/^Spring\/Cover — Instagram carousel\/03 — .+\.mp4$/)]);
    // The video slide: a Reel's 3 s – 15 min.
    expect(plans[2].warnings).toEqual([expect.stringContaining("outside Instagram carousel's 3 s – 15 min")]);
    const { renderers } = fakes();
    const r = await exportPosts(ed, [a, b, c], { renderers });
    expect(unzip(r.files[0].bytes).map((e) => e.name)).toEqual(plans.map((p) => p.file));
    expect(r.files[0].name).toBe("Spring.zip");
    // One slide alone: the count is checked.
    ed.batch("Ungroup", () => [b, c].forEach((id) => writePost(ed, id, { ...readPost(ed, id)!, group: null })));
    ed.batch("Group", () => writePost(ed, a, { ...readPost(ed, a)!, group: { id: "g1", index: 0 } }));
    expect(planExports(ed, [a])[0].warnings).toEqual(["1 slide: Instagram carousel takes 2–10"]);
  });

  it("the dialog saves one zip or the files one by one, and waits while an animation exports", async () => {
    const { ed, call } = await editor();
    const a = json(await call("new_post", { formatId: "instagram.post", campaign: "Launch" })).nodeId;
    const reel = await animatedPost(call, "instagram.reel", 6);
    ed.ui.set({ socialExport: { ids: [a, reel] } });
    const view = mount(() => createElement(EditorContext.Provider, { value: ed }, createElement(ExportPostsDialog)), {});
    const combo = (label: string) => $$('[role="combobox"]').filter((x) => x.getAttribute("aria-label") === label);
    expect(document.body.textContent).toContain("One zip of 2 files, by campaign");
    click(combo("Save as")[0]);
    click($$('[role="option"]').find((o) => o.textContent?.trim() === "Separate files")!);
    expect(document.body.textContent).toContain("2 files, in a folder per campaign");
    // The rows' fields: the JPEG's quality, the video's quality and frame rate.
    expect($$("[data-export-quality]")).toHaveLength(2);
    expect(combo("Frame rate")).toHaveLength(1);
    click(combo("Quality")[0]);
    click($$('[role="option"]').find((o) => o.textContent?.trim() === "Low")!);
    expect($$("[data-export-post]")[1].textContent).toMatch(/MP4 · H\.264 · 30 fps · \d+\.\d Mbps/);
    expect($$("[data-export-post]")[1].textContent).not.toContain("12.4 Mbps");
    // Another export running: Export waits.
    const release = takeAnimatedExport(ed)!;
    await new Promise((r) => setTimeout(r, 0));
    expect($$("[data-export-locked]")).toHaveLength(1);
    expect(($$("[data-export-posts]")[0] as HTMLButtonElement).disabled).toBe(true);
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect($$("[data-export-locked]")).toHaveLength(0);
    view.unmount();
  });
});
