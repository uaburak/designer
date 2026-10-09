// The chat while an agent works: the Thinking… row's line and seconds (activity.ts), the image card's states
// (service.ts applyEvent / withPlacedImage / turnOver), whether a prompt asks for a picture (asksForImage), and the
// canvas placeholder's place and life (imagePlaceholder.ts).
import { afterEach, describe, expect, it, vi } from "vitest";
import { activityOf, asksForImage, elapsedLabel, GENERATE_IMAGE, PLACE_IMAGE, requestedAspect, segmentsOf, stepsSummary, THINKING, toolActiveLabel } from "../agents/activity";
import { FADE_MS, ImagePlaceholders, landInBox, placeholderArgs, placeholderTarget, reshapeTarget, REVEAL_MS, targetAspect, type PlaceholderEnv, type PlaceNode } from "../agents/imagePlaceholder";
import { applyEvent, placedInfo, turnOver, withPlacedImage, type ChatMessage, type ImagePart, type MessagePart } from "../agents/service";
import type { ChatEvent } from "@shared/agents/types";

const run = (events: ChatEvent[], start: Partial<ChatMessage> = {}): ChatMessage => events.reduce<ChatMessage>((m, e) => ({ ...m, ...applyEvent(m, e) }), { id: "a", role: "assistant", parts: [], state: "running", ...start });

describe("the Thinking… row", () => {
  it("says what the turn is doing: the CLI's start, Thinking…, the running step, placing a made image", () => {
    expect(activityOf(run([]))).toBe(THINKING);
    expect(activityOf(run([{ type: "status", text: "Starting Antigravity…" }]))).toBe("Starting Antigravity…");
    expect(activityOf(run([{ type: "status", text: "Starting Antigravity…" }, { type: "text", delta: "Let me look" }]))).toBe(THINKING);
    expect(activityOf(run([{ type: "tool", id: "1", name: "get_design_context", state: "running" }]))).toBe("Reading the design…");
    expect(activityOf(run([{ type: "tool", id: "1", name: "get_design_context", state: "running" }, { type: "tool", id: "1", name: "get_design_context", state: "done" }]))).toBe(THINKING);
    expect(activityOf(run([{ type: "tool", id: "g", name: "generate_image", state: "running" }]))).toBe("Making an image…");
    expect(activityOf(run([{ type: "tool", id: "g", name: "generate_image", state: "running" }, { type: "tool", id: "g", name: "generate_image", state: "done" }]))).toBe("Placing the image…");
    expect(activityOf(run([{ type: "tool", id: "p", name: "place_image", state: "running" }]))).toBe("Placing the image…");
    expect(toolActiveLabel("list_dir")).toBe("List dir…");
    // The agents' own file tools on an attached file (Antigravity's view_file, Claude Code's Read).
    expect(toolActiveLabel("view_file")).toBe("Looking at the attached file…");
    expect(toolActiveLabel("Read")).toBe("Looking at the attached file…");
    // Over: no row.
    expect(activityOf({ state: "done", parts: [] })).toBeNull();
  });

  it("shows the seconds from 5 s on", () => {
    expect(elapsedLabel(undefined, 10_000)).toBe("");
    expect(elapsedLabel(1000, 5999)).toBe("");
    expect(elapsedLabel(1000, 6000)).toBe("5s");
    expect(elapsedLabel(0.5, 59_999)).toBe("59s");
    expect(elapsedLabel(1000, 1000 + 65_000)).toBe("1m 05s");
  });
});

