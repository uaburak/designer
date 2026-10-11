import { isIP } from "node:net";
import { mainFetch } from "./net";

/**
 * A dev resource link's name (docs/editor.md D-3, `devmode:link-title {url}` → `{title}`): main reads the page's
 * `<title>` — `https:` only (each redirect too, at most 5), 5 s, at most 512 kB read, no cookies, HTML only. Hosts that
 * are this computer or the local network (localhost, private and link-local addresses written as such) are refused.
 * Any failure is `null`: the editor then names the link by its host and path.
 */

export const LINK_TITLE_TIMEOUT_MS = 5000;
export const LINK_TITLE_MAX_BYTES = 512 * 1024;
const MAX_REDIRECTS = 5;

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

export interface LinkTitleOptions {
  fetcher?: Fetcher;
  /** Tests only: the schemes allowed (default `https:`) and whether local hosts are */
  schemes?: string[];
  allowLocal?: boolean;
  timeoutMs?: number;
}

/** localhost, loopback, private, link-local and unique-local addresses (by their written form) */
export function isLocalHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host === "0.0.0.0") return true;
  const v = isIP(host);
  if (v === 4) {
    const [a, b] = host.split(".").map(Number);
    return a === 127 || a === 10 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  if (v === 6) return host === "::1" || host === "::" || /^f[cd]/.test(host) || /^fe[89ab]/.test(host) || host.startsWith("::ffff:");
  return false;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", middot: "·", hellip: "…", laquo: "«", raquo: "»", bull: "•" };

/** The text of the first `<title>` in `html`, entities decoded and space collapsed; null when there is none. */
export function titleOf(html: string): string | null {
  const m = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
  if (!m) return null;
  const text = m[1]
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, h: string) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d{1,7});/g, (_, d: string) => safeChar(Number(d)))
    .replace(/&([a-z]+);/gi, (all, n: string) => ENTITIES[n.toLowerCase()] ?? all)
    .replace(/\s+/g, " ")
    .trim();
  return text ? text.slice(0, 300) : null;
}

const safeChar = (code: number) => (code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "");

async function readHead(res: Response, max: number): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  while (total < max) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    total += value.length;
    // The title is near the top: stop as soon as it has been read.
    if (/<\/title\s*>/i.test(Buffer.concat(parts).toString("latin1"))) break;
  }
  void reader.cancel().catch(() => undefined);
  return Buffer.concat(parts).subarray(0, max);
}

function decode(bytes: Uint8Array, contentType: string): string {
  const header = /charset=["']?([\w-]+)/i.exec(contentType)?.[1];
  const meta = /<meta[^>]+charset=["']?([\w-]+)/i.exec(Buffer.from(bytes.subarray(0, 4096)).toString("latin1"))?.[1];
  for (const label of [header, meta, "utf-8"]) {
    if (!label) continue;
    try {
      return new TextDecoder(label).decode(bytes);
    } catch {
      /* not a label TextDecoder knows */
    }
  }
  return new TextDecoder().decode(bytes);
}

export async function linkTitle(url: unknown, opts: LinkTitleOptions = {}): Promise<{ title: string | null }> {
  const none = { title: null };
  if (typeof url !== "string" || url.length > 2048) return none;
  const schemes = opts.schemes ?? ["https:"];
  const fetcher = opts.fetcher ?? mainFetch;
  const signal = AbortSignal.timeout(opts.timeoutMs ?? LINK_TITLE_TIMEOUT_MS);
  let current = url;
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const u = new URL(current);
      if (!schemes.includes(u.protocol) || u.username || u.password) return none;
      if (!opts.allowLocal && isLocalHost(u.hostname)) return none;
      const res = await fetcher(u.toString(), { method: "GET", redirect: "manual", credentials: "omit", signal, headers: { Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1" } });
      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        void res.body?.cancel().catch(() => undefined);
        current = new URL(location, u).toString();
        continue;
      }
      const type = res.headers.get("content-type") ?? "";
      if (!res.ok || !/text\/html|application\/xhtml\+xml/i.test(type)) {
        void res.body?.cancel().catch(() => undefined);
        return none;
      }
      return { title: titleOf(decode(await readHead(res, LINK_TITLE_MAX_BYTES), type)) };
    }
  } catch {
    return none;
  }
  return none;
}
