// Figma's DTCG import / export of variable modes (model/dtcg.ts; R3 "Round 6"): the exported file's shape as Figma
// writes it, and the importer's accepted forms.
import { describe, expect, it } from "vitest";
import { aliasRef, dtcgColor, exportMode, findAliasTarget, modeFileName, parseColor, parseTokens, tokenValue } from "../model/dtcg";
import type { Collection, Variable, VariableLookup, VarValue } from "../model/variables";

const mode = (id: string, name: string) => ({ id, name, sortPosition: id });
const collection = (id: string, name: string, modes: { id: string; name: string; sortPosition: string }[]): Collection =>
  ({ id, name, modes, defaultMode: modes[0].id, sortPosition: "", hidden: false, node: {} as Collection["node"], parent: null, overrides: new Map() }) as Collection;
const variable = (id: string, name: string, c: string, type: Variable["type"], values: Record<string, VarValue>, extra: Partial<Variable> = {}): Variable =>
  ({ id, name, collection: c, type, values: new Map(Object.entries(values)), scopes: null, description: "", codeSyntax: [], hidden: false, sortPosition: id, node: {} as Variable["node"], ...extra }) as Variable;

const theme = collection("1:1", "Theme", [mode("1:2", "Light"), mode("1:3", "Dark")]);
const prims = collection("2:1", "Primitives", [mode("2:2", "Value")]);
const vars = [
  variable("3:1", "color/bg", "1:1", "COLOR", { "1:2": { kind: "literal", value: { r: 1, g: 1, b: 1, a: 1 } }, "1:3": { kind: "literal", value: { r: 0, g: 0, b: 0, a: 0.5 } } }, { scopes: ["FRAME_FILL"], description: "Page background" }),
  variable("3:2", "color/surface", "1:1", "COLOR", { "1:2": { kind: "alias", id: "3:1" }, "1:3": { kind: "alias", id: "4:1" } }),
  variable("3:3", "space/md", "1:1", "FLOAT", { "1:2": { kind: "literal", value: 16 } }),
  variable("3:4", "label", "1:1", "STRING", { "1:2": { kind: "literal", value: "Hello" } }),
  variable("3:5", "flag", "1:1", "BOOLEAN", { "1:2": { kind: "literal", value: true } }),
  variable("4:1", "gray/900", "2:1", "COLOR", { "2:2": { kind: "literal", value: { r: 0.1, g: 0.1, b: 0.1, a: 1 } } }),
];
const lookup: VariableLookup = {
  variable: (id) => vars.find((v) => v.id === id),
  collection: (id) => [theme, prims].find((c) => c.id === id),
};

describe("DTCG export (Figma's format)", () => {
  it("writes one mode: nested groups, types, colours, aliases, extensions, the mode name last", () => {
    expect(modeFileName("Light")).toBe("Light.tokens.json");
    const json = JSON.parse(exportMode(theme, vars.slice(0, 5), "1:2", lookup, () => null));
    expect(Object.keys(json)).toEqual(["color", "space", "label", "flag", "$extensions"]);
    expect(json.$extensions).toEqual({ "com.figma.modeName": "Light" });
    expect(json.color.bg).toEqual({
      $type: "color",
      $value: { colorSpace: "srgb", components: [1, 1, 1], alpha: 1, hex: "#FFFFFF" },
      $description: "Page background",
      $extensions: { "com.figma.variableId": "VariableID:3:1", "com.figma.scopes": ["FRAME_FILL"] },
    });
    expect(json.color.surface.$value).toBe("{color.bg}");
    expect(json.space.md).toMatchObject({ $type: "number", $value: 16 });
    expect(json.label).toMatchObject({ $type: "string", $value: "Hello", $extensions: { "com.figma.type": "string" } });
    expect(json.flag).toMatchObject({ $type: "number", $value: 1, $extensions: { "com.figma.type": "boolean" } });
  });
  it("writes an alias to another collection as its value with aliasData", () => {
    const json = JSON.parse(exportMode(theme, vars.slice(0, 2), "1:3", lookup, () => ({ r: 0.1, g: 0.1, b: 0.1, a: 1 })));
    expect(json.color.surface.$value.hex).toBe("#1A1A1A");
    expect(json.color.surface.$extensions["com.figma.aliasData"]).toEqual({ targetVariableId: "VariableID:4:1", targetVariableName: "gray/900", targetVariableSetId: "VariableCollectionId:2:1", targetVariableSetName: "Primitives" });
    expect(json.color.bg.$value).toEqual(dtcgColor({ r: 0, g: 0, b: 0, a: 0.5 }));
    expect(aliasRef("a/b/c")).toBe("{a.b.c}");
  });
});

