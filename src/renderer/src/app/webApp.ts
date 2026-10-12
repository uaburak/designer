/**
 * The web app (docs/cloud.md §7): the renderer built for https://wecra.app (`npm run build:web`, vite.webapp.config.ts
 * sets VITE_WECRA_WEB=1) — the product in a browser, served by the Worker from the same origin as the API. Not the
 * development page (`npm run web`, the dev store's demo) and never the desktop app (`window.designer`).
 *
 * What changes on the web: the server is the page's own origin; the store is the personal Drafts from the server with
 * an IndexedDB cache per account (no local "My team", no demo files); only the product's routes (Home, a file, a
 * presentation); desktop-only features stay hidden (local fonts, CLI agents / MCP, haptics, the macOS sign-in sheet),
 * Save local copy… is a download and Import is the file picker.
 */

/** True in the web app's build, in a browser (never under the desktop app's preload). */
export function isWebApp(): boolean {
  if ((import.meta.env.VITE_WECRA_WEB as string | undefined) !== "1") return false;
  return typeof window === "undefined" || !(window as { designer?: unknown }).designer;
}

/** The web app's cache of one account (an IndexedDB database), deleted when the account logs out */
export const webCacheName = (uid: string) => `wecra.cache.${uid}`;

/** The cache's bound until Settings sets one: 1 GB (the desktop's is 5 GB) */
export const WEB_CACHE_LIMIT_BYTES = 1024 ** 3;

/**
 * The web app's client-side routes (all under `/`, by query — the Worker's API owns every path, docs/cloud.md §7):
 * `/` Home (signed out: the welcome page), `/?editor&file=<key>` a file, `/?present&file=<key>` its presentation.
 * Development routes (`?gallery`, `?engine`, `?admin`, `?tabbar`, `?welcome`) aren't part of the product.
 */
export type WebRoute = "files" | "editor" | "present";

export function webRoute(search: string): WebRoute {
  const params = new URLSearchParams(search);
  if (params.has("present") && params.get("file")) return "present";
  if (params.has("editor") && params.get("file")) return "editor";
  return "files";
}

/** Saves bytes as a file in the browser's downloads (Save local copy… on the web) */
export function downloadBytes(bytes: Uint8Array, name: string, type = "application/octet-stream"): void {
  const url = URL.createObjectURL(new Blob([bytes.slice().buffer as ArrayBuffer], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** A file name for a `.fig` download: the file's name, without the characters file systems refuse */
export const figFileName = (name: string) =>
  `${[...name]
    .map((c) => (c.charCodeAt(0) < 32 ? " " : c))
    .join("")
    .replace(/[\\/:*?"<>|]+/g, " ")
    .trim() || "Untitled"}.fig`;
