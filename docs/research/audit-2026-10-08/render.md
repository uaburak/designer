# Audit: rendering fidelity vs Figma (2026-10-08). $S = this folder.
Tooling HIGH: scripts/fig-fidelity.mjs crashes `__dirname is not defined` (src/main/fonts.ts → views.ts → protocol.ts:17 via Vite SSR). Scratch workaround $S/ff.mjs (sets globalThis.__dirname, port 5371). Fix: stub ./views ./protocol in the script's plugin or move fontIndex out of Electron-coupled module.
Numbers (mean ΔE / >10 / >25), 2× ss: sections 0.19/0.19%/0; stacks_wrap 0.20/0.09%/0; structure 0.11/0/0; owner 0.47/0.04%/0. --ignore-derived owner 1.20/2.57%/1.26% (bold title drawn regular).
Matches: normal text weight/ink; colour means; analytic shadows; section fill/stroke; corner smoothing 180/184 nodes vs Figma fillGeometry within 1e-6.
HIGH
1 Clips: square axis-aligned clips widened to whole device px (Renderer.cpp:591-603 floor/ceil) + hard discard (gfx/gl/Shaders.h:348) → leak up to 1 device px (stacks_wrap cell 376,104 ΔE 5.1, $S/out/crop_sw.png). Stencil clips binary (cov<0.5 discard ~Shaders.h:328) → jagged for smoothed-corner / rotated / double-rounded frames (owner file 1,370 smoothed frames). Fix: float clip rect with AA coverage (roundClip with radii 0); path clips multiply curve coverage (as INSIDE strokes) or R8 clip mask (engine.md §6.7). Both backends (WGSL too).
2 Tiny text/layers fade: greek bars 35% at em<3 device px (render/TextRender.cpp:26); Figma at ~2px em still dark glyph blobs (darkest 25 vs ours 196–209, ink −17–20%; $S/own1/crop_text.png); cull <0.5 px (Renderer.cpp:885) loses detail. Fix: glyphs down to ~1px em, below greek at full colour×coverage; calibrate vs Figma.
3 (SELECTION AGENT OWNS — skip) frame titles #898989 override/sections labels.
MEDIUM
4 (SELECTION AGENT OWNS — skip) pixel grid / pixel preview / outlines.
5 Corner smoothing next to a square corner: per-corner budget min(w,h)/2 (geometry/Shapes.cpp:113, lines 31-33) kills smoothing (e.g. 122×28 radii [14,14,0,0] smoothing 0.6, 8.4 px off). Fix: per-edge budget (edge length − neighbour corner extent) as figma-squircle.
6 Effects rules (help 360041488473): strokes drawn above inner shadow (ours inner shadow over strokes, Renderer.cpp:960-966); spread only on rect/ellipse/frame/component (frames need clip + visible fill) — ours dilates everything; one layer blur + one background blur per object (ours max layer blur + all bg blurs, Renderer.cpp:895-899, 917); effect blend modes ignored (composites at 956/965 NORMAL); "Show behind transparent areas" off: Figma hides shadow under layer, ours ×(1−α) (Shaders.h:456-459) — verify.
7 Newer effects: progressive blur drawn uniform (blurOpType in Effect::extra, scene/Node.h:478-488); Noise/Texture/Glass @later not drawn; Noise & Pattern paints dropped on import (src/shared/fig/convert.ts:114).
8 Images softer when zoomed out: HF energy 1.42 Figma vs 0.48 ours (trilinear textureGrad Shaders.h:51, GLDevice.cpp:447). Check at 25–50%, consider LOD bias / bilinear tiers; nearest-neighbour at high zoom unverified.
9 Thin strokes at small scale: component-set dashed border one strong side #cba3ff vs ours four faint #f1e7ff (alpha×width hairline rule; $S/out/crop_cs.png) — calibrate.
LOW
10 Dither blurs/shadows (forum) — ours gradients only (Shaders.h:66).
11 (SELECTION AGENT OWNS) palettes.
12 Missing-font fallback ignores weight (bold drawn regular) — pick nearest weight in fallback.
NEXT: use Figma's stored fillGeometry/strokeGeometry per node as ground truth (import drops them; $S/sq3.mjs + $S/figdec.mjs). Owner file strokes: 13,374 centre / 4,453 inside / 521 outside, 6,801 round caps, 36 dashed, 3,712 per-side — compare strokes, arrowheads, dash phase.
