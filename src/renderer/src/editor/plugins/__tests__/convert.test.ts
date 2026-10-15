// The Plugin API's effect and image-filter shapes (api/convert.ts) as Figma's converter writes them
// (docs/research/rea/effects.md §2.14, §2.24, §2.26): glass in Figma's fields, the clamps and warnings, the spread
// rule, the noise size vector, SHADER, one glass per node, saturation ↔ vibrance.
import { describe, expect, it } from "vitest";
import type { NodeChange } from "@/engine/codec";
import { effectFromApi, effectToApi, effectsFromApi, paintFromApi, paintToApi } from "../api/convert";
import { ONE_GLASS, figmaGlass, shownAngle } from "../../model/glass";

const rect = { type: "ROUNDED_RECTANGLE" } as NodeChange;
const BLACK = { r: 0, g: 0, b: 0, a: 0.25 };

describe("Plugin API effects", () => {
  it("glass: depth ↔ refractionRadius, splay ↔ reflectionDistance, bevelSize always 1; round trip", () => {
    const api = { type: "GLASS", visible: true, lightIntensity: 0.5, lightAngle: 30, refraction: 0.6, depth: 40, dispersion: 0.2, radius: 8, splay: 0.25 };
    const doc = effectFromApi(api, "effects[0]");
    expect(doc).toEqual({ type: "GLASS", visible: true, specularIntensity: 0.5, specularAngle: 30, refractionIntensity: 0.6, refractionRadius: 40, bevelSize: 1, chromaticAberration: 0.2, reflectionDistance: 0.25, radius: 8 });
    expect(effectToApi(doc)).toEqual(api);
    // Figma's ranges: depth 1–100, splay 0–1, angle −899–900.
    expect(effectFromApi({ type: "GLASS", depth: 0, splay: 3, lightAngle: 2000 }, "e")).toMatchObject({ refractionRadius: 1, reflectionDistance: 1, specularAngle: 900 });
    // Left out: Figma's new glass.
    expect(effectFromApi({ type: "GLASS" }, "e")).toMatchObject({ refractionRadius: 20, specularAngle: -45, specularIntensity: 0.8, refractionIntensity: 0.8, chromaticAberration: 0.5, reflectionDistance: 0, radius: 4, bevelSize: 1 });
  });

  it("a glass Wecra wrote before round 17 (Depth in bevelSize, Splay 0–100 in refractionRadius) reads in Figma's fields", () => {
    const old = { type: "GLASS" as const, bevelSize: 30, refractionRadius: 50, radius: 4 };
    expect(figmaGlass(old)).toMatchObject({ refractionRadius: 30, reflectionDistance: 0.5, bevelSize: 1 });
    expect(effectToApi(old)).toMatchObject({ depth: 30, splay: 0.5 });
    // Figma's own (bevelSize 1) is left alone.
    const figma = { type: "GLASS" as const, bevelSize: 1, refractionRadius: 50 };
    expect(figmaGlass(figma)).toBe(figma);
    expect(shownAngle(-45)).toBe(315);
    expect(shownAngle(400)).toBe(40);
  });

  it("one glass per node (Figma's message)", () => {
    expect(() => effectsFromApi([{ type: "GLASS" }, { type: "GLASS" }], rect)).toThrow(ONE_GLASS);
    expect(effectsFromApi([{ type: "GLASS" }, { type: "DROP_SHADOW", color: BLACK }], rect)).toHaveLength(2);
  });

  it("shadows: radius 0–250 and spread ±30000 clamped with a warning; spread only where Figma draws it", () => {
    const warnings: string[] = [];
    const warn = (m: string) => void warnings.push(m);
    const s = effectFromApi({ type: "DROP_SHADOW", color: BLACK, radius: 300, spread: 40000 }, "effects[0]", rect, warn);
    expect(s).toMatchObject({ radius: 250, spread: 30000 });
    expect(warnings).toHaveLength(1);
    // A text, a group, a frame that doesn't clip or has no visible fill: spread 0, warned.
    for (const node of [{ type: "TEXT" }, { type: "FRAME", fillPaints: [{ type: "SOLID", visible: true }], frameMaskDisabled: true }, { type: "FRAME", fillPaints: [] }] as NodeChange[]) {
      warnings.length = 0;
      expect(effectFromApi({ type: "INNER_SHADOW", color: BLACK, spread: 4 }, "e", node, warn).spread).toBe(0);
      expect(warnings).toHaveLength(1);
    }
    for (const node of [{ type: "ELLIPSE" }, { type: "FRAME", fillPaints: [{ type: "SOLID" }] }, { type: "INSTANCE", fillPaints: [{ type: "SOLID" }] }] as NodeChange[])
      expect(effectFromApi({ type: "DROP_SHADOW", color: BLACK, spread: 4 }, "e", node, warn).spread).toBe(4);
  });

  it("blurs, noise and texture: Figma's names and clamps, the noise size vector", () => {
    expect(effectToApi({ type: "FOREGROUND_BLUR", radius: 4 }).type).toBe("LAYER_BLUR");
    expect(effectFromApi({ type: "LAYER_BLUR", blurType: "PROGRESSIVE", radius: 20, startRadius: 400 }, "e")).toMatchObject({ type: "FOREGROUND_BLUR", startRadius: 100 });
    const t = effectFromApi({ type: "TEXTURE", radius: 400, noiseSizeVector: { x: 2, y: 3 } }, "e");
    expect(t).toMatchObject({ type: "GRAIN", radius: 100, noiseSize: { x: 2, y: 3 } });
    expect(effectToApi(t)).toMatchObject({ type: "TEXTURE", noiseSize: 2, noiseSizeVector: { x: 2, y: 3 } });
    expect(() => effectFromApi({ type: "NOISE", noiseSize: 1, noiseSizeVector: { x: 2, y: 2 } }, "e")).toThrow(/noiseSize/);
    const n = effectFromApi({ type: "NOISE", noiseType: "MULTITONE", noiseSize: 0.5 }, "e");
    expect(n).toMatchObject({ noiseSize: { x: 0.5, y: 0.5 }, opacity: 0.15 });
    expect(typeof n.seed).toBe("number");
    // A field the document doesn't hold reads as Figma's Effect reads it.
    expect(effectToApi({ type: "NOISE", noiseType: "MULTITONE" })).toMatchObject({ noiseSize: 0, opacity: 0 });
  });

  it("shader effects are SHADER in the Plugin API", () => {
    const e = { type: "CUSTOM" as const, visible: true, blendMode: "NORMAL" as const, customEffectId: { assetRef: { key: "k" } } };
    expect(effectToApi(e).type).toBe("SHADER");
    expect(effectFromApi({ type: "SHADER", customEffectId: e.customEffectId }, "e")).toMatchObject({ type: "CUSTOM", customEffectId: e.customEffectId });
  });
});

describe("Plugin API image filters", () => {
  it("saturation is the document's vibrance, both ways", () => {
    const p = paintFromApi({ type: "IMAGE", scaleMode: "FILL", imageHash: "ab", filters: { saturation: 0.5, exposure: 0.2 } }, "fills[0]");
    expect(p.paintFilter).toEqual({ vibrance: 0.5, exposure: 0.2 });
    expect(paintToApi(p).filters).toEqual({ exposure: 0.2, saturation: 0.5 });
  });
});
