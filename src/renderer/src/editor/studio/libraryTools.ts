/**
 * The manager's library tools (docs/studio.md §3.3): their definitions and how the editor answers them. 15a lists
 * LIBRARY_TOOLS among the manager's tools and sends their calls here. They read and write the brand library through
 * the store (`getStoreClient().brands`), not the document, so none of them is a write tool.
 */
import { getStoreClient } from "@/store";
import { AiRunError, runOnce, type AiApi } from "../../../../shared/ai/api";
import { creditsFor, type AiUsage, type AiUsageEntry } from "../../../../shared/ai/types";
import type { ToolDef, ToolResult } from "../../../../shared/agents/tools";
import { textResult } from "../../../../shared/agents/tools";
import { missingFor } from "../../../../shared/studio/library";
import type { Brand, BrandColor, BrandImageRole, BrandSave, BrandsRepository, LabelText, LabelTier, Product, ProductSave, SocialFormat } from "../../../../shared/studio/types";
import type { EditorController } from "../controller";
import { editorBridge } from "../desktop";

const brandId = { type: "string", description: "A brand's id (from library_find or library_get)." };
const productId = { type: "string", description: "A product's id (from library_get)." };

const colorSpec = { type: "object", properties: { name: { type: "string" }, hex: { type: "string", description: '"#RRGGBB"' } }, required: ["hex"] };
const formatSpec = { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, width: { type: "number" }, height: { type: "number" } }, required: ["name", "width", "height"] };
const labelSpec = {
  type: "object",
  properties: {
    id: { type: "string", description: "Keep a text's id when you change it." },
    text: { type: "string", description: "Exactly as printed on the label, Turkish letters included." },
    tier: { enum: ["sharp", "soft"], description: "sharp: written exactly in pictures (name, brand, volume). soft: small print, left illegible." },
  },
  required: ["text", "tier"],
};

export const LIBRARY_TOOLS: ToolDef[] = [
  {
    name: "library_find",
    title: "Find in the library",
    description: "Finds brands and products by name (case and accents ignored: \"liq humus\" finds \"LIQ HUMUS\"). Returns each match's id, name and, for a product, its brand.",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    write: false,
  },
  {
    name: "library_get",
    title: "Get a brand",
    description: "A brand with its colours, fonts, tone, formats, logos and products. Each product has its shape, its pictures (id, role, size), its label texts with their tiers, and whether the owner confirmed the texts.",
    inputSchema: { type: "object", properties: { brandId }, required: ["brandId"] },
    write: false,
  },
  {
    name: "library_missing",
    title: "What is still missing",
    description: "What the request still lacks before posts can be made: the brand, a logo, colours, the product, a product photo, the shape, label texts, confirmed labels (in that order). Empty: ready.",
    inputSchema: { type: "object", properties: { brandId, productIds: { type: "array", items: { type: "string" } } }, required: ["brandId", "productIds"] },
    write: false,
  },
  {
    name: "library_save_brand",
    title: "Save a brand",
    description: "Creates a brand (without `id`) or changes one (with `id`); only the fields you give change. Use what the owner said in the chat. Returns the brand.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        colors: { type: "array", items: colorSpec },
        fonts: { type: "array", items: { type: "string" } },
        tone: { type: "string", description: "The brand's voice and look, in the owner's words." },
        formats: { type: "array", items: formatSpec, description: "Default: Post 1080 × 1350, Story 1080 × 1920, Square post 1080 × 1080." },
        libraryFileKey: { type: ["string", "null"], description: "A file published as the brand's library, if there is one." },
      },
      required: ["name"],
    },
    write: false,
  },
  {
    name: "library_save_product",
    title: "Save a product",
    description: "Creates a product of a brand (without `id`) or changes one (with `id`); only the fields you give change. `labels` replaces the label texts; changed texts need the owner's confirmation again (labelsConfirmed: true only after the owner said so).",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        brandId,
        name: { type: "string" },
        series: { type: ["string", "null"], description: 'The distributor\'s series or product line ("Venta"); "" or null: none.' },
        shape: { type: "string", description: '"20 L white translucent jerrycan, handle top left, blue hexagon seal on the cap"' },
        labels: { type: "array", items: labelSpec },
        labelsConfirmed: { type: "boolean" },
        notes: { type: "string" },
      },
      required: ["brandId", "name"],
    },
    write: false,
  },
  {
    name: "library_add_image",
    title: "Add a picture",
    description:
      "Adds a PNG, JPEG or WebP picture (at most 20 MB): role packshot (a product photo) or label (a close-up of its label) for a product (`productId`), logo or style for the brand. Give its bytes as base64 in `data`. (A file path can't be read here: the owner's attached files arrive as data.)",
    inputSchema: {
      type: "object",
      properties: {
        brandId,
        productId,
        role: { enum: ["packshot", "label", "logo", "style"] },
        name: { type: "string" },
        data: { type: "string", description: "The picture's bytes as base64." },
        path: { type: "string" },
      },
      required: ["brandId", "role"],
    },
    write: false,
  },
  {
    name: "library_read_labels",
    title: "Read the label from photos",
    description:
      "Reads the label texts off the product's photos and close-ups with the text model and saves them as suggestions (labelsConfirmed: false): name, brand and volume as sharp, ingredients and other small print as soft. Then ask the owner to confirm them (a choice card: Looks right / Edit).",
    inputSchema: { type: "object", properties: { brandId, productId }, required: ["brandId", "productId"] },
    write: false,
  },
  {
    name: "library_image",
    title: "Look at a picture",
    description: "A library picture as an image, so you can look at it (reduced to 1568 px on the long side).",
    inputSchema: { type: "object", properties: { brandId, imageId: { type: "string" } }, required: ["brandId", "imageId"] },
    write: false,
  },
];

