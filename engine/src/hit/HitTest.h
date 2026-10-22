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
// visible fill or stroke or `topLevel`. Children not included. A rectangle or a frame is hit in its whole box, the
// corners its radii cut off included (live Figma, round 15); `clip`: the frame's clipping shape instead (rounded).
bool hitsOwnShape(const NodeProps& p, Vec2 local, double slop, bool topLevel, bool clip = false);

// hitsOwnShape for any node: path shapes (vectors, stars, lines, booleans, arcs, smoothed corners)
// by their geometry — inside a fill under its winding rule, or near the stroke's centre line.
bool hitsNode(const Document& doc, Guid id, Vec2 local, double slop, bool topLevel);

// Whether `local` (node space) is within `slop` of the node's outline — its stroke's centre line or its fill's edge:
// the Text on path tool's target (Figma Draw, docs/draw.md §4.4: the edge of a shape, a vector or a brush stroke).
bool hitsEdge(const Document& doc, Guid id, Vec2 local, double slop);

// The ids from the page's direct child down to the innermost visible node under
// `world`. Hidden nodes and what's in them are skipped; children outside a
// clipping frame don't count; groups are hit only through their children; the
// path stops before the first locked node. `pixel` is one CSS px in world units.
// A transform group's copies hit too: a hit on copy k is a hit on the layer it repeats (docs/draw.md §4.2).
// `open` (what the selected layers are in, Editor::openForHit): a frame in one of them is hit in its whole box even
// when it shows nothing there, as a top-level one — with a variant's "label" selected, the area of its "startContent"
// takes the hover and the click, not only the icon's strokes (live Figma, the owner's 2026-10-23 recording).
std::vector<Guid> hitPath(const Document& doc, Guid page, Vec2 world, double pixel, const std::vector<Guid>* open = nullptr);

// Every layer under `world`, topmost first, each as its path from the page's
// direct child down to it (the same rules as hitPath); a path that is the
// prefix of one already listed (a frame under its own hit child) isn't repeated.
// For the context menu's "Select layer" (`includeLocked`: locked layers and what is in them too — Figma lists them
// there with a padlock).
std::vector<std::vector<Guid>> hitPaths(const Document& doc, Guid page, Vec2 world, double pixel, bool includeLocked = false);

}  // namespace eng
