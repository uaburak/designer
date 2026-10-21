# Motion for agents — what a model needs to make motion graphics natively in Wecra (2026-10-21)

The owner's idea: a model like Claude Opus makes good motion when it writes GSAP / Remotion / Framer Motion / CSS code
and renders it (sketch → animated UI, logo stings, stat reveals, product promos). Wecra already has a native Motion
editor (docs/motion.md) with agent tools in Figma's Plugin API shapes (§9.1). This note audits what such a model needs,
what Wecra has for each item, and designs what to add so an agent — in the Agents panel or over MCP — gets results as
good as code, while everything stays **native**: keyframe tracks and presets in the timeline, editable by hand, played by
the prototype player and exported as MP4 / WebM / GIF / SVG / Lottie.

Status: Part A (audit + design) and **phase 1 built the same day** (see §5 and docs/motion.md §9.2).

## 1. How a model works when it writes motion code

What a code-writing model leans on, in order of how much it matters to the result:

1. **A timeline language.** GSAP's `gsap.timeline()` with the position parameter (`"<"`, `">"`, `"+=0.2"`, `"-=0.1"`,
   `"<0.1"`, labels, `"label+=0.3"`), `stagger` (`each` / `amount`, `from: "start" | "center" | "end" | "edges" |
   "random" | index`), `from` / `to` / `fromTo`, `keyframes`, `repeat` / `yoyo` / `repeatDelay`, defaults. Remotion is
   frame arithmetic (`interpolate(frame, [0, 30], [0, 1], {easing})`, `spring({frame, fps, config})`, `<Sequence from>`).
   Framer Motion is per-element `initial` / `animate` / `transition {delay, staggerChildren, type: "spring"}`. The common
   core: **relative placement in time, many targets at once with a stagger, from-values that render before the tween
   starts**. Writing absolute keyframe times by hand for 20 layers is where a model makes mistakes; a sequencing language
   removes them.
2. **The full easing vocabulary**: GSAP's `power1…4` / `sine` / `expo` / `circ` × `in` / `out` / `inOut`, `back(s)`,
   `elastic(a, p)`, `bounce`, `steps(n)`, `none`; CSS `cubic-bezier()` and `ease*`; springs with physics parameters
   (Framer's `stiffness` / `damping` / `mass`, Remotion's `config`), bounce / duration springs.
3. **Property coverage**: transform (x, y, scale, scaleX/Y, rotate, skew, transform-origin), opacity / autoAlpha, fill and
   stroke colours, gradient stops, corner radius, width / height, blur and shadow, **text split** into chars / words /
   lines with a stagger, **number count-up**, **path drawing** (DrawSVG: trim start / end / offset), **shape morphing**
   (MorphSVG), **motion along a path** (MotionPathPlugin, `autoRotate`), masks and reveals (clip-path, a moving mask),
   perspective / 3D-ish flips, camera moves (a container panned / scaled), loops and yoyo, audio sync (beats).
4. **Seeing the result.** With code the model renders frames (Remotion stills, a headless browser screenshot strip, a
   GIF) and iterates: "the title arrives before the card — move it", "the overshoot is too strong". Without frames the
   model is blind; it is the single largest quality lever after the timeline language.
5. **A method**: storyboard (beats with times) → layers built for animation (grouped, named, anchor points right, clean
   vectors) → timeline → check frames → refine. Good defaults: 0.3–0.8 s per move, out-eases for entrances, in-eases
   for exits, 40–120 ms stagger, overlap instead of strict sequence, one hero move per beat, hold the end state.

## 2. What Wecra has today, per item (before phase 1)

