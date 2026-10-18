// The manager's tools on fakes (docs/studio.md §2.2, §5.4, §6): the library, the image runs, the workers and the
// canvas are stand-ins; the task queue is the real one. make_posts (frames named and placed in a row, the picture
// into each frame's "Picture" layer, the review after all), the cards' answers resolving the waiting calls, the
// image model card kept for the chat, delegate_task's agents, report_review's fixes; in Social (docs/social.md §7, round
// 18c) make_posts on the board (a campaign, posts made at once, templates, the Motion pass), the review's pins and its
// own fixes, the follow-up chips, make_brand_library until round 18b.
import { describe, expect, it } from "vitest";
import type { ToolResult } from "@shared/agents/tools";
import type { ProviderInfo } from "@shared/agents/types";
import type { ImageRouteInfo } from "@shared/ai/types";
import { DEFAULT_MANAGER_SETTINGS, brandsUnavailable, type Brand, type BrandsRepository, type ManagerSettings, type Product } from "@shared/studio/types";
import { formatById } from "@shared/social/formats";
import { SOCIAL_WORKER_LINE } from "@shared/social/managerPrompt";
import type { PostProblem } from "@shared/social/types";
import { TaskQueue } from "../agents/tasks";
import { campaignName, cleanReport, frameName, runManagerTool, type CardAnswer, type ManagerEnv, type StudioChatData, type ViewCard } from "../agents/managerTools";
import type { StudioImageRequest } from "../studio/images";

const product: Product = {
  id: "p1",
  brandId: "b1",
  name: "Liq Humus",
  shape: "1 L white bottle",
  images: [{ id: "img-pack", role: "packshot", name: "front", mime: "image/png", width: 800, height: 1200 }],
  labels: [
    { id: "l1", text: "LIQ HUMUS", tier: "sharp" },
    { id: "l2", text: "İçindekiler: …", tier: "soft" },
  ],
  labelsConfirmed: true,
  notes: "",
  created: 0,
  updated: 0,
};
const brand: Brand = {
  id: "b1",
  name: "Partner Agro",
  colors: [{ name: "Green", hex: "#1BA37A" }],
  fonts: ["Inter"],
  tone: "Earthy",
  logos: [{ id: "img-logo", role: "logo", name: "logo", mime: "image/png", width: 400, height: 200 }],
  formats: [
    { id: "post", name: "Post", width: 1080, height: 1350 },
    { id: "story", name: "Story", width: 1080, height: 1920 },
  ],
  libraryFileKey: null,
  products: [product],
  created: 0,
  updated: 0,
};

