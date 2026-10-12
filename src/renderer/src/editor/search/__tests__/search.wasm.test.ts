// @vitest-environment happy-dom
// Visual search in the editor (docs/ai.md §6) on the real engine (the committed Wasm, headless) with a fake embedder
// and the store's real search service on a memory host: what is indexed (top-level frames, components, not groups or
// shapes), incremental passes (versions, only touched targets re-embedded), removed nodes, the switches (indexing off,
// no models), the pass limit, and the query flow (text → CLIP text + MiniLM, image → CLIP, names only without models).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { Engine } from "@/engine/Engine";
import { EngineStore } from "@/engine/EngineStore";
import { loadEngine } from "@/engine/loadEngine";
import type { NodeChange } from "@/engine/codec";
import { SAMPLE_DOCUMENT } from "@/engine/sampleDocument";
import type { FileMeta } from "../../../../../shared/store/types";
import { SearchService } from "../../../../../store/search/service";
import { EditorController } from "../../controller";
import { memoryDocumentSource } from "../../documentSource";
import { WorkerEmbedder, type EmbedReply, type EmbedRequest, type Embedder, type RgbaImage } from "../embedder";
import { NODES_PER_PASS, SearchIndexer, squareOnWhite, type IndexerDeps } from "../indexer";
import { combine, downloadSearchModels, searchModels, type ModelsApi } from "../models";
import { NoModelsError, runSearch, splitHits } from "../query";
import { contentHash, editorSearchSource, joinText, type SearchSource } from "../source";

const wasm = join(process.cwd(), "src/renderer/src/engine/wasm/engine.wasm");

beforeAll(async () => {
  globalThis.fetch = async () => new Response(null, { status: 404 });
  const bytes = readFileSync(wasm);
  await loadEngine({ wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), printErr: () => {} });
});

async function editor() {
  const source = memoryDocumentSource(SAMPLE_DOCUMENT, { fileName: "Screens" });
  const engine = await Engine.create(null, { sessionID: 1 });
  engine.load(await source.load());
  engine.setViewport(1280, 800, 1, 1280, 800);
  const ed = new EditorController(engine, new EngineStore(engine), source);
  return { ed, engine };
}

/** A fake embedder: an image's vector is its mean colour (spread over 512 slots), a text's its letters' counts. */
class FakeEmbedder implements Embedder {
  calls = { image: 0, clipText: 0, text: 0 };
  async image(img: RgbaImage) {
    this.calls.image++;
    const v = new Float32Array(512);
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < img.width * img.height; i++) {
      const [pr, pg, pb] = [img.pixels[i * 4], img.pixels[i * 4 + 1], img.pixels[i * 4 + 2]];
      if (pr === 255 && pg === 255 && pb === 255) continue; // the white padding
      r += pr;
      g += pg;
      b += pb;
      n++;
    }
    n = Math.max(1, n);
    v[0] = r / n / 255 - 0.5;
    v[1] = g / n / 255 - 0.5;
    v[2] = b / n / 255 - 0.5;
    v[3] = 0.05;
    return v;
  }
  async clipText(text: string) {
    this.calls.clipText++;
    const v = new Float32Array(512);
    // "dark" points at a dark picture, anything else at a light one
    if (/dark/i.test(text)) v.set([-0.33, -0.33, -0.33, 0.05]);
    else v.set([0.5, 0.5, 0.5, 0.05]);
    return v;
  }
  async text(text: string) {
    this.calls.text++;
    const v = new Float32Array(384);
    for (const c of text.toLowerCase()) if (c >= "a" && c <= "z") v[c.charCodeAt(0) - 97] += 1;
    v[383] = 0.01;
    return v;
  }
  dispose() {}
}

function store(files: string[]) {
  const disk = new Map<string, Uint8Array>();
  const service = new SearchService({
    read: async (n) => disk.get(n) ?? null,
    write: async (n, b) => void disk.set(n, b),
    remove: async (n) => void disk.delete(n),
    list: async () => [...disk.keys()],
    getMeta: (k) => (files.includes(k) ? ({ fileKey: k, name: "Screens", trashedAt: null } as FileMeta) : null),
    log: () => undefined,
  });
  return { repo: service.repository(), disk };
}

const noTimers = { setTimeout: () => 0, clearTimeout: () => undefined };

