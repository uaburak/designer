// Round 6b in main without Electron (docs/ai.md §2.4–2.6): the local models' downloads (a local HTTP server standing in
// for Hugging Face: progress, the SHA-256 and size checks, the pinned revision, nothing served until checked), the
// aimodel: scheme's answers, and the image runs on fake HTTP (OpenAI Images, the Gemini API) and on a stub `agy`
// (a Node script that saves a picture in its conversation's folder as generate_image does).
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_AI_SETTINGS, type AiBalance, type AiImageRequest, type AiModelInfo, type AiModelState, type AiRunEvent, type AiSettings } from "../../../shared/ai/types";
import type { SpawnFn } from "../../agents/providers/turns";
import { AI_MODELS, ModelStore, safeJoin } from "../models";
import { agyImagePrompt } from "./antigravity";
import { openAiSize } from "./openai";
import { cleanImageRequest, imageRoute, runImage, type ImageRunDeps } from "./run";
import { imageInfo, jobPrompt } from "./types";

vi.mock("electron", () => ({ app: { getPath: () => tmpdir() }, net: {}, protocol: {}, webContents: { getAllWebContents: () => [] } }));
const { modelResponse } = await import("../protocol");

const work = mkdtempSync(join(tmpdir(), "ai-images-test-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

function crc32(b: Buffer): number {
  let c = 0xffffffff;
  for (const x of b) {
    c ^= x;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** A w × h RGBA PNG of one colour. */
function png(w: number, h: number, rgba = [255, 0, 0, 255]): Buffer {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(rgba, y * (w * 4 + 1) + 1 + x * 4);
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

function listen(handler: (req: IncomingMessage, res: ServerResponse, body: Buffer) => void): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => handler(req, res, Buffer.concat(chunks)));
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
  });
}

// ── Local models ──

describe("the local models' catalogue", () => {
  it("pins every model at a commit, with a size and a SHA-256 per file", () => {
    expect(AI_MODELS.map((m) => m.id)).toEqual(["isnet", "swin2sr-x4", "lama", "clip-vit-b32", "minilm-l6"]);
    for (const m of AI_MODELS) {
      expect(m.revision).toMatch(/^[0-9a-f]{40}$/);
      expect(m.bytes).toBe(m.files.reduce((s, f) => s + f.bytes, 0));
      for (const f of m.files) expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(m.files.some((f) => f.path.endsWith(".onnx"))).toBe(true);
    }
    // docs/ai.md §2.4's sizes
    expect(AI_MODELS.find((m) => m.id === "isnet")!.files.find((f) => f.path.endsWith(".onnx"))!.bytes).toBe(88_152_708);
  });

  it("pins models that run on onnxruntime-web's wasm (found running them for real, 2026-10-12)", () => {
    const onnx = (id: string) => AI_MODELS.find((m) => m.id === id)!.files.find((f) => f.path.endsWith(".onnx"))!;
    // BiRefNet lite needed > 4 GB at 1024² on wasm and a 64-input Concat on WebGPU: background removal is ISNet's.
    expect(AI_MODELS.some((m) => /birefnet/i.test(m.repo))).toBe(false);
    expect(AI_MODELS.find((m) => m.id === "isnet")!.repo).toBe("imgly/isnet-general-onnx");
    // Swin2SR's fp16 export fails its first wasm run ("Shape mismatch attempting to re-use buffer"); the fp32 one runs.
    expect(onnx("swin2sr-x4")).toEqual({ path: "onnx/model.onnx", bytes: 55_046_351, sha256: "2038700d530bb756a29552d7c8ddbd4a8f734df6cc43162ed543360a7aeb02f7" });
  });

  it("never joins a path outside the model's folder", () => {
    expect(safeJoin("/m/lama", "onnx/model.onnx")).toBe("/m/lama/onnx/model.onnx");
    for (const bad of ["../x", "a/../../x", "/etc/passwd", "", "a//b", "./a"]) expect(safeJoin("/m/lama", bad)).toBeNull();
  });
});

describe("downloading a model", () => {
  const good = Buffer.alloc(300_000, 7);
  const cfg = Buffer.from('{"a":1}');
  const info: AiModelInfo = { id: "lama", label: "Test", use: "Erase", license: "MIT", repo: "org/repo", revision: "a".repeat(40), files: [{ path: "config.json", bytes: cfg.length, sha256: sha(cfg) }, { path: "onnx/model.onnx", bytes: good.length, sha256: sha(good) }], bytes: cfg.length + good.length };
  let server: Server;
  let base = "";
  let served: Buffer = good;
  const asked: string[] = [];
  beforeAll(async () => {
    ({ server, url: base } = await listen((req, res) => {
      asked.push(req.url ?? "");
      if (req.url === `/org/repo/resolve/${"a".repeat(40)}/config.json`) return res.end(cfg);
      if (req.url === `/org/repo/resolve/${"a".repeat(40)}/onnx/model.onnx`) {
        res.writeHead(200, { "Content-Length": served.length });
        // In pieces, so progress shows.
        let at = 0;
        const next = () => {
          if (at >= served.length) return res.end();
          res.write(served.subarray(at, at + 65536));
          at += 65536;
          setTimeout(next, 2);
        };
        return next();
      }
      res.writeHead(404).end();
    }));
  });
  afterAll(() => server.close());

  it("downloads at the pinned revision with progress, checks every file and serves it only then", async () => {
    const dir = join(work, "models-ok");
    const states: AiModelState[] = [];
    const store = new ModelStore({ dir, baseUrl: base, models: [info], onState: (s) => states.push(s) });
    expect(store.state("lama")).toEqual({ id: "lama", state: "absent", bytes: info.bytes });
    expect(store.filePath("lama", "onnx/model.onnx")).toBeNull();
    const both = [store.download("lama"), store.download("lama")];
    const [a, b] = await Promise.all(both);
    expect(a).toEqual({ id: "lama", state: "ready", bytes: info.bytes });
    expect(b).toEqual(a);
    expect(asked.filter((u) => u.endsWith("model.onnx"))).toHaveLength(1);
    const progress = states.filter((s) => s.state === "downloading");
    expect(progress.length).toBeGreaterThan(2);
    expect(progress.map((s) => s.received!)).toEqual([...progress.map((s) => s.received!)].sort((x, y) => x - y));
    expect(states.at(-1)!.state).toBe("ready");
    const path = store.filePath("lama", "onnx/model.onnx")!;
    expect(readFileSync(path).equals(good)).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "lama", "manifest.json"), "utf8")).revision).toBe("a".repeat(40));
    expect(store.filePath("lama", "README.md")).toBeNull();
    expect(store.filePath("lama", "../models-ok/lama/manifest.json")).toBeNull();
    // A new pin (another revision) makes it absent again.
    expect(new ModelStore({ dir, baseUrl: base, models: [{ ...info, revision: "b".repeat(40) }] }).state("lama").state).toBe("absent");
    expect(store.remove("lama").state).toBe("absent");
    expect(existsSync(join(dir, "lama"))).toBe(false);
  });

  it("refuses a file whose checksum doesn't match (nothing kept, nothing served)", async () => {
    served = Buffer.alloc(good.length, 8);
    const dir = join(work, "models-bad");
    const store = new ModelStore({ dir, baseUrl: base, models: [info] });
    const s = await store.download("lama");
    expect(s.state).toBe("error");
    expect(s.error).toMatch(/checksum/);
    expect(existsSync(join(dir, "lama"))).toBe(false);
    expect(existsSync(join(dir, "lama.partial"))).toBe(false);
    expect(store.filePath("lama", "onnx/model.onnx")).toBeNull();
    served = Buffer.alloc(good.length - 5, 7);
    expect((await store.download("lama")).error).toMatch(/incomplete/);
    served = good;
    expect((await store.download("lama")).state).toBe("ready");
  });

  it("says when Hugging Face can't be reached", async () => {
    const store = new ModelStore({ dir: join(work, "models-off"), baseUrl: "http://127.0.0.1:9", models: [info] });
    const s = await store.download("lama");
    expect(s.state).toBe("error");
    expect(s.error).toMatch(/Couldn't reach Hugging Face/);
  });

  it("serves aimodel://<id>/<path> read-only, with CORS and CORP for the isolated editor", async () => {
    const dir = join(work, "models-serve");
    const store = new ModelStore({ dir, baseUrl: base, models: [info] });
    await store.download("lama");
    const ok = modelResponse("aimodel://lama/onnx/model.onnx", "GET", store);
    expect(ok.status).toBe(200);
    expect(ok.path).toBe(join(dir, "lama", "onnx", "model.onnx"));
    expect(ok.headers["Access-Control-Allow-Origin"]).toBe("*");
    expect(ok.headers["Cross-Origin-Resource-Policy"]).toBe("cross-origin");
    expect(ok.headers["Content-Length"]).toBe(String(good.length));
    expect(modelResponse("aimodel://lama/config.json", "HEAD", store)).toMatchObject({ status: 200, headers: { "Content-Type": "application/json" } });
    expect(modelResponse("aimodel://lama/config.json", "HEAD", store).path).toBeUndefined();
    expect(modelResponse("aimodel://lama/config.json", "POST", store).status).toBe(405);
    expect(modelResponse("aimodel://lama/manifest.json", "GET", store).status).toBe(404);
    expect(modelResponse("aimodel://lama/%2e%2e/x", "GET", store).status).toBe(404);
    expect(modelResponse("aimodel://other/config.json", "GET", store).status).toBe(404);
    expect(modelResponse("app://lama/config.json", "GET", store).status).toBe(404);
  });
});

