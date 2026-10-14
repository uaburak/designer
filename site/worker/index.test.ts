import { describe, expect, it } from "vitest";
import worker, { contentType, isFileName, newestFile, parseRange, type Env, type Release } from "./index";

/** An in-memory R2 bucket: the head / get (with an offset+length range) the Worker uses */
class FakeBucket {
  readonly objects = new Map<string, Uint8Array>();
  calls: string[] = [];

  put(key: string, data: string | Uint8Array): void {
    this.objects.set(key, typeof data === "string" ? new TextEncoder().encode(data) : data);
  }

  private meta(key: string, bytes: Uint8Array) {
    return { key, size: bytes.byteLength, httpEtag: `"etag-${key}"`, etag: `etag-${key}`, uploaded: new Date(Date.UTC(2026, 9, 14)), httpMetadata: {} };
  }

  async head(key: string) {
    this.calls.push(`head ${key}`);
    const bytes = this.objects.get(key);
    return bytes ? this.meta(key, bytes) : null;
  }

  async get(key: string, options?: { range?: { offset: number; length: number } }) {
    this.calls.push(`get ${key}${options?.range ? ` ${options.range.offset}+${options.range.length}` : ""}`);
    const bytes = this.objects.get(key);
    if (!bytes) return null;
    const part = options?.range ? bytes.slice(options.range.offset, options.range.offset + options.range.length) : bytes;
    return {
      ...this.meta(key, bytes),
      body: new Response(part).body,
      json: async () => JSON.parse(new TextDecoder().decode(bytes)),
    };
  }
}

function setup() {
  const bucket = new FakeBucket();
  const assets: string[] = [];
  const env = {
    RELEASES: bucket as unknown as R2Bucket,
    ASSETS: { fetch: async (r: Request) => (assets.push(new URL(r.url).pathname), new Response("page")) } as unknown as Fetcher,
  } satisfies Env;
  const call = (path: string, init?: RequestInit) => worker.fetch(new Request(`https://get.wecra.app${path}`, init), env);
  return { bucket, assets, call };
}

const release = (version: string, windows: boolean): Release => ({
  version,
  date: "2026-10-20",
  notes: "## New\n- Things",
  files: {
    mac: { name: `Wecra-${version}.dmg`, size: 100 },
    ...(windows ? { windows: { name: `Wecra-Setup-${version}.exe`, size: 90 } } : {}),
  },
});

describe("parseRange", () => {
  it("resolves first-last, open-ended and suffix ranges", () => {
    expect(parseRange("bytes=0-9", 100)).toEqual({ start: 0, end: 9 });
    expect(parseRange("bytes=90-", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=90-500", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=-500", 100)).toEqual({ start: 0, end: 99 });
    expect(parseRange("bytes=99-99", 100)).toEqual({ start: 99, end: 99 });
  });

  it("is unsatisfiable past the end, for an empty suffix and on an empty file", () => {
    expect(parseRange("bytes=100-", 100)).toBe("unsatisfiable");
    expect(parseRange("bytes=100-200", 100)).toBe("unsatisfiable");
    expect(parseRange("bytes=-0", 100)).toBe("unsatisfiable");
    expect(parseRange("bytes=0-", 0)).toBe("unsatisfiable");
    expect(parseRange("bytes=-5", 0)).toBe("unsatisfiable");
  });

  it("ignores what it can't serve as one range: the whole file", () => {
    expect(parseRange(null, 100)).toBeNull();
    expect(parseRange("bytes=0-1, 5-6", 100)).toBeNull();
    expect(parseRange("items=0-1", 100)).toBeNull();
    expect(parseRange("bytes=-", 100)).toBeNull();
    expect(parseRange("bytes=9-3", 100)).toBeNull();
    expect(parseRange("bytes=a-b", 100)).toBeNull();
  });
});

