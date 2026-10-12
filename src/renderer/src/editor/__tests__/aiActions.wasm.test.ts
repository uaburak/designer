// @vitest-environment happy-dom
// Round 6a: the AI actions on the real engine with a fake `ai` API (scripted JSON answers) — each action's input
// selection and schema, the apply as one undo step of the user's history, cancel mid-run, bad-output, over-limit,
// Rename layers' rules, First Draft building a frame from a kit, and every run in the ledger.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { fonts } from "@/engine/fonts";
import { Engine } from "@/engine/Engine";
import { EngineStore } from "@/engine/EngineStore";
import { loadEngine } from "@/engine/loadEngine";
import { SAMPLE_DOCUMENT } from "@/engine/sampleDocument";
import { DEFAULT_AI_SETTINGS, type AiErrorCode, type AiRunEvent, type AiRunEventMsg, type AiRunRequest, type AiUsageEntry } from "@shared/ai/types";
import { INTERACTIONS_SCHEMA, RENAME_SCHEMA, TEXTS_SCHEMA } from "@shared/ai/schemas";
import { SYSTEM_PREFIX } from "@shared/ai/prompts";
import { EditorController } from "../controller";
import { memoryDocumentSource } from "../documentSource";
import { runTool, type ToolEnv } from "../agents/mcpTools";
import { AgentTurns } from "../agents/turns";
import { setAiBackend, type AiActions } from "../ai/service";
import { liveInteractions, type PrototypeInteraction } from "../model/prototype";

const wasm = join(process.cwd(), "src/renderer/src/engine/wasm/engine.wasm");

beforeAll(async () => {
  globalThis.fetch = async () => new Response(null, { status: 404 });
  const bytes = readFileSync(wasm);
  await loadEngine({ wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), printErr: () => {} });
  // No font files here: nothing counts as missing unless a test says so.
  vi.spyOn(fonts, "missing").mockReturnValue([]);
});

type Answer = { json: unknown; usage?: { input: number; output: number; credits?: number; providerId?: string; model?: string } } | { error: { code: AiErrorCode; message: string } } | "hang";

/** A fake main: each run answers with `script(request)` a tick later (or never: "hang", until cancelled). */
function fakeAi(script: (req: AiRunRequest) => Answer) {
  const listeners = new Set<(m: AiRunEventMsg) => void>();
  const requests: AiRunRequest[] = [];
  const cancelled: string[] = [];
  const emit = (runId: string, event: AiRunEvent) => listeners.forEach((l) => l({ runId, event }));
  const api = {
    onEvent(cb: (m: AiRunEventMsg) => void) {
      listeners.add(cb);
      return () => void listeners.delete(cb);
    },
    async run(req: AiRunRequest) {
      requests.push(req);
      const a = script(req);
      if (a === "hang") return;
      setTimeout(() => {
        emit(req.runId, { type: "status", text: "Thinking" });
        if ("error" in a) {
          emit(req.runId, { type: "error", code: a.error.code, message: a.error.message });
        } else {
          const u = a.usage ?? { input: 1200, output: 300 };
          emit(req.runId, { type: "usage", usage: { ...u, images: 0, credits: u.credits ?? 1 } });
          emit(req.runId, { type: "result", text: JSON.stringify(a.json), json: a.json });
        }
        emit(req.runId, { type: "done" });
      }, 1);
    },
    async cancel(runId: string) {
      cancelled.push(runId);
      setTimeout(() => emit(runId, { type: "done", cancelled: true }), 1);
    },
    async settings() {
      return { ...DEFAULT_AI_SETTINGS, text: { providerId: "claude-code", model: "sonnet" } };
    },
  };
  return { api, requests, cancelled };
}

async function editor(script: (req: AiRunRequest) => Answer) {
  const source = memoryDocumentSource(SAMPLE_DOCUMENT, { fileName: "AI actions" });
  const engine = await Engine.create(null, { sessionID: 1 });
  engine.load(await source.load());
  engine.setViewport(1280, 800, 1, 1280, 800);
  const ed = new EditorController(engine, new EngineStore(engine), source);
  const turns = new AgentTurns(ed);
  const env: ToolEnv = { ed, write: (_l, fn, refs) => turns.write(null, "Test", fn, refs) };
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await runTool(env, name, args);
    const text = r.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    expect(r.isError, text).toBeFalsy();
    return JSON.parse(text);
  };
  const fake = fakeAi(script);
  const ledger: Omit<AiUsageEntry, "id" | "at">[] = [];
  const ai: AiActions = setAiBackend(ed, { api: fake.api, record: async (e) => ledger.push(e), policy: async () => ({ disabled: false, limit: null }) });
  await ai.refresh();
  return { ed, engine, call, ai, ledger, ...fake };
}