/** The store's `brands` repository (tests give theirs). */
let repoOverride: BrandsRepository | null = null;
export function setLibraryRepository(r: BrandsRepository | null): void {
  repoOverride = r;
}
const brands = (): BrandsRepository => repoOverride ?? getStoreClient().brands;

/** What `library_read_labels` needs of main and the store (tests give fakes). */
export interface LibraryToolsBackend {
  api: Pick<AiApi, "run" | "cancel" | "onEvent"> | null;
  record?: (e: Omit<AiUsageEntry, "id" | "at">) => Promise<unknown>;
  /** Pictures for the model: base64 PNG, shrunk (default: a canvas) */
  shrink?: (data: string, mime: string, max: number) => Promise<{ data: string; mime: string }>;
}
let backendOverride: LibraryToolsBackend | null = null;
export function setLibraryToolsBackend(b: LibraryToolsBackend | null): void {
  backendOverride = b;
}
const backend = (): LibraryToolsBackend => backendOverride ?? { api: (editorBridge() as { ai?: Pick<AiApi, "run" | "cancel" | "onEvent"> } | null)?.ai ?? null };

// ── Small helpers ─────────────────────────────────────────────────────────────────────────────────────────────────

const text = (v: unknown, what: string): string => {
  if (typeof v !== "string" || !v.trim()) throw new Error(`${what} is required`);
  return v;
};

function strip<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

/** The brand as the manager reads it: its pictures as ids with roles, no pixels. */
function brandView(b: Brand) {
  return {
    id: b.id,
    name: b.name,
    colors: b.colors,
    fonts: b.fonts,
    tone: b.tone,
    formats: b.formats,
    libraryFileKey: b.libraryFileKey,
    logos: b.logos.map((i) => ({ id: i.id, role: i.role, name: i.name, width: i.width, height: i.height })),
    products: b.products.map(productView),
  };
}

function productView(p: Product) {
  return {
    id: p.id,
    name: p.name,
    series: p.series ?? null,
    shape: p.shape,
    notes: p.notes,
    images: p.images.map((i) => ({ id: i.id, role: i.role, name: i.name, width: i.width, height: i.height })),
    labels: p.labels.map((l) => ({ id: l.id, text: l.text, tier: l.tier })),
    labelsConfirmed: p.labelsConfirmed,
  };
}

/** A canvas-made PNG, at most `max` px on the long side (no DOM: the picture as it is). */
async function shrinkWithCanvas(data: string, mime: string, max: number): Promise<{ data: string; mime: string }> {
  if (typeof createImageBitmap !== "function" || typeof document === "undefined") return { data, mime };
  try {
    return await shrinkNow(data, mime, max);
  } catch {
    // A picture the browser can't decode goes as it is: the model may still read it
    return { data, mime };
  }
}

async function shrinkNow(data: string, mime: string, max: number): Promise<{ data: string; mime: string }> {
  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  const bmp = await createImageBitmap(new Blob([bytes as BlobPart], { type: mime }));
  try {
    const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
    if (k === 1 && mime === "image/png") return { data, mime };
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bmp.width * k));
    canvas.height = Math.max(1, Math.round(bmp.height * k));
    const ctx = canvas.getContext("2d");
    if (!ctx) return { data, mime };
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const url = canvas.toDataURL("image/png");
    return { data: url.slice(url.indexOf(",") + 1), mime: "image/png" };
  } finally {
    bmp.close();
  }
}

// ── Reading labels ────────────────────────────────────────────────────────────────────────────────────────────────

