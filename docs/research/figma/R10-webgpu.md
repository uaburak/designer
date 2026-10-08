# R10-webgpu — How Figma moved its renderer to WebGPU (verified 2026-10-08)

Sources opened:
- figma.com/blog "Figma rendering: Powered by WebGPU" (Alex Ringlein, Luke Anderson, 2025-09-18) — https://www.figma.com/blog/figma-rendering-powered-by-webgpu/
- help.figma.com Figma's browser and hardware requirements — https://help.figma.com/hc/en-us/articles/360039827194
- Emscripten 6.0.11's `tools/ports/emdawnwebgpu.py` and ChangeLog (`-sUSE_WEBGPU` removed in 4.0.10 for Dawn's `emdawnwebgpu`), and the Dawn release it pins (v20260423.175430, `emdawnwebgpu_pkg/README.md`)

Where this file says "Figma", it reports the blog post; "we" is what this repo built from it (engine/src/gfx/wgpu, docs/engine.md §6.1). The post gives no numbers, no blocklist and no shader code; those gaps are marked.

## 1. Why

- Figma chose WebGL in 2015, when it was rarely used for complex 2D; Chromium shipped WebGPU in 2023.
- What WebGPU offers them: compute shaders (moving CPU work to the GPU), no WebGL global state, better error reporting.
- The constraints they set: a backend designed for performance from the start, WebGL kept working throughout, a gradual rollout.

## 2. The graphics interface first

- Figma's old interface mirrored WebGL's bind-then-draw (`bindVertexBuffer`, `bindTextureUniform`, `bindMaterial`, `bindFramebuffer`, then `draw()`); bindings outlived the draw, which caused bugs.
- They made every draw input an explicit argument: `draw(vertexBuffer, framebuffer, {texture}, material, …)`. The WebGL implementation binds lazily (only what changed). This fixed WebGL bugs before any WebGPU code existed.
- **Uniforms.** WebGL sets them one at a time (`setUniform1f`, `setUniform3fv`); WebGPU wants them in buffers, and a buffer per uniform per draw would regress. They added an **`encodeDraw`** step (records each draw's uniform data and material) and a **`submit()`**: on WebGPU, `submit()` uploads all the frame's uniform data as one buffer and issues the draws at offsets into it; on WebGL the same calls fall back to the per-uniform functions.

Ours: `gfx::Device` already had explicit-argument draws (`DrawCall`: pipeline, instances, textures, scissor, stencil ref, 12 vec4 uniform slots) and a `submit()` — built that way in E1 after R1 §b. The WebGPU device does what Figma's `submit()` does: each draw's uniforms go into a 256-byte slot of a CPU staging buffer (consecutive draws with equal uniforms share a slot), and at submit the staging buffers are written with one `queue.writeBuffer` each (64 KB, 256 draws) before the command buffer; draws bind them with a dynamic offset.

## 3. Shaders

- Figma's shaders are WebGL 1 GLSL; hand-keeping a WGSL copy of each was rejected, and open-source converters didn't accept WebGL 1 GLSL.
- So GLSL stays the single source. A custom shader processor parses it, rewrites it as newer GLSL (uniform blocks), then runs **naga** (open source) to produce WGSL. The processor emits both GLSL and WGSL, extracts input types and data layouts for the C++ side, and supports `#include`.

Ours (interim): the three programs (the merged instanced Shape program — SDF shapes, shadows, curve coverage, paints, clips; Composite — layers, masks, blend modes, shadows; Blur) are hand-translated, line for line, in `gfx/wgpu/Shaders.h`, next to the GLSL in `gfx/gl/Shaders.h`. No naga or Tint is installed on this machine (no cargo); `tools/shadergen` with naga, Figma's pipeline, remains the plan (docs/engine.md §6.10) and would replace both hand-kept files. Parity is checked by pixels instead (§7).

## 4. Bindings, native, Dawn

- Wasm: Emscripten's built-in WebGPU bindings (forwarding to the browser's API); custom C++/JS bindings where those were too slow. Native (server-side rendering, tests, debugging): Dawn. Emscripten's bindings were deprecated, so they were moving to Dawn's **emdawnwebgpu**.
- Differences they had to absorb: coordinate systems ("internal coordinate systems" — no detail given), errors (WebGL checks are synchronous and costly; WebGPU reports asynchronously with better messages), **readback** (synchronous in WebGL, asynchronous in WebGPU — "a major change").
- Bind groups: caching and reusing them was one of the two fixes for their largest regressions.