const name = (engine: Engine, id: string) => engine.readNode(id, { fields: ["name"] })?.name;
const chars = (engine: Engine, id: string) => (engine.readNode(id, { fields: ["textData"] }) as { textData?: { characters?: string } } | null)?.textData?.characters;
/** Children in the order they were made (an auto layout's flow order) */
const kids = (engine: Engine, id: string) => [...(engine.readNode(id, { childIds: true })?.childIds ?? [])];
/** The ids a request's outline marks with `mark`. */
const marked = (req: AiRunRequest, mark: string) => [...req.prompt.matchAll(new RegExp(`^\\s*(\\S+) .*\\[${mark.replace(/[?]/g, "\\?")}\\]$`, "gm"))].map((m) => m[1]);

/** Two screens that repeat: Frame 1 (a default-named card frame, a text, a renamed "Header", a hidden frame, an ellipse) and its duplicate. */
async function screens(t: Awaited<ReturnType<typeof editor>>) {
  const screen = (x: number) => ({
    type: "FRAME",
    name: "Frame 1",
    x,
    y: 0,
    width: 390,
    height: 800,
    children: [
      { type: "FRAME", name: "Frame 7", x: 0, y: 0, width: 390, height: 80, children: [{ type: "TEXT", characters: "Welcome back" }] },
      { type: "FRAME", name: "Header", x: 0, y: 100, width: 390, height: 60 },
      { type: "FRAME", name: "Frame 9", x: 0, y: 200, width: 100, height: 60, visible: false, children: [{ type: "TEXT", characters: "Hidden" }] },
      { type: "ELLIPSE", name: "Ellipse 1", x: 0, y: 300, width: 40, height: 40 },
      { type: "RECTANGLE", name: "Rectangle 4", x: 0, y: 400, width: 40, height: 40 },
    ],
  });
  const created = (await t.call("create_nodes", { nodes: [screen(3000), screen(3500)] })).created as { id: string }[];
  return created.map((c) => c.id);
}

describe("Rename layers", () => {
  it("asks only about default-named layers, one per matching place, and applies the names as one undo step (free)", async () => {
    const t = await editor((req) => ({ json: { names: [...marked(req, "rename").map((id, i) => ({ id, name: ["Login screen", "Greeting", "Welcome title"][i] ?? `Layer ${i}` })), { id: "999:999", name: "Ignored" }] }, usage: { input: 900, output: 80, credits: 0 } }));
    const [a, b] = await screens(t);
    t.engine.setSelection([a, b]);
    const [cardA, headerA, hiddenA, ellipseA, rectA] = kids(t.engine, a);
    const [cardB] = kids(t.engine, b);
    const textA = kids(t.engine, cardA)[0];
    const textB = kids(t.engine, cardB)[0];

    const count = await t.ai.renameLayers();
    expect(t.requests).toHaveLength(1);
    const req = t.requests[0];
    expect(req.action).toBe("rename-layers");
    expect(req.schema).toEqual(RENAME_SCHEMA);
    expect(req.system.startsWith(SYSTEM_PREFIX)).toBe(true);
    // Each top-level frame is its own screen; their card and text match across the two: asked once.
    const asked = marked(req, "rename");
    expect(asked).toEqual(expect.arrayContaining([a, b, cardA, textA]));
    expect(asked).not.toContain(cardB);
    expect(asked).not.toContain(textB);
    for (const skipped of [headerA, hiddenA, ellipseA, rectA]) expect(asked).not.toContain(skipped);
    expect(count).toBeGreaterThanOrEqual(5);
    expect(name(t.engine, cardB)).toBe(name(t.engine, cardA));
    expect(name(t.engine, textB)).toBe(name(t.engine, textA));
    expect(name(t.engine, headerA)).toBe("Header");
    expect(name(t.engine, rectA)).toBe("Rectangle 4");
    expect(t.ai.get().error).toBeNull();

    // One step of the user's history.
    expect(t.ed.store.undo.canUndo).toBe(true);
    t.engine.undo();
    expect(name(t.engine, a)).toBe("Frame 1");
    expect(name(t.engine, cardA)).toBe("Frame 7");
    expect(name(t.engine, cardB)).toBe("Frame 7");
    expect(t.ledger).toEqual([expect.objectContaining({ action: "rename-layers", credits: 0, ok: true, providerId: "claude-code", model: "sonnet", orgId: null })]);
  });

  it("with nothing to rename asks nothing; Rename anyway renames renamed layers", async () => {
    const t = await editor((req) => ({ json: { names: marked(req, "rename").map((id) => ({ id, name: "Renamed" })) } }));
    const header = (await t.call("create_nodes", { nodes: [{ type: "FRAME", name: "Header", x: 3000, y: 0, width: 200, height: 100 }] })).created[0].id;
    expect(await t.ai.renameLayers({ refs: [header] })).toBe(0);
    expect(t.requests).toHaveLength(0);
    expect(await t.ai.renameLayers({ refs: [header], anyway: true })).toBe(1);
    expect(name(t.engine, header)).toBe("Renamed");
  });
});