export const LABELS_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    texts: {
      type: "array",
      items: {
        type: "object",
        properties: { text: { type: "string" }, tier: { enum: ["sharp", "soft"] } },
        required: ["text", "tier"],
      },
    },
  },
  required: ["texts"],
};

const LABELS_SYSTEM =
  "You read product labels from photos. You write down the texts printed on the product's label exactly as they are printed: the same letters, capitals, accents and Turkish letters (İ ı Ş ş Ğ ğ Ü ü Ö ö Ç ç), numbers and units. Answer only with JSON.";

function labelsPrompt(brandName: string, p: Product, n: number): string {
  return [
    `Brand: ${brandName}. Product: ${p.name}.${p.shape ? ` Shape: ${p.shape}.` : ""}`,
    `The ${n} attached picture${n === 1 ? " shows" : "s show"} this product and its label. List every text printed on the label, one entry per line of text or per short phrase, in reading order, skipping any text you can't read for certain.`,
    'Give each text a tier. "sharp": the texts that must always be written exactly: the product name, the brand name, the volume or weight ("1 Litre", "20 L"), the slogan or product type if it is large. "soft": everything else, the small print: ingredients, usage directions, warnings, addresses, certificates, barcodes\' digits, contact lines.',
    'Answer as {"texts":[{"text":"...","tier":"sharp"|"soft"}]}.',
  ].join("\n");
}

/** The answer as label texts (the model's JSON, checked). */
export function readLabelAnswer(json: unknown): { text: string; tier: LabelTier }[] {
  const list = (json as { texts?: unknown } | null)?.texts;
  if (!Array.isArray(list)) throw new Error("The answer has no `texts`");
  const out: { text: string; tier: LabelTier }[] = [];
  for (const e of list) {
    const t = typeof (e as { text?: unknown })?.text === "string" ? (e as { text: string }).text.trim() : "";
    if (!t) continue;
    out.push({ text: t, tier: (e as { tier?: unknown }).tier === "sharp" ? "sharp" : "soft" });
  }
  if (!out.length) throw new Error("No label text was read");
  return out;
}

