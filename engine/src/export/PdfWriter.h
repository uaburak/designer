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
// - text as glyphs (Figma: "text is exported as glyphs"), with ToUnicode maps
//   so it can be selected and copied: a font that draws its file's own glyf
//   outlines (TrueType; a variable font at its default instance) embedded as a
//   subset TrueType (Type 0 over CIDFontType2, Identity-H, Figma's
//   `/Registry (FigmaPDF)`; export/TrueType.h), any other as Type 3 fonts whose
//   glyph procedures are the outlines (atlas 15 §9);
// - tagged (atlas 15 §9: Figma's StructTreeRoot, MarkInfo, ActualText): a
//   Document element with a P per text layer over its marked content (on the
//   page or in a group's form XObject), the parent tree, /Tabs /S.
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