describe("an answer as words and groups of steps", () => {
  const tool = (id: string, name: string, state: "running" | "done" | "error" = "done"): ChatEvent => ({ type: "tool", id, name, state });
  /** Each segment in short: its kind, its steps (by id), whether the turn is in it, its line. */
  const shape = (m: Pick<ChatMessage, "state" | "parts">) => segmentsOf(m).map((s) => (s.kind === "text" ? `text:${s.text.trim()}` : `${s.kind}[${s.steps.map((t) => t.id).join(",")}]${s.active ? "*" : ""} ${s.label}`));

  it("puts each run of steps between the words in one group: text, steps, text, steps", () => {
    const events: ChatEvent[] = [{ type: "text", delta: "Let me look." }, tool("1", "get_selection"), tool("2", "get_design_context"), { type: "text", delta: "\n\nNow the mobile one." }, tool("3", "create_nodes"), tool("4", "set_selection", "error")];
    expect(shape(run(events, { state: "done" }))).toEqual(["text:Let me look.", "steps[1,2] Read the design", "text:Now the mobile one.", "steps[3,4] Selected the result"]);
    expect(stepsSummary([{ kind: "tool", id: "1", name: "get_selection", state: "done" }])).toBe("Looked at the selection");
    // Keys stay put as the answer grows (the groups keep open or closed).
    expect(segmentsOf(run(events, { state: "done" })).map((s) => s.key)).toEqual(["text:0", "steps:1", "text:3", "steps:4"]);
  });

  it("while running, the group the turn is in is the thinking line: its running step, else Thinking…; after words a new one", () => {
    // Nothing yet: one running group, empty.
    expect(shape(run([]))).toEqual(["steps[]* Thinking…"]);
    expect(shape(run([{ type: "status", text: "Starting Antigravity…" }]))).toEqual(["steps[]* Starting Antigravity…"]);
    // A step running: its group says what it does; done, the same group thinks on.
    expect(shape(run([tool("1", "get_selection"), tool("2", "get_design_context", "running")]))).toEqual(["steps[1,2]* Reading the design…"]);
    expect(shape(run([tool("1", "get_selection"), tool("2", "get_design_context")]))).toEqual(["steps[1,2]* Thinking…"]);
    // Words after it: that group settles, a new one runs below them under the key the next step's group gets.
    const m = run([tool("1", "get_selection"), { type: "text", delta: "Got it." }]);
    expect(shape(m)).toEqual(["steps[1] Looked at the selection", "text:Got it.", "steps[]* Thinking…"]);
    const next = run([tool("1", "get_selection"), { type: "text", delta: "Got it." }, tool("2", "create_nodes", "running")]);
    expect(segmentsOf(m)[2].key).toBe(segmentsOf(next)[2].key);
    expect(shape(next)).toEqual(["steps[1] Looked at the selection", "text:Got it.", "steps[2]* Creating layers…"]);
    // Over: nothing running, no empty group.
    expect(shape(run([tool("1", "get_selection"), { type: "text", delta: "Done." }], { state: "done" }))).toEqual(["steps[1] Looked at the selection", "text:Done."]);
  });

  it("gives an image its own group, Generate image, with its card and the place_image that puts it on the canvas", () => {
    const g: ChatEvent[] = [tool("1", "get_selection"), { type: "tool", id: "g", name: "generate_image", args: { aspect_ratio: "1:1" }, state: "running" }];
    const making = run(g);
    expect(shape(making)).toEqual(["steps[1] Looked at the selection", "image[g]* Making an image…"]);
    expect(segmentsOf(making)[1]).toMatchObject({ kind: "image", image: { state: "generating" } });
    const made = run([...g, tool("g", "generate_image"), tool("p", "place_image", "running")]);
    expect(shape(made)).toEqual(["steps[1] Looked at the selection", "image[g,p]* Placing the image…"]);
    // place_image's result puts the picture on the card, then the turn ends.
    const placed = { state: "done" as const, parts: turnOver(withPlacedImage(run([...g, tool("g", "generate_image"), tool("p", "place_image"), { type: "text", delta: "Here it is." }]).parts!, { hash: "h", width: 2, height: 2 }), false) };
    expect(shape(placed)).toEqual(["steps[1] Looked at the selection", `image[g,p] ${GENERATE_IMAGE}`, "text:Here it is."]);
    // A failed one: its group, no card.
    const failed = run([tool("g", "generate_image", "running"), { type: "tool", id: "g", name: "generate_image", state: "error", summary: "quota" }], { state: "done" });
    expect(segmentsOf(failed)).toMatchObject([{ kind: "image", label: GENERATE_IMAGE, steps: [{ state: "error" }] }]);
    expect((segmentsOf(failed)[0] as { image?: unknown }).image).toBeUndefined();
    // A picture the agent had, placed: "Place image", with its step.
    const own = withPlacedImage(run([tool("p", "place_image")]).parts!, { hash: "h", width: 1, height: 1 });
    expect(shape({ state: "done", parts: own })).toEqual([`image[p] ${PLACE_IMAGE}`]);
  });

  it("keeps the card put up as the prompt was sent where it is: generate_image and place_image join it there", () => {
    const asked: ImagePart = { kind: "image", id: "image:asked:a", state: "generating", aspect: 1, asked: true };
    const early = run([{ type: "status", text: "Starting Antigravity…" }], { parts: [asked] });
    expect(shape(early)).toEqual([`image[] ${GENERATE_IMAGE}`, "steps[]* Starting Antigravity…"]);
    const m = run([{ type: "text", delta: "Sure." }, tool("1", "get_selection"), { type: "tool", id: "g", name: "generate_image", state: "running" }], { parts: [asked] });
    expect(shape(m)).toEqual(["image[g]* Making an image…", "text:Sure.", "steps[1] Looked at the selection"]);
    expect(segmentsOf(m)[0].key).toBe(segmentsOf(early)[0].key);
    // Made: about to be placed, the image's group is the one thinking.
    const made = run([tool("g", "generate_image")], { parts: m.parts });
    expect(shape(made)).toEqual(["image[g]* Placing the image…", "text:Sure.", "steps[1] Looked at the selection"]);
    const after = run([tool("p", "place_image"), tool("s", "set_selection")], { parts: withPlacedImage(run([tool("p", "place_image")], { parts: made.parts }).parts!, { hash: "h", width: 1, height: 1 }) });
    expect(shape(after)).toEqual([`image[g,p] ${GENERATE_IMAGE}`, "text:Sure.", "steps[1,s]* Thinking…"]);
  });
});

