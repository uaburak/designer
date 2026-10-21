// @vitest-environment happy-dom
// Motion for agents, phase 1 (docs/research/motion-for-agents.md, docs/motion.md §9.2) on the real engine and the Figma logo
// fixture: `animate` turns a GSAP-like script into native keyframe tracks (targets by name and path, stagger, "<",
// eases mapped, an XY track's other axis kept, rotate clockwise, skew and an arc through Wecra's fields, a layer blur
// added, a text split into characters with its own stagger, repeat, one undo step), `get_motion_frames` shows the
// timeline as a contact sheet or frames at the right times, and the result exports as GIF and Lottie.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { Message } from "@/engine/codec";
import { Engine } from "@/engine/Engine";
import { EngineStore } from "@/engine/EngineStore";
import { loadEngine } from "@/engine/loadEngine";
import { TOOL_BY_NAME, type ToolResult } from "@shared/agents/tools";
import { EditorController } from "../controller";
import { memoryDocumentSource } from "../documentSource";
import { runTool, type ToolEnv } from "../agents/mcpTools";
import { AgentTurns } from "../agents/turns";
import MOTION_LOGO_DOCUMENT from "../motion/fixtures/figma-logo-motion.json";

const wasm = join(process.cwd(), "src/renderer/src/engine/wasm/engine.wasm");
const FRAME = "1:1";
const RED = "1:2";
const ORANGE = "1:3";
const PURPLE = "1:4";
const BLUE = "1:5";
const GREEN = "1:6";

beforeAll(async () => {
  globalThis.fetch = async () => new Response(null, { status: 404 });
  const bytes = readFileSync(wasm);
  await loadEngine({ wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), printErr: () => {} });
});

async function editor() {
  const source = memoryDocumentSource(MOTION_LOGO_DOCUMENT as unknown as Message, { fileName: "Figma logo · Motion" });
  const engine = await Engine.create(null, { sessionID: 1 });
  engine.load(await source.load());
  engine.setViewport(1280, 800, 1, 1280, 800);
  const ed = new EditorController(engine, new EngineStore(engine), source);
  const turns = new AgentTurns(ed);
  const env: ToolEnv = { ed, write: (_l, fn, refs) => turns.write(null, "Claude Code", fn, refs) };
  const call = async (name: string, args: Record<string, unknown>) => runTool(env, name, args);
  return { ed, engine, call };
}

const text = (r: ToolResult) => r.content.map((c) => (c.type === "text" ? c.text : "")).join("");
const json = (r: ToolResult) => {
  expect(r.isError, text(r)).toBeFalsy();
  return JSON.parse(text(r));
};
const error = (r: ToolResult) => {
  expect(r.isError, text(r)).toBe(true);
  return text(r);
};
type Track = { keyframes: { timelinePosition: number; value: { type: string; value: number | { x: number; y: number } }; easing?: { type: string } }[] };
const layer = async (call: (n: string, a: Record<string, unknown>) => Promise<ToolResult>, id: string) => json(await call("get_motion", { nodeId: FRAME })).layers.find((l: { id: string }) => l.id === id) as { manualKeyframeTracks: Record<string, Track> & { effects?: Record<number, Record<string, Track>> } } | undefined;
const times = (t: Track) => t.keyframes.map((k) => Math.round(k.timelinePosition * 1000) / 1000);
const values = (t: Track) => t.keyframes.map((k) => (typeof k.value.value === "number" ? Math.round(k.value.value * 1000) / 1000 : k.value.value));
const png = (b64: string) => {
  const b = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const v = new DataView(b.buffer);
  return { sig: String.fromCharCode(...b.slice(1, 4)), width: v.getUint32(16), height: v.getUint32(20) };
};

