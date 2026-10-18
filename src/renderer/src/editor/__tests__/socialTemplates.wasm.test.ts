// @vitest-environment happy-dom
// Social's templates and the Brands library (docs/social.md §10, round 18b) on the real engine: the library generated
// for two brands (the Brand collection's modes, colour variables by name and by order, On primary's contrast pick,
// fonts, text styles, the Logo set's variants and the marker), the same again changing nothing, a removed brand's
// mode and logo gone, a renamed brand's renamed (its mode id kept); Save as template's refusals per missing wiring and the set it makes; a plain frame's texts
// carried to the template's slots by role; a brand switching only the mode and the logo variant; fill_slots refusing
// a locked slot; each action one undo step.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Engine } from "@/engine/Engine";
import { EngineStore } from "@/engine/EngineStore";
import { loadEngine } from "@/engine/loadEngine";
import { SAMPLE_DOCUMENT } from "@/engine/sampleDocument";
import type { Brand, BrandsRepository } from "@shared/studio/types";
import { EditorController } from "../controller";
import { memoryDocumentSource } from "../documentSource";
import { createNodes } from "../agents/mcpTools";
import type { Message } from "@/engine/codec";
import { encodeMessage } from "../../../../shared/schema/codec";
import { messageToKiwi } from "../../store/engineMessage";
import { openStoreDocument, type StoreDocumentSource } from "../../store/documentSource";
import { memoryStorage } from "../../store/memory/kv";
import { MemoryStore } from "../../store/memory/memoryStore";
import { draftPublish, publishLibrary, setLibraryEnabled } from "../libraries";
import { importCsvPosts, readCsvPosts } from "../social/templates/csvImport";
import { setBrandsRepository } from "../studio/forms";
import { AgentsService } from "../agents/service";
import { runTool } from "../agents/mcpTools";
import { brandsUnavailable } from "@shared/studio/types";
import { applyChecks, checkPost, editorWriter, fixProblem, newPost } from "../social/actions";
import { readPost } from "../social/posts";
import { readBoard } from "../social/socialState";
import { brandColors, changedBrands, createBrandsLibrary, onPrimary, readBrandLibrary, writeBrandLibrary } from "../social/templates/brandLibrary";
import { applyBrand, applyTemplate, fillSlots, inferSlots, insertTemplate, localTemplates, postSlots, readSlot, readTemplate, saveAsTemplate, slotTexts, templateIndex, templateVariants } from "../social/templates/templates";

const wasm = join(process.cwd(), "src/renderer/src/engine/wasm/engine.wasm");

beforeAll(async () => {
  globalThis.fetch = async () => new Response(null, { status: 404 });
  const bytes = readFileSync(wasm);
  await loadEngine({ wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), printErr: () => {} });
});
afterEach(() => setBrandsRepository(null));

async function setup() {
  const source = memoryDocumentSource(SAMPLE_DOCUMENT, { fileName: "Test" });
  const engine = await Engine.create(null, { sessionID: 1 });
  engine.load(await source.load());
  engine.setViewport(1280, 800, 1, 1280, 800);
  const ed = new EditorController(engine, new EngineStore(engine), source);
  return { ed, engine, w: editorWriter(ed) };
}

const brand = (id: string, name: string, over: Partial<Brand> = {}): Brand => ({ id, name, colors: [], fonts: [], tone: "", logos: [], formats: [], libraryFileKey: null, products: [], created: 1, updated: 1, ...over });
const ACME = brand("b1", "Acme", { colors: [{ name: "Background", hex: "#F4F1EA" }, { name: "", hex: "#1BA37A" }, { name: "Leaf", hex: "#0E5A3C" }, { name: "", hex: "#FFD400" }], fonts: ["Poppins", "Lora"] });
const BETA = brand("b2", "Beta", { colors: [{ name: "Primary", hex: "#FFE14D" }], fonts: [] });

function repo(brands: Brand[]): BrandsRepository {
  const no = () => Promise.reject(new Error("no"));
  return { list: async () => brands, get: async (id) => brands.find((b) => b.id === id) ?? null, find: async () => ({ brands: [], products: [] }), saveBrand: no, removeBrand: no, saveProduct: no, removeProduct: no, addImage: no, removeImage: no, image: no, watch: () => () => {} };
}

