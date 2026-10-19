# Paints & effects — Figma vs Wecra (REA round, 2026-10-15)

What Figma's renderer does for paints and effects, what Wecra's engine does today, and the ordered work to close the gap.

**Sources.**
- Figma: a clean-room static reading of the desktop app's cached `viewer.min.js` (its JS build of the renderer and the scene → render-tree builder, every GLSL shader as `SHADER_SOURCE_*`), the wasm's shader strings, `3187.min.js` (Plugin API effect converter), `8865.min.js` (the effect panel's defaults) and `2108.min.js` (clamp constants). The evidence column quotes offsets in `viewer.min.js` unless another file is named. Only short snippets are quoted.
- One live probe through the Figma MCP (`use_figma`, file `2Rh4mZi09rwwECJE0xBG8Z`, page `effects`, frame `blur1` 1:121). The owner's Starter plan stopped the run after 5 calls. The other 13 probes are listed in §5 as still to run.
- Wecra: `docs/engine.md` §6.5–6.7, `schema/document.kiwi`, `engine/src/render/Renderer.cpp`, `engine/src/gfx/gl/Shaders.h` (`gfx/wgpu/Shaders.h` mirrors it line for line), `engine/src/scene/{Node.h,Extras.h,Document.cpp}`, `engine/src/export/{Export.cpp,SvgWriter.cpp}`, the Effects / Paints panels, the Plugin API converter and the agents' schema. Figma's own schema (`docs/research/figma/figma-schema-106.kiwi`, version 106) gives the field numbers.

**Confidence.** *High*: read directly from shader or builder code, consistent across files. *Medium*: read from builder code whose branch conditions were not fully traced. *Probe*: confirmed by the live render.

---

## 1. Summary

| # | Feature | Wecra | Size | Prio |
|---|---|---|---|---|
| 1 | Glass field mapping (Depth / Splay) and defaults | **different** (wrong fields) | S | 1 |
| 2 | Blur kernel: tent of half-width R, not Gaussian σ = R/2 | **different** | M | 1 |
| 3 | Analytic rect / rrect shadow: triangle CDF | **different** | S | 1 |
| 4 | Blur reach and node bounds expansion | partial | S | 2 |
| 5 | Effect visibility rules | partial | S | 2 |
| 6 | Per-node effect order: array order, compounding, one backdrop effect | partial | M | 2 |
| 7 | Blur resolution / downsampling | different (looks the same) | S | 3 |
| 8 | Drop-shadow silhouette ignores fill opacity | different (medium; probe first) | S | 3 |
| 9 | Drop-shadow pipeline (knockout, offset space, blend) | done (small gaps) | S | 4 |
| 10 | Shadow spread (geometry, strokes, clamps) | partial | M | 3 |
| 11 | Inner shadow (hard mask, order exception) | partial | S | 3 |
| 12 | Background blur clamped to the node box | missing | M | 2 |
| 13 | Background blur mask | partial | S | 3 |
| 14 | Progressive blur: per-pixel tent, sharp blend | different | L | 4 |
| 15 | Glass rendering algorithm | different | L | 3 |
| 16 | Glass on arbitrary shapes | missing | L | 5 |
| 17 | Noise effect shader (fBm, density bands) | different | M | 3 |
| 18 | Noise / texture defaults and seed | partial | S | 2 |
| 19 | Texture (GRAIN): fBm displacement, clip rules, shadows | different | M | 3 |
| 20 | Gradient t functions | done | — | — |
| 21 | Gradient interpolation colour space | missing | L | 4 |
| 22 | Dither amplitude (±1/255, all channels) | partial | S | 4 |
| 23 | Image scale-mode transforms | partial (TILE rotation) | S | 5 |
| 24 | Image colour adjustments (exact pipeline, contrast ×0.3) | different | M | 3 |
| 25 | Blend-mode compositing | done | — | — |
| 26 | Plugin API effect clamps and names | partial (Glass wrong, no clamps) | S | 2 |
| 27 | Effect field defaults (kiwi decode and panel) | partial | S | 2 |

`engine.md` §6.7 is wrong on three points and must change with the work below: the blur is a tent (not "Separable Gaussian … σ = radius / 2 … half-width 3σ", engine.md:689), Glass Depth is `refractionRadius` and Splay is `reflectionDistance` (engine.md:696), and every layer blur and texture applies in list order (not "the first layer blur … only", engine.md:692).

---

## 2. Figma behaviour → Wecra today, per feature

### 2.1 Blur kernel (layer, background, shadow, glass frost) — **different**, high, probe
**Figma.** Every blur is a separable **tent** (triangle): tap weights `count − k` for k = 0…count, one pass per axis (2-D kernel tent(x)·tent(y)), adjacent taps merged into one bilinear fetch. `count` = radius × the node's absolute scale × zoom, in device px (`cv` @748582: `radiusInTexels=Math.min(n,i*t*a*r)`; wasm str 11331 `float l=count-f;float m=count-g;…c+=n*(texture(o)+texture(p))`). The half-width equals the radius exactly (equivalent σ = R/√6 ≈ 0.408 R). A blur under 1 device px is skipped.
**Probe.** A 100 × 100 white rect on black, LAYER_BLUR 20, row y = 200: zero up to x = 131, first non-zero at 132, edge ≈ 127, zero again from 270. Observed 2 / 14 / 36 / 66 at 18 / 14 / 10 / 6 px outside the edge. A tent of R = 20 predicts 1.3 / 11.5 / 32 / 62. A Gaussian with σ = 10 predicts 9 / 21 / 40 / 70 and a 30 px tail. The tent fits; the tails sit slightly above an ideal tent, which the ×2 downsample's bilinear fetches may explain (§2.7).
**Wecra.** A Gaussian with σ = radius / 2 and half-width 3σ everywhere. Layer blur: `Renderer.cpp:1561` (`radius / 2 * scale`). Shadows: `Renderer.cpp:791` (analytic), `:1625` (generic). Backdrop: `:931–932`. The blur pass `Shaders.h:676–711` (`exp(-i²/2σ²)`, `n = ceil(3σ)` ≤ 48). So a radius-20 blur reaches 30 px, and its falloff near the edge is wider and softer than Figma's.
**Build.** Replace the Gaussian with the tent in the Blur fragment (GL and WGSL): weights `count − |i|`, at most 64 taps, linear-sampling pairs. Pass the radius in texels instead of σ (`Layer::blur` becomes a radius; rename it so no σ is left). Skip under 1 texel. Keep the dilate / erode modes.

### 2.2 Blur resolution and downsampling — **different** (same look), high
**Figma.** `renderBlur` (@752525): `u = min(64, scaleLimitForBlursAndEffects(r)·r·texSize)`, with `scaleLimitForBlursAndEffects(e) = 1/(1+2e)` (@958729). The content may be rendered at a reduced scale (quantised to 2/texSize) so the radius stays ≤ 128 texels. Above 4 texels (or 64 on an axis) the layer is downscaled ×2 with one bilinear fetch, blurred with count/2 and upscaled bilinearly. There is only one ×2 level. The static code shows no dither in the blur passes, but the probe saw ±1 noise in the flat region after a blur (§2.21).
**Wecra.** `Renderer::blurLayer` (`Renderer.cpp:1935–2015`): halve until σ·scale ≤ 8 texels, at most ×32, then blur. Gaussian passes are dithered (`Shaders.h:697–699`).
**Build.** With the tent: halve while the radius is above 64 texels, then one more ×2 when it is above 4 texels, to match Figma's single bilinear level and its tail. Rendering the layer smaller (Figma's reduced scale) is a performance choice that changes nothing visible; keep our halving chain for radii above 128 texels. This goes in the same change as §2.1.

