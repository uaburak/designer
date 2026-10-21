import type { DefaultSkill } from "./types";

export const DEV_HANDOFF: DefaultSkill = {
  name: "dev-handoff",
  description:
    "Prepare designs for developers in Wecra's Dev Mode: clean names and structure, tokens bound, annotations and measurements, export settings for assets, states and edge cases documented, then Ready for dev (set_dev_status). Use when asked to hand off, prepare for dev, annotate, spec, or mark ready for development.",
  instructions: `A developer should build it from the file without asking. Change only names, annotations, export settings and status unless asked to fix the design.

## 1. Audit the frames (get_metadata, get_design_context)
- Names: frames and sections named by what they are ("Checkout / Payment / Desktop"); layers by role ("Header", "Price", "CTA") — no "Frame 123", "Group 4", "Rectangle". Rename with update_nodes {name}.
- Structure: auto layout everywhere it behaves like flex in code; no stray groups around single layers; hidden leftovers removed (ask before delete_nodes).
- Tokens: colours, spacing, radius, type bound to variables / styles (wecra-design-system skill). Developers see variable names and codeSyntax in Dev Mode — add codeSyntax {WEB: "var(--…)"} to variables that lack it when the team uses CSS variables.
- Components: instances, not detached copies; variant names match the code's props (component-authoring).

## 2. States and edge cases
Make sure the hand-off includes, as frames or variants beside the main screen: hover / focus / pressed / disabled for interactive components, empty, loading, error, long-text and many-items versions, and Mobile / Desktop sizes. Missing ones: list them for the owner; draw them only if asked.

## 3. Annotations and measurements
- Annotations explain what the design can't show: behaviour, logic, data source, accessibility (focus order, labels, roles), animation timing, truncation rules. set_properties {annotations} on the layer — describe_schema {field: "Annotation"} gives the shape (a label and pinned properties such as width, padding, fills, typography). One annotation per decision, short: "Truncate to 2 lines, then '…'; full text in a tooltip."
- Measurements between layers developers might get wrong (custom offsets, overlaps) — in the same annotations shape where supported; otherwise mention them in an annotation's label.
- Motion: duration and easing per transition ("Overlay: Smart animate 300 ms ease-out"); a timeline's details via get_motion.

## 4. Assets
- Icons and illustrations as components or vectors with clear names ("icon/arrow-right"); photos as image fills.
- Export settings on what developers export: set_properties {exportSettings: [...]} (SVG for icons, PNG 1x / 2x / 3x for raster, WebP or JPG for photos); describe_schema ExportSettings for the shape. Check with export_nodes {useNodeSettings: true} when asked to deliver files.

## 5. Mark ready
- set_dev_status {nodeIds: [frames or sections], status: "READY_FOR_DEV", description: "what this covers / what changed since last hand-off"}. After a later change: status again with a description of the change. When dev finishes: "COMPLETED". Remove: null.
- Save a named version for the hand-off when asked (save_version "Hand-off: Checkout v2").
- Leave a summary comment on the section (add_comment): scope, open questions, links to flows (prototype starting points).

## Checklist
- [ ] Frames and layers named by role; auto layout; no detached instances
- [ ] Tokens bound; codeSyntax present where the team needs it
- [ ] States and edge cases present or listed
- [ ] Annotations for behaviour, a11y, motion; key measurements noted
- [ ] Export settings on assets
- [ ] Ready for dev set with a description; summary comment left`,
};
