# Prototyping — Figma's player read and measured, Wecra matched point by point (REA round, 2026-10-20)

How Figma's prototypes are built and behave (the inline preview, the presentation view, the player, every transition
and easing, Smart Animate, and what feeds them), with the evidence for each fact, and — per the owner's method — each
point checked side by side in Wecra: Figma's code and a live measurement, Wecra's code and **the same measurement**,
then ✓ when they agree or a fix (with a native test pinning Figma's value) when they don't.

**Sources and method.**
- *Read from code*: Figma's current web build as cached by the desktop app (2026-10-20 18:18): the prototype viewer
  `viewer-1e99064317a8d9ad.min.js` (2.0 MB — the TS player, renderer and multiplayer client), the `/proto` shell
  `prototype_app-5402c01db97d2664.min.js`, the `prototype-lib` wasm (`34f8082c…/compiled_wasm.wasm`, 28.8 MB, strings
  only) and the editor `figma_app-ce44270e1f795160.min.js` plus today's chunks (the inline-preview host is
  `42416-6aab7d1c2233d2db.min.js`). Extracted from `~/Library/Application Support/Figma/DesktopProfile/v43/Cache` with a
  small simple-cache reader (brotli bodies decoded). REA 6.5.0 `analyze_javascript_application` over viewer + shell:
  Evidence `ev_0f048de820828a29975f71676f6a9a3ce52b6b10396cbba42d7cc7035126eeb8` (65 modules, 492 k AST nodes); the
  rest is targeted reading of the minified classes (offsets below are byte offsets into the viewer bundle unless
  another file is named; class names are the minifier's). No Figma code is copied, only short identifiers.
- *Measured*: live Figma (the owner's Untitled draft, a scratch page "zz Proto probe (Wecra REA)", deleted at the end)
  in the app's Browser pane, and Wecra's web dev build (`vite.web.config.ts`, `?editor&doc=empty`, the inline preview at
  100 %) in the same pane — **the same probe script in both** (`scripts/proto-bench/probe-inject.mjs`): the page's clock
  held (performance.now, Date.now, requestAnimationFrame replaced), stepped 10 ms a frame, the canvas read back inside
  the drawing task, colour runs / bounding boxes extracted per frame. Test documents were built identically: Figma via
  the Plugin API from the console, Wecra via its agents' tools (`runTool` of `editor/agents/mcpTools.ts`, the Plugin
  API shapes). Raw series: `prototype-easing-live.json`.
- *Inferred*: marked so.

The detailed notes behind §1–§5 (each line with its offset) are appended as Appendices A–C.

## Checklist — Figma vs Wecra, side by side

Status: ✓ = same result from the same measurement (or the same code value where nothing can be measured); **fixed** =
Wecra changed in this round (commit after the group); open = not settled, why.

### Group 1 — easings, springs, durations

| Item | Figma (evidence) | Wecra (before) | Status |
|---|---|---|---|
| Bezier presets | `sJ.easingValuesForPreset` @420414: IN/EASE_IN `.42,0,1,1`; OUT/CUSTOM default `0,0,.58,1`; INOUT `.42,0,.58,1`; LINEAR; IN_BACK `.3,−.05,.7,−.5`; OUT_BACK `.45,1.45,.8,1`; INOUT_BACK `.7,−.4,.4,1.4`. Measured 10 ms series (json) | `motion/Easing` + `proto::ease` same constants; measured series equal to ±0.5 px (one-frame phase) for Linear, Ease in/out/in-out, custom `.2,.8,.3,1` | ✓ |
| Bezier solver | WebKit UnitBezier, 8 Newton steps then bisection, ε = 1/(200·duration) (`sj` @415300) | `motion::cubicBezier`, 8 Newton + 40 bisection, ε 1e-7 | ✓ (differences < 1e-4) |
| Spring presets | Gentle 1/100/15, Quick 1/300/20, Bouncy 1/600/15, Slow 1/80/20, custom default 1/100/15 (@420414) | `motion::kGentle…` same | ✓ |
| Spring maths | `sX` @416200: ζ<1 closed form B=(ζω0−v0)/ωd; **ζ≥1 played as critical at ω0**: 1−(1+(ω0−v0)t)e^(−ω0 t); runs in real seconds `solve(p·duration)` (`s$` @417020); end committed at p = 1 | `viewerSpring` same forms, `t·durationOf` | ✓ — measured: Gentle peak +4.5 px / 160, Quick +17, Bouncy +58, Slow (ζ 1.118) 159.5 at 1 s then snaps, custom 1/200/10 +48.5 — Wecra identical after the overshoot fix below |
| Stored spring for an edited preset | `easingFunctionValues` uses the action's `easingFunction` for CUSTOM_CUBIC and every spring preset (@433267) | `springOf` same | ✓ |
| Frame clock | legacy tracker `mn` @1529482: dt capped at 1/30 s, progress clamp(elapsed/d, 0, 1), d ≤ 0 → end. Measured: 50 ms steps advance 12 px of 360 per frame (= 33.3 ms) | `kMaxFrameMs = 1000/30` | ✓ |
| Missing / zero duration | `s1.transitionDuration`: INSTANT → 0; stored ≥ 0 kept (**0 stays 0**); missing/negative → 0.3 | `0 → 0.3` (the Plugin API's `|| .3`) | **fixed** (Prototype.cpp readAction; `proto.rea`, `proto.delay` tests) |
| After delay default | `sQ.transitionTimeout` @427363: missing → 0.8, explicit 0 stays 0 | `0 → 0.8` | **fixed** |
| Hover / press delay default | `sQ.interactionDuration` @427168: missing → 0.3, explicit 0 stays 0 | `0 → 0.3` | **fixed** |
| Spring overshoot drawn | translation is an unclamped lerp (`cb.interpolateTranslation` @763687); measured Out back peak 170.5 / 160, In back dip −16, Bouncy 218 | **clamped at the end value**: `lerpMatrix` returned the end for t ≥ 1 / the start for t ≤ 0 — Back easings and springs never overshot; In back started ~600 ms late | **fixed** (`lerpMatrix` endpoints only at exactly 0 / 1); re-measured: Out back 170.5, In back −16, Quick 177, Bouncy 218 — identical series |
| Opacity under overshoot | `cb.interpolateOpacity` = clamp(lerp, 0, 1); paint opacity clamped | unclamped lerp (could exceed 1 / go below 0) | **fixed** (`unit()` for layer, paint, screen, overlay, dissolve and fade opacities; corner radii, stroke weight, size ≥ 0) |

### Group 2 — transition types and directions

| Item | Figma (evidence) | Wecra | Status |
|---|---|---|---|
| Move in | `cN` @764930: entering from ±1 screen, exiting still. Measured (Plugin `MOVE_IN` LEFT): the new screen enters from the right edge, 800 px/s at 2× | `geometryOf` moveFrom | ✓ |
| Move out | `MOVE_OUT_TO_X = MOVE_FROM_opposite.reversed()`; measured: Plugin `MOVE_OUT` LEFT → the old screen leaves to the left, the new one is under it (red marker leaves at 100 ms) | `reversed(moveFrom(side^1))`; agents' writer swaps L↔R for all five types | ✓ |
| Push | entering ±1 → 0, exiting 0 → ∓1; RIGHT / BOTTOM are reversed LEFT / TOP (exiting on top) | pushFrom same | ✓ |
| Slide in | entering ±1; exiting moves ¼ the other way, opacity 1 → 0.5. Measured: old screen's grey 228 at 0.2, 139 at 0.9 (= 1 − 0.5 t over black) and its marker 20 px / 100 ms | slideFrom same | ✓ |
| Slide out | reversed slide: old screen leaves fully on top, new one comes back from ¼ at 0.5 → 1 (blue 129 at t≈0) | same | ✓ |
| Dissolve | straight cross-fade of the two screens in sRGB values (`lerpTile`, @956304); measured white→blue 234 / 209 at 0.08 / 0.18 | linear cross-fade | ✓ |
| Unit of the offsets | max(old size, new size) per axis (`SI` @1732300) | `view_.screen` | ✓ (same size frames measured) |
| Overlays | Fade / Push / Slide on an overlay play as **Instant** (`s1.transitionType` @432546); an overlay moves only its size + its distance to the edge; background fades with the eased progress | (group 6) | — |
| Back / Close | replay the change's transition **reversed** with its duration and easing (`_returnToFrame` @1264350) | (group 6) | — |

### Group 3 — Smart Animate matching and interpolation (measured, Linear 1 s, box bounding boxes at 250 / 500 / 750 / 1100 ms)

| Case | Figma | Wecra | Status |
|---|---|---|---|
| Two same-named siblings, order swapped in B | matched by **index among same-named siblings**: each moves horizontally, colours cross (red ↔ green, mixed at 500 ms) | same bboxes and colours at every sample | ✓ |
| Same name, different parent path (Group/Dot → Dot) | **not matched**: old fades out in place, new fades in in place (both 50 % at 500 ms) | same (pixel series: linear 0 → 1 / 1 → 0, equal at 500 ms) | ✓ |
| Same name and path, rectangle → ellipse | matched: **moves and cross-dissolves** (rectangle corners at 50 % half way; both at x 160) | moved as one ellipse (no dissolve) | **fixed**: a leaf shape whose kind changed is a dissolving match — `dissolving_` path for the old layer, fade-in along the same path for the new (`proto.rea` test) |
| Text whose characters change | matched: **moves and cross-dissolves** (bbox top 95 → 120 → 145 → 170) | dissolved **in place** (old at its place, new at its place) | **fixed** (same mechanism); re-measured: Wecra bboxes equal Figma's ±1 px |
| A drop shadow added | **animates**: the layer moves at full opacity, the shadow fades in at its final offset (blue under it from 500 ms) — help.figma.com's "no Smart animate with shadows" no longer holds | dissolved in place (shadow lists differing = not animatable) | **fixed**: effects lerp pairwise, a missing one comes in with alpha 0 (`lerpEffects`); re-measured identical |
| Nested (Card moves, Dot moves inside it) | absolute = lerp of the parent ∘ lerp of the child (Dot at 165, 115 half way) | identical bboxes | ✓ |
| Position, size, radius, fill colour, opacity | linear per property; colour a straight RGBA lerp of sRGB values, layer opacity lerp (measured centre colour 158, 66, 163 at p ≈ 0.52 over white) | same | ✓ |
| Blend modes during Smart animate | a plan node without the BLENDING trait draws PASS_THROUGH at opacity 1 (`SE` @1696525) — the gradient overlay over a photo loses its blend while animating | blended throughout | not copied (a rendering artifact; owner's decision 2026-10-20) |

### Group 5 (started) — multiple actions

| Item | Figma | Wecra | Status |
|---|---|---|---|
| Two Navigate actions on one click (Dissolve 1 s, then Instant) | the second waits for the first transition to end (`triggerHotspot` @1827101 queue); measured: R5 at once, T5 at 1020 ms | R5 at 10 ms, T5 at 1010 ms (held clock) | ✓ |
| Instance and main both On click | Plugin `setReactionsAsync` on an instance replaces its inherited list (read back: only its own; the click navigates to its own destination) | merges by id (`proto::instanceInteractions`) — same for this case | ✓ for the Plugin-written case; the panel-written case is open (needs a UI probe) |

### Group 4 — interactive components

| Item | Figma | Wecra (before) | Status |
|---|---|---|---|
| Change to (instant) on a clicked toggle | the instance shows the other variant | same (`changeTo` swaps the instance) | ✓ |
| The changed state on the next screen's same-path instance | **carried** (measured: Toggle On on P1 → Next → P2's "Toggle" green); code: `hV` @1192355 stores non-transient Change-to states by semantic path (names + index among same names, the screen's name left out), applied on arrival unless "Reset component state" | not carried (P2's toggle Off) | **fixed**: `componentStates_` + `carryComponentStates` (v1 interactions only; reset flag honoured; variants of the same set only); `proto.rea` test (both flag values) |
| Back to the first screen | its toggle still On (measured) | same (the instance keeps its swap) | ✓ |
| Restart | component states, variables, scroll, history reset; goes to the flow's start — from a non-flow frame (URL `starting-point-node-id` not a flow) Figma restarted at the page's **first flow** (measured) | resets; restarts at the frame it started on | resets ✓; the restart frame for a non-flow start is open (the inline preview restarts "from the last selected frame", prototype-preview.txt) |
| Instance with its own On click + main's On click | Plugin-written: the instance's list replaces the inherited one (measured: navigates to its own) | merged by id — same result here | ✓ (panel-written case open) |
| Hover / press states when leaving a screen | reverted (`_initiateStateChange`) | `held_` cleared on navigate | ✓ (read from code) |

### Group 5 — triggers

| Item | Figma | Wecra (before) | Status |
|---|---|---|---|
| Mouse leave / enter order | leaves inner → outer, then enters **outer → inner**, the first that changes state ends the round (`mP` @~1575000) | enters deepest first, all of them | **fixed** (`hover`); `proto.rea` test |
| While hovering | only when no enter / leave acted; the topmost (deepest) hover hotspot's **first** hover interaction; not again while hovered | every newly entered layer's every hover interaction | **fixed** (`Held.hotspot`) |
| NONE trigger | read as On click (`sQ.interactionType`) | never fired | **fixed** (`ix`) |
| Press / release / click | Mouse down → While pressing; release → Mouse up → On click (≤ 5 px) → reverse press; drag threshold 5 px | same constants (`kDragThreshold` 5, …) | ✓ (code) |
| After delay | timers start on every committed change, checked each frame, cancelled by any change; ← / → at least 500 ms | `armTimers` / `kArrowDelayMs` | ✓ (code) |
| Keys | whole topmost screen, exact key set, first match | proto.wave4 | ✓ (code) |
| Drag | progress = projection on the vector, 0.15 / duration release rule | `kReleaseSpeed`, scrub | ✓ (code) |
| Multiple actions | sequential, each screen change / Change to waits (measured 1020 ms) | measured 1010 ms | ✓ |
| Conditionals | first true branch inserted at the queue's front; none → nothing | `chosenBranch` + `drain` | ✓ (code) |
| A release < 0.1 s after the press | processed a frame later so the pressed state shows | immediate | open (cosmetic) |

### Group 6 — overlays, history, scroll

| Item | Figma | Wecra (before) | Status |
|---|---|---|---|
| Back from an overlay opened on B (after A → B) | **back to A, overlay closed** (measured; `returnToState2` skips transient overlay steps) | closed the overlay only, stayed on B | **fixed** (`back` skips overlay steps; `undoLast` keeps the exact-undo for hover reverts); test `prototype.player: Back in an overlay…` |
| Back with only overlays opened since the start | nothing (Close overlay closes them) | closed the overlay | **fixed** (test updated) |
| Back restores the overlays open when the screen was left | no: back to the screen with no overlays | restored them | **fixed** |
| Scroll position across screens (v1) | stored by semantic path when a screen is left, applied to the next screen's same-path scrollers, 0 where none; Reset scroll position → 0 (measured: List scrolled 200 on A → B's List at 200) | kept per frame id only (B's list at 0) | **fixed** (`carryScroll`, `scrollStore_`); `proto.rea` test (both flag values) |
| Overlay defaults | CENTER, no background interaction, black 25 % when on; positions against the base screen; manual unclamped | prototype.test (centred 87.5, 356) | ✓ |
| Click outside | closes the topmost overlay only if it closes on click outside and no hotspot took the click | same | ✓ |
| Overlay transitions | Fade / Push / Slide on Open overlay play Instant; close = opening reversed | close reversed ✓ (2026-10-20 audit); Fade / Push / Slide played as set | **fixed** (openOverlay: Instant; `proto.rea` test) |

### Group 7 — presentation and inline preview

Matched in the 2026-10-20 audit (`docs/research/figma/live/2026-10-20/prototype-preview.txt` §4: place, size, resize,
header, options, scaling modes, presentation chrome and options, flows sidebar, background black). Not re-measured in
this round.

## 1. Architecture (summary; detail in Appendix C)

- **Separate app, same engine.** The presentation (`/proto/<file>`) is `prototype_app` + the `viewer` bundle + the
  `prototype-lib` wasm — Figma's C++ scene graph (layout, text, variables, expressions, kiwi, Smart-animate matching
  and baking) built without the editor. The inline preview (⇧Space) is the same viewer in an iframe
  (`/embed?embed_host=inline-viewer&url=…/proto/…&hide-ui=1&inline-viewer=1`) — its own process-less JS heap and its own
  wasm instance; the editor talks to it only by postMessage control messages (navigate, restart, scaling, smart-animate
  scrub; the viewer reports the presented node). *Read from code.*
- **Document delivery.** The viewer opens its own multiplayer WebSocket (role "viewer"); a shallow root query, then
  `SCENE_GRAPH_QUERY` subtrees per top-level frame, chosen by a breadth-first walk of the navigation graph from the
  current screen (destinations, conditional branches, Back targets, variant sets bound to variables, hyperlinks), depth ≤ 8
  and ≤ 64 frames (mobile 2 / 4), 4 frames a batch; linear prototypes ±2 frames. Editor edits reach an open preview as
  ordinary multiplayer NODE_CHANGES of the subscribed subtrees (*inferred from the code path*).
- **Rendering.** WebGPU when allowed, else the unified WebGL renderer, else the legacy TS WebGL2 one; 512 px tiles, a
  16 ms / 2-tile / 250-target-switch budget per frame, SSAA ×4; one cached render tree per transition animated by
  opacity / transform wrapper nodes; a continuous rAF loop that draws on demand (3 frames after the last request).
  Per frame: due timers (After delay, hover delays) → app onFrame → scroll / camera → resize → draw.
- **TS vs C++.** TS: the state machine, history, event dispatch, transitions, scroll physics, fit modes, the tile
  compositor. C++: document, layout, variables / expressions / conditionals (`getFirstTruthyConditionalIndex`), Smart
  animate matching (`_tryGetNodeMatchesCpp`), instance interaction inheritance.

Wecra: the inline preview and the presentation run the same engine (`proto::Player`) on the editor's document in the
same process (no iframe, no server round trip) — a deliberate architectural difference (docs/engine.md §3.4); the
player semantics are what must match, and §2–§5 track them.

## 2. The player (summary; detail in Appendix A)

Defaults (`sQ` / `s1`): NONE trigger = On click; durations as in group 1; easing OUT_CUBIC; open-URL-in-new-tab true;
the reset flags false. Hotspots: the topmost layer with that trigger under the pointer (scroll and clipping applied); no
bubbling; only the topmost overlay can be hit. Press → Mouse down, else While pressing; release → Mouse up, else On click
(≤ 5 px of travel), else reverse the press; a release < 0.1 s after the press is held one frame. Mouse leave fires inner
to outer, then Mouse enter outer to inner; While hovering only if enter / leave did nothing; leaving reverses it (Change
to → previous state, navigate → one step back, running Smart animate plays back from its progress). After delay timers
start on every committed change, are checked at the start of each frame, any change cancels them. Keys: searched over
the whole topmost screen, exact key set, first match only. Drag: 5 px threshold, progress = projection on the
transition's vector, release threshold 0.15 / duration around 0.5. Multiple actions run in sequence, each Navigate /
Overlay / Swap / Change to / Back / Close waiting for its transition; Set variable / mode, URL, media continue at once;
a new click / press clears the queue. Conditionals: first true branch's actions are inserted at the queue's front; none
true → nothing. History: base screen + overlay list; Navigate closes overlays; Swap replaces the top overlay; Back
skips trailing overlay / swap / hover entries and replays the transition reversed. Restart resets variables, modes,
overlays, history, component states, scroll and timelines. Scroll physics: iOS / macOS bounce (friction 0.135^t, edge
spring m 0.5 k 100 ζ 1.1, rubber band 0.52(1 − x/size)²), Android / Windows / Linux clamp (friction 0.015).

## 3. Transitions and easing — value-vs-time tables

`prototype-easing-live.json` holds the measured series (Figma and Wecra before the fix). Peaks to test against
(160 px travel, 1 s): Out back +10.56 (max of the curve), In back −16.26, In-out back −9.35 / +9.35, Gentle +4.54,
Quick +17.35, Bouncy +58.25, custom spring 1/200/10 +48.80; Slow reaches 0.9987 at 1 s and snaps to 1 on commit.

## 4. Smart Animate (summary; detail in Appendix B)

Matching: name + parent path, index among same-named siblings (measured); different paths never match (measured);
instance helpers in C++ (`computeInstanceNameHierarchyMatchingHelper`, `computeMatchingInstancesInStateGroup`).
A matched pair that can't morph (shape kind, text characters / font) dissolves *along the matched path* (measured).
Per property: transform (decomposed translation / scale / angle), size, radii (≥ 0), stroke weight, paints by index
(same count, else the from list; a 0-opacity paint takes the other's type), effects pairwise (a new shadow fades in —
measured), opacity clamped; unmatched layers fade in / out in place. Blend modes drop while animating (not copied).

## 5. What affects prototypes (summary; detail in Appendix C)

Devices: `PrototypeDevice {type NONE / PRESET / CUSTOM / PRESENTATION, size, presetIdentifier, rotation}`; fit modes
(`scaling=` contain, contain-with-zoom, scale-down (default), min-zoom, scale-down-width, fit-width, free, responsive);
background = the page's prototypeBackgroundColor, transparent → black. Overlays: position CENTER … MANUAL (7),
background NONE / SOLID_COLOR (default black 25 %), interaction NONE / CLOSE_ON_CLICK_OUTSIDE; positions computed against
the base screen; manual = hotspot's top-left + offset, unclamped. Scrolling: the base screen scrolls both ways; others by
overflowDirection where content exceeds; Fixed children drawn above everything, excluded from content bounds; Sticky
vertical only. Variables: Set variable may Change-to instances whose variants are bound to it; Set variable mode is
scoped to the hotspot's instance or node; modes resolved at trigger time. Instances: interactions merged with the
main's by id (own fields win, new ones appended, deleted dropped).

## Wecra must match — rules and how to test them

1. Durations: missing → 0.3 s, After delay missing → 0.8 s, hover delay missing → 0.3 s, explicit 0 = 0, Instant = 0
   (`proto.rea` / `proto.delay`).
2. Easing curves equal to the tables above at every 10 ms sample (`proto.rea`: peaks; the json for full series; the
   probe script re-measures both apps).
3. Overshoot is drawn for position and size; opacity is clamped to [0, 1]; radii / stroke ≥ 0 (`proto.rea`).
4. The frame clock caps dt at 1/30 s.
5. Transition geometry: Move / Push / Slide / out types / Dissolve as group 2 (`prototype.test`).
6. Smart animate: match by name path + index among same names; a non-morphable match dissolves along the path; shadows
   animate (`proto.rea`, `prototype.smart`).
7. Multiple actions: each waits for its predecessor's transition.
8. Component states and scroll offsets follow semantic paths to the next screen (v1), unless the step resets them;
   Restart clears them (`proto.rea`).
9. Back skips overlay-only steps and returns to the previous screen with no overlays (`prototype.player`).
10. Hover: leaves inner → outer, enters outer → inner, first acting one ends the round; While hovering only then, on
    the deepest hover hotspot, its first interaction; NONE = On click (`proto.rea`).

---

## Appendix A — The player — static reading

(Working notes of the static reading, kept as written; "[code]" = read from code, "[inferred]" = drawn from it. Superseded where the checklist above measured otherwise — e.g. shadows.)

All offsets are byte offsets in `viewer-1e99064317a8d9ad.min.js` unless noted. Tag: **[code]** = read from code; **[inferred]** = consequence drawn from the code, not observed. Class names are the minifier's.

### 0. Data model (interaction / event / action)

- `sZ` PrototypeInteraction @421661 [code]: `{id, event, actions[], isDeleted, stateManagementVersion (default 0)}`. `allActions()` flattens CONDITIONAL branches. `isValid()` needs a non-NONE event type and a first action whose connectionType ≠ NONE. `applyInteractions` merges override interactions by id (instance overrides) and drops `isDeleted`.
- `sQ` PrototypeEvent @426783 [code] getters and defaults:
  - `interactionType()` default ON_CLICK; **NONE reads as ON_CLICK**.
  - `interactionMaintained()` default false.
  - `interactionDuration()` = stored value if ≥ 0 else **0.3 s** (an explicit 0 stays 0).
  - `transitionTimeout()` = stored if ≥ 0 else **0.8 s** (explicit 0 stays 0 → fires next frame).
  - `keyTrigger()` default `{}`; `createDefault` = `{keyCodes:[], triggerDevice:"KEYBOARD"}`.
  - `mediaHitTime()` default 0.
- `s0` ConditionalActions @429411: `{actions[], condition}`.
- `s1` PrototypeAction @429972 [code] getters:
  - `transitionType()` default INSTANT_TRANSITION; for navigationType OVERLAY the types FADE, PUSH_*, SLIDE_* (in, not out) read as INSTANT; SCROLL_ANIMATE outside SCROLL_TO reads as INSTANT.
  - `transitionDuration()` 0 for INSTANT (unless connection OBJECT_ANIMATION); else stored if ≥ 0 else 0.3.
  - `easingType()` default OUT_CUBIC; `easingFunctionValues()` uses the stored `easingFunction` for CUSTOM_CUBIC, GENTLE, SPRING_PRESET_ONE/TWO/THREE, CUSTOM_SPRING, else the preset table (@420414).
  - `connectionType()` default NONE; `navigationType()` default NAVIGATE; `mediaAction()` PLAY; `openUrlInNewTab()` default **true**; `mediaSkipByAmount` 5; `mediaPlaybackRate` 1.
  - `transitionPreserveScroll()` (legacy, v0): true if SMART_ANIMATE, or a smart-animatable directional type with "Animate matching layers"; false for SLIDE/PUSH/MOVE without it; else the stored flag.
  - `transitionResetScrollPosition`, `transitionResetInteractiveComponents`, `transitionResetVideoPosition` default **false**.
  - `transitionNodeID()` valid only for INTERNAL_NODE, UPDATE_MEDIA_RUNTIME, OBJECT_ANIMATION, UPDATE_ANIMATION_TIMELINE_STATE (or missing connection type).
- `ry.isValidForConnection` @1312806 [code]: URL only for ON_CLICK, MOUSE_UP, AFTER_TIMEOUT; BACK not valid for ON_HOVER / ON_PRESS.
- Cause enum `oq`/`eW` @515913 [code]: TIMER 1, ON_HOVER 2, ON_PRESS 3, ON_CLICK 4, DRAG 5, REVERSE_HOVER 6, REVERSE_PRESS 7, MOUSE_DOWN 8, MOUSE_UP 9, MOUSE_IN 10, MOUSE_OUT 11, MOUSE_ENTER 12, MOUSE_LEAVE 13, ON_KEY_DOWN 14, GAMEPAD 15, VOICE 16, MOBILE_NAV 17, LEFT/RIGHT_ARROW 18/19, MEDIA_HIT 20, MEDIA_END 21.
  - `isTransientAction` @515364: **ON_HOVER, ON_PRESS, REVERSE_HOVER, REVERSE_PRESS, MOUSE_DOWN, MOUSE_IN, MOUSE_OUT, MOUSE_ENTER, MOUSE_LEAVE are transient**; TIMER, CLICK, DRAG, MOUSE_UP, KEY, media, arrows are not.
  - Opposite pairs: HOVER↔REVERSE_HOVER, PRESS↔REVERSE_PRESS, IN↔OUT, ENTER↔LEAVE, MOUSE_DOWN→MOUSE_UP.

### 1. Pointer pipeline (`S` = CanvasPointerEventDelegate, handler cut @~1890000; constants @1917097)

- Constants [code]: `SQ = 5` (drag confirm distance, view px), `S0 = 0.2 s` (wheel target stickiness), `S1 = 0.4 s` and `S2 = 50` (tap = < 50 px and < 0.4 s, touch only), `S3 = 0.1 s` (release deferral), `MAX_MICROTASKS_PER_FRAME = 2` @1814879, key codes ALT 18, SHIFT 16, META 91, CONTROL 17 @1815500.
- Press (`_handleSinglePointerPress`) [code]: records drag start, then `handleInteractionsForPress`: resets MOUSE_UP maintained entries, tries **MOUSE_DOWN** hotspot; only if not handled, **ON_PRESS** (While pressing) hotspot → triggers the hotspot's **first** ON_PRESS interaction and stores `_lastPressData` (swapped instance path or hotspot path).
- Release [code]: if a press was handled < 0.1 s ago, the release is stored and processed at the end of the next frame (`maybeProcessStoredPointerRelease` in `_onFrame`) — so a fast click still shows the pressed state one frame. Then `handleInteractionsForRelease`: reset MOUSE_DOWN entries; if a drag interaction is active → end drag, done. Else **MOUSE_UP** hotspot; if not handled and click allowed → **ON_CLICK**; if still not handled → **reverse press** (While pressing ends: `returnInstanceToState(BEFORE_LAST_ANY_STATE, REVERSE_PRESS)` for Change to, else `requestBack`).
  - Click allowed when the drag gesture was not confirmed (moved ≤ 5 px) and the press was not a MAINTAINED (delayed) one, or when a confirmed drag landed on a DRAG proposal that was handled.
  - [inferred] A node with both While pressing and On click: the click fires and the press is **not** reversed by that release (reverse runs only when MOUSE_UP and ON_CLICK did not handle).
  - A scroll during a press reverses the press at once (`handleInteractionsForScroll`).
- Hotspot pick `hotspotOnPresentedNode` @1320579 [code]: candidates = hotspots on the presented node having an interaction of the queried type; the point must be inside the hotspot's interactive bounds **with scrolling and ancestor clipping applied**; among them the one **highest in layer order** wins (legacy path `isAboveInLayerOrder`; behind gate `viewer_cpp_hittest(_geometry)` a C++ geometry hit test does the same). So the topmost layer that has *that trigger* wins; a child without the trigger lets the event reach a parent with it; different trigger types never compete (MOUSE_DOWN before ON_PRESS, MOUSE_UP before ON_CLICK). No bubbling: one hotspot per event per trigger type.
  - With an overlay open, **only the topmost overlay** is hit-tested (`_hotspotAtCanvasSpacePointWithInteractionType` @~1897000); the base screen and lower overlays get no clicks/hover. The point is mapped by `baseTlfSpaceToOverlaySpace1`.
  - Points outside the base screen's bounding box return nothing (except MOUSE_OUT).
- Click @`_handleClick` [code]: triggers **every** ON_CLICK interaction on the chosen hotspot, in list order. If no hotspot: if the topmost overlay has `CLOSE_ON_CLICK_OUTSIDE` and the point is outside the overlay node's bounding box → close the topmost overlay only (`closeOverlayAtAndAbove(len-1, REMEMBER)`).
- Misclick: hotspot hints flash (`f9` @1525042) for **0.7 s**, opacity `1 − bezier[0,0,.58,1](t)` with t in raw seconds.
- Cursor: pointer over ON_CLICK / ON_PRESS / MOUSE_DOWN / MOUSE_UP hotspots that are not the screen itself; touch OS → touch cursor.

### 2. Move: mouse enter / leave, while hovering

`handleInteractionsForMove` [code] order per pointer move: cursor → `_handleMouseEnterMouseLeave` → (deprecated MOUSE_IN/OUT) → if nothing handled: `_handleHover1` (ON_HOVER) then `_handleReverseHover`.

- Entered set (`mP` @~1575000, `_getNodesEnteredByCanvasSpacePoint`) [code]: on the topmost screen, the topmost MOUSE_ENTER/LEAVE hotspot under the point, plus all its ancestors up to the screen (inner → outer). Overlapping siblings below are not entered.
- Leaves first, then enters [code]: newly left nodes in order **inner → outer**; newly entered in order **outer → inner**. Leave candidates come from the topmost screen and the one below it (second topmost overlay or base); enter candidates only from the topmost. The loop stops as soon as the prototype's action counter changes (a navigation/state change happened).
- Delays (`interactionMaintained` + `interactionDuration`) for MOUSE_ENTER/LEAVE/DOWN/UP [code, `_handleMaintainedInteraction`]: an entry is set per (hotspot, type) and a callback scheduled after `interactionDuration × 1000 | 0` ms; it fires only if the entry was not reset, the global action counter and the swapped instance's counter are unchanged. Resets: ENTER entry when the pointer is no longer inside; LEAVE entry when it is inside again; MOUSE_UP entries on a new press; MOUSE_DOWN on release, scroll, drag off the hotspot, pointer leaving the window. A press handled as MAINTAINED suppresses the click.
- While hovering (ON_HOVER) [code]: topmost ON_HOVER hotspot; its **first** ON_HOVER interaction is triggered (unless a hover smart-animate is already running on it). The change records `canvasSpaceTriggerBounds` = the hotspot's interactive bounds at trigger time. Reverse hover: for a Change to, when the point leaves the hotspot's (scrolled, clipped) bounds → `returnInstanceToState(BEFORE_LAST_ANY_STATE, REVERSE_HOVER)`; for navigate/overlay → `requestBack(BEFORE_LAST_ANY_STATE, REVERSE_HOVER)`; for a JIT smart animate in progress → plays it **backwards from its current progress** (`beginReverseAnimationSurface`). A hover smart animate that finishes is **held at its end** (`markHoldIfHoverAndDone`, mO.onFrame @1573446) instead of committing.
- After every committed/aborted change, the player re-runs `handleInteractionsForMove` at the current mouse position in a microtask (≤ 2 per frame) so hover/enter states follow a screen that changed under a still pointer (`_onCommitOrAbortForInteractions`). Nodes of newly shown frames are marked "not entered" without firing leave.

### 3. Timers (After delay) [code, `_triggerPotentialTimedTransition`, `_scheduleTimedInteractionCallback`]

- Started on each committed or aborted state change for the new/changed frames (new base screen, new overlays) plus every instance inside the topmost screen; on each Change-to commit for the swapped instance and its descendants. Only roots are kept (a node whose ancestor is in the list is dropped; the search covers the subtree).
- Delay = `transitionTimeout × 1000 | 0` ms (default 0.8 s; 0 allowed); navigation via ← → arrows forces ≥ 500 ms.
- Fires (checked at the start of each animation frame, `_runDueTimedInteractionCallbacks`, ordered by due time then creation order) only if the topmost-screen change counter and the relevant action counters are unchanged → **any navigation, overlay or state change in between cancels it**. Nodes inside an active JIT animation / animation surfaces are skipped.
- [inferred] A Change to that targets its own instance with After delay restarts the timer on each commit → loops (caret blink).

### 4. Keys and gamepad [code, `handleInteractionsForKeyPress`]

- Searches ON_KEY_DOWN hotspots in the whole topmost screen (not under the pointer). Pressed list = modifiers (ALT 18, SHIFT 16, META 91, CTRL 17) + the key's code (modifier keys alone add nothing). Match: `triggerDevice == KEYBOARD`, `keyCodes.length == pressed.length` and every stored code is pressed; on non-mac META in the trigger is treated as CTRL.
- Triggers the **first** matching interaction of the first matching hotspot and accepts the event (stops). Gamepad: same with `triggerDevice ≠ KEYBOARD` and `keyCodes ∋ button`.
- Inline preview: an unhandled Esc or ⇧Space closes the preview.

### 5. Drag (On drag) [code, `onDrag`, `getBestScrollOrDragProposal`, `ms` @~1534000, `mo`]

- A drag is confirmed after > 5 px (or 2 touches). The proposal tree walk (`findBestScrollOrDragProposalInTree`) picks per node: SCROLL if it can still scroll in the drag direction, OVERSCROLL otherwise (bouncing OS only), DRAG if the node has a DRAG interaction; best by direction similarity; a DRAG beats an OVERSCROLL.
- Drag vector: Smart animate (or directional + Animate matching layers) = from the hotspot's centre in the source frame to its matched layer's centre in the destination; directional transitions = frame size (navigate: max of both frames; overlay/swap: destination size) × the transition's unit translation; Back/Close drags use the reverse of the stored transition.
- Progress = clamp(dot(pointer − start, v) / |v|², 0, 1), driven per frame. Release: speed = progress per second along v; threshold = 0.15 / duration. If progress ≥ 0.5 → revert only when speed ≤ −threshold; else revert unless speed ≥ +threshold. Remaining time: linear settle for JIT (`remaining × duration`), else based on the easing's derivative.

### 6. Media

ON_MEDIA_HIT at `mediaHitTime` and ON_MEDIA_END registered per visible video hotspot on every commit; an interaction whose actions are all media actions can be followed by a Change-to interaction in the same list (`_shouldTriggerVariantInteractionWithMediaAction`).

### 7. Actions: order, sequencing, conditionals, variables [code, `triggerHotspot` @1827101, `runSequentialAction`, `SU` queue @~1800700]

- Every action of the interaction is appended to a queue (`SU`) in order, then `runNextAction()`.
- Navigate / Overlay / Swap / Change to / Back / Close: after starting, the queue **waits until that state change commits** (end of its transition) before running the next action (`handleStateChangeCommitted` / `handleHsmCommitted` → next). Scroll to: instant → continues immediately; animated → after the scroll animation ends. SET_VARIABLE, SET_VARIABLE_MODE, URL, media, timeline actions → next action immediately.
- The queue is **cleared** by a new ON_CLICK / MOUSE_DOWN / MOUSE_UP / ON_PRESS trigger, by an aborted change, by restart; reverse-hover / reverse-press commits do not advance it.
- CONDITIONAL: `s2.getFirstTruthyConditionalIndex(node, …)` (wasm, `runConditional`, expressions in `FGParameterDataEvaluator.cpp`) → index of the first true branch; that branch's actions are **inserted at the front** of the queue in order. No true branch → nothing, queue continues. Waits for the font list first.
- SET_VARIABLE: `runSetVariable` in wasm (scope = the hotspot or its containing primary instance; resolved modes of the hotspot); may also run Change-to actions of interactive components whose variant properties are bound to that variable (`getICActionsForSetVariableAction`). The history keeps the last value per variable.
- SET_VARIABLE_MODE: set id (or legacy set key) + mode id, `runSetVariableMode`; overlays then take their parent's modes again.
- URL: `connectionURL`, `openUrlInNewTab` (default true). Hyperlinks to a frame of the file navigate (to the page itself = restart).

### 8. Navigation stack (`PrototypeState`, cut @1236000–1298800; `cz`/`cH` @~790000)

- State = `cH {stateId (base screen), overlays[], animationState}`; history = list of changes `cz {old, new, cause, transitionParameters, direction, historyTransitionParameters}` (REMEMBER appends, RESET replaces, IGNORE keeps).
- `cz.isTransientChange()` @~792900: navigation type OVERLAY, SWAP or SCROLL_TO, an ephemeral navigation, a transient cause, or same base screen → transient.
- Navigate (`navigateToFrameAndCloseOverlays` @~1253000): new state = destination with **no overlays**; navigating to the current frame with no overlays is a no-op; sections' own histories updated (frames in sections). Destination resolution `getDestinationFrame` (a section → its frame).
- Overlay (`overlayFrame`): appends `hK {id, openingTransition, hotspot path, interaction id, derived modes}` to overlays, REMEMBER.
- Swap (overlay open → replace the top overlay's id keeping its slot; no overlay → acts as Navigate) — `_performNavigationOrOverlayChangeForHotspot`.
- Close (`closeOverlayForHotspot`): closes the overlay containing the hotspot **and all above it**, transition = that overlay's opening transition reversed, preserve-scroll on, default state settings (`cz.forClosingTopNOverlays`).
- Back (`returnToState2`, BEFORE_LAST_NONTRANSIENT_STATE = 1): needs history length > 1; drops trailing transient entries (overlays, swaps, hovers…), then pops entries until a valid one; if its old base screen is the current one → restore that entry's old overlay list (closes the overlays opened since); else navigate back to its old base screen with **no overlays**. The animation is the popped entry's transition (or its `historyTransitionParameters`) **played in reverse**, with the Back action's own reset settings. [inferred] Back from an overlay opened on the very first screen does nothing (history length 1 after dropping the overlay); use Close overlay.
- Reverse hover / press use BEFORE_LAST_ANY_STATE (2): no transient skipping — undo exactly the last change.
- Arrow keys/next-previous use the visual frame order (`cK` @~801000: same row = vertical overlap → by x, else by y; sections expanded in place).
- Changes wait for destination frames to load (`WAIT_UNTIL_DESTINATIONS_LOADED`); a new change commits any in-flight one first (`_clearInitiatedChangesBeforeNewChange`), i.e. a click mid-transition jumps the running one to its end.
- Leaving a frame reverts its instances' transient states (hover/press) (`_initiateStateChange`); a Change to on an instance reverts transient states of nested instances (`_requestInstanceStateChange`).
- Restart (`restartPrototype`/`resetPrototype`): ends JIT animations, resets local node changes, variables and modes, overlays, section states, component-state storage, scroll storage, entered nodes, timelines; clears history; goes to the flow start (`activePrototypeStartNodeOrDefault`) else the first visually sorted frame that is not a state group or group.

### 9. Reset rules by stateManagementVersion [code]

- Interaction default `stateManagementVersion` 0 (`sZ`); `cU.getDefault()` uses 1 (@~787600).
- v1 (`handleStateChangeInitiated`, handler @~1880000): before navigating, record every scroll offset of the old screen in a store keyed by the **semantic path** (`rd.getSemanticNodePathForNode` @821939: names + index among same-named siblings, from the top-level frame down; trie uses a "TLF Placeholder" for the top-level name [inferred: so paths match across screens]). Then: Reset scroll position on → set all scroll offsets of the destination to 0 (and store 0); off (default) → apply stored offsets for matching paths, 0 where none.
  - Component states (`hV` @1192355): Change-to histories of interacted interactive components (non-transient swaps) are stored by semantic path + state group; on arrival, instances with the same path get that state unless Reset component state is on (then their local instance changes are cleared). Instances whose variant is bound to variables are left alone.
- v0: preserve scroll (s1.transitionPreserveScroll) → match old/new scrollable frames by name, else equal size (±1), else same position (±1) and copy offsets; otherwise reset offsets of new frames to 0. No component-state transfer.
- Overlays: on open, the overlay receives its parent's resolved variable modes for collections it does not set explicitly; cleared on close.

### 10. Overlays [code, `h$` @~1204500, `hZ`]

- Settings come from the **overlay frame node**: `overlayPositionType` (default CENTER), `overlayBackgroundInteraction` (default NONE), `overlayBackgroundAppearance` (`sz` default `{NONE, rgba(0,0,0,.25)}`).
- Position relative to the **base screen's bounding box** (not the viewport): TOP_LEFT/CENTER/RIGHT, CENTER, BOTTOM_* by edges/centres; MANUAL = hotspot's scrolled top-left + action `overlayRelativePosition` (a manual overlay opened from an overlay adds that overlay's render offset). No clamping into the screen.
- Click outside: only with CLOSE_ON_CLICK_OUTSIDE and only when no ON_CLICK hotspot handled the click; closes the topmost overlay.
- Scroll/drag routing: topmost overlay first; a point outside it is blocked if its background is SOLID_COLOR, else passes to the next overlay / base screen.

### 11. Scroll physics (cut @1406500–1415500) [code]

- OS → physics `_J`: iOS / macOS → BOUNCING (`_7`), Android / Linux / Windows → CLAMPING (`pr`), else none. Relevant OS = the device's if it is iOS/Android, else the machine's (`_getRelevantOSForDevice`).
- Bouncing: fling = exponential friction, drag coefficient **0.135** (`pi`): pos(t) = p + v·(0.135^t − 1)/ln 0.135, end = p − v/ln 0.135; done when |v(t)| < 1/(0.05·dpr) px/s. Hitting a bound switches to a spring: mass **0.5**, stiffness **100**, damping ratio **1.1** (c ≈ 15.56), entry velocity capped at **5000**; spring done when |x − end| ≤ 1/dpr and |v| ≤ 1/(0.05·dpr). Rubber band while dragging past a bound: delta × 0.52·(1 − |overscroll|/size)².
- Clamping (Android-style `_4`): friction 0.015, deceleration rate ln 0.78 / ln 0.9, duration T = exp(ln(0.35·|v| / (0.015 · 61774.04968 · 0.84)) / (rate − 1)), distance |v|·T / 3.065, shape 1.2t³ − 3.27t² + 3.065t; the cross axis gets 0 velocity unless ≥ 50; clamped to bounds, no overscroll.
- Fling velocity from drag samples within the last 0.1 s; threshold 50·dpr px/s.
- Wheel: delta ÷ zoom; the scroll target sticks for 0.2 s between wheel events; ⌘/Ctrl + wheel zooms by 0.99^dy where allowed.
- Scroll direction restriction (`restrictScrollDeltaAxes`): HORIZONTAL / VERTICAL / NONE / BOTH (BOTH uses the overflow direction or actual overflow per axis).
- Sticky (`rh` @823601): a sticky child of the scroll container moves with the scroll until it reaches the container top (offset = min(scroll, its distance from the container top)); inside a non-scrolling parent it sticks only while the parent is in view, then is pushed up with the parent's bottom; inside a fixed parent: no offset. Standard children: offset = parent's scroll offset.

## Appendix B — Transitions, easing, Smart Animate — static reading

(Working notes of the static reading, kept as written; "[code]" = read from code, "[inferred]" = drawn from it. Superseded where the checklist above measured otherwise — e.g. shadows.)

Source: viewer-1e99064317a8d9ad.min.js (offsets @N are into this file unless noted), prototype-lib compiled_wasm.wasm strings (wasm-strings.txt line numbers). All "read from code" unless marked inferred. REA evidence for the bundle graph: ev_0f048de820828a29975f71676f6a9a3ce52b6b10396cbba42d7cc7035126eeb8.

### A. Easing (confirmations + extensions)
- Bezier sK @414100 = WebKit UnitBezier: cx=3x1, bx=3(x2−x1)−cx, ax=1−cx−bx (same for y); solveCurveX: 8 Newton iterations (stop |err|<eps or |dx|<1e-6), then bisection on [0,1]. eps = 1/(200·durationSeconds) (sj @415300). invert() uses the swapped bezier (y1,x1,y2,x2).
- Spring sX @416200: ω0=√(k/m), ζ=c/(2√(km)); ζ<1: ωd=ω0√(1−ζ²), A=1, B=(ζω0−v0)/ωd, x(t)=e^(−ζω0 t)(A cos ωd t + B sin ωd t); ζ≥1 (over-damped too): x(t)=(1+(ω0−v0)t)e^(−ω0 t) — over-damped springs are played as CRITICAL at ω0. value = 1 − x(t). solveInverse: 15-step secant on [0, π/ω0], tol 0.001.
- s$ @417020: value(p) = spring.solve(p · durationSeconds) (physical seconds, no normalisation; at p=1 value is not forced to 1 — the end state is committed when progress reaches 1). getDerivative returns its 2nd arg (no real derivative).
- sJ @417271: cache key = values.toFixed(2) + duration.toFixed(2) + animationType; animationType = spring iff easingType ∈ {SPRING, GENTLE_SPRING, SPRING_PRESET_ONE/TWO/THREE, CUSTOM_SPRING} (@418649); an action with no stored easingType passes undefined → bezier (harmless: default values are OUT_CUBIC's bezier).
- easingValuesForPreset @420414: IN_CUBIC/EASE_IN [.42,0,1,1]; OUT_CUBIC/CUSTOM_CUBIC/default [0,0,.58,1]; INOUT_CUBIC [.42,0,.58,1]; LINEAR [0,0,1,1]; IN_BACK [.3,−.05,.7,−.5]; OUT_BACK [.45,1.45,.8,1]; INOUT_BACK [.7,−.4,.4,1.4]; GENTLE/CUSTOM_SPRING [1,100,15,0]; ONE(Quick) [1,300,20,0]; TWO(Bouncy) [1,600,15,0]; THREE(Slow) [1,80,20,0]. Legacy "SPRING" falls to default → [0,0,.58,1] values but spring type → s$ with m=0,k=0.58… (degenerate; inferred: never stored by current editors).
- s1.easingFunctionValues @433267: CUSTOM_CUBIC and every spring preset use the action's stored easingFunction when present (so an edited-duration preset plays its rescaled stored spring); other beziers always use the table.
- s1.transitionDuration @433267: INSTANT (and not OBJECT_ANIMATION) → 0; stored value if ≥ 0 (so 0 stays 0 here); else 0.3. easingType default OUT_CUBIC.
- maxEasingMagnitude @418066 = max(1−bounds.top, bounds.bottom, 1) of the bezier hull (only for render-bounds padding; for springs the values are wrongly treated as bezier points).
- Hotspot hint flash (presentation "Show hints on click") @1525172: 0.7 s, opacity = 1 − ease([0,0,.58,1], t).

### B. Progress clock (legacy, non-JIT) — mn @1529482
- willStartTransitionWithDuration(d): elapsed 0. advanceToNextFrame: dt = now − lastFrame, **dt capped at 1/30 s**, elapsed += dt; progress = clamp(±elapsed/d + start, 0, 1). d ≤ 0 → progress jumps to 1 (0 for reverse). In progress while 0 ≤ p < 1. Then the easing is applied (easedTransitionProgress @1783022: easing.get(p); raw p when progress is driven externally, i.e. by a drag).
- Consequence: a slow frame (> 33 ms) slows the animation rather than skipping ahead.
- JIT clock (hq.computePlaybackTimeUs @1199649+): wall clock, no cap: t = min(durationUs, (now − start)·1000); "hold" phase returns duration.

### C. Frame-pair transitions — cN @764930–770900 (trans.js)
Units: translations are fractions of a size vector; at render (Sy @1720699, SI._renderTreeForBaseScreenTransition @1732300–1734900) the size is **max(newFrame.size, oldFrame.size)** component-wise (base screens) or the overlay rule below. Interpolation: cb.interpolateTranslation = lerp(from,to,easedT) (NOT clamped — springs/back overshoot); cb.interpolateOpacity = clamp(lerp(from,to,easedT),0,1) (@763687).
| type | entering (new) | exiting (old) | on top |
|---|---|---|---|
| INSTANT | — | — | duration 0 |
| DISSOLVE (also FADE, SMART_ANIMATE, MAGIC_MOVE as the frame-pair fallback) | — | — | DISSOLVE node: lerpTile(old,new, clamp(easedT,0,1)) = straight cross-fade of the two rasterised screens (@956304, di @629462) |
| MOVE_FROM_X | from OFFSCREEN_X (±1 of size) → 0 | static | entering |
| PUSH_FROM_LEFT | (−1,0) → 0 | 0 → (+1,0) | entering |
| PUSH_FROM_RIGHT = PUSH_FROM_LEFT.reversed() | (+1,0) → 0 | 0 → (−1,0) | exiting drawn on top (reversed flips the flag) |
| PUSH_FROM_TOP | (0,−1) → 0 | 0 → (0,+1) | entering; PUSH_FROM_BOTTOM = reversed |
| SLIDE_FROM_X | OFFSCREEN_X → 0, opacity 1 | 0 → **−OFFSCREEN_X / 4** (moves ¼ of the size the opposite way), opacity **1 → 0.5** | entering |
| SLIDE_OUT_TO_LEFT = SLIDE_FROM_RIGHT.reversed() | starts at ¼ offset, opacity 0.5 → 1, moves to 0 | 0 → OFFSCREEN (full) | exiting on top |
| MOVE_OUT_TO_LEFT = MOVE_FROM_RIGHT.reversed() | static | 0 → OFFSCREEN_LEFT | exiting on top |
reversed() @769800 swaps entering/exiting from↔to and flips the draw order. OFFSCREEN_LEFT = (−1,0), RIGHT (1,0), TOP (0,−1), BOTTOM (0,1); SLIDE_BACK_FRAME_OPACITY_START 1 / END .5.
- Old screen during a navigate keeps its own zoom: exiting transform = translate(size·exitT) · translate(newFrame.center) · scale(zoomBefore/zoomNow) · translate(−oldFrame.center) (@1733353) — i.e. both screens are centred on the viewport.
- Back / Close reverse: getFramePairTransition @796667 returns cN.get(type).reversed() when direction REVERSE. Back (returnToState2/_returnToFrame @1264350) uses the last change's historyTransitionParameters ?? transitionParameters with direction REVERSE — Back replays the transition that brought you here, backwards, with its duration and easing.
- Overlay restrictions (s1.transitionType @432546): navigationType OVERLAY with FADE/PUSH*/SLIDE* → INSTANT; SCROLL_ANIMATE outside SCROLL_TO → INSTANT.
- transitionPreserveScroll @433900: true for SMART_ANIMATE (or a smart-animatable type with matching on); false for SLIDE/PUSH/MOVE_IN; otherwise the stored flag.

### D. Overlays — SI._renderTreeForOverlayTransition @1734900–1736900 (ovl.js)
- Overlays common to old and new stacks (same ids, prefix) draw unchanged.
- Leaving overlays: background (overlay dim) opacity 1 − easedT; overlay translated by D·exitT where D = overlaySize + o, o = its rendered origin relative to the base screen (top-left), or for MOVE_FROM_RIGHT/BOTTOM o = baseSize − (origin + overlaySize) — i.e. **the overlay moves exactly far enough to leave the base screen's edge**, not the screen size. Opacity by the pair's exiting opacity.
- Entering overlays: background opacity easedT (not clamped in JS), same distance rule with enteringFrameTransition.
- Dissolve: leaving group and entering group cross-faded (DISSOLVE node).
- Closing an overlay = REVERSE of its openingTransitionType → it leaves the way it came (Move in from bottom closes moving down) with its opening duration/easing (hK.openingTransitionType @1206338; ms.computeDragVector1 CLOSE branch @mr-mo.js:203).
- Smart animate between overlays (same stack depth, top differs): magic-move plan of the two overlays; overlay backgrounds cross-faded (OVERLAY_BACKGROUND_DISSOLVE); the overlay's position lerps from the old rendered origin to the new: pos = newDelta·t + oldOrigin·(1−t).
- Smart animate base-screen navigate with old overlays open: old overlays fade/move with the exiting pair transition and cross-fade (DISSOLVE) against the magic-move tree.

### E. Smart Animate (legacy path = default)
- When JIT is used (u_ @813053): only if flags metronome && !disable_jit and (mix_jit_default_enabled, or eclipse && transitionOverridesEnabled, or (content has a motion clip && action.enableJitSmartAnimate), or content has 3D transforms). Otherwise the legacy plan-tree path below. ug: smart animate = type SMART_ANIMATE, or a MOVE/PUSH/SLIDE type with transitionShouldSmartAnimate ("Animate matching layers").
- Matching and plan building are in C++ (prototype-lib wasm): mr.getMagicMovePlanForTransition / getMagicMovePlanForStateSwap / getNodeMatches(oldFrame,newFrame) → map oldNodeId → newNode (@1527788). The rules (name / hierarchy) are NOT readable from the JS; wasm strings show `computeInstanceNameHierarchyMatchingHelper`, `closest-ancestor-node-matches`, `computeMatchingInstancesInStateGroup`, FGSubtreeMatcher.cpp, FGComponentPropMatcher.cpp (wasm-strings.txt ~10099, 10651) — name+hierarchy matching with instance-aware helpers (inferred).
- Plan tree node hM @1163935: oldSceneNode → newSceneNode, isMatchedNode, isDissolve (subtree cross-faded: forDissolveStart / forDissolveEnd rendered and lerped by DISSOLVE, SE.customRenderTree @SE-Sy.js:66), enabledTraits bitmask hP @1163579: SCROLL_BEHAVIOR 1, CLIPPING 2, FILL_PAINT_DATA 4, STROKE_PAINT_DATA 8, GEOMETRY 16, BLENDING 32, EFFECT_DATA 64, MASKING 128, TEXT_DECORATION_FILL_PAINT_DATA 256, TRANSFORM_MODIFIER_DATA 512.
- Per node (SE @1696525): opacity = transition.interpolateOpacity(easedT) only when BLENDING trait set, else 1; **blendMode() = PASS_THROUGH when the node lacks the BLENDING trait** → explains the live observation that blend modes drop during Smart animate; clipping only with CLIPPING trait; masks only with MASKING; effects only with EFFECT_DATA (none for dissolve nodes); absoluteTransform = C++ planNode.absoluteTransform(0,t,t,t) (transform decomposed into translation/scale/angle — debug print @hM.js:118 shows translation, scale, angle in degrees).
- Transition object hb @1153816 (C++ backed): hasTransitioning{Opacity,Translation,Transform,Scaling,TransformOrigin,CornerRadii,Effects,Paints,GeometryForRoundedRectangles,StrokeForRoundedRectangles}, hasLegacyTransitioningSizesForImageRect.
  - Rounded rectangles (frames/rects): size = lerp(fromSize,toSize,t); each corner radius = max(lerp,0); stroke weight lerps; INSIDE/CENTER/OUTSIDE handled; strokeAlign reported CENTER while transitioning (@hb.js:74–120; SE.strokeAlign).
  - Paints (_getPaints @hb.js:153): pairwise by index, lengths must match (else the from list is kept); equal paints unchanged; a paint with opacity 0 takes the other paint's type/content at opacity 0 (so a fill fading in/out of a different type morphs, not pops). VolatilePaint ol @471665: colour = per-channel straight lerp of RGBA (iv.mix @242999, no premultiply, sRGB values); paint opacity clamp(lerp,0,1); paint transform lerped (on.lerp1 around centre); images: size/scale-mode change interpolated (STRETCH/FIT/FILL/CROP) with angle lerp; type/blend mode = from's.
  - Effects (_getEffects @hb.js:168): if an effect differs within its type (or origin/radii transition): DROP_SHADOW / INNER_SHADOW keep the FROM value in this JS path (no tween here), blurs get an interpolated effect oA. Same effects: unchanged. (Shadow tweening, if any, would be in C++ — not seen.)
  - Text, vectors: decided in C++ (no JS path); live data (prototype-playback.txt §7): font-size-only change = one text scaled; characters/style change = cross-fade; colour interpolated.
- Change-to (instance state swap, HSM) @1778215: per-instance tracker mn with duration = JIT runtime duration or transitionParameters.transitionDuration; progress eased unless driven by drag; plan via getMagicMovePlanForStateSwap.

### F. JIT smart animate (keyframe path, flag-gated) — hq @1199649, mO @1573446
- startSmartAnimate stores animationDurationUs, source/destination, triggerInteractionType, phase "forward".
- mO.onFrame: t = computePlaybackTimeUs(now); when t ≥ duration: ON_HOVER forward → phase "hold" (stays at the end while hovered); other triggers → completeAnimationAndCleanupKeyframes → navigate/commit destination.
- Leave mid-hover (@1875069): if the pointer leaves the trigger bounds, beginReverseAnimationSurface(now, durationUs): phase "reverse" over the FULL stored duration starting now, built as a reversed JIT animation from destination to source (uA reversed:true). Not resumed from the mid-point (inferred: the reverse starts from the destination end — matches the live "jumps to the hover's end, animates back").
- Drag-driven JIT: easing forced to LINEAR [0,0,1,1] when the trigger is DRAG (uS @813420).

### G. Drag-to-animate — ms @1534713 (mr-mo.js:140–274), mo @1542366
- Drag vector: Smart animate → the matched layer's centre in the new frame minus its centre in the old frame, each in its frame's coordinates (getNodeMatches). Other types (not DISSOLVE/INSTANT/SMART_ANIMATE): translation delta (to − from) of whichever frame is drawn on top, × size (max of the two frames; for OVERLAY/SWAP the destination's size).
- Progress = clamp(dot(pointer − start, v) / |v|², 0, 1); during the drag the raw progress is used (no easing).
- Release: speed = dot(velocity, v)/|v|² (progress units / s, from the last two pointer samples). Threshold = 0.15 / duration. If progress ≥ 0.5: revert only if speed ≤ −threshold; else commit only if speed ≥ +threshold.
- Legacy settle: r = easing.invert(progress); s = 1; if reverting s = clamp(log2(r+0.5)+1, 0.02, 1); if |speed| ≥ 1/duration: s = |speed / easing'(r)|; settle time scale l = duration / s; progress then runs linearly (un-eased clock from r) to 0 or 1 → remaining time = (1−r or r)·l, eased by the action's easing.
- JIT settle: linear, duration = |target − progress|·duration (min 1 µs).

### H. Scroll to (SCROLL_ANIMATE) @1895127, hy @1078653, fq/fK @1502904
- Container = nearest ancestor with scrollDirection ≠ NONE or top-level, not too rotated. desired offset = target.absTranslation + extraScrollOffset − container.absTranslation; clamped to [min,max]. SCROLL_ANIMATE: per axis pos(t) = begin + (end−begin)·curve.get(clamp(t/duration,0,1)) (overshoot allowed by springs); otherwise jump.

### Open (needs live probes or wasm decompilation)
- Exact matching rules (name vs id vs path, duplicate names, instances of different mains), unmatched-layer fade timing, text/vector morphs, shadow tweening, auto layout during animation, opacity clamp inside C++ interpolateOpacity.

## Appendix C — Architecture and stored values — static reading

(Working notes of the static reading, kept as written; "[code]" = read from code, "[inferred]" = drawn from it. Superseded where the checklist above measured otherwise — e.g. shadows.)

Build read: 2026-10-20. Files (scratchpad proto-rea/b, b2): viewer-1e99064317a8d9ad.min.js (V), prototype_app-5402c01db97d2664.min.js (P),
prototype-lib compiled_wasm.wasm 28.8 MB (W) + compiled_wasm.js, figma_app-ce44270e1f795160.min.js (F),
42416-6aab7d1c2233d2db.min.js (editor inline-preview chunk, E), 26289-41a8b38d3cea794e.min.js (device sizes), 39133-159abe89cc886130.min.js (slides embed).
All "read from code" unless marked. Offsets are byte offsets in the decoded file.

### 1. Architecture

#### Processes / pieces
- /proto page = `prototype_app` shell (React) which preloads the `prototype-lib` wasm: `(0,_.F$)("prototype-lib")` P@60004. The player
  itself is the `viewer` bundle (TS, ~2 MB) + prototype-lib wasm.
- prototype-lib wasm = Figma's C++ `fullscreen/lib` scenegraph (scenegraph, node facets, motion, expressions, layout, text, kiwi,
  graphics/webgpu, gl) plus `fullscreen/lib/prototype/{PrototypeLib,InteractiveComponents,Variables,PrototypeDocumentSyncing,
  PrototypeAnimationHelpers,WasmImageManagerBindings}.cpp`, `SmartAnimateTransitionBake.cpp`, `viewer/RTCompositeTileCache.cpp`
  (W strings). Exports seen in compiled_wasm.js: computeJitSmartAnimateMatchPlan, bakeSmartAnimateTransition,
  computeSmartAnimateTrackGroups, getResolvedVariableModesForPrototype, getEffectivePrototypeStartNodeId, decodePrototypeInteractions,
  WasmHotspotRendererBindings_draw, drawPrototypeDevice, play/pause/setPlayhead PrototypeAnimationTimeline.
- TS side (V) owns: the player state machine (PrototypeState, change history, overlays), event dispatch / hit-testing (TS unless gate
  `viewer_cpp_hittest`), transitions (render-tree composition with eased-progress closures), scroll physics, the viewport/fit modes,
  tile compositor, image/video managers, multiplayer client. Every scene node accessor goes through the wasm
  (`s2.nodeTsApi().getPrototypeBackgroundColor(rz.Sie.PROTOTYPE_LIB)` V@1100735; overlay fields V@1067172).
- C++ (W) owns: document, layout ("updateImmutableFramesAndLayoutDirtyGroupsAndStacks"), variables / expressions / conditionals
  (`getFirstTruthyConditionalIndex`, `runSetVariable`, `runSetVariableMode`, `getICActionsForSetVariableAction`, `shouldDisallowSwap`
  V@1172069), instance interaction inheritance, smart-animate matching (`mr._tryGetNodeMatchesCpp`, `_tryGetMagicMovePlanCpp` V@1527788).

#### How the document arrives (V@1622446–1651124, IncrementalFrameLoader mz V@1605433)
- The viewer opens its own multiplayer WebSocket (class mG wraps `new WebSocket`), role `"viewer"` (V@1622446),
  URL built by `_mpContext.url({fileKey, role, connectionType:"initial-load"|"reconnect", canvasQuerySkipContainers:true})` V@1631847;
  reconnect adds `reconnect-sequence-number`, `scenegraph-queries`, `reconnect-key`. A preconnected socket is reused if URL matches.
- Not the whole file: incremental frame loading. Root query `(0:0, depth 1)` (document + pages, shallow; `_setLoadFullDocument` switches
  it to depth 0 = everything) V@1606128/@1606817; then `SCENE_GRAPH_QUERY` messages listing `(topLevelFrameId, 0)` subtrees V@1650794.
  Which frames: BFS over the navigation graph from the current screen(s) — destinations of every interaction (incl. conditional branches),
  Back's removed frames, variant sets of instances with variable-bound variant props, hyperlinks — depth ≤ 8 (mobile 2), ≤ 64 frames
  (mobile 4), sent 4 TLFs per batch (`MAX_PROTOTYPE_TLF_BATCH_SIZE=4`) V@1605433, @1610300. Linear prototypes (slides): ±2 frames
  (`MAX_SLIDESHOW_PRELOAD_DISTANCE()=2`) V@1605981. Frame eviction only with mobile optimisations (`protoUseFrameEviction`) V@34521.
- Loading phases: `getSceneLoadingPhase`/`handleSceneChangedLoadingPhase` with PENDING_INITIAL_LOAD, PENDING_LOAD_AFTER_RECONNECT, LOADED
  (V@1183500 hB, gV @~1956000).
- Live edits: the editor's edits go to the multiplayer server like any client; the viewer receives NODE_CHANGES for the subscribed subtrees
  (`willReceiveNodeChanges/didReceiveNodeChanges` V hB). Each scene-graph event invalidates the viewport (`handleSceneGraphEvent` →
  `_viewport.invalidate()` unless property NAME; base-screen PARENT_INDEX/SIZE/PROTOTYPE_DEVICE re-fit) V viewer-main L1062.
  [inferred] no local shortcut from editor to inline preview for document data: the inline preview iframe is a separate /proto page
  with its own socket; the editor↔iframe channel carries only control messages (below).
- `multiplayerLocalBroadcaster` BroadcastChannel (V@1949500) is the presenter/audience (spotlight/slides) relay of user changes
  (recentClicks, instanceStateChanges, triggeredOverlaysData, …), not document edits.

#### Inline preview (editor side, E)
- iframe `/embed?embed_host=inline-viewer&url=…/proto/<file>?…&hide-ui=1&inline-viewer=1` (earlier live note); slides embed builds
  `bare-ui=1&scaling=fit-width&content-scaling=fixed&needsAlpha=1&inline-viewer=1&starting-point-node-id=` (39133@2357798).
- Control channel `window.postMessage(…,"*")` both ways, origin-checked on receive (E@6851477 module 744394):
  editor → viewer: NAVIGATE_TO_FRAME_AND_CLOSE_OVERLAYS {nodeId, playbackGeneration, startingPointNodeId}, NAVIGATE_FORWARD,
  NAVIGATE_BACKWARD, RESTART, SET_SCALING_MODE {scalingInfo,userInitiated}, SET_INTERACTIONS_ENABLED, RETARGET_TRANSITION_PREVIEW,
  SMART_ANIMATE_START_AND_SEEK, REQUEST_EXPORT/CANCEL_EXPORT, TIMELINE_PLAYER_PLAY/PAUSE/RESET,
  INLINE_PREVIEW_WAS_MODAL_OPENED_SINCE_VIEWER_LOADED.
  viewer → editor: INITIAL_LOAD, INLINE_PREVIEW_READY_TO_RECEIVE_MESSAGES, PRESENTED_NODE_CHANGED {presentedNodeId, baseScreenNodeId},
  INLINE_PREVIEW_SET_FRAME_CONTROLS, REQUEST_CLOSE, SMART_ANIMATE_TRANSITION_STATE, UPDATE_TIMELINE_PLAYER_STATE, EXPORT_COMPLETED.
  keydown/keyup inside the iframe are re-dispatched on the iframe element (key "Unidentified" while interactions enabled).
- Selection follow: editor dispatches HANDLE_EDITOR_SELECTION_CHANGED (F-chunk E@1599729) only in the fullscreen view; reducer
  (E@6840613) → `getInlinePreviewNodeIdOnSelectionChange()` → navigateTo(node) if it is a valid frame, else keeps / falls back
  (deleted current node → first flow start or close). UPDATE_PRESENTED_NODE with target-frame-following scrolls the canvas;
  5 follow events trigger a one-time tip.

#### Rendering (V)
- Renderer choice `makeRenderer` (viewer-main L566): WebGPU (`_X`) when `useUnifiedRenderer()` && `isWebGPUSupportedAndAllowed` &&
  device initialised and no WebGL fallback requested; else unified WebGL (`_j`) when `useUnifiedRenderer()`; else legacy TS WebGL2
  renderer (`ls`). `useUnifiedRenderer = gate viewer_editor_renderer_unification || veru_wasm_rendertree || webgpu_override` V@31607.
  Render tree in wasm when `veru_wasm_rendertree`.
- Continuous rAF loop (`internalOnFrame` V@334294) fires WINDOW_FRAME every frame; drawing is on demand: `setNeedsBlit`, a
  tracker keeps "rendering" for 3 more frames after the last blit request (`FRAMES_TO_FINISH_RENDERING=3`, S$ viewer-main L449).
- Per frame `_onFrame` (viewer-main L1147): frame++ ; run due timed interaction callbacks (After delay, maintained hover/press
  delays); appState.onFrame (state machine, transitions); tick code-layer animations; clamp dirty scroll containers; scroll animation;
  blit if interacted or needed; idleness/zoom tracker; viewport prepare (camera animation 0.2 s); responsive resize of the base screen;
  re-fit viewport; send cursor to multiplayer; apply multiplayer scroll offsets; compute background colour; hotspot flash rects;
  `renderer.draw(viewport, uiRenderData)`; transition progress to multiplayer; afterFrame; process stored pointer release.
- Tile compositor budget per frame (m8 V@1664158): 16 ms (`defaultTimeBudgetInSeconds=.016`), 2 tiles rendered per frame,
  250 render-target switches. Tile config (_k V@1384663, V@1753108): tile 512 px (256 with mobile optimisations), texture = device
  max texture size (2048 mobile), 6 initial textures (3 mobile), unlimited textures on desktop / 384 MB target on mobile; SSAA x4
  (x2 when DPR > 3); tiles per texture multiple 64 (16 mobile).
- Transitions (SI V@1729934): the whole transition is one render tree built once and cached on the transition
  (`cachedRenderTree`), animated by closures reading the eased progress: exiting/entering frames wrapped in opacity / transform /
  translation nodes; translation unit = max(old size, new size) × direction vector; dissolve = cross-fade node; smart animate =
  magic-move plan render tree; overlays: own background nodes that fade (ENTERING/EXITING_OVERLAY_BACKGROUND), Move from right/bottom
  measured from the far edge.
- Frame-pair transitions (cN V@764115): SLIDE_FROM_X entering 1×size from X to 0, exiting 0 → ¼ size the other way with opacity
  1 → 0.5; PUSH_FROM_X entering from X, exiting fully out opposite; MOVE_FROM_X entering only; *_OUT_TO_* = reversed of the opposite
  FROM (and the exiting frame drawn on top); default draw order entering on top.
- Preloading: images of ±2 nearby frames for linear prototypes (online, gate) / ±3 offline slides (ha V@1035245); shader prefetch
  for current −1…+3 slides (mU V@1602869); embedded prototypes window current, +3, −1, at most 1 active (2 with gate) (aN V@348995).
  Image manager: 4 simultaneous preloads.
- Input: double-click = second press < 500 ms and < 4 px (V@334404). MAX_MICROTASKS_PER_FRAME 2. Zoom in presentation (not inline):
  ×2 / ×0.5, reset 1, zoom-to-fit padding 50, zoom 1/64 … 256 (cL V@773799).

#### Fit modes (V@514046, @782503, @1247809)
URL `scaling=`: contain, contain-with-zoom, scale-down (default for unknown), min-zoom, scale-down-width, fit-width, free, responsive
(= contain + content-scaling responsive); `content-scaling=fixed|responsive`.
Scale: scale-down-width = min(1, viewW / contentW); fit-width = viewW / contentW; contain / scale-down / contain-with-zoom =
1/max(cw/vw, ch/vh) (scale-down capped at 1) then rounded UP so content height is whole pixels: ceil(s·h)/h; min-zoom / none = 1;
free = 0 (user camera). The frame's layout viewport: contain-family → infinite (no responsive reflow); fit-width family →
(∞, viewH / scale); others → the view size.
Background (u3 V@971219): no canvas → black; no base screen → page bg; transparent-background flag → transparent; free → page bg;
override colour if set; page `prototypeBackgroundColor` if not transparent; else BLACK.

### 5. Stored values / defaults

#### Reaction model defaults when reading (V s1/sQ/sZ @421661–437500)
- interactionType missing or NONE → ON_CLICK; interactionMaintained false; interactionDuration missing/negative → 0.3 (0 kept);
  transitionTimeout missing/negative → 0.8 (0 kept); keyTrigger {} ; default event {NONE, false, 0, {keyCodes:[], triggerDevice:KEYBOARD}, 0}.
- transitionType missing → INSTANT_TRANSITION; for navigationType OVERLAY, FADE/PUSH/SLIDE become INSTANT; SCROLL_ANIMATE outside
  SCROLL_TO becomes INSTANT. transitionDuration: INSTANT (non object-animation) → 0, else stored ≥0, else 0.3. easingType missing →
  OUT_CUBIC. easingFunction used only for CUSTOM_CUBIC / GENTLE / SPRING_PRESET_ONE/TWO/THREE / CUSTOM_SPRING (else preset table).
- transitionPreserveScroll: true for smart animate; false for slide/push/move; else stored. transitionResetScrollPosition,
  transitionResetVideoPosition, transitionResetInteractiveComponents default false. openUrlInNewTab default true.
  mediaSkipByAmount 5, mediaPlaybackRate 1, navigationType NAVIGATE, connectionType NONE.
- stateManagementVersion 0 = "old noodle" (tracked as legacy); cU.fromPrototypeAction(action, version) builds the transition
  parameters with state-management settings V@787295.
- Instance interactions vs main (sZ.applyInteractions V@425853): main's list, then each own interaction with the same id is applied
  field-wise (only non-null fields override; only the first action merged), others appended, isDeleted ones removed. Actual
  inheritance for derived nodes is computed in C++ [inferred: wasm exports prototypeInteractions per node].
- Hotspot flash ignores Change-to-only interactions on ON_HOVER / ON_PRESS / AFTER_TIMEOUT, and media triggers (V viewer-main _findHotspotsToAnimate).

#### Multiple actions / conditionals / variables (V viewer-main L723–815, SU L154)
- All actions of an interaction are queued; one runs, the next runs after the state change it caused commits (or immediately when it
  causes none: URL, SET_VARIABLE without IC swaps, SET_VARIABLE_MODE, media); queue cleared on abort, on restart, and when a new
  click / mouse down / mouse up / press triggers; not continued for REVERSE_HOVER / REVERSE_PRESS changes.
- CONDITIONAL: C++ `getFirstTruthyConditionalIndex(node, firstBranchCondition)`; the chosen branch's actions are inserted in the
  queue in place. Waits for the font list.
- SET_VARIABLE: C++ runSetVariable(scopeNode = containing primary instance or node, variableId, data, resolvedModes); first runs
  "IC actions" — Change-to swaps of instances whose variant props are bound to the variable.
- SET_VARIABLE_MODE: set id from targetVariableSetID or deprecated key; C++ runSetVariableMode(scopeNode, setId, modeId,
  extensionId); also broadcast to multiplayer observers. W: "Can only set variable mode values on local variables".
- Modes are resolved at trigger time: `node.getResolvedVariableModesForPrototype()`.

#### Scrolling (V@1072834–1077100, @822300, @839985)
- scrollDirection: frame-like nodes that constrain children (not SLIDE): the base screen (top level, role 0) = BOTH, others = their
  overflowDirection; non-frames NONE. Scrolls only if content (children's scrolling bounds, fixed children excluded) exceeds the
  frame on that axis.
- Fixed: scrollBehavior FIXED_WHEN_CHILD_OF_SCROLLING_FRAME and parent scrollable (overflow ≠ NONE or top-level FRAME). Fixed layers
  must be the last children (index ≥ last non-fixed + 1) and are drawn after (above) all scrolling content.
- Sticky (STICKY_SCROLLS), vertical only: in a scrolling parent it moves with the scroll until its top reaches the scroll container's
  top, then holds: dy = min(scrollY, stickyTop − containerTop); inside a non-scrolling parent within a scrolling ancestor it holds
  only while its parent is in view and is pushed out with the parent's bottom.
- Scroll physics by OS / device: iOS, macOS → bouncing (friction drag 0.135, rubber band 0.52·(1−x)², overscroll spring
  mass 0.5 k 100 ζ 1.1, spring velocity ≤ 5000); Android, Linux, Windows → clamped Android-style fling (friction 0.015,
  deceleration ln .78/ln .9, cross-axis velocity < 50 dropped) (V@1405500).

#### Devices (26289@643758, F@1326142, schema 78711@12923577)
- PrototypeDevice {type NONE 0 | PRESET 1 | CUSTOM 2 | PRESENTATION 3, size, presetIdentifier, rotation NONE | CCW_90}.
- Preset screen sizes (pz): Android Compact 412×917, Android Medium 700×840, iPhone 16 393×852, 16 Pro 402×874, 16 Pro Max 440×956,
  16 Plus 430×932, iPhone 17 402×874, Air 420×912, 17 Pro 402×874, 17 Pro Max 440×956, 15/15 Pro 393×852, 15 Plus/Pro Max 430×932,
  14 390×844, 14 Pro 393×852, 14 Plus 428×926, 14 Pro Max 430×932, 13/13 Pro 390×844, 13 Pro Max 428×926, 13 mini / X / 11 Pro
  375×812, 11 / 11 Pro Max 414×896, SE 320×568, 8 375×667, 8 Plus 414×736, Pixel 2 411×731, Pixel 2 XL 411×823; Android Large /
  Small archived. Each preset: artwork imageSize, scaleFactor 3, offset, hit-target SVG (835864 in E@1888798). Slides 1920×1080,
  1024×768.
- Overlay: OverlayPositionType CENTER 0 … MANUAL 7; OverlayBackgroundInteraction NONE | CLOSE_ON_CLICK_OUTSIDE;
  OverlayBackgroundAppearance {NONE | SOLID_COLOR, color}. The panel toggles write SOLID_COLOR / NONE and CLOSE_ON_CLICK_OUTSIDE /
  NONE through C++ setters (78711@367263); the colour given on enabling is chosen in C++ (not found in JS).