### 2.3 Blur bounds expansion — **partial**, high
**Figma.** A blur grows its bounds by exactly radius × axis scale (`lR` / `lI`). A progressive blur grows along its gradient axes. The rendered bounds sum the reaches of all visible layer blurs. Each drop shadow adds offset ± (radius + spread) ± the blur reach, so the bounds are asymmetric (`_updateBoundsIfNeeded` @1130575). Inner shadow, background blur, glass, noise and texture don't grow the node's bounds. Texture does grow them when clipToShape is off (§2.19).
**Wecra.** `effectsOutset` (`Document.cpp:73–87`) takes the max, not the sum, and grows symmetrically: `max(|ox|, |oy|) + radius + spread`. It is applied to all four sides (`Document.cpp:301`). The exported image's bounds (`Export.cpp:124–139`) are asymmetric for shadows but take the max of the layer blurs. The renderer's own layer reach is `3σ + 2` (`Renderer.cpp:1594`, `:1627`, `:821`).
**Build.** `effectsOutset` → `effectsBounds(p, size) → Rect`, asymmetric: Σ layer-blur radii; each drop shadow `offset ± (radius + spread)` grown by the blur sum; texture radius when not clipped. Use it in `derive()`, in `Export.cpp` and for layer rects (reach = radius + 1 instead of `3σ + 2`; `backdropReach` = radius + 1). Native test: bounds of a node with an offset shadow and two layer blurs.

### 2.4 Analytic rect / rounded-rect shadow — **different**, high
**Figma.** One pass when the blurred child is a FILL whose only paint is SOLID, with no clamp, perpendicular axes, uniform scale and uniform corner radii. The kernel is the triangle CDF `g(h)` on [−1, 1] (wasm 11513 `float g(float h){if(h<-1.0){return 0.0;}else if(h<0.0){return 0.5*(h+1.0)*(h+1.0);}…`). Rect: `(g(x0) − g(x1))(g(y0) − g(y1))`. Rounded rect: 4 samples weighted `max(0, 1 − |h|)`. Uniforms are in units of blurRadius = radius / scale, and the quad is grown by blurRadius. The rounded inner shadow is 1 − the blurred rrect, times the rrect SDF (fwidth AA).
**Wecra.** Evan Wallace's erf / Gaussian form (`Shaders.h:365–394`: `gaussian`, `erf2`, `boxShadow` integrating ±3σ), σ = radius / 2 (`Renderer.cpp:791`, `:800`, `:806`). The eligibility test (`analyticShadows`, `Renderer.cpp:727–738`) allows per-corner radii.
**Build.** In `boxShadow`, put the tent CDF in place of erf: `shadowX` uses `g`, the y integral 4 samples over [−R, R] weighted by the tent. Pass R instead of σ, and grow the quad by R. Keep per-corner radii: with the same kernel the result matches the generic path. Mirror in WGSL. Test: a centre row of an analytic shadow equals the generic path's within 1/255 (NullDevice cannot read pixels, so `engine-shot`), plus a calibration shot against the probe values of §2.1.

### 2.5 Dither — see §2.21.

### 2.6 Drop-shadow silhouette ignores fill opacity — **different**, medium (probe pending)
**Figma.** In shadow mode, every fill that is visible and not fully transparent becomes SOLID_BLACK at opacity 1 (`C()` @853844 `a.isForShadows()&&rr.containsAtLeastOneVisibleNotFullyTransparentPaint(c)&&(c=ep(1))`). `HARD_MASK_WITH_COLOR` then puts the shadow colour on it. So a 10 %-opacity fill casts a full-strength shadow; only fully transparent paints cast nothing. A clipping frame with a visible fill casts its box only, not its children.
**Wecra.** The generic path blurs a copy of the content layer `C` (`Renderer.cpp:1624–1638`, `S.copyOf = C`), so the shadow follows the content's alpha: a 10 % fill casts a 10 % shadow. The analytic path needs an opaque fill (`Renderer.cpp:727–738`), so it doesn't arise there.
**Build (after probe 1.2 confirms).** Draw the shadow source as the node's silhouette: `opaqueCopy` (`Renderer.cpp:766`) with every visible paint whose effective alpha is above 0 made opaque, and for a clipping frame its own box without children. Then the analytic path can take any visible solid fill. The knockout already uses geometry (`Renderer.cpp:1641–1652`).

