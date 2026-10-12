/**
 * The cap on every account's stored bytes together (`server_storage_bytes`, docs/multiplayer.md §17, §17.1): the
 * operator's number (`server_settings` row `server_storage_bytes`, Settings › Operator › Spend guard). Since content
 * moved to R2 (docs/cloud.md §3) there is no cap by default — the spend guard decides; QUOTA_LIMITS' 1 TB is only what
 * Settings shows for "Use default".
 */
import type { D1Like } from "../db";

/** 1 MB … 1 TB */
export const MIN_SERVER_STORAGE = 1024 * 1024;
export const MAX_SERVER_STORAGE = 1024 ** 4;

export async function serverStorageSetting(d1: D1Like): Promise<number | null> {
  const r = await d1.prepare(`SELECT v FROM server_settings WHERE k = 'server_storage_bytes'`).first<{ v: string }>();
  const n = Number(r?.v);
  return r && Number.isInteger(n) && n >= MIN_SERVER_STORAGE && n <= MAX_SERVER_STORAGE ? n : null;
}

/** The operator's cap, else none (Infinity) */
export async function serverStorageLimit(d1: D1Like): Promise<number> {
  return (await serverStorageSetting(d1)) ?? Infinity;
}
