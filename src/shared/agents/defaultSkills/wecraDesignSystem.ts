import type { DefaultSkill } from "./types";

export const WECRA_DESIGN_SYSTEM: DefaultSkill = {
  name: "wecra-design-system",
  description:
    "Work inside the file's design system: find its tokens (variables, styles) and components — local and from enabled libraries — and use them instead of raw values or look-alike layers. Use whenever you create or change UI in a file that has variables, styles, components or enabled libraries, and when asked to 'use the design system' or 'tokenize' a design.",
  instructions: `Rule: never type a raw value when a token for it exists; never draw a component that exists.

## 1. Inventory (once per task; keep it as notes)
- Local tokens: get_variable_defs {all: true} — collections, modes, every variable with its resolved values, scopes and codeSyntax.
- Tokens on a sample: get_variable_defs on a well-built existing frame (default: the selection) shows which variables and styles that design actually uses — the house conventions.
- Styles: get_design_context of existing screens lists the text / paint / effect / grid styles applied (ids and names).
- Libraries: get_libraries — enabled libraries with their components, styles and variables, plus pending updates. get_libraries {assets: "<libraryFileKey>"} lists a library's published assets (key, kind, name). A library that is relevant but not enabled: ask before set_library_enabled. Pending updates: tell the owner (accept_library_updates only when asked).
- Components: local ones from get_metadata (COMPONENT / COMPONENT_SET), library ones from the assets list. Note their variant properties and component properties.

## 2. Map every need to a token
- Colour → a semantic variable (text/primary, bg/surface …) over a primitive (blue/500); a primitive only if no role fits. Bind with bind_variable {field: "fills[0]" | "strokes[0]" | "effects[0].color"}.
- Spacing, radius, sizes, stroke widths → FLOAT variables bound to itemSpacing, padding*, cornerRadius, strokeWeight, width / height.
- Type → a text style (apply_style {slot: "text"}); if the system has typography variables (fontFamily, fontSize, lineHeight), bind those instead.
- Shadows and blurs → effect styles (apply_style {slot: "effect"}); grids → grid styles.
- Copy that switches language or content → STRING variables bound to characters.
- Matching: exact resolved value first; otherwise the nearest token on the scale — and say in your answer that you rounded (e.g. 18 → space/16). Respect scopes (a TEXT_FILL variable isn't for frames).
- No token fits and the value will repeat: propose a new token (create_variable in the right collection, sensible name and scopes) rather than a raw value; a one-off: use raw and mention it.

## 3. Components before layers
- Buttons, inputs, cards, nav, list items, badges, icons: instances. Local: duplicate_nodes an existing instance (or the component's instance) and reparent_nodes it; library: insert_library_component {library, key, x, y} then reparent_nodes into place.
- Configure instances through their properties, not by detaching: variant properties and component properties (TEXT, BOOLEAN, INSTANCE_SWAP) via update_nodes / set_properties componentProperties (describe_schema for the shape). Swap icons with the INSTANCE_SWAP property.
- Never detach an instance to restyle it. Missing variant? Tell the owner, or add it to the main component (component-authoring skill) when asked.

## 4. Tokenize an existing design (on request)
1. get_design_context of the frame; list raw values by property.
2. Group equal values; map each group to a token (step 2).
3. Bind in batches per token (bind_variable with nodeIds), apply styles, swap look-alike layers for instances.
4. Report what stayed raw and why.

## 5. Verify
get_design_context again: bound variables and styles show on each layer; nothing important raw. get_screenshot in each mode of the theme collection (set_variable_mode on a duplicate) to see tokens behave.

## Checklist
- [ ] Inventory of variables, styles, components and enabled libraries done
- [ ] Colours, spacing, radius, type and effects bound to tokens / styles
- [ ] Instances (local or library) used; configured by properties, never detached
- [ ] New tokens proposed only for repeating values; roundings reported
- [ ] Re-read with get_design_context; modes checked`,
};