### 2.7 Drop-shadow pipeline and order — **done**, small gaps, high
**Figma.** For each visible DROP_SHADOW in array order: silhouette offset in absolute space → spread → hard mask with colour → tent blur → texture if a clipped GRAIN exists → knockout unless `showShadowBehindNode`, skipped when the node is opaque (fill and stroke opaque) → blend with the effect's blend mode. All drop shadows form one group under the content, the first entry at the bottom (`y()` @852499). The knockout silhouette is solid black for every paint except IMAGE / EMOJI / VIDEO, which keep their alpha.
**Wecra.** The same order and the same knockout rule (`Renderer.cpp:1641–1666`; `opaquePaints` / `opaqueCopy` `:755–775`). The offset is in absolute space (`localOffset` `:778`, `deviceOffset` `:1639`). Effect blend: `:1640`. There is a cap of 8 shadows (`:1525–1530`), which Figma's builder doesn't have.
**Build.** Images keep their alpha in the knockout copy (`opaqueCopy` turns them white today). Drop the cap of 8, or raise it to a guard of 64. The clipped-texture-on-shadows step is in §2.19.

### 2.8 Shadow spread — **partial**, high
**Figma.** Spread applies only when `isSpreadEligibleNode` (@1087821): a frame-like node with a visible background and clipsContent, or a rect / ellipse-like node. It is in absolute units (converted by colLen/det). The fill geometry is regenerated at size + 2·spread, with the corner radius grown or shrunk by the spread. With a visible stroke that isn't INSIDE, the size first grows by strokeWeight × (OUTSIDE ? 2 : 1). A drop shadow vanishes when size ≤ −2·spread. An inner shadow's spread is clamped to ≥ −size/2.
**Wecra.** Eligibility matches (`shadowSpread`, `Renderer.cpp:742–751`). The analytic path grows the rect and radii (`:794–799`), but only radii that are already above 0. The generic path dilates or erodes the alpha with a separable max/min (`Shaders.h:704–710`, `blurLayer` `:1963–1972`). A square structuring element squares off an ellipse's spread and rounded corners. The stroke growth and the inner-shadow clamp are missing.
**Build.** Spread as geometry: for eligible nodes (always rect / ellipse / frame), generate the shape at size + 2·s with radii + s, clamped ≥ 0 (`geom::` rect / ellipse builders; the analytic path already does this). Add the stroke growth, the vanish rule and the inner clamp. Remove the morphology pass from the shadow path, or keep it only as a fallback. Native tests: spread on an ellipse gives an ellipse of the grown size; spread with an OUTSIDE stroke.

### 2.9 Inner shadow — **partial**, high
**Figma.** Visible when enabled && colour α > 0 && (radius > 0 || offset ≠ 0 || spread > 0); a negative spread alone doesn't count (`isVisibleForRendering` @494490). It is built as MASK INNER_SHADOW: the alpha is the node's silhouette (hard mask); the source is the silhouette offset, eroded by the spread and tent-blurred; then the colour and the blend mode. Inner shadows stack in array order. The order is fills, inner shadows, strokes, except when the node has both a layer blur and an inner shadow (@848085).
**Wecra.** Composite mode 4: `inside × (1 − blurred)` with `inside` = the content's alpha (`Shaders.h:636–640`, `Renderer.cpp:1682–1687`). The strokes-above split is there (`:1600–1680`), without the exception. The visibility rule is missing: a radius-0, offset-0 inner shadow allocates layers and draws nothing.
**Build.** The visibility rule (§2.24). `inside` = the silhouette (the same hard mask as §2.6). Skip the split when a layer blur is present.

### 2.10 Per-node effect order — **partial**, high
**Figma.** `Z()` (@869900–872600): content → the **first** visible BACKGROUND_BLUR **or** GLASS (the loop breaks; the backdrop goes under the content and is skipped when the node is opaque) → inner shadows → drop shadows (kept apart when a clipped texture or noise exists) → shader (CUSTOM) effects. Then **in array order**: FOREGROUND_BLUR wraps the result, merging the pending shadows first so they are blurred too; GRAIN wraps it, merging the shadows first when clipToShape is off; NOISE wraps the content only, never the shadows. Then the leftover shadows go under, and node blend and opacity apply last. Several layer blurs all apply and compound, and texture, noise and layer blur compound in list order.
**Wecra.** A fixed pipeline (`Renderer.cpp:1516–1735`): the first FOREGROUND_BLUR only (`:1534`), the first GRAIN only (`:1540`), up to 8 noises, the first BACKGROUND_BLUR **and** the first GLASS, both drawn (`:1585–1586`). The order is noise inside the wrap, then texture, then shaders, then the blur (`:1689–1735`). Shadows are inside the wrap, so noise draws over the shadows too. Noise goes through `C` (the content), so that part is right.
**Build.** Rewrite `drawNode`'s effect stage as a list walk:
1. Collect `backdrop` = the first visible BACKGROUND_BLUR or GLASS, whichever comes first.
2. Content (with inner shadows and the strokes split) as today.
3. Walk `effects` in order. FOREGROUND_BLUR: a layer of its own blurring (content + pending shadows). GRAIN: displace (with the shadows merged when not clipped). NOISE: over the content's alpha only. CUSTOM: before the walk, as Figma does.
4. Then any shadows not merged yet go under, and the node's opacity and blend apply.
This replaces the `wrap` / `post` / `split` booleans with a small op list, which is also what Figma's render-tree builder produces. It is the biggest structural change in this area and should come with a native test per order (layer blur then texture vs texture then layer blur: different command lists; two layer blurs give two blur layers).

### 2.11 Background blur clamped to the node box — **missing**, high
**Figma.** The backdrop is sampled through `CLAMPED_BLUR_TILE_NODE_SPACE`. The clamp rect is the node box grown by an OUTSIDE (weight) or CENTER (weight/2) stroke × strokeMiterLimit, plus the text bounds. The centre sample is clamped to the rect and every tap outside it gets weight 0, renormalised (wasm 11323 `float u=(count-k)*float(q==clamp(q,blurClamp.xy,blurClamp.zw))`). So the backdrop outside the node's box never bleeds into its blur. The backdrop is gathered from the parent's content bounds ∪ the mask bounds, plus the radius when progressive.
**Wecra.** The backdrop is copied with `reach` around the node (`Renderer.cpp:965–967`) and blurred unclamped, so a bright object just outside a glass card bleeds into its edge.
**Build.** A `clamp` rect (node space → texels) on the tent blur pass, with per-tap rejection and renormalisation, used for BACKGROUND_BLUR and the glass frost. The copy reach can then shrink to the stroke-grown box (no radius) for uniform blurs, which also helps `growForBackdrops` (`engine.md` round 17). Test: shot of a background blur next to a white rect outside its box: no light at its edge.

