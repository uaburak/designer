import { safeStorage } from "electron";

/**
 * Secrets kept in userData files (the account's session, the MCP server's token): "enc:<base64>" sealed with
 * safeStorage — the key is "DesignerV2 Safe Storage" in the login keychain — or "raw:<secret>" where the OS has no
 * encryption.
 *
 * Async only, on launch's path above all. A Mac asks the person before a build signed differently from the one that
 * made the keychain item reads it (an ad-hoc build after another, the Developer ID build after an ad-hoc one). The
 * sync API (`decryptString` / `encryptString`) waits for that answer on main's thread: until someone answers, main
 * runs nothing — no store port, Home's spinner, no quit (2026-10-12: a signed test build behind an unanswered
 * keychain prompt). The async API fetches the key off main's thread; only the caller's promise waits.
 */

/** What we use of safeStorage (a fake in sealed.test.ts) */
export interface AsyncSealer {
  isAsyncEncryptionAvailable(): Promise<boolean>;
  encryptStringAsync(plainText: string): Promise<Buffer>;
  decryptStringAsync(encrypted: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>;
}

export interface SealOptions {
  sealer?: AsyncSealer;
  /** Said once when the keychain hasn't answered after `slowMs` (default 5 s): a prompt is probably open */
  warn?: (message: string) => void;
  slowMs?: number;
}

const defaults = (o?: SealOptions) => ({
  sealer: o?.sealer ?? (safeStorage as AsyncSealer),
  warn: o?.warn ?? ((m: string) => console.warn(m)),
  slowMs: o?.slowMs ?? 5000,
});

/** The keychain's answer, with a line in the log while macOS waits for the person (the prompt may be behind windows). */
async function patiently<T>(what: string, work: () => Promise<T>, o: ReturnType<typeof defaults>): Promise<T> {
  const timer = setTimeout(() => o.warn(`[keychain] still waiting for the keychain to ${what} — macOS may be asking to allow access to “DesignerV2 Safe Storage”`), o.slowMs);
  timer.unref?.();
  try {
    return await work();
  } finally {
    clearTimeout(timer);
  }
}

/** A sealed value's secret: null when there is none, it is malformed, or the keychain refuses (the caller starts afresh). */
export async function unsealAsync(v: unknown, opts?: SealOptions): Promise<string | null> {
  if (typeof v !== "string") return null;
  if (v.startsWith("raw:")) return v.slice(4);
  if (!v.startsWith("enc:")) return null;
  const o = defaults(opts);
  try {
    return (await patiently("read a secret", () => o.sealer.decryptStringAsync(Buffer.from(v.slice(4), "base64")), o)).result;
  } catch {
    return null;
  }
}

/** A secret sealed for a file: "enc:…" with the keychain, "raw:…" where the OS has no encryption. */
export async function sealAsync(secret: string, opts?: SealOptions): Promise<string> {
  const o = defaults(opts);
  const available = await patiently("seal a secret", () => o.sealer.isAsyncEncryptionAvailable(), o).catch(() => false);
  if (!available) return `raw:${secret}`;
  return `enc:${(await patiently("seal a secret", () => o.sealer.encryptStringAsync(secret), o)).toString("base64")}`;
}
