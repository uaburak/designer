#include "hit/HitTest.h"

#include <algorithm>
#include <cmath>

namespace eng {

namespace {

bool anyVisible(const std::vector<Paint>& paints) {
  for (auto& p : paints)
    if (p.visible) return true;
  return false;
}

double shapeDistance(const NodeProps& p, Vec2 local) {
  Vec2 half{p.size.x / 2, p.size.y / 2};
  Vec2 c = local - half;
  if (p.type == NodeType::ELLIPSE) return sdEllipse(c, half);
  double radii[4] = {p.cornerRadii[0], p.cornerRadii[1], p.cornerRadii[2], p.cornerRadii[3]};
  return sdRoundedBox(c, half, radii);
}

}  // namespace

bool hitsOwnShape(const NodeProps& p, Vec2 local, double slop, bool topLevel) {
  double d = shapeDistance(p, local);
  bool fill = anyVisible(p.fillPaints);
  bool stroke = anyVisible(p.strokePaints) && p.strokeWeight > 0;
  double inner = 0, outer = 0;
  if (stroke) {
    double w = p.strokeWeight;
    switch (p.strokeAlign) {
      case StrokeAlign::INSIDE: inner = w; break;
      case StrokeAlign::OUTSIDE: outer = w; break;
      default: inner = outer = w / 2;
    }
  }
  if (p.isFrameLike()) {
    // A frame is hit in its box when it shows something there, or when it is top-level.
    if ((fill || stroke || topLevel) && d <= outer) return true;
    if (!stroke) return false;
  } else if (fill || !stroke) {
    if (d <= std::max(outer, 0.0) + (fill ? 0 : slop)) return true;
    if (!stroke) return false;
  }
  // The stroke: within max(half its width, slop) of its centre line.
  double centre = (outer - inner) / 2, half = (outer + inner) / 2;
  return std::fabs(d - centre) <= std::max(half, slop);
}

namespace {

// Calls f(path) for each node hit at `world`, topmost first; stops when f returns false.
template <typename F>
void forEachHit(const Document& doc, Guid page, Vec2 world, double pixel, F&& f) {
  // Candidates from the page's spatial index, topmost first; a candidate counts when
  // its own geometry is hit and no hidden ancestor hides it and no clipping ancestor
  // cuts it off.
  double reach = pixel * kHitSlopCss;
  std::vector<Guid> candidates;
  doc.query(page, {world.x - reach, world.y - reach, 2 * reach, 2 * reach}, [&](Guid id) {
    candidates.push_back(id);
    return true;
  });
  std::sort(candidates.begin(), candidates.end(), [&](Guid a, Guid b) { return doc.paintsBefore(b, a); });
  for (Guid id : candidates) {
    const Node* n = doc.get(id);
    if (!n || n->props.isGroupLike() || !doc.visibleInTree(id)) continue;  // groups are hit through their children
    bool clipped = false;
    for (Guid a = n->props.parentIndex.guid; a != kNoGuid && !clipped;) {
      const Node* an = doc.get(a);
      if (!an || an->props.type == NodeType::CANVAS) break;
      if (an->props.clipsContent()) {
        Mat2x3 m = doc.worldTransform(a);
        double unit = std::sqrt(std::fabs(m.determinant()));
        double slop = (unit > 0 ? pixel / unit : pixel) * kHitSlopCss;
        if (!hitsOwnShape(an->props, m.inverse().apply(world), slop, true)) clipped = true;
      }
      a = an->props.parentIndex.guid;
    }
    if (clipped) continue;
    Mat2x3 m = doc.worldTransform(id);
    double unit = std::sqrt(std::fabs(m.determinant()));
    double slop = (unit > 0 ? pixel / unit : pixel) * kHitSlopCss;
    bool topLevel = n->props.parentIndex.guid == page;
    if (!hitsOwnShape(n->props, m.inverse().apply(world), slop, topLevel)) continue;
    std::vector<Guid> path = doc.pathFromPage(id);
    for (size_t i = 0; i < path.size(); i++) {
      const Node* pn = doc.get(path[i]);
      if (pn && pn->props.locked) {
        path.resize(i);
        break;
      }
    }
    if (!f(std::move(path))) return;
  }
}

}  // namespace

std::vector<Guid> hitPath(const Document& doc, Guid page, Vec2 world, double pixel) {
  std::vector<Guid> out;
  forEachHit(doc, page, world, pixel, [&](std::vector<Guid> path) {
    out = std::move(path);
    return false;
  });
  return out;
}

std::vector<std::vector<Guid>> hitPaths(const Document& doc, Guid page, Vec2 world, double pixel) {
  std::vector<std::vector<Guid>> out;
  forEachHit(doc, page, world, pixel, [&](std::vector<Guid> path) {
    if (path.empty()) return true;
    for (const auto& seen : out)
      if (seen.size() >= path.size() && std::equal(path.begin(), path.end(), seen.begin())) return true;
    out.push_back(std::move(path));
    return true;
  });
  return out;
}

}  // namespace eng
