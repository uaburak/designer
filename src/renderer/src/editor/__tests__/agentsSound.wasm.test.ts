// @vitest-environment happy-dom
// Sound for motion (docs/motion.md §9.3) on the real engine and the Figma logo fixture: `generate_sound` synthesises
// recipes locally, stores each as a WAV in the file's store and puts it on the timeline with its sync point on the given
// time (one undo step for the call), named rows by kind, volumes by kind; `place: false` hands back WAV files;
// `score_motion` reads an `animate` script's motion back as events at the script's times; `get_sound_mix` measures it.
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
import { timelineOf } from "../motion/publicApi";
import MOTION_LOGO_DOCUMENT from "../motion/fixtures/figma-logo-motion.json";

const wasm = join(process.cwd(), "src/renderer/src/engine/wasm/engine.wasm");
const FRAME = "1:1";

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
type Added = { id: string; name: string; row: string; type: string; offset: number; sync: number; duration: number; trimStart?: number; volumeDb: number };

describe("agents' sound tools", () => {
  it("are listed: generate_sound writes, score_motion and get_sound_mix read", () => {
    expect(TOOL_BY_NAME.get("generate_sound")).toMatchObject({ write: true });
    expect(TOOL_BY_NAME.get("score_motion")).toMatchObject({ write: false });
    expect(TOOL_BY_NAME.get("get_sound_mix")).toMatchObject({ write: false });
  });

  it("generates sounds, stores them, places each sync point on its time, in one undo step", async () => {
    const { ed, engine, call } = await editor();
    json(await call("set_timeline", { nodeId: FRAME, duration: 4 }));
    const before = timelineOf(ed, FRAME)!.audio.length;
    const r = json(
      await call("generate_sound", {
        nodeId: FRAME,
        sounds: [
          { type: "whoosh", at: 1, duration: 1, name: "Card whoosh" },
          { preset: "hit.punch", at: 2 },
          { type: "pop", at: 2.6, seed: 4 },
          { type: "riser", at: 1, duration: 2 },
          { preset: "music.calm" },
        ],
      }),
    );
    const added = r.added as Added[];
    expect(added).toHaveLength(5);
    const [whoosh, hit, pop, riser, bed] = added;
    // The whoosh's peak (55 % of it) on 1 s; the hit's transient on 2 s.
    expect(whoosh).toMatchObject({ name: "Card whoosh", row: "Whooshes", type: "whoosh", sync: 1, volumeDb: -9 });
    expect(whoosh.offset).toBeCloseTo(0.45, 2);
    expect(hit).toMatchObject({ name: "Hit punch", row: "Hits", sync: 2, volumeDb: -6 });
    expect(pop).toMatchObject({ row: "UI", volumeDb: -10 });
    // A riser ending on 1 s would start before 0: it starts at 0, trimmed by 1 s.
    expect(riser).toMatchObject({ offset: 0, trimStart: 1, sync: 1, row: "Risers" });
    // The bed runs the timeline's length.
    expect(bed).toMatchObject({ offset: 0, duration: 4, row: "Music", volumeDb: -18 });

    const model = timelineOf(ed, FRAME)!;
    expect(model.audio.length).toBe(before + 5);
    const clip = model.audio.find((a) => a.id === whoosh.id)!;
    expect(clip.volume).toBeCloseTo(Math.pow(10, -9 / 20), 3);
    expect(model.audioTracks.find((t) => t.id === clip.trackId)!.name).toBe("Whooshes");
    expect(model.audio.find((a) => a.id === riser.id)!.startUs).toBe(1_000_000);
    // Stored like a dropped WAV: in the file's store by hash.
    const bytes = await ed.images.store!.get(clip.mediaHash);
    expect(bytes).toBeTruthy();
    expect(String.fromCharCode(...bytes!.slice(0, 4))).toBe("RIFF");

    // A second call: a whoosh that doesn't overlap shares the row; one that does gets "Whooshes 2".
    const again = json(await call("generate_sound", { nodeId: FRAME, sounds: [{ preset: "swoosh", at: 3.5 }, { type: "whoosh", at: 1.1 }] })).added as Added[];
    expect(again[0].row).toBe("Whooshes");
    expect(again[1].row).toBe("Whooshes 2");

    // One undo per call.
    engine.command("UNDO");
    expect(timelineOf(ed, FRAME)!.audio.length).toBe(before + 5);
    engine.command("UNDO");
    expect(timelineOf(ed, FRAME)!.audio.length).toBe(before);
  });

  it("saves WAV files with place: false, and explains a bad recipe", async () => {
    const { call } = await editor();
    const r = await call("generate_sound", { place: false, sounds: [{ preset: "chime.success", key: "A minor", name: "Done" }] });
    const out = json(r);
    expect(out.files[0]).toMatchObject({ file: "Done.wav" });
    expect(r.files?.[0]).toMatchObject({ name: "Done.wav", mimeType: "audio/wav" });
    expect(atob(r.files![0].data).slice(0, 4)).toBe("RIFF");
    const bad = await call("generate_sound", { nodeId: FRAME, sounds: [{ type: "laser" }] });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toContain("sounds[0].type");
  });

  it("scores an animate script's motion at the script's times", async () => {
    const { call } = await editor();
    // Layers of their own (the fixture's logo parts have motion already).
    json(await call("create_nodes", { parentId: FRAME, nodes: [{ type: "RECTANGLE", name: "Box", x: 10, y: 10, width: 120, height: 120 }, { type: "RECTANGLE", name: "Badge", x: 10, y: 150, width: 60, height: 60 }] }));
    json(
      await call("animate", {
        nodeId: FRAME,
        timeline: { duration: 4 },
        tweens: [
          { targets: "Box", from: { x: -200 }, duration: 0.6, ease: "power2.out", position: 0 },
          { targets: ["Red", "Purple", "Blue"], fromTo: [{ opacity: 0 }, { opacity: 1 }], duration: 0.3, stagger: 0.1, position: 1 },
          { targets: "Badge", fromTo: [{ scale: 0.5 }, { scale: 1 }], duration: 0.5, ease: "back.out(1.7)", position: 2 },
        ],
      }),
    );
    const s = json(await call("score_motion", { nodeId: FRAME }));
    const ev = (type: string, layer: string) => (s.events as { type: string; layer?: string; t: number; end?: number; peak?: number; layers?: string[]; step?: number }[]).filter((e) => e.type === type && e.layer === layer);
    const move = ev("move", "Box")[0];
    expect(move.t).toBe(0);
    expect(move.end).toBeCloseTo(0.6, 2);
    // power2.out: fastest at its start (the engine's samples say so).
    expect(move.peak!).toBeLessThan(0.2);
    expect(ev("arrive", "Box").some((e) => Math.abs(e.t - 0.6) < 0.002)).toBe(true);
    expect(ev("appear", "Red")[0].t).toBeCloseTo(1, 2);
    const group = (s.events as { type: string; grouping?: string; layers?: string[]; step?: number; t: number }[]).find((e) => e.type === "stagger" && e.grouping === "LAYERS" && e.t === 1)!;
    expect(group).toMatchObject({ t: 1, step: 0.1, layers: ["Red", "Purple", "Blue"] });
    const pop = ev("pop", "Badge")[0];
    expect(pop.t).toBeGreaterThan(2.1);
    expect(pop.t).toBeLessThan(2.5);
    expect(s.duration).toBe(4);
    // Nothing past the timeline's end.
    expect(Math.max(...s.events.map((e: { t: number }) => e.t))).toBeLessThanOrEqual(4);
    expect(s.cues.length).toBeGreaterThan(0);
  });

  it("measures the mix it made", async () => {
    const { call } = await editor();
    json(await call("set_timeline", { nodeId: FRAME, duration: 3 }));
    json(await call("generate_sound", { nodeId: FRAME, sounds: [{ preset: "music.uplifting" }, { type: "impact", at: 1 }] }));
    const m = json(await call("get_sound_mix", { nodeId: FRAME }));
    expect(m.seconds).toHaveLength(3);
    expect(m.notHeard).toEqual([]);
    expect(m.beds).toEqual(["Music uplifting"]);
    expect(m.peakDb).toBeLessThan(0);
    expect(m.peakDb).toBeGreaterThan(-20);
    // The hit's second is the loudest.
    expect(m.seconds[1].peakDb).toBeGreaterThan(m.seconds[0].peakDb);
  });
});
