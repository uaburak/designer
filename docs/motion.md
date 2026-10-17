# Motion (contract, Phase 7 round 8; written 2026-10-12; **the pre-round commit landed 2026-10-17** — §4.1's schema, `src/shared/motion/types.ts`, the `Engine.ts` / `abi.ts` / `codec.ts` stubs, the chrome stubs and the icons; 8a is next)

Figma Motion (Beta) inside DesignerV2's Design editor: **Motion mode** with its **timeline**, **keyframes** (manual and auto-keyframe), **easing** (Figma's named curves, springs, custom bezier and spring, easing and timing variables), **animation presets** and composite **animation styles**, the **anchor point**, **motion paths**, **path trim**, **text animation**, **audio**, **animated components**, playback in **prototypes**, **export** (MP4, WebM, GIF, animated SVG, Lottie, dotLottie), the **Motion tab in Dev Mode** with code, and the plugin API. This file decides the engine model, the evaluator, the chrome, export, Dev Mode and the shared types. Ownership and merge order are in `docs/roadmap.md` "Round 8".

Motion is a **mode of a Design file**, not a file type (help: "switch the toolbar toggle to Motion"; "Any frame can switch to Motion mode"). `FileMeta.editorType` stays `"design"`.

**Corrected 2026-10-15 from Figma's own code** (`docs/research/rea/motion.md`, a static reading of the current desktop build's modules; no live probe ran — its §5 lists the 14 probes still to run). Ten decisions of the 2026-10-12 text were contradicted by the code and are rewritten in place: the keyframe binding is an `EXPRESSION KEYFRAME [base, KEYFRAME_TRACK_PARAMETER_DATA]` whose first argument is the resting value (§4.2); the default timeline lives on the top-level frame itself (§4.3); stored units are Figma's (opacity ×100, rotation −radians, §4.5); XY and X / Y tracks are exclusive (§4.5); presets are code run against a `figma:motion` runtime and their output is materialised as tracks (§3, §4.6); the preset catalogue and its defaults are Figma's (§4.6, §10); IN_CUBIC on a keyframe means "no easing", Ease in is EASE_IN 15 and the default keyframe easing is CUSTOM_CUBIC (0.5, 0, 0.5, 1) (§4.7); springs are stored physical and played normalised by Figma's settle time T (§4.7); text stagger has Figma's seven fields (§4.10); the timeline settings and the easing menu are Figma's (§6.2, §6.3). The schema is the current build's, not the 106 dump (§4.1). The prototype side already follows the code (round 17 batch A): `engine/src/motion/Easing.{h,cpp}` holds the curves and springs, the plugin / agent prototype shapes swap the side for every directional transition, and mouse delays live in `interactionMaintained` / `interactionDuration`.

Marks: **[unverified]** = our decision where Figma's own behaviour, wording, numbers or storage could not be seen. Motion's editing UI could not be captured live (`research/figma/live/motion/behaviour.md`: the built-in browser was not signed in; only the mode switch and the "Motion Beta" tag were seen). Figma's MCP (which can read and write motion) needs the owner's sign-in and was not available to this session. Every [unverified] item is listed for the capture in §12.

---

## 1. What Figma does (verified 2026-10-12)

Sources (help.figma.com unless said; all opened 2026-10-12):
- Explore Figma Motion: /hc/en-us/articles/41274629073303
- Use the Figma Motion timeline: /41405906446999
- Quickly add motion with preset animation styles: /41307886266135
- Add, select, and delete keyframes: /41307938657559
- Adjust an animation's easing: /41414048690839
- Move a layer's anchor point: /41352588622615
- Edit an object's motion path: /41780233501591
- Animate strokes with path trim: /42200302811927
- Animate text layers: /43825262591383
- Add audio to animations: /43825294171927
- Animated components: /41307940738967
- Export animations: /41307983648407
- Hand off animations to development: /41296356954263
- Overview of variables collections and modes (Easing, Timing): /14506821864087
- Tutorial "Create a chat bubble animation": /41837837143831
- Blog "Introducing Figma Motion" (2026-06-24, Config 2026): https://www.figma.com/blog/introducing-figma-motion/
- Plugin API: https://developers.figma.com/docs/plugins/api/figma-motion/ and /docs/plugins/api/Motion/ (types), plus Figma's own agent skills `figma-use-motion` (motion-patterns.md, motion-easing.md) and `figma-implement-motion` (Figma plugin 2.2.127, in the local plugin cache) — the MCP's `get_motion_context` output and its limits
- Figma's schema: `research/figma/figma-schema-106.kiwi`
- Forum (unofficial): https://forum.figma.com/ask-the-community-7/motion-and-prototyping-55428

**Access.** Open beta; "Anyone with `can edit` access to a file can use Figma Motion", any plan. "If you don't see the Motion option in the toolbar, make sure you have `can edit` access". The mode switch reads **Draw / Design / Motion / Dev Mode**; the Motion radio carries a "Motion Beta" tag above it (live capture, `motion_beta_special_tooltip`, the `metronome` feature flag).

**Timeline** (/41405906446999). "While Figma Motion is enabled, the timeline appears across the bottom of your screen." Controls, in Figma's lettering:
- **A Play/Pause** — Spacebar plays, again pauses.
- **B Auto-keyframe** — "changes to an object are recorded automatically as keyframes". The control is named **Toggle auto-keyframe**; when on, "a red bar appears across the top of the timeline and on the playhead", and an on-canvas **auto-keyframe handle** appears on the selection.
- **C Current time** — the playhead's time; type a value to jump.
- **D Duration** — "New animations default to 2000 milliseconds"; type a value or drag the handle at the timeline's right side.
- **E Time unit** — seconds or milliseconds.
- **F Playback** — cycles **Loop**, **Once**, **Ping-pong**.
- **G Collapse layers** — collapses or expands all layers on the timeline.
- Resize by dragging the top edge; **Collapse timeline** minimises it. Zoom: a slider on the right, pinch / spread, or ⌘ (Ctrl) + wheel.
- **Layer tracks**: "Animations applied to an object are grouped under a layer track." Drag a track to move it in time; drag its side handles "to change the duration of all animations on that object".

**Keyframes** (/41307938657559). Keyframable properties show a **diamond** in the right sidebar with **Add keyframe**. Manual: move the playhead, click Add keyframe, enter a value, move the playhead, enter another value. Unselected keyframes are a blue outline diamond, selected a blue filled diamond. Click selects; **double-click moves the playhead to it**; Shift-click or a drag box multi-selects; selecting a layer in the timeline selects all its keyframes. Drag to move ("wider spacing means slower motion"); **hold Shift and drag over the playhead to snap** to it (and so to other keyframes). Delete deletes; selecting a property row and pressing Delete deletes its whole track. Double-click a keyframe, then edit its value in the right sidebar. Examples of keyframable properties: opacity, position, rotation.

**Easing** (/41414048690839). Click the line between two keyframes (or a preset animation) to open the **Easing** menu:
- Bezier: **Linear**, **Ease in**, **Ease out**, **Ease in and out**, **Ease in back**, **Ease out back**, **Ease in and out back**, **Hold**.
- Spring: **Gentle**, **Quick**, **Bouncy**, **Slow**.
- Custom: **Custom bezier** (drag the handles, or type a cubic-bezier value; the corner points reset the curve), **Custom spring** (the spring editor, or a **Bounce** field).
- "Custom curves and springs can be saved as variables".
- Plugin API names (MotionEasing): EASE_IN, EASE_OUT, EASE_IN_AND_OUT, LINEAR, EASE_IN_BACK, EASE_OUT_BACK, EASE_IN_AND_OUT_BACK, CUSTOM_CUBIC_BEZIER {x1,y1,x2,y2}, GENTLE, QUICK, BOUNCY, SLOW, CUSTOM_SPRING {bounce 0–1}, HOLD. "The easing on a keyframe controls how to animate from the previous keyframe to this keyframe." `figma.motion.physicalSpringToNormalized({mass, stiffness, damping})` → bounce. HOLD ≙ CSS `steps(1, jump-end)`; on the last segment the last value persists.

**Presets and styles** (/41307886266135). In Motion, select layers and click **+** in the **Animations** section of the right sidebar, choose an animation type, set its settings ("Available settings vary depending on the animation type"). Or click **Animations** in that section for a **composite animation style** ("applies multiple preset animations at once"). A new preset starts at the playhead; drag it to move, drag its handles to change its duration; select it on the timeline or in the section to change type, settings, duration and easing. Seen values (tutorial): type **Scale** › **Scale in**, **Amount** 0 %, **Delay** 0 ms, **Duration** 250 ms; type **Rotation** › **Rotate in**, **Direction** Clockwise, **Amount** 2°, Delay 100 ms, Duration 180 ms; Easing Custom bezier. Blog: presets "include fade, move, and scale", "Styles can be stacked to play together or dragged into sequence"; "Custom animation styles are coming". Path trim: a **Path** animation style (open vector paths, one per object; disabled otherwise). Text: type **Text** (only with a text layer; grouping character, word, line or paragraph; direction; **Text stagger settings**), composite **Text enter** / **Text exit** (hover to preview on the canvas). Plugin: `figma.motion.figmaAnimationStyles()` lists Figma's styles ({styleId, name, description, props}); the Fade style has props `timing` ("in"), `easing` (default OUT_CUBIC); props seen in the skill: `timing`, `moveX`, `fade`, `easing`; `duration` and `timelineOffset` are top level (seconds).

**Anchor point** (/41352588622615). "By default, the anchor point is located at the center of the object." Rotation and scale pivot on it; "In Motion mode, position is measured from the anchor point" ("In Design mode, position is always measured from the object's upper-left corner"). **Edit anchor point** in the **Transform** section, or ⌥R (Alt R), then drag the target.

**Motion path** (/41780233501591). Selecting an object with position keyframes reveals its path: "A motion path appears as a sequence of dots" (spacing = easing), squares at keyframes. Drag a square to move that keyframe's position; ⌘ (Ctrl) while selecting a keyframe pulls a handle to curve the path. Editable only in Motion.

**Path trim** (/42200302811927). **Path trim start** and **Path trim end** in the **Stroke** section, 0–100 %, keyframable; only center-aligned strokes; open and closed paths.

**Audio** (/43825294171927). AAC, MPA, MP3, WAV; import and drop onto a frame or the timeline; drag the audio track in time; volume slider in the **Audio** section; right-click › **Mute audio** or the eye icon on the timeline row; **Split audio at playhead** (⌥K / Alt K), then move or Delete a region.

**Animated components** (/41307940738967). Made like any component (only in Design mode: "Components can currently only be created in Design mode"). "Animated instances appear as purple layer tracks on the timeline"; drag instances to reposition them in time; "the animation's duration and properties can only be edited at the main component level"; "Component properties cannot be modified while in Figma Motion."

**Variables** (/14506821864087). New types **Timing** ("Duration in milliseconds", applied "to a preset animation's delay and duration") and **Easing** ("Easing curve or spring animation", applied "to animation presets and keyframes"). Blog: "switching a page's mode updates every animation that references them". Paid plans: design system integration.

**Export** (/41307983648407). Select a **top-level frame** ("Animated layers must be inside a frame to be exported"; "Top-level frames with animated layers are marked with the Motion icon"), **Export** section › **Animated** tab › Export › Download. Formats **MP4, WebM, GIF, SVG**, plus **Lottie** (raw JSON, one animation per file) and **dotLottie** (compressed archive with images and fonts, several animations). Settings: **Size** (defaults or custom), **Frame rate**, **Quality** (MP4 / WebM: lossy compression), **Loop** (GIF: loop or play once). "Exporting animations larger than 1920 x 1080 or exceeding 30 FPS is only available on paid plans". Desktop app: a save dialog. Lottie limits: shaders exported as a flat image; video unsupported; angular gradients flat; drop shadows / noise / glass partial.

**Dev Mode** (/41296356954263). Select the animated frame, open the **Motion** tab in the Inspect panel, **Show in timeline view** (a read-only timeline beside the code). Under **Code**: a format selector **CSS** (default), **React**, **JSON**; **Copy**. Blog and overview: "copy animation code directly into CSS, JSON, or motion.dev" (React = motion.dev). The MCP gives keyframes, timing, easing (CSS `@keyframes` and motion.dev snippets; SwiftUI clients get CSS — **Figma emits no SwiftUI or Compose motion code**).

**Other.** Time-stamped comments ("tie feedback to specific moments"); the Figma agent adds keyframes from a prompt; shader properties are keyframable ("Any shader property can be keyframed"); **3D transforms "coming soon"** (blog; a waitlist). Prototypes: a forum answer says Motion animations autoplay and loop in prototypes, set by the timeline's Playback, and that triggering them from an interaction "doesn't appear to be available yet" (unofficial). Figma's schema nevertheless has the action `ConnectionType.UPDATE_ANIMATION_TIMELINE_STATE = 10` with `AnimationTimelineAction {PLAY, PAUSE, TOGGLE_PLAY_PAUSE, SET_PLAYHEAD}`.

**Plugin API facts used as model evidence** (developers.figma.com Motion types; the skill):
- `node.manualKeyframeTracks`: per field, `{id, baseValue, keyframes: [{id, timelinePosition (s), value, easing}]}`, `keyframeOperation 'SET' | 'OFFSET' | 'SCALE'`. Fills / strokes by paint index (SOLID colour only, or a shader property by `propertyId`), effects by index and field.
- Public fields: CORNER_RADIUS, the four RECTANGLE_*_CORNER_RADIUS, STROKE_WEIGHT, BORDER_*_WEIGHT ×4, STACK_SPACING, STACK_PADDING_* ×4, STACK_COUNTER_SPACING, WIDTH, HEIGHT, OPACITY, GRID_ROW_GAP, GRID_COLUMN_GAP, TRANSLATION_X / _Y / _XY, ROTATION, SCALE_X / _Y / _XY, PATH_TRIM_START / _END. Effect fields: OFFSET_X, OFFSET_Y, RADIUS, SPREAD, COLOR, REFRACTION_RADIUS, SPECULAR_ANGLE, SPECULAR_INTENSITY, CHROMATIC_ABERRATION, SPLAY, REFRACTION_INTENSITY, START_RADIUS, NOISE_SIZE_X, NOISE_SIZE_Y, DENSITY, EFFECT_OPACITY, SECONDARY_COLOR.
- Transform fields "compose with the node's existing transform": translation additive (neutral 0, px, node's own coordinate system, +x right, +y down), rotation additive (degrees, positive counter-clockwise like `node.rotation`, not normalised: −360 is a full clockwise turn), scale multiplicative (neutral 1). Rotation and scale pivot on the visual centre by default. Absolute fields replace the node's value. WIDTH / HEIGHT: "Not valid for groups and vector shapes."
- "The first keyframe's value holds back to t=0"; the last holds to the timeline's end; the first keyframe's easing is unused.
- "Do not animate top-level frames that are direct children of the page."
- `node.timelines` = the containing top-level frame's timeline `{id, duration}`; `setTimelineDuration(id, s)`.
- `node.animationStyles`: applied styles `{type 'FIGMA', id, styleId, name, duration, timelineOffset, props}` or `{type 'CUSTOM', id, styleId, name, timelineOffset}`.
- MCP / asset export renders a static asset at the timeline's t = 0 (skill gotcha).

## 2. What DesignerV2 already has (repo, 2026-10-12)

| Feature | Status | Where |
|---|---|---|
| Mode switch with Motion | ◐ `EditorMode` has `"motion"`; the toolbar's Motion segment is **disabled** (`docs/editor.md` N12) | `ds/components/EditorToolbar.tsx` (`EDITOR_MODES`, icon `24.motion`), `editor/canvas/BottomToolbar.tsx` |
| Easing maths | ✓ Figma's named cubic beziers and back easings (its easing table's numbers), physical springs with an initial velocity (presets Gentle / Quick / Bouncy / Slow, the `{1, 100, 10}` fallback), Figma's closed-form settle time T and ζ clamp, the spring editor's 6 / (ζω₀) duration and its inverse; prototype transitions use it (2026-10-15) | `engine/src/motion/Easing.{h,cpp}` (`cubicBezier`, `springValue`, `springSettleTime`, `springEditorDuration`, `springWithEditorDuration`); `engine/src/proto/Prototype.cpp` (`ease`, `durationOf`) |
| Interpolating props over time | ✓ Smart animate (matching layers, transforms, sizes, colours, opacity, text dissolve) in the player | `engine/src/proto/Player.*`, `render/PresentScene.h` (`PropsOverrides`) |
| A renderer that draws a node with replaced props | ✓ `Renderer::propsAt` (scene item overrides) | `render/Renderer.h` |
| Schema | ✗ KEYFRAME 56 / KEYFRAME_TRACK 57 / ANIMATION_PRESET_INSTANCE 58 and every motion field are placeholders; `EasingData`, `SpringParams`, `BezierHandles`, `VariableDataType.EASING 22 / TIMING 23` exist as `@later` | `schema/document.kiwi` |
| PNG frames of a node | ✓ E7 export (`exportNodes` → Pixels, `encodePixels`) | `editor/exportCore.ts`, `engine/src/export/` |
| Videos as media | ✓ VIDEO paints; files by SHA-1 hash in the file's image store; the browser plays them | `editor/images.ts`, `Player` Media |
| Dev Mode Inspect + code | ✓ CSS / iOS / Android code for layers; a tab slot (`ExtraTab`) | `src/viewer/InspectPanel.tsx`, `src/viewer/inspect/` |
| Comments | ✓ pins with a page point / layer offset; server D1 `comments` | `src/shared/comments.ts`, `server/src/comments.ts`, migration 0006 |
| Undo, actors, presence | ✓ engine.md §9 | — |

## 3. Decisions

