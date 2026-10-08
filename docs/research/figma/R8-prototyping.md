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

## 12. Round 5 check against help.figma.com (2026-10-08; article text read through the help centre's JSON API)

Articles (all `https://help.figma.com/hc/en-us/articles/<id>`): 360040318013 Play your prototypes (PLAY), 21158597546391 device settings (DEV), 360040315773 Connect your prototype (CONN), 360039818874 Smart animate (SA), 360040522373 animations (ANIM), 360051748654 easing (EASE), 360039818734 scroll (SCROLL), 360039818254 overlays (OVL), 14506587589399 variables in prototypes (VARP), 15253268379799 variable modes in prototypes (MODES), 15253194385943 expressions (EXPR), 15253220891799 multiple actions and conditionals (COND), 8878274530455 videos (VID), 360061175334 interactive components (IC), 4411431245335 view prototype connections (VIEWC), 360039823894 flows (FLOWS), 31011968186007 / 31012379669783 FD4B. This section decides over the lines above where they differ.

- **Device.** "No device" is the help's name for the empty choice (PLAY: "Available only if the prototype device is set to No device or Presentation"); the menu label itself is still unseen. "Custom Size (Fit)" and "Presentation (Full)" apply only in presentation view; the inline preview offers only phone, watch and tablet presets. Model: "the iPhone 15 Pro Max comes in four different colors" (DEV). The preset list and colour names are published nowhere (unverified, ours). Device frames are SVG artwork (figma.com/blog/behind-the-feature-inline-device-frames), shown in presentation view and the inline preview, toggled by **"Show device frame"**. Background default: not documented (we keep #1E1E1E).
- **Scale options** (PLAY). No device: "Actual size (100%)", "Responsive" ("The contents of the prototype will resize and re-layout as the prototype viewer resizes according to the constraints and auto layout properties"), "Fit width", "Fit width and height" ("It will not scale up the prototype"), "Fill screen". Defaults: first frame wider than 1024 px → Actual size (Responsive recommended); narrower → Actual size (Fit width and height recommended); all frames 16:9 or device Presentation → Fill screen; device Custom → Fit width and height. With a device: "Responsive" / "Fixed size" ("Shows the design at 100% within the device"), then "Fit device on screen", "Zoom device to fill screen", "Show device at 100%", "Show device frame". Z cycles the options.
- **Inline preview** (PLAY, FD4B): "Preview" in the toolbar, a flow's preview icon, or ⇧Space opens "a floating window, called the inline preview". At its top: ← → (back / forward), Restart ("from the last selected frame on the canvas"; R), an overflow menu, open in presentation view in a new tab, X. Edges resize it (⇧ keeps the ratio). Overflow menu: "Fit width" (No device / Presentation only), "Responsive", "Follow prototype" (the canvas selection follows the preview), "Resize window/device to 100%", "Respect aspect ratio" (No device only), "Show device frame". Edits show at once; clicking another frame on the canvas jumps the preview there.
- **On drag** (TRIG): "Drag allows you to move back and forward through the transition. This creates a continuum". Released part way it snaps to the start or the end (forum; the threshold is unpublished — we use half way).
- **Smart animate** (SA): Scale, Position, Opacity, Rotation, Fill (solid / gradient / image); texture, noise, background blur and layer blur animate; **drop shadow and inner shadow do not** — a frame with an unsupported property falls back to Dissolve; overlays never smart-animate except Swap overlay; new layers dissolve in; unchanged layers don't animate. Corner radius, strokes and text content are not mentioned (forum: corner radius fades). Matching (21523793229463): names, parents' names and hierarchy; top-level frame names and variant names need not match; unnamed text layers match by text style and nearest position; ties by index.
- **Animate matching layers** (CONN: "Check this box to apply the Smart animate transition to any matching layers"; SA): layers that don't match use the main transition; matching layers smart-animate; matching Fixed layers get no transition; non-matching Fixed layers dissolve; the frame's fill isn't part of the animation; layers above matching layers animate above the destination.
- **Fixed in nested scrolling frames**: no help text (we pin them to their own scrolling frame, drawn above its scrolling children).
- **Set variable and modes** (MODES): "Any variables contained within a layer that has a set mode will only update the value of that specific mode definition." A target can name a mode explicitly — the variable's name, then "Modes" — shown as `variableName:modeName`. Set variable mode "changes the mode for the current page … Any mode explicitly defined on an object will still be used".
- **Conditional** (COND, EXPR): "If" with a boolean expression typed or picked from suggested variables and operators, then actions; "Else" with actions (may stay empty). Operators: `+ - * /`, string `+`, `== != and or > < >= <=`, `!` / `not`, unary `-`, parentheses; precedence: parentheses, ×÷, +−; for booleans: parentheses, comparisons, and, or; left to right. Strings in quotes; `true` / `false`. Invalid conditions are outlined in red. Typings: `conditionalBlocks: {condition?, actions}[]` (else-if blocks are representable; the help documents only If / Else).
- **Video** (TRIG, ACT, VID): triggers "When video hits" (a timestamp) and "When video ends" on connections that begin on a video; actions on interactions that end on a video: "Play/pause video" (Play video / Pause video / Toggle play/pause), "Mute/unmute video" (Mute video / Unmute video / Toggle mute/unmute), "Set to specific time", "Jump forward/backward in time" (Jump forward / Jump backward + seconds); state "Reset video state". Typings: `UPDATE_MEDIA_RUNTIME` with PLAY, PAUSE, TOGGLE_PLAY_PAUSE, MUTE, UNMUTE, TOGGLE_MUTE_UNMUTE, SKIP_FORWARD / SKIP_BACKWARD (`amountToSkip`), SKIP_TO (`newTimestamp`).
- **Inherited interactions** (VIEWC): "Figma won't display the inherited connections on the canvas by default. Select the instance to view its inherited connections." (IC: the tab shows "Interactions" and "Variant interactions"; on the same trigger the prototype interaction wins.)
- **Verified wording**: the trigger menu's "Key/Gamepad" (CONN; the article heading says Keyboard/Gamepad); "Mouse down / Touch press", "Mouse up / Touch release" in CONN's list; a new interaction's animation is "Instant" (FD4B-S: "By default, the Animation is set to Instant"); easing names in sentence case ("Set the Curve to Ease out", FD4B-S; "an \"Ease out\" curve lasting \"300ms\"", VIEWC) under a dropdown called **Curve**; duration 1–10000 ms; Present ⌘⌥↩; flows hover "Select frame", "Copy link", "Preview"; "Edit description", "Remove starting point"; "Close when clicking outside", "Add background behind overlay"; "Select matching interactions", "Add action". Still unverified: After delay's 800 ms (forum), the action menu's order (ACT's article order: Navigate to, Back, Set variable, Set variable mode, Conditional, Scroll to, Open link, Open overlay, Close overlay, Swap overlay, the video actions, Change to), the overlay position labels, the overlay background's 25 % black, Ease out 300 ms when an animation is first chosen.
