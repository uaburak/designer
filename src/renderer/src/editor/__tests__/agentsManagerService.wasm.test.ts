// @vitest-environment happy-dom
// The manager in the Agents tab (docs/studio.md §2) on the real engine, main a stand-in: with the manager on, a message
// is the manager's turn (its instructions, its tools); its tool calls are answered here, a worker's are refused; a
// worker task is a turn of its own beside it; a card's answer resolves the waiting call; Stop stops its tasks. Off,
// the chat talks to the picked agent as before.
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
