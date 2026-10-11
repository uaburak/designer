// Main's side of plugins (docs/plugins.md §3.2–§3.3, round 5e): manifests, the networkAccess rules and the UI's CSP,
// fetch with the allowlist (redirects included), clientStorage's 5 MB, development plugins' path checks, hot reload's
// debounce, the New plugin… templates, runs owned by their view, the plugin: scheme's answers and frame navigation.
import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { INVOKE_ROLES } from "../../shared/ipc";

vi.mock("electron", () => ({ protocol: { handle: () => undefined } }));
const { parseManifest, runsHere } = await import("../../shared/plugins/manifest");
const { domainsAllow, effectiveDomains, parseDomain, pluginUiCsp, cspSourcesOf: toCspSources } = await import("../../shared/plugins/network");
const { pluginFetch, refusedText } = await import("./fetch");
const { ClientStorage, QUOTA_TEXT, STORAGE_QUOTA_BYTES } = await import("./storage");
const { DevelopmentPlugins, insideFolder, watchedFiles } = await import("./manifests");
const { PluginWatcher } = await import("./watch");
const { TEMPLATE_IDS, templateFiles } = await import("./templates");
const { PluginRuns } = await import("./runs");
const { frameMayNavigate, pluginResponse } = await import("./protocol");

const base = { name: "Test", id: "123", api: "1.0.0", main: "code.js" };

