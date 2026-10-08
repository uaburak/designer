// SVG export (docs/engine.md §10.8, E7): a vector writer over the scene, in the
// shape Figma's own SVG export has — `<svg width height viewBox fill="none">`,
// one element per paint (`<rect>`, `<circle>` / `<ellipse>`, `<path>` with the
// coordinates in the file's space), `<g>` only where something needs one
// (opacity, a blend mode, effects, a frame's clip, a mask, an id), and the
// `<defs>` at the end with Figma's ids (`clip0_1_2`, `paint0_linear_1_2`,
// `filter0_d_1_2`, `mask0_1_2`, `pattern0_1_2`, `image0_1_2`; `_1_2` the
// exported layer's GUID):
// - paints: solid (`#RRGGBB`, black / white by name, `fill-opacity`), linear
//   and radial gradients (userSpaceOnUse), angular and diamond gradients as
//   CSS gradients in a `<foreignObject>` clipped to the shape (as Figma does),
//   images as patterns with the file inlined as a data URI;
// - strokes: centre strokes as `stroke` attributes; INSIDE / OUTSIDE ones as
//   an inset / outset shape ("Simplify stroke", plain shapes), as their
//   outlined area (simplify, other shapes), or at twice the weight under a
//   mask of the fill (simplify off: Figma's `path-1-inside-1` masks);
// - effects as filters (drop / inner shadows with spread, layer blur) and
//   background blur as a `backdrop-filter` in a `<foreignObject>`;
// - masks as `<mask>` (alpha, luminance; "Vector" masks by their outline);
// - text as glyph outlines ("Outline text") or as `<text>` / `<tspan>` per line.
#pragma once

#include <string>

#include "export/Export.h"

namespace eng::exporter {

std::string writeSvg(const Document& doc, TextLayouts* texts, const Target& target, const Settings& settings);

}  // namespace eng::exporter
