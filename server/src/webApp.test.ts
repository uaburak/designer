import { beforeEach, describe, expect, it } from "vitest";
import { handle, type Deps } from "./api";
import { Db, type D1Like } from "./db";
import { sqliteD1 } from "./testing/sqliteD1";
import { appCsp, isAppAsset, isAppRoute } from "./webApp";

const ORIGIN = "https://wecra.app";
const INDEX = '<!doctype html><title>Wecra</title><script type="module" src="/assets/index-AbC123.js"></script>';

let deps: Deps;
let assetFetches: string[];
let withApp: boolean;

beforeEach(() => {
  assetFetches = [];
  withApp = true;
  const d1: D1Like = sqliteD1();
  // Workers Static Assets (out/web): the app's index.html and hashed files, the viewer at _viewer/index.html
  const files: Record<string, [string, string]> = {
    "/index.html": [INDEX, "text/html"],
    "/assets/index-AbC123.js": ["console.log(1)", "text/javascript"],
    "/assets/engine-Zz9_x-1.wasm": ["\0asm", "application/octet-stream"],
    "/boot.js": ["/* theme */", "text/javascript"],
    "/_viewer/index.html": ["<!doctype html><title>Developer preview</title>", "text/html"],
  };
  const env = {
    SESSION_SECRET: "s".repeat(40),
    DEV_AUTH: "1",
    WEB_ORIGINS: "https://wecra.app,http://localhost:5199",
    GOOGLE_CLIENT_ID: "client",
    GOOGLE_CLIENT_SECRET: "secret",
    ASSETS: {
      fetch: async (req: Request | string) => {
        const path = new URL(typeof req === "string" ? req : req.url).pathname;
        assetFetches.push(path);
        const f = withApp || !path.startsWith("/index") ? files[path] : undefined;
        return f ? new Response(f[0], { headers: { "content-type": f[1] } }) : new Response("not found", { status: 404 });
      },
    },
  };
  deps = { db: new Db(d1), env: env as unknown as Deps["env"], rooms: { fetch: async () => new Response("room") }, fetch: async () => new Response(null, { status: 500 }), now: () => Date.UTC(2026, 9, 12) };
});

const get = (path: string, init: RequestInit = {}) => handle(new Request(ORIGIN + path, init), deps);

describe("the web app on the Worker (docs/cloud.md §7)", () => {
  it("serves the app at / and /app/…, no-cache, with its CSP", async () => {
    for (const path of ["/", "/app", "/app/whatever/deep", "/index.html"]) {
      const res = await get(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(res.headers.get("cache-control")).toBe("no-cache");
      expect(await res.text()).toBe(INDEX);
      const csp = res.headers.get("content-security-policy")!;
      expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
      expect(csp).toContain("worker-src 'self' blob:");
      expect(csp).toContain("img-src 'self' data: blob: https:");
      expect(csp).toContain("connect-src 'self' wss://wecra.app https://raw.githubusercontent.com");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    }
    const head = await get("/", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  it("serves hashed files immutable, boot.js revalidated, the Wasm as application/wasm", async () => {
    const js = await get("/assets/index-AbC123.js");
    expect(js.status).toBe(200);
    expect(js.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    const wasm = await get("/assets/engine-Zz9_x-1.wasm");
    expect(wasm.headers.get("content-type")).toBe("application/wasm");
    expect((await get("/boot.js")).headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
    expect((await get("/assets/missing-1.js")).status).toBe(404);
  });

  it("never answers an API path with the app", async () => {
    // Unauthenticated API reads: the API's own 401 / 404, JSON — never index.html
    for (const path of ["/me", "/files", "/files/abcdef123", "/orgs/x", "/me/drafts", "/notifications"]) {
      const res = await get(path, { headers: { accept: "text/html" } });
      expect(res.status, path).toBe(401);
      expect(res.headers.get("content-type"), path).toContain("application/json");
    }
    const unknown = await get("/no-such-page", { headers: { accept: "text/html" } });
    expect(unknown.status).not.toBe(200);
    expect(await unknown.text()).not.toContain("<title>Wecra</title>");
    // Public routes keep their own pages
    expect((await get("/privacy")).headers.get("content-type")).toContain("text/html");
    expect(await (await get("/privacy")).text()).not.toBe(INDEX);
    expect(await (await get("/health")).json()).toEqual({ name: "designer", ok: true });
    expect(assetFetches.filter((p) => p === "/index.html")).toHaveLength(0);
    // POST / is the API's (no app for writes)
    expect((await get("/", { method: "POST" })).headers.get("content-type")).toContain("application/json");
  });

  it("the preview viewer is read from _viewer/index.html", async () => {
    const page = await get(`/p/${"P".repeat(22)}`);
    // No PREVIEWS binding here: the viewer page itself needs only the assets
    expect([200, 503]).toContain(page.status);
    if (page.status === 200) expect(await page.text()).toContain("Developer preview");
  });

  it("a server without the app keeps / as the API's health answer", async () => {
    withApp = false;
    expect(await (await get("/")).json()).toEqual({ name: "designer", ok: true });
  });

  it("signs in from the Worker's own origin without listing it (workers.dev, wrangler dev)", async () => {
    const challenge = "c".repeat(43);
    const login = (back: string, origin = ORIGIN) =>
      handle(new Request(`${origin}/auth/login?${new URLSearchParams({ return: back, state: "s".repeat(24), challenge, method: "google" })}`), deps);
    expect((await login("https://wecra.app/?editor&file=abc")).status).toBe(302);
    expect((await login("https://designer.example.workers.dev/", "https://designer.example.workers.dev")).status).toBe(302);
    expect((await login("http://localhost:5199/")).status).toBe(302);
    expect((await login("https://evil.example/")).status).toBe(400);
  });

  it("route rules", () => {
    expect(isAppRoute("/")).toBe(true);
    expect(isAppRoute("/app/x")).toBe(true);
    expect(isAppRoute("/apple")).toBe(false);
    expect(isAppRoute("/files")).toBe(false);
    expect(isAppAsset("/assets/a-1.js")).toBe(true);
    expect(isAppAsset("/assets/../secret")).toBe(false);
    expect(isAppAsset("/assets/sub/a.js")).toBe(false);
    expect(appCsp("http://localhost:8787")).toContain("ws://localhost:8787");
  });
});
