// The Figma connection in main (figma.ts): the token checked with Figma, kept sealed (never as plain text on disk),
// used for a paste's images, forgotten on Disconnect. safeStorage and fetch are fakes; no network.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FetchLike } from "../shared/figmaApi";

vi.mock("electron", () => ({ app: { getPath: () => tmpdir() }, net: { fetch: () => Promise.reject(new Error("no network in tests")) }, safeStorage: {} }));
const { FigmaConnectionStore } = await import("./figma");

const TOKEN = "figd_abcdefghijklmnopqrstuvwxyz0123456789";
const A = "a".repeat(40);

/** A keychain that "encrypts" by reversing (enough to tell the token isn't written as it is). */
const sealer = {
  isAsyncEncryptionAvailable: vi.fn(async () => true),
  encryptStringAsync: vi.fn(async (s: string) => Buffer.from([...s].reverse().join(""))),
  decryptStringAsync: vi.fn(async (b: Buffer) => ({ result: [...b.toString()].reverse().join(""), shouldReEncrypt: false })),
};

function figma(meStatus = 200) {
  const calls: { url: string; token?: string }[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, token: init?.headers?.["X-Figma-Token"] });
    const json = url.endsWith("/v1/me") ? (meStatus === 200 ? { handle: "Ada", email: "ada@example.com" } : { status: meStatus, err: "Invalid token" }) : url.includes("/images") ? { meta: { images: { [A]: "https://s3/a" } } } : null;
    const status = url.endsWith("/v1/me") ? meStatus : 200;
    return { ok: status === 200, status, headers: { get: () => null }, json: async () => json, arrayBuffer: async () => new Uint8Array([9, 9]).buffer };
  };
  return { fetch, calls };
}

let dir = "";
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});
const path = () => join((dir = mkdtempSync(join(tmpdir(), "figma-conn-"))), "figma.json");

describe("Figma connection (main)", () => {
  it("connects, keeps the token sealed, fetches with it, disconnects", async () => {
    const f = figma();
    const p = path();
    const store = new FigmaConnectionStore({ path: p, fetch: f.fetch, seal: { sealer } });
    expect(await store.status()).toEqual({ connected: false, user: null });
    expect(await store.images("AbCdEfGh123", [A])).toEqual({ ok: false, error: "no-token" });
    expect(await store.connect(`  ${TOKEN}\n`)).toEqual({ ok: true, value: { connected: true, user: { handle: "Ada", email: "ada@example.com" } } });
    const disk = readFileSync(p, "utf8");
    expect(disk).not.toContain(TOKEN);
    expect(JSON.parse(disk).token).toMatch(/^enc:/);
    // A new store (the next launch) unseals it and uses it for the images, with the token for api.figma.com only.
    const again = new FigmaConnectionStore({ path: p, fetch: f.fetch, seal: { sealer } });
    expect(await again.status()).toEqual({ connected: true, user: { handle: "Ada", email: "ada@example.com" } });
    const r = await again.images("AbCdEfGh123", [A, "nope"]);
    expect(r).toEqual({ ok: true, value: { images: [{ hash: A, bytes: new Uint8Array([9, 9]) }], missing: [] } });
    expect(f.calls.filter((c) => c.url.startsWith("https://api.figma.com/")).every((c) => c.token === TOKEN)).toBe(true);
    expect(f.calls.find((c) => c.url === "https://s3/a")?.token).toBeUndefined();
    expect(await again.disconnect()).toEqual({ connected: false, user: null });
    expect(readFileSync(p, "utf8")).toBe("{}");
    expect(await again.images("AbCdEfGh123", [A])).toEqual({ ok: false, error: "no-token" });
  });

  it("keeps nothing when Figma refuses the token", async () => {
    const p = path();
    const store = new FigmaConnectionStore({ path: p, fetch: figma(403).fetch, seal: { sealer } });
    expect(await store.connect(TOKEN)).toEqual({ ok: false, error: "invalid-token" });
    expect(await store.status()).toEqual({ connected: false, user: null });
    expect(await store.connect("x")).toEqual({ ok: false, error: "invalid-token" });
  });
});
