# Prototype playback that behaves like a website (research, 2026-10-21)

The owner's goal: **playing a Wecra prototype should feel like using the real site** — the logic a developer writes for
a website, folded into Figma's prototype model (triggers, actions, variants, variables, overlays, scroll settings), not
exported as code. This document lists what a browser does that a prototype would need, what Figma's prototype offers
for each, what Wecra's player does today, and the gap. It ends with a prioritised list of additions and the batch to
build first ("tonight's batch").

Research only. No product code changed.

## 0. Sources and conventions

**Wecra today:**
- `engine/src/proto/Player.cpp`: the player. Functions are cited as `Player::fn`.
- `engine/src/proto/Prototype.cpp`: the interaction model.
- `engine/src/proto/Scroll.cpp`: scroll physics.
- `src/renderer/src/present/PresentationView.tsx`: the presentation's DOM side (input, cursor, menus).
- `src/renderer/src/editor/panels/prototype/`: the Prototype panel (`PrototypePanel.tsx`, `InteractionDetails.tsx`).
- `docs/engine.md` §3.4: the "As built" notes, including 2026-10-21 (nested interactive components, instance and main
  interactions both running, variant overrides carried, Responsive as a viewport, overlay Fit to window).

**Figma, already researched:**
- `docs/research/figma/prototype-web-research.md` ("PWR").
- `docs/research/atlas/13-prototyping.md` ("atlas 13").
- `docs/research/rea/prototype.md` ("REA").
- `docs/research/figma/live/2026-10-20/prototype-playback.txt` ("live 10-20").
- Figma's current schema, `docs/research/figma/figma-schema-current.kiwi` ("schema-current", cited by line).

**Figma, read for this document (2026-10-21):**
- Figma Sites interactions: https://help.figma.com/hc/en-us/articles/31242843431575 ("SITES-INT"; official).
- Sites breakpoints: https://help.figma.com/hc/en-us/articles/31242797809815 ("SITES-BP"; official).
- Sites accessibility: https://help.figma.com/hc/en-us/articles/31242789265431 ("SITES-A11Y"; official).
- Accessible prototypes: https://help.figma.com/hc/en-us/articles/7810391964695 ("A11Y-PROTO"; official). Tab order
  follows layer order, and auto layout follows its direction. Navigate and Open link become links, and other On click
  actions become buttons.
- Figma's accessibility team blog: https://www.figma.com/blog/a-conversation-with-our-accessibility-team/ ("A11Y-BLOG";
  official). In accessible mode, "On hover" interactions fire while a clickable element has keyboard focus. The team
  names a "While focused" trigger as the missing ideal.
- Text input in prototypes, forum thread "Interactive text inputs in prototype mode":
  https://forum.figma.com/suggest-a-feature-11/interactive-text-inputs-in-prototype-mode-17975 ("FORUM-INPUT";
  community and staff). As of 2024–2025 Figma staff say typing during Present/Preview is not available. The workarounds
  are one Key trigger per character plus a string variable, or third-party tools.

**Key finding — Figma already has fields for most website behaviours.** Figma Sites added them to the same `NodeChange`
schema that Design files use (schema-current):
- `behaviors = 404`, type `NodeBehaviors`: `appear`, `hover`, `press`, `focus` (each holds a `BehaviorTransition` and a
  `NodeChange state`), `scrollParallax`, `scrollTransform`, `cursor` (`CursorBehavior {hotspotX, hotspotY, cursorGuid}`:
  a custom cursor drawn by a layer), `marquee`, `code`.
- `accessibleHTMLTag = 302`: an `HTMLTag` with INPUT, BUTTON, SELECT, TEXTAREA, A, FORM, LABEL, NAV, MAIN, DIALOG-like
  sections and more.
- `ariaAttributes = 357`, `accessibleLabel = 304`, `isDecorativeImage = 490`.
- `breakpointMinWidth = 501` and `responsiveSetSettings = 400`. The latter includes `ignoreReducedMotion`.

`docs/schema.md` §"reserved" row 12 (Sites) already lists these field numbers as reserved for a later Sites round.

