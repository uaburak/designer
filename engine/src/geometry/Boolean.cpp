#include "geometry/Boolean.h"

#include <algorithm>
#include <cmath>

#include "clipper2/clipper.engine.h"

namespace eng::geom {

namespace {

using Clipper2Lib::Clipper64;
using Clipper2Lib::ClipType;
using Clipper2Lib::FillRule;
using Clipper2Lib::Path64;
using Clipper2Lib::Paths64;
using Clipper2Lib::Point64;

constexpr int kStepBits = 20;  // flattening steps per curve: < 2^20

// A source curve: a cubic (quads are elevated, lines have p1 = p0, p2 = p3).
struct Curve {
  Vec2 p[4];
  bool line = false;
  int steps = 1;
  int64_t prev = -1;  // the curve before it in its contour (its end is this one's start)
};

struct Member {
  int64_t curve;
  double t;
};

class Clipping {
 public:
  explicit Clipping(double tolerance) : tolerance_(std::max(tolerance, 1e-6)) {}

  // A path's contours as Clipper paths, each point tagged with (curve, step).
  Paths64 add(const Path& path) {
    Paths64 out;
    int64_t first = -1;
    forEachSegment(
        path,
        [&](Vec2) {
          out.emplace_back();
          first = -1;
        },
        [&](Verb v, Vec2 from, const Vec2* p) {
          Curve c;
          if (v == Verb::Line) {
            c = {{from, from, p[0], p[0]}, true, 1, -1};
          } else if (v == Verb::Quad) {
            c.p[0] = from;
            c.p[1] = from + (p[0] - from) * (2.0 / 3);
            c.p[2] = p[1] + (p[0] - p[1]) * (2.0 / 3);
            c.p[3] = p[1];
          } else {
            c.p[0] = from, c.p[1] = p[0], c.p[2] = p[1], c.p[3] = p[2];
          }
          if (!c.line) {
            double m = std::max((c.p[0] - c.p[1] * 2 + c.p[2]).length(), (c.p[1] - c.p[2] * 2 + c.p[3]).length());
            c.steps = std::clamp(static_cast<int>(std::ceil(std::sqrt(0.75 * m / tolerance_))), 1, (1 << kStepBits) - 1);
          }
          int64_t id = static_cast<int64_t>(curves_.size());
          c.prev = first < 0 ? -1 : id - 1;
          if (first < 0) first = id;
          curves_.push_back(c);
          for (int k = 0; k < c.steps; k++) {
            Vec2 q = c.line ? c.p[0] : cubicAt(c.p[0], c.p[1], c.p[2], c.p[3], static_cast<double>(k) / c.steps);
            out.back().push_back(point(q, (id << kStepBits) | k));
          }
        },
        [&](bool) {
          // Every contour is closed for clipping: its first curve follows its last.
          if (first >= 0 && static_cast<int64_t>(curves_.size()) - 1 > first) curves_[static_cast<size_t>(first)].prev = static_cast<int64_t>(curves_.size()) - 1;
          if (!out.empty() && out.back().size() < 3) out.pop_back();
        });
    return out;
  }

  Paths64 run(const Paths64& subjects, const Paths64& clips, ClipType type, FillRule rule) {
    Clipper64 c;
    c.PreserveCollinear(true);
    c.SetZCallback([this](const Point64& e1bot, const Point64& e1top, const Point64& e2bot, const Point64& e2top, Point64& pt) {
      Member a = onEdge(e1bot, e1top, pt), b = onEdge(e2bot, e2top, pt);
      hits_.push_back({a, b});
      pt.z = -static_cast<int64_t>(hits_.size());
    });
    if (!subjects.empty()) c.AddSubject(subjects);
    if (!clips.empty()) c.AddClip(clips);
    Paths64 out;
    c.Execute(type, rule, out);
    return out;
  }

  // Clipper's result back to a path, runs along one source curve turned back into that curve.
  Path recover(const Paths64& rings) const {
    Path path;
    for (const Path64& ring : rings) {
      size_t m = ring.size();
      if (m < 3) continue;
      path.moveTo(unscale(ring[0]));
      size_t i = 0;
      while (i < m) {
        Member a{}, b{};
        int64_t curve = commonCurve(ring[i], ring[(i + 1) % m], -1, a, b);
        if (curve < 0 || curves_[static_cast<size_t>(curve)].line) {
          path.lineTo(unscale(ring[(i + 1) % m]));
          i++;
          continue;
        }
        // Extend the run while the next edge is on the same curve, in the same direction.
        double t0 = a.t, t1 = b.t;
        size_t j = i + 1;
        while (j < m) {
          Member c{}, d{};
          if (commonCurve(ring[j % m], ring[(j + 1) % m], curve, c, d) != curve) break;
          if ((t1 - t0) * (d.t - c.t) <= 0 || std::fabs(c.t - t1) > 1e-9) break;
          t1 = d.t;
          j++;
        }
        const Curve& cv = curves_[static_cast<size_t>(curve)];
        Vec2 s[4];
        cubicSection(cv.p, t0, t1, s);
        path.cubicTo(s[1], s[2], unscale(ring[j % m]));
        i = j;
      }
      path.close();
    }
    return path;
  }

