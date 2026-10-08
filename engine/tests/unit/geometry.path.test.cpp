// Paths, Figma's blobs, vector networks, shapes and the stroker (docs/engine.md §5).
#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdlib>

#include "GeometryHelpers.h"
#include "doctest.h"
#include "geometry/Shapes.h"
#include "geometry/Stroker.h"
#include "geometry/VectorNetwork.h"

using namespace eng;
using namespace eng::geom;

namespace {
constexpr double kPi = 3.14159265358979323846;
}

TEST_CASE("commandsBlob: Figma's path encoding round-trips byte for byte") {
  json::Value doc = test::figmaSampleJson("structure");
  codec::BlobsIn blobs = codec::readBlobs(doc);
  int checked = 0;
  for (auto& n : doc.get("nodeChanges")->array) {
    const json::Value* geometry = n.get("fillGeometry");
    if (!geometry || !geometry->isArray()) continue;
    for (auto& g : geometry->array) {
      Bytes bytes = blobs.get(g.get("commandsBlob"));
      REQUIRE(bytes);
      Path p = Path::fromCommands(bytes->data(), bytes->size());
      CHECK(p.toCommands() == *bytes);
      checked++;
    }
  }
  CHECK(checked >= 10);
}

TEST_CASE("vector networks decode and re-encode byte for byte (structure.fig)") {
  auto nodes = test::figmaSample("structure");
  int vectors = 0;
  for (auto& n : nodes) {
    if (n.props.type != NodeType::VECTOR) continue;
    vectors++;
    REQUIRE(n.props.shape().vectorData.present);
    REQUIRE(n.props.shape().vectorData.network);
    const auto& bytes = *n.props.shape().vectorData.network;
    VectorNetwork net;
    REQUIRE(VectorNetwork::decode(bytes.data(), bytes.size(), net));
    CHECK(!net.vertices.empty());
    CHECK(!net.segments.empty());
    CHECK(net.encode() == bytes);
  }
  CHECK(vectors == 8);
}

TEST_CASE("a network's fill is Figma's own fillGeometry (the Sketch logo in structure.fig)") {
  json::Value doc = test::figmaSampleJson("structure");
  codec::BlobsIn blobs = codec::readBlobs(doc);
  auto nodes = test::figmaSample("structure");
  int compared = 0;
  for (auto& raw : doc.get("nodeChanges")->array) {
    const json::Value* type = raw.get("type");
    if (!type || type->string != "VECTOR") continue;
    NodeChange n;
    REQUIRE(codec::readChange(raw, n, &blobs));
    VectorNetwork net;
    REQUIRE(VectorNetwork::decode(n.props.shape().vectorData.network->data(), n.props.shape().vectorData.network->size(), net));
    auto fills = networkFills(net, n.props.shape().vectorData, n.props.size);
    REQUIRE(fills.size() == 1);
    Bytes figma = blobs.get(raw.get("fillGeometry")->array[0].get("commandsBlob"));
    Path theirs = Path::fromCommands(figma->data(), figma->size());
    double diff = test::mismatch(fills[0].path, fills[0].windingRule == WindingRule::ODD, theirs, false, 0.05);
    CHECK(diff < 0.002);
    Rect a = fills[0].path.bounds(), b = theirs.bounds();
    CHECK(std::fabs(a.x - b.x) < 0.01);
    CHECK(std::fabs(a.right() - b.right()) < 0.01);
    CHECK(std::fabs(a.bottom() - b.bottom()) < 0.01);
    compared++;
  }
  CHECK(compared == 8);
}

