// @vitest-environment happy-dom
// The Plugin API's Motion (docs/motion.md §9; round 8f) through QuickJS and figma.js on the real engine and the Figma
// logo fixture, as Figma's own guide writes it: manualKeyframeTracks read in seconds, applyManualKeyframeTrack /
// removeManualKeyframeTrack, the object assigned whole, timelines / setTimelineDuration, figmaAnimationStyles and
// applyAnimationStyle / removeAnimationStyle, Figma's refusals; Dev Mode reads only. One undo step per run. Round 8j:
// custom animation styles (made, entries, applied as CUSTOM, updated reaching the layer) and easings' variable aliases.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { Message } from "@/engine/codec";
import { Engine } from "@/engine/Engine";
import { EngineStore } from "@/engine/EngineStore";
import { loadEngine } from "@/engine/loadEngine";
import { EditorController } from "../../controller";
import { memoryDocumentSource } from "../../documentSource";
import MOTION_LOGO_DOCUMENT from "../../motion/fixtures/figma-logo-motion.json";
import { createCollection, createVariable } from "../../variables";
import { PluginRun, type RunSpec } from "../host";
import { PluginUiStore } from "../ui/store";

const wasm = join(process.cwd(), "src/renderer/src/engine/wasm/engine.wasm");

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
  return { ed, engine };
}

const inline = (code: string, editorType?: "figma" | "dev"): RunSpec => ({
  pluginId: "inline",
  name: "Inline",
  manifest: { name: "Inline", id: "inline", api: "1.0.0", main: "code.js", editorType: editorType ? [editorType] : undefined, networkAccess: { allowedDomains: ["none"] } },
  code,
  ui: {},
  development: true,
  command: "",
  ...(editorType ? { editorType } : {}),
});

/** Runs `code` and gives back what it passed to `done(…)`, and the console's errors. */
async function runFor(ed: EditorController, code: string, editorType?: "figma" | "dev"): Promise<{ result: unknown; errors: string[] }> {
  const logs: string[][] = [];
  let result: unknown;
  const body = `const done = (v) => { console.log("RESULT " + JSON.stringify(v)); figma.closePlugin(); };\n(async () => {\n${code}\n})().catch((e) => { console.error(String(e && e.message ? e.message : e)); figma.closePlugin(); });`;
  const r = new PluginRun(inline(body, editorType), { ed, desktop: null, ui: new PluginUiStore(), console: (level, args) => logs.push([level, ...args.map(String)]) });
  await r.start();
  await Promise.race([r.ended, new Promise((_, rej) => setTimeout(() => rej(new Error("the run didn't end")), 3000))]);
  for (const l of logs) if (l[0] === "log" && l[1]?.startsWith("RESULT ")) result = JSON.parse(l[1].slice(7));
  return { result, errors: logs.filter((l) => l[0] === "error").map((l) => l.slice(1).join(" ")) };
}

