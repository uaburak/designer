// @vitest-environment happy-dom
// Round 7c — Draw's toolbar and tools chrome (docs/draw.md §5.1, §5.2, §5.6, §5.7): the settings the secondary
// toolbar sends to the engine (a fake one: the real Draw calls are round 7b's), built-in brushes installed when first
// used, ⌘-click sampling, the mode and the Brush, the Brush styles menu's sections, and Draw's commands.
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Status } from "@/engine/abi";
import { DRAW_TOOL_DEFAULTS, type BrushType, type DrawCommandArgs, type DrawToolSettings as Settings, type InstallBrushInput } from "@shared/draw/types";
import { $, $$, click, mount, type Mounted } from "../../ds/__tests__/dom";
import { EditorContext, type EditorController } from "../controller";
import { Store, type UIState } from "../uiStore";
import { COMMAND_BY_ID, isEnabled } from "../commands";
import { BrushMenu } from "../draw/BrushMenu";
import { DrawToolSettings } from "../draw/DrawToolSettings";
import { applySampled, attachDrawTools, brushSections, chooseBrush, drawToolsOf, sendDrawTools, setBuiltinBrushes, setPencil } from "../draw/drawTools";

const toasts = vi.hoisted(() => [] as string[]);
vi.mock("@/ds", async (original) => ({ ...(await original<typeof import("@/ds")>()), showToast: (o: { message: string }) => (toasts.push(o.message), 1) }));

const ARTWORK = { width: 256, height: 16, d: "M0 0L256 8L0 16Z", windingRule: "NONZERO" as const };

/** A fake engine with round 7b's Draw calls recorded; `built: false` throws like the Engine.ts stubs. */
function fakeEditor(opts: { built?: boolean; brushes?: { guid: string; name: string; type: BrushType }[]; selected?: { guid: string; type: string }[]; commands?: number } = {}) {
  const built = opts.built ?? true;
  const notBuilt = (name: string) => {
    throw new Error(`engine: ${name} not built (round 7b)`);
  };
  const brushes = [...(opts.brushes ?? [])];
  const sent: Settings[] = [];
  const installed: InstallBrushInput[] = [];
  const commands: { id: keyof DrawCommandArgs; args: unknown }[] = [];
  const listeners = new Map<string, ((e: unknown) => void)[]>();
  const toolListeners: (() => void)[] = [];
  const store = { tool: "MOVE", subscribe: (_t: string, l: () => void) => (toolListeners.push(l), () => {}) };
  const engine = {
    destroyed: false,
    setDrawToolSettings: (s: Settings) => (built ? (sent.push(s), Status.OK) : notBuilt("setDrawToolSettings")),
    installBrush: (input: InstallBrushInput) => {
      if (!built) return notBuilt("installBrush");
      installed.push(input);
      const guid = `0:${100 + brushes.length}`;
      brushes.push({ guid, name: input.name, type: input.type });
      return guid;
    },
    listBrushes: () => (built ? brushes : notBuilt("listBrushes")),
    brushPreview: () => (built ? { width: 2, height: 2, pixels: new Uint8Array(16) } : notBuilt("brushPreview")),
    runDrawCommand: (id: keyof DrawCommandArgs, args: unknown) => (built ? (commands.push({ id, args }), opts.commands ?? Status.OK) : notBuilt("runDrawCommand")),
    commandState: () => (built ? 1 : 0),
    on: (type: string, l: (e: unknown) => void) => {
      listeners.set(type, [...(listeners.get(type) ?? []), l]);
      return () => {};
    },
  };
  const selected = opts.selected ?? [];
  const ed = {
    engine,
    store,
    ui: new Store<Partial<UIState>>({ mode: "design" }),
    tools: new Set(["MOVE", "PENCIL", "BRUSH", "TEXT_PATH"]),
    selection: selected.map((n) => n.guid),
    selectedNodes: () => selected,
    setTool: (t: string) => {
      store.tool = t;
      toolListeners.forEach((l) => l());
    },
    focusCanvas: () => {},
  } as unknown as EditorController;
  const emit = (type: string, e: unknown) => listeners.get(type)?.forEach((l) => l(e));
  return { ed, sent, installed, commands, emit, store };
}

let m: Mounted | null = null;
afterEach(() => {
  m?.unmount();
  m = null;
  setBuiltinBrushes([]);
});
beforeEach(() => setBuiltinBrushes([]));