describe("Text actions", () => {
  it("Rewrite this… sends the selected texts and replaces their characters in one step", async () => {
    const t = await editor((req) => ({ json: { texts: [...req.prompt.matchAll(/^(\d+:\d+): "(.*)"$/gm)].map((m) => ({ id: m[1], characters: m[2].toUpperCase() })) } }));
    const frame = (await t.call("create_nodes", { nodes: [{ type: "FRAME", name: "Card", x: 3000, y: 0, width: 300, height: 200, children: [{ type: "TEXT", characters: "Hello there" }, { type: "TEXT", characters: "Second line" }, { type: "TEXT", characters: "Locked", locked: true }] }] })).created[0].id;
    const [one, two, locked] = kids(t.engine, frame);
    t.engine.setSelection([frame]);
    expect(await t.ai.editTexts({ kind: "rewrite", prompt: "Shout it" })).toBe(2);
    const req = t.requests[0];
    expect(req.action).toBe("rewrite");
    expect(req.schema).toEqual(TEXTS_SCHEMA);
    expect(req.system).toContain("Shout it");
    // The locked text is context only: not among the texts to change.
    expect(req.prompt.split("Where they are")[0]).not.toContain(locked);
    expect(chars(t.engine, one)).toBe("HELLO THERE");
    expect(chars(t.engine, two)).toBe("SECOND LINE");
    t.engine.undo();
    expect(chars(t.engine, one)).toBe("Hello there");
    expect(chars(t.engine, two)).toBe("Second line");
    expect(t.ledger[0]).toMatchObject({ action: "rewrite", input: 1200, output: 300, credits: 1, ok: true });
  });

  it("Stop mid-run cancels: nothing written, no error, the run still recorded", async () => {
    const t = await editor(() => "hang");
    const text = (await t.call("create_nodes", { nodes: [{ type: "TEXT", characters: "Keep me", x: 3000, y: 0 }] })).created[0].id;
    t.engine.setSelection([text]);
    const run = t.ai.editTexts({ kind: "shorten" });
    await new Promise((r) => setTimeout(r, 5));
    expect(t.ai.get().run?.action).toBe("shorten");
    t.ai.stop();
    expect(await run).toBeNull();
    expect(t.cancelled).toHaveLength(1);
    expect(t.ai.get().run).toBeNull();
    expect(t.ai.get().error).toBeNull();
    expect(chars(t.engine, text)).toBe("Keep me");
    expect(t.ledger[0]).toMatchObject({ action: "shorten", ok: false, credits: 0 });
  });

  it("bad-output and over-limit become Figma-style errors; an answer of the wrong shape is bad-output", async () => {
    let answer: Answer = { error: { code: "bad-output", message: "The answer didn't match the schema." } };
    const t = await editor(() => answer);
    const text = (await t.call("create_nodes", { nodes: [{ type: "TEXT", characters: "Hola", x: 3000, y: 0 }] })).created[0].id;
    t.engine.setSelection([text]);
    expect(await t.ai.editTexts({ kind: "translate", language: "English" }, { fromPanel: true })).toBeNull();
    expect(t.ai.get().error).toMatchObject({ action: "translate", code: "bad-output", message: "Something went wrong. Try again." });
    expect(t.requests[0].system).toContain("English");

    answer = { json: { nope: true } };
    await t.ai.editTexts({ kind: "translate", language: "English" }, { fromPanel: true });
    expect(t.ai.get().error?.code).toBe("bad-output");

    answer = { error: { code: "over-limit", message: "You've used all 4,250 AI credits for this month. They reset on November 1." } };
    await t.ai.editTexts({ kind: "translate", language: "English" }, { fromPanel: true });
    expect(t.ai.get().error).toMatchObject({ code: "over-limit", message: "You've used all 4,250 AI credits for this month. They reset on November 1." });
    expect(chars(t.engine, text)).toBe("Hola");
    expect(t.ed.store.undo.canUndo).toBe(true); // only the test's own create
  });

  it("refuses texts whose fonts are missing (Figma's missing fonts rule) without asking", async () => {
    const t = await editor(() => ({ json: { texts: [] } }));
    const text = (await t.call("create_nodes", { nodes: [{ type: "TEXT", characters: "Hi", x: 3000, y: 0 }] })).created[0].id;
    t.engine.setSelection([text]);
    vi.mocked(fonts.missing).mockReturnValueOnce([{ family: "Inter", style: "Regular" }]);
    expect(await t.ai.editTexts({ kind: "shorten" }, { fromPanel: true })).toBeNull();
    expect(t.ai.get().error?.code).toBe("missing-fonts");
    expect(t.requests).toHaveLength(0);
  });

  it("Replace content marks repeated rows as groups whose texts must differ", async () => {
    let same = true;
    const t = await editor((req) => {
      const ids = [...req.prompt.matchAll(/^(\d+:\d+): /gm)].map((m) => m[1]);
      return { json: { texts: ids.map((id, i) => ({ id, characters: same ? "Same" : `Person ${i}` })) } };
    });
    const row = (n: number) => ({ type: "FRAME", name: "Row", x: 0, y: n * 50, width: 300, height: 40, children: [{ type: "TEXT", name: "Name", characters: "Lorem ipsum" }] });
    const list = (await t.call("create_nodes", { nodes: [{ type: "FRAME", name: "List", x: 3000, y: 0, width: 300, height: 200, children: [row(0), row(1), row(2)] }] })).created[0].id;
    t.engine.setSelection([list]);
    expect(await t.ai.replaceContent("", { fromPanel: true })).toBeNull();
    expect(t.ai.get().error?.code).toBe("bad-output");
    expect(t.requests[0].prompt).toContain("Groups (must differ)");
    same = false;
    expect(await t.ai.replaceContent("people")).toBe(3);
    const values = kids(t.engine, list).map((r) => chars(t.engine, kids(t.engine, r)[0]));
    expect(new Set(values).size).toBe(3);
  });
});