### 2.12 Background blur mask — **partial**, medium
**Figma.** `W()` (@864044): a non-frame node uses its shadow-mode silhouette (any visible, not fully transparent paint gives a full mask). A frame whose fill and stroke both have visible non-transparent paints uses fill + stroke in solid black; a clipping frame its silhouette; a non-clipping frame fill + stroke masked by the silhouette. A frame at 1 % fill opacity therefore shows the full blur over its whole box.
**Wecra.** The backdrop is painted into the shape at the node's alpha `a` (`Renderer.cpp:978–1011`), only when a fill is visible at ≥ 0.1 % (`:1551–1556`), and only into the fill shape (strokes excluded). Vector shapes use their fill geometry.
**Build.** Paint the backdrop at full strength into fill ∪ stroke geometry (the silhouette); the node's opacity still applies through its layer. Skip it when the node is opaque.

### 2.13 Progressive blur — **different**, high
**Figma.** `startOffset` / `endOffset` are fractions of the size (× `size.withOnesForZeros()`). startRadius applies at the start and radius at the end; start == end falls back to a standard blur. The shader projects each pixel onto start → end (clamped 0..1), takes `count = mix(startCount, endCount, t)` (min 0.001, the same tent, at most 64 taps) and runs two passes, perpendicular then along the gradient. Where the radius is under about 1 texel it blends with the sharp source (weights sharp = b², blurred = (2(b² − 1))²).
**Wecra.** A pyramid of up to 8 uniformly blurred copies (`blurLevels`, `Renderer.cpp:108–115`), each pixel mixing the two levels around its σ: composite mode 5 for layer blurs (`Shaders.h:617–624`) and PaintKind 7 for backdrops (`Shaders.h:78–88`). The fallback rule matches (`Renderer.cpp:1566–1569`).
**Build.** A variable-radius tent pass (`count` per pixel from the projected t; perpendicular then along the axis) with the sharp blend, replacing the level pyramid. This removes up to 8 copies per blur (performance win) and gives Figma's exact falloff. Size L because of the backdrop variant and the content-cache interplay. Do it after §2.1–2.4.

