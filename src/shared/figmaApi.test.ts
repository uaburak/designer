// Figma's REST API with a personal access token (figmaApi.ts), on a mocked fetch: no network.
import { describe, expect, it } from "vitest";
import { classifyFigmaError, fetchFigmaImages, figmaImageUrls, figmaMe, type FetchLike } from "./figmaApi";

const TOKEN = "figd_abcdefghijklmnopqrstuvwxyz0123456789";
const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);

type Call = { url: string; headers?: Record<string, string> };

function fake(routes: Record<string, { status?: number; json?: unknown; bytes?: Uint8Array; headers?: Record<string, string> } | "throw">) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, headers: init?.headers });
    const r = routes[url];
    if (!r || r === "throw") throw new TypeError("Failed to fetch");
    const status = r.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (n: string) => r.headers?.[n.toLowerCase()] ?? null },
      json: async () => r.json,
      arrayBuffer: async () => (r.bytes ?? new Uint8Array()).slice().buffer,
    };
  };
  return { fetch, calls };
}

const res = (status: number, json: unknown, headers: Record<string, string> = {}) => ({ status, headers: { get: (n: string) => headers[n.toLowerCase()] ?? null }, json: async () => json });

describe("Figma REST API", () => {
  it("classifies Figma's refusals", async () => {
    expect(await classifyFigmaError(res(403, { status: 403, err: "Invalid token" }))).toEqual({ error: "invalid-token" });
    expect(await classifyFigmaError(res(403, { status: 403, err: "Token expired" }))).toEqual({ error: "expired" });
    expect(await classifyFigmaError(res(403, { status: 403, err: "Forbidden" }))).toEqual({ error: "no-access" });
    expect(await classifyFigmaError(res(404, { status: 404, err: "Not found" }))).toEqual({ error: "not-found" });
    expect(await classifyFigmaError(res(429, {}, { "retry-after": "30" }))).toEqual({ error: "rate-limited", retryAfter: 30 });
    expect(await classifyFigmaError(res(500, null))).toEqual({ error: "failed" });
  });

  it("checks a token with /v1/me (X-Figma-Token), a token without the user scope still connects", async () => {
    const ok = fake({ "https://api.figma.com/v1/me": { json: { id: "1", handle: "Ada", email: "ada@example.com" } } });
    expect(await figmaMe(TOKEN, ok.fetch)).toEqual({ ok: true, value: { handle: "Ada", email: "ada@example.com" } });
    expect(ok.calls[0].headers).toEqual({ "X-Figma-Token": TOKEN });
    const noScope = fake({ "https://api.figma.com/v1/me": { status: 403, json: { status: 403, err: "Invalid scope: requires current_user:read" } } });
    expect(await figmaMe(TOKEN, noScope.fetch)).toEqual({ ok: true, value: null });
    const bad = fake({ "https://api.figma.com/v1/me": { status: 403, json: { status: 403, err: "Invalid token" } } });
    expect(await figmaMe(TOKEN, bad.fetch)).toEqual({ ok: false, error: "invalid-token" });
    expect(await figmaMe("short", bad.fetch)).toEqual({ ok: false, error: "invalid-token" });
    expect(await figmaMe(TOKEN, fake({ "https://api.figma.com/v1/me": "throw" }).fetch)).toEqual({ ok: false, error: "offline" });
  });

  it("maps imageRef → URL (lower-case, https only)", async () => {
    const f = fake({ "https://api.figma.com/v1/files/AbCdEfGh123/images": { json: { error: false, status: 200, meta: { images: { [A.toUpperCase()]: "https://s3/a", [B]: "http://insecure/b", [C]: 7 } } } } });
    expect(await figmaImageUrls(TOKEN, "AbCdEfGh123", f.fetch)).toEqual({ ok: true, value: { [A]: "https://s3/a" } });
    expect(await figmaImageUrls(TOKEN, "../me", f.fetch)).toEqual({ ok: false, error: "not-found" });
  });

  it("downloads only the images the paste needs, without the token; reports the ones the file lacks", async () => {
    const f = fake({
      "https://api.figma.com/v1/files/AbCdEfGh123/images": { json: { meta: { images: { [A]: "https://s3/a", [B]: "https://s3/b", [C]: "https://s3/c" } } } },
      "https://s3/a": { bytes: new Uint8Array([1, 2, 3]) },
      "https://s3/b": { status: 403 },
    });
    const progress: [number, number][] = [];
    const r = await fetchFigmaImages(TOKEN, "AbCdEfGh123", [A, B, "d".repeat(40), "not-a-hash"], f.fetch, { onProgress: (d, t) => progress.push([d, t]) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.images).toEqual([{ hash: A, bytes: new Uint8Array([1, 2, 3]) }]);
    expect(r.value.missing.sort()).toEqual([B, "d".repeat(40)].sort());
    expect(f.calls.map((c) => c.url)).not.toContain("https://s3/c");
    for (const c of f.calls) expect(!!c.headers?.["X-Figma-Token"]).toBe(c.url.startsWith("https://api.figma.com/"));
    expect(progress.at(-1)).toEqual([2, 2]);
  });

  it("passes Figma's refusal of the file on, and says offline when nothing could be downloaded", async () => {
    const denied = fake({ "https://api.figma.com/v1/files/AbCdEfGh123/images": { status: 404, json: { status: 404, err: "Not found" } } });
    expect(await fetchFigmaImages(TOKEN, "AbCdEfGh123", [A], denied.fetch)).toEqual({ ok: false, error: "not-found" });
    const down = fake({ "https://api.figma.com/v1/files/AbCdEfGh123/images": { json: { meta: { images: { [A]: "https://s3/a" } } } } });
    expect(await fetchFigmaImages(TOKEN, "AbCdEfGh123", [A], down.fetch)).toEqual({ ok: false, error: "offline" });
    expect(await fetchFigmaImages(TOKEN, "AbCdEfGh123", [], down.fetch)).toEqual({ ok: true, value: { images: [], missing: [] } });
  });
});