| Need | Wecra today | Where | Gap |
|---|---|---|---|
| Timeline language (sequence, stagger, labels, relative positions) | none: `set_keyframes` writes one field's absolute keyframes on layers | `editor/agents/motionTools.ts` `setKeyframesTool`, `motion/publicApi.ts` `applyManualKeyframeTrack` | **missing** — the agent computes every time itself |
| from / to with "current" values | none (absolute keyframes only; additive fields need offsets) | — | **missing** |
| Repeat / yoyo per tween | timeline playback LOOP / ONCE / PING_PONG only; `trackLoopMode LOOP` evaluated, no UI or tool | `motion/Evaluate.cpp`, docs/motion.md §4.4 | **missing** per tween (can be unrolled into keyframes) |
| Easing: Figma's named curves, custom bezier, springs (bounce) | yes, `MOTION_EASING_TYPES` + `CUSTOM_CUBIC_BEZIER` + `CUSTOM_SPRING {bounce}`; springs fill the segment (normalised) | `motion/Easing.{h,cpp}`, `publicApi.ts` `easingFrom` | **no GSAP / CSS names**; no physical spring input at the tool; no elastic / bounce / steps |
| x / y / scale / rotate | yes: TRANSLATION_*, SCALE_*, ROTATION (CCW +, the opposite of CSS / GSAP) | `motion/Fields.cpp` | sign trap for rotation |
| skew | **evaluated** (MOTION_SHEAR in the motion transform) but not writable by any tool | `Fields.cpp` (publicName ""), `MotionLayer.cpp` `motionTransform` | **not reachable** |
| transform origin | `MOTION_SET_ANCHOR` (command 342, %) — no agent tool | `MotionCommands.cpp` | not reachable by agents |
| opacity, size, radii, stroke weight, gaps, paddings | yes | `Fields.cpp` | — |
| fill / stroke colour (SOLID) | yes, `{collection: "fills", index}` COLOR | `MotionLayer.cpp` | — |
| gradient stops | evaluated only from `.fig` PAINT / GRADIENT_PAINT values | §4.8 | **missing** to write |
| blur / shadow | yes, `effects[i].RADIUS / OFFSET_* / SPREAD / COLOR` — the effect must exist | `slotFromPublic` | the agent has to add the effect first |
| text split + stagger | yes: the **TextStagger** preset, and a text's **own stagger** (`MOTION_SET_TEXT_STAGGER`, 344) that plays its *manual* tracks per character / word / line | `motion/TextStagger.*`, MotionLayer step 5 | the own stagger isn't reachable by agents (preset only) |
| number count-up | none (text content isn't keyframable) | — | **missing** (phase 2) |
| path drawing | yes: PATH_TRIM_START / END (no offset) | `geometry/Path` `trimPath` | trim offset missing (Figma has none) |
| shape morph | none (vector geometry isn't keyframable — Figma's rule too) | §4.8 | **missing** (phase 3) |
| motion along a path | yes: TRANSLATION_XY keyframes with bezier handles, arc-length eased | `MOTION_SET_PATH_HANDLES` (343), §4.8 | no tool sets handles; no "follow this path" input |
| arcs / pies / rings, star / polygon | **evaluated** (ARC_DATA_*, STAR_INNER_SCALE, POLYGON_COUNT) but not writable | `Fields.cpp` | **not reachable** |
| masks / reveals | masks exist in the document; animating the mask layer works with existing fields | — | only documentation |
| 3D / perspective | none (TRANSFORM_3D_* round trip only; Figma unreleased) | schema 59–63 | out of scope |
| camera moves | animate a wrapping frame's translation / scale | — | only documentation |
| loops | timeline playback | `MOTION_SET_TIMELINE` | — |
| audio sync | `add_audio`, `edit_audio`; no beat data for agents (`audioBeatAnalyses` round trip) | motionTools.ts | beat markers (phase 2) |
| presets / composite styles | yes: add_animation, apply_animation_style, custom styles | motionTools.ts | — |
| **seeing the result** | `get_screenshot` = the design at rest; `export_animation` saves a GIF **file** the chat agent can't look at in the same turn (an outside client can't see it at all) | `mcpTools.ts` `getScreenshot`, `exportAnimationTool` | **missing**: frames at chosen times returned as images |
| sketch → layers | the model sees an attached image; builds with `create_nodes` (incl. `svg` markup) and `place_image`; Vectorize exists for the user (image toolbar) | `imageTools/vectorize.ts`, docs/ai.md §5 | no agent tool for Vectorize; no method text |
| a method / skill | one paragraph in the system prompt | `src/shared/agents/prompts.ts` | **missing** |

## 3. Design

### 3a. `animate` — a GSAP-like timeline compiled to native keyframes

One write tool taking a **timeline script**. It never creates a new kind of data: every tween becomes ordinary manual
keyframes (`MOTION_ADD_KEYFRAME` through `publicApi.applyManualKeyframeTrack`), a text's own stagger
(`MOTION_SET_TEXT_STAGGER`), an anchor (`MOTION_SET_ANCHOR`) and the timeline's settings (`MOTION_SET_TIMELINE`) — so
the result is edited in the timeline, read by `get_motion`, played by the player and exported to every format exactly
like hand-made motion. One call = one undo step.