// ── Image runs ──

const balance = (remaining: number): AiBalance => ({ month: "2026-10", used: 4250 - remaining, allowance: 4250, remaining, resetsAt: Date.UTC(2026, 10, 1), byAction: {} });

function deps(o: Partial<Omit<ImageRunDeps, "settings">> & { settings?: Partial<AiSettings> } = {}): ImageRunDeps {
  const settings = { ...DEFAULT_AI_SETTINGS, ...o.settings };
  return {
    balance: async () => balance(100),
    imageKey: () => "sk-test",
    agyPath: () => null,
    spawn: ((cmd, args, options) => spawn(cmd, args, options)) as SpawnFn,
    env: () => process.env,
    home: join(work, "home"),
    workDir: join(work, "runs"),
    ...o,
    settings: () => settings,
  };
}

async function run(req: AiImageRequest, d: ImageRunDeps, cancelAfter?: number): Promise<AiRunEvent[]> {
  const events: AiRunEvent[] = [];
  const abort = new AbortController();
  if (cancelAfter !== undefined) setTimeout(() => abort.abort(), cancelAfter);
  await runImage(req, d, (e) => events.push(e), abort.signal);
  return events;
}

const b64 = (b: Buffer) => b.toString("base64");

describe("image requests", () => {
  it("are checked as plain data", () => {
    expect(cleanImageRequest({ runId: "r1", action: "make-image", prompt: "a cat", size: { width: 512.4, height: 300 }, extra: 1 })).toEqual({ runId: "r1", action: "make-image", prompt: "a cat", size: { width: 512, height: 300 } });
    expect(() => cleanImageRequest({ runId: "r1", action: "remove-background", image: "AA" })).toThrow(/unknown action/);
    expect(() => cleanImageRequest({ runId: "r1", action: "edit-image", prompt: "x" })).toThrow(/needs the picture/);
    expect(() => cleanImageRequest({ runId: "r1", action: "make-image", prompt: " " })).toThrow(/needs a prompt/);
    expect(() => cleanImageRequest({ runId: "../x", action: "make-image", prompt: "x" })).toThrow(/runId/);
    expect(() => cleanImageRequest({ runId: "r", action: "edit-image", image: "!!notbase64" })).toThrow(/PNG/);
  });

  it("go to the asked route, the action's, Settings › AI's image route, else Antigravity", () => {
    const s = { ...DEFAULT_AI_SETTINGS };
    expect(imageRoute(s, { action: "expand-image" })).toEqual({ providerId: "antigravity" });
    expect(imageRoute({ ...s, image: { providerId: "gemini-images" } }, { action: "expand-image" })).toEqual({ providerId: "gemini-images" });
    expect(imageRoute({ ...s, image: { providerId: "gemini-images" }, actions: { "expand-image": { providerId: "openai-images" } } }, { action: "expand-image" })).toEqual({ providerId: "openai-images" });
    expect(imageRoute(s, { action: "make-image", route: { providerId: "openai-images", model: "gpt-image-1" } }).model).toBe("gpt-image-1");
  });

  it("word Expand and Erase themselves, and size OpenAI's canvas by aspect", () => {
    expect(jobPrompt("expand-image", undefined)).toMatch(/Fill the empty, transparent area/);
    expect(jobPrompt("expand-image", "a beach")).toMatch(/a beach$/);
    expect(jobPrompt("erase-object", "")).toMatch(/Remove what is inside the masked area/);
    expect(openAiSize({ width: 1600, height: 900 })).toBe("1536x1024");
    expect(openAiSize({ width: 900, height: 1600 })).toBe("1024x1536");
    expect(openAiSize({ width: 1000, height: 1100 })).toBe("1024x1024");
    expect(openAiSize()).toBe("auto");
    expect(imageInfo(png(3, 2))).toEqual({ mime: "image/png", width: 3, height: 2 });
    expect(agyImagePrompt({ action: "expand-image", prompt: "Fill it", image: png(1, 1), size: { width: 300, height: 200 } })).toMatch(/image\.png \(the picture to edit\)[\s\S]*300 × 200 px[\s\S]*answer with only its absolute path/);
  });

  it("stop when AI is off or the month's credits are used", async () => {
    const off = await run({ runId: "a", action: "make-image", prompt: "x" }, deps({ settings: { enabled: false } }));
    expect(off).toEqual([{ type: "error", code: "disabled", message: "AI is turned off in Settings › AI." }, { type: "done" }]);
    const over = await run({ runId: "b", action: "make-image", prompt: "x" }, deps({ balance: async () => balance(0) }));
    expect(over.find((e) => e.type === "error")).toMatchObject({ type: "error", code: "over-limit" });
    const noKey = await run({ runId: "c", action: "make-image", prompt: "x", route: { providerId: "gemini-images" } }, deps({ imageKey: () => null }));
    expect(noKey.find((e) => e.type === "error")).toMatchObject({ type: "error", code: "no-provider", message: "Add your Gemini API key in Settings › AI." });
    const noAgy = await run({ runId: "d", action: "make-image", prompt: "x" }, deps());
    expect(noAgy.find((e) => e.type === "error")).toMatchObject({ type: "error", code: "no-provider" });
  });
});