### 2.14 Glass field mapping — **different**, high (fixes our doc)
**Figma.** Plugin API ↔ kiwi (`3187.min.js` @3497923): refraction ↔ `refractionIntensity` [0,1]; **depth ↔ `refractionRadius` [1,100]**; lightAngle ↔ `specularAngle` [−899,900], shown as (a + 360) % 360; lightIntensity ↔ `specularIntensity` [0,1]; dispersion ↔ `chromaticAberration` [0,1]; radius = frost [0,100]; **splay ↔ `reflectionDistance` [0,1]**; `bevelSize` is always written as 1. Only one glass effect per node ("Only one glass effect is allowed per node.", 2108 module 598990). Defaults (8865): refractionIntensity 0.8, refractionRadius 20, specularIntensity 0.8, specularAngle −45, bevelSize 1, chromaticAberration 0.5, reflectionDistance 0, secondaryColor white α 0, radius 4. secondaryColor and tint aren't used in rendering.
**Wecra (wrong in seven places).**
- `schema/document.kiwi:476–482` comments: `refractionRadius` "Splay", `bevelSize` "Depth".
- `engine/src/scene/Extras.h:33–34`: defaults `refractionRadius = 0`, `bevelSize = 20`.
- `Renderer.cpp:942–946`: depth from `bevelSize`, splay from `refractionRadius / 100`; `backdropReach` (`:822`) uses `bevelSize`. A Figma `.fig` (bevelSize 1, refractionRadius 20) therefore draws a 1 px-deep glass.
- `Effects.tsx:76–77, 465, 468`: default and Depth slider write `bevelSize`; Splay writes `refractionRadius` 0–100; Angle shown −180…180 (`:459`).
- `plugins/api/convert.ts:195, 213`: `depth ↔ bevelSize`, no splay.
- `src/shared/agents/docSchema.ts:68–70, 96–98`, `layerProps.ts:85`: the same mapping told to agents.
- `docs/engine.md:696`.
**Build.** Remap everywhere: Depth ↔ `refractionRadius` (1–100, default 20); Splay ↔ `reflectionDistance` (shown 0–100, stored 0–1); write `bevelSize: 1`; Angle shown (a + 360) % 360 and stored −899…900. Allow one glass per node (the panel's + and the type menu refuse a second; the API throws Figma's message). No migration is needed for `.fig` imports (they already hold Figma's fields). Files made in Wecra before the fix hold Depth in `bevelSize`: a load-time fix-up (`bevelSize > 1 && refractionRadius == 0` → move it) is enough for the owner's few files. Tests: `render.effects.test.cpp` "extras" case (the defaults), `convert.test.ts` (Plugin API round trip), the agents' schema snapshot.

### 2.15 Glass rendering algorithm — **different**, high
**Figma.** blurRadius = max(radius, 1); dispersion × 0.2 (`CHROMATIC_EXPANSION_FACTOR` @613118); the refraction distance `rd` = min(halfW, halfH, depth). The frost is the backdrop downscaled ×2 and tent-blurred; the capture reach is blur + rd × (refraction + 0.2·dispersion). On the signed distance `eh` to the corner-smoothed rounded rect: ramp `ei = clamp((eh + rd + bevel)/rd)`; displacement magnitude `mix(clamp(ei^3.5·rd·refraction, ±0.999 rd), refraction·0.2·0.999 rd, bevel ramp)`; direction `mix(edge normal, radial from centre, splay)`; the backdrop is sampled at `p − dir·mag`. Dispersion: 8 taps along the displacement × dispersion, R/G/B offset ±½, triangle weights. Highlights: angle `lightAngle − frameRotation + π/2`, `smoothstep(.35, 1, dot(n, −L))·I` on the lit side, 0.6× on the opposite side, plus `0.05·I·dot(dir, L)·ramp²`. Then the content is drawn over it (wasm 11307 constants `cq=0.35 cr=0.6 cs=0.2 ct=3.5`; `uU.render` @894313).
**Wecra.** `glassAt` (`Shaders.h:43–64`): bend `e²·refraction·depth` along the normal, 3 taps for dispersion, a `pow(facing, sharp)` rim light; corner smoothing is not in the SDF. Hand-tuned, and `engine.md:696` says so ("not calibrated").
**Done (2026-10-19, the owner's parity round).** Ported from `SHADER_SOURCE_GLASS_FRAGMENT` and `renderRectangularLiquidGlass` / `glassTile` (viewer.min.js, the 2026-10-15 cache) into `glassAt` (GL + WGSL), computed in the node's own units (`g_dist`, the quadrant's corner radius, `g_toFrag` = node units → target px from the derivatives of the node coordinate). Confirmed and corrected details: rd = min(centre.x, centre.y, refractionDistance) in node units (`uU.render`); the dispersion uniform is chromaticAberration × 0.2 (the builder multiplies, the shader takes it raw); the light angle is degrees → radians in `glassTile`, frame rotation from `nodeToTileSpace.toAngle()`; the displacement normal uses corner radii max(radius, max(bevel, rd)) and is zero inside the corners' centres' box; the highlight normal uses the real radii; the highlight band is smoothstep(−bevel, −0.2·bevel) — 1 node unit wide at bevel 1; blurRadius = max(radius, 1). The field mapping of §2.14 holds: the captures at Depth 1 / 46 / 100 match (no lens at 1, a mirrored lens growing toward the rim at 46 / 100). Side by side: `../figma/live/owner-2026-10-18/after/glass-*.webp`. Not ported: corner smoothing in the distance (Figma's Bézier SDF; ours draws smoothed corners as paths, which get the frost only) and the non-uniform corners' numeric gradient (ours takes the quadrant's radius); the arbitrary-shape path (§2.16) stays open — ellipses use their exact SDF with the elliptic normal.
**Build (as planned before).** Port the algorithm into `glassAt` (GL + WGSL), with new uniform slots for frame rotation, splay (`reflectionDistance`), bevel and the corner smoothing (the smoothed rrect SDF that `geom` already uses for drawing). Frost is a clamped tent blur (§2.11) at max(radius, 1) after a ×2 downsample. Reach = blur + rd × (refraction + 0.2·dispersion). Depends on §2.14 and §2.11. Shot tests at three light angles and a rotated frame.

### 2.16 Glass on arbitrary shapes — **missing**, high
**Figma.** Frames (not groups) and rectangles use the analytic SDF. Every other shape (ellipse, vector, text, boolean) takes `GLASS_ARBITRARY_SHAPE`: a white mask of the fill geometry is tent-blurred in single-channel F32 (radius 0.5·depth + clamp(depth, 1, 6)) to stand in for the edge distance and normal, and a second blurred mask for the bevel (`K()` @867600, `renderArbitraryShapeLiquidGlass`).
**Wecra.** Rect, ellipse and frame only (SDF); other shapes get the frosted backdrop without an edge (`Renderer.cpp:981`, `engine.md:696`). Ellipses use an exact ellipse SDF, which Figma doesn't (it uses the blurred-mask path).
**Build.** A single-channel layer of the fill mask, two tent blurs (R16F / R32F where available; RGBA8 alpha fallback on WebGL2 without float render targets), and a `glassArbitrary` paint kind reading distance and normal from the blurred mask (gradient). Ellipses move to this path to match Figma. Size L (new target format in `gfx::Device`, both backends).

### 2.17 Noise effect shader — **different**, high
**Figma.** `NoiseType` MULTITONE 0, MONOTONE 1, DUOTONE 2 (the shader int too). Node space relative to the centre (size/2), so the noise moves and scales with the node. A 3-octave signed fBm of gradient (Perlin) noise at frequency 1/noiseSize per axis, seeds seed + 0..3 for four channels, v = (fbm + 1)/2. A pixel passes when v falls in a band of width density/2 centred on 0.25; duotone adds a second band at 0.75 (wasm 10973 `f=10.0*(0.25-density/4.0)…g=f+10.0*(density/2.0)`). MULTITONE: rgb = 2v − 0.5 per channel, α = band(v4)·opacity·srcα. MONOTONE: luminance .213/.715/.072 → α = band(lum)·color.a·srcα, rgb = colour. DUOTONE: low band secondaryColor, high band colour. Drawn within the node's alpha, in the effect's blend mode. noiseSize ≤ 1 is supersampled. Never on drop shadows.
**Wecra.** A hash per cell (`noiseAt`, `Shaders.h:532–542`; `noiseCell` `:66–75` for the paint): square, hard-edged cells, MONO = colour × a random strength, density = the share of cells drawn. Anchored at the node's origin, not its centre (`effectRows`, `Renderer.cpp:100`). It also goes over the shadows (inside the wrap, §2.10).
**Build.** Port Figma's noise as a shared GLSL / WGSL function (gradient noise, 3 octaves, the band test, three modes, supersampling ×4 when noiseSize ≤ 1), anchored at the node's centre. Use it for both the NOISE effect (composite mode 6) and the NOISE paint (PaintKind 9). The paint's Figma shader was not read in this round; assume the same function and confirm with a probe. Order fix in §2.10.

### 2.18 Noise / texture defaults and seed — **partial**, medium
**Figma.** NOISE: noiseType MONOTONE, noiseSize (0.5, 0.5), colour black α 0.25, opacity 0.15 for multitone (0.25 in the initial template), density 1, secondaryColor white α 0.25, seed = floor(1e4·Math.random()). GRAIN: noiseSize (4, 4), clipToShape false, radius 4, a random seed. The engine's own Effect defaults: noiseSize 0, clipToShape = (type == CUSTOM), seed 0.
**Wecra.** `Effects.tsx:73–75`: no seed (every new noise / texture shares seed 0, so two textured layers look identical), texture size 0.5, Multi opacity 0.25 (`:408`, `:418`). `Extras.h:22–35`: decode defaults noiseSize 0.5 and opacity 1.
**Build.** Random seed on add (0…9999) in `defaultEffect`, texture size (4, 4), Multi opacity 0.15. `EffectExtras` defaults follow the kiwi defaults (noiseSize 0, opacity 0, clipToShape per type) so absent fields read as in Figma. Test: `defaultEffect` unit test; "extras" native case.

### 2.19 Texture (GRAIN) — **different**, high
**Figma.** radius = the maximum displacement in node units; frequency 1/noiseSize. The displacement is (fbm(seed), fbm(seed + 1)), the same 3-octave noise anchored at the node's centre. Unclipped: sample at p + d·radius, and the bounds grow by the radius. clipToShape: the displacement is scaled by pow(srcα, .2)·pow(dispα, .2), and the original pixel is kept wherever the source or the displaced sample is transparent, so the silhouette is preserved and the bounds don't grow (wasm 10979). Visible only when radius > 0. Texture with clipToShape also textures the drop shadows; unclipped, it merges the pending shadows first and moves them too.
**Wecra.** A random shift per hashed cell (`textureShift`, `Shaders.h:544–548`): blocky jumps, not a smooth warp. clipToShape multiplies by the source alpha (`:628–631`), which cuts the edge instead of keeping the silhouette. The first GRAIN only. It always moves the shadows (they are in the wrap). The bounds grow even when clipped (`Document.cpp:81`).
**Build.** Port the displacement and the clip rule on top of §2.17's noise function. Apply texture to the shadows per Figma's two cases (§2.10 op list). Bounds grow only when unclipped.

### 2.20 Gradient t functions — **done**, high
**Figma.** In gradient space h = p − 0.5: LINEAR h.x + 0.5; RADIAL 2·|h|; ANGULAR fract(atan(h.y, h.x)/2π); DIAMOND 2(|x| + |y|); a ramp atlas row sampled clamped (wasm 11575).
**Wecra.** `Shaders.h:111–117`: the same four formulas; the ramp is 256 texels per row, clamped (`rampAt`, `Shaders.h:20–23`). Nothing to build.

### 2.21 Dither amplitude — **partial**, high (blur dither: probe contradicts static reading)
**Figma.** Analytic shadows and gradients dither by `(rand(gl_FragCoord) − 0.5) × 0.007843` (2/255), so ±1/255 on all four channels, alpha included. Pixels with α 0 are left alone; at α 1 the alpha is kept. rand = `fract(sin(dot(vec2(12.9898, 78.233), fragCoord))·43758.5453)` (wasm 11422 / 11575). The static reading shows no dither in the blur passes, but the probe's flat region after a blur showed 254 / 255 noise.
**Wecra.** ±½/255 interleaved-gradient noise on the alpha only (`dither`, `Shaders.h:344–349`; blur pass `:697–699`); gradients ±½/255 on rgb only (`:118–120`).
**Build.** One `figDither(vec4)` with Figma's hash and amplitude on all channels, with the α 0 / α 1 rules, used for gradients and analytic shadows. For blurs, follow probe 1.11 (keep dithering if Figma's blur output is confirmed noisy). Update `engine.md:644` and `:692`.

