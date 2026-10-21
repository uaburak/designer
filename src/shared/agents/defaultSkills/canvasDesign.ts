import type { DefaultSkill } from "./types";

export const CANVAS_DESIGN: DefaultSkill = {
  name: "canvas-design",
  description:
    "Make a poster, cover, key visual, illustration-led graphic or any single composed image in Wecra: a concept, a format, a focal point, a grid, type as image, a limited palette, vector shapes, export. Use for visual pieces that are looked at rather than used (not app screens).",
  instructions: `A poster is one idea seen from three metres. Decide the idea before drawing.

## 1. Concept and format
- One sentence: what the viewer must get in one second, and the feeling. Pick a visual metaphor from the subject (a festival about water → a single horizon line cut across the page; a jazz night → overlapping offset type like a bad print).
- Format first (top-level frame): A-series poster 1190 × 1684 (A2 ratio 1:1.414), story 1080 × 1920, square 1080 × 1080, cover 1600 × 2400, banner 1920 × 1080. For print, keep a 3 % safe margin and note bleed in the frame's description.

## 2. Composition
- One focal point, placed on a third or deliberately off-centre; the eye path goes focal point → headline → details. Squint test with get_screenshot at a small size: the focal point must still read.
- Scale contrast is the main tool: the biggest element 5–10× the smallest text. Leave 30–50 % empty space; empty space is part of the composition, not leftover.
- A grid even when it doesn't show: 6 or 12 columns, a baseline of 8; align the small text blocks to it so the free elements feel intended. Use layoutGrids (set_properties) to keep it visible while working, then hide it.
- Break the grid once, on purpose (one element bleeding off the edge or overlapping the headline).

## 3. Type as image
- Headline set huge and tight (line height 0.85–1.0, letter spacing -2 % to -5 %), maybe one word per line, maybe rotated 90°. Details small and quiet (12–16 at poster scale ×2), one weight.
- Outline text (vectorize via run_command when available) only when you need to shape it; otherwise keep it live text so it stays editable.
- Two typefaces at most; a display face with real character is worth more than effects.

## 4. Colour and texture
- 2–4 colours: a dominant field, a contrasting accent, ink. Choose by the concept (riso-like duotones, a single spot colour on paper white, deep night with one warm light).
- Texture with the file's own paints instead of fake photos: NOISE and TEXTURE paints, GRADIENT_LINEAR / RADIAL / ANGULAR / DIAMOND, a layer blur or progressive blur, blend modes (MULTIPLY for print-like overlaps). describe_schema Paint for the shapes.

## 5. Shapes and imagery
- Draw with create_nodes: rectangles, ellipses (arcData for half circles and rings), stars and polygons, lines; free shapes as svg markup in create_nodes (kept as editable vectors), shapes cut and merged with pathfinder (DIVIDE, TRIM, MERGE, CROP, MINUS_BACK).
- Photos: place_image into a shape so it is cropped by it (nodeId of the shape); duotone it with a colour fill on top in a blend mode.
- Repetition with variation (12 circles, each a little shifted) reads as rhythm: duplicate_nodes then update_nodes with offsets.

## 6. Finish
- Name layers by role ("Headline", "Focal shape", "Date"), group the details into one auto layout block.
- get_screenshot at full size and small size; fix tangents (edges that almost touch), accidental alignments, widows in the headline.
- Export when asked: export_nodes PNG at 2x (screens) or PDF (print); set exportSettings on the frame with set_properties so the owner can re-export.

## Checklist
- [ ] One idea, one focal point, readable as a thumbnail
- [ ] Strong scale contrast, 30–50 % empty space, a grid kept
- [ ] ≤ 2 typefaces, ≤ 4 colours, texture from paints not filler photos
- [ ] Editable vectors and live text; layers named by role
- [ ] Exported in the right format and scale when asked`,
};