const collection = (engine: Engine) => engine.variableCollections({}).find((c) => c.name === "Brand")!;
const varNamed = (engine: Engine, name: string) => collection(engine).variableIds.map((id) => engine.variable(id)!).find((v) => v.name === name)!;
const hex = (c: unknown) => {
  const x = c as { r: number; g: number; b: number };
  return `#${[x.r, x.g, x.b].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("")}`.toUpperCase();
};
const logoVariants = (engine: Engine, set: string) => ((engine.readNode(set, { childIds: true })?.childIds ?? []) as string[]).map((k) => engine.readNode(k, { fields: ["name"] })?.name);
const undoLabel = (ed: EditorController) => ed.store.undo.undoLabel;

/** A post frame with a headline, a body and a CTA, as an owner draws one. */
function drawnPost(ed: EditorController, w: ReturnType<typeof editorWriter>) {
  const id = newPost(ed, w, { formatId: "instagram.post" });
  const env = { ed, write: <T,>(_l: string, fn: () => T) => fn() };
  ed.batch("Draw", () =>
    createNodes(env, {
      parentId: id,
      nodes: [
        { type: "TEXT", name: "Title", characters: "Fresh harvest", fontSize: 72, x: 80, y: 80 },
        { type: "TEXT", name: "Copy", characters: "Organic humus for every field", fontSize: 32, x: 80, y: 260 },
        { type: "TEXT", name: "Button", characters: "Order now", fontSize: 36, x: 80, y: 1100 },
      ],
    })
  );
  return id;
}