1. **Figma's schema, Figma's numbers** (§4.1). Everything Motion stores is Figma's fields. No `@ours` field. Where Figma's *use* of a field could not be seen, our use is marked [unverified] and the field keeps Figma's name and type, so a Motion `.fig` from the owner can calibrate it without a migration.
2. **Keyframes are nodes.** A track is a KEYFRAME_TRACK node, its keyframes are KEYFRAME children, a preset is an ANIMATION_PRESET_INSTANCE node — the per-keyframe granularity of Figma's schema, so undo, the journal, multiplayer (per-property last writer wins), branch merges and libraries need nothing new.
3. **The document holds base values; time is a derived layer.** The animated node's own fields keep their static (base) value. The evaluator turns (timeline, t) into values that a **motion layer** writes over the base values in memory — preview writes, never in a transaction, never journaled, never in `DOCUMENT_CHANGED`, never in exports of the document (§5).
4. **Static renders draw the base values** (Design / Dev Mode canvas, thumbnails, PNG / JPG / SVG / PDF, the viewer, REST images). Figma's MCP asset export bakes t = 0 [differs; owner question §12.2]. Motion mode, the player, the animated exports and Dev Mode's timeline view draw the evaluated values.
5. **A timeline belongs to a top-level frame or a main component** (the "timeline root"). Its layers (not the root itself) are animated. Instances play their main component's timeline, offset in their container's.
6. **Presets are code, and their output is stored** (corrected 2026-10-15; Figma's code, `docs/research/rea/motion.md` §2.17): an animation preset is a code component (`CodeObjectType.ANIMATION_PRESET = 3`) written against a `figma:motion` module (`tween`, `animate`, `defineProperties`, `EasingType`), run in the plugin sandbox; what it returns is written as KEYFRAME_TRACK / KEYFRAME nodes that the field's KEYFRAME expression references through ANIMATION_PRESET parameters (§4.2), re-run when the props, the duration or the offset change. The evaluator only plays tracks, so C++ knows no preset. (The plugin docs' "not materialized" is about what `manualKeyframeTracks` returns, not about storage.)
7. **The editor's clock is in TypeScript** (requestAnimationFrame, or the AudioContext's clock while audio plays); the engine evaluates at the time it is given. The player's clock is the engine's (its existing `tick(nowMs)`).
8. **One undo step per user action** (§4.9 names).
9. **Exports encode in the renderer process**: WebCodecs for MP4 / WebM, `gifenc` for GIF, our own writers for animated SVG, Lottie and dotLottie. Nothing new in main; the save dialog is the existing export path.
10. **Dev Mode code is Figma's three formats** — CSS, React (motion.dev), JSON — from one resolved model the engine gives (§8).
11. **3D transforms are not built** ("coming soon" at Figma); `transform3d 570` / `scene3d 572` stay reserved.

---

## 4. Engine model

### 4.1 Schema (the main session's pre-round commit; the round's only schema edit)

**Take the schema from the current build, not from the 106 dump** (corrected 2026-10-15, `docs/research/rea/motion.md` §2.6; the embedded schema text is in that round's scratchpad, `rea-work/motion/embedded-schema.txt`). The numbers of the `NodeChange` motion fields below are unchanged there; the current build adds: `TimelineData.durationUsVar = 8`; `StyleIdForAnimation.timelineOffsetVar = 7`; `TextElementDelayBehaviour.clipContent = 5`, `transformOriginMode = 6`, `transformOrigin = 7` and `enum TextElementTransformOriginMode {MATCH 0, CHARACTER 1, WORD 2, LINE 3, PARAGRAPH 4}`; `KeyframeValueType.ROTATION_3D = 12` (`KeyframeAnyValue.rotation3DValue = 12`); `NodeContentsKeyframeBindingLocation.audioParametrizedField = 5`, `enum AudioParametrizedField {MISSING 0, GAIN 1, TIMELINE_OFFSET 2}`; `AudioFill` 13–20 (bpm and beat fields, `volumeVar 19`, `timelineOffsetVar 20`); `AudioBeatAnalysis` and `NodeChange.audioBeatAnalyses = 613`; `Paint.videoFillPlayback = 47` (`VideoFillPlayback` 1–7); `ExportSettings.frameRate 13, loopCount 14, backgroundType 15, duration 16, svgAnimated 17`; `ImageType MP4 4, GIF 5, WEBM 6, LOTTIE 7, DOTLOTTIE 8`; `VariableDataType.UNIT_NUMBER = 36`; `ExpressionFunction` KEYFRAME 19, COMPOSE_COLOR 20, PAINT_TO_COLOR 21, RESOLVE_LENGTH 22, TRANSITION 23; `TransitionOverrideData.all = 1` deprecated. **Deprecated in the current build** (kept as plain fields for round trips, never written): `keyframeValueRef 586`, `timelinePositionType 510`, `isClip 545`. The `.fig` importer must keep KEYFRAME / KEYFRAME_TRACK nodes and their fields (today it drops unknown node types, `src/shared/fig/convert.ts`): a round-trip test is part of the pre-commit.

Originally copied from `figma-schema-106.kiwi` with Figma's numbers, by `docs/schema.md` §15's rule. Checked 2026-10-12: every `NodeChange` number below is a placeholder `_rN` in `schema/document.kiwi`; no `@ours` name collides (ours are 1000–1002); `Effect` 37–42 / 45–54 are placeholders; `ComponentPropValue` 5 is free.

**Node types** (removed from the "Dropped" comment): `KEYFRAME = 56; KEYFRAME_TRACK = 57; ANIMATION_PRESET_INSTANCE = 58;`

**Enums, complete with Figma's values** (new): `InterpolationType {HOLD 0, BEZIER 1, SPRING 2}`, `KeyframeOperation {SET 0, SCALE 1, OFFSET 2}`, `TimelinePositionType {ABSOLUTE 0, RELATIVE 1}`, `TrackLoopMode {NONE 0, LOOP 1}`, `PlaybackStyle {ONCE 0, LOOP 1, BOOMERANG 2}`, `KeyframeValueType {FLOAT 0, INVALID 1, COLOR 2, TEXT_DATA 3, VECTOR 4, BOOL 5, CIRCLE 6, LINE 7, CIRCLE_POINT 8, COLOR_POINT 9, GRADIENT_PAINT 10, PAINT 11}`, `KeyframeTrackParameterType {INVALID 0, MANUAL 1, ANIMATION_PRESET 2}`, `InterpolationColorSpace {DEFAULT 0, OKLAB 1, OKLCH 2, HSL 3, SRGB_LINEAR 4}`, `InterpolationHueMethod {SHORTER 0, LONGER 1, INCREASING 2, DECREASING 3}`, `TextElementGrouping {CHARACTER 0, CHARACTER_NO_WHITESPACE 1, WORD 2, LINE 3, PARAGRAPH 4}`, `TextElementDelayOrder {LEFT_RIGHT 0, RIGHT_LEFT 1, CENTER_OUT 2, RANDOM 3}`, `SpringType {NORMALIZED 0, PHYSICAL 1}`, `VariableTimingDisplayUnit {MILLISECONDS 0, SECONDS 1}`, `AnimationTimelineAction {PLAY 0, PAUSE 1, TOGGLE_PLAY_PAUSE 2, SET_PLAYHEAD 3}`, `KeyframeBindingEffectParametrizedField` (0–21, round trip).

**Enum values added to kept enums**: `VariableDataType KEYFRAME_TRACK_ID = 20, KEYFRAME_TRACK_PARAMETER_DATA = 21`; `VariableResolvedDataType KEYFRAME_TRACK_ID = 13, KEYFRAME_TRACK_PARAMETER_DATA = 14`; `VariableField` 43–76 complete (X_POSITION 43 … TEXT_ELEMENT_DELAY 76, Figma's names); `StyleType ANIMATION = 7`; `ConnectionType UPDATE_ANIMATION_TIMELINE_STATE = 10` (the comment keeps OBJECT_ANIMATION 9 dropped); `ExpressionFunction KEYFRAME = 19` (the binding of every keyframed field, §4.2); `ComponentPropType EASING = 8`. `EASING 22 / TIMING 23` and `EASING 15 / TIMING 16` lose `@later`.

**Messages** (new, Figma's fields complete): `FrameRate {numerator 1, denominator 2}`, `TRSSTransform2D {translation 1, rotation 2, scale 3, shearX 4}`, `TransformOrigin {Number x 1, Number y 2}`, `OptionalVector {Vector value 1}`, `Circle`, `Line`, `CirclePoint`, `ColorPoint`, `GradientParameterValue`, `KeyframeAnyValue` (1–11), `KeyframeValueData {value 1, valueType 2}`, `KeyframeTrackId {guid 1, assetRef 2}`, `AnimationPresetId {guid 1, assetRef 2}`, `ManualKeyframeTrackParameter {keyframeTrackId 1, timelineDefId 2}`, `AnimationPresetKeyframeTrackParameter {animationPresetId 1, keyframeTrackId 2, timelineDefId 3}`, `KeyframeTrackAnyParameter {manual 1, animationPreset 2, animationStyleBindingId 3}`, `KeyframeTrackParameter {value 1, type 2}`, `KeyframeTrackParameterValue {parameters 1}`, `TimelineData {durationUs 1, defaultTimeline 2, parentTimelineDefId 3, playbackStyle 4, autoplay 5, keyframeSnappingFps 6, quantizePlayback 7, durationUsVar 8}`, `TimelineDefinitionsMap(Entry)`, `TimelineAssignmentKey {assignedTimelineId 1, containingTimelineId 2}`, `TimelineBindingData {offsetUs 1, disabled 2, autoplay 3}`, `TimelineAssignmentsMap(Entry)`, `AnimationPresets {presets 1}`, `AnimationPresetData {animationPresetId 1, timelineDefId 2, sortPosition 3}`, `StyleAnimation {animationPresetId 1}`, `StyleIdForAnimation {id 1, timelineDefId 2, animationStyleId 3, timelineOffset 4, generatedAnimationPresets 5, sortPosition 6, timelineOffsetVar 7}`, `GeneratedAnimationPreset {animationPresetId 1}`, `TextElementDelayBehaviour {enabled 1, grouping 2, delayMs 3, order 4, clipContent 5, transformOriginMode 6, transformOrigin 7}`, `AudioFill` (1–12), `AudioTrack` (1–4), `NodeContentsKeyframeBindingLocation` (round trip only).

**Fields added to kept messages**:
- `SpringParams.springType = 4` (`SpringType`). `VariableAnyValue.keyframeTrackIdValue = 19`, `keyframeTrackParameterValue = 20` (replacing `_r19`, `_r20`). `ComponentPropValue.easingData = 5`.
- `Effect`: `refractionRadiusVar 37`, `specularAngleVar 38`, `specularIntensityVar 39`, `chromaticAberrationVar 40`, `splayVar 41`, `refractionIntensityVar 42`, `startRadiusVar 45`, `startOffsetXVar 46`, `startOffsetYVar 47`, `endOffsetXVar 48`, `endOffsetYVar 49`, `noiseSizeXVar 50`, `noiseSizeYVar 51`, `densityVar 52`, `effectOpacityVar 53`, `secondaryColorVar 54` (all `VariableData`).
- `PrototypeAction`: `animationTimelineAction = 39`, `animationSkipToTime = 40`, `animationTimelineDefId = 41`.

**`NodeChange` fields adopted** (Figma's declarations):

| # | Field | On (ours) | Use |
|---|---|---|---|
| 505 | `InterpolationType interpolationType` | KEYFRAME | mirrors `easingData` (HOLD / BEZIER / SPRING) for round trips |
| 506 | `int64 timelinePosition` | KEYFRAME | µs from the timeline's start, an integer (`Math.round(1e6 · s)`; seconds at the plugin API) |
| 507 | `KeyframeValueData keyframeValue` | KEYFRAME | the keyframe's value in stored units (§4.5); the base value is the KEYFRAME expression's first argument, not on the track (§4.2) |
| 508 | `BezierHandles bezierHandles` | KEYFRAME | mirrors `easingData`'s bezier |
| 509 | `KeyframeOperation keyframeOperation` | KEYFRAME_TRACK | SET 0 replace, SCALE 1 multiply, OFFSET 2 add; SET for manual tracks |
| 510 | `TimelinePositionType timelinePositionType` | — | deprecated in the current build: round trip only |
| 511 | `GUID clipId` | — | round trip only |
| 512 | `uint64 timelineDuration` | top-level frame (the default timeline), ANIMATION_PRESET_INSTANCE | the timeline's length, µs (`setTimelineDuration` writes `round(s · 1e6)` on the frame); a clip's length |
| 513 | `int64 timelineOffset` | top-level frame, ANIMATION_PRESET_INSTANCE | µs |
| 514 | `PlaybackStyle playbackStyle` | top-level frame | the default timeline's playback (ONCE / LOOP / BOOMERANG) |
| 521 | `AnimationPresets animationPresets` | animated layer | its presets, in stacking order |
| 523 | `TRSSTransform2D motionTransform` | animated layer | the motion transform's base; absent = identity |
| 535 | `EasingData easingData` | KEYFRAME, ANIMATION_PRESET_INSTANCE | the easing into this keyframe / of the clip |
| 542 | `OptionalVector pathTrim` | vector-like layers | x = start, y = end, 0–1; absent = 0 / 1 [mapping unverified] |
| 543 | `bool timelineDisabled` | top-level frame, ANIMATION_PRESET_INSTANCE | the timeline / clip is off (eye) |
| 544 | `bool useLegacySmartAnimate` | — | round trip only (the player's snapshot Smart animate is the legacy path) |
| 545 | `bool isClip` | — | deprecated in the current build: round trip only |
| 552 | `TimelineDefinitionsMap timelineDefinitions` | main component, frame with nested timelines | nested and main-component timelines only; the default timeline is the frame's own fields (§4.3) |
| 553 | `TimelineAssignmentsMap timelineAssignments` | INSTANCE | its main's timeline placed in the container's |
| 566 | `VariableTimingDisplayUnit timingDisplayUnit` | VARIABLE (TIMING) | shown in ms or s |
| 580 | `StyleAnimation[] styleAnimations` | style node (ANIMATION) | round trip (custom styles are "coming" at Figma) |
| 582 | `StyleIdForAnimation[] styleIdsForAnimation` | animated layer | composite styles applied and the presets each generated |
| 583 | `AnimationPresetId backingAnimationPresetId` | ANIMATION_PRESET_INSTANCE | the preset type (`assetRef.key`, §4.6) |
| 586 | `VariableData keyframeValueRef` | — | deprecated in the current build: round trip only (a keyframe's value binds through the KEYFRAME's own `parameterConsumptionMap`, §4.2) |
| 587 | `TransformOrigin transformOrigin` | animated layer | the anchor point; absent = 50 % / 50 % |
| 591 | `TrackLoopMode trackLoopMode` | KEYFRAME_TRACK | NONE (LOOP evaluated, no UI [unverified]) |
| 597 | `bool linkMotionScaleAspectRatio` | animated layer | Scale's link toggle |
| 598 | `BezierHandles motionPathBezierHandles` | KEYFRAME (position) | the motion path's handles |
| 599 | `InterpolationColorSpace interpolationColorSpace` | KEYFRAME (colour) | |
| 600 | `InterpolationHueMethod interpolationHueMethod` | KEYFRAME (colour, OKLCH / HSL) | |
| 601 | `FrameRate timelineKeyframeSnappingFps` | top-level frame | the default timeline's snapping grid (§6.2) |
| 602 | `bool quantizeTimelinePlayback` | top-level frame | round trip |
| 603 | `AudioFill[] audioFills` | timeline root | audio clips |
| 605 | `AudioTrack[] audioTracks` | timeline root | audio rows |
| 610 | `TextElementDelayBehaviour textElementDelayBehaviour` | TEXT | text stagger (fields 1–7, §4.10) |
| 613 | `AudioBeatAnalysis[] audioBeatAnalyses` | timeline root | round trip |

**Still reserved**: `transform3d 570` / `scene3d 572` (3D, not released), `objectAnimations 426` (Slides), `transitionOverrides 526` (prototype transition overrides, a later Design round), `strokeOffset 554`, `strokeData 571`, `customEffects 569` (Draw's list).

**Field metadata.** All new fields are ordinary overridable fields except: `timelineDefinitions`, `audioFills`, `audioTracks` are `@nooverride` (an instance never redefines its main's timeline); `timelineAssignments` is `@own` on an INSTANCE. A `parameterConsumptionMap` entry carrying a KEYFRAME expression is refused in `symbolOverrides` (Figma: motion is edited at the main component only); the engine drops it with a warning on import.

**Default values** (`@default`): `motionTransform` absent = `{translation 0,0, rotation 0, scale 1,1, shearX 0}` (kiwi's zero scale must not be read as 0); `transformOrigin` absent = `{50 PERCENT, 50 PERCENT}`; `pathTrim` absent = no trim; a fresh timeline's length 2 000 000 µs (help: "New animations default to 2000 milliseconds"; the code that sets it was not seen, probe 5.1).

After the edit: `npm run engine:gen` (C++ and TS codecs; no wasm build), `npm run check`.

### 4.2 Where the motion nodes live, and how a layer points to them [structure unverified]

Figma's ids carry an `assetRef` (`KeyframeTrackId`, `AnimationPresetId`), so tracks and presets are addressable assets, not layers. Ours:

- **KEYFRAME_TRACK** and **ANIMATION_PRESET_INSTANCE** nodes are children of the **Internal Only Canvas `0:2`** (with VARIABLE, BRUSH…), never under a page. A track's `name` is its field (e.g. `OPACITY`, `fills[0]`, `effects[1].RADIUS`); a preset instance's `name` is its type's name.
- A track's id string is `KeyframeTrackId:<guid>` (Figma's). **KEYFRAME** nodes are children of their track, sorted by `timelinePosition`; **positions are unique per track**: writes upsert keyframes by integer µs position, then delete every child whose position is not in the new list (Figma's `addOrUpdateKeyframe`); duplicate positions in a preset's output collapse to the last one.
- The **binding** (corrected 2026-10-15, Figma's code `docs/research/rea/motion.md` §2.8) is an **expression**: the animated layer's `parameterConsumptionMap` entry for the field (key = the field's `VariableField`, e.g. `MOTION_TRANSLATION_X`, `OPACITY`) holds `VariableData {dataType EXPRESSION, resolvedDataType <the base value's: FLOAT / COLOR / VECTOR>, value.expressionValue {expressionFunction KEYFRAME (19), expressionArguments: [base, {dataType KEYFRAME_TRACK_PARAMETER_DATA, value.keyframeTrackParameterValue {parameters}}]}}`. **The resting (base) value is the expression's first argument.** Each parameter is `{type MANUAL, value.manual {keyframeTrackId, timelineDefId}}`, `{type ANIMATION_PRESET, value.animationPreset {animationPresetId, keyframeTrackId, timelineDefId}}`, or an `animationStyleBindingId`. Several stack on one field, folded in list order; writing a manual track keeps the preset parameters and appends MANUAL (`[...presetParams, manual]`). The engine already evaluates EXPRESSION bindings (variables round): KEYFRAME is one more `ExpressionFunction` that returns the folded track value at the motion layer's time, and argument 0 when Motion is off.
  - Paint fields bind through the paint's own `VariableData` slots, with the same KEYFRAME expression: SOLID colour → `Paint.colorVar`, paint opacity → `Paint.opacityVar`, a shader property → `Paint.componentPropAssignments[k].varValue`. Effects, fill / stroke component props and audio gain are located with `NodeContentsKeyframeBindingLocation {topLevelField EFFECT_DATA | FILL_PAINT_DATA | STROKE_PAINT_DATA | AUDIO_FILLS, index, effectParametrizedFieldValue, audioParametrizedField}`.
  - Effect fields through `Effect.*Var` (OFFSET_X → `xVar`, OFFSET_Y → `yVar`, RADIUS → `radiusVar`, SPREAD → `spreadVar`, COLOR → `colorVar`, REFRACTION_RADIUS → `refractionRadiusVar`, SPECULAR_ANGLE → `specularAngleVar`, SPECULAR_INTENSITY → `specularIntensityVar`, CHROMATIC_ABERRATION → `chromaticAberrationVar`, SPLAY → `splayVar`, REFRACTION_INTENSITY → `refractionIntensityVar`, START_RADIUS → `startRadiusVar`, NOISE_SIZE_X / _Y → `noiseSizeXVar` / `noiseSizeYVar`, DENSITY → `densityVar`, EFFECT_OPACITY → `effectOpacityVar`, SECONDARY_COLOR → `secondaryColorVar`); a shader effect's property → `Effect.componentPropAssignments[k].varValue`.
  - A KEYFRAME's easing bound to an EASING variable: the KEYFRAME's own `parameterConsumptionMap` entry `EASING_DATA (57)` → ALIAS. Its value bound to a variable: the KEYFRAME's own entry `KEYFRAME_VALUE (68)` → ALIAS [inferred from the VariableField; `keyframeValueRef 586` is deprecated].
- **A variable-bound field keeps its alias as the expression's base argument** (an ALIAS `VariableData` as argument 0): no alias moves, no undo special case. Removing the last track puts argument 0 back as the field's binding (or its literal as the field's value).
- **The `MotionIndex`** (engine, derived, rebuilt with bindings): track → animated nodes, node → (field → track), root → its animated nodes, preset → node.
- **Ownership operations** (every one in the same transaction as the operation itself):
  - deleting a layer removes the tracks, keyframes and preset instances only it binds;
  - duplicate, copy / paste (same file and across files), Paste to replace, create component / set from animated layers keep or deep-copy them with new GUIDs and rebind;
  - Detach instance deep-copies the main's tracks for the detached layers (otherwise main and copy would share them);
  - Flatten / boolean / Outline stroke drop the consumed layers' tracks;
  - library publish carries a component's tracks and presets as dependencies; a library copy in a consuming file brings them with `assetRef` set; Accept update replaces them (like variables, `docs/data.md` §8);
  - `.fig` import keeps Figma's structure as is: whatever Figma's parents are, the evaluator reads only the bindings and the nodes' fields, so a track that Figma keeps elsewhere still plays. (Where Figma's tracks live is still not visible in its code; the Internal Only Canvas is ours.)

### 4.3 Timelines

- A **timeline root** is a top-level frame (a page's direct child FRAME / SYMBOL / INSTANCE, a section's direct child frame included) or any SYMBOL. **The default timeline is the frame itself** (corrected 2026-10-15, Figma's code `docs/research/rea/motion.md` §2.15): its length is the frame's own `timelineDuration 512` (µs; `node.timelines` returns `[{id: the containing top-level frame's id, duration: timelineDuration / 1e6}]`, and `setTimelineDuration(id, s)` requires id to be that frame and 0 < s ≤ MAX_SAFE_INTEGER µs), its playback the frame's `playbackStyle 514`, its snapping grid `timelineKeyframeSnappingFps 601`, its offset / off switch `timelineOffset 513` / `timelineDisabled 543`, and **its id is the frame's GUID** wherever a `timelineDefId` refers to it. A fresh timeline: 2 000 000 µs (help; probe 5.1), `playbackStyle LOOP` [unverified], snapping 60/1 (the frames-mode default, §6.2), `quantizeTimelinePlayback false`.
- **`timelineDefinitions 552`** holds only nested and main-component timelines: GUID → `TimelineData {durationUs, defaultTimeline, parentTimelineDefId, playbackStyle ONCE | LOOP | BOOMERANG, autoplay, keyframeSnappingFps, quantizePlayback, durationUsVar}`.
- The root itself is never animated (Figma's rule); its descendants are. Diamonds on the root are disabled.
- The timeline's length is `durationUs`. Keyframes and clips past it are kept and drawn dimmed in the timeline [unverified]; playback stops at the duration.
- **Animated instances**: an INSTANCE inside a root whose main is a timeline root plays the main's timeline (Figma calls it "clip-backed", `isClipBackedComponentInstance`, `clipId 511`). Its place in time is its `timelineAssignments` entry `{key {assignedTimelineId = the main's timeline id, containingTimelineId = the container root's timeline id}, value {offsetUs, disabled false, autoplay true}}`; absent = offset 0. It plays with the main's duration and playback style, within the container's time. Nested instances compose offsets. The instance's own sublayers are not editable in Motion (purple track; drag only).
- **Playback styles**: ONCE → t clamps to [0, d]; LOOP → t mod d; BOOMERANG (UI "Ping-pong") → triangle wave of period 2d.

### 4.4 Track evaluation

For field f of node n at root time T (µs):

1. **Local time**: τ = T − (sum of instance offsets on the way down), mapped by each enclosing instance's main's playback style.
2. **Parameters**, in the KEYFRAME expression's list order, starting from the base value b = the expression's argument 0 resolved in n's variable modes (for MOTION_* fields the component of `motionTransform`, for MOTION_TRANSFORM_ORIGIN_* of `transformOrigin`):
   - each parameter's track (MANUAL, or the materialised tracks of an ANIMATION_PRESET parameter) → its value v(τ), combined by the track's `keyframeOperation`: SET → v; OFFSET → acc + v; SCALE → acc × v.
3. **A track's value v(τ)**: keyframes sorted by `timelinePosition` t₀ < t₁ < … (positions are unique per track, §4.2; binary search).
   - τ ≤ t₀ → value(k₀) (the first value holds back to 0); τ ≥ tₙ → value(kₙ).
   - tᵢ < τ < tᵢ₊₁ → p = (τ − tᵢ) / (tᵢ₊₁ − tᵢ), e = ease(kᵢ₊₁'s easing, p), value = interpolate(value(kᵢ), value(kᵢ₊₁), e, kᵢ₊₁'s colour space / hue method; for VECTOR position tracks the motion path, §4.8).
   - A keyframe's value: its KEYFRAME_VALUE (68) binding resolved in n's variable modes if set, else `keyframeValue`, converted from stored units (§4.5).
   - `trackLoopMode LOOP`: τ wraps on [t₀, tₙ] [unverified].
4. **Mapping to the node**: the result is written to the field (§5). MOTION_* compose as §4.5.

### 4.5 Fields, value types and composition

The single table (`src/shared/motion/types.ts` `KEYFRAME_FIELDS`, mirrored in C++ `motion/Fields.h`; a test checks they agree). It also carries each field's **stored unit** (corrected 2026-10-15, Figma's unit module, `docs/research/rea/motion.md` §2.12) — `storedToNode` / `nodeToStored`, used by the evaluator, the panels and the plugin layer — and Figma's **write clamps**:
- **OPACITY**, the normalised effect fields (SPECULAR_INTENSITY, CHROMATIC_ABERRATION, SPLAY, REFRACTION_INTENSITY) and audio volume are **stored × 100** (opacity 0.5 ↔ stored 50).
- **ROTATION (MOTION_ROTATION) is stored as −radians** (the plugin's degrees, positive counter-clockwise: 90° ↔ −π/2). 3D rotations are stored in radians, not negated. SCALE-operation tracks are not converted.
- Clamps on write: radii, stroke and border weights, paddings, WIDTH / HEIGHT, grid gaps and STACK_COUNTER_SPACING ≥ 0; OPACITY and PATH_TRIM_* in [0, 1] (plugin units); effect RADIUS ≥ 0, SPREAD ±30000, REFRACTION_RADIUS 1–100, SPECULAR_ANGLE −899…900, START_RADIUS and NOISE_SIZE 0–100, DENSITY and EFFECT_OPACITY 0–1; audio volume 0–2; colour channels 0–1; `timelinePosition` ≥ 0.
- **Combined XY and separate X / Y tracks cannot coexist** on one node for position or scale (Figma: "keyframe tracks must be either combined or separated"); the write path refuses the mix, and `MOTION_COMBINE_TRACKS` / `MOTION_SPLIT_TRACKS` (§4.9) switch between them, merging keyframe times.
- Plugin reads of translation, rotation and shear base values add the node's static TRSS component (`relativeTransform`'s), as Figma's do.

| Public name | `VariableField` | Value type | Node field | Kind |
|---|---|---|---|---|
| OPACITY | 31 | FLOAT 0–1 (stored × 100) | `opacity` | absolute |
| CORNER_RADIUS | 1 | FLOAT px | `cornerRadius` | absolute |
| RECTANGLE_TOP_LEFT / TOP_RIGHT / BOTTOM_LEFT / BOTTOM_RIGHT_CORNER_RADIUS | 14 / 15 / 16 / 17 | FLOAT px | the corner's radius | absolute |
| STROKE_WEIGHT | 4 | FLOAT px | `strokeWeight` | absolute |
| BORDER_TOP / BOTTOM / LEFT / RIGHT_WEIGHT | 18 / 19 / 20 / 21 | FLOAT px | the border weight | absolute |
| STACK_SPACING, STACK_COUNTER_SPACING | 5, 23 | FLOAT px | auto layout gaps | absolute, re-lays out |
| STACK_PADDING_LEFT / TOP / RIGHT / BOTTOM | 6 / 7 / 8 / 9 | FLOAT px | paddings | absolute, re-lays out |
| GRID_ROW_GAP, GRID_COLUMN_GAP | 41, 42 | FLOAT px | grid gaps | absolute, re-lays out |
| WIDTH, HEIGHT | 12, 13 | FLOAT px > 0 | `size` | absolute, re-lays out; not for groups and vectors |
| TRANSLATION_X, TRANSLATION_Y | 46, 47 | FLOAT px | motion translation | additive on `motionTransform` |
| TRANSLATION_XY | 69 | VECTOR px | motion translation | additive; has a motion path |
| ROTATION | 48 | FLOAT degrees, CCW + (stored −radians) | motion rotation | additive, not normalised |
| SCALE_X, SCALE_Y | 49, 50 | FLOAT × | motion scale | multiplicative |
| SCALE_XY | 70 | VECTOR × (a FLOAT input is uniform) | motion scale | multiplicative |
| PATH_TRIM_START, PATH_TRIM_END | 54, 55 | FLOAT 0–1 | `pathTrim.value.x / .y` | absolute |
| fills[i] / strokes[i] colour | via `Paint.colorVar` | COLOR | the paint's colour (SOLID) | absolute |
| fills[i] / strokes[i] opacity | via `Paint.opacityVar` | FLOAT 0–1 | the paint's opacity | absolute |
| fills[i] / effects[i] shader property | via `componentPropAssignments[k].varValue` | the property's type (FLOAT, COLOR, VECTOR, CIRCLE, LINE, CIRCLE_POINT, COLOR_POINT) | the assignment's value | absolute |
| effects[i].<field> | via `Effect.*Var` | FLOAT, or COLOR for COLOR / SECONDARY_COLOR (normalised fields 0–1, stored × 100) | the effect's field | absolute |
| *not public, evaluated if a file has them*: MOTION_SHEAR 51, MOTION_TRANSFORM_ORIGIN_X / _Y / _XY 74 / 75 / 73, ARC_DATA_STARTING_ANGLE / ENDING_ANGLE / INNER_RADIUS 65 / 66 / 67, STAR_INNER_SCALE 72, POLYGON_COUNT 64 (rounded), TEXT_ELEMENT_DELAY 76 | | FLOAT | | absolute (shear additive) |
| *never evaluated* (round trip): X_POSITION 43, Y_POSITION 44, ROTATION 45, SCROLL_OFFSET_* 52–53, DISSOLVE_PROGRESS 56, MEDIA_CURRENT_TIME 58, TRANSFORM_3D_* 59–63, SCENE_3D_PERSPECTIVE 71 | | | | — |

**The motion transform.** For a node with transform M (its layout transform, Design's x / y / rotation / flip) and size (w, h), anchor o = (resolve(transformOrigin.x, w), resolve(transformOrigin.y, h)) (PERCENT → % of the size, PIXELS / RAW → px), and motion values tx, ty, r (degrees), sx, sy, k (shear):

`M_motion = M · T(o) · T(tx, ty) · R(−r) · Shear(k) · S(sx, sy) · T(−o)`

(R(−r): Figma's positive rotation is counter-clockwise on a y-down canvas, as `node.rotation`; the stored value is already −radians, §4.5.) Translation is in the node's own coordinates (the plugin's rule). The motion transform is **visual only**: it never moves siblings in auto layout, never changes constraints, and only the node's subtree is transformed (CSS `transform` semantics). Its result is a separate derived matrix (`NodeTable.motionWorld`), so the layout transform is untouched.

**Fields that change layout** (WIDTH, HEIGHT, STACK_*, GRID gaps) mark the node `LAYOUT` and run layout in the motion layer's flush (§5), so children reflow as Figma's do.

### 4.6 Presets (ANIMATION_PRESET_INSTANCE 58)

Rewritten 2026-10-15 from Figma's code (`docs/research/rea/motion.md` §2.17, §2.18); the 2026-10-12 table (Fade / Move, 500 ms, 100 px, invented composite styles) is withdrawn.

**What a preset is.** An animation style is a style of `StyleType.ANIMATION` whose content is **animation presets**: code components (`CodeObjectType.ANIMATION_PRESET = 3`) in TypeScript against a `figma:motion` module (`animate`, `tween`, `defineProperties`, `EasingType`). A preset returns `AnimationPreset {nodeId, keyframeTracks [{parameterField | topLevelField + index + effectParametrizedField, keyframeOperation, keyframes [{timelinePosition µs, easing, value}], enabled}], textElementDelayBehaviour?, effects?}`. `tween({mode, timelinePosition = 0, duration, from, to, easing, enabled = true})` gives exactly two keyframes at [pos, pos + duration], both carrying the easing; a negative duration throws. A preset may generate at most one LAYER_BLUR effect. Delay is not added to the positions: it is the binding's `timelineOffset`.

**Ours, in Figma's shape:**
- a small `figma:motion` runtime in TypeScript (`src/shared/motion/runtime.ts`: `tween`, `animate`, `defineProperties`, `EasingType`) that runs in the plugin sandbox (`editor/plugins/runtime/`);
- the first-party presets as our own TypeScript modules against it (written from the behaviour below; Figma's sources are not copied);
- applying a style runs the preset and materialises its tracks with `MOTION_SET_PRESET_TRACKS` in the same undo step (KEYFRAME_TRACK nodes referenced from the fields' KEYFRAME expressions through ANIMATION_PRESET parameters, §4.2), and re-runs it when its props, duration or offset change, collapsing duplicate positions as Figma does;
- node fields: `styleIdsForAnimation 582` (`{id, timelineDefId, animationStyleId, timelineOffset µs, generatedAnimationPresets[], sortPosition, timelineOffsetVar}`), `animationPresets 521`, `styleAnimations 580`, `backingAnimationPresetId 583`, the ANIMATION_PRESET_INSTANCE 58 nodes. Props are `componentPropAssignments` on the instance, values in `ComponentPropValue` or bound in `varValue` (TIMING → Delay / Duration, EASING → Easing).

Custom (user) animation styles later need only the style node and the sandbox; C++ needs no preset knowledge.

**The first-party catalogue** (Figma's active presets and their defaults; the propDefs carry `{name, type NUMBER | TEXT | BOOL | EASING, label motion.preset_flyout.*, default, selectConfig.options, inputConfig {min, max, unit, icon}, numberResolvedAsTiming}`). Shared: Delay 0 s, Duration 0.5 s (min 0.01), Easing OUT_CUBIC.

| Preset | Types | Props and defaults | Track |
|---|---|---|---|
| **New** | (starter) | — | — |
| **Opacity** | fadeIn / fadeOut / custom | amount 0 %, start 0 %, end 100 % | OPACITY, mode **SCALE** (amount / 100 → 1 for fadeIn) |
| **Position** | slide_in / slide_out / custom | direction left / right / top / bottom + the 4 diagonals (default left), distance **200 px**, axis xy, start 200 / 200, end 0 / 0 | TRANSLATION_XY, mode **OFFSET** |
| **Scale** | scaleIn / scaleOut / custom | axis whCombined, amount **120 %** | SCALE_XY, mode **SCALE** |
| **Rotation** | rotateIn / rotateOut / custom | clockwise, **180°** (a clockwise rotateIn goes −amount → 0), radians | ROTATION, mode **OFFSET** |
| **Size** | resize_in / resize_out / custom | amount 50 px, start 50, end 100 | WIDTH / HEIGHT, mode **OFFSET** |
| **Corner Radius** | roundIn / roundOut / custom | corner all, amount 10 px (roundOut `[amount, 0]`, otherwise `[0, amount]`; probe 5.11) | CORNER_RADIUS, mode **OFFSET** |
| **Path** | draw / erase / travel / custom | segment 10 %; needs strokes | PATH_TRIM_*, mode **SET** |
| **Text** | revealBy character / word / line | duration 1.5 s | typewriter |
| **TextStagger** | in / out | §4.10 (gated `metronome_text_animations` at Figma) | per element |

Fade, Move, Rotate, Resize, Path Draw and Path Travel are **deprecated** at Figma (read, never offered). **Composite styles**: none listed until probe 5.10 (`figma.motion.figmaAnimationStyles()`) shows Figma's own names, ids and props; the help's **Text enter** / **Text exit** are the only verified names.

### 4.7 Easing

One implementation, `engine/src/motion/Easing.{h,cpp}` — **built 2026-10-15** for prototypes (`proto::ease` / `durationOf` call it): `cubicBezier`, the preset tables, `springValue` (with an initial velocity), Figma's settle time `springSettleTime`, the spring editor's `springEditorDuration` and its inverse, the editor limits. Round 8 adds `forKeyframe(EasingData*)`, HOLD, bounce ↔ physical and the normalised segment mode. All numbers below are Figma's (its easing tables module, shared by prototypes and Motion; corrected 2026-10-15, `docs/research/rea/motion.md` §2.3, §2.5, §2.10, §2.11).

| UI | `EasingType` | Curve |
|---|---|---|
| Hold | HOLD 14 | 0 until p = 1 (CSS `step-end`) |
| Linear | LINEAR 3 | t |
| Ease in | **EASE_IN 15** (written; IN_CUBIC 0 is read as Ease in only in prototypes) | cubic-bezier(0.42, 0, 1, 1) |
| Ease out | OUT_CUBIC 1 | (0, 0, 0.58, 1) |
| Ease in and out | INOUT_CUBIC 2 | (0.42, 0, 0.58, 1) |
| Ease in back | IN_BACK_CUBIC 4 | (0.3, −0.05, 0.7, −0.5) |
| Ease out back | OUT_BACK_CUBIC 5 | (0.45, 1.45, 0.8, 1) |
| Ease in and out back | INOUT_BACK_CUBIC 6 | (0.7, −0.4, 0.4, 1.4) |
| Custom bezier | CUSTOM_CUBIC 7 | `easingValue.bezierEasing`; prototypes' default (0, 0, 0.58, 1) |
| Gentle / Quick / Bouncy / Slow | GENTLE_SPRING 9 / SPRING_PRESET_ONE 11 / SPRING_PRESET_TWO 12 / SPRING_PRESET_THREE 13 | physical `[mass, stiffness, damping, v0]` = [1, 100, 15, 0] / [1, 300, 20, 0] / [1, 600, 15, 0] / [1, 80, 20, 0] (legacy SPRING 8 reads as Gentle) |
| Custom spring | CUSTOM_SPRING 10 | `easingValue.springEasing {mass, stiffness, damping}`; default [1, 100, 15, 0]; an invalid one falls back to [1, 100, 10, 0] |

**On keyframes, `easingType` 0 (IN_CUBIC, the kiwi default) means "no easing"** and resolves to **CUSTOM_CUBIC (0.5, 0, 0.5, 1)**; a missing easing too. New keyframes and plugin keyframe writes without an easing store CUSTOM_CUBIC `{0.5, 0, 0.5, 1}`; a real ease in is EASE_IN 15.

**Springs.** ω₀ = √(k/m), ζ = c / (2√(km)), clamped to ≥ 0.03 (an undamped spring still settles); value(t) = 1 − x(t) by the under-, critically or over-damped closed form with v₀ = initialVelocity. **Settle time T = (−ln 0.001 + ln(1 + (ζω₀ + |v₀|) / ω_d)) / (ζω₀)**, ω_d = ω₀√(1 − ζ²), with ζ ≤ 0.9999 (GENTLE: T ≈ 1.022 s); a prototype spring transition lasts T (whether Figma's player uses T or 6 / (ζω₀) is probe 5.4). The spring editor's **Duration is 6 / (ζω₀) = 12m / c**; typing a duration d sets ω₀ = 6 / (d·ζ) rounded to 4 significant digits (mass and ζ kept); its graph handle sits at x = π / ω₀, y = 2 − 2·clamp(ζ, 0, 1)^0.87. Limits: ω₀ 0.1–1000, mass 0.01–100, stiffness 0.01–10000, damping 0.01–1000.

**Springs in keyframes are stored physical** — `EasingData {easingType CUSTOM_SPRING, easingValue.springEasing {mass, stiffness, damping}}`, or the preset types — and **played normalised** (`SpringParams.springType` NORMALIZED 0 / PHYSICAL 1): over a segment, e(p) = spring(p · T(m, k, c)) and e(1) = 1, so the curve fills the interval.
- The plugin and the UI show one **bounce** = clamp(1 − ζ, 0, 1). bounce → physical: ζ = clamp(1 − bounce, 1e−4, 1), ω₀ kept from the existing spring if valid else 10 rad/s, mass kept (clamped 0.01–100) else 1, k = ω₀²m, c = 2ζ√(km); a fresh bounce b becomes `{m 1, k 100, c 20(1 − b)}`.
- `figma.motion.physicalSpringToNormalized({mass, stiffness, damping})` requires positive finite values and returns 1 − ζ.

**Prototype write rules** (built 2026-10-15 in the agents' / plugin shapes): CUSTOM_CUBIC_BEZIER's x1 and x2 clamped to [0, 1], y1 / y2 free; CUSTOM_SPRING mass [0, 1000], stiffness [0, 10000], damping [0, 1000], initial velocity written 0; an `easingFunction*` with another easing type is an error; on read a bezier needs exactly 4 values, a spring at least 3. Sites behaviours have their own easing table (Penner's CSS cubics) and must never share this one (Sites is set aside).

**`easingData` is the source of truth**; `interpolationType` / `bezierHandles` are written alongside (HOLD → HOLD, springs → SPRING, the rest → BEZIER with the curve's four numbers) and read only when `easingData` is absent (an older file).

**EASING variables**: `VariableAnyValue.easingValue` (`EasingData`); resolved per mode like any variable; a keyframe or a preset bound to one changes with the page's mode (Figma's "switching a page's mode updates every animation that references them"). **TIMING variables**: `floatValue` in **milliseconds** (help: "Duration in milliseconds"; the schema comment saying seconds is corrected), `timingDisplayUnit` on the VARIABLE for its display.

### 4.8 Interpolation per value type

- **FLOAT**: a + (b − a) e. Overshoot (back, springs) is not clamped, except OPACITY, PATH_TRIM_* and normalised effect fields (clamped to 0–1 when applied) and WIDTH / HEIGHT (≥ 0.01).
- **VECTOR**: per component; **TRANSLATION_XY** follows the **motion path**: between kᵢ and kᵢ₊₁ a cubic Bézier P₀ = vᵢ, P₁ = vᵢ + outᵢ, P₂ = vᵢ₊₁ + inᵢ₊₁, P₃ = vᵢ₊₁, where a keyframe's `motionPathBezierHandles {p1x, p1y}` = its in-handle and `{p2x, p2y}` = its out-handle, relative to its value [encoding unverified]; zero handles = a straight line. The eased progress e is applied **by arc length** (a 64-sample length table per segment, cached per keyframe pair), so the dots' spacing shows the easing as Figma's do.
- **COLOR**: in `interpolationColorSpace` of kᵢ₊₁: DEFAULT and the absent value = gamma-encoded sRGB per channel (Figma's code export interpolates in RGB, gotchas.md); SRGB_LINEAR; OKLAB; OKLCH and HSL with `interpolationHueMethod` (SHORTER default, LONGER, INCREASING, DECREASING); alpha linear, not premultiplied.
- **BOOL**, **TEXT_DATA**: the previous value until the next keyframe (a step).
- **CIRCLE, LINE, CIRCLE_POINT, COLOR_POINT** (shader properties): per component; COLOR_POINT's colour as COLOR.
- **PAINT / GRADIENT_PAINT** (only from `.fig` files; the UI animates SOLID colours): same type and stop count → stops' colours and positions, transform and opacity per component; otherwise a step at e = 0.5.
- **Transforms** are never interpolated as matrices: translation, rotation, scale and shear are separate tracks.
- **Paths**: vector geometry is not keyframable (not in Figma's public list); only path trim, arc data, polygon count and star inner scale.

### 4.9 Editing (commands), auto-keyframe and undo

**Motion view state** (not in the document; per editor): `{on, root, timeUs, autoKeyframe, showMotionPath}` set by `engine.setMotion(state)`. `root` null = the root containing the selection (or the first selected root).

**Write routing in Motion mode.** Every write that reaches the engine — `set_props` from the panels, a canvas gesture, a nudge — goes through `MotionLayer::route` when Motion is on:
- the root itself, and fields not in `KEYFRAME_FIELDS`, are written as in Design (base values);
- a keyframable field **with a track**: the keyframe at the playhead (± half a snapping frame) is updated, or one is created there with the new value and Figma's default keyframe easing, CUSTOM_CUBIC (0.5, 0, 0.5, 1) (§4.7); keyframes are upserted by integer µs position (§4.2);
- a keyframable field **without a track**, auto-keyframe **on**: a track is created with base = the current value, a keyframe at t = 0 with the current value (only when the playhead is past 0) and one at the playhead with the new value [unverified: Figma's first auto-key may make only one keyframe];
- without a track, auto-keyframe **off**: the base value changes (the static design), as in Design.
- **Gestures map to motion fields**: move → TRANSLATION_XY; the rotate handle → ROTATION; the resize handles → SCALE_XY (⇧ keeps the ratio; `linkMotionScaleAspectRatio`) [unverified: Figma may resize WIDTH / HEIGHT]; the panel's W / H → WIDTH / HEIGHT. Without a track and with auto-keyframe off they edit x / y / rotation / size as in Design.
- **Position in Motion mode** is the anchor point's (help): the panel's X / Y show `anchorWorld = M_motion(o)` in the parent's coordinates; typing X writes TRANSLATION_X = X − (the anchor at rest); rotation shows base + motion rotation; Scale (%) X / Y with the link toggle shows the motion scale.

**Commands** (`CommandId` 330–349; args `MotionCommandArgs` in §10; each one undo step with its name) [names unverified]:

| Id | Name | Undo name |
|---|---|---|
| 330 | `MOTION_ADD_KEYFRAME` — node(s), field, at the playhead, the current (evaluated) value | "Add keyframe" |
| 331 | `MOTION_SET_KEYFRAMES` — time / value / easing of keyframes by id (a drag is one gesture: `txn_begin` … `txn_commit`) | "Move keyframes" / "Edit keyframe" |
| 332 | `MOTION_DELETE_KEYFRAMES` — by id; a track left empty is removed with its binding | "Delete keyframes" |
| 333 | `MOTION_DELETE_TRACKS` — node, fields | "Delete animation" |
| 334 | `MOTION_SET_EASING` — keyframes or preset instances, an easing (or an EASING variable) | "Change easing" |
| 335 | `MOTION_SET_TIMELINE` — root: duration, playback style, snapping fps | "Change duration" / "Change playback" |
| 336 | `MOTION_ADD_ANIMATION` — nodes, preset type, props, at the playhead | "Add animation" |
| 337 | `MOTION_SET_ANIMATION` — instance: type, props, offset, duration, disabled | "Edit animation" |
| 338 | `MOTION_REMOVE_ANIMATIONS` — instances | "Remove animation" |
| 339 | `MOTION_APPLY_STYLE` — nodes, composite style | "Apply animation style" |
| 340 | `MOTION_RETIME_LAYER` — node: move all its keyframes and clips by Δ, or scale them about the bar's other end (the layer bar's handles) | "Move animation" / "Change animation duration" |
| 341 | `MOTION_SET_INSTANCE_OFFSET` — instance, offset | "Move animation" |
| 342 | `MOTION_SET_ANCHOR` — nodes, anchor (x, y as % of the size) | "Move anchor point" |
| 343 | `MOTION_SET_PATH_HANDLES` — keyframe, in / out handles | "Edit motion path" |
| 344 | `MOTION_SET_TEXT_STAGGER` — text node, behaviour | "Edit text animation" |
| 345 | `MOTION_ADD_AUDIO` — root, media hash, name, offset, length | "Add audio" |
| 346 | `MOTION_SET_AUDIO` — clip: offset, trim, volume, mute, track | "Edit audio" |
| 347 | `MOTION_SPLIT_AUDIO` — clip at the playhead (⌥K) | "Split audio" |
| 348 | `MOTION_REMOVE_AUDIO` — clips | "Delete audio" |
| 349 | `MOTION_PASTE_KEYFRAMES` — keyframes copied from the timeline (§6.2), at the playhead, onto the selected layers' same fields | "Paste keyframes" |
| 350 | `MOTION_COMBINE_TRACKS` — node, position or scale: X / Y tracks → one XY track (keyframe times merged; Figma's `switchVectorKeyframesToCombined`) | "Combine tracks" |
| 351 | `MOTION_SPLIT_TRACKS` — node, position or scale: an XY track → X and Y (Figma's `switchVectorKeyframesToSplit`) | "Split tracks" |
| 352 | `MOTION_SET_PRESET_TRACKS` — preset instance: the tracks its code returned, materialised (§4.6) | (inside the applying step) |

Snapping: dragged keyframes and clips snap to frames of the timeline's `keyframeSnappingFps`; ⇧ while dragging snaps to the playhead and to other keyframes (verified).

The **anchor point** tool: `TOOLS` gains `"ANCHOR_POINT"` (⌥R in Motion, toggles; Draw's ⌥R rotation origin stays in Draw / Design). The target is drawn at the anchor; dragging it writes `transformOrigin` and compensates TRANSLATION so the layer does not jump [unverified: Figma may let it jump]; snaps to the box's 9 points and centre.

**Motion path editing** (Motion on, one layer with TRANSLATION_XY or X / Y tracks selected): the path is drawn (§6.4); dragging a square writes that keyframe's value; ⌘-drag from a square pulls its handles (symmetric; ⌥ breaks the symmetry [unverified]). Separate X and Y tracks show a path whose squares are the union of their times; dragging one writes both tracks at that time (a node has either the XY track or the X / Y pair, never both, §4.5).

### 4.10 Text animation

Corrected 2026-10-15 (Figma's TextStagger preset and CSS codegen, `docs/research/rea/motion.md` §2.19): `textElementDelayBehaviour 610 {enabled 1, grouping 2, delayMs 3 (≥ 0), order 4, clipContent 5, transformOriginMode 6 (MATCH / CHARACTER / WORD / LINE / PARAGRAPH), transformOrigin 7 (default {0, 0})}`, written by the **TextStagger** preset. Its props: animationDirection in | out; textDelayGrouping CHARACTER | CHARACTER_NO_WHITESPACE | WORD | LINE | PARAGRAPH (default CHARACTER); **presetStaggerOverlap 50 %** (0–100) instead of a fixed stagger in ms; textDelayOrder LEFT_RIGHT | RIGHT_LEFT | CENTER_OUT | RANDOM; clipContent false; elementTransformOriginMode MATCH; origin 50 % / 50 %; sub-animations position (on; direction top, distance 40), rotation (off; 180°), scale (off; 120 %), opacity (off; 0 %), **blur** (off; 20 px — the preset's one LAYER_BLUR). The derived timing (startUs, groupDurationUs, staggerStepMs) is computed in C++; step = f(overlap, duration, count) is open (probe 5.12). CSS export: `animation-delay: calc(start + var(--stagger-index) * step)`. Elements are transformed about their origin mode's box and clipped when `clipContent`.

The behaviour on a TEXT node turns its OPACITY, MOTION_* and preset tracks into **per-element** animations: the text's laid-out glyphs are grouped (CHARACTER; CHARACTER_NO_WHITESPACE skips spaces in the count; WORD; LINE; PARAGRAPH), element i in `order` (LEFT_RIGHT, RIGHT_LEFT, CENTER_OUT by distance from the middle element, RANDOM by a hash of the node's GUID and i) evaluates the tracks at τ − i × delayMs; each element is drawn with its own motion transform about its own box's centre and its own opacity. The text node's own box is not transformed by those tracks. The renderer draws such a text glyph-run by glyph-run (`Glyph.rotation` already exists) with per-run transforms and alpha. TEXT_ELEMENT_DELAY (76) can animate delayMs.

### 4.11 Audio

`audioFills` on the root: `AudioFill {id, mediaHash (SHA-1 of the file in the file's image store, as videos), timelineOffsetUs, startTimeUs (trim into the file), durationUs (the region's length), volume 0–1, mute, displayName, loopEnabled, playbackDurationUs, trackId, loopPhaseOffsetUs}`; `audioTracks {id, name, gain, mute}` are the rows (one row per dropped file by default). The engine stores and edits them (commands 345–348); TypeScript plays and mixes them (§6.6, §7.4). The prototype player does not play audio in this round [Figma unverified].

### 4.12 Prototype player

`engine/src/proto/Player` gains timelines:
- When a screen or an overlay is shown, each timeline root among it and its contents starts its clock at 0 when its transition ends (Smart animate's destination snapshot is taken with the evaluator at t = 0, so nothing jumps) [unverified]. Roots with `autoplay` false wait for an action.
- `tick(nowMs)` advances every running clock; the evaluated values are written to the player's own engine by the motion layer (§5) before the scene is built, so Smart animate, scrolling, hit-testing and overlays see them. `animating()` is true while any timeline runs (LOOP / BOOMERANG run until the screen leaves).
- Instances in a shown screen play their main's timeline with their offsets.
- `ConnectionType UPDATE_ANIMATION_TIMELINE_STATE` actions (from `.fig` files): PLAY / PAUSE / TOGGLE_PLAY_PAUSE / SET_PLAYHEAD (`animationSkipToTime` seconds) on `animationTimelineDefId`'s root. Figma's plugin reactions reader returns `null` for such an action; ours does the same.
- Smart animate stays the player's snapshot interpolation (Figma's legacy path, `useLegacySmartAnimate`); Figma's viewer now generates keyframe track groups "just in time" (`computeSmartAnimateTrackGroups`, unmatched layers through `DISSOLVE_PROGRESS 56`, Scroll to on SCROLL_OFFSET_X / Y). Re-expressing it as generated tracks, then transition overrides (`transitionOverrides 526`), come after the evaluator (`docs/research/rea/motion.md` §2.23, §2.24). The Prototype panel shows such an action read-only as "Control animation" [Figma's UI has no such action yet, per the forum; wording ours].
- Restart and navigation Back restart the screen's clocks.
- `prefers-reduced-motion` is not applied (Figma's prototype setting `ignoreReducedMotion` is not adopted).

### 4.13 Rendering, hit-testing and other derived users

- The **canvas in Motion mode** draws the focused root with the motion layer applied; other roots show their base values [unverified: Figma may show every root at the playhead].
- **Hit-testing and selection chrome** in Motion mode use the evaluated geometry (`motionWorld`), so you click and see the layer where it is at the playhead.
- **Frame titles**: a top-level frame with a timeline gets the **Motion icon** before its title (verified: "marked with the Motion icon"), drawn by `render/FrameTitles` (`16.motion`, §10).
- **Path trim** (`pathTrim`, animated or static): the stroke is drawn over the arc-length interval [start, end] of each sub-path (start > end wraps for closed paths); only CENTER strokes (verified); exports draw it too (SVG: `pathLength="1"` + dasharray).
- The **motion transform** applies to render, hit, bounds (render bounds include the motion transform) and the animated exports; static exports ignore it (base).

### 4.14 Performance budgets (M3, 16 GB; release wasm)

- Evaluation: ≤ 0.5 ms for 200 animated properties per frame (keyframe search by binary search, cached spring settle times and arc-length tables).
- A Motion-mode frame (restore + apply + pipeline + render) of a 1440 × 900 root with ≤ 50 animated layers: ≤ 8 ms (60 fps with headroom); layout-changing fields: ≤ 12 ms.
- Scrubbing: one evaluation per pointer event, coalesced to one per animation frame.
- Export: 1080p frames rendered + encoded (H.264, hardware) ≥ 30 frames / s; GIF ≥ 10 frames / s at 480 px; frames stream to the encoder (at most 4 queued, `encodeQueueSize`), never all in memory.
- Native bench (`native-bench`): `motion.eval` (1 000 tracks × 10 keyframes) and `motion.frame` (50 layers) — numbers recorded in `docs/engine-build.md`.
- The editor, playing: no React render per frame except the playhead and the current-time field (a ref-driven transform, not state).

## 5. The motion layer (`engine/src/motion/MotionLayer.*`)

The evaluated values are **preview writes** into the live node props, held by the motion layer, never by a transaction:

1. **`apply(root, T)`** (on `setMotion`, on every time change, after every commit while active): for every animated (node, field) under the root — real and derived (instance sublayers) — remember the base value once (`restoreList`), write the evaluated value, mark the node dirty with the field's dirty mask, then run pipeline stages 1–8 (`engine.md` §3.3) for those nodes. Motion values are applied **after** stage 3 (bindings), so a variable-bound base value is resolved first and the preview wins; MOTION_* fields write `NodeTable.motionWorld` only.
2. **`restore()`**: writes every remembered base value back and marks the nodes dirty. Called:
   - before **any** transaction begins (`Txn` begin hook — every kind: User, Gesture, Undo, Redo, System, Remote, Load, an actor's step), so commands, gestures, undo, remote and agent writes always read and write base values; after the commit the layer applies again;
   - before reading the document for storage or export: `engine_encode*` / snapshots, clipboard copy, `exportNodes` (static), the REST / plugin reads of base values (`MotionLayer::Suspend` RAII, nestable);
   - when Motion mode ends.
3. **No events**: preview writes emit no `DOCUMENT_CHANGED` and no `NODES_CHANGED`. One `MOTION_CHANGED {root}` event is emitted when the root's motion model changes (a commit touching a motion node, a binding, the root's timeline, audio, or the selection's root) so the timeline refetches; panels in Motion mode re-read values on the editor's own frame tick (throttled to 10 Hz while playing, every change while scrubbing).
4. **Derived nodes**: instance sublayers get preview writes too; the materializer (stage 2) rebuilding them drops the writes, and `apply` writes again in the same flush.
5. **The player** uses the same layer on its own engine, with one clock per running root.
6. **Exports at time t** (§7) call `apply(root, t)` inside an export scope, render, then `restore()`.

### 5.1 As built — round 8a, increment 1 (2026-10-17, branch `claude/social-media-ui-video-g30phd`; for 8b)

`engine/src/motion/` (native tests `engine/tests/unit/r8.motion.test.cpp`, 6 cases; `npm run engine:test`):
- **`Fields.h/.cpp`** — the §4.5 table as `FieldInfo` rows (`fieldInfo(VariableField)`, `fieldByPublicName`), `storedToNode` / `nodeToStored` (OPACITY ×100, MOTION_ROTATION −radians), `clampWrite`, `isMotionTransformField`, `writeNodeFloat` / `readNodeFloat` (node units; PATH_TRIM_* and the grid gaps write `extra`). The engine's `VariableField` enum and names now carry 43–76, `ExpressionFunction::KEYFRAME = 19`.
- **`Model.h/.cpp`** — the decoded model: `Keyframe` (µs, `KeyframeValue` in stored units, `EasingSpec`, colour space / hue method, path handles), `Track` (operation, loop, keyframes sorted and unique by µs), `Param` (MANUAL / ANIMATION_PRESET / STYLE), `Slot` (a node field, a fill's / stroke's colour or opacity, an effect's radius / colour / spread / offset), `Binding` (base argument + params), `Timeline` (the root's own fields; defaults 2 s, LOOP, 60/1), `LayerBase` (motionTransform, transformOrigin, link). `MotionIndex::rebuild(doc)` reads KEYFRAME_TRACK / KEYFRAME nodes and the KEYFRAME expressions (`parameterConsumptionMap`, `Paint.colorVar` / `opacityVar`, `Effect.*Var`) from `NodeProps::extra` through the kiwi → JSON helpers (`codec::extraValueToJson`; `decodeParams` reads the OTHER-kind second argument through `extraToJsonMembers("VariableData")`); `rootOf`, `timeline`, `animatedUnder` (real nodes only).
- **`Evaluate.h/.cpp`** — `easeKeyframe` (absent / IN_CUBIC → CUSTOM_CUBIC (0.5, 0, 0.5, 1); HOLD; the presets; springs normalised by `springNormalized`), `lerpColor` (DEFAULT sRGB, SRGB_LINEAR, OKLAB, OKLCH and HSL with the four hue methods; alpha linear), `motionPathPoint` (cubic from the handles, eased progress by arc length over 64 samples), `interpolate`, `trackValue` (hold before / after, binary search, HOLD, loop), `localTime` (ONCE / LOOP / BOOMERANG), `foldValue` (SET / OFFSET / SCALE in list order over the base).
- **`Easing.h/.cpp`** gains `bezierAt`, `springNormalized`, `bounceOf`, `springFromBounce`, `hold`.
- **`MotionLayer.h/.cpp`** — `State {on, root, timeUs, autoKeyframe, showMotionPath}`; `MotionLayer::apply(doc, index, root, timeUs, resolve)` remembers each animated node's base `NodeProps` once and writes the evaluated values with `Document::apply` (no transaction, no journal, no `DOCUMENT_CHANGED`; the render tree catches up through the document's change log); `restore(doc)` puts the base back bit-identically; `Suspend` (RAII) for storage, exports and the clipboard. **Deviation from §4.5 / §5 (kept):** a MOTION_* field composes `M · T(o) · T(t) · R(−r) · Shear · S · T(−o)` into the node's `transform` as a preview write instead of a separate `motionWorld` — render, hit-testing and bounds all follow the transform, and the base is in the restore list; layout never runs on preview writes, so siblings never move. Layout-changing fields (WIDTH, paddings…) are written but the children are **not re-laid out yet**.
- **`Editor`** (`editor/Editor.h/.cpp`): `setMotion(State)` / `setMotionJson(json)` / `motion()`, `motionRoot()` (the state's root, else the selection's), `motionIndex()` (rebuilt lazily after a commit), `motionLayer()`, `motionSuspended()`; `begin()` restores the layer before any transaction (every kind), `commit()` marks the index dirty and applies again while on, `loadDocument` resets, `changeSelection` re-applies when the root follows the selection; `Events::motion` → **`MOTION_CHANGED {root}`** (on a change of root or on / off). The variables resolver reads a KEYFRAME expression as its first argument (`Variables.cpp resolveData`), so Design mode and static reads show the base. `CodecJson.cpp` keeps a KEYFRAME expression's parameter argument (OTHER kind) instead of folding the whole expression into OTHER.
- **ABI** (`api/MotionApi.inc`, `api/exports.txt`): `engine_set_motion(h, json)`; `engine_encode_document` and `engine_encode_selection` run under the suspend.

### 5.2 As built — round 8b, increment 1 (2026-10-17; `engine/src/editor/MotionCommands.cpp`, tests `r8.motion_edit.test.cpp`, 4 cases)

- **Commands** (`Editor::motionCommand`, ids 330–335, 340, 342, 343; the rest answer `E_UNSUPPORTED` until their increment): `MOTION_ADD_KEYFRAME` (the slot's manual track made when there is none — a KEYFRAME_TRACK on the Internal Only Canvas named by the field key, bound by a KEYFRAME expression whose base is the slot's literal, or its existing alias / expression kept as the base argument; the keyframe upserted by integer µs at the playhead or `timeUs`, with the given value in public units or the slot's current value — the folded tracks over the base), `MOTION_SET_KEYFRAMES` (time with Figma's upsert — a keyframe already at the new position goes —, value, easing, path handles), `MOTION_DELETE_KEYFRAMES` (an emptied track goes with its parameter; the last parameter gone, the base argument is the slot's binding again — an alias stays bound, a literal lives in the field), `MOTION_DELETE_TRACKS`, `MOTION_SET_EASING` (keyframes and preset instances; `interpolationType` mirrored), `MOTION_SET_TIMELINE` (duration, playback ONCE / LOOP / PING_PONG → BOOMERANG, snapping fps with 29.97 / 23.976 as 30000/1001 and 24000/1001), `MOTION_RETIME_LAYER` (Δ or a scale about a pivot over the node's manual tracks), `MOTION_SET_ANCHOR` (PERCENT; no keep-in-place compensation yet), `MOTION_SET_PATH_HANDLES`. Each is one undo step with §4.9's name; `created` carries the keyframe ids.
- **Public shapes** (`src/shared/motion/types.ts`): `KeyframeField` ↔ `motion::Slot` (`slotFromPublic`, `writePublicField`), `KeyframeValue` in public units ↔ stored (`toStored` / `toPublic` through Fields.h), `MotionEasing` ↔ `EasingData` (`easingFromPublic`: a bounce becomes a physical spring with `springFromBounce`, `springType NORMALIZED`; `writePublicEasing`: an absent / IN_CUBIC easing reads as the default CUSTOM_CUBIC (0.5, 0, 0.5, 1)). A keyframe's easing or value bound to a variable is not taken yet.
- **Routing** (`Editor::motionRouteWrite`, from `setProps`): with Motion on, a panel write of OPACITY, STROKE_WEIGHT, the paddings and gaps, WIDTH / HEIGHT or a uniform CORNER_RADIUS on a layer under the root becomes a keyframe at the playhead when the field has a track, or when auto-keyframe is on (the first auto-keyframe also writes the old value at t = 0 when the playhead is past 0); the base stays. Gestures (a move → TRANSLATION_XY, rotate, resize) are not routed yet.
- **Ownership**: `deleteSelection` removes the tracks only the deleted layers bind (`motionTracksOwnedBy`, `motionRemoveTrack`); duplicate / paste / detach don't deep-copy tracks yet.
- **Reads** (`writeMotionTimeline` / `engine_motion_timeline(ref)`, `writeMotionFieldStates` / `engine_motion_field_states(refs)`, `writeMotionResolved` / `engine_motion_resolved(ref)`): `TimelineModel` (layers top first with depth, manual tracks with their keyframes in public units, `icon` = the node type's name for the TS side to map, `clips` / `audio` empty), `FieldStates` (a keyframe within half a snapping frame of the playhead → `"keyframe"`, else `"track"`), `ResolvedMotion` (manual tracks in root time; instance offsets later). `Engine.ts`: `setMotion`, `motionTimeline`, `motionFieldStates`, `motionResolved` are real; `motionRenderFrame` / `motionShapes` still throw.

**Not in increment 1** (next): instance sublayers and `timelineAssignments` offsets (§4.3), re-layout for layout fields (§4.5), path trim rendering (§4.13), text stagger (§4.10), audio (§4.11), the player's timelines (§4.12), the motion path / anchor overlays (§6.4), the Motion icon in frame titles, exports at t (§7.2), `MotionResolved` / `motionShapes` reads (8b's API), the EASING-variable binding of a keyframe (`EASING_DATA` / `KEYFRAME_VALUE` on the KEYFRAME node), effect fields beyond radius / colour / spread / offset, the native bench cases.

## 6. The chrome (Motion mode)

All metrics are [unverified] until a signed-in capture (§12.1); colours and sizes come from DS tokens (`--figma-color-*`, `ds/tokens`), nothing hard-coded. Figma's wording as quoted in §1.

### 6.1 Mode

- The toolbar's **Motion** segment is enabled (`EditorToolbar` `EDITOR_MODES`); hovering it shows the "Motion Beta" tag above the switch (live capture: 90 × 24, `#1e1e1e`, radius 5, "Motion" 11/450 + "Beta"). `ui.mode = "motion"`; View › **Switch to Motion** (no shortcut [unverified]).
- Motion keeps Design's tools; components can't be created ("Create component" disabled in Motion, verified), and component properties are read-only in Motion (verified).
- Entering Motion: `engine.setMotion({on: true, root: null, timeUs: 0, autoKeyframe: false})`, the timeline opens; leaving: `on: false` (the canvas shows base values).
- Viewers (can view) don't see Motion (verified: "make sure you have can edit access").

### 6.2 Timeline panel (`editor/motion/timeline/`)

At the bottom of the canvas, full width between the left and right panels; default height 240 px [unverified], drag the top edge (min 120, max 60 % of the window), **Collapse timeline** (a header button) leaves the header only. The canvas viewport insets follow its height (`canvas/viewInsets.ts`).

**Header (left to right)**: **Play / Pause** (Space), **Toggle auto-keyframe** (red when on: a red bar across the top of the timeline and on the playhead; a record glyph), **Current time** (a number field: typed in the time unit, Enter jumps), " / ", **Duration** (a number field), **Timeline settings** (a popover, corrected 2026-10-15 from Figma's timeline settings module, `docs/research/rea/motion.md` §2.16): units **ms** or **frames**; the snapping grid as a `FrameRate {numerator, denominator}` — in ms mode the presets 10/1, 20/1 and 100/1 fps (shown as 100 ms, 50 ms, 10 ms) and "Off", in frames mode 60 (default), 30, 30000/1001, 24, 24000/1001 and 12; a typed ms value becomes fps = 1000 / ms clamped 1–1000, a typed frame rate is rounded and clamped 1–120; loop control **Once / Loop / Ping pong** (BOOMERANG), Ping pong disabled when the timeline has audio; time display formats %, ms, s, timecode_ms, timecode_frames. **Playback** (a button cycling Loop → Once → Ping pong; icons `24.loop`, `24.play-once`, `24.ping-pong`), **Collapse layers**, then on the right the **zoom slider** and **Collapse timeline**.

**Body**: a layer column (left, 240 px, resizable) and the track area (right) under a **time ruler** (labels every 100 / 250 / 500 / 1000 ms depending on zoom; frame ticks when zoomed in).
- **Rows**: one **layer track** per animated layer of the root, in the Layers panel's order (top first), named and iconed as in Layers; expanded, its **property rows** (one per track: "Opacity", "Position", "Rotation", "Scale", "Width"…, "Fill 1", "Drop shadow · Blur"…; names [unverified]) and its **animation clips** (presets). Animated **instances** show as one purple track (`--figma-color-bg-component` family), collapsed, draggable only. **Audio** rows at the bottom (the waveform, the clip's name). A layer's eye toggles nothing in Motion except audio rows (mute).
- **Layer bar**: on the layer track, from its first to its last keyframe / clip; drag to move all (`MOTION_RETIME_LAYER` Δ), drag its side handles to scale all about the other end.
- **Keyframes**: diamonds (blue outline / blue filled when selected; Hold keyframes square-ish [unverified]; Figma's timeline worker draws 16 × 16 diamonds, interpolation lines inset 8 px from each diamond, the origin at x = 18 px, Inter 9 / 11 px labels); click selects, ⇧-click adds, marquee in the track area selects, selecting a layer row selects all its keyframes; double-click moves the playhead to it and selects the layer; drag moves (snapping §4.9); Delete deletes; ⌘C / ⌘V copy and paste keyframes at the playhead (ours; Figma's not documented); Delete on a selected property row deletes its track.
- **Segments**: the line between two keyframes of a row; hover highlights; click opens the **Easing menu** (§6.3) for the segment's end keyframe.
- **Clips** (presets): a bar with the type's name; drag moves (offset), side handles change the duration; click selects (and selects it in the right panel's Animations section); Delete removes.
- **Playhead**: a vertical line with a handle in the ruler; drag or click in the ruler scrubs; ← / → step one frame (at the snapping fps), ⇧← / ⇧→ ten frames, Home / End go to 0 / the duration [shortcuts unverified].
- **Duration handle** at the end of the timeline; past it dimmed.
- **Zoom**: the slider, pinch, ⌘ / Ctrl + wheel (verified); plain wheel scrolls rows, ⇧ + wheel scrolls time.
- **Read-only mode** (Dev Mode, §8): the same component with `readOnly`: playhead, play and zoom only.

**Playback clock** (`editor/motion/clock.ts`): `requestAnimationFrame`; t advances by wall time × 1; at the duration: ONCE stops, LOOP wraps, Ping-pong reverses; each frame `engine.setMotion({timeUs})`; with audio clips the AudioContext's `currentTime` is the master clock (§6.6). Pausing keeps the playhead.

### 6.3 Easing menu and editor (`editor/motion/easing/`)

A popover anchored to the clicked segment, clip or panel field:
- **Easing** dropdown (corrected 2026-10-15, Figma's easing menu modules): **Hold first**, then the bezier presets and the springs, **no dividers**; when the current easing is a spring the list shows only the springs, otherwise Hold plus the non-spring ones. A **Bezier | Spring** segmented control switches to CUSTOM_CUBIC or CUSTOM_SPRING. When the type changes, custom values are kept only if the new type is the matching custom type; otherwise the preset's values load. Labels: Figma's `proto.easing_behavior.*` set (bezier_ease_in / _out / _in_and_out, linear, the back variants, bezier_custom, spring_gentle / _quick / _bouncy / _slow / _custom, hold). Each item has a small curve preview.
- **One editor for prototypes and Motion**: `editor/motion/easing/EasingEditor` with a `context: "prototype" | "motion"` prop — Hold and Bounce only in Motion; mass / stiffness / damping and the spring's 6 / (ζω₀) Duration (§4.7) in prototypes. It replaces the Prototype panel's numeric fields (`panels/prototype/InteractionDetails.tsx`).
- **Custom bezier**: a 200 × 200 curve editor (handles draggable, x clamped to [0, 1], y may go outside 0–1 to −0.5…1.5), the corner points reset (verified), a text field "x1, y1, x2, y2" (Figma: "enter a cubic-bezier value directly into the field").
- **Custom spring**: the spring editor (a response curve; its handle at x = π / ω₀, y = 2 − 2·clamp(ζ, 0, 1)^0.87, §4.7) and the **Bounce** field (0–1, verified).
- A preview dot running the curve on hover [ours].
- The **variable** button binds an EASING variable (the variables picker filtered to Easing); "Create variable" saves the custom curve as one (verified: "can be saved as variables").
- Shared by the timeline, the Animations section and the variables' Easing value editor. The component's props are fixed in §10 (`EasingEditorProps`), so 8c and 8d build against them.

### 6.4 Canvas in Motion mode

- The focused root is drawn at the playhead; other frames at rest.
- **Motion path** of a selected layer with position keyframes: dots at every frame of the path (spacing = easing, verified: "a sequence of dots"), squares at keyframes (verified), handles when ⌘ is held or a square's handles are non-zero; drawn by the engine's overlay (`render/Overlay`, `OverlayStyle::motionPath*`).
- **Auto-keyframe handle**: with auto-keyframe on, a small red handle at the selection's anchor [form unverified]; dragging it moves the layer (TRANSLATION keys).
- **Anchor point** target (⌥R or Edit anchor point): a crosshair circle at the anchor, draggable.
- Selection boxes follow the evaluated geometry.

### 6.5 Right panel in Motion mode (`editor/motion/panels/` + small edits)

- **Diamonds**: every keyframable field in Transform (X, Y, Rotation, W, H, Scale), Appearance (Opacity, Corner radius and corners), Layout (gap, paddings), Fill (each SOLID paint's colour, opacity; shader properties), Stroke (weight, Path trim start / end), Effects (the effect fields) shows a diamond before its label: empty when the field has no track, an outline when it has one, filled when a keyframe sits at the playhead; clicking it toggles "Add keyframe" / removes the keyframe at the playhead (verified: "Add keyframe next to the property"). The fields show the evaluated value at the playhead; editing writes through routing (§4.9).
- **Transform section** (Motion only): Position X / Y (from the anchor), Rotation, Scale X / Y % with the link toggle, **Edit anchor point** (⌥R).
- **Stroke**: **Path trim start** / **Path trim end** (0–100 %, verified) for vector-like layers with a center stroke (shown in Design too, as static fields).
- **Animations** section (verified name): a **+** menu of the types (Figma's catalogue, §4.6: New, Opacity, Position, Scale, Rotation, Size, Corner Radius, Path, Text, Text stagger; Path needs strokes, the text ones only for text layers), the **Animations** button opening the composite styles list (hover previews on the canvas, verified for Text enter / exit), and one row per preset instance of the selected layer (its type, eye, remove); clicking a row expands its settings (Type, its props, Delay, Duration, Easing with the easing menu; Delay and Duration bindable to TIMING variables, Easing to EASING).
- **Audio** section (verified name) for a selected audio clip: Volume slider, Mute.
- **Text** layers: the Text animation's settings include **Text stagger settings** (Grouping, Direction, Stagger).
- Hidden in Motion: the Prototype tab [unverified], component property editing (read-only).

### 6.6 Audio (`editor/motion/audio/`)

- Import: drop an audio file (AAC, MPA, MP3, WAV, verified; `.aac .m4a .mpa .mp2 .mp3 .wav`) onto a frame or the timeline; the file goes to the file's image store by SHA-1 (as videos, `editor/images.ts` gains `isAudioFile`, max 100 MB [ours]); decoded once by `AudioContext.decodeAudioData` for the waveform (peaks cached per hash) and playback. MPA (MPEG-1 layer 2) may not decode in Chromium: such a file shows "Couldn't add audio" [unverified].
- Playback in Motion: an `AudioBufferSourceNode` per clip region scheduled against the clock, a `GainNode` per clip (volume, mute) and per track (gain, mute); scrubbing plays nothing [unverified].
- ⌥K **Split audio at playhead**, right-click › **Mute audio**, Delete removes the selected region (verified).

### 6.7 Variables (`editor/panels/variables/`)

The Create variable menu gains **Easing** and **Timing** (types `EASING`, `TIMING`); value cells: Easing shows the curve's name and opens the easing editor; Timing a number in ms or s (`timingDisplayUnit`). Scopes: none for these two [unverified]. Binding: Delay / Duration ← TIMING; easing ← EASING (§6.3).

### 6.8 Comments with a time

A comment placed in Motion mode records the playhead: `CommentAnchor.timeMs` (§10); its pin shows only while the playhead is within ±250 ms of it [unverified] and the thread shows the time ("0:01.250"); clicking the time jumps the playhead. Server: migration **0017_comment_time.sql** (`ALTER TABLE comments ADD COLUMN time_ms INTEGER`), `server/src/comments.ts` reads / writes it, the local store too.

### 6.9 Commands and menus

`view.switch-to-motion`; in Motion: `motion.play-pause` (Space), `motion.toggle-auto-keyframe` [no Figma shortcut known], `motion.add-keyframe`, `motion.anchor-point` (⌥R), `motion.split-audio` (⌥K), `motion.next-frame` / `prev-frame`. Canvas menu in Motion: Add keyframe ▸ (fields), Remove animation, Mute audio on audio. Design's canvas menu item **Add motion** (Figma's, listed and disabled today, `docs/editor.md` 642) switches to Motion with the layer selected.

### 6.10 As built — round 8c / 8d, increment 1 (2026-10-17; `src/renderer/src/editor/motion/`, tests `motion/__tests__/` — 15 cases on fixed models, since the committed wasm predates Motion)

- **Mode** (`devmode/devMode.ts`, `uiStore.ts`, `commands.ts`, `menus.ts`, `canvas/BottomToolbar.tsx`): `ui.mode = "motion"` with `ui.motion` (`MotionUIState`: playhead µs, playing, auto-keyframe, collapsed, selected keyframes, unit); the toolbar's Motion segment and View › **Switch to Motion** toggle it (the Beta tag is not drawn yet); `syncEngine` pushes `setMotion({on, root: null, timeUs, autoKeyframe})` on every mode change (guarded: a wasm without the Motion exports leaves the chrome on its own state); leaving Motion stops the clock. Commands `motion.play-pause` (Space, Motion only), `motion.toggle-auto-keyframe`, `motion.collapse-timeline`.
- **Shell** (`MotionMode.tsx`): mounted by `EditorApp` after the shortcuts panel; `<section data-motion-timeline="open" | "collapsed">` docked along the bottom — `EditorApp.module.css` lifts the panels and the toolbar by `--ds-size-motion-timeline` (240) / `--ds-size-motion-timeline-header` (40), as the shortcuts panel does. The model is `engine.motionTimeline()` re-read on `MOTION_CHANGED`, the store's `selection` / `structure` / `undo` topics; the clock (`clock.ts`: rAF, wall time × 1, ONCE stops, LOOP wraps, Ping-pong reverses, pause keeps the playhead) drives `setPlayhead`, which pushes `setMotion({timeUs})` each frame. A keyframe drag and the duration handle run inside `txnBegin` / `txnCommit` (one undo step).
- **Timeline** (`timeline/Timeline.tsx`, a pure view of `TimelineModel` with callbacks; `timeline/maths.ts`: the 18 px origin, `fitScale`, the ruler's 10 ms … 10 s label steps at ≥ 56 px, frame snapping at the timeline's fps, ⇧-snapping to the playhead and the other keyframes within 8 px, `formatTime` / `parseTime` in ms, s and frames, `layerExtent`): the header (Play / Pause, Toggle auto-keyframe — red, with the red bar over the timeline and a red playhead —, Current time / Duration fields, Playback cycling Loop → Once → Ping-pong with `24.loop` / `24.play-once` / `24.ping-pong`, Collapse layers, the root's name, the zoom slider, Collapse timeline); the layer column (the Layers glyph and name, a chevron, the property rows under it; an animated instance one purple bar); the track area (the ruler scrubs; the layer bar; 16 × 16 diamonds — click selects, ⇧ adds, double-click moves the playhead and selects the layer, a layer row selects all its keyframes, a property row its own; drag moves the selection together, snapped, `MOTION_SET_KEYFRAMES`; Delete → `MOTION_DELETE_KEYFRAMES`, or `MOTION_DELETE_TRACKS` for a selected property row; the segment between two diamonds, dashed for Hold, opens the Easing menu for its end keyframe → `MOTION_SET_EASING`; the playhead; the duration handle → `MOTION_SET_TIMELINE`; past the duration dimmed; ← / → a frame, ⇧ ten, Home / End, Space; ⌘ / Ctrl + wheel zooms). Dark in both themes (`data-theme="dark"`, like the shortcuts panel) [unverified].
- **Easing** (`easing/EasingEditor.tsx`): a `Popover` with the Bezier | Spring switch and Figma's list — Hold first, then the curves, no dividers; springs only while the current easing is a spring — each row with a curve preview; Custom bezier takes "x1, y1, x2, y2" in a field, Custom spring its Bounce. `EasingMenu` is the same popover in this increment.
- **Right panel** (`panels/MotionSection.tsx`, `panels/KeyframeDiamond.tsx`; `DesignPanel` shows it first in Motion mode): a **Motion** section with Opacity, Corner radius, Stroke weight, Width, Height, Position, Rotation, Scale, each with its diamond from `motionFieldStates` (none / a track / a keyframe at the playhead; a mixed selection: a keyframe when every node has one, a track when any has one) and the field's current value; the diamond runs `MOTION_ADD_KEYFRAME` at the playhead or `MOTION_DELETE_KEYFRAMES`.

**Not in increment 1** (next, in §6's order): the Motion Beta tag; the timeline settings popover (units, grids), the top-edge resize, marquee selection, ⌘C / ⌘V of keyframes, the layer bar's drag and scale handles, clips (presets) and audio rows, the read-only mode for Dev Mode; the 200 × 200 bezier editor, the spring curve, the hover preview, the EASING variable binding, the prototype context; the diamonds beside Design's own fields (fills, strokes, effects, layout), the Transform section with the anchor point, Path trim, Animations, Audio; the canvas overlays (§6.4); comments with a time (§6.8); the rest of §6.9's commands and the canvas menu.

## 7. Export

### 7.1 The Animated tab (`panels/design/Export.tsx`)

The Export section gains tabs **Static** (today's) and **Animated** (verified), Animated enabled when the selection is one or more top-level frames with a timeline (others: the tab says "Select a top-level frame to export animations" [wording ours]). Settings:
- **Format**: MP4, WebM, GIF, SVG, Lottie, dotLottie (verified list). Default MP4 [unverified].
- **Size**: 0.5x, 1x (default), 2x, 3x, 4x, and custom "W × H" [preset list unverified]; MP4 / WebM dimensions are rounded up to even numbers; capped at 4096 × 4096 (H.264 level 5.2).
- **Frame rate**: 24, 25, 30 (default), 50, 60 fps [list unverified].
- **Quality** (MP4, WebM): Low, Medium, High (default) → bitrate 0.05 / 0.1 / 0.2 bits per pixel per frame [ours].
- **Loop** (GIF): on (default) / off.
- No plan gate: Figma limits > 1920 × 1080 and > 30 fps to paid plans; DesignerV2 is Enterprise.
- **Export** → a progress row with Cancel → the file: desktop: the save dialog (the existing export path, `exporting.ts`), web: a download. Name: the frame's name + extension (`exportFiles.ts` `planExportPaths`); several frames: one file each, dotLottie: one file with all.
- **Range**: the whole timeline once — ONCE / LOOP: [0, d]; Ping-pong: [0, 2d] (there and back).
- **Background**: video formats composite over the frame's own fills; a transparent frame is composited over white [unverified]; GIF keeps 1-bit transparency (alpha < 0.5 → transparent); SVG and Lottie keep transparency.
- Restricted files ("Restrict copying and sharing") block Animated export for viewers (verified), as Static export does.

### 7.2 Frames

`engine.motionRenderFrame(root, tUs, scale)` → `Pixels` (straight RGBA, the E7 PNG path with the motion layer applied at t, §5). The exporter (`editor/motion/export/frames.ts`) renders frame k at t = k / fps, yields to the event loop between frames, waits for fonts / images first (as `exportCore.ts` does), and stops on Cancel. Effects and shaders render as on the canvas.

### 7.3 MP4 / WebM (WebCodecs)

- `VideoEncoder` per export; MP4: H.264 `avc1.640033` (High 5.1), fallback `avc1.42E033`; WebM: VP9 `vp09.00.41.08`, fallback VP8 `vp8`; `bitrateMode: "variable"`, `latencyMode: "quality"`, key frame every 2 s; `hardwareAcceleration: "prefer-hardware"`. Electron ships Chromium's proprietary codecs, so H.264 encodes through VideoToolbox on macOS (and MediaFoundation on Windows).
- Muxers: **`mp4-muxer`** and **`webm-muxer`** (Vanilagy, MIT), installed at the latest 5.x, pinned exactly in `package.json` (no ranges); `fastStart: "in-memory"`.
- Audio: the timeline's clips mixed offline (`OfflineAudioContext`, 48 kHz stereo, the clips' volumes and mutes) and encoded with `AudioEncoder`: MP4 → AAC `mp4a.40.2` 128 kb/s when `isConfigSupported`, else Opus; WebM → Opus 128 kb/s. No audio clips → no audio track.
- Frames from `Pixels` → `VideoFrame` (`format: "RGBA"`, `timestamp` µs); backpressure on `encodeQueueSize > 4`.

### 7.4 GIF

**`gifenc`** (mattdesl, MIT, exact version pinned): one global palette per export from up to 32 sampled frames (`quantize` 256 colours, `rgba4444` when transparency is used), `applyPalette` per frame, no dithering; delays in centiseconds with an accumulator so 30 fps alternates 3 / 4 cs (GIF can't do better than 100 / x); fps above 50 is exported at 50; Loop on → NETSCAPE repeat 0, off → no loop extension.

### 7.5 Animated SVG

Our writer (`editor/motion/export/svg.ts`): the engine's static SVG of the root at **base values** with stable ids (`exportNodes` SVG option `ids: "guid"` → `id="n-<s>-<l>"` on each layer's group), plus one `<style>` with CSS `@keyframes` per animated property per element from the **resolved model** (§8.1): `translate`, `rotate`, `scale` (CSS individual transform properties, `transform-box: fill-box; transform-origin` from the anchor), `opacity`, `fill` / `stroke` colours (SOLID), `stroke-width`, path trim (`pathLength="1"` + `stroke-dasharray` / `stroke-dashoffset`); per-segment `animation-timing-function` (cubic-bezier; springs as CSS `linear()` sampled at 30 points; HOLD `steps(1, jump-end)`); `animation-iteration-count` / `direction` from the playback style (LOOP infinite, Ping-pong infinite alternate, ONCE 1 with `fill-mode: both`). Fields CSS can't animate in SVG (WIDTH / HEIGHT with layout, effects, gaps and paddings, text stagger, shader properties) are exported static and listed in a warning toast ("Some animations can't be exported to SVG" [wording ours]).

### 7.6 Lottie and dotLottie

Our writer (`editor/motion/export/lottie/`), Lottie 5.7 JSON (`v "5.7.0"`, `fr` = the frame rate, `ip 0`, `op` = frames, `w` / `h` = the root's size × scale):
- Each layer → a shape layer (`ty 4`) whose shapes are the engine's outlines of its fills and strokes in local coordinates (`engine.motionShapes(root)`, §10), groups / frames → precomps or null-parented layers, clip content → track mattes; text → outlined shapes; images → image assets (`ty 2`, embedded base64 in Lottie, files in dotLottie).
- Transforms: `ks.a` = the anchor, `ks.p` = position (with spatial tangents `ti` / `to` from motion path handles), `ks.r` = −rotation (Lottie is clockwise), `ks.s` = scale × 100, `ks.o` = opacity × 100; SOLID fill / stroke colour keyframes; path trim → a trim-paths shape (`ty "tm"`).
- Easing per keyframe: bezier → `o` / `i` tangents; springs and back curves beyond bezier → baked, one linear keyframe per frame; HOLD → `h: 1`.
- Like Figma: shaders, angular gradients and unsupported effects → the layer rasterised at its base state as an image layer; videos unsupported (skipped with a warning); drop shadows / noise / glass static.
- Lottie: one animation per file (verified); with several frames selected, Lottie writes one file each. dotLottie: a ZIP (our minimal store-only writer with CRC-32, `deflate-raw` through `CompressionStream` for JSON) with `manifest.json` (`{version "1", generator "DesignerV2", animations [{id}]}`), `animations/<id>.json`, `images/…`, and the frames' fonts are outlined (no font files).

### 7.7 Limits and errors

- Max duration 10 min, max frames 36 000 [ours]. An encoder `isConfigSupported` false → "This format isn't supported on this device" and the next fallback.
- An export in progress blocks a second export of the same file (the row shows the progress); closing the tab cancels.

### 7.8 As built — round 8e, increment 1 (2026-10-17; `src/renderer/src/editor/motion/export/`, `panels/design/ExportAnimated.tsx`; tests `motion/__tests__/export.test.ts`, `editor/__tests__/exportAnimatedTab.dom.test.ts`, native `r8.motion_logo.test.cpp`)

- **Engine** (`export/ExportApi.inc`): `engine_motion_render_frame(h, {root, timeUs, scale, allowPending})` — the root's own box (`useAbsoluteBounds`, so every frame is the same size) at `scale`, drawn by the renderer's export path with the motion layer set to `timeUs` and the previous view state put back on every way out (a RAII restore); E_BUSY as `engine_export` until fonts and images arrived. `Engine.motionRenderFrame(root, timeUs, scale, {allowPending})` → `Pixels | null`, `Engine.motionRenderBusy` tells busy from error. Not yet: `motionShapes` (Lottie).
- **Frames** (`frames.ts`): `planFrames` (the span: d, or 2d for Ping-pong; frame k at k / fps; the 10 min / 36 000 frame limits), `engineFrames` (a `FrameSource` over the engine: the first frame waits up to 10 s for what the root draws, the rest draw what there is, a turn of the event loop per frame, an AbortSignal stops it), `flattenOnto`, `padToEven`.
- **GIF** (`gif.ts`, gifenc 1.0.3 pinned): the palette from up to 32 evenly spread frames (65 536 pixels sampled each; rgba4444 + 1-bit alpha when a sampled pixel is transparent, else rgb565), `applyPalette` per frame, delays by a centisecond accumulator (30 fps → 3, 4, 3, 3, 4…), above 50 fps the frames are thinned to 50, Loop → NETSCAPE 0 (off: none).
- **MP4 / WebM** (`video.ts`, mp4-muxer 5.2.2, webm-muxer 5.1.4 pinned): `pickVideoConfig` tries `avc1.640033` → `avc1.42E033` (MP4) and `vp09.00.41.08` → `vp8` (WebM) through `VideoEncoder.isConfigSupported`; bitrate = w × h × fps × 0.05 / 0.1 / 0.2 (Low / Medium / High), variable, quality latency, hardware preferred, a key frame every 2 s, the encode queue held at 4; frames flattened on white and padded to even sides; `fastStart: "in-memory"`. **Audio is not muxed yet** (no audio clips exist before the audio increment).
- **The job** (`exportAnimated.ts`): `timelineOf` (a root's span, playback, name and size from `motionTimeline`), `scaleOf` (a Size preset, or a custom W × H as the width's factor), `renderAnimated` (one file or a reason), `exportAnimated` (every job, then `saveFiles` — the desktop's Save dialog, a browser download; the errors for a toast). SVG, Lottie and dotLottie answer "isn't built yet".
- **The panel** (`ExportAnimated.tsx`; `Export.tsx` gained the **Static | Animated** tabs, "+" and the rows on Static only): Format, Size (0.5x … 4x, Custom with W / H), Frame rate (24 … 60), Quality (MP4 / WebM) or Loop (GIF), **Export animation** / "Export N animations" with a progress row ("Exporting frame x of y…") and Cancel; without a timeline root among the targets, "Select a top-level frame to export animations". The settings are the panel's for the session.

**Not in increment 1**: the Animated tab's settings stored on the layer (`ExportSettings` 13–17), the Background choice, animated SVG (§7.5), Lottie / dotLottie (§7.6, `motionShapes`), audio in MP4 / WebM (§7.3), the one-export-per-file lock, the restricted-file gate beyond what Static already does (Animated reads `exportAllowed` too). Verified here only on the native build (the ABI's sizes, errors and restore) and on fixed frames (GIF bytes, the codec choice); the encoders need Chromium's WebCodecs — the Mac run.

## 8. Dev Mode — the Motion tab

### 8.1 The resolved model

`engine.motionResolved(rootOrNode)` → `ResolvedMotion` (§10): every animated layer under it (instance sublayers included, with their offsets), each property as **keyframes in root time** — manual tracks and presets materialised (preset tracks generated as keyframes at their clip ends, with the clip's easing; text stagger as per-element delays), values in public units (px, degrees, multipliers, 0–1, RGBA), easing as `MotionEasing`, the anchor, duration and playback style. It feeds Dev Mode code, the SVG and Lottie writers, the plugin API's `node.animations`, the MCP / agents and REST.

### 8.2 The tab (`src/viewer/inspect/motion*`, `src/viewer/InspectPanel.tsx`)

In Dev Mode (editor and viewer) the Inspect panel has a **Motion** tab when the selection is or contains an animated layer (verified). It shows:
- **Show in timeline view** (verified): opens the read-only timeline (8c's panel with `readOnly`) at the bottom of the Dev Mode canvas; play, scrub, zoom; the canvas plays the frame (the motion layer on, as Motion mode, nothing editable).
- **Timing**: duration, playback, and per property: start, end, easing name (and its cubic-bezier or bounce), values [layout ours].
- **Code** (verified): a format selector **CSS** (default) / **React** / **JSON**, the code, **Copy** (verified).
  - **CSS**: per animated element a class with `animation: <name> <duration>ms <iteration> <direction> both`, `transform-origin`, and one `@keyframes` per property group, keyframe percentages from times / duration, per-keyframe `animation-timing-function`, individual transform properties (`translate`, `rotate`, `scale`), springs as `linear(…)`, HOLD as `steps(1, jump-end)`; identical motion shared once (a comment points to the first, as Figma's MCP dedupes).
  - **React**: motion.dev (`import { motion } from "motion/react"`): `<motion.div initial={…} animate={{ x: […], opacity: […] }} transition={{ x: { duration, times: […], ease: [[x1,y1,x2,y2], …], repeat: Infinity, repeatType: "loop" | "reverse" } }} style={{ transformOrigin }} />` per element; a 2-keyframe spring as `type: "spring", bounce, duration`.
  - **JSON**: `ResolvedMotion` pretty-printed.
  - Units follow Dev Mode's unit setting (px / rem for distances; ms durations).
- No SwiftUI / Compose motion code: Figma has none (§1).

## 9. Plugin API, REST, agents, `.fig`

- **Plugin API** (`editor/plugins/api/`, `plugins/runtime/figma.js`), Figma's shapes (§1): `node.manualKeyframeTracks` (get / set), `applyManualKeyframeTrack(field, track)`, `removeManualKeyframeTrack(field)`, `node.animationStyles` (get / set), `applyAnimationStyle(styleId, config?)` → id, `removeAnimationStyle(id)`, `node.timelines`, `setTimelineDuration(id, s)`, `node.animations` (manual tracks only, as Figma's), `figma.motion.playheadPosition`, `figmaAnimationStyles()`, `physicalSpringToNormalized()`. Errors as Figma's ("Do not animate top-level frames…" → throw on a root; WIDTH / HEIGHT on groups and vectors throw; "keyframe tracks must be either combined or separated"). Seconds at the API, µs inside; the unit table of §4.5 (opacity × 100, rotation −radians) and the bounce conversion of §4.7 at the boundary. Field descriptors: `{type 'PROPERTY', name}` | `{type 'INDEXED_ITEM', collection 'fills' | 'strokes', index[, propertyId]}` | `{type 'INDEXED_ITEM', collection 'effects', index, field | propertyId}`; `ManualKeyframeBindingInput {id?, baseValue?, keyframes [{id?, timelinePosition ≥ 0, easing? MotionEasing | VariableAlias, value}]}`; keyframes read back sorted. Gated by `metronome` at Figma; Dev Mode exposes only the reads; `transitionOverrides` (gate `eclipse`) comes with §4.12's later work.
- **REST** (`editor/rest/fileJson.ts`): motion fields pass through as Figma's names on the animated nodes; the internal canvas's motion nodes are not listed (as variables aren't).
- **Agents** (`src/shared/agents/tools.ts`, the host): tools `set_keyframes` / `apply_animation` / `get_motion` over the same commands and `motionResolved` (Figma's agent "adds keyframes to the timeline").
- **`.fig`** (`src/shared/fig/`): KEYFRAME / KEYFRAME_TRACK / ANIMATION_PRESET_INSTANCE and every adopted field survive import → export (by field name); a fidelity test with a synthetic file now, and the owner's Motion `.fig` when it arrives (§12.1).

---

## 10. Shared types — commit verbatim before the round

`src/shared/motion/types.ts`:

```ts
/**
 * Figma Motion (docs/motion.md) — the types the engine bindings, the Motion chrome, export, Dev Mode and the plugin
 * API share. Document shapes (KeyframeValueData, TimelineData, EasingData…) are the generated ones in
 * src/shared/schema/document.generated.ts; these are the shapes around them. Times are µs inside, seconds at the
 * plugin API, ms in the UI. [unverified] defaults are ours.
 */

/** A GUID as the engine bindings print it: "sessionID:localID". */
export type GuidString = string;
/** Microseconds (an integer). */
export type Micros = number;

export const DEFAULT_DURATION_US: Micros = 2_000_000; // help.figma.com 41405906446999 (probe 5.1)
export const DEFAULT_SNAPPING_FPS = 60; // Figma's frames-mode default (timeline settings, §6.2)

// ---- Fields ----------------------------------------------------------------------------------------------------

/** Figma's public keyframe fields (developers.figma.com Motion `KeyframePropertyFieldName`). */
export const KEYFRAME_PROPERTY_FIELDS = [
  "CORNER_RADIUS", "STROKE_WEIGHT", "STACK_SPACING", "STACK_PADDING_LEFT", "STACK_PADDING_TOP", "STACK_PADDING_RIGHT",
  "STACK_PADDING_BOTTOM", "WIDTH", "HEIGHT", "RECTANGLE_TOP_LEFT_CORNER_RADIUS", "RECTANGLE_TOP_RIGHT_CORNER_RADIUS",
  "RECTANGLE_BOTTOM_LEFT_CORNER_RADIUS", "RECTANGLE_BOTTOM_RIGHT_CORNER_RADIUS", "BORDER_TOP_WEIGHT", "BORDER_BOTTOM_WEIGHT",
  "BORDER_LEFT_WEIGHT", "BORDER_RIGHT_WEIGHT", "STACK_COUNTER_SPACING", "OPACITY", "GRID_ROW_GAP", "GRID_COLUMN_GAP",
  "TRANSLATION_X", "TRANSLATION_Y", "TRANSLATION_XY", "ROTATION", "SCALE_X", "SCALE_Y", "SCALE_XY",
  "PATH_TRIM_START", "PATH_TRIM_END",
] as const;
export type KeyframePropertyFieldName = (typeof KEYFRAME_PROPERTY_FIELDS)[number];

/** Figma's effect keyframe fields (`EffectKeyframeFieldName`). */
export const EFFECT_KEYFRAME_FIELDS = [
  "OFFSET_X", "OFFSET_Y", "RADIUS", "SPREAD", "COLOR", "REFRACTION_RADIUS", "SPECULAR_ANGLE", "SPECULAR_INTENSITY",
  "CHROMATIC_ABERRATION", "SPLAY", "REFRACTION_INTENSITY", "START_RADIUS", "NOISE_SIZE_X", "NOISE_SIZE_Y", "DENSITY",
  "EFFECT_OPACITY", "SECONDARY_COLOR",
] as const;
export type EffectKeyframeFieldName = (typeof EFFECT_KEYFRAME_FIELDS)[number];

/** Figma's `KeyframeField` (plugin API). Paint fields without `propertyId` are the SOLID colour; `opacity: true` is ours (the paint's opacity). */
export type KeyframeField =
  | { type: "PROPERTY"; name: KeyframePropertyFieldName }
  | { type: "INDEXED_ITEM"; collection: "fills" | "strokes"; index: number; propertyId?: string; opacity?: boolean }
  | { type: "INDEXED_ITEM"; collection: "effects"; index: number; field?: EffectKeyframeFieldName; propertyId?: string };

export type KeyframeValueTypeName = "FLOAT" | "COLOR" | "TEXT_DATA" | "VECTOR" | "BOOL" | "CIRCLE" | "LINE" | "CIRCLE_POINT" | "COLOR_POINT";

export interface FieldInfo {
  /** The schema's VariableField number (docs/motion.md §4.5) */
  variableField: number;
  value: KeyframeValueTypeName;
  /** Stored ↔ node units (Figma's): "x100" (OPACITY, normalised effect fields), "-rad" (ROTATION: node degrees CCW+ ↔ stored −radians); absent = as is */
  stored?: "x100" | "-rad";
  /** Figma's write clamp, in node units */
  clamp?: [number, number];
  kind: "absolute" | "additive" | "multiplicative";
  /** Changes layout: the motion layer re-lays out the node */
  layout?: boolean;
  /** The UI's row name in the timeline [unverified] */
  label: string;
}

/** The single table of keyframable node fields (C++ engine/src/motion/Fields.h mirrors it; a test compares). */
export const KEYFRAME_FIELDS: Record<KeyframePropertyFieldName, FieldInfo> = {
  OPACITY: { variableField: 31, value: "FLOAT", kind: "absolute", stored: "x100", clamp: [0, 1], label: "Opacity" },
  CORNER_RADIUS: { variableField: 1, value: "FLOAT", kind: "absolute", label: "Corner radius" },
  RECTANGLE_TOP_LEFT_CORNER_RADIUS: { variableField: 14, value: "FLOAT", kind: "absolute", label: "Top left radius" },
  RECTANGLE_TOP_RIGHT_CORNER_RADIUS: { variableField: 15, value: "FLOAT", kind: "absolute", label: "Top right radius" },
  RECTANGLE_BOTTOM_LEFT_CORNER_RADIUS: { variableField: 16, value: "FLOAT", kind: "absolute", label: "Bottom left radius" },
  RECTANGLE_BOTTOM_RIGHT_CORNER_RADIUS: { variableField: 17, value: "FLOAT", kind: "absolute", label: "Bottom right radius" },
  STROKE_WEIGHT: { variableField: 4, value: "FLOAT", kind: "absolute", label: "Stroke weight" },
  BORDER_TOP_WEIGHT: { variableField: 18, value: "FLOAT", kind: "absolute", label: "Top stroke" },
  BORDER_BOTTOM_WEIGHT: { variableField: 19, value: "FLOAT", kind: "absolute", label: "Bottom stroke" },
  BORDER_LEFT_WEIGHT: { variableField: 20, value: "FLOAT", kind: "absolute", label: "Left stroke" },
  BORDER_RIGHT_WEIGHT: { variableField: 21, value: "FLOAT", kind: "absolute", label: "Right stroke" },
  STACK_SPACING: { variableField: 5, value: "FLOAT", kind: "absolute", layout: true, label: "Gap" },
  STACK_COUNTER_SPACING: { variableField: 23, value: "FLOAT", kind: "absolute", layout: true, label: "Row gap" },
  STACK_PADDING_LEFT: { variableField: 6, value: "FLOAT", kind: "absolute", layout: true, label: "Left padding" },
  STACK_PADDING_TOP: { variableField: 7, value: "FLOAT", kind: "absolute", layout: true, label: "Top padding" },
  STACK_PADDING_RIGHT: { variableField: 8, value: "FLOAT", kind: "absolute", layout: true, label: "Right padding" },
  STACK_PADDING_BOTTOM: { variableField: 9, value: "FLOAT", kind: "absolute", layout: true, label: "Bottom padding" },
  GRID_ROW_GAP: { variableField: 41, value: "FLOAT", kind: "absolute", layout: true, label: "Row gap" },
  GRID_COLUMN_GAP: { variableField: 42, value: "FLOAT", kind: "absolute", layout: true, label: "Column gap" },
  WIDTH: { variableField: 12, value: "FLOAT", kind: "absolute", layout: true, label: "Width" },
  HEIGHT: { variableField: 13, value: "FLOAT", kind: "absolute", layout: true, label: "Height" },
  TRANSLATION_X: { variableField: 46, value: "FLOAT", kind: "additive", label: "Position X" },
  TRANSLATION_Y: { variableField: 47, value: "FLOAT", kind: "additive", label: "Position Y" },
  TRANSLATION_XY: { variableField: 69, value: "VECTOR", kind: "additive", label: "Position" },
  ROTATION: { variableField: 48, value: "FLOAT", kind: "additive", stored: "-rad", label: "Rotation" },
  SCALE_X: { variableField: 49, value: "FLOAT", kind: "multiplicative", label: "Scale X" },
  SCALE_Y: { variableField: 50, value: "FLOAT", kind: "multiplicative", label: "Scale Y" },
  SCALE_XY: { variableField: 70, value: "VECTOR", kind: "multiplicative", label: "Scale" },
  PATH_TRIM_START: { variableField: 54, value: "FLOAT", kind: "absolute", clamp: [0, 1], label: "Path trim start" },
  PATH_TRIM_END: { variableField: 55, value: "FLOAT", kind: "absolute", clamp: [0, 1], label: "Path trim end" },
};

// ---- Values and easing -----------------------------------------------------------------------------------------

export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** Figma's `KeyframeValue` (plugin API). */
export type KeyframeValue =
  | { type: "FLOAT"; value: number }
  | { type: "COLOR"; value: RGBA }
  | { type: "TEXT_DATA"; value: string }
  | { type: "VECTOR"; value: { x: number; y: number } }
  | { type: "BOOL"; value: boolean }
  | { type: "CIRCLE"; value: { x: number; y: number; radius: number } }
  | { type: "LINE"; value: { x: number; y: number; x2: number; y2: number } }
  | { type: "CIRCLE_POINT"; value: { x: number; y: number; radius: number; angle: number } }
  | { type: "COLOR_POINT"; value: { x: number; y: number; color: RGBA } };

/** Figma's public easing names (MotionEasing.type), in the Easing menu's order (Hold first, §6.3). */
export const MOTION_EASING_TYPES = [
  "HOLD", "LINEAR", "EASE_IN", "EASE_OUT", "EASE_IN_AND_OUT", "EASE_IN_BACK", "EASE_OUT_BACK", "EASE_IN_AND_OUT_BACK",
  "GENTLE", "QUICK", "BOUNCY", "SLOW", "CUSTOM_CUBIC_BEZIER", "CUSTOM_SPRING",
] as const;
export type MotionEasingType = (typeof MOTION_EASING_TYPES)[number];

export interface MotionEasing {
  type: MotionEasingType;
  easingFunctionCubicBezier?: { x1: number; y1: number; x2: number; y2: number };
  easingFunctionSpring?: { bounce: number };
}

/** An easing as stored: a value, or bound to an EASING variable. */
export type EasingRef = MotionEasing | { variable: GuidString };

/** The Easing menu's labels (help.figma.com 41414048690839). */
export const EASING_LABELS: Record<MotionEasingType, string> = {
  LINEAR: "Linear",
  EASE_IN: "Ease in",
  EASE_OUT: "Ease out",
  EASE_IN_AND_OUT: "Ease in and out",
  EASE_IN_BACK: "Ease in back",
  EASE_OUT_BACK: "Ease out back",
  EASE_IN_AND_OUT_BACK: "Ease in and out back",
  HOLD: "Hold",
  GENTLE: "Gentle",
  QUICK: "Quick",
  BOUNCY: "Bouncy",
  SLOW: "Slow",
  CUSTOM_CUBIC_BEZIER: "Custom bezier",
  CUSTOM_SPRING: "Custom spring",
};

/** Public name → the schema's EasingType. */
export const EASING_SCHEMA_TYPE: Record<MotionEasingType, string> = {
  LINEAR: "LINEAR",
  EASE_IN: "EASE_IN", // 15; IN_CUBIC (0) on a keyframe means "no easing" (§4.7)
  EASE_OUT: "OUT_CUBIC",
  EASE_IN_AND_OUT: "INOUT_CUBIC",
  EASE_IN_BACK: "IN_BACK_CUBIC",
  EASE_OUT_BACK: "OUT_BACK_CUBIC",
  EASE_IN_AND_OUT_BACK: "INOUT_BACK_CUBIC",
  HOLD: "HOLD",
  GENTLE: "GENTLE_SPRING",
  QUICK: "SPRING_PRESET_ONE",
  BOUNCY: "SPRING_PRESET_TWO",
  SLOW: "SPRING_PRESET_THREE",
  CUSTOM_CUBIC_BEZIER: "CUSTOM_CUBIC",
  CUSTOM_SPRING: "CUSTOM_SPRING",
};

/** The named bezier curves (Figma's easing table, engine/src/motion/Easing.h). */
export const BEZIER_PRESETS: Partial<Record<MotionEasingType, [number, number, number, number]>> = {
  LINEAR: [0, 0, 1, 1],
  EASE_IN: [0.42, 0, 1, 1],
  EASE_OUT: [0, 0, 0.58, 1],
  EASE_IN_AND_OUT: [0.42, 0, 0.58, 1],
  EASE_IN_BACK: [0.3, -0.05, 0.7, -0.5],
  EASE_OUT_BACK: [0.45, 1.45, 0.8, 1],
  EASE_IN_AND_OUT_BACK: [0.7, -0.4, 0.4, 1.4],
};

/** The spring presets, stored physical (Figma's [mass, stiffness, damping]; the bounce shown is clamp(1 − ζ, 0, 1)). */
export const SPRING_PRESETS: Partial<Record<MotionEasingType, { mass: number; stiffness: number; damping: number }>> = {
  GENTLE: { mass: 1, stiffness: 100, damping: 15 },
  QUICK: { mass: 1, stiffness: 300, damping: 20 },
  BOUNCY: { mass: 1, stiffness: 600, damping: 15 },
  SLOW: { mass: 1, stiffness: 80, damping: 20 },
};

/** A keyframe written without an easing (and an IN_CUBIC / missing one read): Figma's CUSTOM_CUBIC (0.5, 0, 0.5, 1). */
export const DEFAULT_KEYFRAME_EASING: MotionEasing = { type: "CUSTOM_CUBIC_BEZIER", easingFunctionCubicBezier: { x1: 0.5, y1: 0, x2: 0.5, y2: 1 } };

/** figma.motion.physicalSpringToNormalized: bounce = clamp(1 − ζ, 0, 1), ζ = damping / (2·√(stiffness·mass)); positive finite values only. */
export function physicalSpringToNormalized(s: { mass: number; stiffness: number; damping: number }): number {
  if (![s.mass, s.stiffness, s.damping].every((x) => Number.isFinite(x) && x > 0)) throw new Error("physicalSpringToNormalized: mass, stiffness and damping must be positive numbers");
  const zeta = s.damping / (2 * Math.sqrt(s.stiffness * s.mass));
  return Math.min(1, Math.max(0, 1 - zeta));
}

/** A bounce as a physical spring (Figma's): ζ = clamp(1 − bounce, 1e−4, 1), ω₀ and mass kept from `prev` when valid (else 10 rad/s, 1). */
export function normalizedToPhysicalSpring(bounce: number, prev?: { mass: number; stiffness: number; damping: number }): { mass: number; stiffness: number; damping: number } {
  const zeta = Math.min(1, Math.max(1e-4, 1 - bounce));
  const valid = !!prev && [prev.mass, prev.stiffness].every((x) => Number.isFinite(x) && x > 0);
  const mass = valid ? Math.min(100, Math.max(0.01, prev!.mass)) : 1;
  const w0 = valid ? Math.sqrt(prev!.stiffness / prev!.mass) : 10;
  const stiffness = w0 * w0 * mass;
  return { mass, stiffness, damping: 2 * zeta * Math.sqrt(stiffness * mass) };
}

// ---- Timeline ----------------------------------------------------------------------------------------------------

/** The UI's names; the schema's PlaybackStyle is LOOP / ONCE / BOOMERANG. The order is the Playback button's cycle. */
export type PlaybackName = "LOOP" | "ONCE" | "PING_PONG";
export const PLAYBACK_CYCLE: readonly PlaybackName[] = ["LOOP", "ONCE", "PING_PONG"];
export const PLAYBACK_LABELS: Record<PlaybackName, string> = { LOOP: "Loop", ONCE: "Once", PING_PONG: "Ping-pong" };

/** The timeline settings' units and snapping grids (Figma's, §6.2): FrameRate numerator / denominator. */
export type TimelineUnit = "ms" | "frames";
export const SNAPPING_GRIDS: Record<TimelineUnit, readonly [number, number][]> = {
  ms: [[10, 1], [20, 1], [100, 1]],
  frames: [[60, 1], [30, 1], [30000, 1001], [24, 1], [24000, 1001], [12, 1]],
};

/** engine.setMotion's argument (view state, never in the document). Omitted keys keep their value. */
export interface MotionViewState {
  on?: boolean;
  /** The timeline root shown; null: the root of the selection */
  root?: GuidString | null;
  timeUs?: Micros;
  autoKeyframe?: boolean;
  showMotionPath?: boolean;
}

export interface TimelineKeyframe {
  id: GuidString;
  timeUs: Micros;
  value: KeyframeValue;
  /** The value bound to a variable */
  valueVariable?: GuidString;
  /** Easing into this keyframe (unused on the first) */
  easing: EasingRef;
}

export interface TimelineTrack {
  id: GuidString;
  field: KeyframeField;
  label: string;
  keyframes: TimelineKeyframe[];
}

export interface TimelineClip {
  /** The ANIMATION_PRESET_INSTANCE */
  id: GuidString;
  preset: PresetKey;
  name: string;
  startUs: Micros;
  durationUs: Micros;
  disabled: boolean;
  easing: EasingRef;
  props: Record<string, PresetPropValue>;
  /** The composite style that generated it, if any */
  style?: { id: GuidString; key: string; name: string };
}

export interface TimelineLayer {
  node: GuidString;
  name: string;
  /** The Layers panel's icon name */
  icon: string;
  depth: number;
  /** An animated instance: one purple bar, moved by its offset only */
  instance?: { offsetUs: Micros; durationUs: Micros; mainTimeline: GuidString };
  tracks: TimelineTrack[];
  clips: TimelineClip[];
  /** First keyframe / clip start → last keyframe / clip end (the layer bar) */
  startUs: Micros;
  endUs: Micros;
}

export interface TimelineAudioClip {
  id: GuidString;
  trackId: GuidString;
  name: string;
  mediaHash: string;
  offsetUs: Micros;
  startUs: Micros;
  durationUs: Micros;
  volume: number;
  mute: boolean;
}

export interface TimelineModel {
  root: GuidString;
  rootName: string;
  timelineId: GuidString;
  durationUs: Micros;
  playback: PlaybackName;
  snappingFps: number;
  layers: TimelineLayer[];
  audioTracks: { id: GuidString; name: string; gain: number; mute: boolean }[];
  audio: TimelineAudioClip[];
}

/** engine.motionFieldStates: per node, per field key (fieldKey()), the right panel's diamond. */
export type DiamondState = "none" | "track" | "keyframe";
export type FieldStates = Record<GuidString, Record<string, { state: DiamondState; keyframe?: GuidString }>>;

/** A field's stable key: "OPACITY", "fills[0]", "fills[0].opacity", "fills[0]#<propertyId>", "effects[1].RADIUS". */
export function fieldKey(f: KeyframeField): string {
  if (f.type === "PROPERTY") return f.name;
  const base = `${f.collection}[${f.index}]`;
  if (f.propertyId) return `${base}#${f.propertyId}`;
  if ("field" in f && f.field) return `${base}.${f.field}`;
  if ("opacity" in f && f.opacity) return `${base}.opacity`;
  return base;
}

// ---- Presets and styles ------------------------------------------------------------------------------------------

/** Figma's active first-party presets (§4.6); Fade, Move, Rotate, Resize, Path Draw and Path Travel are deprecated there. */
export type PresetKey = "new" | "opacity" | "position" | "scale" | "rotation" | "size" | "cornerRadius" | "path" | "text" | "textStagger";
export type PresetPropValue = number | boolean | string | MotionEasing | { variable: GuidString };

/** A preset's prop as Figma's propDefs carry it ({name, type NUMBER | TEXT | BOOL | EASING, default, selectConfig.options, inputConfig}). */
export interface PresetPropDef {
  key: string;
  label: string;
  kind: "enum" | "number" | "bool" | "easing";
  /** enum: [value, label][] */
  options?: [string, string][];
  unit?: "s" | "%" | "°" | "px";
  min?: number;
  max?: number;
  /** A NUMBER that resolves as timing (Delay, Duration: TIMING variables bind to it) */
  timing?: boolean;
  default: PresetPropValue;
}

export interface PresetDef {
  key: PresetKey;
  /** The Animations + menu's label */
  name: string;
  props: PresetPropDef[];
}

// Shared by every preset (Figma's): Delay 0 s, Duration 0.5 s (min 0.01), Easing OUT_CUBIC.
const TIMING_PROPS = (duration = 0.5): PresetPropDef[] => [
  { key: "delay", label: "Delay", kind: "number", unit: "s", min: 0, timing: true, default: 0 },
  { key: "duration", label: "Duration", kind: "number", unit: "s", min: 0.01, timing: true, default: duration },
  { key: "easing", label: "Easing", kind: "easing", default: { type: "EASE_OUT" } },
];

/** The first-party presets and their defaults (Figma's propDefs, docs/research/rea/motion.md §2.18); the code is ours. */
export const ANIMATION_PRESETS: readonly PresetDef[] = [
  { key: "new", name: "New", props: [...TIMING_PROPS()] },
  { key: "opacity", name: "Opacity", props: [
    { key: "type", label: "Type", kind: "enum", options: [["fadeIn", "Fade in"], ["fadeOut", "Fade out"], ["custom", "Custom"]], default: "fadeIn" },
    { key: "amount", label: "Amount", kind: "number", unit: "%", default: 0 },
    { key: "start", label: "Start", kind: "number", unit: "%", default: 0 },
    { key: "end", label: "End", kind: "number", unit: "%", default: 100 },
    ...TIMING_PROPS(),
  ] },
  { key: "position", name: "Position", props: [
    { key: "type", label: "Type", kind: "enum", options: [["slide_in", "Slide in"], ["slide_out", "Slide out"], ["custom", "Custom"]], default: "slide_in" },
    { key: "direction", label: "Direction", kind: "enum", options: [["left", "Left"], ["right", "Right"], ["top", "Top"], ["bottom", "Bottom"], ["top_left", "Top left"], ["top_right", "Top right"], ["bottom_left", "Bottom left"], ["bottom_right", "Bottom right"]], default: "left" },
    { key: "distance", label: "Distance", kind: "number", unit: "px", default: 200 },
    ...TIMING_PROPS(),
  ] },
  { key: "scale", name: "Scale", props: [
    { key: "type", label: "Type", kind: "enum", options: [["scaleIn", "Scale in"], ["scaleOut", "Scale out"], ["custom", "Custom"]], default: "scaleIn" },
    { key: "amount", label: "Amount", kind: "number", unit: "%", default: 120 },
    ...TIMING_PROPS(),
  ] },
  { key: "rotation", name: "Rotation", props: [
    { key: "type", label: "Type", kind: "enum", options: [["rotateIn", "Rotate in"], ["rotateOut", "Rotate out"], ["custom", "Custom"]], default: "rotateIn" },
    { key: "direction", label: "Direction", kind: "enum", options: [["clockwise", "Clockwise"], ["counterclockwise", "Counterclockwise"]], default: "clockwise" },
    { key: "amount", label: "Amount", kind: "number", unit: "°", default: 180 },
    ...TIMING_PROPS(),
  ] },
  { key: "size", name: "Size", props: [
    { key: "type", label: "Type", kind: "enum", options: [["resize_in", "Resize in"], ["resize_out", "Resize out"], ["custom", "Custom"]], default: "resize_in" },
    { key: "amount", label: "Amount", kind: "number", unit: "px", default: 50 },
    ...TIMING_PROPS(),
  ] },
  { key: "cornerRadius", name: "Corner Radius", props: [
    { key: "type", label: "Type", kind: "enum", options: [["roundIn", "Round in"], ["roundOut", "Round out"], ["custom", "Custom"]], default: "roundIn" },
    { key: "amount", label: "Amount", kind: "number", unit: "px", default: 10 },
    ...TIMING_PROPS(),
  ] },
  { key: "path", name: "Path", props: [
    { key: "type", label: "Type", kind: "enum", options: [["draw", "Draw"], ["erase", "Erase"], ["travel", "Travel"], ["custom", "Custom"]], default: "draw" },
    { key: "segment", label: "Segment", kind: "number", unit: "%", default: 10 },
    ...TIMING_PROPS(),
  ] },
  { key: "text", name: "Text", props: [
    { key: "revealBy", label: "Reveal by", kind: "enum", options: [["character", "Character"], ["word", "Word"], ["line", "Line"]], default: "character" },
    ...TIMING_PROPS(1.5),
  ] },
  { key: "textStagger", name: "Text stagger", props: [
    { key: "animationDirection", label: "Direction", kind: "enum", options: [["in", "In"], ["out", "Out"]], default: "in" },
    { key: "textDelayGrouping", label: "Grouping", kind: "enum", options: [["CHARACTER", "Character"], ["CHARACTER_NO_WHITESPACE", "Character (no spaces)"], ["WORD", "Word"], ["LINE", "Line"], ["PARAGRAPH", "Paragraph"]], default: "CHARACTER" },
    { key: "presetStaggerOverlap", label: "Overlap", kind: "number", unit: "%", min: 0, max: 100, default: 50 },
    { key: "textDelayOrder", label: "Order", kind: "enum", options: [["LEFT_RIGHT", "Left to right"], ["RIGHT_LEFT", "Right to left"], ["CENTER_OUT", "Center out"], ["RANDOM", "Random"]], default: "LEFT_RIGHT" },
    { key: "clipContent", label: "Clip content", kind: "bool", default: false },
    ...TIMING_PROPS(),
  ] },
];

// The option and prop labels above are Figma's keys' meaning (motion.preset_flyout.*), their English wording [unverified].

export interface AnimationStyleDef {
  key: string;
  name: string;
  /** Text-only styles show only for text layers */
  textOnly?: boolean;
  /** The presets it inserts, each offset from the playhead */
  presets: { preset: PresetKey; offsetMs: number; props: Record<string, PresetPropValue> }[];
}

/** Composite animation styles: none until probe 5.10 (`figma.motion.figmaAnimationStyles()`) shows Figma's own; "Text enter" / "Text exit" are the help's names. */
export const ANIMATION_STYLES: readonly AnimationStyleDef[] = [];

// ---- Commands ----------------------------------------------------------------------------------------------------

export interface KeyframeEdit {
  id: GuidString;
  timeUs?: Micros;
  value?: KeyframeValue;
  /** Bind the value to a variable (null unbinds) */
  valueVariable?: GuidString | null;
  easing?: EasingRef;
  /** TRANSLATION_XY keyframes: the motion path's handles, relative to the value */
  pathHandles?: { in: { x: number; y: number }; out: { x: number; y: number } };
}

export interface AudioEdit {
  id: GuidString;
  offsetUs?: Micros;
  startUs?: Micros;
  durationUs?: Micros;
  volume?: number;
  mute?: boolean;
  trackId?: GuidString;
}

/** engine.runMotionCommand's arguments by CommandId (abi.ts 330–349). */
export interface MotionCommandArgs {
  MOTION_ADD_KEYFRAME: { nodes: GuidString[]; field: KeyframeField; timeUs?: Micros; value?: KeyframeValue };
  MOTION_SET_KEYFRAMES: { edits: KeyframeEdit[] };
  MOTION_DELETE_KEYFRAMES: { ids: GuidString[] };
  MOTION_DELETE_TRACKS: { node: GuidString; fields: KeyframeField[] };
  MOTION_SET_EASING: { ids: GuidString[]; easing: EasingRef };
  MOTION_SET_TIMELINE: { root: GuidString; durationUs?: Micros; playback?: PlaybackName; snappingFps?: number };
  MOTION_ADD_ANIMATION: { nodes: GuidString[]; preset: PresetKey; props?: Record<string, PresetPropValue>; startUs?: Micros };
  MOTION_SET_ANIMATION: { id: GuidString; preset?: PresetKey; props?: Record<string, PresetPropValue>; startUs?: Micros; durationUs?: Micros; disabled?: boolean };
  MOTION_REMOVE_ANIMATIONS: { ids: GuidString[] };
  MOTION_APPLY_STYLE: { nodes: GuidString[]; style: string; startUs?: Micros };
  MOTION_RETIME_LAYER: { node: GuidString; deltaUs?: Micros; scale?: { factor: number; pivotUs: Micros } };
  MOTION_SET_INSTANCE_OFFSET: { instance: GuidString; offsetUs: Micros };
  MOTION_SET_ANCHOR: { nodes: GuidString[]; x: number; y: number; keepInPlace?: boolean };
  MOTION_SET_PATH_HANDLES: { keyframe: GuidString; in: { x: number; y: number }; out: { x: number; y: number } };
  MOTION_SET_TEXT_STAGGER: { node: GuidString; enabled: boolean; grouping?: "CHARACTER" | "CHARACTER_NO_WHITESPACE" | "WORD" | "LINE" | "PARAGRAPH"; delayMs?: number; order?: "LEFT_RIGHT" | "RIGHT_LEFT" | "CENTER_OUT" | "RANDOM" };
  MOTION_ADD_AUDIO: { root: GuidString; mediaHash: string; name: string; offsetUs: Micros; durationUs: Micros };
  MOTION_SET_AUDIO: { root: GuidString; edits: AudioEdit[] };
  MOTION_SPLIT_AUDIO: { root: GuidString; id: GuidString; atUs: Micros };
  MOTION_REMOVE_AUDIO: { root: GuidString; ids: GuidString[] };
  MOTION_PASTE_KEYFRAMES: { nodes: GuidString[]; atUs: Micros; clipboard: MotionClipboard };
}

/** Keyframes copied from the timeline (the editor keeps it; relative times from the earliest). */
export interface MotionClipboard {
  tracks: { field: KeyframeField; keyframes: { dtUs: Micros; value: KeyframeValue; easing: EasingRef }[] }[];
}

// ---- Resolved model (Dev Mode code, SVG / Lottie export, plugin `animations`, agents) -----------------------------

export interface ResolvedKeyframe {
  timeUs: Micros;
  value: KeyframeValue;
  /** Into this keyframe */
  easing: MotionEasing;
}

export interface ResolvedProperty {
  field: KeyframeField;
  kind: FieldInfo["kind"];
  keyframes: ResolvedKeyframe[];
  /** Per-element stagger (text animations) */
  stagger?: { grouping: string; order: string; delayMs: number; elements: number };
}

export interface ResolvedLayer {
  node: GuidString;
  /** Instance-qualified path for derived layers ("I<instance>;<sublayer>"), else the GUID */
  path: string;
  name: string;
  /** The anchor as % of the size */
  anchor: { x: number; y: number };
  size: { width: number; height: number };
  properties: ResolvedProperty[];
}

export interface ResolvedMotion {
  root: GuidString;
  durationUs: Micros;
  playback: PlaybackName;
  layers: ResolvedLayer[];
}

// ---- Export --------------------------------------------------------------------------------------------------------

export type AnimatedFormat = "MP4" | "WEBM" | "GIF" | "SVG" | "LOTTIE" | "DOTLOTTIE";
export const ANIMATED_FORMATS: readonly AnimatedFormat[] = ["MP4", "WEBM", "GIF", "SVG", "LOTTIE", "DOTLOTTIE"];
export const ANIMATED_FORMAT_LABELS: Record<AnimatedFormat, string> = {
  MP4: "MP4", WEBM: "WebM", GIF: "GIF", SVG: "SVG", LOTTIE: "Lottie", DOTLOTTIE: "dotLottie",
};
export const FRAME_RATES = [24, 25, 30, 50, 60] as const; // [unverified]

export interface AnimatedExportSettings {
  format: AnimatedFormat;
  /** A multiplier, or an exact size */
  size: { scale: number } | { width: number; height: number };
  fps: (typeof FRAME_RATES)[number];
  /** MP4 / WebM */
  quality: "LOW" | "MEDIUM" | "HIGH";
  /** GIF */
  loop: boolean;
}
export const DEFAULT_ANIMATED_EXPORT: AnimatedExportSettings = { format: "MP4", size: { scale: 1 }, fps: 30, quality: "HIGH", loop: true };

export interface AnimatedExportProgress {
  frame: number;
  frames: number;
  phase: "render" | "encode" | "audio" | "mux" | "done";
}

/** engine.motionShapes(root): what the Lottie writer draws (outlines in each layer's local space, at base values). */
export interface MotionShapeLayer {
  node: GuidString;
  parent: GuidString | null;
  name: string;
  /** Local transform (2×3: a b c d e f) and size at base values */
  transform: [number, number, number, number, number, number];
  size: { width: number; height: number };
  opacity: number;
  /** Clips its children (frames with clip content) */
  clips: boolean;
  /** SVG path data per paint: fills then strokes (strokes outlined) */
  paths: { d: string; windingRule: "NONZERO" | "EVENODD"; paint: { type: "SOLID"; color: RGBA } | { type: "GRADIENT_LINEAR" | "GRADIENT_RADIAL"; stops: { position: number; color: RGBA }[]; from: { x: number; y: number }; to: { x: number; y: number } } }[];
  /** An image fill's hash (the layer is drawn as that image, FILL / FIT resolved to a rect) */
  image?: { hash: string; rect: { x: number; y: number; width: number; height: number } };
  /** Can't be expressed as shapes (shaders, angular gradients, effects): export as a raster of the base state */
  rasterize: boolean;
}

// ---- Dev Mode ------------------------------------------------------------------------------------------------------

export type MotionCodeFormat = "CSS" | "REACT" | "JSON";
export const MOTION_CODE_FORMATS: readonly MotionCodeFormat[] = ["CSS", "REACT", "JSON"];
export const MOTION_CODE_LABELS: Record<MotionCodeFormat, string> = { CSS: "CSS", REACT: "React", JSON: "JSON" };

// ---- The easing editor's props (8d builds it, 8c uses it) -----------------------------------------------------------

export interface EasingEditorProps {
  value: EasingRef;
  /** Live changes while dragging (no commit); `commit` once on release / Enter */
  onChange(value: EasingRef, commit: boolean): void;
  /** Offer the variable binding (EASING variables) */
  allowVariable?: boolean;
  /** Where to anchor the popover (a DOMRect's box; the shared types stay DOM-free) */
  anchor: { x: number; y: number; width: number; height: number };
  onClose(): void;
}
```

`src/shared/comments.ts` gains `timeMs?: number | null` on `CommentAnchor` (§6.8).

**`Engine.ts` stubs** (throwing "not built (round 8b)" until 8b):
- `setMotion(state: MotionViewState): number`
- `motionTimeline(root?: GuidString): TimelineModel | null`
- `motionFieldStates(nodes: GuidString[]): FieldStates`
- `motionResolved(node: GuidString): ResolvedMotion | null`
- `motionRenderFrame(root: GuidString, timeUs: Micros, scale: number): Pixels | null`
- `motionShapes(root: GuidString): MotionShapeLayer[]`
- `runMotionCommand<K extends keyof MotionCommandArgs>(id: K, args: MotionCommandArgs[K]): number`
- `ExportSettings` (SVG) gains `ids?: "guid"`.

**`abi.ts`**: CommandIds `MOTION_ADD_KEYFRAME: 330` … `MOTION_PASTE_KEYFRAMES: 349` in §4.9's order; `TOOLS` gains `"ANCHOR_POINT"`; the event `MOTION_CHANGED` (`{ type: "MOTION_CHANGED"; root: GuidString | null }` in `codec.ts`'s `EngineEvent`).

**Stubs for the chrome**: `src/renderer/src/editor/motion/easing/EasingEditor.tsx` exporting `EasingEditor(props: EasingEditorProps)` and `EasingMenu` (rendering nothing until 8d), and `editor/motion/index.ts` (an empty barrel), so 8c and 8d compile against them from the start.

**Icons** (`ds/icons/registry.ts`, drawn in the house style by the main session): `16.motion` (frame title / layer badge), `24.keyframe`, `24.keyframe-add`, `16.keyframe` (outline) / `16.keyframe.filled`, `24.auto-keyframe`, `24.play-once`, `24.ping-pong` (`24.loop`, `24.play`, `24.pause` exist), `24.anchor-point`, `24.collapse-layers`, `24.timeline-collapse`, `16.audio`, `24.animation-fade`, `24.animation-move`, `24.animation-scale`, `24.animation-rotate`, `24.animation-path`, `24.animation-text`, `16.easing`.

## 11. Tests

- **Native** (8a: `engine/tests/unit/r8.motion.test.cpp`, `r8.motion_render.test.cpp`): track evaluation (before / between / after, HOLD, equal times), every easing against reference values (beziers by Newton / bisection, normalised springs settle exactly at 1, bounce 0 has no overshoot, physical springs forced to 1), composition SET / OFFSET / SCALE, the motion transform about the anchor (and rotation sign), arc-length motion path (equal-time spacing ∝ easing), colour spaces (OKLCH hue methods), presets' generated tracks (each type, in / out, delay), text stagger orders, instance offsets and playback styles nested, restore() returns bit-identical base values (a snapshot before / after a play cycle is byte-equal), preview writes produce no DOCUMENT_CHANGED, layout re-runs for WIDTH on an auto-layout child, path trim geometry (open, closed, wrap), the player's timeline clocks; render goldens at three times (`SHOT_ONLY=r8 npm run engine:shot`).
- **Native** (8b: `r8.motion_edit.test.cpp`): each command and its undo / redo, routing (track / auto-key / base), gesture → TRANSLATION_XY / ROTATION / SCALE_XY, delete / duplicate / copy-paste / detach / flatten ownership, library copy carries tracks, anchor compensation, motion path handles, audio split.
- **Wasm** (8b: `src/renderer/src/engine/__tests__/motion.wasm.test.ts`): the bindings end to end (timeline model, field states, resolved model, a frame's pixels change over time).
- **TS**: easing maths (`physicalSpringToNormalized`), the clock (loop / once / ping-pong), the timeline's hit maths and snapping, CSS / React / JSON code (snapshots), SVG and Lottie writers (schema-valid JSON; a Lottie validated against the 5.7 JSON schema subset), the GIF palette / delays, the MP4 / WebM muxers on a fake encoder, the dotLottie ZIP (CRC, readable by `DecompressionStream`), comments' timeMs round trip, the plugin API on the wasm engine (after 8b).
- **Editor shots** (`EDITOR_ONLY=motion`): Motion mode with the timeline, a keyframe selected, the easing menu and both custom editors, the Animations section, the motion path, the anchor target, the Animated export tab, Dev Mode's Motion tab with each format.

**Probes before the round** (`docs/research/rea/motion.md` §5, from the devtools console or the Figma MCP when its call limit allows): the default timeline length (5.1), keyframe default easing (5.2), EASE_IN round trip (5.3), spring bounces and which duration a prototype spring transition runs (5.4), bounce → physical (5.5), stored units (5.6), the XY / X-Y error (5.7), After delay with no timeout (5.8), the directional types and the panel's arrow for MOVE_OUT_TO_LEFT (5.9), Figma's animation styles (5.10), Corner radius roundIn (5.11), text stagger timing (5.12), transition overrides (5.13), the export plan-limit text (5.14).

## 12. Open questions for the owner

**Answered by the owner, 2026-10-12:** (1) build with our own constants now, calibrate later from a `motion.fig`; (2) Design mode and static exports show the **base values**; (3) Motion mode plays **only the focused frame**; (4) not asked — default: resizing with auto-keyframe records scale keys; (5) **time-stamped comments are left for later** — agent 8g and migration 0017 are out of this round (`CommentAnchor.timeMs` is not added in the pre-round commit).

1. **A Motion sample `.fig` and one signed-in capture** (as for Draw). In Figma Motion: one top-level frame with (a) opacity and position keyframes with Ease out, Custom bezier and Custom spring, (b) a Fade, a Move and a Scale preset and one composite style, (c) an anchor point moved and a curved motion path, (d) a path trim, (e) a text with Text enter, (f) an animated component's instance offset in time, (g) a Timing and an Easing variable bound, (h) an audio clip — saved as `docs/research/figma/samples/motion.fig`. And sign in to figma.com in the built-in browser so an agent can capture the timeline, the Animations section and menus, the easing editors and the Animated export tab (`research/figma/live/motion/`). This settles every [unverified] item: where Figma keeps tracks (§4.2), time units, the spring encoding, preset props and defaults, composite style names, sizes and wording. **Default**: build with our decisions now and calibrate later, as Draw did.
2. **What Design mode and static exports show for animated layers**: the base values (our default: what you designed stays visible; a fade-in layer is not invisible in Design) or the state at t = 0 (what Figma's MCP asset export does). **Default**: base values.
3. **Canvas in Motion mode**: only the focused frame plays at the playhead (default), or every frame with a timeline on the page.
4. **Resizing in Motion with auto-keyframe**: scale keys (our default, like After Effects / Jitter) or width / height keys.
5. **The new comment field** needs migration 0017 and a server deploy at the end (the owner deploys). Fine to include, or leave time-stamped comments for later?
