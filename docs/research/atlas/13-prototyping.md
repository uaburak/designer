# 13 — Prototyping and presentation (Figma Design desktop 126.9.13)

Every trigger, action, transition, easing, overlay, scroll, drag, hover, timer, flow and viewer rule that the shipped build reveals, down to the numbers. Written for DesignerV2's prototype panel (`src/renderer/src/editor/panels/prototype/`), model (`editor/model/prototype.ts`), engine player (`engine/src/proto/`) and presentation view (`src/renderer/src/present/`).

## 1. Scope and sources

**Scope.** The Prototype tab in the editor (triggers, actions, animation, state, overlay settings, scroll behaviour, flows), the prototype player (presentation view, inline preview), the viewer chrome (scaling, hints, keyboard, URL options), and the prototype-lib wasm. Motion keyframes, animation styles, springs' normalised form and transition overrides are in `docs/research/rea/motion.md` and are only summarised here (§3.4, §11).

**Prior work reused, not redone.**
- `docs/research/rea/motion.md` (REA, 2026-10-15): easing tables, spring maths, Plugin direction swap, timing defaults, Smart animate as JIT tracks, transition overrides. One-line summaries with links in §3.4 and §11.
- `docs/research/figma/R8-prototyping.md` (help-site research, 2026-10-08): UI wording, help-documented behaviour. This chapter confirms or corrects it from code. Where this chapter disagrees, the code wins.

**Sources read (all under `~/.cache/figma-rea/figma/`, read-only).**

| File | What it holds for this chapter | Where read |
|---|---|---|
| `774.min.js` (1.48 MB) | The Prototype panel: interaction details, trigger dropdown, action dropdown, animation section, direction control, overlay settings, state section, Set variable, Scroll to offsets, Open link, video and animation actions | modules 794339, 307962, 292375, 319589 @ 245 000–370 000 |
| `figma_app.min.js` | Trigger / action label formatters, action list and action → kiwi mapping, state-panel visibility, paywall gates, scroll-behaviour labels, number-input bounds | @ 1 714 589, 1 716 772, 1 724 586, 2 991 065 (module 327793), 3 854 435 |
| `3187.min.js` | Spring module 110210 (settle time), easing table 551153, device catalogue | @ 5 558 719; device objects |
| `viewer.min.js` (2.0 MB) | The prototype player in TypeScript: transitions (class `cN`), easing (`sJ`), hotspot hints (`f9`, hotspot shader), overlays (`h$`, `hZ`), drag (`ms`, JIT drag), timers, hover / reverse hover, keys, gamepad, scroll physics, sticky / fixed, action queue, semantic node paths, background colour | offsets cited inline |
| `prototype_app.min.js` | The viewer app shell: scaling options and their order per frame class, footer (Restart, R), hide-UI shortcut per keyboard layout, scroll padding | around `viewer.options_menu.fit_width_and_height` |
| `2108.min.js` | Options menu (Show hints on click, scaling groups, Z), UI auto-fade | module 445891, 604730 |
| `9531.min.js` | Prototype URL parameters | `pathToSelectedView` |
| `fullscreen__prototype-lib__compiled_wasm.{js,wasm}` | The viewer's C++ (file list, exported bindings) | `strings -n 6` of the wasm; export names in the JS glue |
| `fullscreen__fullscreen-wasm__compiled_wasm.wasm` | Validation strings, keyboard shortcut map | `strings -n 6`, `-n 12` |
| Embedded kiwi schema (dumped earlier to `rea-work/motion/embedded-schema.txt`) | Every prototype message and enum with field numbers | §2 |

No live probe ran (the brief forbids editing Figma files; the Figma MCP was not used). Every finding is CONFIRMED (read in code) or INFERRED (deduced); help-only facts are marked HELP.

---

## 2. Data model (embedded schema, current build)

### 2.1 Enums

| Enum | Values (number) | Evidence |
|---|---|---|
| `InteractionType` | ON_CLICK 0, AFTER_TIMEOUT 1, MOUSE_IN 2, MOUSE_OUT 3, ON_HOVER 4, MOUSE_DOWN 5, MOUSE_UP 6, ON_PRESS 7, NONE 8, DRAG 9, ON_KEY_DOWN 10, ON_VOICE 11, ON_MEDIA_HIT 12, ON_MEDIA_END 13, MOUSE_ENTER 14, MOUSE_LEAVE 15 | schema, CONFIRMED |
| `ConnectionType` | NONE 0, INTERNAL_NODE 1, URL 2, BACK 3, CLOSE 4, SET_VARIABLE 5, UPDATE_MEDIA_RUNTIME 6, CONDITIONAL 7, SET_VARIABLE_MODE 8, OBJECT_ANIMATION 9 (Slides), UPDATE_ANIMATION_TIMELINE_STATE 10 | schema, CONFIRMED |
| `NavigationType` | NAVIGATE 0, OVERLAY 1, SWAP 2, SWAP_STATE 3 ("Change to"), SCROLL_TO 4 | schema, CONFIRMED |
| `TransitionType` | INSTANT_TRANSITION 0, DISSOLVE 1, FADE 2 (legacy), SLIDE_FROM_LEFT/RIGHT/TOP/BOTTOM 3–6, PUSH_FROM_* 7–10, MOVE_FROM_* 11–14, SLIDE_OUT_TO_* 15–18, MOVE_OUT_TO_* 19–22, MAGIC_MOVE 23 (legacy), SMART_ANIMATE 24, SCROLL_ANIMATE 25 | schema, CONFIRMED |
| `EasingType` | IN_CUBIC 0, OUT_CUBIC 1, INOUT_CUBIC 2, LINEAR 3, IN_BACK_CUBIC 4, OUT_BACK_CUBIC 5, INOUT_BACK_CUBIC 6, CUSTOM_CUBIC 7, SPRING 8 (legacy), GENTLE_SPRING 9, CUSTOM_SPRING 10, SPRING_PRESET_ONE 11 (Quick), SPRING_PRESET_TWO 12 (Bouncy), SPRING_PRESET_THREE 13 (Slow), HOLD 14 (Motion only), EASE_IN 15 | schema, CONFIRMED |
| `OverlayPositionType` | CENTER 0, TOP_LEFT 1, TOP_CENTER 2, TOP_RIGHT 3, BOTTOM_LEFT 4, BOTTOM_CENTER 5, BOTTOM_RIGHT 6, MANUAL 7 | schema, CONFIRMED |
| `OverlayBackgroundInteraction` | NONE 0, CLOSE_ON_CLICK_OUTSIDE 1 | CONFIRMED |
| `OverlayBackgroundType` | NONE 0, SOLID_COLOR 1 | CONFIRMED |
| `ScrollDirection` | NONE 0, HORIZONTAL 1, VERTICAL 2, BOTH 3 | CONFIRMED |
| `ScrollBehavior` | SCROLLS 0, FIXED_WHEN_CHILD_OF_SCROLLING_FRAME 1, STICKY_SCROLLS 2 | CONFIRMED |
| `ScrollContractedState` | EXPANDED 0, CONTRACTED 1 (field deprecated) | CONFIRMED |
| `PrototypeDeviceType` | NONE 0, PRESET 1, CUSTOM 2, PRESENTATION 3 | CONFIRMED |
| `DeviceRotation` | NONE 0, CCW_90 1 | CONFIRMED |
| `TriggerDevice` | KEYBOARD 0, UNKNOWN_CONTROLLER 1, XBOX_ONE 2, PS4 3, SWITCH_PRO 4 | CONFIRMED |
| `MediaAction` | PLAY 0, PAUSE 1, TOGGLE_PLAY_PAUSE 2, MUTE 3, UNMUTE 4, TOGGLE_MUTE_UNMUTE 5, SKIP_FORWARD 6, SKIP_BACKWARD 7, SKIP_TO 8, SET_PLAYBACK_RATE 9 | CONFIRMED |
| `AnimationTimelineAction` | PLAY 0, PAUSE 1, TOGGLE_PLAY_PAUSE 2, SET_PLAYHEAD 3 | motion.md §2.22 |
| `TransitionDirection` (multiplayer playback) | FORWARD 0, REVERSE 1 | CONFIRMED |
| `ExpressionFunction` | ADDITION 0, SUBTRACTION 1, RESOLVE_VARIANT 2, MULTIPLY 3, DIVIDE 4, EQUALS 5, NOT_EQUAL 6, LESS_THAN 7, LESS_THAN_OR_EQUAL 8, GREATER_THAN 9, GREATER_THAN_OR_EQUAL 10, AND 11, OR 12, NOT 13, STRINGIFY 14, TERNARY 15, VAR_MODE_LOOKUP 16, NEGATE 17, IS_TRUTHY 18, KEYFRAME 19, COMPOSE_COLOR 20, PAINT_TO_COLOR 21, RESOLVE_LENGTH 22, TRANSITION 23 | CONFIRMED |

### 2.2 Messages