describe("agents' animate tool", () => {
  it("is listed: animate writes, get_motion_frames reads", () => {
    expect(TOOL_BY_NAME.get("animate")).toMatchObject({ write: true });
    expect(TOOL_BY_NAME.get("get_motion_frames")).toMatchObject({ write: false });
  });

  it("compiles a GSAP-like script into native tracks in one undo step", async () => {
    const { engine, call } = await editor();
    const before = times((await layer(call, ORANGE))!.manualKeyframeTracks.OPACITY);
    const r = json(
      await call("animate", {
        nodeId: FRAME,
        defaults: { duration: 0.5, ease: "power3.out" },
        tweens: [
          { targets: ["Orange", "Purple"], from: { opacity: 0, y: 40 }, stagger: 0.2, label: "in" },
          { targets: "Green", to: { rotate: 90, skewX: 10 }, duration: 1, ease: "back.out(1.7)", position: "<" },
          { targets: BLUE, fromTo: [{ arcEnd: 0 }, { arcEnd: 360 }], ease: "none", position: "in+=0.5" },
          { targets: "Red", to: { x: 50 }, position: ">" },
        ],
      }),
    );
    expect(r.tweens.map((t: { start: number; end: number }) => [t.start, t.end])).toEqual([[0, 0.7], [0, 1], [0.5, 1], [1, 1.5]]);
    expect(r.labels).toEqual({ in: 0 });
    const orange = (await layer(call, ORANGE))!.manualKeyframeTracks;
    const purple = (await layer(call, PURPLE))!.manualKeyframeTracks;
    expect(times(orange.OPACITY)).toEqual([0, 0.5]);
    expect(values(orange.OPACITY)).toEqual([0, 1]);
    expect(times(purple.OPACITY)).toEqual([0.2, 0.7]);
    expect(values(purple.TRANSLATION_Y)).toEqual([40, 0]);
    expect(purple.OPACITY.keyframes[0].easing?.type).toBe("HOLD");
    expect(purple.OPACITY.keyframes[1].easing?.type).toBe("CUSTOM_CUBIC_BEZIER");
    // rotate is CSS's (clockwise +): Wecra's ROTATION is counter-clockwise +; skew through MOTION_SHEAR (tan 10°).
    const green = (await layer(call, GREEN))!.manualKeyframeTracks;
    expect(values(green.ROTATION)).toEqual([0, -90]);
    expect(values(green.MOTION_SHEAR)[1]).toBeCloseTo(Math.tan((10 * Math.PI) / 180), 3);
    const blue = (await layer(call, BLUE))!.manualKeyframeTracks;
    expect(values(blue.ARC_DATA_ENDING_ANGLE)[1]).toBeCloseTo(2 * Math.PI, 3);
    // Red had a combined Position track: x is written as its own track, its y kept as one.
    const red = (await layer(call, RED))!.manualKeyframeTracks;
    expect(red.TRANSLATION_XY).toBeUndefined();
    expect(values(red.TRANSLATION_X).at(-1)).toBe(50);
    expect(red.TRANSLATION_Y.keyframes.length).toBeGreaterThan(1);
    // One undo step takes the whole script back.
    engine.command("UNDO");
    expect(times((await layer(call, ORANGE))!.manualKeyframeTracks.OPACITY)).toEqual(before);
    expect((await layer(call, RED))!.manualKeyframeTracks.TRANSLATION_XY).toBeDefined();
  });

  it("plays what it wrote: the motion layer at a time matches the script", async () => {
    const { engine, call } = await editor();
    json(await call("animate", { nodeId: FRAME, tweens: [{ targets: "Orange", fromTo: [{ opacity: 0 }, { opacity: 1 }], duration: 1, ease: "none" }, { targets: "Blue", to: { arcEnd: 180 }, duration: 1, ease: "none", position: 0 }] }));
    engine.setMotion({ on: true, root: FRAME, timeUs: 250_000, autoKeyframe: false, showMotionPath: false } as never);
    const o = engine.readNode(ORANGE, { fields: ["opacity"] }) as { opacity?: number };
    expect(o.opacity).toBeCloseTo(0.25, 2);
    const b = engine.readNode(BLUE, { fields: ["arcData"] }) as { arcData?: { endingAngle: number } };
    expect(b.arcData?.endingAngle).toBeCloseTo(Math.PI / 4, 2);
    engine.setMotion({ on: false } as never);
  });

  it("adds a layer blur for blur, splits a text into characters, repeats, sets the timeline", async () => {
    const { engine, call } = await editor();
    const made = json(await call("create_nodes", { parentId: FRAME, nodes: [{ type: "TEXT", name: "Title", characters: "Hello motion", x: 20, y: 20 }] }));
    const title = made.created[0].id as string;
    const r = json(
      await call("animate", {
        nodeId: FRAME,
        timeline: { duration: 4, playback: "LOOP" },
        tweens: [
          { targets: "Title", split: "chars", from: { opacity: 0, y: 12 }, stagger: 0.04, duration: 0.4 },
          { targets: "Orange", from: { blur: 12 }, duration: 0.6, position: 0 },
          { targets: "Green", to: { scale: 1.2 }, duration: 0.5, ease: "sine.inOut", yoyo: true, repeat: -1, position: 1 },
        ],
      }),
    );
    expect(r.timeline).toMatchObject({ duration: 4, playback: "LOOP" });
    const t = engine.readNode(title, { fields: ["textElementDelayBehaviour"] }) as { textElementDelayBehaviour?: { enabled?: boolean; delayMs?: number; grouping?: string } };
    expect(t.textElementDelayBehaviour).toMatchObject({ enabled: true, delayMs: 40, grouping: "CHARACTER_NO_WHITESPACE" });
    // 11 characters (the space doesn't count): the span holds the last one.
    expect(r.tweens[0].end).toBeCloseTo(0.4 + 10 * 0.04, 3);
    const orange = engine.readNode(ORANGE, { fields: ["effects"] }) as { effects?: { type: string; radius: number }[] };
    expect(orange.effects?.some((e) => e.type === "FOREGROUND_BLUR")).toBe(true);
    const o = (await layer(call, ORANGE))!.manualKeyframeTracks;
    expect(o.effects).toBeDefined();
    const radius = Object.values(o.effects!)[0].RADIUS;
    expect(values(radius)).toEqual([12, 0]);
    const g = (await layer(call, GREEN))!.manualKeyframeTracks.SCALE_XY;
    expect(times(g)).toEqual([1, 1.5, 2, 2.5, 3, 3.5, 4]);
    expect(g.keyframes.map((k) => Math.round((k.value.value as { x: number }).x * 1000) / 1000)).toEqual([1, 1.2, 1, 1.2, 1, 1.2, 1]);
  });

  it("explains what it can't do: a bad ease, an unknown property, a target that matches nothing, the frame itself", async () => {
    const { call } = await editor();
    expect(error(await call("animate", { nodeId: FRAME, tweens: [{ targets: "Red", to: { x: 1 }, ease: "wobbly" }] }))).toContain("ease");
    expect(error(await call("animate", { nodeId: FRAME, tweens: [{ targets: "Red", to: { spin: 1 } }] }))).toContain("spin");
    const w = json(await call("animate", { nodeId: FRAME, tweens: [{ targets: ["Nothing here", FRAME, "Red"], to: { opacity: 0.5 } }] }));
    expect(w.warnings.join("\n")).toContain('no layer named "Nothing here"');
    expect(w.warnings.join("\n")).toContain("top-level frame");
    expect(Object.keys(w.layers)).toEqual([RED]);
    expect(error(await call("animate", { nodeId: FRAME, tweens: [{ targets: "Red", to: { x: 1 }, repeat: -1 }] }))).toContain("timeline.duration");
  });
});