function indexer(source: SearchSource, repo: IndexerDeps["repo"], embedder: Embedder | null, over: Partial<IndexerDeps> = {}) {
  return new SearchIndexer({
    source,
    repo,
    embedder: async () => embedder,
    enabled: async () => true,
    encodePng: async (img) => new Uint8Array([img.width & 255, img.height & 255]),
    now: () => 1000,
    timers: noTimers,
    ...over,
  });
}

describe("the editor's search source", () => {
  it("lists top-level frames and components, not groups or shapes, with text and a 224 px picture", async () => {
    const { ed } = await editor();
    const source = editorSearchSource(ed, "f1");
    expect(source.targets().map((t) => [t.nodeId, t.kind, t.name])).toEqual([
      ["1:1", "frame", "Desktop"],
      ["1:10", "frame", "Mobile"],
    ]);
    expect(source.text("1:1")).toBe("Desktop");
    const px = source.pixels("1:1", 224) as RgbaImage;
    expect([px.width, px.height]).toEqual([224, 147]);
    const tall = source.pixels("1:10", 224) as RgbaImage;
    expect(tall.height).toBe(224);
    expect(source.version("1:1")).toBe(source.version("1:1"));
    expect(source.version("1:1")).not.toBe(source.version("1:10"));
    expect(source.chain("1:5")).toEqual(["1:5", "1:1", "0:1", "0:0"]);
    expect(source.chain("9:9")).toEqual([]);
  });

  it("hashes and joins text", () => {
    expect(contentHash("a")).toMatch(/^[0-9a-f]{16}$/);
    expect(contentHash("a")).not.toBe(contentHash("b"));
    expect(joinText(["  Sign  in ", undefined, "", "Email"])).toBe("Sign in Email");
    expect(joinText(["x".repeat(3000)]).length).toBe(2000);
  });

  it("pads pictures to a white square for CLIP", () => {
    const img = { width: 2, height: 1, pixels: new Uint8Array([0, 0, 0, 255, 0, 0, 0, 0]) };
    const sq = squareOnWhite(img);
    expect([sq.width, sq.height]).toEqual([2, 2]);
    expect([...sq.pixels.slice(0, 8)]).toEqual([0, 0, 0, 255, 255, 255, 255, 255]);
  });
});