describe("Brands library (round 18b)", () => {
  it("maps a brand's colours by name, then in order, and picks On primary by contrast", () => {
    const c = brandColors(ACME);
    expect(c).toMatchObject({ Background: "#F4F1EA", Primary: "#1BA37A", Secondary: "#0E5A3C", Accent: "#FFD400", Text: "#1E1E1E" });
    expect(brandColors(BETA)).toMatchObject({ Primary: "#FFE14D", Secondary: "#FFE14D", Accent: "#FFE14D", Background: "#FFFFFF" });
    expect(onPrimary("#FFE14D")).toBe("#1E1E1E");
    expect(onPrimary("#0E5A3C")).toBe("#FFFFFF");
    // A colour left over after the slots keeps its own name.
    expect(brandColors(brand("b", "B", { colors: ["#111111", "#222222", "#333333", "#444444", "#555555", "#666666"].map((hex, i) => ({ name: i === 5 ? "Sky" : "", hex })) }))).toMatchObject({ Sky: "#666666" });
  });

  it("generates the collection, styles, Logo set and marker for two brands, idempotent, a removed brand gone", async () => {
    const { ed, engine, w } = await setup();
    const report = w("Update brands library", () => writeBrandLibrary(ed, [ACME, BETA]));
    expect(undoLabel(ed)).toBe("Update brands library");
    const c = collection(engine);
    expect(c.modes.map((m) => m.name)).toEqual(["Acme", "Beta"]);
    expect(report.modes).toEqual({ b1: c.modes[0].modeId, b2: c.modes[1].modeId });
    const primary = varNamed(engine, "Color/Primary");
    expect(hex(primary.valuesByMode[report.modes.b1])).toBe("#1BA37A");
    expect(hex(primary.valuesByMode[report.modes.b2])).toBe("#FFE14D");
    expect(hex(varNamed(engine, "Color/On primary").valuesByMode[report.modes.b2])).toBe("#1E1E1E");
    expect(varNamed(engine, "Font/Heading").valuesByMode).toEqual({ [report.modes.b1]: "Poppins", [report.modes.b2]: "Inter" });
    expect(varNamed(engine, "Font/Body").valuesByMode[report.modes.b1]).toBe("Lora");
    const styles = engine.styles(undefined, {}).filter((s) => s.styleType === "TEXT");
    expect(styles.map((s) => s.name).sort()).toEqual(["Body", "CTA", "Heading"]);
    expect(styles.find((s) => s.name === "Heading")?.text).toMatchObject({ fontSize: 64, fontName: { family: "Poppins", style: "Bold" } });
    // The Logo set on its page, a Brand variant per brand.
    const logos = engine.pages().find((p) => p.name === "Logos")!;
    expect(engine.readNode(report.logoSet!, { fields: ["name", "parentIndex"] })).toMatchObject({ name: "Logo", parentIndex: { guid: logos.guid } });
    expect(logoVariants(engine, report.logoSet!)).toEqual(["Brand=Acme", "Brand=Beta"]);
    expect(ed.store.page).not.toBe(logos.guid);
    expect(readBrandLibrary(ed)).toEqual({ v: 1, generatedFrom: { b1: 1, b2: 1 }, names: { b1: "Acme", b2: "Beta" } });
    expect(changedBrands(readBrandLibrary(ed), [ACME, { ...BETA, updated: 2 }])).toBe(1);

    // Again: nothing new.
    const counts = () => ({ vars: collection(engine).variableIds.length, modes: collection(engine).modes.length, styles: engine.styles(undefined, {}).length, variants: engine.readNode(report.logoSet!, { childIds: true })?.childIds?.length, pages: engine.pages().length });
    const before = counts();
    w("Update brands library", () => writeBrandLibrary(ed, [ACME, BETA]));
    expect(counts()).toEqual(before);

    // Beta removed, Gamma added: Beta's mode and logo go, Gamma's come.
    const GAMMA = brand("b3", "Gamma", { colors: [{ name: "", hex: "#2244AA" }] });
    w("Update brands library", () => writeBrandLibrary(ed, [ACME, GAMMA]));
    expect(collection(engine).modes.map((m) => m.name)).toEqual(["Acme", "Gamma"]);
    expect(logoVariants(engine, report.logoSet!)).toEqual(["Brand=Acme", "Brand=Gamma"]);
    expect(readBrandLibrary(ed)?.generatedFrom).toEqual({ b1: 1, b3: 1 });
    engine.command("UNDO");
    expect(collection(engine).modes.map((m) => m.name)).toEqual(["Acme", "Beta"]);
  });

  it("renames a renamed brand's mode and logo variant (matched by its id), the mode id and variant kept", async () => {
    const { ed, engine, w } = await setup();
    const report = w("Update brands library", () => writeBrandLibrary(ed, [ACME, BETA]));
    const variants = engine.readNode(report.logoSet!, { childIds: true })?.childIds;
    // Acme renamed, a new brand before it: it gets a mode of its own, not Acme's.
    const GAMMA = brand("b3", "Gamma");
    const again = w("Update brands library", () => writeBrandLibrary(ed, [GAMMA, { ...ACME, name: "Acme Agro", updated: 2 }, BETA]));
    expect(again.modes.b1).toBe(report.modes.b1);
    expect(again.modes.b3).not.toBe(report.modes.b1);
    expect(collection(engine).modes.map((m) => m.name)).toEqual(["Gamma", "Acme Agro", "Beta"]);
    expect(logoVariants(engine, report.logoSet!)).toEqual(["Brand=Acme Agro", "Brand=Beta", "Brand=Gamma"]);
    expect(engine.readNode(report.logoSet!, { childIds: true })?.childIds?.slice(0, 2)).toEqual(variants);
    expect(readBrandLibrary(ed)?.names).toEqual({ b3: "Gamma", b1: "Acme Agro", b2: "Beta" });
  });

  it("creates the file in the first folder and points every brand at it; an existing one is only opened", async () => {
    const calls: string[] = [];
    const deps = {
      createFile: async (i: { name: string; folderId: string | null }) => (calls.push(`create ${i.name} in ${i.folderId}`), { fileKey: "K1", name: i.name }),
      listFolders: async () => [{ id: "f0", trashedAt: 5 }, { id: "f1" }],
      saveBrand: async (b: { id: string; libraryFileKey: string }) => void calls.push(`save ${b.id} → ${b.libraryFileKey}`),
      open: async (key: string) => void calls.push(`open ${key}`),
    };
    expect(await createBrandsLibrary([ACME, BETA], deps)).toBe("K1");
    expect(calls).toEqual(["create Brands in f1", "save b1 → K1", "save b2 → K1", "open K1"]);
    calls.length = 0;
    expect(await createBrandsLibrary([{ ...ACME, libraryFileKey: "K9" }], deps)).toBe("K9");
    expect(calls).toEqual(["open K9"]);
  });
});

