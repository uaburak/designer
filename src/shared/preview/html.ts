/**
 * "Export preview as HTML…" (docs/data.md §13, the fallback until Firebase is configured): one self-contained file —
 * the viewer's built page (`out/viewer/index.html`: its JS, CSS, fonts and the engine's Wasm already inlined by
 * vite.viewer.config.ts) with the preview package added as a JSON data block. The Wasm is instantiated from bytes,
 * so the file opens from `file://` in Chrome, Safari or Firefox (WebGL 2 needed). Pure; shared by the store (writes
 * the file), the viewer (reads the block) and the tests.
 */
import { isPreviewManifest, type PreviewManifest, type PreviewPackage } from "./format";

/** The viewer's template marks where the data goes. */
export const PREVIEW_DATA_PLACEHOLDER = "<!--designer:preview-data-->";
export const PREVIEW_DATA_ID = "designer-preview-data";
/** The engine's Wasm, inlined by the viewer's build */
export const ENGINE_WASM_ID = "designer-engine-wasm";

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function toBase64(bytes: Uint8Array): string {
  const B = (globalThis as { Buffer?: { from(b: Uint8Array): { toString(enc: string): string } } }).Buffer;
  if (B) return B.from(bytes).toString("base64");
  let out = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(out);
}

const LOOKUP = (() => {
  const t = new Uint8Array(128).fill(255);
  for (let i = 0; i < B64.length; i++) t[B64.charCodeAt(i)] = i;
  t["-".charCodeAt(0)] = 62;
  t["_".charCodeAt(0)] = 63;
  return t;
})();

/** Decodes base64 (whitespace ignored) without atob's string round trip. */
export function fromBase64(text: string): Uint8Array {
  const clean = text.replace(/[^A-Za-z0-9+/_-]/g, "");
  const n = clean.length;
  const out = new Uint8Array(Math.floor((n * 3) / 4));
  let o = 0;
  for (let i = 0; i < n; i += 4) {
    const a = LOOKUP[clean.charCodeAt(i)];
    const b = LOOKUP[clean.charCodeAt(i + 1)];
    const c = i + 2 < n ? LOOKUP[clean.charCodeAt(i + 2)] : 0;
    const d = i + 3 < n ? LOOKUP[clean.charCodeAt(i + 3)] : 0;
    if (a === 255 || b === 255 || c === 255 || d === 255) throw new Error("not base64");
    const v = (a << 18) | (b << 12) | (c << 6) | d;
    out[o++] = v >>> 16;
    if (i + 2 < n) out[o++] = (v >>> 8) & 0xff;
    if (i + 3 < n) out[o++] = v & 0xff;
  }
  return out.subarray(0, o);
}

/** The data block's JSON. */
interface InlinePreview {
  manifest: PreviewManifest;
  doc: string;
  images: Record<string, string>;
}

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** JSON that is safe inside a <script> element (no "</script>", no "<!--"). */
const scriptJson = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");

/** The page title an exported preview gets: Figma's "‹file› – Figma" becomes "‹file› – Developer preview". */
export const previewTitle = (fileName: string) => `${fileName || "Untitled"} – Developer preview`;

/** The viewer's page with the package in it. */
export function inlinePreviewHtml(template: string, pkg: PreviewPackage): string {
  if (!template.includes(PREVIEW_DATA_PLACEHOLDER)) throw new Error("the viewer page has no place for the preview's data (rebuild it with npm run build:viewer)");
  const data: InlinePreview = {
    manifest: pkg.manifest,
    doc: toBase64(pkg.doc),
    images: Object.fromEntries([...pkg.images].map(([sha1, bytes]) => [sha1, toBase64(bytes)])),
  };
  const block = `<script id="${PREVIEW_DATA_ID}" type="application/json">${scriptJson(data)}</script>`;
  return template
    .replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(previewTitle(pkg.manifest.fileName))}</title>`)
    .replace(PREVIEW_DATA_PLACEHOLDER, () => block);
}

/** The package from a data block's text (the viewer, tests). */
export function readInlinePreview(json: string): PreviewPackage {
  const data = JSON.parse(json) as Partial<InlinePreview>;
  if (!data || !isPreviewManifest(data.manifest) || typeof data.doc !== "string") throw new Error("this file's preview data is damaged");
  const images = new Map<string, Uint8Array>();
  for (const [sha1, b64] of Object.entries(data.images ?? {})) if (/^[0-9a-f]{40}$/.test(sha1) && typeof b64 === "string") images.set(sha1, fromBase64(b64));
  return { manifest: data.manifest, doc: fromBase64(data.doc), images };
}
