#include "editor/Snapping.h"

#include <algorithm>
#include <cmath>

namespace eng {

namespace {

constexpr double kSame = 0.01;  // world units: lines this close coincide

double lo(const Rect& r, int a) { return a == 0 ? r.x : r.y; }
double len(const Rect& r, int a) { return a == 0 ? r.w : r.h; }
double hi(const Rect& r, int a) { return lo(r, a) + len(r, a); }
double mid(const Rect& r, int a) { return lo(r, a) + len(r, a) / 2; }

bool crossOverlap(const Rect& a, const Rect& b, int axis) {
  int c = 1 - axis;
  return lo(a, c) < hi(b, c) && lo(b, c) < hi(a, c);
}

// The cross-axis middle of where two boxes overlap (or of `fallback`).
double crossMiddle(const Rect& a, const Rect& b, int axis, const Rect& fallback) {
  int c = 1 - axis;
  double s = std::max(lo(a, c), lo(b, c)), e = std::min(hi(a, c), hi(b, c));
  return s <= e ? (s + e) / 2 : mid(fallback, c);
}

// A mark along `axis` from `from` to `to` at cross position `at`.
SpacingMark mark(int axis, double from, double to, double at) {
  return axis == 0 ? SpacingMark{{from, at}, {to, at}} : SpacingMark{{at, from}, {at, to}};
}

Rect shifted(const Rect& r, Vec2 d) { return {r.x + d.x, r.y + d.y, r.w, r.h}; }

}  // namespace

void Snapper::reset(std::vector<Rect> boxes, std::optional<Rect> container) {
  boxes_ = std::move(boxes);
  container_ = container;
}

SnapResult Snapper::snapBox(const Rect& m, double threshold, bool snapX, bool snapY) const {
  SnapResult res;
  struct Choice {
    double d = 0;
    int kind = -1;  // 0 lines, 1 centred between two, 2 a known gap after `before`, 3 a known gap before `after`
    int before = -1, after = -1, gapLeft = -1, gapRight = -1;
  } choice[2];

  for (int a = 0; a < 2; a++) {
    if (a == 0 ? !snapX : !snapY) continue;
    Choice& best = choice[a];
    double bestAbs = threshold + 1e-9;
    auto consider = [&](double d, Choice c) {
      if (std::fabs(d) < bestAbs) {
        bestAbs = std::fabs(d);
        c.d = d;
        best = c;
      }
    };
    const double mine[3] = {lo(m, a), mid(m, a), hi(m, a)};
    auto lines = [&](const Rect& t) {
      const double theirs[3] = {lo(t, a), mid(t, a), hi(t, a)};
      for (double tl : theirs)
        for (double ml : mine) consider(tl - ml, Choice{0, 0});
    };
    for (const Rect& t : boxes_) lines(t);
    if (container_) lines(*container_);

    // Equal spacing, among the boxes beside the moving one on this axis.
    std::vector<int> row;
    for (int i = 0; i < static_cast<int>(boxes_.size()); i++)
      if (crossOverlap(boxes_[static_cast<size_t>(i)], m, a)) row.push_back(i);
    int before = -1, after = -1;
    for (int i : row) {
      const Rect& t = boxes_[static_cast<size_t>(i)];
      if (hi(t, a) <= lo(m, a) + threshold && (before < 0 || hi(t, a) > hi(boxes_[static_cast<size_t>(before)], a))) before = i;
      if (lo(t, a) >= hi(m, a) - threshold && (after < 0 || lo(t, a) < lo(boxes_[static_cast<size_t>(after)], a))) after = i;
    }
    if (before >= 0 && after >= 0) {
      const Rect& B = boxes_[static_cast<size_t>(before)];
      const Rect& A = boxes_[static_cast<size_t>(after)];
      if (lo(A, a) - hi(B, a) >= len(m, a)) {
        Choice c{0, 1, before, after};
        consider((hi(B, a) + lo(A, a) - len(m, a)) / 2 - lo(m, a), c);
      }
    }
    std::vector<int> sorted = row;
    std::sort(sorted.begin(), sorted.end(), [&](int x, int y) { return lo(boxes_[static_cast<size_t>(x)], a) < lo(boxes_[static_cast<size_t>(y)], a); });
    for (size_t i = 0; i + 1 < sorted.size(); i++) {
      const Rect& L = boxes_[static_cast<size_t>(sorted[i])];
      const Rect& R = boxes_[static_cast<size_t>(sorted[i + 1])];
      double gap = lo(R, a) - hi(L, a);
      if (gap < 0.5) continue;
      if (before >= 0 && before != sorted[i + 1]) {
        Choice c{0, 2, before, -1, sorted[i], sorted[i + 1]};
        consider(hi(boxes_[static_cast<size_t>(before)], a) + gap - lo(m, a), c);
      }
      if (after >= 0 && after != sorted[i]) {
        Choice c{0, 3, -1, after, sorted[i], sorted[i + 1]};
        consider(lo(boxes_[static_cast<size_t>(after)], a) - gap - hi(m, a), c);
      }
    }
    if (best.kind >= 0) {
      (a == 0 ? res.offset.x : res.offset.y) = best.d;
      (a == 0 ? res.snappedX : res.snappedY) = true;
    }
  }

  Rect placed = shifted(m, res.offset);
  for (int a = 0; a < 2; a++) {
    const Choice& c = choice[a];
    if (c.kind < 0) continue;
    if (c.kind == 0) {
      auto g = guidesFor(placed, a == 0, a == 1);
      res.guides.insert(res.guides.end(), g.begin(), g.end());
      continue;
    }
    auto box = [&](int i) -> const Rect& { return boxes_[static_cast<size_t>(i)]; };
    if (c.kind == 1) {
      res.spacings.push_back(mark(a, hi(box(c.before), a), lo(placed, a), crossMiddle(box(c.before), placed, a, placed)));
      res.spacings.push_back(mark(a, hi(placed, a), lo(box(c.after), a), crossMiddle(placed, box(c.after), a, placed)));
    } else {
      const Rect& L = box(c.gapLeft);
      const Rect& R = box(c.gapRight);
      res.spacings.push_back(mark(a, hi(L, a), lo(R, a), crossMiddle(L, R, a, placed)));
      if (c.kind == 2) res.spacings.push_back(mark(a, hi(box(c.before), a), lo(placed, a), crossMiddle(box(c.before), placed, a, placed)));
      else res.spacings.push_back(mark(a, hi(placed, a), lo(box(c.after), a), crossMiddle(placed, box(c.after), a, placed)));
    }
  }
  return res;
}

SnapResult Snapper::snapPoint(Vec2 p, double threshold, bool snapX, bool snapY) const {
  SnapResult res;
  for (int a = 0; a < 2; a++) {
    if (a == 0 ? !snapX : !snapY) continue;
    double v = a == 0 ? p.x : p.y, bestAbs = threshold + 1e-9, best = 0;
    bool found = false;
    auto lines = [&](const Rect& t) {
      for (double tl : {lo(t, a), mid(t, a), hi(t, a)})
        if (std::fabs(tl - v) < bestAbs) {
          bestAbs = std::fabs(tl - v);
          best = tl - v;
          found = true;
        }
    };
    for (const Rect& t : boxes_) lines(t);
    if (container_) lines(*container_);
    if (found) {
      (a == 0 ? res.offset.x : res.offset.y) = best;
      (a == 0 ? res.snappedX : res.snappedY) = true;
    }
  }
  return res;
}

std::vector<GuideLine> Snapper::guidesFor(const Rect& box, bool x, bool y) const {
  std::vector<GuideLine> out;
  for (int a = 0; a < 2; a++) {
    if (a == 0 ? !x : !y) continue;
    int c = 1 - a;
    for (double ml : {lo(box, a), mid(box, a), hi(box, a)}) {
      double from = lo(box, c), to = hi(box, c);
      bool any = false;
      auto check = [&](const Rect& t) {
        for (double tl : {lo(t, a), mid(t, a), hi(t, a)})
          if (std::fabs(tl - ml) < kSame) {
            from = std::min(from, lo(t, c));
            to = std::max(to, hi(t, c));
            any = true;
            return;
          }
      };
      for (const Rect& t : boxes_) check(t);
      if (container_) check(*container_);
      if (!any) continue;
      out.push_back(a == 0 ? GuideLine{{ml, from}, {ml, to}} : GuideLine{{from, ml}, {to, ml}});
    }
  }
  return out;
}

void measureBetween(const Rect& s, const Rect& h, std::vector<SpacingMark>& marks, std::vector<GuideLine>& extensions) {
  auto contains = [](const Rect& outer, const Rect& inner) { return outer.containsRect(inner); };
  if (contains(h, s) || contains(s, h)) {
    const Rect& outer = contains(h, s) ? h : s;
    const Rect& inner = contains(h, s) ? s : h;
    double cy = mid(inner, 1), cx = mid(inner, 0);
    if (inner.x > outer.x) marks.push_back(mark(0, outer.x, inner.x, cy));
    if (outer.right() > inner.right()) marks.push_back(mark(0, inner.right(), outer.right(), cy));
    if (inner.y > outer.y) marks.push_back(mark(1, outer.y, inner.y, cx));
    if (outer.bottom() > inner.bottom()) marks.push_back(mark(1, inner.bottom(), outer.bottom(), cx));
    return;
  }
  for (int a = 0; a < 2; a++) {
    int c = 1 - a;
    const Rect* first = nullptr;
    const Rect* second = nullptr;
    if (hi(s, a) <= lo(h, a)) first = &s, second = &h;
    else if (hi(h, a) <= lo(s, a)) first = &h, second = &s;
    if (!first) continue;
    bool overlap = crossOverlap(s, h, a);
    double at = overlap ? crossMiddle(s, h, a, s) : mid(s, c);
    marks.push_back(mark(a, hi(*first, a), lo(*second, a), at));
    if (!overlap) {
      // The hovered layer doesn't reach the line: a guide along its near edge does.
      double edge = &h == first ? hi(h, a) : lo(h, a);
      double near = at < lo(h, c) ? lo(h, c) : hi(h, c);
      extensions.push_back(a == 0 ? GuideLine{{edge, near}, {edge, at}} : GuideLine{{near, edge}, {at, edge}});
    }
  }
}

}  // namespace eng
