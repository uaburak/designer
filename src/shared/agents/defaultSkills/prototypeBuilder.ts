import type { DefaultSkill } from "./types";

export const PROTOTYPE_BUILDER: DefaultSkill = {
  name: "prototype-builder",
  description:
    "Build prototypes in Wecra that behave like a real website or app: flows and starting points, navigation, Change to on component variants, Smart animate with matching layer names, overlays (Keep in window, Stack, Fit to window), text input fields, Tab order, breakpoints named 'Name / Desktop|Mobile', scrolling with Fixed / Sticky layers, variables and conditionals — verified with get_prototype. Use when asked to prototype, wire up, make clickable or interactive.",
  instructions: `## 1. Plan the flow
- get_metadata of the page and get_prototype (existing flows and interactions). List the screens (top-level frames), the paths between them, and what is an overlay (menus, modals, toasts) versus a screen.
- One flow per task the user tests ("Sign up", "Checkout"): set_flow_starting_point {nodeId: <first screen>, name: "Checkout"}. Device and background: set_prototype_settings {device, backgroundColor}.

## 2. Screens and breakpoints
- Name breakpoint frames "Home / Desktop" and "Home / Mobile" (or "Home / 1440", "Home / 390"): with Website behaviours on and the Responsive device, the player switches between same-named frames at the window width (halfway between widths), keeping component states and scroll. Wire interactions on every size of a screen.
- Flow steps that aren't sizes use words or numbers after the slash ("Checkout / Payment", "Checkout / 2").

## 3. Navigation
- add_interaction {nodeId: <hotspot>, trigger: {type: "ON_CLICK"}, actions: [{type: "NAVIGATE", destinationId, transition: {type: "SMART_ANIMATE", duration: 0.3, easing: "EASE_OUT"}}]}. Back buttons: {type: "BACK"}. Anchors on a long page: {type: "SCROLL_TO", destinationId: <section>}. External links: {type: "URL", url, openInNewTab: true}.
- Put the hotspot on the whole button or row (the instance), not on its text.
- Transitions: Smart animate between screens that share layers; DISSOLVE 0.2–0.3 s otherwise; MOVE_IN / PUSH for mobile stacks; Instant for tabs.

## 4. Smart animate needs matching names
Layers animate between frames when their names and hierarchy paths match ("Card/Title" on both). Rename before wiring (update_nodes {name}). Different names = cross-fade. Keep the same component instances where possible.

## 5. Component interactions (Change to)
States live in the component set (component-authoring skill): on the Default variant {trigger: {type: "ON_HOVER"}, actions: [{type: "CHANGE_TO", destinationId: <Hover variant>, transition: {type: "SMART_ANIMATE", duration: 0.15, easing: "EASE_OUT"}}]}; ON_PRESS → Pressed; ON_CLICK → Selected / Open for toggles, tabs, accordions, checkboxes. Then every instance in every screen is interactive without per-screen wiring. Nested components keep their own states.

## 6. Overlays
- {type: "OPEN_OVERLAY", destinationId: <overlay frame>, overlay: {position: "CENTER", background: "#00000066", closeOnClickOutside: true}} for modals; position "BOTTOM_CENTER" for sheets; "MANUAL" with overlayRelativePosition for dropdowns attached to their trigger.
- Per overlay frame (set_prototype_settings {nodes: [{nodeId, …}]}):
  - overlayEdgeBehavior "AUTO" (Keep in window: a Manual dropdown follows its hotspot on scroll, flips above when there's no room, stays 8 px inside the window) — the default; "NONE" to pin it.
  - overlayStack {gap: 8, max: 3} for toasts at a top / bottom position: they queue and slide; give each toast an AFTER_TIMEOUT {timeout: 3} → CLOSE.
  - overlayFitWindow "WIDTH" | "HEIGHT" | "BOTH" for full-screen menus and sheets.
- Close buttons: {type: "CLOSE"}. Swap one overlay for another: SWAP_OVERLAY.

## 7. Forms and keyboard
- Text fields: set_prototype_settings {nodes: [{nodeId: <the field's text layer>, prototypeTextInput: {type: "TEXT" | "EMAIL" | "PASSWORD" | "NUMBER" | "MULTI_LINE", maxLength}}]}. The text's own characters are the placeholder. Bind the text's characters to a STRING variable (bind_variable field "characters") when other screens must show what was typed ("Hoş geldin, {name}").
- Tab order = auto layout order (then reading order): build forms as vertical auto layout in field order; Focus variants on inputs and buttons (accessibility-audit). Enter / Space activate the focused hotspot; Esc closes dismissible overlays; arrows move inside auto layout groups (tabs, menus).
- Cursors: prototypeCursor "POINTER" etc. only where the default guess is wrong.

## 8. Scrolling
- A screen taller than the device scrolls vertically by itself. Inner scrollers: a frame with clipsContent and overflowDirection "VERTICAL" / "HORIZONTAL" (carousels).
- Headers: scrollBehavior "FIXED" (stays) or "STICKY_SCROLLS" (sticks at the top when reached) on the child, via set_prototype_settings nodes. Fixed layers sit on top of the layer list.

## 9. Logic with variables
- State: create_variable_collection "Prototype" with BOOLEAN / FLOAT / STRING variables (isLoggedIn, cartCount, plan). Change them: {type: "SET_VARIABLE", variableId, variableValue}. Show them: bind_variable characters / visible.
- Branching: {type: "CONDITIONAL", conditionalBlocks: [{condition: <a BOOLEAN variable or expression>, actions: [...]}, {actions: [...]}]}. describe_schema VariableData for expressions.
- Modes: SET_VARIABLE_MODE for language (TR / EN) or theme toggles.
- Timers: AFTER_TIMEOUT on a screen (splash → home).

## 10. Verify
- get_prototype: every hotspot has the intended trigger and destination; no interaction points at a deleted frame; each flow has a starting point; overlays have their settings.
- Walk each flow in your head from the starting point: can the user get back from every screen and close every overlay?
- Tell the owner how to play it (Present, or the inline preview) and which flow to start.

## Checklist
- [ ] Flows with starting points; device set
- [ ] Breakpoints named "Name / Desktop|Mobile" and wired on every size
- [ ] Smart animate layers share names; states in component sets with Change to
- [ ] Overlays positioned with Keep in window / Stack / Fit to window as fitting; every overlay closable
- [ ] Text inputs set; forms in auto layout order; Focus variants
- [ ] Fixed / Sticky headers; inner scrollers; variables and conditionals for logic
- [ ] get_prototype re-read; no dead ends`,
};