### 2.22 Gradient interpolation colour space — **missing**, medium (field ids now verified)
**Figma.** `Paint.interpolationColorSpace = 41` (`InterpolationColorSpace` DEFAULT 0, OKLAB 1, OKLCH 2, HSL 3, SRGB_LINEAR 4) and `Paint.interpolationHueMethod = 42` (`InterpolationHueMethod` SHORTER 0, LONGER 1, INCREASING 2, DECREASING 3). These are in `docs/research/figma/figma-schema-106.kiwi` (Paint message and enums at lines 1103–1116). The UI's default hue method is INCREASING, shown for the hue spaces. CSS export: DEFAULT → `in srgb` / `in display-p3` per document profile; OKLAB → `in oklab`; OKLCH → `in oklch <hue>`; HSL → `in hsl <hue>`; SRGB_LINEAR → `in srgb-linear` (3187). The NodeChange-level `interpolationColorSpace = 599` / `interpolationHueMethod = 600` in `docs/schema.md:685` are Motion's keyframe fields, not these.
**Wecra.** Not in the schema: Paint 41 / 42 are reserved `_r41` / `_r42` (`schema/document.kiwi:389`), so a `.fig`'s values are not kept. The ramp interpolates premultiplied sRGB only (`Renderer.cpp:249–282`). No panel control, no CSS (`src/viewer/inspect/css.ts:56–58`, `editor/model/exports.ts:302–310`).
**Build.**
1. Schema: un-reserve Paint 41 / 42 with Figma's names, plus the two enums (`schemagen --check`). `NODE_CHANGES`: no new NodeChange field; the paint lists (`fillPaints`, `strokePaints`, styles' paints) carry them.
2. Engine: `rampRow` takes the space and hue method into its hash and bakes the 256-texel row by converting the stops (straight alpha → space → interpolate → sRGB, then premultiply). The shader is unchanged.
3. Panel: the gradient picker's interpolation menu (Figma's wording; Turkish entries).
4. CSS / SVG: CSS `in …`; SVG export bakes extra stops when the space isn't DEFAULT.
Native test: an OKLCH ramp's midpoint equals the CSS Color 4 reference value.

### 2.23 Image scale-mode transforms — **partial**, high
**Figma.** FILL: translate(.5) · rotate(−rot) · scale(ratio/maxComponent) · translate(−.5); FIT the same with minComponent; STRETCH as stored; TILE: rotation **about the centre**, then scale(1/scalingFactor) · scale(boundsToImageRatio), tiles starting at the node's top-left. scalingFactor rescales by originalWidth / decodedWidth for smaller tiers (`imageTransformForGeometrySize` @470041). Sampling: 8 sub-pixel taps averaged; straight-alpha textures, premultiplied after sampling.
**Wecra.** FILL / FIT / STRETCH match (`imageMatrix`, `Renderer.cpp:74–97`; its copy in `export/Scene.cpp:248`). TILE rotates about the node's origin (`:85–88`). The tier rescale is equivalent: the original size is used when known (`:339–340`). Sampling is `textureGrad` at LOD −1, from the audit's sharpness calibration (`Shaders.h:99–101`).
**Build.** TILE: rotate about the centre in both copies of `imageMatrix`. Leave the sampling as calibrated.

