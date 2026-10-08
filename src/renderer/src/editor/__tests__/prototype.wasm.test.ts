// Prototyping on the real engine (headless Wasm): the schema's prototype fields as the panel reads and writes them
// (round-tripping through the engine's kiwi snapshot), prototype mode's noodle drag adding an interaction (and the
// PROTOTYPE_CONNECTED event the panel opens it from), and the presentation player through the facade: the flow's start,
// a click navigating, an overlay, Back, restart, the state the view shows.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { PointerType, Status } from "@/engine/abi";
import { Engine } from "@/engine/Engine";
import { EngineStore } from "@/engine/EngineStore";
import { loadEngine } from "@/engine/loadEngine";
import type { NodeChange } from "@/engine/codec";
import { EditorController } from "../controller";
import { memoryDocumentSource } from "../documentSource";
import { PROTOTYPE_DOCUMENT } from "../fixtures";
import { liveInteractions, newInteraction, guidJson, type PrototypeFields } from "../model/prototype";
import { paintVideoHash, videoPaint } from "../model/paints";
import { protoFields } from "../panels/prototype/PrototypePanel";

const wasm = fileURLToPath(new URL("../../engine/wasm/engine.wasm", import.meta.url));

beforeAll(async () => {
  const g = globalThis as Record<string, unknown>;
  g.window ??= globalThis;
  g.document ??= { querySelector: () => null };
  const bytes = readFileSync(wasm);
  await loadEngine({ wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), printErr: () => {} });
});

async function editor() {
  const source = memoryDocumentSource(PROTOTYPE_DOCUMENT, { fileName: "Prototype" });
  const engine = await Engine.create(null, { sessionID: 1 });
  engine.load(await source.load());
  engine.setViewport(1600, 1000, 1, 1600, 1000);
  const store = new EngineStore(engine);
  const ed = new EditorController(engine, store, source);
  return { ed, engine };
}

const read = (engine: Engine, id: string) => engine.readNode(id) as (NodeChange & PrototypeFields) | null;

