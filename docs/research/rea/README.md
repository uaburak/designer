# REA round — Figma's canvas reverse-engineered, and how Wecra takes it in

Written 2026-10-15. Method: Figma desktop's own cached web-editor build (the minified webpack chunks, `fullscreen-wasm` 52 MB and `prototype-lib` wasm, `timeline_renderer_worker`, render / image workers) was extracted from `~/Library/Application Support/Figma/DesktopProfile/v43/Cache` and read with [REA](https://github.com/morluto/rea) 6.5.0 (`analyze-javascript-application` per chunk), the wasm's strings (C++ class names live in its assertion and log messages; the `name` section is stripped, exports are minified) and grep around Figma's field names. Uncertain findings were probed with the Plugin API in the owner's draft "REA probe (Wecra research)" (`2Rh4mZi09rwwECJE0xBG8Z`) until the Figma MCP Starter-plan call limit stopped it — components, vector and effects got live probes, motion and canvas did not (their probe lists are in the reports, to run from the devtools console as `docs/research/figma/live/` did). Each finding carries its evidence (chunk + offset + short snippet); no Figma code is copied.

| Report | Wecra today | Biggest gaps |
|---|---|---|
| [components.md](components.md) | the core model matches (primary / nested instances, `I<inst>;<key>` ids, PROP_REF bindings, VARIANT defs, derivedSymbolData) | rules the engine doesn't enforce (single-text rule on swap, name / cycle validation, Push enable rule, exposed-instance preconditions, default property names), Figma's 15 reset kinds, `.fig` round-trip keys (componentKey 216, sharedSymbolVersion 126, overrideLevel 321, overrideStash 248), NUMBER / IMAGE props, visibleWhen |
| [vector.md](vector.md) | Draw round 7 is in (brushes, Dynamic, text path, transform modifiers, booleans, shape builder) | **bug**: `strokeBrushGuid = -1:-1` (Figma's Dynamic) reads as Brush in TS; defaults that contradict Figma (Dynamic 0.75/0.3/0.5, width presets 0.1875, transform count 2–40, scatter gap 0.9); kind change must keep width points and dashes; Outline stroke of Dynamic / Brush; Simplify / Offset tools; plugin vector getters |
| [effects.md](effects.md) | every effect type exists | **every Figma blur is a separable tent of half-width R** (confirmed live: R = 20 stops at ~20 px), ours is a Gaussian σ = R/2 reaching 3σ; glass mis-mapped (Depth = refractionRadius, Splay = reflectionDistance, bevelSize 1); array-order effect walk; background blur clamped to the node box; fBm noise / texture; gradient interpolation fields Paint 41 / 42 |
| [motion.md](motion.md) | prototype easing / springs match Figma's numbers; Motion (round 8) is unbuilt and deferred | prototype fixes (MOVE_OUT / SLIDE_OUT direction, 0 → 0.3 s / 0.8 s, CUSTOM_CUBIC default `[0,0,.58,1]`, EASE_IN 15, write clamps, closed-form spring settle time); eight corrections to `docs/motion.md` before round 8 starts; `.fig` import drops KEYFRAME / KEYFRAME_TRACK |
| [canvas.md](canvas.md) | render on demand, WebGPU → WebGL2 fallback, C++-owned NODE_CHANGES, UAX#14 are equivalent | Plugin / agent layout setters (SPACE_BETWEEN vs SPACE_EVENLY, GRID side effects); layout not re-run after undo / redo / remote; undo's dangling-reference filter and no-op skipping; image decode colour handling; perf: lazy materialisation, occlusion culling, time-sliced edit rendering, threaded rendering (XL) |

## Integration order

Ordered by correctness first, then by what the owner sees, then by size. "Batch" = one implementation round on its own branch with native tests; C++ batches end with one `npm run engine:build`.

**Batch A — correctness, small (this night's round, 2026-10-15)**
1. Vector: stroke-kind detection (`-1:-1` sentinel, neutral Dynamic = Basic), Dynamic defaults, width presets + Flip matching, kind change keeps width points / dashes, transform count 2–40, stroke settings limits.
2. Effects: glass field mapping in its seven places; tent blur + triangle-CDF analytic shadow (GL and WGSL together); asymmetric blur bounds; effect visibility rules.
3. Components: single-text rule on swap / variant switch; Push's enable rule; default property names; exposed-instance preconditions over every variant; detach `assetRef` for library mains.
4. Canvas: layout re-run after undo / redo / remote; Plugin / agent auto-layout and grid setters (SPACE_EVENLY, validation, GRID side effects); image downscale rule.
5. Motion (prototype side only — round 8 stays deferred): direction mapping, plugin `reactions` shape, timing defaults and mouse delays, easing numbers and clamps, spring settle time; `docs/motion.md` corrections.

**Batch B — Figma's rules, medium**: component validation with Figma's messages, the 15 reset kinds + plugin `removeOverrides`, variant-name backfill; per-node effect order, clamped background blur, noise / texture fBm shaders, image adjustments; Outline stroke of Dynamic / Brush, Simplify and Offset tools, scatter per-brush defaults; undo filters, edit scopes; image decode colour handling.

**Batch C — schema round (one wasm build)**: overrideLevel 321, overrideStash 248, componentKey 216 / sharedSymbolVersion 126 / componentPropRefs 267 on export, Paint 41 / 42, editScopeInfo 365, encodedOffsetsIndex 34, localUndoStack 22 / 23, motion fields from the current embedded schema (not the 106 dump).

**Batch D — performance** (gate: `scripts/engine-bench.mjs` on the owner's B2C file): lazy materialisation of invisible content, occlusion culling, time-sliced edit rendering, tile budget classes, pointer-move coalescing; then the XL threaded renderer (render worker on OffscreenCanvas) — owner's go-ahead needed, it changes `docs/engine.md` §6.

**Later, with their rounds**: Motion round 8 (keyframes through `EXPRESSION KEYFRAME`, timelines, presets as code against `figma:motion`), NUMBER / IMAGE properties and visibleWhen, slot primary instances, partial component sets on paste (multiplayer-era), StrokeAlign OFFSET / strokeData multi-stroke, glass on arbitrary shapes.
