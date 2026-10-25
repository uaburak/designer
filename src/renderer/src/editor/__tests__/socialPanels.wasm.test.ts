// @vitest-environment happy-dom
// Social's chrome (docs/social.md §6, round 18a) on the real engine: a Social file (§18) opens on the Posts tab with the
// agent's right panel and keeps Social, a Design file has no Social; the Posts list groups by campaign; the Post section's caption counter turns red
// past the format's limit; the safe areas' bands follow the camera's zoom. Round 18c: a review pin picks its problem in
// the review card; a post goes to the agent with its format.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, createElement } from "react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Engine } from "@/engine/Engine";
import { EngineStore } from "@/engine/EngineStore";
import { loadEngine } from "@/engine/loadEngine";
import { SAMPLE_DOCUMENT } from "@/engine/sampleDocument";
import { $, $$, click, mount, type Mounted } from "../../ds/__tests__/dom";
import { EditorContext, EditorController } from "../controller";
import { memoryDocumentSource } from "../documentSource";
import { CanvasLayers, LeftSide, RightSide } from "../EditorApp";
import { runEditorCommand } from "../commands";
import { setMode } from "../devmode/devMode";
import { editorWriter, newCampaign, newPost, setCampaign, setPost } from "../social/actions";
import { PostSection } from "../social/PostSection";
import { readPost, writePost } from "../social/posts";
import { ManagerCard } from "../panels/agents/StudioCards";
import { agentsOf } from "../agents/service";
import type { ViewCard } from "../agents/managerTools";
import { useUI } from "../hooks";
import { bandTone } from "../social/SafeAreaOverlay";

const wasm = join(process.cwd(), "src/renderer/src/engine/wasm/engine.wasm");

beforeAll(async () => {
  globalThis.fetch = async () => new Response(null, { status: 404 });
  const bytes = readFileSync(wasm);
  await loadEngine({ wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), printErr: () => {} });
});

let m: Mounted | null = null;
afterEach(() => {
  m?.unmount();
  m = null;
  document.body.innerHTML = "";
});

/** What the overlay hands the engine's safe areas, call by call */
function spySafeAreas(engine: Engine) {
  const sent: { id: string; insets: { top: number; right: number; bottom: number; left: number }; color: { a: number } }[][] = [];
  const real = engine.setSafeAreas.bind(engine);
  engine.setSafeAreas = (areas) => {
    sent.push(areas.map((a) => ({ ...a })));
    real(areas);
  };
  return sent;
}

/** `editorType` "buzz": a Social file (docs/social.md §18), which opens in Social */
async function setup(view: () => ReturnType<typeof createElement>, editorType: "design" | "buzz" = "buzz") {
  const source = memoryDocumentSource(SAMPLE_DOCUMENT, { fileName: "Test", editorType });
  const engine = await Engine.create(null, { sessionID: 1 });
  engine.load(await source.load());
  engine.setViewport(1280, 800, 1, 1280, 800);
  const ed = new EditorController(engine, new EngineStore(engine), source);
  m = mount(() => createElement(EditorContext.Provider, { value: ed }, view()), {});
  return { ed, engine };
}

