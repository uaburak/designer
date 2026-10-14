/**
 * Figma's REST API with the person's own personal access token (docs/desktop.md §13 "Images from Figma"): who the
 * token belongs to (`GET /v1/me`) and a file's image fills (`GET /v1/files/:key/images` → `{ meta: { images: {
 * <imageRef>: <signed URL> } } }`, then each URL downloaded). An imageRef is the hex SHA-1 Figma names an image by —
 * the hash a pasted paint carries. Pure, `fetch` injected: main runs it on the desktop (no CORS, the token never
 * reaches a page), the browser build directly.
 *
 * The token goes to api.figma.com only (header `X-Figma-Token`); the signed image URLs are fetched without it.
 */

export const FIGMA_API = "https://api.figma.com";
/** Where a person makes a token: Figma › Settings › Security › Personal access tokens */
export const FIGMA_SETTINGS_URL = "https://www.figma.com/settings";

export interface FigmaUser {
  /** The account's name (`handle`) */
  handle: string;
  email: string;
}

/**
 * Why a call failed: `invalid-token` (refused: mistyped, revoked), `expired`, `no-access` (the token's person can't
 * open that file, or the token lacks the File content scope), `not-found` (no such file), `rate-limited`, `offline`
 * (no connection — in a browser also a request the browser blocked), `failed` (anything else).
 */
export type FigmaApiError = "no-token" | "invalid-token" | "expired" | "no-access" | "not-found" | "rate-limited" | "offline" | "failed";

export type FigmaResult<T> = { ok: true; value: T } | { ok: false; error: FigmaApiError; retryAfter?: number };

export type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

/** A Figma file key (the part of a file's URL after /design/ or /file/). */
export const isFigmaFileKey = (key: unknown): key is string => typeof key === "string" && /^[A-Za-z0-9]{8,128}$/.test(key);
/** A personal access token as Figma makes them ("figd_…"); anything printable without spaces is let through. */
export const looksLikeFigmaToken = (token: unknown): token is string => typeof token === "string" && /^[\x21-\x7e]{16,512}$/.test(token);
/** An image's name: 40 hex digits. */
export const isImageRef = (hash: unknown): hash is string => typeof hash === "string" && /^[0-9a-f]{40}$/.test(hash);

/** An error response, classified (Figma answers `{ status, err }`; a refused token is 403 "Invalid token"). */
export async function classifyFigmaError(res: { status: number; headers: { get(name: string): string | null }; json(): Promise<unknown> }): Promise<{ error: FigmaApiError; retryAfter?: number }> {
  let message = "";
  try {
    const body = (await res.json()) as { err?: unknown; message?: unknown } | null;
    message = String(body?.err ?? body?.message ?? "");
  } catch {
    /* no JSON body */
  }
  if (res.status === 429) {
    const after = Number(res.headers.get("retry-after"));
    return { error: "rate-limited", ...(Number.isFinite(after) && after > 0 ? { retryAfter: after } : {}) };
  }
  if (res.status === 401 || res.status === 403) {
    if (/expired/i.test(message)) return { error: "expired" };
    if (res.status === 401 || /invalid token|token.*(invalid|revoked)|not authorized/i.test(message)) return { error: "invalid-token" };
    return { error: "no-access" };
  }
  if (res.status === 404) return { error: "not-found" };
  return { error: "failed" };
}

const headers = (token: string) => ({ "X-Figma-Token": token });

async function call<T>(fetch: FetchLike, url: string, token: string, read: (body: unknown) => T | null, signal?: AbortSignal): Promise<FigmaResult<T>> {
  let res;
  try {
    res = await fetch(url, { headers: headers(token), signal });
  } catch {
    return { ok: false, error: "offline" };
  }
  if (!res.ok) return { ok: false, ...(await classifyFigmaError(res)) };
  let value: T | null = null;
  try {
    value = read(await res.json());
  } catch {
    value = null;
  }
  return value === null ? { ok: false, error: "failed" } : { ok: true, value };
}

/**
 * Whose token this is. A token without the "Current user" scope still works for images: Figma refuses `/v1/me` for
 * it with a scope message (not "Invalid token"), so the token is good and the name unknown (`null`).
 */
export async function figmaMe(token: string, fetch: FetchLike, signal?: AbortSignal): Promise<FigmaResult<FigmaUser | null>> {
  if (!looksLikeFigmaToken(token)) return { ok: false, error: "invalid-token" };
  const r = await call(fetch, `${FIGMA_API}/v1/me`, token, (b) => {
    const u = b as { handle?: unknown; email?: unknown } | null;
    return u && typeof u === "object" ? { handle: String(u.handle ?? ""), email: String(u.email ?? "") } : null;
  }, signal);
  if (!r.ok && r.error === "no-access") return { ok: true, value: null };
  return r;
}

/** A file's image fills: imageRef → signed download URL. */
export async function figmaImageUrls(token: string, fileKey: string, fetch: FetchLike, signal?: AbortSignal): Promise<FigmaResult<Record<string, string>>> {
  if (!isFigmaFileKey(fileKey)) return { ok: false, error: "not-found" };
  return call(fetch, `${FIGMA_API}/v1/files/${encodeURIComponent(fileKey)}/images`, token, (b) => {
    const images = (b as { meta?: { images?: unknown } } | null)?.meta?.images;
    if (!images || typeof images !== "object") return null;
    const out: Record<string, string> = {};
    for (const [ref, url] of Object.entries(images as Record<string, unknown>)) if (typeof url === "string" && /^https:\/\//.test(url)) out[ref.toLowerCase()] = url;
    return out;
  }, signal);
}

export interface FigmaImage {
  hash: string;
  bytes: Uint8Array;
}

/** Figma's images are capped on import; a download larger than this is refused (a wrong URL, not an image). */
export const MAX_FIGMA_IMAGE_BYTES = 64 * 1024 * 1024;

/**
 * The images `hashes` names, from the file `fileKey`: its image URLs, then each one the paste needs downloaded (a few
 * at a time). `missing`: hashes the file has no image for, or whose download failed.
 */
export async function fetchFigmaImages(
  token: string,
  fileKey: string,
  hashes: readonly string[],
  fetch: FetchLike,
  opts: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void; parallel?: number } = {}
): Promise<FigmaResult<{ images: FigmaImage[]; missing: string[] }>> {
  const wanted = [...new Set(hashes.map((h) => h.toLowerCase()).filter(isImageRef))];
  if (!wanted.length) return { ok: true, value: { images: [], missing: [] } };
  const urls = await figmaImageUrls(token, fileKey, fetch, opts.signal);
  if (!urls.ok) return urls;
  const images: FigmaImage[] = [];
  const missing: string[] = wanted.filter((h) => !urls.value[h]);
  const queue = wanted.filter((h) => urls.value[h]);
  const total = queue.length;
  let done = 0;
  let offline = 0;
  const worker = async () => {
    for (let h = queue.shift(); h; h = queue.shift()) {
      try {
        const res = await fetch(urls.value[h], { signal: opts.signal });
        const bytes = res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
        if (bytes && bytes.length && bytes.length <= MAX_FIGMA_IMAGE_BYTES) images.push({ hash: h, bytes });
        else missing.push(h);
      } catch {
        offline++;
        missing.push(h);
      }
      opts.onProgress?.(++done, total);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.parallel ?? 4, queue.length)) }, worker));
  if (!images.length && offline) return { ok: false, error: "offline" };
  return { ok: true, value: { images, missing } };
}
