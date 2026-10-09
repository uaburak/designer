// The planar faces of overlapping shapes (round 12, the Shape builder; help.figma.com "Create custom shapes with the
// shape builder tool": "hover over the individual regions of the selected layers"). Every shape's outline (its fill
// contours, open ones closed) is flattened, the polylines are split where they cross themselves or each other, and
// the resulting planar graph's bounded faces are traced (holes: what lies inside a face without touching it). Each
// face knows which inputs cover it (inside under their own winding rule) and comes back as exact curves: runs of the
// flattened boundary along one input curve become that curve's section (as the booleans do, Boolean.h), so adjacent
// faces share their boundaries exactly and a union of faces is the shapes' own curves again.
#pragma once

#include <cstdint>
#include <vector>

#include "geometry/Path.h"
#include "scene/Node.h"

namespace eng::geom {

struct FaceInput {
  Path path;  // closed contours (open ones are closed)
  WindingRule rule = WindingRule::NONZERO;
};

struct PlanarFace {
  Path path;                                 // the outer contour then its holes (NONZERO: holes wound the other way)
  std::vector<std::vector<Vec2>> rings;      // the same flattened: outer ring first (hit-testing, the overlay)
  std::vector<uint32_t> covers;              // the inputs inside which the face lies (ascending)
  Vec2 sample;                               // a point inside the face
  double area = 0;                           // of the outer ring minus the holes
  bool contains(Vec2 p) const;               // inside the outer ring and outside the holes
};

// The bounded faces of the inputs' arrangement that lie inside at least one input. `tolerance`: how finely curves are
// flattened (input units); `maxEdges` bounds the work (more flattened edges: no faces).
std::vector<PlanarFace> planarFaces(const std::vector<FaceInput>& inputs, double tolerance, size_t maxEdges = 40000);

}  // namespace eng::geom
