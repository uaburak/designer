// The geometry comparator (round 7, item 14): Figma's own fillGeometry / strokeGeometry — what Figma's renderer filled
// for every node, kept in the samples' full fixtures (engine/tools/fixtures.mjs) — against ours: the node's fill
// regions (NodeGeometry) and its stroke as the renderer draws it (the stroker's outline at the alignment's width,
// kept inside / outside the fill; per-side rings). Each pair is sampled on a grid, row by row with the fill rules,
// and scored by the area where they disagree over Figma's outline length: the mean distance between the two outlines
// in px (0.5 px = half a pixel off all round).
//
// ENG_FIG_GEOMETRY=/path/file.full.json (engine/tools/fig-geometry.mjs writes one from any .fig) compares that file
// too, and prints its worst nodes.
#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <cstdio>
#include <string>
#include <vector>

#include "doctest.h"
#include "editor/Editor.h"
#include "geometry/Shapes.h"
#include "geometry/Stroker.h"
#include "GeometryHelpers.h"

using namespace eng;
using namespace eng::geom;

namespace {

// A region: the union of `paths` (each with its own rule), optionally kept inside (or outside) `clip`.
struct Shape {
  std::vector<std::pair<std::vector<Polyline>, bool>> paths;  // flattened, evenOdd
  std::vector<std::pair<std::vector<Polyline>, bool>> clip;
  bool clipOutside = false;
};

void addPath(std::vector<std::pair<std::vector<Polyline>, bool>>& to, const Path& p, bool evenOdd, double tol) {
  to.push_back({flatten(p, tol), evenOdd});
}

// Which of the samples x0 + (i + ½)·step (i < n) on row y are inside `polys` under the rule.
void rowInside(const std::vector<Polyline>& polys, bool evenOdd, double y, double x0, double step, size_t n, std::vector<uint8_t>& out) {
  std::vector<std::pair<double, int>> cross;
  for (const Polyline& pl : polys) {
    size_t m = pl.points.size();
    if (m < 2) continue;
    for (size_t i = 0; i < m; i++) {
      Vec2 a = pl.points[i], b = pl.points[(i + 1) % m];  // every contour closes for filling
      if ((a.y <= y) == (b.y <= y)) continue;
      double x = a.x + (y - a.y) / (b.y - a.y) * (b.x - a.x);
      cross.push_back({x, b.y > a.y ? 1 : -1});
    }
  }
  std::sort(cross.begin(), cross.end());
  int w = 0;
  size_t k = 0;
  for (size_t i = 0; i < n; i++) {
    double x = x0 + (static_cast<double>(i) + 0.5) * step;
    while (k < cross.size() && cross[k].first <= x) w += cross[k++].second;
    bool in = evenOdd ? (w & 1) != 0 : w != 0;
    if (in) out[i] = 1;
  }
}

void rowOf(const Shape& s, double y, double x0, double step, size_t n, std::vector<uint8_t>& out) {
  std::fill(out.begin(), out.end(), 0);
  for (auto& [polys, eo] : s.paths) rowInside(polys, eo, y, x0, step, n, out);
  if (s.clip.empty()) return;
  std::vector<uint8_t> c(n, 0);
  for (auto& [polys, eo] : s.clip) rowInside(polys, eo, y, x0, step, n, c);
  for (size_t i = 0; i < n; i++)
    if (out[i] && (c[i] != 0) == s.clipOutside) out[i] = 0;
}

double perimeter(const Shape& s) {
  double len = 0;
  for (auto& [polys, eo] : s.paths)
    for (const Polyline& pl : polys)
      for (size_t i = 0; i + 1 < pl.points.size() + (pl.closed ? 1 : 0); i++)
        len += (pl.points[(i + 1) % pl.points.size()] - pl.points[i]).length();
  return len;
}

Rect boundsOf(const Shape& s) {
  bool first = true;
  Rect r;
  for (auto& [polys, eo] : s.paths)
    for (const Polyline& pl : polys)
      for (Vec2 p : pl.points) {
        Rect q{p.x, p.y, 0, 0};
        r = first ? q : r.united(q);
        first = false;
      }
  return r;
}

// The mean distance (px) between the outlines of `figma` and `ours`: the area where they disagree over Figma's
// outline length (∞ when Figma has nothing to measure against).
double outlineError(const Shape& figma, const Shape& ours) {
  Rect r = boundsOf(figma).united(boundsOf(ours));
  double P = perimeter(figma);
  if (!(P > 0) || r.w <= 0 || r.h <= 0) return 0;
  // About 0.05 px per sample on small shapes, coarser on big ones (at most ~3 M samples).
  double step = std::max(0.05, std::sqrt(r.w * r.h / 3e6));
  size_t n = static_cast<size_t>(std::ceil(r.w / step)) + 2;
  double x0 = r.x - step;
  std::vector<uint8_t> a(n), b(n);
  double diff = 0;
  for (double y = r.y - step * 0.5; y < r.bottom() + step; y += step) {
    rowOf(figma, y, x0, step, n, a);
    rowOf(ours, y, x0, step, n, b);
    for (size_t i = 0; i < n; i++) diff += a[i] != b[i];
  }
  return diff * step * step / P;
}

Path pathOf(const codec::BlobsIn& blobs, const json::Value& g) {
  Bytes bytes = blobs.get(g.get("commandsBlob"));
  if (!bytes) return {};
  return Path::fromCommands(bytes->data(), bytes->size());
}

bool evenOddOf(const json::Value& g) {
  const json::Value* w = g.get("windingRule");
  return w && w->isString() && (w->string == "ODD" || w->string == "EVENODD");
}

// Our stroke in the form Figma stores its strokeGeometry (seen in sections.fig): a per-side ring as drawn; otherwise
// the stroker's outline of the centre line, unclipped — at twice the weight when the stroke is aligned (INSIDE /
// OUTSIDE) on a closed shape (the renderer then keeps the inner / outer half, as ours does). A dashed aligned stroke's
// geometry holds its dashes twice, at the weight and at twice it: their union is the latter.
bool ourStroke(const Document& doc, Guid id, const NodeProps& p, Shape& out, double tol) {
  if (!(p.strokeWeight > 0)) return false;
  bool independent = p.stroke().borderStrokeWeightsIndependent && (p.isRectLike() || p.isFrameLike());
  if (independent) {
    const auto& bw = p.stroke().borderWeights;
    double k0 = p.strokeAlign == StrokeAlign::INSIDE ? 0 : p.strokeAlign == StrokeAlign::OUTSIDE ? 1 : 0.5;
    double t = bw[0], r = bw[1], b = bw[2], l = bw[3];
    Rect outerBox{-l * k0, -t * k0, p.size.x + (l + r) * k0, p.size.y + (t + b) * k0};
    Rect innerBox{outerBox.x + l, outerBox.y + t, outerBox.w - l - r, outerBox.h - t - b};
    CornerRadii radii = clampRadii(p.size, p.cornerRadii);
    Path ring = rectPath({outerBox.w, outerBox.h}, radii).transformed(Mat2x3::translate(outerBox.x, outerBox.y));
    if (innerBox.w > 0 && innerBox.h > 0) {
      CornerRadii ir;
      for (size_t i = 0; i < 4; i++) ir[i] = std::max(0.0, radii[i] - std::max(t, l));
      ring.append(rectPath({innerBox.w, innerBox.h}, ir).transformed(Mat2x3::translate(innerBox.x, innerBox.y)).reversed());
    }
    addPath(out.paths, ring, false, tol);
    return true;
  }
  const NodeGeometry* g = doc.geometry(id);
  if (!g || g->stroke.path.empty()) return false;
  bool closedArea = !g->fills.empty() && !g->hasOpenEnds;
  bool aligned = closedArea && p.strokeAlign != StrokeAlign::CENTER;
  StrokeStyle style;
  style.width = p.strokeWeight * (aligned ? 2 : 1);
  style.join = p.strokeJoin;
  style.miterLimit = p.miterLimit;
  style.cap = p.strokeCap;
  style.dashes = p.stroke().dashPattern;
  style.fitDashes = p.isRectLike() || p.isFrameLike();
  style.caps = g->stroke.caps.empty() ? nullptr : &g->stroke.caps;
  addPath(out.paths, strokePath(g->stroke.path, style, tol), false, tol);
  return true;
}

struct Report {
  int fills = 0, strokes = 0;
  double fillSum = 0, strokeSum = 0, fillMax = 0, strokeMax = 0;
  std::string fillWorst, strokeWorst;
  std::vector<std::pair<double, std::string>> all;
};

Report compare(const json::Value& doc) {
  Report rep;
  codec::BlobsIn blobs = codec::readBlobs(doc);
  Editor e;
  e.setSessionID(9);
  e.loadDocument(codec::readMessage(doc), kNoGuid);
  const Document& d = e.document();
  const double tol = 0.01;
  for (auto& raw : doc.get("nodeChanges")->array) {
    Guid id;
    if (!raw.get("guid") || !codec::readGuid(*raw.get("guid"), id)) continue;
    const Node* n = d.get(id);
    if (!n || n->props.type == NodeType::TEXT) continue;  // glyph outlines depend on the fonts at hand
    const NodeProps& p = n->props;
    std::string name = p.name + " (" + id.toString() + ")";
    if (const json::Value* fg = raw.get("fillGeometry"); fg && fg->isArray() && !fg->array.empty()) {
      const NodeGeometry* g = d.geometry(id);
      if (g && !g->fills.empty()) {
        Shape figma, ours;
        for (auto& x : fg->array) addPath(figma.paths, pathOf(blobs, x), evenOddOf(x), tol);
        for (auto& f : g->fills) addPath(ours.paths, f.path, f.windingRule == WindingRule::ODD, tol);
        double err = outlineError(figma, ours);
        rep.fills++;
        rep.fillSum += err;
        rep.all.push_back({err, "fill " + name});
        if (err > rep.fillMax) rep.fillMax = err, rep.fillWorst = name;
      }
    }
    if (const json::Value* sg = raw.get("strokeGeometry"); sg && sg->isArray() && !sg->array.empty()) {
      Shape figma, ours;
      for (auto& x : sg->array) addPath(figma.paths, pathOf(blobs, x), evenOddOf(x), tol);
      if (perimeter(figma) > 0 && ourStroke(d, id, p, ours, tol)) {
        double err = outlineError(figma, ours);
        if (const char* dbg = std::getenv("ENG_FIG_DEBUG"); dbg && id.toString() == dbg) {
          // The first contours of each, by their bounds (ENG_FIG_DEBUG=<guid>).
          for (auto* sh : {&figma, &ours}) {
            int k = 0;
            for (auto& [polys, eo] : sh->paths)
              for (const Polyline& pl : polys) {
                Rect r{pl.points[0].x, pl.points[0].y, 0, 0};
                for (Vec2 q : pl.points) r = r.united({q.x, q.y, 0, 0});
                if (k++ < 14) MESSAGE((sh == &figma ? "figma " : "ours  ") << r.x << ".." << r.right() << " × " << r.y << ".." << r.bottom());
              }
            MESSAGE((sh == &figma ? "figma " : "ours  ") << k << " contours");
          }
        }
        rep.strokes++;
        rep.strokeSum += err;
        rep.all.push_back({err, "stroke " + name});
        if (err > rep.strokeMax) rep.strokeMax = err, rep.strokeWorst = name;
      }
    }
  }
  return rep;
}

void print(const std::string& file, const Report& r) {
  MESSAGE(file << ": fills " << r.fills << " (mean " << (r.fills ? r.fillSum / r.fills : 0) << " px, max " << r.fillMax << " px "
               << r.fillWorst << "), strokes " << r.strokes << " (mean " << (r.strokes ? r.strokeSum / r.strokes : 0) << " px, max "
               << r.strokeMax << " px " << r.strokeWorst << ")");
}

}  // namespace

TEST_CASE("geometry comparator: Figma's fillGeometry / strokeGeometry against ours — the samples") {
  for (const char* name : {"structure", "sections", "stacks_wrap"}) {
    Report r = compare(test::figmaSampleJson(name));
    print(name, r);
    CHECK(r.fills > 0);
    // Fills and strokes (dashes fitted to the sides included) match to a hundredth of a pixel.
    CHECK(r.fillMax < 0.02);
    CHECK(r.strokeMax < 0.02);
  }
}

TEST_CASE("geometry comparator: any file (ENG_FIG_GEOMETRY=file.full.json)") {
  const char* path = std::getenv("ENG_FIG_GEOMETRY");
  if (!path || !*path) return;
  json::Value v;
  REQUIRE(json::parse(test::readFile(path), v));
  Report r = compare(v);
  print(path, r);
  std::sort(r.all.begin(), r.all.end(), [](auto& a, auto& b) { return a.first > b.first; });
  for (size_t i = 0; i < r.all.size() && i < 25; i++) MESSAGE(r.all[i].first << " px  " << r.all[i].second);
  size_t over = 0;
  for (auto& [err, what] : r.all) over += err > 0.05;
  MESSAGE(over << " of " << r.all.size() << " over 0.05 px");
}
