import { describe, expect, it } from "vitest";
import type { DesignVariable } from "@/types/design";
import { startingLibrary } from "../library";
import { getNode, makeFrame, makeInstance, newDocument, removeNodes, type FigmaDocument, type FrameNode, type SceneNode } from "../model";
import { keepsOverview, overviewFields, overviewOf, withOverview } from "../overview";
import { publishedPage, usedComponents } from "../publish";
import { currentLibrary, detachDeleted, splitLibrary, tombstoneOf, withLibrary, withoutVariables, frozenValues } from "../systemLibrary";
import { designSystemOf, type EditState } from "../designSystem";
import { OVERVIEW_IMAGE, pageFrameOf } from "../page";

const fields = { slug: "demo", title: "Demo", category: "", year: "2026" };
/** A new project's file, the starting library in it, its Overview made. */
function newFile(): FigmaDocument {
  const library = currentLibrary(null);
  return withOverview(withLibrary(newDocument("Demo"), library), fields);
}

describe("currentLibrary", () => {
  it("seeds the starting library, every component's signature kept", () => {
    const lib = currentLibrary(null);
    expect(lib.nodes.length).toBeGreaterThan(10);
    expect(Object.keys(lib.seeded).length).toBe(lib.nodes.length);
    expect(lib.nodes.some((n) => n.id === "c-overview")).toBe(true);
  });
  it("keeps a stored, current library as it is", () => {
    const lib = currentLibrary(null);
    expect(currentLibrary(lib)).toEqual(lib);
  });
  it("on an older version: an edited starting component stays, an untouched one is replaced, a deleted one stays gone", () => {
    const lib = currentLibrary(null);
    const edited = lib.nodes.map((n) => (n.id === "c-heading" ? { ...n, name: "My heading" } : n));
    const older = { ...lib, nodes: edited.filter((n) => n.id !== "c-paragraph"), version: 0, deleted: [{ id: "c-paragraph", node: lib.nodes.find((n) => n.id === "c-paragraph")! }] };
    const up = currentLibrary(older);
    expect(up.nodes.find((n) => n.id === "c-heading")?.name).toBe("My heading");
    expect(up.nodes.some((n) => n.id === "c-paragraph")).toBe(false);
  });
});

describe("withLibrary / splitLibrary", () => {
  it("puts the library in and takes it back out (the open page with it)", () => {
    const file = { ...newFile(), currentPage: "p-components" };
    const { project, nodes } = splitLibrary(file);
    expect(project.pages).toBeUndefined();
    expect(project.currentPage).toBeUndefined();
    expect(nodes.length).toBeGreaterThan(10);
  });
});

describe("the Overview", () => {
  it("is made on a new project's page, first, and says the project's fields", () => {
    const file = newFile();
    const o = overviewOf(file);
    expect(o).not.toBeNull();
    expect(pageFrameOf(file)!.children[0].id).toBe(o!.instance.id);
    expect(overviewFields(file)?.title).toBe("Demo");
  });
  it("can't be removed: an edit that takes it away isn't kept", () => {
    const file = newFile();
    const page = pageFrameOf(file)!;
    const without: FigmaDocument = { ...file, nodes: file.nodes.map((n) => (n.id === page.id ? { ...page, children: page.children.slice(1) } : n)) };
    expect(keepsOverview(file, without)).toBe(false);
    expect(keepsOverview(file, file)).toBe(true);
  });
});

describe("variables deleted: their uses keep the value they had", () => {
  it("replaces every alias of a deleted variable with its light value", () => {
    const gone: DesignVariable = { id: "v-brand", name: "Brand", kind: "color", light: { value: "#123456" }, dark: { value: "#abcdef" } };
    const node = { ...makeFrame("F", 0, 0, 10, 10), fills: [{ color: { alias: "v-brand" } }] };
    const frozen = frozenValues([gone], []);
    const next = withoutVariables([node], frozen)[0] as FrameNode;
    expect(next.fills[0].color).toEqual({ value: "#123456" });
    // Nothing of it: the same objects.
    expect(withoutVariables([node], new Map())[0]).toBe(node);
  });
  it("follows a deleted variable's alias to its value", () => {
    const base: DesignVariable = { id: "v-base", name: "Base", kind: "number", light: { value: 8 } };
    const gone: DesignVariable = { id: "v-gap", name: "Gap", kind: "number", light: { alias: "v-base" } };
    expect(frozenValues([gone], [base]).get("v-gap")).toEqual({ value: 8 });
  });
});

