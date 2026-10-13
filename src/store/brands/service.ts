/**
 * The store's `brands` repository (docs/studio.md §3.1): the brand and product library. One folder per brand,
 * `<brandId>/brand.json` (the brand with its products and its pictures' details, no pixels) and
 * `<brandId>/images/<imageId>.<png|jpg|webp>`. Pictures are checked by their bytes (PNG, JPEG, WebP; ≤ 20 MB) and
 * their size comes from the header. Every change says the brand's id to `watch`ers (topic `brands`).
 *
 * No Node or DOM imports: the desktop store (files under `Workspace/spaces/brands/`) and the browser's dev store
 * (keys) both run it through `BrandsHost`.
 */
import { base64Bytes } from "../../shared/agents/images";
import { StoreError } from "../../shared/store/protocol";
import { SerialQueue } from "../../shared/store/queue";
import { foldName, nameScore } from "../../shared/studio/library";
import { DEFAULT_FORMATS, type Brand, type BrandColor, type BrandImage, type BrandImageAdd, type BrandImageRole, type BrandSave, type BrandsRepository, type LabelText, type Product, type ProductSave, type SocialFormat } from "../../shared/studio/types";
import { EXTENSION, MAX_BRAND_IMAGE_BYTES, readBrandImage, type BrandMime } from "./imageInfo";

export interface BrandsHost {
  /** A text file under the library ("<brandId>/brand.json"); null: none */
  read(name: string): Promise<string | null>;
  write(name: string, text: string): Promise<void>;
  /** A picture's bytes ("<brandId>/images/<imageId>.png"); null: none */
  readBytes(name: string): Promise<Uint8Array | null>;
  writeBytes(name: string, bytes: Uint8Array): Promise<void>;
  /** A file, or a whole folder with everything in it ("<brandId>") */
  remove(name: string): Promise<void>;
  /** The folders directly in the library (the brand ids) */
  brandIds(): Promise<string[]>;
  newId(): string;
  now(): number;
  log(level: "debug" | "info" | "warn" | "error", message: string, detail?: unknown): void;
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const ROLES: readonly BrandImageRole[] = ["packshot", "label", "logo", "style"];
/** Pictures kept per product (more is never read: a prompt takes 8 references) */
const MAX_IMAGES = 40;

const bad = (message: string) => new StoreError("invalid", message);
const clip = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : "");

export function brandFile(brandId: string): string {
  return `${brandId}/brand.json`;
}
export function imageFile(brandId: string, image: Pick<BrandImage, "id" | "mime">): string {
  return `${brandId}/images/${image.id}.${EXTENSION[image.mime]}`;
}

function cleanColors(v: unknown): BrandColor[] {
  if (!Array.isArray(v)) return [];
  const out: BrandColor[] = [];
  for (const c of v.slice(0, 32)) {
    const hex = clip((c as BrandColor)?.hex, 9);
    if (!/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(hex)) throw bad(`"${hex}" isn't a colour (use #RRGGBB)`);
    out.push({ name: clip((c as BrandColor).name, 60), hex: hex.toUpperCase() });
  }
  return out;
}

function cleanFormats(v: unknown): SocialFormat[] {
  if (!Array.isArray(v)) return [];
  const out: SocialFormat[] = [];
  for (const f of v.slice(0, 16)) {
    const { id, name, width, height } = f as SocialFormat;
    const w = Math.round(Number(width));
    const h = Math.round(Number(height));
    if (!(w >= 16 && w <= 8192 && h >= 16 && h <= 8192)) throw bad(`Format "${clip(name, 40)}" needs a width and a height between 16 and 8192`);
    out.push({ id: clip(id, 40) || foldName(clip(name, 40)).replace(/[^a-z0-9]+/g, "-") || "format", name: clip(name, 60) || `${w} × ${h}`, width: w, height: h });
  }
  return out;
}

export class BrandsService {
  private queue = new SerialQueue();
  private listeners = new Set<(brandId: string) => void>();
  private cache = new Map<string, Brand>();
  private loaded = false;

  constructor(private host: BrandsHost) {}

