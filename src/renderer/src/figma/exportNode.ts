/**
 * Figma's Export and Copy as: a layer's element saved as SVG, PNG or JPG.
 * Each is made from the layer's vectors (see vectorSvg): the SVG itself, or
 * it drawn to a canvas at the scale. (An SVG holding the element's HTML — a
 * foreignObject — would draw it exactly, but a canvas it is drawn on can't
 * be read back in Chrome or Safari: no PNG could be made of it.)
 *
 * A picture the browser may not read (another site's, or Storage's while
 * its bucket has no CORS rule — see cors.json) stays out of the file —
 * linked by its address in an SVG, blank in a PNG: the export says which
 * (`missing`).
 */

import type { ExportSetting } from "./model";
import { vectorSvg } from "./vectorSvg";

/** What an export made, and what it left out. */
export interface ExportResult {
  blob: Blob;
  /** Pictures that couldn't be read (CORS): linked in an SVG, blank in a PNG/JPG */
  missing: string[];
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const safe = (name: string) => name.replace(/[^\w.-]+/g, "_") || "layer";

/** Saves the element as `name`.png/jpg/svg at the scale (a download); what it left out, said. */
export async function exportElement(el: HTMLElement, name: string, setting: ExportSetting): Promise<string[]> {
  const file = `${safe(name)}${setting.scale > 1 ? `@${setting.scale}x` : ""}.${setting.format}`;
  const { blob, missing } = await renderElement(el, setting);
  download(blob, file);
  return missing;
}

/** Copies the element to the clipboard as an SVG file's text or a PNG image (Figma's Copy as); what it left out, said. */
export async function copyElementAs(el: HTMLElement, format: "svg" | "png"): Promise<string[]> {
  const { blob, missing } = await renderElement(el, { scale: 2, format });
  if (format === "svg") await navigator.clipboard.writeText(await blob.text());
  else await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
  return missing;
}

/** The element as a file's bytes: an SVG of its vectors, or a PNG/JPG of them at the scale. */
export async function renderElement(el: HTMLElement, setting: ExportSetting): Promise<ExportResult> {
  const { svg, missing } = await vectorSvg(el);
  if (setting.format === "svg") return { blob: new Blob([svg], { type: "image/svg+xml" }), missing };
  const box = /viewBox="([^"]+)"/.exec(svg)?.[1].split(" ").map(Number) ?? [0, 0, el.offsetWidth, el.offsetHeight];
  const [, , width, height] = box;
  const img = new Image();
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
  try {
    img.src = url;
    await img.decode().catch(() => {
      throw new Error("The layer could not be drawn");
    });
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * setting.scale));
    canvas.height = Math.max(1, Math.round(height * setting.scale));
    const g = canvas.getContext("2d")!;
    if (setting.format === "jpg") {
      g.fillStyle = "#ffffff";
      g.fillRect(0, 0, canvas.width, canvas.height);
    }
    g.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, setting.format === "jpg" ? "image/jpeg" : "image/png", 0.92));
    if (!blob) throw new Error("The image could not be made");
    return { blob, missing };
  } finally {
    URL.revokeObjectURL(url);
  }
}