TEST_CASE("networks: chains, regions, a network made from a path") {
  Path tri;
  tri.moveTo({0, 0});
  tri.lineTo({10, 0});
  tri.cubicTo({10, 5}, {5, 10}, {0, 10});
  tri.close();
  VectorNetwork net = networkFromPath(tri, WindingRule::NONZERO);
  CHECK(net.vertices.size() == 3);
  CHECK(net.segments.size() == 3);
  REQUIRE(net.regions.size() == 1);
  CHECK(net.regions[0].loops[0].size() == 3);
  auto chains = net.chains();
  REQUIRE(chains.size() == 1);
  CHECK(chains[0].closed);
  VectorNetwork back;
  auto bytes = net.encode();
  REQUIRE(VectorNetwork::decode(bytes.data(), bytes.size(), back));
  CHECK(test::mismatch(back.regionPath(back.regions[0]), false, tri, false, 0.1) < 0.002);
  // An open path: one open chain, filled as if closed when it has no region.
  Path open;
  open.moveTo({0, 0});
  open.lineTo({10, 0});
  open.lineTo({10, 10});
  VectorNetwork o = networkFromPath(open, WindingRule::NONZERO);
  CHECK(o.regions.empty());
  auto oc = o.chains();
  REQUIRE(oc.size() == 1);
  CHECK(!oc[0].closed);
  VectorData d;
  d.present = true;
  d.normalizedSize = {10, 10};
  auto fills = networkFills(o, d, {20, 20});  // scaled ×2
  REQUIRE(fills.size() == 1);
  CHECK(std::fabs(test::sampledArea(fills[0].path, false, 0.1) - 200) < 2);
}

TEST_CASE("shapes: rounded and smoothed rectangles, arcs, polygons, stars") {
  // Plain and rounded.
  CHECK(std::fabs(test::sampledArea(rectPath({100, 50}, {0, 0, 0, 0}), false, 0.25) - 5000) < 1);
  double rounded = 5000 - (4 - kPi) * 100;  // r = 10 at every corner
  CHECK(std::fabs(test::sampledArea(rectPath({100, 50}, {10, 10, 10, 10}), false, 0.1) - rounded) < 3);
  // Radii larger than the sides shrink together (Figma's clamp).
  CornerRadii c = clampRadii({100, 50}, {40, 40, 40, 40});
  CHECK(c[0] == doctest::Approx(25));
  // Smoothing keeps the box and sits between the sharp and the round corner.
  Path smooth = rectPath({100, 100}, {20, 20, 20, 20}, 0.6);
  Rect b = smooth.bounds();
  CHECK(b.x == doctest::Approx(0).epsilon(1e-9));
  CHECK(b.right() == doctest::Approx(100));
  double sa = test::sampledArea(smooth, false, 0.1);
  double round20 = 10000 - (4 - kPi) * 400;
  CHECK(sa < round20);
  CHECK(sa > round20 - 300);
  // Next to square corners a smoothed corner has its whole edge (Figma's fillGeometry; figma-squircle's per-edge
  // budget): 122 × 28, radii 14 14 0 0, smoothing 0.6 → the top right corner starts (1 + 0.6) × 14 = 22.4 before the
  // corner (a budget of min(w, h) / 2 = 14 gave up the smoothing).
  Path tab = rectPath({122, 28}, {14, 14, 0, 0}, 0.6);
  REQUIRE(tab.points.size() > 2);
  CHECK(tab.points[1].x == doctest::Approx(122 - 22.4));
  CHECK(tab.points[1].y == doctest::Approx(0));
  CornerRadii tabRadii{14, 14, 0, 0};
  CornerRadii budgets = cornerBudgets({122, 28}, tabRadii);
  CHECK(budgets[0] == doctest::Approx(28));
  CHECK(budgets[1] == doctest::Approx(28));
  // Equal radii: half the shorter side, as before.
  CornerRadii even{20, 20, 20, 20};
  CHECK(cornerBudgets({100, 60}, even)[2] == doctest::Approx(30));
  // Smoothing 0 is the plain rounded rectangle.
  CHECK(test::mismatch(rectPath({100, 100}, {20, 20, 20, 20}, 0), false, rectPath({100, 100}, {20, 20, 20, 20}), false, 0.1) < 1e-9);
  // Ellipses and arcs.
  CHECK(std::fabs(test::sampledArea(ellipsePath({100, 60}, {}), false, 0.1) - kPi * 50 * 30) < 15);
  ArcData half{0, kPi, 0};
  CHECK(std::fabs(test::sampledArea(ellipsePath({100, 100}, half), false, 0.1) - kPi * 2500 / 2) < 15);
  ArcData ring{0, 2 * kPi, 0.5};
  CHECK(std::fabs(test::sampledArea(ellipsePath({100, 100}, ring), false, 0.1) - kPi * (2500 - 625)) < 20);
  ArcData quarterDonut{0, kPi / 2, 0.5};
  CHECK(std::fabs(test::sampledArea(ellipsePath({100, 100}, quarterDonut), false, 0.1) - kPi * (2500 - 625) / 4) < 10);
  // A triangle fills its box: apex at the top centre, the base along the bottom.
  Path tri = polygonPath({100, 100}, 3, 0);
  Rect tb = tri.bounds();
  CHECK(tb.x == doctest::Approx(0).epsilon(1e-9));
  CHECK(tb.w == doctest::Approx(100));
  CHECK(tb.h == doctest::Approx(100));
  CHECK(std::fabs(test::sampledArea(tri, false, 0.1) - 5000) < 10);
  // A 5-point star: 10 corners.
  Path star = starPath({100, 100}, 5, 0.382, 0);
  CHECK(test::countVerb(star, Verb::Line) == 9);
  CHECK(star.bounds().w == doctest::Approx(100));
  // Rounded corners make it smaller, not larger.
  CHECK(test::sampledArea(starPath({100, 100}, 5, 0.382, 5), false, 0.2) < test::sampledArea(star, false, 0.2));
}

