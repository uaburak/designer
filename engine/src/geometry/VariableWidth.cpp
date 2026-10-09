#include "geometry/VariableWidth.h"

#include <algorithm>
#include <cmath>
#include <functional>

#include "base/Json.h"
#include "scene/CodecKiwi.h"

namespace eng::geom {

namespace {

WidthPoint sym(double position, double width) { return {position, width / 2, width / 2}; }

// Fritsch–Carlson monotone cubic through (x[i], y[i]) at u.
double monotone(const std::vector<double>& x, const std::vector<double>& y, double u) {
  size_t n = x.size();
  if (n == 0) return 0.5;
  if (n == 1 || u <= x.front()) return y.front();
  if (u >= x.back()) return y.back();
  std::vector<double> delta(n - 1), m(n);
  for (size_t k = 0; k + 1 < n; k++) {
    double h = x[k + 1] - x[k];
    delta[k] = h > 1e-12 ? (y[k + 1] - y[k]) / h : 0;
  }
  m[0] = delta[0];
  m[n - 1] = delta[n - 2];
  for (size_t k = 1; k + 1 < n; k++) m[k] = delta[k - 1] * delta[k] <= 0 ? 0 : (delta[k - 1] + delta[k]) / 2;
  for (size_t k = 0; k + 1 < n; k++) {
    if (delta[k] == 0) {
      m[k] = m[k + 1] = 0;
      continue;
    }
    double a = m[k] / delta[k], b = m[k + 1] / delta[k];
    double s = a * a + b * b;
    if (s > 9) {
      double tau = 3 / std::sqrt(s);
      m[k] = tau * a * delta[k];
      m[k + 1] = tau * b * delta[k];
    }
  }
  size_t k = static_cast<size_t>(std::upper_bound(x.begin(), x.end(), u) - x.begin());
  k = std::clamp<size_t>(k, 1, n - 1) - 1;
  double h = x[k + 1] - x[k];
  if (h <= 1e-12) return y[k + 1];
  double t = (u - x[k]) / h, t2 = t * t, t3 = t2 * t;
  double v = (2 * t3 - 3 * t2 + 1) * y[k] + (t3 - 2 * t2 + t) * h * m[k] + (-2 * t3 + 3 * t2) * y[k + 1] + (t3 - t2) * h * m[k + 1];
  return std::max(0.0, v);
}

}  // namespace

std::vector<WidthPoint> presetPoints(WidthProfile profile) {
  switch (profile) {
    case WidthProfile::WEDGE: return {sym(0, 1), sym(1, 0)};                        // full width → a point
    case WidthProfile::TAPER: return {sym(0, 1), sym(1, 0.25)};                     // full → a quarter
    case WidthProfile::QUARTER_TAPER: return {sym(0, 0.25), sym(0.25, 1), sym(1, 0.25)};
    case WidthProfile::EYE: return {sym(0, 0), sym(0.5, 1), sym(1, 0)};             // points at both ends
    case WidthProfile::MIRRORED_TAPER: return {sym(0, 0.25), sym(0.5, 1), sym(1, 0.25)};
    default: return {};
  }
}

WidthProfile matchPreset(const std::vector<WidthPoint>& points) {
  if (points.empty()) return WidthProfile::UNIFORM;
  for (int i = 1; i < static_cast<int>(WidthProfile::CUSTOM); i++) {
    auto preset = presetPoints(static_cast<WidthProfile>(i));
    if (preset.size() != points.size()) continue;
    bool same = true;
    for (size_t k = 0; k < preset.size() && same; k++)
      same = std::fabs(preset[k].position - points[k].position) < 1e-4 && std::fabs(preset[k].ascent - points[k].ascent) < 1e-4 &&
             std::fabs(preset[k].descent - points[k].descent) < 1e-4;
    if (same) return static_cast<WidthProfile>(i);
  }
  return WidthProfile::CUSTOM;
}

std::vector<WidthPoint> normalized(std::vector<WidthPoint> points) {
  for (auto& p : points) {
    p.position = std::isfinite(p.position) ? std::clamp(p.position, 0.0, 1.0) : 0;
    p.ascent = std::isfinite(p.ascent) ? std::max(0.0, p.ascent) : 0.5;
    p.descent = std::isfinite(p.descent) ? std::max(0.0, p.descent) : 0.5;
  }
  std::stable_sort(points.begin(), points.end(), [](const WidthPoint& a, const WidthPoint& b) { return a.position < b.position; });
  return points;
}

void profileAt(const std::vector<WidthPoint>& sorted, double u, double& ascent, double& descent) {
  if (sorted.empty()) {
    ascent = descent = 0.5;
    return;
  }
  std::vector<double> x, a, d;
  x.reserve(sorted.size());
  for (const WidthPoint& p : sorted) {
    // Points at the same position: the last one counts.
    if (!x.empty() && std::fabs(p.position - x.back()) < 1e-9) {
      a.back() = p.ascent, d.back() = p.descent;
      continue;
    }
    x.push_back(p.position), a.push_back(p.ascent), d.push_back(p.descent);
  }
  ascent = monotone(x, a, u);
  descent = monotone(x, d, u);
}

double maxShare(const std::vector<WidthPoint>& points) {
  double m = 0.5;
  for (const WidthPoint& p : points) m = std::max({m, p.ascent, p.descent});
  return m;
}

std::vector<WidthPoint> flipped(const std::vector<WidthPoint>& points) {
  std::vector<WidthPoint> out = points;
  for (auto& p : out) p.position = 1 - p.position;
  return normalized(std::move(out));
}

}  // namespace eng::geom