describe("the indexer", () => {
  it("indexes, then re-embeds only what a change touched, and removes what is gone", async () => {
    const { ed, engine } = await editor();
    const { repo } = store(["f1"]);
    const fake = new FakeEmbedder();
    const ix = indexer(editorSearchSource(ed, "f1"), repo, fake);
    const off = engine.on("NODES_CHANGED", (e) => ix.touch(e.refs));

    expect(await ix.runNow()).toMatchObject({ indexed: 2, removed: 0, left: 0 });
    const v1 = await repo.versions("f1");
    expect(Object.keys(v1).sort()).toEqual(["1:1", "1:10"]);
    expect(fake.calls.image).toBe(2);
    expect((await repo.thumb("f1", "1:1"))!.length).toBe(2);

    // Nothing changed: nothing embedded again
    expect(await ix.runNow()).toMatchObject({ indexed: 0, left: 0 });
    expect(fake.calls.image).toBe(2);

    // A shape inside Mobile changes: only Mobile is embedded again, with a new version
    ed.setProps(["1:12"], { name: "Primary button" } as never, "Rename");
    expect(await ix.runNow()).toMatchObject({ indexed: 1 });
    expect(fake.calls.image).toBe(3);
    const v2 = await repo.versions("f1");
    expect(v2["1:1"]).toBe(v1["1:1"]);
    expect(v2["1:10"]).not.toBe(v1["1:10"]);

    // A new indexer (the file opened again) checks every version once, embeds nothing
    const again = indexer(editorSearchSource(ed, "f1"), repo, fake);
    expect(await again.runNow()).toMatchObject({ indexed: 0 });
    expect(fake.calls.image).toBe(3);

    // Desktop deleted: it leaves the index
    engine.applyChanges({ type: "NODE_CHANGES", sessionID: 1, nodeChanges: [{ guid: "1:1", phase: "REMOVED" } as NodeChange] });
    expect(await ix.runNow()).toMatchObject({ removed: 1 });
    expect(Object.keys(await repo.versions("f1"))).toEqual(["1:10"]);
    off();
  });

  it("does nothing while indexing is off or the models aren't here", async () => {
    const { ed } = await editor();
    const { repo, disk } = store(["f1"]);
    expect(await indexer(editorSearchSource(ed, "f1"), repo, new FakeEmbedder(), { enabled: async () => false }).runNow()).toMatchObject({ skipped: "disabled" });
    expect(await indexer(editorSearchSource(ed, "f1"), repo, null).runNow()).toMatchObject({ skipped: "no-models" });
    expect(disk.size).toBe(0);
  });

  it("embeds at most 20 nodes a pass and schedules the rest", async () => {
    const targets = Array.from({ length: 45 }, (_, i) => ({ nodeId: `1:${i}`, kind: "frame" as const, name: `Frame ${i}`, pageId: "0:1", pageName: "Page 1", width: 10, height: 10 }));
    const source: SearchSource = {
      fileKey: "f1",
      fileName: () => "Screens",
      targets: () => targets,
      version: (id) => `v-${id}`,
      text: (id) => `Frame ${id}`,
      pixels: () => ({ width: 1, height: 1, pixels: new Uint8Array([10, 20, 30, 255]) }),
      chain: (id) => [id],
    };
    const { repo } = store(["f1"]);
    const scheduled: number[] = [];
    const ix = indexer(source, repo, new FakeEmbedder(), { timers: { setTimeout: (_fn, ms) => scheduled.push(ms), clearTimeout: () => undefined } });
    expect(await ix.runNow()).toMatchObject({ indexed: NODES_PER_PASS, left: 25 });
    expect(scheduled).toEqual([2000]);
    expect(await ix.runNow()).toMatchObject({ indexed: 20, left: 5 });
    expect(await ix.runNow()).toMatchObject({ indexed: 5, left: 0 });
    expect(Object.keys(await repo.versions("f1")).length).toBe(45);
  });

  it("waits for fonts and images, then draws what there is", async () => {
    const asked: boolean[] = [];
    const source: SearchSource = {
      fileKey: "f1",
      fileName: () => "Screens",
      targets: () => [{ nodeId: "1:1", kind: "frame", name: "A", pageId: "0:1", pageName: "Page 1", width: 1, height: 1 }],
      version: () => "v",
      text: () => "A",
      pixels: (_id, _s, allow) => (asked.push(!!allow), allow ? { width: 1, height: 1, pixels: new Uint8Array(4) } : "busy"),
      chain: (id) => [id],
    };
    const { repo } = store(["f1"]);
    const ix = indexer(source, repo, new FakeEmbedder());
    expect(await ix.runNow()).toMatchObject({ indexed: 0, skipped: "busy" });
    expect(await ix.runNow()).toMatchObject({ indexed: 0, skipped: "busy" });
    expect(await ix.runNow()).toMatchObject({ indexed: 1 });
    expect(asked).toEqual([false, false, true]);
  });
});

describe("the query", () => {
  /** Headless exports draw no pixels (no GPU in Node): Desktop is drawn light and Mobile dark, as in the sample. */
  const solid = (v: number): RgbaImage => ({ width: 4, height: 4, pixels: new Uint8Array(64).map((_, i) => (i % 4 === 3 ? 255 : v)) });
  const drawn = (id: string) => solid(id === "1:10" ? 0x2c : 0xf2);

  async function indexed() {
    const { ed } = await editor();
    const { repo } = store(["f1"]);
    const fake = new FakeEmbedder();
    const source = { ...editorSearchSource(ed, "f1"), pixels: drawn };
    await indexer(source, repo, fake).runNow();
    return { ed, repo, fake };
  }

  it("text: CLIP's text and MiniLM's vectors, exact names first", async () => {
    const { repo, fake } = await indexed();
    const dark = await runSearch(repo, { text: "dark screen" }, fake);
    expect(dark.semantic).toBe(true);
    expect(dark.hits[0].doc.name).toBe("Mobile"); // the dark frame
    expect(fake.calls.clipText).toBe(1);
    expect(fake.calls.text).toBeGreaterThan(2);
    const named = await runSearch(repo, { text: "mobile" }, fake); // its vectors point at the light Desktop
    expect(named.hits.map((h) => [h.doc.name, h.exact])).toEqual([["Mobile", true], ["Desktop", false]]);
  });

  it("an image or a selection: CLIP's image vector only", async () => {
    const { repo, fake } = await indexed();
    const out = await runSearch(repo, { image: drawn("1:10") }, fake);
    expect(out.hits[0].doc.nodeId).toBe("1:10");
    expect(out.hits[0].score).toBeCloseTo(1, 2);
    expect(splitHits(out.hits).designs.length).toBe(out.hits.length);
  });

  it("without the models: names only for text, and an image needs them", async () => {
    const { repo } = await indexed();
    const out = await runSearch(repo, { text: "mobile" }, null);
    expect(out).toMatchObject({ semantic: false });
    expect(out.hits.map((h) => h.doc.name)).toEqual(["Mobile"]);
    await expect(runSearch(repo, { image: { width: 1, height: 1, pixels: new Uint8Array(4) } }, null)).rejects.toBeInstanceOf(NoModelsError);
    expect((await runSearch(repo, { text: "  " }, null)).hits).toEqual([]);
  });
});