describe("make_brand_library through the manager (round 18b)", () => {
  it("ManagerEnv.brandLibrary updates the library in the library file as one step of the owner's history", async () => {
    const { ed, engine, w } = await setup();
    setBrandsRepository(repo([ACME]));
    w("Update brands library", () => writeBrandLibrary(ed, [ACME]));
    // Beta added in the Brands panel; the manager is asked to bring the library up to date.
    setBrandsRepository(repo([ACME, BETA]));
    const s = new AgentsService(ed, null, { brands: brandsUnavailable, imageRoutes: async () => [], record: () => {} });
    const env = s.managerEnv("T1", { chat: "c1", message: "m1" });
    expect(await env.brandLibrary!()).toMatchObject({ brands: ["Acme", "Beta"] });
    expect(collection(engine).modes.map((m) => m.name)).toEqual(["Acme", "Beta"]);
    expect(readBrandLibrary(ed)?.generatedFrom).toEqual({ b1: 1, b2: 1 });
    expect(undoLabel(ed)).toBe("Studio: Update brands library");
    // Elsewhere (not the library), the studio's dependency makes the file: the env hands it its editor and writer.
    const calls: string[] = [];
    const s2 = new AgentsService(ed, null, { brands: brandsUnavailable, imageRoutes: async () => [], record: () => {}, brandLibrary: async (e, wr) => (calls.push(`${e === ed} ${typeof wr}`), { fileKey: "K", brands: ["Acme"] }) });
    expect(await s2.managerEnv("T2", { chat: "c1", message: "m1" }).brandLibrary!()).toEqual({ fileKey: "K", brands: ["Acme"] });
    expect(calls).toEqual(["true function"]);
  });
});

