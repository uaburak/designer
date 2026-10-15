# 08 — Effects: shadows, blurs, noise, texture, glass

Figma Design desktop 126.9.13, read 2026-10-16 from the cached editor build (`~/.cache/figma-rea/figma/`, outside the
repo) under `~/.cache/figma-rea/BRIEF.md`. Figma's code is not copied here. This file records behaviour, numbers,
enums and strings, each with its evidence. **CONFIRMED** = read directly in the build; **INFERRED** = deduced.

## 1. Scope and sources

**Scope.** Every effect type of the build (Drop shadow, Inner shadow, Layer blur, Background blur incl. progressive,
Noise, Texture, Glass, and the Beta shader "Custom" effect as far as it touches the effects panel), the effects
panel UI (rows, "+", the type picker, the settings window, per-type fields with defaults / ranges / steps / units),
count limits, mixed selections, effect styles, the canvas edit mode of progressive blur, export / CSS, and the
rendering numbers. The 3-D "Transform effects" rows (Perspective, Rotate 3D) that now share the panel are only
mentioned (§9). The shader effect authoring (generative effects) is out of scope.

**Sources read**

| Source | What it gave |
|---|---|
| `7535.min.js` @81198–@175000 (module 450865; `774.min.js` / `8936.min.js` are near-identical copies) | The whole UI3 effects panel: type picker @83527, glass callout, blur fields @~98000, glass fields + light dial @~100000–@104000, texture @~112000, noise @~114000, shadow @~127000–@137000, settings window, row summaries, count limits `au` @~166000, `EffectsPanel` / `EffectsList` / `Effect` row classes. |
| `8865.min.js` modules 868013 + 296653 | Effect templates per type (`IK`), the type-change / progressive fix-ups (`UF`), max 100 constants (`aO`, `ml`), the random seed, the shadow icon chooser. |
| `figma_app.min.js` @3733404 (module 398227) | The effect type order `Bf()`; module 379741: the type-name formatter; module 635687: classic / shader sections. |
| `9574.min.js` module 424871 | The "+" entry-point menu (effect types with icons, Beta badge, 3-D items). |
| `858.min.js` / `7621.min.js` | Effect-style tile warning for glass styles; the 9 drop / inner shadow icons by offset sign. |
| `3187.min.js` | CSS (Dev Mode) mapping of effects; Plugin API effect converter (already read by the prior report). |
| `2108.min.js` | Plugin API error "Only one glass effect is allowed per node." |
| `4989.min.js` | Lottie export-lint rules for effects. |
| `fullscreen__fullscreen-wasm__compiled_wasm.wasm` (`strings -n 6`, cited `wasm str #N`) | Class / pass / shader names, `containsOnlySpreadEligibleNodes`, `containsAnyKnockoutShadowEligibleNodes`, progressive-blur handle labels and edit-mode action, SVG export ids. |
| Prior REA report | [`docs/research/rea/effects.md`](../rea/effects.md) (2026-10-15): renderer, shaders, Plugin API clamps — summarised in §2, not redone. |
| Live captures | `docs/research/figma/live/popovers/effect-settings-*.txt`, `effect-type-menu.txt`, `effect-styles.txt`, `design/rectangle-with-effect.txt` — English labels. |

The build ships i18n **keys** only; English text below is given only where a live capture or the repo's i18n
attests it (marked *live* / *repo*).

## 2. Prior findings (renderer, Plugin API) — one line each

All CONFIRMED in the prior report unless it says otherwise; section links point into
[`docs/research/rea/effects.md`](../rea/effects.md).