describe("the chat's image card", () => {
  const images = (m: ChatMessage) => (m.parts ?? []).filter((p): p is Extract<MessagePart, { kind: "image" }> => p.kind === "image");

  it("appears right after generate_image starts, at the aspect asked for; made → ready; gone when the step fails", () => {
    const m = run([{ type: "text", delta: "Sure." }, { type: "tool", id: "g", name: "generate_image", args: { aspect_ratio: "16:9" }, state: "running" }]);
    expect(m.parts!.map((p) => p.kind)).toEqual(["text", "tool", "image"]);
    expect(images(m)[0]).toMatchObject({ state: "generating", aspect: 16 / 9 });
    expect(images(run([{ type: "tool", id: "g", name: "generate_image", state: "running" }, { type: "tool", id: "g", name: "generate_image", state: "done" }]))[0].state).toBe("ready");
    expect(images(run([{ type: "tool", id: "g", name: "generate_image", state: "running" }, { type: "tool", id: "g", name: "generate_image", state: "error", summary: "quota" }]))).toEqual([]);
    // Other tools make no card.
    expect(images(run([{ type: "tool", id: "p", name: "place_image", state: "running" }]))).toEqual([]);
  });

  it("shows the picture once place_image put it on the canvas; a picture without generate_image gets a card of its own", () => {
    const m = run([{ type: "tool", id: "g", name: "generate_image", state: "running" }, { type: "tool", id: "g", name: "generate_image", state: "done" }]);
    const placed = withPlacedImage(m.parts!, { hash: "abc", width: 1024, height: 512 });
    expect(placed.filter((p) => p.kind === "image")).toEqual([{ kind: "image", id: "image:g", state: "placed", hash: "abc", width: 1024, height: 512, aspect: 2 }]);
    const alone = withPlacedImage([{ kind: "text", text: "Here." }], { hash: "def", width: 10, height: 10 });
    expect(alone[1]).toMatchObject({ kind: "image", state: "placed", hash: "def" });
    expect(placedInfo({ content: [{ type: "text", text: JSON.stringify({ nodeId: "1:2", imageHash: "abc", imageSize: { width: 3, height: 4 } }) }, { type: "text", text: "not json" }] })).toEqual({ hash: "abc", width: 3, height: 4 });
    expect(placedInfo({ content: [{ type: "text", text: "Done" }] })).toBeNull();
  });

  it("reads the aspect an image request asks for", () => {
    expect(requestedAspect(undefined)).toBe(1);
    expect(requestedAspect({ aspect_ratio: "3:4" })).toBe(0.75);
    expect(requestedAspect({ aspectRatio: "16x9" })).toBeCloseTo(16 / 9);
    expect(requestedAspect({ width: 600, height: 300 })).toBe(2);
    expect(requestedAspect({ aspect_ratio: "100:1" })).toBe(4);
  });
});