describe("prototyping on the engine (wasm, headless)", () => {
  it("reads and writes the schema's prototype fields, and they survive the kiwi snapshot", async () => {
    const { ed, engine } = await editor();
    const next = read(engine, "2:4")!;
    const list = liveInteractions(next.prototypeInteractions);
    expect(list).toHaveLength(1);
    expect(list[0].event?.interactionType).toBe("ON_CLICK");
    expect(list[0].actions?.[0]).toMatchObject({ connectionType: "INTERNAL_NODE", navigationType: "NAVIGATE", transitionNodeID: { sessionID: 2, localID: 10 }, transitionType: "SMART_ANIMATE" });
    expect(read(engine, "2:1")!.prototypeStartingPoint).toMatchObject({ name: "Onboarding" });
    expect(read(engine, "2:20")!.overlayPositionType).toBe("BOTTOM_CENTER");
    expect(read(engine, "2:6")!.scrollDirection).toBe("HORIZONTAL");

    // The panel's writes: a second interaction, a device, overflow, one undo step each.
    ed.setProps(["2:4"], protoFields({ prototypeInteractions: [...list, newInteraction(guidJson("1:500"), "2:20")] }), "Add interaction");
    ed.setProps(["0:1"], protoFields({ prototypeDevice: { type: "PRESET", presetIdentifier: "IPHONE_16", size: { x: 393, y: 852 }, rotation: "NONE" } }), "Prototype device");
    ed.setProps(["2:10"], protoFields({ scrollDirection: "VERTICAL" }), "Overflow");
    expect(liveInteractions(read(engine, "2:4")!.prototypeInteractions)).toHaveLength(2);
    expect(read(engine, "0:1")!.prototypeDevice).toMatchObject({ type: "PRESET", presetIdentifier: "IPHONE_16" });
    ed.setProps(["2:10"], protoFields({ scrollDirection: null }), "Overflow");
    expect(read(engine, "2:10")!.scrollDirection).toBeUndefined();
    engine.undo();
    expect(read(engine, "2:10")!.scrollDirection).toBe("VERTICAL");

    // Through the engine's own kiwi snapshot into a new engine: the same fields.
    const bytes = engine.encodeDocumentKiwi();
    const other = await Engine.create(null, { sessionID: 2 });
    expect(other.loadKiwi(bytes)).toBe(Status.OK);
    expect(liveInteractions(read(other, "2:4")!.prototypeInteractions)).toHaveLength(2);
    expect(read(other, "0:1")!.prototypeDevice).toMatchObject({ presetIdentifier: "IPHONE_16", size: { x: 393, y: 852 } });
    expect(read(other, "2:20")!.overlayBackgroundAppearance).toMatchObject({ backgroundType: "SOLID_COLOR" });
    other.destroy();
    engine.destroy();
  });

  it("drags a noodle from the + handle to a frame in prototype mode", async () => {
    const { engine } = await editor();
    engine.setCamera({ x: 0, y: 0, zoom: 1 });
    engine.setPrototypeMode(true);
    engine.setSelection(["2:5"]);  // Menu button (311, 40, 40 × 40): its handle at (351, 60)
    const connected: { refs: string[]; interaction: string | null }[] = [];
    engine.on("PROTOTYPE_CONNECTED", (e) => connected.push({ refs: e.refs, interaction: e.interaction }));
    expect(engine.pointer(PointerType.DOWN, 351, 60, 0, 1, 0)).not.toBe(0);
    engine.pointer(PointerType.MOVE, 500, 200, 0, 1, 0);
    engine.pointer(PointerType.MOVE, 700, 400, 0, 1, 0);  // over Details
    engine.pointer(PointerType.UP, 700, 400, 0, 0, 0);
    const list = liveInteractions(read(engine, "2:5")!.prototypeInteractions);
    expect(list).toHaveLength(2);
    expect(list[1].actions?.[0]).toMatchObject({ navigationType: "NAVIGATE", transitionNodeID: { sessionID: 2, localID: 10 }, transitionType: "INSTANT_TRANSITION" });
    expect(connected).toEqual([{ refs: ["2:5"], interaction: expect.any(String) }]);
    engine.destroy();
  });

  it("presents: the flow's start, a click navigates, an overlay, Back, Restart", async () => {
    const { engine } = await editor();
    engine.setViewport(375, 812, 1, 375, 812);
    expect(engine.presentStart({ page: "0:1" })).toBe(Status.OK);
    let s = engine.presentState();
    expect(s).toMatchObject({ active: true, screen: "2:1", screenName: "Home", flow: "2:1", flowName: "Onboarding", canBack: false });
    expect(s.flows).toEqual([{ node: "2:1", name: "Onboarding", description: "" }]);
    const click = (x: number, y: number) => {
      engine.presentPointer(PointerType.MOVE, x, y, 0, 0);
      engine.presentPointer(PointerType.DOWN, x, y, 1, 0);
      engine.presentPointer(PointerType.UP, x, y, 0, 0);
    };
    // The menu button opens Menu at the bottom.
    click(331, 60);
    s = engine.presentState();
    expect(s.overlays).toEqual(["2:20"]);
    // Clicking outside it closes it.
    click(100, 100);
    expect(engine.presentState().overlays).toEqual([]);
    // Next → Details (Smart animate).
    click(100, 740);
    s = engine.presentState();
    expect(s).toMatchObject({ screen: "2:10", screenName: "Details", canBack: true });
    expect(s.events.some((e) => e.type === "CHANGED")).toBe(true);
    // Its Back button (24, 384, 100 × 40).
    click(60, 400);
    expect(engine.presentState().screen).toBe("2:1");
    // No device: Actual size (100%) first (Figma's default); Z goes on to Responsive; R restarts.
    expect(engine.presentState().scale).toBe("ACTUAL");
    engine.presentCommand("scale");
    expect(engine.presentState().scale).toBe("RESPONSIVE");
    engine.presentSetOptions({ scale: "FIT" });
    click(100, 740);
    expect(engine.presentKey("down", 82, 0)).toBe(true);
    expect(engine.presentState()).toMatchObject({ screen: "2:1", history: 0 });
    engine.presentStop();
    expect(engine.presentState().active).toBe(false);
    engine.destroy();
  });

  it("Change to on an interactive component swaps its variant", async () => {
    const { engine } = await editor();
    engine.setViewport(375, 812, 1, 375, 812);
    engine.presentStart({ page: "0:1", node: "2:1" });
    const main = () => (engine.readNode("2:7", { fields: ["symbolData"] }) as { symbolData?: { symbolID?: { sessionID: number; localID: number } } }).symbolData?.symbolID;
    expect(main()).toEqual({ sessionID: 3, localID: 2 });
    engine.presentPointer(PointerType.MOVE, 320, 655, 0, 0);
    engine.presentPointer(PointerType.DOWN, 320, 655, 1, 0);
    engine.presentPointer(PointerType.UP, 320, 655, 0, 0);
    expect(main()).toEqual({ sessionID: 3, localID: 4 });
    engine.presentCommand("restart");
    expect(main()).toEqual({ sessionID: 3, localID: 2 });
    engine.destroy();
  });

  it("presents in a device frame (Model, Show device frame, Responsive / Fixed size) through the facade", async () => {
    const { ed, engine } = await editor();
    ed.setProps(["0:1"], protoFields({ prototypeDevice: { type: "PRESET", presetIdentifier: "IPHONE_16_PRO_DESERT_TITANIUM", size: { x: 402, y: 874 }, rotation: "NONE" } }), "Prototype device");
    engine.setViewport(1200, 1000, 1, 1200, 1000);
    expect(engine.presentStart({ page: "0:1" })).toBe(Status.OK);
    let s = engine.presentState();
    expect(s).toMatchObject({ device: true, deviceType: "PRESET", devicePreset: "IPHONE_16_PRO_DESERT_TITANIUM", hasDeviceFrame: true, deviceFrame: true, responsive: false, scale: "FIT" });
    const framed = s.screenRect!;
    engine.presentSetOptions({ deviceFrame: false, responsive: true });
    s = engine.presentState();
    expect(s).toMatchObject({ deviceFrame: false, responsive: true });
    // Without its frame the screen can be drawn larger.
    expect(s.screenRect!.h).toBeGreaterThanOrEqual(framed.h);
    engine.destroy();
  });

  it("plays a video: Prototype › Video, a video action, its report back, Enable Figma shortcuts", async () => {
    const { ed, engine } = await editor();
    // Next (2:4) becomes a video that toggles itself; Prototype › Video: autoplay, muted.
    const poster = "ffeeddccbbaa99887766554433221100ffeeddcc";
    const video = "00112233445566778899aabbccddeeff00112233";
    const paint = videoPaint(video, { hash: poster, width: 327, height: 56 }, "Clip");
    ed.setProps(
      ["2:4"],
      protoFields({
        videoPlayback: { autoplay: true, mediaLoop: true, muted: true },
        prototypeInteractions: [{ event: { interactionType: "ON_CLICK" }, actions: [{ connectionType: "UPDATE_MEDIA_RUNTIME", transitionNodeID: guidJson("2:4"), mediaAction: "TOGGLE_PLAY_PAUSE" }] }],
      }),
      "Video",
    );
    ed.setProps(["2:4"], { fillPaints: [paint as never] }, "Video");
    const back = read(engine, "2:4")!;
    expect(back.fillPaints?.[0]).toMatchObject({ type: "VIDEO" });
    expect(paintVideoHash(back.fillPaints![0] as never)).toBe(video);
    expect(back.videoPlayback).toMatchObject({ autoplay: true, mediaLoop: true, muted: true });
    engine.setViewport(375, 812, 1, 375, 812);
    expect(engine.presentStart({ page: "0:1", node: "2:1" })).toBe(Status.OK);
    let media = engine.presentMedia();
    expect(media).toEqual([expect.objectContaining({ id: "2:4", hash: video, playing: true, muted: true, loop: true, seek: null })]);
    engine.presentPointer(PointerType.MOVE, 100, 740, 0, 0);
    engine.presentPointer(PointerType.DOWN, 100, 740, 1, 0);
    engine.presentPointer(PointerType.UP, 100, 740, 0, 0);
    media = engine.presentMedia();
    expect(media[0].playing).toBe(false);
    expect(engine.presentMediaFrame("2:4", { time: 1.5, duration: 4, ended: false, seekSerial: 0 })).toBe(Status.OK);
    expect(engine.presentMedia()[0]).toMatchObject({ time: 1.5, duration: 4 });
    // Enable Figma shortcuts off: R no longer restarts (the prototype's own keys would still work).
    engine.presentSetOptions({ shortcuts: false });
    expect(engine.presentState().shortcuts).toBe(false);
    expect(engine.presentKey("down", 82, 0)).toBe(false);
    engine.presentSetOptions({ shortcuts: true });
    expect(engine.presentKey("down", 82, 0)).toBe(true);
    engine.destroy();
  });

  it("viewer mode: reads and selection work, edits are refused", async () => {
    const { engine } = await editor();
    engine.setViewerMode(true);
    expect(engine.setProps(["2:4"], { name: "Renamed" })).toBe(Status.E_READONLY);
    expect(engine.command("DELETE")).toBe(Status.E_READONLY);
    expect(engine.command("ZOOM_TO_FIT")).toBe(Status.OK);
    engine.setSelection(["2:4"]);
    expect(engine.getSelection().refs).toEqual(["2:4"]);
    expect(engine.readNode("2:4")?.name).not.toBe("Renamed");
    engine.setViewerMode(false);
    expect(engine.setProps(["2:4"], { name: "Renamed" })).toBe(Status.OK);
    engine.destroy();
  });
});