| Message | Fields (number) | Evidence |
|---|---|---|
| `PrototypeInteraction` | id 1, event 2, actions[] 3, isDeleted 4, stateManagementVersion 5 | CONFIRMED |
| `PrototypeEvent` | interactionType 1, interactionMaintained 2, interactionDuration 3 (s), keyTrigger 4, voiceEventPhrase 5, transitionTimeout 6 (s), mediaHitTime 7 (s), transitionTimeoutVar 8 | CONFIRMED |
| `KeyTrigger` | keyCodes[] 1 (DOM keyCodes; modifiers as their own codes), triggerDevice 2 | CONFIRMED |
| `PrototypeAction` | transitionNodeID 1, transitionType 2, transitionDuration 3 (s), easingType 4, transitionTimeout 5 (deprecated), transitionShouldSmartAnimate 6, connectionType 7, connectionURL 8, overlayRelativePosition 9, navigationType 10, transitionPreserveScroll 11, easingFunction 12 (4 floats), extraScrollOffset 13, targetVariableID 14 (dep.), targetVariableValue 15 (dep.), mediaAction 16, transitionResetVideoPosition 17, openUrlInNewTab 18, targetVariable 19, targetVariableData 20, mediaSkipToTime 21, mediaSkipByAmount 22, conditions 23 (dep.), conditionalActions 24, transitionResetScrollPosition 25, transitionResetInteractiveComponents 26, targetVariableSetID 27, targetVariableModeID 28, targetVariableSetKey 29, animationType 30, animationTargetId 31 (dep.), animationPhase 32, animationState 33, linkParam 34, cmsTarget 35, mediaPlaybackRate 36, simpleLink 37, variableSetTargetExtensionId 38, animationTimelineAction 39, animationSkipToTime 40, animationTimelineDefId 41, transitionOverridesEnabled 42, enableJitSmartAnimate 43, interpolationColorSpace 44, interpolationHueMethod 45, transitionDurationVar 46, easingVar 47 | CONFIRMED |
| `ConditionalActions` | actions[] 1, condition 2 (VariableData; absent = Else) | CONFIRMED (+ §5.9) |
| `PrototypeVariableTarget` | id 1, nodeFieldAlias 2 | CONFIRMED |
| `PrototypeStartingPoint` | name 1, description 2, position 3 (fractional index string) | CONFIRMED |
| `PrototypeDevice` | type 1, size 2, presetIdentifier 3, rotation 4 | CONFIRMED |
| `OverlayBackgroundAppearance` | backgroundType 1, backgroundColor 2 | CONFIRMED |
| `TriggeredOverlayData` (multiplayer) | overlayGuid 1, hotspotGuid 2, swapGuid 3, prototypeInteractionGuid 4, hotspotBlueprintId 5 | CONFIRMED |
| `ScrollMapping` | blueprintID 1, overlayIndex 2, scrollOffset 3 | CONFIRMED |

NodeChange fields: `transitionNodeID 139`, `prototypeStartNodeID 140` (canvas, legacy), `prototypeBackgroundColor 141` (canvas), `transitionInfo 153` (dep.), `transitionType 154`, `transitionDuration 155`, `scrollDirection 159`, `scrollOffset 166` (dep.), `scrollContractedState 178` (dep.), `fixedChildrenDivider 180` (dep.), `transitionPreserveScroll 181`, `prototypeDevice 184` (canvas), `scrollBehavior 186`, `interactionType 187`, `transitionTimeout 188`, `interactionMaintained 189`, `interactionDuration 190`, `destinationIsOverlay 192` (dep.), `overlayPositionType 198`, `overlayRelativePosition 199`, `overlayBackgroundInteraction 200`, `overlayBackgroundAppearance 201`, `transitionShouldSmartAnimate 207`, `prototypeInteractions 226`, `prototypeStartingPoint 249`, `objectAnimations 426` (Slides), `isEmbeddedPrototype 486`, `transitionOverrides 526`, `codePreviewSettings 531`, `presentationOutlines 573`, `specCanvasScrollEnabled 604`. CONFIRMED (schema). Overlay settings live on the **overlay frame**, not on the action; manual position lives on the **action** (`overlayRelativePosition 9`).

---

## 3. Triggers

### 3.1 The trigger dropdown (774 module 319589, function `eI`) — CONFIRMED

Order, with separators (`|`):

`None` | `On click`, `On drag`, `While hovering`, `While pressing`, `Key/Gamepad` | `Mouse enter`, `Mouse leave`, `Mouse down`, `Mouse up` | `After delay` | `When video hits`, `When video ends`.

- In Sites (`(0,J.cJ)()` true): no `None`, no `On drag`, no first / third separators, no video triggers.
- The video group appears only when `showVideoV2Triggers` (selection holds a video) is true.
- Each option carries an icon (`eb.e7(t)`); the trigger row shows the icon as `iconLead`.

Label formatters (figma_app @1 714 589 / @1 716 772): four sets — long desktop (`On click`, `While hovering`, `While pressing`, `On drag`, `Mouse enter`, `Mouse leave`, `Mouse down`, `Mouse up`, `After delay`, `Key/Gamepad`, `When video hits`, `When video ends`), long touch (`On tap`, `Touch down`, `Touch up`), short desktop (`Click`, `Hover`, `Press`, `Drag`, `Delay`, `Key`, `Voice`, `Video hits`, `Video ends`), short touch (`Tap`, `Touch down`, `Touch up`). Legacy MOUSE_IN / MOUSE_OUT get their own formatter (`proto.interaction.type.mouse_enter_deprecated` / `mouse_leave_deprecated`). English text of each key is INFERRED from R8 (the dictionary is not in the cache).

### 3.2 Which triggers are enabled — CONFIRMED (`eI`, the `disabled:!function(t){…}` test)

