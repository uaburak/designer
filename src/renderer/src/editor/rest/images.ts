/**
 * `GET /v1/images/:key` on the client (docs/multiplayer.md §16.6): each id exported by the engine's exporters (E7,
 * `exportCore.ts`) with Figma's settings — `scale` 0.01–4, PNG / JPG / SVG / PDF, `svg_outline_text`,
 * `svg_include_id` (ids written always; `svg_include_node_id`'s `data-node-id` isn't), `contents_only`, `use_absolute_bounds` — one part per id (name = the id);
 * an id that doesn't exist or draws nothing has no part (the Worker answers `null` for it). Figma's 32-megapixel cap:
 * a larger raster is drawn at the scale that fits.
 */
import type { Engine } from "@/engine/Engine";
import type { ImagesParams } from "../../../../shared/rest/types";
import { renderEngineExport, type ImageBytes } from "../exportCore";
import type { ExportSettings } from "../model/exports";

/** Figma's cap on a rendered image's pixels */
export const MAX_PIXELS = 32_000_000;

const MIME = { png: "image/png", jpg: "image/jpeg", svg: "image/svg+xml", pdf: "application/pdf" } as const;

/** The engine's export settings for the REST parameters (`scale` brought under the pixel cap for this size) */
export function exportSettingsFor(p: ImagesParams, size: { x: number; y: number } | null): ExportSettings {
  const vector = p.format === "svg" || p.format === "pdf";
  let scale = Math.min(4, Math.max(0.01, p.scale || 1));
  if (!vector && size && size.x > 0 && size.y > 0 && size.x * size.y * scale * scale > MAX_PIXELS) scale = Math.sqrt(MAX_PIXELS / (size.x * size.y));
  return {
    suffix: "",
    imageType: p.format === "jpg" ? "JPEG" : p.format === "svg" ? "SVG" : p.format === "pdf" ? "PDF" : "PNG",
    constraint: { type: "CONTENT_SCALE", value: vector ? 1 : scale },
    contentsOnly: p.contents_only !== false,
    svgOutlineText: p.svg_outline_text !== false,
    svgIDMode: p.svg_include_id || p.svg_include_node_id ? "ALWAYS" : "IF_NEEDED",
    svgForceStrokeMasks: p.svg_simplify_stroke === false,
    useAbsoluteBounds: p.use_absolute_bounds === true,
    colorProfile: "DOCUMENT",
  } as ExportSettings;
}

/** The parts of an `images` job: id → the file's bytes */
export async function renderImages(engine: Engine, images: ImageBytes | null, p: ImagesParams): Promise<{ name: string; bytes: Uint8Array; contentType: string }[]> {
  const out: { name: string; bytes: Uint8Array; contentType: string }[] = [];
  for (const id of p.ids) {
    const node = engine.readNode(id, { fields: ["size", "type"] });
    // Pages and the document aren't rendered (Figma renders layers); they answer null
    if (!node || node.type === "DOCUMENT" || node.type === "CANVAS") continue;
    const r = await renderEngineExport(engine, images, [id], exportSettingsFor(p, node.size ?? null));
    if ("bytes" in r && r.bytes.length) out.push({ name: id, bytes: r.bytes, contentType: MIME[p.format] });
  }
  return out;
}
