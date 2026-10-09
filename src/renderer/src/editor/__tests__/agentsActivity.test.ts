// The chat while an agent works: the Thinking… row's line and seconds (activity.ts), the image card's states
// (service.ts applyEvent / withPlacedImage), and the canvas placeholder's place and life (imagePlaceholder.ts).
import { afterEach, describe, expect, it, vi } from "vitest";
import { activityOf, elapsedLabel, requestedAspect, THINKING, toolActiveLabel } from "../agents/activity";
import { FADE_MS, ImagePlaceholders, landInBox, placeholderArgs, placeholderTarget, type PlaceholderEnv, type PlaceNode } from "../agents/imagePlaceholder";
import { applyEvent, placedInfo, withPlacedImage, type ChatMessage, type MessagePart } from "../agents/service";
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
    expect(toolActiveLabel("view_file")).toBe("View file…");
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

describe("the canvas placeholder", () => {
  afterEach(() => vi.useRealTimers());

  const nodes: Record<string, PlaceNode> = {
    "0:1": { type: "CANVAS" },
    "1:1": { type: "FRAME", size: { x: 400, y: 300 }, transform: { m00: 1, m01: 0, m02: 100, m10: 0, m11: 1, m12: 50 }, parent: "0:1" },
    "1:2": { type: "RECTANGLE", size: { x: 80, y: 40 }, transform: { m00: 1, m01: 0, m02: 10, m10: 0, m11: 1, m12: 20 }, parent: "1:1" },
    "1:3": { type: "TEXT", size: { x: 80, y: 20 }, transform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 }, parent: "1:1" },
    "1:4": { type: "FRAME", autoLayout: true, size: { x: 390, y: 200 }, transform: { m00: 1, m01: 0, m02: 20, m10: 0, m11: 1, m12: 30 }, parent: "1:1" },
  };
  const env = (selection: string[] = []): PlaceholderEnv => ({ page: "0:1", selection, read: (id) => nodes[id] ?? null, camera: { x: 0, y: 0, zoom: 1 }, viewport: { width: 1000, height: 1000 } });

  it("goes inside a selected frame, 512 × 512 fitted and centred; over a selected shape (filling it); else mid-view", () => {
    expect(placeholderTarget(env(["1:1"]))).toEqual({ page: "0:1", parentId: "1:1", box: { x: 50, y: 0, width: 300, height: 300 }, world: { x: 150, y: 50, width: 300, height: 300 } });
    expect(placeholderTarget(env(["1:2"]))).toEqual({ page: "0:1", nodeId: "1:2", box: { x: 0, y: 0, width: 80, height: 40 }, world: { x: 110, y: 70, width: 80, height: 40 } });
    // An auto layout frame: beside it on the page (a child would join its flow), as tall as it.
    expect(placeholderTarget(env(["1:4"]))).toEqual({ page: "0:1", parentId: "0:1", box: { x: 550, y: 80, width: 200, height: 200 }, world: { x: 550, y: 80, width: 200, height: 200 } });
    // Text, several layers or none: the middle of the view, 512 at most (60 % of it here).
    expect(placeholderTarget(env(["1:3"]))).toEqual({ page: "0:1", parentId: "0:1", box: { x: 244, y: 244, width: 512, height: 512 }, world: { x: 244, y: 244, width: 512, height: 512 } });
    const zoomed = { ...env(), camera: { x: -500, y: -500, zoom: 2 } };
    expect(placeholderTarget(zoomed, 2)!.box).toEqual({ x: 250 + 250 - 150, y: 250 + 250 - 75, width: 300, height: 150 });
    expect(placeholderTarget({ ...env(), page: null })).toBeNull();
  });

  it("gives place_image its place unless the agent named one", () => {
    const ph = new ImagePlaceholders();
    const inFrame = ph.start("t", placeholderTarget(env(["1:1"])))!;
    expect(placeholderArgs({ path: "a.png", width: 200 }, inFrame)).toEqual({ path: "a.png", width: 200, parentId: "1:1", __box: { x: 50, y: 0, width: 300, height: 300 } });
    expect(placeholderArgs({ path: "a.png", x: 0 }, inFrame)).toEqual({ path: "a.png", x: 0 });
    expect(placeholderArgs({ path: "a.png" }, undefined)).toEqual({ path: "a.png" });
    const shape = ph.start("t", placeholderTarget(env(["1:2"])))!;
    expect(placeholderArgs({ path: "a.png" }, shape)).toEqual({ path: "a.png", nodeId: "1:2" });
    // In the box: fitted and centred, or at the agent's size centred on it.
    expect(landInBox({ x: 50, y: 0, width: 300, height: 300 }, { width: 1024, height: 512 })).toEqual({ x: 50, y: 75, width: 300, height: 150 });
    expect(landInBox({ x: 50, y: 0, width: 300, height: 300 }, { width: 1024, height: 512 }, { width: 200 })).toEqual({ x: 100, y: 100, width: 200, height: 100 });
  });

  it("lives from generate_image to place_image; fades out on an error or the turn's end; per turn, oldest first", () => {
    vi.useFakeTimers();
    const ph = new ImagePlaceholders();
    const seen: number[] = [];
    ph.subscribe(() => seen.push(ph.list().length));
    const a = ph.start("t1", placeholderTarget(env()))!;
    const b = ph.start("t1", placeholderTarget(env()))!;
    const c = ph.start("t2", placeholderTarget(env()))!;
    expect(ph.start("t1", null)).toBeNull();
    expect(ph.next("t1")).toBe(a);
    ph.placed(a.id);
    expect(ph.list().map((p) => p.id)).toEqual([b.id, c.id]);
    expect(ph.next("t1")).toBe(b);
    // generate_image failed: the newest of the turn fades, then goes.
    ph.fail("t1");
    expect(ph.list().find((p) => p.id === b.id)?.state).toBe("leaving");
    expect(ph.next("t1")).toBeUndefined();
    vi.advanceTimersByTime(FADE_MS);
    expect(ph.list().map((p) => p.id)).toEqual([c.id]);
    // Stop / done / error: what is left fades out.
    ph.end("t2");
    expect(ph.list()[0].state).toBe("leaving");
    vi.advanceTimersByTime(FADE_MS);
    expect(ph.list()).toEqual([]);
    expect(seen.length).toBeGreaterThanOrEqual(6);
    ph.dispose();
  });
});
