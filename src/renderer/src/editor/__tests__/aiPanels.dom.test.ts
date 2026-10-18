// @vitest-environment happy-dom
// Round 6a's chrome on the real engine: the Actions panel's AI sections (the AI badge, image rows waiting for their
// tools), a form (Rewrite this…) whose run shows progress with Stop and comes back to the form when stopped, an error
// in Figma's words with "AI balance" for over-limit; the Prototype tab's "Add interactions" for two top-level frames.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, createElement } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { Engine } from "@/engine/Engine";
import { EngineStore } from "@/engine/EngineStore";
import { loadEngine } from "@/engine/loadEngine";
import { fonts } from "@/engine/fonts";
import { mount, key } from "@/ds/__tests__/dom";
import { DEFAULT_AI_SETTINGS, type AiRunEventMsg, type AiRunRequest } from "@shared/ai/types";
import { EditorContext, EditorController } from "../controller";
import { memoryDocumentSource } from "../documentSource";
import { PROTOTYPE_DOCUMENT } from "../fixtures";
import { ActionsPanel } from "../panels/ActionsPanel";
import { PrototypePanel } from "../panels/prototype/PrototypePanel";
import { setAiBackend } from "../ai/service";
import { runTool } from "../agents/mcpTools";
import { AgentTurns } from "../agents/turns";

const wasm = resolve(process.cwd(), "src/renderer/src/engine/wasm/engine.wasm");

beforeAll(async () => {
  globalThis.fetch = (async () => new Response(null, { status: 404 })) as typeof fetch;
  const bytes = readFileSync(wasm);
  await loadEngine({ wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), printErr: () => {} });
  vi.spyOn(fonts, "missing").mockReturnValue([]);
});

async function setup(panel: "actions" | "prototype", answer: (req: AiRunRequest, emit: (m: AiRunEventMsg) => void) => void, o: { enabled?: boolean; orgDisabled?: boolean; remaining?: number } = {}) {
  const source = memoryDocumentSource(PROTOTYPE_DOCUMENT, { fileName: "AI" });
  const engine = await Engine.create(null, { sessionID: 1 });
  engine.load(await source.load());
  const ed = new EditorController(engine, new EngineStore(engine), source);
  const listeners = new Set<(m: AiRunEventMsg) => void>();
  const emit = (m: AiRunEventMsg) => listeners.forEach((l) => l(m));
  const cancelled: string[] = [];
  const ai = setAiBackend(ed, {
    api: {
      onEvent: (cb) => (listeners.add(cb), () => void listeners.delete(cb)),
      run: async (req) => answer(req, emit),
      cancel: async (runId) => {
        cancelled.push(runId);
        setTimeout(() => emit({ runId, event: { type: "done", cancelled: true } }), 1);
      },
      settings: async () => ({ ...DEFAULT_AI_SETTINGS, enabled: o.enabled ?? true }),
    },
    record: async () => {},
    policy: async () => ({ disabled: !!o.orgDisabled, limit: null }),
    balance: async () => ({ remaining: o.remaining ?? 4250, resetsAt: Date.UTC(2026, 10, 1, 12) }),
  });
  await ai.refresh();
  // A text to act on.
  const turns = new AgentTurns(ed);
  const made = await runTool({ ed, write: (_l, fn, refs) => turns.write(null, "Test", fn, refs) }, "create_nodes", { nodes: [{ type: "TEXT", characters: "Hello there", x: 3000, y: 0 }] });
  const text = JSON.parse(made.content.map((c) => (c.type === "text" ? c.text : "")).join("")).created[0].id as string;
  if (panel === "actions") ed.ui.set({ actionsOpen: true });
  const View = () => createElement(EditorContext.Provider, { value: ed }, createElement(panel === "actions" ? ActionsPanel : PrototypePanel));
  const view = mount(View, {});
  return { ed, engine, ai, view, cancelled, text };
}

const tick = () => act(() => new Promise((r) => setTimeout(r, 5)));
const panelEl = () => document.querySelector<HTMLElement>("[data-actions-panel]")!;
const rowByLabel = (label: string) => [...panelEl().querySelectorAll<HTMLElement>('[role="option"]')].find((r) => r.textContent?.startsWith(label));