  /** Changes, with the brand's id (the server broadcasts them on topic `brands`) */
  onEvent(listener: (brandId: string) => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  private emit(brandId: string) {
    for (const l of [...this.listeners]) {
      try {
        l(brandId);
      } catch (e) {
        this.host.log("warn", "brands: a listener threw", e);
      }
    }
  }

  private async load(): Promise<Map<string, Brand>> {
    if (this.loaded) return this.cache;
    for (const id of await this.host.brandIds()) {
      if (!ID.test(id)) continue;
      try {
        const text = await this.host.read(brandFile(id));
        if (text) this.cache.set(id, JSON.parse(text) as Brand);
      } catch (e) {
        this.host.log("warn", `brands: ${id}/brand.json can't be read`, e);
      }
    }
    this.loaded = true;
    return this.cache;
  }

  private async put(brand: Brand): Promise<Brand> {
    brand.updated = this.host.now();
    await this.host.write(brandFile(brand.id), JSON.stringify(brand, null, 1));
    this.cache.set(brand.id, brand);
    this.emit(brand.id);
    return structuredClone(brand);
  }

  private brandOf(all: Map<string, Brand>, id: string): Brand {
    const b = all.get(id);
    if (!b) throw new StoreError("not-found", "That brand isn't in the library");
    return b;
  }

  private newUniqueId(taken: (id: string) => boolean): string {
    for (;;) {
      const id = this.host.newId();
      if (!taken(id)) return id;
    }
  }

  list(): Promise<Brand[]> {
    return this.queue.run(async () => [...(await this.load()).values()].sort((a, b) => foldName(a.name).localeCompare(foldName(b.name))).map((b) => structuredClone(b)));
  }

  get(id: string): Promise<Brand | null> {
    return this.queue.run(async () => {
      const b = (await this.load()).get(id);
      return b ? structuredClone(b) : null;
    });
  }

  find(query: string): Promise<{ brands: Brand[]; products: Product[] }> {
    return this.queue.run(async () => {
      const all = [...(await this.load()).values()];
      const brands = all
        .map((b) => ({ b, s: nameScore(b.name, query) }))
        .filter((x) => x.s > 0)
        .sort((x, y) => y.s - x.s || foldName(x.b.name).localeCompare(foldName(y.b.name)))
        .map((x) => structuredClone(x.b));
      const products = all
        .flatMap((b) => b.products.map((p) => ({ p, s: nameScore(p.name, query) })))
        .filter((x) => x.s > 0)
        .sort((x, y) => y.s - x.s || foldName(x.p.name).localeCompare(foldName(y.p.name)))
        .map((x) => structuredClone(x.p));
      return { brands, products };
    });
  }

  saveBrand(s: BrandSave): Promise<Brand> {
    return this.queue.run(async () => {
      const all = await this.load();
      const name = clip(s?.name, 120);
      if (!name) throw bad("A brand needs a name");
      const old = s.id ? this.brandOf(all, s.id) : null;
      if ([...all.values()].some((b) => b.id !== old?.id && foldName(b.name) === foldName(name))) throw bad(`There is already a brand named ${name}`);
      const now = this.host.now();
      const brand: Brand = old
        ? { ...old }
        : { id: this.newUniqueId((id) => all.has(id)), name, colors: [], fonts: [], tone: "", logos: [], formats: DEFAULT_FORMATS.map((f) => ({ ...f })), libraryFileKey: null, products: [], created: now, updated: now };
      brand.name = name;
      if (s.colors) brand.colors = cleanColors(s.colors);
      if (s.fonts) brand.fonts = s.fonts.map((f) => clip(f, 80)).filter(Boolean).slice(0, 16);
      if (s.tone !== undefined) brand.tone = clip(s.tone, 2000);
      if (s.formats) brand.formats = cleanFormats(s.formats);
      if (s.libraryFileKey !== undefined) brand.libraryFileKey = s.libraryFileKey ? clip(s.libraryFileKey, 64) : null;
      return this.put(brand);
    });
  }

  removeBrand(id: string): Promise<void> {
    return this.queue.run(async () => {
      const all = await this.load();
      if (!all.has(id)) return;
      if (!ID.test(id)) throw bad("Bad brand id");
      await this.host.remove(id);
      all.delete(id);
      this.emit(id);
    });
  }

  saveProduct(s: ProductSave): Promise<Product> {
    return this.queue.run(async () => {
      const all = await this.load();
      const brand = this.brandOf(all, s?.brandId);
      const name = clip(s.name, 120);
      if (!name) throw bad("A product needs a name");
      const old = s.id ? brand.products.find((p) => p.id === s.id) : undefined;
      if (s.id && !old) throw new StoreError("not-found", "That product isn't in the library");
      if (brand.products.some((p) => p.id !== old?.id && foldName(p.name) === foldName(name))) throw bad(`${brand.name} already has a product named ${name}`);
      const now = this.host.now();
      const next: Product = old ? { ...old } : { id: this.newUniqueId((id) => brand.products.some((p) => p.id === id)), brandId: brand.id, name, shape: "", images: [], labels: [], labelsConfirmed: false, notes: "", created: now, updated: now };
      next.name = name;
      if (s.shape !== undefined) next.shape = clip(s.shape, 2000);
      if (s.notes !== undefined) next.notes = clip(s.notes, 4000);
      if (s.labels) {
        const used = new Set<string>();
        const labels: LabelText[] = [];
        for (const l of s.labels.slice(0, 100)) {
          const text = typeof l?.text === "string" ? l.text.trim().slice(0, 500) : "";
          if (!text) continue;
          if (l.tier !== "sharp" && l.tier !== "soft") throw bad(`A label text is "sharp" or "soft", not "${String(l.tier)}"`);
          let id = l.id && ID.test(l.id) && !used.has(l.id) ? l.id : "";
          if (!id) id = this.newUniqueId((x) => used.has(x));
          used.add(id);
          labels.push({ id, text, tier: l.tier });
        }
        const changed = JSON.stringify(labels.map((l) => [l.text, l.tier])) !== JSON.stringify(next.labels.map((l) => [l.text, l.tier]));
        next.labels = labels;
        // Changed texts need the owner's eyes again, unless the save says they were checked
        if (changed && s.labelsConfirmed === undefined) next.labelsConfirmed = false;
      }
      if (s.labelsConfirmed !== undefined) next.labelsConfirmed = !!s.labelsConfirmed && next.labels.length > 0;
      next.updated = now;
      brand.products = old ? brand.products.map((p) => (p.id === old.id ? next : p)) : [...brand.products, next];
      await this.put(brand);
      return structuredClone(next);
    });
  }

  removeProduct(brandId: string, productId: string): Promise<void> {
    return this.queue.run(async () => {
      const brand = this.brandOf(await this.load(), brandId);
      const p = brand.products.find((x) => x.id === productId);
      if (!p) return;
      brand.products = brand.products.filter((x) => x.id !== productId);
      await this.put(brand);
      for (const i of p.images) await this.host.remove(imageFile(brand.id, i)).catch((e) => this.host.log("warn", "brands: a picture wasn't removed", e));
    });
  }

  addImage(a: BrandImageAdd): Promise<BrandImage> {
    return this.queue.run(async () => {
      const brand = this.brandOf(await this.load(), a?.brandId);
      if (!ROLES.includes(a.role)) throw bad(`A picture's role is one of ${ROLES.join(", ")}`);
      const brandLevel = a.role === "logo" || a.role === "style";
      const product = a.productId ? brand.products.find((p) => p.id === a.productId) : null;
      if (a.productId && !product) throw new StoreError("not-found", "That product isn't in the library");
      if (!brandLevel && !product) throw bad(`A ${a.role === "packshot" ? "product photo" : "label close-up"} belongs to a product`);
      if (brandLevel && product) throw bad(`A ${a.role} picture belongs to the brand, not to a product`);
      const bytes = typeof a.data === "string" ? base64Bytes(a.data) : null;
      if (!bytes) throw bad("The picture isn't base64");
      if (bytes.length > MAX_BRAND_IMAGE_BYTES) throw bad("Pictures are at most 20 MB");
      const info = readBrandImage(bytes);
      if (!info) throw bad("Only PNG, JPEG and WebP pictures can be added");
      const list = product ? product.images : brand.logos;
      if (list.length >= MAX_IMAGES) throw bad(`At most ${MAX_IMAGES} pictures here`);
      const image: BrandImage = { id: this.newUniqueId(() => false), role: a.role, name: clip(a.name, 120) || `${a.role}.${EXTENSION[info.mime]}`, mime: info.mime, width: info.width, height: info.height };
      await this.host.writeBytes(imageFile(brand.id, image), bytes);
      list.push(image);
      // "logo" and "style" live in the brand's `logos` (a brand picture); a product's pictures in the product
      await this.put(brand);
      return { ...image };
    });
  }

  removeImage(brandId: string, imageId: string): Promise<void> {
    return this.queue.run(async () => {
      const brand = this.brandOf(await this.load(), brandId);
      const lists = [brand.logos, ...brand.products.map((p) => p.images)];
      const list = lists.find((l) => l.some((i) => i.id === imageId));
      const image = list?.find((i) => i.id === imageId);
      if (!list || !image) return;
      list.splice(list.indexOf(image), 1);
      await this.put(brand);
      await this.host.remove(imageFile(brand.id, image)).catch((e) => this.host.log("warn", "brands: a picture wasn't removed", e));
    });
  }

  image(brandId: string, imageId: string): Promise<{ data: string; mime: BrandMime }> {
    return this.queue.run(async () => {
      const brand = this.brandOf(await this.load(), brandId);
      const image = [...brand.logos, ...brand.products.flatMap((p) => p.images)].find((i) => i.id === imageId);
      if (!image) throw new StoreError("not-found", "That picture isn't in the library");
      const bytes = await this.host.readBytes(imageFile(brand.id, image));
      if (!bytes) throw new StoreError("not-found", "That picture's file is missing");
      return { data: toBase64(bytes), mime: image.mime };
    });
  }

  repository(): BrandsRepository {
    return {
      list: () => this.list(),
      get: (id) => this.get(id),
      find: (q) => this.find(q),
      saveBrand: (b) => this.saveBrand(b),
      removeBrand: (id) => this.removeBrand(id),
      saveProduct: (p) => this.saveProduct(p),
      removeProduct: (b, p) => this.removeProduct(b, p),
      addImage: (a) => this.addImage(a),
      removeImage: (b, i) => this.removeImage(b, i),
      image: (b, i) => this.image(b, i),
      watch: (l) => this.onEvent(l),
    };
  }
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