Ours:
- emdawnwebgpu (`webgpu.h`), the port Emscripten 6.0.11 ships. Its pinned Dawn release still reads the removed `USE_WEBGPU` setting (link error), so `engine/cmake/emdawnwebgpu_engine.py` loads the same port with that one read defaulted. Custom JS (`gfx/wgpu/library_engine_wgpu.js`) covers what `webgpu.h` doesn't: importing the GPUDevice TypeScript requested, ImageBitmap uploads (`copyExternalImageToTexture`), the device-loss hook, the self test, readback.
- Coordinates: WebGPU's framebuffer y runs down. Offscreen targets are drawn with clip y negated, so their rows sit in memory as GL leaves them and every texture read, copy and scissor means the same on both backends; the canvas is drawn unflipped (the shaders get the sign and the framebuffer height in a device-owned uniform slot and rebuild `gl_FragCoord`).
- Readback stays synchronous for our callers (thumbnails, exports, the shot tests): the texture is copied into a WebGPU OffscreenCanvas and read through a 2D canvas (the browser waits for the GPU, as `glReadPixels` does). Figma made theirs asynchronous; doing the same here means making `engine_render_thumbnail` and the export calls asynchronous — not done.
- Bind groups are cached by the textures' identities and dropped with them; pipelines are compiled at `createPipeline` for both colour formats (targets RGBA8, the canvas's preferred BGRA8).

## 5. Fallback and blocklist

- WebGL start-up runs test renders and readbacks to catch bad drivers. The WebGPU equivalent needs an asynchronous readback — hundreds of milliseconds at load, unacceptable.
- Plan 1: run the WebGPU tests after the session starts, without blocking, and blocklist failing devices. Not enough: on Windows WebGPU could fail mid-session (device lost, then `requestAdapter`/`requestDevice` throwing).
- Final design: **dynamic fallback** — a session starts on WebGPU and switches to WebGL if the asynchronous tests fail or any WebGPU failure happens mid-session; like WebGL context-loss recovery, except the backend is swapped, not recreated.
- Rollout finished with devices **blocklisted by average fallback rate** (a fallback is a visible hitch). The post publishes no list.
- Help Center: Figma needs WebGL 1 at minimum; shaders (the shader fill feature) need WebGPU, **not in compatibility mode** (Chrome 113+, Firefox 141+, Safari 26+, Edge 121+).

Ours: `src/renderer/src/engine/gfx.ts` picks WebGPU when `navigator.gpu` gives a high-performance adapter that is not a fallback (software) adapter, not compatibility mode, not on the (empty, Figma-shaped) blocklist, and this machine hasn't fallen back twice already (Figma's fallback-rate blocklist, for one machine: a localStorage count); else WebGL2. `?gfx=webgl|webgpu` forces one (webgpu clears the count). The device runs a self test after start (one composite at opacity 0.5 into a 4×4 target, read back with `mapAsync`); a mismatch, or a lost device, makes `Engine.gfxFallback` move the session to WebGL2 — on a copy of the canvas, since a canvas keeps its first context type — with `engine_gfx_switch` rebuilding the renderer (every GPU resource is a cache).

## 6. What they measured

- An internal performance framework against a WebGL baseline on many Windows, Mac and ChromeOS devices; results varied by device type. The largest regressions were fixed by bind group caching/reuse and by batching draws into fewer render passes.
- Production rollout by percentage, metrics split by GPU, OS and browser: some device classes improved, others were neutral, **no regressions**. No numbers are published.
- Next for them: compute-shader blurs, MSAA through WebGPU, RenderBundles for CPU overhead.

## 7. Our measurements (M3, Chrome 152 / Electron 44)

- `npm run engine:shot -- --gfx webgpu`: every check that passes on WebGL passes on WebGPU (93 + 2 fallback checks). Same-GPU screenshot comparison (`SHOT_GPU=1` WebGL on ANGLE-Metal vs WebGPU): 99.988 % of pixels identical, 99.993 % within 2/255; exports (PNG via readback) byte-identical.
- `engine-bench --synthetic 20000`, 1440×900 @2x: both backends hold 16.7 ms frames (vsync) in every scenario; render-call CPU is equal or lower on WebGPU (first frame 21.3 → 15.3 ms CPU, wheel-zoom p95 7.0 → 4.3 ms; other medians 0.1–0.5 ms on both); Chrome's GPU-process peak 887 → 745 MB. WebGPU has no synchronous readback or timer query in the bench, so GPU times are WebGL-only.
- Electron 44 on macOS exposes WebGPU (Metal, `metal-3`, 16384 max texture) without flags in secure contexts (the app's `app://` scheme is registered secure; a `data:` page has no `navigator.gpu`). Headless Chrome for the shot test needs `--enable-unsafe-webgpu --enable-gpu --use-angle=metal`; SwiftShader's WebGPU adapter is a fallback adapter our selection refuses.