describe("Templates (round 18b)", () => {
  it("refuses Save as template with the missing wiring named", async () => {
    const { ed, w } = await setup();
    const id = drawnPost(ed, w);
    const texts = inferSlots(ed, id);
    expect(texts.map((s) => s.role).sort()).toEqual(["body", "cta", "headline"]);
    const title = texts.find((s) => s.role === "headline")!.nodeId;
    expect(saveAsTemplate(ed, w, id, { name: "T", slots: [] })).toEqual({ error: "Tag at least one slot" });
    expect(saveAsTemplate(ed, w, id, { name: "T", slots: [{ nodeId: id, role: "headline" }] })).toEqual({ error: "Headline needs a text layer" });
    expect(saveAsTemplate(ed, w, id, { name: "T", slots: [{ nodeId: title, role: "logo" }] })).toEqual({ error: "The logo needs an instance of the Brands library's Logo component" });
    expect(saveAsTemplate(ed, w, id, { name: "T", slots: [{ nodeId: title, role: "picture" }] })).toEqual({ error: "The picture needs an image fill" });
    expect(saveAsTemplate(ed, w, id, { name: "T", slots: [{ nodeId: id, role: "background" }] })).toEqual({ error: "Background needs a fill bound to a Color variable of the Brand collection" });
    expect(readPost(ed, id)?.formatId).toBe("instagram.post");
  });

  it("saves a post as a template (set, Format variant, TEXT properties, slots) as one step, the post an instance of it", async () => {
    const { ed, engine, w } = await setup();
    const id = drawnPost(ed, w);
    const r = saveAsTemplate(ed, w, id, { name: "Product hero" });
    expect(undoLabel(ed)).toBe("Save as template");
    if ("error" in r) throw new Error(r.error);
    const set = engine.componentInfo(id)!.main!.set!;
    expect(readTemplate(ed, set)).toMatchObject({ name: "Product hero", formats: { "Instagram post": "instagram.post" }, platforms: ["instagram"], origin: "owner" });
    expect(templateVariants(ed, set)).toEqual([{ id, value: "Instagram post" }]);
    const props = engine.componentInfo(set)!.properties;
    expect(props.map((p) => `${p.type}:${p.name}`).sort()).toEqual(["TEXT:Body", "TEXT:CTA", "TEXT:Headline", "VARIANT:Format"]);
    expect(readSlot(ed, inferSlots(ed, id).find((s) => s.role === "headline")!.nodeId)?.property).toMatch(/^Headline#/);
    expect(readPost(ed, id)).toBeNull();
    expect(localTemplates(ed).map((t) => t.key)).toEqual([r.key]);
    const post = readBoard(ed, ed.store.page).posts[0];
    expect(post.data.template).toEqual({ key: r.key, variant: "Instagram post" });
    expect(engine.componentInfo(post.id)?.kind).toBe("INSTANCE");
    expect(slotTexts(ed, post.id)).toEqual({ headline: "Fresh harvest", body: "Organic humus for every field", cta: "Order now" });
    engine.command("UNDO");
    expect(engine.componentInfo(id)?.kind).not.toBe("VARIANT");
    expect(readPost(ed, id)?.formatId).toBe("instagram.post");
  });

  it("applies a template to a plain frame, its texts carried to the slots by role", async () => {
    const { ed, engine, w } = await setup();
    const { key } = saveAsTemplate(ed, w, drawnPost(ed, w), { name: "Hero" }) as { key: string };
    const plain = newPost(ed, w, { formatId: "instagram.post", campaignId: null });
    const env = { ed, write: <T,>(_l: string, fn: () => T) => fn() };
    ed.batch("Draw", () => createNodes(env, { parentId: plain, nodes: [{ type: "TEXT", name: "Big", characters: "Autumn sale", fontSize: 90 }, { type: "TEXT", name: "Small", characters: "Two for one", fontSize: 30, y: 300 }] }));
    const at = engine.readNode(plain, { fields: ["transform"] })!.transform!;
    const [made] = await applyTemplate(ed, w, [plain], { key });
    expect(undoLabel(ed)).toBe("Apply template");
    expect(engine.readNode(plain)).toBeNull();
    expect(engine.readNode(made, { fields: ["transform"] })!.transform).toMatchObject({ m02: at.m02, m12: at.m12 });
    expect(slotTexts(ed, made)).toEqual({ headline: "Autumn sale", body: "Two for one", cta: "Order now" });
    expect(readPost(ed, made)).toMatchObject({ formatId: "instagram.post", template: { key, variant: "Instagram post" } });
    engine.command("UNDO");
    expect(engine.readNode(made)).toBeNull();
    expect(engine.readNode(plain, { fields: ["name"] })).not.toBeNull();
  });

  it("fills slots through the TEXT properties, refusing a locked one, reporting an overrun, as one step", async () => {
    const { ed, engine, w } = await setup();
    const id = drawnPost(ed, w);
    const slots = inferSlots(ed, id).map((s) => ({ ...s, locked: s.role === "cta", maxChars: s.role === "headline" ? 10 : null }));
    saveAsTemplate(ed, w, id, { name: "Hero", slots });
    const post = readBoard(ed, ed.store.page).posts[0].id;
    const report = await fillSlots(ed, w, post, { headline: "A much longer headline", body: "New body", cta: "Buy" });
    expect(undoLabel(ed)).toBe("Fill slots");
    expect(report).toMatchObject({ filled: ["headline", "body"], locked: ["cta"], over: [{ role: "headline", chars: 22, maxChars: 10 }] });
    expect(slotTexts(ed, post)).toEqual({ headline: "A much longer headline", body: "New body", cta: "Order now" });
    // The main is untouched (instance overrides only).
    expect(slotTexts(ed, id)).toEqual({ headline: "Fresh harvest", body: "Organic humus for every field", cta: "Order now" });
    engine.command("UNDO");
    expect(slotTexts(ed, post).headline).toBe("Fresh harvest");
  });

  it("switches a post's brand: the Brand mode and the logo's variant, nothing else", async () => {
    const { ed, engine, w } = await setup();
    setBrandsRepository(repo([ACME, BETA]));
    const lib = w("Update brands library", () => writeBrandLibrary(ed, [ACME, BETA]));
    // A template: a background bound to Color/Primary, a logo instance of the Logo set, a headline.
    const id = newPost(ed, w, { formatId: "instagram.square" });
    const variants = engine.readNode(lib.logoSet!, { childIds: true })!.childIds as string[];
    ed.batch("Draw", () => {
      engine.runCommand("BIND_VARIABLE", { refs: [id], target: "fillPaints[0].color", variable: varNamed(engine, "Color/Primary").id } as never);
      const logo = engine.runCommand("INSERT_INSTANCE", { main: variants[0], parent: id, x: 200, y: 200 } as never).created[0] ?? engine.getSelection().refs[0];
      engine.setProps([logo], { parentIndex: { guid: id, position: "~" } } as never);
      createNodes({ ed, write: (_l, fn) => fn() }, { parentId: id, nodes: [{ type: "TEXT", name: "Title", characters: "Hello", fontSize: 64, y: 600 }] });
    });
    expect(inferSlots(ed, id).map((s) => s.role).sort()).toEqual(["background", "headline", "logo"]);
    const { key } = saveAsTemplate(ed, w, id, { name: "Brand card" }) as { key: string };
    const made = await insertTemplate(ed, w, { key, brandId: "b1" });
    expect(undoLabel(ed)).toBe("New post");
    const logo = postSlots(ed, made).find((s) => s.data.role === "logo")!.nodeId;
    const mode = () => engine.variableModes(made).find((m) => m.collectionId === collection(engine).id)?.explicitModeId;
    expect(mode()).toBe(lib.modes.b1);
    expect(engine.componentInfo(logo)?.variantProperties).toEqual({ Brand: "Acme" });
    // The headline's family follows Font/Heading in the brand's mode.
    const title = postSlots(ed, made).find((s) => s.data.role === "headline")!.nodeId;
    const family = () => (engine.readNode(title, { fields: ["fontName"] }) as { fontName?: { family: string } } | null)?.fontName?.family;
    expect(family()).toBe("Poppins");
    const before = { size: engine.readNode(made, { fields: ["size", "transform", "name"] }), texts: slotTexts(ed, made) };
    await applyBrand(ed, w, [made], "b2");
    expect(undoLabel(ed)).toBe("Apply brand");
    expect(mode()).toBe(lib.modes.b2);
    expect(engine.componentInfo(logo)?.variantProperties).toEqual({ Brand: "Beta" });
    expect(family()).toBe("Inter");
    expect(readPost(ed, made)?.brandId).toBe("b2");
    expect({ size: engine.readNode(made, { fields: ["size", "transform", "name"] }), texts: slotTexts(ed, made) }).toEqual(before);
    engine.command("UNDO");
    expect(mode()).toBe(lib.modes.b1);
    expect(engine.componentInfo(logo)?.variantProperties).toEqual({ Brand: "Acme" });
  });

  it("gives a detached template post that lost its logo the template again (Fix without a model), one step", async () => {
    const { ed, engine, w } = await setup();
    setBrandsRepository(repo([ACME]));
    const lib = w("Update brands library", () => writeBrandLibrary(ed, [ACME]));
    const id = newPost(ed, w, { formatId: "instagram.square" });
    const variants = engine.readNode(lib.logoSet!, { childIds: true })!.childIds as string[];
    ed.batch("Draw", () => {
      engine.runCommand("BIND_VARIABLE", { refs: [id], target: "fillPaints[0].color", variable: varNamed(engine, "Color/Primary").id } as never);
      engine.runCommand("INSERT_INSTANCE", { main: variants[0], parent: id, x: 200, y: 200 } as never);
      createNodes({ ed, write: (_l, fn) => fn() }, { parentId: id, nodes: [{ type: "TEXT", name: "Title", characters: "Hello", fontSize: 64, y: 600 }] });
    });
    const { key } = saveAsTemplate(ed, w, id, { name: "Brand card" }) as { key: string };
    const made = await insertTemplate(ed, w, { key, brandId: "b1" });
    // Detached, its logo deleted: the check finds it missing.
    engine.setSelection([made]);
    engine.command("DETACH_INSTANCE");
    const frame = readBoard(ed, ed.store.page).posts.find((p) => p.data.template?.key === key && engine.componentInfo(p.id)?.kind !== "INSTANCE")!.id;
    const logo = (engine.readNodes([frame], { subtree: true, fields: ["name"] }) as { guid: string; name?: string }[]).find((n) => n.name === "Logo")!.guid;
    engine.setSelection([logo]);
    engine.command("DELETE");
    applyChecks(ed, w, frame, checkPost(ed, frame));
    expect(readPost(ed, frame)?.problems.map((p) => p.id)).toContain("check:logo:missing");
    expect(fixProblem(ed, w, frame, "check:logo:missing")).toBe(true);
    expect(undoLabel(ed)).toBe("Fix problem");
    const again = readBoard(ed, ed.store.page).posts.find((p) => p.data.template?.key === key && p.id !== made)!;
    expect(engine.componentInfo(again.id)?.kind).toBe("INSTANCE");
    expect(postSlots(ed, again.id).some((s) => s.data.role === "logo")).toBe(true);
    expect(again.data.problems.map((p) => p.id)).not.toContain("check:logo:missing");
  });
});

describe("CSV import (round 18b)", () => {
  it("makes one post per row and format from a template as a new campaign's row, as one step", async () => {
    const { ed, engine, w } = await setup();
    setBrandsRepository(repo([ACME, BETA]));
    const { key } = saveAsTemplate(ed, w, drawnPost(ed, w), { name: "Hero", formats: ["instagram.story"] }) as { key: string };
    const before = readBoard(ed, ed.store.page).posts.length;
    const read = readCsvPosts('headline,body,caption,hashtags,brand\n"Autumn, at last",Two for one,Hello,#a #b,Beta\nWinter,Warm,Bye,,\n');
    if ("error" in read) throw new Error(read.error);
    const made = await importCsvPosts(ed, w, read.posts, { key, formatIds: ["instagram.post", "instagram.story"], campaign: "October", brandId: "b1", brands: [ACME, BETA] });
    expect(undoLabel(ed)).toBe("Import CSV");
    expect(made).toHaveLength(4);
    const board = readBoard(ed, ed.store.page);
    const october = board.groups.find((g) => g.campaign?.name === "October")!;
    expect(october.posts.map((p) => p.data.formatId)).toEqual(["instagram.post", "instagram.story", "instagram.post", "instagram.story"]);
    expect(new Set(october.posts.map((p) => p.y)).size).toBe(1);
    expect(slotTexts(ed, made[1])).toMatchObject({ headline: "Autumn, at last", body: "Two for one" });
    expect(engine.readNode(made[1], { fields: ["size"] })?.size).toEqual({ x: 1080, y: 1920 });
    expect(readPost(ed, made[0])).toMatchObject({ caption: "Hello", hashtags: ["a", "b"], brandId: "b2", template: { key, variant: "Instagram post" } });
    expect(readPost(ed, made[2])).toMatchObject({ caption: "Bye", hashtags: [], brandId: "b1" });
    engine.command("UNDO");
    expect(readBoard(ed, ed.store.page).posts.length).toBe(before);
    expect(readBoard(ed, ed.store.page).campaigns.map((c) => c.name)).not.toContain("October");
  });
});

describe("Templates through a library (round 18b)", () => {
  async function workspace() {
    const store = await MemoryStore.open({ storage: memoryStorage() });
    const team = await store.api({}).workspace.createFolder({ name: "Team", parentId: null });
    const EMPTY: Message = { type: "NODE_CHANGES", sessionID: 0, nodeChanges: SAMPLE_DOCUMENT.nodeChanges.filter((n) => n.type === "DOCUMENT" || n.guid === "0:1" || n.guid === "0:2") };
    const file = async (name: string) => (await store.addFile({ name, folderId: team.id, snapshot: encodeMessage(messageToKiwi(EMPTY)) })).fileKey;
    const open = async (fileKey: string) => {
      const source: StoreDocumentSource = await openStoreDocument(store.api({}), fileKey, { recordViewed: false });
      const engine = await Engine.create(null, { sessionID: source.sessionID });
      engine.load(await source.load());
      engine.setViewport(1280, 800, 1, 1280, 800);
      const ed = new EditorController(engine, new EngineStore(engine), source);
      engine.onDocumentChanged((_, e) => source.onChanges(e.message, { kind: e.kind, label: e.label }));
      await ed.libraries.refresh();
      return { ed, engine, w: editorWriter(ed) };
    };
    return { file, open };
  }

  it("publishes a template with its marker in the manifest; another file lists it, inserts it bound to a brand and switches brands", async () => {
    setBrandsRepository(repo([ACME, BETA]));
    const ws = await workspace();
    const libKey = await ws.file("Brands");
    const lib = await ws.open(libKey);
    // The Brands library and, in the same file, a template wired to it.
    const report = lib.w("Update brands library", () => writeBrandLibrary(lib.ed, [ACME, BETA]));
    const post = newPost(lib.ed, lib.w, { formatId: "instagram.post" });
    const variants = lib.engine.readNode(report.logoSet!, { childIds: true })!.childIds as string[];
    lib.ed.batch("Draw", () => {
      lib.engine.runCommand("BIND_VARIABLE", { refs: [post], target: "fillPaints[0].color", variable: varNamed(lib.engine, "Color/Primary").id } as never);
      const logo = lib.engine.runCommand("INSERT_INSTANCE", { main: variants[0], parent: post, x: 200, y: 200 } as never).created[0] ?? lib.engine.getSelection().refs[0];
      lib.engine.setProps([logo], { parentIndex: { guid: post, position: "~" } } as never);
      createNodes({ ed: lib.ed, write: (_l, fn) => fn() }, { parentId: post, nodes: [{ type: "TEXT", name: "Title", characters: "Hello", fontSize: 64, y: 600 }] });
    });
    const saved = saveAsTemplate(lib.ed, lib.w, post, { name: "Brand card", formats: ["linkedin.square"] });
    if ("error" in saved) throw new Error(saved.error);
    expect(readTemplate(lib.ed, saved.set)?.formats).toEqual({ "Instagram post": "instagram.post", "LinkedIn square": "linkedin.square" });
    const draft = await draftPublish(lib.ed);
    const item = draft.items.find((i) => i.key === saved.key)!;
    expect(item.social?.template).toMatchObject({ name: "Brand card", platforms: ["instagram", "linkedin"] });
    expect(item.social?.slots?.find((s) => s.role === "headline")).toMatchObject({ property: expect.stringMatching(/^Headline#/), locked: false });
    const v = await publishLibrary(lib.ed, draft, { description: "", selected: new Set(draft.items.map((i) => i.key)), moveModes: new Map() });
    expect(v.assets.find((a) => a.key === saved.key)?.social?.template.name).toBe("Brand card");

    // Another file: the library enabled, the template listed from the manifest, inserted for LinkedIn bound to Acme.
    const app = await ws.open(await ws.file("Campaign"));
    await setLibraryEnabled(app.ed, libKey, true);
    expect(templateIndex(app.ed).map((e) => [e.name, e.library, e.node])).toEqual([["Brand card", libKey, null]]);
    // Its slots come with the manifest: list_templates shows them before the template is first used.
    const listed = JSON.parse((await runTool({ ed: app.ed, write: app.w }, "list_templates", {})).content.map((c) => (c.type === "text" ? c.text : "")).join("")) as { source: string; slots: { role: string }[] }[];
    expect(listed.map((x) => [x.source, x.slots.map((s) => s.role).sort()])).toEqual([[expect.any(String), ["background", "headline", "logo"]]]);
    const made = await insertTemplate(app.ed, app.w, { key: saved.key, formatId: "linkedin.square", brandId: "b1" });
    expect(app.engine.readNode(made, { fields: ["size"] })?.size).toEqual({ x: 1200, y: 1200 });
    expect(readPost(app.ed, made)).toMatchObject({ formatId: "linkedin.square", brandId: "b1", template: { key: saved.key, variant: "LinkedIn square" } });
    const remote = app.engine.variableCollections({ includeRemote: true }).find((c) => c.name === "Brand")!;
    const mode = () => app.engine.variableModes(made).find((m) => m.collectionId === remote.id)?.explicitModeId;
    const logo = postSlots(app.ed, made).find((s) => s.data.role === "logo")!.nodeId;
    expect(remote.modes.find((m) => m.modeId === mode())?.name).toBe("Acme");
    expect(app.engine.componentInfo(logo)?.variantProperties).toEqual({ Brand: "Acme" });
    await applyBrand(app.ed, app.w, [made], "b2");
    expect(remote.modes.find((m) => m.modeId === mode())?.name).toBe("Beta");
    expect(app.engine.componentInfo(logo)?.variantProperties).toEqual({ Brand: "Beta" });
  });
});
