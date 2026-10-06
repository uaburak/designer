#include "geometry/Stroker.h"

#include <algorithm>
#include <cmath>

#include "geometry/Shapes.h"

namespace eng::geom {

namespace {

constexpr double kPi = 3.14159265358979323846;

// A flattened contour; `corner[i]` = point i is where two of the path's segments meet
// (joins there use the node's join; points inside a flattened curve always miter).
struct Line {
  std::vector<Vec2> pts;
  std::vector<bool> corner;
  bool closed = false;
};

double cross(Vec2 a, Vec2 b) { return a.x * b.y - a.y * b.x; }
double dot(Vec2 a, Vec2 b) { return a.x * b.x + a.y * b.y; }
Vec2 unit(Vec2 v) {
  double l = v.length();
  return l > 0 ? v * (1 / l) : Vec2{};
}
Vec2 perp(Vec2 d) { return {-d.y, d.x}; }
Vec2 rotate(Vec2 v, double a) { return {v.x * std::cos(a) - v.y * std::sin(a), v.x * std::sin(a) + v.y * std::cos(a)}; }

// Emits a polygon wound positively (so every piece adds under NONZERO).
void polygon(Path& out, std::initializer_list<Vec2> pts) {
  std::vector<Vec2> p(pts);
  double area = 0;
  for (size_t i = 0; i < p.size(); i++) area += cross(p[i], p[(i + 1) % p.size()]);
  if (std::fabs(area) < 1e-18) return;
  if (area < 0) std::reverse(p.begin(), p.end());
  out.moveTo(p[0]);
  for (size_t i = 1; i < p.size(); i++) out.lineTo(p[i]);
  out.close();
}

void disc(Path& out, Vec2 c, double r) {
  if (r <= 0) return;
  out.moveTo({c.x + r, c.y});
  arcTo(out, c, r, r, 0, 2 * kPi);  // increasing angle: positive area in y-down space
  out.close();
}

std::vector<Line> flattenWithCorners(const Path& path, double tol) {
  std::vector<Line> out;
  forEachSegment(
      path,
      [&](Vec2 p) {
        out.push_back({});
        out.back().pts.push_back(p);
        out.back().corner.push_back(true);
      },
      [&](Verb v, Vec2 from, const Vec2* p) {
        Line& l = out.back();
        std::vector<Vec2> pts;
        if (v == Verb::Line) pts.push_back(p[0]);
        else if (v == Verb::Quad) flattenQuad(from, p[0], p[1], tol, pts);
        else flattenCubic(from, p[0], p[1], p[2], tol, pts);
        for (size_t i = 0; i < pts.size(); i++) {
          if (pts[i] == l.pts.back()) continue;
          l.pts.push_back(pts[i]);
          l.corner.push_back(i + 1 == pts.size());
        }
      },
      [&](bool closed) {
        Line& l = out.back();
        l.closed = closed;
        if (closed && l.pts.size() > 1 && l.pts.front() == l.pts.back()) {
          l.pts.pop_back();
          l.corner.pop_back();
        }
      });
  return out;
}

// The dashes of a contour as open lines (by arc length; the pattern restarts at each contour).
std::vector<Line> dash(const Line& line, const std::vector<double>& pattern) {
  std::vector<Line> out;
  double total = 0;
  for (double d : pattern) total += std::max(0.0, d);
  if (pattern.empty() || total <= 0) return {line};
  std::vector<Vec2> pts = line.pts;
  std::vector<bool> corner = line.corner;
  if (line.closed && !pts.empty()) {
    pts.push_back(pts.front());
    corner.push_back(true);
  }
  size_t k = 0;
  double left = std::max(0.0, pattern[0]);
  bool on = true;
  Line cur;
  auto startDash = [&](Vec2 p, bool c) {
    cur = Line{};
    cur.pts.push_back(p);
    cur.corner.push_back(c);
  };
  if (!pts.empty()) startDash(pts[0], true);
  for (size_t i = 0; i + 1 < pts.size(); i++) {
    Vec2 a = pts[i], b = pts[i + 1];
    double len = (b - a).length(), at = 0;
    while (len - at > left) {
      at += left;
      Vec2 p = a + (b - a) * (at / len);
      if (on) {
        cur.pts.push_back(p);
        cur.corner.push_back(false);
        if (cur.pts.size() > 1) out.push_back(cur);
      } else {
        startDash(p, false);
      }
      on = !on;
      k = (k + 1) % pattern.size();
      left = std::max(0.0, pattern[k]);
      if (left == 0 && on) {
        // A zero-length dash: a dot (caps make it visible).
        out.push_back(Line{{p, p}, {false, false}, false});
      }
    }
    left -= len - at;
    if (on) {
      cur.pts.push_back(b);
      cur.corner.push_back(corner[i + 1]);
    }
  }
  if (on && cur.pts.size() > 1) out.push_back(cur);
  return out;
}

// Trims `len` off the end (atEnd) or the start of an open line.
void trim(Line& l, double len, bool atEnd) {
  if (len <= 0 || l.pts.size() < 2) return;
  if (!atEnd) {
    std::reverse(l.pts.begin(), l.pts.end());
    std::reverse(l.corner.begin(), l.corner.end());
  }
  while (l.pts.size() >= 2 && len > 0) {
    Vec2 a = l.pts[l.pts.size() - 2], b = l.pts.back();
    double seg = (b - a).length();
    if (seg > len) {
      l.pts.back() = b + (a - b) * (len / seg);
      len = 0;
    } else {
      len -= seg;
      l.pts.pop_back();
      l.corner.pop_back();
    }
  }
  if (!atEnd) {
    std::reverse(l.pts.begin(), l.pts.end());
    std::reverse(l.corner.begin(), l.corner.end());
  }
}

// Arrowhead sizes (unverified against Figma: chosen to look like its defaults at 1–4 px).
double lineArrowLength(double w) { return 2.5 * w + 4; }
double triangleSide(double w) { return 3 * w + 4; }
double circleRadius(double w) { return 1.5 * w + 1.5; }
double diamondHalf(double w) { return 1.5 * w + 2.5; }

void strokeLine(Path& out, Line line, const StrokeStyle& s, StrokeCap startCap, StrokeCap endCap, double tol);

// A cap at `p`, the line arriving along `d` (unit, pointing out of the line).
void cap(Path& out, Vec2 p, Vec2 d, StrokeCap c, const StrokeStyle& s, double tol) {
  double hw = s.width / 2;
  Vec2 n = perp(d) * hw;
  switch (c) {
    case StrokeCap::NONE: break;
    case StrokeCap::SQUARE: polygon(out, {p + n, p + n + d * hw, p - n + d * hw, p - n}); break;
    case StrokeCap::ROUND: disc(out, p, hw); break;
    case StrokeCap::ARROW_LINES: {
      double L = lineArrowLength(s.width);
      double a = 40 * kPi / 180;
      Vec2 back = d * -1;
      Line arms{{p + rotate(back, a) * L, p, p + rotate(back, -a) * L}, {true, true, true}, false};
      StrokeStyle st = s;
      st.join = StrokeJoin::MITER;
      st.miterLimit = 8;
      st.dashes.clear();
      strokeLine(out, arms, st, StrokeCap::NONE, StrokeCap::NONE, tol);
      break;
    }
    case StrokeCap::ARROW_EQUILATERAL: {
      double side = triangleSide(s.width), h = side * std::sqrt(3.0) / 2;
      Vec2 tip = p + d * (hw * 0.5), base = tip - d * h, m = perp(d) * (side / 2);
      polygon(out, {tip, base + m, base - m});
      break;
    }
    case StrokeCap::TRIANGLE_FILLED: {
      // Figma's "Reversed triangle": the base at the end, the point back along the line.
      double side = triangleSide(s.width), h = side * std::sqrt(3.0) / 2;
      Vec2 m = perp(d) * (side / 2), base = p + d * (hw * 0.5);
      polygon(out, {base + m, base - m, base - d * h});
      break;
    }
    case StrokeCap::CIRCLE_FILLED: disc(out, p, circleRadius(s.width)); break;
    case StrokeCap::DIAMOND_FILLED: {
      double r = diamondHalf(s.width);
      Vec2 m = perp(d) * r;
      polygon(out, {p + d * r, p + m, p - d * r, p - m});
      break;
    }
  }
}

double capTrim(StrokeCap c, double w) {
  return c == StrokeCap::ARROW_EQUILATERAL ? triangleSide(w) * std::sqrt(3.0) / 4 : 0;
}

void join(Path& out, Vec2 p, Vec2 d0, Vec2 d1, StrokeJoin j, double miterLimit, double hw) {
  double c = cross(d0, d1), dt = dot(d0, d1);
  if (std::fabs(c) < 1e-12 && dt > 0) return;  // straight on
  if (j == StrokeJoin::ROUND) {
    disc(out, p, hw);
    return;
  }
  double side = c > 0 ? -1 : 1;  // the outer side of the turn
  Vec2 o0 = perp(d0) * (hw * side), o1 = perp(d1) * (hw * side);
  if (j == StrokeJoin::MITER) {
    Vec2 b = unit(o0 + o1);
    double cosHalf = dot(b, o0) / hw;  // cos of half the angle between the offsets
    if (cosHalf > 1e-9) {
      double ratio = 1 / cosHalf;
      if (ratio <= miterLimit) {
        polygon(out, {p, p + o0, p + b * (hw * ratio), p + o1});
        return;
      }
    }
  }
  polygon(out, {p, p + o0, p + o1});
}

void strokeLine(Path& out, Line line, const StrokeStyle& s, StrokeCap startCap, StrokeCap endCap, double tol) {
  double hw = s.width / 2;
  size_t n = line.pts.size();
  if (n == 0) return;
  if (n == 1 || (n == 2 && line.pts[0] == line.pts[1])) {
    // A point: round and square caps show it.
    Vec2 p = line.pts[0];
    if (startCap == StrokeCap::ROUND || endCap == StrokeCap::ROUND) disc(out, p, hw);
    else if (startCap == StrokeCap::SQUARE || endCap == StrokeCap::SQUARE) polygon(out, {p + Vec2{-hw, -hw}, p + Vec2{hw, -hw}, p + Vec2{hw, hw}, p + Vec2{-hw, hw}});
    return;
  }
  if (!line.closed) {
    Vec2 d0 = unit(line.pts[1] - line.pts[0]), d1 = unit(line.pts[n - 1] - line.pts[n - 2]);
    Vec2 p0 = line.pts[0], p1 = line.pts[n - 1];
    cap(out, p0, d0 * -1, startCap, s, tol);
    cap(out, p1, d1, endCap, s, tol);
    trim(line, capTrim(startCap, s.width), false);
    trim(line, capTrim(endCap, s.width), true);
    n = line.pts.size();
    if (n < 2) return;
  }
  size_t segs = line.closed ? n : n - 1;
  for (size_t i = 0; i < segs; i++) {
    Vec2 a = line.pts[i], b = line.pts[(i + 1) % n];
    Vec2 d = unit(b - a);
    if (d.x == 0 && d.y == 0) continue;
    Vec2 nr = perp(d) * hw;
    polygon(out, {a + nr, b + nr, b - nr, a - nr});
  }
  size_t first = line.closed ? 0 : 1, last = line.closed ? n : n - 1;
  for (size_t i = first; i < last; i++) {
    Vec2 prev = line.pts[(i + n - 1) % n], p = line.pts[i], next = line.pts[(i + 1) % n];
    Vec2 d0 = unit(p - prev), d1 = unit(next - p);
    if ((d0.x == 0 && d0.y == 0) || (d1.x == 0 && d1.y == 0)) continue;
    bool corner = i < line.corner.size() ? line.corner[i] : true;
    join(out, p, d0, d1, corner ? s.join : StrokeJoin::MITER, corner ? s.miterLimit : 1e9, hw);
  }
}

}  // namespace

Path strokePath(const Path& center, const StrokeStyle& style, double tolerance) {
  Path out;
  if (!(style.width > 0)) return out;
  std::vector<Line> lines = flattenWithCorners(center, std::max(tolerance, 1e-6));
  for (size_t i = 0; i < lines.size(); i++) {
    StrokeCap start = style.cap, end = style.cap;
    if (style.caps && i < style.caps->size()) start = (*style.caps)[i].first, end = (*style.caps)[i].second;
    if (lines[i].closed) start = end = StrokeCap::NONE;
    if (style.dashes.empty()) {
      strokeLine(out, lines[i], style, start, end, tolerance);
      continue;
    }
    // Dashes: the node's cap at every dash end (arrowheads only at the contour's own ends).
    auto plain = [&](StrokeCap c) {
      return c == StrokeCap::ROUND || c == StrokeCap::SQUARE ? c : (style.cap == StrokeCap::ROUND || style.cap == StrokeCap::SQUARE ? style.cap : StrokeCap::NONE);
    };
    std::vector<Line> dashes = dash(lines[i], style.dashes);
    for (size_t k = 0; k < dashes.size(); k++) {
      bool first = !lines[i].closed && k == 0 && dashes[k].pts.front() == lines[i].pts.front();
      bool lastOne = !lines[i].closed && k + 1 == dashes.size() && dashes[k].pts.back() == lines[i].pts.back();
      strokeLine(out, dashes[k], style, first ? start : plain(start), lastOne ? end : plain(end), tolerance);
    }
  }
  return out;
}

double strokeReach(const StrokeStyle& s, bool hasOpenEnds) {
  double hw = s.width / 2;
  double r = hw;
  if (s.join == StrokeJoin::MITER) r = std::max(r, hw * std::max(1.0, s.miterLimit));
  if (hasOpenEnds) {
    auto capReach = [&](StrokeCap c) {
      switch (c) {
        case StrokeCap::SQUARE: return hw * std::sqrt(2.0);
        case StrokeCap::ARROW_LINES: return lineArrowLength(s.width) + hw * 4;
        case StrokeCap::ARROW_EQUILATERAL:
        case StrokeCap::TRIANGLE_FILLED: return triangleSide(s.width) + hw;
        case StrokeCap::CIRCLE_FILLED: return circleRadius(s.width);
        case StrokeCap::DIAMOND_FILLED: return diamondHalf(s.width);
        default: return hw;
      }
    };
    r = std::max(r, capReach(s.cap));
    if (s.caps)
      for (auto& [a, b] : *s.caps) r = std::max({r, capReach(a), capReach(b)});
  }
  return r;
}

}  // namespace eng::geom
