# Spike: how to answer `GET /v1/images/:key` (Phase 7 round 1e)

Figma's endpoint renders nodes of a file: `GET /v1/images/:key?ids=1:2,1:3&scale=0.01…4&format=jpg|png|svg|pdf`
(+ `svg_outline_text`, `svg_include_id`, `svg_include_node_id`, `svg_simplify_stroke`, `contents_only`,
`use_absolute_bounds`, `version`) → `{ err, images: { "1:2": "<url>" | null } }`, the URLs short-lived links to the
rendered files (a `null` for a node that failed to render). Round 5a (`server/src/rest/`) builds it; this note decides
how, before it is promised.

## The constraint

Our renderer draws through `gfx::Device` with two backends, WebGL2 and WebGPU (`docs/engine.md` §6). A Worker has
neither. But not every format needs them:

- **SVG and PDF are vector writers over the scene** (`engine/src/export/SvgWriter`, `PdfWriter`), not renderer
  output. Only PDF asks the renderer for one thing: layers with shadows or blurs are written as an image of the layer
  (`exporter::Rasterize`); without a renderer they are written as vectors without their effects.
- **PNG and JPG are the renderer's pixels** (offscreen target + `readPixels`). On the engine's `NullDevice` they come out
  at the right size but blank.

## Measured (2026-10-11)

Probe: `server/spikes/rest-images-probe/` — the committed release build (`src/renderer/src/engine/wasm/engine.wasm`,
the one the app ships) and the app's own `Engine.ts`, bundled by wrangler 4.149 and run in workerd under `wrangler dev`
(`../saml/node_modules/.bin/wrangler dev`, then `GET /?format=SVG|PDF|PNG&n=<extra cards>`). Two things were needed:
the Wasm imported as a module and passed through Emscripten's `instantiateWasm` (Workers don't compile Wasm from
bytes at run time), and a two-line `window` / `document` shim (the `-sENVIRONMENT=web` glue reads them at start; a
server build would use `-sENVIRONMENT=web,worker`).

| | Result |
|---|---|
| `engine.wasm` | 4,617,639 B raw, 1,637,264 B gzip; the probe bundle 5.0 MiB / 1.7 MiB gzip — within Workers' only size limit today (64 MiB uncompressed; no compressed limit, per Cloudflare's limits page) |
| Start | the first request (instantiate + create + load + export) 32 ms wall; later ones 3–8 ms |
| Wasm memory | 66.6 MiB at start (`INITIAL_HEAP=64MB`), unchanged up to ~1k nodes |
| SVG / PDF / PNG of the sample card | ok / ok / ok (280×160, **blank**: NullDevice) — the SVG identical to the app's (`<rect … rx="12" fill="#F2F2F2"/>` + the inside stroke) |
| 1,000 extra cards, export of the frame | SVG 152 KB in 49 ms; PDF 88 KB in 39 ms; memory 66.6 MiB |
| 20,000 extra cards | SVG 3.1 MB in 216 ms; PDF 1.8 MB in 631 ms; memory **95.9 MiB** |
| 100,000 extra cards | SVG 15.5 MB in 1,248 ms; memory **238.8 MiB** |

workerd under `wrangler dev` doesn't enforce the 128 MB isolate limit; production does, and it counts Wasm memory and
the JS heap together (a Wasm memory never shrinks). So a Worker can export SVG / PDF of pages up to roughly
10–20k nodes; past that it is killed. The engine derives only the shown page (`docs/engine.md` §4 "per page"), which
helps: memory follows the page asked for, not the whole file.

Workers limits (developers.cloudflare.com/workers/platform/limits, read 2026-10-11): CPU **10 ms** a request on Free;
Paid 30 s by default, up to 5 min (`limits.cpu_ms`); memory 128 MB per isolate on both; startup 1 s.

## The options

**(a) Thumbnails only.** Serve the file's stored thumbnail (≤ 800×600, one frame) for every id. Cheap and already
half-built (`thumbnailUrl`, `docs/multiplayer.md` §14.13), but it isn't what the endpoint is for: callers ask for
specific nodes (icon pipelines, design-token scripts, docs sites). Useful only as the file-level `thumbnail_url`.

**(b) Client render-and-cache.** The room asks a connected editor or viewer of the file (they already hold the
document and a GPU engine) to run `engine_export` for the ids and upload the bytes; the server stores them by
`(file, version seq, node, settings)` in the room's blob store (`docs/multiplayer.md` §4: SQLite, 1 MB chunks, no R2)
and answers with links. Pixel-identical to the app (it *is* the app's export), all formats, every feature (custom
shader paints, glass, blurs), no new renderer. The cost: an answer needs someone online with the file open, or a
cached result for that version. For a personal deployment where the owner's desktop app is usually running, a
**headless "render helper" in the desktop app** (main keeps one hidden view connected to files that have REST traffic)
removes most of that gap.