TEST_CASE("stroker: caps, joins, dashes") {
  Path line;
  line.moveTo({0, 0});
  line.lineTo({100, 0});
  StrokeStyle s;
  s.width = 10;
  CHECK(std::fabs(test::sampledArea(strokePath(line, s, 0.05), false, 0.1) - 1000) < 3);
  s.cap = StrokeCap::SQUARE;
  CHECK(std::fabs(test::sampledArea(strokePath(line, s, 0.05), false, 0.1) - 1100) < 3);
  s.cap = StrokeCap::ROUND;
  CHECK(std::fabs(test::sampledArea(strokePath(line, s, 0.05), false, 0.1) - (1000 + kPi * 25)) < 4);
  // Dashes: half on, half off.
  s.cap = StrokeCap::NONE;
  s.dashes = {10, 10};
  CHECK(std::fabs(test::sampledArea(strokePath(line, s, 0.05), false, 0.1) - 500) < 3);
  s.dashes.clear();
  // A right-angle corner: miter fills the corner square, bevel cuts half of it, round a quarter circle.
  Path corner;
  corner.moveTo({0, 0});
  corner.lineTo({100, 0});
  corner.lineTo({100, 100});
  double base = 2 * 1000;  // two 100 × 10 strips
  s.join = StrokeJoin::MITER;
  double miter = test::sampledArea(strokePath(corner, s, 0.05), false, 0.1);
  s.join = StrokeJoin::BEVEL;
  double bevel = test::sampledArea(strokePath(corner, s, 0.05), false, 0.1);
  s.join = StrokeJoin::ROUND;
  double round = test::sampledArea(strokePath(corner, s, 0.05), false, 0.1);
  CHECK(std::fabs(miter - base) < 4);  // the outer corner square (25) replaces the inner overlap (25)
  CHECK(std::fabs(bevel - (base - 12.5)) < 4);
  CHECK(std::fabs(round - (base - 25 + kPi * 25 / 4)) < 4);
  // Miter limit: a sharp turn falls back to a bevel.
  Path sharp;
  sharp.moveTo({0, 0});
  sharp.lineTo({100, 0});
  sharp.lineTo({0, 10});
  s.join = StrokeJoin::MITER;
  s.miterLimit = 4;
  Rect bounds = strokePath(sharp, s, 0.05).bounds();
  CHECK(bounds.right() < 110);
  // A closed square: no caps, joins everywhere: outer 110², inner 90².
  Path sq = rectPath({100, 100}, {0, 0, 0, 0});
  s.join = StrokeJoin::MITER;
  CHECK(std::fabs(test::sampledArea(strokePath(sq, s, 0.05), false, 0.1) - (110 * 110 - 90 * 90)) < 6);
  // Arrowheads reach past the end.
  s.cap = StrokeCap::ARROW_EQUILATERAL;
  s.width = 2;
  Rect arrow = strokePath(line, s, 0.05).bounds();
  CHECK(arrow.h > 6);
  CHECK(strokeReach(s, true) > 5);
  // Figma's line arrow at 1 px: arms 4.5 long, 45° off the line, round ends — ±(3.18 + 0.5) across.
  s.cap = StrokeCap::ARROW_LINES;
  s.width = 1;
  Rect lineArrow = strokePath(line, s, 0.05).bounds();
  CHECK(lineArrow.h == doctest::Approx(2 * (4.5 / std::sqrt(2.0) + 0.5)).epsilon(0.002));
}