describe("DTCG import", () => {
  it("reads Figma's own export back", () => {
    const text = exportMode(theme, vars.slice(0, 5), "1:2", lookup, () => null);
    const f = parseTokens(text);
    expect(f.modeName).toBe("Light");
    expect(f.tokens.map((t) => [t.name, t.type])).toEqual([
      ["color/bg", "COLOR"],
      ["color/surface", "COLOR"],
      ["space/md", "FLOAT"],
      ["label", "STRING"],
      ["flag", "BOOLEAN"],
    ]);
    expect(f.tokens[1].value).toEqual({ kind: "ref", name: "color/bg" });
    expect(f.tokens[4].value).toEqual({ kind: "literal", value: true });
  });
  it("takes the help's forms: hex, HSL, px dimensions, s durations, fontFamily; skips the rest", () => {
    const f = parseTokens(
      JSON.stringify({
        red: { $type: "color", $value: "#ff0000" },
        hsl: { $type: "color", $value: { colorSpace: "hsl", components: [120, 100, 50], alpha: 1 } },
        "border-radius-default": { $type: "dimension", $value: { value: 4, unit: "px" } },
        rem: { $type: "dimension", $value: { value: 1, unit: "rem" } },
        "transition-duration": { $type: "duration", $value: { value: 0.2, unit: "s" } },
        "heading-font": { $type: "fontFamily", $value: "Inter" },
        shadow: { $type: "shadow", $value: {} },
        group: { $type: "number", a: { $value: 1 }, b: { $value: 2 } },
      }),
    );
    expect(f.tokens.find((t) => t.name === "red")?.value).toEqual({ kind: "literal", value: { r: 1, g: 0, b: 0, a: 1 } });
    const g = f.tokens.find((t) => t.name === "hsl")!.value as { value: { g: number } };
    expect(g.value.g).toBeCloseTo(1);
    expect(f.tokens.find((t) => t.name === "border-radius-default")?.value).toEqual({ kind: "literal", value: 4 });
    expect(f.tokens.find((t) => t.name === "transition-duration")?.type).toBe("FLOAT");
    expect(f.tokens.find((t) => t.name === "heading-font")?.type).toBe("STRING");
    expect(f.tokens.find((t) => t.name === "group/b")?.value).toEqual({ kind: "literal", value: 2 }); // $type from the group
    expect(f.skipped.sort()).toEqual(["rem", "shadow"]);
    expect(parseColor("#0f08")).toEqual({ r: 0, g: 1, b: 0, a: 0x88 / 255 });
    expect(() => parseTokens("[1, 2]")).toThrow();
  });
  it("resolves references and aliasData to variables (by id, else names), else the value", () => {
    const f = parseTokens(exportMode(theme, vars.slice(0, 2), "1:3", lookup, () => ({ r: 0.1, g: 0.1, b: 0.1, a: 1 })));
    const surface = f.tokens.find((t) => t.name === "color/surface")!;
    expect(surface.value.kind).toBe("aliasData");
    const byName = new Map(vars.map((v) => [v.name, v]));
    expect(tokenValue(surface, byName, vars, lookup)).toEqual({ kind: "alias", id: "4:1" });
    if (surface.value.kind === "aliasData") {
      expect(findAliasTarget({ ...surface.value, id: "VariableID:abc/-1:-1" }, vars, lookup)).toBe("4:1"); // by collection id + name
      expect(findAliasTarget({ ...surface.value, id: undefined, collectionId: undefined }, vars, lookup)).toBe("4:1"); // by names
      expect(tokenValue({ ...surface, value: { ...surface.value, id: undefined, collectionId: undefined, collection: "Nope" } }, byName, vars, lookup)?.kind).toBe("literal");
    }
  });
});
