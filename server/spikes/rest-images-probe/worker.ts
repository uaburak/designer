// Round 1e probe for server/spikes/rest-images.md: does the committed engine (src/renderer/src/engine/wasm, the
// release build the app ships) run inside workerd, headless (the engine's NullDevice), and export SVG / PDF there?
// Run: cd server/spikes/rest-images-probe && ../saml/node_modules/.bin/wrangler dev  → GET /?format=SVG|PDF|PNG
// Never deployed. Workers don't compile Wasm from bytes at run time, so the module is imported (compiled at upload)
// and handed to Emscripten through instantiateWasm.
import engineWasm from "../../../src/renderer/src/engine/wasm/engine.wasm";
import { Engine } from "../../../src/renderer/src/engine/Engine";
import { loadEngine } from "../../../src/renderer/src/engine/loadEngine";
import { SAMPLE_DOCUMENT } from "../../../src/renderer/src/engine/sampleDocument";

let loadMs = -1;
async function ready(): Promise<void> {
  if (loadMs >= 0) return;
  const t0 = Date.now();
  // The -sENVIRONMENT=web glue builds `specialHTMLTargets = [0, document, window]` at start; a server build would
  // use -sENVIRONMENT=web,worker (or shell) instead of this shim.
  const g = globalThis as Record<string, unknown>;
  g.window ??= globalThis;
  g.document ??= { querySelector: () => null };
  await loadEngine({
    printErr: () => {},
    instantiateWasm: (imports: WebAssembly.Imports, done: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void) => {
      WebAssembly.instantiate(engineWasm as WebAssembly.Module, imports).then((instance) => done(instance, engineWasm as WebAssembly.Module));
      return {};
    },
  } as never);
  loadMs = Date.now() - t0;
}

export default {
  async fetch(request: Request): Promise<Response> {
    const format = (new URL(request.url).searchParams.get("format") ?? "SVG") as "SVG" | "PDF" | "PNG";
    try {
      await ready();
      const t0 = Date.now();
      const engine = await Engine.create(null, { sessionID: 1 });
      // ?n=N: N more cards inside the "Desktop" frame (a heavier export of 1:1).
      const n = Number(new URL(request.url).searchParams.get("n") ?? 0);
      const card = SAMPLE_DOCUMENT.nodeChanges.find((c) => c.guid === "1:5")!;
      const extra = Array.from({ length: n }, (_, i) => ({
        ...card, guid: `5:${i + 1}`, name: `Card ${i}`,
        parentIndex: { guid: "1:1", position: "~" + String(i).padStart(6, "0") },
        transform: { ...card.transform!, m02: (i % 40) * 16, m12: Math.floor(i / 40) * 10 },
      }));
      engine.load({ ...SAMPLE_DOCUMENT, nodeChanges: [...SAMPLE_DOCUMENT.nodeChanges, ...extra].map((c) => ({ ...c, phase: "CREATED" as const })) });
      engine.setViewport(1280, 800, 1, 1280, 800);
      const out = engine.exportNodes([n ? "1:1" : "1:5"], { imageType: format } as never) as { status: string; bytes?: Uint8Array; pixels?: { width: number; height: number; data?: Uint8Array } };
      const ms = Date.now() - t0;
      engine.destroy();
      const heap = (await loadEngine()).module.HEAPU8.length; // the Wasm linear memory, bytes
      if (new URL(request.url).searchParams.has("raw") && out.bytes)
        return new Response(out.bytes, { headers: { "content-type": format === "PDF" ? "application/pdf" : "image/svg+xml" } });
      return Response.json({ format, status: out.status, bytes: out.bytes?.length ?? null, pixels: out.pixels ? [out.pixels.width, out.pixels.height] : null, loadMs, exportMs: ms, heap });
    } catch (e) {
      return Response.json({ error: e instanceof Error ? `${e.message}\n${e.stack}` : String(e) }, { status: 500 });
    }
  },
};