describe("file names", () => {
  it("takes release files and rejects paths and odd keys", () => {
    for (const ok of ["latest-mac.yml", "latest.yml", "Wecra-1.2.0.dmg", "Wecra-1.2.0-arm64-mac.zip", "Wecra-Setup-1.2.0.exe.blockmap"]) expect(isFileName(ok)).toBe(true);
    for (const bad of ["", "..", "../releases.json", "a/b", ".hidden", "a..b", "%2e%2e", "a b", "a\\b", "x".repeat(201)]) expect(isFileName(bad)).toBe(false);
  });

  it("types by extension", () => {
    expect(contentType("latest-mac.yml")).toMatch(/^text\/yaml/);
    expect(contentType("Wecra-1.2.0.dmg")).toBe("application/x-apple-diskimage");
    expect(contentType("Wecra-1.2.0-arm64-mac.zip")).toBe("application/zip");
    expect(contentType("x.blockmap")).toBe("application/octet-stream");
  });
});

describe("/updates/<file>", () => {
  it("streams the whole file with its length, ETag and cache rule", async () => {
    const { bucket, call } = setup();
    bucket.put("updates/Wecra-1.2.0-arm64-mac.zip", "0123456789");
    const res = await call("/updates/Wecra-1.2.0-arm64-mac.zip");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("0123456789");
    expect(res.headers.get("Content-Length")).toBe("10");
    expect(res.headers.get("ETag")).toBe('"etag-updates/Wecra-1.2.0-arm64-mac.zip"');
    expect(res.headers.get("Accept-Ranges")).toBe("bytes");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(res.headers.get("Content-Type")).toBe("application/zip");
    expect(bucket.calls).toEqual(["get updates/Wecra-1.2.0-arm64-mac.zip"]);
  });

  it("sends the feeds no-cache and ignores electron-updater's noCache query", async () => {
    const { bucket, call } = setup();
    bucket.put("updates/latest-mac.yml", "version: 1.2.0\n");
    const res = await call("/updates/latest-mac.yml?noCache=1abc");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
    expect(await res.text()).toBe("version: 1.2.0\n");
  });

  it("answers a range with 206, its Content-Range and length", async () => {
    const { bucket, call } = setup();
    bucket.put("updates/a.zip", "0123456789");
    const res = await call("/updates/a.zip", { headers: { Range: "bytes=2-5" } });
    expect(res.status).toBe(206);
    expect(await res.text()).toBe("2345");
    expect(res.headers.get("Content-Range")).toBe("bytes 2-5/10");
    expect(res.headers.get("Content-Length")).toBe("4");
    expect(bucket.calls).toEqual(["head updates/a.zip", "get updates/a.zip 2+4"]);

    const tail = await call("/updates/a.zip", { headers: { Range: "bytes=-3" } });
    expect(tail.status).toBe(206);
    expect(await tail.text()).toBe("789");
    expect(tail.headers.get("Content-Range")).toBe("bytes 7-9/10");

    const open = await call("/updates/a.zip", { headers: { Range: "bytes=8-" } });
    expect(await open.text()).toBe("89");
    expect(open.headers.get("Content-Range")).toBe("bytes 8-9/10");
  });

  it("answers 416 past the end", async () => {
    const { bucket, call } = setup();
    bucket.put("updates/a.zip", "0123456789");
    const res = await call("/updates/a.zip", { headers: { Range: "bytes=10-20" } });
    expect(res.status).toBe(416);
    expect(res.headers.get("Content-Range")).toBe("bytes */10");
    expect(await res.text()).toBe("");
  });

  it("sends the whole file for several ranges", async () => {
    const { bucket, call } = setup();
    bucket.put("updates/a.zip", "0123456789");
    const res = await call("/updates/a.zip", { headers: { Range: "bytes=0-1, 4-5" } });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("0123456789");
  });

  it("answers HEAD with the headers and no body, ranges too", async () => {
    const { bucket, call } = setup();
    bucket.put("updates/Wecra-1.2.0.dmg", "0123456789");
    const res = await call("/updates/Wecra-1.2.0.dmg", { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Length")).toBe("10");
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="Wecra-1.2.0.dmg"');
    expect(await res.text()).toBe("");
    const ranged = await call("/updates/Wecra-1.2.0.dmg", { method: "HEAD", headers: { Range: "bytes=0-3" } });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get("Content-Length")).toBe("4");
    expect(bucket.calls.every((c) => c.startsWith("head "))).toBe(true);
  });

  it("is 404 for a missing file and never reads outside updates/", async () => {
    const { bucket, call } = setup();
    bucket.put("releases.json", "{}");
    expect((await call("/updates/missing.zip")).status).toBe(404);
    expect((await call("/updates/missing.zip", { headers: { Range: "bytes=0-1" } })).status).toBe(404);
    for (const p of ["/updates/", "/updates/%2e%2e%2freleases.json", "/updates/..%2freleases.json", "/updates/a/b.zip", "/updates/.env"]) {
      expect((await call(p)).status).toBe(404);
    }
    expect(bucket.calls.filter((c) => !c.includes("missing.zip"))).toEqual([]);
  });

  it("refuses other methods", async () => {
    const { call } = setup();
    expect((await call("/updates/a.zip", { method: "PUT", body: "x" })).status).toBe(405);
  });
});

describe("/download/<platform>", () => {
  it("redirects to the newest release's file", async () => {
    const { bucket, call } = setup();
    bucket.put("releases.json", JSON.stringify({ releases: [release("1.3.0", false), release("1.2.0", true), release("1.1.0", true)] }));
    const mac = await call("/download/mac");
    expect(mac.status).toBe(302);
    expect(mac.headers.get("Location")).toBe("https://get.wecra.app/updates/Wecra-1.3.0.dmg");
    const win = await call("/download/windows");
    expect(win.status).toBe(302);
    expect(win.headers.get("Location")).toBe("https://get.wecra.app/updates/Wecra-Setup-1.2.0.exe");
  });

  it("a bare /download is the site's Download page, not a file", async () => {
    const { call, assets } = setup();
    for (const path of ["/download", "/download/"]) expect(await (await call(path)).text()).toBe("page");
    expect(assets).toEqual(["/download", "/download/"]);
  });

  it("shows a 404 page when there is no release yet", async () => {
    const { call } = setup();
    const res = await call("/download/mac");
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toMatch(/^text\/html/);
    expect(await res.text()).toContain("No macOS download yet");
    const win = await call("/download/windows");
    expect(await win.text()).toContain("No Windows download yet");
    expect((await call("/download/linux")).status).toBe(404);
  });

  it("shows the 404 page for a Mac-only list or a broken releases.json", async () => {
    const { bucket, call } = setup();
    bucket.put("releases.json", JSON.stringify({ releases: [release("1.3.0", false)] }));
    expect((await call("/download/windows")).status).toBe(404);
    bucket.put("releases.json", "not json");
    expect((await call("/download/mac")).status).toBe(404);
  });

  it("skips a file name that isn't one", () => {
    const bad = { ...release("1.3.0", false), files: { mac: { name: "../x", size: 1 } } };
    expect(newestFile([bad, release("1.2.0", false)], "mac")?.name).toBe("Wecra-1.2.0.dmg");
  });
});

describe("/api/releases", () => {
  it("returns releases.json for a minute", async () => {
    const { bucket, call } = setup();
    const json = JSON.stringify({ releases: [release("1.2.0", true)] });
    bucket.put("releases.json", json);
    const res = await call("/api/releases");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=60");
    expect(res.headers.get("Content-Type")).toMatch(/^application\/json/);
    expect(await res.text()).toBe(json);
  });

  it("is an empty list on an empty bucket", async () => {
    const { call } = setup();
    expect(await (await call("/api/releases")).json()).toEqual({ releases: [] });
    expect((await call("/api/other")).status).toBe(404);
  });
});

describe("pages", () => {
  it("hands every other path to the assets", async () => {
    const { assets, call } = setup();
    expect(await (await call("/features")).text()).toBe("page");
    expect(assets).toEqual(["/features"]);
  });
});