**Rule for storing new data.** Use the cheapest option that keeps the `.fig` export valid, in this order of preference:
1. **Runtime only.** Nothing is stored. Use this when a web default can be derived from what the file already holds
   (the hotspot's interactions, component variant names, auto layout, overlay settings).
2. **Figma's own field.** Use Figma's name and number, as `docs/schema.md` §1.2 requires ("add no `@ours` field where
   Figma has one"). Examples: `behaviors.focus` / `.hover` / `.press` / `.cursor`, `accessibleHTMLTag`,
   `breakpointMinWidth`.
   - Figma Design may not expect Sites fields in a Design file. Until a probe confirms that Figma opens a `.fig` that
     carries them, the exporter should **drop them like `@ours` fields**: one flag on those `NODE_FIELDS` entries,
     beside `FIELD_FLAGS.OURS`.
   - The probe: export a file with them, open it in Figma Design, check that nothing breaks, then check whether Figma
     keeps the fields on save.
3. **`@ours` field.** Use one only where Figma has nothing, numbered from `NodeChange` 1004 (1000–1003 are taken; see
   `docs/schema.md` §0).
   - The exporter already drops every `@ours` field and the definitions only they use (`src/shared/fig/figmaExport.ts`
     `OUR_NODE_FIELDS`; test "Wecra-only prototype settings stay out of the export").
   - New enum values must never be added to Figma's enums. A Wecra-only trigger must not become `InteractionType = 16`,
     because the exporter can drop fields but cannot rewrite values inside Figma's messages. Put such a value in a
     Wecra field beside the interaction instead.
   - Settings on a component's layers must be overridable on instances, like `overlayFitWindow`.

## 1. Catalogue: what a website does, Figma, Wecra, gap

Status labels in the Gap column: **none**, **partial**, **missing**. "Web:" is how a browser or a typical web app does
it.

### 1.1 Pointer states

| Item | Web | Figma prototype | Wecra today | Gap |
|---|---|---|---|---|
| Hover | `:hover` on every ancestor under the pointer, instant, CSS transition per property | While hovering / Mouse enter / leave + Change to + Smart animate; only the deepest hover hotspot, one level a round (atlas 13 §3.5, REA Group 5) | Every level under the pointer, like `:hover` (`Player::hover`, `whileHovering`; docs/engine.md §3.4 2026-10-21) | none (beyond Figma already) |
| Hover transition interrupted (pointer leaves mid-animation) | CSS transition reverses **from the current value**, in the time already elapsed (shortened reversal) | Reverse hover is `returnInstanceToState(BEFORE_LAST_ANY_STATE)`; a new change first commits the running one (REA App. A §8: "a click mid-transition jumps the running one to its end") | `Player::swapInstance` snapshots the document's props (`snapshot` → `snapWalk` reads `props()`, the *target* state), so the reverse starts from the fully-hovered state: a visible jump on quick in-out | **missing** — no interruptible transitions |
| Active / pressed | `:active` while the button is held | While pressing (reverts on release), Mouse down / up | Same (`Player::pointer`, `Held`) | none |
| Focus / `:focus-visible` | Focusable elements get focus by click or Tab; ring shown only for keyboard focus | No focus model. Accessible-prototype mode maps clickables to buttons/links and fires On hover while focused (A11Y-PROTO, A11Y-BLOG); Sites has `behaviors.focus` (a focus state) | None | **missing** |
| Cursor type | `cursor: pointer / text / grab / not-allowed / help / zoom-in / move …` per element; custom image cursors | Viewer shows a hand on hotspots; Sites: "Cursor effect" = a custom cursor drawn by a layer (`CursorBehavior`, SITES-INT) | `PresentationView.tsx` (style `cursor`): `grabbing` while scrubbing, `pointer` over any hotspot, else `default` | **partial** — no text, grab, not-allowed or custom cursors |
| Disabled | `disabled` attribute: no events, not focusable, `cursor: not-allowed`, dimmed | No concept; designers make a "Disabled" variant without interactions | Same as Figma | **missing** — a disabled instance still runs its main's interactions unless removed by hand |
| Hotspot hints | — (sites don't show) | Click on nothing flashes hotspots (atlas 13 §10.4) | `kHintsMs`, Options › Show hints on click | none |
| Touch (tap, long press) | Pointer events, `touch-action`, no hover on touch | Tap < 50 px / 0.4 s; Mouse down/up = touch down/up (atlas 13 §3.5) | Same constants | none |

### 1.2 Keyboard

| Item | Web | Figma | Wecra | Gap |
|---|---|---|---|---|
| Tab / Shift+Tab focus order | DOM order or `tabindex`; skips disabled / hidden | Only in accessible mode: layer order, auto layout direction (A11Y-PROTO) | None — Tab is a Key trigger like any other (`Player::key`) | **missing** |
| Enter / Space activate | Enter on links/buttons, Space on buttons/checkboxes | Key/Gamepad trigger on a layer, searched over the whole topmost screen, first match wins (atlas 13 §3.5) | Same (`Player::key`) | **partial** — no "activate the focused element" |
| Esc closes | Esc closes the topmost dialog / popover / menu | Only through a Key trigger (Esc → Close overlay); unhandled Esc closes the *inline preview* | Same; presentation shortcuts R / → / Space / N / ← / Z (`Player::key`) | **missing** as automatic rule |
| Arrow keys in menus, tabs, radio groups, carousels | Roving tabindex: ↑↓ in a menu, ←→ in tabs/radios, Home/End | Key triggers per item (one interaction per key per item) | Same | **missing** |
| Typing shortcuts in the page (/, ⌘K) | App-defined | Key/Gamepad with modifiers, Meta→Ctrl off Mac | Same | none |
| Text keys go to a focused input, not shortcuts | Yes | — (no inputs) | Space / N / R would hit presentation shortcuts | **missing** (needs inputs first) |

### 1.3 Forms

| Item | Web | Figma | Wecra | Gap |
|---|---|---|---|---|
| Typing into a text field (caret, selection, IME, copy/paste, Backspace) | `<input>` / `<textarea>` | **Not available** (FORUM-INPUT; staff 2024). Workaround: a Key trigger per character + string variable | None in the player; the engine has a full text editor for the canvas (`text/TextEditor.cpp`, docs/engine.md §7.6) | **missing** — the most-asked gap in Figma itself |
| Placeholder | Shown while empty, styled grey | Designers draw it as text / a variant | — | **missing** |
| Validation (required, pattern, email, min/max length) + error state | Constraint validation API, `:invalid`, messages | Conditional on variables (MULTI) — no string functions beyond equality / concatenation | Conditionals + expressions (`Player::chosenBranch`, `evaluate`) | **partial** (needs a typed value to test) |
| Checkbox / radio / toggle / switch | Native checked state; radios exclusive by `name` | Variants + Change to; exclusivity needs variables + conditionals; variant property bound to a variable flips both (PWR §8) | Change to, variable-bound variants, Set variable | **partial** — no radio-group exclusivity without wiring every option |
| Select / dropdown / combobox | Native popup, keyboard, typeahead | Overlay + Change to / Set variable per option | Same | **partial** (anchoring, keyboard: §1.6) |
| Slider / range | Drag thumb, value | On drag scrubs a transition between two states only | `Player::beginScrub` (two-state scrub) | **missing** — no continuous value |
| Submit (Enter submits the form) | `<form>` submit on Enter, button type=submit | Key Enter trigger on a layer | Same | **partial** |
| Field values kept across screens | SPA state / form state | Variables persist for the session; component states carried by semantic path (STATE) | Variables (APPLY_REMOTE writes), `Player::carryComponentStates` | **partial** (typed text would need the same) |

### 1.4 State

| Item | Web | Figma | Wecra | Gap |
|---|---|---|---|---|
| Component state (props / internal state) | React state per instance | Interactive components (Change to), states per instance (IC) | Every level, kept across outer changes (`keepNestedStates`, docs/engine.md §3.4) | none |
| App / page state | Store (Redux, context) | Variables (string, number, boolean, colour), Set variable, modes (VARP) | Same (`Player::setVariable`, `setVariableMode`) | none |
| Conditional rendering | `{cond && <X/>}` | Visibility bound to a boolean variable; Conditional action (VARP, MULTI) | Same (`VariableField::VISIBLE`) | none |
| Derived values (`count + 1`, string concat, `a > b`) | JS expressions | Expression functions: + − × ÷, compare, AND/OR/NOT, VAR_MODE_LOOKUP (PWR §1) | `ExpressionField.tsx`, `Player::evaluate` | none |
| Lists (render N items from data, add / remove an item) | `.map()` | None in Design (Sites has CMS / Repeater — reserved, schema.md row 12) | None | **missing** (large; low priority) |
| Reset on restart | Reload clears state | Restart resets variables, modes, states, scroll (REA App. A §8) | `Player::restart`, `restoreOriginals` | none |

### 1.5 Navigation

| Item | Web | Figma | Wecra | Gap |
|---|---|---|---|---|
| Routing (link → page) | URL change, page render | Navigate to (closes overlays) | `Player::navigate` | none |
| History back / forward | Browser Back / Forward, `history.back()`, also the mouse's back button and ⌘[ | Back action; ← / → step through the *frame order*, not history (atlas 13 §10.3) | `Player::back`, `undoLast` | **partial** — no Forward, no browser-style back gesture/keys (⌘[ / ⌘], mouse buttons 4/5) |
| Deep link to a screen | URL path | `node-id` / `starting-point-node-id` URL params (atlas 13 §9) | Same (`PresentationView.tsx` URL options) | none |
| URL reflects the current screen | Yes (shareable) | The viewer updates `node-id` | Check: the presentation URL is not rewritten on navigate | **partial** |
| In-page anchors / scroll to section | `#id`, `scrollIntoView({behavior:"smooth"})` | Scroll to (instant or animated, SCROLL_ANIMATE) | `Player::scrollTo` | none |
| Open link in new tab | `target=_blank` | Open link, new tab option; leaving-Figma notice (ACT) | `Event::OPEN_URL`, `newTab` | none |
| Text hyperlinks | `<a>` in text | Text with links is interactive without interactions | `Player::linkAt`, `follow` | none |

### 1.6 Overlays

| Item | Web | Figma | Wecra | Gap |
|---|---|---|---|---|
| Modal with backdrop, click-outside closes | `<dialog>`, backdrop | Overlay + background + Close when clicking outside (OVL) | Same (`openOverlay`, `closeOverlay`) | none |
| Modal focus trap (Tab stays inside), focus returns to the opener on close | `inert` on the page, focus restore | — | — | **missing** (needs focus first) |
| Esc dismiss | Yes | Only by a Key trigger | — | **missing** |
| Scroll lock under a modal | `overflow: hidden` on body | An overlay with a background blocks scroll / drag to what is under it (REA App. A §10) | Same: `Player::hitTest` returns the overlay's layer for a backdrop, `Player::wheel` then scrolls nothing under it | none for modals; see "anchored" for popovers |
| Drawer (side sheet) full height | `position: fixed; inset: 0 auto 0 0` | Overlay at a side; runs past the window when taller | Overlay **Fit to window** (`overlayFitWindow = 1003`, `Player::fitOverlays`) | none (beyond Figma) |
| Popover / dropdown anchored to its trigger | Floating UI: placed at the anchor, follows it on scroll | Manual position: the hotspot's scrolled top-left + offset, computed **once at open**, never clamped (atlas 13 §6.2) | Same (`Player::overlayPlace`); when the page scrolls under an overlay without a background, the overlay stays put while its anchor moves | **missing** — does not follow its anchor |
| Edge repositioning (flip above, shift inside the viewport) | Floating UI `flip()` / `shift()` | None (overlays can run off-screen) | None | **missing** |
| Tooltip with delay | `title` / tooltip after ~500 ms, hides on leave | Mouse enter with a delay + Open overlay, Mouse leave + Close (TRIG) | Same (maintained Mouse enter delay) | none (setup is manual but works) |
| Toast: auto-dismiss | Timer | After delay on the overlay → Close overlay | `Player::armTimers` arms overlays too | none |
| Toast queue / stacking | Several toasts stack, the rest shift when one leaves | Overlays stack on top of each other at the same position (OVL; stacking undocumented) | Same: overlapping | **missing** |
| Nested menus (submenu on hover) | Yes | Overlay from an overlay (Manual adds the parent's offset) | Same | none |
| Dismiss rules (click outside closes only the topmost; Navigate closes all) | Library-specific | As stated (REA App. A §8, §10) | Same | none |

### 1.7 Scroll

| Item | Web | Figma | Wecra | Gap |
|---|---|---|---|---|
| Page scroll and inner scroll | `overflow: auto` | Overflow Vertical / Horizontal / Both (SCR) | `Player::wheel`, `beginScrollDrag`, `topScrollRange` / `nestedScrollRange` | none |
| Scroll chaining (inner reaches its end → page scrolls) | Default (`overscroll-behavior: auto`) | Wheel latches to one node for 0.2 s (atlas 13 §8.2) | Same; an inner scroller at its end passes the wheel to the next hit (`Player::wheel` loop) | none |
| Sticky / fixed | `position: sticky / fixed` | Sticky (vertical, direct-parent bounded), Fixed (SCR) | `Player::stick`, `addFixed` | none (horizontal sticky missing in both) |
| Momentum / overscroll bounce | OS physics | iOS/macOS bouncing, Android clamping (atlas 13 §8.2) | `Scroll.cpp`, `Player::scrollPhysics` | none |
| Scroll snap (carousels) | `scroll-snap-type: x mandatory` | None (a horizontal scroller stops anywhere) | None | **missing** |
| Scroll-linked effects (parallax, reveal on view, progress) | IntersectionObserver, scroll-driven animations | Not in Design prototypes; Sites: Reveal (In view, Page load), Scroll parallax, Scroll transform (SITES-INT; `behaviors.appear / scrollParallax / scrollTransform`) | Motion timelines play on screen load (`Player::startTimeline`) | **missing** for scroll-driven |
| Infinite list / load more | Fetch on reaching the end | — | — | **missing** (low value for prototypes) |
| Scroll restoration on Back | Browser restores the scroll position | Kept by semantic path, shared between same-named frames; Reset scroll position (STATE) | `Player::carryScroll`, `scrollStore_` | none |

### 1.8 Responsive

| Item | Web | Figma | Wecra | Gap |
|---|---|---|---|---|
| Viewport resize reflows | Fluid layout | Responsive scaling: frame takes the window's width (PLAY) | Width and the web's height rule (`Player::fitResponsive`, docs/engine.md §3.4) | none (beyond Figma) |
| Breakpoints switch layout | Media queries; different markup per size | Design: none during playback. Sites: breakpoints (Desktop 1280 / Tablet 800 / Mobile 375) inside one webpage, `breakpointMinWidth` (SITES-BP) | None: resizing a Desktop frame to 390 px only squeezes it | **missing** |
| Component variants per breakpoint (nav → hamburger) | Media query in the component | Sites: per-breakpoint overrides (`derivedBreakpointData`) | None | **missing** |
| min / max width | `min-width`, `max-width` | Auto layout min / max width (`minSize` / `maxSize`) | Engine lays out with them under Responsive | none |
| Orientation | `orientationchange` | Device orientation, presentation-only, one per prototype (DEV) | Device settings | none |

### 1.9 Motion

| Item | Web | Figma | Wecra | Gap |
|---|---|---|---|---|
| Per-property transitions | `transition: opacity .2s, transform .3s` | One transition per action; Smart animate interpolates matched layers (SA) | Same (`smartDest`, `smartSource`) | none (per-property timing: missing in both) |
| Easing and springs | CSS easings, spring libraries | Bezier presets, custom bezier, springs (EASE) | `proto::ease`, `springOf` — matched to Figma's viewer (live 10-20) | none |
| Keyframe animations | `@keyframes`, loops | Figma Motion timelines (keyframes) | `Player::startTimeline`, `timelineAction` | none |
| Interruptible animation | Retarget from the current value | A new change commits the running one first (jump to the end) | `Player::startAnim` calls `finishAnim()` (jump to the end); instance swaps restart from the target state | **missing** (same root as 1.1 interrupted hover) |
| Stagger | `transition-delay: calc(i * 40ms)` | Motion: TextStagger presets (keyframes); not in interactions | Motion presets | **partial** |
| Reduced motion | `prefers-reduced-motion` | Sites: `responsiveSetSettings.ignoreReducedMotion` (it respects the OS by default); Design viewer: none known | None | **missing** |
| Enter animations on load | CSS animation on mount | Motion timeline, After delay | `startTimeline`, `armTimers` | none |

### 1.10 Media

| Item | Web | Figma | Wecra | Gap |
|---|---|---|---|---|
| Video controls, autoplay, loop, mute | `<video controls autoplay loop muted>` | Video fill; Play / Pause / Mute / Skip actions; When video hits / ends (ACT, TRIG) | `Player::mediaAction`, `syncMedia`, `presentationVideos.ts` | none |
| GIF | Plays always | Plays in presentation (OVL) | GIFs play as looping videos (`Player.h` Media `gif`) | none |
| Audio | `<audio>` | Video's sound only | Same | none (Motion audio exists for timelines) |

### 1.11 Timers and loading

| Item | Web | Figma | Wecra | Gap |
|---|---|---|---|---|
| Delay | `setTimeout` | After delay (≤ 20 s), maintained mouse delays (atlas 13 §3.3) | `armTimers` | none |
| Interval / repeat (carousel autoplay, polling) | `setInterval` | After delay chain looping between frames / variants (Change to back and forth) | Same | none (repeating is manual but works) |
| Loading state / skeleton then content | Async render | After delay → Change to / Navigate | Same | none |

### 1.12 Data

| Item | Web | Figma | Wecra | Gap |
|---|---|---|---|---|
| Counter, cart total | State + arithmetic | Number variable + expression (VARP) | Same | none |
| Persistence across screens | Store | Variables are global for the session | Same | none |
| Persistence across reload (localStorage) | `localStorage` | Restart resets everything | Same | **missing** (optional; a reload is a restart in both) |
| Typed text as data | Input value | — | — | **missing** (§1.3) |

### 1.13 Accessibility basics

| Item | Web | Figma | Wecra | Gap |
|---|---|---|---|---|
| Visible focus ring | `:focus-visible` outline | Accessible mode only; Sites focus behaviour | — | **missing** |
| Roles change keyboard behaviour (button: Enter+Space; link: Enter; checkbox: Space; menu: arrows) | ARIA / native semantics | Accessible prototypes infer button vs link from the action (A11Y-PROTO); Sites: `accessibleHTMLTag`, ARIA roles (SITES-A11Y) | — | **missing** |
| Screen reader | DOM + ARIA | Accessible mode builds HTML for VoiceOver / NVDA / JAWS (A11Y-PROTO) | None (one WebGL canvas) | **missing** (large; out of scope tonight) |

### 1.14 Performance

| Item | Web | Figma | Wecra | Gap |
|---|---|---|---|---|
| Instant response (< 100 ms), 60–120 fps | — | Measured: first hover long tasks 57–125 ms, warm 8 ms p50 (live 10-20 §2) | p50 8.3 ms, p95 9–17 ms, no long task (live 10-20) | none |
| Press feedback before the release is processed | — | A release < 0.1 s after the press waits a frame so the pressed state shows (REA Group 5) | Immediate | **open** (cosmetic, REA) |

## 2. What Wecra should add (prioritised)

Each entry gives:
- **Set up**: how a designer sets it up, in Figma's vocabulary.
- **Store**: runtime only, or the stored field.
- **Panel**: where it goes in the UI.
- **Effort**: S (≤ ½ day), M (1–2 days), L (more).
- **Value**: how much "feels like the real site" it adds.

The first 12 are **tonight's batch**. They give the biggest gain for prototypes built from components, and most need no
stored data.

Every runtime rule below is on while presenting, with one switch:
- **Options › Advanced settings › "Website behaviours"**, beside "Enable Figma shortcuts". It is on by default, and the
  `web-behaviours=0` URL parameter turns it off.
- Off, the player behaves as Figma's.
- Store the switch with the other view options in `PresentationView` (no document data).

### Tonight's batch

**1. Real text input in input components**
- **Set up:**
  - Select a text layer inside an input component and turn on **Prototype › Text input**, a new section shown for text
    layers.
  - Options: Type (Text / Password / Email / Number / Multi-line); Placeholder = the layer's own text, shown in its own
    style while the field is empty.
  - If the layer's characters are bound to a **string variable** (Figma's text binding), typing writes the variable —
    two-way binding, like `v-model` — so other layers and screens bound to it update, and Conditionals can test it.
  - Without a variable, the typed text is kept by semantic path, like component states, so the same field on the next
    screen shows it.
- **Runtime:**
  - A click focuses the field: caret, selection, ⌘A / C / V / X, ←→, Backspace, IME through a hidden DOM `<textarea>`,
    like the canvas's text editing.
  - The presentation engine's `TextEditor` edits the layer with APPLY_REMOTE writes.
  - Keys go to the field before Key triggers and presentation shortcuts, except Enter (single-line), Esc and Tab.
  - Every keystroke fires the field's (and its ancestors') "Key/Gamepad: any key" — see item 13 for "On change"; tonight
    the variable is what other layers read.
- **Store:** `@ours` `NodeChange.prototypeTextInput = 1004` (`TextInputSettings {type, multiline, maxLength}`, absent =
  off), overridable on instances. Typed values are runtime only.
- **Panel:** Prototype tab, a "Text input" section below "Scroll behavior" when a text layer is selected; Figma's
  section style (title + toggle, then rows).
- **Effort:** M. **Value:** very high — Figma's most requested prototype gap.

**2. Keyboard focus, Tab order and `:focus-visible`**
- **Set up:** automatic. Focusable layers:
  - hotspots with On click / Mouse down / Mouse up / While pressing;
  - text inputs (item 1);
  - text hyperlinks.
- **Order:** Figma's accessible-prototype rule (A11Y-PROTO) — layer order, auto layout following its direction —
  across the topmost overlay, else the screen. Tab / ⇧Tab move; focus starts at the screen's first focusable layer.
- **Focus state:**
  - If the focused layer is an instance whose component set has a variant whose state value is "Focus" / "Focused"
    (same other properties), the player does a Change to into it and back on blur: the `:focus` variant.
  - Otherwise it draws a 2 px focus ring (`OverlayStyle`, the web's default blue, offset 2, following the layer's
    corner radius). The ring is drawn **only for keyboard focus**, as `:focus-visible` — a mouse click focuses without a
    ring.
  - Hover interactions also run while focused, as Figma's accessible mode does (A11Y-BLOG).
- **Store:** runtime only. Later, an optional `@ours` `prototypeFocus = 1010` (not focusable / tab order) for
  exceptions.
- **Panel:** none tonight.
- **Effort:** M. **Value:** high.

**3. Enter / Space activate the focused element; Esc closes**
- **Set up:** automatic.
- **Enter:**
  - On a focused hotspot, Enter runs its On click (Mouse down → Mouse up → On click, with the pressed state for one
    frame).
  - Space does the same, except on Navigate / Open link hotspots — links take Enter only, as the web does.
  - Enter in a single-line text input runs the field's Key/Gamepad "Enter" trigger, else the On click of the first
    layer named like a submit button ("Submit", "Continue", "Sign in"; heuristic; off by default) — see item 14.
- **Esc:**
  - Esc that no Key trigger took closes the topmost overlay that closes on click outside (a dismissible one), or blurs a
    focused field.
  - On the base screen, Esc does nothing.
- **Precedence:** Key triggers always come first (Figma's rule), so explicit setups still win.
- **Store:** runtime only. **Effort:** S. **Value:** high.

**4. Modal focus trap and focus return**
- **Set up:** automatic.
- **Rules:**
  - While an overlay with a background is open, Tab cycles inside it.
  - On close, focus returns to the hotspot that opened it, found by key (`Player::keyOf`), as the web's dialog pattern
    does.
- **Store:** runtime only. **Effort:** S (on top of item 2). **Value:** medium-high.

**5. Arrow keys in menus, tabs and lists (roving focus)**
- **Set up:** automatic, inside an auto-layout parent whose children are focusable.
  - ↑↓ move focus in a vertical stack, ←→ in a horizontal one; Home / End go to the ends.
  - In an overlay (a dropdown or menu), ↓ from the opener's focus goes to the first item.
- Moving focus runs no actions — "selection follows focus" for tabs is opt-in later, `prototypeFocus`.
- **Store:** runtime only. **Effort:** S. **Value:** medium-high for menus and selects.

**6. Anchored popovers: follow the anchor, flip and shift at the edges**
- **Set up:** applies to overlays placed **Manual** (opened from a hotspot).
  - **Follow:** the overlay keeps its offset from its hotspot while the screen or a scroller under it scrolls, as Floating
    UI's `autoUpdate` does. Overlays with a background are unaffected (scroll is locked under them).
  - **Flip:** if it would run past the window's bottom (or right), it opens on the other side of its hotspot:
    `y = hotspot top − overlay height − offset.y`.
  - **Shift:** otherwise it is clamped inside the window with 8 px of margin.
- **Store:**
  - `@ours` `NodeChange.overlayEdgeBehavior = 1005` on the overlay frame (enum `OverlayEdge {AUTO = 0 (flip + shift +
    follow), NONE = 1 (Figma's), FOLLOW_ONLY = 2}`), next to `overlayFitWindow`.
  - Absent = AUTO while Website behaviours is on; NONE when it is off.
- **Panel:** Prototype › Overlay, a row "Keep in window" (checkbox) under "Fit to window", shown only when the position
  is Manual.
- **Effort:** M. **Value:** high — dropdowns, date pickers, account menus.

**7. Breakpoints: the screen switches to its other size on window resize**
- **Set up:** Figma's own naming convention, which state sharing already uses (STATE).
  - Top-level frames named alike — the same name, or the same prefix before " / ", e.g. "Home / Desktop" 1440, "Home /
    Tablet" 834, "Home / Mobile" 390 — form one responsive group.
  - Under Responsive (no device), the player shows the group's frame with the largest width ≤ the window's width (the
    smallest one below every width). Width is the breakpoint's min width, as Sites' `breakpointMinWidth`.
  - On a resize across a breakpoint, it swaps screens instantly (no history entry, like `replaceOverlays`).
  - Scroll positions, component states, typed text and variables carry over by semantic path — the same carry as
    Navigate (`carryScroll`, `carryComponentStates`).
- **Store:**
  - Runtime only; nothing stored when names match.
  - Later: an explicit min width on a top-level frame in Figma's field `breakpointMinWidth = 501`, export-gated by the
    probe in §0.
- **Panel:** the presentation's Options menu shows "Switch breakpoints" (on by default under Website behaviours).
- **Effort:** M. **Value:** very high for the owner's desktop/mobile files.

**8. Interruptible transitions (hover in / out mid-animation)**
- **Set up:** automatic.
- **Rules:**
  - When a Change to on an instance starts while that instance is animating (a hover's revert, a quick re-hover), the
    new animation starts from the **drawn** values: `snapshot` reads `drawnProps` — the current frame's interpolated
    props — instead of `props()`.
  - Its duration is scaled by the progress already made, so the reversal is shortened as in CSS (`duration × p` when
    reversing to the previous state).
  - Same for screen transitions: a click mid-transition retargets instead of jumping to the end (Figma jumps;
    `Player::startAnim` → `finishAnim`).
- **Store:** runtime only. **Effort:** M (instance swaps first: S–M). **Value:** high — "jank" on quick hovers is what
  makes a prototype feel fake.

**9. Toast queue: stacked, auto-dismissed overlays**
- **Set up:** on the overlay frame, Prototype › Overlay › **Stack**: None (Figma's) / Stack, with a gap.
  - When several overlays with Stack open at the same preset position, they stack away from that edge (bottom positions
    upwards, top positions downwards) with the gap.
  - When one closes (After delay → Close overlay, already working), the others slide into place with the overlay's own
    transition easing.
  - Optionally cap the number shown (Max, e.g. 3; the oldest closes).
- **Store:** `@ours` `NodeChange.overlayStack = 1007` (`OverlayStack {gap, max}`, absent = none).
- **Panel:** Prototype › Overlay, a "Stack" row with a gap field.
- **Effort:** S–M. **Value:** medium-high (toasts, notifications, snackbars).

**10. Cursor types per hotspot**
- **Automatic** (Website behaviours on):
  - `pointer` over click hotspots (as now);
  - `text` (I-beam) over text inputs;
  - `grab` over On drag hotspots and scrollers being dragged, then `grabbing`;
  - `not-allowed` over disabled instances (item 11);
  - `default` elsewhere.
- **Explicit:** Prototype › Interactions header area gets a "Cursor" dropdown: Auto, Default, Pointer, Text, Grab, Move,
  Not allowed, Help, Zoom in, Zoom out, Crosshair, None. Shown for any selected layer; inherited by descendants, like
  CSS.
- **Store:**
  - `@ours` `NodeChange.prototypeCursor = 1006`, an enum, absent = Auto.
  - A custom cursor drawn by a layer goes later into Figma's `behaviors.cursor` (`CursorBehavior`).
- **Engine:** `Player::stateJson` gains `cursor` (a string); `PresentationView` sets it.
- **Effort:** S. **Value:** medium — small, but every hover tells.

**11. Disabled instances**
- **Set up:** automatic, from Figma's naming. An instance whose variant property value is "Disabled" (any property,
  case-insensitive, e.g. State=Disabled), or whose boolean component property named "Disabled" is true:
  - runs no interactions;
  - is not focusable;
  - shows the `not-allowed` cursor;
  - lets hovers pass through to its parent.
- If a Set variable later switches it to another state, it is live again.
- **Store:** runtime only. **Effort:** S. **Value:** medium-high (forms, steppers).

**12. Typed values and state kept across screens and reloads**
- **Set up:** automatic.
  - Typed text (item 1) carries by semantic path, like component states.
  - **Options › "Keep state on reload"** (off by default): variables, typed text, component states and the current
    screen are saved in the presentation view's `sessionStorage`, keyed by file and flow, and restored on reload — the
    `localStorage` / SPA state of a real site.
  - Restart (R) always clears it.
- **Store:** runtime only (browser session storage, never the document).
- **Effort:** S. **Value:** medium.

### Later (after tonight)

| # | Feature, Figma vocabulary | Store | Panel | Effort | Value |
|---|---|---|---|---|---|
| 13 | **Trigger "On change"** (a text input's value changed; a slider moved) and **"While focused"** (A11Y-BLOG's missing trigger). New trigger kinds must not be new `InteractionType` values: an `@ours` field holds them beside the interaction (`prototypeWebTriggers = 1008`, a list of `{trigger, actions}` shaped like `PrototypeInteraction`), shown in the same trigger dropdown after a separator | `@ours` | Trigger dropdown | M | high |
| 14 | **Form submit and validation**: a frame marked as Form (Figma's `accessibleHTMLTag = FORM`, gated), Enter in a field submits = runs the form's "On submit" (from 13); input "Required" / "Pattern" (Email, Number, Min length) → an `:invalid` variant (State=Error) on submit and on blur | `@ours` `TextInputSettings` fields + Figma's tag | Text input section | M | high |
| 15 | **Breakpoint variants inside components**: an instance's variant property named "Breakpoint" / "Size" / "Device" with values matching the responsive group's names switches with the window (media queries in a component); or a variable collection whose modes are named after breakpoints switches mode by width | runtime | — | M | high |
| 16 | **Radio groups**: Change to into a variant whose state is "Selected" / "Checked" / "On" reverts its siblings of the same set in the same auto-layout parent | runtime (opt-out `@ours`) | — | S | medium |
| 17 | **Scroll snap** for horizontal / vertical scrollers: Prototype › Scroll behavior › "Snap to children" (Start / Center), flings land on a child | `@ours` `scrollSnap = 1009` | Scroll behavior section | M | medium-high (carousels) |
| 18 | **Slider / range**: On drag on a thumb inside a track writes a number variable (0–1 or min–max) continuously; the thumb's x is bound to it | `@ours` | Interaction details | L | medium |
| 19 | **Scroll-linked effects**: Reveal on view / Scroll parallax / Scroll transform — Figma's own Sites behaviours `behaviors.appear / scrollParallax / scrollTransform` | Figma field 404 (gated) | A "Behaviors" section | L | medium |
| 20 | **Reduced motion**: honour the OS `prefers-reduced-motion` (transitions → Dissolve 0.15 s, timelines paused), Options toggle | runtime | Options menu | S | medium |
| 21 | **Forward and browser back keys**: ⌘[ / ⌘], mouse buttons 4 / 5, a Forward history (`Player::back` keeps a forward stack); URL `node-id` updated on navigate | runtime | — | S | medium |
| 22 | **Per-property transition timing** (opacity 0.15 s, transform 0.3 s) within one Smart animate | `@ours` | Animation section | L | low-medium |
| 23 | **Repeating lists from data** (Sites' Repeater / CMS) | Figma fields (reserved) | — | L | low for prototypes |
| 24 | **Accessible mode**: an HTML mirror for screen readers (A11Y-PROTO) | runtime | Options › Accessibility settings | L | medium (not "feel") |
| 25 | **Press feedback timing**: a release < 0.1 s after a press waits one frame (REA open item) | runtime | — | S | low |

## 3. Notes for implementation

- **Where the work goes.** All runtime rules belong in `Player`, the C++ player, like every 2026-10-21 rule. The DOM
  side only does the following:
  - forwards keys (Tab, Enter, Space, Esc, arrows, typed text, IME composition) when the player answers "handled";
  - sets the cursor from `stateJson`;
  - hosts the hidden `<textarea>` for item 1.
- **Hit-testing and order.** Focus order uses the same paint order as hits (`Player::topmostFirst`); Canvas stacking
  "First on top" must not reverse the Tab order. Tab order is layer order as Figma's accessible mode reads it (top of
  Layers first), mapped through auto layout's direction.
- **Keys.** One key flows through these steps in order, stopping at the first that takes it:
  1. A focused text input takes text keys.
  2. Key triggers on the topmost screen (Figma's rule, unchanged).
  3. Website-behaviour keys (Tab, Enter, Space, Esc, arrows).
  4. The presentation shortcuts (R, →, Space, N, ←, Z), only when "Enable Figma shortcuts" is on and no field is
     focused.
- **The canvas's text editor.** The text input can reuse the canvas's text editing (`TextEditor`, the canvas's hidden
  textarea bridge) on the presentation's engine. Writes are APPLY_REMOTE (no history, never journaled), and edits are
  undone on stop like other runtime states (`Player::remember`).
- **Multiplayer readiness.** Every addition is either runtime state of one viewer or a per-node field: one top-level
  field = one LWW unit (docs/schema.md §0). Nothing blocks Phase 6.
- **Tests.** Add native tests next to `proto.nested_components.test.cpp` / `proto.instance_interactions.test.cpp` —
  one per rule (Tab order across auto layout, Esc closing only a dismissible top overlay, flip and shift maths,
  breakpoint pick, interrupted hover starting from drawn values, toast stacking offsets). Add exporter tests for every
  new `@ours` field ("stays out of the export").
