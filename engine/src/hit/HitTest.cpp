#include "hit/HitTest.h"

#include <algorithm>
#include <cmath>

#include "geometry/Brush.h"
#include "geometry/DynamicStroke.h"
#include "geometry/Repeat.h"
#include "geometry/Shapes.h"
#include "geometry/Stroker.h"
#include "geometry/VariableWidth.h"
#include "text/TextLayout.h"
#include "text/TextPathLayout.h"

namespace eng {

namespace {

bool anyVisible(const std::vector<Paint>& paints) {
  for (auto& p : paints)
    if (p.visible) return true;
  return false;
}

double shapeDistance(const NodeProps& p, Vec2 local, bool square = false) {
  Vec2 half{p.size.x / 2, p.size.y / 2};
  Vec2 c = local - half;
  if (p.type == NodeType::ELLIPSE) return sdEllipse(c, half);
  double radii[4] = {p.cornerRadii[0], p.cornerRadii[1], p.cornerRadii[2], p.cornerRadii[3]};
  if (square) radii[0] = radii[1] = radii[2] = radii[3] = 0;
  const uint32_t inv = p.invertedCorners();
  if (!inv) return sdRoundedBox(c, half, radii);
  // Inverted corners (docs/schema.md §3.6): the box less a disc around each such corner — never hit there, the box
  // rule below notwithstanding (what they cut away is the shape's own outline, not a rounding's sliver).
  CornerRadii clamped = geom::clampRadii(p.size, p.cornerRadii);
  for (int k = 0; k < 4; k++)
    if (inv & (1u << k)) radii[k] = 0;
  double d = sdRoundedBox(c, half, radii);
  const Vec2 corners[4] = {{0, 0}, {p.size.x, 0}, {p.size.x, p.size.y}, {0, p.size.y}};
  for (int k = 0; k < 4; k++)
    if (inv & (1u << k)) d = std::max(d, clamped[static_cast<size_t>(k)] - (local - corners[k]).length());
  return d;
}

// Rectangles and frames (components, instances, sets) are hit in their whole box where they show something there —
// the corners a radius cuts off included (live Figma, round 15: the owner's pill-shaped Button instance takes hover and
// clicks in its corners). Ellipses and path shapes are hit by their geometry.
bool hitByBox(const NodeProps& p) { return p.isRectLike() || p.isFrameLike(); }

}  // namespace

bool hitsOwnShape(const NodeProps& p, Vec2 local, double slop, bool topLevel, bool clip) {
  double d = shapeDistance(p, local);
  // Filled area: the box for rectangles and frames (not when the frame clips: its content is cut at the rounded edge).
  double area = !clip && hitByBox(p) ? shapeDistance(p, local, true) : d;
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
    if ((fill || stroke || topLevel) && area <= outer) return true;
    if (!stroke) return false;
  } else if (fill || !stroke) {
    if (area <= std::max(outer, 0.0) + (fill ? 0 : slop)) return true;
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
  // A text on a path (Figma Draw): its glyphs' turned boxes (their advance, ascent to descent), not its box.
  if (p.type == NodeType::TEXT_PATH) {
    const text::TextLayout* L = doc.geometryCache().textPathLayout(id);
    if (!L || L->lines.empty()) return false;
    double asc = L->lines[0].ascent, desc = L->lines[0].descent;
    for (const text::LaidGlyph& g : L->glyphs) {
      Mat2x3 G = Mat2x3::translate(g.x, g.y) * Mat2x3::rotate(g.rotation);
      Vec2 q = G.inverse().apply(local);
      if (q.x >= -slop && q.x <= g.advance + slop && q.y >= -asc - slop && q.y <= desc + slop) return true;
    }
    return false;
  }
  // Figma Draw's brush and dynamic strokes (docs/draw.md §4.3, §4.5): within the outline they are drawn as.
  if (!p.extra.empty() && anyVisible(p.strokePaints) && p.strokeWeight > 0 &&
      (strokeBrushOf(p) != kNoGuid || hasDynamicStroke(p))) {
    if (const NodeGeometry* g = doc.geometry(id); g && !g->stroke.path.empty()) {
      double tol = std::max(slop / 8, 1e-4);
      geom::Path outline;
      if (brushStroke(doc, p, *g, tol, outline)) {
        std::vector<geom::Polyline> polys = geom::flatten(outline, tol);
        if (geom::contains(polys, local, false) || geom::distanceTo(polys, local) <= slop) return true;
      } else if (geom::Path center; dynamicCenter(p, *g, tol, center)) {
        double half = p.strokeAlign == StrokeAlign::CENTER ? p.strokeWeight / 2 : p.strokeWeight;
        if (geom::distanceTo(geom::flatten(center, tol), local) <= std::max(half, slop)) return true;
      }
      // The fill still takes clicks (below); the plain centre line no longer does.
      if (anyVisible(p.fillPaints))
        for (auto& f : g->fills)
          if (!f.path.empty() && geom::contains(geom::flatten(f.path, tol), local, f.windingRule == WindingRule::ODD)) return true;
      return false;
    }
  }
  // A variable-width stroke (round 12): hit within its outline.
  bool variable = !p.extra.empty() && anyVisible(p.strokePaints) && p.strokeWeight > 0 && hasWidthPoints(p) && widthProfileAllowed(p);
  if (!p.isPathShape() && !variable) return hitsOwnShape(p, local, slop, topLevel);
  // A smoothed or dashed rectangle with a fill: its box, as any rectangle.
  if (p.isRectLike() && (anyVisible(p.fillPaints) || !(anyVisible(p.strokePaints) && p.strokeWeight > 0)) &&
      shapeDistance(p, local, true) <= (anyVisible(p.fillPaints) ? 0 : slop))
    return true;
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

bool hitsEdge(const Document& doc, Guid id, Vec2 local, double slop) {
  const NodeGeometry* g = doc.geometry(id);
  if (!g) return false;
  double tol = std::max(slop / 8, 1e-4);
  if (!g->stroke.path.empty() && geom::distanceTo(geom::flatten(g->stroke.path, tol), local) <= slop) return true;
  for (auto& f : g->fills)
    if (!f.path.empty() && geom::distanceTo(geom::flatten(f.path, tol), local) <= slop) return true;
  return false;
}

namespace {

// A layer inside a transform group, hit at one of the group's copies (docs/draw.md §4.2): the innermost visible layer
// of `id`'s subtree under `world`, where `world` is already mapped back to copy 0 — kNoGuid when none.
Guid hitSubtree(const Document& doc, Guid id, Vec2 world, double pixel, int depth);

Guid hitTransformCopies(const Document& doc, Guid group, Vec2 world, double pixel, int depth, bool skipSource) {
  const geom::RepeatResult* rep = repeatOf(doc, group);
  const std::vector<Guid>& kids = doc.children(group);
  Mat2x3 W = doc.worldTransform(group), Wi = W.inverse();
  size_t n = rep ? rep->instances.size() : 1;
  // What the children can cover (their render bounds, group space, grown by the slop): copies the point is outside of
  // are skipped without a look at their layers.
  Rect cover;
  bool any = false;
  for (Guid c : kids) {
    const Node* cn = doc.get(c);
    if (!cn || !cn->props.visible) continue;
    Rect b = transformedBounds(Wi * Mat2x3::translate(doc.renderBounds(c).x, doc.renderBounds(c).y), doc.renderBounds(c).w,
                               doc.renderBounds(c).h);
    cover = any ? cover.united(b) : b;
    any = true;
  }
  if (!any) return kNoGuid;
  double unit = std::sqrt(std::fabs(W.determinant()));
  double slop = (unit > 0 ? pixel / unit : pixel) * kHitSlopCss;
  cover = {cover.x - slop, cover.y - slop, cover.w + 2 * slop, cover.h + 2 * slop};
  Vec2 local = Wi.apply(world);
  // Topmost copy first.
  for (size_t k = n; k-- > 0;) {
    const Mat2x3 inst = rep ? rep->instances[k] : Mat2x3{};
    bool identity = inst == Mat2x3{};
    if (identity && skipSource) continue;
    Vec2 q = inst.inverse().apply(local);
    if (!cover.contains(q)) continue;
    Vec2 back = W.apply(q);
    for (size_t c = kids.size(); c-- > 0;) {
      Guid hit = hitSubtree(doc, kids[c], back, pixel, depth + 1);
      if (hit != kNoGuid) return hit;
    }
  }
  return kNoGuid;
}

Guid hitSubtree(const Document& doc, Guid id, Vec2 world, double pixel, int depth) {
  const Node* n = doc.get(id);
  if (!n || !n->props.visible || depth > 64) return kNoGuid;
  const NodeProps& p = n->props;
  if (p.type == NodeType::TRANSFORM) return hitTransformCopies(doc, id, world, pixel, depth, false);
  Mat2x3 m = doc.worldTransform(id);
  double unit = std::sqrt(std::fabs(m.determinant()));
  double slop = (unit > 0 ? pixel / unit : pixel) * kHitSlopCss;
  Vec2 local = m.inverse().apply(world);
  if (p.fitsChildren()) {
    if (p.isBoolean()) {
      const NodeGeometry* g = doc.geometry(id);
      bool inside = false;
      if (g)
        for (auto& f : g->fills) inside |= geom::contains(geom::flatten(f.path, slop / 8), local, false);
      if (!inside) return kNoGuid;
    }
    const std::vector<Guid>& kids = doc.children(id);
    for (size_t c = kids.size(); c-- > 0;)
      if (Guid hit = hitSubtree(doc, kids[c], world, pixel, depth + 1); hit != kNoGuid) return hit;
    return kNoGuid;
  }
  bool clips = p.clipsContent();
  if (!clips || hitsOwnShape(p, local, slop, true, true)) {
    const std::vector<Guid>& kids = doc.children(id);
    for (size_t c = kids.size(); c-- > 0;)
      if (Guid hit = hitSubtree(doc, kids[c], world, pixel, depth + 1); hit != kNoGuid) return hit;
  }
  return hitsNode(doc, id, local, slop, false) ? id : kNoGuid;
}

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
  auto truncateLocked = [&](std::vector<Guid>& path) {
    for (size_t i = 0; i < path.size() && !includeLocked; i++) {
      const Node* pn = doc.get(path[i]);
      if (pn && pn->props.locked) {
        path.resize(i);
        break;
      }
    }
  };
  for (Guid id : candidates) {
    const Node* n = doc.get(id);
    if (!n || !doc.visibleInTree(id)) continue;
    // A transform group (Figma Draw) is hit here, all its copies at once, each mapped back to the layers it repeats;
    // its layers aren't hit on their own (the outermost group stands for everything inside it).
    if (repeatAncestor(doc, id) != kNoGuid) continue;
    bool transform = n->props.type == NodeType::TRANSFORM;
    // Groups and boolean operations are hit through their children.
    if (n->props.fitsChildren() && !transform) continue;
    bool clipped = false;
    for (Guid a = n->props.parentIndex.guid; a != kNoGuid && !clipped;) {
      const Node* an = doc.get(a);
      if (!an || an->props.type == NodeType::CANVAS) break;
      if (an->props.clipsContent()) {
        Mat2x3 m = doc.worldTransform(a);
        double unit = std::sqrt(std::fabs(m.determinant()));
        double slop = (unit > 0 ? pixel / unit : pixel) * kHitSlopCss;
        if (!hitsOwnShape(an->props, m.inverse().apply(world), slop, true, true)) clipped = true;
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
    if (transform) {
      Guid hit = hitTransformCopies(doc, id, world, pixel, 0, false);
      if (hit == kNoGuid) continue;
      std::vector<Guid> path = doc.pathFromPage(hit);
      truncateLocked(path);
      if (path.empty()) continue;
      if (!f(std::move(path))) return;
      continue;
    }
    Mat2x3 m = doc.worldTransform(id);
    double unit = std::sqrt(std::fabs(m.determinant()));
    double slop = (unit > 0 ? pixel / unit : pixel) * kHitSlopCss;
    // Top-level: on the page, or in a section (a section's frames are hit in their whole box, like the page's).
    const Node* parent = doc.get(n->props.parentIndex.guid);
    bool topLevel = n->props.parentIndex.guid == page || (parent && parent->props.type == NodeType::SECTION);
    if (!hitsNode(doc, id, m.inverse().apply(world), slop, topLevel)) continue;
    std::vector<Guid> path = doc.pathFromPage(id);
    truncateLocked(path);
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
