// @vitest-environment happy-dom
// The Brands view (docs/studio.md §3.2), on an in-memory library: the list's cards with their counts, readiness bars
// and gaps; a brand's page filtered by series and readiness, its picks and the bulk bar; a product's page with its
// readiness steps, arrows and path; the product form's Series; and the view's pure rules.
import { act, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { $, $$, mount, type Mounted } from "@/ds/__tests__/dom";
import { BrandsService } from "../../../../store/brands/service";
import type { Brand, Product } from "../../../../shared/studio/types";
import { ProductForm, setBrandsRepository } from "../studio/forms";
import { BrandsView } from "../studio/brands/BrandsView";
import { NO_FILTER, brandStats, designRequest, filterProducts, productGap, productReadiness, seriesCounts } from "../studio/brands/model";
import type { BrandsActions } from "../studio/brands/parts";
import { BrandsWindow } from "../studio/brands/BrandsWindow";
import { EditorContext, type EditorController } from "../controller";
import { Store, type UIState } from "../uiStore";
import { FileBrowser } from "../../files/FileBrowser";
import type { FilesBackend } from "../../files/storeAccess";
import { MemoryWorkspace } from "../../files/__tests__/memoryWorkspace";

const PNG = (() => {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, 40);
  new DataView(b.buffer).setUint32(20, 60);
  return b;
})();
const b64 = Buffer.from(PNG).toString("base64");

function library() {
  const text = new Map<string, string>();
  const bytes = new Map<string, Uint8Array>();
  let n = 0;
  return new BrandsService({
    read: async (k) => text.get(k) ?? null,
    write: async (k, v) => void text.set(k, v),
    readBytes: async (k) => bytes.get(k) ?? null,
    writeBytes: async (k, v) => void bytes.set(k, v),
    remove: async (k) => {
      for (const m of [text, bytes]) for (const key of [...m.keys()]) if (key === k || key.startsWith(`${k}/`)) m.delete(key);
    },
    brandIds: async () => [...new Set([...text.keys()].map((k) => k.split("/")[0]))],
    newId: () => `id${++n}`,
    now: () => 1000 + n,
    log: () => {},
  });
}

