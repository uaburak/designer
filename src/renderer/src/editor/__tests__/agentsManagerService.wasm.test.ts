// @vitest-environment happy-dom
// The manager in the Agents tab (docs/studio.md §2) on the real engine, main a stand-in: with the manager on, a message
// is the manager's turn (its instructions, its tools); its tool calls are answered here, a worker's are refused; a
// worker task is a turn of its own beside it, and its card runs it again with the prompt edited; a card's answer resolves the waiting call; Stop stops its tasks. Off,
// the chat talks to the picked agent as before. In Social (docs/social.md §7, round 18c) every turn is the manager's,
// with the board in its instructions; its Social tools, a post's Fix and the follow-up chips; and (the leftovers) the
// composer's direct turns in Social, Fix without a model or as a worker's relayout task, Make starter templates.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { Engine } from "@/engine/Engine";
import { EngineStore } from "@/engine/EngineStore";
import { loadEngine } from "@/engine/loadEngine";
import { SAMPLE_DOCUMENT } from "@/engine/sampleDocument";
import type { ToolResult } from "@shared/agents/tools";
import type { AgentSettings, AgentsApi, ToolCall, TurnEvent, TurnRequest } from "@shared/agents/types";
import { DEFAULT_MANAGER_SETTINGS, brandsUnavailable } from "@shared/studio/types";
import { EditorController } from "../controller";
import { memoryDocumentSource } from "../documentSource";
import { AgentsService } from "../agents/service";
import { applyChecks, checkPost, editorWriter, fixProblem, newCampaign, newPost, setCampaign } from "../social/actions";
import { createNodes } from "../agents/mcpTools";
import { readPost, writePost } from "../social/posts";
import { fixWithAgent, makeStarterTemplates } from "../social/SocialMode";
import { STARTER_BRIEF } from "@shared/social/managerPrompt";

const wasm = join(process.cwd(), "src/renderer/src/engine/wasm/engine.wasm");

beforeAll(async () => {
  globalThis.fetch = async () => new Response(null, { status: 404 });
  const bytes = readFileSync(wasm);
  await loadEngine({ wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), printErr: () => {} });
});

async function setup(managerOn: boolean) {
  const source = memoryDocumentSource(SAMPLE_DOCUMENT, { fileName: "Manager test" });
  const engine = await Engine.create(null, { sessionID: 1 });
  engine.load(await source.load());
  engine.setViewport(1280, 800, 1, 1280, 800);
  const ed = new EditorController(engine, new EngineStore(engine), source);
  let emit: (e: TurnEvent) => void = () => {};
  let tool: (c: ToolCall) => Promise<ToolResult> = async () => ({ content: [] });
  const turns: (TurnRequest & { turnId: string })[] = [];
  const stopped: string[] = [];
  const settings: AgentSettings = { providerId: "codex", models: {}, custom: [], manager: { ...DEFAULT_MANAGER_SETTINGS, enabled: managerOn } };
  const api = {
    providers: async () => [
      { id: "claude-code", kind: "claude-code", label: "Claude Code", available: true, models: ["default", "sonnet"], efforts: ["high", "low"] },
      { id: "codex", kind: "codex", label: "Codex", available: true, models: ["default"] },
    ],
    settings: async () => settings,
    setSettings: async (p: Partial<AgentSettings>) => Object.assign(settings, p),
    mcp: async () => ({ running: false, url: null, connections: [] }),
    onEvent: (cb: typeof emit) => ((emit = cb), () => {}),
    onToolCall: (h: typeof tool) => ((tool = h), () => {}),
    onMcpState: () => () => {},
    turn: async (r: TurnRequest) => {
      const turnId = `T${turns.length + 1}`;
      turns.push({ ...r, turnId });
      return { turnId };
    },
    stop: async (id: string) => void stopped.push(id),
    usage: async () => null,
    attach: async () => ({ attachments: [], errors: [] }),
  } as unknown as AgentsApi;
  const s = new AgentsService(ed, api, { brands: brandsUnavailable, imageRoutes: async () => [], record: () => {} });
  await s.refreshProviders();
  return { s, ed, turns, stopped, emit: (e: TurnEvent) => emit(e), tool: (c: ToolCall) => tool(c) };
}

