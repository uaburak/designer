// @vitest-environment happy-dom
// Motion through a `.fig` (docs/motion.md §9; round 8f): the Figma logo fixture with every kind of motion data the
// commands write — manual tracks, a preset clip, a composite style, a timeline's settings, an anchor, an audio clip —
// saved as Figma's canvas.fig (Save local copy, shared/fig/figmaExport.ts), read back by our importer and loaded again:
// the timeline and the resolved model are the same.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deflateRawSync, inflateRawSync, zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { beforeAll, describe, expect, it } from "vitest";
import type { Message } from "@/engine/codec";
import { Engine } from "@/engine/Engine";
import { EngineStore } from "@/engine/EngineStore";
import { loadEngine } from "@/engine/loadEngine";
import type { FigCodecs } from "@shared/fig/compression";
import { decodeCanvas } from "@shared/fig/container";
import { encodeFigmaCanvas } from "@shared/fig/figmaExport";
import { decodeAnySchema } from "@shared/fig/importFig";
import { decodeMessage } from "@shared/schema/codec";
import { messageToEngine } from "@/store/engineMessage";
import { EditorController } from "../../controller";
import { memoryDocumentSource } from "../../documentSource";
import MOTION_LOGO_DOCUMENT from "../fixtures/figma-logo-motion.json";
import { addPreset, applyStyle } from "../presets";

const wasm = join(process.cwd(), "src/renderer/src/engine/wasm/engine.wasm");
const codecs: FigCodecs = {
  inflateRaw: (b) => new Uint8Array(inflateRawSync(b)),
  deflateRaw: (b) => new Uint8Array(deflateRawSync(b)),
  zstdDecompress: (b) => new Uint8Array(zstdDecompressSync(b)),
  zstdCompress: (b) => new Uint8Array(zstdCompressSync(b)),
};

beforeAll(async () => {
  globalThis.fetch = async () => new Response(null, { status: 404 });
  const bytes = readFileSync(wasm);
  await loadEngine({ wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), printErr: () => {} });
});

async function engineWith(message: Message) {
  const source = memoryDocumentSource(message, { fileName: "Figma logo · Motion" });
  const engine = await Engine.create(null, { sessionID: 1 });
  engine.load(await source.load());
  engine.setViewport(1280, 800, 1, 1280, 800);
  return { engine, ed: new EditorController(engine, new EngineStore(engine), source) };
}

describe("Motion through a .fig", () => {
  it("manual tracks, presets, a composite style, the timeline, the anchor and audio survive Save local copy and import", async () => {
    const { engine, ed } = await engineWith(MOTION_LOGO_DOCUMENT as unknown as Message);
    expect(addPreset(ed, "rotation", ["1:6"], { type: "ROUNDED_RECTANGLE", strokes: false }, { startUs: 250_000, durationUs: 600_000, props: { type: "rotateOut" } })).toHaveLength(1);
    expect(applyStyle(ed, "slideIn", ["1:5"], { type: "ELLIPSE", strokes: false }, 1_000_000)).toBe(true);
    expect(engine.runMotionCommand("MOTION_SET_TIMELINE", { root: "1:1", durationUs: 9_000_000, snappingFps: 30 })).toBe(0);
    expect(engine.runMotionCommand("MOTION_SET_ANCHOR", { nodes: ["1:4"], x: 0, y: 100 })).toBe(0);
    expect(engine.runMotionCommand("MOTION_ADD_AUDIO", { root: "1:1", mediaHash: "0123456789abcdef0123456789abcdef01234567", name: "Beat", offsetUs: 500_000, durationUs: 3_000_000 })).toBe(0);
    const timeline = engine.motionTimeline("1:1")!;
    const resolved = engine.motionResolved("1:1")!;
    expect(timeline.layers.find((l) => l.node === "1:5")!.clips.map((c) => c.style?.key)).toEqual(["slideIn", "slideIn"]);

    // As the store saves it: the engine's kiwi snapshot, decoded.
    const canvas = decodeCanvas(encodeFigmaCanvas(decodeMessage(engine.encodeDocumentKiwi()), codecs), codecs);
    const { message: back, report } = decodeAnySchema(canvas.schema, canvas.message, { keepDerived: true });
    expect(report?.droppedNodeTypes ?? {}).toEqual({});
    for (const f of ["animationPresets", "styleIdsForAnimation", "audioFills", "audioTracks", "timelineOffset", "timelineDuration", "backingAnimationPresetId", "componentPropAssignments", "transformOrigin"])
      expect(Object.keys(report?.droppedFields ?? {}).filter((k) => k.endsWith(`.${f}`)), f).toEqual([]);
    const again = await engineWith(messageToEngine(back));
    expect(again.engine.motionTimeline("1:1")).toEqual(timeline);
    expect(again.engine.motionResolved("1:1")).toEqual(resolved);
  });
});