const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => {
  for (let i = 0; i < 20; i++) await tick();
};
const json = (r: ToolResult) => {
  const t = r.content.find((c) => c.type === "text");
  const text = t && t.type === "text" ? t.text : "";
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

interface Node {
  name: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  children: string[];
  fill?: string;
}

/** A manager's environment of fakes: a page with one frame on it, workers that make the frames they're asked for. */
/**
 * `social`: the view is in Social mode — new_post makes a post node (a record with its problems), set_campaign a campaign;
 * `templates`: new_post takes a templateKey (round 18b built), else it refuses it as the view does until then.
 */
function fakeEnv(o: { settings?: Partial<ManagerSettings>; routes?: ImageRouteInfo[]; withBrand?: Brand; social?: boolean; templates?: boolean } = {}) {
  const nodes = new Map<string, Node>([
    ["0:1", { name: "Page 1", type: "CANVAS", x: 0, y: 0, width: 0, height: 0, children: ["1:1"] }],
    ["1:1", { name: "Existing", type: "FRAME", x: 0, y: 0, width: 500, height: 400, children: [] }],
  ]);
  let next = 10;
  const settings: ManagerSettings = { ...DEFAULT_MANAGER_SETTINGS, image: { providerId: "gemini-images", model: "pro" }, ...o.settings };
  const providers: ProviderInfo[] = [
    { id: "claude-code", kind: "claude-code", label: "Claude Code", available: true, models: ["default"] },
    { id: "codex", kind: "codex", label: "Codex", available: true, models: ["default"] },
  ];
  let data: StudioChatData = {};
  const cards: ViewCard[] = [];
  const answers: ((a: CardAnswer) => void)[] = [];
  const workerPrompts: string[] = [];
  const images: StudioImageRequest[] = [];
  const tools: { name: string; args: Record<string, unknown> }[] = [];
  const blurred: { nodeId: string; boxes: unknown[] }[] = [];
  const problems = new Map<string, PostProblem[]>();
  const suggested: ViewCard[] = [];
  const brands: BrandsRepository = { ...brandsUnavailable(), get: async (id) => (id === (o.withBrand ?? brand).id ? (o.withBrand ?? brand) : null), image: async () => ({ data: "AAAA", mime: "image/png" }) };
  const queue = new TaskQueue({ limits: () => ({ cli: settings.parallel, image: 4 }), onChange: () => {} });
  const env: ManagerEnv = {
    chatId: "chat",
    messageId: "msg",
    signal: new AbortController().signal,
    settings: () => settings,
    providers: () => providers,
    queue,
    data: () => data,
    setData: (fn) => (data = fn(data)),
    ask: (card) => {
      cards.push(card);
      return new Promise((r) => answers.push(r));
    },
    noteTask: () => {},
    runWorker: async (_task, prompt) => {
      workerPrompts.push(prompt);
      // The worker makes the frame it was asked for (named in quotes after "FRAME named exactly"), with its Picture layer.
      const m = /FRAME named exactly “([^”]+)”, (\d+) × (\d+), at x (-?\d+), y (-?\d+)/.exec(prompt);
      if (m) {
        const id = `2:${next++}`;
        const pic = `2:${next++}`;
        nodes.set(pic, { name: "Picture", type: "RECTANGLE", x: 0, y: 0, width: +m[2], height: +m[3], children: [] });
        nodes.set(id, { name: m[1], type: "FRAME", x: +m[4], y: +m[5], width: +m[2], height: +m[3], children: [pic] });
        nodes.get("0:1")!.children.push(id);
      }
      // Social: the worker draws in the post made for it (its id in brackets), its Picture layer at the bottom.
      const post = /Finish one social post .*?\((\d+:\d+)\)/.exec(prompt);
      if (post && !prompt.includes("fill_slots {")) {
        const pic = `2:${next++}`;
        nodes.set(pic, { name: "Picture", type: "RECTANGLE", x: 0, y: 0, width: 100, height: 100, children: [] });
        nodes.get(post[1])!.children.unshift(pic);
      }
      return { summary: "Made it" };
    },
    brands,
    library: async (name) => ({ content: [{ type: "text", text: `${name} ran` }] }),
    runImage: async (req) => {
      images.push(req);
      return { data: new Uint8Array([1, 2, 3]), mime: "image/png", width: req.size.width, height: req.size.height, credits: 16 };
    },
    blur: async (nodeId, boxes) => void blurred.push({ nodeId, boxes }),
    imageRoutes: async () => o.routes ?? [],
    attach: async (files) => files.map((f) => ({ path: `/chat/attachments/${f.name}`, name: f.name, mime: "image/png" })),
    tool: async (name, args) => {
      tools.push({ name, args });
      if (name === "place_image") nodes.get(String(args.nodeId))!.fill = String(args.data);
      if (name === "get_screenshot") return { content: [{ type: "image", data: "PNG", mimeType: "image/png" }] };
      if (name === "set_campaign") return { content: [{ type: "text", text: JSON.stringify({ campaignId: "camp-1", name: args.name }) }] };
      if (name === "new_post") {
        if (args.templateKey && !o.templates) return { content: [{ type: "text", text: "new_post from a template isn't available yet" }], isError: true };
        const f = formatById(String(args.formatId))!;
        const id = `3:${next++}`;
        const page = nodes.get("0:1")!;
        nodes.set(id, { name: String(args.name), type: "FRAME", x: 600 + page.children.length * 1200, y: 0, width: f.width, height: f.height, children: [] });
        page.children.push(id);
        problems.set(id, []);
        return { content: [{ type: "text", text: JSON.stringify({ nodeId: id, campaignId: args.campaignId, slots: [] }) }] };
      }
      return { content: [{ type: "text", text: "{}" }] };
    },
    page: () => "0:1",
    read: (id) => nodes.get(id) ?? null,
    pictureOf: async (id) => nodes.get(id)?.fill ?? null,
    ...(o.social
      ? {
          social: () => true,
          posts: { problems: (id: string) => problems.get(id) ?? null, setProblems: (id: string, list: PostProblem[]) => void problems.set(id, list) },
          suggest: (card: ViewCard) => void suggested.push(card),
        }
      : {}),
  };
  return { env, nodes, cards, answers, workerPrompts, images, tools, blurred, problems, suggested, data: () => data, queue };
}

describe("make_posts", () => {
  it("an image task and a frame task per format × variation, frames named and placed in a row right of the page, each picture in its frame's Picture layer, then the review", async () => {
    const f = fakeEnv();
    const r = json(await runManagerTool(f.env, "make_posts", { brand: "b1", products: ["p1"], request: "Liq Humus post and story" }));
    expect(r.tasks).toHaveLength(9);
    expect(r.tasks.filter((t: { kind: string }) => t.kind === "image")).toHaveLength(4);
    const review = r.reviewTaskId as string;
    const [done] = await f.queue.wait([review], 5000);
    await settle();
    expect(done).toMatchObject({ state: "done", summary: "4 frames ready for review" });
    const names = ["Post v1", "Post v2", "Story v1", "Story v2"].map((s) => `Liq Humus — ${s}`);
    expect(names[0]).toBe(frameName([product], brand.formats[0], 1));
    const frames = done.nodeIds!.map((id) => f.nodes.get(id)!);
    expect(frames.map((n) => n.name)).toEqual(names);
    // In a row, right of the page's content (the frame ending at 500), 100 apart.
    expect(frames.map((n) => [n.x, n.y])).toEqual([[700, 0], [1880, 0], [3060, 0], [4240, 0]]);
    // Each picture went into its own frame's Picture layer; the image runs had the references and the format's ratio.
    for (const n of frames) expect(f.nodes.get(n.children[0])!.fill).toBe("AQID");
    expect(f.images.map((i) => i.aspectRatio)).toEqual(["4:5", "4:5", "9:16", "9:16"]);
    expect(f.images[0].references[0]).toEqual({ data: "AAAA", role: expect.any(String) });
    expect(f.images[0].route).toEqual({ providerId: "gemini-images", model: "pro" });
    // The frame workers got the logo file and the Picture layer to make.
    expect(f.workerPrompts[0]).toContain("/chat/attachments/Partner-Agro-logo.png");
    expect(f.workerPrompts[0]).toContain("“Picture”");
    // A brief kept on the chat; the next request's row goes under this one.
    expect(f.data().briefs).toHaveLength(1);
    expect(f.data().rows).toEqual({ pageId: "0:1", x: 700, nextY: 1920 + 200 });
  });

  it("refuses while the library misses something, unless the owner said go anyway", async () => {
    const f = fakeEnv({ withBrand: { ...brand, colors: [] } });
    const r = await runManagerTool(f.env, "make_posts", { brand: "b1", products: ["p1"] });
    expect(r.isError).toBe(true);
    expect(json(r).missing).toEqual(["Partner Agro has no colours"]);
    const go = json(await runManagerTool(f.env, "make_posts", { brand: "b1", products: ["p1"], anyway: true, formats: ["post"], variations: 1 }));
    expect(go.tasks).toHaveLength(3);
  });

  it("no image model set: the choice card asks (unavailable routes greyed), and “Use this for this chat” keeps the pick", async () => {
    const routes: ImageRouteInfo[] = [
      { providerId: "gemini-images", label: "Gemini API", models: [{ id: "m-pro", label: "Pro" }, { id: "m-fast", label: "Fast" }], available: true, references: true },
      { providerId: "openai-images", label: "OpenAI Images", models: [], available: false, reason: "Add a key", references: true },
    ];
    const f = fakeEnv({ settings: { image: null }, routes });
    const call = runManagerTool(f.env, "make_posts", { brand: "b1", products: ["p1"], formats: ["post"], variations: 1 });
    await settle();
    expect(f.cards).toHaveLength(1);
    expect(f.cards[0]).toMatchObject({ kind: "choice", remember: true, options: [{ id: "gemini-images|m-pro" }, { id: "gemini-images|m-fast" }, { id: "openai-images|", detail: "Add a key" }], disabled: ["openai-images|"] });
    f.answers[0]({ optionId: "gemini-images|m-fast", remember: true });
    const r = json(await call);
    expect(r.imageRoute).toEqual({ providerId: "gemini-images", model: "m-fast" });
    expect(f.data().imageRoute).toEqual({ providerId: "gemini-images", model: "m-fast" });
    // Kept for the chat: the next request doesn't ask.
    await runManagerTool(f.env, "make_posts", { brand: "b1", products: ["p1"], formats: ["post"], variations: 1 });
    expect(f.cards).toHaveLength(1);
  });
});

describe("cards and tasks", () => {
  it("ask_choice and show_form wait for the owner's answer; a turn that ended answers cancelled", async () => {
    const f = fakeEnv();
    const choice = runManagerTool(f.env, "ask_choice", { question: "Labels right?", options: [{ id: "yes", label: "Looks right" }, { id: "edit", label: "Edit" }] });
    await tick();
    f.answers[0]({ optionId: "yes", remember: false });
    expect(json(await choice)).toMatchObject({ optionId: "yes", label: "Looks right" });
    const form = runManagerTool(f.env, "show_form", { form: "brand", prefill: { name: "Partner Agro" } });
    await tick();
    expect(f.cards[1]).toMatchObject({ kind: "brand-form", prefill: { name: "Partner Agro" } });
    f.answers[1]({ brandId: "b9" });
    expect(json(await form)).toEqual({ brandId: "b9" });
    const product = runManagerTool(f.env, "show_form", { form: "product", brandId: "b9" });
    await tick();
    f.answers[2]({ cancelled: true });
    expect(json(await product)).toBe("cancelled");
  });

  it("delegate_task: the general agent by default, only allowed agents, dependencies checked; wait_tasks reports", async () => {
    const f = fakeEnv({ settings: { allowed: ["claude-code"] } });
    const a = json(await runManagerTool(f.env, "delegate_task", { title: "Rename", prompt: "Rename the layers" }));
    expect(a.agent).toBe("claude-code · claude-sonnet-5-5");
    const refused = await runManagerTool(f.env, "delegate_task", { title: "X", prompt: "Y", agent: "codex" });
    expect(refused.isError).toBe(true);
    expect((await runManagerTool(f.env, "delegate_task", { title: "X", prompt: "Y", dependsOn: ["nope"] })).isError).toBe(true);
    const w = json(await runManagerTool(f.env, "wait_tasks", { taskIds: [a.taskId] }));
    expect(w.tasks[0]).toMatchObject({ state: "done", summary: "Made it" });
    expect(f.workerPrompts[0]).toContain("Rename the layers");
  });

  it("report_review: the card's Fix selected dispatches the fixes (§6.2); Leave as is ends the loop", async () => {
    const f = fakeEnv();
    const made = json(await runManagerTool(f.env, "make_posts", { brand: "b1", products: ["p1"], formats: ["post"], variations: 1 }));
    const [rv] = await f.queue.wait([made.reviewTaskId], 5000);
    await settle();
    const frame = rv.nodeIds![0];
    const pic = f.nodes.get(frame)!.children[0];
    const report = {
      briefId: made.briefId,
      items: [
        {
          nodeId: frame,
          ok: false,
          problems: [
            { id: "a", kind: "sharp-text", detail: "“LIQ HUMUS” reads “LIQ HUMOS”", box: { x: 10, y: 10, width: 100, height: 20 } },
            { id: "b", kind: "soft-text", detail: "readable wrong words", box: { x: 50, y: 60, width: 80, height: 30 } },
            { id: "c", kind: "layout", detail: "the logo is outside the safe area" },
          ],
        },
      ],
    };
    const call = runManagerTool(f.env, "report_review", { report });
    await settle();
    const card = f.cards.at(-1)!;
    expect(card).toMatchObject({ kind: "review", report: { items: [{ problems: [{ fix: "fix-label" }, { fix: "blur" }, { fix: "relayout" }] }] } });
    f.answers.at(-1)!({ fix: ["a", "b", "c"] });
    const r = json(await call);
    expect(r.answer).toBe("Fix selected");
    expect(r.tasks.map((t: { title: string }) => t.title)).toEqual(["Fix label: Liq Humus — Post v1", "Relayout: Liq Humus — Post v1"]);
    expect(f.blurred).toEqual([{ nodeId: pic, boxes: [{ x: 50, y: 60, width: 80, height: 30 }] }]);
    await f.queue.wait(r.tasks.map((t: { taskId: string }) => t.taskId), 5000);
    // Fix label edited the frame's own picture, at the frame's ratio.
    const edit = f.images.at(-1)!;
    expect(edit.image).toBe("AQID");
    expect(edit.aspectRatio).toBe("4:5");
    expect(f.workerPrompts.at(-1)).toContain("the logo is outside the safe area");
    const leave = runManagerTool(f.env, "report_review", { report });
    await settle();
    f.answers.at(-1)!({ cancelled: true });
    expect(json(await leave).answer).toBe("Leave as is");
  });

  it("cleanReport keeps known kinds with their §6.2 fix and unique ids", () => {
    const r = cleanReport({ items: [{ nodeId: "1:2", problems: [{ id: "x", kind: "shape", fix: "blur" }, { id: "x", kind: "extra" }, { kind: "weird" }] }] }, "brief-1");
    expect(r.briefId).toBe("brief-1");
    expect(r.items[0].problems.map((p) => p.fix)).toEqual(["regenerate", "regenerate"]);
    expect(new Set(r.items[0].problems.map((p) => p.id)).size).toBe(2);
    expect(r.items[0].ok).toBe(false);
  });
});

describe("the manager in Social (docs/social.md §7)", () => {
  it("make_posts makes the posts on the board at once — a campaign, catalogue formats, Social's worker line — then the frame and image tasks, the Motion pass on video formats, and the review", async () => {
    const f = fakeEnv({ social: true });
    const r = json(await runManagerTool(f.env, "make_posts", { brand: "b1", products: ["p1"], formats: ["instagram.post", "instagram.story"], variations: 1, request: "Liq Humus için post + story", animate: { seconds: 6 } }));
    // The campaign by its default name; one post per format, made before any task runs.
    expect(f.tools.find((x) => x.name === "set_campaign")!.args).toEqual({ name: campaignName([product]), brandId: "b1" });
    expect(campaignName([product], new Date(2026, 9, 18))).toBe("Liq Humus — October");
    const made = f.tools.filter((x) => x.name === "new_post").map((x) => x.args);
    expect(made).toEqual([
      { formatId: "instagram.post", name: "Liq Humus — Instagram post v1", brandId: "b1", productId: "p1", campaignId: "camp-1" },
      { formatId: "instagram.story", name: "Liq Humus — Instagram story v1", brandId: "b1", productId: "p1", campaignId: "camp-1" },
    ]);
    expect(r.campaignId).toBe("camp-1");
    expect(r.posts.map((p: { formatId: string }) => p.formatId)).toEqual(["instagram.post", "instagram.story"]);
    // A Motion pass on the story only (it has video limits; the post doesn't), within its length.
    expect(r.tasks.map((t: { title: string }) => t.title)).toEqual(["Frame: Liq Humus — Instagram post v1", "Picture: Liq Humus — Instagram post v1", "Frame: Liq Humus — Instagram story v1", "Picture: Liq Humus — Instagram story v1", "Animate: Liq Humus — Instagram story v1", "Review: Liq Humus"]);
    expect(r.next).toContain("set_post");
    const [done] = await f.queue.wait([r.reviewTaskId], 5000);
    await settle();
    expect(done).toMatchObject({ state: "done", summary: "2 posts ready for review", nodeIds: r.posts.map((p: { nodeId: string }) => p.nodeId) });
    // The workers draw in the posts made for them, with Social's line; the story's safe area is named.
    const story = r.posts[1].nodeId;
    const prompt = f.workerPrompts.find((p) => p.includes(`(${story})`) && p.includes("Finish one social post"))!;
    expect(prompt).toContain(SOCIAL_WORKER_LINE);
    expect(prompt).toContain("269 px at the top, 672 px at the bottom");
    expect(f.workerPrompts.find((p) => p.includes("Animate the post"))).toContain("duration: 6");
    // Each picture went into its post's Picture layer.
    for (const p of r.posts) expect(f.nodes.get(f.nodes.get(p.nodeId)!.children[0])!.fill).toBe("AQID");
  });

  it("a template that can't be applied yet: the posts are drawn instead, and the answer says so; one that can: fill_slots takes the words and the picture", async () => {
    const f = fakeEnv({ social: true });
    const r = json(await runManagerTool(f.env, "make_posts", { brand: "b1", products: ["p1"], formats: ["instagram.square"], variations: 1, template: "tpl-1" }));
    expect(r.template).toContain("not used");
    expect(f.tools.filter((x) => x.name === "new_post")).toHaveLength(2);
    const t = fakeEnv({ social: true, templates: true });
    const r2 = json(await runManagerTool(t.env, "make_posts", { brand: "b1", products: ["p1"], formats: ["instagram.square"], variations: 1, template: "tpl-1" }));
    expect(r2.template).toBe("tpl-1");
    expect(t.tools.filter((x) => x.name === "new_post")[0].args.templateKey).toBe("tpl-1");
    await t.queue.wait([r2.reviewTaskId], 5000);
    await settle();
    expect(t.workerPrompts[0]).toContain("fill_slots");
    expect(t.tools.find((x) => x.name === "fill_slots")!.args).toMatchObject({ nodeId: r2.posts[0].nodeId, picture: { data: "AQID", scaleMode: "FILL" } });
  });

  it("report_review on posts: the problems become pins; Fix selected hands back the caption as the manager's own, starts the relayout and unpins it when done; Leave as is unpins all", async () => {
    const f = fakeEnv({ social: true });
    const made = json(await runManagerTool(f.env, "make_posts", { brand: "b1", products: ["p1"], formats: ["instagram.story"], variations: 1 }));
    await f.queue.wait([made.reviewTaskId], 5000);
    await settle();
    const post = made.posts[0].nodeId;
    f.problems.set(post, [{ id: "check:caption:count", kind: "caption", detail: "too long", fix: "rewrite", source: "check" }]);
    const report = { briefId: made.briefId, items: [{ nodeId: post, ok: false, problems: [{ id: "s", kind: "safe-area", detail: "CTA in the bottom band", box: { x: 10, y: 1700, width: 200, height: 60 } }, { id: "c", kind: "caption", detail: "Caption too long" }, { id: "v", kind: "video", detail: "70 s" }] }] };
    const call = runManagerTool(f.env, "report_review", { report });
    await settle();
    // Pins: the review's beside the check's.
    expect(f.problems.get(post)!.map((p) => [p.id, p.source, p.fix])).toEqual([["check:caption:count", "check", "rewrite"], ["s", "review", "relayout"], ["c", "review", "rewrite"], ["v", "review", "retime"]]);
    f.answers.at(-1)!({ fix: ["s", "c"] });
    const r = json(await call);
    expect(r.yours.map((y: { id: string; fix: string }) => [y.id, y.fix])).toEqual([["c", "rewrite"]]);
    expect(r.next).toContain("set_post");
    expect(r.tasks.map((t: { title: string; nodeId: string }) => [t.title, t.nodeId])).toEqual([["Relayout: Liq Humus — Instagram story v1", post]]);
    // The one left (v) and the manager's own (c) leave at once; the relayout's (s) when its task is done.
    await f.queue.wait([r.tasks[0].taskId], 5000);
    await settle();
    expect(f.problems.get(post)!.map((p) => p.id)).toEqual(["check:caption:count"]);
    const leave = runManagerTool(f.env, "report_review", { report });
    await settle();
    expect(f.problems.get(post)!).toHaveLength(4);
    f.answers.at(-1)!({ cancelled: true });
    await leave;
    expect(f.problems.get(post)!.map((p) => p.id)).toEqual(["check:caption:count"]);
  });

  it("follow-ups: ask_choice {suggestions} shows at most three chips and returns at once; make_brand_library isn't available until round 18b", async () => {
    const f = fakeEnv({ social: true });
    const r = json(await runManagerTool(f.env, "ask_choice", { question: "Next?", suggestions: true, options: ["a", "b", "c", "d"].map((id) => ({ id, label: `Option ${id}` })) }));
    expect(r.shown).toEqual(["Option a", "Option b", "Option c"]);
    expect(f.suggested[0]).toMatchObject({ kind: "choice", suggestions: true, options: [{ id: "a" }, { id: "b" }, { id: "c" }] });
    expect(f.cards).toEqual([]);
    const lib = await runManagerTool(f.env, "make_brand_library", {});
    expect(lib.isError).toBe(true);
    expect(json(lib)).toContain("isn't available yet");
    const withLib = fakeEnv({ social: true });
    withLib.env.brandLibrary = async () => ({ fileKey: "file-brands", brands: ["b1"] });
    expect(json(await runManagerTool(withLib.env, "make_brand_library", {}))).toMatchObject({ fileKey: "file-brands", brands: ["b1"] });
  });

  it("cleanReport keeps Social's kinds with their fixes (§7.3)", () => {
    const r = cleanReport({ items: [{ nodeId: "1:2", problems: ["safe-area", "caption", "contrast", "logo", "video"].map((kind, i) => ({ id: `p${i}`, kind })) }] });
    expect(r.items[0].problems.map((p) => p.fix)).toEqual(["relayout", "rewrite", "relayout", "relayout", "retime"]);
  });
});
