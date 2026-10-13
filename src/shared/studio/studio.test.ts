/**
 * The library's pure rules and the prompt builder (docs/studio.md §4.1, §5.2).
 */
import { describe, expect, it } from "vitest";
import { foldName, missingFor, nameScore } from "./library";
import { MAX_REFERENCES, VARIATION_HINTS, buildFixLabelPrompt, buildImagePrompt, nearestAspectRatio } from "./prompt";
import { DEFAULT_FORMATS, type Brand, type BrandImage, type Product, type StudioBrief } from "./types";

const img = (id: string, role: BrandImage["role"], name = id): BrandImage => ({ id, role, name, mime: "image/png", width: 100, height: 100 });

function product(over: Partial<Product> = {}): Product {
  return {
    id: "p1",
    brandId: "b1",
    name: "Liq Humus",
    shape: "20 L white translucent jerrycan, handle top left",
    images: [img("ph1", "packshot"), img("ph2", "packshot"), img("ph3", "packshot"), img("lb1", "label"), img("lb2", "label")],
    labels: [
      { id: "l1", text: "LIQ HUMUS", tier: "sharp" },
      { id: "l2", text: "Net 20 Litre", tier: "sharp" },
      { id: "l3", text: "İçindekiler: hümik asit", tier: "soft" },
    ],
    labelsConfirmed: true,
    notes: "",
    created: 0,
    updated: 0,
    ...over,
  };
}

function brand(over: Partial<Brand> = {}, products: Product[] = [product()]): Brand {
  return { id: "b1", name: "Partner Agro", colors: [{ name: "Leaf", hex: "#1BA37A" }], fonts: [], tone: "calm and honest", logos: [img("lg", "logo")], formats: [...DEFAULT_FORMATS], libraryFileKey: null, products, created: 0, updated: 0, ...over };
}

const briefOf = (over: Partial<StudioBrief> = {}): StudioBrief => ({ id: "br", request: "post and story", brandId: "b1", productIds: ["p1"], formats: [DEFAULT_FORMATS[0]], scene: "in a greenhouse, morning light", variations: 2, imageRoute: { providerId: "gemini-images" }, ...over });

describe("foldName", () => {
  it("folds case, accents and Turkish letters", () => {
    expect(foldName("İSTANBUL")).toBe("istanbul");
    expect(foldName("ısparta")).toBe("isparta");
    expect(foldName("ŞEKER Çiğdem Üzüm Öğle")).toBe("seker cigdem uzum ogle");
    expect(foldName("  Liq   Humus ")).toBe("liq humus");
  });
  it("ranks the whole name above a start above a part", () => {
    expect(nameScore("Liq Humus", "liq humus")).toBeGreaterThan(nameScore("Liq Humus Plus", "liq humus"));
    expect(nameScore("Liq Humus Plus", "liq")).toBeGreaterThan(nameScore("Super Liq", "humus"));
    expect(nameScore("Liq Humus", "zzz")).toBe(0);
  });
});

describe("missingFor", () => {
  it("lists the brand first when it isn't there", () => {
    expect(missingFor(null, []).map((m) => m.field)).toEqual(["brand"]);
  });
  it("is empty when everything is there", () => {
    expect(missingFor(brand(), [product()])).toEqual([]);
  });
  it("lists a bare brand's needs in the contract's order", () => {
    const bare = brand({ logos: [], colors: [] }, []);
    expect(missingFor(bare, []).map((m) => m.field)).toEqual(["logo", "colors", "product"]);
  });
  it("lists a bare product's needs, in order", () => {
    const bare = product({ images: [], shape: "", labels: [], labelsConfirmed: false });
    const out = missingFor(brand({}, [bare]), [bare]);
    expect(out.map((m) => m.field)).toEqual(["packshot", "shape", "labels"]);
    expect(out.every((m) => m.productId === "p1" && m.brandId === "b1")).toBe(true);
    expect(out[0].message).toBe("Liq Humus has no product photo");
  });
  it("asks for confirmation only when there are texts, and a label close-up alone isn't a product photo", () => {
    const p = product({ images: [img("lb", "label")], labelsConfirmed: false });
    expect(missingFor(brand({}, [p]), [p]).map((m) => m.field)).toEqual(["packshot", "labels-confirmed"]);
  });
  it("orders each kind across products: all photos, then all shapes …", () => {
    const a = product({ id: "a", name: "A", images: [], shape: "" });
    const b = product({ id: "b", name: "B", images: [], shape: "" });
    expect(missingFor(brand({}, [a, b]), [a, b]).map((m) => `${m.field}:${m.productId}`)).toEqual(["packshot:a", "packshot:b", "shape:a", "shape:b"]);
  });
});

describe("nearestAspectRatio", () => {
  it("picks the nearest of 1:1, 4:5, 3:4, 9:16, 16:9", () => {
    expect(nearestAspectRatio(1080, 1350)).toBe("4:5");
    expect(nearestAspectRatio(1080, 1920)).toBe("9:16");
    expect(nearestAspectRatio(1080, 1080)).toBe("1:1");
    expect(nearestAspectRatio(1920, 1080)).toBe("16:9");
    expect(nearestAspectRatio(1200, 1600)).toBe("3:4");
    expect(nearestAspectRatio(1000, 1200)).toBe("4:5");
    expect(nearestAspectRatio(0, 0)).toBe("1:1");
  });
});

