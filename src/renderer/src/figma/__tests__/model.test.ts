import { describe, expect, it } from "vitest";
import {
  cloneNode,
  findNode,
  getNode,
  insertNode,
  layerName,
  makeFrame,
  makeInstance,
  makeText,
  resolveInstance,
  setOf,
  withRenamedLayer,
  withoutLanguage,
  writtenLanguages,
  type FigmaDocument,
  type FrameNode,
  type SceneNode,
  type TextNode,
} from "../model";

const text = (name: string, characters: string, extra: Partial<TextNode> = {}): TextNode => ({ ...makeText(0, 0, characters), name, ...extra });
const component = (id: string, name: string, children: SceneNode[], extra: Partial<FrameNode> = {}): FrameNode => ({ ...makeFrame(name, 0, 0, 200, 100), id, type: "component", children, ...extra });
const doc = (nodes: SceneNode[]): FigmaDocument => ({ version: 1, nodes, pageId: nodes[0]?.id ?? "" });

describe("insertNode", () => {
  it("names a layer apart from its new siblings", () => {
    const frame = { ...makeFrame("Frame", 0, 0, 100, 100), children: [text("Card", "a")] };
    const next = insertNode([frame], frame.id, text("Card", "b"));
    const kids = (next[0] as FrameNode).children.map((c) => c.name);
    expect(kids).toEqual(["Card", "Card 2"]);
  });
  it("keeps the same arrays elsewhere", () => {
    const a = makeFrame("A", 0, 0, 10, 10);
    const b = makeFrame("B", 0, 0, 10, 10);
    const next = insertNode([a, b], a.id, text("T", "t"));
    expect(next[1]).toBe(b);
  });
});

describe("findNode / getNode (indexed)", () => {
  it("finds a nested node, its parent, its path", () => {
    const inner = text("Inner", "x");
    const mid = { ...makeFrame("Mid", 0, 0, 10, 10), children: [inner] };
    const top = { ...makeFrame("Top", 0, 0, 10, 10), children: [mid] };
    const found = findNode([top], inner.id)!;
    expect(found.parent?.id).toBe(mid.id);
    expect(found.path).toEqual([top.id, mid.id, inner.id]);
    expect(getNode([top], "nope")).toBeNull();
  });
  it("sees a new tree as new (never a stale index)", () => {
    const a = text("A", "a");
    const list = [a];
    expect(getNode(list, a.id)).toBe(a);
    const b = text("B", "b");
    expect(getNode([...list, b], b.id)).toBe(b);
  });
});

describe("cloneNode", () => {
  it("gives fresh ids and sends a copied set's reactions to the copies' variants", () => {
    const v1 = component("v1", "Btn", [], { variant: [{ property: "State", value: "A" }], reactions: [{ id: "r1", trigger: "click", target: "v2", animation: "smart", easing: "ease-out", duration: 300 }] });
    const v2 = component("v2", "Btn", [], { variant: [{ property: "State", value: "B" }] });
    const set: FrameNode = { ...makeFrame("Btn", 0, 0, 200, 200), id: "set", type: "componentSet", children: [v1, v2] };
    const copy = cloneNode(set);
    const [c1, c2] = copy.children as FrameNode[];
    expect(c1.id).not.toBe("v1");
    expect(c1.reactions?.[0].target).toBe(c2.id);
    expect(setOf([copy], c1.id)?.id).toBe(copy.id);
  });
});

describe("layerName", () => {
  it("takes out the separators of composite ids and name paths", () => {
    expect(layerName("UI/UX › Design")).toBe("UI∕UX > Design");
  });
});

describe("resolveInstance", () => {
  it("draws the instance's own changes of its frame (fills, corners, gap)", () => {
    const main = component("c1", "Card", [text("Title", "Hello")]);
    const instance: FrameNode = { ...makeInstance(main, 0, 0), overrides: { "": { fills: [{ color: { value: "#ff0000" } }], cornerRadius: { value: 12 }, itemSpacing: { value: 30 } } } };
    const r = resolveInstance([main, instance], instance)!;
    expect(r.fills[0].color).toEqual({ value: "#ff0000" });
    expect(r.cornerRadius).toEqual({ value: 12 });
    expect(r.itemSpacing).toEqual({ value: 30 });
  });
  it("keeps the component's English words for a text property the instance didn't set", () => {
    const main = component("c1", "Card", [text("Title", "Merhaba", { charactersEn: "Hello", charactersProp: "title" })], { properties: [{ id: "title", name: "Title", type: "text", value: "Merhaba" }] });
    const instance = makeInstance(main, 0, 0);
    const title = resolveInstance([main, instance], instance)!.children[0] as TextNode;
    expect(title.charactersEn).toBe("Hello");
    // Its own words, untranslated: no English of the default's under them.
    const own: FrameNode = { ...instance, props: { title: "Selam" } };
    const ownTitle = resolveInstance([main, own], own)!.children[0] as TextNode;
    expect(ownTitle.characters).toBe("Selam");
    expect(ownTitle.charactersEn).toBeUndefined();
  });
});

describe("withRenamedLayer", () => {
  it("moves every instance's overrides of a renamed layer to its new name", () => {
    const main = component("c1", "Card", [text("Title", "Hello")]);
    const instance: FrameNode = { ...makeInstance(main, 0, 0), overrides: { Title: { characters: "Own" } } };
    const page: FrameNode = { ...makeFrame("Page", 0, 0, 100, 100), children: [instance] };
    const file: FigmaDocument = { ...doc([page]), pages: [{ id: "p-components", name: "Components", nodes: [main] }] };
    const titleId = main.children[0].id;
    const next = withRenamedLayer(file, titleId, "Heading");
    const inst = getNode(next.nodes, instance.id) as FrameNode;
    expect(inst.overrides).toEqual({ Heading: { characters: "Own" } });
    expect((getNode(next.pages![0].nodes, titleId) as TextNode).name).toBe("Heading");
  });
  it("names it apart from its siblings", () => {
    const main = component("c1", "Card", [text("A", "a"), text("B", "b")]);
    const next = withRenamedLayer(doc([main]), main.children[1].id, "A");
    expect((next.nodes[0] as FrameNode).children.map((c) => c.name)).toEqual(["A", "A 2"]);
  });
});

describe("writtenLanguages", () => {
  it("offers only the languages the page has words in", () => {
    const page: FrameNode = { ...makeFrame("Page", 0, 0, 100, 100), children: [text("T", "Merhaba")] };
    expect(writtenLanguages(doc([page])).map((l) => l.code)).toEqual(["tr"]);
    const en: FrameNode = { ...page, children: [text("T", "Merhaba", { charactersEn: "Hello" })] };
    expect(writtenLanguages(doc([en])).map((l) => l.code)).toEqual(["tr", "en"]);
  });
});

describe("withoutLanguage", () => {
  it("takes a language's words out of the project, not out of the site's library page", () => {
    const own = text("Title", "Merhaba", { charactersEn: "Hello" });
    const main = component("c-card", "Card", [text("Label", "Etiket", { charactersEn: "Label" })]);
    const file: FigmaDocument = { ...doc([own]), languages: [{ code: "tr", name: "Türkçe" }, { code: "en", name: "English" }], pages: [{ id: "p-components", name: "Components", nodes: [main] }] };
    const next = withoutLanguage(file, "en", "p-components");
    expect((next.nodes[0] as TextNode).charactersEn).toBeUndefined();
    expect(next.pages?.[0]).toBe(file.pages?.[0]);
    expect(next.languages?.map((l) => l.code)).toEqual(["tr"]);
  });
});
