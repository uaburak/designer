#include "hit/HitTest.h"

#include <algorithm>
#include <cmath>

#include "geometry/Stroker.h"
#include "geometry/VariableWidth.h"

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

bool hitsNode(const Document& doc, Guid id, Vec2 local, double slop, bool topLevel) {
  const Node* n = doc.get(id);
  if (!n) return false;
  const NodeProps& p = n->props;
  // A slice is hit on its edge only (it paints nothing; the layers under it stay clickable — unverified live).
  if (p.type == NodeType::SLICE) return std::fabs(shapeDistance(p, local)) <= slop;
  // A variable-width stroke (round 12): hit within its outline.
  bool variable = !p.extra.empty() && anyVisible(p.strokePaints) && p.strokeWeight > 0 && hasWidthPoints(p) && widthProfileAllowed(p);
  if (!p.isPathShape() && !variable) return hitsOwnShape(p, local, slop, topLevel);
  const NodeGeometry* g = doc.geometry(id);
  if (!g) return false;
  bool fill = anyVisible(p.fillPaints), stroke = anyVisible(p.strokePaints) && p.strokeWeight > 0;
  double tol = std::max(slop / 8, 1e-4);
  bool hasFillArea = false;
  if (fill || !stroke)
    for (auto& f : g->fills) {
      if (f.path.empty()) continue;
      hasFillArea = true;
      if (geom::contains(geom::flatten(f.path, tol), local, f.windingRule == WindingRule::ODD)) return true;
    }
  if (g->stroke.path.empty()) return false;
  if (variable) {
    std::vector<geom::WidthPoint> profile = widthPointsOf(p);
    geom::StrokeStyle style;
    style.width = p.strokeWeight * (p.strokeAlign == StrokeAlign::CENTER ? 1 : 2);
    style.join = p.strokeJoin;
    style.miterLimit = p.miterLimit;
    style.cap = p.strokeCap;
    style.caps = g->stroke.caps.empty() ? nullptr : &g->stroke.caps;
    style.profile = &profile;
    if (geom::contains(geom::flatten(geom::strokePath(g->stroke.path, style, tol), tol), local, false)) return true;
    return geom::distanceTo(geom::flatten(g->stroke.path, tol), local) <= slop;
  }
  // The stroke (or, with nothing painted, the outline): within max(half its reach, slop) of the centre line.
  double half = stroke ? (p.strokeAlign == StrokeAlign::CENTER ? p.strokeWeight / 2 : p.strokeWeight) : 0;
  if (!stroke && hasFillArea) return false;
  return geom::distanceTo(geom::flatten(g->stroke.path, tol), local) <= std::max(half, slop);
}

namespace {

// Calls f(path) for each node hit at `world`, topmost first; stops when f returns false.
template <typename F>
void forEachHit(const Document& doc, Guid page, Vec2 world, double pixel, F&& f, bool includeLocked = false) {
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
    // Groups and boolean operations are hit through their children.
    if (!n || n->props.fitsChildren() || !doc.visibleInTree(id)) continue;
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
      // Inside a boolean operation: only where its result is.
      if (an->props.isBoolean()) {
        Mat2x3 m = doc.worldTransform(a);
        double unit = std::sqrt(std::fabs(m.determinant()));
        double slop = (unit > 0 ? pixel / unit : pixel) * kHitSlopCss;
        const NodeGeometry* g = doc.geometry(a);
        bool inside = false;
        if (g)
          for (auto& f : g->fills) inside |= geom::contains(geom::flatten(f.path, slop / 8), m.inverse().apply(world), false);
        if (!inside) clipped = true;
      }
      a = an->props.parentIndex.guid;
    }
    if (clipped) continue;
    Mat2x3 m = doc.worldTransform(id);
    double unit = std::sqrt(std::fabs(m.determinant()));
    double slop = (unit > 0 ? pixel / unit : pixel) * kHitSlopCss;
    // Top-level: on the page, or in a section (a section's frames are hit in their whole box, like the page's).
    const Node* parent = doc.get(n->props.parentIndex.guid);
    bool topLevel = n->props.parentIndex.guid == page || (parent && parent->props.type == NodeType::SECTION);
    if (!hitsNode(doc, id, m.inverse().apply(world), slop, topLevel)) continue;
    std::vector<Guid> path = doc.pathFromPage(id);
    for (size_t i = 0; i < path.size() && !includeLocked; i++) {
      const Node* pn = doc.get(path[i]);
      if (pn && pn->props.locked) {
        path.resize(i);
        break;
      }
    }
    // A locked top-level layer: the click goes through it to what is under it (round 8: locked layers take no clicks).
    if (path.empty()) continue;
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

std::vector<std::vector<Guid>> hitPaths(const Document& doc, Guid page, Vec2 world, double pixel, bool includeLocked) {
  std::vector<std::vector<Guid>> out;
  forEachHit(
      doc, page, world, pixel,
      [&](std::vector<Guid> path) {
        if (path.empty()) return true;
        for (const auto& seen : out)
          if (seen.size() >= path.size() && std::equal(path.begin(), path.end(), seen.begin())) return true;
        out.push_back(std::move(path));
        return true;
      },
      includeLocked);
  return out;
}

}  // namespace eng
