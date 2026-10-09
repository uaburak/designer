// Round 12 on the real engine (headless Wasm), the live capture (`&doc=capture`): vector edit's More menu tools
// (live toolbar/vector-edit-more-menu.txt) — Shape builder (M) and Variable width (⇧W) picked through the editor's
// vector state; Stroke settings' Width profile (popovers/stroke-advanced-settings.txt) applying the presets
// (SET_WIDTH_PROFILE, FLIP_WIDTH_POINTS) that the panel reads back from variableWidthPoints; Flatten on a main
// component enabled (live context-component).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { Engine } from "@/engine/Engine";
import { EngineStore } from "@/engine/EngineStore";
import { loadEngine } from "@/engine/loadEngine";
import { MOD_SHIFT, Status } from "@/engine/abi";
import { EditorController } from "../controller";
import { memoryDocumentSource } from "../documentSource";
import { CAPTURE_DOCUMENT } from "../fixtures";
import { vectorMoreTools } from "../canvas/BottomToolbar";
import { WIDTH_PROFILES, matchProfile, presetPoints, profileAt, profilePath, readWidthPoints } from "../widthProfile";

const wasm = fileURLToPath(new URL("../../engine/wasm/engine.wasm", import.meta.url));

beforeAll(async () => {
  const g = globalThis as Record<string, unknown>;
  g.window ??= globalThis;
  g.document ??= { querySelector: () => null };
  const bytes = readFileSync(wasm);
  await loadEngine({ wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), printErr: () => {} });
});

async function editor() {
  const source = memoryDocumentSource(CAPTURE_DOCUMENT, { fileName: "Untitled" });
  const engine = await Engine.create(null, { sessionID: 1 });
  engine.load(await source.load());
  const ed = new EditorController(engine, new EngineStore(engine), source);
  return { ed, engine };
}

const pointsOf = (engine: Engine, id: string) => readWidthPoints((engine.readNode(id) as Record<string, unknown> | null)?.variableWidthPoints);

describe("width profiles (round 12)", () => {
  it("the six presets of the plugin API, matched back; their 62 × 4 images", () => {
    expect(WIDTH_PROFILES.map((p) => p.value)).toEqual(["UNIFORM", "WEDGE", "TAPER", "QUARTER_TAPER", "EYE", "MIRRORED_TAPER"]);
    for (const { value } of WIDTH_PROFILES) expect(matchProfile(presetPoints(value))).toBe(value);
    expect(matchProfile([{ position: 0.3, ascent: 1, descent: 1 }])).toBe("CUSTOM");
    // Uniform fills the 4 px; a wedge narrows to a point at its end.
    expect(profilePath([])).toMatch(/^M0 0L/);
    expect(profilePath(presetPoints("WEDGE"))).toContain("L62 2L62 2");
    const eye = profileAt(presetPoints("EYE"), 0.5);
    expect(eye.ascent + eye.descent).toBeCloseTo(1);
  });

  it("Width profile applies a preset to the selection in one undo step; Flip width points mirrors it", async () => {
    const { ed, engine } = await editor();
    engine.setSelection(["7:64"]);
    expect(engine.commandState("SET_WIDTH_PROFILE")).not.toBe(0);
    expect(engine.commandState("FLIP_WIDTH_POINTS")).toBe(0); // live: disabled on a uniform stroke
    expect(engine.command("SET_WIDTH_PROFILE", { refs: ["7:64"], profile: "TAPER" })).toBe(Status.OK);
    expect(matchProfile(pointsOf(engine, "7:64"))).toBe("TAPER");
    expect(engine.command("FLIP_WIDTH_POINTS", { refs: ["7:64"] })).toBe(Status.OK);
    const flipped = pointsOf(engine, "7:64");
    expect(flipped[0].ascent + flipped[0].descent).toBeCloseTo(0.25);
    expect(flipped[1].ascent + flipped[1].descent).toBeCloseTo(1);
    engine.undo();
    expect(matchProfile(pointsOf(engine, "7:64"))).toBe("TAPER");
    engine.undo();
    expect(pointsOf(engine, "7:64")).toEqual([]);
    // Not on a dashed stroke (Figma).
    ed.setProps(["7:64"], { dashPattern: [4, 4] } as never, "Dash");
    expect(engine.commandState("SET_WIDTH_PROFILE")).toBe(0);
  });
});

describe("vector edit's More: Shape builder and Variable width (round 12)", () => {
  it("both tools are the engine's; Variable width only where it applies", async () => {
    const { ed, engine } = await editor();
    engine.setSelection(["7:64"]);
    expect(ed.vector.start("7:64")).toBe(true);
    expect(ed.vector.state.get().variableWidth).toBe(true);
    expect(ed.vector.hasTool("SHAPE_BUILDER")).toBe(true);
    ed.vector.setTool("SHAPE_BUILDER");
    expect(ed.vector.state.get().tool).toBe("SHAPE_BUILDER");
    ed.vector.setTool("VARIABLE_WIDTH");
    expect(ed.vector.state.get().tool).toBe("VARIABLE_WIDTH");
    const rows = vectorMoreTools(ed.vector.state.get().tool, ed.vector.state.get().variableWidth);
    expect(rows.map((r) => (typeof r === "object" && "checked" in r ? [r.label, !!r.checked, !!r.disabled] : r))).toEqual([
      ["Shape builder", false, false],
      ["Variable width", true, false],
    ]);
    ed.vector.end();
    // A dashed stroke: Variable width isn't offered.
    ed.setProps(["7:64"], { dashPattern: [4, 4] } as never, "Dash");
    expect(ed.vector.start("7:64")).toBe(true);
    expect(ed.vector.state.get().variableWidth).toBe(false);
    expect(ed.vector.hasTool("VARIABLE_WIDTH")).toBe(false);
    expect(engine.setVectorEditTool("VARIABLE_WIDTH")).toBe(Status.E_UNSUPPORTED);
  });

  it("M and ⇧W pick them on the canvas; the VECTOR_EDIT event lists the held layers", async () => {
    const { ed, engine } = await editor();
    engine.setSelection(["7:60", "7:61"]);
    engine.key("down", "Enter", "Enter", 0);
    expect(ed.vector.state.get().active).toBe(true);
    expect(ed.vector.state.get().layers).toEqual(["7:60", "7:61"]);
    engine.key("down", "KeyM", "m", 0);
    expect(ed.vector.state.get().tool).toBe("SHAPE_BUILDER");
    engine.key("down", "KeyW", "W", MOD_SHIFT);
    expect(ed.vector.state.get().tool).toBe("VARIABLE_WIDTH");
  });
});

describe("Flatten on a main component (round 12, live context-component: enabled)", () => {
  it("is enabled and replaces the component with a vector, one undo step", async () => {
    const { engine } = await editor();
    engine.setSelection(["8:1"]);
    expect(engine.commandState("FLATTEN")).not.toBe(0);
    expect(engine.command("FLATTEN")).toBe(Status.OK);
    const made = engine.getSelection().refs[0];
    expect(made).not.toBe("8:1");
    expect(engine.readNode(made)?.type).toBe("VECTOR");
    engine.undo();
    expect(engine.readNode("8:1")?.type).toBe("SYMBOL");
  });
});
