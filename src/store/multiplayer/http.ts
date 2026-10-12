/**
 * What every call to the server shares when the answer isn't ours (the 2026-10-12 incident): Cloudflare's own error
 * pages — 1102 "Worker exceeded resource limits", 1101, 1015 rate limited, 5xx — came back as HTML and were shown to
 * people verbatim. Here they become our short English words, and idempotent reads try again before saying them.
 * Imports nothing from Node or the DOM (the desktop store and the browser's dev store both run it).
 */
import { StoreError } from "../../shared/store/protocol";

export const SERVER_BUSY_TEXT = "The server is busy. Try again in a moment.";
export const RATE_LIMITED_TEXT = "Too many requests. Try again in a moment.";
export const STILL_UPLOADING_TEXT = "This file is still uploading. Try again in a moment.";

/** `detail.code` of a refusal that is the server's (or Cloudflare's) momentary trouble, not an answer */
export type TransientCode = "server_busy" | "rate_limited";
const TRANSIENT = new Set<string>(["server_busy", "rate_limited"] satisfies TransientCode[]);

/** Waits between a read's tries (two retries: 250 ms, then 750 ms) */
export const READ_RETRY_DELAYS = [250, 750];
/** Waits between an upload's tries (sharing a file: its images and snapshot) */
export const UPLOAD_RETRY_DELAYS = [500, 1500, 4000];

/** Is this answer's body a page (HTML, or Cloudflare's plain "error code: 1102") rather than our JSON? */
export function isErrorPage(res: Response, text: string): boolean {
  if ((res.headers.get("content-type") ?? "").toLowerCase().includes("text/html")) return true;
  if (/^\s*<(!doctype|html)/i.test(text)) return true;
  return res.headers.has("cf-ray") && !isJson(text);
}

function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** Cloudflare's error number in its page ("error code: 1102", "Error 1015"), if it says one */
export function cloudflareCode(text: string): number | null {
  const plain = text.replace(/<[^>]*>/g, " ");
  const m = /error\s+code:?\s*(\d{4})\b/i.exec(plain) ?? /\berror\s+(1\d{3})\b/i.exec(plain);
  return m ? Number(m[1]) : null;
}

/** An error page, or a 5xx / 429 the store has no specific words for, as our words (never the page itself) */
export function busyError(status: number, text: string, page: boolean, serverCode?: unknown): StoreError {
  const cf = page ? cloudflareCode(text) : null;
  const limited = status === 429 || cf === 1015;
  const detail: Record<string, unknown> = { code: (limited ? "rate_limited" : "server_busy") satisfies TransientCode, status };
  if (cf !== null) detail.cloudflare = cf;
  if (typeof serverCode === "string") detail.serverCode = serverCode;
  return new StoreError("unavailable", limited ? RATE_LIMITED_TEXT : SERVER_BUSY_TEXT, detail);
}

/** Momentary trouble worth another try: no connection, the server busy or rate limiting */
export function isTransient(e: unknown): boolean {
  if (!(e instanceof StoreError)) return false;
  if (e.code === "offline") return true;
  const code = (e.detail as { code?: unknown } | undefined)?.code;
  return e.code === "unavailable" && typeof code === "string" && TRANSIENT.has(code);
}

/** Should a read that got this answer try again? 5xx, 429 and error pages — not our JSON refusals (a Governance+ 503). */
export async function retryableAnswer(res: Response): Promise<boolean> {
  if (res.ok) return false;
  const text = await res.clone().text().catch(() => "");
  if (isErrorPage(res, text)) return true;
  if (res.status < 500 && res.status !== 429) return false;
  try {
    const code = (JSON.parse(text) as { code?: unknown } | null)?.code;
    return code === undefined || code === "internal" || code === "rate_limited";
  } catch {
    return true;
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * One call, tried again after each of `delays` when it is a read (GET, HEAD) and the network failed or the answer was
 * 5xx, 429 or an error page. The last answer (or the network's error) is the caller's to turn into words.
 */
export async function fetchWithRetry(method: string, delays: readonly number[], go: () => Promise<Response>): Promise<Response> {
  const idempotent = method === "GET" || method === "HEAD";
  for (let attempt = 0; ; attempt++) {
    const last = !idempotent || attempt >= delays.length;
    let res: Response;
    try {
      res = await go();
    } catch (e) {
      if (last) throw e;
      await sleep(delays[attempt]);
      continue;
    }
    if (last || !(await retryableAnswer(res))) return res;
    await res.body?.cancel().catch(() => {});
    await sleep(delays[attempt]);
  }
}

/** A step tried again after each of `delays` while it fails with momentary trouble (`isTransient`) */
export async function withRetry<T>(delays: readonly number[], step: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await step();
    } catch (e) {
      if (attempt >= delays.length || !isTransient(e)) throw e;
      await sleep(delays[attempt]);
    }
  }
}
