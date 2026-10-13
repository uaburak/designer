// @vitest-environment happy-dom
// Studio's library on the editor's side (docs/studio.md §3): the Brand and Product forms (pictures staged by a file
// input, written on save), the Brands panel's pages, and the manager's library tools — all on an in-memory library.
import { act, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { $, $$, mount, type Mounted } from "@/ds/__tests__/dom";
import type { AiRunEventMsg, AiRunRequest } from "@shared/ai/types";
import { BrandsService } from "../../../../store/brands/service";
import { missingFor } from "../../../../shared/studio/library";
import type { EditorController } from "../controller";
import { EditorContext } from "../controller";
import { BrandForm, ProductForm, setBrandsRepository } from "../studio/forms";
import { BrandsPanel } from "../studio/BrandsPanel";
import { LIBRARY_TOOLS, runLibraryTool, setLibraryRepository, setLibraryToolsBackend } from "../studio/libraryTools";

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
const ed = {} as EditorController;
const call = async (name: string, args: Record<string, unknown>) => {
  const r = await runLibraryTool(ed, name, args);
  const first = r.content[0];
  return { r, text: first?.type === "text" ? first.text : "", json: first?.type === "text" && !r.isError ? (JSON.parse(first.text) as Record<string, unknown>) : null };
};

function setInput(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  act(() => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

let svc: BrandsService;
let view: Mounted | null = null;
beforeEach(() => {
  svc = library();
  setBrandsRepository(svc.repository());
  setLibraryRepository(svc.repository());
});
afterEach(() => {
  view?.unmount();
  view = null;
  setBrandsRepository(null);
  setLibraryRepository(null);
  setLibraryToolsBackend(null);
});

describe("the forms", () => {
  it("BrandForm saves the name, a colour and a staged logo", async () => {
    const done = vi.fn();
    view = mount(BrandForm, { onDone: done, onCancel: () => {} });
    const form = $("[data-brand-form]");
    const name = $('input[aria-label="Brand name"]', form) as HTMLInputElement;
    setInput(name, "Partner Agro");
    act(() => $$("button", form).find((b) => b.textContent === "Add colour")!.click());
    setInput($('input[aria-label="Colour 1 name"]', form) as HTMLInputElement, "Leaf");
    setInput($('input[aria-label="Colour 1 hex"]', form) as HTMLInputElement, "#1ba37a");
    // a logo through the file input
    const file = new File([PNG], "logo.png", { type: "image/png" });
    const input = $('[data-file-input="logo"]', form) as HTMLInputElement;
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    act(() => void input.dispatchEvent(new Event("change", { bubbles: true })));
    await tick();
    expect($$('[data-picture="staged"]', form)).toHaveLength(1);
    act(() => $("[data-save]", form).click());
    await tick();
    expect(done).toHaveBeenCalledTimes(1);
    const [brand] = await svc.list();
    expect(brand.name).toBe("Partner Agro");
    expect(brand.colors).toEqual([{ name: "Leaf", hex: "#1BA37A" }]);
    expect(brand.logos).toHaveLength(1);
    expect(brand.logos[0]).toMatchObject({ role: "logo", width: 40, height: 60, name: "logo.png" });
    expect(brand.formats.map((f) => f.name)).toEqual(["Post", "Story", "Square post"]);
  });

  it("BrandForm refuses a file that isn't a picture, and Cancel writes nothing", async () => {
    const cancel = vi.fn();
    view = mount(BrandForm, { onDone: () => {}, onCancel: cancel });
    const form = $("[data-brand-form]");
    const input = $('[data-file-input="logo"]', form) as HTMLInputElement;
    Object.defineProperty(input, "files", { value: [new File(["x"], "notes.txt", { type: "text/plain" })], configurable: true });
    act(() => void input.dispatchEvent(new Event("change", { bubbles: true })));
    await tick();
    expect($('[role="alert"]', form).textContent).toContain("isn't a PNG, JPEG or WebP");
    act(() => $$("button", form).find((b) => b.textContent === "Cancel")!.click());
    expect(cancel).toHaveBeenCalled();
    expect(await svc.list()).toEqual([]);
  });

  it("ProductForm saves label texts with tiers; editing them leaves them unchecked", async () => {
    const brand = await svc.saveBrand({ name: "Partner Agro" });
    const done = vi.fn();
    view = mount(ProductForm, { brandId: brand.id, onDone: done, onCancel: () => {} });
    const form = $("[data-product-form]");
    setInput($('input[aria-label="Product name"]', form) as HTMLInputElement, "Liq Humus");
    setInput($('textarea[aria-label="Shape"]', form) as HTMLTextAreaElement, "20 L jerrycan");
    act(() => $$("button", form).find((b) => b.textContent === "Add text")!.click());
    setInput($('input[aria-label="Label text 1"]', form) as HTMLInputElement, "LIQ HUMUS");
    act(() => $$("button", form).find((b) => b.textContent === "Add text")!.click());
    setInput($('input[aria-label="Label text 2"]', form) as HTMLInputElement, "Içindekiler …");
    act(() => $("[data-save]", form).click());
    await tick();
    expect(done).toHaveBeenCalledTimes(1);
    const p = (await svc.get(brand.id))!.products[0];
    expect(p).toMatchObject({ name: "Liq Humus", shape: "20 L jerrycan", labelsConfirmed: false });
    expect(p.labels.map((l) => [l.text, l.tier])).toEqual([["LIQ HUMUS", "sharp"], ["Içindekiler …", "sharp"]]);
  });
});

describe("the Brands panel", () => {
  it("lists brands, opens a brand and a product, shows the label table", async () => {
    const brand = await svc.saveBrand({ name: "Partner Agro", colors: [{ name: "Leaf", hex: "#1BA37A" }], tone: "calm" });
    await svc.saveProduct({ brandId: brand.id, name: "Liq Humus", shape: "20 L jerrycan", labels: [{ text: "LIQ HUMUS", tier: "sharp" }] });
    view = mount(() => createElement(EditorContext.Provider, { value: ed }, createElement(BrandsPanel)), {});
    await tick();
    expect($$("[data-brand]")).toHaveLength(1);
    act(() => $("[data-brand]").click());
    await tick();
    expect($("[data-brand-page]").textContent).toContain("Leaf #1BA37A");
    expect($("[data-brand-page]").textContent).toContain("1080 × 1350");
    act(() => $("[data-product]").click());
    await tick();
    const page = $("[data-product-page]");
    expect($('input[aria-label="Label text"]', page)).not.toBeNull();
    expect(page.textContent).toContain("20 L jerrycan");
    expect($("[data-read-labels]", page).hasAttribute("disabled")).toBe(true);
  });

  it("shows an empty state with no brands", async () => {
    view = mount(() => createElement(EditorContext.Provider, { value: ed }, createElement(BrandsPanel)), {});
    await tick();
    expect(document.body.textContent).toContain("No brands yet");
  });
});

describe("the library tools", () => {
  it("lists the eight tools of §3.3, none of them a document write", () => {
    expect(LIBRARY_TOOLS.map((t) => t.name)).toEqual(["library_find", "library_get", "library_missing", "library_save_brand", "library_save_product", "library_add_image", "library_read_labels", "library_image"]);
    expect(LIBRARY_TOOLS.every((t) => !t.write && t.inputSchema.type === "object")).toBe(true);
  });

  it("saves, finds and reports what is missing", async () => {
    const { json: brand } = await call("library_save_brand", { name: "Partner Agro", colors: [{ name: "Leaf", hex: "#1ba37a" }] });
    const brandId = brand!.id as string;
    const { json: product } = await call("library_save_product", { brandId, name: "Liq Humus", shape: "20 L jerrycan" });
    const found = (await call("library_find", { query: "liq HUMUS" })).json as { products: { brandId: string; brand: string }[] };
    expect(found.products).toEqual([expect.objectContaining({ brandId, brand: "Partner Agro" })]);
    const missing = (await call("library_missing", { brandId, productIds: [product!.id] })).json as unknown as { field: string }[];
    expect(missing.map((m) => m.field)).toEqual(["logo", "packshot", "labels"]);
    expect(missing).toEqual(missingFor((await svc.get(brandId))!, (await svc.get(brandId))!.products));
    const got = (await call("library_get", { brandId })).json as { products: { labels: unknown[]; images: unknown[] }[] };
    expect(got.products[0].images).toEqual([]);
    expect((await call("library_get", { brandId: "nope" })).r.isError).toBe(true);
  });

  it("adds pictures from base64, refuses paths, and returns a picture as an image", async () => {
    const brandId = (await call("library_save_brand", { name: "B" })).json!.id as string;
    const productId = (await call("library_save_product", { brandId, name: "P" })).json!.id as string;
    const added = await call("library_add_image", { brandId, productId, role: "packshot", data: `data:image/png;base64,${b64}`, name: "front.png" });
    expect(added.json).toMatchObject({ role: "packshot", width: 40, height: 60 });
    const path = await call("library_add_image", { brandId, productId, role: "packshot", path: "/tmp/x.png" });
    expect(path.r.isError).toBe(true);
    expect(path.text).toMatch(/path can't be read/);
    const bad = await call("library_add_image", { brandId, productId, role: "packshot", data: Buffer.from("GIF89a").toString("base64") });
    expect(bad.r.isError).toBe(true);
    const imageId = (added.json as { id: string }).id;
    const shown = await runLibraryTool(ed, "library_image", { brandId, imageId });
    expect(shown.content[0]).toMatchObject({ type: "image", data: b64, mimeType: "image/png" });
  });

  it("reads label texts off the photos through the text route and saves them unconfirmed", async () => {
    const brandId = (await call("library_save_brand", { name: "B" })).json!.id as string;
    const productId = (await call("library_save_product", { brandId, name: "Liq Humus", labels: [{ text: "old", tier: "sharp" }], labelsConfirmed: true })).json!.id as string;
    await call("library_add_image", { brandId, productId, role: "label", data: b64 });
    await call("library_add_image", { brandId, productId, role: "packshot", data: b64 });
    const requests: AiRunRequest[] = [];
    const recorded: unknown[] = [];
    const listeners = new Set<(m: AiRunEventMsg) => void>();
    setLibraryToolsBackend({
      api: {
        onEvent: (cb) => (listeners.add(cb), () => void listeners.delete(cb)),
        cancel: async () => {},
        run: async (req) => {
          requests.push(req);
          const emit = (event: AiRunEventMsg["event"]) => listeners.forEach((l) => l({ runId: req.runId, event }));
          setTimeout(() => {
            emit({ type: "result", text: "", json: { texts: [{ text: "LIQ HUMUS", tier: "sharp" }, { text: "Net 20 Litre", tier: "sharp" }, { text: "İçindekiler: hümik asit", tier: "soft" }, { text: "  ", tier: "soft" }] } });
            emit({ type: "done" });
          }, 1);
        },
      },
      record: async (e) => void recorded.push(e),
      shrink: async (data, mime) => ({ data, mime }),
    });
    const out = await call("library_read_labels", { brandId, productId });
    expect(out.r.isError).toBeUndefined();
    expect(requests).toHaveLength(1);
    expect(requests[0].images?.map((i) => i.name)).toEqual(["label-1", "packshot-2"]);
    expect(requests[0].schema).toBeTruthy();
    const saved = (await svc.get(brandId))!.products[0];
    expect(saved.labels.map((l) => [l.text, l.tier])).toEqual([["LIQ HUMUS", "sharp"], ["Net 20 Litre", "sharp"], ["İçindekiler: hümik asit", "soft"]]);
    expect(saved.labelsConfirmed).toBe(false);
    expect(recorded).toHaveLength(1);
  });

  it("reads no labels without pictures, or without the text model", async () => {
    const brandId = (await call("library_save_brand", { name: "B" })).json!.id as string;
    const productId = (await call("library_save_product", { brandId, name: "P" })).json!.id as string;
    expect((await call("library_read_labels", { brandId, productId })).text).toMatch(/no pictures/);
    await call("library_add_image", { brandId, productId, role: "packshot", data: b64 });
    setLibraryToolsBackend({ api: null });
    expect((await call("library_read_labels", { brandId, productId })).text).toMatch(/desktop app/);
  });
});