describe("Add interactions", () => {
  it("connects the selected frames from the answer (NAVIGATE / BACK), one step, 20 credits, the banner", async () => {
    let ids: { button: string; back: string; a: string; b: string } | null = null;
    const t = await editor(() => ({ json: { interactions: [{ sourceId: ids!.button, trigger: "ON_CLICK", action: "NAVIGATE", destinationId: ids!.b }, { sourceId: ids!.back, trigger: "ON_CLICK", action: "BACK" }, { sourceId: ids!.button, trigger: "ON_CLICK", action: "NAVIGATE", destinationId: ids!.a }] }, usage: { input: 2000, output: 200, credits: 20, providerId: "antigravity", model: "gemini-3-pro" } }));
    const made = (await t.call("create_nodes", {
      nodes: [
        { type: "FRAME", name: "Home", x: 3000, y: 0, width: 390, height: 800, children: [{ type: "FRAME", name: "Sign up button", x: 20, y: 700, width: 200, height: 48, children: [{ type: "TEXT", characters: "Sign up" }] }] },
        { type: "FRAME", name: "Sign up", x: 3500, y: 0, width: 390, height: 800, children: [{ type: "TEXT", name: "Back", characters: "‹ Back", x: 16, y: 16 }] },
      ],
    })).created as { id: string }[];
    const [a, b] = made.map((m) => m.id);
    ids = { a, b, button: kids(t.engine, a)[0], back: kids(t.engine, b)[0] };
    t.engine.setSelection([a, b]);
    expect(await t.ai.addInteractions()).toBe(2);
    const req = t.requests[0];
    expect(req.schema).toEqual(INTERACTIONS_SCHEMA);
    expect(marked(req, "button?")).toContain(ids.button);
    const live = (id: string) => liveInteractions((t.engine.readNode(id) as { prototypeInteractions?: PrototypeInteraction[] } | null)?.prototypeInteractions);
    expect(live(ids.button)).toHaveLength(1);
    expect(live(ids.button)[0].actions?.[0]).toMatchObject({ navigationType: "NAVIGATE" });
    expect(live(ids.back)[0].actions?.[0]).toMatchObject({ connectionType: "BACK" });
    expect(t.ai.get().banner).toEqual({ kind: "interactions", count: 2, start: a });
    // The provider main says answered, not Settings › AI's route (with "Automatic" that was "auto" — found running it for real).
    expect(t.ledger[0]).toMatchObject({ action: "add-interactions", credits: 20, providerId: "antigravity", model: "gemini-3-pro" });
    // ✕ on the banner undoes the step.
    t.ai.closeBanner(true);
    expect(live(ids.button)).toHaveLength(0);
    expect(live(ids.back)).toHaveLength(0);
  });

  it("needs two top-level frames", async () => {
    const t = await editor(() => ({ json: { interactions: [] } }));
    const a = (await t.call("create_nodes", { nodes: [{ type: "FRAME", name: "Only", x: 3000, y: 0, width: 100, height: 100 }] })).created[0].id;
    t.engine.setSelection([a]);
    expect(await t.ai.addInteractions({ fromPanel: true })).toBeNull();
    expect(t.ai.get().error).toMatchObject({ code: "nothing-selected", message: "Select two or more top-level frames to connect." });
    expect(t.requests).toHaveLength(0);
  });
});