const text = (r: ToolResult) => (r.content[0]?.type === "text" ? r.content[0].text : "");
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("the manager in a chat", () => {
  it("off: the picked agent answers as before (no role, no manager tools)", async () => {
    const { s, turns } = await setup(false);
    await s.send("Make the mobile version");
    expect(turns[0]).toMatchObject({ providerId: "codex", prompt: "Make the mobile version" });
    expect(turns[0].role).toBeUndefined();
    expect(turns[0].managerTools).toBeUndefined();
  });

  it("on: the manager's turn (its agent, model, effort, instructions and tools); a worker's turn beside it; manager tools refused for the worker", async () => {
    const { s, turns, emit, tool } = await setup(true);
    await s.send("Partner Agro'nun Liq Humus'u için bir post");
    const m = turns[0];
    expect(m).toMatchObject({ providerId: "claude-code", model: "claude-haiku-5-5", effort: "low", role: "manager" });
    expect(m.prompt).toMatch(/You are the MANAGER/);
    expect(m.prompt).toMatch(/Partner Agro'nun Liq Humus'u için bir post$/);
    expect(m.managerTools!.map((t) => t.name)).toEqual(expect.arrayContaining(["delegate_task", "wait_tasks", "make_posts", "review", "report_review"]));
    const chatId = s.currentChat()!.id;
    expect(s.currentChat()!.messages[1]).toMatchObject({ manager: true, provider: "Manager" });

    // The manager hands out a task: a worker's turn starts at once, the manager's still running.
    const d = JSON.parse(text(await tool({ reqId: 1, turnId: "T1", client: "Claude Code", name: "delegate_task", args: { title: "Rename layers", prompt: "Rename the card's layers" } })));
    await tick();
    await tick();
    expect(turns[1]).toMatchObject({ providerId: "claude-code", model: "claude-sonnet-5-5", role: "worker", chatId });
    expect(turns[1].prompt).toContain("Rename the card's layers");
    expect(s.get().running[chatId]).toBe("T1");
    // The worker can't use the manager's tools.
    const refused = await tool({ reqId: 2, turnId: "T2", client: "Claude Code", name: "delegate_task", args: { title: "x", prompt: "y" } });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toMatch(/manager's tool/);
    // Its steps and words go to its task card; its end ends the task with its last words.
    emit({ turnId: "T2", chatId, event: { type: "tool", id: "u", name: "update_nodes", state: "done" } });
    emit({ turnId: "T2", chatId, event: { type: "text", delta: "Renamed 4 layers." } });
    emit({ turnId: "T2", chatId, event: { type: "usage", usage: { input: 4000, output: 1000 } } });
    emit({ turnId: "T2", chatId, event: { type: "done" } });
    const waited = JSON.parse(text(await tool({ reqId: 3, turnId: "T1", client: "Claude Code", name: "wait_tasks", args: { taskIds: [d.taskId] } })));
    expect(waited.tasks[0]).toMatchObject({ state: "done", summary: "Renamed 4 layers." });
    const card = s.currentChat()!.tasks![0];
    expect(card).toMatchObject({ title: "Rename layers", state: "done", credits: 2, worker: { state: "done" } });
    expect(card.worker!.parts.map((p) => p.kind)).toEqual(["tool", "text"]);
  });

  it("a task card's Run again (docs/studio.md §5.2): only once it has ended, a worker's turn with the edited prompt, its card in the same answer", async () => {
    const { s, turns, emit, tool } = await setup(true);
    await s.send("Rename the layers");
    const chatId = s.currentChat()!.id;
    const d = JSON.parse(text(await tool({ reqId: 1, turnId: "T1", client: "Claude Code", name: "delegate_task", args: { title: "Rename layers", prompt: "Rename the card's layers" } })));
    await tick();
    await tick();
    expect(await s.runTaskAgain(d.taskId, "Rename only the texts")).toBe("This task can't run again.");
    emit({ turnId: "T2", chatId, event: { type: "done" } });
    await tick();
    expect(s.currentChat()!.tasks![0]).toMatchObject({ state: "done", prompt: "Rename the card's layers", again: { kind: "worker" } });
    expect(await s.runTaskAgain(d.taskId, "Rename only the texts")).toBeNull();
    await tick();
    await tick();
    expect(turns[2]).toMatchObject({ role: "worker", chatId });
    expect(turns[2].prompt).toMatch(/Rename only the texts$/);
    const tasks = s.currentChat()!.tasks!;
    expect(tasks.map((x) => [x.title, x.messageId, x.state])).toEqual([
      ["Rename layers", tasks[0].messageId, "done"],
      ["Rename layers", tasks[0].messageId, "running"],
    ]);
  });

  it("a choice card's click resolves the manager's waiting call; Stop on the manager stops its tasks and ends its cards", async () => {
    const { s, turns, stopped, tool } = await setup(true);
    await s.send("Labels?");
    const chatId = s.currentChat()!.id;
    const asked = tool({ reqId: 1, turnId: "T1", client: "Claude Code", name: "ask_choice", args: { question: "Labels right?", options: [{ id: "ok", label: "Looks right" }, { id: "edit", label: "Edit" }] } });
    await tick();
    const card = s.currentChat()!.messages[1].cards![0];
    expect(card).toMatchObject({ kind: "choice", question: "Labels right?" });
    expect(s.cardOpen(card.id)).toBe(true);
    s.answerCard(card.id, { optionId: "ok", remember: false });
    expect(JSON.parse(text(await asked))).toMatchObject({ optionId: "ok", label: "Looks right" });
    expect(s.currentChat()!.messages[1].cards![0].answer).toEqual({ optionId: "ok", remember: false });

    const d = JSON.parse(text(await tool({ reqId: 2, turnId: "T1", client: "Claude Code", name: "delegate_task", args: { title: "Long", prompt: "Something long" } })));
    await tick();
    await tick();
    const pending = tool({ reqId: 3, turnId: "T1", client: "Claude Code", name: "show_form", args: { form: "brand" } });
    await tick();
    s.stop(chatId);
    expect(text(await pending)).toBe("cancelled");
    expect(s.queue.get(d.taskId)!.state).toBe("stopped");
    expect(stopped).toEqual(expect.arrayContaining(["T1", turns[1].turnId]));
  });
});

describe("the manager in Social (docs/social.md §1.3, §7)", () => {
  it("in Social every turn is the manager's, even with the manager off, and its instructions carry the board; in Design they don't", async () => {
    const { s, ed, turns } = await setup(false);
    const post = newPost(ed, editorWriter(ed), { formatId: "instagram.story" });
    const campaign = newCampaign("Liq Humus — October", null);
    setCampaign(ed, editorWriter(ed), ed.store.page, campaign);
    ed.ui.set({ mode: "social" });
    expect(s.managerProvider()?.id).toBe("claude-code");
    await s.send("Liq Humus için bu hafta Instagram post + story, LinkedIn de olsun", s.contextOf([post]));
    expect(turns[0]).toMatchObject({ role: "manager", providerId: "claude-code" });
    expect(turns[0].prompt).toContain("[Social mode.");
    expect(turns[0].prompt).toContain("- Liq Humus — October (");
    expect(turns[0].prompt).toContain("1 post outside any campaign");
    expect(turns[0].managerTools!.map((t) => t.name)).toContain("make_brand_library");
    // The post goes as context with its format (the chip shows it too).
    expect(turns[0].context.selection[0]).toMatchObject({ id: post, format: "Instagram story" });
    // Back in Design, with the manager off: the picked agent, no Social paragraph.
    s.newChat();
    ed.ui.set({ mode: "design" });
    await s.send("Hello");
    expect(turns[1].role).toBeUndefined();
    expect(turns[1].prompt).not.toContain("Social mode");
  });

  it("the manager's Social tool calls are answered on the canvas; a worker can't call make_brand_library", async () => {
    const { s, ed, turns, tool } = await setup(true);
    ed.ui.set({ mode: "social" });
    await s.send("Make a post");
    const made = JSON.parse(text(await tool({ reqId: 1, turnId: "T1", client: "Claude Code", name: "new_post", args: { formatId: "instagram.post", campaign: "Spring" } })));
    const board = JSON.parse(text(await tool({ reqId: 2, turnId: "T1", client: "Claude Code", name: "get_board", args: {} })));
    expect(board.campaigns[0].posts[0].nodeId).toBe(made.nodeId);
    await tool({ reqId: 3, turnId: "T1", client: "Claude Code", name: "delegate_task", args: { title: "Draw", prompt: "Draw it" } });
    await tick();
    await tick();
    expect(turns[1].prompt).toContain("[Social mode: posts are top-level frames");
    const refused = await tool({ reqId: 4, turnId: "T2", client: "Claude Code", name: "make_brand_library", args: {} });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toMatch(/manager's tool/);
  });

  it("a post's Fix sends the manager that problem with the post as context; a follow-up chip is the owner's next message", async () => {
    const { s, ed, turns, emit } = await setup(false);
    ed.ui.set({ mode: "social" });
    const post = newPost(ed, editorWriter(ed), { formatId: "linkedin.landscape" });
    s.fixProblem({ id: post, name: "LinkedIn landscape" }, { kind: "caption", detail: "The caption is 3100 characters; LinkedIn landscape takes 3000.", fix: "rewrite" });
    await tick();
    expect(turns[0].prompt).toContain(`Fix on “LinkedIn landscape” (${post}): caption — The caption is 3100 characters`);
    expect(turns[0].context.selection).toEqual([expect.objectContaining({ id: post, format: "LinkedIn landscape" })]);
    // The manager suggests follow-ups as chips and ends its turn.
    const chatId = s.currentChat()!.id;
    s.managerEnv("T1", { chat: chatId, message: s.currentChat()!.messages[1].id }).suggest!({ kind: "choice", id: "card-f", question: "Next?", options: [{ id: "story", label: "Story's animated version?" }], suggestions: true });
    emit({ turnId: "T1", chatId, event: { type: "done" } });
    await tick();
    s.pickSuggestion("card-f", "story");
    await tick();
    expect(turns[1].prompt).toMatch(/Story's animated version\?$/);
    expect(s.currentChat()!.messages[1].cards![0].answer).toEqual({ optionId: "story", remember: false });
  });
});

describe("Social's leftovers (docs/social.md §17)", () => {
  it("the composer picks an agent for direct turns in Social, and the manager again", async () => {
    const { s, ed, turns, emit } = await setup(false);
    ed.ui.set({ mode: "social" });
    await s.chooseInSocial({ providerId: "claude-code", model: "sonnet" });
    expect(s.managerProvider()).toBeNull();
    await s.send("Make the headline bigger");
    expect(turns[0]).toMatchObject({ providerId: "claude-code", model: "sonnet", prompt: "Make the headline bigger" });
    expect(turns[0].role).toBeUndefined();
    emit({ turnId: turns[0].turnId, chatId: s.currentChat()!.id, event: { type: "done" } });
    await tick();
    await s.chooseInSocial(null);
    await s.send("Make a story too");
    expect(turns[1].role).toBe("manager");
    // Outside Social the pick changes nothing: the manager's setting decides.
    await s.chooseInSocial({ providerId: "codex" });
    ed.ui.set({ mode: "design" });
    expect(s.managerProvider()).toBeNull();
  });

  it("a safe-area problem is fixed without a model: the text moved inside the band, one undo step, the pin gone", async () => {
    const { ed, turns } = await setup(false);
    ed.ui.set({ mode: "social" });
    const w = editorWriter(ed);
    const post = newPost(ed, w, { formatId: "instagram.story" });
    const cta = createNodes({ ed, write: (_l, fn) => fn() }, { parentId: post, nodes: [{ type: "TEXT", name: "CTA", characters: "Order now", fontSize: 48, x: 80, y: 1800 }] }).touched![0];
    applyChecks(ed, w, post, checkPost(ed, post));
    const problem = readPost(ed, post)!.problems.find((p) => p.kind === "safe-area")!;
    expect(problem.id).toBe(`check:safe-area:${cta}`);
    fixWithAgent(ed, { id: post, name: "Story" }, problem);
    expect(ed.store.undo.undoLabel).toBe("Fix problem");
    expect(readPost(ed, post)!.problems.some((p) => p.kind === "safe-area")).toBe(false);
    const y = ed.engine.readNode(cta, { fields: ["transform", "size"] })!;
    expect(y.transform!.m12 + y.size!.y).toBeLessThanOrEqual(1920 * 0.65 + 0.5);
    expect(turns).toHaveLength(0);
    // A hidden logo is shown again.
    const logo = createNodes({ ed, write: (_l, fn) => fn() }, { parentId: post, nodes: [{ type: "RECTANGLE", name: "Logo", width: 100, height: 100, x: 400, y: 600 }] }).touched![0];
    ed.batch("Hide", () => {
      ed.engine.setProps([logo], { visible: false });
      writePost(ed, post, { ...readPost(ed, post)!, brandId: "b1" });
    });
    applyChecks(ed, w, post, checkPost(ed, post));
    const missing = readPost(ed, post)!.problems.find((p) => p.id === "check:logo:missing")!;
    expect(fixProblem(ed, w, post, missing.id)).toBe(true);
    expect(ed.engine.readNode(logo, { fields: ["visible"] })?.visible).not.toBe(false);
    expect(readPost(ed, post)!.problems).toEqual([]);
    expect(turns).toHaveLength(0);
  });

  it("more fixes without a model (docs/social.md §30): a card holding the text moved in, a text too wide narrowed, a second logo hidden, hashtags past the limit dropped, a text recoloured to read", async () => {
    const { ed, turns } = await setup(false);
    ed.ui.set({ mode: "social" });
    const w = editorWriter(ed);
    const make = (parentId: string, nodes: unknown[]) => createNodes({ ed, write: (_l, fn) => fn() }, { parentId, nodes } as never).touched!;
    const post = newPost(ed, w, { formatId: "instagram.portrait" });
    // A text in an auto-layout card at the left edge: the card moves (the text can't, its stack places it)
    const [card] = make(post, [{ type: "FRAME", name: "Card", x: 10, y: 600, width: 300, height: 100, layoutMode: "VERTICAL", children: [{ type: "TEXT", name: "Price", characters: "₺99", fontSize: 40 }] }]);
    const price = ed.engine.readNodes([card], { subtree: true, fields: ["type"] }).find((n) => n.type === "TEXT")!.guid;
    // A text wider than the safe area
    const [wide] = make(post, [{ type: "TEXT", name: "Headline", characters: "A long headline", fontSize: 60, x: 0, y: 300, width: 1080, textAutoResize: "NONE" }]);
    applyChecks(ed, w, post, checkPost(ed, post));
    const ids = readPost(ed, post)!.problems.map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining([`check:safe-area:${price}`, `check:safe-area:${wide}`]));
    expect(fixProblem(ed, w, post, `check:safe-area:${price}`)).toBe(true);
    expect(ed.engine.readNode(card, { fields: ["transform"] })!.transform!.m02).toBeCloseTo(64);
    expect(fixProblem(ed, w, post, `check:safe-area:${wide}`)).toBe(true);
    const h = ed.engine.readNode(wide, { fields: ["transform", "size"] })!;
    expect(h.transform!.m02).toBeCloseTo(64);
    expect(h.size!.x).toBeCloseTo(1080 - 128);
    expect(readPost(ed, post)!.problems.filter((p) => p.kind === "safe-area")).toEqual([]);
    // Two logos: the second hidden
    const [, copy] = make(post, [{ type: "RECTANGLE", name: "Logo", x: 200, y: 1200, width: 100, height: 100 }, { type: "RECTANGLE", name: "Logo copy", x: 600, y: 1200, width: 100, height: 100 }]);
    applyChecks(ed, w, post, checkPost(ed, post));
    expect(fixProblem(ed, w, post, "check:logo:several")).toBe(true);
    expect(ed.engine.readNode(copy, { fields: ["visible"] })?.visible).toBe(false);
    // 31 hashtags on a 30-hashtag format: the last one dropped
    ed.batch("Tags", () => writePost(ed, post, { ...readPost(ed, post)!, hashtags: Array.from({ length: 31 }, (_, i) => `t${i}`) }));
    applyChecks(ed, w, post, checkPost(ed, post));
    expect(fixProblem(ed, w, post, "check:caption:hashtags")).toBe(true);
    expect(readPost(ed, post)!.hashtags).toHaveLength(30);
    expect(readPost(ed, post)!.problems).toEqual([]);
    expect(turns).toHaveLength(0);
  });

  it("a contrast problem is fixed without a model: the text takes a colour that reads over its backdrop (docs/social.md §30)", async () => {
    const { ed } = await setup(false);
    ed.ui.set({ mode: "social" });
    const w = editorWriter(ed);
    const post = newPost(ed, w, { formatId: "instagram.portrait" });
    // Light grey on the post's white
    const [title] = createNodes({ ed, write: (_l, fn) => fn() }, { parentId: post, nodes: [{ type: "TEXT", name: "Title", characters: "Hello", fontSize: 80, x: 200, y: 400, width: 400, height: 100, textAutoResize: "NONE", fills: [{ type: "SOLID", color: "#CCCCCC" }] }] } as never).touched!;
    applyChecks(ed, w, post, checkPost(ed, post));
    const problem = readPost(ed, post)!.problems.find((p) => p.kind === "contrast");
    if (!ed.engine.renderNodeThumbnailPixels({ node: post, maxSize: 64 })) return; // an engine that can't draw has no backdrop to read
    expect(problem?.id).toBe(`check:contrast:${title}`);
    expect(fixProblem(ed, w, post, problem!.id)).toBe(true);
    const fill = (ed.engine.readNode(title, { fields: ["fillPaints"] })!.fillPaints ?? [])[0] as { color?: { r: number } };
    expect(fill.color?.r).toBe(0);
    expect(readPost(ed, post)!.problems.filter((p) => p.kind === "contrast")).toEqual([]);
  });

  it("a relayout problem nothing mechanical fixes goes to a worker's task without a manager turn; done, its pin leaves", async () => {
    const { s, ed, turns, emit } = await setup(false);
    ed.ui.set({ mode: "social" });
    const w = editorWriter(ed);
    const post = newPost(ed, w, { formatId: "instagram.story" });
    const problem = { id: "p-1", kind: "contrast" as const, detail: "“Title” has a contrast of 1.3:1.", fix: "relayout" as const, source: "review" as const };
    ed.batch("Pin", () => writePost(ed, post, { ...readPost(ed, post)!, problems: [problem] }));
    expect(fixProblem(ed, w, post, problem.id)).toBe(false);
    expect(await s.relayoutProblem({ id: post, name: "Story" }, problem)).toBe(true);
    await tick();
    await tick();
    expect(turns).toHaveLength(1);
    expect(turns[0].role).toBe("worker");
    expect(turns[0].prompt).toContain(`Fix the frame “Story” (${post}): “Title” has a contrast of 1.3:1.`);
    const chat = s.currentChat()!;
    expect(chat.messages.map((m) => [m.role, m.manager ?? false])).toEqual([["user", false], ["assistant", true]]);
    emit({ turnId: turns[0].turnId, chatId: chat.id, event: { type: "text", delta: "Moved it." } });
    emit({ turnId: turns[0].turnId, chatId: chat.id, event: { type: "done" } });
    await tick();
    await tick();
    expect(readPost(ed, post)!.problems).toEqual([]);
  });

  it("Make starter templates sends the manager its brief, the chat showing the short request", async () => {
    const { s, ed, turns } = await setup(false);
    ed.ui.set({ mode: "social" });
    await s.chooseInSocial({ providerId: "codex" });
    await makeStarterTemplates(ed, s);
    expect(turns[0].role).toBe("manager");
    expect(turns[0].prompt).toContain(STARTER_BRIEF);
    expect(s.currentChat()!.messages[0].text).toBe("Make starter templates");
    expect(ed.ui.get().socialRightTab).toBe("agent");
  });
});
