/**
 * The prompt builder (docs/studio.md §5.2): the brief, the brand and its products → the words and references sent to
 * the image model. Deterministic, so every variation gets the same rules. Product fidelity depends on this text alone:
 * the model draws the whole picture from the references and these rules (no compositing).
 */
import type { Brand, BrandImage, ImagePrompt, Product, PromptReference, ReviewProblem, SocialFormat, StudioBrief } from "./types";

/** The most pictures a model takes with one prompt */
export const MAX_REFERENCES = 8;
/** Photos of one product in a prompt, and close-ups of its label */
const PACKSHOTS_PER_PRODUCT = 2;
const LABELS_PER_PRODUCT = 1;

/** The ratios the models take */
const RATIOS: readonly [string, number][] = [
  ["1:1", 1],
  ["4:5", 4 / 5],
  ["3:4", 3 / 4],
  ["9:16", 9 / 16],
  ["16:9", 16 / 9],
];

/** The nearest model ratio to a format, by ratio (so 1080 × 1350 is 4:5 and 1080 × 1920 is 9:16). */
export function nearestAspectRatio(width: number, height: number): string {
  if (!(width > 0 && height > 0)) return "1:1";
  const r = Math.log(width / height);
  let best = RATIOS[0];
  for (const x of RATIOS) if (Math.abs(Math.log(x[1]) - r) < Math.abs(Math.log(best[1]) - r)) best = x;
  return best[0];
}

/** Camera, light and arrangement changes, in order: variation 1 takes the first, 2 the second … (then it starts over). */
export const VARIATION_HINTS: readonly string[] = [
  "Camera: eye level, straight on, the product centred. Light: soft, even daylight from the front-left. Arrangement: calm and simple, with room around the product.",
  "Camera: slightly low, three-quarter angle, the product a little off centre. Light: warm side light from the right with a soft shadow. Arrangement: a few natural props near the product, never in front of it.",
  "Camera: slightly high, looking gently down. Light: bright, clean overcast light. Arrangement: the product in the front, the scene stretching back in soft focus.",
  "Camera: close and tight on the product, a shallow depth of field. Light: golden, low-angle light. Arrangement: the product large in the frame, the background a soft blur.",
  "Camera: wide, the product in the lower third with open space above it. Light: cool morning light. Arrangement: airy, with plenty of empty space for text.",
];

const roleName = (p: Product, i: BrandImage, k: number): string =>
  i.role === "label" ? `Label close-up: ${p.name}` : `Product reference: ${p.name}, photo ${k}`;

interface Ref {
  brandId: string;
  imageId: string;
  role: string;
}

/**
 * The references of a request, at most MAX_REFERENCES: a product's photos (up to 2) and one label close-up each, then
 * the brand's style pictures. When there are too many, every product keeps its first photo first, then each label
 * close-up, then second photos, then style pictures. The result is in reading order: product by product, then style.
 */
export function referencesFor(brand: Brand, products: readonly Product[], cap = MAX_REFERENCES): PromptReference[] {
  type Cand = { rank: number; order: number; ref: Ref };
  const cands: Cand[] = [];
  let order = 0;
  for (const p of products) {
    const photos = p.images.filter((i) => i.role === "packshot").slice(0, PACKSHOTS_PER_PRODUCT);
    const labels = p.images.filter((i) => i.role === "label").slice(0, LABELS_PER_PRODUCT);
    photos.forEach((i, k) => cands.push({ rank: k === 0 ? 0 : 2, order: order++, ref: { brandId: brand.id, imageId: i.id, role: roleName(p, i, k + 1) } }));
    for (const i of labels) cands.push({ rank: 1, order: order++, ref: { brandId: brand.id, imageId: i.id, role: roleName(p, i, 1) } });
  }
  for (const i of brand.logos.filter((x) => x.role === "style")) cands.push({ rank: 3, order: order++, ref: { brandId: brand.id, imageId: i.id, role: `Style reference: ${i.name}` } });
  return cands
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .slice(0, cap)
    .sort((a, b) => a.order - b.order)
    .map((c) => c.ref);
}

const quote = (t: string) => `"${t.replace(/\r?\n/g, " ").replace(/"/g, "”")}"`;

/** The sentences about the products: shapes, relative sizes, and what the label must say */
function productSection(products: readonly Product[]): string[] {
  const out: string[] = [];
  for (const p of products) {
    out.push(`${p.name}${p.shape.trim() ? `: ${p.shape.trim()}` : ""}`);
  }
  return out;
}

function sharpTexts(products: readonly Product[]): string[] {
  const out: string[] = [];
  for (const p of products) {
    const sharp = p.labels.filter((l) => l.tier === "sharp");
    if (!sharp.length) continue;
    out.push(`${p.name}'s label must read exactly:`);
    for (const l of sharp) out.push(`- ${quote(l.text)}`);
  }
  return out;
}

const SOFT_RULE =
  "All other small print on the labels (everything not quoted above): leave it illegible, softly blurred like a low-resolution print. Keep the lines' places, lengths and colours from the reference, and write no real letters. Everything else (the products' shapes, edges, logo, large text and the whole scene) stays fully sharp.";

