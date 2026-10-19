// @vitest-environment happy-dom
// Round 8e on the real engine (the committed Wasm build, the Figma logo fixture; docs/motion.md §4.11, §7.5, §7.6):
// audio added, edited, split and deleted through the commands and listed in the timeline model; the Audio section's
// Mute; the shapes and samples the vector exports read, and the Lottie and SVG files built from them; the Animated
// tab's settings stored on the frame.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { beforeAll, describe, expect, it } from "vitest";
import type { Message } from "@/engine/codec";
import { Engine } from "@/engine/Engine";
import { EngineStore } from "@/engine/EngineStore";
import { loadEngine } from "@/engine/loadEngine";
import { $, click, mount } from "../../../ds/__tests__/dom";
import { EditorContext, EditorController } from "../../controller";
import { setMode } from "../../devmode/devMode";
import { memoryDocumentSource } from "../../documentSource";
import { exportSettingsOf } from "../../model/exports";
import { removeAudio, splitAudioAtPlayhead, timelineModel } from "../audio/audioEdits";
import MOTION_LOGO_DOCUMENT from "../fixtures/figma-logo-motion.json";
import { animatedSettingOf, writeAnimatedSetting } from "../export/animatedSettings";
import { planFrames } from "../export/frames";
import { writeLottie } from "../export/lottie/lottie";
import { writeAnimatedSvg } from "../export/svg";
import { sampleScene } from "../export/vectorAnim";
import { setMotionUi, setPlayhead } from "../motionState";
import { AudioSection } from "../panels/AudioSection";

const wasm = join(process.cwd(), "src/renderer/src/engine/wasm/engine.wasm");
const RED = "1:2";

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
  engine.setSelection([RED]);
  setMode(ed, "motion");
  return { ed, engine, root: engine.motionTimeline(RED)!.root };
}

describe("round 8e on the engine", () => {
  it("audio: added on its own row, split at the playhead, muted from the Audio section, deleted — each one undo step", async () => {
    const { ed, engine, root } = await editor();
    const r = engine.runMotionCommandCreating("MOTION_ADD_AUDIO", { root, mediaHash: "ab".repeat(20), name: "Beat", offsetUs: 0, durationUs: 2_000_000 });
    expect(r.created).toHaveLength(1);
    let model = timelineModel(ed)!;
    expect(model.audioTracks.map((t) => t.name)).toEqual(["Beat"]);
    expect(model.audio[0]).toMatchObject({ id: r.created[0], offsetUs: 0, startUs: 0, durationUs: 2_000_000, volume: 1, mute: false });
    // ⌥K at 500 ms: two regions of the file, the new one selected.
    setPlayhead(ed, 500_000);
    splitAudioAtPlayhead(ed);
    model = timelineModel(ed)!;
    expect(model.audio.map((c) => [c.offsetUs, c.startUs, c.durationUs])).toEqual([[0, 0, 500_000], [500_000, 500_000, 1_500_000]]);
    // The Audio section mutes the selected one.
    setMotionUi(ed, { selectedAudio: model.audio[1].id });
    const view = mount(() => createElement(EditorContext.Provider, { value: ed }, createElement(AudioSection)), {});
    expect($("[data-audio-section]", view.host)).not.toBeNull();
    click($('[data-audio-section] input[type="checkbox"]', view.host));
    expect(timelineModel(ed)!.audio[1].mute).toBe(true);
    view.unmount();
    removeAudio(ed, [model.audio[0].id, model.audio[1].id]);
    expect(timelineModel(ed)!.audio).toHaveLength(0);
    expect(timelineModel(ed)!.audioTracks).toHaveLength(0);
    engine.command("UNDO");
    expect(timelineModel(ed)!.audio).toHaveLength(2);
    engine.destroy();
  });

  it("the vector exports: the logo's shapes and samples as a Lottie animation and an animated SVG", async () => {
    const { ed, engine, root } = await editor();
    const tl = engine.motionTimeline(root)!;
    const plan = planFrames(tl.durationUs, tl.playback, 10)!;
    const scene = sampleScene(ed, root, plan, tl.durationUs, tl.playback)!;
    expect(scene).not.toBeNull();
    expect(scene.root.shape.node).toBe(root);
    expect(scene.root.frames).toHaveLength(plan.frames + 1);
    const lottie = writeLottie(scene, { name: "Logo", scale: 1, rasters: new Map() }) as { op: number; layers: { ks: { o: { a: number }; p: { a: number } } }[] };
    expect(lottie.op).toBe(plan.frames);
    // Something moves or fades over time.
    expect(lottie.layers.some((l) => l.ks.o.a === 1 || l.ks.p.a === 1)).toBe(true);
    const svg = writeAnimatedSvg(scene, { scale: 1, playback: tl.playback, durationMs: plan.rangeUs / 1000, rasters: new Map() });
    expect(svg).toContain("@keyframes");
    expect(svg).toContain(`id="n-${RED.replace(":", "-")}"`);
    engine.destroy();
  });

  it("the Animated tab's settings live on the frame, apart from its static export rows", async () => {
    const { ed, engine, root } = await editor();
    expect(animatedSettingOf(ed, root)).toBeNull();
    writeAnimatedSetting(ed, [root], { format: "LOTTIE", size: { scale: 2 }, fps: 24, quality: "HIGH", loop: true });
    expect(animatedSettingOf(ed, root)).toEqual({ format: "LOTTIE", size: { scale: 2 }, fps: 24, quality: "HIGH", loop: true });
    expect(exportSettingsOf(engine.readNode(root) as { exportSettings?: unknown })).toEqual([]);
    engine.command("UNDO");
    expect(animatedSettingOf(ed, root)).toBeNull();
    engine.destroy();
  });
});
