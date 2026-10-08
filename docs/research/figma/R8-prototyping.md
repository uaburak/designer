# R8-prototyping — Figma prototyping and presentation view (verified 2026-10-08)

Sources opened:
- help.figma.com Prototype triggers — https://help.figma.com/hc/en-us/articles/360040035834
- help.figma.com Prototype actions — https://help.figma.com/hc/en-us/articles/360040035874
- help.figma.com Prototype animations — https://help.figma.com/hc/en-us/articles/360040522373
- help.figma.com Prototype easing and spring animations — https://help.figma.com/hc/en-us/articles/360051748654
- help.figma.com Smart animate layers between frames — https://help.figma.com/hc/en-us/articles/360039818874
- help.figma.com Create overlays in your prototypes — https://help.figma.com/hc/en-us/articles/360039818254
- help.figma.com Prototype scroll and overflow behavior — https://help.figma.com/hc/en-us/articles/360039818734
- help.figma.com Connect your prototype (create connections) — https://help.figma.com/hc/en-us/articles/360040315773
- help.figma.com Create and manage prototype flows — https://help.figma.com/hc/en-us/articles/360039823894
- help.figma.com Set prototype device and background settings — https://help.figma.com/hc/en-us/articles/21158597546391
- help.figma.com Present designs and prototypes — https://help.figma.com/hc/en-us/articles/360040318013
- help.figma.com State management for prototypes — https://help.figma.com/hc/en-us/articles/14397859494295
- help.figma.com Preserve scroll position in prototypes — https://help.figma.com/hc/en-us/articles/360051747774
- help.figma.com FD4B: Add prototype connections — https://help.figma.com/hc/en-us/articles/31011968186007
- figma.com/blog How Figma put the bounce in spring animations — https://www.figma.com/blog/how-we-built-spring-animations/
- developers.figma.com Plugin API: Reaction, Action, Trigger, Transition (+Easing), Overlay, overflowDirection, PageNode.flowStartingPoints — https://developers.figma.com/docs/plugins/api/
- developers.figma.com REST file node types — https://developers.figma.com/docs/rest-api/file-node-types/
- Figma's own kiwi schema in this repo: `docs/research/figma/figma-schema.kiwi` (enums quoted in §11)
- forum.figma.com (third party, only for defaults Figma doesn't document; marked as such)

## 1. Prototype tab (right panel; Shift+E toggles Design/Prototype — unverified in help, common knowledge)
- Nothing selected, sections in order: **Device**, **Background**, **Flows**.
  - Device sub-rows: Device, Orientation, Model, Preview. Device type options: "Frame preset", "Custom Size (Fit)", "Presentation (Full)" (body text also says "Custom size"). A "None" entry exists in the dropdown (unverified wording).
  - If the frame uses a device preset (e.g. iPhone 15 Pro Max), Figma auto-selects the matching device.
  - Orientation: "Portrait" / "Landscape" (kiwi `DeviceRotation` NONE / CCW_90).
  - Model = colour variant of the device (e.g. "iPhone 15 Pro Max comes in four different colors").
  - Preset catalogue (unverified, not listed in help): phones (iPhone 16/15 families, iPhone SE, Google Pixel, Android Compact/Medium, Samsung Galaxy), tablets (iPad mini/Pro, Surface Pro), desktop ("MacBook Air", "MacBook Pro 14"", "MacBook Pro 16"" per a 2025 forum reply — no generic "Desktop"), watches (Apple Watch). Presentation view gets all presets; inline preview only phone/watch/tablet.
  - Background: "Choose a custom background color to appear behind your selected device in presentation view." Default colour not documented (Figma uses a dark grey #1E1E1E — unverified). Kiwi: `prototypeBackgroundColor` on CANVAS.
  - Flows: list of all flow starting points on the page; hover a row → "Preview" (inline preview) or "Select frame". Order = `PrototypeStartingPoint.position` (fractional index); the first is the default for Present with nothing selected (Plugin API remark).
- Top-level frame selected: **Flow starting point** section (+ to add; name field; "Edit description" opens rich text (bold, lists, links); "Remove starting point"; "Copy link" on hover of the heading), **Interactions** section (+ / "Add"), **Scroll behavior** section, overlay settings when the frame is an overlay destination.
- Nested layer selected: Interactions + Scroll behavior (Position only; Overflow only if it is a frame).

## 2. Triggers (help headings in order; UI menu labels drop the slash halves on desktop)
1. "On click/On tap" — UI shows "On click" (On tap on mobile).
2. "On drag" — any direction; dragging scrubs forward/back through the transition.
3. "While hovering" — returns to the original frame when the cursor leaves.
4. "While pressing" — returns to the original frame on release.
5. "Keyboard/Gamepad" (help heading; the dropdown reads "Key/Gamepad" — unverified). Single key or combo (e.g. Shift–K); controllers Xbox One, PS4, Switch Pro (kiwi `TriggerDevice` KEYBOARD/UNKNOWN_CONTROLLER/XBOX_ONE/PS4/SWITCH_PRO).
6. "Mouse enter" 7. "Mouse leave" — one-way (do not revert); legacy "Mouse move inside/outside" (pre 2023-11-16) can't be created.
8. "Mouse down (touch down)" 9. "Mouse up (touch up)" — Mouse enter/leave/down/up carry an optional `delay` ms.
10. "After delay" — ms field; default **800 ms** (forum, unverified); max 10000 ms (forum).
11. "When video hits" (timestamp) 12. "When video ends" — only on connections that start on a video.
- Plugin API: ON_HOVER / ON_PRESS revert when the trigger ends; MOUSE_* are permanent.

## 3. Actions (help order; one interaction holds several actions via "Add action")
- "Navigate to" — replaces the screen, closes all overlays, pushes history.
- "Back" — pops navigation history.
- "Set variable", "Set variable mode", "Conditional" (if/else blocks of actions).
- "Scroll to" — to an object in the same top-level frame (only target allowed inside the same frame); picker lists only direct children of scrollable frames, drag a noodle for any object; animation "Instant" or "Animate". Kiwi `extraScrollOffset` = offset fields (UI wording unverified).
- "Open link" — URL; opens in a new tab ("Open in new tab" checkbox, kiwi `openUrlInNewTab`); external sites show a leaving-Figma warning.
- "Open overlay", "Close overlay" (closes the topmost overlay), "Swap overlay" (replaces topmost overlay, keeps its position/settings, not added to history).
- Video: "Play/pause video" (Play video / Pause video / Toggle play/pause), "Mute/unmute video", "Set to specific time", "Jump forward/backward in time".
- "Change to" — interactive components: switch the closest ancestor instance to a variant.
- UI dropdown order (unverified): Navigate to, Change to, Back, Scroll to, Open link, Open overlay, Swap overlay, Close overlay, Set variable, Set variable mode, Conditional, video actions.

## 4. Animation
- Types: "Instant", "Dissolve", "Smart animate", "Move in", "Move out", "Push", "Slide in", "Slide out".
  - Dissolve, Smart animate: Easing + Duration. Move/Push/Slide: Direction + Easing + Duration + "Animate matching layers" checkbox.
  - Direction: Left / Right / Top / Bottom (Plugin API; UI shows four arrow buttons).
  - Move in/out: destination moves over a stationary original. Push: original pushed out. Slide in/out: move + offset + dissolve.
- Interaction details labels: Trigger, Action, Destination, Animation, Direction, Animate matching layers, Easing (and spring), Duration, State management, Add action.
- Duration range 1–10000 ms.
- Defaults for a new noodle: Trigger "On click", Action "Navigate to", destination = drop frame (help FD4B), Animation "Instant" (help beginner guide via search excerpt). When switching to an animated type: Ease out, 300 ms (forum reports; unverified). Figma reuses the last-edited interaction settings within a session (forum, unverified).
- Easing list: "Linear", "Ease in", "Ease out", "Ease in and out", "Ease in back", "Ease out back", "Ease in and out back", "Custom bezier"; springs "Gentle", "Quick", "Bouncy", "Slow", "Custom spring" (help capitalises "Ease In And Out"; UI3 uses sentence case — unverified).
  - Gentle = most neutral; Quick = toasts/notifications; Bouncy = playful; Slow = fullscreen scale-up.
  - Custom bezier: `cubic-bezier(x1, y1, x2, y2)`, endpoints fixed 0,0 / 1,1; draggable graph.
  - Custom spring: Mass, Stiffness, Damping (Plugin API adds initialVelocity); duration is derived (mass changes the ms); graph shows a duration handle. Preset numbers not published (unverified).
- State management checkboxes (new-style interactions, after 2023-05-24): "Reset scroll position", "Reset component state", "Reset video state" (only shown when relevant). Legacy "Preserve scroll position" only on old interactions with an "Update" / "Update all" button.

## 5. Smart animate
- Matches by **layer name** and **position in hierarchy**; applies to whole objects, components and layers inside components/groups. Duplicated frames keep names. Objects in sections match only within the section.
- Unnamed text layers take their name from content (search excerpt of help; unverified on current page).
- Animated: Scale (size), Position, Opacity (use layer opacity 0%, not hidden), Rotation, Fill (solid ↔ gradient ↔ image). Corner radius not mentioned (unverified). Texture, noise, background/layer blur supported.
- Not supported: drop shadow, inner shadow, moving between shapes → falls back to dissolve.
- Unmatched layers in the destination dissolve in (sources dissolve out); identical layers don't animate.
- Overlays: Open overlay never smart-animates (overlay = new frame); Swap overlay does with matching layers.
- "Animate matching layers" on Move/Push/Slide: non-matching layers use the main transition, matching layers smart-animate, matching fixed layers get no transition, non-matching fixed layers dissolve. Frame fill isn't animated (overlap; add a filled rectangle behind).
- Unique group names prevent matching.

## 6. Connections on canvas
- Parts: hotspot (frame or object in it), connection ("the arrow or 'noodle'"), destination (normally a top-level frame).
- Create: Prototype tab, select layer, "Hover over the blue circle on the button layer's edge until a blue plus icon appears", drag to the destination; noodle snaps to the frame when near. Or "+" in Interactions.
- Multi-select hotspots (Shift-click / marquee) then drag one plus → one interaction each. Shift-click / drag-select connections and drag their ends to retarget.
- Noodle: blue line from the hotspot's edge node to the destination with an arrowhead (visual details unverified). Dropping the end on empty canvas deletes the interaction (unverified).
- First connection between unconnected frames auto-creates a flow starting point on the source frame, named "Flow 1", "Flow 2" …; shown as "a small blue label" with a preview (play) icon and the flow name above the frame; double-click the name to rename; drag the icon onto empty canvas to remove. Right-click a frame → "Add starting point". A frame can belong to many flows but has at most one starting point.
- Main-component interactions are inherited by instances.
- Overlay frames show a blue overlay icon next to the frame on canvas; clicking it opens the overlay settings.

## 7. Overflow scrolling
- "Scroll behavior" section → **Overflow**: "No scrolling", "Horizontal", "Vertical", "Both directions". Frames only (top-level and nested).
- Content must exceed the frame, else: "For scrolling to work on this frame, the content needs to be bigger than the frame." Top-level frame taller than the device scrolls in the viewport; nested frames scroll their own bounds ("Clip content" hides overflow on canvas).
- **Position**: "Scroll with parent", "Fixed", "Sticky" (one per layer; parent must have overflow).
  - Fixed: moved above other layers in the frame, grouped under a "Fixed" label in Layers; scrolling layers can't be put above fixed ones. Not allowed in auto layout frames unless the child is absolute positioned.
  - Sticky: vertical-scrolling frames only; scrolls until its top edge hits the parent's top, then pins; releases on scroll back; bounded by its direct parent. Stacking follows layer order; auto layout canvas stacking "Last on top" / "First on top".
- Scroll position is memorised per frame and shared between matching frames (same name or common "Prefix /").

## 8. Overlay settings (stored on the overlay frame, reused by every interaction)
- Position: seven presets + manual: "Centered", "Top left", "Top center", "Top right", "Bottom left", "Bottom center", "Bottom right", "Manual" (labels unverified; enum CENTER … MANUAL verified). Manual = relative to the triggering hotspot (`overlayRelativePosition`), set by dragging in the destination preview.
- "Close when clicking outside" (kiwi CLOSE_ON_CLICK_OUTSIDE).
- "Add background behind overlay" — colour + opacity, drawn in front of the current frame; default black 000000 at 25% (third party, unverified).
- Animation section on Open overlay: transition, direction, easing, duration.
- Swap overlay keeps the original overlay's position; Back from a swapped overlay returns to the previous screen, not the previous overlay.

## 9. Presentation view and inline preview
- "Preview" = inline preview in the editor (Shift Space); live-updates with edits; jumps to a frame clicked on canvas; R restarts from the last selected frame; overflow menu has scale and "open in presentation view" (new tab); X closes.
- "Present" (⌘⌥Return / Ctrl+Alt+Enter) opens presentation view in a separate tab (desktop app: a new tab in the tab bar). UI3 puts Present/Preview at the top of the right panel (exact dropdown wording unverified).
- Starts at the selected frame's flow, else the first flow; without flows, frames ordered x then y; without connections, all frames on the page are navigable, with connections only connected frames.
- Top bar: Figma logo (back to files), sidebar toggle (flows list with descriptions), comment, presenter spotlight, Share, options menu, fullscreen. Bottom bar: ← → arrows, device switcher (only with a device), "Restart".
- Options menu: "Enable Figma shortcuts", "Show hints on click" (hotspot hints: clicking off a hotspot flashes blue boxes on clickable areas), "Make available offline", "Accessibility settings", "Hide UI" (`&hide-ui=1`).
- Scaling without device: "Actual size (100%)", "Responsive", "Fit width", "Fit width and height", "Fill screen". With device: "Responsive"/"Fixed size", "Fit device on screen", "Zoom device to fill screen", "Show device at 100%", "Show device frame".
- Shortcuts: → / Space / N next frame; ← previous frame; R restart; Z cycle scale options; C comments and F fullscreen (need "Enable Figma shortcuts"). Esc not documented.

## 10. Runtime semantics
- History stack: Navigate to pushes; Back pops; Swap overlay not recorded; Navigate to closes all overlays; overlays stack, Close overlay removes the topmost.
- While hovering / While pressing revert to the original frame when the pointer leaves / is released; Mouse enter/leave/down/up do not revert.
- After delay starts when the frame is shown (first-frame delay bug reported 2026 — forum).
- State memorisation: interactive component variants, scroll and video state restored on return; shared across matching frames; reset only via the State management checkboxes.

## 11. Data mapping (kiwi field numbers verified in `figma-schema.kiwi`)
- NodeChange: `prototypeInteractions` 226 (`PrototypeInteraction{id, event, actions[], isDeleted, stateManagementVersion}`), `prototypeStartingPoint` 249 (`{name, description, position}`), `prototypeDevice` 184 (`{type NONE|PRESET|CUSTOM|PRESENTATION, size, presetIdentifier, rotation NONE|CCW_90}`), `prototypeBackgroundColor` 141, `scrollDirection` 159 (`ScrollDirection` NONE/HORIZONTAL/VERTICAL/BOTH), `scrollBehavior` 186 (`SCROLLS`/`FIXED_WHEN_CHILD_OF_SCROLLING_FRAME`/`STICKY_SCROLLS`), `scrollOffset` 166, `overlayPositionType` 198, `overlayRelativePosition` 199, `overlayBackgroundInteraction` 200, `overlayBackgroundAppearance` 201 (`{backgroundType NONE|SOLID_COLOR, backgroundColor}`); legacy single-connection fields 139/153–156/181–190/192/207.
- `PrototypeEvent{interactionType, interactionMaintained, interactionDuration, keyTrigger, transitionTimeout, mediaHitTime}`; `InteractionType` ON_CLICK, AFTER_TIMEOUT, MOUSE_IN, MOUSE_OUT, ON_HOVER, MOUSE_DOWN, MOUSE_UP, ON_PRESS, NONE, DRAG, ON_KEY_DOWN, ON_VOICE, ON_MEDIA_HIT, ON_MEDIA_END, MOUSE_ENTER, MOUSE_LEAVE.
- `PrototypeAction{transitionNodeID 1, transitionType 2, transitionDuration 3 (kiwi unit unverified; REST says ms), easingType 4, transitionShouldSmartAnimate 6 (= Animate matching layers), connectionType 7, connectionURL 8, overlayRelativePosition 9, navigationType 10, transitionPreserveScroll 11, easingFunction 12 (bezier 4 floats / spring params), extraScrollOffset 13, openUrlInNewTab 18, transitionResetScrollPosition 25, transitionResetInteractiveComponents 26, transitionResetVideoPosition 17, conditionalActions 24, targetVariable* 14/15/19/20, targetVariableSetID 27, targetVariableModeID 28}`.
- `ConnectionType` NONE, INTERNAL_NODE (node actions), URL, BACK, CLOSE, SET_VARIABLE, UPDATE_MEDIA_RUNTIME, CONDITIONAL, SET_VARIABLE_MODE. `NavigationType` NAVIGATE, OVERLAY, SWAP, SWAP_STATE (= Plugin "CHANGE_TO" / "Change to"), SCROLL_TO.
- `TransitionType` used today: INSTANT_TRANSITION, DISSOLVE, SMART_ANIMATE, SCROLL_ANIMATE (Scroll to "Animate"), MOVE_FROM_*, MOVE_OUT_TO_*, PUSH_FROM_*, SLIDE_FROM_* (Slide in), SLIDE_OUT_TO_*; legacy FADE, MAGIC_MOVE. Direction is baked into the enum (Plugin API splits it into type + direction LEFT/RIGHT/TOP/BOTTOM; "Move in" Left ↔ MOVE_FROM_RIGHT? mapping unverified).
- `EasingType` IN_CUBIC (Ease in), OUT_CUBIC (Ease out), INOUT_CUBIC, LINEAR, IN_BACK_CUBIC, OUT_BACK_CUBIC, INOUT_BACK_CUBIC, CUSTOM_CUBIC, SPRING (legacy), GENTLE_SPRING, CUSTOM_SPRING, SPRING_PRESET_ONE/TWO/THREE (= Quick/Bouncy/Slow — order inferred, unverified). Plugin names: EASE_IN, EASE_OUT, EASE_IN_AND_OUT, LINEAR, EASE_IN_BACK, EASE_OUT_BACK, EASE_IN_AND_OUT_BACK, CUSTOM_CUBIC_BEZIER, GENTLE, QUICK, BOUNCY, SLOW, CUSTOM_SPRING.
- Plugin API: `Reaction{actions[], trigger}` (`action` deprecated); `OverflowDirection` NONE/HORIZONTAL/VERTICAL/BOTH ("Overflow Behavior" in the Prototype tab); `OverlayPositionType` CENTER, TOP_LEFT, TOP_CENTER, TOP_RIGHT, BOTTOM_LEFT, BOTTOM_CENTER, BOTTOM_RIGHT, MANUAL; `OverlayBackground` NONE | SOLID_COLOR{color}; `OverlayBackgroundInteraction` NONE | CLOSE_ON_CLICK_OUTSIDE; `PageNode.flowStartingPoints` sorted `{nodeId, name}`.
- REST: `interactions`, `transitionNodeID`, `transitionDuration` (ms), `transitionEasing`, `overflowDirection` NONE / HORIZONTAL_SCROLLING / VERTICAL_SCROLLING / HORIZONTAL_AND_VERTICAL_SCROLLING; CANVAS `flowStartingPoints` (sorted as in the panel), `prototypeDevice`, deprecated `prototypeStartNodeID`.