describe("OpenAI Images and the Gemini API (fake HTTP)", () => {
  let server: Server;
  let base = "";
  const seen: { url: string; headers: IncomingMessage["headers"]; body: Buffer }[] = [];
  beforeAll(async () => {
    ({ server, url: base } = await listen((req, res, body) => {
      seen.push({ url: req.url ?? "", headers: req.headers, body });
      const json = (code: number, v: unknown) => res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(v));
      if (req.url === "/v1/images/generations") return json(200, { data: [{ b64_json: b64(png(4, 2)) }] });
      if (req.url === "/v1/images/edits") return body.includes(Buffer.from("refuse me")) ? json(400, { error: { message: "Your request was rejected by the safety system." } }) : json(200, { data: [{ b64_json: b64(png(6, 4)) }] });
      if (req.url?.startsWith("/gem/models/")) {
        if (req.headers["x-goog-api-key"] !== "sk-test") return json(403, { error: { message: "API key not valid" } });
        const parsed = JSON.parse(body.toString()) as { contents: { parts: { text?: string }[] }[] };
        if (parsed.contents[0].parts[0].text?.includes("words only")) return json(200, { candidates: [{ content: { parts: [{ text: "I can't draw that." }] } }] });
        return json(200, { candidates: [{ content: { parts: [{ text: "Here" }, { inlineData: { mimeType: "image/png", data: b64(png(8, 8)) } }] } }] });
      }
      json(404, {});
    }));
  });
  afterAll(() => server.close());
  const d = (o: Partial<Omit<ImageRunDeps, "settings">> = {}) => deps({ openaiBaseUrl: `${base}/v1`, geminiBaseUrl: `${base}/gem`, ...o });

  it("makes an image with generations and answers the picture, its size and Figma-like credits", async () => {
    const ev = await run({ runId: "o1", action: "make-image", prompt: "a red square", size: { width: 1600, height: 900 }, route: { providerId: "openai-images", model: "gpt-image-1" } }, d());
    expect(ev.map((e) => e.type)).toEqual(["status", "image", "usage", "done"]);
    expect(ev[1]).toMatchObject({ type: "image", mime: "image/png", width: 4, height: 2 });
    // Who answered rides on the usage, so the ledger names it even for a run without a route (Expand; found 2026-10-12).
    expect(ev[2]).toEqual({ type: "usage", usage: { input: 0, output: 0, images: 1, credits: 2, providerId: "openai-images", model: "gpt-image-1" } });
    const req = seen.find((s) => s.url === "/v1/images/generations")!;
    expect(req.headers.authorization).toBe("Bearer sk-test");
    expect(JSON.parse(req.body.toString())).toEqual({ model: "gpt-image-1", prompt: "a red square", n: 1, size: "1536x1024" });
  });

  it("expands with edits: the padded picture as image[], the mask, the instruction", async () => {
    const ev = await run({ runId: "o2", action: "expand-image", image: b64(png(6, 4)), mask: b64(png(6, 4, [0, 0, 0, 0])), route: { providerId: "openai-images" } }, d());
    expect(ev[1]).toMatchObject({ type: "image", width: 6, height: 4 });
    const body = seen.find((s) => s.url === "/v1/images/edits")!.body.toString("latin1");
    expect(body).toContain('name="image[]"; filename="image.png"');
    expect(body).toContain('name="mask"; filename="mask.png"');
    expect(body).toContain("Fill the empty, transparent area");
    const refused = await run({ runId: "o3", action: "edit-image", image: b64(png(2, 2)), prompt: "refuse me", route: { providerId: "openai-images" } }, d());
    expect(refused.find((e) => e.type === "error")).toMatchObject({ type: "error", code: "refused" });
  });

  it("edits with Gemini: inlineData parts in, the first inlineData part out", async () => {
    const ev = await run({ runId: "g1", action: "edit-image", image: b64(png(2, 2)), reference: b64(png(1, 1)), prompt: "make it blue", route: { providerId: "gemini-images" } }, d());
    expect(ev[1]).toMatchObject({ type: "image", width: 8, height: 8 });
    expect(ev[2]).toMatchObject({ usage: { credits: 8 } });
    const req = seen.find((s) => s.url?.startsWith("/gem/models/gemini-2.5-flash-image:generateContent"))!;
    const parts = (JSON.parse(req.body.toString()) as { contents: { parts: Record<string, unknown>[] }[] }).contents[0].parts;
    expect(parts).toHaveLength(3);
    expect(parts[0].text).toMatch(/^make it blue[\s\S]*second picture is a reference/);
    const words = await run({ runId: "g2", action: "make-image", prompt: "words only", route: { providerId: "gemini-images" } }, d());
    expect(words.find((e) => e.type === "error")).toMatchObject({ type: "error", code: "bad-output", message: "Gemini sent no picture: I can't draw that." });
    const bad = await run({ runId: "g3", action: "make-image", prompt: "x", route: { providerId: "gemini-images" } }, d({ imageKey: () => "wrong" }));
    expect(bad.find((e) => e.type === "error")).toMatchObject({ type: "error", code: "signed-out" });
  });
});