describe("a prompt asking for a picture", () => {
  it("is read from the words, English and Turkish", () => {
    const yes = [
      "bu kareye bir kovboy garson resmi koy",
      "Bu Kareye Bir Kovboy Garson RESMİ Koy",
      "Make an image of a cowboy waitress and put it in this frame",
      "One more image, please",
      "generate a picture of a sunset",
      "add a photo of a dog here",
      "a 3D render of a coffee cup",
      "draw a cowboy on a horse",
      "replace the image with a beach photo",
      "bir kedi görseli oluştur",
      "fotoğraf ekle",
      "İllüstrasyon yap",
      "bir kovboy çiz",
      "çizer misin bir at",
      "logo görseli üret",
      "bu çerçeveye manzara fotoğrafı koy",
    ];
    const no = [
      "Make the mobile version of this",
      "add auto layout",
      "rename the layers",
      "delete the image",
      "resmi sil",
      "make the photo bigger",
      "move the picture to the left",
      "what is in this image?",
      "bu görsel nedir",
      "bir dikdörtgen çiz",
      "draw a line under the title",
      "çizgiyi kalınlaştır",
      "",
    ];
    expect(yes.filter((p) => !asksForImage(p))).toEqual([]);
    expect(no.filter((p) => asksForImage(p))).toEqual([]);
  });
});

