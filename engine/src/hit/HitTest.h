// What is under a point, geometry-accurate (rounded corners, ellipses,
// strokes, frame clipping), and which of it a click picks — Figma's rules as
// in src/renderer/src/figma/picking.ts (docs/engine.md §8.2).
#pragma once

#include <vector>

#include "scene/Document.h"

namespace eng {

// The slop for strokes and thin shapes, in CSS px (docs/engine.md §8.2).
inline constexpr double kHitSlopCss = 4;

// Whether `local` (in the node's own space) is on the node's own geometry:
// its fill (or its whole shape when it has neither fill nor stroke), its stroke
// within max(half its width, `slop`); a frame anywhere in its box when it has a
// visible fill or stroke or `topLevel`. Children not included.
bool hitsOwnShape(const NodeProps& p, Vec2 local, double slop, bool topLevel);

// The ids from the page's direct child down to the innermost visible node under
// `world`. Hidden nodes and what's in them are skipped; children outside a
// clipping frame don't count; groups are hit only through their children; the
// path stops before the first locked node. `pixel` is one CSS px in world units.
std::vector<Guid> hitPath(const Document& doc, Guid page, Vec2 world, double pixel);

// Every layer under `world`, topmost first, each as its path from the page's
// direct child down to it (the same rules as hitPath); a path that is the
// prefix of one already listed (a frame under its own hit child) isn't repeated.
// For the context menu's "Select layer".
std::vector<std::vector<Guid>> hitPaths(const Document& doc, Guid page, Vec2 world, double pixel);

}  // namespace eng