describe("Antigravity's generate_image (a stub agy)", () => {
  const STUB = join(work, "stub-agy.cjs");
  const PNG_B64 = b64(png(5, 3));
  writeFileSync(
    STUB,
    `const fs = require("fs"), path = require("path");
const args = process.argv.slice(2);
const mode = process.env.STUB_MODE;
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const conv = "conv-" + process.pid;
fs.writeFileSync(path.join(process.cwd(), "args.json"), JSON.stringify(args));
fs.writeFileSync(process.env.STUB_LOG, JSON.stringify({ args, files: fs.readdirSync(process.cwd()) }));
out({ event: "init", conversation_id: conv, init: { model: "stub" } });
if (mode === "hang") { setTimeout(() => {}, 60000); return; }
if (mode === "quota") { out({ event: "result", result: { status: "ERROR", error: "RESOURCE_EXHAUSTED: quota exceeded" } }); process.exit(1); }
const dir = path.join(process.env.HOME_DIR, ".gemini", "antigravity-cli", "brain", conv);
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, "generated_1.png");
out({ event: "step_update", step_update: { conversation_id: conv, step_type: "tool", state: "ACTIVE", tool_info: { name: "generate_image" } } });
if (mode !== "none") fs.writeFileSync(file, Buffer.from("${PNG_B64}", "base64"));
out({ event: "step_update", step_update: { conversation_id: conv, step_type: "tool", state: "DONE", tool_info: { name: "generate_image", output: "Saved " + file } } });
out({ event: "result", result: { status: "SUCCESS", response: mode === "none" ? "Done." : file } });
`
  );
  const log = join(work, "agy-log.json");
  const agyDeps = (mode: string) =>
    deps({
      agyPath: () => "agy",
      spawn: ((_cmd, args, options) => spawn(process.execPath, [STUB, ...args], { ...options, env: { ...options.env, STUB_MODE: mode, STUB_LOG: log, HOME_DIR: join(work, "home") } })) as SpawnFn,
    });

  it("runs agy headless in its own project with the picture in its workspace, and reads the saved picture", async () => {
    const ev = await run({ runId: "a1", action: "expand-image", image: b64(png(4, 4)), prompt: "beach", size: { width: 8, height: 4 } }, agyDeps("ok"));
    expect(ev.map((e) => e.type)).toEqual(["status", "image", "usage", "done"]);
    expect(ev[1]).toMatchObject({ type: "image", mime: "image/png", width: 5, height: 3 });
    expect((ev[1] as { data: string }).data).toBe(PNG_B64);
    const seen = JSON.parse(readFileSync(log, "utf8")) as { args: string[]; files: string[] };
    expect(seen.files).toContain("image.png");
    expect(seen.args).toEqual(expect.arrayContaining(["--output-format", "stream-json", "--project", "designerv2-images", "--disable-slash-commands"]));
    expect(seen.args[1]).toMatch(/generate_image[\s\S]*Fill the empty, transparent area[\s\S]*beach/);
    const project = JSON.parse(readFileSync(join(work, "home", ".gemini", "config", "projects", "designerv2-images.json"), "utf8")) as { permissionGrants: { permissionGrants: { deny: string[] } } };
    expect(project.permissionGrants.permissionGrants.deny).toEqual(["mcp(*)", "command(*)", "unsandboxed(*)", "read_url(*)", "execute_url(*)"]);
  });

  it("reports a quota error, no picture, a timeout and a cancel", async () => {
    expect((await run({ runId: "a2", action: "make-image", prompt: "x" }, agyDeps("quota"))).find((e) => e.type === "error")).toMatchObject({ type: "error", code: "rate-limited" });
    expect((await run({ runId: "a3", action: "make-image", prompt: "x" }, agyDeps("none"))).find((e) => e.type === "error")).toMatchObject({ type: "error", code: "bad-output", message: "Antigravity didn't make a picture." });
    expect((await run({ runId: "a4", action: "make-image", prompt: "x" }, { ...agyDeps("hang"), timeoutMs: 400 })).find((e) => e.type === "error")).toMatchObject({ type: "error", code: "timeout" });
    expect((await run({ runId: "a5", action: "make-image", prompt: "x" }, agyDeps("hang"), 300)).filter((e) => e.type !== "status")).toEqual([{ type: "done", cancelled: true }]);
  });
});