const tick = () => act(() => new Promise((r) => setTimeout(r, 10)));
async function until(check: () => void) {
  for (let i = 0; ; i++) {
    await tick();
    try {
      return check();
    } catch (err) {
      if (i >= 200) throw err;
    }
  }
}
function setInput(el: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const click = (el: Element) => act(() => (el as HTMLElement).click());
const names = () => $$("[data-product]").map((c) => $("button[class*='productName']", c).textContent);

let svc: BrandsService;
let view: Mounted | null = null;
beforeEach(() => {
  svc = library();
  setBrandsRepository(svc.repository());
});
afterEach(() => {
  view?.unmount();
  view = null;
  setBrandsRepository(null);
});

/** MTM Agro: a logo, two colours, Inter; Venta Fe (photo, confirmed labels), Venta Zn (labels unconfirmed), Seipasa K (nothing) */
async function mtm() {
  const brand = await svc.saveBrand({ name: "MTM Agro", colors: [{ name: "Leaf", hex: "#1BA37A" }, { name: "Soil", hex: "#5A3E2B" }], fonts: ["Inter"], tone: "Calm and close to the farmer. Plain words." });
  await svc.addImage({ brandId: brand.id, productId: null, role: "logo", name: "logo.png", data: b64 });
  const fe = await svc.saveProduct({ brandId: brand.id, name: "Venta Fe", series: "Venta", shape: "1 L bottle", labels: [{ text: "VENTA FE", tier: "sharp" }], labelsConfirmed: true });
  await svc.addImage({ brandId: brand.id, productId: fe.id, role: "packshot", name: "fe.png", data: b64 });
  const zn = await svc.saveProduct({ brandId: brand.id, name: "Venta Zn", series: "Venta", labels: [{ text: "VENTA ZN", tier: "sharp" }] });
  const k = await svc.saveProduct({ brandId: brand.id, name: "Seipasa K", series: "Seipasa" });
  const loose = await svc.saveProduct({ brandId: brand.id, name: "Agro Mix" });
  return { brand: (await svc.get(brand.id))!, fe, zn, k, loose };
}

function fakeActions() {
  const a = { askAgent: vi.fn<BrandsActions["askAgent"]>(), designPosts: vi.fn<BrandsActions["designPosts"]>(), readLabels: vi.fn<BrandsActions["readLabels"]>(async () => null) };
  return a satisfies BrandsActions;
}

describe("I · the list", () => {
  it("shows each brand as a card: counts, colours, readiness bars and its gaps", async () => {
    await mtm();
    await svc.saveBrand({ name: "Partner Agro" });
    view = mount(BrandsView, {});
    await until(() => expect($$("[data-brand]")).toHaveLength(2));
    const [m, p] = $$("[data-brand]");
    expect($("[data-brand-meta]", m).textContent).toBe("4 products · 2 series · 1 logo · Inter");
    expect($$("[data-meter]", m).map((x) => x.textContent)).toEqual(["Product photos1/4", "Label texts confirmed1/4"]);
    expect($$('[class*="swatches"] > span', m)).toHaveLength(2);
    expect($("[data-brand-gaps]", m)).toBeNull();
    expect($("[data-brand-gaps]", p).textContent).toBe("No logo yet · No colours yet · No font yet · No products yet");
    expect($("[data-brands-new-card]")).not.toBeNull();
    expect($('[data-brands-library="create"]')).not.toBeNull();
  });

  it("searches brands by their products' names too", async () => {
    await mtm();
    await svc.saveBrand({ name: "Partner Agro" });
    view = mount(BrandsView, {});
    await until(() => expect($$("[data-brand]")).toHaveLength(2));
    setInput($('input[aria-label="Search brands and products"]') as HTMLInputElement, "seipasa");
    expect($$("[data-brand]").map((c) => c.getAttribute("data-brand"))).toHaveLength(1);
    expect($("[data-brand]").textContent).toContain("MTM Agro");
    setInput($('input[aria-label="Search brands and products"]') as HTMLInputElement, "nothing like it");
    expect($$("[data-brand]")).toHaveLength(0);
    expect(document.body.textContent).toContain("No brand or product matches.");
  });

  it("shows an empty state with no brands, and Esc on the list closes the view", async () => {
    const close = vi.fn();
    view = mount(BrandsView, { onClose: close });
    await until(() => expect(document.body.textContent).toContain("No brands yet"));
    act(() => void $("[data-brands-view]").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe("J · a brand's page", () => {
  it("filters its products by series and readiness", async () => {
    const { brand } = await mtm();
    view = mount(BrandsView, { initial: { page: "brand", brandId: brand.id } });
    await until(() => expect($$("[data-product]")).toHaveLength(4));
    expect($("[data-brand-page]").textContent).toContain("Calm and close to the farmer.");
    expect(names()).toEqual(["Agro Mix", "Seipasa K", "Venta Fe", "Venta Zn"]);
    const rows = $$("[data-series-filter]").map((r) => r.textContent);
    expect(rows).toEqual(["All4", "Seipasa1", "Venta2", "No series1"]);
    click($('[data-series-filter="venta"]'));
    expect(names()).toEqual(["Venta Fe", "Venta Zn"]);
    expect($('[data-series-filter="venta"]').getAttribute("aria-pressed")).toBe("true");
    click($('[data-filter="labels"] input'));
    expect(names()).toEqual(["Venta Zn"]);
    click($('[data-series-filter="none"]'));
    expect(names()).toEqual(["Agro Mix"]);
    click($('[data-series-filter="all"]'));
    click($('[data-filter="labels"] input'));
    click($('[data-filter="photo"] input'));
    expect(names()).toEqual(["Agro Mix", "Seipasa K", "Venta Zn"]);
    // A card's badge: its first gap and how many more
    const zn = $$("[data-product]").find((c) => c.textContent?.includes("Venta Zn"))!;
    expect($("[data-gap]", zn).textContent).toBe("No photo +2");
    expect($("[data-gap]", zn).parentElement!.textContent).toContain("Venta");
  });

  it("picks products for the bulk bar: Ask the agent to design… gets them, × clears", async () => {
    const { brand } = await mtm();
    const actions = fakeActions();
    view = mount(BrandsView, { actions, initial: { page: "brand", brandId: brand.id } });
    await until(() => expect($$("[data-product]")).toHaveLength(4));
    expect($("[data-bulk-bar]")).toBeNull();
    const card = (name: string) => $$("[data-product]").find((c) => c.textContent?.includes(name))!;
    click($("[data-product-pick] input", card("Venta Fe")));
    click($("[data-product-pick] input", card("Venta Zn")));
    expect($("[data-bulk-bar]").textContent).toContain("2 products selected");
    click($("[data-bulk-design]"));
    expect(actions.designPosts).toHaveBeenCalledTimes(1);
    const [b, picked] = actions.designPosts.mock.calls[0] as [Brand, Product[]];
    expect(b.id).toBe(brand.id);
    expect(picked.map((p) => p.name).sort()).toEqual(["Venta Fe", "Venta Zn"]);
    click($("[data-bulk-read]"));
    await until(() => expect(actions.readLabels).toHaveBeenCalledTimes(1)); // only Venta Fe has a picture
    click($("[data-bulk-clear]"));
    expect($("[data-bulk-bar]")).toBeNull();
    // The header's agent buttons
    click($("[data-brand-design]"));
    expect(actions.designPosts).toHaveBeenLastCalledWith(expect.objectContaining({ id: brand.id }), []);
    click($("[data-brand-ask]"));
    expect(actions.askAgent).toHaveBeenCalledWith("About MTM Agro: ");
  });

  it("without the editor (Home): no picks, no agent buttons", async () => {
    const { brand } = await mtm();
    view = mount(BrandsView, { initial: { page: "brand", brandId: brand.id } });
    await until(() => expect($$("[data-product]")).toHaveLength(4));
    expect($$("[data-product-pick]")).toHaveLength(0);
    expect($("[data-brand-design]")).toBeNull();
    expect($("[data-brand-ask]")).toBeNull();
    expect($("[data-brand-edit]")).not.toBeNull();
  });

  it("shows the identity and the formats in their tabs", async () => {
    const { brand } = await mtm();
    view = mount(BrandsView, { initial: { page: "brand", brandId: brand.id } });
    await until(() => expect($$("[data-product]")).toHaveLength(4));
    click($$('[role="tab"]').find((x) => x.textContent?.startsWith("Identity"))!);
    const identity = $("[data-brand-identity]");
    expect(identity.textContent).toContain("Leaf");
    expect(identity.textContent).toContain("#1BA37A");
    expect(identity.textContent).toContain("Inter");
    click($$('[role="tab"]').find((x) => x.textContent?.startsWith("Formats"))!);
    expect($("[data-brand-formats]").textContent).toContain("1080 × 1350");
  });
});

describe("K · a product's page", () => {
  it("ticks the readiness steps, steps through the products and goes back by its path", async () => {
    const { brand, zn } = await mtm();
    const actions = fakeActions();
    view = mount(BrandsView, { actions, initial: { page: "brand", brandId: brand.id } });
    await until(() => expect($$("[data-product]")).toHaveLength(4));
    click($('[data-series-filter="venta"]'));
    click($("button[class*='productName']", $$("[data-product]")[1]));
    await until(() => expect($(`[data-product-page="${zn.id}"]`)).not.toBeNull());
    const steps = $$("[data-step]").map((s) => [s.getAttribute("data-step"), s.hasAttribute("data-done")]);
    expect(steps).toEqual([
      ["brand", true],
      ["logo", true],
      ["colors", true],
      ["product", true],
      ["packshot", false],
      ["shape", false],
      ["labels", true],
      ["labels-confirmed", false],
    ]);
    expect($("[data-readiness]").textContent).toContain("5/8");
    click($("[data-complete-agent]"));
    expect(actions.askAgent.mock.calls[0][0]).toContain("Venta Zn has no product photo");
    expect($('input[aria-label="Label text"]').getAttribute("value") ?? ($('input[aria-label="Label text"]') as HTMLInputElement).value).toBe("VENTA ZN");
    expect($("[data-read-labels]").hasAttribute("disabled")).toBe(true);
    expect($("[data-product-crumbs]").textContent).toBe("Brands/MTM Agro/Venta/Venta Zn");
    // The arrows follow the brand page's filter (Venta): Venta Fe before, nothing after
    expect($("[data-product-next]").hasAttribute("disabled")).toBe(true);
    click($("[data-product-prev]"));
    await until(() => expect($("[data-product-page]").textContent).toContain("1 L bottle"));
    expect($$("[data-step]").every((s) => s.hasAttribute("data-done"))).toBe(true);
    expect($("[data-complete-agent]")).toBeNull();
    // The series in the path: the brand's page on that series
    click($$("[data-product-crumbs] button").find((b) => b.textContent === "Venta")!);
    await until(() => expect(names()).toEqual(["Venta Fe", "Venta Zn"]));
  });

  it("adds a picture from the tile and confirms the label texts", async () => {
    const { brand, zn } = await mtm();
    view = mount(BrandsView, { initial: { page: "product", brandId: brand.id, productId: zn.id } });
    await until(() => expect($("[data-product-page]")).not.toBeNull());
    expect($("[data-read-labels]")).toBeNull(); // no text model at Home
    const input = $('[data-file-input="packshot"]') as HTMLInputElement;
    Object.defineProperty(input, "files", { value: [new File([PNG], "zn.png", { type: "image/png" })], configurable: true });
    act(() => void input.dispatchEvent(new Event("change", { bubbles: true })));
    await until(() => expect($$("[data-thumb]")).toHaveLength(1));
    expect((await svc.get(brand.id))!.products.find((p) => p.id === zn.id)!.images.map((i) => i.role)).toEqual(["packshot"]);
    click($("[data-labels-confirmed] input"));
    await until(() => expect(($("[data-labels-confirmed] input") as HTMLInputElement).checked).toBe(true));
    expect((await svc.get(brand.id))!.products.find((p) => p.id === zn.id)!.labelsConfirmed).toBe(true);
  });
});

describe("the product form's Series", () => {
  it("offers the brand's series and saves the one picked", async () => {
    const { brand } = await mtm();
    const done = vi.fn();
    view = mount(ProductForm, { brandId: brand.id, onDone: done, onCancel: () => {} });
    await until(() => expect($$("[data-series-suggestion]").map((b) => b.textContent)).toEqual(["Seipasa", "Venta"]));
    setInput($('input[aria-label="Product name"]') as HTMLInputElement, "Venta Mn");
    click($('[data-series-suggestion="Venta"]'));
    expect(($('input[aria-label="Series"]') as HTMLInputElement).value).toBe("Venta");
    click($("[data-save]"));
    await until(() => expect(done).toHaveBeenCalledTimes(1));
    expect((await svc.get(brand.id))!.products.find((p) => p.name === "Venta Mn")!.series).toBe("Venta");
  });

  it("a new product from a series' page starts in that series", async () => {
    const { brand } = await mtm();
    view = mount(BrandsView, { initial: { page: "brand", brandId: brand.id } });
    await until(() => expect($$("[data-product]")).toHaveLength(4));
    click($('[data-series-filter="seipasa"]'));
    click($("[data-product-new]"));
    await until(() => expect(($('input[aria-label="Series"]') as HTMLInputElement).value).toBe("Seipasa"));
  });
});

describe("over the editor (the Brands tab)", () => {
  function editor(ui: Partial<UIState>, editorType: "design" | "buzz" = ui.mode === "social" ? "buzz" : "design") {
    const store = new Store<UIState>({ railTab: "brands", mode: "social", ...ui } as UIState);
    const ed = { ui: store, source: { editorType }, focusCanvas: vi.fn(), setTool: vi.fn() } as unknown as EditorController;
    view = mount(() => createElement(EditorContext.Provider, { value: ed }, createElement(BrandsWindow)), {});
    return { ed, store };
  }

  it("shows while the tab is chosen; Esc on the list or another tab closes it", async () => {
    await mtm();
    const { store, ed } = editor({ mode: "design" });
    await until(() => expect($$("[data-brand]")).toHaveLength(1));
    expect($("[data-brands-window]").getAttribute("role")).toBe("dialog");
    act(() => store.set({ railTab: "assets" }));
    expect($("[data-brands-window]")).toBeNull();
    act(() => store.set({ railTab: "brands", variablesOpen: true }));
    expect($("[data-brands-window]")).toBeNull();
    act(() => store.set({ variablesOpen: false }));
    await until(() => expect($$("[data-brand]")).toHaveLength(1));
    act(() => void $("[data-brand]").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(store.get().railTab).toBe("file");
    expect(ed.focusCanvas).toHaveBeenCalled();
  });

  it("Design posts goes to the agent with the request — a Social file's board on the brand; a Design file stays in Design", async () => {
    const { brand } = await mtm();
    const { store } = editor({ mode: "social" });
    await until(() => expect($$("[data-brand]")).toHaveLength(1));
    click($("button[class*='cardName']"));
    await until(() => expect($("[data-brand-design]")).not.toBeNull());
    click($("[data-brand-design]"));
    expect(store.get()).toMatchObject({ railTab: "agents", socialBrandId: brand.id, socialDraft: { text: "Design posts for MTM Agro: " } });
    expect($("[data-brands-window]")).toBeNull();
    view?.unmount();
    // A Design file: the left panel's Agents tab, still Design (docs/social.md §18)
    const design = editor({ mode: "design" });
    await until(() => expect($$("[data-brand]")).toHaveLength(1));
    click($("button[class*='cardName']"));
    await until(() => expect($("[data-brand-design]")).not.toBeNull());
    click($("[data-brand-design]"));
    expect(design.store.get()).toMatchObject({ mode: "design", railTab: "agents", socialDraft: { text: "Design posts for MTM Agro: " } });
    expect(design.store.get().socialBrandId).toBeUndefined();
  });
});

describe("Home › Brands", () => {
  it("is in Home's sidebar and shows the same view, full page", async () => {
    await mtm();
    const ws = new MemoryWorkspace({ teamName: "My team" });
    const backend: FilesBackend = { workspace: ws, source: "memory", thumbnailUrl: () => null };
    view = mount(FileBrowser, { backend, initialLocation: { kind: "drafts" }, toast: () => {}, openDeps: { navigate: () => {} } });
    await tick();
    const item = $$('nav [data-ds="SidebarItem"]').find((el) => el.textContent?.trim() === "Brands")!;
    expect(item).toBeTruthy();
    act(() => void item.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
    await until(() => expect($$("[data-brand]")).toHaveLength(1));
    expect(item.getAttribute("aria-current")).toBe("page");
    expect($("main").getAttribute("aria-label")).toBe("Brands");
    expect($("[data-brands-close]")).toBeNull();
    click($("button[class*='cardName']"));
    await until(() => expect($$("[data-product]")).toHaveLength(4));
    expect($("[data-brand-design]")).toBeNull();
  });
});

describe("the view's rules", () => {
  it("counts, orders and finds", async () => {
    const { brand } = await mtm();
    expect(brandStats(brand)).toEqual({ products: 4, series: 2, logos: 1, withPhoto: 1, labelsConfirmed: 1 });
    expect(seriesCounts(brand.products)).toEqual({ series: [{ key: "seipasa", name: "Seipasa", count: 1 }, { key: "venta", name: "Venta", count: 2 }], none: 1 });
    expect(filterProducts(brand.products, { ...NO_FILTER, sort: "series" }).map((p) => p.name)).toEqual(["Seipasa K", "Venta Fe", "Venta Zn", "Agro Mix"]);
    expect(filterProducts(brand.products, { ...NO_FILTER, query: "zn" }).map((p) => p.name)).toEqual(["Venta Zn"]);
    expect(productGap(brand.products.find((p) => p.name === "Venta Fe")!)).toBeNull();
    const bare = { ...brand, logos: [], colors: [] };
    expect(productReadiness(bare, brand.products[0]).steps.filter((s) => !s.done).map((s) => s.field)).toEqual(["logo", "colors"]);
    expect(designRequest(brand, [])).toBe("Design posts for MTM Agro: ");
    expect(designRequest(brand, brand.products.slice(0, 2))).toBe("Design posts for MTM Agro with Venta Fe, Venta Zn: ");
  });
});
