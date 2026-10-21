# Motion (contract, Phase 7 round 8; written 2026-10-12; **the pre-round commit landed 2026-10-17** — §4.1's schema, `src/shared/motion/types.ts`, the `Engine.ts` / `abi.ts` / `codec.ts` stubs, the chrome stubs and the icons; 8a is next)

Figma Motion (Beta) inside DesignerV2's Design editor: **Motion mode** with its **timeline**, **keyframes** (manual and auto-keyframe), **easing** (Figma's named curves, springs, custom bezier and spring, easing and timing variables), **animation presets** and composite **animation styles**, the **anchor point**, **motion paths**, **path trim**, **text animation**, **audio**, **animated components**, playback in **prototypes**, **export** (MP4, WebM, GIF, animated SVG, Lottie, dotLottie), the **Motion tab in Dev Mode** with code, and the plugin API. This file decides the engine model, the evaluator, the chrome, export, Dev Mode and the shared types. Ownership and merge order are in `docs/roadmap.md` "Round 8".

Motion is a **mode of a Design file**, not a file type (help: "switch the toolbar toggle to Motion"; "Any frame can switch to Motion mode"). `FileMeta.editorType` stays `"design"`.

**Corrected 2026-10-15 from Figma's own code** (`docs/research/rea/motion.md`, a static reading of the current desktop build's modules; no live probe ran — its §5 lists the 14 probes still to run). Ten decisions of the 2026-10-12 text were contradicted by the code and are rewritten in place: the keyframe binding is an `EXPRESSION KEYFRAME [base, KEYFRAME_TRACK_PARAMETER_DATA]` whose first argument is the resting value (§4.2); the default timeline lives on the top-level frame itself (§4.3); stored units are Figma's (opacity ×100, rotation −radians, §4.5); XY and X / Y tracks are exclusive (§4.5); presets are code run against a `figma:motion` runtime and their output is materialised as tracks (§3, §4.6); the preset catalogue and its defaults are Figma's (§4.6, §10); IN_CUBIC on a keyframe means "no easing", Ease in is EASE_IN 15 and the default keyframe easing is CUSTOM_CUBIC (0.5, 0, 0.5, 1) (§4.7); springs are stored physical and played normalised by Figma's settle time T (§4.7); text stagger has Figma's seven fields (§4.10); the timeline settings and the easing menu are Figma's (§6.2, §6.3). The schema is the current build's, not the 106 dump (§4.1). The prototype side already follows the code (round 17 batch A): `engine/src/motion/Easing.{h,cpp}` holds the curves and springs, the plugin / agent prototype shapes swap the side for every directional transition, and mouse delays live in `interactionMaintained` / `interactionDuration`.

Marks: **[unverified]** = our decision where Figma's own behaviour, wording, numbers or storage could not be seen. Motion's editing UI could not be captured live (`research/figma/live/motion/behaviour.md`: the built-in browser was not signed in; only the mode switch and the "Motion Beta" tag were seen). Figma's MCP (which can read and write motion) needs the owner's sign-in and was not available to this session. Every [unverified] item is listed for the capture in §12.

## Motion status (2026-10-18, after round 8j) — what is complete, what remains

**Built** (each round's "As built" has the detail): the engine model and evaluator — every public field, Figma's stored units, the keyframe default easing, named curves and springs, colour spaces, motion paths, layout at the playhead, animated instances with offsets, path trim, text stagger (8a; §5.1, §5.3); every editing command of §4.9's table, 330–352 — 344 (a text's own stagger), 349 (paste), 350 / 351 (combine / split) were the last, built in 8i — with the panel writes and canvas gestures routed, auto-keyframe, the anchor kept in place, ownership on delete / duplicate / paste / detach (8b, 8i; §5.2, §6.11); Motion mode's chrome — the timeline (rows, diamonds, segments, marquee, copy / paste through the engine, clips, audio rows, instance bars, resize, the **settings popover** — units, Figma's snapping grids, loop —, the **layer bar's drag and scale handles**, lanes **scrolling with the layer column**, a Position / Scale row's Combine / Split, a consistent read-only view for Dev Mode), the **Easing editor** (Figma's list, the **200 × 200 bezier editor** with its handles and corner resets, the **spring curve** with its bounce handle, the **hover preview**), the diamonds beside Design's fields, the Motion / Path trim / Animations / Audio / **Text stagger** sections, the motion path and the anchor point tool on the canvas, the **Motion icon in animated frames' titles**, the **style hover preview** on the canvas (8c / 8d, 8i, 8j; §6.10–§6.12); **comments with a time** — the playhead kept, pins near it, the time on the thread, markers on the ruler (8j; §6.8, §6.12); the Position / Scale **XY vs X / Y exclusivity enforced on writes** (8j); **EASING and TIMING variables** — types in the Variables panel, values edited there, a keyframe's easing and a clip's Delay / Duration / Easing bound to them, played in the layer's modes (8i; §4.7, §6.7, §6.11); presets and composite styles with the `figma:motion` runtime, and **custom (user) animation styles** made from a layer's clips, applied, updated (**reaching the layers they're applied to**) and deleted (8h, 8i, 8j; §5.4, §6.11, §6.12); audio (import, playback, edits) and animated export — MP4 / WebM with audio, GIF, animated SVG, Lottie, dotLottie, the settings on the layer — Lottie and the SVG now writing **the timeline's own keyframes with their bezier easings** (Lottie also the motion path's tangents) for layers animated by manual keyframes, samples for the rest (8e, 8i; §7.8, §7.9, §6.11); Ping-pong keyed there and back (8j); the prototype player's timelines and Play / Pause / Toggle / Set playhead actions (atlas 13 §14), the Prototype panel's custom bezier / spring on the Easing editor's graph (8j); the agents' motion tools, the Plugin API's Motion — custom animation styles and `{type: "CUSTOM"}`, easings bound by `VariableAlias`, `save_animation_style` for agents (8j) —, Dev Mode's Motion tab and the `.fig` round trip (8f, 8j; §9.1, §6.12).

**Remaining** (none blocks Social's agent): text stagger's clip / origin / blur — **blocked**: `TextElementDelayBehaviour` 5–7 are named in `research/rea/motion.md` without their declarations, and the schema parity check reads the 106 dump; in the vector exports, springs (no bezier holds one), presets' clips, X / Y tracks at different times and curved paths in the SVG (all sampled, exactly), Hold or curved paths in Ping-pong, and WIDTH / HEIGHT / corner radius reshaping paths (needs per-frame shapes from the engine); the spring editor's ω₀ / Duration handle in Motion (springs play normalised; the Prototype panel keeps its physical fields); the custom styles' order / folder API and their consumers; `timingDisplayUnit` in the Timing cell; REST motion fields; the native bench cases; **needs Figma**: Figma's own composite styles (probe 5.10) and the signed-in capture of Figma's Motion UI (§12) — every [unverified] look and wording (the comment markers, the ±250 ms window, the preview's play-once) stays ours until then.

**For Social:** an agent can read a frame's motion, write keyframes on any public field, add presets and composite styles, set the duration / playback / fps, put audio on the timeline and export MP4 / WebM / GIF / SVG / Lottie into its folder — all through the `designer` MCP tools in Figma's Plugin API shapes, each chat turn one undo step. The editor side of Motion is complete to the contract; what remains is the list above.

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

**Ours, in Figma's shape** (built 2026-10-18, round 8h: §5.4):
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
- **Gestures map to motion fields**: move → TRANSLATION_XY; the rotate handle → ROTATION; the resize handles → WIDTH / HEIGHT, as the panel's W / H (decided 2026-10-17 for increment 2, §5.2; the 2026-10-12 line said SCALE_XY [unverified: Figma may scale]); the panel's W / H → WIDTH / HEIGHT. Without a track and with auto-keyframe off they edit x / y / rotation / size as in Design.
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

Built 2026-10-18 (round 8e, §7.9). `audioFills` on the root: `AudioFill {id, mediaHash (SHA-1 of the file in the file's image store, as videos), timelineOffsetUs, startTimeUs (trim into the file), durationUs (the region's length), volume 0–1, mute, displayName, loopEnabled, playbackDurationUs, trackId, loopPhaseOffsetUs}`; `audioTracks {id, name, gain, mute}` are the rows (one row per dropped file by default). The engine stores and edits them (commands 345–348); TypeScript plays and mixes them (§6.6, §7.4). The prototype player does not play audio in this round [Figma unverified]. Agents generate sounds locally and place them as these clips (§9.3).

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