| Rule | Effect |
|---|---|
| `NONE` | Always enabled. |
| A trigger already used by another interaction on the same layer (selection's interactions share one source node) | Disabled — **except** `Key/Gamepad`, `On drag`, `ON_VOICE`, `When video hits`, which may repeat. |
| `After delay` | Always enabled (bypasses the rules below). |
| `When video hits` / `When video ends` | Enabled only when the selection has a video. |
| Interaction contains `Open link` (directly or in a Conditional) | Only `On click` and `Mouse up` are enabled. |
| Interaction contains a video action (`UPDATE_MEDIA_RUNTIME`) | `While hovering`, `While pressing`, `On drag` disabled. |
| Interaction contains an animation-timeline action | `While hovering`, `While pressing` disabled (`V.Kf` = ON_HOVER / ON_PRESS). |
| Interaction holds exactly one action and it is `Back` | `While hovering`, `While pressing` disabled. |

The "same trigger" identity (`figma_app` module 821376, `g(e)`) is: MOUSE_* + `interactionMaintained`; ON_KEY_DOWN + device + sorted key codes; AFTER_TIMEOUT + timeout; ON_MEDIA_HIT + time; others the type alone. CONFIRMED.

### 3.3 Trigger parameters and their bounds — CONFIRMED (774 `eE`, figma_app 327793)

| Trigger | Field | Default | Min | Max | Unit in UI / stored | Evidence |
|---|---|---|---|---|---|---|
| After delay | `transitionTimeout` | **0.8 s** | 0.001 s (input default) | **20 s** | ms / s | `transitionTimeout:o=.8`, `max:20` |
| Mouse enter / leave / down / up (and legacy in / out) | `interactionDuration` (+ `interactionMaintained = value > 0`) | empty (no delay); **0.3 s** read default | 0 | 10 s (input default) | ms / s | `interactionDuration:p=.3`, `min:0`, `e&&e>0?{interactionMaintained:!0,…}:{interactionMaintained:!1}` |
| When video hits | `mediaHitTime` | 0 | 0 | 3600 s | timestamp | `mediaHitTime:d=0`, `max:3600` |
| Key/Gamepad | `keyTrigger` | `{keyCodes: [], triggerDevice: KEYBOARD}` | — | — | — | `eN={keyCodes:[],triggerDevice:"KEYBOARD"}` |
| After delay (variable) | `transitionTimeoutVar` (TIMING variable) | — | — | — | — | gate `metronome && proto_parameterized_noodles` |

- The delay placeholder is `proto.trigger.add_delay_placeholder`; an empty delay means not maintained. Scrub and wheel move 1 ms per step (`scrubMultiplier: l/1e3`).
- Selecting `Key/Gamepad` focuses the key-capture field at once. While focused it shows `proto.keyCapture.press_key_lowercase`; empty it shows `proto.keyCapture.click_to_set_key`. A key press records the code plus held modifiers; repeat presses of the same key add modifiers; modifier-only presses are ignored; a gamepad button press records `[button]` with the controller type. A label longer than 10 characters gets a tooltip.
- Number inputs in this panel (`W4`, figma_app 327793 `M`): seconds shown as milliseconds, default **min 0.001 s, max 10 s, resolution 0.001 s**. CONFIRMED.

### 3.4 Timing defaults already settled in motion.md

`transitionDuration` reads 0.3 s when missing or 0; `transitionTimeout` reads 0.8 s when missing or 0; maintained mouse interactions with no duration read 0.3 s; legacy MOUSE_IN / MOUSE_OUT read as MOUSE_ENTER / MOUSE_LEAVE with `deprecatedVersion`; new interactions get `stateManagementVersion = 1`. See `docs/research/rea/motion.md` §2.2.

### 3.5 Runtime behaviour of each trigger (viewer.min.js) — CONFIRMED unless marked

| Trigger | Runtime rule | Evidence |
|---|---|---|
| On click | Fires on release of a press that hit a hotspot; several ON_CLICK interactions on one hotspot fire in order. A click that hits nothing first checks "close on click outside" (§6.3), then flashes hotspot hints (§10.4). | `triggerHotspot(t,n,oq.ON_CLICK,e)`; `_shouldCloseTopmostOverlayOnClickOutside` |
| Tap (touch) | A gesture is a tap when it moved **< 50 px** and lasted **< 0.4 s**. | `isTap(){…distanceTo(…)<S2&&…<S1}`, `S1=.4,S2=50` |
| Pointer release debounce | A release within **0.1 s** of a handled press is stored and processed later. | `S3=.1`, `_storeOrProcessPointerReleaseAtPoint` |
| Drag gesture start | A press becomes a drag after **> 5 px** of movement (or two pointers). | `t.distanceTo(this._dragStart)>SQ`, `SQ=5` |
| While hovering | Fires when the pointer is over a hotspot (once per frame, `setHoverLastHandledFrameNum`). Reverts when the pointer leaves the hotspot's interactive bounds, clipped and scrolled by its ancestors, measured in the previous frame's space; the instance returns to `BEFORE_LAST_ANY_STATE` with cause REVERSE_HOVER. | `_handleHover2`, `_handleReverseHover`, `returnInstanceToState(…,h9.BEFORE_LAST_ANY_STATE,oq.REVERSE_HOVER)` |
| While pressing | Same model on press / release (REVERSE_PRESS in the recorder). INFERRED from the recorder keys `reverse_press`. | `viewer.prototype_recorder.reverse_press` |
| Mouse enter / leave | Hotspots entered / left are found on the topmost overlay or base screen (leave also checks the second topmost); they fire in order of entering / leaving; if any action changes state (`actionCounter`) the loop stops. One-way (no revert). | `_handleMouseEnterMouseLeave` |
| Mouse down / up | Mouse down fires on press; a pending maintained MOUSE_DOWN is cancelled for other nodes when a drag starts. | `handleInteractionsForDrag` |
| Delayed mouse triggers (maintained) | A timer of `round(interactionDuration × 1000)` ms; when it fires, the action runs only if the pointer is still in (entry not reset), no other prototype action ran meanwhile (global and per-instance `actionCounter` unchanged) and the node still exists. | `_handleMaintainedInteraction`, `_scheduleTimedInteractionCallback(c,1e3*…interactionDuration()|0)` |
| After delay | Timers start when a screen change **commits or aborts** (after its transition), for every AFTER_TIMEOUT hotspot inside the new screens (outermost only). They fire only if the topmost screen has not changed (`topmostScreenChangeCounter`) and the state counters are unchanged. **If the screen was reached with the footer arrows, the delay is at least 500 ms.** Timers are kept sorted by fire time, then by creation order. | `_triggerPotentialTimedTransition`, `Math.max(500,h)` |
| Key/Gamepad | Searched on the topmost screen only. A keyboard trigger matches when the pressed set (modifiers Alt, Shift, Meta, Control as their own codes, plus the key) has **exactly** the stored length and every stored code; **Meta is read as Control on non-Mac**. The **first matching hotspot wins** and the event is consumed. Gamepad triggers match the button code with any controller type ≠ KEYBOARD. | `handleInteractionsForKeyPress`, `handleInteractionsForGamepadDown` |
| When video hits / ends | Registered with the video manager per hotspot when the screen commits; "ends" uses time 0 on the end event. | `_createMediaHitEvents`, `_createMediaEndEvents` |
| Hyperlinks in text | A TEXT node with hyperlinks is interactive without any interaction. | `isNodeInteractableBecauseOfHyperlinks` |

Inline preview only: **Esc** or **Shift+Space** that no key trigger consumed closes the preview (`requestClose`). CONFIRMED (`onKeyPress`).

---

## 4. Actions

### 4.1 The action dropdown (774 @~90 000 in the dump; figma_app `er`) — CONFIRMED

Default order (no experiment): `None` | `Navigate to`, `Change to`, `Back`, `Scroll to`, `Open link` | `Open overlay`, `Swap overlay`, `Close overlay` | `Set variable`, `Set variable mode`, `Conditional` | video: `Play/pause video`, `Mute/unmute video`, `Set to specific time`, `Jump forward/backward in time` | animation: `Play/pause animation`, `Set playhead`.

- Experiment `exp_prototyping_reorder_actions.new_ordering`: `None` | Navigate to, Change to, Back, Scroll to, Open link | Set variable, Set variable mode, Conditional | Open overlay, Swap overlay, Close overlay.
- Sites: Change to, Back, Scroll to | Set variable, Conditional (and preset placeholders).
- `Change to` is disabled unless the selection is inside a variant or an instance of one (`isSelectionContainedInStateOrStateInstance`).
- `Set variable mode` only with the `prototype_set_mode_action` flag.
- `Conditional` is not offered inside a Conditional (no nesting).
- Video group only when the selection or its frame has a video; animation group only with `metronome` and an eligible timeline on every selected node.
- A mixed selection adds a disabled `Mixed` row and a separator first.

### 4.2 Action → kiwi (figma_app `es`) — CONFIRMED

| Menu value | connectionType | navigationType / extra |
|---|---|---|
| NAVIGATE_TO | INTERNAL_NODE | NAVIGATE |
| SWAP_STATE_TO ("Change to") | INTERNAL_NODE | SWAP_STATE |
| GO_BACK | BACK | — |
| SCROLL_TO | INTERNAL_NODE | SCROLL_TO |
| OPEN_URL | URL | — |
| OPEN_OVERLAY | INTERNAL_NODE | OVERLAY |
| SWAP_WITH ("Swap overlay") | INTERNAL_NODE | SWAP |
| CLOSE_OVERLAY | CLOSE | — |
| SET_VARIABLE / SET_VARIABLE_MODE / CONDITIONAL | same name | — |
| UPDATE_MEDIA_PLAY_PAUSE_OPTIONS | UPDATE_MEDIA_RUNTIME | mediaAction TOGGLE_PLAY_PAUSE (sub-menu: Play, Pause, Toggle) |
| UPDATE_MEDIA_MUTE_UNMUTE_OPTIONS | UPDATE_MEDIA_RUNTIME | TOGGLE_MUTE_UNMUTE |
| UPDATE_MEDIA_SKIP_TO | UPDATE_MEDIA_RUNTIME | SKIP_TO |
| UPDATE_MEDIA_SKIP_BY_OPTIONS | UPDATE_MEDIA_RUNTIME | SKIP_FORWARD (sub-menu: forward / backward) |
| UPDATE_ANIMATION_PLAY_PAUSE_OPTIONS | UPDATE_ANIMATION_TIMELINE_STATE | animationTimelineAction TOGGLE_PLAY_PAUSE (Toggle, Play, Pause) |
| UPDATE_ANIMATION_SET_PLAYHEAD | UPDATE_ANIMATION_TIMELINE_STATE | SET_PLAYHEAD |

### 4.3 Per-action fields and defaults — CONFIRMED (774)

| Action | Fields | Defaults / bounds |
|---|---|---|
| Navigate to / Change to / Open overlay / Swap overlay | Destination dropdown (`proto.destination`), then Animation (§5) | Destinations from `getTransitionDestinationsOnActiveCanvas` with a filter: ALL; SCROLL_TO; STATES (Change to); RESPONSIVE_SETS (Sites). Viable ids first, then a separator, then disabled ids. Navigate destinations must be "a different top-level frame on the same page" (wasm validation string). |
| Scroll to | Destination grouped by scroll container (disabled container name as a header, its children below, the top-level frame first); Offset X / Y (`extraScrollOffset`) | Offset default `{0, 0}`; small / big nudge from user settings |
| Open link | URL text field (placeholder `proto.interaction.example_com`), checkbox `proto.action_open_url_in_new_tab` | **New tab is on by default** (`checked: openUrlInNewTab === undefined || true`) |
| Set variable | Target (variable picker, BOOLEAN / STRING / FLOAT / COLOR can be created inline), Value (expression builder) | Picker window 216 px wide |
| Set variable mode | Collection, Mode | `proto.prototype_panel.edit_set_mode.none / missing_collection / missing_mode` |
| Conditional | `If` row with a boolean expression, its actions, then `Else` with its actions; "Add action" inside each | Else may be empty |
| Set to specific time | `mediaSkipToTime` | 0 … 3600 s |
| Jump forward / backward | `mediaSkipByAmount` | **5 s** default, max 3600 s |
| Set playhead | `animationSkipToTime` | 0 … 3600 s, 6 fractional digits |
| Video target | dropdown `proto.video_dropdown.label`; "This video" first when the hotspot is the video | — |

### 4.4 Runtime of actions (viewer `triggerHotspot`, `runSequentialAction`) — CONFIRMED

- **All actions of an interaction go into a queue and run in order.** An action that starts a screen change — Navigate / Change to / Overlay / Swap (INTERNAL_NODE except an instant Scroll to), Back, Close — holds the queue until it finishes; Open link, Set variable, Set variable mode, video and timeline actions continue at once.
- **Navigate to**: `navigateToFrameAndCloseOverlays(dest, …, REMEMBER, FORWARD)` — closes every overlay and pushes history.
- **Swap overlay** with no overlay open behaves as **Navigate to** (`SWAP && !hasOverlay` takes the navigate branch). With an overlay open it replaces the topmost overlay (`swapTopOverlay`).
- **Back**: `requestBack(…, BEFORE_LAST_NONTRANSIENT_STATE)` — returns to the last non-transient state, replaying the transition reversed (§5.3).
- **Close overlay**: `closeOverlayForHotspot(hotspot)` — closes the overlay that holds the hotspot (INFERRED: and those above it), then aborts any JIT smart animate on overlays.
- **Open link**: `onURLClicked(url, openUrlInNewTab)`; a text hyperlink navigates by its own rule. The viewer app opens with `postRedirect(url, "_blank")` in the desktop app.
- **Set variable**: waits for the font list; if the variable drives interactive-component variants, the matching `Change to` actions run first; then `runSetVariable(instance, id, data, modes)` in the hotspot's resolved variable modes (the containing primary instance is the scope).
- **Set variable mode**: resolves the set by id (or legacy key); missing set or mode logs a warning and does nothing.
- **Conditional**: `getFirstTruthyConditionalIndex(scope, condition)` (C++); the chosen block's actions are inserted into the queue at that point with index path `[i, block, j]`.
- **Change to on hover** with a delay: the maintained timer also checks the per-instance action counter (§3.5).

### 4.5 Plan gates (figma_app `ed`) — CONFIRMED

With `prototype_multi_path_paywall` and no advanced prototyping, multiple actions, conditionals, variables and videos open an upsell (Starter → Pro). DesignerV2 is personal: no gate.

---

## 5. Animation (transitions)

### 5.1 Animation dropdown and availability — CONFIRMED (774 `et`, `ee`, `en`)

- Scroll to: `Instant`, `Animate` (SCROLL_ANIMATE).
- Every other action: `Instant`, `Dissolve`, `Smart animate` | `Move in`, `Move out`, `Push`, `Slide in`, `Slide out`.

Enabled options per action (`en(interactionType, navigationType, behavior)`):

| Action | Enabled animations |
|---|---|
| Navigate to | all except SCROLL_ANIMATE |
| Open overlay | **Instant, Dissolve, Move in only** |
| Swap overlay | Instant, Dissolve, Move in, Smart animate |
| Change to | Instant, Dissolve, Smart animate |
| Scroll to | Instant, Animate (not in the Sites anchor-link case) |
| Any action with **On drag** | Instant and Dissolve are disabled (drag needs a moving transition) |

Fields shown:

| Field | Shown when |
|---|---|
| Direction (4 buttons) | behaviour not Instant / Dissolve / Smart animate / Animate |
| `Animate matching layers` | Navigate to + Move in / Move out / Push / Slide in / Slide out, not Instant |
| Curve + Duration | any animated behaviour |
| `Play motion (Beta)` (`enableJitSmartAnimate`) | Smart animate, flag-gated |
| Easing / duration variable pickers | `metronome && proto_parameterized_noodles` (types EASING, TIMING) |
| Transition timeline toggle | `eclipse` gate with Smart animate (motion.md §2.24) |

### 5.2 Direction buttons and stored type — CONFIRMED (774 `ex`, `er`)

The control's buttons, in order, store: `RIGHT` (aria "left"), `LEFT` ("right"), `TOP` ("down"), `BOTTOM` ("up"). The stored type is `${behaviour}_FROM_${value}` (Move in, Push, Slide in) or `${behaviour}_TO_${value}` (Move out, Slide out). **The arrow names the direction of motion; the stored value names the side the new screen comes from.** A missing direction defaults to `RIGHT` → e.g. `MOVE_FROM_RIGHT` (motion leftwards). Changing direction when none is set also sets behaviour MOVE. This matches the viewer (§5.3): `MOVE_OUT_TO_RIGHT` is built as `MOVE_FROM_LEFT.reversed()`, so the old screen leaves **to the left** — the `_OUT_TO_` names are mirror images, as motion.md §2.1 found for the Plugin API.

### 5.3 Transition geometry (viewer class `cN`) — CONFIRMED

Offsets are in units of the frame size (`withScaledTranslation`); LEFT = (−1, 0), RIGHT = (1, 0), TOP = (0, −1), BOTTOM = (0, 1). "Entering" = destination, "exiting" = source. By default the entering screen is drawn on top.

| Type | Entering from → to | Exiting from → to | Exiting opacity | On top |
|---|---|---|---|---|
| INSTANT_TRANSITION | — | — | — | — |
| DISSOLVE (also SMART_ANIMATE fallback, FADE, MAGIC_MOVE) | — | — | dissolve (cross-fade) | entering |
| SLIDE_FROM_LEFT | (−1,0) → 0 | 0 → (+¼, 0) | **1 → 0.5** | entering |
| SLIDE_FROM_RIGHT | (1,0) → 0 | 0 → (−¼, 0) | 1 → 0.5 | entering |
| SLIDE_FROM_TOP | (0,−1) → 0 | 0 → (0, +¼) | 1 → 0.5 | entering |
| SLIDE_FROM_BOTTOM | (0,1) → 0 | 0 → (0, −¼) | 1 → 0.5 | entering |
| PUSH_FROM_LEFT | (−1,0) → 0 | 0 → (1,0) | 1 | entering |
| PUSH_FROM_RIGHT | reverse of PUSH_FROM_LEFT: (1,0) → 0 | 0 → (−1,0) | 1 | exiting |
| PUSH_FROM_TOP | (0,−1) → 0 | 0 → (0,1) | 1 | entering |
| PUSH_FROM_BOTTOM | reverse of PUSH_FROM_TOP | | | exiting |
| MOVE_FROM_LEFT / RIGHT / TOP / BOTTOM | side → 0 | stays | 1 | entering |
| MOVE_OUT_TO_LEFT | reverse of MOVE_FROM_RIGHT: stays | 0 → (1,0) | 1 | exiting |
| MOVE_OUT_TO_RIGHT | reverse of MOVE_FROM_LEFT | 0 → (−1,0) | 1 | exiting |
| MOVE_OUT_TO_TOP / BOTTOM | reverse of MOVE_FROM_BOTTOM / TOP | | | exiting |
| SLIDE_OUT_TO_LEFT | reverse of SLIDE_FROM_RIGHT: entering (−¼,0) → 0 with opacity 0.5 → 1 | 0 → (1,0) | 1 | exiting |
| SLIDE_OUT_TO_RIGHT / TOP / BOTTOM | reverse of SLIDE_FROM_LEFT / BOTTOM / TOP | | | exiting |

`reversed()` swaps entering / exiting, swaps each from / to, keeps dissolve, and flips who is on top. Back and Close play the opening transition reversed. Translation and opacity are linear in the eased progress (`lerp`, opacity clamped 0–1).

For drag, the vector of a Move / Push / Slide is `(to − from)` of the screen drawn on top, times `max(source size, destination size)` (Overlay / Swap: destination size). CONFIRMED (`computeDragVectorImpl`).

### 5.4 Easing, duration, spring — numbers

Bezier table (viewer `sJ.easingValuesForPreset`, 3187 module 551153): IN_CUBIC = EASE_IN `[.42,0,1,1]`; OUT_CUBIC `[0,0,.58,1]`; INOUT_CUBIC `[.42,0,.58,1]`; LINEAR `[0,0,1,1]`; IN_BACK_CUBIC `[.3,−.05,.7,−.5]`; OUT_BACK_CUBIC `[.45,1.45,.8,1]`; INOUT_BACK_CUBIC `[.7,−.4,.4,1.4]`; CUSTOM_CUBIC default `[0,0,.58,1]`; anything unknown → `[0,0,.58,1]`. Springs `[mass, stiffness, damping, v0]`: GENTLE `[1,100,15,0]`, QUICK `[1,300,20,0]`, BOUNCY `[1,600,15,0]`, SLOW `[1,80,20,0]`, CUSTOM default `[1,100,15,0]`, invalid → `[1,100,10,0]`. CONFIRMED (both modules agree). Same as motion.md §2.3.

**Spring playback in the player** (viewer class `s$`): eased value at progress x = `spring.solve(x · durationSeconds)` — the physical spring runs in real seconds over the stored `transitionDuration`. CONFIRMED.

**What `transitionDuration` holds for a spring** (774 `el`, `ep`): when the curve switches between bezier and spring, the duration is reset: to **0.3 s** for a bezier, to **`J5(spring)`** for a spring (module 110210 `r`, the settle time T). Editing the spring's Duration field (`R.PQ`) rescales the spring and stores `J5` of the new spring. CONFIRMED. The Duration field shows the editor duration `R.xX` = 6 / (ζω₀) (motion.md §2.5), while the stored, played duration is T. So the question motion.md left open (probe 5.4) is answered: **the player runs T.**

T = (−ln 0.001 + ln(1 + ζ'ω₀ / ω_d)) / (ζ'ω₀), ω₀ = √(k/m), ζ = c / (2√(km)), ζ' = min(0.9999, ζ), ω_d = ω₀√(1 − ζ'²). Computed:

| Spring | ω₀ (rad/s) | ζ | T (stored duration) | Editor duration 6/(ζω₀) |
|---|---|---|---|---|
| Gentle 1/100/15 | 10.000 | 0.750 | **1.022 s** | 0.800 s |
| Quick 1/300/20 | 17.321 | 0.577 | **0.744 s** | 0.600 s |
| Bouncy 1/600/15 | 24.495 | 0.306 | **0.958 s** | 0.800 s |
| Slow 1/80/20 | 8.944 | 1.118 (clamped 0.9999) | **1.250 s** | 0.600 s |
| Invalid fallback 1/100/10 | 10.000 | 0.500 | 1.473 s | 1.200 s |

Duration field (all curves): ms display, min 1 ms, max **10 000 ms**, scrub step 20/240/20 = 1/240 s per unit, wheel step `I/10`. The tooltip key is `proto.animation_panel.easing_duration_tooltip`. CONFIRMED.

**Frame clock** (viewer class `mn.advanceToNextFrame`): each frame adds `min(realDelta, 1/30 s)` to elapsed time — a long frame slows the animation instead of skipping it. Progress = clamp(elapsed / duration + startProgress, 0, 1); duration 0 jumps to the end. CONFIRMED.

**Viewport animation curve** (`cP.animationProgress`): EASE_IN_OUT = smootherstep 6t⁵ − 15t⁴ + 10t³; otherwise ease-out quint 1 − (1 − t)⁵. CONFIRMED (code); used for viewer camera moves — INFERRED.

### 5.5 Smart animate

- **Which types can match layers**: SMART_ANIMATE, and Push / Move in / Move out / Slide in / Slide out with `transitionShouldSmartAnimate` (`i9.supportsSmartAnimate`). CONFIRMED.
- **Matching is C++** (`getNodeMatches`, `getMagicMovePlan`, `getMagicMovePlanForStateSwap` in prototype-lib). The plan is a tree of `AnimationPlanTreeNode` with `isDissolve`, `isMatchedNode`, `scalesIndependentlyOfParent`, `enabledTraits`, `transition`. CONFIRMED (viewer class `hM`).
- **Identity used for state memory and matching across frames** (viewer `getSemanticNodePathForNode`): the path from the node up to its top-level frame, each step = (layer name, index among siblings **with the same name**). The top-level frame (FRAME, INSTANCE, SYMBOL or SLIDE) is replaced by the placeholder `"TLF Placeholder"`, so top-level frame names need not match. CONFIRMED for state memory; that the C++ matcher uses the same rule is INFERRED (help agrees: names, parents' names, hierarchy; ties by index).
- **What interpolates** (legacy `SingleLayerTransition` interface in prototype-lib): translation, transform (rotation / skew), transform origin, scaling, opacity, rectangle size, stroke weight, four corner radii, fill paints, stroke paints, text-decoration paints, effects, rounded-rectangle geometry and stroke. Everything else snaps or dissolves. CONFIRMED (binding names). The JIT path generates keyframe track groups instead (motion.md §2.23); unmatched layers dissolve through `DISSOLVE_PROGRESS`; dissolve kinds named in the wasm: `DISSOLVE_BASE_SCREEN_TRANSITION`, `DISSOLVE_OVERLAY_TRANSITION`, `DISSOLVE_NAV_FROM_OVERLAY`.
- Help-level rules (R8 §5, §12) stand: shadows do not animate (frame falls back to Dissolve), Open overlay never smart-animates, Swap overlay does.

### 5.6 On drag — CONFIRMED (viewer class `ms`, JIT drag observer)

| Step | Rule |
|---|---|
| Drag vector (Smart animate or matching layers) | The dragged hotspot's matched node: centre in destination − centre in source (both in their frames' space). |
| Drag vector (Move / Push / Slide) | §5.3. Dissolve / Instant: no vector. |
| Progress | clamp(dot(pointer − start, v) / ‖v‖², 0, 1). |
| Release | Speed s = pointer velocity projected on v, in progress per second. Threshold r = **0.15 / durationSeconds**. If progress ≥ 0.5: revert only when s ≤ −r. If progress < 0.5: complete only when s ≥ r. |
| Settle | Runs from the current progress to 0 or 1 in **‖target − progress‖ × duration** (≥ 1 µs). |

### 5.7 Scroll to animation

`SCROLL_ANIMATE` animates the scroll container's offset with the action's easing and duration (a JIT "ScrollTo" track group). An Instant Scroll to does not hold the action queue; an animated one does. CONFIRMED (`runSequentialAction`, `startScrollTo`).

---

## 6. Overlays

### 6.1 Overlay settings panel (774 module 794339, `G`, `H`) — CONFIRMED

- Position dropdown (224 px wide): `Center`, `Top left`, `Top center`, `Top right`, `Bottom left`, `Bottom center`, `Bottom right`, separator, `Manual`.
- `Close when clicking outside` checkbox — **hidden when the trigger is While hovering or While pressing**.
- `Add background behind overlay` checkbox → SOLID_COLOR; then a Background row with colour chit, hex, opacity.
- **Default background colour: black at 25 %** (`{r:0,g:0,b:0,a:.25}`), used when none is stored.
- Stored on the overlay frame: `overlayPositionType`, `overlayBackgroundInteraction`, `overlayBackgroundAppearance`; each change is its own undo scope.

### 6.2 Position maths (viewer `hZ` = `BoundOverlay_computeOrigin`) — CONFIRMED

With the base screen's bounds (x, y, W, H) and overlay size (w, h):

| Position | origin x | origin y |
|---|---|---|
| TOP_LEFT / BOTTOM_LEFT | x | (top) y / (bottom) y + H − h |
| TOP_CENTER / CENTER / BOTTOM_CENTER | x + W/2 − w/2 | y / y + H/2 − h/2 / y + H − h |
| TOP_RIGHT / BOTTOM_RIGHT | x + W − w | y / y + H − h |
| MANUAL | hotspot's scrolled top-left + `overlayRelativePosition` | same |

A MANUAL overlay opened from inside another overlay adds the previous overlay's rendered offset. A missing overlay frame reads CENTER and NONE.

### 6.3 Overlay runtime — CONFIRMED

- Overlays stack; hits are tested on the topmost overlay first (point mapped into overlay space), else the base screen.
- **Close on click outside**: only after no hotspot handled the click; if the topmost overlay has CLOSE_ON_CLICK_OUTSIDE and the point is outside its bounds, it closes **only the topmost** overlay (`closeOverlayAtAndAbove(last)`).
- The overlay's background fades with the transition progress (`backgroundTransitionProgress`). INFERRED: linear in progress.
- Back from an overlay replays its opening transition reversed.

---

## 7. State management (774 `eY`; figma_app `e_`, `W`) — CONFIRMED

A collapsible section `State` (closed by default).

| Interaction version | Checkboxes |
|---|---|
| Old (`stateManagementVersion` 0 / missing) | `Preserve scroll position` (+ `Reset video state` when relevant); an "Update" banner converts it (`transitionResetScrollPosition = !preserveScroll`, version 1), with "Update all" for the page. |
| New (1) | `Reset scroll position` (+ info tooltip with "Learn more"), `Reset component state` (only when the destination contains an interactive component, or the action is Back), `Reset video state` (only when it contains a video, or Back) |

The section is shown when the interaction has more than one action, or its action is not Close / Open link / Scroll to / Set variable / Conditional / Set variable mode / None / video. Mixed versions show `proto.state_management.mixed_state_update`.

---

## 8. Scroll behaviour

### 8.1 Panel — CONFIRMED (figma_app formatters `Ge`, `Rk`)

- Overflow: `No scrolling`, `Horizontal`, `Vertical`, `Both directions`. Tooltip when content does not exceed the frame: `proto.prototype_panel.content_needs_to_be_bigger_than_the_frame_tooltip`; Sites marquee frames: `overflow_scrolling_not_available_for_frames_with_marquee`.
- Position: `Scroll with parent` (SCROLLS), `Fixed (stay in place)` (FIXED_WHEN_CHILD_OF_SCROLLING_FRAME), `Sticky (stop at top edge)` (STICKY_SCROLLS). English wording INFERRED from keys.

### 8.2 Runtime — CONFIRMED (viewer)

| Rule | Detail |
|---|---|
| What scrolls | A frame scrolls on an axis when its direction allows it **and** content exceeds the frame on that axis (`height > frame height` etc.). |
| Fixed | Effective only if the parent scrolls or the parent is a top-level FRAME. Fixed children are gathered into a separate render group above the scrolling ones. |
| Sticky (vertical only) | Let s = sticky's initial top − scroll container's top. **Direct child of the scroller**: offset y = min(scrollY, s) → it scrolls until its top meets the container's top, then pins. **Inside a non-scrolling parent** within the scroller: pinned while s < scrollY ≤ s + o, where o = parent height − (sticky's top within parent + sticky height); beyond that it stays at −o (released at the parent's bottom). Inside a Fixed parent: no offset. |
| Wheel | Successive wheel events within **0.2 s** keep scrolling the same node. |
| Physics by OS | iOS / macOS (device or host): **bouncing**; Android / Linux / Windows: **clamping**; others: none (no fling). |
| Bouncing (iOS) | Friction drag 0.135 (position p + v·dragᵗ/ln drag − v/ln drag); overscroll resistance factor 0.52·(1 − overscroll fraction)²; spring back with mass 0.5, stiffness 100, damping ratio 1.1 (damping = 2·1.1·√(0.5·100) ≈ 15.56); boundary velocity capped at 5000 px/s; tolerance velocity 1/(0.05·dpr)… distance 1/dpr. |
| Clamping (Android) | Android OverScroller curve: friction 0.015, deceleration rate ln 0.78 / ln 0.9, deceleration for friction 61774.04968 × 0.84, duration exp(ln(0.35·|v| / (friction·decel)) / (rate − 1)), distance polynomial 1.2t³ − 3.27t² + 3.065t; the cross axis flings only if its speed ≥ 0, sharing the main axis duration; positions clamp to the range. |
| Scroll memory | Scroll offsets are kept per semantic path (§5.5) and shared between matching frames; reset via `Reset scroll position`. |

### 8.3 Viewer scroll padding — CONFIRMED (`prototype_app` `tt`)

Except in Fit width or Actual size with a preset device, the viewer pads the scroll area **12 px left / right and 54 px top / bottom**; Fit width and the Actual-size-with-device case use 0.

---

## 9. Flows and starting points

- `PrototypeStartingPoint {name, description, position}` on the top-level frame. Validation (editor wasm): "Can only set flow starting point with non-empty name", "… with valid nodeId", "… on associated page", "… that is a top level frame and a valid prototype source (no groups nor immutable or invisible frames)". Reordering is by fractional position (`placePrototypeStartingPointPositionBetween`). CONFIRMED.
- Panel: `Flow starting point` title, description editor with bold, italic, strikethrough, link, code, code block, header, bulleted and ordered lists (tooltip keys `proto.starting_points.description_*`); "Edit description"; add / delete tooltips. Flows section rows: `Preview`, `Copy link`, `Select frame`. CONFIRMED (keys).
- In the viewer, a URL `starting-point-node-id` that differs from the active one sets it and **restarts**; a `node-id` different from the base screen navigates there and closes overlays (or restarts). An invalid start node redirects to the first page with the toast `viewer.popup.invalid_start_node_redirect`. CONFIRMED (`prototype_app`).
- Status messages: `a_prototype_needs_to_have_at_least_one_frame`, `a_prototype_with_connections_needs_a_valid_top_level_frame_as_the_origin`, `a_presentation_needs_to_have_at_least_one_slide`. Flow auto-naming ("Flow 1"…) is HELP only (not seen in code).
- Restart goes to the first of the top-level prototype nodes in order (`nodeToRestartPrototypeOn`). CONFIRMED.

---

## 10. Presentation view (prototype viewer)

### 10.1 Scaling options — CONFIRMED (`prototype_app` `ts`, `td`, `tl`, `tb`; 2108 `k`)

| Option id | viewportScalingMode | contentScalingMode | Label (no device) | Label (with device) |
|---|---|---|---|---|
| ACTUAL_SIZE | min-zoom | fixed | Actual size (100%) | Show device at 100% |
| FIT_TO_SCREEN | scale-down | fixed | Fit width and height | Fit device on screen |
| FIT_WIDTH | scale-down-width | fixed | Fit width | — |
| FILL_SCREEN | contain | fixed | Fill screen | Zoom device to fill screen |
| RESPONSIVE | contain | responsive | Responsive | — |

Order by file class (first two = "Recommended", the rest = "Other"; with more than four "other" items outside DEFAULT they move into a sub-menu):

| Class (enum) | Order |
|---|---|
| PRESENTATION (0) | Fill screen, Actual size, Fit width and height, Fit width, Responsive |
| CUSTOM (1) | Fit width and height, Fill screen, Actual size, Responsive, Fit width |
| LARGE (2) | Actual size, Responsive, Fit width, Fit width and height, Fill screen |
| SMALL (3) | Actual size, Fit width and height, Fit width, Responsive, Fill screen |
| DEFAULT (4, the atom's initial value) | Actual size, Fit width and height, Fit width, Fill screen, Responsive |
| Preset device | Fit device on screen, Zoom device to fill screen, Show device at 100%; plus a separate `Fixed size` / `Responsive` pair |

The class thresholds (LARGE = first frame wider than 1024 px, SMALL = narrower, PRESENTATION = 16:9 or device Presentation, CUSTOM = device Custom) are HELP; the computation was not found in JS (INFERRED: C++). **Z** moves to the next option in this order (the menu shows "Z" next to the next one). Mobile default: `fit-width` / fixed; a mobile "responsive" toggle sets contain / responsive.

### 10.2 Options menu — CONFIRMED (2108 `k`)

`Show hints on click` (toggle `showHotspots`, default on), `Disable default keyboard navigation` (key `…disable_default_keyboard_navigation_v1`; URL `disable-default-keyboard-nav=1`), scaling groups, `Show device frame`, `Make available offline` (preloads every image, video and shader, then reloads frames), `Accessibility settings`, `Hide UI`. Other viewer toasts: `viewer.popup.content_scale_set_to`, `device_scale_set_to`, `press_key_to_show_ui_again`, `some_missing_fonts_were_replaced`, `one_or_more_images_in_this_prototype_failed_to_load` (+ "Learn why"), `couldn_t_play_interaction_nested_instance_is_swapped_with_its_parent_instance` (debounced 200 ms).

### 10.3 Keyboard — CONFIRMED where cited

| Key | Effect | Evidence |
|---|---|---|
| ⌘⌥↩ / Ctrl+Alt+Enter | Present (editor) | shortcut map `present-as-prototype` |
| Alt+9 | Show Prototype panel | `show-prototype-panel` |
| ⌘\ (mac) / Ctrl+\ | Hide / show UI — the key adapts to the keyboard layout (German `^`, Swedish / Finnish / UK-Mac `§`, UK-PC `` ` ``, Danish `$`, Norwegian `'` mac / `|`, Portuguese `§` mac / `\`, Spanish `º`, Latin-American `|`, French AZERTY `@`, Japanese kana `@`, Korean `₩`, Italian `\`; US / Dvorak / Chinese use the default) | `prototype_app` `tm`, `th` |
| R | Restart (footer button shows "R") | `viewer.footer.r` |
| Z | Next scaling option | §10.1 |
| ← → | Previous / next frame (footer stepper, "frame N of M") | `viewer.footer.*`; arrow-reached screens delay After delay ≥ 500 ms |
| Esc, Shift+Space | Close the inline preview | `onKeyPress` |
| ⌃⌘⌥R | Toggle recording interactions (internal recorder) | `toggle-recording-interactions` |

Space / N as "next", C, F come from help (R8 §9) and were not re-found in code.

### 10.4 Hotspot hints — CONFIRMED (viewer `f9`, hotspot shader)

- Trigger: a click that hits no hotspot (and closed no overlay).
- Duration **0.7 s**; opacity = 1 − ease(t) with ease = cubic-bezier **(0, 0, 0.58, 1)** over 0.7 s (fades from full at once, no hold).
- Colour **rgb(48, 194, 255) = #30C2FF**; fill at **50 %** of the current opacity, border at **100 %**; border width = 2 device pixels (`uStrokeProportion = (2/w, 2/h) / (zoom · dpr)`); clipped to each hotspot's clip rectangle.
- Hints cover the hotspots of the current screen and overlays.

### 10.5 Viewer chrome — CONFIRMED

- UI auto-hide (mobile / hide-UI flow, 2108 module 604730): fades after **2000 ms** (1000 ms on mobile browsers); revealed by moving within the header height of the top or within **60 px** of the bottom and **85 px** of the footer's centre; clicking a hotspot hides it; Esc shows it.
- Background behind frames: URL `bg-color` override, else the canvas's `prototypeBackgroundColor`, else **black** when that is transparent (viewer `u3`). The editor's default colour was not seen (R8 keeps #1E1E1E, unverified).
- Cursor: hand over On click / While pressing / Mouse down hotspots; touch cursor on mobile; none when interactions are off.

### 10.6 Prototype URL parameters — CONFIRMED (9531 `pathToSelectedView`)

`scaling`, `content-scaling`, `bg-color` (hex, masked to 0xFFFFFF), `hide-ui=1`, `bare-ui=1`, `hotspot-hints=0`, `device-frame=0`, `mobile-optimizations=true`, `inline-viewer=1`, `node-id`, `starting-point-node-id`, `show-proto-sidebar=1`, `disable-default-keyboard-nav=1`, `comments-enabled=1` / `allow-comments=1`, `version-id`, `show-debug-stats`, `share`, `popout`, `open-popout`; path kinds `proto`, `deck`, `presenter`.

### 10.7 Devices — CONFIRMED (3187 device objects)

186 preset identifiers (model × colour, e.g. `APPLE_IPHONE_17_LAVENDER`, `…_SAGE`, `…_MIST_BLUE`), each with frame artwork URL, thumbnail, `styleName`, scale factor, image size and screen offset. Device names (54, some archived / legacy): MacBook Air, TV, Macintosh 128k, Android Compact / Medium / Large / Small / Expanded, iPhone 17 / Air / 17 Pro / 17 Pro Max, iPhone 16 / 16 Plus / 16 Pro / 16 Pro Max, iPhone 15 family, iPhone 14 family, iPhone 13 family incl. mini, iPhone 11 family, iPhone X, iPhone SE, iPhone 8 / 8 Plus, Google Pixel 2 / 2 XL, Google Nexus 5X, Surface Pro 4 / 8, iPad mini / iPad mini 8.3, Apple Watch 38 / 40 / 41 / 42 / 44 / 45 mm, Series 10 42 / 46 mm; Slides adds "Slide 16:9" (1920×1080) and "Slide 4:3" (1024×768). Device frames are off in mobile browsers, the inline preview and Slides. Groups in the device panel: Phone, Tablet, Desktop, Watch, Paper, Social media, Presentation, Figma Community, Archive, Custom size, No device (keys `proto.frame_preset_panel.*`).

### 10.8 Interactive components in the player — CONFIRMED / INFERRED

- Change to swaps the closest instance that holds the target variant (`sZ.whichInstanceToSwap(hotspot, targetVariant)`); per-instance action counters guard delayed and timed triggers.
- Hover / press variant changes revert with `returnInstanceToState(BEFORE_LAST_ANY_STATE)`.
- Instance interactions run before inherited (main-component) interactions on the same trigger (tooltip `…interactions_on_instances_are_triggered_before_inherited_internal_interactions_tooltip`). A Change to must swap within the same component set (tooltip `this_interaction_must_swap_from_a_variant_to_another_variant…`).
- A swap that would nest an instance into itself fails with the "nested instance is swapped with its parent" toast.

---

## 11. Variables, expressions, Motion links

- Set variable / Set variable mode / Conditional: §4.3, §4.4. Expression operators and help rules: R8 §12. Expression functions: §2.1 (`TERNARY`, `IS_TRUTHY`, `VAR_MODE_LOOKUP` included).
- Duration / easing / timeout bound to variables (`transitionDurationVar`, `easingVar`, `transitionTimeoutVar`) are TIMING / EASING variable types, gated (`metronome && proto_parameterized_noodles`). CONFIRMED.
- Animation timeline actions, transition overrides, JIT smart animate, bake to keyframes: motion.md §2.22–2.24.

## 12. The prototype-lib wasm's role — CONFIRMED

`fullscreen__prototype-lib__compiled_wasm.wasm` (28 MB) is a separate Emscripten build of Figma's C++ scene graph for the viewer: sources include `fullscreen/lib/prototype/{PrototypeLib, PrototypeDocumentSyncing, InteractiveComponents, Variables, PrototypeAnimationHelpers, WasmImageManagerBindings, WebTestAPI}.cpp`, `render-tree/prototype-viewer/RTCompositeTileCache.cpp`, `scenegraph/FGSmartAnimateTransitionBake.cpp`, `derived-subtree/…/FGSmartKeyframeTrack(Group)Spec.cpp`, `expressions/FGFunction{Keyframe,Transition}.cpp`, the whole `scenegraph/motion/` folder and the variable code. The TypeScript player (`viewer.min.js`) drives it through bindings: document sync, `getNodeMatches` / `getMagicMovePlan(ForStateSwap)` (Smart animate), `getFramePairDragTranslationDelta`, `getFirstTruthyConditionalIndex`, `getICActionsForSetVariableAction`, `cleanedUpTransitionDestination`, `SingleLayerTransition*` (legacy per-layer interpolation), `WasmHotspotRendererBindings`, `WasmDeviceRendererBindings`, `generateBaseScreen(AndOverlays|Transition)RenderTree`, `ViewerStateFacet*`. The renderer is chosen by flags: `ts` (TS renderer), `wasm` (`viewer_editor_renderer_unification` or `webgpu_override`), `unified` (+ `veru_wasm_rendertree`). The editor's own wasm carries the same matching and plan code (bindings present in its JS too) for the inline preview and baking.

---

## 13. UI strings

English text where R8 / help verified it; otherwise the i18n key (the English dictionary is not in the cache).

- Section titles: Interactions, Interaction (`proto.interaction.interaction`), Trigger, Action, Destination, Animation, Direction, Curve, Duration, Delay, Key, Time, State, Overlay, Position, Background, Flow starting point, Flows, Scroll behavior (`proto.scroll_panel.scroll_behavior_title`), Overflow, Position.
- Triggers: None, On click, On tap, On drag, While hovering, While pressing, Key/Gamepad, Mouse enter, Mouse leave, Mouse down, Mouse up, Touch down, Touch up, After delay, When video hits, When video ends; short: Click, Tap, Hover, Press, Drag, Delay, Key, Voice, Video hits, Video ends.
- Key capture: `proto.keyCapture.press_key_lowercase`, `proto.keyCapture.click_to_set_key`.
- Actions: None, Navigate to, Change to, Back, Scroll to, Open link, Open overlay, Swap overlay, Close overlay, Set variable, Set variable mode, Conditional, If, Else, Play/pause video, Play video, Pause video, Toggle play/pause, Mute/unmute video, Mute video, Unmute video, Toggle mute/unmute, Set to specific time, Jump forward/backward in time, Jump forward, Jump backward, Play/pause animation, Set playhead, Mixed, Add action, `proto.prototype_panel.add_nested_action`.
- Open link: placeholder `proto.interaction.example_com`, `proto.open_url.text_input_label`, Open in new tab.
- Scroll to: Offset (`proto.scroll_options.offset`), X, Y; tooltips `proto.trigger.x_offset`, `proto.trigger.y_offset`.
- Animations: Instant, Dissolve, Smart animate, Move in, Move out, Push, Slide in, Slide out, Animate; Animate matching layers; Play motion + Beta badge; direction aria: left, right, down, up.
- Curves: Linear, Ease in, Ease out, Ease in and out, Ease in back, Ease out back, Ease in and out back, Custom bezier, Gentle, Quick, Bouncy, Slow, Custom spring, Hold (Motion); spring fields Mass, Stiffness, Damping; `proto.easing_behavior.flip_curve`; picker titles `proto.easing_picker.title / presets / libraries`.
- State: Preserve scroll position, Reset scroll position, Reset component state, Reset video state; `proto.state_management.update_controls`, `visual_bell_updated_message`, `visual_bell_update_all`, `mixed_state_update`, `info_tooltip`, Learn more.
- Overlay: Center, Top left, Top center, Top right, Bottom left, Bottom center, Bottom right, Manual, Close when clicking outside, Add background behind overlay, background colour / opacity labels.
- Scroll: No scrolling, Horizontal, Vertical, Both directions; Scroll with parent, Fixed (stay in place), Sticky (stop at top edge); `content_needs_to_be_bigger_than_the_frame_tooltip`.
- Panel misc: `use_the_circular_node_to_connect_the_selected_object_to_another_frame_tooltip`, Show connections / Hide connections, Select matching interactions (`select_n_matching_interactions`), Delete, Remove interaction, `click_plus_to_replace_mixed_content`, video panel: Video, Autoplay, Loop, Sound, Show video controls, Playback speed.
- Flows: Preview, Copy link, Select frame, Edit description, `edit_flow_title`, add / delete starting point tooltips.
- Device panel: No device, Phone, Tablet, Desktop, Watch, Paper, Social media, Presentation, Figma Community, Archive, Custom size, Fit, Fill, Model, Width, Height.
- Viewer: Restart, R, Previous frame, Next frame, frame progress, Options, Show hints on click, Show device frame, Make available offline, Accessibility settings, Hide UI, Recommended, Other, Actual size (100%), Fit width, Fit width and height, Fill screen, Responsive, Fixed size, Fit device on screen, Zoom device to fill screen, Show device at 100%, Enter / Exit full screen, Share prototype, Open in editor, Add comment, Flows sidebar (open / close, copy link to flow, no description), loading overlay (can't connect, try again, reload, "taking some time").
- Status: a prototype needs at least one frame; a prototype with connections needs a valid top-level frame as the origin; invalid start node redirect.

---

## 14. DesignerV2 today

| Area | Figma (this chapter) | DesignerV2 | Verdict |
|---|---|---|---|
| Hotspot hints | 0.7 s, opacity 1 − ease-out(0,0,.58,1), #30C2FF fill 50 % + 2-device-px border 100 % | `kHintsMs = 600`, full for 60 % then linear fade, `0x0D99FF` (`Player.cpp:18, 2410, 2429`) | **differs** |
| Slide in / out | other screen moves **¼** and fades 1 → 0.5 | `kSlideOffset = 0.3`, no opacity change (`Player.cpp:19, 2229–2234`) | **differs** |
| Drag start | > 5 px | `kDragThreshold = 4` CSS px (`Player.cpp:17`) | differs (small) |
| Drag release | velocity rule, threshold 0.15 / duration | half-way only (`Player.cpp:1679–1700`) | **differs** |
| Scroll physics | iOS bouncing / Android clamping by OS, fling | clamp only, no fling (`Player.cpp:979`) | **missing** |
| Sticky | min(scrollY, s) for direct children; parent-bounded when nested | pins to the screen's top (`Player.cpp:1965–2002`) | partial (check nested rule) |
| Frame clock | per-frame delta capped at 1/30 s | wall-clock progress (`Player.cpp:1594, 1627`) | differs |
| After delay | max 20 s; ≥ 500 ms when reached by arrows; starts after commit; cancelled by any other action | max 10 000 ms (`InteractionDetails.tsx:221`) | partial |
| Mouse delays | maintained timers, cancelled when left / any action ran | fired at once (motion.md §2.2) | **missing** |
| Key triggers | exact key set, Meta → Ctrl off-Mac, first hotspot wins | not checked | open |
| Trigger list rules | already-used triggers disabled; Open link only with click / mouse up; video / timeline / Back-only limits | list exists (`model/prototype.ts:159`); rules not seen | **missing** |
| Animation per action | Overlay: Instant / Dissolve / Move in; Swap: + Smart; Change to: Instant / Dissolve / Smart; drag disables Instant / Dissolve | all eight offered (`model/prototype.ts:452`) | **missing** |
| Direction default | none → RIGHT (`MOVE_FROM_RIGHT`) | `{animation, direction LEFT}` fallback (`model/prototype.ts:494`) | check |
| Spring duration | stored = settle T (Gentle 1.022 s…), played over it | sampled settle time; Duration hidden for springs (motion.md §2.5) | differs (small) |
| Overlay settings | 25 % black default, Close-outside hidden for hover / press, positions maths | 25 % black (`InteractionDetails.tsx:621`); hover / press hiding not seen | partial |
| Swap overlay without overlay | acts as Navigate to | not checked | open |
| Action queue | navigations hold the queue; others run at once; Conditional inserts its block | `run()` loops all actions at once (`Player.cpp:1047`) | **differs** |
| Open link default | new tab on | not checked | open |
| Scaling options | five ids, per-class order, Z cycles | help table (`PresentationView.tsx:69–83`) | partial (order per class) |
| Viewer URL params, hide-UI key per layout, UI fade 2 s | §10 | not built | missing |
| Devices | 186 presets / 54 names | `engine/src/proto/Devices.cpp` (217 lines) | partial |


### As built (2026-10-18, wave 4)

Built in `engine/src/proto` (Player, Prototype, the new `Scroll.{h,cpp}`), the Prototype panel and the presentation view; native tests `engine/tests/unit/proto.wave4.test.cpp` (15 cases), vitest in `editor/__tests__/prototype.test.ts`.

- **Transition geometry** (§5.3) as Figma's `cN`: `proto::geometryOf` — Slide in moves the other screen ¼ and fades it 1 → 0.5; the _OUT_TO_ types are the reversed _FROM_ ones of the other side (MOVE_OUT_TO_RIGHT leaves to the left); Push from right / bottom draw the leaving screen on top. The panel's arrows store Figma's side for every type (Move out ← = MOVE_OUT_TO_RIGHT; no direction = RIGHT), matching the agents' Plugin mapping. Files Wecra wrote earlier with Move out / Slide out now play mirrored, as Figma would play them.
- **Hotspot hints** (§10.4): 0.7 s, opacity 1 − cubic-bezier(0, 0, 0.58, 1), #30C2FF, fill at 50 %, a 2-device-pixel border at 100 % (`PresentItem.borderAlpha`, a small hook in `render/PresentScene.h` / `PresentRender.cpp`), clipped by each layer's clipping ancestors.
- **Drag** (§3.5, §5.6): a drag past 5 px; the vector of the screen drawn on top × the larger screen (an overlay: its own), Smart animate's matched hotspot centre to centre; let go, the pointer's speed (last 100 ms, 0 after 40 ms still) against 0.15 / duration decides, then |target − p| × duration. `engine_pointer` now passes the event's time to the player.
- **Frame clock** (§5.4): transitions, Change to, Scroll to, flings and timelines advance by at most 1/30 s a frame (timers stay on the wall clock).
- **Action queue** (§4.4): actions run in order; a screen change, Change to or animated Scroll to holds the rest until its animation ends; a Conditional's chosen block is inserted in place; a While hovering / pressing queue is dropped when it is undone.
- **Swap overlay** with no overlay open navigates (§4.4).
- **After delay** (§3.5): timers start when the screen's transition ends, outermost hotspots only, in order of time then creation, ≥ 500 ms when reached with ← / →; panel max 20 s. Timers and delayed mouse triggers are dropped when another action ran meanwhile — counted: screens, overlays, Change to, Back, Close, Set variable (mode); not Scroll to, Open link or video (INFERRED, which actions bump Figma's counter is not read).
- **Key triggers** (§3.5): the topmost screen only, the exact key set, ⌘ read as Ctrl off the Mac (the view passes its host, `engine_present_set_options {host}`).
- **Scrolling** (§8.2): a drag that fires no On drag scrolls the frame under it; let go, it flings — iOS / macOS bouncing (friction 0.135, resistance 0.52·(1 − f)², spring 0.5 / 100 / ratio 1.1, 5000 px/s cap, tolerances by dpr), Android / Windows / Linux clamping (OverScroller curve); the device's platform first (Android presets clamp), else the host. Wheel events within 0.2 s keep scrolling the same frame. Sticky layers inside a non-scrolling parent are released at its bottom; under a Fixed parent not moved.
- **Panel** (§3.2, §5.1, §5.4, §6.1): the Trigger list disables a trigger another interaction uses (Figma's identity: mouse + delay, key + codes, delay + time), Open link → On click / Mouse up only, video actions → no hover / press / drag, a lone Back → no hover / press; each action's animations (Overlay: Instant, Dissolve, Move in; Swap: + Smart animate; Change to: Instant, Dissolve, Smart animate; On drag: no Instant / Dissolve); Animate matching layers for Navigate to only; a spring's Duration is 6 / (ζω₀) and typing it rescales it to a custom spring; the stored duration is reset to 0.3 s / the spring's T when the curve changes kind; Close when clicking outside hidden for While hovering / pressing.
- **Open link** opens a new tab unless the file stores false (written explicitly now).
- **Scale options** (§10.1): Figma's per-class order (`Player::scaleOrder`, `stateJson.scaleOrder`), the first two "Recommended", Z goes to the next, the first is the default. The class thresholds are the help's (C++ in Figma, not read).
- **Motion timelines** (docs/motion.md §4.12): `UPDATE_ANIMATION_TIMELINE_STATE` read / written (Play, Pause, Toggle, Set playhead); the base screen's timeline plays through `Editor::setMotion` from when its transition ends (Once stops at its end, Loop / Boomerang run on), restarts with the screen, stops with it.

Not done: overlays' own timelines (the editor's motion layer holds one root), the viewer's URL parameters, the hide-UI key per layout and the UI's 2 s fade (§10.5 – §10.6), the mobile scale default, Close overlay closing those above it (open question 3), gamepad triggers, the device list (186 presets). Open questions in §15 stay open.

---

## 15. Open questions (with the probe that settles each)

1. Overlay transition list: the panel enables only Instant / Dissolve / Move in for Open overlay. Do Slide in / Push work on overlays opened from older files? — Open a file with `OVERLAY + SLIDE_FROM_RIGHT` in Figma's presentation view.
2. Frame class thresholds for the scaling order (LARGE / SMALL / PRESENTATION / CUSTOM) — present a 1025-px and a 1023-px frame, read the Options menu order.
3. Close overlay: only the hotspot's overlay, or it and all above? — two stacked overlays, Close from the lower one.
4. While pressing revert path and the exact press-revert trigger (release vs leave) — record with the viewer's recorder (⌃⌘⌥R) and read `reverse_press` events.
5. Overlay background fade curve (linear vs eased) — screen-record an Open overlay with a 2 s Dissolve and a 50 % background.
6. The C++ matcher's tie-breaks (same-name siblings, unnamed text layers by style and position) — two frames with swapped same-named layers, Smart animate, frame-step the result.
7. Editor default for `prototypeBackgroundColor` (the viewer falls back to black) — read a fresh file's canvas via the Plugin API.
8. Key labels' English text for keys marked with their i18n id — read the live Prototype panel or the help centre screenshots.
9. Space / N / C / F shortcuts in presentation view (help only) — press them with "Disable default keyboard navigation" off and on.
10. Whether `Play motion (Beta)` (JIT) changes timing versus the legacy path for the same transition — run the same Smart animate with the box on and off and compare frame captures.
</content>
</invoke>
