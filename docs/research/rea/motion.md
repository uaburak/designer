# Motion & prototyping animation — Figma vs Wecra (REA round, 2026-10-15)

What Figma's current build does for Motion (keyframes, easing, springs, timelines, animation styles, text stagger, export) and for prototype animation, what Wecra does today, and the ordered work to close the gap. It also lists what `docs/motion.md` (the Round 8 contract, written 2026-10-12 without access to Figma's code) must change before Round 8 starts.

**Sources.**
- Figma: a clean-room static reading of the owner's installed desktop app cache (current build). The modules are `3187.min.js` (Plugin API motion surface @3.26–3.53 MB, easing tables module 551153, spring maths 110210, keyframe easing resolution 957593, unit conversion 565744, the keyframeable allowlist 985763, the preset sources and the `figma:motion` runtime 910280, the preset propDefs @13.90–13.93 MB, and the embedded kiwi schema text), `figma_app` (manual keyframe tracks ↔ document 892667, spring normalisation 508579, easing labels 402803 / 435729, the animation style catalogue 687932, Sites behaviours 715063), `3653.min.js` (timeline settings), `timeline_renderer_worker.min.js`, `1462.min.js` (CSS codegen) and the wasm's strings. The evidence column quotes offsets or module ids. Only short snippets are quoted. The working notes are outside the repo (scratchpad `rea-work/motion/static-notes.md`).
- Live probes: none ran. The first `use_figma` call (file `2Rh4mZi09rwwECJE0xBG8Z`) hit the Figma MCP's Starter-plan call limit, so nothing was created or read. The 14 probes are listed in §5.
- Wecra: `docs/motion.md`, `docs/roadmap.md` "Round 8", `docs/handoff.md`, `schema/document.kiwi`, `engine/src/proto/{Prototype,Player}.*`, `src/renderer/src/editor/{model/prototype.ts,agents/prototypeSpec.ts,panels/prototype/InteractionDetails.tsx,plugins/api/nodes.ts,canvas/BottomToolbar.tsx}`, `src/shared/fig/convert.ts`. Figma's older schema dump `docs/research/figma/figma-schema-106.kiwi` gives the field numbers; the embedded schema is newer (§2.24).

**Confidence.** *High*: read directly from the code, consistent across modules. *Medium*: read from code whose branch conditions or call sites were not fully traced. No item is probe-confirmed.

**State of the round.** Round 8 (Motion) is deferred by the owner (`docs/roadmap.md:387`, `docs/handoff.md:40`). Nothing of it is built. The toolbar's Motion segment is disabled (`BottomToolbar.tsx:130–132`), there is no `engine/src/motion/` and no `src/shared/motion/`, and every motion `NodeChange` field is still a placeholder (`schema/document.kiwi:2165–2181`). What exists is the prototype side: transitions, Smart animate, Figma's named easings and physical springs in `engine/src/proto/`. This report therefore has two halves: prototype fixes that apply to shipped code now (priorities 1–2), and contract corrections plus the build order for Round 8 when the owner reopens it.

---

## 1. Summary

| # | Feature | Wecra | Size | Prio |
|---|---|---|---|---|
| 1 | Prototype transition direction mapping (Plugin / agent shape) | **different** (MOVE_OUT / SLIDE_OUT not inverted; plugin `reactions` returns raw kiwi) | S | 1 |
| 2 | Prototype timing units and defaults (0 → 0.3 s, mouse delays, `stateManagementVersion`) | partial | S | 1 |
| 3 | Easing presets: exact numbers | partial (prototype curves done; CUSTOM_CUBIC default wrong; EASE_IN written as IN_CUBIC) | S | 1 |
| 4 | Prototype custom easing clamps (Plugin / agent writes) | partial | S | 2 |
| 5 | Spring maths: settle time, ζ clamp, v0, editor duration | partial | S | 2 |
| 6 | Schema drift: adopt the motion schema from the current build, not 106 | missing (contract based on 106) | M | 2 |
| 7 | Contract corrections in `docs/motion.md` | different (8 decisions contradicted by the code) | S | 1 |
| 8 | Keyframe storage: `EXPRESSION KEYFRAME [base, KEYFRAME_TRACK_PARAMETER_DATA]` | missing; contract **different** | M | 3 |
| 9 | KEYFRAME_TRACK / KEYFRAME nodes, upsert by µs | missing | L | 3 |
| 10 | Keyframe default easing: IN_CUBIC (0) = unset → CUSTOM_CUBIC (.5, 0, .5, 1) | missing; contract **different** | S | 3 |
| 11 | Normalised springs in keyframes (bounce ↔ physical, x scaled by T) | missing; contract **different** | S | 3 |
| 12 | Stored units and write clamps (opacity ×100, rotation −rad, µs) | missing; contract **different** | S | 3 |
| 13 | Keyframeable allowlist and the XY vs X / Y exclusivity | missing | S | 3 |
| 14 | Motion transform (`motionTransform 523`, composition, pivot) | missing (contract matches) | M | 3 |
| 15 | Timelines: `timelineDuration 512` on the top-level frame; nested `timelineDefinitions` / assignments | missing; contract **different** | M | 3 |
| 16 | Timeline settings: ms / frames units, FrameRate grid, Once / Loop / Ping pong | missing; contract partial | M | 4 |
| 17 | Animation styles = code presets against `figma:motion`, materialised tracks | missing; contract **different** | XL | 4 |
| 18 | First-party preset catalogue and defaults | missing; contract **different** | M | 4 |
| 19 | Text stagger (`textElementDelayBehaviour` 1–7) | missing; contract partial | L | 5 |
| 20 | Motion easing menu and editors (HOLD first, Bezier / Spring switch, graph) | missing (prototype panel has numeric fields only) | M | 4 |
| 21 | Plugin `figma.motion` and node motion API | missing | L | 5 |
| 22 | `UPDATE_ANIMATION_TIMELINE_STATE` prototype action | missing | M | 5 |
| 23 | Smart animate as generated keyframe tracks (JIT), `useLegacySmartAnimate` | different (direct interpolation; same look) | L | 6 |
| 24 | Transition overrides (per-property smart-animate timing) | missing | L | 6 |
| 25 | Video / GIF / Lottie / animated SVG export, plan limit | missing | XL | 5 |
| 26 | Audio and video fills on the timeline | missing | L | 6 |
| 27 | Sites behaviours' separate easing table | missing (Sites set aside) | S | 7 |

`docs/motion.md` is wrong on eight decisions and must change before Round 8 starts (§3, task 1): where the base value lives (§4.2), what IN_CUBIC means on a keyframe and the default easing (§4.7), how springs are stored in keyframes (§4.7), stored units for opacity and rotation (§4.5), where the default timeline's duration lives (§4.3), presets evaluated in C++ and never materialised (§3 decision 6, §4.6), the preset catalogue and its defaults (§4.6), and `TextElementDelayBehaviour`'s fields (§4.1, §4.10). It also uses `keyframeValueRef 586`, `timelinePositionType 510` and `isClip 545`, which the current build marks deprecated.

---

## 2. Figma behaviour → Wecra today, per feature

