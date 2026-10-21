import type { DefaultSkill } from "./types";

export const COMPONENT_AUTHORING: DefaultSkill = {
  name: "component-authoring",
  description:
    "Build reusable components in Wecra: auto layout mains, component sets with well-named variant properties, boolean / text / instance-swap properties, interactive states (Default, Hover, Pressed, Focus, Disabled) wired so prototypes and Website behaviours work, and override-friendly layer names. Use when asked to make a component, a variant set, a button / input / card system, or to fix components that don't behave in prototypes.",
  instructions: `## 1. Plan the API before drawing
Write the component's props as code would: e.g. Button — Variant (Primary | Secondary | Ghost | Danger), Size (S | M | L), State (Default | Hover | Pressed | Focus | Disabled), Icon left (boolean), Icon (instance swap), Label (text). Rules:
- Variant properties only for things that change the structure or look across a fixed set (Variant, Size, State). Text content → TEXT property. Show / hide → BOOLEAN property. Icons → INSTANCE_SWAP property. This keeps the set small (Variant × Size × State, not × every icon).
- Names in Title case, values in Title case, no "=" or "," in names: "State=Hover" style is what Wecra writes in the variant's name.
- Keep values consistent across components (always "Disabled", never "Inactive" in one and "Off" in another).

## 2. Build the base
- One frame with auto layout (create_nodes layoutMode HORIZONTAL / VERTICAL; padding and gap bound to spacing variables; hug content; min width where labels vary). Fills, strokes and radius bound to theme variables (theme-factory / wecra-design-system skills) so the component follows modes.
- Layer names describe roles, not looks: "Container", "Label", "Icon left", "Icon right", "Spinner" — never "Frame 12", "Rectangle 4". Overrides survive variant switches only when layer names (paths) match across variants, so every variant keeps the same names and structure; hide what a variant doesn't use rather than deleting it.
- Make it a component: run_command {engineCommand: "CREATE_COMPONENT", nodeIds: [frame]}.

## 3. Variants
- Duplicate the main per variant (duplicate_nodes), change only what differs, name each "Variant=Primary, Size=M, State=Hover".
- Combine: run_command {engineCommand: "COMBINE_AS_VARIANTS", nodeIds: [...]}. Later additions: ADD_VARIANT; renaming: SET_VARIANT_PROPERTIES. Lay the set out as a grid (auto layout wrap, gap 16–24) — states in columns, variants × sizes in rows.
- describe_schema {field: "COMBINE_AS_VARIANTS"} (or any command name) gives the exact arguments.

## 4. Component properties
- ADD_COMPONENT_PROPERTY on the set (or main): {name: "Label", type: "TEXT", defaultValue: "Button"}, {name: "Icon left", type: "BOOLEAN", defaultValue: false}, {name: "Icon", type: "INSTANCE_SWAP", defaultValue: <icon component id>, preferredValues}.
- Bind them to layers: BIND_COMPONENT_PROPERTY {refs: [layer], field: "characters" | "visible" | "mainComponent", prop: "<property key>"} — in every variant.
- Optional disabled flag: a BOOLEAN property literally named "Disabled" also makes Wecra's player treat the instance as disabled.

## 5. Interactive states (so prototypes behave like a website)
- State values: Default, Hover, Pressed, Focus, Disabled (Selected / Checked / Error / Loading when the component has them). Exactly these words: Wecra's Website behaviours recognise a variant whose value is Focus / Focused / Focus visible as the keyboard focus state, and any variant value "Disabled" as disabled (no interactions, not focusable, not-allowed cursor).
- Wire the interactions on the Default variant inside the set (add_interaction on that variant): {trigger: {type: "ON_HOVER"}, actions: [{type: "CHANGE_TO", destinationId: <Hover variant id>, transition: {type: "SMART_ANIMATE", duration: 0.15, easing: "EASE_OUT"}}]} and {trigger: {type: "ON_PRESS"}, actions: [{type: "CHANGE_TO", destinationId: <Pressed id>, …}]}. While hovering / pressing revert by themselves. describe_schema Reaction for the shapes; get_prototype to read them back.
- Focus variant: Default plus a visible ring (a 2 px stroke outside, or an outer frame stroke bound to focus/ring) with 3:1 contrast; no interactions needed on it (Enter / Space run the Default's click).
- Disabled: lowered contrast but still legible; no interactions.
- Nested interactive components (a Chip inside a Filter bar, a Checkbox inside a List item): each inner component carries its own state interactions; the outer one doesn't need to know. Name the inner instances ("Checkbox", "Chip 1") so states and overrides are kept by path.
- Text fields: the Label/Value text gets Prototype › Text input (set_prototype_settings {nodes: [{nodeId: <text>, prototypeTextInput: {type: "TEXT"}}]}); its parent frame is the box (clicks anywhere on it focus the field); Focus and Error variants for the box.

## 6. Check
- get_screenshot of the set; insert an instance (duplicate an instance next to the set), switch its properties with update_nodes and confirm overrides (label text, icon) survive switching variant.
- Play it: set_flow_starting_point on a test frame holding instances and ask the owner to Tab / hover — or read get_prototype to confirm every Default has its hover / press.

## Checklist
- [ ] API planned: variants only for structure; TEXT / BOOLEAN / INSTANCE_SWAP for the rest
- [ ] Auto layout, tokens bound, role-named layers identical across variants
- [ ] Set combined and laid out as a grid; property names / values consistent
- [ ] States Default / Hover / Pressed / Focus / Disabled with hover / press Change to
- [ ] Overrides survive variant switches; nested components keep their own states`,
};
