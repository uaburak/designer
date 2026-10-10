# Round 16 — canvas handles: hatch rules, radius handles, inverted corners

The owner's requests (2026-10-10) and what was built. Screens: `canvas16-*-{dark,light}.png` here, written by
`CANVAS16_DOCS=1 EDITOR_ONLY=canvas16 node src/renderer/src/editor/tools/editor-shot.mjs` (24 pixel checks, both themes).

## 1. Auto layout's hatch (the owner's rules)

- A padding under the pointer hatches **only that padding** (`canvas16-padding`).
- With **⌥ held** the opposite padding is hatched too (`canvas16-padding-alt`), and a drag on the bar sets both — both
  outlined while dragging (help.figma.com "Explore auto layout properties": ⌥ the opposite padding); ⌥⇧ all four.
  Pressing or letting go of ⌥ updates the hatch at once, and mid-drag the values.
- A **gap** under the pointer hatches **every gap** (one value; no ⌥ needed) (`canvas16-gaps`).
- The badge and the drag otherwise as round 15 (`docs/research/figma/live/behaviour/spacing-handles.md`).
- The Design panel's padding / gap fields hatch the same while hovered, focused or scrubbed
  (`engine_set_spacing_highlight(h, mask)` / `Engine.setSpacingHighlight(mask)`, built by r16-inputs; checked here with
  the bottom padding, the pointer away: `canvas16-panel-highlight`).

## 2. Corner radius handles

- The radius dots now show on **frames, components and instances** as well as rectangles (not sections).
- A drag sets **every corner**; **⌥** only the dragged one (help.figma.com "Adjust corner radius and smoothing").
- **⌘ — the owner's addition**: the rounding goes **inward** (concave). Figma has no equivalent: its corner radius
  controls only round outward, and inverted corners are an open feature request
  ([forum.figma.com "corner styles"](https://forum.figma.com/suggest-a-feature-11/corner-styles-16964); the suggested
  workaround is subtracting circles, which breaks on resize). So: ⌘ all corners inward, ⌘⌥ the dragged one inward,
  ⌥ the dragged one outward, no modifier all outward. One undo step per drag (`canvas16-radius-inverted`,
  `canvas16-radius-one-inverted`; the owner's reference: a quarter circle cut out of a corner).

## 3. Inverted corners in the document

- Our own schema field `NodeChange.invertedCornerMask = 1002` (`@ours`, docs/schema.md §3.6): a bit per corner
  (1 top-left, 2 top-right, 4 bottom-right, 8 bottom-left). The radius stays in Figma's fields.
- Geometry: the outward corner's curve mirrored across its chord — a quarter circle around the corner itself (smoothed
  corners mirror the same way). Drawn from the outline's path on WebGL2 and WebGPU (fills, strokes, per-side strokes,
  background blur, Outline mode, the selection outline), **clipping** a frame's content (`canvas16-frame-clip`),
  **hit-testing** (nothing in the cut-away disc), SVG / PDF export as a path.
- Design panel: an inverted corner reads as a **negative radius** (the all-corners field when all four are inverted);
  typing or stepping to a negative number turns that corner inward, a positive one outward again.
- Native tests: `engine/tests/unit/r16.canvas_handles.test.cpp` (hatch incl. ⌥ / ⌥⇧ / gaps / panel highlight; radius
  drags all / ⌥ / ⌘ / ⌘⌥ / ⌘ let go mid-drag / frames / instances; geometry, hits, clicks, kiwi + JSON round trip, SVG).