describe("components deleted: their instances become frames", () => {
  it("detaches instances of a deleted component when a project opens", () => {
    const lib = currentLibrary(null);
    const card = lib.nodes.find((n) => n.id === "c-card") as FrameNode;
    const instance = makeInstance(card, 0, 0);
    const page: FrameNode = { ...makeFrame("Page", 0, 0, 100, 100), children: [instance] };
    const project: FigmaDocument = { version: 1, nodes: [page], pageId: page.id };
    const libWithout = { ...lib, nodes: lib.nodes.filter((n) => n.id !== "c-card"), deleted: [tombstoneOf(card)] };
    const next = detachDeleted(project, libWithout, [], [], []);
    const detached = getNode(next.nodes, instance.id) as FrameNode;
    expect(detached.type).toBe("frame");
    expect(detached.children.length).toBe(card.children.length);
    // Nothing deleted: the same file.
    expect(detachDeleted(project, lib, [], [], [])).toBe(project);
  });
});

describe("designSystemOf", () => {
  const state = (file: FigmaDocument): EditState => ({ file, variables: [], deletedVariables: [], textStyles: [], deletedTextStyles: [], deletedComponents: [] });
  it("deleting a variable detaches its uses and keeps a tombstone (one step)", () => {
    const v: DesignVariable = { id: "v1", name: "Accent", kind: "color", light: { value: "#ff0000" } };
    const page: FrameNode = { ...makeFrame("Page", 0, 0, 10, 10), fills: [{ color: { alias: "v1" } }] };
    let s: EditState = { ...state({ version: 1, nodes: [page], pageId: page.id }), variables: [v] };
    designSystemOf(s, (change) => { s = change(s); }).removeVariable("v1");
    expect(s.variables).toEqual([]);
    expect(s.deletedVariables.map((x) => x.id)).toEqual(["v1"]);
    expect((s.file.nodes[0] as FrameNode).fills[0].color).toEqual({ value: "#ff0000" });
  });
  it("deleting a component detaches its instances everywhere and keeps a tombstone", () => {
    const file = newFile();
    const card = getNode(splitLibrary(file).nodes, "c-card") as FrameNode;
    const instance = makeInstance(card, 0, 0);
    const page = pageFrameOf(file)!;
    const withCard: FigmaDocument = { ...file, nodes: file.nodes.map((n) => (n.id === page.id ? { ...page, children: [...page.children, instance] } : n)) };
    let s = state(withCard);
    designSystemOf(s, (change) => { s = change(s); }).deleteComponent("c-card");
    expect(getNode(splitLibrary(s.file).nodes, "c-card")).toBeNull();
    expect((getNode(s.file.nodes, instance.id) as FrameNode).type).toBe("frame");
    expect(s.deletedComponents.map((d) => d.id)).toEqual(["c-card"]);
  });
});

describe("publishedPage", () => {
  it("holds the page frame and only the components it draws (theirs too), the cover's alt the title", () => {
    const file = newFile();
    const page = pageFrameOf(file)!;
    const overview = page.children[0] as FrameNode;
    const withCover: FrameNode = { ...overview, overrides: { [OVERVIEW_IMAGE]: { fills: [{ type: "image", color: { alias: "bg-2" }, image: { url: "https://x/y.jpg", fit: "fill" } }] } } };
    const pictured: FigmaDocument = { ...file, nodes: file.nodes.map((n) => (n.id === page.id ? { ...page, children: [withCover] } : n)) };
    const out = publishedPage(pictured, { ...fields, coverImage: "https://x/y.jpg" }, 3, [], []);
    expect(out.doc.nodes.length).toBe(1);
    const comps = out.doc.pages![0].nodes.map((n) => n.id);
    expect(comps).toEqual(["c-overview"]);
    const fills = (out.doc.nodes[0] as FrameNode).children[0] as FrameNode;
    expect(fills.overrides?.[OVERVIEW_IMAGE].fills?.[0].image?.alt).toBe("Demo");
    expect(out.summary.order).toBe(3);
    expect(out.summary.images[0]).toBe("https://x/y.jpg");
  });
  it("takes in nested components (a Card inside Project info)", () => {
    const lib = startingLibrary().nodes;
    const info = lib.find((n) => n.id === "c-info") as FrameNode;
    const used = usedComponents([makeInstance(info, 0, 0) as SceneNode], lib).map((n) => n.id);
    expect(used).toContain("c-info");
    expect(used).toContain("c-card");
  });
});

describe("removeNodes keeps the overview guard honest", () => {
  it("(sanity) a page without its first child has no whole overview", () => {
    const file = newFile();
    const page = pageFrameOf(file)!;
    const stripped: FigmaDocument = { ...file, nodes: removeNodes(file.nodes, new Set([page.children[0].id])) };
    expect(overviewOf(stripped)).toBeNull();
  });
});