| # | Finding | Link |
|---|---|---|
| P1 | Every blur (layer, background, shadow, glass frost) is a separable **tent** of half-width = radius (σ ≈ R/√6), at most 64 taps, skipped under 1 device px; probe-confirmed. | [§2.1](../rea/effects.md#21-blur-kernel-layer-background-shadow-glass-frost--different-high-probe) |
| P2 | Blur resolution: `scaleLimitForBlursAndEffects(r) = 1/(1+2r)`, radius ≤ 128 texels, one ×2 bilinear downsample above 4 texels. | [§2.2](../rea/effects.md#22-blur-resolution-and-downsampling--different-same-look-high) |
| P3 | Bounds: Σ layer-blur radii; drop shadows offset ± (radius + spread) asymmetric; inner shadow / bg blur / glass / noise don't grow bounds; texture grows them only when not clipped. | [§2.3](../rea/effects.md#23-blur-bounds-expansion--partial-high) |
| P4 | Analytic rect / rrect shadow uses the triangle **CDF** `g(h)` (0.5(h+1)² …), 4 samples for the rounded case. | [§2.4](../rea/effects.md#24-analytic-rect--rounded-rect-shadow--different-high) |
| P5 | Shadow silhouette: any visible, not fully transparent paint casts at full strength (probe pending). | [§2.6](../rea/effects.md#26-drop-shadow-silhouette-ignores-fill-opacity--different-medium-probe-pending) |
| P6 | Drop-shadow pipeline: offset in absolute space → spread → colour → tent → knockout unless `showShadowBehindNode` (skipped when node opaque) → effect blend; first entry bottom-most. | [§2.7](../rea/effects.md#27-drop-shadow-pipeline-and-order--done-small-gaps-high) |
| P7 | Spread only for rect / ellipse-like or frame-like with visible fill **and** clipsContent; geometry regenerated at size + 2s with radii ± s; visible non-INSIDE stroke grows size first; drop shadow vanishes at size ≤ −2s; inner spread ≥ −size/2. | [§2.8](../rea/effects.md#28-shadow-spread--partial-high) |
| P8 | Inner shadow visible only if α>0 and (radius>0 ∨ offset≠0 ∨ spread>0); drawn fills → inner shadows → strokes (exception with a layer blur). | [§2.9](../rea/effects.md#29-inner-shadow--partial-high) |
| P9 | Per-node order: first visible BACKGROUND_BLUR **or** GLASS only; then layer blurs / texture / noise **in array order**, compounding; noise never on shadows. | [§2.10](../rea/effects.md#210-per-node-effect-order--partial-high) |
| P10 | Background blur samples are clamped to the node box (taps outside get weight 0, renormalised). | [§2.11](../rea/effects.md#211-background-blur-clamped-to-the-node-box--missing-high) |
| P11 | Background-blur mask = the node's hard silhouette (fill ∪ stroke), not its alpha. | [§2.12](../rea/effects.md#212-background-blur-mask--partial-medium) |
| P12 | Progressive blur: offsets are fractions of size; per-pixel `count = mix(start, end, t)`, two passes (perpendicular, then along), sharp blend under ~1 texel; start == end falls back to uniform. | [§2.13](../rea/effects.md#213-progressive-blur--different-high) |
| P13 | Glass fields: Depth ↔ `refractionRadius` [1,100], Splay ↔ `reflectionDistance` [0,1], `bevelSize` always 1; one glass per node. | [§2.14](../rea/effects.md#214-glass-field-mapping--different-high-fixes-our-doc) |
| P14 | Glass algorithm: dispersion × 0.2, rd = min(halfW, halfH, depth), ramp^3.5 displacement, splay mixes normal→radial, 8-tap dispersion, highlights `smoothstep(.35,1,…)`, opposite side 0.6×. | [§2.15](../rea/effects.md#215-glass-rendering-algorithm--different-high) |
| P15 | Glass on non-rect shapes via a blurred F32 mask (`GLASS_ARBITRARY_SHAPE`). | [§2.16](../rea/effects.md#216-glass-on-arbitrary-shapes--missing-high) |
| P16 | Noise: 3-octave gradient-noise fBm, centred on the node, density band(s) around 0.25 (and 0.75 for duotone), MULTI / MONO / DUO maths. | [§2.17](../rea/effects.md#217-noise-effect-shader--different-high) |
| P17 | Texture: smooth fBm displacement × radius; clipToShape keeps the silhouette and doesn't grow bounds. | [§2.19](../rea/effects.md#219-texture-grain--different-high) |
| P18 | Dither ±1/255 on all channels (analytic shadows, gradients). | [§2.21](../rea/effects.md#221-dither-amplitude--partial-high-blur-dither-probe-contradicts-static-reading) |
| P19 | Plugin API: shadow radius [0,250], spread [−30000,30000] (forced 0 with a warning on ineligible nodes), progressive startRadius [0,100], texture radius [0,100], noiseSize [0,100]; names FOREGROUND_BLUR↔LAYER_BLUR, GRAIN↔TEXTURE, CUSTOM↔SHADER. | [§2.26](../rea/effects.md#226-plugin-api-effect-clamps-and-names--partial-high) |
| P20 | Engine defaults and `isVisibleForRendering` per type (blur visible if radius>0 ∨ startRadius>0; texture if radius>0; noise / glass always). | [§2.27](../rea/effects.md#227-effect-field-defaults-and-visibility--partial-high) |

## 3. Effect types, order, names, limits

### 3.1 The type list (picker and "+" menu order) — CONFIRMED

`Bf()` (figma_app @3733404, module 398227) returns `[...["INNER_SHADOW","DROP_SHADOW"], ...["FOREGROUND_BLUR","BACKGROUND_BLUR"], "NOISE","GRAIN","GLASS"]` plus `"CUSTOM"` when the shader-effects flag is on.

| # | kiwi type | Panel name (key → English) | Plugin API name |
|---|---|---|---|
| 1 | INNER_SHADOW | `fullscreen.properties_panel.effects.inner_shadow` → "Inner shadow" *live* | INNER_SHADOW |
| 2 | DROP_SHADOW | `…effects.drop_shadow` → "Drop shadow" *live* | DROP_SHADOW |
| 3 | FOREGROUND_BLUR | `…effects.layer_blur` → "Layer blur" *live* | LAYER_BLUR |
| 4 | BACKGROUND_BLUR | `…effects.background_blur` → "Background blur" *live* | BACKGROUND_BLUR |
| 5 | NOISE | `…effects.noise` → "Noise" *live* | NOISE |
| 6 | GRAIN | `…effects.texture` → "Texture" *live* | TEXTURE |
| 7 | GLASS | `…effects.glass` → "Glass" *live* | GLASS |
| 8 | CUSTOM (flag) | `…effects.custom` (row) / `…effects.custom_effect` (picker) → "Shader" *live* | SHADER |

Transform-modifier types REPEAT and SYMMETRY share the Effect message (formatter names them via
`transform_modifiers.repeat/symmetry`) but are not in the effects menu (`w.REPEAT = null`, 9574 module 424871).

In the "+" menu (9574 424871) a separator precedes CUSTOM, which carries a **Beta** badge (`general.beta`), and
when 3-D transform effects are enabled, "Rotate 3D"/"Perspective" items follow after a separator (§9). CONFIRMED.

### 3.2 Per-type count limits — CONFIRMED

`au` (7535 @~166000): **DROP_SHADOW 8, INNER_SHADOW 8, FOREGROUND_BLUR 1, BACKGROUND_BLUR 1, NOISE 2, GRAIN 1,
GLASS 1, CUSTOM 10** (REPEAT 5, SYMMETRY 1). A type whose count across the selection's list (classic + shader
sections) is ≥ its limit is `"disallowedForCount"`: it is greyed in the "+" menu and in the type picker of other rows
(the current row's own type stays enabled), with tooltip `properties_panel.effects.already_applied`. A second state
`"disallowedForGlassType"` shows `properties_panel.effects.glass.non_frame_warning` (the computation no longer sets
it in this build — INFERRED: legacy of frame-only glass; arbitrary-shape glass ships, see the callout in §6.6).

INFERRED consequence: in the UI a node can hold only one layer blur and one background blur, although the renderer
compounds several (P9 — reachable through the Plugin API or files).

### 3.3 Row icons — CONFIRMED

`vG()` (8865 868013): shadows pick one of 9 icons keyed by `sign(offset.x)` + `sign(offset.y)` ("00","01","0-1",
"10","11","1-1","-10","-11","-1-1"; 858 / 7621); blurs have separate icons for uniform and progressive; noise,
texture, glass, shader one each.

## 4. Templates and defaults

### 4.1 New effect template — CONFIRMED (8865 296653 `j()`, 868013 `IK()`)

Base (`j()`): `blendMode NORMAL, color rgba(0,0,0,0.25), offset (0,4), radius 4, spread 0, type DROP_SHADOW,
visible true, showShadowBehindNode false`. `IK(type)` spreads the base and sets `type`:

| Type | Extra fields at creation | Resulting visible fields |
|---|---|---|
| DROP_SHADOW / INNER_SHADOW | — | X 0, Y 4, Blur 4, Spread 0, #000 25 % |
| FOREGROUND_BLUR / BACKGROUND_BLUR | — | Uniform, Blur 4 |
| GRAIN (Texture) | then `UF` adds noiseSize (4,4), clipToShape false, seed | Size 4, Radius 4 (base radius), Clip to shape off |
| NOISE | color #000 25 %, opacity 0.25; then `UF` adds noiseType MONOTONE, noiseSize (0.5,0.5), density 1, secondaryColor #FFF 25 %, seed | Mono, Size 0.5, Density 100 %, Color #000 25 % |
| GLASS | refractionIntensity .8, refractionRadius 20, specularIntensity .8, specularAngle −45, bevelSize 1, chromaticAberration .5, secondaryColor #FFF α 0; `UF` adds reflectionDistance 0 | Light −45° 80 %, Refraction 80, Depth 20, Dispersion 50, Frost 4 (base radius), Splay 0 |
| CUSTOM | `UF` adds clipToShape true when absent | — |

Seed = `floor(1e4 · Math.random())` (0…9999), added only when the effect's seed is falsy (so seed 0 is re-rolled).

"+" without a menu adds `IK("DROP_SHADOW")` (`addProperty`, 7535). With the entry-point menu (shown when 3-D
effects or shader effects are enabled) the chosen type's template is added. CONFIRMED.

### 4.2 Changing type (`UF(effect, newType, blurOpType?, nodeKind?)`) — CONFIRMED

The type picker writes `{...oldEffect, type: newType, ...UF(...)}`: **every existing field is kept** (shadow →
layer blur keeps radius 4 and the shadow's colour / offset silently). `UF` fills only missing / falsy fields:

- GRAIN: noiseSize (4,4), clipToShape false, seed.
- NOISE: noiseType MONOTONE, noiseSize (0.5,0.5), **opacity 0.15** (when falsy), density 1, secondaryColor #FFF 25 %, seed.
- GLASS: refractionRadius 20, specularAngle −45, specularIntensity .8, bevelSize 1, chromaticAberration .5,
  reflectionDistance 0, refractionIntensity .8, secondaryColor #FFF α 0. (Falsy test: a stored angle 0 or
  intensity 0 is reset to the default on type change.)
- Blur with blurOpType PROGRESSIVE: radius = min(radius, 100), startRadius = min(startRadius, 100); startOffset /
  endOffset default to **(0.5, 0) → (0.5, 1)** (top-centre → bottom-centre), or **(0, −0.5) → (1, −0.5)** when the
  selection is only LINE nodes (`xn(numSelectedByType) === "LINE"`).
- CUSTOM: clipToShape true if absent.

Toggling Uniform ↔ Progressive calls the same `UF` with the new blurOpType (so going progressive clamps both radii
to 100). Switching back to NORMAL keeps startRadius / offsets in the data.

## 5. The effects panel (UI3)

### 5.1 Section and rows — CONFIRMED (7535 `EffectsPanel`, `EffectsList`, `Effect`)

- Section title `properties_panel.effects.effects` ("Effects" *live*); "+" tooltip
  `fullscreen.properties_panel.section_effects.tooltip_addEffect` ("Add effect" *live*); style button
  "Effects, Apply styles" *live* (style type `EFFECT`, field `inheritEffectStyleKey`).
- Row: eye toggle (left), effect button (icon + type name; for a shader, its display name), minus
  (`fullscreen.properties_panel.tooltip_remove`). Rows can be dragged to reorder. In the revamped panel the eye is
  shown only on hover / focus / when the effect is hidden / while its settings are open.
- Large-preview rows (Draw / illustration mode) add a **value summary** (formatter max 2 decimals; percent formatter):

| Type | Summary parts |
|---|---|
| Drop / Inner shadow | `X {x}` `Y {y}` `B {radius}` `S {spread}` (keys `properties_panel.effects.x/y/b/s`) |
| Layer / Background blur | `Uniform {r}` or `Progressive {start} → {end}` |
| Texture | `Size {s}` or `Size X {x}` `Size Y {y}` when different, then `R {radius}` |
| Noise | `Mono/Duo/Multi`, size as texture, `D {density%}` |
| Glass | `A {specularAngle}°` (raw stored value), `I {intensity%}` |

- Clicking a row's button opens its **settings window**; a newly added effect opens its window automatically
  (`lastAddedItemIndexAtom`). Clicking again or outside closes it.
- **Editing any field of a hidden effect makes it visible** (`onChange` sets `visible = true`). CONFIRMED.
- Remove deselects the property; removing all also detaches an applied effect style (`applyStyleToSelection(…, "-1:-1")`).
- Effects split into a "classic" list and a separate **shader effects** list headed
  `fullscreen.properties_panel.shader_chooser.title_effects` (module 635687); storage order is interleaved, display
  indices map back to storage indices.

### 5.2 Mixed selections — CONFIRMED

When the selected nodes' effect lists differ, the list is MIXED: the panel shows
`fullscreen.properties_panel.click_plus_to_replace_mixed_content` ("Click + to replace mixed effects" *repo*), and
"+" replaces every node's list with `[newEffect]` (old lists discarded; one commit). The revamped panel can instead
edit per-section when only one section is mixed (`effects-panel-edit-*-mixed`, writes each node's list via
`gC()`). Individual mixed field values show `fullscreen.mixed` ("Mixed").

### 5.3 Settings window — CONFIRMED

- Header: the **type picker** (dropdown; min width 160 px; hovering an option **previews** it live with a 50 ms
  debounce, `effect-type-dropdown`), and a **blend-mode** button only for DROP_SHADOW, INNER_SHADOW and NOISE.
- Body per type (§6). Footer: a variable-scope hint `EFFECT_FLOAT`.
- Width: shader effects 280 (resizable 280–480); others the default floating-window width.
- Opens at the row (`_H(rowEl, width)`), closes on outside click unless the click is inside `#fullscreen-root`.
- Number fields: resolution 0.1, scrub multiplier 0.1, wheel multiplier 4, nudge = the global small / big nudge
  (1 / 10 by default — INFERRED from the shared nudge props). Draw's slider variant ("illustration slider inputs")
  replaces fields with slider + field rows; ranges below give both.

## 6. Per-type fields

### 6.1 Drop shadow / Inner shadow — CONFIRMED (7535 `nc` / `nd` / `nu`)

| Field (label key → English) | Stored | Input range | Slider range | Notes |
|---|---|---|---|---|
| Position X / Y (`fullscreen.properties_panel.effects.position` → "Position" *live*) | offset.x / .y px | −30000…30000 | −300…300 | vars `xVar` / `yVar` |
| Blur (`fullscreen.properties_panel.effects.blur` → "Blur" *live*) | radius px | 0…**250** | 0…100 | var `radiusVar`; tooltip `properties_panel.effects.blur_radius` |
| Spread (`…effects.spread` → "Spread" *live*) | spread px | −30000…30000 | −300…300 | **disabled** unless `selectionContainsOnlySpreadEligibleNodes`; var `spreadVar` |
| Color (`properties_panel.effects.color` → "Color" *live*) | color RGBA | hex + opacity % | — | variable scope `EFFECT_COLOR`; colour picker with library variables |
| Show behind transparent areas (`properties_panel.effects.show_behind_transparent_areas` → *repo*) | showShadowBehindNode | checkbox | — | **DROP_SHADOW only**, shown only when `selectionContainsAnyKnockoutShadowEligibleNodes` (wasm str 17422) |

Spread tooltip when disabled, by cause (first match): frame-like without visible fills →
`properties_panel.effects.spread_fills_warning`; frame-like without clipping → `spread_clip_warning`; otherwise
`spread_rect_ellipse_warning`. When enabled the tooltip is just "Spread". (English unattested.)

Editing X / Y / Blur / Spread / Color detaches the corresponding bound variable.

### 6.2 Layer blur / Background blur — CONFIRMED (7535 `tA` / `tS` / `tI`)

| Field | Stored | Range | Notes |
|---|---|---|---|
| Type (`properties_panel.effects.blur.type` → "Type", segmented "Uniform" / "Progressive" *live*; keys `…blur.type.normal/progressive`) | blurOpType NORMAL / PROGRESSIVE | — | toggling runs `UF` (§4.2) |
| Blur (uniform) | radius | input min 0, **no max**; slider max **500 for Layer blur**, **100 for Background blur** | var `radiusVar` |
| Start (`…blur.start_blur` → "Start" *live*) | startRadius | 0…100 | progressive only; var `startRadiusVar` (motion flag) |
| End (`…blur.end_blur` → "End" *live*) | radius | 0…100 | progressive only |

Progressive **canvas edit mode**: opening the settings of a progressive blur enters edit mode
`PROGRESSIVE_BLUR` (action `toggle-progressive-blur-edit-mode`, wasm str 27563); closing it, or switching the open
effect to a non-progressive / non-blur, leaves it. The canvas shows two draggable handles (start / end,
`progressive_blur.start_handle_label` / `end_handle_label`, `ProgressiveBlurMoveHandleBehavior`) that move
startOffset / endOffset. Hovering or focusing the Start / End field highlights the matching handle
(`setProgressiveBlurHandleTypeSelection(START|END|NONE)`). CONFIRMED.

### 6.3 Noise — CONFIRMED (7535 `nn` / `nt` / `ne`)

| Field | Stored | Range / unit | Notes |
|---|---|---|---|
| Noise type (`properties_panel.noise.noise_type` → "Noise type"; "Mono" / "Duo" / "Multi" *live*) | noiseType MONOTONE / DUOTONE / MULTITONE | segmented, in that order | |
| Noise size X / Y ("Noise size" *live*) | noiseSize {x,y} | input max 100; slider 0.01…100 **exponential** | Y is **linked** to X while both equal and unbound; clearing Y re-links it to X |
| Density ("Density" *live*) | density 0…1 | percent field | var `densityVar` |
| Opacity (`…noise.opacity`) | opacity 0…1 | percent | **Multi only**; var `effectOpacityVar` |
| Color / Colors (`…noise.color` with `numColors` 1 or 2) | color (+ secondaryColor for Duo) | colour chits | Mono: 1, Duo: 2, Multi: none |

Duotone: the open chit (primary / secondary) is reported to the canvas (`setDuotoneNoiseColorTypeSelection`).
Blend mode button available (§5.3).

### 6.4 Texture (GRAIN) — CONFIRMED (7535 `t8` / `t4` / `t5`)

| Field | Stored | Range | Notes |
|---|---|---|---|
| Size X / Y (`…texture.noise_size` → "Size" *live*) | noiseSize | input max 100; slider 0.01…100 exponential | linked Y as noise |
| Radius (`…texture.radius` → "Radius" *live*) | radius | 0…100 (slider 0.01…100 exponential) | var `radiusVar` |
| Clip to shape (`…texture.clip_to_shape` → "Clip to shape" *live*) | clipToShape | checkbox | |

No blend-mode button.

### 6.5 Glass — CONFIRMED (7535 `tJ`, `tZ`, `tF`, `tG`, `tK`)

| Field (English *live*) | Stored | Shown | Range | Step | Variable field |
|---|---|---|---|---|---|
| Light angle (dial + field) | specularAngle (deg) | field shows **−180…180** (stored > 180 shown − 360) | written wrapped to 0…359 | 1 | specularAngleVar |
| Light intensity | specularIntensity 0…1 | percent | 0…100 % | nudge 0.01 / 0.1 | specularIntensityVar |
| Refraction | refractionIntensity | ×100 | 0…100 | 1 | refractionIntensityVar |
| Depth | refractionRadius | as is | **1…100** | 1 | refractionRadiusVar |
| Dispersion | chromaticAberration | ×100 | 0…100 | 1 | chromaticAberrationVar |
| Frost | radius | as is | 0…100 | 1 | radiusVar |
| Splay | reflectionDistance | ×100 | 0…100 | 1 | splayVar |

Sliders are linear, label right of a narrow scrub field. Light dial (`light-angle-control`): angle = atan2 from the
dial centre, 0° = up, clockwise; while dragging, **Shift snaps to multiples of 45°**, otherwise it snaps to the
nearest 45° when within **4°**, **Ctrl** disables snapping; drag commits on release. The dial's glow opacity =
(0.1 + 0.9·clamp(I,0,1)^0.6) × (0.2 in dark theme, 1 in light).

No blend-mode button. `bevelSize` is not editable (always 1, P13).

### 6.6 Glass callout and styles — CONFIRMED

- First time a glass row opens: a callout "Glass Arbitrary Shapes Callout" (`properties_panel.effects.glass.callout.title/body`, buttons `learn_more` → `/community/file/1522715486231239473`, `got_it`), stored as seen in `seen_glass_arbitrary_shapes_callout`.
- An **effect style** containing GLASS shows `properties_panel.effects.glass.style.non_frame_warning` on its style tile when non-frame-likes are selected (858 `eo()`).
- Plugin API: a second glass throws "Only one glass effect is allowed per node." (2108).

### 6.7 Shader (CUSTOM)

Picked from the menu as "Shader" (Beta); opens a shader chooser instead of a template; row name = shader display
name; up to 10; listed in their own section; buttons `properties_panel.effects.open_code_component` /
`create_code_component`; reset to default. Not further covered here.

## 7. Effect styles — CONFIRMED / INFERRED

- Style type `EFFECT`; nodes keep `inheritEffectStyleKey` / `effectStyleId` / `inheritEffectStyleId` /
  `softDeletedEffectStyleId` (wasm str 12679, 30463–30465). A style holds the whole effect list.
- The panel's style button lists "Effect styles" / "No effect styles." *live*; applying replaces the node's list;
  a style consumer (node with an applied style) shows the style name instead of rows; editing a row detaches
  (generic style-panel behaviour, INFERRED from `nk.yT` shared helpers).
- Removing all effects detaches the style (§5.1). Style tiles for glass styles carry the non-frame warning (§6.6).
- Create-style modal reuses the same rows (`create-style-grid-*` picker ids).

## 8. Rendering, bounds, export, clip

| Topic | Value | Status / evidence |
|---|---|---|
| Kernel | tent, half-width = radius, ≤ 64 taps | CONFIRMED, P1 |
| Analytic shadow | triangle CDF | CONFIRMED, P4 |
| Effect bounds | asymmetric, Σ blur radii, shadow offsets | CONFIRMED, P3; wasm `effectBoundsExpansions`, `maxEffectRadius` |
| Clip by parent | a clipping frame clips its children's effects; a node's own effects are not clipped by its own clipsContent (shadows drawn outside) | INFERRED (standard; no contrary code seen) |
| Background-blur clamp | to the node box + stroke | CONFIRMED, P10 |
| SVG export | filter ids `effect%d_dropShadow_%s`, `effect%d_innerShadow_%s`, `effect%d_foregroundBlur_%s`, `effect%d_noise_%s`, `effect%d_texture_%s` (no background-blur / glass filter) | CONFIRMED wasm str 18063–18070 |
| CSS (Dev Mode) | DROP / INNER → `box-shadow` (inset for inner; `x y blur spread color`); on vectors / groups DROP → `filter: drop-shadow(x y r color)`; LAYER_BLUR → `filter: blur()`, BACKGROUND_BLUR → `backdrop-filter: blur()` (blur value = radius/2 per prior report); NOISE, TEXTURE, GLASS, SHADER emit nothing; only visible effects | CONFIRMED 3187 |
| Lottie export lint | shadows, noise / texture, glass "may change"; shader effect unsupported | CONFIRMED 4989 |

## 9. Transform effects (3-D) in the effects section

The revamped panel adds a "Transform effects" header (`fullscreen.properties_panel.effects.transform_effects`)
with **Perspective** (`…effects.perspective`, row "P {n}") and **Rotate 3D** (`…effects.rotate_3d`, "X/Y/Z")
rows, copy / cut / paste of `scene3d` / `transform3d`, Delete key removal. Out of this chapter's scope; listed so
the panel's layout is complete. CONFIRMED (7535 `nG`, `n3`).

## 10. Edge cases

- Hidden effect + edit → becomes visible (§5.1).
- Type change keeps foreign fields (§4.2); a glass with angle 0 changed away and back resets angle to −45.
- Progressive radii above 100 are clamped when switching to progressive; uniform layer blur has no input max.
- Shadow blur field max 250 (= Plugin API clamp).
- Spread disabled (not hidden) on ineligible selections; the stored spread stays and is ignored by the renderer (P7).
- "Show behind transparent areas" hidden when no node in the selection is knockout-eligible.
- One layer blur / one background blur / one texture / one glass / two noises per node through the UI.
- Mixed lists: "+" replaces all.
- Effects on LINE nodes: progressive offsets run along the line.

## 11. UI strings

i18n keys of the area (English *live* = captured in `docs/research/figma/live`, *repo* = `src/shared/i18n`):

- `fullscreen.properties_panel.effects.drop_shadow` "Drop shadow" *live*; `.inner_shadow` "Inner shadow" *live*; `.layer_blur` "Layer blur" *live*; `.background_blur` "Background blur" *live*; `.noise` "Noise" *live*; `.texture` "Texture" *live*; `.glass` "Glass" *live*; `.custom` / `.custom_effect` "Shader" *live*.
- `properties_panel.effects.effects` "Effects" *live*; `fullscreen.properties_panel.section_effects.tooltip_addEffect` "Add effect" *live*.
- `fullscreen.properties_panel.effects.position` "Position" *live*; `.blur` "Blur" *live*; `.spread` "Spread" *live*; `properties_panel.effects.color` "Color" *live*; `properties_panel.effects.x` / `.y` / `.b` / `.s` / `.r` / `.d` / `.p` (single letters); `properties_panel.effects.s_size`, `s_size_x`, `s_size_y`; `properties_panel.effects.blur_radius`.
- `properties_panel.effects.show_behind_transparent_areas` "Show behind transparent areas" *repo*.
- `properties_panel.effects.spread_fills_warning`, `spread_clip_warning`, `spread_rect_ellipse_warning` (English unattested).
- `properties_panel.effects.blur.type` "Type" *live*; `.blur.type.normal` "Uniform" *live*; `.blur.type.progressive` "Progressive" *live*; `.blur.start_blur` "Start" *live*; `.blur.end_blur` "End" *live*.
- `properties_panel.noise.noise_type` "Noise type" *live*; `properties_panel.noise.noise_size` "Noise size" *live*; `properties_panel.effects.noise.type.mono/duo/multi` "Mono" / "Duo" / "Multi" *live*; `properties_panel.effects.noise.density` "Density" *live*; `properties_panel.effects.noise.opacity`; `properties_panel.effects.noise.color` (plural by `numColors`) "Color" *live*.
- `properties_panel.effects.texture.noise_size` "Size" *live*; `.texture.radius` "Radius" *live*; `.texture.clip_to_shape` "Clip to shape" *live*.
- `properties_panel.effects.glass.light` "Light" *live*; `.glass.refraction` "Refraction" *live*; `.glass.depth` "Depth" *live*; `.glass.chromatic_aberration` "Dispersion" *live*; `.glass.frost` "Frost" *live*; `.glass.splay` "Splay" *live*; `.glass.specular_angle`, `.glass.specular_intensity`, `.glass.angle_a`, `.glass.intensity_i`; `.glass.non_frame_warning`; `.glass.style.non_frame_warning`; `.glass.callout.title/body/learn_more/got_it`.
- `properties_panel.effects.effect_type`, `properties_panel.effects.effect_settings`, `properties_panel.effects.already_applied`, `properties_panel.effects.open_code_component`, `properties_panel.effects.create_code_component`.
- `fullscreen.properties_panel.click_plus_to_replace_mixed_content` "Click + to replace mixed effects" *repo*; `fullscreen.mixed` "Mixed".
- `fullscreen.properties_panel.tooltip_remove` "Remove"; `general.beta` "Beta".
- Styles: "Effect styles", "No effect styles." *live*.
- Plugin API: "Only one glass effect is allowed per node." (2108).
- Canvas: `progressive_blur.start_handle_label`, `progressive_blur.end_handle_label`.
- Export lint: `fullscreen.properties_panel.export_lint.drop_shadow_description`, `.noise_description`, `.glass_description`.

## 12. DesignerV2 today

Compared with `src/renderer/src/editor/panels/design/Effects.tsx`, `editor/model/glass.ts`, `engine/src/scene/Extras.*`,
`engine/src/render/Renderer.cpp`.

| Area | DesignerV2 | Verdict |
|---|---|---|
| Type order Inner, Drop, Layer, Background, Noise, Texture, Glass (+Shader) | `EFFECT_TYPES` same | matches |
| Templates (shadow 0/4/4/0 #000 25 %, noise, texture (4,4) r4, glass defaults, random seed) | `defaultEffect`, `GLASS_DEFAULTS` | matches (prior fixes landed) |
| Blend button for shadows + noise only | `hasEffectBlend` | matches |
| Count limits 8/8/1/1/2/1/1/10 | only "one glass" (`glassTaken`) | **missing** (shadows, blurs, texture, noise unlimited in UI) |
| Type change keeps all fields + `UF` fill-ins | rebuilds from the template, keeps radius only | differs |
| Progressive: clamp radii to 100, Start / End max 100, LINE offsets | no clamp, no max, no LINE case | **missing** |
| Progressive canvas handles / edit mode | none found | **missing** |
| Blur slider max 500 (layer) / 100 (background); shadow blur input max 250; spread / position ±30000, sliders ±300 | no max on shadow blur / spread / position | differs |
| Spread disabled + three warnings on ineligible selections | always enabled | **missing** |
| "Show behind transparent areas" condition | shown when not all fills opaque | close (Figma: knockout-eligible nodes) |
| Glass angle field −180…180, dial snapping (Shift 45°, 4° magnet, Ctrl free) | 0…359 field, arrow keys ±1 / Shift ±15 | differs |
| Noise / texture size Y linked to X, exponential sliders 0.01…100 | separate X / Y fields | differs |
| Editing a hidden effect makes it visible | not seen | missing (unverified) |
| Row value summaries (Draw rows) | name only | missing |
| Mixed: "Click + to replace mixed effects" | present | matches |
| Renderer (tent, CDF, order, clamp, glass, noise) | see prior report §2 | per [`rea/effects.md`](../rea/effects.md) |
| Renderer cap of 8 shadows | `Renderer.cpp:1560` "up to eight" | matches the UI limit; Figma's renderer itself has no cap |

## 13. Open questions

| Question | Live probe that settles it |
|---|---|
| English of the spread warnings and of `already_applied` / `glass.non_frame_warning` | Hover the disabled Spread field on a frame without fill / without clip / a vector; hover a greyed menu entry. |
| Exact knockout-eligibility rule behind `containsAnyKnockoutShadowEligibleNodes` | Select an opaque rect, a 50 % rect, an image, a group; see when the checkbox appears. |
| Is `disallowedForGlassType` ever set in 126.9 (glass on vectors/text)? | Add Glass to a vector and a text layer; check the menu state. |
| Global nudge amounts in the effect window (1 / 10?) | Arrow / Shift+Arrow in Blur. |
| Effect style editing flow (edit style popover fields, detach icon) | Create an effect style, open "Edit style". |
| Progressive handle drag constraints (snapping, clamping outside the node) | Drag a handle past the node edge with / without Shift. |
| Whether the light dial also accepts keyboard arrows | Focus the dial, press arrows. |
