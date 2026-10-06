#include "editor/Selection.h"

#include <cmath>
#include <unordered_set>

namespace eng {

namespace {

// The node's world rotation (radians) when it has no skew and no flip mismatch; NaN otherwise.
double rotationOf(const Mat2x3& m) {
  double sx = std::hypot(m.m00, m.m10), sy = std::hypot(m.m01, m.m11);
  if (sx == 0 || sy == 0) return std::nan("");
  double dot = (m.m00 * m.m01 + m.m10 * m.m11) / (sx * sy);
  if (std::fabs(dot) > 1e-6 || m.determinant() < 0) return std::nan("");
  return std::atan2(m.m10, m.m00);
}

}  // namespace

SelectionBox selectionBox(const Document& doc, const std::vector<Guid>& selection) {
  SelectionBox box;
  std::vector<Guid> live;
  for (Guid id : selection)
    if (doc.has(id)) live.push_back(id);
  if (live.empty()) return box;
  box.valid = true;
  if (live.size() == 1) {
    Rect lb = doc.localBounds(live[0]);
    box.toWorld = doc.worldTransform(live[0]) * Mat2x3::translate(lb.x, lb.y);
    box.size = {lb.w, lb.h};
    return box;
  }
  // Same rotation for all: the box in that rotated frame.
  double angle = rotationOf(doc.worldTransform(live[0]));
  bool shared = !std::isnan(angle) && std::fabs(angle) > 1e-9;
  for (size_t i = 1; shared && i < live.size(); i++) {
    double a = rotationOf(doc.worldTransform(live[i]));
    shared = !std::isnan(a) && std::fabs(a - angle) < 1e-6;
  }
  Mat2x3 frame = shared ? Mat2x3::rotate(angle) : Mat2x3{};
  Mat2x3 toFrame = frame.inverse();
  bool any = false;
  Rect r;
  for (Guid id : live) {
    Rect lb = doc.localBounds(id);
    Rect b = transformedBounds(toFrame * doc.worldTransform(id) * Mat2x3::translate(lb.x, lb.y), lb.w, lb.h);
    r = any ? r.united(b) : b;
    any = true;
  }
  box.toWorld = frame * Mat2x3::translate(r.x, r.y);
  box.size = {r.w, r.h};
  return box;
}

std::vector<Guid> topLevelSelection(const Document& doc, const std::vector<Guid>& selection) {
  std::unordered_set<Guid, GuidHash> chosen(selection.begin(), selection.end());
  std::vector<Guid> out;
  for (Guid id : selection) {
    if (!doc.has(id)) continue;
    bool covered = false;
    int guard = 0;
    for (Guid p = doc.parentOf(id); p != kNoGuid && !covered && guard < 100000; p = doc.parentOf(p), guard++)
      if (chosen.count(p)) covered = true;
    if (!covered) out.push_back(id);
  }
  return out;
}

}  // namespace eng