describe("the models", () => {
  const info = [
    { id: "clip-vit-b32", label: "CLIP", use: "Visual search", license: "MIT", repo: "", revision: "", files: [], bytes: 153_600_000 },
    { id: "minilm-l6", label: "MiniLM", use: "Search", license: "Apache-2.0", repo: "", revision: "", files: [], bytes: 23_000_000 },
  ] as const;

  it("reads their state, unavailable while main lists none", async () => {
    const api = (state: unknown[], listed: readonly unknown[] = info): ModelsApi => ({ models: async () => ({ info: listed, state }) as never, modelDownload: async () => null as never, onModelState: () => () => undefined, settings: async () => null as never });
    expect((await searchModels(api([], []))).state).toBe("unavailable");
    expect(await searchModels(null)).toMatchObject({ state: "unavailable" });
    expect(await searchModels(api([]))).toMatchObject({ state: "absent", bytes: 176_600_000, missing: ["clip-vit-b32", "minilm-l6"] });
    expect(await searchModels(api([{ id: "clip-vit-b32", state: "ready", bytes: 153_600_000 }, { id: "minilm-l6", state: "ready", bytes: 23_000_000 }]))).toMatchObject({ state: "ready", missing: [] });
    expect(combine([{ id: "clip-vit-b32", state: "downloading", received: 50, bytes: 100 }, { id: "minilm-l6", state: "absent", bytes: 20 }])).toMatchObject({ state: "downloading", received: 50 });
  });

  it("downloads what is missing, reporting progress", async () => {
    const states = new Map<string, unknown>([["clip-vit-b32", { id: "clip-vit-b32", state: "ready", bytes: 153_600_000 }]]);
    const downloads: string[] = [];
    let listener: ((s: never) => void) | null = null;
    const api: ModelsApi = {
      models: async () => ({ info: info as never, state: [...states.values()] as never }),
      modelDownload: async (id) => {
        downloads.push(id);
        listener?.({ id, state: "downloading", received: 10, bytes: 23_000_000 } as never);
        const done = { id, state: "ready", bytes: 23_000_000 } as const;
        states.set(id, done);
        return done;
      },
      onModelState: (cb) => ((listener = cb as never), () => (listener = null)),
      settings: async () => null as never,
    };
    const seen: string[] = [];
    await downloadSearchModels(api, (m) => seen.push(m.state));
    expect(downloads).toEqual(["minilm-l6"]);
    expect(seen).toEqual(["downloading", "ready"]);
    expect(listener).toBeNull();
  });
});

describe("the worker's client", () => {
  it("routes replies, transfers pixels, and ends the worker on failure", async () => {
    let onmessage: ((e: MessageEvent<EmbedReply>) => void) | null = null;
    const posted: EmbedRequest[] = [];
    let terminated = 0;
    const worker = {
      postMessage: (m: EmbedRequest) => void posted.push(m),
      set onmessage(f: typeof onmessage) {
        onmessage = f;
      },
      get onmessage() {
        return onmessage;
      },
      onerror: null as ((e: ErrorEvent) => void) | null,
      terminate: () => void terminated++,
    };
    const client = new WorkerEmbedder(() => worker);
    const a = client.text("hello");
    const b = client.image({ width: 1, height: 1, pixels: new Uint8Array(4) });
    expect(posted.map((p) => p.op)).toEqual(["text", "image"]);
    onmessage!({ data: { id: posted[1].id, vector: new Float32Array([2]) } } as MessageEvent<EmbedReply>);
    onmessage!({ data: { id: posted[0].id, error: "no model" } } as MessageEvent<EmbedReply>);
    expect([...(await b)]).toEqual([2]);
    await expect(a).rejects.toThrow("no model");
    const c = client.clipText("x");
    worker.onerror!({ message: "crashed" } as ErrorEvent);
    await expect(c).rejects.toThrow("crashed");
    expect(terminated).toBe(1);
    client.dispose();
  });
});