async function readLabels(a: Record<string, unknown>): Promise<ToolResult> {
  const repo = brands();
  const brand = await repo.get(text(a.brandId, "brandId"));
  if (!brand) return textResult("That brand isn't in the library", true);
  const product = brand.products.find((p) => p.id === a.productId);
  if (!product) return textResult("That product isn't in the library", true);
  // Close-ups first (they read best), then photos; the model takes at most 8
  const pics = [...product.images.filter((i) => i.role === "label"), ...product.images.filter((i) => i.role === "packshot")].slice(0, 8);
  if (!pics.length) return textResult(`${product.name} has no pictures yet: add a product photo or a label close-up first`, true);
  const be = backend();
  if (!be.api) return textResult("The text model isn't available here (reading labels needs the desktop app)", true);
  const shrink = be.shrink ?? shrinkWithCanvas;
  const images: { name: string; data: string }[] = [];
  for (const [k, p] of pics.entries()) {
    const got = await repo.image(brand.id, p.id);
    const small = await shrink(got.data, got.mime, 1024);
    images.push({ name: `${p.role}-${k + 1}`, data: small.data });
  }
  const runId = `studio-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
  let usage: AiUsage | undefined;
  let ok = false;
  try {
    const out = await runOnce(be.api, { runId, action: "rewrite", system: LABELS_SYSTEM, prompt: labelsPrompt(brand.name, product, images.length), images, schema: LABELS_SCHEMA }, { onEvent: (e) => e.type === "usage" && (usage = e.usage) });
    usage = out.usage ?? usage;
    const json = out.json ?? JSON.parse(out.text);
    const texts = readLabelAnswer(json);
    ok = true;
    const saved = await repo.saveProduct({ id: product.id, brandId: brand.id, name: product.name, labels: texts, labelsConfirmed: false });
    return textResult({ productId: saved.id, labels: saved.labels.map((l: LabelText) => ({ id: l.id, text: l.text, tier: l.tier })), labelsConfirmed: false, note: "Suggestions read from the photos: ask the owner to confirm or edit them." });
  } catch (e) {
    if (e instanceof AiRunError) return textResult(`Reading the label failed: ${e.message}`, true);
    return textResult(`Reading the label failed: ${e instanceof Error ? e.message : String(e)}`, true);
  } finally {
    void (be.record ?? ((entry) => getStoreClient().ai.record(entry)))({
      action: "rewrite",
      providerId: usage?.providerId ?? "auto",
      ...(usage?.model ? { model: usage.model } : {}),
      input: usage?.input ?? 0,
      output: usage?.output ?? 0,
      images: images.length,
      credits: usage ? (usage.credits ?? creditsFor("rewrite", usage)) : ok ? creditsFor("rewrite", {}) : 0,
      fileKey: null,
      orgId: null,
      local: false,
      ok,
    })?.catch?.(() => {});
  }
}

// ── The tools ─────────────────────────────────────────────────────────────────────────────────────────────────────

const ROLES: readonly BrandImageRole[] = ["packshot", "label", "logo", "style"];

export async function runLibraryTool(_ed: EditorController, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  try {
    return await run(name, args ?? {});
  } catch (e) {
    return textResult(e instanceof Error ? e.message : String(e), true);
  }
}

async function run(name: string, a: Record<string, unknown>): Promise<ToolResult> {
  const repo = brands();
  switch (name) {
    case "library_find": {
      const found = await repo.find(text(a.query, "query"));
      const nameOf = new Map<string, string>();
      for (const b of await repo.list()) nameOf.set(b.id, b.name);
      return textResult({
        brands: found.brands.map((b) => ({ id: b.id, name: b.name, products: b.products.map((p) => ({ id: p.id, name: p.name })) })),
        products: found.products.map((p) => ({ id: p.id, name: p.name, brandId: p.brandId, brand: nameOf.get(p.brandId) ?? "" })),
      });
    }
    case "library_get": {
      const b = await repo.get(text(a.brandId, "brandId"));
      return b ? textResult(brandView(b)) : textResult("That brand isn't in the library", true);
    }
    case "library_missing": {
      const b = await repo.get(text(a.brandId, "brandId"));
      if (!b) return textResult(missingFor(null, []));
      const ids = Array.isArray(a.productIds) ? (a.productIds as unknown[]).filter((x): x is string => typeof x === "string") : [];
      const picked = b.products.filter((p) => ids.includes(p.id));
      return textResult(missingFor(b, picked));
    }
    case "library_save_brand": {
      const save: BrandSave = strip({
        id: typeof a.id === "string" ? a.id : undefined,
        name: text(a.name, "name"),
        colors: Array.isArray(a.colors) ? (a.colors as BrandColor[]) : undefined,
        fonts: Array.isArray(a.fonts) ? (a.fonts as string[]) : undefined,
        tone: typeof a.tone === "string" ? a.tone : undefined,
        formats: Array.isArray(a.formats) ? (a.formats as SocialFormat[]) : undefined,
        libraryFileKey: a.libraryFileKey === null || typeof a.libraryFileKey === "string" ? (a.libraryFileKey as string | null) : undefined,
      });
      return textResult(brandView(await repo.saveBrand(save)));
    }
    case "library_save_product": {
      const save: ProductSave = strip({
        id: typeof a.id === "string" ? a.id : undefined,
        brandId: text(a.brandId, "brandId"),
        name: text(a.name, "name"),
        series: typeof a.series === "string" || a.series === null ? a.series : undefined,
        shape: typeof a.shape === "string" ? a.shape : undefined,
        labels: Array.isArray(a.labels) ? (a.labels as ProductSave["labels"]) : undefined,
        labelsConfirmed: typeof a.labelsConfirmed === "boolean" ? a.labelsConfirmed : undefined,
        notes: typeof a.notes === "string" ? a.notes : undefined,
      });
      return textResult(productView(await repo.saveProduct(save)));
    }
    case "library_add_image": {
      const role = a.role as BrandImageRole;
      if (!ROLES.includes(role)) throw new Error(`role is one of ${ROLES.join(", ")}`);
      if (typeof a.data !== "string" || !a.data) {
        if (typeof a.path === "string" && a.path) throw new Error("A file path can't be read here: only the desktop app's main process reads paths. Give the picture's bytes as `data` (base64), or ask the owner to drop the picture into the library.");
        throw new Error("data (the picture as base64) is required");
      }
      const data = a.data.replace(/^data:[^;,]*;base64,/, "");
      const img = await repo.addImage({ brandId: text(a.brandId, "brandId"), productId: typeof a.productId === "string" && a.productId ? a.productId : null, role, name: typeof a.name === "string" ? a.name : "", data });
      return textResult({ id: img.id, role: img.role, name: img.name, width: img.width, height: img.height });
    }
    case "library_read_labels":
      return readLabels(a);
    case "library_image": {
      const got = await repo.image(text(a.brandId, "brandId"), text(a.imageId, "imageId"));
      const small = await (backend().shrink ?? shrinkWithCanvas)(got.data, got.mime, 1568);
      return { content: [{ type: "image", data: small.data, mimeType: small.mime }] };
    }
    default:
      return textResult(`${name} isn't a library tool`, true);
  }
}