namespace eng {

std::vector<geom::WidthPoint> widthPointsOf(const NodeProps& p) {
  auto it = p.extra.find("variableWidthPoints");
  if (it == p.extra.end() || it->second.empty()) return {};
  json::Value v;
  if (!json::parse(codec::extraValueToJson("NodeChange", it->second), v) || !v.isArray()) return {};
  std::vector<geom::WidthPoint> out;
  for (const json::Value& e : v.array) {
    if (!e.isObject()) continue;
    geom::WidthPoint w;
    if (const json::Value* x = e.get("position")) w.position = x->numberOr(0);
    if (const json::Value* x = e.get("ascent")) w.ascent = x->numberOr(0.5);
    if (const json::Value* x = e.get("descent")) w.descent = x->numberOr(0.5);
    out.push_back(w);
  }
  return geom::normalized(std::move(out));
}

bool hasWidthPoints(const NodeProps& p) {
  auto it = p.extra.find("variableWidthPoints");
  return it != p.extra.end() && !it->second.empty();
}

uint64_t widthPointsKey(const NodeProps& p) {
  auto it = p.extra.find("variableWidthPoints");
  return it == p.extra.end() ? 0 : std::hash<std::string>()(it->second);
}

std::string encodeWidthPoints(const std::vector<geom::WidthPoint>& points) {
  if (points.empty()) return {};
  json::Value list;
  list.kind = json::Value::Kind::Array;
  auto number = [](double x) {
    json::Value n;
    n.kind = json::Value::Kind::Number;
    n.number = x;
    return n;
  };
  for (const geom::WidthPoint& w : points) {
    json::Value o;
    o.kind = json::Value::Kind::Object;
    o.object.emplace_back("position", number(w.position));
    o.object.emplace_back("ascent", number(w.ascent));
    o.object.emplace_back("descent", number(w.descent));
    o.object.emplace_back("segmentId", number(0));
    list.array.push_back(std::move(o));
  }
  return codec::extraFromJson("NodeChange", "variableWidthPoints", list);
}

bool widthProfileAllowed(const NodeProps& p) {
  if (!p.stroke().dashPattern.empty()) return false;
  auto it = p.extra.find("dynamicStrokeSettings");
  return it == p.extra.end() || it->second.empty();
}

}  // namespace eng
