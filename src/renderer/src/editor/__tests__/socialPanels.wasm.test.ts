// @vitest-environment happy-dom
// Social's chrome (docs/social.md §6, round 18a) on the real engine: the mode switch mounts the Posts tab and the agent's
// right panel and gives Design's back; the Posts list groups by campaign; the Post section's caption counter turns red
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
import { editorWriter, newCampaign, newPost, setCampaign, setPost } from "../social/actions";
import { PostSection } from "../social/PostSection";
import { readPost, writePost } from "../social/posts";
import { ManagerCard } from "../panels/agents/StudioCards";
import { agentsOf } from "../agents/service";
import type { ViewCard } from "../agents/managerTools";
import { useUI } from "../hooks";

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

async function setup(view: () => ReturnType<typeof createElement>) {
  const source = memoryDocumentSource(SAMPLE_DOCUMENT, { fileName: "Test" });
  const engine = await Engine.create(null, { sessionID: 1 });
  engine.load(await source.load());
  engine.setViewport(1280, 800, 1, 1280, 800);
  const ed = new EditorController(engine, new EngineStore(engine), source);
  m = mount(() => createElement(EditorContext.Provider, { value: ed }, view()), {});
  return { ed, engine };
}

describe("Social mode's chrome (round 18a)", () => {
  it("the mode switch mounts the Posts tab and the agent's panel, and gives Design's back", async () => {
    const { ed } = await setup(() => createElement("div", null, createElement(LeftSide), createElement(RightSide)));
    expect($('[data-panel="left"]')?.getAttribute("data-tab")).toBe("file");
    expect($("[data-social-right]")).toBeNull();
    expect($('[data-rail-tab="posts"]')).toBeNull();

    act(() => runEditorCommand(ed, "view.mode-social"));
    expect(ed.ui.get().mode).toBe("social");
    expect($('[data-panel="left"]')?.getAttribute("data-tab")).toBe("posts");
    expect($('[data-rail-tab="posts"]')).not.toBeNull();
    // The agent is on the right: the rail has no Agents tab in Social.
    expect($('[data-rail-tab="agents"]')).toBeNull();
    expect($("[data-social-right]")?.getAttribute("data-social-right")).toBe("agent");
    expect($('[data-agents][data-placement="right"]')).not.toBeNull();
    // Post and Design collapsed under the chat (the proposed default).
    expect($$("[data-social-section] button[aria-expanded]").map((b) => b.getAttribute("aria-expanded"))).toEqual(["false", "false"]);

    // Properties: the chat hidden, Post and Design open.
    act(() => click($$('[data-social-right] [role="radio"]').find((b) => b.textContent === "Properties")!));
    expect($("[data-social-right]")?.getAttribute("data-social-right")).toBe("properties");
    expect($("[data-agents]")).toBeNull();
    expect($("[data-social-properties]")).not.toBeNull();

    // Back to Design: File, Design's right panel; nothing in the document changed.
    const undo = ed.store.undo.undoLabel;
    act(() => runEditorCommand(ed, "view.mode-social"));
    expect(ed.ui.get().mode).toBe("design");
    expect($('[data-panel="left"]')?.getAttribute("data-tab")).toBe("file");
    expect($("[data-social-right]")).toBeNull();
    expect(ed.store.undo.undoLabel).toBe(undo);
  });

  it("lists the page's posts by campaign in the Posts tab", async () => {
    const { ed } = await setup(() => createElement(LeftSide));
    act(() => runEditorCommand(ed, "view.mode-social"));
    expect($("[data-social-posts]")).toBeNull();
    const w = editorWriter(ed);
    act(() => {
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
  });

  it("turns the caption's counter red past the format's limit", async () => {
    let id = "";
    const { ed } = await setup(() => createElement(PostSection));
    act(() => {
      ed.ui.set({ mode: "social" });
      id = newPost(ed, editorWriter(ed), { formatId: "instagram.post" });
      ed.engine.setSelection([id]);
    });
    const counter = () => $("[data-caption-count]")!;
    expect(counter().textContent).toBe("0 / 2,200");
    expect(counter().hasAttribute("data-over")).toBe(false);
    expect($("[data-caption-fold]")?.getAttribute("data-caption-fold")).toBe("125");
    act(() => setPost(ed, editorWriter(ed), [id], { caption: "x".repeat(2201) }));
    expect(counter().textContent).toBe("2,201 / 2,200");
    expect(counter().hasAttribute("data-over")).toBe(true);
    // Hashtags count against the limit too (on their own line after the caption).
    act(() => setPost(ed, editorWriter(ed), [id], { caption: "x".repeat(2190), hashtags: ["tarım"] }));
    expect(counter().textContent).toBe("2,198 / 2,200");
    expect(counter().hasAttribute("data-over")).toBe(false);
  });

  it("draws a story's safe-area bands at the camera's zoom", async () => {
    let id = "";
    const { ed, engine } = await setup(() => createElement(CanvasLayers));
    act(() => {
      ed.ui.set({ mode: "social" });
      id = newPost(ed, editorWriter(ed), { formatId: "instagram.story", at: { x: 0, y: 0 } });
      // A square post has no safe area: no bands for it.
      newPost(ed, editorWriter(ed), { formatId: "instagram.square", at: { x: 2000, y: 0 } });
    });
    act(() => engine.setCamera({ x: 10, y: 20, zoom: 0.5 }));
    const post = $(`[data-safe-areas] [data-post="${id}"]`)!;
    expect($$("[data-safe-areas] [data-post]")).toHaveLength(1);
    expect(post.style.transform).toBe("translate(10px, 20px)");
    expect(post.style.width).toBe("540px");
    expect(post.style.height).toBe("960px");
    const band = (side: string) => post.querySelector<HTMLElement>(`[data-band="${side}"]`)!;
    expect(band("top").style.height).toBe("134.5px");
    expect(band("bottom").style.height).toBe("336px");
    expect(band("left").style.width).toBe("32.5px");
    expect(band("left").style.top).toBe("134.5px");
    // Smaller than 8 px on screen: not drawn.
    act(() => engine.setCamera({ x: 0, y: 0, zoom: 0.1 }));
    expect(band("left").hidden).toBe(true);
    expect(band("top").hidden).toBe(false);
    // Safe areas off: gone.
    act(() => runEditorCommand(ed, "social.toggle-safe-areas"));
    expect($("[data-safe-areas]")).toBeNull();
  });
});

describe("Social's agent pieces (round 18c)", () => {
  it("a review pin selects its post, shows the Agent tab and marks its problem in the review card", async () => {
    let card: ViewCard | null = null;
    // The card re-renders when the ui changes (as the chat does).
    function Card() {
      useUI((s) => s.socialProblem);
      return card ? createElement(ManagerCard, { card, service: agentsOf(ed) }) : null;
    }
    const { ed } = await setup(() => createElement("div", null, createElement(CanvasLayers), createElement(Card)));
    let id = "";
    act(() => {
      ed.ui.set({ mode: "social" });
      id = newPost(ed, editorWriter(ed), { formatId: "instagram.story", at: { x: 0, y: 0 } });
    });
    const problem = { id: "s1", kind: "safe-area" as const, detail: "“CTA” reaches into the bottom band", box: { x: 100, y: 1700, width: 300, height: 80 }, fix: "relayout" as const };
    act(() => ed.batch("Pins", () => writePost(ed, id, { ...readPost(ed, id)!, problems: [{ ...problem, source: "review" }] })));
    card = { kind: "review", id: "card-r", report: { briefId: "b", items: [{ nodeId: id, name: "Story", ok: false, problems: [problem] }] } };
    const pin = $('[data-review-pins] [data-problem="s1"]')!;
    expect(pin.textContent).toBe("1");
    act(() => click(pin));
    expect(ed.store.selection.refs).toEqual([id]);
    expect(ed.ui.get()).toMatchObject({ socialRightTab: "agent", socialProblem: { post: id, problem: "s1" } });
    const row = $('[data-card="review"] [data-review-problem="s1"]')!;
    expect(row.hasAttribute("data-pinned")).toBe(true);
    expect(row.textContent).toContain("Safe area: “CTA” reaches into the bottom band");
  });

  it("a selected post goes to the agent as context with its format (its chip shows it)", async () => {
    const { ed } = await setup(() => createElement(RightSide));
    let id = "";
    act(() => {
      runEditorCommand(ed, "view.mode-social");
      id = newPost(ed, editorWriter(ed), { formatId: "linkedin.landscape" });
      ed.engine.setSelection([id]);
    });
    expect(agentsOf(ed).selectionContext()).toEqual([expect.objectContaining({ id, format: "LinkedIn landscape" })]);
  });
});
