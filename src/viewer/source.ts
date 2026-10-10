/**
 * Where a developer preview comes from (docs/data.md §13, docs/multiplayer.md §9):
 *
 * - an exported HTML file: the package is inlined in a `<script id="designer-preview-data">` block, the engine's
 *   Wasm in `<script id="designer-engine-wasm">` (the viewer's build put it there);
 * - the multiplayer server: the Worker serves this page at `/p/<previewId>` and the package's files at
 *   `/previews/<previewId>/…` on the same origin (`?p=<id>&server=<origin>` points a dev viewer at another server);
 * - a folder with the package's files (`?src=<url>`), for development.
 *
 * The HTTP cases go through the general loader in remote.ts.
 */
import { PREVIEW_DOC_NAME, PREVIEW_MANIFEST_NAME, previewImageName } from "@shared/preview/format";
import { ENGINE_WASM_ID, fromBase64, PREVIEW_DATA_ID, readInlinePreview } from "@shared/preview/html";
import { checkManifest, loadEmbed, loadRemote, messageOf, PreviewError, type LoadedPreview } from "./remote";

export { PreviewError, type LoadedPreview } from "./remote";

/** The engine's Wasm when the page carries it (an exported file), else null (fetched next to the script). */
export function inlineWasm(): ArrayBuffer | null {
  const el = document.getElementById(ENGINE_WASM_ID);
  const text = el?.textContent?.trim();
  if (!text) return null;
  const bytes = fromBase64(text);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** A preview package laid out as files under `base` (a folder URL ending in "/"). */
const packageAt = (base: string): Promise<LoadedPreview> =>
  loadRemote({
    manifest: new URL(PREVIEW_MANIFEST_NAME, base).href,
    doc: { url: new URL(PREVIEW_DOC_NAME, base).href, format: "fig-kiwi" },
    image: (sha1) => new URL(previewImageName(sha1), base).href,
  });

export async function loadPreview(): Promise<LoadedPreview> {
  const inline = document.getElementById(PREVIEW_DATA_ID);
  if (inline?.textContent) {
    let pkg;
    try {
      pkg = readInlinePreview(inline.textContent);
    } catch {
      throw new PreviewError("This preview can't be opened", "The file's data is damaged.");
    }
    checkManifest(pkg.manifest);
    const message = await messageOf(pkg.doc);
    return { manifest: pkg.manifest, message, image: async (sha1) => pkg.images.get(sha1) ?? null };
  }
  const params = new URLSearchParams(location.search);
  const src = params.get("src");
  if (src) return packageAt(new URL(src.endsWith("/") ? src : `${src}/`, location.href).href);
  const embed = /\/embed\/([A-Za-z0-9_-]{6,64})\/?$/.exec(location.pathname)?.[1] ?? params.get("embed");
  if (embed) return loadEmbed(params.get("server") ?? location.origin, embed);
  const id = /\/p\/([0-9A-Za-z]{22})\/?$/.exec(location.pathname)?.[1] ?? params.get("p");
  if (!id || !/^[0-9A-Za-z]{22}$/.test(id)) throw new PreviewError("No preview here", "Open the link you were sent, or an exported preview file.");
  const server = params.get("server") ?? location.origin;
  return packageAt(new URL(`/previews/${id}/`, server).href);
}