describe("Social mode's chrome (round 18a)", () => {
  it("the grid view (docs/social.md §29): no post toolbar; a grid's container selected as one has an Export button and gives way to a post's selection", async () => {
    let id = "";
    const { ed } = await setup(() => createElement(CanvasLayers));
    await act(async () => {
      id = newPost(ed, editorWriter(ed), { formatId: "instagram.portrait" });
    });
    await act(async () => ed.engine.setSelection([id]));
    expect($("[data-post-toolbar]")).toBeNull();
    // The container selected (a click on its name or its black): the selection empty, its Export at the top right
    await act(async () => {
      ed.engine.setSelection([]);
      ed.ui.set({ socialGrid: "instagram.portrait" });
    });
    expect($('[data-grid-name="instagram.portrait"]')?.hasAttribute("data-selected")).toBe(true);
    expect($('[data-grid-export="instagram.portrait"]')?.textContent).toBe("Export");
    // A post selected: the container no more
    await act(async () => ed.engine.setSelection([id]));
    expect(ed.ui.get().socialGrid).toBeNull();
    expect($("[data-grid-export]")).toBeNull();
  });

  it("a Social file opens in Social with its agent on the left; the right panel follows the selection; Design and Motion beside it; a Design file has none", async () => {
    const { ed } = await setup(() => createElement("div", null, createElement(LeftSide), createElement(RightSide)));
    expect(ed.ui.get().mode).toBe("social");
    // The agent is the left panel's first tab (docs/social.md §19)
    expect($('[data-panel="left"]')?.getAttribute("data-tab")).toBe("agents");
    expect($('[data-agents][data-placement="left"]')).not.toBeNull();
    expect($$("[data-rail-tab]").map((b) => b.getAttribute("data-rail-tab"))[0]).toBe("agents");
    // Nothing selected: the Board
    expect($("[data-social-right]")?.getAttribute("data-social-right")).toBe("board");
    expect($("[data-social-board]")).not.toBeNull();
    // One post selected: its Design panel, the Post section a tab beside it
    const w = editorWriter(ed);
    let a = "";
    let b = "";
    await act(async () => {
      a = newPost(ed, w, { formatId: "instagram.portrait" });
      b = newPost(ed, w, { formatId: "instagram.portrait" });
    });
    await act(async () => ed.engine.setSelection([a]));
    expect($("[data-social-right]")?.getAttribute("data-social-right")).toBe("design");
    act(() => click($$('[data-social-right] [role="radio"]').find((x) => x.textContent === "Post")!));
    expect($("[data-social-properties] [data-post-field=\"status\"]")).not.toBeNull();
    // Two posts: the bulk panel
    await act(async () => ed.engine.setSelection([a, b]));
    expect($("[data-social-right]")?.getAttribute("data-social-right")).toBe("bulk");
    expect($("[data-social-bulk]")?.textContent).toContain("2 posts selected");
    // A click on the blank: the Board again
    await act(async () => ed.engine.setSelection([]));
    expect($("[data-social-right]")?.getAttribute("data-social-right")).toBe("board");

    // Its modes are Design, Social and Motion (docs/social.md §23): no Dev Mode or Draw.
    for (const id of ["view.dev-mode", "view.switch-to-draw"]) expect(runEditorCommand(ed, id)).toBe(false);
    act(() => setMode(ed, "dev"));
    expect(ed.ui.get().mode).toBe("social");
    act(() => setMode(ed, "design"));
    expect(ed.ui.get().mode).toBe("design");
    act(() => void runEditorCommand(ed, "view.switch-to-motion"));
    expect(ed.ui.get().mode).toBe("motion");
    // Motion again: back to Social
    act(() => void runEditorCommand(ed, "view.switch-to-motion"));
    expect(ed.ui.get().mode).toBe("social");
    m?.unmount();

    // A Design file opens in Design (and View › Social is gone).
    const design = await setup(() => createElement(LeftSide), "design");
    expect(design.ed.ui.get().mode ?? "design").toBe("design");
    expect($('[data-panel="left"]')?.getAttribute("data-tab")).toBe("file");
    expect($('[data-rail-tab="posts"]')).toBeNull();
    expect(runEditorCommand(design.ed, "view.mode-social")).toBe(false);
  });

  it("the templates are the rail's own tab after Posts (docs/social.md §20), with the gallery and its starter action", async () => {
    await setup(() => createElement(LeftSide));
    expect($$("[data-rail-tab]").map((b) => b.getAttribute("data-rail-tab")).slice(0, 3)).toEqual(["agents", "posts", "templates"]);
    act(() => click($('[data-rail-tab="templates"]')!));
    expect($('[data-panel="left"]')?.getAttribute("data-tab")).toBe("templates");
    expect($('[data-panel="left"]')?.textContent).toContain("No templates yet");
    expect($('[data-panel="left"]')?.textContent).toContain("Make starter templates…");
  });

  it("lists the page's posts by campaign in the Posts tab", async () => {
    const { ed } = await setup(() => createElement(LeftSide));
    act(() => ed.ui.set({ railTab: "posts" }));
    expect($("[data-social-posts]")).toBeNull();
    const w = editorWriter(ed);
    // The index tells its listeners in a microtask (deferred.ts): an async act lets the list re-render
    await act(async () => {
      const c = newCampaign("October", null);
      setCampaign(ed, w, ed.store.page, c);
      newPost(ed, w, { formatId: "instagram.post", campaignId: c.id });
      newPost(ed, w, { formatId: "instagram.story", campaignId: c.id });
      newPost(ed, w, { formatId: "linkedin.square" });
    });
    const groups = $$("[data-campaign-header]").map((h) => h.textContent);
    expect(groups).toEqual(["October2", "No campaign1"]);
    expect($$("[data-post]").map((r) => r.textContent?.replace(/\s+/g, " ").trim())).toEqual([
      expect.stringContaining("Instagram post"),
      expect.stringContaining("Instagram story"),
      expect.stringContaining("LinkedIn square"),
    ]);
    // A click selects the post.
    const story = $$("[data-post]")[1];
    act(() => click(story));
    expect(ed.store.selection.refs).toEqual([story.getAttribute("data-post")]);
    // ⇧ adds the rows from the last one clicked, across campaigns; ⌘ takes one out.
    const ids = $$("[data-post]").map((r) => r.getAttribute("data-post"));
    const press = (el: Element, opts: MouseEventInit) => act(() => void el.dispatchEvent(new MouseEvent("click", { bubbles: true, ...opts })));
    press($$("[data-post]")[2], { shiftKey: true });
    expect(ed.store.selection.refs).toEqual([ids[1], ids[2]]);
    act(() => click($$("[data-post]")[2]));
    press($$("[data-post]")[0], { shiftKey: true });
    expect(ed.store.selection.refs).toEqual(ids);
    press($$("[data-post]")[1], { metaKey: true });
    expect(ed.store.selection.refs).toEqual([ids[0], ids[2]]);
  });

  it("turns the caption's counter red past the format's limit", async () => {
    let id = "";
    const { ed } = await setup(() => createElement(PostSection));
    await act(async () => {
      ed.ui.set({ mode: "social" });
      id = newPost(ed, editorWriter(ed), { formatId: "instagram.post" });
      ed.engine.setSelection([id]);
    });
    const counter = () => $("[data-caption-count]")!;
    expect(counter().textContent).toBe("0 / 2,200");
    expect(counter().hasAttribute("data-over")).toBe(false);
    expect($("[data-caption-fold]")?.getAttribute("data-caption-fold")).toBe("125");
    await act(async () => setPost(ed, editorWriter(ed), [id], { caption: "x".repeat(2201) }));
    expect(counter().textContent).toBe("2,201 / 2,200");
    expect(counter().hasAttribute("data-over")).toBe(true);
    // Hashtags count against the limit too (on their own line after the caption).
    await act(async () => setPost(ed, editorWriter(ed), [id], { caption: "x".repeat(2190), hashtags: ["tarım"] }));
    expect(counter().textContent).toBe("2,198 / 2,200");
    expect(counter().hasAttribute("data-over")).toBe(false);
  });

  it("a Social file's grid view shows the safe areas and no pins: on each post the Design glyph, which opens it alone (docs/social.md §21, §29)", async () => {
    let id = "";
    const { ed } = await setup(() => createElement(CanvasLayers));
    const sent = spySafeAreas(ed.engine);
    await act(async () => {
      id = newPost(ed, editorWriter(ed), { formatId: "instagram.story", at: { x: 0, y: 0 } });
    });
    const problem = { id: "s1", kind: "safe-area" as const, detail: "“CTA” reaches into the bottom band", box: { x: 100, y: 1700, width: 300, height: 80 }, fix: "relayout" as const, source: "check" as const };
    await act(async () => ed.batch("Pins", () => writePost(ed, id, { ...readPost(ed, id)!, problems: [problem, { ...problem, id: "s2", box: undefined }] })));
    // The safe areas show on the grid too (§30); no pins there
    expect(sent.at(-1)?.map((a) => a.id)).toEqual([id]);
    expect($('[data-review-pins] [data-problem="s1"]')).toBeNull();
    const open = $(`[data-post-open="${id}"]`)!;
    expect(open.querySelector("svg")).not.toBeNull();
    act(() => click(open));
    expect(ed.store.selection.refs).toEqual([id]);
    expect(ed.ui.get().socialView).toBe("asset");
    expect(ed.ui.get().socialPanelTab).toBe("design");
  });

  it("hands the engine each post's safe area — drawn inside the post as a layout guide, following it (docs/social.md §30)", async () => {
    let id = "";
    let square = "";
    // A Design file in Social
    const { ed } = await setup(() => createElement(CanvasLayers), "design");
    const sent = spySafeAreas(ed.engine);
    // The posts index tells its listeners in a microtask (deferred.ts): an async act lets the overlay re-render
    await act(async () => {
      ed.ui.set({ mode: "social" });
      id = newPost(ed, editorWriter(ed), { formatId: "instagram.story", at: { x: 0, y: 0 } });
      // A square post: the margin over and under it, what the profile grid's 3:4 crops at its sides
      square = newPost(ed, editorWriter(ed), { formatId: "instagram.square", at: { x: 2000, y: 0 } });
    });
    const last = sent.at(-1)!;
    expect(last.find((a) => a.id === id)?.insets).toEqual({ top: 269, right: 65, bottom: 672, left: 65 });
    expect(last.find((a) => a.id === square)?.insets).toEqual({ top: 64, right: 135, bottom: 64, left: 135 });
    // Red at the layout guide's 10 % (the test's engine draws nothing to read a tone off)
    expect(last[0].color).toMatchObject({ a: 0.1 });
    // Safe areas off: none
    await act(async () => void runEditorCommand(ed, "social.toggle-safe-areas"));
    expect(sent.at(-1)).toEqual([]);
  });
});

