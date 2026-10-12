/**
 * The server's answers that aren't ours (the 2026-10-12 incident): Cloudflare's pages as our words, reads tried again.
 */
import { describe, expect, it } from "vitest";
import { StoreError } from "../../shared/store/protocol";
import { cloudflareCode, fetchWithRetry, isErrorPage, isTransient, RATE_LIMITED_TEXT, SERVER_BUSY_TEXT, STILL_UPLOADING_TEXT, withRetry } from "./http";
import { httpError, isGone } from "./service";

const CF_1102 = `<!DOCTYPE html>
<html lang="en-US"><head><title>Worker exceeded resource limits | designer.example | Cloudflare</title></head>
<body><div id="cf-error-details"><h1><span class="cf-error-type">Error</span> <span class="cf-error-code">1102</span></h1>
<h2 class="cf-subheadline">Worker exceeded resource limits</h2></div></body></html>`;

const html = (body: string, status: number) => new Response(body, { status, headers: { "content-type": "text/html; charset=UTF-8", "cf-ray": "8d1f2a3b4c5d6e7f-AMS" } });
const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("httpError", () => {
  it("never shows Cloudflare's page: 1102 / 1101 / 5xx pages say the server is busy, with the error's number", async () => {
    const e = await httpError(html(CF_1102, 503));
    expect(e).toMatchObject({ code: "unavailable", message: SERVER_BUSY_TEXT });
    expect(e.detail).toEqual({ code: "server_busy", status: 503, cloudflare: 1102 });
    expect((await httpError(html("<html><body>Error 1101 Worker threw exception</body></html>", 500))).detail).toMatchObject({ cloudflare: 1101 });
    // A page whatever its type says (leading whitespace, upper case), and Cloudflare's plain text for API clients
    expect((await httpError(new Response("  \n<HTML><body>Bad gateway</body></HTML>", { status: 502 }))).message).toBe(SERVER_BUSY_TEXT);
    const plain = await httpError(new Response("error code: 1102", { status: 503, headers: { "cf-ray": "x-AMS" } }));
    expect(plain.message).toBe(SERVER_BUSY_TEXT);
    expect(plain.detail).toMatchObject({ cloudflare: 1102 });
  });

  it("says rate limiting in its own words (1015, 429)", async () => {
    const e = await httpError(new Response("error code: 1015", { status: 429, headers: { "cf-ray": "x-AMS" } }));
    expect(e).toMatchObject({ code: "unavailable", message: RATE_LIMITED_TEXT });
    expect(e.detail).toMatchObject({ code: "rate_limited", cloudflare: 1015 });
    expect((await httpError(html("<html><title>Error 1015</title><body>You are being rate limited</body></html>", 403))).message).toBe(RATE_LIMITED_TEXT);
    expect((await httpError(json({ error: "slow down", code: "rate_limited" }, 429))).message).toBe(RATE_LIMITED_TEXT);
  });

  it("keeps our own JSON refusals as they were; our 5xx bodies aren't shown either", async () => {
    expect(await httpError(json({ error: "only the owner can", code: "forbidden" }, 403))).toMatchObject({ code: "forbidden", message: "only the owner can" });
    const internal = await httpError(json({ error: "D1_ERROR: no such table", code: "internal" }, 500));
    expect(internal).toMatchObject({ code: "unavailable", message: SERVER_BUSY_TEXT });
    expect(internal.detail).toMatchObject({ code: "server_busy", serverCode: "internal" });
    // Governance+'s 503 stays its own refusal
    expect((await httpError(json({ error: "key", code: "key_unavailable" }, 503))).detail).toMatchObject({ code: "key_unavailable" });
  });

  it("tells a file gone (our JSON 404 / 410) from a page's 404 and a room with no snapshot yet", async () => {
    expect(isGone(await httpError(json({ error: "not found", code: "not_found" }, 404)))).toBe(true);
    expect(isGone(await httpError(json({ error: "gone", code: "gone" }, 410)))).toBe(true);
    const page = await httpError(html("<html><body>404 Not Found</body></html>", 404));
    expect(isGone(page)).toBe(false);
    expect(page.message).toBe(SERVER_BUSY_TEXT);
    const uploading = await httpError(json({ error: "no snapshot yet", code: "no_snapshot" }, 404));
    expect(uploading).toMatchObject({ code: "unavailable", message: STILL_UPLOADING_TEXT });
    expect(uploading.detail).toMatchObject({ code: "no_snapshot" });
    expect(isGone(uploading)).toBe(false);
    expect(isTransient(uploading)).toBe(false);
  });
});

describe("error pages", () => {
  it("recognises pages and reads Cloudflare's number", () => {
    expect(isErrorPage(new Response(""), "<!doctype html><p>x</p>")).toBe(true);
    expect(isErrorPage(new Response("", { headers: { "cf-ray": "x" } }), '{"error":"x"}')).toBe(false);
    expect(isErrorPage(new Response(""), "plain")).toBe(false);
    expect(cloudflareCode(CF_1102)).toBe(1102);
    expect(cloudflareCode("nothing here")).toBeNull();
  });
});

describe("fetchWithRetry", () => {
  const answers = (...list: (Response | Error)[]) => {
    let n = 0;
    const go = async () => {
      const a = list[Math.min(n++, list.length - 1)];
      if (a instanceof Error) throw a;
      return a.clone();
    };
    return { go, count: () => n };
  };

  it("tries a read again on no network, 5xx, 429 and pages, then gives the last answer", async () => {
    const a = answers(new TypeError("fetch failed"), html(CF_1102, 503), json({ ok: true }, 200));
    expect((await fetchWithRetry("GET", [0, 0], a.go)).status).toBe(200);
    expect(a.count()).toBe(3);
    const b = answers(html(CF_1102, 503));
    expect((await fetchWithRetry("GET", [0, 0], b.go)).status).toBe(503);
    expect(b.count()).toBe(3);
    const c = answers(new TypeError("fetch failed"));
    await expect(fetchWithRetry("HEAD", [0], c.go)).rejects.toThrow("fetch failed");
    expect(c.count()).toBe(2);
  });

  it("never tries again a write, or our JSON refusals", async () => {
    const w = answers(html(CF_1102, 503));
    expect((await fetchWithRetry("POST", [0, 0], w.go)).status).toBe(503);
    expect(w.count()).toBe(1);
    const r = answers(json({ error: "not found", code: "not_found" }, 404));
    await fetchWithRetry("GET", [0, 0], r.go);
    expect(r.count()).toBe(1);
    const g = answers(json({ error: "key", code: "key_unavailable" }, 503));
    await fetchWithRetry("GET", [0, 0], g.go);
    expect(g.count()).toBe(1);
  });
});

describe("withRetry", () => {
  it("tries a step again only through momentary trouble", async () => {
    let n = 0;
    expect(
      await withRetry([0, 0], async () => {
        if (n++ < 2) throw new StoreError("unavailable", SERVER_BUSY_TEXT, { code: "server_busy" });
        return "ok";
      }),
    ).toBe("ok");
    n = 0;
    await expect(
      withRetry([0, 0], async () => {
        n++;
        throw new StoreError("forbidden", "no");
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(n).toBe(1);
  });
});
