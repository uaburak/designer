import type { DefaultSkill } from "./types";

export const THEME_FACTORY: DefaultSkill = {
  name: "theme-factory",
  description:
    "Build themes in Wecra with variable collections and modes: primitives, semantic colour roles bound to layers, Light / Dark / brand modes, switching a frame's mode, and a prototype theme toggle. Use when asked for a dark mode, a theme, a new colour scheme, a white-label / multi-brand version, or to make colours switchable.",
  instructions: `Themes are two layers of variables: primitives (what colours exist) and semantic roles (what a colour is for). Layers bind only to roles; modes change what roles point to.

## 1. Read what exists
get_variable_defs {all: true}. Reuse existing collections; never make a second "Color" collection beside one. get_design_context on a typical frame shows which fills are raw and which are bound.

## 2. Primitives
- create_variable_collection {name: "Primitives"} with one mode. COLOR variables per hue and step: "blue/50" … "blue/950", "neutral/0" … "neutral/1000" (neutrals tinted toward the brand hue, see frontend-design). 9–11 steps per hue; even lightness steps.
- Hide them from publishing when the file is a library (hiddenFromPublishing: true) — consumers should use roles.

## 3. Semantic roles with modes
- create_variable_collection {name: "Theme", modes: ["Light", "Dark"]} (add brand modes: ["Light", "Dark", "Acme Light", "Acme Dark"] — or a separate "Brand" collection when brand and light/dark vary independently).
- Roles as aliases to primitives per mode: create_variable {name: "bg/default", type: "COLOR", values: {"Light": {alias: "<neutral/0 id>"}, "Dark": {alias: "<neutral/950 id>"}}}. A useful minimum set:
  bg/default, bg/subtle, surface/default, surface/raised, border/default, border/strong, text/primary, text/secondary, text/disabled, text/on-accent, accent/default, accent/hover, accent/pressed, focus/ring, status/success, status/warning, status/danger (+ their "on" texts), overlay/scrim.
- Scope them (scopes: FRAME_FILL / SHAPE_FILL for bg and surface, TEXT_FILL for text, STROKE_COLOR for border) so the pickers only offer sensible ones; add codeSyntax {WEB: "var(--bg-default)"} when the team codes from it.
- Dark is not inverted light: lift surfaces as they rise (raised = lighter in dark), lower saturation of accents by ~10–20 %, keep text/primary at ~90 % white, not #FFF; shadows become borders or lighter surfaces.
- FLOAT roles too when themes differ in shape: radius/control, radius/card, border/width.

## 4. Bind
- bind_variable on every themed layer: field "fills[0]" (or "fill"), "strokes[0]", "effects[0].color", cornerRadius. Work frame by frame; texts get text/*, containers bg/* or surface/*, dividers border/*.
- Components: bind inside the main components so every instance follows.
- Afterwards nothing themed should keep a raw colour: get_design_context and look for unbound fills.

## 5. Use the modes
- A frame shows a mode with set_variable_mode {nodeIds: [frame], collectionId: "<Theme id>", mode: "Dark"} — duplicate_nodes the Light screen and switch the copy to compare side by side.
- Prototype toggle: add_interaction on the toggle {trigger: {type: "ON_CLICK"}, actions: [{type: "SET_VARIABLE_MODE", variableCollectionId: "<Theme id>", variableModeId: "<Dark id>"}]}; a second state of the toggle (a variant) sets Light back.
- New brand: edit_variable_collection {collectionId: "Theme", action: "duplicate_mode", mode: "Light"}, rename it (action "rename_mode"), then set_variable_value only the roles that differ (usually accent/* and maybe radius).

## 6. Check
- get_screenshot each mode; contrast in every mode per the accessibility-audit skill (dark modes often fail on text/secondary and on accent text).

## Checklist
- [ ] Primitives collection + a semantic Theme collection with modes
- [ ] Roles alias primitives; scoped; dark tuned, not inverted
- [ ] Every themed layer (and main components) bound to roles
- [ ] Frames switched with set_variable_mode; toggle via SET_VARIABLE_MODE if asked
- [ ] Each mode screenshotted and contrast-checked`,
};