const withEditor = (ed: EditorController, child: () => ReactNode) =>
  function Host() {
    return createElement(EditorContext.Provider, { value: ed }, child());
  };

describe("round 7c: the tools' settings go to the engine", () => {
  it("each change sends the whole settings, clamped to the ranges", () => {
    const { ed, sent } = fakeEditor();
    setPencil(ed, { weight: 500, kind: "DYNAMIC", dynamic: { frequency: 0 } });
    expect(sent.at(-1)!.pencil).toEqual({ ...DRAW_TOOL_DEFAULTS.pencil, weight: 100, kind: "DYNAMIC", dynamic: { ...DRAW_TOOL_DEFAULTS.pencil.dynamic, frequency: 0.01 } });
    expect(sent.at(-1)!.brush).toEqual(DRAW_TOOL_DEFAULTS.brush);
    expect(drawToolsOf(ed).settings.pencil.weight).toBe(100);
  });

  it("the engine's stubs (round 7b not built) leave the chrome working on its own state", () => {
    const { ed } = fakeEditor({ built: false });
    expect(sendDrawTools(ed)).toBe(Status.E_UNSUPPORTED);
    setPencil(ed, { weight: 3 });
    expect(drawToolsOf(ed).settings.pencil.weight).toBe(3);
    expect(brushSections(ed).custom).toEqual([]);
    expect(chooseBrush(ed, { guid: null, name: "Noir", type: "STRETCH", builtin: "NOIR" })).toBeNull();
    expect(drawToolsOf(ed).brush).toMatchObject({ name: "Noir", builtin: "NOIR", guid: null });
  });

  it("entering Draw sends the settings; leaving it with the Brush puts Move back; the Brush installs its brush", () => {
    setBuiltinBrushes([{ key: "HEIST", name: "Heist", type: "STRETCH", artwork: ARTWORK }]);
    const { ed, sent, installed, store } = fakeEditor();
    const off = attachDrawTools(ed);
    expect(sent).toHaveLength(0);
    ed.ui.set({ mode: "draw" });
    expect(sent).toHaveLength(1);
    ed.setTool("BRUSH");
    // The default brush (Heist [unverified]) went into the file when the Brush was first used.
    expect(installed).toEqual([{ name: "Heist", type: "STRETCH", artwork: ARTWORK }]);
    expect(sent.at(-1)!.brush.brush).toBe("0:100");
    ed.ui.set({ mode: "design" });
    expect(store.tool).toBe("MOVE");
    off();
  });

  it("a built-in is installed when picked, once; the file's own brush is used as it is", () => {
    setBuiltinBrushes([{ key: "BUBBLEGUM", name: "Bubblegum", type: "SCATTER", artwork: { ...ARTWORK, width: 64, height: 64 } }]);
    const { ed, installed, sent } = fakeEditor({ brushes: [{ guid: "0:9", name: "Mine", type: "SCATTER" }] });
    const bubblegum = brushSections(ed).scatter[0];
    expect(bubblegum).toEqual({ guid: null, name: "Bubblegum", type: "SCATTER", builtin: "BUBBLEGUM" });
    expect(chooseBrush(ed, bubblegum)).toBe("0:101");
    expect(brushSections(ed).scatter[0].guid).toBe("0:101");
    chooseBrush(ed, brushSections(ed).scatter[0]);
    expect(installed).toHaveLength(1);
    chooseBrush(ed, brushSections(ed).custom[0]);
    expect(sent.at(-1)!.brush.brush).toBe("0:9");
    expect(drawToolsOf(ed).brush).toEqual({ name: "Mine", type: "SCATTER", builtin: null, guid: "0:9" });
  });

  it("⌘-click sampling (DRAW_TOOL_SAMPLED) becomes the tool's settings and goes back to the engine", () => {
    const { ed, sent, emit } = fakeEditor({ brushes: [{ guid: "0:5", name: "Noir", type: "STRETCH" }] });
    const off = attachDrawTools(ed);
    emit("DRAW_TOOL_SAMPLED", { type: "DRAW_TOOL_SAMPLED", tool: "PENCIL", color: "#ff0000", opacity: 0.5, weight: 7, kind: "DYNAMIC", dynamic: { frequency: 3, wiggle: 2, smoothen: 0.1 } });
    expect(sent.at(-1)!.pencil).toEqual({ color: "#ff0000", opacity: 0.5, weight: 7, kind: "DYNAMIC", dynamic: { frequency: 3, wiggle: 2, smoothen: 0.1 } });
    applySampled(ed, { tool: "BRUSH", color: "#00ff00", opacity: 1, weight: 9, kind: "BRUSH", brush: "0:5" });
    expect(sent.at(-1)!.brush).toEqual({ color: "#00ff00", opacity: 1, weight: 9, brush: "0:5" });
    expect(drawToolsOf(ed).brush).toEqual({ name: "Noir", type: "STRETCH", builtin: "NOIR", guid: "0:5" });
    off();
  });
});

