// Secrets sealed with safeStorage, async only (sealed.ts). 2026-10-12: a test build signed differently from the one
// that made "DesignerV2 Safe Storage" launched behind a keychain prompt nobody answered; startAgents' sync
// `decryptString` held main's thread on it — the store's port never reached Home (a spinner), quitting hung.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const sync = () => {
  throw new Error("the sync safeStorage API waits for a keychain prompt on main's thread");
};
vi.mock("electron", () => ({ safeStorage: { decryptString: sync, encryptString: sync, isEncryptionAvailable: sync } }));
const { sealAsync, unsealAsync } = await import("./sealed");

/** A keychain whose answer comes when the test says (a prompt the person answers later, or never) */
function keychain(o: { available?: boolean; allowed?: boolean } = {}) {
  const waiting: (() => void)[] = [];
  const answer = () => waiting.splice(0).forEach((f) => f());
  const later = <T>(value: () => T) =>
    new Promise<T>((resolve, reject) => {
      const settle = () => {
        try {
          resolve(value());
        } catch (e) {
          reject(e);
        }
      };
      // "Always Allow" given before: no prompt, the answer comes at once.
      if (o.allowed) settle();
      else waiting.push(settle);
    });
  let denied = false;
  const sealer = {
    isAsyncEncryptionAvailable: vi.fn(() => later(() => o.available ?? true)),
    encryptStringAsync: vi.fn((s: string) => later(() => Buffer.from(`v10${s}`))),
    decryptStringAsync: vi.fn((b: Buffer) =>
      later(() => {
        if (denied) throw new Error("User canceled the operation");
        return { result: b.toString().slice(3), shouldReEncrypt: false };
      }),
    ),
  };
  return { sealer, answer, deny: () => ((denied = true), answer()) };
}

afterEach(() => vi.useRealTimers());

describe("sealed secrets", () => {
  it("unseals through the async keychain only; the caller waits, main's thread doesn't", async () => {
    const k = keychain();
    const enc = `enc:${Buffer.from("v10the-token").toString("base64")}`;
    let got: string | null | undefined;
    const p = unsealAsync(enc, { sealer: k.sealer }).then((v) => (got = v));
    // A prompt is open: the call has returned, nothing is decided yet, and other work runs meanwhile.
    await Promise.resolve();
    expect(got).toBeUndefined();
    k.answer();
    await p;
    expect(got).toBe("the-token");
    expect(k.sealer.decryptStringAsync).toHaveBeenCalledTimes(1);
  });

  it("raw values, nothing and garbage never touch the keychain", async () => {
    const k = keychain();
    expect(await unsealAsync("raw:abc", { sealer: k.sealer })).toBe("abc");
    expect(await unsealAsync(undefined, { sealer: k.sealer })).toBeNull();
    expect(await unsealAsync("plain", { sealer: k.sealer })).toBeNull();
    expect(await unsealAsync(42, { sealer: k.sealer })).toBeNull();
    expect(k.sealer.decryptStringAsync).not.toHaveBeenCalled();
  });

  it("a refused or failing keychain is no secret (the caller starts afresh), not a hang", async () => {
    const k = keychain();
    const p = unsealAsync(`enc:${Buffer.from("v10x").toString("base64")}`, { sealer: k.sealer });
    k.deny();
    expect(await p).toBeNull();
  });

  it("says in the log when the keychain keeps it waiting (a prompt may be behind the windows)", async () => {
    vi.useFakeTimers();
    const k = keychain();
    const warn = vi.fn();
    const p = unsealAsync(`enc:${Buffer.from("v10x").toString("base64")}`, { sealer: k.sealer, warn, slowMs: 5000 });
    await vi.advanceTimersByTimeAsync(4999);
    expect(warn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/keychain.*DesignerV2 Safe Storage/);
    k.answer();
    expect(await p).toBe("x");
    // Answered: no more lines.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("seals with the keychain when it is there, raw where the OS has no encryption", async () => {
    const k = keychain({ allowed: true });
    const sealed = await sealAsync("s3cret", { sealer: k.sealer });
    expect(sealed).toBe(`enc:${Buffer.from("v10s3cret").toString("base64")}`);
    expect(await unsealAsync(sealed, { sealer: k.sealer })).toBe("s3cret");

    const none = keychain({ available: false, allowed: true });
    expect(await sealAsync("s3cret", { sealer: none.sealer })).toBe("raw:s3cret");
    expect(none.sealer.encryptStringAsync).not.toHaveBeenCalled();
  });

  it("launch's path never calls the sync safeStorage API (account session, the MCP server's token)", () => {
    const src = (p: string) => readFileSync(join(import.meta.dirname, p), "utf8");
    const account = src("account/index.ts");
    expect(account).not.toMatch(/safeStorage\./);
    const agents = src("agents/host.ts");
    const start = agents.slice(agents.indexOf("export async function startAgents"), agents.indexOf("export async function stopAgents"));
    expect(start.length).toBeGreaterThan(0);
    expect(start).toMatch(/unsealAsync\(/);
    expect(start).not.toMatch(/safeStorage\.|\bunseal\(|\bseal\(/);
  });
});