describe("plugins: Motion (docs/motion.md §9)", () => {
  it("reads manualKeyframeTracks, timelines and animations in seconds; figma.motion lists the styles", async () => {
    const { ed } = await editor();
    const { result, errors } = await runFor(
      ed,
      `const red = await figma.getNodeByIdAsync("1:2");
       const frame = await figma.getNodeByIdAsync("1:1");
       const styles = figma.motion.figmaAnimationStyles();
       done({
         keys: Object.keys(red.manualKeyframeTracks).sort(),
         opacity: red.manualKeyframeTracks.OPACITY.keyframes.map((k) => [typeof k.id, k.timelinePosition >= 0, k.value.type]),
         timelines: red.timelines, frameTimelines: frame.timelines,
         animations: red.animations.length,
         has: ["applyManualKeyframeTrack", "removeManualKeyframeTrack", "applyAnimationStyle", "removeAnimationStyle", "setTimelineDuration"].map((m) => typeof red[m]),
         styleIds: styles.map((s) => s.styleId), textProps: Object.keys(styles.find((s) => s.styleId === "TextStagger").props).length > 5,
         playhead: figma.motion.playheadPosition,
         bounce: figma.motion.physicalSpringToNormalized({ mass: 1, stiffness: 100, damping: 10 }),
       });`
    );
    expect(errors).toEqual([]);
    const r = result as Record<string, unknown>;
    expect(r.keys).toEqual(expect.arrayContaining(["OPACITY", "TRANSLATION_XY"]));
    expect((r.opacity as unknown[])[0]).toEqual(["string", true, "FLOAT"]);
    expect(r.timelines).toEqual(r.frameTimelines);
    expect((r.timelines as { id: string }[])[0].id).toBe("1:1");
    expect(r.animations).toBeGreaterThan(0);
    expect(r.has).toEqual(["function", "function", "function", "function", "function"]);
    expect(r.styleIds).toEqual(["Opacity", "Position", "Scale", "Rotation", "Size", "CornerRadius", "Path", "TextStagger"]);
    expect(r.textProps).toBe(true);
    expect(r.playhead).toBe(0);
    expect(r.bounce).toBeCloseTo(0.5, 6);
  });

  it("applyManualKeyframeTrack / removeManualKeyframeTrack / the object assigned whole, and setTimelineDuration — one undo step", async () => {
    const { ed, engine } = await editor();
    const { result, errors } = await runFor(
      ed,
      `const green = await figma.getNodeByIdAsync("1:6");
       green.applyManualKeyframeTrack({ type: "PROPERTY", name: "ROTATION" }, { keyframes: [
         { timelinePosition: 0, value: { type: "FLOAT", value: 0 } },
         { timelinePosition: 1, easing: { type: "EASE_OUT" }, value: { type: "FLOAT", value: 120 } },
       ] });
       const after = green.manualKeyframeTracks.ROTATION.keyframes.map((k) => [k.timelinePosition, Math.round(k.value.value), k.easing && k.easing.type]);
       const existing = green.manualKeyframeTracks;
       green.manualKeyframeTracks = { ...existing, fills: { 0: { keyframes: [
         { timelinePosition: 0, value: { type: "COLOR", value: { r: 1, g: 0, b: 0, a: 1 } } },
         { timelinePosition: 1, value: { type: "COLOR", value: { r: 0, g: 0, b: 1, a: 1 } } },
       ] } } };
       const fills = Object.keys(green.manualKeyframeTracks.fills || {});
       green.removeManualKeyframeTrack({ type: "PROPERTY", name: "ROTATION" });
       const [tl] = green.timelines;
       green.setTimelineDuration(tl.id, 5);
       done({ after, fills, gone: green.manualKeyframeTracks.ROTATION === undefined, duration: green.timelines[0].duration });`
    );
    expect(errors).toEqual([]);
    // A keyframe written without an easing reads as Figma's default (CUSTOM_CUBIC (0.5, 0, 0.5, 1)).
    expect(result).toEqual({ after: [[0, 0, "CUSTOM_CUBIC_BEZIER"], [1, 120, "EASE_OUT"]], fills: ["0"], gone: true, duration: 5 });
    expect(engine.motionTimeline("1:1")!.durationUs).toBe(5_000_000);
    engine.command("UNDO");
    const undone = engine.motionTimeline("1:1")!;
    expect(undone.durationUs).not.toBe(5_000_000);
    expect(undone.layers.find((l) => l.node === "1:6")?.tracks.some((t) => t.field.type === "INDEXED_ITEM")).toBeFalsy();
  });

  it("applyAnimationStyle returns the applied id; animationStyles reads it; removeAnimationStyle takes it", async () => {
    const { ed } = await editor();
    const { result, errors } = await runFor(
      ed,
      `const green = await figma.getNodeByIdAsync("1:6");
       const def = figma.motion.figmaAnimationStyles().find((s) => s.styleId === "Opacity");
       const id = green.applyAnimationStyle(def.styleId, { duration: 0.5, timelineOffset: 0.25, props: { timing: "in", easing: { type: "EASE_OUT" } } });
       const applied = green.animationStyles.find((s) => s.id === id);
       green.animationStyles = green.animationStyles.map((s) => (s.id === id ? { ...s, duration: 0.35 } : s));
       const edited = green.animationStyles[0].duration;
       green.removeAnimationStyle(id);
       done({ applied: { styleId: applied.styleId, duration: applied.duration, timelineOffset: applied.timelineOffset, type: applied.props.type }, edited, left: green.animationStyles.length });`
    );
    expect(errors).toEqual([]);
    expect(result).toEqual({ applied: { styleId: "Opacity", duration: 0.5, timelineOffset: 0.25, type: "fadeIn" }, edited: 0.35, left: 0 });
  });

  it("round 8j: custom animation styles — made, entries added, applied as CUSTOM, an entry added reaching the layer, moved in place, removed", async () => {
    const { ed, engine } = await editor();
    const { result, errors } = await runFor(
      ed,
      `const green = await figma.getNodeByIdAsync("1:6");
       const style = figma.createCustomAnimationStyle();
       style.name = "Motion/Gentle entrance";
       const entry = await style.addAnimationEntryAsync("Opacity", { duration: 0.4, easing: { type: "EASE_OUT" }, timing: "in" });
       const listed = (await figma.getLocalCustomAnimationStylesAsync()).map((s) => [s.name, s.type, s.animationEntries.length]);
       let strict = "";
       try { green.applyAnimationStyle(style.id, { type: "CUSTOM", duration: 1 }); } catch (e) { strict = e.message; }
       let untyped = "";
       try { green.applyAnimationStyle(style.id); } catch (e) { untyped = e.message; }
       const before = green.animationStyles.length;
       const binding = green.applyAnimationStyle(style.id, { type: "CUSTOM", timelineOffset: 0.25 });
       const applied = green.animationStyles.find((s) => s.id === binding);
       await style.addAnimationEntryAsync("Scale", { duration: 0.3, delay: 0.1 });
       const entries = style.animationEntries.map((e) => [e.name, e.duration, e.props.delay]);
       green.animationStyles = green.animationStyles.map((s) => (s.id === binding ? { type: "CUSTOM", id: s.id, styleId: s.styleId, timelineOffset: 0.5 } : s));
       const moved = green.animationStyles.find((s) => s.id === binding);
       style.removeAnimationEntry(entry.id);
       const left = style.animationEntries.map((e) => e.name);
       green.removeAnimationStyle(binding);
       const after = green.animationStyles.length;
       style.remove();
       done({ listed, strict, untyped, added: before + 1, applied, entries, moved, left, after, before, styles: (await figma.getLocalCustomAnimationStylesAsync()).length });`
    );
    expect(errors).toEqual([]);
    const r = result as Record<string, unknown>;
    expect(r.listed).toEqual([["Motion/Gentle entrance", "CUSTOM_ANIMATION", 1]]);
    expect(r.strict).toContain("only timelineOffset");
    expect(r.untyped).toContain('{type: "CUSTOM"');
    expect(r.applied).toEqual({ id: expect.any(String), type: "CUSTOM", styleId: expect.any(String), name: "Motion/Gentle entrance", timelineOffset: 0.25 });
    expect(r.entries).toEqual([["Opacity", 0.4, 0], ["Scale", 0.3, 0.1]]);
    expect(r.moved).toEqual({ ...(r.applied as object), timelineOffset: 0.5 });
    expect(r.left).toEqual(["Scale"]);
    expect(r.after).toBe(r.before);
    expect(r.styles).toBe(0);
    // The run is one undo step: undone, the green layer has no clip of the style.
    engine.command("UNDO");
    expect(engine.motionTimeline("1:1")!.layers.find((l) => l.node === "1:6")?.clips.some((c) => c.style) ?? false).toBe(false);
  });

  it("round 8j: an updated custom style reaches the layer it's applied to; an easing binds to an EASING variable by its alias", async () => {
    const { ed, engine } = await editor();
    const collection = createCollection(ed, "Motion")!;
    const variable = createVariable(ed, collection, "EASING")!;
    const { result, errors } = await runFor(
      ed,
      `const green = await figma.getNodeByIdAsync("1:6");
       const style = figma.createCustomAnimationStyle();
       await style.addAnimationEntryAsync("Opacity", { duration: 0.5 });
       green.applyAnimationStyle(style.id, { type: "CUSTOM" });
       const clips = () => green.animationStyles.filter((s) => s.type === "CUSTOM").length;
       await style.addAnimationEntryAsync("Rotation", { duration: 0.5, delay: 0.5 });
       green.applyManualKeyframeTrack({ type: "PROPERTY", name: "OPACITY" }, { keyframes: [
         { timelinePosition: 0, value: { type: "FLOAT", value: 0 } },
         { timelinePosition: 1, value: { type: "FLOAT", value: 1 }, easing: { type: "VARIABLE_ALIAS", id: ${JSON.stringify(variable)} } },
       ] });
       let wrong = "";
       try { green.applyManualKeyframeTrack({ type: "PROPERTY", name: "OPACITY" }, { keyframes: [{ timelinePosition: 0, value: { type: "FLOAT", value: 0 }, easing: { type: "VARIABLE_ALIAS", id: "9:999" } }] }); } catch (e) { wrong = e.message; }
       done({ bindings: clips(), easing: green.manualKeyframeTracks.OPACITY.keyframes[1].easing, wrong });`
    );
    expect(errors).toEqual([]);
    const r = result as Record<string, unknown>;
    expect(r.bindings).toBe(1);
    expect(r.easing).toEqual({ type: "VARIABLE_ALIAS", id: variable });
    expect(r.wrong).toContain("no variable");
    // The style's two entries are on the layer: Opacity at 0, Rotation 0.5 s in.
    const clips = engine.motionTimeline("1:1")!.layers.find((l) => l.node === "1:6")!.clips.filter((c) => c.style);
    expect(clips.map((c) => [c.preset, c.startUs])).toEqual([["opacity", 0], ["rotation", 500_000]]);
  });

  it("refuses as Figma's API does: a top-level frame, combined with separated tracks, a wrong easing name; Dev Mode reads only", async () => {
    const { ed } = await editor();
    const { result } = await runFor(
      ed,
      `const frame = await figma.getNodeByIdAsync("1:1");
       const red = await figma.getNodeByIdAsync("1:2");
       const tries = [
         () => frame.applyManualKeyframeTrack({ type: "PROPERTY", name: "OPACITY" }, { keyframes: [{ timelinePosition: 0, value: { type: "FLOAT", value: 1 } }] }),
         () => red.applyManualKeyframeTrack({ type: "PROPERTY", name: "TRANSLATION_X" }, { keyframes: [{ timelinePosition: 0, value: { type: "FLOAT", value: 1 } }] }),
         () => red.applyManualKeyframeTrack({ type: "PROPERTY", name: "OPACITY" }, { keyframes: [{ timelinePosition: 0, value: { type: "FLOAT", value: 1 }, easing: { type: "OUT_CUBIC" } }] }),
         () => red.setTimelineDuration("9:9", 2),
       ];
       done(tries.map((f) => { try { f(); return "ok"; } catch (e) { return e.message; } }));`
    );
    const r = result as string[];
    expect(r[0]).toContain("top-level frames");
    expect(r[1]).toContain("combined or separated");
    expect(r[2]).toContain("EASE_OUT");
    expect(r[3]).toContain("isn't this node's");
    const dev = await runFor(
      ed,
      `const red = await figma.getNodeByIdAsync("1:2");
       let refused = "";
       try { red.removeManualKeyframeTrack({ type: "PROPERTY", name: "OPACITY" }); } catch (e) { refused = e.message; }
       done({ refused, read: Object.keys(red.manualKeyframeTracks).length > 0 });`,
      "dev"
    );
    expect(dev.result).toEqual({ refused: expect.stringContaining("Dev Mode"), read: true });
  });
});
