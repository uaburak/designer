/**
 * The Brands library's tools (docs/studio.md §3.3), their definitions alone: the manager lists them among its tools,
 * and an outside MCP client (Claude Code, Claude Desktop…) gets them too, the owner's own library being his to fill
 * from there (docs/social.md §21). The editor answers them (editor/studio/libraryTools.ts) through the store, not
 * the document, so none of them is a write tool.
 */
import type { ToolDef } from "../agents/tools";

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

export const LIBRARY_TOOL_NAMES: ReadonlySet<string> = new Set(LIBRARY_TOOLS.map((t) => t.name));
