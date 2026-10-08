// Figma Draw's brush strokes (docs/engine-build.md "Text round" → BRUSH): a BRUSH node is a brush's artwork (a
// vector: its fill regions in its own W × H box, the stroke's direction along x). A path stroked with a brush
// (NodeChange.strokeBrushGuid) is drawn with that artwork instead of a plain stroke:
//   - STRETCH ("Elongates the brush style along the length of the stroke"): the artwork bent along each contour —
//     x / W → the arc length, (y − H/2) / H → across the path at the stroke's weight;
//   - SCATTER ("Repeats the brush style along the length of the stroke"): stamps of the artwork along each contour,
//     `gap` stamp lengths apart, turned to the path, with Figma's jitters seeded by strokeSeed — or exactly at
//     scatterBrushTransforms, the per-stamp matrices Figma stores.
#pragma once

#include <cstdint>
#include <vector>

#include "geometry/Path.h"
#include "math/Math.h"
#include "scene/Node.h"

namespace eng::geom {

struct ScatterSettings {
  double gap = 1;            // stamp lengths between stamps' starts (≥ 0.25)
  double wiggle = 0;         // random offset across the path, in stamp heights
  double angularJitter = 0;  // ± degrees
  double rotation = 0;       // degrees
  double sizeJitter = 0;     // 0–3: a stamp's size varies by up to this factor
};

// `artwork`: the brush's fill paths (its own space), `box`: its size. `weight`: the stroke weight (the artwork's
// height at the stroke). `reverse`: Direction "Backward" (BrushOrientation REVERSE).
Path stretchBrush(const Path& center, const Path& artwork, Vec2 box, double weight, bool reverse, double tolerance);
Path scatterBrush(const Path& center, const Path& artwork, Vec2 box, double weight, const ScatterSettings& s, uint64_t seed,
                  double tolerance);
// Stamps at Figma's stored transforms (node space, each mapping the artwork's box).
Path scatterAt(const Path& artwork, const std::vector<Mat2x3>& transforms);

}  // namespace eng::geom

namespace eng {

class Document;
struct NodeGeometry;

// A node stroked with a brush (strokeBrushGuid naming a BRUSH node of `doc`): the stroke's outline in node space,
// the brush's artwork laid along `g`'s stroke centre line at the node's stroke weight. False when the node has no
// brush (or its brush isn't in the document): the plain stroke draws. `key` gets a hash of what it was made from.
bool brushStroke(const Document& doc, const NodeProps& p, const NodeGeometry& g, double tolerance, geom::Path& out, uint64_t* key = nullptr);
// The BRUSH node a node's stroke uses (kNoGuid: none).
Guid strokeBrushOf(const NodeProps& p);

}  // namespace eng
