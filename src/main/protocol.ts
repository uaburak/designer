import { net, protocol } from "electron";
import { open } from "node:fs/promises";
import { join, normalize, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { workspaceDir } from "./storeHost";

/**
 * The built app is served from app://designer: a secure origin of its own
 * (storage and fetch work as on the web), the app's own files only, HTML
 * with the CSP, and the workspace's pictures read-only (docs/desktop.md §11–12).
 */

export const SCHEME = "app";
export const APP_ORIGIN = `${SCHEME}://designer`;
/** electron-vite's dev server, while developing */
export const DEV_URL = process.env.ELECTRON_RENDERER_URL;
const RENDERER_DIR = join(__dirname, "../renderer");

/**
 * Cross-origin isolation (docs/desktop.md §12.3): COOP same-origin + COEP
 * require-corp on every response, so the views have SharedArrayBuffer (a
 * later threaded engine) and measureUserAgentSpecificMemory(). Every page
 * loads only the app's own files and the workspace's pictures, all from
 * this origin. DESIGNER_CROSS_ORIGIN_ISOLATED=0 turns it off.
 */
export const CROSS_ORIGIN_ISOLATED = process.env.DESIGNER_CROSS_ORIGIN_ISOLATED !== "0";

/**
 * What the built page may load (it has no CSP of its own): its own files and
 * Wasm ('wasm-unsafe-eval': WebAssembly.compile, nothing else evaluated),
 * the workspace's pictures (this origin), data: and blob: URLs it makes
 * itself, inline styles (React's). No network origins: the store, the only
 * part that may talk to Firebase, is a utility process.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "font-src 'self' data: blob:",
  "connect-src 'self' data: blob:",
  "frame-src 'none'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join("; ");

/** Before `ready`. */
export function registerScheme() {
  protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true } }]);
}

const TYPES: Record<string, string> = { ".wasm": "application/wasm", ".js": "text/javascript", ".mjs": "text/javascript" };

/** A picture's type from its first bytes (blobs carry no name). */
function sniff(head: Uint8Array): string {
  const at = (i: number, ...bytes: number[]) => bytes.every((b, j) => head[i + j] === b);
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return "image/png";
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  const text = new TextDecoder().decode(head.slice(0, 256)).trimStart();
  if (text.startsWith("<svg") || (text.startsWith("<?xml") && text.includes("<svg"))) return "image/svg+xml";
  return "application/octet-stream";
}

/**
 * The workspace's pictures, read-only (docs/desktop.md §11; the store is the
 * only writer): `/_blob/<sha1>` → `<workspace>/blobs/<sha1[0..2]>/<sha1>`,
 * `/_thumb/<fileKey>.png` → `<workspace>/files/<fileKey>/thumbnail.png`.
 * Names are checked by pattern, so no path can be built from a request.
 * (The contract's per-launch token is not asked for yet.)
 */
async function workspaceFile(pathname: string): Promise<Response | null> {
  let file: string;
  let immutable: boolean;
  const blob = /^\/_blob\/([0-9a-f]{40})$/.exec(pathname);
  const thumb = /^\/_thumb\/([A-Za-z0-9_-]{1,64})\.png$/.exec(pathname);
  if (blob) {
    file = join(workspaceDir(), "blobs", blob[1].slice(0, 2), blob[1]);
    immutable = true;
  } else if (thumb) {
    file = join(workspaceDir(), "files", thumb[1], "thumbnail.png");
    immutable = false;
  } else return null;
  let bytes: Buffer;
  try {
    const handle = await open(file, "r");
    try {
      bytes = await handle.readFile();
    } finally {
      await handle.close();
    }
  } catch {
    return new Response("Not found", { status: 404 });
  }
  const headers = new Headers({
    "Content-Type": immutable ? sniff(bytes.subarray(0, 512)) : "image/png",
    "Cache-Control": immutable ? "max-age=31536000, immutable" : "no-cache",
    "X-Content-Type-Options": "nosniff",
    "Access-Control-Allow-Origin": "*",
  });
  if (CROSS_ORIGIN_ISOLATED) headers.set("Cross-Origin-Resource-Policy", "cross-origin");
  return new Response(bytes, { status: 200, headers });
}

/** After `ready`: the app's own files only (the path guard), each with its headers; the workspace's pictures. */
export function handleScheme() {
  protocol.handle(SCHEME, async (request) => {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith("/_blob/") || pathname.startsWith("/_thumb/")) {
      if (request.method !== "GET" && request.method !== "HEAD") return new Response("Not allowed", { status: 405 });
      const res = await workspaceFile(pathname);
      if (res) return res;
      return new Response("Not found", { status: 404 });
    }
    const file = normalize(join(RENDERER_DIR, decodeURIComponent(pathname === "/" ? "/index.html" : pathname)));
    if (!file.startsWith(RENDERER_DIR + sep)) return new Response("Not found", { status: 404 });
    const res = await net.fetch(pathToFileURL(file).toString());
    const headers = new Headers(res.headers);
    const ext = file.slice(file.lastIndexOf("."));
    if (TYPES[ext]) headers.set("Content-Type", TYPES[ext]);
    headers.set("X-Content-Type-Options", "nosniff");
    if (CROSS_ORIGIN_ISOLATED) {
      headers.set("Cross-Origin-Opener-Policy", "same-origin");
      headers.set("Cross-Origin-Embedder-Policy", "require-corp");
      headers.set("Cross-Origin-Resource-Policy", "same-origin");
    }
    if (file.endsWith(".html")) headers.set("Content-Security-Policy", CSP);
    return new Response(res.body, { status: res.status, headers });
  });
}

/** One of the app's own pages (the built app's origin, or the dev server's). */
export function isAppUrl(url: string) {
  try {
    const { origin, protocol: scheme } = new URL(url);
    return DEV_URL ? origin === new URL(DEV_URL).origin : scheme === `${SCHEME}:`;
  } catch {
    return false;
  }
}

/** The page of a role: index.html with the role's query (src/renderer/src/main.tsx). */
export function pageUrl(query: Record<string, string>) {
  const search = new URLSearchParams(query).toString();
  return DEV_URL ? `${DEV_URL.replace(/\/$/, "")}/?${search}` : `${APP_ORIGIN}/index.html?${search}`;
}