### 2.24 Image colour adjustments — **different**, high
**Figma.** Shader order (@41681): linearise (pow 2.2) → shadows / highlights become an exposure offset `0.75x/√(1+4x²)` around `lum − 0.5^2.2` → CIELAB: b* += 30·temperature, a* += 30·tint, contrast on L* (positive: smootherstep 50 ± 30; negative: (L − 50)·0.2 + 50 mixed) → exposure with k = 10^(2e) − 1 and luminance-preserving desaturation (0.75) → saturation (vibrance) as a luminance mix with a gamut-limited boost (≤ 2×) → pow 1/2.2. Values are clamped to [−1, 1]. **Contrast is stored in [−0.3, 0.3]** (API contrast = kiwi / 0.3), and API `saturation` ↔ kiwi `vibrance` (3187).
**Wecra.** `adjust()` (`Shaders.h:29–41`) is an ad-hoc sRGB approximation ("unverified"). The panel stores contrast −1…1 (`editor/model/paints.ts:291–298`), so a Figma file's contrast reads ×3.3 weaker and ours writes values Figma clamps. The Plugin API reads `saturation` from `paintFilter`, which holds `vibrance` (`plugins/api/convert.ts:100, 122–124`), so saturation never round-trips.
**Build.** Port Figma's pipeline into `adjust()` (GL + WGSL; the export's PNG path uses the same shader). Panel: contrast UI ±100 ↔ stored ±0.3. Plugin API: `saturation ↔ vibrance`, `contrast = kiwi/0.3`. Tests: a vitest for the panel / API mapping; an engine-shot of the seven adjustments at ±1.

### 2.25 Blend-mode compositing — **done**, high
**Figma.** `uType` = the kiwi BlendMode; W3C formulas premultiplied; SOFT_LIGHT exact; HUE / SAT / COLOR / LUM with luma .30/.59/.11 and W3C ClipColor / SetSat; COLOR_BURN / DODGE with an epsilon of 1/255; LINEAR_BURN `max(0, s + d − αsαd)`; LINEAR_DODGE `min(1, s + d)`.
**Wecra.** `blendColor` (`Shaders.h:572–593`) and the composite (`:650–661`) match. The only gap is the 1/255 epsilon in COLOR_BURN / DODGE (ours compares to 0 / 1 exactly), a one-line change folded into §2.21's shader pass.

### 2.26 Plugin API effect clamps and names — **partial**, high
**Figma.** Shadows: radius [0, 250] with a warning (INNER / DROP only), spread [−30000, 30000], forced to 0 with a warning unless RECTANGLE / ROUNDED_RECTANGLE / ELLIPSE or a FRAME / COMPONENT / INSTANCE with visible fills and clipping. Progressive startRadius [0, 100]; texture radius [0, 100]; noiseSize [0, 100] (number = x, plus `noiseSizeVector {x, y}`, a mismatch throws). Names: FOREGROUND_BLUR ↔ LAYER_BLUR, GRAIN ↔ TEXTURE, CUSTOM ↔ SHADER; REPEAT / SYMMETRY read back as BACKGROUND_BLUR. `blurType` NORMAL / PROGRESSIVE. Variable bindings: shadow colour / radius / spread / offsetX / offsetY → colorVar / radiusVar / spreadVar / xVar / yVar; blur radius → radiusVar.
**Wecra.** `convert.ts:177–213`: the names and blurType are right; Glass is wrong (§2.14); no clamps, no spread rule, no `noiseSizeVector`, no SHADER name, no one-glass check.
**Build.** The clamps and warnings (`console.warn` via the plugin console), the spread rule, `noiseSizeVector`, `CUSTOM ↔ SHADER`, the glass mapping. Tests in `convert.test.ts`.