describe("First Draft", () => {
  const plan = { name: "Meditation sign up", platform: "app", blocks: [{ block: "status-bar", props: {} }, { block: "top-bar", props: { title: "Create account" } }, { block: "form-fields", props: { fields: ["Name", "Email"], placeholders: ["Jane", "jane@example.com"] } }, { block: "buttons", props: { primary: "Sign up" } }, { block: "not-a-block", props: {} }] };

  it("builds one frame from the kit (390 wide for an app) as one step; a theme replaces it in one more step", async () => {
    const t = await editor(() => ({ json: plan }));
    const frame = await t.ai.firstDraft("A sign up screen for a meditation app", "app-design");
    expect(frame).toBeTruthy();
    const req = t.requests[0];
    expect(req.action).toBe("first-draft");
    expect(JSON.stringify(req.schema)).toContain("checkout-summary");
    expect(req.system).toContain("form-fields");
    const n = t.engine.readNode(frame!, { childIds: true, fields: ["name", "size", "stackMode"] })!;
    expect(n.name).toBe("Meditation sign up");
    expect(n.size?.x).toBe(390);
    expect(kids(t.engine, frame!).map((id) => name(t.engine, id))).toEqual(["Status bar", "Top bar", "Form", "Buttons"]);
    expect(t.ed.selection).toEqual([frame]);
    expect(t.ai.get().draft).toMatchObject({ kit: "app-design", theme: "indigo", frame });

    const fill = (id: string) => JSON.stringify((t.engine.readNode(id, { fields: ["fillPaints"] }) as { fillPaints?: unknown }).fillPaints);
    const page = t.ed.store.page;
    const before = kids(t.engine, page).length;
    const light = fill(frame!);
    const restyled = t.ai.restyleDraft({ style: { mode: "dark" } })!;
    expect(restyled).not.toBe(frame);
    expect(t.engine.readNode(frame!, { fields: ["name"] })).toBeNull();
    expect(kids(t.engine, page).length).toBe(before);
    expect(fill(restyled)).not.toBe(light);
    t.engine.undo();
    expect(t.engine.readNode(frame!, { fields: ["name"] })?.name).toBe("Meditation sign up");
    t.engine.undo();
    expect(t.engine.readNode(frame!, { fields: ["name"] })).toBeNull();
    // Closing Actions ends the session.
    t.ai.panelClosed();
    expect(t.ai.get().draft).toBeNull();
  });
});