**(c) A CPU raster path in the engine, in a Worker.** A third `gfx::Device` (software) under the same render tree:
stencil-then-cover path fills with MSAA, the six built-in programs (Draw, Composite, Blur…; `gfx/gl/Shaders.h`,
712 lines of GLSL) rewritten as C++ per-pixel code, blend modes, masks, backdrop copies, mip levels. XL, and it hits
walls a Worker can't move:
- **memory**: Figma allows `scale` up to 4. A 1920×1080 frame at 4× is one 7680×4320 RGBA8 target = 127 MiB —
  the whole isolate, before the MSAA target, the layer and backdrop targets and the document (66 MiB of Wasm at rest);
  at 2× each target is 32 MiB. Tiling the export would be required on top of the rasterizer;
- **CPU**: a software rasterizer in Wasm, single-threaded, with blurs — seconds per large frame, so the paid plan and
  `cpu_ms` raised, and still timeouts on big frames;
- **custom shader paints and effects** (r11: user-written shaders, `gfx/gl/CustomShader.h`) can't run without a GPU
  or a shader interpreter — they would render wrong, silently;
- **fidelity**: a second rasterizer must match the GPU's coverage, gradients and blurs, or exports differ from the
  app; that's a permanent parity test burden (`engine-shot` runs on two backends today, this would be a third).

**(d) An external render service.** Headless Chromium running our own web viewer (`npm run viewer` already exports a
file headless; `scripts/drive.mjs`) — the same engine and GPU backends, so the same pixels. Where it would run:
- **Cloudflare Containers** (instances from 1/16 vCPU · 256 MiB to 4 vCPU · 12 GiB): no GPU, so WebGL2 through
  SwiftShader (Chromium's software GL; recent Chromium needs `--enable-unsafe-swiftshader` for it — to verify) or WebGPU
  on SwiftShader Vulkan. Needs the Workers Paid plan and pays per instance-time; cold starts of seconds;
- **Cloudflare Browser Rendering**: Free 10 browser-minutes a day, Paid 10 hours a month then $0.09/h; whether its
  Chrome has WebGL is undocumented — to verify before relying on it;
- **a box of the owner's** (the Mac itself, behind a tunnel): that's (b) with extra steps.
A native build of the engine (C++ against Dawn native with its SwiftShader adapter, or EGL + Mesa llvmpipe for the GL
backend) in a Container would avoid Chromium but adds a non-Emscripten build to maintain.

## Recommendation

**Build (b) + the vector half of (c) in round 5a; keep (d) as the upgrade path; don't build a CPU rasterizer.**

1. **SVG and PDF on the server** with the engine Wasm as it is (proved above): a server build of the same sources
   (`-sENVIRONMENT=web,worker`, no gfx backends linked: `NullDevice` only, so smaller), run where the document is —
   in the file's Durable Object or a Worker that streams the snapshot + frames from it. Text: files uploaded with
   derived data (`ENCODE_DERIVED`: glyph outlines per text, `docs/engine.md` §4 "derived data stored") draw from their
   stored outlines with no font at all; bundled Inter and Google Fonts can be fetched; local-only fonts of the author
   fall back to the stored outlines. Images: from the room's blob store. Limits: refuse with Figma's
   `err` for pages over a node budget (start at 15k nodes; measure in production) and fall to (2). PDF layers with
   effects: hand those requests to (2), or write them without effects and say so in `err` — decide in round 5a.
   Needs the **Workers Paid plan** ($5/month): even the 280×160 card's cold export (~25 ms) is over Free's 10 ms CPU.
2. **PNG / JPG by client render-and-cache.** `GET /v1/images` with a raster format: answer from the cache when the
   version's render exists; else send `render {ids, settings, version}` to one connected client of the room (an
   editor first, then a viewer, then the desktop app's render helper), wait up to ~25 s, store and answer; nobody
   online → `{err: "No client available to render this file", status: 503}` (Figma returns 4xx/5xx with `err` the same
   way) and `null` per id. Renders are content-addressed, so a version renders once.
3. **If raster without a client becomes necessary** (friends' CI hitting files nobody has open): put (d) — headless
   Chromium + the viewer in a Cloudflare Container — behind the same "render client" interface as (2). It is the one
   way to get identical pixels without a GPU in our own code. Verify SwiftShader WebGL2 / WebGPU in that image first.
4. `thumbnail_url` (files, projects listings) stays (a): the stored thumbnail.

Not chosen: (c)'s rasterizer — XL work that still can't do 4× exports of large frames inside 128 MB, can't run custom
shader paints, and would be a third backend to keep in parity forever.
