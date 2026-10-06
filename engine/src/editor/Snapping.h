// Snapping, smart guides and measurement (docs/engine.md §8.5): a moving box
// (or a dragged edge) snaps to the edges and centres of its siblings and its
// parent frame, or to equal spacing between them, within 6 CSS px; what it
// snapped to is shown with red guides spanning the objects involved. ⌥ shows
// distances from the selection to the hovered layer.
#pragma once

#include <optional>
#include <vector>

#include "math/Math.h"

namespace eng {

// A red guide line, world coordinates.
struct GuideLine {
  Vec2 a, b;
};

// A measured distance: a red line from a to b with end ticks and a pill for the
// number (the number itself comes with text, E3).
struct SpacingMark {
  Vec2 a, b;
};

struct SnapResult {
  Vec2 offset;  // add to the moving box / point
  bool snappedX = false, snappedY = false;
  std::vector<GuideLine> guides;
  std::vector<SpacingMark> spacings;
};

class Snapper {
 public:
  // What can be snapped to: sibling boxes (world AABBs) and the parent frame's box.
  void reset(std::vector<Rect> boxes, std::optional<Rect> container);
  bool empty() const { return boxes_.empty() && !container_; }

  // Snaps a moving box: its edges and centre to theirs, or to equal spacing.
  SnapResult snapBox(const Rect& moving, double threshold, bool snapX = true, bool snapY = true) const;
  // Snaps one dragged point (a resize edge, a drawing corner) to their edges and
  // centres; `box` is the box being shaped once snapped (for the guides' extent).
  SnapResult snapPoint(Vec2 p, double threshold, bool snapX, bool snapY) const;
  // The guides for a box that is already in place (after snapPoint moved its edge).
  std::vector<GuideLine> guidesFor(const Rect& box, bool x, bool y) const;

 private:
  std::vector<Rect> boxes_;
  std::optional<Rect> container_;
};

// Figma's ⌥ measurement between the selection's box and the hovered layer's box
// (both world AABBs): the distances between them (or to the edges of the one
// containing the other), plus guides where a line has to be extended to reach.
void measureBetween(const Rect& selection, const Rect& hovered, std::vector<SpacingMark>& marks, std::vector<GuideLine>& extensions);

}  // namespace eng
