/**
 * Sending webhooks (docs/multiplayer.md §16.9 "Sending" and "Retries"): `POST endpoint` with the payload, headers
 * `content-type: application/json`, `user-agent: DesignerV2-Webhooks/1` and `X-Designer-Signature: t=<unix s>,
 * v1=<hex HMAC-SHA256(passcode, t + "." + body)>` (decision 11), 10 s at most. Only a 200 counts (Figma's rule); a
 * failure is tried again after 5 min, 30 min and 3 h, by the five-minute cron (`sweepWebhooks`, at most 50 a run), then given
 * up. Rows older than 7 days are deleted by the same cron. A row is claimed before it is sent (`sending_until`, a
 * lease of `SEND_LEASE_MS`), so the immediate send and the cron never deliver it twice.
 */
import { WEBHOOK_RETRY_MINUTES } from "../../../src/shared/rest/types";
import type { Deps } from "../api";

export const DELIVERY_TIMEOUT_MS = 10_000;
export const SWEEP_BATCH = 50;
export const LOG_DAYS = 7;

const enc = new TextEncoder();

export async function signature(passcode: string, t: number, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(passcode), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`${t}.${body}`)));
  return `t=${t},v1=${[...sig].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

interface Row {
  id: number;
  webhook_id: number;
  endpoint: string;
  payload: string;
  attempt: number;
  passcode: string | null;
}

/** Send one queued row now and record the answer (and the next try) */
async function send(deps: Pick<Deps, "db" | "now" | "fetch">, r: Row): Promise<void> {
  const now = deps.now();
  const t = Math.floor(now / 1000);
  let status: number | null = null;
  let error: string | null = null;
  try {
    const res = await deps.fetch(r.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "DesignerV2-Webhooks/1", "x-designer-signature": await signature(r.passcode ?? "", t, r.payload) },
      body: r.payload,
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      redirect: "manual",
    });
    status = res.status;
    if (status !== 200) error = `The endpoint answered ${status}`;
    await res.body?.cancel().catch(() => undefined);
  } catch (e) {
    error = (e as Error)?.name === "TimeoutError" ? "The endpoint didn't answer within 10 seconds" : `The request failed: ${(e as Error)?.message ?? e}`.slice(0, 500);
  }
  const attempt = r.attempt + 1;
  // attempt 1 is the first send; 2–4 are Figma's three retries
  const retry = error && attempt <= WEBHOOK_RETRY_MINUTES.length ? now + WEBHOOK_RETRY_MINUTES[attempt - 1] * 60_000 : null;
  await deps.db.d1
    .prepare(`UPDATE webhook_requests SET sent_at = ?2, attempt = ?3, status = ?4, received_at = ?5, error_msg = ?6, next_at = ?7, sending_until = NULL WHERE id = ?1`)
    .bind(r.id, now, attempt, status, status !== null ? deps.now() : null, error, retry)
    .run();
}

const SELECT = `SELECT r.id, r.webhook_id, r.endpoint, r.payload, r.attempt, w.passcode FROM webhook_requests r JOIN webhooks w ON w.id = r.webhook_id`;

/** How long a claimed row stays someone's: longer than a send (10 s) can take; a crashed sender's row frees after it */
export const SEND_LEASE_MS = 60_000;

/**
 * Claim rows to send (migration 0016): one UPDATE … RETURNING takes the rows `where` picks that are still queued and
 * carry no unexpired lease, so the immediate send and the cron can't both take one. The claimed rows, with passcodes.
 */
async function claim(deps: Pick<Deps, "db" | "now">, where: string, binds: unknown[]): Promise<Row[]> {
  const now = deps.now();
  const { results: claimed } = await deps.db.d1
    .prepare(
      `UPDATE webhook_requests SET sending_until = ?1 WHERE id IN (SELECT id FROM webhook_requests WHERE next_at IS NOT NULL AND (sending_until IS NULL OR sending_until <= ?2) AND ${where})
       RETURNING id`,
    )
    .bind(now + SEND_LEASE_MS, now, ...binds)
    .all<{ id: number }>();
  if (!claimed.length) return [];
  const { results } = await deps.db.d1.prepare(`${SELECT} WHERE r.id IN (SELECT value FROM json_each(?1)) ORDER BY r.id`).bind(JSON.stringify(claimed.map((c) => c.id))).all<Row>();
  return results;
}

/** Send these rows now (after `emitWebhook` queued them) */
export async function deliverRows(deps: Pick<Deps, "db" | "now" | "fetch">, ids: number[]): Promise<void> {
  if (!ids.length) return;
  const rows = await claim(deps, `id IN (SELECT value FROM json_each(?3))`, [JSON.stringify(ids)]);
  await Promise.all(rows.map((r) => send(deps, r)));
}

/** The five-minute cron ("*\/5 * * * *"): what is due (≤ 50), then the log older than 7 days */
export async function sweepWebhooks(deps: Pick<Deps, "db" | "now" | "fetch">): Promise<{ sent: number }> {
  const now = deps.now();
  const results = await claim(deps, `next_at <= ?2 ORDER BY next_at LIMIT ?3`, [SWEEP_BATCH]);
  await Promise.all(results.map((r) => send(deps, r)));
  await deps.db.d1.prepare(`DELETE FROM webhook_requests WHERE created_at < ?1`).bind(now - LOG_DAYS * 86_400_000).run();
  return { sent: results.length };
}