describe("agents' get_motion_frames", () => {
  it("draws a contact sheet at evenly spread times, frames at chosen times, and a GIF on request", async () => {
    const { call } = await editor();
    json(await call("animate", { nodeId: FRAME, timeline: { duration: 2 }, tweens: [{ targets: "Red", fromTo: [{ opacity: 0 }, { opacity: 1 }], duration: 2, ease: "none" }] }));
    const sheet = await call("get_motion_frames", { nodeId: FRAME, count: 5, maxSize: 600 });
    expect(sheet.isError).toBeFalsy();
    const imgs = sheet.content.filter((c) => c.type === "image");
    expect(imgs).toHaveLength(1);
    const info = JSON.parse(text(sheet));
    expect(info.times).toEqual([0, 0.5, 1, 1.5, 2]);
    expect(info.grid.columns * info.grid.rows).toBeGreaterThanOrEqual(5);
    const p = png((imgs[0] as { data: string }).data);
    expect(p.sig).toBe("PNG");
    expect(Math.max(p.width, p.height)).toBeLessThanOrEqual(600);
    expect(p.width).toBeGreaterThan(100);

    const frames = await call("get_motion_frames", { nodeId: RED, times: [0, 2, 2], sheet: false, maxSize: 128 });
    const f = frames.content.filter((c) => c.type === "image") as { data: string }[];
    expect(f).toHaveLength(3);
    expect(JSON.parse(text(frames)).times).toEqual([0, 2, 2]);
    // The same time draws the same picture (the pixels themselves need a GPU: node draws blank frames of the right size).
    expect(f[1].data).toBe(f[2].data);
    expect(png(f[0].data).width).toBeLessThanOrEqual(128);

    const gif = await call("get_motion_frames", { nodeId: FRAME, count: 2, gif: true });
    expect(gif.files?.[0]).toMatchObject({ mimeType: "image/gif" });
    expect(atob(gif.files![0].data).slice(0, 6)).toBe("GIF89a");
    expect(error(await call("get_motion_frames", { nodeId: FRAME, times: Array(30).fill(0) }))).toContain("at most 24");
  });

  it("an animate script's result exports as GIF and as Lottie with its keyframes", async () => {
    const { call } = await editor();
    json(await call("create_nodes", { parentId: FRAME, nodes: [{ type: "RECTANGLE", name: "Box", x: 150, y: 250, width: 100, height: 100, fills: [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }] }] }));
    // The end held 0.5 s, played once.
    json(await call("animate", { nodeId: FRAME, timeline: { duration: 1.5, playback: "ONCE" }, tweens: [{ targets: "Orange", from: { opacity: 0 } }, { targets: "Box", to: { rotate: 90 }, duration: 1, ease: "power2.inOut", position: 0 }] }));
    const gif = await call("export_animation", { nodeId: FRAME, format: "GIF", scale: 0.25, fps: 24 });
    expect(atob(gif.files![0].data).slice(0, 6)).toBe("GIF89a");
    const lottie = JSON.parse(atob((await call("export_animation", { nodeId: FRAME, format: "LOTTIE", fps: 24 })).files![0].data));
    expect(lottie).toMatchObject({ v: "5.7.0", fr: 24, op: 36 });
    // Box turns 90° clockwise (Lottie's rotation is clockwise +, as the script's), reached at 1 s and held.
    type L = { nm: string; ks: { r: { a: number; k: { t: number; s: number[] }[] } }; layers?: L[] };
    const all: L[] = [];
    const walk = (ls: L[]) => ls.forEach((l) => (all.push(l), l.layers && walk(l.layers)));
    walk(lottie.layers);
    const box = all.find((l) => l.nm === "Box")!;
    expect(box.ks.r.a).toBe(1);
    const k = box.ks.r.k;
    expect(k[0].s[0]).toBeCloseTo(0, 3);
    expect(k[k.length - 1].s[0]).toBeCloseTo(90, 1);
    expect(k.every((f) => f.t <= 24 || Math.abs(f.s[0] - 90) < 0.01)).toBe(true);
  });
});