describe("Social's agent pieces (round 18c)", () => {
  it("a review pin selects its post, opens its card (the words, Fix with agent, Ignore) and marks its problem in the review card (docs/social.md §30)", async () => {
    let card: ViewCard | null = null;
    // The card re-renders when the ui changes (as the chat does).
    function Card() {
      useUI((s) => s.socialProblem);
      return card ? createElement(ManagerCard, { card, service: agentsOf(ed) }) : null;
    }
    // A Design file in Social: its board's pins (a Social file's board shows a badge, §21)
    const { ed } = await setup(() => createElement("div", null, createElement(CanvasLayers), createElement(Card)), "design");
    let id = "";
    await act(async () => {
      ed.ui.set({ mode: "social" });
      id = newPost(ed, editorWriter(ed), { formatId: "instagram.story", at: { x: 0, y: 0 } });
    });
    const problem = { id: "s1", kind: "safe-area" as const, detail: "“CTA” reaches into the bottom band", box: { x: 100, y: 1700, width: 300, height: 80 }, fix: "relayout" as const };
    await act(async () => ed.batch("Pins", () => writePost(ed, id, { ...readPost(ed, id)!, problems: [{ ...problem, source: "review" }] })));
    card = { kind: "review", id: "card-r", report: { briefId: "b", items: [{ nodeId: id, name: "Story", ok: false, problems: [problem] }] } };
    const pin = $('[data-review-pins] [data-problem="s1"]')!;
    expect(pin.textContent).toBe("1");
    act(() => click(pin));
    expect(ed.store.selection.refs).toEqual([id]);
    expect(ed.ui.get()).toMatchObject({ socialProblem: { post: id, problem: "s1" } });
    // Its card: an agent's problem as it wrote it; no mechanical fix for it, so the agent's
    const opened = $('[data-problem-card="s1"]')!;
    expect(opened.textContent).toContain("“CTA” reaches into the bottom band");
    expect($("[data-problem-fix]")?.textContent).toBe("Fix with agent");
    const row = $('[data-card="review"] [data-review-problem="s1"]')!;
    expect(row.hasAttribute("data-pinned")).toBe(true);
    expect(row.textContent).toContain("Safe area: “CTA” reaches into the bottom band");
  });

  it("a selected post goes to the agent as context with its format (its chip shows it)", async () => {
    const { ed } = await setup(() => createElement(RightSide));
    let id = "";
    act(() => {
      id = newPost(ed, editorWriter(ed), { formatId: "linkedin.landscape" });
      ed.engine.setSelection([id]);
    });
    expect(agentsOf(ed).selectionContext()).toEqual([expect.objectContaining({ id, format: "LinkedIn landscape" })]);
  });
});

describe("the safe areas' hatch (docs/social.md §30)", () => {
  /** A 10 × 10 render: `band` the colour of its outer ring of pixels, `middle` the rest */
  const render = (band: number[], middle: number[]) => {
    const pixels = new Uint8Array(10 * 10 * 4);
    for (let y = 0; y < 10; y++)
      for (let x = 0; x < 10; x++) pixels.set([...(x === 0 || y === 0 || x === 9 || y === 9 ? band : middle), 255], (y * 10 + x) * 4);
    return { width: 10, height: 10, pixels } as never;
  };
  const bands = { top: 10, right: 10, bottom: 10, left: 10 };
  it("red, unless the design under the bands is red: then blue, else purple", () => {
    expect(bandTone(render([255, 255, 255], [220, 30, 30]), { width: 100, height: 100 }, bands)).toBe("red");
    expect(bandTone(render([220, 30, 30], [255, 255, 255]), { width: 100, height: 100 }, bands)).toBe("blue");
    // Dark red is no red to the eye's hatch: kept
    expect(bandTone(render([60, 10, 10], [255, 255, 255]), { width: 100, height: 100 }, bands)).toBe("red");
  });
});