describe("the canvas placeholder", () => {
  afterEach(() => vi.useRealTimers());

  const at = (x: number, y: number) => ({ m00: 1, m01: 0, m02: x, m10: 0, m11: 1, m12: y });
  const nodes: Record<string, PlaceNode> = {
    "0:1": { type: "CANVAS" },
    "1:1": { type: "FRAME", size: { x: 400, y: 300 }, transform: at(100, 50), parent: "0:1", radius: [8, 8, 8, 8] },
    "1:2": { type: "RECTANGLE", size: { x: 80, y: 40 }, transform: at(10, 20), parent: "1:1" },
    "1:3": { type: "TEXT", size: { x: 80, y: 20 }, transform: at(0, 0), parent: "1:1" },
    "1:4": { type: "FRAME", size: { x: 390, y: 200 }, transform: at(20, 30), parent: "1:1" },
    "1:5": { type: "SECTION", size: { x: 600, y: 400 }, transform: at(1000, 0), parent: "0:1" },
    "1:6": { type: "ELLIPSE", size: { x: 100, y: 50 }, transform: at(0, 500), parent: "0:1" },
    // Turned 90° clockwise about its top left, which sits at (300, 600).
    "1:7": { type: "RECTANGLE", size: { x: 100, y: 50 }, transform: { m00: 0, m01: -1, m02: 300, m10: 1, m11: 0, m12: 600 }, parent: "0:1" },
    "1:8": { type: "GROUP", size: { x: 100, y: 100 }, transform: at(0, 0), parent: "0:1" },
  };
  const env = (selection: string[] = []): PlaceholderEnv => ({ page: "0:1", selection, read: (id) => nodes[id] ?? null, camera: { x: 0, y: 0, zoom: 1 }, viewport: { width: 1000, height: 1000 } });

  it("covers a selected layer that takes a fill — a frame (auto layout or not), a shape — exactly: its bounds, turn and corners", () => {
    expect(placeholderTarget(env(["1:1"]))).toEqual({ page: "0:1", nodeId: "1:1", box: { x: 0, y: 0, width: 400, height: 300 }, world: { x: 100, y: 50, width: 400, height: 300 }, shape: { m: [1, 0, 100, 0, 1, 50], width: 400, height: 300, radius: [8, 8, 8, 8] } });
    expect(placeholderTarget(env(["1:2"]))).toEqual({ page: "0:1", nodeId: "1:2", box: { x: 0, y: 0, width: 80, height: 40 }, world: { x: 110, y: 70, width: 80, height: 40 }, shape: { m: [1, 0, 110, 0, 1, 70], width: 80, height: 40 } });
    // Auto layout: filled too (no child joins its flow).
    expect(placeholderTarget(env(["1:4"]))).toMatchObject({ nodeId: "1:4", world: { x: 120, y: 80, width: 390, height: 200 } });
    expect(placeholderTarget(env(["1:6"]))!.shape).toEqual({ m: [1, 0, 0, 0, 1, 500], width: 100, height: 50, ellipse: true });
    const turned = placeholderTarget(env(["1:7"]))!;
    expect(turned.shape).toEqual({ m: [0, -1, 300, 1, 0, 600], width: 100, height: 50 });
    expect(turned.world).toEqual({ x: 250, y: 600, width: 50, height: 100 });
    expect(targetAspect(turned)).toBe(2);
  });

  it("goes inside a selected section, 512 × 512 fitted and centred; else mid-view", () => {
    expect(placeholderTarget(env(["1:5"]))).toEqual({ page: "0:1", parentId: "1:5", box: { x: 100, y: 0, width: 400, height: 400 }, world: { x: 1100, y: 0, width: 400, height: 400 }, shape: { m: [1, 0, 1100, 0, 1, 0], width: 400, height: 400 } });
    // Text, a group, several layers or none: the middle of the view, 512 at most (60 % of it here).
    const mid = { page: "0:1", parentId: "0:1", box: { x: 244, y: 244, width: 512, height: 512 }, world: { x: 244, y: 244, width: 512, height: 512 }, shape: { m: [1, 0, 244, 0, 1, 244], width: 512, height: 512 } };
    expect(placeholderTarget(env(["1:3"]))).toEqual(mid);
    expect(placeholderTarget(env(["1:8"]))).toEqual(mid);
    expect(placeholderTarget(env(["1:1", "1:2"]))).toEqual(mid);
    expect(targetAspect(placeholderTarget(env()))).toBe(1);
    const zoomed = { ...env(), camera: { x: -500, y: -500, zoom: 2 } };
    expect(placeholderTarget(zoomed, 2)!.box).toEqual({ x: 350, y: 425, width: 300, height: 150 });
    expect(placeholderTarget({ ...env(), page: null })).toBeNull();
  });

  it("takes the aspect generate_image asks for, in the square it had; a filled layer keeps its shape", () => {
    const read = env().read;
    const mid = placeholderTarget(env())!;
    expect(reshapeTarget(mid, 16 / 9, read)).toMatchObject({ box: { x: 244, y: 356, width: 512, height: 288 }, shape: { m: [1, 0, 244, 0, 1, 356] } });
    expect(reshapeTarget(mid, 1, read)).toBe(mid);
    expect(reshapeTarget(placeholderTarget(env(["1:5"]))!, 2, read)).toMatchObject({ parentId: "1:5", box: { x: 100, y: 100, width: 400, height: 200 }, world: { x: 1100, y: 100, width: 400, height: 200 } });
    const fill = placeholderTarget(env(["1:1"]))!;
    expect(reshapeTarget(fill, 2, read)).toBe(fill);
  });

  it("gives place_image its place: the selected layer to fill, unless the agent named another; else the box", () => {
    const ph = new ImagePlaceholders();
    const shape = ph.start("t", placeholderTarget(env(["1:2"])))!;
    expect(placeholderArgs({ path: "a.png" }, shape)).toEqual({ path: "a.png", nodeId: "1:2" });
    // Its own size or place on the page don't make a new layer: the layer is filled.
    expect(placeholderArgs({ path: "a.png", width: 200, x: 0, y: 0 }, shape)).toEqual({ path: "a.png", nodeId: "1:2" });
    expect(placeholderArgs({ path: "a.png", parentId: "1:2" }, shape)).toEqual({ path: "a.png", nodeId: "1:2" });
    // Another layer or parent named: the agent's.
    expect(placeholderArgs({ path: "a.png", nodeId: "9:9" }, shape)).toEqual({ path: "a.png", nodeId: "9:9" });
    expect(placeholderArgs({ path: "a.png", parentId: "1:1" }, shape)).toEqual({ path: "a.png", parentId: "1:1" });
    const inSection = ph.start("t", placeholderTarget(env(["1:5"])))!;
    expect(placeholderArgs({ path: "a.png", width: 200 }, inSection)).toEqual({ path: "a.png", width: 200, parentId: "1:5", __box: { x: 100, y: 0, width: 400, height: 400 } });
    expect(placeholderArgs({ path: "a.png", x: 0 }, inSection)).toEqual({ path: "a.png", x: 0 });
    expect(placeholderArgs({ path: "a.png" }, undefined)).toEqual({ path: "a.png" });
    // In the box: fitted and centred, or at the agent's size centred on it.
    expect(landInBox({ x: 50, y: 0, width: 300, height: 300 }, { width: 1024, height: 512 })).toEqual({ x: 50, y: 75, width: 300, height: 150 });
    expect(landInBox({ x: 50, y: 0, width: 300, height: 300 }, { width: 1024, height: 512 }, { width: 200 })).toEqual({ x: 100, y: 100, width: 200, height: 100 });
  });

  it("lives from the prompt (or generate_image) to place_image, then reveals the picture and goes; fades out on an error or the turn's end", () => {
    vi.useFakeTimers();
    const ph = new ImagePlaceholders();
    const seen: number[] = [];
    ph.subscribe(() => seen.push(ph.list().length));
    // Put up as the prompt was sent (keyed by the answer until the turn has its id), then generate_image shows in it.
    const asked = ph.start("answer", placeholderTarget(env()))!;
    ph.rekey("answer", "t1");
    expect(ph.next("t1")?.id).toBe(asked.id);
    const bound = ph.bind("t1", "g1", (t) => reshapeTarget(t, 2, env().read))!;
    expect(bound).toMatchObject({ id: asked.id, tool: "g1", target: { box: { width: 512, height: 256 } } });
    expect(ph.ofTool("t1", "g1")?.id).toBe(asked.id);
    // A second image of the turn: nothing waiting, a placeholder of its own.
    expect(ph.bind("t1", "g2")).toBeUndefined();
    const b = ph.start("t1", placeholderTarget(env()), "g2")!;
    const c = ph.start("t2", placeholderTarget(env()))!;
    expect(ph.start("t1", null)).toBeNull();
    // The picture landed: the reveal plays over it, then the placeholder goes.
    ph.placed(asked.id);
    expect(ph.list().find((p) => p.id === asked.id)?.state).toBe("revealing");
    expect(ph.next("t1")?.id).toBe(b.id);
    vi.advanceTimersByTime(REVEAL_MS);
    expect(ph.list().map((p) => p.id)).toEqual([b.id, c.id]);
    // generate_image failed: its placeholder fades, then goes.
    ph.fail("t1", "g2");
    expect(ph.list().find((p) => p.id === b.id)?.state).toBe("leaving");
    expect(ph.next("t1")).toBeUndefined();
    vi.advanceTimersByTime(FADE_MS);
    expect(ph.list().map((p) => p.id)).toEqual([c.id]);
    // The turn ended without a picture (done, an error, Stop): what is left fades out.
    ph.end("t2");
    expect(ph.list()[0].state).toBe("leaving");
    ph.placed(c.id); // too late: no reveal
    expect(ph.list()[0].state).toBe("leaving");
    vi.advanceTimersByTime(FADE_MS);
    expect(ph.list()).toEqual([]);
    expect(seen.length).toBeGreaterThanOrEqual(8);
    expect(REVEAL_MS).toBeGreaterThanOrEqual(600);
    expect(REVEAL_MS).toBeLessThanOrEqual(800);
    ph.dispose();
  });
});