### 2.1 Prototype transition direction mapping — **different**, high
**Figma.** The kiwi `TransitionType` stores the side the destination comes from. The Plugin direction is the direction of motion. The Plugin writer swaps LEFT ↔ RIGHT and TOP ↔ BOTTOM for **every** directional type: `MOVE_IN → MOVE_FROM_`, `MOVE_OUT → MOVE_OUT_TO_`, `PUSH → PUSH_FROM_`, `SLIDE_IN → SLIDE_FROM_`, `SLIDE_OUT → SLIDE_OUT_TO_` (3187 @3265011+: `case"MOVE_OUT":i="MOVE_OUT_TO_"` … `case"RIGHT":return"LEFT";case"LEFT":return"RIGHT"`). The reader is symmetric (`e.includes("_LEFT"):return"RIGHT"`). So Plugin `{MOVE_OUT, direction LEFT}` is stored as `MOVE_OUT_TO_RIGHT`. `matchLayers ↔ transitionShouldSmartAnimate`. DISSOLVE, SMART_ANIMATE and SCROLL_ANIMATE pass through. INSTANT_TRANSITION reads back as `transition: null`.
**Wecra.** The agents' tool and its reader use the panel's model. `transitionOf` inverts only the "in" types (`model/prototype.ts:476–478` `OPPOSITE`). The "out" types use `TOWARDS`, which is the identity (`:469`, `:479–480`, reader `:486`, `:496–499`). So an agent's `{MOVE_OUT, LEFT}` is stored as `MOVE_OUT_TO_LEFT`, the opposite of Figma's. The plugin API does not convert at all: `node.reactions` returns and accepts the raw kiwi `prototypeInteractions` (`plugins/api/nodes.ts:394–397`, runtime `figma.js:92–93`), although `docs/plugins.md:393` promises the shapes of `prototypeSchema.ts`.
**Build.** Give the Plugin-shape conversion its own direction tables (Figma's symmetric swap for all five types) in `agents/prototypeSpec.ts`, and leave the panel's `transitionOf` / `animationOf` alone until a probe shows how Figma's panel draws `MOVE_OUT_TO_LEFT` (probe 5.9). Route plugin `reactions` / `setReactionsAsync` through the same `interactionsToDoc` / `interactionsFromDoc` the agents use. Tests: `prototype.test.ts` round trips for all 20 directional types in the Plugin shape. Write the panel finding into `docs/plugins.md`.

### 2.2 Prototype timing units and defaults — **partial**, high
**Figma.** `transitionDuration` is in seconds and reads back as 0.3 when missing **or 0** (`t.duration=e.transitionDuration||.3`). `transitionTimeout` (AFTER_TIMEOUT) reads back as 0.8 when missing or 0. Mouse enter / leave / up / down store their delay as `interactionMaintained = (delay !== 0)` and `interactionDuration = delay` in seconds. On read, a maintained interaction with no duration gets delay 0.3, otherwise 0. Legacy MOUSE_IN / MOUSE_OUT read as MOUSE_ENTER / MOUSE_LEAVE with `deprecatedVersion: true`. New reactions are written with `stateManagementVersion = 1`. Legacy `preserveScrollPosition` maps to `transitionResetScrollPosition = !preserve`. A missing easing reads as OUT_CUBIC.
**Wecra.**
- `readAction` uses `num(transitionDuration, 0.3)` (`Prototype.cpp:77`), so an explicit 0 stays 0. The same holds for `transitionTimeout` (`:341`).
- Mouse delays are stored in `PrototypeEvent.transitionTimeout` (`prototypeSpec.ts:206–209`, read `:234–235`). `interactionMaintained` / `interactionDuration` exist in the schema (`document.kiwi:1151–1152`) but nothing reads or writes them. A `.fig` with a hover delay therefore loses it, and Wecra's own delays do not round-trip to Figma.
- The player fires MOUSE_ENTER at once and ignores any delay (`Player.cpp:774`). Only AFTER_TIMEOUT has a timer (`:1576`).
- `stateManagementVersion` is stripped from copies (`Prototype.cpp:473–482`) and never written on new interactions.
**Build.** `readAction` / `interactions`: 0 → 0.3 and 0 → 0.8 as Figma does. Store mouse delays in `interactionMaintained` + `interactionDuration`, and read the old `transitionTimeout` placement once for files Wecra wrote earlier. Give the player per-interaction delay timers for MOUSE_ENTER / LEAVE / DOWN / UP that cancel when the pointer leaves or is released. Write `stateManagementVersion = 1` on new interactions (panel, agents, plugin). Native test `proto.delay.test.cpp`; vitest for the spec. Size S.

### 2.3 Easing presets: exact numbers — **partial**, high
**Figma** (3187 module 551153 @5559659, used by both prototypes and Motion). Bezier `[x1, y1, x2, y2]`: IN_CUBIC and EASE_IN `[.42,0,1,1]`; OUT_CUBIC `[0,0,.58,1]`; INOUT_CUBIC `[.42,0,.58,1]`; LINEAR `[0,0,1,1]`; IN_BACK_CUBIC `[.3,−.05,.7,−.5]`; OUT_BACK_CUBIC `[.45,1.45,.8,1]`; INOUT_BACK_CUBIC `[.7,−.4,.4,1.4]`; CUSTOM_CUBIC default `[0,0,.58,1]` in prototypes. Springs `[mass, stiffness, damping, v0]`: GENTLE `[1,100,15,0]`; QUICK = SPRING_PRESET_ONE `[1,300,20,0]`; BOUNCY = SPRING_PRESET_TWO `[1,600,15,0]`; SLOW = SPRING_PRESET_THREE `[1,80,20,0]`; CUSTOM_SPRING default `[1,100,15,0]`. An invalid spring falls back to `[1,100,10,0]`. Legacy SPRING (8) reads as GENTLE. Plugin `EASE_IN` is written as `EASE_IN` (15), not IN_CUBIC. This settles the QUICK / BOUNCY / SLOW order that `docs/motion.md` left open.
**Wecra.** Every named curve and spring matches (`Prototype.cpp:252–267`, `:572–584`), including the `{1,100,10}` fallback (`:261`). Three gaps:
- Picking Custom bezier fills `[0.42, 0, 0.58, 1]` (`model/prototype.ts:532`, agents' default `prototypeSpec.ts:70`). Figma's default is `[0, 0, 0.58, 1]`. The engine's own fallback is already Figma's (`Prototype.cpp:583`).
- The agents' and the panel's "Ease in" write IN_CUBIC (`prototypeSpec.ts:50`, `model/prototype.ts:505`). That is harmless in prototypes, but Figma's Plugin writer uses EASE_IN, and on keyframes IN_CUBIC means "unset" (§2.10).
- There is no single easing module yet. The constants live in `proto::ease`.
**Build.** Set the two CUSTOM_CUBIC defaults to `[0, 0, 0.58, 1]`. Write EASE_IN (15) from the agents' / plugin `EASE_IN`, and keep the panel's value list reading both. Round 8 moves the tables to `engine/src/motion/Easing.{h,cpp}` (contract §4.7) and makes the HOLD row explicit. Size S.

### 2.4 Prototype custom easing clamps — **partial**, high
**Figma.** Plugin writes clamp CUSTOM_CUBIC_BEZIER's x1 and x2 to [0, 1] and leave y1 and y2 free, stored as `easingFunction = [x1,y1,x2,y2]`. CUSTOM_SPRING clamps mass to [0, 1000], stiffness to [0, 10000] and damping to [0, 1000], and forces `initialVelocity` to 0: `[m,k,c,0]`. Passing `easingFunctionCubicBezier` or `easingFunctionSpring` with another easing type throws. On read, the bezier needs exactly 4 values and the spring at least 3. Prototype springs are exposed as `{mass, stiffness, damping}`, not as bounce.
**Wecra.** `easingToDoc` (`prototypeSpec.ts:60–83`) accepts any finite numbers, with no x clamp and no range clamp, and it ignores a mismatched `easingFunction*` instead of rejecting it. The panel's spring fields set only lower bounds (`InteractionDetails.tsx:581–587`). The engine clamps mass and stiffness to ≥ 0.01 (`Prototype.cpp:263–265`).
**Build.** Clamp in `easingToDoc` exactly as Figma does, and return Figma's error for a mismatched `easingFunction*`. Clamp x1 / x2 in the panel's bezier fields. Size S.

### 2.5 Spring maths — **partial**, high
**Figma** (3187 module 110210 @5558637; figma_app 508579 @3823858). ω₀ = √(k/m), ζ = c / (2√(km)), with ζ optionally clamped to [0.03, 0.9999]. value(t) = 1 − x(t) with the standard under-damped closed form, or the critically / over-damped one, and v₀ = initialVelocity. Settle time **T = (−ln 0.001 + ln(1 + (ζω₀ + |v₀|)/ω_d)) / (ζω₀)** with ζ ≤ 0.9999. The spring editor's duration is **6 / (ζω₀) = 12m / c**. Dragging the duration sets ω₀ = 6 / (d·ζ), rounded to 4 significant digits. The graph handle sits at x = π/ω₀, y = 2 − 2·clamp(ζ, 0, 1)^0.87. Limits: ω₀ 0.1–1000, mass 0.01–100, stiffness 0.01–10000, damping 0.01–1000.
**Wecra.** The closed forms match (`Prototype.cpp:271–284`), but v₀ is fixed at 0. The settle time is found by sampling at 1/120 s up to 10 s for |x − 1| > 0.001 (`:291–297`). That is the last crossing, which is shorter than Figma's envelope bound T, so a Wecra spring transition ends slightly earlier. ζ is not clamped (ζ = 0 never settles, and sampling caps it at 10 s). The panel hides Duration for springs (`InteractionDetails.tsx:561`), where Figma's spring editor shows and edits 6/(ζω₀). Which of T and 6/(ζω₀) Figma's prototype player uses is open (probe 5.4).
**Build.** In `motion::Easing` (task 4): `springAt(m, k, c, v0, t)`, `springSettle(...)` = Figma's T with ζ ≤ 0.9999, the editor duration and its inverse, and the limits. `proto::durationOf` switches from sampling to T. Native test `motion.easing.test.cpp` with table values (GENTLE: ω₀ = 10, ζ = 0.75, T = (6.9078 + ln(1 + 7.5/6.614))/7.5 ≈ 1.022 s). Size S.

### 2.6 Schema drift vs `figma-schema-106.kiwi` — **missing**, high
**Figma.** The schema embedded in the current build is newer than the 106 dump `docs/motion.md` §4.1 was copied from. Motion-relevant additions: `TimelineData.durationUsVar = 8`; `StyleIdForAnimation.timelineOffsetVar = 7`; `TextElementDelayBehaviour.clipContent = 5`, `transformOriginMode = 6`, `transformOrigin = 7` and the enum `TextElementTransformOriginMode {MATCH 0, CHARACTER 1, WORD 2, LINE 3, PARAGRAPH 4}`; `KeyframeValueType.ROTATION_3D = 12` (`KeyframeAnyValue.rotation3DValue = 12`); `NodeContentsKeyframeBindingLocation.audioParametrizedField = 5` and `enum AudioParametrizedField {MISSING 0, GAIN 1, TIMELINE_OFFSET 2}`; `AudioFill` 13–20 (bpm and beat fields, `volumeVar 19`, `timelineOffsetVar 20`); `AudioBeatAnalysis`, NodeChange `audioBeatAnalyses = 613`; `Paint.videoFillPlayback = 47` (`VideoFillPlayback` 1–7); `ExportSettings.frameRate 13, loopCount 14, backgroundType 15, duration 16, svgAnimated 17`; `ImageType MP4 4, GIF 5, WEBM 6, LOTTIE 7, DOTLOTTIE 8`; `VariableDataType.UNIT_NUMBER = 36`; `ExpressionFunction` KEYFRAME 19, COMPOSE_COLOR 20, PAINT_TO_COLOR 21, RESOLVE_LENGTH 22, TRANSITION 23; `TransitionOverrideData.all = 1` deprecated. Deprecated in the current build: `keyframeValueRef 586`, `timelinePositionType 510`, `isClip 545`. The numbers of the existing NodeChange motion fields are unchanged.
**Wecra.** None of this is adopted. The node types are only a comment (`document.kiwi:89`). `ConnectionType` stops at 8 (`:990–1001`). PrototypeAction 39–41 are `_r` placeholders (`:1205`). ExpressionFunction drops KEYFRAME (`:1306`). VariableField drops 43–76 (`:1427`). `SpringParams` / `EasingData` are `@later` (`:1363`, `:1381`). The `.fig` importer drops every unknown field and every node of an unknown type (`src/shared/fig/convert.ts:6–7`), so a Figma Motion file opens with its animation silently removed.
**Build.** Task 2: the Round 8 pre-commit schema edit, taken from the embedded schema (the dump is in the scratchpad, `rea-work/motion/embedded-schema.txt`) rather than from 106, plus `ExpressionFunction.KEYFRAME = 19` and the PrototypeAction / ConnectionType values. `npm run engine:gen`, then a `.fig` round-trip test that keeps KEYFRAME / KEYFRAME_TRACK nodes and their fields. Size M.

### 2.7 Contract corrections — see §3.

### 2.8 Keyframe storage — **missing**; contract **different**, high
**Figma** (figma_app 892667 @7864104). A keyframed field is bound in the node's `parameterConsumptionMap` (key = `VariableField`, for example `MOTION_TRANSLATION_X`, `OPACITY`) to an **EXPRESSION** `{expressionFunction KEYFRAME (19), expressionArguments: [baseValue, {type KEYFRAME_TRACK_PARAMETER_DATA (21), value {parameters}}]}`, whose resolved type is the base value's (FLOAT / COLOR / VECTOR). **The resting value is the expression's first argument.** Each parameter is `{type MANUAL, value.manual {keyframeTrackId, timelineDefId}}`, `{type ANIMATION_PRESET, value.animationPreset {animationPresetId, keyframeTrackId, timelineDefId}}` or `animationStyleBindingId`. Several stack on one field, and writing a manual track keeps the preset parameters and appends MANUAL (`[...presetParams, manual]`). Solid-paint colours put the same expression in `Paint.colorVar`. Effects, fill / stroke component props and audio gain are located with `NodeContentsKeyframeBindingLocation {topLevelField EFFECT_DATA | FILL_PAINT_DATA | STROKE_PAINT_DATA | AUDIO_FILLS, index, effectParametrizedFieldValue, audioParametrizedField}`.
**Contract.** `docs/motion.md:190` binds `VariableData {dataType KEYFRAME_TRACK_PARAMETER_DATA}` directly, with no EXPRESSION and no base argument, and puts the base on the KEYFRAME_TRACK's `keyframeValue` (`:142`, 507 "KEYFRAME_TRACK (base value)"). §4.2's rule "a variable-bound field moves its alias into the track" follows from that and goes too.
**Build.** Bind through the KEYFRAME expression. A variable-bound field keeps its alias **as the expression's base argument** (an ALIAS `VariableData`), which is simpler than §4.2's move-the-alias rule and needs no undo special case. The evaluator resolves argument 0 in the node's modes (base), then folds the parameters in list order. The engine already evaluates EXPRESSION bindings (variables round), so KEYFRAME is one more `ExpressionFunction` case that returns the track value at the motion layer's time, and the base value when Motion is off. Size M (with task 5).

### 2.9 KEYFRAME_TRACK / KEYFRAME nodes — **missing**, high
**Figma.** A track is a KEYFRAME_TRACK (57) node with the id string `KeyframeTrackId:<guid>`, created by `keyframeBindings.createKeyframeTrack(TRACK)`. It carries `keyframeOperation 509` (SET 0 = replace, SCALE 1 = multiply, OFFSET 2 = add) and `trackLoopMode 591` (NONE / LOOP). Its children are KEYFRAME (56) nodes with `timelinePosition 506` (int64 **µs**, rounded to an integer), `keyframeValue 507` (`KeyframeValueData {value, valueType}`) and `easingData 535`. A keyframe's easing aliases an EASING variable through the KEYFRAME node's own consumption key `EASING_DATA (57)`. Writes upsert keyframes by integer µs position (`addOrUpdateKeyframe(track, easing, value, pos, hasExplicitEasing)`), then delete any child whose position is not in the new list. Duplicate positions in preset output collapse to the last one, and the list is sorted by position. The first keyframe's value holds back to t = 0, the last holds to the end, and keyframe k's easing governs the segment k−1 → k.
**Contract.** It matches the node model (decision 2, §4.2) and the evaluation rules (§4.4). Where the tracks live (the contract's Internal Only Canvas `0:2`) is still not visible in the code. The contract's "equal times: the later `parentIndex` wins" becomes "positions are unique per track" (upsert by µs).
**Build.** Task 5: `engine/src/motion/{Track,Evaluate}.*`, with upsert-by-µs in the write path and a binary search for evaluation. Size L.

### 2.10 Keyframe default easing — **missing**; contract **different**, high
**Figma** (3187 module 957593 @13936918; figma_app 892667 `O(e)`; timeline worker table `{0: N, 15: {p1x:.42,…}}`). On keyframes, `easingType` 0 (IN_CUBIC, the kiwi default) is read as "no easing" and resolves to **CUSTOM_CUBIC (0.5, 0, 0.5, 1)**. A missing easing resolves to that bezier too, and Plugin keyframe writes with no easing store CUSTOM_CUBIC `{.5,0,.5,1}`. A real ease-in is written as **EASE_IN (15)**. HOLD steps (CSS `step-end`). LINEAR is linear.
**Contract.** `docs/motion.md:289` reads IN_CUBIC as Ease in. `:329` makes "Ease out" the default for new keyframes [unverified].
**Build.** Inside `motion::Easing::forKeyframe(EasingData*)`: absent or IN_CUBIC → bezier (.5, 0, .5, 1). The UI's "Ease in" writes EASE_IN. New keyframes get CUSTOM_CUBIC (.5, 0, .5, 1). Size S.

### 2.11 Normalised springs in keyframes — **missing**; contract **different**, medium
**Figma** (figma_app 508579; 3187 spring editor). Keyframe springs are **stored physical**: `EasingData {easingType CUSTOM_SPRING, easingValue.springEasing {mass, stiffness, damping}}`, or the preset types. The Plugin shows them as one `bounce` = clamp(1 − ζ, 0, 1). bounce → physical: ζ = clamp(1 − bounce, 1e−4, 1), ω₀ kept from the existing spring if valid else 10 rad/s, mass kept (clamped 0.01–100) else 1, k = ω₀²m, c = 2ζ√(km). So a fresh bounce b becomes `{m 1, k 100, c 20(1 − b)}`. `figma.motion.physicalSpringToNormalized` requires positive finite m, k and c and returns 1 − ζ. In a keyframe segment the spring runs in "normalized" mode: its x axis is scaled by the settle time T (§2.5), so the curve fills the interval (`SpringParams.springType` NORMALIZED 0 / PHYSICAL 1).
**Contract.** `docs/motion.md:297` gives the presets bounces 0.25 / 0.42 / 0.69 / 0, and `:303` stores `{springType NORMALIZED, damping = ζ, stiffness 0, mass 1}` with a numerically solved settle time.
**Build.** Store `{m, k, c}` (the presets keep their enum). For a keyframe segment, e(p) = spring(p · T(m, k, c)) and e(1) = 1. Bounce ↔ physical as above. Because T·ω₀ depends only on ζ when v₀ = 0, the curve's shape is the contract's, but the stored numbers and T's formula become Figma's. Size S.

### 2.12 Stored units and write clamps — **missing**; contract **different**, high
**Figma** (3187 module 565744). `timelinePosition`: seconds in the Plugin API, µs in the document (`Math.round(1e6·s)`). **OPACITY**, the normalised effect fields (SPECULAR_INTENSITY, CHROMATIC_ABERRATION, SPLAY, REFRACTION_INTENSITY) and audio volume are **stored ×100**. **ROTATION (MOTION_ROTATION) is stored as −radians** (Plugin: degrees, positive counter-clockwise). 3D rotations are stored in radians, not negated. SCALE-operation tracks are not converted. Write validation: radii, stroke and border weights, paddings, WIDTH / HEIGHT, grid gaps, STACK_COUNTER_SPACING ≥ 0; OPACITY and PATH_TRIM_* in [0, 1]; effect RADIUS ≥ 0, SPREAD ±30000, REFRACTION_RADIUS 1–100, SPECULAR_ANGLE −899..900, START_RADIUS and NOISE_SIZE 0–100, DENSITY and EFFECT_OPACITY 0–1; audio volume 0–2; colour channels 0–1; timelinePosition ≥ 0.
**Contract.** `docs/motion.md:233` stores OPACITY 0–1 and `:244` stores ROTATION in degrees.
**Build.** Keep the unit conversion in one table (`motion/Fields.h`, mirrored in `src/shared/motion/types.ts`): `storedToNode` / `nodeToStored` per field, used by the evaluator, the panels and the plugin layer, and the clamps in the write path. Native test: opacity 0.5 ↔ stored 50, rotation 90° ↔ −π/2. Size S.

### 2.13 Keyframeable allowlist and XY exclusivity — **missing**, high
**Figma** (3187 module 985763; 767144; 892667). Public manual-keyframe fields: CORNER_RADIUS, STROKE_WEIGHT, STACK_SPACING, STACK_PADDING_LEFT / TOP / RIGHT / BOTTOM, WIDTH, HEIGHT, the four RECTANGLE_*_CORNER_RADIUS, the four BORDER_*_WEIGHT, STACK_COUNTER_SPACING, OPACITY, GRID_ROW_GAP, GRID_COLUMN_GAP, TRANSLATION_X / Y / XY, ROTATION, SCALE_X / Y / XY, PATH_TRIM_START / END. With the `transforms3d` flag: TRANSFORM_3D_TRANSLATION_Z, TRANSFORM_3D_ROTATION_X / Y / Z, SCENE_3D_PERSPECTIVE. Public names map to `MOTION_*` (`VariableField` MOTION_TRANSLATION_X 46, _Y 47, MOTION_ROTATION 48, MOTION_SCALE_X 49, _Y 50, MOTION_SHEAR 51 (not public), PATH_TRIM_START 54, _END 55, DISSOLVE_PROGRESS 56, EASING_DATA 57, KEYFRAME_VALUE 68, MOTION_TRANSLATION_XY 69, MOTION_SCALE_XY 70, MOTION_TRANSFORM_ORIGIN_XY / X / Y 73 / 74 / 75, TEXT_ELEMENT_DELAY 76). **Combined XY and separate X / Y tracks for position or scale cannot coexist on one node**: "keyframe tracks must be either combined or separated". The engine has `switchVectorKeyframesToCombined / ToSplit`. The preset runtime's own list also allows min / max width / height and `textData`.
**Contract.** The list matches `docs/motion.md:231–253`. The exclusivity rule and the combine / split switch are missing (`:364` lets X and Y tracks share a path).
**Build.** Enforce the rule in the write path. Add `MOTION_COMBINE_TRACKS` / `MOTION_SPLIT_TRACKS` (one undo step each, merging keyframe times) to the command list. Size S.

### 2.14 Motion transform — **missing** (contract matches), medium
**Figma** (892667 `M={[MOTION_TRANSLATION_X]:"translationX",…}`; wasm `has-own-motion-transform`, `absolute-transform-with-motion`). Keyframed transforms leave `relativeTransform` alone and animate `motionTransform 523` (`TRSSTransform2D {translation, rotation, scale, shearX}`), which composes with the resting transform: translation and rotation add (neutral 0), scale multiplies (neutral 1). The pivot defaults to the visual centre. `MOTION_TRANSFORM_ORIGIN_*` are behind a flag (`metronome_keyframeable_origin`). `linkMotionScaleAspectRatio 597` locks uniform scale. When reading back, the FLOAT base values of translation, rotation and shear have the static TRSS component added (`r.value += d[e]` with d = relativeTransform.toTrss()).
**Contract.** `docs/motion.md:255–259` matches, including the visual-only rule. Add: plugin reads add the static TRSS component, and the rotation sign follows §2.12's −radians storage.
**Build.** Task 6: `NodeTable.motionWorld`, render / hit / bounds, as contracted. Size M.

### 2.15 Timelines — **missing**; contract **different**, high
**Figma** (3187 @3488xxx). Each top-level frame owns a timeline: `node.timelines` returns `[{id: the containing top-level frame's id, duration: ownOrDerivedTimelineDuration / 1e6}]`. `setTimelineDuration(id, s)` requires id to be that frame and s positive and ≤ MAX_SAFE_INTEGER µs, and writes **`timelineDuration 512` = round(s·1e6) on the frame itself**. Nested timelines live in `timelineDefinitions 552` (GUID → `TimelineData {durationUs, defaultTimeline, parentTimelineDefId, playbackStyle ONCE | LOOP | BOOMERANG, autoplay, keyframeSnappingFps, quantizePlayback, durationUsVar}`). `timelineAssignments 553` maps `{assignedTimelineId, containingTimelineId}` → `{offsetUs, disabled, autoplay}`. A component instance whose main has motion is "clip-backed" (`isClipBackedComponentInstance`, `clipId 511`), and its offset is read and set through the assignments (`getNestedTimelineOffsetUsFromAssignments`). Other fields on the frame: `timelineOffset 513`, `timelineDisabled 543`, `playbackStyle 514`, `timelineKeyframeSnappingFps 601`, `quantizeTimelinePlayback 602`.
**Contract.** `docs/motion.md:206` creates a `timelineDefinitions` entry with `durationUs` on the root and uses its GUID as the timeline id. `:147` puts `timelineDuration` only on ANIMATION_PRESET_INSTANCE, and `playbackStyle 514` / `timelineKeyframeSnappingFps 601` are "round trip only".
**Build.** Default timeline = the top-level frame: duration in its `timelineDuration`, playback in its `playbackStyle`, snapping in `timelineKeyframeSnappingFps`, and timeline id = the frame's GUID in `timelineDefId` references. `timelineDefinitions` holds only nested and main-component timelines. The default length of a fresh timeline is open: help says 2000 ms, but the code was not seen (probe 5.1). Size M.

### 2.16 Timeline settings — **missing**; contract partial, high
**Figma** (3653.min.js). Units: **ms** or **frames**. The grid is stored as a `FrameRate {numerator, denominator}`. In ms mode the presets are 10/1, 20/1 and 100/1 fps (shown as 100 ms, 50 ms, 10 ms) plus "Off". In frames mode they are 60 (default), 30, 30000/1001, 24, 24000/1001 and 12. A typed ms value becomes fps = 1000/ms clamped 1–1000, and a typed frame rate is rounded and clamped 1–120. Loop control: Once, Loop, Ping pong (BOOMERANG), with Ping pong disabled when the timeline has audio. Time display formats: %, ms, s, timecode_ms, timecode_frames. The timeline worker draws 16 × 16 diamonds, interpolation lines inset 8 px from each diamond, the origin at x = 18 px and Inter 9 / 11 px labels.
**Contract.** `docs/motion.md:430` has a seconds / milliseconds toggle and a Playback cycle button. It has no frames unit, no grid presets and no audio rule.
**Build.** In 8c's timeline header: a settings popover with these units, grid presets and loop options. Size M.

### 2.17 Animation styles are code presets — **missing**; contract **different**, high
**Figma** (3187 module 910280 @13502382; runtime `function tween({ mode, timelinePosition = 0, duration, from, to, easing, enabled = true })`). An animation style is a style of `StyleType.ANIMATION` whose content is **animation presets**: code components (`CodeObjectType.ANIMATION_PRESET = 3`) written in TypeScript against a `figma:motion` module (`animate`, `tween`, `defineProperties`, `EasingType`) and evaluated in a QuickJS or iframe sandbox. A preset returns `AnimationPreset {nodeId, keyframeTracks [{parameterField | topLevelField + index + effectParametrizedField, keyframeOperation, keyframes [{timelinePosition µs, easing, value}], enabled}], textElementDelayBehaviour?, effects?}`. `tween()` gives exactly two keyframes at [pos, pos + duration], both carrying the easing, and a negative duration throws. A preset may generate at most one LAYER_BLUR effect. Delay is not added to the positions: the runtime syncs delay to the binding's `timelineOffset`. The output is written as KEYFRAME_TRACK nodes that the field's KEYFRAME expression references through ANIMATION_PRESET parameters (§2.8), with upsert and collapse rules (§2.9). Node fields: `styleIdsForAnimation 582` (`{id, timelineDefId, animationStyleId, timelineOffset µs, generatedAnimationPresets[], sortPosition, timelineOffsetVar}`), `animationPresets 521`, `styleAnimations 580`, `backingAnimationPresetId 583`, node type ANIMATION_PRESET_INSTANCE 58.
**Contract.** `docs/motion.md` decision 6 (`:108`) and §4.6 (`:263–280`): the C++ evaluator generates preset tracks on the fly and never stores them. Preset props live in `componentPropAssignments` on the instance.
**Build.** Keep Figma's shape:
- a small `figma:motion` runtime in TypeScript (`src/shared/motion/runtime.ts`: `tween`, `animate`, `defineProperties`, EasingType) that runs in the plugin sandbox Wecra already has (`editor/plugins/runtime/`);
- first-party presets written as TypeScript modules against it (our own code, from the behaviour in §2.18; Figma's sources are not copied);
- the editor applies a style: run the preset, then materialise its tracks with `MOTION_SET_PRESET_TRACKS` in the same undo step, re-run when props, duration or offset change, and collapse duplicate positions as Figma does.
The evaluator then only plays tracks, so C++ needs no preset knowledge, and custom (user) animation styles later need only the style node and the sandbox. Size XL.

### 2.18 First-party preset catalogue and defaults — **missing**; contract **different**, high
**Figma** (figma_app 687932; 3187 propDef modules 712978, 938240, 361071, 143079, 529402, 467581, 121628, 12629). Active presets: **New** (starter), **Opacity**, **Position**, **Scale**, **Rotation**, **Size**, **Corner Radius**, **Path**, **Text** (typewriter), **TextStagger** (gated `metronome_text_animations`). **Fade, Move, Rotate, Resize, Path Draw and Path Travel are deprecated.** Shared defaults: delay 0 s, duration 0.5 s (min 0.01), easing OUT_CUBIC.
- Opacity: type fadeIn | fadeOut | custom, amount 0 %, start 0 %, end 100 %, mode **scale**.
- Position: slide_in | slide_out | custom, direction left / right / top / bottom plus the 4 diagonals (default left), distance **200 px**, axis xy, start 200 / 200, end 0 / 0, mode **offset**.
- Scale: scaleIn | scaleOut | custom, axis whCombined, amount **120 %**, mode **scale**.
- Rotation: rotateIn | rotateOut | custom, clockwise, **180°** (a clockwise rotateIn goes −amount → 0), mode **offset**, radians.
- Size: resize_in | resize_out | custom, amount 50 px, start 50, end 100, mode **offset**.
- Corner radius: roundIn | roundOut | custom, corner all, amount 10 px, mode **offset** (roundOut `[amount, 0]`, otherwise `[0, amount]`; probe 5.11).
- Path: draw | erase | travel | custom, segment 10 %, mode **set**, needs strokes.
- Text: revealBy character | word | line, duration 1.5 s.
PropDefs carry `{name, type NUMBER | TEXT | BOOL | EASING, label motion.preset_flyout.*, default*, selectConfig.options, inputConfig {min, max, unit, icon}, numberResolvedAsTiming}`.
**Contract.** `docs/motion.md:269–278` uses the deprecated Fade / Move names, defaults of 500 ms, 100 px and "unverified", OPACITY in SCALE 0 → 1 (Figma: amount/100 → 1), and invented composite styles (Slide in, Pop in, Spin in…).
**Build.** Replace the table with this catalogue and these defaults, and drop the invented composite style list until a probe of `figma.motion.figmaAnimationStyles()` (probe 5.10) shows Figma's own. Size M.

### 2.19 Text stagger — **missing**; contract partial, high
**Figma** (3187 module 542808 @13931885; `1462.min.js` CSS codegen). TextStagger props: animationDirection in | out; textDelayGrouping CHARACTER | CHARACTER_NO_WHITESPACE | WORD | LINE | PARAGRAPH (default CHARACTER); presetStaggerOverlap 50 % (0–100); textDelayOrder LEFT_RIGHT | RIGHT_LEFT | CENTER_OUT | RANDOM; clipContent false; elementTransformOriginMode MATCH; origin 50 % / 50 %. Sub-animations: position (on; direction top, distance 40), rotation (off; 180°), scale (off; 120 %), opacity (off; 0 %), blur (off; 20 px). The preset writes `textElementDelayBehaviour 610 {enabled 1, grouping 2, delayMs 3 (≥ 0), order 4, clipContent 5, transformOriginMode 6, transformOrigin 7 (default {0, 0})}`. The derived timing (startUs, groupDurationUs, staggerStepMs) is computed in C++. CSS export: `animation-delay: calc(start + var(--stagger-index) * step)`.
**Contract.** `docs/motion.md:368` has fields 1–4 only and a fixed stagger in ms. It has no overlap, no clip, no per-element origin mode, and no blur sub-animation.
**Build.** Add fields 5–7 and the enum (task 2). The renderer groups glyph runs, applies per-element transforms about the origin mode's box, clips if `clipContent`, and derives step = f(overlap, duration, count) (the formula is open, probe 5.12). Size L.

### 2.20 Motion easing menu and editors — **missing** (prototype: partial), medium
**Figma** (figma_app 435729, 402803). The Motion easing dropdown lists **HOLD first**, then the bezier presets and the springs, with no dividers. If the current easing is a spring the list shows only springs; otherwise HOLD plus the non-spring ones. A **Bezier | Spring** segmented control switches to CUSTOM_CUBIC or CUSTOM_SPRING. When the type changes, custom values are kept only if the new type is the matching custom type; otherwise the preset's values load. Labels: `proto.easing_behavior.bezier_ease_in` / `_out` / `_in_and_out` / `linear` / back variants / `bezier_custom` / `spring_gentle` / `spring_quick` / `spring_bouncy` / `spring_slow` / `spring_custom` / `hold`.
**Wecra.** The prototype panel has one Select over `EASINGS` (`model/prototype.ts:503–518`, with Custom bezier among the curves and a divider before the springs) and plain numeric fields for the bezier's four numbers and the spring's mass / stiffness / damping (`InteractionDetails.tsx:574–587`). There is no curve editor, no spring graph and no Bezier / Spring switch. Motion has nothing (contract §6.3).
**Build.** Build `editor/motion/easing/EasingEditor` once and use it for both prototype and Motion, with a `context: "prototype" | "motion"` prop (HOLD and bounce only in Motion; mass / stiffness / damping and the 6/(ζω₀) duration in prototypes). The bezier graph clamps x to [0, 1], and the spring graph uses §2.5's handle mapping. Size M.

### 2.21 Plugin motion API — **missing**, high
**Figma** (3187 @3642471, @3487000–3495000; zod @3829590). Gated by `metronome`. `figma.motion`: `playheadPosition` (seconds, read-only), `figmaAnimationStyles()`, `physicalSpringToNormalized({mass, stiffness, damping})`. Node: `manualKeyframeTracks` (get / set; keys are fields, plus fills / strokes by index and effects by index → field or property), `applyManualKeyframeTrack(field, track)`, `removeManualKeyframeTrack(field)`, `animations` (resolved, read-only), `animationStyles`, `applyAnimationStyle(styleId, {duration, timelineOffset, props})` → instance id, `removeAnimationStyle(id)`, `timelines`, `setTimelineDuration`, `getTimelineOffset` / `setTimelineOffset`, and `transitionOverrides` (gate `eclipse`). Dev Mode exposes only the reads. Field descriptors: `{type 'PROPERTY', name}` | `{type 'INDEXED_ITEM', collection 'fills' | 'strokes', index[, propertyId]}` | `{type 'INDEXED_ITEM', collection 'effects', index, field | propertyId}`. `ManualKeyframeBindingInput {id?, baseValue?, keyframes [{id?, timelinePosition ≥ 0, easing? MotionEasing | VariableAlias, value}]}`. Keyframes read back sorted.
**Wecra.** None. The plugin runtime has no `figma.motion`.
**Build.** Task 12 (contract 8f), on top of tasks 5–9, with §2.12's unit table and §2.11's bounce conversion. Size L.

### 2.22 Prototype action controlling a timeline — **missing**, high
**Figma.** `ConnectionType.UPDATE_ANIMATION_TIMELINE_STATE = 10` with `PrototypeAction.animationTimelineAction 39` (PLAY 0, PAUSE 1, TOGGLE_PLAY_PAUSE 2, SET_PLAYHEAD 3), `animationSkipToTime 40` (seconds) and `animationTimelineDefId 41`. The Plugin reactions reader returns null for it (`case"UPDATE_ANIMATION_TIMELINE_STATE":return null`). OBJECT_ANIMATION 9 is Slides' object animations.
**Wecra.** `ConnectionType` ends at SET_VARIABLE_MODE 8 (`document.kiwi:990–1001`). 39–41 are `_r` placeholders (`:1205`).
**Build.** Schema in task 2. Player support (contract §4.12) once timelines play. The plugin reader returns null like Figma. Size M.

### 2.23 Smart animate as generated tracks — **different** (same look), medium
**Figma** (wasm strings: `-JitAnimationClone-From`, `-SmartKeyframeTrackGroup`, `computeSmartAnimateTrackGroups`, `-JitScrollTrackGroup`, `dissolve-from-fill-paints`, `FGSmartAnimateTransitionBake.cpp`, `enableJitSmartAnimate`). The current viewer runs smart animate "just in time". It clones source and destination, matches animatable nodes (`matchAnimatableNodes`, `maybeAnimateRotation`), and generates keyframe track groups that the Motion keyframe engine plays. Unmatched layers dissolve through `DISSOLVE_PROGRESS (56)`. Animated "Scroll to" is a track group on SCROLL_OFFSET_X / Y (52 / 53). `useLegacySmartAnimate 544` keeps the old path per node or file. `bakeSmartAnimateTransition` turns a transition into editable keyframes (a "transition timeline" opened from Motion).
**Wecra.** `Player` interpolates between snapshots directly (`Player.h:143–145`, `:308–322`: `smartDest`, `smartSource`, `matchedKeys`, `addMatching`). The matching, dissolve and Move / Push / Slide with matching layers are there. `enableJitSmartAnimate 43` is kept on PrototypeAction and `useLegacySmartAnimate 544` is reserved.
**Build.** Nothing now. After the evaluator exists, re-express smart animate as generated tracks in the player so that transition overrides (§2.24) and "bake to keyframes" become possible. Keep the snapshot path as the legacy one (`useLegacySmartAnimate`). Size L.

### 2.24 Transition overrides — **missing**, high
**Figma** (3187 @3492xxx; gate `eclipse`). `transitionOverrides 526` → `TransitionOverrideData {all 1 (deprecated), propertyOverrides 2}`. Entries are keyed by prop ALL | OPACITY | TRANSLATION | ROTATION | SCALE, or by a node-contents binding location (effects, paints, parameter fields, audio). Each lists `TransitionOverride {id, duration ≥ 0, delay ≥ 0, easing, durationVar, delayVar, easingVar, createdAtMs, interactionIDs, disabled}`, so a layer has its own smart-animate timing per property for a given interaction. Through the Plugin API `interactionIDs` must hold exactly 1 id, and new ids come from `generateUniqueID`.
**Wecra.** `transitionOverridesEnabled 42` is kept on PrototypeAction (round-trip test `convert.test.ts:145,178`). `transitionOverrides 526` is reserved (`docs/schema.md:685`).
**Build.** After §2.23: the schema, a per-layer "Transition" section in the Prototype panel, and the player applying per-property timing to its generated tracks. Size L.

### 2.25 Video / GIF / Lottie / animated SVG export — **missing**, high
**Figma** (3187 module 158676; exportAsync). Plugin `exportAsync({format 'MP4' | 'GIF' | 'WEBM', fps, quality, loopCount (GIF), constraint})` is gated by `metronome`, renders server-side (`exportVideoInline`), and defaults to 30 fps. Plan limit: an export is blocked when fps > 30, or max(w, h) > 1920, or min(w, h) > 1080, unless the plan has high-fidelity export ("Video export at W×H / Nfps exceeds the 1920×1080 / 30fps limit for this plan"). Other motion exports: Lottie and dotLottie, animated SVG (SMIL `<animate … calcMode="spline">`, `svgAnimated`), and CSS / motion.dev code in Dev Mode, where springs are written `spring(stiffness, damping, mass)` or `spring(bounce)` and HOLD as `step-end`. GRADIENT_PAINT keyframes are dropped by motion export. `ExportSettings` 13–17, `ImageType` 4–8.
**Wecra.** Static exports only (`editor/exportCore.ts`).
**Build.** Contract §7 (8e), with Figma's `ExportSettings` / `ImageType` numbers. Wecra encodes locally, so the plan limit does not apply. That is an owner decision; the default is no limit, since it is personal use. Size XL.

### 2.26 Audio and video on the timeline — **missing**, medium
**Figma.** `AudioFill` (timelineOffsetUs, startTimeUs, durationUs, volume, mute, loopEnabled, playbackDurationUs, trackId, loopPhaseOffsetUs, sourceDurationUs, bpm / beat fields, volumeVar, timelineOffsetVar) and `AudioTrack {id, name, gain, mute}` live on nodes (`audioFills 603`, `audioTracks 605`, `audioBeatAnalyses 613`). Volume is keyframeable (AUDIO_FILLS + GAIN; Plugin 0–2, stored ×100). Video fills carry `Paint.videoFillPlayback 47` `{startTimeMs, endTimeMs, timelineOffsetUs, playbackDurationUs, loopPhaseOffsetUs, volume, mute}` and show as bars. Waveform peaks are cached in IndexedDB (≤ 32 MB).
**Wecra.** VIDEO paints play in the prototype player (`Player` media). There is no audio and no `videoFillPlayback`.
**Build.** Contract §4.11 / §6.6, plus `videoFillPlayback` so a video paint sits on the timeline. Size L.

### 2.27 Sites behaviours' easing table — **missing** (out of scope), high
**Figma** (figma_app 715063). Sites behaviours (Hover, Press, Focus, Appear, ScrollTransform, ScrollParallax) use Penner's CSS cubics: IN_CUBIC / EASE_IN `[.55,.055,.675,.19]`, OUT_CUBIC `[.215,.61,.355,1]`, INOUT_CUBIC `[.645,.045,.355,1]`. The back curves match the prototype ones. Default transition OUT_CUBIC 0.3 s, appear 0.6 s.
**Wecra.** Sites is set aside (round 12). Nothing to build. When Sites returns, keep this table separate from `motion::Easing` and never mix the two.

---

## 3. Corrections to `docs/motion.md` (task 1)

| Contract place | Today | Change to |
|---|---|---|
| §3 decision 6 (`:108`), §4.6 (`:263–280`) | Presets evaluated in C++, never stored | Presets are code against a `figma:motion` runtime, and their output is materialised into KEYFRAME_TRACK nodes referenced by ANIMATION_PRESET parameters (§2.17) |
| §4.1 (`:129`, `:141–175`) | Schema from 106; `keyframeValueRef 586`, `timelinePositionType 510`, `isClip 545` in use; `TextElementDelayBehaviour` 1–4 | Current embedded schema (§2.6); the three fields deprecated (round trip only); `TextElementDelayBehaviour` 1–7, `TimelineData.durationUsVar 8`, `StyleIdForAnimation.timelineOffsetVar 7`, `ExpressionFunction.KEYFRAME 19` |
| §4.2 (`:190`, `:194`) | Binding = `VariableData KEYFRAME_TRACK_PARAMETER_DATA`; base on the track; the alias moves into the track | Binding = `EXPRESSION KEYFRAME [base, KEYFRAME_TRACK_PARAMETER_DATA]`; the alias stays as the base argument (§2.8) |
| §4.3 (`:206`) | The default timeline is a `timelineDefinitions` entry | The default timeline is the top-level frame's own `timelineDuration 512` / `playbackStyle 514` / `timelineKeyframeSnappingFps 601`; its id is the frame's id (§2.15) |
| §4.5 (`:233`, `:244`) | OPACITY stored 0–1, ROTATION in degrees | Stored ×100 and −radians; one unit table (§2.12); XY vs X / Y exclusive (§2.13) |
| §4.7 (`:289`, `:297–305`, `:329`) | IN_CUBIC = Ease in; Ease out default; normalised springs stored as ζ | IN_CUBIC = unset → CUSTOM_CUBIC (.5, 0, .5, 1); EASE_IN 15 for Ease in; springs stored physical, played normalised by Figma's T (§2.10, §2.11); constants verified |
| §4.6 table, composite styles (`:271–278`) | Fade / Move / …, 500 ms, 100 px, invented composites | Figma's catalogue and defaults (§2.18) |
| §4.10 (`:368`) | Fixed stagger ms, 4 fields | Overlap %, clipContent, origin mode, blur sub-animation (§2.19) |
| §6.2 (`:430`) | s / ms toggle | ms / frames units, FrameRate grid presets, Ping pong disabled with audio (§2.16) |
| §6.3 (`:448`) | Separators, HOLD among the curves | HOLD first, no dividers, spring-only list when the easing is a spring, Bezier / Spring switch (§2.20) |

---

## 4. Integration plan (ordered)

Prototype fixes (shipped code, can land now; no wasm build is needed for 1–3 unless noted):

1. **Contract update** — apply §3 to `docs/motion.md`, `docs/schema.md` §15's Round 8 row and `docs/roadmap.md` "Round 8" (8a's file list gains `motion/Expression` and loses `Presets.*`; 8c gains the timeline settings; a new 8h for the `figma:motion` runtime and the presets). Docs only. S.
2. **Prototype direction and plugin reactions** (§2.1) — `agents/prototypeSpec.ts`: Figma's symmetric swap for the five directional types in the Plugin shape. `plugins/api/nodes.ts` `reactions`: convert through the spec both ways (Reaction `{trigger, actions}` shape), `null` for UPDATE_ANIMATION_TIMELINE_STATE. Tests: `prototype.test.ts` (20 directions), plugin reactions round trip. S.
3. **Prototype defaults and delays** (§2.2, §2.3, §2.4) — `Prototype.cpp`: duration 0 → 0.3, timeout 0 → 0.8; mouse delays in `interactionMaintained` / `interactionDuration` (read the old placement once); player delay timers for MOUSE_*; `stateManagementVersion = 1` on new interactions; CUSTOM_CUBIC default `[0, 0, .58, 1]` (`model/prototype.ts:532`, `prototypeSpec.ts:70`); EASE_IN written as 15 from the agents and the plugin; Figma's clamps in `easingToDoc` and the panel. Native `proto.delay.test.cpp`; vitest. Rebuild the wasm (`npm run engine:build`). S.
4. **One easing module** (§2.5) — `engine/src/motion/Easing.{h,cpp}`: the bezier table, springs with v₀, Figma's T, the editor duration and its inverse, the limits, bounce ↔ physical, `forKeyframe` (IN_CUBIC unset). `proto::ease` / `durationOf` call it. Native `motion.easing.test.cpp` (table values; GENTLE T ≈ 1.022 s; bounce 0.25 → c = 15). Can land before Round 8, since it changes the prototype's spring durations only by Figma's T. S.

Round 8 (when the owner reopens it), in the roadmap's 8a → 8f order with these changes:

5. **Schema from the current build** (§2.6, §2.22) — the pre-round commit: node types 56–58, NodeChange 505–613 as listed in §2.6 (deprecated ones kept as plain fields for round trips), `ExpressionFunction.KEYFRAME 19`, `ConnectionType.UPDATE_ANIMATION_TIMELINE_STATE 10`, PrototypeAction 39–41, `Paint.videoFillPlayback 47`, `ExportSettings` 13–17, `ImageType` 4–8, `TextElementDelayBehaviour` 1–7, `TextElementTransformOriginMode`. `npm run engine:gen`; a `.fig` round-trip test keeping KEYFRAME / KEYFRAME_TRACK nodes. M.
6. **Field table and units** (§2.12, §2.13) — `motion/Fields.h` + `src/shared/motion/types.ts` (one table: VariableField, value type, stored ↔ node unit, clamp, composition), with the XY / X-Y exclusivity check. A test checks that the two agree. S.
7. **Tracks and the KEYFRAME expression** (§2.8, §2.9, §2.10, §2.11) — `motion/{Track,Evaluate,Expression}.*`: tracks with upsert by µs, binary-search evaluation, SET / OFFSET / SCALE folding over the expression's base argument, keyframe easing via task 4, and paint `colorVar` and effect locations. Native `r8.motion.test.cpp`. L.
8. **Motion transform and the motion layer** (§2.14) — `motionTransform` → `NodeTable.motionWorld`; render / hit / bounds; the preview-write layer of contract §5. M.
9. **Timelines** (§2.15) — the frame's own `timelineDuration` / `playbackStyle` / snapping, nested `timelineDefinitions`, instance `timelineAssignments`, playback styles; player clocks and `UPDATE_ANIMATION_TIMELINE_STATE` (§2.22). M.
10. **Editing commands and the timeline UI** (contract 8b / 8c) with §2.16's settings popover and §2.13's combine / split commands. XL.
11. **Easing editor shared with prototypes** (§2.20) — `editor/motion/easing/`: Motion and prototype contexts, bezier graph, spring graph, the Bezier / Spring switch; it replaces the numeric fields in `InteractionDetails.tsx:574–587`. M.
12. **`figma:motion` runtime and first-party presets** (§2.17, §2.18) — `src/shared/motion/runtime.ts` in the plugin sandbox; the presets as our own TypeScript; `MOTION_SET_PRESET_TRACKS` materialising the output; the Animations section. XL.
13. **Text stagger** (§2.19) — schema fields 5–7, glyph grouping and per-element transforms in `render/` and `text/`, the TextStagger preset. L.
14. **Plugin motion API** (§2.21) and Dev Mode code (CSS / motion.dev with `spring(...)` and `step-end`). L.
15. **Export** (§2.25) and **audio / video on the timeline** (§2.26) — contract 8e, with Figma's ExportSettings numbers. XL + L.
16. **Smart animate on tracks, then transition overrides** (§2.23, §2.24) — the player generates tracks; the snapshot path stays as `useLegacySmartAnimate`; then `transitionOverrides 526` and its panel. L + L.

---

## 5. Probes still to run (when the MCP call limit resets, or by hand in Figma)

All 14 were planned for one `use_figma` session on a `motion` page of file `2Rh4mZi09rwwECJE0xBG8Z`. The Starter-plan quota stopped the first call, and nothing in the file changed. Whether the `metronome` gate is on for this account is also unknown.

1. A fresh top-level frame: `node.timelines` before any keyframe, and the default duration after the first one (2000 ms per help?).
2. A keyframe written with no easing: read back as CUSTOM_CUBIC (.5, 0, .5, 1)?
3. An EASE_IN keyframe: does it round-trip as EASE_IN, not IN_CUBIC?
4. Spring presets: read back `bounce` for GENTLE / QUICK / BOUNCY / SLOW, and how long a prototype spring transition runs (T or 6/(ζω₀)).
5. CUSTOM_SPRING with bounce 0.3 → the stored mass / stiffness / damping.
6. Opacity 0.5 and rotation 90° keyframes → the stored values (×100, −radians).
7. Writing TRANSLATION_XY after TRANSLATION_X: the "combined or separated" error.
8. AFTER_TIMEOUT with no timeout → 0.8 on read.
9. `{MOVE_IN, RIGHT}` and `{MOVE_OUT, LEFT}` → stored types, and the panel's arrow for MOVE_OUT_TO_LEFT.
10. `figma.motion.figmaAnimationStyles()`: names, ids and props of Figma's styles.
11. Corner Radius roundIn: 0 → amount or amount → 0.
12. Text stagger: delayMs for 10 characters at overlap 50 % and duration 0.5 s.
13. `transitionOverrides` on a node (is `eclipse` on?).
14. `exportAsync({format: 'GIF'})` at 2000 × 1000 / 30 fps: the plan-limit error text.