```jsonc
{ "nodeId": "1:1",                       // the frame (timeline); default: the targets' frame
  "defaults": { "duration": 0.6, "ease": "power3.out" },
  "timeline": { "duration": 4, "playback": "LOOP" },   // default: grown to the last keyframe (+ hold)
  "mode": "replace",                     // the script owns the fields it touches (default) | "merge"
  "tweens": [
    { "targets": "Card/*", "from": { "opacity": 0, "y": 40 }, "stagger": 0.08 },
    { "targets": "Title", "split": "chars", "from": { "opacity": 0, "y": 20 }, "stagger": 0.03, "position": "<0.2" },
    { "label": "outro", "position": "+=1" },
    { "targets": ["1:7"], "to": { "rotate": 360 }, "duration": 1.2, "ease": "none", "repeat": -1, "position": "outro" },
    { "targets": "Ring", "fromTo": [{ "drawSVG": "0%" }, { "drawSVG": "100%" }], "ease": "expo.inOut" }
  ] }
```

- **Targets**: ids ("12:34"), layer names ("Title" — every match under the frame), name paths ("Card/Title",
  "Cards/*" for children). Several targets with `stagger` (number or `{each | amount, from: start | end | center | edges
  | random | index}`) spread their starts as GSAP does.
- **Position**: GSAP's parameter in full — absolute seconds, `"<"` / `">"` (start / end of the previous tween),
  `"<0.2"`, `">-0.1"`, `"+=0.3"` / `"-=0.2"` (relative to the timeline's end so far), labels and `"label+=0.3"`.
- **from / to / fromTo / keyframes**: missing ends are the value *at that time on the timeline being built* (the rest
  value, or what earlier tweens left), so `from` tweens render their from-state before they start (a first keyframe holds
  back to 0) and later tweens continue where earlier ones ended. A tween's start key eases in with **Hold** (a from-value
  appears at the start, GSAP's immediate render); its end key carries the tween's ease. Overlapping tweens on one property
  follow GSAP's `overwrite: "auto"`: the later tween's span replaces the earlier's keys inside it.
- **repeat / yoyo / repeatDelay**: unrolled into keyframes (repeat -1: until the timeline's end); a yoyo's return uses the
  mirrored curve, as GSAP plays it backwards.
- **Properties → fields**: x / y → TRANSLATION_X / _Y (px from rest; XY when the layer already has an XY track), scale /
  scaleX / scaleY → SCALE_XY or SCALE_X / _Y, **rotate / rotation in CSS / GSAP's sense (clockwise +)** → ROTATION
  (negated), skewX (deg) → MOTION_SHEAR = tan, opacity / autoAlpha, width / height, cornerRadius / borderRadius,
  strokeWidth, fill / backgroundColor / color and stroke / borderColor (hex, rgb(), {r,g,b,a}) → the first SOLID paint,
  blur (a layer blur effect, added at 0 when missing) → its RADIUS, drawSVG ("0% 100%", "50%", 0–1, [start, end]) / trimStart
  / trimEnd → PATH_TRIM_*, arcStart / arcEnd (deg) / arcInnerRadius → ARC_DATA_*, starInnerRadius, pointCount, gap,
  padding(Top|Right|Bottom|Left); `transformOrigin` ("50% 50%", "left top", "center bottom") sets the anchor.
- **split: "chars" | "words" | "lines"** on a text target: the text's tracks are written once and its own stagger plays
  them per element (`stagger` → delayMs, `stagger.from` → LEFT_RIGHT / RIGHT_LEFT / CENTER_OUT / RANDOM).
- **Easing names**: GSAP's (exact cubic curves for power1 / power2, the standard bezier fits for sine, power3, power4,
  expo, circ; back with its overshoot; **bounce compiled into seven exact parabolic keyframes**; **steps(n) into Hold
  keyframes**; elastic → a bouncy spring), CSS's (ease, ease-in, ease-out, ease-in-out, linear, cubic-bezier(…)),
  Framer's / Remotion's springs ({type: "spring", stiffness, damping, mass} or {bounce}) → CUSTOM_SPRING by damping ratio,
  and Wecra's own names (EASE_OUT, GENTLE, BOUNCY …).
- **Result**: per tween its targets and span, per layer the fields written, the labels, the timeline, warnings (a target
  matched nothing, a property the layer can't take) — and the hint to check with `get_motion_frames`.

### 3b. Primitives

- **Phase 1**: the fields the engine already evaluates but no tool could write — **skew** (MOTION_SHEAR), **arcs**
  (ARC_DATA_STARTING_ANGLE / ENDING_ANGLE / INNER_RADIUS: progress rings, pie charts, loaders), **star inner radius** and
  **point count** — become writable under their schema names (the engine's `fieldByPublicName` takes them; the timeline
  model already reported them by these names). Wecra-only, never in Figma's public list; stored as is.
- **Phase 2**: **number count-up** (a TEXT's characters keyframed as a number with format — a new `@ours` node field
  evaluated by the motion layer, text relaid out per frame); **motion along a path** input (`motionPath: [{x, y} …]` →
  XY keyframes with Catmull-Rom handles through `MOTION_SET_PATH_HANDLES`, optional autoRotate as a ROTATION track
  sampled from the tangent); **trim offset** (the visible window slides — compiled to START / END pairs); **gradient stop**
  writes; **beat markers** for audio sync (the store's `audioBeatAnalyses` read back to agents).
- **Phase 3**: **shape morph** between two vectors (a resampled point correspondence and a VECTOR_NETWORK keyframe type
  the renderer interpolates; Lottie `ks` path keyframes); perspective flips (a 2.5D card flip via SCALE_X + skew is in
  the skill until then).

### 3c. Seeing the result — `get_motion_frames`

A read tool: a frame's timeline rendered at chosen times (`times`) or `count` evenly spread (default 6, at most 24) and
returned **as images in the tool result** — by default **one contact sheet PNG** (a grid, each cell stamped with its
time), or one PNG per frame (`sheet: false`); `gif: true` also saves a small looping GIF in the working folder. It uses
the Animated export's frame renderer (`engine.motionRenderFrame`), so what it shows is what MP4 / GIF exports contain.
The model checks spacing, arrival order, overshoot and the end state, then refines with `animate` (mode merge) or
`set_keyframes`.

### 3d. Sketch → layers

Phase 1 is method, not code: the model *sees* the sketch (an attached image or one placed with `place_image`) and
rebuilds it as clean layers with `create_nodes` — frames with auto layout, real text, rectangles / ellipses, and `svg`
markup for icons and drawn shapes (strokes kept so `drawSVG` can draw them on) — naming every layer it will animate and
grouping what moves together. Phase 2 adds a `vectorize_image` agent tool over the engine's Vectorize (6e) for
hand-drawn strokes the model shouldn't redraw.

### 3e. The skill

A built-in skill **motion-design** (always listed, fetched with `get_skill`), and a short pointer in the system prompt:
storyboard (beats, times) → layers built for motion (names, groups, anchors, overflow clipping) → `animate` in one script
→ `get_motion_frames` → refine → `export_animation`. Defaults: entrances 0.4–0.8 s `power3.out` / `expo.out`, exits
0.25–0.4 s `power2.in`, emphasis `back.out(1.7)` or a spring, stagger 0.04–0.1 s (chars 0.02–0.04 s), overlap ("<0.15")
rather than strict sequence, hold the final state ≥ 1 s, 3–8 s for UI pieces; easing families per brand mood; never
animate the top-level frame — wrap a "Camera" frame for pans and zooms.

## 4. Phases

| Phase | What | When |
|---|---|---|
| **1** | `animate` (timeline script → native keyframes, GSAP / CSS / spring easings, stagger, labels, relative positions, repeat / yoyo, text split, transform origin, blur auto-effect); `get_motion_frames` (contact sheet / frames / GIF as images); skew, arc, star and polygon fields writable; the **motion-design** skill and system-prompt pointer; docs | **tonight (2026-10-21) — built** |
| 2 | number count-up; motionPath input + autoRotate; trim offset; gradient stops; vectorize_image tool; beat markers; `animate` reading back a script from the timeline (`get_motion` as script) | next |
| 3 | shape morph; perspective; per-character colour; a Remotion-like expression track ("value = f(t)") baked to keyframes | later |

## 5. Phase 1 — as built

See docs/motion.md §9.2 for the details and tests. Files: `src/renderer/src/editor/agents/animateScript.ts` (the
compiler: easings, positions, stagger, unrolling — pure, unit-tested), `animateTool.ts` (targets, current values,
writing through `publicApi`), `motionFrames.ts` (`get_motion_frames`), `src/shared/agents/motionSkill.ts` (the skill),
the tools' definitions in `src/shared/agents/tools.ts`, engine `motion/Fields.cpp` (`fieldByPublicName` takes the
evaluated non-public fields' schema names).
