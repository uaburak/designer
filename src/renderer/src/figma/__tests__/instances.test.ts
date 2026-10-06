import { describe, expect, it } from "vitest";
import { changesAt, makeFrame, makeInstance, makeText, parseVariantName, variantLabel, withPushedOverrides, withResetAt, withVariantName, withoutChange, type FrameNode, type SceneNode, type TextNode } from "../model";

const text = (name: string, characters: string): TextNode => ({ ...makeText(0, 0, characters), name });
const card = (): FrameNode => ({ ...makeFrame("Card", 0, 0, 200, 100), id: "c-card", type: "component", children: [text("Title", "Başlık"), text("Body", "Metin")] });
const red = [{ type: "solid" as const, color: { value: "#ff0000" } }];

describe("instance changes (Figma's Reset ▸)", () => {
  it("lists what an instance and a layer in it changed", () => {
    const main = card();
    const inst = { ...makeInstance(main, 0, 0), id: "i1", overrides: { Title: { characters: "Merhaba", fills: red }, "": { fills: red } } } as FrameNode;
    const nodes: SceneNode[] = [main, inst];
    expect(changesAt(nodes, "i1").map((c) => c.label)).toEqual(["Text", "Fill"]);
    expect(changesAt(nodes, "i1/Title").map((c) => c.label)).toEqual(["Text", "Fill"]);
    expect(changesAt(nodes, "i1/Body")).toEqual([]);
  });
  it("resets one kind of change, or all of a layer's", () => {
    const overrides = { Title: { characters: "Merhaba", fills: red }, Body: { characters: "x" } };
    expect(withResetAt(overrides, ["Title"], "Fill")).toEqual({ Title: { characters: "Merhaba" }, Body: { characters: "x" } });
    expect(withResetAt(overrides, ["Title"])).toEqual({ Body: { characters: "x" } });
    const inst = { ...makeInstance(card(), 0, 0), overrides } as FrameNode;
    expect(withoutChange(inst, "Text").overrides).toEqual({ Title: { fills: red } });
    expect(withoutChange(inst).overrides).toBeUndefined();
  });
});

describe("withPushedOverrides (Push changes to main component)", () => {
  it("puts the instance's changes on the main's layers and its own frame", () => {
    const pushed = withPushedOverrides(card(), { Title: { characters: "Merhaba" }, "": { fills: red } });
    expect((pushed.children[0] as TextNode).characters).toBe("Merhaba");
    expect((pushed.children[1] as TextNode).characters).toBe("Metin");
    expect(pushed.fills).toEqual(red);
  });
});

describe("variant names (Figma's Property=Value layer names)", () => {
  const variant = (id: string, pairs: [string, string][]): FrameNode => ({ ...makeFrame(id, 0, 0, 10, 10), id, type: "component", variant: pairs.map(([property, value]) => ({ property, value })) });
  const set = (): FrameNode => ({ ...makeFrame("Buttons", 0, 0, 100, 100), id: "set", type: "componentSet", children: [variant("a", [["State", "Default"], ["iconOnly", "False"]]), variant("b", [["State", "hover"], ["iconOnly", "False"]])] });
  it("shows values, a True/False one with its property", () => {
    expect(variantLabel(set().children[0] as FrameNode)).toBe("Default, iconOnly=False");
  });
  it("reads a typed name — Prop=Value, or values in order — and refuses what isn't one", () => {
    expect(parseVariantName("State=active, iconOnly=True", ["State", "iconOnly"])).toEqual([{ property: "State", value: "active" }, { property: "iconOnly", value: "True" }]);
    expect(parseVariantName("active, True", ["State", "iconOnly"])).toEqual([{ property: "State", value: "active" }, { property: "iconOnly", value: "True" }]);
    expect(parseVariantName("State=, x", ["State"])).toBeNull();
    expect(parseVariantName("State=a, State=b", ["State"])).toBeNull();
    expect(parseVariantName("active", ["State", "iconOnly"])).toBeNull();
  });
  it("sets the variant's values; a new property goes to every variant", () => {
    const next = withVariantName(set(), "b", [{ property: "State", value: "active" }, { property: "Size", value: "lg" }]);
    const [a, b] = next.children as FrameNode[];
    expect(b.variant).toEqual([{ property: "State", value: "active" }, { property: "iconOnly", value: "False" }, { property: "Size", value: "lg" }]);
    expect(b.name).toBe("State=active, iconOnly=False, Size=lg");
    expect(a.variant?.find((v) => v.property === "Size")?.value).toBe("lg");
  });
});
