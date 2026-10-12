/**
 * The web app at https://wecra.app (docs/cloud.md §7): the renderer's browser build (`npm run build:web` → out/web) is
 * the Worker's static assets, served by the Worker itself (`run_worker_first`), so every API path stays the API's.
 *
 *   GET /                    the app's index.html (no-cache); its routes are queries: `/?editor&file=<key>`, `/?present&file=<key>`
 *   GET /app, /app/…         the same index.html (reserved for the app's own paths; never an API path)
 *   GET /assets/<hashed>     the app's scripts, styles, Wasm, workers, fonts: immutable for a year
 *   GET /boot.js             the theme's boot script (not hashed): revalidated
 *
 * Nothing else falls back to index.html: an unknown path is the API's 404. The page's Content-Security-Policy allows
 * its own scripts and the engine's WebAssembly, workers from itself and blob:, images from data:, blob: and https (people's
 * photos), connections to this origin (HTTP and WebSocket) and to the Google Fonts files the font picker downloads.
 */

export interface AssetsBinding {
  fetch(req: Request | string): Promise<Response>;
}

/** The app's own client-side addresses: `/` and the reserved `/app/…` */
export const isAppRoute = (path: string): boolean => path === "/" || path === "/index.html" || path === "/app" || path.startsWith("/app/");

/** The app's files among the assets */
export const isAppAsset = (path: string): boolean => /^\/assets\/[A-Za-z0-9._-]+$/.test(path) || path === "/boot.js";

/** The page's Content-Security-Policy (`origin`: this server, for the WebSocket's wss: form) */
export function appCsp(origin: string): string {
  const ws = origin.replace(/^http/, "ws");
  return [
    "default-src 'self'",
    // The engine and QuickJS are WebAssembly; no inline scripts (boot.js is a file)
    "script-src 'self' 'wasm-unsafe-eval'",
    "worker-src 'self' blob:",
    // React's style attributes and the design system's inline styles
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "media-src 'self' data: blob:",
    // The API and the rooms' sockets here; Google Fonts' files (the font picker, engine/webFonts.ts); onnxruntime's
    // Wasm, over the assets' 25 MiB a file (vite.webapp.config.ts)
    `connect-src 'self' ${ws} https://raw.githubusercontent.com https://cdn.jsdelivr.net`,
    // Plugins' UI: opaque-origin frames (docs/plugins.md)
    "frame-src 'self' blob: data:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

const securityHeaders = (headers: Headers) => {
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "strict-origin-when-cross-origin");
};

/** The app's answer for a GET/HEAD of `path`, or null when the path isn't the app's (the API's then) */
export async function webAppRoute(req: Request, url: URL, path: string, assets: AssetsBinding | undefined): Promise<Response | null> {
  if (!assets || (req.method !== "GET" && req.method !== "HEAD")) return null;
  if (isAppRoute(path)) {
    const res = await assets.fetch(new Request(new URL("/index.html", url.origin)));
    // A server without the app deployed (the viewer only): `/` stays the API's
    if (!res.ok || !(res.headers.get("content-type") ?? "text/html").includes("html")) return null;
    const headers = new Headers(res.headers);
    headers.set("content-type", "text/html; charset=utf-8");
    headers.set("cache-control", "no-cache");
    headers.set("content-security-policy", appCsp(url.origin));
    headers.set("x-frame-options", "DENY");
    securityHeaders(headers);
    return new Response(req.method === "HEAD" ? null : res.body, { status: 200, headers });
  }
  if (isAppAsset(path)) {
    const res = await assets.fetch(new Request(new URL(path, url.origin)));
    if (!res.ok) return new Response("not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
    const headers = new Headers(res.headers);
    headers.set("cache-control", path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "public, max-age=0, must-revalidate");
    if (path.endsWith(".wasm")) headers.set("content-type", "application/wasm");
    securityHeaders(headers);
    return new Response(req.method === "HEAD" ? null : res.body, { status: 200, headers });
  }
  return null;
}