### 2.27 Effect field defaults and visibility — **partial**, high
**Figma.** Engine defaults: blendMode NORMAL, radius 0, startRadius 0, spread 0, visible true, showShadowBehindNode false, noiseType MONOTONE, noiseSize 0, clipToShape = (type == CUSTOM), blurOpType NORMAL, seed 0 (`Effect` ctor @497900). The JSON effect decoder defaults a missing showShadowBehindNode to **true** (`decodeEffects` @986189; which inputs use it is untraced: probe 1.9). The new-effect template: DROP_SHADOW, rgba(0,0,0,.25), offset (0, 4), radius 4, spread 0, visible, showShadowBehindNode false; inner shadow and the blurs take the same template with only the type changed. `isVisibleForRendering` (@494490): DROP_SHADOW enabled && α > 0; INNER_SHADOW also (radius > 0 || offset ≠ 0 || spread > 0); BACKGROUND / FOREGROUND blur enabled && (radius > 0 || startRadius > 0); GRAIN enabled && radius > 0; NOISE, GLASS, CUSTOM enabled.
**Wecra.** The panel template matches (`Effects.tsx:70–72`). Visibility in the renderer is `e.visible` plus the backdrop radius test (`Renderer.cpp:1522–1532`): a shadow at α 0, an empty inner shadow or a radius-0 texture still allocates layers.
**Build.** `bool visibleForRendering(const Effect&)` in `scene/` (used by the renderer, bounds, export and the render tree's `samplesBackdrop`), with Figma's rules. Native test per type.

---

## 3. Integration plan (ordered)

Every shader change goes into `gfx/gl/Shaders.h` and `gfx/wgpu/Shaders.h` together. After any C++ change: `npm run engine:test`, `SHOT_ONLY=… npm run engine:shot` on WebGL2 and WebGPU, then `npm run engine:build` (engine.wasm is committed). `docs/engine.md` §6.7 / §6.5 are rewritten in the same commits, as their contract text says.

1. **Glass fields (S, P1).** Depth ↔ `refractionRadius`, Splay ↔ `reflectionDistance`, `bevelSize` = 1. Files: `schema/document.kiwi` comments, `scene/Extras.h` defaults, `Renderer.cpp` `drawBackgroundBlur` / `backdropReach`, `Effects.tsx` (sliders, defaults, angle shown 0–359, one glass per node), `convert.ts`, `docSchema.ts` / `layerProps.ts` / `nodeSpec.ts`, `engine.md:696`. Load-time fix-up for Wecra-made files. Tests: native "extras", `convert.test.ts`, the agents' schema test.
2. **Visibility rules (S, P2).** `visibleForRendering` in `scene/`; used by `drawNode`, `effectsOutset`, `Export.cpp`, `RenderTree` backdrop flags. Native tests per type.
3. **Tent blur (M, P1).** Blur fragment tent + clamp-ready signature; `Layer::blur` holds a radius in device px; one ×2 level above 4 texels (halving chain kept above 128 texels); skip under 1 texel. All callers: layer blur, shadows, backdrop, progressive levels (interim), glass frost. `SvgWriter` / CSS keep `radius / 2`: that is what Figma's own SVG / CSS export writes.
4. **Analytic shadow tent CDF (S, P1).** `boxShadow` / `shadowX` with `g(h)`, the quad grown by R; inner variant. Calibration shot against the probe row (§2.1) at 1× and 2×.
5. **Reach and bounds (S, P2).** Asymmetric `effectsBounds` (sum of layer blurs, shadow offsets, unclipped texture); layer reach R + 1; `backdropReach` R + 1 (+ glass reach from item 11). Native test of the bounds; `render.cache.test.cpp` stays green (strip growth uses the reach).
6. **Defaults and seed (S, P2).** `defaultEffect` random seed, texture (4, 4), Multi 0.15; `EffectExtras` kiwi defaults. Vitest + native "extras".
7. **Plugin API (S, P2).** Clamps, warnings, spread rule, `noiseSizeVector`, SHADER, contrast / saturation for images. `convert.test.ts`.
8. **Effect op list (M, P2).** `drawNode` walks effects in array order (§2.10): every layer blur and texture compounds, noise over the content only, the first background-blur-or-glass only, shadows merged into a blur and into an unclipped texture, the inner-shadow / layer-blur order exception. Native command-list tests for each ordering.
9. **Background blur clamp (M, P2).** The clamp rect and per-tap rejection in the tent pass; the copy reach reduced to the stroke-grown box. Shot test with a bright neighbour.
10. **Silhouettes (S, P3; after probe 1.2).** Shadow, inner-shadow and backdrop masks from the hard silhouette; image alpha kept in the knockout; the clipping frame casts its box; the shadow cap lifted.
11. **Spread as geometry (M, P3).** Grown / shrunk rect, rrect and ellipse with the stroke growth, the vanish rule and the inner clamp; morphology off for shadows. Native tests (ellipse, OUTSIDE stroke).
12. **Noise and texture shaders (M, P3).** Figma's 3-octave gradient-noise fBm (shared function), density bands, three modes, supersampling, centred anchor; texture displacement and clip rule; the NOISE paint on the same function (probe the paint).
13. **Image adjustments (M, P3).** Figma's pipeline in `adjust()`; panel contrast ±0.3 storage. Shot of the seven sliders.
14. **Glass algorithm (L, P3).** Port §2.15 (smoothed rrect SDF, ramp, displacement, splay, 8-tap dispersion, highlights with frame rotation). Shots at three angles and a rotated frame.
15. **Dither and blend epsilon (S, P4).** `figDither` on all channels; COLOR_BURN / DODGE epsilon; blur dither per probe 1.11.
16. **Progressive blur (L, P4).** A variable-radius tent in two passes (perpendicular, then along the axis) with the sharp blend; drop the level pyramid (`blurLevels`, composite mode 5, PaintKind 7 intervals).
17. **Gradient interpolation (L, P4).** Schema Paint 41 / 42 + enums; ramp baking in OKLab / OKLCH / HSL / linear; the picker's menu (`t()` + Turkish); CSS `in …`; SVG baked stops. Native ramp test; vitest for CSS.
18. **Glass on any shape (L, P5).** Single-channel float targets in `gfx::Device` (both backends), the blurred-mask distance and normal, ellipses moved to it.
19. **TILE rotation about the centre (S, P5).** `imageMatrix` in `Renderer.cpp` and `export/Scene.cpp`.

---

## 4. Wecra-side notes that are not gaps

- The drop-shadow offset in absolute space, the knockout by geometry rather than alpha, the spread eligibility, the strokes-above-inner-shadows split, Figma's four gradient t functions and the W3C blend modes are already Figma's.
- CSS / SVG export writing `blur(radius / 2)` / `stdDeviation = radius / 2` (`src/viewer/inspect/css.ts:164–165`, `SvgWriter.cpp:672, 709, 725`) is Figma's export convention, not its renderer's; keep it.
- The panel lists effects reversed (`Effects.tsx:184`, top = last), as fills. Whether Figma's effects list is reversed is unverified (probe 1.10).

---

## 5. Probes still to run (when the MCP call limit resets, or by hand in Figma)

From the probe plan (1.x), with what each one decides:
- 1.2 Drop shadow of a 10 % fill: full or 10 %? Decides item 10.
- 1.3 Background blur beside a bright object outside the box: clamped? Confirms item 9.
- 1.4 Glass Depth / Splay in a saved `.fig` (decode with `dec2.py`): confirms item 1 on file data (the API mapping is already high confidence).
- 1.5 Two layer blurs; noise / texture / layer blur in both orders. Confirms item 8.
- 1.6 Noise on drop shadows; texture with clipToShape on the shadow. Confirms items 8 and 12.
- 1.7 A rotated node's drop-shadow offset (page space). Expected done.
- 1.8 / 1.10 UI defaults for noise and texture, and the effects list order (UI only, not through `use_figma`).
- 1.9 showShadowBehindNode when a plugin omits it.
- 1.11 Gradient and blur dither amplitude (slice histogram).
- 1.12 interpolationColorSpace in a saved `.fig` (field ids are now verified from `figma-schema-106.kiwi`; the probe checks the values Figma writes).
- 1.13 Glass on an ellipse, a vector and a text.
- 1.14 Spread on a non-eligible node (silently ignored?).

Method that works (from the run): export a 1 px slice (`figma.createSlice`, `resize(400, 1)`), base64 it, decode locally (the decoder must handle PNG filter types; `scratchpad/dec2.py`). Full frames are too long to copy reliably.