namespace {

// An SVG path as Figma's exporter writes it (absolute M L H V C Z, numbers separated by spaces or signs).
Path svgPath(const char* d) {
  Path p;
  Vec2 cur{0, 0}, start{0, 0};
  char cmd = 0;
  const char* c = d;
  auto num = [&]() {
    while (*c == ' ' || *c == ',') c++;
    char* end = nullptr;
    double v = std::strtod(c, &end);
    c = end;
    return v;
  };
  while (*c) {
    while (*c == ' ') c++;
    if (!*c) break;
    if (std::isalpha(static_cast<unsigned char>(*c))) cmd = *c++;
    switch (cmd) {
      case 'M': cur = {num(), 0}; cur.y = num(); start = cur; p.moveTo(cur); cmd = 'L'; break;
      case 'L': cur = {num(), 0}; cur.y = num(); p.lineTo(cur); break;
      case 'H': cur.x = num(); p.lineTo(cur); break;
      case 'V': cur.y = num(); p.lineTo(cur); break;
      case 'C': {
        Vec2 a{num(), 0};
        a.y = num();
        Vec2 b{num(), 0};
        b.y = num();
        cur = {num(), 0};
        cur.y = num();
        p.cubicTo(a, b, cur);
        break;
      }
      case 'Z': p.close(); cur = start; cmd = 0; break;
      default: return p;
    }
  }
  return p;
}

}  // namespace

