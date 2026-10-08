// PDF export (docs/engine.md §10.8, E7): a vector writer over the scene, PDF
// 1.7 as Figma writes it ("PDF 1.7", 1 px = 1 pt, one page per exported layer —
// File › Export frames to PDF puts every top-level frame of the page in one
// file). What it writes:
// - paths with the nonzero / even-odd rules, clips for frames, strokes with
//   their caps, joins, dashes (INSIDE / OUTSIDE: twice the weight clipped to
//   the fill's inside / outside; per-side weights and arrowheads as outlines);
// - paints: solid colours, linear and radial gradients as axial / radial
//   shadings, angular and diamond gradients as function shadings (a PostScript
//   calculator function), gradient stop opacity and paint opacity through soft
//   masks and ExtGStates, images as image XObjects (JPEG colour + a soft mask
//   for alpha), tiled images as tiling patterns;
// - opacity on layers that need a group, blend modes, alpha / luminance masks
//   (soft masks), and — PDF having no blur — layers with shadows or blurs drawn
//   as an image of the layer rendered by the engine (as Figma does);
// - text as glyphs: Type 3 fonts whose glyph procedures are the outlines, with
//   a ToUnicode map, so the text is not editable but can be selected and copied
//   (Figma: "text is exported as glyphs").
#pragma once

#include <functional>
#include <string>
#include <vector>

#include "export/Export.h"

namespace eng::exporter {

// A layer rendered with its effects: the subtree of `id` within `world` at `scale` px per unit, straight RGBA8 rows
// top to bottom (false: can't, the layer is written as vectors without its effects).
using Rasterize = std::function<bool(Guid id, const Rect& world, double scale, int& width, int& height, std::string& rgba)>;

std::string writePdf(const Document& doc, TextLayouts* texts, const std::vector<Target>& pages, const Settings& settings,
                     const Rasterize& rasterize);

}  // namespace eng::exporter