function rules(products: readonly Product[]): string[] {
  const many = products.length > 1;
  const names = products.map((p) => p.name).join(", ");
  return [
    `PRODUCT FIDELITY (the most important rule). The reference images show the real product${many ? "s" : ""} (${names}). Draw ${many ? "each of them" : "it"} exactly as in ${many ? "its" : "the"} reference: the same shape, proportions, colours, cap, label layout and logo. Do not redraw, restyle, simplify or invent any part of the product, and do not redraw the logo: copy it as it is on the reference. Never change the number of products or add another product.`,
    `Show ${many ? "every product" : "the product"} whole: uncropped, in front, not hidden behind anything, not transparent, not cut by the edge of the picture.`,
    many
      ? "Relative sizes follow the real shapes described below (a 20 L jerrycan stands about twice as tall as a 1 L bottle). Keep them in proportion to each other."
      : "Keep the product's size believable for its real shape described below.",
  ];
}

function sceneLines(brief: StudioBrief, brand: Brand, variation: number): string[] {
  const hint = VARIATION_HINTS[(Math.max(1, Math.round(variation)) - 1) % VARIATION_HINTS.length];
  const scene = brief.scene.trim() || "A clean, natural setting that suits the brand";
  const out = [`Scene: ${scene}.`];
  if (brand.tone.trim()) out.push(`The brand's look and voice: ${brand.tone.trim()}`);
  if (brand.colors.length) out.push(`Brand colours, for the mood of the scene: ${brand.colors.map((c) => `${c.name ? `${c.name} ` : ""}${c.hex}`).join(", ")}.`);
  out.push(`Variation ${Math.max(1, Math.round(variation))}. ${hint}`);
  return out;
}

export function buildImagePrompt(brief: StudioBrief, brand: Brand, products: readonly Product[], format: SocialFormat, variation: number): ImagePrompt {
  const references = referencesFor(brand, products);
  const aspectRatio = nearestAspectRatio(format.width, format.height);
  const lines: string[] = [];
  lines.push(`Make one photorealistic advertising picture for ${brand.name}, in the aspect ratio ${aspectRatio} (the ${format.name} format).`);
  if (references.length) {
    lines.push("", "REFERENCE IMAGES (in this order):");
    references.forEach((r, i) => lines.push(`Image ${i + 1}: ${r.role}`));
  }
  lines.push("", ...rules(products));
  const shapes = productSection(products);
  if (shapes.length) lines.push("", "THE PRODUCTS:", ...shapes.map((s) => `- ${s}`));
  const sharp = sharpTexts(products);
  if (sharp.length) lines.push("", "LABEL TEXTS (sharp):", ...sharp);
  lines.push("", "SMALL PRINT:", SOFT_RULE);
  lines.push("", "THE SCENE:", ...sceneLines(brief, brand, variation));
  lines.push("", "NO EXTRA TEXT: add no captions, titles, watermarks, borders, price tags or extra logos anywhere in the picture. The layout adds the text and the brand logo later. Leave calm space for it.");
  return { prompt: lines.join("\n"), references, aspectRatio };
}

/**
 * Fix label (§6.2): the picture made before goes first as the image to edit; the label close-ups and exact texts
 * follow. Only the named texts change.
 */
export function buildFixLabelPrompt(brand: Brand, products: readonly Product[], problems: readonly ReviewProblem[]): ImagePrompt {
  const labelRefs = referencesFor(brand, products).filter((r) => r.role.startsWith("Label close-up") || r.role.startsWith("Product reference"));
  const references = labelRefs.filter((r) => r.role.startsWith("Label close-up")).concat(labelRefs.filter((r) => !r.role.startsWith("Label close-up"))).slice(0, MAX_REFERENCES - 1);
  const lines: string[] = [];
  lines.push("Edit the picture. Image 1 is the picture to edit; keep it exactly as it is, except for the text corrections below.");
  if (references.length) {
    lines.push("", "REFERENCE IMAGES (the real labels):", "Image 1: the picture to edit");
    references.forEach((r, i) => lines.push(`Image ${i + 2}: ${r.role}`));
  }
  lines.push(
    "",
    "KEEP UNCHANGED: the scene, the light, the composition, the camera, the colours, the products' shapes and everything else in the picture. Change nothing outside the text named below, and do not move, resize or redraw the products or their logos.",
    "",
    "CORRECT ONLY THESE TEXTS on the product labels, so that they read exactly as written:"
  );
  for (const pr of problems) lines.push(`- ${pr.detail}`);
  const sharp = sharpTexts(products);
  if (sharp.length) lines.push("", "The exact label texts:", ...sharp);
  lines.push("", "Copy the letters, their font, weight, size, colour and position from the label close-up. Leave all the other small print as it is in the picture: softly blurred, written with no real letters. Add no new text, caption or watermark.");
  return { prompt: lines.join("\n"), references, aspectRatio: "1:1" };
}