// Figma's end points as its SVG exporter writes their outlines (public Figma exports of lines with end points; the
// stroke's own outline, unioned): ours must cover the same area.
TEST_CASE("stroke end points: Figma's arrowheads, from its own exports") {
  struct Case {
    const char* what;
    Vec2 a, b;
    double w;
    StrokeCap start, end;
    const char* figma;
    std::vector<double> dashes = {};
  };
  const Case cases[] = {
      {"line arrows, 1 px", {1, 4}, {17, 4}, 1, StrokeCap::ARROW_LINES, StrokeCap::ARROW_LINES,
       "M0.646447 3.64645C0.451184 3.84171 0.451184 4.15829 0.646447 4.35355L3.82843 7.53553C4.02369 7.7308 4.34027 7.7308 4.53553 7.53553C4.7308 7.34027 4.7308 7.02369 4.53553 6.82843L1.70711 4L4.53553 1.17157C4.7308 0.976311 4.7308 0.659728 4.53553 0.464466C4.34027 0.269204 4.02369 0.269204 3.82843 0.464466L0.646447 3.64645ZM17.3536 4.35355C17.5488 4.15829 17.5488 3.84171 17.3536 3.64645L14.1716 0.464466C13.9763 0.269204 13.6597 0.269204 13.4645 0.464466C13.2692 0.659728 13.2692 0.976311 13.4645 1.17157L16.2929 4L13.4645 6.82843C13.2692 7.02369 13.2692 7.34027 13.4645 7.53553C13.6597 7.7308 13.9763 7.7308 14.1716 7.53553L17.3536 4.35355ZM1 4.5L17 4.5V3.5L1 3.5V4.5Z"},
      {"line arrow, 2 px", {1, 8}, {24, 8}, 2, StrokeCap::ARROW_LINES, StrokeCap::NONE,
       "M0.292892 7.29289C-0.0976315 7.68342 -0.0976315 8.31658 0.292892 8.70711L6.65685 15.0711C7.04738 15.4616 7.68054 15.4616 8.07107 15.0711C8.46159 14.6805 8.46159 14.0474 8.07107 13.6569L2.41421 8L8.07107 2.34315C8.46159 1.95262 8.46159 1.31946 8.07107 0.928932C7.68054 0.538408 7.04738 0.538408 6.65685 0.928932L0.292892 7.29289ZM24 7L1 7V9L24 9V7Z"},
      {"triangle arrow, 1 px (square cap at the other end)", {0, 3}, {55, 3}, 1, StrokeCap::ARROW_EQUILATERAL, StrokeCap::SQUARE,
       "M55 3.5H55.5V2.5H55V3.5ZM0 3L5 5.88675V0.113249L0 3ZM55 2.5L4.5 2.5V3.5L55 3.5V2.5Z"},
      {"triangle arrow, 2 px", {0, 6}, {30, 6}, 2, StrokeCap::ARROW_EQUILATERAL, StrokeCap::NONE,
       "M-1.90735e-06 6L10 11.7735V0.226497L-1.90735e-06 6ZM30 5L9 5V7L30 7V5Z"},
      {"reversed triangle, 1 px", {400, 3}, {522, 3}, 1, StrokeCap::NONE, StrokeCap::TRIANGLE_FILLED,
       "M517 3.5L522 5.88675V0.113249L517 2.5V3.5ZM400 3.5H517.5V2.5H400V3.5Z"},
      {"circle arrow, 1 px", {3, 179}, {131.782, 179}, 1, StrokeCap::CIRCLE_FILLED, StrokeCap::NONE,
       "M0.333333 179C0.333333 180.473 1.52724 181.667 3 181.667C4.47276 181.667 5.66667 180.473 5.66667 179C5.66667 177.527 4.47276 176.333 3 176.333C1.52724 176.333 0.333333 177.527 0.333333 179ZM3 179.5H131.782V178.5H3V179.5Z"},
      {"diamond and line arrows, 1 px", {4, 3}, {4, 53}, 1, StrokeCap::DIAMOND_FILLED, StrokeCap::ARROW_LINES,
       "M4 0.113249L1.11325 3L4 5.88675L6.88675 3L4 0.113249ZM3.64645 53.3536C3.84171 53.5488 4.15829 53.5488 4.35356 53.3536L7.53554 50.1716C7.7308 49.9763 7.7308 49.6597 7.53554 49.4645C7.34027 49.2692 7.02369 49.2692 6.82843 49.4645L4 52.2929L1.17157 49.4645C0.976313 49.2692 0.65973 49.2692 0.464468 49.4645C0.269206 49.6597 0.269206 49.9763 0.464468 50.1716L3.64645 53.3536ZM4 3L3.5 3L3.5 53L4 53L4.5 53L4.5 3L4 3Z"},
      // Dashed lines: the pattern fitted to the line, half a dash at each end (a dashed 1170 px line's [10, 40] →
      // 23 periods of 50.87; a 32 px line's [4, 4] → 4 periods, its last half dash under the triangle).
      {"dashed, diamond and line arrow", {2.99463, 4}, {1173.006, 4}, 1, StrokeCap::DIAMOND_FILLED, StrokeCap::ARROW_LINES,
       "M0.107877 4L2.99463 6.88675L5.88138 4L2.99463 1.11325L0.107877 4ZM1173.36 4.35355C1173.55 4.15829 1173.55 3.84171 1173.36 3.64645L1170.18 0.464466C1169.98 0.269204 1169.67 0.269204 1169.47 0.464466C1169.27 0.659728 1169.27 0.976311 1169.47 1.17157L1172.3 4L1169.47 6.82843C1169.27 7.02369 1169.27 7.34027 1169.47 7.53553C1169.67 7.7308 1169.98 7.7308 1170.18 7.53553L1173.36 4.35355ZM2.99463 4.5H8.08163V3.5H2.99463V4.5ZM48.7777 4.5H58.9517V3.5H48.7777V4.5ZM99.6477 4.5H109.822V3.5H99.6477V4.5ZM150.518 4.5H160.692V3.5H150.518V4.5ZM201.388 4.5H211.562V3.5H201.388V4.5ZM252.258 4.5H262.432V3.5H252.258V4.5ZM303.128 4.5H313.302V3.5H303.128V4.5ZM353.998 4.5H364.172V3.5H353.998V4.5ZM404.868 4.5H415.042V3.5H404.868V4.5ZM455.738 4.5H465.912V3.5H455.738V4.5ZM506.608 4.5H516.782V3.5H506.608V4.5ZM557.478 4.5H567.652V3.5H557.478V4.5ZM608.348 4.5H618.522V3.5H608.348V4.5ZM659.218 4.5H669.392V3.5H659.218V4.5ZM710.088 4.5H720.262V3.5H710.088V4.5ZM760.958 4.5H771.132V3.5H760.958V4.5ZM811.828 4.5H822.002V3.5H811.828V4.5ZM862.698 4.5H872.872V3.5H862.698V4.5ZM913.568 4.5H923.742V3.5H913.568V4.5ZM964.438 4.5H974.612V3.5H964.438V4.5ZM1015.31 4.5H1025.48V3.5H1015.31V4.5ZM1066.18 4.5H1076.35V3.5H1066.18V4.5ZM1117.05 4.5H1127.22V3.5H1117.05V4.5ZM1167.92 4.5H1173.01V3.5H1167.92V4.5Z",
       {10, 40}},
      {"dashed, triangle arrow", {0, 3}, {32, 3}, 1, StrokeCap::NONE, StrokeCap::ARROW_EQUILATERAL,
       "M32 3L27 0.113249V5.88675L32 3ZM0 3V3.5H2V3V2.5H0V3ZM6 3V3.5H10V3V2.5H6V3ZM14 3V3.5H18V3V2.5H14V3ZM22 3V3.5H26V3V2.5H22V3Z", {4, 4}},
  };
  for (const Case& k : cases) {
    CAPTURE(k.what);
    Path line;
    line.moveTo(k.a);
    line.lineTo(k.b);
    StrokeStyle s;
    s.width = k.w;
    s.dashes = k.dashes;
    std::vector<std::pair<StrokeCap, StrokeCap>> caps{{k.start, k.end}};
    s.caps = &caps;
    Path ours = strokePath(line, s, 0.01);
    Path figma = svgPath(k.figma);
    // Bounds of the outlines themselves (flattened: control points don't count).
    auto extent = [](const Path& p) {
      Rect r{1e9, 1e9, -2e9, -2e9};
      double x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
      for (const Polyline& pl : flatten(p, 0.001))
        for (Vec2 q : pl.points) x0 = std::min(x0, q.x), y0 = std::min(y0, q.y), x1 = std::max(x1, q.x), y1 = std::max(y1, q.y);
      r = {x0, y0, x1 - x0, y1 - y0};
      return r;
    };
    Rect a = extent(ours), b = extent(figma);
    CHECK(std::fabs(a.x - b.x) < 0.01);
    CHECK(std::fabs(a.y - b.y) < 0.01);
    CHECK(std::fabs(a.right() - b.right()) < 0.01);
    CHECK(std::fabs(a.bottom() - b.bottom()) < 0.01);
    CHECK(test::mismatch(ours, false, figma, false, 0.02) < 0.001);  // measured: 0 – 5e-5
  }
}

TEST_CASE("corner radius on a vector network rounds its sharp corners") {
  Path sq = rectPath({100, 100}, {0, 0, 0, 0});
  VectorNetwork net = networkFromPath(sq, WindingRule::NONZERO);
  VectorData d;
  d.present = true;
  d.normalizedSize = {100, 100};
  VectorNetwork r = withRoundedCorners(net, d, 10);
  CHECK(r.segments.size() == 8);
  auto fills = networkFills(r, d, {100, 100});
  REQUIRE(fills.size() == 1);
  CHECK(std::fabs(test::sampledArea(fills[0].path, false, 0.1) - (10000 - (4 - kPi) * 100)) < 4);
  // A vertex's own radius wins over the node's.
  d.styleOverrideTable.push_back(VectorStyle{7, VS_CORNER_RADIUS, {}, StrokeCap::NONE, StrokeJoin::MITER, VectorMirror::NONE, 0, ""});
  net.vertices[0].styleID = 7;
  VectorNetwork r2 = withRoundedCorners(net, d, 10);
  CHECK(r2.segments.size() == 7);
}
