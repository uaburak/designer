/**
 * The `brands` repository (docs/studio.md §3.1): pictures checked by their bytes, find with case and accent folding
 * (Turkish too), events after every change, removal; on a memory host, then through the real LocalStore's files.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StoreError } from "../../shared/store/protocol";
import { openTestStore, type TestStore } from "../testing/harness";
import { BrandsService, type BrandsHost } from "./service";
import { readBrandImage } from "./imageInfo";

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

function png(width: number, height: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, height);
  return b;
}
function jpeg(width: number, height: number): Uint8Array {
  // SOI, an APP0 segment of length 4, SOF0 (length 11)
  const b = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, height >> 8, height & 255, width >> 8, width & 255, 1, 1, 0x11, 0, 0xff, 0xd9]);
  return b;
}
function webpLossless(width: number, height: number): Uint8Array {
  const b = new Uint8Array(30);
  b.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x4c, 0, 0, 0, 0, 0x2f]);
  const bits = (width - 1) | ((height - 1) << 14);
  new DataView(b.buffer).setUint32(21, bits, true);
  return b;
}

function memoryHost() {
  const text = new Map<string, string>();
  const bytes = new Map<string, Uint8Array>();
  let n = 0;
  const host: BrandsHost = {
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
  };
  return { host, text, bytes };
}

describe("picture bytes", () => {
  it("reads PNG, JPEG and WebP sizes from the headers", () => {
    expect(readBrandImage(png(640, 480))).toEqual({ mime: "image/png", width: 640, height: 480 });
    expect(readBrandImage(jpeg(300, 200))).toEqual({ mime: "image/jpeg", width: 300, height: 200 });
    expect(readBrandImage(webpLossless(123, 77))).toEqual({ mime: "image/webp", width: 123, height: 77 });
  });
  it("refuses everything else, by its bytes", () => {
    expect(readBrandImage(new TextEncoder().encode("GIF89a......"))).toBeNull();
    expect(readBrandImage(new TextEncoder().encode("<svg></svg>"))).toBeNull();
    expect(readBrandImage(new Uint8Array(0))).toBeNull();
    expect(readBrandImage(png(0, 5))).toBeNull();
  });
});

describe("BrandsService", () => {
  it("saves brands and products and keeps them across a restart", async () => {
    const { host } = memoryHost();
    const a = new BrandsService(host);
    const brand = await a.saveBrand({ name: "Partner Agro", colors: [{ name: "Leaf", hex: "#1ba37a" }], tone: "calm, honest" });
    expect(brand.colors).toEqual([{ name: "Leaf", hex: "#1BA37A" }]);
    expect(brand.formats.map((f) => f.id)).toEqual(["post", "story", "square"]);
    const product = await a.saveProduct({ brandId: brand.id, name: "Liq Humus", shape: "20 L jerrycan", labels: [{ text: "LIQ HUMUS", tier: "sharp" }, { text: "Ingredients …", tier: "soft" }] });
    expect(product.labelsConfirmed).toBe(false);
    expect(product.labels.map((l) => l.id)).toHaveLength(2);

    const b = new BrandsService(host);
    const again = await b.get(brand.id);
    expect(again?.products.map((p) => p.name)).toEqual(["Liq Humus"]);
    expect((await b.list()).map((x) => x.name)).toEqual(["Partner Agro"]);
  });

  it("changed label texts need confirming again; an explicit save confirms", async () => {
    const a = new BrandsService(memoryHost().host);
    const brand = await a.saveBrand({ name: "B" });
    const p = await a.saveProduct({ brandId: brand.id, name: "P", labels: [{ text: "One", tier: "sharp" }], labelsConfirmed: true });
    expect(p.labelsConfirmed).toBe(true);
    const same = await a.saveProduct({ id: p.id, brandId: brand.id, name: "P", labels: [{ id: p.labels[0].id, text: "One", tier: "sharp" }] });
    expect(same.labelsConfirmed).toBe(true);
    const edited = await a.saveProduct({ id: p.id, brandId: brand.id, name: "P", labels: [{ text: "Two", tier: "sharp" }] });
    expect(edited.labelsConfirmed).toBe(false);
  });

  it("keeps a product's series: trimmed, in the brand's own spelling, cleared by an empty one, kept when not given", async () => {
    const a = new BrandsService(memoryHost().host);
    const brand = await a.saveBrand({ name: "MTM Agro" });
    const old = await a.saveProduct({ brandId: brand.id, name: "Old" });
    expect(old.series).toBeUndefined();
    const p = await a.saveProduct({ brandId: brand.id, name: "Venta Fe", series: "  Venta  " });
    expect(p.series).toBe("Venta");
    const q = await a.saveProduct({ brandId: brand.id, name: "Venta Zn", series: "VENTA" });
    expect(q.series).toBe("Venta");
    const renamed = await a.saveProduct({ id: q.id, brandId: brand.id, name: "Venta Zinc" });
    expect(renamed.series).toBe("Venta");
    const cleared = await a.saveProduct({ id: q.id, brandId: brand.id, name: "Venta Zinc", series: "" });
    expect(cleared.series).toBeNull();
    expect((await a.saveProduct({ id: p.id, brandId: brand.id, name: "Venta Fe", series: null })).series).toBeNull();
  });

  it("refuses bad input", async () => {
    const a = new BrandsService(memoryHost().host);
    await expect(a.saveBrand({ name: "  " })).rejects.toBeInstanceOf(StoreError);
    const brand = await a.saveBrand({ name: "İstanbul Tarım" });
    await expect(a.saveBrand({ name: "istanbul tarim" })).rejects.toThrow(/already a brand/);
    await expect(a.saveBrand({ name: "X", colors: [{ name: "n", hex: "green" }] })).rejects.toThrow(/colour/);
    await expect(a.saveProduct({ brandId: "nope", name: "P" })).rejects.toMatchObject({ code: "not-found" });
    await a.saveProduct({ brandId: brand.id, name: "Humus" });
    await expect(a.saveProduct({ brandId: brand.id, name: "HUMUS" })).rejects.toThrow(/already has/);
  });

  it("adds pictures by their bytes and returns them", async () => {
    const { host, bytes } = memoryHost();
    const a = new BrandsService(host);
    const brand = await a.saveBrand({ name: "B" });
    const p = await a.saveProduct({ brandId: brand.id, name: "P" });
    const shot = await a.addImage({ brandId: brand.id, productId: p.id, role: "packshot", name: "front.png", data: b64(png(800, 1000)) });
    expect(shot).toMatchObject({ role: "packshot", mime: "image/png", width: 800, height: 1000, name: "front.png" });
    const logo = await a.addImage({ brandId: brand.id, productId: null, role: "logo", name: "logo", data: b64(jpeg(200, 100)) });
    expect(logo.mime).toBe("image/jpeg");
    expect([...bytes.keys()].sort()).toEqual([`${brand.id}/images/${logo.id}.jpg`, `${brand.id}/images/${shot.id}.png`].sort());

    const got = await a.image(brand.id, shot.id);
    expect(got.mime).toBe("image/png");
    expect(Buffer.from(got.data, "base64")).toEqual(Buffer.from(png(800, 1000)));
    const full = (await a.get(brand.id))!;
    expect(full.logos).toHaveLength(1);
    expect(full.products[0].images).toHaveLength(1);
  });

  it("refuses pictures that aren't PNG, JPEG or WebP, or are misplaced", async () => {
    const a = new BrandsService(memoryHost().host);
    const brand = await a.saveBrand({ name: "B" });
    const p = await a.saveProduct({ brandId: brand.id, name: "P" });
    const gif = b64(new TextEncoder().encode("GIF89a\x01\x00\x01\x00"));
    await expect(a.addImage({ brandId: brand.id, productId: p.id, role: "packshot", name: "x", data: gif })).rejects.toThrow(/PNG, JPEG and WebP/);
    await expect(a.addImage({ brandId: brand.id, productId: p.id, role: "packshot", name: "x", data: "not base64!" })).rejects.toThrow(/base64/);
    await expect(a.addImage({ brandId: brand.id, productId: null, role: "packshot", name: "x", data: b64(png(5, 5)) })).rejects.toThrow(/belongs to a product/);
    await expect(a.addImage({ brandId: brand.id, productId: p.id, role: "logo", name: "x", data: b64(png(5, 5)) })).rejects.toThrow(/belongs to the brand/);
    const big = new Uint8Array(20 * 1024 * 1024 + 1);
    big.set(png(5, 5));
    await expect(a.addImage({ brandId: brand.id, productId: p.id, role: "packshot", name: "x", data: b64(big) })).rejects.toThrow(/20 MB/);
  });

  it("find folds case and accents, Turkish letters too, for brands and products", async () => {
    const a = new BrandsService(memoryHost().host);
    const brand = await a.saveBrand({ name: "Partner Agro" });
    const other = await a.saveBrand({ name: "ÇİĞDEM Şeker" });
    await a.saveProduct({ brandId: brand.id, name: "LIQ HUMUS" });
    await a.saveProduct({ brandId: brand.id, name: "Liq Hümüs Plus" });
    await a.saveProduct({ brandId: other.id, name: "Işık Kesme Şeker" });

    expect((await a.find("liq humus")).products.map((p) => p.name)).toEqual(["LIQ HUMUS", "Liq Hümüs Plus"]);
    expect((await a.find("humus")).products.map((p) => p.name).sort()).toEqual(["LIQ HUMUS", "Liq Hümüs Plus"]);
    expect((await a.find("cigdem seker")).brands.map((b) => b.name)).toEqual(["ÇİĞDEM Şeker"]);
    expect((await a.find("ÇİĞDEM")).brands).toHaveLength(1);
    expect((await a.find("isik")).products.map((p) => p.name)).toEqual(["Işık Kesme Şeker"]);
    expect((await a.find("ISIK")).products).toHaveLength(1);
    expect((await a.find("PARTNER")).brands.map((b) => b.name)).toEqual(["Partner Agro"]);
    expect(await a.find("zzz")).toEqual({ brands: [], products: [] });
    // best match first: the whole name before a part of one
    expect((await a.find("liq hümüs plus")).products[0].name).toBe("Liq Hümüs Plus");
  });

  it("tells watchers the brand's id after every change, and on removal", async () => {
    const { host, bytes } = memoryHost();
    const a = new BrandsService(host);
    const seen: string[] = [];
    const off = a.repository().watch((id) => seen.push(id));
    const brand = await a.saveBrand({ name: "B" });
    const p = await a.saveProduct({ brandId: brand.id, name: "P" });
    const img = await a.addImage({ brandId: brand.id, productId: p.id, role: "label", name: "l", data: b64(png(4, 4)) });
    await a.removeImage(brand.id, img.id);
    await a.removeProduct(brand.id, p.id);
    await a.removeBrand(brand.id);
    expect(seen).toEqual(Array(6).fill(brand.id));
    off();
    await a.saveBrand({ name: "C" });
    expect(seen).toHaveLength(6);
    expect(bytes.size).toBe(0);
    expect((await a.list()).map((b) => b.name)).toEqual(["C"]);
  });

  it("removing a product or a picture removes its files", async () => {
    const { host, bytes } = memoryHost();
    const a = new BrandsService(host);
    const brand = await a.saveBrand({ name: "B" });
    const p = await a.saveProduct({ brandId: brand.id, name: "P" });
    const i1 = await a.addImage({ brandId: brand.id, productId: p.id, role: "packshot", name: "1", data: b64(png(4, 4)) });
    await a.addImage({ brandId: brand.id, productId: p.id, role: "packshot", name: "2", data: b64(png(4, 4)) });
    await a.removeImage(brand.id, i1.id);
    expect(bytes.size).toBe(1);
    await expect(a.image(brand.id, i1.id)).rejects.toMatchObject({ code: "not-found" });
    await a.removeProduct(brand.id, p.id);
    expect(bytes.size).toBe(0);
  });
});

describe("through the real LocalStore", () => {
  let ts: TestStore | null = null;
  afterEach(async () => {
    await ts?.close();
    ts = null;
  });

  it("keeps Workspace/spaces/brands/<id>/brand.json and images/<id>.png, and says it on the events", async () => {
    ts = await openTestStore();
    const events: string[] = [];
    ts.store.brands.onEvent((id) => events.push(id));
    const repo = ts.api.brands;
    const brand = await repo.saveBrand({ name: "Partner Agro" });
    const p = await repo.saveProduct({ brandId: brand.id, name: "Liq Humus" });
    const img = await repo.addImage({ brandId: brand.id, productId: p.id, role: "packshot", name: "front.png", data: b64(png(10, 20)) });
    const dir = join(ts.dir, "Workspace", "spaces", "brands", brand.id);
    expect(readdirSync(dir).sort()).toEqual(["brand.json", "images"]);
    expect(readdirSync(join(dir, "images"))).toEqual([`${img.id}.png`]);
    expect(events).toEqual([brand.id, brand.id, brand.id]);
    await repo.removeBrand(brand.id);
    expect(() => readdirSync(dir)).toThrow();
    expect(await repo.list()).toEqual([]);
  });
});
