import type { PluginFetchInit, PluginFetchResponse } from "../../shared/ipc";
import { domainsAllow } from "./network";

/**
 * `fetch` from a plugin's code (docs/plugins.md decision 4, §3.3): main checks the URL against the run's
 * `networkAccess` — and again at every redirect, which is followed here by hand — then fetches through `mainFetch`
 * (the deployment's proxy), with no cookies, 30 s at most and a body of at most 20 MB.
 */

export const PLUGIN_FETCH_TIMEOUT_MS = 30_000;
export const PLUGIN_FETCH_MAX_BYTES = 20 * 1024 * 1024;
const MAX_REDIRECTS = 20;
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
/** Headers a plugin can't set (the browser's forbidden ones that matter here) */
const FORBIDDEN_HEADERS = new Set(["cookie", "cookie2", "host", "connection", "content-length", "transfer-encoding", "keep-alive", "upgrade", "te", "trailer", "expect", "proxy-authorization", "proxy-connection", "via", "origin", "referer", "dnt"]);

/** Figma's CSP-style refusal text (§3.3) */
export const refusedText = (url: string) => `Refused to connect to '${url}' because it violates the plugin's networkAccess (manifest.json)`;

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

function cleanInit(init: PluginFetchInit | undefined): { method: string; headers: Headers; body: string | Uint8Array | undefined } {
  const method = (typeof init?.method === "string" ? init.method : "GET").toUpperCase();
  if (!METHODS.has(method)) throw new Error(`fetch: the method ${method.slice(0, 20)} isn't allowed`);
  const headers = new Headers();
  if (init?.headers && typeof init.headers === "object")
    for (const [k, v] of Object.entries(init.headers).slice(0, 100)) {
      if (typeof v !== "string" || k.length > 256 || v.length > 8192) continue;
      const name = k.toLowerCase();
      if (FORBIDDEN_HEADERS.has(name) || name.startsWith("sec-") || name.startsWith("proxy-")) continue;
      try {
        headers.set(k, v);
      } catch {
        /* not a header name or value */
      }
    }
  const body = typeof init?.body === "string" || init?.body instanceof Uint8Array ? init.body : undefined;
  if (body !== undefined && (method === "GET" || method === "HEAD")) throw new Error("fetch: a GET or HEAD request has no body");
  if (body !== undefined && (typeof body === "string" ? Buffer.byteLength(body) : body.length) > PLUGIN_FETCH_MAX_BYTES) throw new Error("fetch: the body is larger than 20 MB");
  return { method, headers, body };
}

async function readCapped(res: Response, max: number): Promise<Uint8Array> {
  const length = Number(res.headers.get("content-length"));
  if (Number.isFinite(length) && length > max) throw new Error("fetch: the response is larger than 20 MB");
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      void reader.cancel();
      throw new Error("fetch: the response is larger than 20 MB");
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** The request, for a run that may reach `domains`. */
export async function pluginFetch(domains: readonly string[], url: unknown, init: PluginFetchInit | undefined, fetcher: Fetcher, opts: { timeoutMs?: number; maxBytes?: number } = {}): Promise<PluginFetchResponse> {
  if (typeof url !== "string" || url.length > 8192) throw new Error("fetch: not a URL");
  let current: string;
  try {
    current = new URL(url).toString();
  } catch {
    throw new Error(`fetch: "${url.slice(0, 200)}" isn't a URL`);
  }
  const clean = cleanInit(init);
  const headers = clean.headers;
  let { method, body } = clean;
  const signal = AbortSignal.timeout(opts.timeoutMs ?? PLUGIN_FETCH_TIMEOUT_MS);
  for (let hop = 0; ; hop++) {
    const u = new URL(current);
    if ((u.protocol !== "https:" && u.protocol !== "http:") || !domainsAllow(domains, current)) throw new Error(refusedText(current));
    let res: Response;
    try {
      res = await fetcher(current, { method, headers, body: body as RequestInit["body"], redirect: "manual", credentials: "omit", signal });
    } catch (err) {
      if (signal.aborted) throw new Error("fetch: the request timed out");
      throw new Error(`fetch: ${err instanceof Error ? err.message : String(err)}`);
    }
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      void res.body?.cancel();
      if (hop >= MAX_REDIRECTS) throw new Error("fetch: too many redirects");
      current = new URL(location, current).toString();
      // 303, and 301 / 302 after a POST: the browser's rule — the next request is a GET without a body.
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) {
        if (method !== "HEAD") method = "GET";
        body = undefined;
        headers.delete("content-type");
      }
      // Credentials don't follow a redirect to another origin.
      if (new URL(current).origin !== u.origin) headers.delete("authorization");
      continue;
    }
    const out: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      if (k !== "set-cookie") out[k] = v;
    });
    const bytes = method === "HEAD" ? new Uint8Array(0) : await readCapped(res, opts.maxBytes ?? PLUGIN_FETCH_MAX_BYTES);
    return { status: res.status, statusText: res.statusText, headers: out, body: bytes };
  }
}