describe("buildImagePrompt", () => {
  const b = brand();
  const p = b.products[0];

  it("numbers the references: photos (2), one label close-up, then style pictures", () => {
    const withStyle = brand({ logos: [img("lg", "logo"), img("st", "style", "greenhouse look")] });
    const r = buildImagePrompt(briefOf(), withStyle, [p], DEFAULT_FORMATS[0], 1);
    expect(r.references.map((x) => x.imageId)).toEqual(["ph1", "ph2", "lb1", "st"]);
    expect(r.prompt).toContain("Image 1: Product reference: Liq Humus, photo 1");
    expect(r.prompt).toContain("Image 3: Label close-up: Liq Humus");
    expect(r.prompt).toContain("Image 4: Style reference: greenhouse look");
    expect(r.aspectRatio).toBe("4:5");
    expect(r.references.every((x) => x.brandId === "b1")).toBe(true);
  });

  it("caps references at 8, keeping each product's first photo and label before second photos and styles", () => {
    const many: Product[] = Array.from({ length: 5 }, (_, i) => product({ id: `p${i}`, name: `P${i}`, images: [img(`a${i}`, "packshot"), img(`b${i}`, "packshot"), img(`l${i}`, "label")] }));
    const styled = brand({ logos: [img("st", "style")] }, many);
    const r = buildImagePrompt(briefOf(), styled, many, DEFAULT_FORMATS[0], 1);
    expect(r.references).toHaveLength(MAX_REFERENCES);
    const ids = r.references.map((x) => x.imageId);
    for (let i = 0; i < 5; i++) expect(ids).toContain(`a${i}`);
    for (let i = 0; i < 3; i++) expect(ids).toContain(`l${i}`);
    expect(ids).not.toContain("st");
    // reading order: product by product
    expect(ids.indexOf("a0")).toBeLessThan(ids.indexOf("a1"));
    expect(r.prompt).toContain("Image 8:");
    expect(r.prompt).not.toContain("Image 9:");
  });

  it("quotes the sharp texts exactly, Turkish letters included, and never the soft ones", () => {
    const tr = product({ labels: [{ id: "1", text: "ŞEKER ÇİĞDEM Üzüm", tier: "sharp" }, { id: "2", text: "Gübre — 1 Litre", tier: "sharp" }, { id: "3", text: "İçindekiler: hümik asit %12", tier: "soft" }] });
    const r = buildImagePrompt(briefOf(), brand({}, [tr]), [tr], DEFAULT_FORMATS[0], 1);
    expect(r.prompt).toContain('- "ŞEKER ÇİĞDEM Üzüm"');
    expect(r.prompt).toContain('- "Gübre — 1 Litre"');
    expect(r.prompt).not.toContain("İçindekiler");
    expect(r.prompt).not.toContain("hümik");
    expect(r.prompt).toContain("leave it illegible, softly blurred like a low-resolution print");
    expect(r.prompt).toContain("write no real letters");
    expect(r.prompt).toContain("stays fully sharp");
  });

  it("states the product rules, the shape, the scene, the tone and no added text", () => {
    const r = buildImagePrompt(briefOf(), b, [p], DEFAULT_FORMATS[0], 1);
    expect(r.prompt).toMatch(/same shape, proportions, colours, cap, label layout and logo/);
    expect(r.prompt).toMatch(/do not redraw the logo/);
    expect(r.prompt).toContain("20 L white translucent jerrycan");
    expect(r.prompt).toContain("in a greenhouse, morning light");
    expect(r.prompt).toContain("calm and honest");
    expect(r.prompt).toContain("add no captions, titles, watermarks");
  });

  it("mentions relative sizes of several products", () => {
    const small = product({ id: "p2", name: "Liq Mini", shape: "1 L bottle" });
    const r = buildImagePrompt(briefOf({ productIds: ["p1", "p2"] }), brand({}, [p, small]), [p, small], DEFAULT_FORMATS[0], 1);
    expect(r.prompt).toContain("twice as tall as a 1 L bottle");
    expect(r.prompt).toContain("Liq Mini: 1 L bottle");
  });

  it("is deterministic, and variations differ", () => {
    const one = buildImagePrompt(briefOf(), b, [p], DEFAULT_FORMATS[0], 1);
    expect(buildImagePrompt(briefOf(), b, [p], DEFAULT_FORMATS[0], 1)).toEqual(one);
    const two = buildImagePrompt(briefOf(), b, [p], DEFAULT_FORMATS[0], 2);
    expect(two.prompt).not.toBe(one.prompt);
    expect(two.prompt).toContain(VARIATION_HINTS[1]);
    const hints = Array.from({ length: VARIATION_HINTS.length }, (_, i) => buildImagePrompt(briefOf(), b, [p], DEFAULT_FORMATS[0], i + 1).prompt);
    expect(new Set(hints).size).toBe(VARIATION_HINTS.length);
  });

  it("takes the ratio from the format", () => {
    expect(buildImagePrompt(briefOf(), b, [p], DEFAULT_FORMATS[1], 1).aspectRatio).toBe("9:16");
  });
});

describe("buildFixLabelPrompt", () => {
  const b = brand();
  const p = b.products[0];
  it("names the texts to correct, keeps everything else, and sends label close-ups first", () => {
    const r = buildFixLabelPrompt(b, [p], [{ id: "x", kind: "sharp-text", detail: "“Net 20 Litre” reads “Not 20 Litre”", fix: "fix-label" }]);
    expect(r.prompt).toContain("Image 1 is the picture to edit");
    expect(r.prompt).toContain("Not 20 Litre");
    expect(r.prompt).toContain('- "Net 20 Litre"');
    expect(r.prompt).toMatch(/KEEP UNCHANGED/);
    expect(r.prompt).not.toContain("hümik");
    expect(r.references[0].role).toBe("Label close-up: Liq Humus");
    expect(r.references.length).toBeLessThanOrEqual(MAX_REFERENCES - 1);
    expect(r.prompt).toContain("Image 2: Label close-up: Liq Humus");
  });
});