**As built — increment 2** (2026-10-17, engine only; `MotionCommands.cpp`, `tools/Gestures.cpp`, tests `r8.motion_edit.test.cpp`, 6 more cases):
- **Gestures keyed** (§4.9): a move, a resize from any handle, the rotate handle and a nudge, while Motion is on, on layers under the root (never the root) when auto-keyframe is on or the layer — or a layer above it under the root — is animated (`Editor::motionGestureFor`); otherwise Design's gesture. The drag opens no transaction: each step is a preview write (`MotionLayer::preview`, the base remembered like the layer's own values), so the dragged layer follows the pointer from where the canvas shows it and every other layer stays at the playhead. Pointer-up (`motionFinishGesture`) is one undo step ("Move", "Resize", "Rotate"; a nudge "Nudge"): `motionKeyPose` puts the position into TRANSLATION_XY (or the X / Y pair a layer has instead), the rotate handle's turn into ROTATION (one layer turns about its anchor point, so no position key; several about the selection's centre, their positions keyed too), a new size into WIDTH / HEIGHT (a left or top handle keys the position as well) — each field when it has a track or auto-keyframe is on, with the first auto-keyframe's old value at 0 (`motionKeyAtPlayhead`, which the panel routing now uses too) — and what isn't keyed into the base, solved from M · T(o) · T(t) · L · T(−o) so the layer ends where the gesture left it. The base used to take the evaluated position (the owner's bug: a drag at 2 s left only the 0 ms Position keyframe and the layer jumped by the track's offset). Esc / blur / pointer-cancel drop the previews; a Design gesture's rollback applies the layer again. In Motion a move never reparents or reorders in a flow (the motion transform is visual only); ⌥-drag duplicates as in Design.
- **Ownership** (§4.2): `cloneTree` (Duplicate, ⌥-drag copies, Duplicate page, new variants), the paste's `create` and `detachOne` call `motionCopyTracks`: each manual track a copied layer's KEYFRAME expressions name is copied with its keyframes onto the internal canvas under new GUIDs, the parameter re-pointed at the copy and at the timeline of the root it lands under; a track found nowhere drops its parameter (the last one gone, the base is the binding again). `copySelection` carries the tracks and keyframes after the regions, as it carries brushes (`motionClipboard`), and a paste copies from there first (a cut, another file), else from the document. Copies dropped mid-gesture (⌥ let go, a variant copy turned instance) take their tracks with them. Preset parameters stay as they are (presets: 8h).
- **The anchor kept in place**: `MOTION_SET_ANCHOR` shifts the translation by (I − L)(o − o'), L = R · Shear · S at the playhead — every keyframe of the layer's manual position tracks, else the base `motionTransform` — in the same step [Figma unverified: it may let the layer jump]. Exact at the playhead; when L changes over time the layer keeps its place there and its path keeps its shape.

**Not in increment 2**: the corner radius, shape, gap and line-end handles and the Scale tool (K) still write the base in Motion mode (K → SCALE_XY is the candidate); a gesture whose selection spans roots or holds the root is Design's; the anchor's compensation over time when L is animated; the motion path dragged on the canvas (§6.4); the rest of increment 1's list.

### 5.3 As built — round 8a, increment 2 (2026-10-18; engine first, with the chrome each item needs; native tests `r8.motion_layer.test.cpp`, 6 cases; chrome tests `motion/__tests__/`)

- **Animated instances** (§4.3): `MotionLayer::apply` walks the root itself instead of `animatedUnder` — every layer under it, an instance's derived rows too, each evaluated with its **layer in the main's** bindings (`Hooks::sourceOf` = the editor's `derivedInfo_[row].source`) at its own local time: an INSTANCE whose main plays (`MotionIndex::plays`, rebuilt with the index: roots with animated layers, then the roots holding an instance of one, to a fixed point) moves its sublayers into the main's time — `localTime(τ − offset, the main's duration, the main's playback)` — with the offset of its `timelineAssignments` entry `{assignedTimelineId = its main, containingTimelineId = the timeline it sits in}` (`decodeAssignment`; absent = 0, `disabled` = its sublayers rest), so nested instances compose (the inner one's container is the outer's main). A top-level instance of an animated component is a root that plays its main. Overrides of an animated field on an instance are not read while Motion plays (motion is edited at the main, §4.1). **MOTION_SET_INSTANCE_OFFSET (341)**: the instance's entry for (its main, its root) written, the others kept, one "Move animation" step (`isLibraryCopy` and derived rows refused). The **timeline model** lists such an instance as one layer with `instance {offsetUs, durationUs = the main's, mainTimeline}` and its bar's extent (its sublayers not listed); the chrome drags the purple bar (`Timeline.tsx` `onInstanceDown`: frames, ⇧ to the playhead and keyframes; `MotionMode` wraps the drag in one `txnBegin` / `txnCommit`). The **resolved model** lists the sublayers (`node` / `path` = the row's "I…;…" id) with their keyframes moved by the offsets above them — the main's playback style is not unrolled there.
- **Layout at the playhead** (§4.5): `apply` now runs in four steps — what plays (1), each layer's fields over its base (2), **layout** (3), the motion transforms (4). A field whose row has `layout` (WIDTH, HEIGHT, paddings, gaps, grid gaps) puts the layer and its auto-layout / group parent into `Hooks::relayout`, which the editor runs as `Layout(host).run(dirty)` with a host of its own (`Editor::motionRelayout`, a local `LayoutHost`): `writeGeometry` is a `MotionLayer::preview` write, `resizedInTxn` / `base` answer from the layer's remembered bases (constraints act on a frame the layer resized), text is measured by the editor's own `measureText`. Siblings move and hugging frames grow as Figma's do; the motion transforms then compose over where layout left each layer (visual only, nothing lays out after them). Nothing reaches the base, the journal, undo or `DOCUMENT_CHANGED`; `restore()` puts it all back. `apply` now always restores first (the values are a function of document and time). Layout itself (`layout/`) is unchanged.
- **Path trim** (§4.13): `geom::trimPath` (`geometry/Path.cpp`) cuts each contour to [start, end] of its arc length (32 samples of t per segment; curves split exactly with `cubicSection`, quads raised to cubics); a closed contour stays whole and closed for [0, 1], wraps through its start for start > end, and is dropped for start = end; an open one keeps [min, max]. `TrimmedContour` says which piece came from which contour and whether it keeps its own ends, so `NodeGeometry` gives a cut piece the node's cap and keeps an arrowhead where the end is the path's own. `pathTrimOf(props)` reads `extra.pathTrim` (x = start, y = end; absent or [0, 1]: nothing). `GeometryCache::build` trims the **stroke's centre line** — where the stroke is CENTER or the path is open (Figma: center strokes only) — and hashes the field with the alignment; fills are untouched. Both backends draw it (the renderer's SDF path for rectangles and ellipses steps aside for a trimmed centre stroke, `Renderer::drawStrokePaints`), and so do SVG / PDF (`export/Scene.cpp strokeOf`) and hit-testing, all from the geometry. The motion layer writes PATH_TRIM_* (and the grid gaps) as `F_EXTRA`; `restore()` now removes an `extra` key the layer added (Document::apply merges `extra`, so a pathTrim the base lacked stayed behind). `readNodeFloat` reads PATH_TRIM_* (so MOTION_ADD_KEYFRAME takes them), and `motionRouteWrite` routes the panel's whole `pathTrim` write: each end moved from what the canvas shows becomes a keyframe at the playhead when it has a track (or with auto-keyframe on); an end that isn't keyed goes to the base with the other end's base value; nothing moved, nothing is written. **Chrome**: `motion/panels/PathTrimSection.tsx` — in Motion mode after Stroke, for a selection that strokes: "Path trim" with Start / End (0–100 %, `MotionField` diamonds PATH_TRIM_START / _END), "Path trim only applies to center strokes." when one isn't.
- **Static exports and thumbnails at base values** (§3.4, the owner's answer 2): `engine_export`, `engine_export_info`, `engine_render_thumbnail`, `engine_render_node_thumbnail` and `engine_render_region` hold `motionSuspended()` for the call (before, a PNG exported or a file thumbnail taken in Motion mode drew the playhead's values; the canvas plays on after). **Exports at time t** for any layer (§7.2): `motionTimeUs` in the export settings [ours] draws the first ref's timeline root at that time (`ExportAtTime`, the view state put back) — `Engine.exportNodes(refs, settings, {motionTimeUs})`, `exportInfo(…, {motionTimeUs})`; the Animated tab's frames stay `engine_motion_render_frame`'s.
- **The canvas** (§6.4): with Motion on and one layer under the root selected, `Editor::motionOverlay` gives the renderer's overlay `motionDots` (one per frame of the timeline's snapping rate between the first and last position keyframe — TRANSLATION_XY or the X / Y pair's merged times — where the anchor is at that time: `M_layout · (o + t)` of the base), `motionKeys` (a 7 px square per keyframe, filled at the playhead) and `motionHandles` (a curved keyframe's in / out handles); hidden while moving and with `showMotionPath` off. `MotionLayer::poseAt` folds a layer's MOTION_* tracks at a time (literal bases; an alias base reads as `motionTransform`). **The anchor point tool** (`Tool::ANCHOR_POINT`, now implemented; while Motion is off it shows no target and a press is Move's, and Motion leaving puts Move back): the overlay's target (a ring, a cross and a dot) at the selected layer's anchor; a press within 8 px drags it (`Gesture::MotionAnchor`, a view state; snapped within 6 px to the box's corners, edges' middles and centre as drawn, ⌃ free), let go is MOTION_SET_ANCHOR with its place in the layer's box in percent (the layer kept in place, increment 2's compensation), a click writes nothing; a press elsewhere goes back to Move and is Move's. Chrome: **Edit anchor point** (`24.anchor-point`) in the Motion section's header and `motion.anchor-point`; ⌥R stays `object.rotation-origin`'s key, which hands over to it in Motion (Design's and Draw's rotation origin unchanged). Looks [unverified].
- **Touched outside motion/** (small hooks): `geometry/Path.{h,cpp}` (`trimPath`), `geometry/NodeGeometry.{h,cpp}` (`pathTrimOf`, the trimmed stroke, its key), `render/Renderer.cpp` (the SDF stroke's exception), `render/Renderer.h` / `Overlay.cpp` (the motion overlay), `export/Scene.cpp` (the primitive's exception), `export/ExportApi.inc` / `api/Api.cpp` (the suspends, `ExportAtTime`), `tools/Gestures.cpp` (the anchor tool's press, drag, drop, cancel), `editor/Editor.{h,cpp}` (the hooks, the tool), `panels/design/DesignPanel.tsx` (one line) and `shared.ts` (`pathTrim` on `ExtraFields`), `commands.ts` (⌥R in Motion). Layout and components code is not changed.

**Not in increment 2** (next): **text stagger** (§4.10: glyph grouping and per-element transforms in `render/` and `text/`, the TextStagger preset), **audio** (§4.11, §6.6: the commands 345–348, the Audio section, playback and the export's mix), `motionShapes` for Lottie (§7.6), the motion path's squares and handles dragged on the canvas, the auto-keyframe handle, the anchor's compensation when rotation or scale is animated, layout during a gesture's previews (a resize drag in an auto-layout frame moves its siblings only at pointer-up), overrides of animated fields on instances, the main's playback style unrolled in the resolved model, the Motion icon in frame titles, the player's timelines (§4.12), the native bench cases.

### 5.4 As built — round 8h, animation presets and styles (2026-10-18; engine and chrome; native tests `r8.motion_presets.test.cpp`, 8 cases; chrome tests `motion/__tests__/presets.test.ts`, `presets.wasm.test.ts`, the timeline's clip case)

- **The model** (§4.2, §4.6): a preset is an **ANIMATION_PRESET_INSTANCE** on the Internal Only Canvas — `backingAnimationPresetId 583` its type (`assetRef.key`: "opacity", "position"…), `timelineOffset 513` its start (**Delay is the start** [unverified: Figma may show Delay from somewhere else]), `timelineDuration 512` its length, `easingData 535` its easing, `timelineDisabled 543` its eye, its other props its `componentPropAssignments` (each keyed by a defID the TypeScript side names — sessionID 0, the FNV-1a hash of the prop's key, `editor/motion/presets.ts propId` — values NUMBER / BOOL / TEXT; the engine reads none of them) — listed in its layer's `animationPresets 521` (stacking order). Its materialised tracks are **its own KEYFRAME_TRACK children** (they go with it), bound to the layer's fields by ANIMATION_PRESET parameters placed after the other presets' and before the manual track (`[...presets, manual]`), in the clip's own time from 0. A composite style is a `styleIdsForAnimation 582` entry on the layer (`{id, timelineDefId, animationStyleId.assetRef.key, timelineOffset, generatedAnimationPresets}`; Figma's `timelineOffsetVar 7` isn't in our schema yet). No schema change.
- **The evaluator** (`Model.*`, `Evaluate.h`): `MotionIndex` decodes the presets (`motion::Preset`, `decodePreset`, `decodePresetList`, `MotionIndex::preset`) and gives each ANIMATION_PRESET parameter its clip's offset and off switch; `foldValue` plays a preset's track at τ − the clip's start and skips a disabled clip, so presets fold with manual tracks in list order (a manual SET track after them replaces their value, as Figma's fold does). A layer with presets only (even "New", which makes no track) is an animated layer. An XY field's placeholder literal base no longer hides the layer's `motionTransform` (a Position preset's OFFSET moves from where the layer rests).
- **The `figma:motion` runtime** (`src/shared/motion/runtime.ts`): `tween` (two keyframes at [pos, pos + duration], both eased; a negative duration throws), `animate` (a field's track, tweens merged, duplicate positions collapsed to the last — `collapsePositions`), `defineProperties`, `EasingType`; the output shape is `PresetOutput` (types.ts: tracks in µs and **public units** — a SCALE track's as multipliers — and an optional `textStagger`). **The first-party presets** (`src/shared/motion/presets/index.ts`, our code from §4.6's catalogue and defaults): Opacity (OPACITY × amount → 100 %, Fade out the other way, Custom start → end), Position (TRANSLATION_XY OFFSET, 200 px; a direction is the way the layer travels [unverified]; Custom start X / Y → end X / Y), Scale (SCALE_XY × 120 % → 100 %), Rotation (ROTATION OFFSET; a clockwise Rotate in turns from +180° to 0 — Figma's −amount → 0 in stored −radians), Size (WIDTH and HEIGHT OFFSET −50 → 0), Corner Radius (OFFSET 0 → 10, Round out 10 → 0), Path (SET: Draw the end 0 → 1, Erase the start, Travel a 10 % segment), Text (a typewriter: OPACITY held 0 then 1 per character / word / line, no overlap), Text stagger (§4.10's sub-animations — position on, top, 40 px; rotation, scale, opacity off — per element, 50 % overlap), New (no track). The custom types' Start / End props, `shownFor` / `shownWith` and `needs` (Path: strokes; Text, Text stagger: text layers) are ours [unverified]. **Deviation from §4.6 (kept):** the first-party presets run in the renderer, not the plugin sandbox (they are our own trusted code; custom presets will run the same module in the sandbox).
- **Commands** (`MotionCommands.cpp`; each one undo step): **MOTION_ADD_ANIMATION (336)** "Add animation" — a clip per layer at the playhead (or `startUs`), Figma's 0.5 s / Ease out unless given, its `output` materialised in the same step; `created` the clips. **MOTION_SET_ANIMATION (337)** — type, name, props, start ("Move animation" alone), length ("Change animation duration" alone), easing, eye ("Edit animation"); a new `output` replaces the tracks (the chrome runs the code again on a prop or type change), else a new length stretches the tracks about the clip's start (the tweens span the clip, so that *is* the code run again) and a new easing goes on their keyframes. **MOTION_REMOVE_ANIMATIONS (338)** "Remove animation" — the clip, its tracks and parameters (the last one gone, the base is the field's binding again), its place in the layer's list and in its styles (an emptied style entry goes). **MOTION_APPLY_STYLE (339)** "Apply animation style" — the style's presets (expanded by the TypeScript side, each with its offset from the style's start and its output) on each layer and one style entry naming them; `{detach}` "Detach animation style" forgets an entry, its presets kept. **MOTION_SET_PRESET_TRACKS (352)** — a clip's tracks replaced by an output (a step of its own, or inside the chrome's). **MOTION_SET_EASING** on a clip eases its keyframes too; **MOTION_RETIME_LAYER** moves and stretches the layer's clips with its keyframes.
- **Ownership** (§4.2): deleting a layer removes its clips (`motionTracksOwnedBy` names them, `motionRemoveTrack` takes a clip whole); duplicate / ⌥-drag / paste / detach copy each clip with its tracks (`motionCopyPreset`), re-pointing the layer's list, its styles' generated lists and the parameters; the clipboard carries the clips (a cut or a paste in another file keeps them). MotionCommands' `guidOf` now reads a GUID read back from `extra` ({sessionID, localID}) too — `MOTION_SET_INSTANCE_OFFSET`'s entries for other timelines were not recognised before.
- **Text stagger** (§4.10; `motion/TextStagger.{h,cpp}`): `groupElements` (CHARACTER, CHARACTER_NO_WHITESPACE, WORD, LINE, PARAGRAPH from the laid-out glyphs; spaces between words or lines belong to no element; each element's box its glyphs' advances over their lines), `staggerRanks` (LEFT_RIGHT, RIGHT_LEFT, CENTER_OUT by distance from the middle — equal distances together —, RANDOM a permutation seeded by the node's GUID), `staggerTiming` (one element's g = D / (1 + (m − 1)(1 − overlap)) of the clip's D, step = g (1 − overlap), m the order's slots [ours; probe 5.12]). A preset output's `textStagger` on a TEXT layer writes the **instance's own** `textElementDelayBehaviour` (enabled, grouping, delayMs = the step, order) and scales its tracks to g, counting the text's elements as laid out then (a later text edit keeps the old step until the clip is edited) — on the instance, not the text [deviation from §4.10: Figma's preset returns the behaviour with its tracks; so the text's other animations don't stagger]; a stretched clip stretches its step. The motion layer plays a TEXT layer's staggered parameters per element (`Hooks::textLayout`): each element folds them at τ − rank × step over identity bases, moved / turned / scaled about its own box's centre and faded by its own opacity, kept as `TextElementPoses` (`MotionLayer::textElements`); the text's own box and opacity stay, its props are written again as they are so the canvas draws it again. **Small hooks outside motion/:** `render/Renderer.h` (`TextLayouts::textElements`, default none; the text's ink grows by the elements' reach), `render/TextRender.cpp` (each glyph drawn with its element's transform and opacity, the shader-fill path too), `editor/Editor.{h,cpp}` (the override and the hook). Not built: `clipContent` and the per-element transform origin (schema fields 5–7 aren't in our schema), the blur sub-animation (the preset's one LAYER_BLUR), Dev Mode / SVG's per-element code.
- **Reads**: the timeline model's **clips** (`{id, preset, name, startUs, durationUs, disabled, easing, props by defID, style {id, key}}`, in stacking order; the layer bar spans them); the resolved model gives a preset's keyframes in root time (its clip's start added, a disabled clip left out; values as the track holds them — a SCALE / OFFSET track's relative to the base); the diamonds count manual tracks only (a preset's tracks are its clip's).
- **Chrome**: **Animations** section (`motion/panels/AnimationsSection.tsx`, in Motion mode after the Motion section): **+** lists Figma's catalogue with its glyphs (`24.animation-*`; Path / Text / Text stagger disabled where they don't apply) and adds at the playhead; the **Animations** button (`24.styles`) lists the composite styles (`ANIMATION_STYLES` [unverified, ours until probe 5.10]: Fade in, Fade out, Slide in, Slide out, Scale in, Scale out, Spin in, and Text enter / Text exit for text layers); one row per clip of the selected layer (glyph, type, the style's name, Detach, eye, remove); a row opens its settings — Animation (the type), the type's props as `shownFor` / `shownWith` say, Delay and Duration in ms, Easing (the Easing menu). `editor/motion/presets.ts` runs the code and calls the commands (`addPreset`, `editPreset`, `removePresets`, `applyStyle`, `detachStyle`; `Engine.runMotionCommandCreating`). **Timeline**: a clip row under its layer before the property rows — a bar with the type's name from its start for its length, click selects it (`ui.motion.selectedClip`, shared with the section, which opens its settings), drag moves it, its side handles change its start or its length (frames; ⇧ the playhead and keyframes), Delete removes it; MotionMode wraps a drag in one step. The timeline's rows now fill the layer column's width.

**Not in 8h** (next): the hover preview of a style on the canvas (Figma's, verified for Text enter / exit), Delay / Duration / Easing bound to TIMING and EASING variables (`varValue`), custom (user) animation styles (`styleAnimations 580`, the sandbox), the preset clip's easing opened from the timeline (it is in the settings), text stagger's clip / origin / blur and its codegen, presets in the prototype player (§4.12, with the rest of the player's timelines), the plugin API's `animationStyles` / `applyAnimationStyle` (8f's), Figma's own composite styles and Delay's meaning (probes 5.10, 5.12).

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
- **Segments**: the line between two keyframes of a row, its easing glyph at its middle; hover highlights; click selects it (⇧ adds) and the right panel shows its **Easing page** (§6.14, corrected 2026-10-19 from Figma: nothing floats over the canvas) — in Social too since the same day (§6.14 "Every easing on the page").
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

A comment placed in Motion mode records the playhead: `CommentAnchor.timeMs` (§10); its pin shows only while the playhead is within ±250 ms of it [unverified] and the thread shows the time ("0:01.250"); clicking the time jumps the playhead. Server: migration **0026_comment_time.sql** (built in 8j, §6.12; 0017 had been taken) (`ALTER TABLE comments ADD COLUMN time_ms INTEGER`), `server/src/comments.ts` reads / writes it, the local store too.

### 6.9 Commands and menus

`view.switch-to-motion`; in Motion: `motion.play-pause` (Space), `motion.toggle-auto-keyframe` [no Figma shortcut known], `motion.add-keyframe`, `motion.anchor-point` (⌥R), `motion.split-audio` (⌥K), `motion.next-frame` / `prev-frame`. Canvas menu in Motion: Add keyframe ▸ (fields), Remove animation, Mute audio on audio. Design's canvas menu item **Add motion** (Figma's, listed and disabled today, `docs/editor.md` 642) switches to Motion with the layer selected.

### 6.10 As built — round 8c / 8d, increment 1 (2026-10-17; `src/renderer/src/editor/motion/`, tests `motion/__tests__/` — 15 cases on fixed models, since the committed wasm predates Motion)

- **Mode** (`devmode/devMode.ts`, `uiStore.ts`, `commands.ts`, `menus.ts`, `canvas/BottomToolbar.tsx`): `ui.mode = "motion"` with `ui.motion` (`MotionUIState`: playhead µs, playing, auto-keyframe, collapsed, selected keyframes, unit); the toolbar's Motion segment and View › **Switch to Motion** toggle it (the Beta tag is not drawn yet); `syncEngine` pushes `setMotion({on, root: null, timeUs, autoKeyframe})` on every mode change (guarded: a wasm without the Motion exports leaves the chrome on its own state); leaving Motion stops the clock. Commands `motion.play-pause` (Space, Motion only), `motion.toggle-auto-keyframe`, `motion.collapse-timeline`.
- **Shell** (`MotionMode.tsx`): mounted by `EditorApp` after the shortcuts panel; `<section data-motion-timeline="open" | "collapsed">` docked along the bottom — `EditorApp.module.css` lifts the panels and the toolbar by `--ds-size-motion-timeline` (240) / `--ds-size-motion-timeline-header` (40), as the shortcuts panel does. The model is `engine.motionTimeline()` re-read on `MOTION_CHANGED`, the store's `selection` / `structure` / `undo` topics; the clock (`clock.ts`: rAF, wall time × 1, ONCE stops, LOOP wraps, Ping-pong reverses, pause keeps the playhead) drives `setPlayhead`, which pushes `setMotion({timeUs})` each frame. A keyframe drag and the duration handle run inside `txnBegin` / `txnCommit` (one undo step).
- **Timeline** (`timeline/Timeline.tsx`, a pure view of `TimelineModel` with callbacks; `timeline/maths.ts`: the 18 px origin, `fitScale`, the ruler's 10 ms … 10 s label steps at ≥ 56 px, frame snapping at the timeline's fps, ⇧-snapping to the playhead and the other keyframes within 8 px, `formatTime` / `parseTime` in ms, s and frames, `layerExtent`): the header (Play / Pause, Toggle auto-keyframe — red, with the red bar over the timeline and a red playhead —, Current time / Duration fields, Playback cycling Loop → Once → Ping-pong with `24.loop` / `24.play-once` / `24.ping-pong`, Collapse layers, the root's name, the zoom slider, Collapse timeline); the layer column (the Layers glyph and name, a chevron, the property rows under it; an animated instance one purple bar); the track area (the ruler scrubs; the layer bar; 16 × 16 diamonds — click selects, ⇧ adds, double-click moves the playhead and selects the layer, a layer row selects all its keyframes, a property row its own; drag moves the selection together, snapped, `MOTION_SET_KEYFRAMES`; Delete → `MOTION_DELETE_KEYFRAMES`, or `MOTION_DELETE_TRACKS` for a selected property row; the segment between two diamonds, dashed for Hold, opens the Easing menu for its end keyframe → `MOTION_SET_EASING`; the playhead; the duration handle → `MOTION_SET_TIMELINE`; past the duration dimmed; ← / → a frame, ⇧ ten, Home / End, Space; ⌘ / Ctrl + wheel zooms). Dark in both themes (`data-theme="dark"`, like the shortcuts panel) [unverified].
- **Easing** (`easing/EasingEditor.tsx`, removed 2026-10-19 — §6.14): a `Popover` with the Bezier | Spring switch and Figma's list — Hold first, then the curves, no dividers; springs only while the current easing is a spring — each row with a curve preview; Custom bezier takes "x1, y1, x2, y2" in a field, Custom spring its Bounce. `EasingMenu` is the same popover in this increment.
- **Right panel** (`panels/MotionSection.tsx`, `panels/KeyframeDiamond.tsx`; `DesignPanel` shows it first in Motion mode): a **Motion** section with Opacity, Corner radius, Stroke weight, Width, Height, Position, Rotation, Scale, each with its diamond from `motionFieldStates` (none / a track / a keyframe at the playhead; a mixed selection: a keyframe when every node has one, a track when any has one) and the field's current value; the diamond runs `MOTION_ADD_KEYFRAME` at the playhead or `MOTION_DELETE_KEYFRAMES`.

**Not in increment 1** (next, in §6's order): the Motion Beta tag; the timeline settings popover (units, grids), the top-edge resize, marquee selection, ⌘C / ⌘V of keyframes, the layer bar's drag and scale handles, clips (presets) and audio rows, the read-only mode for Dev Mode; the 200 × 200 bezier editor, the spring curve, the hover preview, the EASING variable binding, the prototype context; the diamonds beside Design's own fields (fills, strokes, effects, layout), the Transform section with the anchor point, Path trim, Animations, Audio; the canvas overlays (§6.4); comments with a time (§6.8); the rest of §6.9's commands and the canvas menu.

### 6.10 As built — round 8c / 8d, increment 2 (2026-10-17; chrome only, no engine change; tests `motion/__tests__/` — 37 cases, `panels.wasm.test.ts` on the committed wasm, which has Motion since the merge)

- **The panels show the values at the playhead** (the owner's bug: at 3000 ms on `?editor&doc=motion` the logo showed but the Motion section said Opacity 0 %, and Design's X was stale). The engine was right — `readNodes` reads the live nodes, which hold the motion layer's preview writes (§5) — but the store's cache (`EngineStore.readNode`) only reads a node again after NODES_CHANGED / DOCUMENT_CHANGED name it, and preview writes send neither. `EngineStore.refreshNodes()` makes every cached read stale and tells every node listener; `pushMotion` (the playhead, auto-keyframe) and devMode's `syncEngine` (entering and leaving Motion: base values again) call it, and while Motion is on `watchMotionLayer` (motionState.ts) calls it after every DOCUMENT_CHANGED and MOTION_CHANGED (a commit re-applies the layer: a keyframe moved changes a layer the change doesn't name). Design's own fields (Position, Rotation, W / H, Opacity, Corner radius, Stroke weight) and the Motion section read the same store, so all of them show the evaluated values; `motionResolved` / `motionFieldStates` stay what they are (keyframes and diamonds — neither gives a value at t). Cost: one full JSON read per shown node per playhead move (~1 ms a frame for two selected layers, dev build). The Motion section's Position, Rotation and Scale rows stay blank: motion-only fields with no node prop to read until the engine gives the evaluated values.
- **Edits from Design's fields in Motion mode**: Opacity, the corners, Stroke weight and W / H already land on a keyframe through `motionRouteWrite` (a transaction reads base values, the engine routes the field). The engine routes no transform write, so X / Y / Rotation are routed in the chrome (`panels/motionWrites.ts`, `motionPerLayer`, used by `PositionSection` in Motion mode): a value typed, stepped or scrubbed is a change from the value shown (the live node, read before the transaction; Rotation's the short way across ±180); a layer with a Position (or its own X / Y) / Rotation track — or, with auto-keyframe on, any layer under the root — gets the keyframe at the playhead (MOTION_ADD_KEYFRAME without a value: the value there) moved by it with MOTION_SET_KEYFRAMES, the panel move turned into the layer's own axes (the motion transform sits under the layout transform, §4.5), in the edit's one undo step; auto-keyframe's first keyframe of a field keeps the value at 0, as `motionRouteWrite` does. Any other layer's base moves by the change.
- **Diamonds beside Design's fields** (`panels/MotionField.tsx`): in Motion mode X, Y (Position — or the layer's own X / Y track), Rotation, W, H, Opacity, Corner radius and Stroke weight wear a 16-wide diamond before the field (none / outline / filled, a click adds or removes the keyframe at the playhead). `DesignPanel` wraps its sections in `MotionFieldStates`: one `motionFieldStates` read for the selection shared by the diamonds and the Motion section.
- **The Motion Beta tag**: the mode switch's Motion radio's tooltip reads "Motion  Beta" (`EditorModeDef.badge`, the tooltip's `data-tooltip-badge`, the label then the tag in the bubble's secondary text; 84 × 24 here against the capture's 90 × 24).
- **Timeline** (`timeline/Timeline.tsx`): a drag over empty track area draws a marquee (the file browser's colours) selecting every diamond it touches, ⇧ adding to the selection; a click there still clears it. ⌘C / ⌘V in the track area copy the selected keyframes and paste them at the playhead (`keyframeClipboard.ts`): the copy is the editor's (per layer, per track, values and easings timed from the earliest), the paste is MOTION_ADD_KEYFRAME per keyframe with its value and easing (`MotionCommandArgs` gains `easing`, which the engine already read) in one "Paste keyframes" step — onto the selected layers when the copy came from one layer, else back onto its own layers; the engine's MOTION_PASTE_KEYFRAMES stays unbuilt. The track area's clipboard events stop there, so the document's copy / paste of layers doesn't run. The top edge (an 8 strip) resizes the timeline between 120 and 60 % of the window [unverified]; the height is `ui.motion.height`, put on the editor as `--ds-size-motion-timeline` so the panels and the toolbar lift with it.

**Not in increment 2** (next): the evaluated values of Position / Rotation / Scale in the Motion section (needs an engine read), routing for X / Y / Rotation in the engine (`motionRouteWrite` — the chrome's routing can go then), the diamonds for fills, strokes' sides, effects and layout's gap / paddings, the timeline's lanes scrolling with the layer column (a long model scrolls the names only), and the rest of increment 1's list: the timeline settings popover, the layer bar's drag and scale handles, clips and audio rows, Dev Mode's read-only timeline, the bezier and spring editors, the EASING variable binding, the Transform section, Path trim, Animations, Audio, the canvas overlays, comments with a time, §6.9's remaining commands.

### 6.11 As built — round 8i, finishing Motion (2026-10-18; engine and chrome; native tests `r8.motion_finish.test.cpp` (6 cases); chrome tests `motion/__tests__/easing.test.ts`, `keyframed.test.ts`, `finish.wasm.test.ts`, the timeline's round 8i cases, `editor/__tests__/variables.test.ts`'s Motion types)

- **The Easing editor** (`easing/EasingEditor.tsx` — removed 2026-10-19 for the Easing page, §6.14 —, `easing/CurveEditor.tsx`; the curves in TypeScript, `src/shared/motion/easing.ts`, the engine's maths): a **200 × 200 graph** over the list — the unit square in its middle (100 px a unit, y −0.5 … 1.5 so back curves and springs overshoot in view), the current curve; a **custom bezier's handles** dragged (x 0–1, y −0.5…1.5; each move `onChange(…, false)`, the release once with `true`), a click on a **corner point** puts its handle back (help: "the corner points reset the curve"); a **custom spring** drawn as it plays (normalised over the segment, §4.7) with one handle at its first peak, dragged up and down for the bounce — Figma's height y = 2 − 2·ζ^0.87, here a quarter of it above the end value [ours: ω₀ has no handle in a normalised graph]. **The hover preview** [ours]: hovering a row shows its curve in the graph and runs a dot along a track under it with the curve as CSS's timing function (`easingCss`: cubic-bezier, `linear()` sampled for springs, `steps(1, jump-end)` for Hold). With `allowVariable` (the timeline's segments, the Animations section's Easing): **Apply variable** (the picker, Easing variables only), the bound variable's pill with **Detach**, and **Create variable** — the current easing saved as a new Easing variable in the file's first collection (or a new one) and bound at once.
- **EASING / TIMING variables** (`model/variables.ts`, `panels/variables/ValueEditor.tsx`, `VariableCommands.cpp`): `VarType` gains **Easing** ("Easing curve or spring animation") and **Timing** ("Duration in milliseconds") — in the Create variable and type-filter menus, their glyphs `16.easing` / `16.timing`, no scopes [unverified]; an Easing value is the public `MotionEasing` stored as `easingValue` (`EasingData`, a custom spring physical), shown by its name (a custom curve's numbers too) and edited with the Easing editor; a Timing value is milliseconds in `floatValue`, edited as a number in ms (`timingDisplayUnit` isn't shown yet). New ones: Ease out / 500 ms [ours: Motion's preset defaults]. The engine's CREATE_VARIABLE / SET_VARIABLE_VALUE take both (EASING from the public shape), DTCG export writes a Timing as a `duration` and an Easing as a `cubicBezier` [ours; a spring as linear].
- **Bindings** (`motion/Model.*`, `MotionCommands.cpp`): a **keyframe's easing** binds through its own `parameterConsumptionMap` EASING_DATA alias (Figma's, rea §2.9; MOTION_SET_EASING / ADD_KEYFRAME / SET_KEYFRAMES with `{variable}`; a value unbinds; its easingData stays as written); a **clip's Delay, Duration and Easing** through `componentPropAssignments` holding only a `varValue` alias on those props' defIDs (`presetPropId`, the TypeScript `propId`; MOTION_SET_ANIMATION `variables`, null unbinds; replacing the props keeps them). `MotionIndex::rebuild` takes a **Resolver** — the editor resolves each alias for the animated layer (its modes; `resolveValue`'s OTHER for an EASING literal) — and rewrites only its decoded copy: the keyframe's easing; the clip's start, its tracks' times stretched from the stored length, their easing. Every commit rebuilds, so a page switched to another mode, or a variable edited, plays at once (Figma: "switching a page's mode updates every animation that references them"). The timeline model gives `easingVariable` per keyframe and `variables` per clip; their values are the resolved ones. The Animations section binds Delay / Duration (**Apply variable** beside each, the bound pill, Detach keeps the value the clip plays now) and Easing.
- **The timeline** (`timeline/Timeline.tsx`, `TimelineSettings.tsx`, `maths.ts`): the **settings popover** (the gear after the time fields) — **Units** ms / frames (`ui.motion.unit`), **Snapping** Figma's grids per unit (ms: 100 / 50 / 10 ms and Off — 1 ms [ours]; frames 60, 30, 29.97, 24, 23.976, 12) or a typed one (ms → 1000 / ms fps, 1–1000; fps rounded, 1–120) → MOTION_SET_TIMELINE `snappingFps`, **Loop** Once / Loop / Ping pong (Ping pong disabled with audio). The **layer bar** drags all the layer's keyframes and clips (MOTION_RETIME_LAYER `deltaUs`) and its side handles scale them about the other end (`scale {factor, pivotUs}`), snapped as keyframes are, each frame's change on top of the last, one "Move animation" / "Change animation duration" step. The **lanes follow the layer column's scroll** (the rows translated by its `scrollTop`; the playhead, the past and the duration stay over them; a plain wheel over the lanes scrolls the column) — the long-model bug. A Position / Scale row's context menu **Combine tracks** / **Split tracks**. A segment bound to a variable says "Easing variable" and is tinted. **Read-only** (Dev Mode's view) keeps play, scrub and zoom: no resize edge, settings, Playback cycle, segment menus (drawn, disabled), layer-bar or duration drags.
- **Engine commands** (`MotionCommands.cpp`): **MOTION_SET_TEXT_STAGGER (344)** "Edit text animation" — a TEXT layer's own `textElementDelayBehaviour` (enabled, grouping, order, delayMs ≥ 0; what isn't given kept) makes its **manual** tracks play per element (`AnimatedNode::stagger`, the motion layer's step 5), or edits a text preset clip's; the right panel's **Text stagger** section (`panels/TextStaggerSection.tsx`, Motion mode, one text layer with keyframes: + / −, Grouping, Direction, Stagger in ms). **MOTION_PASTE_KEYFRAMES (349)** "Paste keyframes" — the copy's tracks at `atUs` on each layer's same fields (upserted by position); the chrome's ⌘V now runs it (one command per target inside the step). **MOTION_COMBINE_TRACKS / MOTION_SPLIT_TRACKS (350 / 351)** "Combine tracks" / "Split tracks" — X and Y into one XY track (a key at every time either has, x and y the tracks' values there, the X key's easing else the Y's) and back (path handles go: a split pair can't hold them).
- **The Motion icon** (`render/FrameTitles.*`, `Overlay.cpp`, `Editor::motionRebuild`): a top-level frame whose timeline plays wears the Motion mode's glyph (a diamond outline with a play mark) before its name — after a thumbnail's or a component's own glyph — in every mode; the index is rebuilt between gestures (the editor's tick) to follow the document outside Motion, the list kept on the editor (`motionTitleRoots_`, the overlay's `motionTitles`, the titles' hit-test).
- **Custom animation styles** (`presets.ts`, `MotionCommands.cpp motionCreateStyle`; §4.6's "custom styles need only the style node"): a **STYLE node of `StyleType.ANIMATION`** (7; the engine's enum gains it) on the internal canvas — a FRAME [ours: Figma's node type unseen] — whose `styleAnimations 580` lists **template ANIMATION_PRESET_INSTANCE children**: copies of a layer's clips without tracks (type, name, props, easing, length, start less the earliest clip's). MOTION_APPLY_STYLE `create {from, name}` "Create animation style", `create {from, style}` "Update animation style" (its templates replaced); applying runs each template's code for the layer and binds the style **by its GUID** (`animationStyleId.guid`; the timeline's clip `style.key` is that GUID). The Animations menu lists the file's custom styles after Figma's, **Create animation style** (from the selected layer's clips), and **Edit animation styles ▸ <style> ▸ Update from selection / Delete style** (DELETE_STYLE: the layers keep their clips); a clip row shows its custom style's name. Not in the generic style lists (`isStyleNode` keeps its four kinds).
- **Lottie and animated SVG write the timeline's keyframes** (`export/keyframed.ts`, `lottie/lottie.ts`, `svg.ts`): a layer animated by **manual** keyframes — Position (XY, or X and Y at the same times with the same curves), Rotation, Scale, Opacity — eased by **beziers or Hold**, with an orthonormal base transform, is a **keyed layer** when its keys, played back at every exported frame, land where the engine drew it (its samples, to 0.05 px; the motion part X = (L·T(o))⁻¹·M·T(o) compared): **Lottie** puts its anchor at the anchor point o, position L(o + t) per key with the segment's curve as `o` / `i` (one per dimension), Hold as `h`, the motion path's handles turned by L as `to` / `ti` (arc length, as the engine moves), rotation the base's turn plus the keyed one (clockwise: −Figma's), scale ×100, opacity × its ancestors' steady opacity; the **SVG** puts L·T(o) on the layer's group and CSS's individual `translate` / `rotate` / `scale` (and `opacity`) as @keyframes at the keys' times with per-segment timing functions (cubic-bezier, Hold `steps(1,end)`), the anchor undone inside. Everything else — springs, presets' clips, instances, text stagger, Ping-pong, curved paths in the SVG, layers the keys don't reproduce (layout moves, WIDTH animations) — stays sampled, so a file never plays differently from the canvas.

**Not in 8i** (the status's remaining list): comments with a time; custom styles and bound easings through the Plugin API / agents; a custom style's update reaching applied layers; the prototype context of the Easing editor; the XY / X-Y exclusivity on writes; text stagger's clip / origin / blur; the exports' keys for Ping-pong, springs and presets; `timingDisplayUnit` in the Timing cell.

### 6.12 As built — round 8j, closing Motion's list (2026-10-18; engine and chrome; native tests `r8.motion_close.test.cpp` (4 cases); chrome tests `comments/comments.test.ts`'s and the timeline's §6.8 cases, `plugins/__tests__/motion.wasm.test.ts`'s and `agentsMotion.wasm.test.ts`'s round 8j cases, `keyframed.test.ts`'s Ping-pong, `presets.wasm.test.ts`'s hover preview, `prototype.test.ts`'s graph, `finish.wasm.test.ts` adjusted; server `comments.test.ts`)

- **Comments with a time** (§6.8; `comments/commentsController.ts`, `CommentsLayer.tsx`, `Thread.tsx`, `timeline/Timeline.tsx`, `MotionMode.tsx`): a comment placed in Motion mode keeps the playhead (`CommentAnchor.timeMs`, whole ms; a moved pin keeps its time); in Motion a pin with a time shows while the playhead is within **±250 ms** of it [unverified] (the open thread always); the thread card shows its time ("0:01.250") beside "Comment" — clicking it switches to Motion and moves the playhead there; the **timeline's ruler** has a marker per thread of the page with a time (resolved ones while shown) — clicking one moves the playhead (the clock too) and opens the thread, centred. Server: migration **0026_comment_time.sql** (0017 had been taken), `server/src/comments.ts` reads and writes `time_ms` (0 … 24 h, rounded; a move without a time clears it); the local store keeps the anchor whole. [Marker and time chip look ours.]
- **Custom styles through the Plugin API** (`motion/publicApi.ts`, `plugins/api/motion.ts`, `runtime/figma.js`; Figma's figma-use-motion "Custom Animation Styles"): `figma.getLocalCustomAnimationStylesAsync()` (and the deprecated sync getter, refused under dynamic-page), `figma.createCustomAnimationStyle()` (an empty style), a style's `name` (writable; slash folders), `type` "CUSTOM_ANIMATION", `animationEntries` ({id, styleId — the entry's own —, name, duration, props with delay / duration / easing}), `addAnimationEntryAsync(definitionStyleId, props)` (Delay is the entry's place in the style; custom styles don't nest), `removeAnimationEntry(id)`, `remove()`; `node.applyAnimationStyle(id, {type: "CUSTOM", timelineOffset})` → the binding's id (strict: duration / props refused; a custom id without the type refused with the hint); `node.animationStyles` lists a custom style's clips as **one binding** `{type: "CUSTOM", id, styleId, name, timelineOffset}`, its array write keeps a binding by id (a new `styleId` or start applies it again **in place**: MOTION_APPLY_STYLE `binding`), leaves it out to remove it; `removeAnimationStyle(bindingId)`. Not built: `moveLocalCustomAnimationStyleAfter` / folders' order, `getStyleConsumersAsync` (empty, as the other styles').
- **Bound easings through the Plugin API and agents**: a keyframe's `easing` or a style's `props.easing` may be Figma's `{type: "VARIABLE_ALIAS", id}` of an EASING variable (checked: it exists and is EASING) — bound through the round 8i bindings; reads give the alias back. A custom style's entries keep values (variables bind on the layers' clips).
- **The agents' tools** (`agents/motionTools.ts`, `shared/agents/tools.ts`): **save_animation_style** — a custom style made from a layer's animations (`fromNodeId`) or from `entries` [{style, props}], its content replaced the same way (`styleId`), renamed, deleted; **apply_animation_style** takes a custom style by id or name; **get_motion** lists `customAnimationStyles`. The tools' timeline growth reads the layers' clip ends (`animationsEnd`).
- **An update reaches the style's layers** (engine `motionCreateStyle` / `motionReapplyStyle`): "Update animation style" (and the Plugin API's entry edits) carry the new content's runs (`create.presets`); every `styleIdsForAnimation` entry naming the style by GUID has its generated clips replaced at its start, its id and place kept — one undo step with the update. `create.templates` writes a style's content from runs (an entry's `id` keeps that template, so entry ids hold).
- **Position / Scale exclusivity on writes** (§4.5; `motionEnsureTrack`): a new X or Y track beside an XY one, or XY beside X / Y, is refused wherever a track is made (Add keyframe, paste, auto-keyframe routing writes the pair a layer has); Combine / Split remove before they make.
- **The Easing editor's graph in the Prototype panel** (`panels/prototype/InteractionDetails.tsx`, `model/prototype.ts` `prototypeCurve` / `easingFunctionOfCurve`): a Custom bezier's 200 × 200 graph with its handles over X1…Y2, a Custom spring's graph with the bounce handle over Mass / Stiffness / Damping — the handle sets damping for ζ = 1 − bounce, mass and stiffness kept, the settle time stored as before [ours: Figma's prototype spring editor maps ω₀ too]. The list stays the panel's Curve select.
- **Ping-pong in Lottie and the animated SVG** (`export/keyframed.ts` `pingPong`): a keyed layer's keys are checked on the timeline's own times, then written there and back — each key again at 2·D − t, each curve mirrored ((x1, y1, x2, y2) → (1 − x2, 1 − y2, 1 − x1, 1 − y1)). Hold and motion path curves in Ping-pong stay sampled.
- **The style hover preview** (`motion/stylePreview.ts`; the ds Menu's `onHighlight`; engine `motionInTxn_`): a style's row lit in the Animations menu applies it in an open transaction and plays it once from the playhead (setMotion `inTransaction`: the motion layer evaluates inside it — the engine restores it before any further write and clears the flag when the transaction ends); another row swaps it, the menu closing or a pick cancels it — never in the document or the history. While it plays, its clips show in the timeline and the Animations section (read from the open transaction) [ours]; a nested step inside the transaction puts the preview back when it ends.

**Not in 8j** (blocked or out of reach without Figma): text stagger's clip / origin / blur — `TextElementDelayBehaviour` 5–7 are named in `research/rea/motion.md` §2.6 / §2.19 but without their declarations (types, `transformOrigin`'s shape) and the schema parity check reads the 106 dump, which lacks them; springs and presets' clips in the vector exports (no bezier holds a spring; preset clips' tracks aren't in the timeline model's tracks); WIDTH / HEIGHT / corner radius reshaping exported paths (the shapes are sampled at rest — the engine's `motionShapes` would need per-frame paths); the spring editor's ω₀ handle in Motion; custom styles' order / folders API; REST motion fields; `timingDisplayUnit`; the native bench cases; the signed-in capture of Figma's Motion UI (§12) and probe 5.10 (Figma's own composite styles).

### 6.13 As built — Motion's chrome after Figma's captures (2026-10-19; engine overlay and chrome; references `docs/research/figma/live/owner-2026-10-18/figma-motion-*.webp` (the owner's captures, 1.32 px per CSS px) and `docs/research/figma/live/2026-10-18/motion.txt` (Figma web's DOM measured); side by side in `owner-2026-10-18/after/motion-*.png`; tests `motion/__tests__/timeline.dom.test.ts`'s property-row case, `maths.test.ts`'s Figma-wording case)

The owner (2026-10-18): Figma's gizmo and keyframe icons "sit much more nicely; ours look slapped on". Restyled and restructured to Figma's layout, behaviour kept; this replaces the look §6.2, §6.4 and §6.5 describe where they differ.

- **Canvas** (engine `Editor::motionOverlay`, `render/Overlay.cpp`, `OverlayStyle` `gizmo*`): the one selected layer under the root wears Figma's **transform gizmo** — a ring 33.5 px round (1.5 px, the selection colour; the same screen size at any zoom), white 8 px handles (corners 2) where it meets the layer's up and right axes, a green arrow up and a pink arrow right 20 px out of them (heads 6 × 5), a white centre dot — and **dotted guides** (2 / 2) from its box to the parent frame's left and top edges at the anchor. It is drawn only (no drag of its own yet); the anchor point tool (⌥R, the Origin button) still replaces it with its target. **No W × H badge** in Motion (Figma's captures; the angle while rotating stays). The motion path is unchanged (no Figma capture shows one).
- **Right panel**: the header reads **Motion · Beta** with the zoom (no Design / Prototype tabs). Sections in Figma's order: header, **Animations** (title white even when empty), Text stagger (texts), **Transform** (`motion/panels/TransformSection.tsx`, in place of Position: Position "X→ | Y↓ | ◇" — the anchor's place in the parent, as Figma's 333.5 / 277.5 —, Separate dimensions on hover (splits / combines the Position track), Scale "↔ | ↕ | ◇" read from the scale tracks at the playhead and written on the keyframe there (added when missing) with Unlock scale aspect ratio, Rotation "0° | ◇", the **Origin** button at the section's right), Layout, Appearance, Typography, **Fill** (a solid paint's row joined with its colour's diamond), Stroke, Path trim, Effects, **Audio**, Export. The old "Motion" list section is gone. **Every animatable field is a joined control whose last 24 × 24 cell is the diamond** (Figma's path, 8 px): outlined white with no track; the selected-secondary blue with a light-blue outline with a track or while auto-keyframe is on; filled light blue at a keyframe on the playhead (`MotionField`, `KeyframeDiamond`).
- **Timeline** (`timeline/Timeline.tsx`, `.module.css`): the panel grey (`--figma-color-bg`) with one 48 header row — over the 296 layer column Play, the keyframe button (Figma's diamond with a dot; filled salmon while auto-keyframe is on), the joined "1855 | 2000 | ms | loop" group (the current time zero-padded to four digits, the padding dim; the unit opens the timeline settings; Figma's Loop icon), Collapse layers at the column's right —, the ruler over the lanes (a 14 strip with a tick per label, labels "0s 200ms … 1s 500ms 2s": steps 10 / 20 / 50 / 100 / 200 / 500 ms … at least 80 px apart, the 17 × 14 scrub head of Figma's path), the zoom slider and the panel toggle in a 160 box at its right; the duration fits left of that box. Rows 24: a layer row's chevron (on hover) at 8, its Layers glyph at 32 and name at 56; property rows with the tree's lines, their name at 56, **‹ ◇ ›** (previous keyframe, add / remove the keyframe at the playhead — `onToggleKeyframe` —, next keyframe) and, while their layer is selected, the **value at the playhead** ("190.6, 246" — Position as the panel's X / Y —, "100%"). A selected layer's rows are lit (bg-selected / -secondary across the lanes), its bar the pressed blue with white grips, its keyframes filled light blue on blue lines; others grey bars with grips, outlined diamonds on grey lines. Past the duration the lanes darken. Tokens `--ds-size-motion-timeline-header` 48.
- **Still different** (why): the panel's header icons and the zoom slider's knob are the DS's, not Figma's (other components); per-row visibility toggles (Figma's DOM lists them at 265) are not built; the gizmo's handles and arrows don't drag yet (Figma's behaviour on drag unrecorded); the ruler's step thresholds are read from two captures only.

### 6.14 As built — the Easing page in the right panel (2026-10-19; chrome only, no engine change; references `docs/research/figma/live/2026-10-18/motion-easing.txt` (Figma web measured) and the owner's capture `owner-2026-10-19/figma-motion-easing-panel.webp`; side by side in `owner-2026-10-19/after/motion-easing-*.png`, shot by `src/renderer/src/editor/tools/motion-easing-shot.mjs`; tests `motion/__tests__/easingPage.wasm.test.ts`)

The owner (2026-10-19): "move the animation (easing) settings into the right panel like Figma". Figma has no floating Easing menu for keyframe segments: clicking a segment turns the right panel into an **Easing** page. This replaces §6.3's popover for the timeline's segments in Motion mode — and, later the same day, for every other easing editor (below: "Every easing on the page").

- **Timeline** (`timeline/Timeline.tsx`): each segment wears Figma's easing glyph at its middle — a 16 × 16 box (radius 5) with a curve (a step for Hold), blue, on the selected segment only (and under the pointer) — Figma's capture shows none on a lit row's other segments. A click selects the segment by its end keyframe (`ui.motion.selectedSegments`; ⇧ adds or removes) and its layer, and clears the keyframe, clip and audio selections; selecting keyframes, a clip or audio clears it, as does a selection without the segments' layers (`MotionShell`).
- **The page** (`easing/EasingPage.tsx`, `EasingGraph.tsx`, `easingMaths.ts`, `EasingPage.module.css`; `DesignPanel` shows it under the layer header in place of the sections, then **Audio**): Back (`24.chevron.left`, Figma's path) and the centred title "Easing"; the **preset select** (208 × 24, the preset glyph, the name — "Custom bezier" / "Custom spring", "Mixed" when the selected segments differ, an applied variable's name with Detach beside); **Curve | Spring** ("Easing type": switches to the other kind's custom easing); the **208 × 208 graph** — Curve: the curve white 1.5, the guides at 0 and 1, the playhead's place in the segment as a vertical guide, two blue handles with ring knobs dragged freely (x 0–1, y as far as the graph reaches; it refits on release: 0 and 1 at 164 / 44, an overshooting handle at 12 or 196 — the capture's 0.45, 1.45, 0.8, 1 measured to the pixel); dragging a named curve makes it a Custom bezier; Spring: Figma's svg geometry (time 23 → 185, the guideline at 104) with our normalised spring (§4.7, its length is the segment's) and the knob at the first peak dragged for the bounce —; the **value row**: Curve — the Bezier field "x1, y1, x2, y2" (`24.easing.bezier`, Figma's path; x clamped 0–1, y −2…3 [ours: a bound]) and **Flip curve** (`24.easing.flip`; end for end: Ease in ↔ Ease out, others custom); Spring — **Bounce** (0–1; `24.easing.bounce`, ours: Figma's icon not recorded).
- **Presets popover** (`easing/EasingPresets.tsx`): a DS Popover left of the panel, 8 over its edge as Figma's, level with the select, 232 wide, dragged by its header; header **Presets | Libraries** tabs, **+** "New variable" (the current easing saved as an Easing variable and applied), Close. Presets: Figma's rows for the kind (Hold … Ease in and out back, Custom bezier; or Gentle, Quick, Bouncy, Slow, Custom spring), 32 high, Figma's glyphs (the 4 × 4 dot grid, the curve sampled at 33 points; none for the custom rows), hover `--figma-color-bg-hover` (#383838), current `--figma-color-bg-selected` (#394360). **Libraries**: the file's and its libraries' Easing variables (Wecra's easing styles, `VariableList` filtered to EASING), the applied one ticked. Hovering a preset draws its curve in the graph with a dot tracing it (the hover preview [ours], kept).
- **Edits**: every selected segment takes the change (MOTION_SET_EASING on all their end keyframes); one undo step per change, a handle's or Bounce's drag inside one "Change easing" transaction.
- **Audio** (`panels/AudioSection.tsx`): with no clip selected the section is now its title and **+** (Figma's), adding audio files at the playhead as a drop does — on the layer page too.
- **Every easing on the page (2026-10-19, later the same day)** — Figma's help: a clip's easing opens the same Easing menu. The page's pieces are one component now, `EasingControls` (`easing/EasingPage.tsx`: the preset select + presets popover, Curve | Spring, the graph, Bezier + Flip curve / Bounce; `values` edited together, Mixed when they differ; `variables` off hides Detach, the Libraries tab and **+**), with `EasingFrame` (Back + "Easing") and `useEasingTransaction` (a drag's moves in one transaction, one undo step per change). Three more entry points use it and **the old floating popover (`EasingEditor.tsx`, `EasingMenu`, `EasingEditorProps`) is gone** — `createEasingVariable` lives in `EasingPage.tsx`, `easingOfType` / `easingMenuTypes` in `easingMaths.ts`; `CurveEditor.tsx` (+ `CurveEditor.module.css`) stays for the Prototype panel's Interaction details only:
  - **A preset clip's Easing** (`panels/AnimationsSection.tsx`): the clip settings' Easing field sets `ui.motion.clipEasing` and the Design panel shows the clip's page (`ClipEasingPage`, `useClipEasing`) under the layer header, then Audio; a change runs the preset again with it (`editPreset`, an EASING variable bound / detached as before); Back clears it and the Animations section shows the clip's settings again. Selecting segments, keyframes, another clip or audio, or a selection without the clip's layer, closes it (`MotionShell`).
  - **Social's timeline**: a segment selects it as in Motion (the timeline has no popover path left: without `onSelectSegments` a segment is drawn, not clickable); Social brings its right panel's Properties tab forward and its Design part shows the page (no Audio section there; `docs/social.md` §6.1).
  - **An Easing variable's value** (`panels/variables/ValueEditor.tsx`, the Local variables table and Edit variable): the value clicked opens a DS Popover titled "Easing" holding `EasingControls` without the variable binding (an alias stays the row's own "Apply variable"); each change is `setVariableValue` with `{ final }`, so a handle's drag is one "Edit variable" step [ours: Figma's own Easing variable editor was not captured — the panel's controls are the closest recorded form].
  - Tests: `motion/__tests__/easingPage.wasm.test.ts` (the clip page, Social's segment with Mixed and Back, the variable's value — each with no popover and one undo step), `timeline.dom.test.ts` (a segment selects, no dialog), `finish.wasm.test.ts` (New variable from the presets). Images `owner-2026-10-19/after/easing-{clip,social,variable}.png` (shot by `src/renderer/src/editor/tools/easing-entry-shot.mjs`, port 5318).
- **Still different** (why): the timeline glyph is one S curve for every bezier (Figma's capture shows the same S for a custom overshoot curve; other kinds unrecorded); Figma's curve graph is a canvas, ours an svg of the same geometry; Bounce's icon is ours; Figma's popover rows for springs and its Libraries tab contents were not captured. In Social's wider right panel (320 by default) the select and fields stretch while the graph stays 208 at the left; the Easing variable's editor is a floating panel of ours (Figma's not captured); its Popover focuses the Bezier field on opening (the DS's first-field focus).

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

**Not in increment 1** (increment 2, §7.9, built the settings on the layer, animated SVG, Lottie / dotLottie, audio in MP4 / WebM and the lock): the Animated tab's settings stored on the layer (`ExportSettings` 13–17), the Background choice, animated SVG (§7.5), Lottie / dotLottie (§7.6, `motionShapes`), audio in MP4 / WebM (§7.3), the one-export-per-file lock, the restricted-file gate beyond what Static already does (Animated reads `exportAllowed` too). Verified here only on the native build (the ABI's sizes, errors and restore) and on fixed frames (GIF bytes, the codec choice); the encoders need Chromium's WebCodecs — the Mac run.

### 7.9 As built — round 8e, increment 2: audio, audio in MP4 / WebM, Lottie / dotLottie, animated SVG, the settings on the layer (2026-10-18; engine `editor/MotionCommands.cpp` (audio), `editor/MotionExport.cpp`, `motion/Model.*`; chrome `editor/motion/audio/`, `editor/motion/export/`, `motion/panels/AudioSection.tsx`; native tests `r8.motion_audio.test.cpp` (5 cases), `r8.motion_export.test.cpp` (2); chrome tests `motion/__tests__/audio.test.ts`, `vector.test.ts`, `export.wasm.test.ts`, the timeline's audio case, `export.test.ts`'s settings case)

- **Audio in the engine** (§4.11): `motion::AudioClip` / `AudioRow` decoded from the root's `audioFills 603` / `audioTracks 605` (`decodeAudioClips`, `decodeAudioRows`). **MOTION_ADD_AUDIO (345)** "Add audio" — a clip `{id, mediaHash, timelineOffsetUs, startTimeUs 0, durationUs, volume 1, displayName, playbackDurationUs, trackId}` on a row of its own (one row per dropped file) unless `trackId` names one; **MOTION_SET_AUDIO (346)** "Edit audio" — a clip's offset, trim (`startUs`), length, volume (0–1), mute, row, and [ours] `tracks` edits (a row's name, gain, mute: the row's eye); **MOTION_SPLIT_AUDIO (347)** "Split audio" — the clip cut at `atUs` into two regions of the file, the second new (`created`); **MOTION_REMOVE_AUDIO (348)** "Delete audio" — a row left without clips goes with its last one. Only a timeline root takes audio (else E_INVALID). The timeline model lists `audioTracks` and `audio`. No schema change.
- **Audio in the chrome** (§6.6; `motion/audio/audio.ts`, `audioEdits.ts`): AAC, MPA, MP3, WAV (`.aac .m4a .mpa .mp2 .mp3 .wav`, ≤ 100 MB [ours]) dropped on the timeline (at the drop's time) or on a frame in Motion mode (at the playhead; `canvas/ImagePlacer.tsx`'s drop hands them over) are stored in the file's image store by SHA-1, decoded once per hash (`AudioLibrary`: buffers and waveform peaks, 100 per second) and added in one "Add audio" step. The **timeline**'s audio rows under the layers: the row's name and eye (mute), each clip a green bar with its waveform and name — click selects it (and the frame), drag moves it, its handles trim it within the file (`trimAudio`), Delete removes it, right-click opens Mute / Unmute audio, Split audio at playhead (⌥K), Delete; Playback skips Ping-pong while the timeline has audio. **Playback** (`AudioPlayer`): while the clock plays, the audible clips under the playhead are scheduled on an AudioContext (a source and a gain per clip: volume × the row's gain, nothing when either is muted) and again on every jump (a loop's wrap, a seek, a file decoded late); the AudioContext's clock is the clock's master while audio plays (`Clock`'s `master`); scrubbing and Ping-pong play nothing. **Audio section** (`AudioSection.tsx`, after Animations): Volume (slider and field, one step per drag) and Mute for the selected clip. **Commands**: `motion.split-audio` (⌥K), `motion.mute-audio` (checked when muted; in the canvas menu in Motion mode while the root has audio).
- **Audio in MP4 / WebM** (§7.3; `export/audioTrack.ts`): the clips over the exported span mixed in an OfflineAudioContext at 48 kHz stereo (`mixAudio`), encoded by AudioEncoder — MP4: AAC `mp4a.40.2` 128 kb/s, else Opus; WebM: Opus — and muxed with the video (mp4-muxer / webm-muxer's audio track). Nothing audible, or no codec the device takes: no audio track. Verified on fixed inputs (the codec choice); the encoders need Chromium.
- **The vector exports' engine reads** (`editor/MotionExport.cpp`; ABI `engine_motion_shapes`, `engine_motion_samples`; `Engine.motionShapes`, `motionSamples`): **`motionShapes(root)`** — the root's layers at base values, the root first (at the origin) and each layer after its parent, back to front: local transform, size, opacity, clipping, its fills (solid with the paint's opacity, linear / radial gradients by their two ends) and strokes as absolute path data in its own space (text as its glyphs' outlines), a centred or open stroke as its centre line with weight, cap, join, miter and dashes (otherwise its outline as an area), the full centre line of a path-trimmed stroke (the trim is the samples'); a leaf with an image, video, angular / diamond gradient, pattern, noise or shader paint, or a blur / grain / noise / glass / shader effect, and any layer holding a mask, is `rasterize`d with its placement (its base state's PNG, a static export). **`motionSamples(root, times)`** — each of those layers' local transform (the motion transform composed), opacity, size, path trim, solid colours and stroke weight at each time; the view state is put back. Types `MotionShapeLayer`, `MotionShapePath`, `MotionSample`, `MotionSamples` (types.ts; the contract's `image` field gave way to `raster`).
- **Lottie / dotLottie** (§7.6; `export/lottie/lottie.ts`, `dotLottie.ts`, `export/vectorAnim.ts`): Lottie 5.7 — a shape layer per layer with something to draw (`fl` / `gf`, centre strokes `st` / `gs` with `lc` / `lj` / `ml` / dashes, `tm` on a trimmed stroke), a null for one without, an image layer for a raster (base64 in Lottie, `images/` in dotLottie), parented as the layers are under a null that applies the Size; a clipping frame (not the root) is a precomposition masked by its box; opacity is each layer's own times its ancestors' in the composition (Lottie doesn't pass it down). dotLottie: our ZIP (deflate-raw JSON, stored images, CRC-32) with `manifest.json`, `animations/<id>.json`, `images/…`; several frames in one file. **Deviation (kept for now):** every animated value is the engine's samples at the export's frame rate, thinned to the frames a straight line between neighbours can't reproduce (linear keyframes) — presets, instance offsets, springs and stacked tracks come out as the canvas plays them, but the timeline's own keyframes with bezier tangents / `ti`-`to` motion path tangents / `h` holds aren't written as such.
- **Animated SVG** (§7.5; `export/svg.ts`): our writer from the same scene — a `<g id="n-<s>-<l>">` per layer nested as the layers are, its paths (gradients in `<defs>`, a frame's clip as a `<clipPath>` around its children, a raster as an embedded PNG), and CSS `@keyframes` for the layer's transform (as `matrix()`) and opacity and the path's colour, stroke width and path trim (`pathLength="1"` + dasharray / dashoffset); Loop / Ping-pong infinite (Ping-pong's way back is in the frames), Once once and held. **Deviation (kept):** matrices of the sampled frames rather than CSS individual transform properties with per-segment timing functions (the research's note that Figma writes SMIL `<animate calcMode="spline">` is not followed either). The static SVG writer (export agent's) is not touched.
- **The settings on the layer** (§7.1; `export/animatedSettings.ts`): the Animated tab's settings are one entry of the frame's `exportSettings` with Figma's fields — `imageType` MP4 / WEBM / GIF / LOTTIE / DOTLOTTIE or SVG + `svgAnimated 17`, the Size as `constraint` (CONTENT_SCALE, or a custom size's width / height), `frameRate 13`, `loopCount 14` (GIF: 0 loops, 1 once), `quality` (Low / Medium / High as 0.25 / 0.5 / 1 [ours]); the tab shows the first frame's, a change goes to every selected frame in one "Export settings" step. The Static rows leave the entry out (`model/exports.ts isAnimatedSetting`, `exportSettingsOf`) and keep it when they write (`Export.tsx writeSettings` → `writeKeepingAnimated`). `backgroundType 15` and `duration 16` aren't written. **One export per file**: a second animated export while one runs is refused and the tab's Export is disabled (`animatedExportRunning`).
- **Touched outside motion/** (small hooks): `canvas/ImagePlacer.tsx` (audio dropped on the canvas), `commands.ts` (`motion.split-audio`, `motion.mute-audio`), `menus.ts` (Mute audio in the canvas menu), `panels/design/DesignPanel.tsx` (the Audio section), `panels/design/Export.tsx` (the static write keeps the animated entry), `model/exports.ts` (`isAnimatedSetting`, `exportSettingsOf` filters it), `uiStore.ts` (`selectedAudio`), `engine/Engine.ts`, `EngineExports.ts`, `engine/api/exports.txt`.

**Not in 8e** (next): the timeline's own keyframes and easings written as Lottie / CSS keyframes (bezier tangents, motion path `ti` / `to`, holds), WIDTH / HEIGHT / corner radius animations reshaping the exported paths, per-element text stagger in the vector exports, drop / inner shadows in them, the Background setting (`backgroundType`) and `duration`, audio volume keyframes (`AudioParametrizedField.GAIN`), looping clips (`loopEnabled`), the waveform peaks cached across sessions (Figma: IndexedDB), audio in the prototype player, `videoFillPlayback` on the timeline, the plan limit (none, personal use). Verified headless on the motion demo (a WAV dropped on the timeline: its row, its bar, its menu; the Audio section); MP4 / WebM with audio, Lottie in a player and the SVG in a browser need the Mac run.

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

### 9.1 As built — round 8f: the agents' motion tools, the Plugin API's Motion, Dev Mode's Motion tab, the `.fig` round trip (2026-10-18; chrome only, no engine change; tests `editor/__tests__/agentsMotion.wasm.test.ts` (9), `plugins/__tests__/motion.wasm.test.ts` (4), `viewer/inspect/motionCode.test.ts` (4), `viewer/inspect/motionTab.wasm.test.ts` (3), `motion/__tests__/fig.wasm.test.ts` (1), `main/agents/toolFiles.test.ts` (2), `imageArgs.test.ts`'s audio case)

**Source for Figma's shapes (verified 2026-10-18):** Figma's own Plugin API guide for agents — the `figma-use-motion` skill shipped with Figma's MCP plugin (2.2.157): `manualKeyframeTracks` as an object (`{OPACITY: {id, baseValue?, keyframes: [{id, timelinePosition (s), value, easing}]}, fills: {0: track}, strokes: {…}, effects: {0: {RADIUS: track}}}`), `applyManualKeyframeTrack(field, track)` / `removeManualKeyframeTrack(field)`, `animationStyles` entries `{id, type "FIGMA" | "CUSTOM", styleId, name, duration, timelineOffset, props}`, `applyAnimationStyle(styleId, {duration, timelineOffset, props})` → the applied id, `removeAnimationStyle(id)`, `timelines` `[{id: the top-level frame's id, duration (s)}]`, `setTimelineDuration(id, s)`, `node.animations` (manual tracks only), `figma.motion.figmaAnimationStyles()` `{styleId, name, description, props}` with props as documentation strings; the public field allowlist and its units (TRANSLATION_* / ROTATION additive — rotation CCW + —, SCALE_* multiplicative, the rest absolute); the rules (no top-level frames; WIDTH / HEIGHT not on groups and vectors; `EASE_IN_AND_OUT`, never `EASE_IN_OUT`, and no internal names like `OUT_CUBIC`; the first keyframe holds back to 0, the last to the end); Figma's style ids "Opacity" and "TextStagger" (the internal "Text" typewriter isn't discoverable) and TextStagger's props (`positionEnabled` / `positionVisible`, `direction`, `distance`, `rotationEnabled`, `rotationDirection`, `rotationAmount`, `scaleEnabled`, `scaleAmount`, `opacityEnabled`, `opacityAmount`, `blurEnabled`, `blurAmount`, `textDelayGrouping`, `textDelayOrder`, `presetStaggerOverlap`, `animationDirection`), Opacity's `timing: "in" | "out"`.

- **One vocabulary** (`editor/motion/publicApi.ts`): Figma's shapes over the engine's commands and reads — `manualKeyframeTracks` (from the timeline model; a fill's opacity track, ours, isn't in the object and is kept on a whole write), `applyManualKeyframeTrack` (keyframes with an id it has edited in place by MOTION_SET_KEYFRAMES, the ones left out deleted, the rest added by MOTION_ADD_KEYFRAME; none: the track removed; `merge` for the agents adds and edits only), `setManualKeyframeTracks` (the tracks left out removed first, so an X / Y pair can become one XY track in one write), `animationsOf`, `timelinesOf`, `setTimeline` (duration, playback, snapping fps), the checks (`fieldFrom`, `valueFrom` — a bare number / {x, y} / {r, g, b} is read as the field's type —, `easingFrom`; Figma's refusals in its words: "Do not animate top-level frames…", "keyframe tracks must be either combined or separated", WIDTH / HEIGHT on a group, vector or boolean group), and the presets as Figma's "animation styles": one applied style = one preset clip (`id` the clip's, `timelineOffset` its start, `duration` its length, `props` its props with `easing`, `visible` its eye [ours]); `figmaAnimationStyles()` lists Opacity, Position, Scale, Rotation, Size, CornerRadius, Path, TextStagger (style ids beyond Opacity / TextStagger by the same rule [unverified]); `applyAnimationStyle` reads Figma's prop names where ours differ (TextStagger's `*Enabled` / `*Visible`, `direction`, `distance`, `rotationDirection`; Opacity's `timing`; `props.delay` adds to `timelineOffset`, `props.duration` wins over `duration`) and validates the rest against the preset's props; TextStagger's blur (not built) is refused. `presets.ts`'s `addPreset` / `applyStyle` take a start (and Add's length, easing, props) instead of always the playhead.
- **The agents' tools** (`src/shared/agents/tools.ts`, `editor/agents/motionTools.ts`, run by `mcpTools.ts`; seconds, Figma's public units; each write one transaction, so a chat turn stays one undo step): **get_motion** (a frame's timeline — duration, playback, fps —, each animated layer's `manualKeyframeTracks`, its `animations` (applied presets) and the composite styles they came from, the audio clips; `resolved: true` adds the resolved model in seconds), **set_keyframes** (one field's track on layers, replaced or `merge`d; the timeline grows to hold the last keyframe unless `extendTimeline: false` — Figma's guide: extend, never shorten), **remove_keyframes** (by keyframe id, or whole tracks by field), **set_timeline**, **add_animation** (a preset by Figma's style id or our key, its timing and props), **edit_animation**, **remove_animations**, **apply_animation_style** (our composite styles: fadeIn … textExit, at a start) and **detach_animation_style**, **add_audio** (main reads `path` from the chat's folder like an image's — AAC / MP3 / WAV / M4A known by their bytes, ≤ 100 MB, `src/main/agents/imageArgs.ts`; stored and decoded in the view, added in the agent's step), **edit_audio** (offset, trim, length, volume, mute, split, remove), **export_animation** (MP4 / WebM / GIF / SVG / Lottie / dotLottie at a scale or size, fps, quality, loop through the Animated export's `renderAnimated`; the bytes ride the result's new `files` and main saves them — `src/main/agents/toolFiles.ts` — in the chat's own folder, Downloads for an outside client, never overwriting, and tells the agent the path; 30 min like the waiting tools). The system prompt gained a Motion paragraph. **`pathTrim`** is now a layer property (`{start, end}`, update_nodes / get_design_context), off the Design-panel walk's exception list.
- **The Plugin API** (`editor/plugins/api/motion.ts`, `runtime/figma.js`; docs/plugins.md §5 "Motion"): on every scene node `manualKeyframeTracks` and `animationStyles` (get / set), `timelines`, `animations`, `applyManualKeyframeTrack`, `removeManualKeyframeTrack`, `applyAnimationStyle`, `removeAnimationStyle`, `setTimelineDuration`; `figma.motion` with `figmaAnimationStyles()`, `playheadPosition` (the editor's playhead, s) and `physicalSpringToNormalized()`. Writes open the run's slice (one undo step per run); Dev Mode reads only.
- **Dev Mode's Motion tab** (`viewer/inspect/MotionTab.tsx`, `motionCode.ts`; the editor's Dev Mode and the preview viewer): a **Motion** tab beside Inspect when the one selected layer is or holds an animated layer — **Show in timeline view** (Motion's timeline `readOnly`, portalled along the canvas's bottom left of the panel; play, scrub, zoom; the engine's motion layer on so the canvas plays the frame, off again when it closes — its Collapse button closes it), **Timing** (duration · playback, then per property its layer, name as the timeline's rows say it, span in ms, easing and every keyframe's value), **Code** — CSS (default) / React / JSON with Copy, lengths in Dev Mode's unit: CSS a class per layer (`animation` per property group over the timeline's duration — Loop `infinite`, Ping-pong `infinite alternate`, Once `1`, `both` —, `transform-origin` from the anchor) and an `@keyframes` per group with percentages, held ends and each keyframe's `animation-timing-function` (Figma's curves as cubic-bezier, springs as `linear()` of 30 samples over the spring's settle time, Hold `steps(1, jump-end)`), `translate` with X and Y merged, `rotate` clockwise + (Figma's −), `scale`, opacity, sizes, radii, borders, gaps, paddings, the first fill / stroke's colour; the same motion on another layer once (a comment); fields CSS can't say listed. React: motion.dev's `animate` / `transition` per layer (times over the timeline, per-segment eases, a two-keyframe spring as `type: "spring"`, `repeat` from the playback). JSON: the resolved model. No SwiftUI / Compose (Figma has none, §8.2).
- **`.fig`**: nothing to change — every motion node and field (manual tracks, preset clips with their props, `styleIdsForAnimation`, `timelineAssignments`, the timeline's settings, `transformOrigin`, `motionTransform`, `audioFills` / `audioTracks`) has Figma's name and number, so Save local copy writes it and the importer reads it back; the test exports the logo fixture with each kind of data as Figma's canvas.fig, imports it and gets the same timeline model and resolved model.

**Not in 8f** (next): REST — what Figma's REST returns for motion is unseen (no field is invented; the internal canvas already isn't listed); `baseValue` in `manualKeyframeTracks` (not read; a written one is ignored — the engine keeps the node's value); keyframes or easings bound to variables (`VariableAlias` refused); custom animation styles (`figma.getLocalCustomAnimationStylesAsync`, `createCustomAnimationStyle`, `type: "CUSTOM"`); TextStagger's blur; Web Animations / SwiftUI / Compose code (not §8's); the Motion tab for a multi-selection; the timeline view's own close button (Collapse closes it); the agents' export of only part of the timeline (Figma's `export_video` job / polling isn't copied: the file comes back in one call).

### 9.2 As built — motion for agents, phase 1 (2026-10-21; [ours], beyond Figma's agent tools; audit and design in `docs/research/motion-for-agents.md`; native test `motion.agent_fields.test.cpp` (1 case), chrome tests `editor/__tests__/animateScript.test.ts` (15), `agentsAnimate.wasm.test.ts` (7))

Goal: an agent makes motion-graphics-quality animation as it would with GSAP / Remotion code, but natively — everything it writes is ordinary manual keyframes, edited in the timeline and exported to every format.

- **`animate`** (`src/shared/agents/tools.ts`; compiler `editor/agents/animateScript.ts`, pure; writer `editor/agents/animateTool.ts`): a GSAP-like script `{nodeId, tweens, defaults, timeline {duration, playback, fps}, mode "replace" | "merge", offset}`. A tween: `{targets, from | to | fromTo [from, to] | keyframes [{…props, duration, ease}], duration, ease, delay, stagger, position, repeat, yoyo, repeatDelay, split, transformOrigin, label}`; a label: `{label, position?}`.
  - **Targets**: ids, layer names (every match under the frame, case-insensitive as a fallback), paths ("Card/Title", "Cards/*" = children). A target that matches nothing, or the top-level frame, is a warning in the result, not an error.
  - **Time**: GSAP's position parameter — seconds, `<` / `>` (start / end of the previous tween, a staggered tween's last element included), `<0.2`, `>-0.1`, `<+=0.2`, `+=` / `-=` after the end so far, labels and `label+=x` (an unknown label is added at the end, as GSAP); `delay` adds; `offset` shifts the whole script. Stagger: a number or `{each | amount, from: start | end | center | edges | random | index}` (random is a fixed shuffle: the same script gives the same timeline).
  - **Values**: a missing end is the channel's value at that time on the timeline being built (rest value, or what earlier tweens left; in merge mode the layer's existing keys). The start key eases in with **Hold** (GSAP's immediate render: a from-value appears at the tween's start and, being the first key, holds back to 0); a start value that differs from a key already at that time goes 1 ms later (`JUMP`). The end key carries the ease. A later tween over the same channel removes the earlier keys inside its span and the end of a segment it cuts through (GSAP's `overwrite: "auto"`). `repeat` (−1: to `timeline.duration`, required) and `yoyo` are unrolled into keys — each repeat starts again 1 ms after the last ends, a yoyo's way back uses the mirrored curve.
  - **Eases**: GSAP's power1–4 / quad / cubic / quart / quint / strong, sine, expo, circ × in / out / inOut (power1 and power2 **exact** as cubic Béziers — t², t³ —, the rest the standard CSS fits), `back(s)` (overshoot scaled), legacy `Power2.easeOut`; CSS `ease*`, `linear`, `cubic-bezier()`, `step-end`; `[x1, y1, x2, y2]`; springs `{type: "spring", stiffness, damping, mass}` → `CUSTOM_SPRING` with bounce = 1 − ζ (played normalised over the tween, §4.7) or `{bounce}` / `spring(0.4)`; Wecra's names. **Unrolled into exact keys**: `bounce` (Penner's seven parabolic arcs, falls t² and rises its mirror — exact), `steps(n)` (Hold keys), `elastic(a, p)` (GSAP's formula, a key at each extremum with a half-sine between, down to 0.1 % of the change); `.in` / `.inOut` by mirroring. So every eased key is a Bézier or Hold, which the Lottie / SVG writers key (§6.11).
  - **Properties → fields** (CSS / GSAP units): x / y → TRANSLATION_X / _Y (an existing XY track becomes X and Y, its untouched axis kept); rotate / rotation — **clockwise +, CSS's** → ROTATION negated; scale → SCALE_XY, scaleX / scaleY → SCALE_X / _Y (not both on one layer); skewX (deg) → MOTION_SHEAR = tan; opacity / autoAlpha; width / height; cornerRadius / borderRadius; strokeWeight / strokeWidth; fill / backgroundColor / color and stroke / borderColor (hex, rgb(a), {r, g, b, a}) → the first visible SOLID paint's COLOR; blur → a layer blur's RADIUS (a FOREGROUND_BLUR at 0 is added when the layer has none); drawSVG ("0% 100%", "40%", n, [a, b], true) / trimStart / trimEnd → PATH_TRIM_* (stroked shapes only); arcStart / arcEnd (deg → rad) / arcInnerRadius → ARC_DATA_* (ellipses); starInnerRadius → STAR_INNER_SCALE; pointCount → POLYGON_COUNT; gap → STACK_SPACING, padding / paddingX / paddingY / paddingTop … → STACK_PADDING_* (auto-layout frames). A layer that can't take a property is a warning. `transformOrigin` ("50% 50%", "left top", [x, y] %) → MOTION_SET_ANCHOR (no compensation) before the keys.
  - **split: "chars" | "words" | "lines"** on a TEXT: its tracks are written once and `MOTION_SET_TEXT_STAGGER` makes them play per element (§4.10, round 8i: CHARACTER_NO_WHITESPACE / WORD / LINE, `stagger` → delayMs, `stagger.from` → LEFT_RIGHT / RIGHT_LEFT / CENTER_OUT / RANDOM); the tween's span includes the last element. Only opacity and transforms play per element.
  - **Writing**: one `env.write("Animate")` — every touched field's track replaced with the compiled list through `publicApi.applyManualKeyframeTrack` (Figma's checks: not the top-level frame, WIDTH / HEIGHT not on groups / vectors, XY vs X / Y), anchors, blur effects, text stagger, then the timeline (`timeline` as given, else grown to the end, never shortened). One call = one undo step. Result: each tween's targets and span, the labels, the end, each layer's fields with their key counts, warnings, and the hint to call `get_motion_frames`.
- **`get_motion_frames`** (`editor/agents/motionFrames.ts`): the timeline at `times` (≤ 24) or `count` evenly spread (default 6, ends included), drawn by `engine.motionRenderFrame` (the Animated export's frames) — **one contact-sheet PNG** (default; columns from the frame's aspect, `maxSize` 1024, each cell under its time in a 3 × 5 pixel font, transparent areas over white) or one PNG per frame (`sheet: false`, 512); the text part lists the times and the grid. `gif: true` also returns a 24 fps looping GIF (≤ 480 px) as a file main saves in the working folder. In node (vitest) the frames are blank but sized — pixels need the view's GPU.
- **Wecra's keyframe fields** (`WECRA_KEYFRAME_FIELDS` in `src/shared/motion/types.ts`; engine `motion::fieldByPublicName` takes the evaluated non-public fields by their schema names, the name the timeline model already reported them by): `MOTION_SHEAR` ("Skew"), `ARC_DATA_STARTING_ANGLE` / `ARC_DATA_ENDING_ANGLE` (radians) / `ARC_DATA_INNER_RADIUS` ("Arc start / end / ratio"), `STAR_INNER_SCALE` ("Star ratio"), `POLYGON_COUNT` ("Count") — writable by set_keyframes, the Plugin API and animate, labelled in the timeline (`labelOf`), Turkish in the dictionary. Never in a Figma-public list; a `.fig` keeps them as the KEYFRAME expressions they are.
- **The skill**: built-in **motion-design** (`src/shared/agents/motionSkill.ts`) — listed with every chat turn's skills unless the owner has his own of that name, answered by `get_skill` in main (`host.ts`). *Since 2026-10-21 (docs/ai.md §8.6) it is the default skill **motion-opus** (`src/shared/agents/defaultSkills/motionOpus.ts`), which took this workflow in and adds the motion craft; `get_skill motion-design` answers with it.* the system prompt's Motion paragraph points to animate, get_motion_frames and the skill. The Agents panel names the steps ("Animating…" / "Animated layers", "Watching the animation…" / "Watched the animation").
- **Exports**: the GIF and Lottie of an animate result are tested (Lottie's rotation reaches the script's 90° clockwise and holds). A looping timeline whose last key is exactly at its end shows the rest pose on the last sampled Lottie frame (t = d wraps to 0) — the skill tells agents to hold the end; MP4 / WebM need WebCodecs (the view), not tested in node.

### 9.3 As built — sound for motion (2026-10-21; [ours]; free and local, no paid service; vitest `motion/__tests__/sound.test.ts` (13), `editor/__tests__/agentsSound.wasm.test.ts` (5))

The owner: "make sound while making motion — and alone: I made an animation, generate sound for it." Agents score motion with a **local synthesiser** they drive with recipes, read the motion as a **cue sheet**, and check the **mix by numbers** (they can't listen).

- **The synthesiser** (`editor/motion/sound/dsp.ts`, pure TypeScript, no Web Audio — the same samples in the view and in node): 48 kHz stereo; polyBLEP saw / square, sine, triangle and FM oscillators with per-sample frequency; white / pink / brown noise from a seeded mulberry32 (**deterministic**: same recipe + seed = same samples); curves, exponential sweeps, hit / ADSR envelopes; a TPT state-variable filter with a moving cutoff; tanh drive; bit / rate crush; equal-power pan with movement; a ping-pong delay; Freeverb (tunings scaled to 48 kHz); DC block; tails trimmed at −70 dB; every sound normalised to **−1 dBFS** peak (the mix level is the clip's volume). An 8 s bed renders in ~0.2 s, an effect in 1–100 ms (M-series, node).
- **Recipes** (`sound/recipes.ts`): `{type | preset, duration, seed, pitch (Hz | "C5"), key ("A minor", "D dorian"), mood, bpm, brightness 0–1, intensity 0–1, pan, panTo, width, reverb, delay, delayTime (s | "1/8"), attack, release, syncAt, …per type}`. Types: click, tap, pop, tick, typing (count / interval / times), whoosh, swoosh, riser, downlifter, impact, thud, boom, shimmer, sparkle (FM bells on the key's scale), chime, notification (motifs up / down / success / error / alert / coin / message, or notes), glitch, pad, swell, drone (progression), beat (patterns four-on-floor / hiphop / halftime / breakbeat / minimal / light / pulse or 16-step rows, bpm, bars, swing), music (beds by mood — uplifting, corporate, calm, dreamy, tense, dark, epic, playful, lofi: a progression, pad, bass, arpeggio, drums by mood; key, bpm, parts, fades, `loop` folds the tail onto the start), stack (layers with `at` / `gainDb`). **Presets** (60): click, click.soft, click.mechanical, tap, tap.wood, pop, pop.bubble, pop.deep, toggle, tick, typing, typing.fast, whoosh, whoosh.fast, whoosh.long, whoosh.heavy, swoosh, swish.air, pass-by, riser, riser.tension, riser.short, downlifter, reverse-swell, swell, impact, impact.cinematic, hit.punch, logo-hit, thud, boom, shimmer, sparkle, glint, magic, chime, chime.success, notification, message, error, alert, coin, glitch, glitch.digital, pad, drone, beat.four-on-floor / hiphop / halftime / breakbeat / minimal, music.<mood> × 9. Each sound has a **sync point** — a whoosh's peak (55 % in), a riser's / swell's end, a hit's transient, a stack's first layer's.
- **`generate_sound`** (`editor/agents/soundTools.ts`): `{nodeId, sounds: [{…recipe, at, align "sync" | "start", name, volumeDb | volume, row}], place}`. Rendered, encoded as 16-bit WAV (`sound/wav.ts`), put in the file's image store by SHA-1 as a dropped WAV is (§6.6), handed to the `AudioLibrary` as samples (`adopt`: peaks for the waveform and an AudioBuffer for playback and the export's mix without decoding again; the next session decodes the WAV), then every clip of the call added in **one "Generate sound" undo step** (MOTION_ADD_AUDIO + MOTION_SET_AUDIO for the volume, the trim and the row's name). Placement: the sync point lands on `at`; a sound that would start before 0 starts at 0 trimmed (`startUs`). Volumes by kind (dB): music / ambience −18, beat −14, hits −6, whooshes −9, UI −10, builds −10, magic −12, chimes −8, glitch −10. **Rows** by kind (Music, Whooshes, Hits, UI, Risers, Magic, Chimes, Glitch, Ambience, Beat) shared while clips don't overlap, else "Hits 2"…; `row` names one. Music / beat / drone / pad without a duration run to the timeline's end (a looping timeline: a seamless loop from 0). `place: false`: WAV files in the agent's working folder (main saves them, as export_animation's). Limits: 40 sounds, 600 s of sound per call. The clips are ordinary audio: the timeline shows them with their names and waveforms (move, trim, volume, mute, split, delete), the editor plays them, MP4 / WebM carry them (§7.9's mix). **Lottie / dotLottie, GIF and SVG carry no audio** (the formats have none). The prototype player plays no timeline audio (unchanged, §4.11).
- **`score_motion`** (`sound/score.ts`, on `engine.motionResolved` + `engine.motionSamples` at ≤ 30 fps, ≤ 1200 samples): events in time order — appear / disappear (opacity from / to ~0), move (merged overlapping transform / size tweens: start, end, **peak** = the fastest moment from the engine's samples, else the ease's shape; props, amount, ease), arrive (a move's end), pop (a scale overshoot: back / spring ease at the overshoot's top, or a keyed rise-and-settle, or a quick 0.5 → 1), spin (≥ 180°), cut (a Hold key), stagger (a text's per-element start times from its stagger behaviour; layers doing the same thing at an even 15–500 ms step), rest, loop, end — each with a strength 0–1 (the change relative to the frame × the layer's size); **accents** (landings within 60 ms), the **climax**, an **energy** curve (0–1 per 0.25 s) and **cues** (a riser into the climax, hits where things land, whooshes 30–70 % into big moves, pops, ticks / typing on staggers, clicks on small appearances). Keys past the timeline's end are left out.
- **`get_sound_mix`** (`sound/mix.ts`): the clips mixed at 48 kHz as the export does (volume × the row's gain, trim, offset; a WAV read straight from the store where nothing decodes): peak / RMS dBFS per second, overall, clipping, pile-ups (3+ effects in 100 ms), flams (starts 1–40 ms apart), seconds with more than 4 effect starts, the bed's RMS against the effects' peak, clips not decoded, and warnings with the fix.
- **The skill**: **sound-design** (now a default skill, `src/shared/agents/defaultSkills/soundDesign.ts`, docs/ai.md §8.6; first a built-in beside motion-design): score_motion → a palette (one bed, 3–6 consistent families, one key) → place (hits on arrivals, whooshes on peaks, pops, ticks on staggers, a riser into the climax, the bed from 0, silence as a tool, ≤ 3–4 starts per second) → levels (bed −18, hero hits −6, whooshes −9…−12, UI −10…−14, ticks −14…−18) → get_sound_mix → fix with edit_audio. **motion-design** step 5 now scores the piece unless the user asked for no sound; the system prompt says so.
- **Not in this round**: an AI sound provider. The codebase has the pattern (Settings › AI image keys: `AiSettings.imageKeys`, sealed with safeStorage in `userData/ai/keys.json`, `ai:set-image-key`); phase 2 would add an ElevenLabs Sound Effects key there (off by default) and a recipe `{type: "ai", prompt, duration}` rendered in main (`POST /v1/sound-generation`) with the local synth as the fallback. Also open: rendering in a worker (a 30 s bed blocks the view ~0.8 s), MP4 with audio checked in node (needs WebCodecs: the view), voice-over / speech, audio volume keyframes, the prototype player's audio. Not checked by ear in the built app: the sounds' quality (verified by numbers: length, rate, peaks, energy at the sync point, pan movement).

**Not in phase 1** (`docs/research/motion-for-agents.md` §4): number count-up, a `motionPath` input with autoRotate, trim offset, gradient stops, `vectorize_image` for sketches, audio beat markers, reading a timeline back as a script, shape morph, perspective. Not checked in the built app (only on the engine in node): the contact sheet's pixels.

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