describe("round 7c: the Brush styles menu", () => {
  it("lists Stretch (15), Scatter (10) and the file's Custom brushes, the current one ticked", () => {
    const picked: string[] = [];
    const { ed } = fakeEditor({ brushes: [{ guid: "0:7", name: "Heist", type: "STRETCH" }, { guid: "0:8", name: "Leaf", type: "SCATTER" }] });
    m = mount(withEditor(ed, () => createElement(BrushMenu, { anchor: null, current: { guid: "0:7", builtin: "HEIST" }, onPick: (e) => picked.push(e.name), onClose: () => {} })), {});
    const groups = $$('[data-brush-menu] [role="group"]');
    expect(groups.map((g) => g.getAttribute("aria-label"))).toEqual(["Stretch", "Scatter", "Custom"]);
    const names = (g: Element) => [...g.querySelectorAll('[role="option"]')].map((o) => o.getAttribute("aria-label"));
    expect(names(groups[0])).toEqual(["Heist", "Blockbuster", "Grindhouse", "Biopic", "Spaghetti Western", "Slasher", "Hardboiled", "Verite", "Epic", "Screwball", "Rom Com", "Noir", "Propaganda", "Melodrama", "New Wave"]);
    expect(names(groups[1])).toEqual(["Bubblegum", "Witch House", "Shoegaze", "Honky Tonk", "Screamo", "Drone", "Doo Wop", "Spoken Word", "Vaporwave", "Oi"]);
    // The installed Heist counts as the built-in, not a custom brush.
    expect(names(groups[2])).toEqual(["Leaf"]);
    expect($$('[role="option"][aria-selected="true"]').map((o) => o.getAttribute("aria-label"))).toEqual(["Heist"]);
    click($('[role="option"][aria-label="Oi"]'));
    expect(picked).toEqual(["Oi"]);
  });

  it("without custom brushes there is no Custom section; `type` keeps one kind (Stroke's picker)", () => {
    const { ed } = fakeEditor();
    m = mount(withEditor(ed, () => createElement(BrushMenu, { anchor: null, current: null, type: "SCATTER", onPick: () => {}, onClose: () => {} })), {});
    expect($$('[data-brush-menu] [role="group"]').map((g) => g.getAttribute("aria-label"))).toEqual(["Scatter"]);
  });
});

describe("round 7c: the secondary toolbar", () => {
  it("the Pencil: colour, weight, Basic / Dynamic (Dynamic's settings in its popover)", () => {
    const { ed, sent } = fakeEditor();
    m = mount(withEditor(ed, () => createElement(DrawToolSettings, { tool: "PENCIL" })), {});
    const bar = $('[data-draw-toolbar="PENCIL"]', m.host);
    expect(bar.getAttribute("aria-label")).toBe("Pencil settings");
    expect($('[aria-label="Color"]', bar)).toBeTruthy();
    expect($('[aria-label="Weight"]', bar)).toBeTruthy();
    expect($$('[role="radio"]', bar).map((r) => r.textContent)).toEqual(["Basic", "Dynamic"]);
    click($$('[role="radio"]', bar)[1]);
    expect(sent.at(-1)!.pencil.kind).toBe("DYNAMIC");
    click($('[aria-label="Dynamic stroke settings"]', m.host));
    expect($$("[data-dynamic-settings] input").map((i) => i.getAttribute("aria-label"))).toEqual(["Frequency", "Wiggle", "Smoothen"]);
  });

  it("the Brush: the Brush styles button shows the current brush and opens the menu; a pick goes to the engine", () => {
    setBuiltinBrushes([{ key: "NOIR", name: "Noir", type: "STRETCH", artwork: ARTWORK }]);
    const { ed, sent } = fakeEditor();
    m = mount(withEditor(ed, () => createElement(DrawToolSettings, { tool: "BRUSH" })), {});
    const button = $('[aria-label="Brush styles"]', m.host);
    expect(button.textContent).toBe("Heist");
    click(button);
    click($('[role="option"][aria-label="Noir"]'));
    expect(sent.at(-1)!.brush.brush).toBe("0:100");
    expect($('[aria-label="Brush styles"]', m.host).textContent).toBe("Noir");
    expect($$("[data-brush-menu]")).toHaveLength(0);
  });
});

