/**
 * Firebase is off until the owner adds `userData/firebase/config.json` (docs/data.md §12.1), written by
 * Settings › Sync › "Connect Firebase project…" or dropped there by hand:
 *
 *   {
 *     "firebase": { "apiKey": "…", "authDomain": "…", "projectId": "…", "storageBucket": "…", "messagingSenderId": "…", "appId": "…" },
 *     "oauth":    { "clientId": "….apps.googleusercontent.com", "clientSecret": "…" },
 *     "viewer":   { "origin": "https://<project>.web.app" }
 *   }
 *
 * The repo holds no config. Even with a config, sync runs only once it is turned on (Settings › Sync, main's
 * `settings.sync.enabled`), and the Firebase SDK is loaded lazily inside the store process (firestoreAdapter.ts).
 */
import { join } from "node:path";
import { readJsonOrNull } from "../local/fsutil";
import type { Log } from "../local/workspace";

export const SYNC_CONFIG_FILE = join("firebase", "config.json");

export interface SyncConfig {
  firebase: { apiKey: string; authDomain: string; projectId: string; storageBucket: string; messagingSenderId?: string; appId: string };
  oauth?: { clientId: string; clientSecret?: string };
  viewer?: { origin: string };
}

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

export function validateSyncConfig(raw: unknown): SyncConfig | null {
  const c = raw as Partial<SyncConfig> | null;
  const f = c?.firebase;
  if (!f || !nonEmpty(f.apiKey) || !nonEmpty(f.authDomain) || !nonEmpty(f.projectId) || !nonEmpty(f.storageBucket) || !nonEmpty(f.appId)) return null;
  if (c.viewer && !/^https:\/\/[^/]+$/.test(c.viewer.origin ?? "")) return null;
  return c as SyncConfig;
}

export async function loadSyncConfig(userDataDir: string, log?: Log): Promise<SyncConfig | null> {
  const raw = await readJsonOrNull<unknown>(join(userDataDir, SYNC_CONFIG_FILE));
  if (raw === null) return null;
  const config = validateSyncConfig(raw);
  if (!config) log?.("warn", `${SYNC_CONFIG_FILE} is incomplete; sync stays off`);
  return config;
}