describe("manifest", () => {
  it("keeps Figma's fields and drops the rest", () => {
    const r = parseManifest({ ...base, ui: "ui.html", editorType: ["figma", "dev"], documentAccess: "dynamic-page", networkAccess: { allowedDomains: ["https://api.example.com"], reasoning: "x" }, menu: [{ name: "A", command: "a" }, { separator: true }, { name: "More", menu: [{ name: "B", command: "b" }] }], extra: 1 }, { development: false });
    expect("manifest" in r && r.manifest).toMatchObject({ name: "Test", ui: "ui.html", editorType: ["figma", "dev"], menu: [{ name: "A", command: "a" }, { separator: true }, { name: "More", menu: [{ name: "B", command: "b" }] }] });
    expect("manifest" in r && "extra" in r.manifest).toBe(false);
  });

  it("refuses what isn't Figma's", () => {
    const errors = (j: unknown, development = false) => {
      const r = parseManifest(j, { development });
      return "errors" in r ? r.errors.join("\n") : "";
    };
    expect(errors({ ...base, name: "" })).toMatch(/name/);
    expect(errors({ ...base, main: "../code.js" })).toMatch(/main/);
    expect(errors({ ...base, main: "/etc/passwd" })).toMatch(/main/);
    expect(errors({ ...base, ui: { main: "../x.html" } })).toMatch(/ui/);
    expect(errors({ ...base, editorType: ["sketch"] })).toMatch(/editorType/);
    expect(errors({ ...base, networkAccess: { allowedDomains: [] } })).toMatch(/at least one/);
    expect(errors({ ...base, networkAccess: { allowedDomains: ["none", "example.com"] } })).toMatch(/only entry/);
    expect(errors({ ...base, networkAccess: { allowedDomains: ["example.com; script-src *"] } })).toMatch(/isn't a domain/);
    expect(errors({ ...base, containsWidget: true })).toBe("Widgets aren't supported in DesignerV2 yet");
    expect(errors({ ...base, capabilities: ["codegen"], editorType: ["dev"] })).toMatch(/codegenLanguages/);
    // A development manifest may leave out its id (main names it); a published one may not.
    const { id: _id, ...noId } = base;
    expect(errors(noId)).toMatch(/id/);
    expect(errors(noId, true)).toBe("");
  });

  it("warns when * or localhost come without a reasoning", () => {
    const r = parseManifest({ ...base, networkAccess: { allowedDomains: ["http://localhost:3000"] } }, { development: true });
    expect("warnings" in r && r.warnings).toHaveLength(1);
  });

  it("runs in Design or Dev Mode only", () => {
    expect(runsHere({ ...base, editorType: ["figjam"] })).toBe(false);
    expect(runsHere({ ...base, editorType: ["figjam", "dev"] })).toBe(true);
  });
});

describe("networkAccess", () => {
  it("reads Figma's entry forms", () => {
    expect(parseDomain("example.com")).toEqual({ schemes: ["https", "wss"], host: "example.com", port: null, path: null });
    expect(parseDomain("http://localhost:3000")).toEqual({ schemes: ["http"], host: "localhost", port: 3000, path: null });
    expect(parseDomain("*.google.com")?.host).toBe("*.google.com");
    expect(parseDomain("https://my-app.com/api/")?.path).toBe("/api/");
    expect(parseDomain("ftp://example.com")).toBeNull();
    expect(parseDomain("exa mple.com")).toBeNull();
    expect(parseDomain("https://*")).toBeNull();
  });

  it("allows by host, subdomain, scheme, port and path", () => {
    expect(domainsAllow(["example.com"], "https://example.com/x")).toBe(true);
    expect(domainsAllow(["example.com"], "http://example.com/x")).toBe(false);
    expect(domainsAllow(["example.com"], "https://api.example.com/")).toBe(false);
    expect(domainsAllow(["*.example.com"], "https://api.example.com/")).toBe(true);
    expect(domainsAllow(["*.example.com"], "https://example.com/")).toBe(false);
    expect(domainsAllow(["*.example.com"], "https://evilexample.com/")).toBe(false);
    expect(domainsAllow(["http://localhost:3000"], "http://localhost:3000/a")).toBe(true);
    expect(domainsAllow(["http://localhost:3000"], "http://localhost:3001/a")).toBe(false);
    expect(domainsAllow(["https://my-app.com/api/"], "https://my-app.com/api/v1/x")).toBe(true);
    expect(domainsAllow(["https://my-app.com/api/"], "https://my-app.com/other")).toBe(false);
    expect(domainsAllow(["example.com/api/exact_path"], "https://example.com/api/exact_path?q=1")).toBe(true);
    expect(domainsAllow(["example.com/api/exact_path"], "https://example.com/api/exact_path/more")).toBe(false);
    expect(domainsAllow(["*"], "https://anything.dev/")).toBe(true);
    expect(domainsAllow(["*"], "http://anything.dev/")).toBe(false);
    expect(domainsAllow(["none"], "https://example.com/")).toBe(false);
    expect(domainsAllow(["example.com"], "https://user:pw@example.com/")).toBe(false);
  });

  it("adds devAllowedDomains for development plugins only", () => {
    expect(effectiveDomains(["none"], ["http://localhost:3000"], true)).toEqual(["http://localhost:3000"]);
    expect(effectiveDomains(["none"], ["http://localhost:3000"], false)).toEqual([]);
  });

  it("writes the UI's CSP per manifest", () => {
    expect(toCspSources(["none"])).toEqual([]);
    expect(toCspSources(["*"])).toEqual(["https:", "wss:"]);
    expect(toCspSources(["example.com", "http://localhost:3000", "https://a.com/api/"])).toEqual(["https://example.com", "wss://example.com", "http://localhost:3000", "https://a.com/api/"]);
    // A source that would add a directive is never written.
    expect(toCspSources(["example.com; frame-ancestors *", "'unsafe-hashes'"])).toEqual([]);
    const none = pluginUiCsp([]);
    expect(none).toContain("default-src 'none'");
    expect(none).toContain("connect-src 'none'");
    expect(none).toContain("script-src 'unsafe-inline' 'unsafe-eval' blob: data:");
    expect(none).toContain("form-action 'none'; base-uri 'none'");
    expect(pluginUiCsp(["api.example.com"])).toContain("connect-src https://api.example.com wss://api.example.com;");
    expect(pluginUiCsp(["api.example.com"])).toContain("style-src 'unsafe-inline' https://fonts.googleapis.com https://api.example.com");
  });
});

describe("fetch", () => {
  let server: Server;
  let origin = "";
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/ok") return void res.end(JSON.stringify({ method: req.method, cookie: req.headers.cookie ?? null }));
      if (req.url === "/hop") return void res.writeHead(302, { Location: "/ok" }).end();
      if (req.url === "/away") return void res.writeHead(302, { Location: "http://127.0.0.2:9/elsewhere" }).end();
      if (req.url === "/big") return void res.end(Buffer.alloc(2048));
      if (req.url === "/post-303") return void res.writeHead(303, { Location: "/ok" }).end();
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const a = server.address();
    origin = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("fetches what the manifest allows, without cookies", async () => {
    const r = await pluginFetch([origin], `${origin}/ok`, { headers: { Cookie: "a=b", "X-Test": "1" } }, fetch);
    expect(r.status).toBe(200);
    expect(JSON.parse(new TextDecoder().decode(r.body))).toEqual({ method: "GET", cookie: null });
  });

  it("refuses outside allowedDomains, with Figma's text", async () => {
    await expect(pluginFetch(["example.com"], `${origin}/ok`, undefined, fetch)).rejects.toThrow(refusedText(`${origin}/ok`));
    await expect(pluginFetch([], "file:///etc/passwd", undefined, fetch)).rejects.toThrow(/Refused/);
  });

  it("checks every redirect", async () => {
    const r = await pluginFetch([origin], `${origin}/hop`, undefined, fetch);
    expect(r.status).toBe(200);
    await expect(pluginFetch([origin], `${origin}/away`, undefined, fetch)).rejects.toThrow(refusedText("http://127.0.0.2:9/elsewhere"));
  });

  it("turns a POST into a GET after a 303", async () => {
    const r = await pluginFetch([origin], `${origin}/post-303`, { method: "POST", body: "x" }, fetch);
    expect(JSON.parse(new TextDecoder().decode(r.body)).method).toBe("GET");
  });

  it("caps the body", async () => {
    await expect(pluginFetch([origin], `${origin}/big`, undefined, fetch, { maxBytes: 1024 })).rejects.toThrow(/larger than/);
  });
});

describe("clientStorage", () => {
  let dir = "";
  beforeAll(async () => void (dir = await mkdtemp(join(tmpdir(), "plugin-storage-"))));
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it("keeps values and bytes, per plugin", async () => {
    const s = new ClientStorage(dir);
    await s.call({ op: "set", pluginId: "dev:abc", key: "k", value: { a: [1, "two", null], bytes: new Uint8Array([1, 2, 3]) } });
    const again = new ClientStorage(dir);
    expect(await again.call({ op: "get", pluginId: "dev:abc", key: "k" })).toEqual({ a: [1, "two", null], bytes: new Uint8Array([1, 2, 3]) });
    expect(await again.call({ op: "keys", pluginId: "dev:abc" })).toEqual(["k"]);
    expect(await again.call({ op: "get", pluginId: "other", key: "k" })).toBeUndefined();
    await again.call({ op: "delete", pluginId: "dev:abc", key: "k" });
    expect(await again.call({ op: "keys", pluginId: "dev:abc" })).toEqual([]);
  });

  it("refuses past 5 MB, counting the key and the value's JSON, bytes by length", async () => {
    expect(STORAGE_QUOTA_BYTES).toBe(5 * 1024 * 1024);
    const s = new ClientStorage(dir, 1000);
    // "k1" (2) + 990 bytes = 992
    await s.call({ op: "set", pluginId: "q", key: "k1", value: new Uint8Array(990) });
    expect(await s.used("q")).toBe(992);
    // "k2" (2) + '"abcdef"' (8) = 10 → 1002 > 1000
    await expect(s.call({ op: "set", pluginId: "q", key: "k2", value: "abcdef" })).rejects.toThrow(QUOTA_TEXT);
    // Replacing a key counts the new value only.
    await s.call({ op: "set", pluginId: "q", key: "k1", value: new Uint8Array(900) });
    await s.call({ op: "set", pluginId: "q", key: "k2", value: "abcdef" });
    expect(await s.used("q")).toBe(902 + 10);
  });

  it("refuses what it can't keep", async () => {
    const s = new ClientStorage(dir);
    await expect(s.call({ op: "set", pluginId: "x", key: "k", value: undefined })).rejects.toThrow(/undefined/);
    await expect(s.call({ op: "set", pluginId: "x", key: 1 as unknown as string, value: 1 })).rejects.toThrow(/key/);
  });
});

describe("development plugins", () => {
  let root = "";
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "plugin-dev-"));
    await mkdir(join(root, "p"));
    await writeFile(join(root, "secret.txt"), "secret");
    await writeFile(join(root, "p", "code.js"), "figma.closePlugin()");
    await writeFile(join(root, "p", "ui.html"), "<p>hi</p>");
    await symlink(join(root, "secret.txt"), join(root, "p", "escape.js"));
  });
  afterAll(() => rm(root, { recursive: true, force: true }));

  it("imports, reads, lists and removes", async () => {
    await writeFile(join(root, "p", "manifest.json"), JSON.stringify({ name: "P", api: "1.0.0", main: "code.js", ui: "ui.html", build: "rm -rf ~" }));
    const list = new DevelopmentPlugins(join(root, "userData"));
    const { plugin, manifest } = await list.add(join(root, "p", "manifest.json"), 1);
    expect(plugin.id).toMatch(/^dev:[0-9a-f]{40}$/);
    expect(manifest.build).toBe("rm -rf ~");
    const bundle = await list.read(plugin.id);
    expect(bundle).toMatchObject({ code: "figma.closePlugin()", ui: { "": "<p>hi</p>" } });
    expect(JSON.parse(await readFile(join(root, "userData", "development.json"), "utf8"))).toEqual([{ path: join(root, "p", "manifest.json"), id: plugin.id, name: "P", addedAt: 1 }]);
    // Imported again: one entry, its first date.
    await list.add(join(root, "p", "manifest.json"), 2);
    expect(await new DevelopmentPlugins(join(root, "userData")).list()).toHaveLength(1);
    expect(watchedFiles(manifest)).toEqual(["manifest.json", "code.js", "ui.html"]);
    expect(await list.remove(plugin.id)).toEqual([]);
  });

  it("reads only inside the plugin's folder, after symlinks", async () => {
    await expect(insideFolder(join(root, "p"), "escape.js")).rejects.toThrow(/isn't inside/);
    await expect(insideFolder(join(root, "p"), "../secret.txt")).rejects.toThrow(/isn't inside/);
    await writeFile(join(root, "p", "manifest.json"), JSON.stringify({ name: "P", api: "1.0.0", main: "escape.js" }));
    await expect(new DevelopmentPlugins(join(root, "userData2")).add(join(root, "p", "manifest.json"))).rejects.toThrow(/isn't inside/);
  });
});

describe("hot reload", () => {
  it("tells once after 300 ms of quiet, for the plugin's own files", () => {
    vi.useFakeTimers();
    const events: string[] = [];
    let fire: (f: string | null) => void = () => undefined;
    const w = new PluginWatcher((id) => events.push(id), (_dir, cb) => ((fire = cb), { close() {} }));
    w.watch("p1", "/x/manifest.json", ["code.js", "ui.html"]);
    fire("code.js");
    vi.advanceTimersByTime(200);
    fire("ui.html");
    vi.advanceTimersByTime(299);
    expect(events).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(events).toEqual(["p1"]);
    fire("node_modules/x.js");
    vi.advanceTimersByTime(1000);
    expect(events).toEqual(["p1"]);
    w.sync([]);
    expect(w.ids).toEqual([]);
    vi.useRealTimers();
  });
});

describe("New plugin… templates", () => {
  it("each one's manifest is valid", () => {
    for (const t of TEMPLATE_IDS) {
      const files = templateFiles(t, "My plugin");
      const r = parseManifest(JSON.parse(files["manifest.json"]), { development: true });
      expect("manifest" in r, t).toBe(true);
      if ("manifest" in r) {
        expect(r.manifest.id).toMatch(/^\d{19}$/);
        expect(!!r.manifest.ui, t).toBe(!!files["ui.html"]);
      }
    }
  });
});

describe("runs and the plugin: scheme", () => {
  it("are owned by the view that registered them", () => {
    const runs = new PluginRuns();
    runs.begin(1, { runId: "run-1", allowedDomains: ["example.com"], dev: false });
    expect(() => runs.begin(2, { runId: "run-1", allowedDomains: ["*"], dev: false })).toThrow(/another view/);
    expect(() => runs.ownedBy(2, "run-1")).toThrow(/isn't registered/);
    expect(() => runs.begin(1, { runId: "Run_1", allowedDomains: [], dev: false })).toThrow(/lower-case/);
    expect(runs.ownedBy(1, "run-1").domains).toEqual(["example.com"]);
    runs.endAll(1);
    expect(runs.get("run-1")).toBeUndefined();
  });

  it("serves a run's ui.html with its CSP, COEP credentialless and CORP cross-origin", () => {
    const runs = new PluginRuns();
    expect(runs.openUi(7, { runId: "abc", html: "<p>ui</p>", allowedDomains: ["none"], devAllowedDomains: ["http://localhost:3000"], dev: true })).toEqual({ url: "plugin://abc/ui.html" });
    const r = pluginResponse("plugin://abc/ui.html", "GET", runs);
    expect(r.status).toBe(200);
    expect(r.body).toBe("<p>ui</p>");
    expect(r.headers["Cross-Origin-Embedder-Policy"]).toBe("credentialless");
    expect(r.headers["Cross-Origin-Resource-Policy"]).toBe("cross-origin");
    expect(r.headers["Content-Security-Policy"]).toContain("connect-src http://localhost:3000;");
    expect(pluginResponse("plugin://abc/other.html", "GET", runs).status).toBe(404);
    expect(pluginResponse("plugin://abc/ui.html", "POST", runs).status).toBe(405);
    expect(pluginResponse("plugin://nope/ui.html", "GET", runs).status).toBe(404);
    runs.closeUi(7, "abc");
    expect(pluginResponse("plugin://abc/ui.html", "GET", runs).status).toBe(404);
  });

  it("lets frames go to their run's UI and allowed https origins only", () => {
    const runs = new PluginRuns();
    runs.openUi(1, { runId: "r1", html: "x", allowedDomains: ["*.example.com"], dev: false });
    const mine = runs.of(1);
    expect(frameMayNavigate("plugin://r1/ui.html", mine)).toBe(true);
    expect(frameMayNavigate("plugin://r2/ui.html", mine)).toBe(false);
    expect(frameMayNavigate("https://app.example.com/login", mine)).toBe(true);
    expect(frameMayNavigate("https://evil.com/", mine)).toBe(false);
    expect(frameMayNavigate("http://app.example.com/", mine)).toBe(false);
    expect(frameMayNavigate("app://designer/index.html", mine)).toBe(false);
    expect(frameMayNavigate("file:///etc/passwd", mine)).toBe(false);
    expect(frameMayNavigate("about:blank", mine)).toBe(true);
  });

  it("the channels are the editor's", () => {
    for (const c of ["plugins:begin-run", "plugins:end-run", "plugins:new-plugin", "plugins:open-ui", "plugins:fetch", "plugins:storage", "devmode:link-title"] as const) expect(INVOKE_ROLES[c]).toEqual(["editor"]);
  });
});
