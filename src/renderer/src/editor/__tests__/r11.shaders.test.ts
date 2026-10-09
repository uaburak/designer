// Round 11: Figma's shader fills and effects as the panels write them — the presets against live's browsers
// (docs/research/figma/live/popovers/fill-picker-custom.txt, effects-add-shader-effects.txt), a paint / effect of
// type CUSTOM with its customEffectId and componentPropAssignments, parameters read and written, the fill row's label
// and swatch, leaving a shader for another paint type.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fromPicker, paintLabel, paintSwatch, type FullPaint } from "../model/paints";
import { SHADER_EFFECTS, SHADER_FILLS, defaultValue, presetOf, shaderEffect, shaderFields, shaderPaint, shaderPreset, shaderValue, withShaderValue, type ShaderFields } from "../model/shaders";
import { SHADER_FILL_PRESETS, SHADER_PRESETS, effectIcon, effectLabel } from "../panels/design/Effects";

const live = (name: string) => readFileSync(fileURLToPath(new URL(`../../../../../docs/research/figma/live/popovers/${name}`, import.meta.url)), "utf8");

/** The tiles' names under "By Figma" in a live dump's last (or only) browser popup. */
function liveTiles(text: string): string[] {
  const block = text.slice(text.lastIndexOf("\n@"));
  const after = block.slice(block.indexOf('"By Figma"'));
  return [...after.matchAll(/^\d+,\d+ \d+x13 "([^"]+)" 11px\/450 #ffffff$/gm)].map((m) => m[1]);
}

describe("shader presets (round 11)", () => {
  it("are live's browsers, name for name and in order", () => {
    expect(SHADER_FILLS.map((p) => p.name)).toEqual(liveTiles(live("fill-picker-custom.txt")));
    expect(SHADER_EFFECTS.map((p) => p.name)).toEqual(liveTiles(live("effects-add-shader-effects.txt")));
    expect(SHADER_FILLS).toHaveLength(10);
    expect(SHADER_EFFECTS).toHaveLength(25);
    expect(SHADER_FILL_PRESETS).toEqual(SHADER_FILLS.map((p) => p.name));
    expect(SHADER_PRESETS).toEqual(SHADER_EFFECTS.map((p) => p.name));
  });

  it("fit the program's uniform slots and have unique keys and parameter ids", () => {
    const keys = new Set<string>();
    for (const p of [...SHADER_FILLS, ...SHADER_EFFECTS]) {
      expect(keys.has(p.key)).toBe(false);
      keys.add(p.key);
      expect(shaderPreset(p.key)).toBe(p);
      expect(p.params.filter((q) => q.type === "color").length).toBeLessThanOrEqual(6);
      expect(p.params.filter((q) => q.type !== "color").length).toBeLessThanOrEqual(24);
      expect(new Set(p.params.map((q) => q.id)).size).toBe(p.params.length);
      for (const q of p.params) if (q.type === "choice") expect(q.options?.length ?? 0).toBeGreaterThan(Number(q.default));
    }
  });

  it("writes Figma's CUSTOM paint: the preset's key and every parameter as an assignment", () => {
    const nebula = shaderPreset("shader.nebula")!;
    const f = shaderFields(nebula);
    expect(f.type).toBe("CUSTOM");
    expect(f.customEffectId).toEqual({ assetRef: { key: "shader.nebula", version: "" } });
    expect(f.componentPropAssignments).toHaveLength(nebula.params.length);
    // A colour is a COLOR literal in varValue, a number a floatValue (in the units shown).
    expect(f.componentPropAssignments[0]).toEqual({ defID: { sessionID: 0, localID: 1 }, varValue: { dataType: "COLOR", resolvedDataType: "COLOR", value: { colorValue: { r: 1, g: 0x4f / 255, b: 0xd8 / 255, a: 1 } } } });
    expect(f.componentPropAssignments[3]).toEqual({ defID: { sessionID: 0, localID: 4 }, value: { floatValue: 100 } });
    const paint = shaderPaint({ opacity: 0.5, visible: false, blendMode: "MULTIPLY" }, nebula);
    expect(paint).toMatchObject({ type: "CUSTOM", opacity: 0.5, visible: false, blendMode: "MULTIPLY" });
    expect(shaderEffect({ visible: false }, shaderPreset("shader.halftone")!)).toMatchObject({ type: "CUSTOM", visible: false, blendMode: "NORMAL" });
  });

  it("reads and writes a parameter, keeping the preset's order; toggles and choices too", () => {
    const outlines = shaderPreset("shader.outlines")!;
    let fx = shaderFields(outlines) as ShaderFields;
    const width = outlines.params.find((p) => p.name === "Width")!;
    const show = outlines.params.find((p) => p.name === "Show layer")!;
    expect(shaderValue(fx, width)).toBe(2);
    expect(shaderValue(fx, show)).toBe(true);
    fx = withShaderValue(fx, width, 6);
    fx = withShaderValue(fx, show, false);
    expect(shaderValue(fx, width)).toBe(6);
    expect(shaderValue(fx, show)).toBe(false);
    expect(fx.componentPropAssignments!.map((a) => (a.defID as { localID: number }).localID)).toEqual(outlines.params.map((p) => p.id));
    // An assignment missing (another app's file, an "s:l" defID): the default, and the "s:l" form is read.
    const bare: ShaderFields = { type: "CUSTOM", customEffectId: { assetRef: { key: "shader.outlines" } }, componentPropAssignments: [{ defID: "0:3", value: { floatValue: 5 } }] };
    expect(shaderValue(bare, outlines.params.find((p) => p.id === 3)!)).toBe(5);
    expect(shaderValue(bare, width)).toBe(defaultValue(width));
    expect(presetOf(bare)).toBe(outlines);
    expect(presetOf({ type: "SOLID" })).toBeUndefined();
  });

  it("names and swatches a shader fill, and leaving it drops the shader", () => {
    const paint = shaderPaint(null, shaderPreset("shader.mesh-gradient")!) as FullPaint;
    expect(paintLabel(paint)).toBe("Mesh gradient");
    expect(paintSwatch(paint)).toMatch(/^linear-gradient\(135deg, rgba\(79, 70, 229, 1\)/);
    expect(paintLabel({ type: "CUSTOM" } as FullPaint)).toBe("Shader");
    const solid = fromPicker(paint, { type: "SOLID", color: { r: 1, g: 0, b: 0, a: 1 }, opacity: 1 });
    expect(solid.type).toBe("SOLID");
    expect(solid).not.toHaveProperty("customEffectId");
    expect(solid).not.toHaveProperty("componentPropAssignments");
  });

  it("names a shader effect's row by its preset, with the shader glyph", () => {
    const e = shaderEffect(null, shaderPreset("shader.bloom")!) as Parameters<typeof effectLabel>[0];
    expect(effectLabel(e)).toBe("Bloom");
    expect(effectIcon(e)).toBe("24.shader.small");
    expect(effectLabel({ type: "DROP_SHADOW" })).toBe("Drop shadow");
  });
});