describe("Actions › AI", () => {
  it("lists Image editing, Design tools and Riffing and writing with the AI badge; image rows wait for their tools", async () => {
    const { view, engine } = await setup("actions", () => {});
    const headers = [...panelEl().querySelectorAll('[role="presentation"]')].map((h) => h.textContent);
    expect(headers).toEqual(["Image editing", "Design tools", "Riffing and writing"]);
    expect(rowByLabel("Rename layers")!.querySelector('[aria-label="AI, Learn more"]')).not.toBeNull();
    expect(rowByLabel("Make an image")!.getAttribute("aria-disabled")).toBe("true");
    expect(rowByLabel("Translate to...")!.getAttribute("aria-disabled")).toBeNull();
    for (const l of ["Remove background", "Boost resolution", "Edit image with prompt", "Replace content", "Add interactions", "First Draft", "Shorten", "Rewrite this..."]) expect(rowByLabel(l), l).toBeTruthy();
    view.unmount();
    engine.destroy();
  });

  it("says why the AI rows can't run: AI turned off, an organization's switch, out of credits (only the free rows run)", async () => {
    const notice = () => panelEl().querySelector('[role="note"]')?.textContent ?? null;
    let s = await setup("actions", () => {});
    expect(notice()).toBeNull();
    s.view.unmount();
    s.engine.destroy();
    s = await setup("actions", () => {}, { enabled: false });
    await tick();
    expect(notice()).toContain("AI features are turned off");
    expect(rowByLabel("Rename layers")!.getAttribute("aria-disabled")).toBe("true");
    s.view.unmount();
    s.engine.destroy();
    s = await setup("actions", () => {}, { orgDisabled: true });
    await tick();
    expect(notice()).toContain("AI features are off for your organization");
    s.view.unmount();
    s.engine.destroy();
    s = await setup("actions", () => {}, { remaining: 0 });
    await tick();
    expect(notice()).toContain("You're out of AI credits");
    expect(notice()).toContain("November 1");
    expect(rowByLabel("Translate to...")!.getAttribute("aria-disabled")).toBe("true");
    expect(rowByLabel("Rename layers")!.getAttribute("aria-disabled")).toBeNull();
    s.view.unmount();
    s.engine.destroy();
  });

  it("Rewrite this…: the form, then progress with Stop; Stop goes back to the form, nothing written", async () => {
    const { view, engine, ai, cancelled, text } = await setup("actions", () => {});
    act(() => void engine.setSelection([text]));
    act(() => rowByLabel("Rewrite this...")!.click());
    expect(panelEl().querySelector('[data-ai-view="rewrite"]')).not.toBeNull();
    const area = panelEl().querySelector("textarea")!;
    act(() => {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      set.call(area, "More friendly");
      area.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const rewrite = [...panelEl().querySelectorAll("button")].find((b) => b.textContent === "Rewrite")!;
    act(() => rewrite.click());
    await tick();
    expect(ai.get().run?.action).toBe("rewrite");
    expect(panelEl().textContent).toContain("Rewriting…");
    const stop = [...panelEl().querySelectorAll("button")].find((b) => b.textContent === "Stop")!;
    act(() => stop.click());
    await tick();
    expect(cancelled).toHaveLength(1);
    expect(ai.get().run).toBeNull();
    expect(panelEl().querySelector('[data-ai-view="rewrite"]')).not.toBeNull();
    expect((engine.readNode(text, { fields: ["textData"] }) as { textData?: { characters?: string } }).textData?.characters).toBe("Hello there");
    // Esc leaves the form for the list.
    key(panelEl(), "Escape");
    expect(panelEl().querySelector("[data-ai-view]")).toBeNull();
    view.unmount();
    engine.destroy();
  });

  it("over-limit: Figma-style message with AI balance", async () => {
    const { view, engine, ai, text } = await setup("actions", (req, emit) => {
      setTimeout(() => {
        emit({ runId: req.runId, event: { type: "error", code: "over-limit", message: "You've used all 4,250 AI credits for this month. They reset on November 1." } });
        emit({ runId: req.runId, event: { type: "done" } });
      }, 1);
    });
    act(() => void engine.setSelection([text]));
    act(() => rowByLabel("Shorten")!.click());
    await tick();
    await tick();
    expect(ai.get().error?.code).toBe("over-limit");
    const alert = panelEl().querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain("They reset on November 1.");
    expect([...alert.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["AI balance", "Try again"]);
    view.unmount();
    engine.destroy();
  });
});

describe("Prototype › Add interactions", () => {
  it("shows for two or more top-level frames, with the AI badge", async () => {
    const { view, engine } = await setup("prototype", () => {});
    const page = engine.readNode(engine.readNode("2:10", { fields: ["parentIndex"] })!.parentIndex!.guid, { childIds: true })!;
    const frames = engine.readNodes(page.childIds ?? [], { fields: ["type"] }).filter((n) => n.type === "FRAME").map((n) => n.guid);
    expect(frames.length).toBeGreaterThan(1);
    const button = () => [...view.host.querySelectorAll("button")].find((b) => b.textContent?.includes("Add interactions"));
    act(() => void engine.setSelection([frames[0]]));
    expect(button()).toBeUndefined();
    act(() => void engine.setSelection(frames.slice(0, 2)));
    expect(button()).toBeTruthy();
    expect(button()!.parentElement!.textContent).toContain("AI");
    view.unmount();
    engine.destroy();
  });
});
