/**
 * Per-IP throttling of the routes anyone can call without an account (docs/multiplayer.md §17): sign-in steps, the
 * public preview viewer's files, embeds, file links, the legal pages. No D1 — counting a stranger's request in D1 would
 * itself spend the free plan's writes. Each Worker isolate counts in memory (best effort: Cloudflare spreads requests
 * over isolates); when a Workers Rate Limiting binding is configured (wrangler.jsonc `ratelimits`: `RATE_LIMIT_AUTH`
 * with 30 a minute, `RATE_LIMIT_PUBLIC` with 600 a minute), it decides that bucket instead, across the network.
 */
import type { Deps } from "../api";
import { HttpError } from "../org/http";

/** What a bucket allows from one IP per minute */
export const THROTTLE_PER_MINUTE = {
  /** /auth/login, /auth/callback, /auth/token, /auth/sso, /auth/2fa, /saml/…/start */
  auth: 30,
  /** /previews/:id/… public reads, /p/:id, /embed/…, /f/:key */
  public: 600,
} as const;
export type ThrottleBucket = keyof typeof THROTTLE_PER_MINUTE;

interface RateLimiterBinding {
  limit(o: { key: string }): Promise<{ success: boolean }>;
}

const MAX_KEYS = 10_000;
const windows = new Map<string, { minute: number; n: number }>();

/** Tests start clean */
export function resetThrottle(): void {
  windows.clear();
}

/** 429 `rate_limited` when this IP passed the bucket's limit this minute */
export async function throttle(deps: Deps, req: Request, bucket: ThrottleBucket): Promise<void> {
  const ip = req.headers.get("cf-connecting-ip");
  if (!ip) return; // not through Cloudflare (tests, local tools): nothing to tell callers apart by
  const binding = (deps.env as Record<string, unknown>)[bucket === "auth" ? "RATE_LIMIT_AUTH" : "RATE_LIMIT_PUBLIC"] as RateLimiterBinding | undefined;
  const key = `${bucket}:${ip}`;
  if (binding) {
    if (!(await binding.limit({ key })).success) throw tooMany();
    return;
  }
  const minute = Math.floor(deps.now() / 60_000);
  const w = windows.get(key);
  if (!w || w.minute !== minute) {
    if (windows.size >= MAX_KEYS) windows.clear();
    windows.set(key, { minute, n: 1 });
    return;
  }
  w.n++;
  if (w.n > THROTTLE_PER_MINUTE[bucket]) throw tooMany();
}

const tooMany = () => new HttpError(429, "Too many requests. Wait a minute and try again.", "rate_limited");