describe("round 7c: Draw's commands", () => {
  it("Brush (B) only in Draw; Text on path a tool of its own", () => {
    const { ed } = fakeEditor();
    const brush = COMMAND_BY_ID.get("tool.brush")!;
    expect(brush.keys).toEqual([{ code: "KeyB" }]);
    expect(isEnabled(ed, brush)).toBe(false);
    ed.ui.set({ mode: "draw" });
    expect(isEnabled(ed, brush)).toBe(true);
    expect(COMMAND_BY_ID.get("tool.text-on-path")).toMatchObject({ label: "Text on path", keys: [] });
  });

  it("Switch to Draw starts on Move; again goes back to Design", () => {
    const { ed, store } = fakeEditor();
    store.tool = "PENCIL";
    (ed.engine as unknown as Record<string, unknown>).setViewerMode = () => {};
    (ed.engine as unknown as Record<string, unknown>).setAnnotationView = () => {};
    (ed.engine as unknown as Record<string, unknown>).setAnnotationFilter = () => {};
    COMMAND_BY_ID.get("view.switch-to-draw")!.run(ed);
    expect(ed.ui.get().mode).toBe("draw");
    expect(store.tool).toBe("MOVE");
    COMMAND_BY_ID.get("view.switch-to-draw")!.run(ed);
    expect(ed.ui.get().mode).toBe("design");
  });

  it("Create brush: one vector-like layer; an open path's refusal is said", () => {
    const one = fakeEditor({ selected: [{ guid: "1:2", type: "ELLIPSE" }] });
    expect(isEnabled(one.ed, COMMAND_BY_ID.get("object.create-brush.stretch")!)).toBe(true);
    COMMAND_BY_ID.get("object.create-brush.scatter")!.run(one.ed);
    expect(one.commands).toEqual([{ id: "CREATE_BRUSH", args: { ref: "1:2", brushType: "SCATTER" } }]);
    expect(isEnabled(fakeEditor({ selected: [{ guid: "1:2", type: "TEXT" }] }).ed, COMMAND_BY_ID.get("object.create-brush.stretch")!)).toBe(false);
    expect(isEnabled(fakeEditor({ selected: [{ guid: "1:2", type: "VECTOR" }, { guid: "1:3", type: "VECTOR" }] }).ed, COMMAND_BY_ID.get("object.create-brush.stretch")!)).toBe(false);
    expect(isEnabled(fakeEditor({ built: false, selected: [{ guid: "1:2", type: "VECTOR" }] }).ed, COMMAND_BY_ID.get("object.create-brush.stretch")!)).toBe(false);
    const open = fakeEditor({ selected: [{ guid: "1:2", type: "LINE" }], commands: Status.E_INVALID });
    COMMAND_BY_ID.get("object.create-brush.stretch")!.run(open.ed);
    expect(toasts).toEqual(["Only closed paths can be used as brushes"]);
  });

  it("Apply transforms (a transform group) and Flip (text on a path)", () => {
    const t = fakeEditor({ selected: [{ guid: "1:2", type: "TRANSFORM" }] });
    expect(isEnabled(t.ed, COMMAND_BY_ID.get("object.apply-transforms")!)).toBe(true);
    expect(isEnabled(t.ed, COMMAND_BY_ID.get("text.flip-path")!)).toBe(false);
    COMMAND_BY_ID.get("object.apply-transforms")!.run(t.ed);
    const p = fakeEditor({ selected: [{ guid: "1:3", type: "TEXT_PATH" }] });
    COMMAND_BY_ID.get("text.flip-path")!.run(p.ed);
    expect([...t.commands, ...p.commands].map((c) => c.id)).toEqual(["APPLY_TRANSFORMS", "FLIP_TEXT_PATH"]);
    expect(COMMAND_BY_ID.get("object.apply-transforms")!.label).toBe("Apply transforms to selection");
  });
});
