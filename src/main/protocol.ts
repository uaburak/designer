import { net, protocol } from "electron";
import { join, normalize, sep } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * The built app is served from app://designer: a secure origin of its own
 * (storage, the sign-in, fetch work as on the web), the app's own files only,
 * HTML with the CSP (docs/desktop.md §11–12).
 */

export const SCHEME = "app";
export const APP_ORIGIN = `${SCHEME}://designer`;
/** electron-vite's dev server, while developing */
export const DEV_URL = process.env.ELECTRON_RENDERER_URL;
const RENDERER_DIR = join(__dirname, "../renderer");

/**
 * Cross-origin isolation (COOP same-origin + COEP require-corp) — off for
 * now: the site admin's pages still show pictures, video and embeds from the
 * web (Firebase Storage, YouTube) that send no CORP header and would be
 * blocked. The v1 engine is single-threaded and needs no SharedArrayBuffer.
 * It goes on (docs/desktop.md §12.3) once the legacy data layer is gone;
 * DESIGNER_CROSS_ORIGIN_ISOLATED=1 turns it on now, to try the engine.
 */
export const CROSS_ORIGIN_ISOLATED = process.env.DESIGNER_CROSS_ORIGIN_ISOLATED === "1";

/**
 * What the built page may load (it has no CSP of its own): its own files and
 * Wasm ('wasm-unsafe-eval': WebAssembly.compile, nothing else evaluated);
 * pictures, video, embeds and Firebase from the web (the legacy data layer);
 * inline styles (React's and the editor's). No plugins.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "media-src 'self' data: blob: https:",
  "font-src 'self' data: blob:",
  "connect-src 'self' data: blob: https: wss:",
  "frame-src 'self' https:",
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

/** After `ready`: the app's own files only (the path guard), each with its headers. */
export function handleScheme() {
  protocol.handle(SCHEME, async (request) => {
    const { pathname } = new URL(request.url);
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
