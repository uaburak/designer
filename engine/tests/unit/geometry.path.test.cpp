// Paths, Figma's blobs, vector networks, shapes and the stroker (docs/engine.md §5).
#include <cmath>

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
    REQUIRE(n.props.vectorData.present);
    REQUIRE(n.props.vectorData.network);
    const auto& bytes = *n.props.vectorData.network;
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
    REQUIRE(VectorNetwork::decode(n.props.vectorData.network->data(), n.props.vectorData.network->size(), net));
    auto fills = networkFills(net, n.props.vectorData, n.props.size);
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