 private:
  static constexpr double kScale = 65536;  // 1/65536 px

  Point64 point(Vec2 p, int64_t z) const { return Point64(std::llround(p.x * kScale), std::llround(p.y * kScale), z); }
  static Vec2 unscale(const Point64& p) { return {static_cast<double>(p.x) / kScale, static_cast<double>(p.y) / kScale}; }

  // The (curve, t) memberships of a point: a flattened point is on its curve (and, at a curve's start, at
  // the end of the previous one); an intersection is on both edges' curves.
  void members(int64_t z, Member out[4], int& n) const {
    n = 0;
    if (z >= 0) {
      int64_t c = z >> kStepBits;
      int k = static_cast<int>(z & ((1 << kStepBits) - 1));
      if (c < 0 || c >= static_cast<int64_t>(curves_.size())) return;
      const Curve& cv = curves_[static_cast<size_t>(c)];
      out[n++] = {c, static_cast<double>(k) / cv.steps};
      if (k == 0 && cv.prev >= 0) out[n++] = {cv.prev, 1.0};
      return;
    }
    size_t h = static_cast<size_t>(-z - 1);
    if (h >= hits_.size()) return;
    for (const Member& m : {hits_[h].first, hits_[h].second})
      if (m.curve >= 0 && n < 4) out[n++] = m;
  }

  // The curve both points lie on next to each other (`prefer` first), with their parameters.
  int64_t commonCurve(const Point64& p, const Point64& q, int64_t prefer, Member& a, Member& b) const {
    Member mp[4], mq[4];
    int np = 0, nq = 0;
    members(p.z, mp, np);
    members(q.z, mq, nq);
    int64_t found = -1;
    for (int i = 0; i < np; i++)
      for (int j = 0; j < nq; j++) {
        if (mp[i].curve != mq[j].curve) continue;
        const Curve& cv = curves_[static_cast<size_t>(mp[i].curve)];
        if (std::fabs(mp[i].t - mq[j].t) > 1.0 / cv.steps + 1e-9) continue;
        if (found < 0 || mp[i].curve == prefer) {
          found = mp[i].curve;
          a = mp[i];
          b = mq[j];
        }
      }
    return found;
  }

  // The (curve, t) of `pt` on the edge bot → top, when both ends are on one curve.
  Member onEdge(const Point64& bot, const Point64& top, const Point64& pt) const {
    Member a{}, b{};
    int64_t c = commonCurve(bot, top, -1, a, b);
    if (c < 0) return {-1, 0};
    double dx = static_cast<double>(top.x - bot.x), dy = static_cast<double>(top.y - bot.y);
    double len2 = dx * dx + dy * dy;
    double f = len2 > 0 ? std::clamp((static_cast<double>(pt.x - bot.x) * dx + static_cast<double>(pt.y - bot.y) * dy) / len2, 0.0, 1.0) : 0;
    return {c, a.t + (b.t - a.t) * f};
  }

  double tolerance_;
  std::vector<Curve> curves_;
  std::vector<std::pair<Member, Member>> hits_;
};

FillRule fillRule(WindingRule r) { return r == WindingRule::ODD ? FillRule::EvenOdd : FillRule::NonZero; }

}  // namespace

Path booleanOp(const std::vector<Operand>& operands, BooleanOperation op, double tolerance) {
  Clipping clip(tolerance);
  // Each operand on its own first: its area under its own rule, as positive contours.
  std::vector<Paths64> shapes;
  for (const Operand& o : operands) {
    Paths64 raw = clip.add(o.path);
    shapes.push_back(clip.run(raw, {}, ClipType::Union, fillRule(o.rule)));
  }
  if (shapes.empty()) return {};
  Paths64 acc = shapes[0];
  switch (op) {
    case BooleanOperation::UNION: {
      Paths64 all;
      for (auto& s : shapes) all.insert(all.end(), s.begin(), s.end());
      acc = clip.run(all, {}, ClipType::Union, FillRule::NonZero);
      break;
    }
    case BooleanOperation::SUBTRACT: {
      Paths64 rest;
      for (size_t i = 1; i < shapes.size(); i++) rest.insert(rest.end(), shapes[i].begin(), shapes[i].end());
      acc = clip.run(shapes[0], rest, ClipType::Difference, FillRule::NonZero);
      break;
    }
    case BooleanOperation::INTERSECT:
      for (size_t i = 1; i < shapes.size(); i++) acc = clip.run(acc, shapes[i], ClipType::Intersection, FillRule::NonZero);
      break;
    case BooleanOperation::XOR:
      for (size_t i = 1; i < shapes.size(); i++) acc = clip.run(acc, shapes[i], ClipType::Xor, FillRule::NonZero);
      break;
  }
  return clip.recover(acc);
}

Path simplify(const Path& path, WindingRule rule, double tolerance) {
  Clipping clip(tolerance);
  Paths64 raw = clip.add(path);
  return clip.recover(clip.run(raw, {}, ClipType::Union, fillRule(rule)));
}

}  // namespace eng::geom