describe("the image card put up as the prompt is sent", () => {
  const asked = (extra: Partial<ImagePart> = {}): ImagePart => ({ kind: "image", id: "image:asked:a", state: "generating", aspect: 1, asked: true, ...extra });

  it("shows the CLI's start line under it, then the first generate_image (at its aspect, unless it fills a layer)", () => {
    expect(activityOf(run([{ type: "status", text: "Starting Antigravity…" }], { parts: [asked()] }))).toBe("Starting Antigravity…");
    const m = run([{ type: "status", text: "Starting Antigravity…" }, { type: "text", delta: "Sure." }, { type: "tool", id: "g", name: "generate_image", args: { aspect_ratio: "16:9" }, state: "running" }], { parts: [asked()] });
    expect(m.parts!.map((p) => p.kind)).toEqual(["image", "text", "tool"]);
    expect(m.parts![0]).toMatchObject({ id: "image:asked:a", tool: "g", state: "generating", aspect: 16 / 9 });
    expect(run([{ type: "tool", id: "g", name: "generate_image", args: { aspect_ratio: "16:9" }, state: "running" }], { parts: [asked({ fill: true, aspect: 2 })] }).parts![0]).toMatchObject({ tool: "g", aspect: 2 });
    // Made, then placed.
    const made = run([{ type: "tool", id: "g", name: "generate_image", state: "running" }, { type: "tool", id: "g", name: "generate_image", state: "done" }], { parts: [asked()] });
    expect(made.parts!.filter((p) => p.kind === "image")).toEqual([asked({ tool: "g", state: "ready" })]);
    expect(withPlacedImage(made.parts!, { hash: "abc", width: 4, height: 4 })[0]).toMatchObject({ id: "image:asked:a", state: "placed", hash: "abc" });
    // A placed picture without generate_image (an image the agent had) fills the card too.
    expect(withPlacedImage([asked()], { hash: "def", width: 4, height: 2 })).toEqual([asked({ state: "placed", hash: "def", width: 4, height: 2, aspect: 2 })]);
  });

  it("is cancelled (fades out) when the turn ends without the agent starting an image; one it started is not placed", () => {
    expect(turnOver([asked(), { kind: "text", text: "Done." }], false)).toEqual([asked({ state: "cancelled" }), { kind: "text", text: "Done." }]);
    expect(turnOver([asked({ tool: "g" }), { kind: "tool", id: "g", name: "generate_image", state: "running" }], true)).toEqual([asked({ tool: "g", state: "failed" }), { kind: "tool", id: "g", name: "generate_image", state: "error" }]);
    expect(turnOver([asked({ state: "placed", hash: "x" }), { kind: "status", text: "…" }], false)).toEqual([asked({ state: "placed", hash: "x" })]);
  });
});
