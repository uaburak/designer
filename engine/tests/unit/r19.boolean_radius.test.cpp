// Round 19a: a boolean group's own corner radius and smoothing round its result (live Figma 2026-10-19,
// docs/research/figma/live/2026-10-18/boolean-radius.txt — Figma's exported SVG outlines are the reference): every
// corner, convex and concave, clamped per corner to half of each neighbouring edge; 999 as round as fits; children keep
// their own radii; a nested boolean is rounded once, by the outermost; Flatten bakes the rounded outline; hit-testing,
// bounds and the SVG export follow it.
#include <cmath>
#include <string>

#include "doctest.h"
#include "editor/Editor.h"
#include "export/SvgWriter.h"
#include "scene/CodecKiwi.h"
#include "geometry/CornerRounding.h"
#include "geometry/Shapes.h"
#include "GeometryHelpers.h"
#include "Helpers.h"

using namespace eng;
using namespace eng::test;

namespace {

// Figma's outlines (boolean-radius.txt): A 300 × 240 at the origin, B 60 × 200 over A's top centre, 30 above it.
const char* kSubtract20 =
    "M300 220C300 231.046 291.046 240 280 240H20C8.95 240 0 231.046 0 220V20C0 8.95 8.95 0 20 0H100C111.046 0 120 8.95 120 20V150C120 161.046 128.954 170 140 "
    "170H160C171.046 170 180 161.046 180 150V20C180 8.95 188.954 0 200 0H280C291.046 0 300 8.95 300 20V220Z";
const char* kSubtract999 =
    "M300 120C300 186.274 246.274 240 180 240H120C53.73 240 0 186.274 0 120V60C0 26.86 26.86 0 60 0C93.14 0 120 26.86 120 60V140C120 156.569 133.431 170 150 "
    "170C166.569 170 180 156.569 180 140V60C180 26.86 206.86 0 240 0C273.14 0 300 26.86 300 60V120Z";

const Guid kBool{1, 10}, kA{1, 11}, kB{1, 12};
// The boolean at (200, 100) on the page; A at (0, 30) in it, B at (120, 0): A's space is the boolean's moved up 30.
const Mat2x3 kToA = Mat2x3::translate(0, -30);

geom::Path svg(const char* d) {
  geom::Path p;
  REQUIRE(parseSvgPath(d, p));
  return p;
}

// The largest distance from either outline to the other (both flattened finely): 0 for the same shape.
double distance(const geom::Path& a, const geom::Path& b) {
  auto pa = geom::flatten(a, 0.005), pb = geom::flatten(b, 0.005);
  double worst = 0;
  for (auto& line : pa)
    for (Vec2 p : line.points) worst = std::max(worst, geom::distanceTo(pb, p));
  for (auto& line : pb)
    for (Vec2 p : line.points) worst = std::max(worst, geom::distanceTo(pa, p));
  return worst;
}

// An outline of horizontal and vertical edges with each corner's quarter circle (Figma's 0.5523 · r handles): the
// expected shapes Figma's text describes but doesn't spell out.
geom::Path orthogonal(const std::vector<Vec2>& pts, const std::vector<double>& radii) {
  geom::Path out;
  size_t n = pts.size();
  auto unit = [](Vec2 v) { return v * (1 / v.length()); };
  for (size_t i = 0; i < n; i++) {
    Vec2 V = pts[i], u = unit(V - pts[(i + n - 1) % n]), v = unit(pts[(i + 1) % n] - V);
    double r = radii[i], k = 0.5522847498 * r;
    Vec2 S = V - u * r, E = V + v * r;
    if (i == 0) out.moveTo(S);
    else out.lineTo(S);
    out.cubicTo(S + u * k, E - v * k, E);
  }
  out.close();
  return out;
}

struct Doc {
  Editor e;
  explicit Doc(BooleanOperation op, double radius, double smoothing = 0, double childRadius = 0) {
    auto nodes = baseChanges();
    NodeChange b = make(kBool, NodeType::BOOLEAN_OPERATION, kPage, "!", {200, 100, 300, 270}, "Boolean");
    b.props.shape().booleanOperation = op;
    b.props.cornerRadii = {radius, radius, radius, radius};
    b.props.stroke().cornerSmoothing = smoothing;
    b.props.fillPaints = {Paint::solid(Color::hex(0x0C8CE9))};
    nodes.push_back(b);
    NodeChange a = make(kA, NodeType::ROUNDED_RECTANGLE, kBool, "!", {0, 30, 300, 240}, "A");
    a.props.cornerRadii = {childRadius, childRadius, childRadius, childRadius};
    nodes.push_back(a);
    nodes.push_back(make(kB, NodeType::ROUNDED_RECTANGLE, kBool, "\"", {120, 0, 60, 200}, "B"));
    e.setViewport(800, 600, 1, 800, 600);
    e.loadDocument(nodes, kNoGuid);
    e.takeEvents();
  }
  // The result in A's space.
  geom::Path result() {
    const NodeGeometry* g = e.document().geometry(kBool);
    REQUIRE(g);
    REQUIRE(g->fills.size() == 1);
    return g->fills[0].path.transformed(kToA);
  }
};

}  // namespace

TEST_CASE("r19a: Subtract with radius 20 and 999 is Figma's outline") {
  CHECK(distance(Doc(BooleanOperation::SUBTRACT, 20).result(), svg(kSubtract20)) < 0.5);
  CHECK(distance(Doc(BooleanOperation::SUBTRACT, 999).result(), svg(kSubtract999)) < 0.5);
  // Closer than that: Figma's numbers to the hundredth (its arcs are 0.5523 · r cubics, as ours).
  CHECK(distance(Doc(BooleanOperation::SUBTRACT, 20).result(), svg(kSubtract20)) < 0.02);
  CHECK(distance(Doc(BooleanOperation::SUBTRACT, 999).result(), svg(kSubtract999)) < 0.02);
  // Radius 0: the sharp result as before.
  geom::Path sharp = Doc(BooleanOperation::SUBTRACT, 0).result();
  CHECK(test::countVerb(sharp, geom::Verb::Cubic) == 0);
}

TEST_CASE("r19a: Union, Exclude and Intersect round every corner, each clamped to what fits") {
  // Union r20: B's bump (30 high above A) rounded 15 at its top and into A's top edge (concave, 15); A's corners 20.
  geom::Path u = orthogonal({{0, 0}, {120, 0}, {120, -30}, {180, -30}, {180, 0}, {300, 0}, {300, 240}, {0, 240}}, {20, 15, 15, 15, 15, 20, 20, 20});
  CHECK(distance(Doc(BooleanOperation::UNION, 20).result(), u) < 0.02);
  // Exclude r20: two pieces — A without B (Subtract's outline) and B's 60 × 30 top, rounded 15.
  geom::Path x = Doc(BooleanOperation::XOR, 20).result();
  CHECK(test::countVerb(x, geom::Verb::Move) == 2);
  geom::Path both = svg(kSubtract20);
  both.append(orthogonal({{120, -30}, {180, -30}, {180, 0}, {120, 0}}, {15, 15, 15, 15}));
  CHECK(distance(x, both) < 0.02);
  // Intersect r999: the 60 × 170 overlap becomes a pill (radius 30, half its width).
  geom::Path i = Doc(BooleanOperation::INTERSECT, 999).result();
  CHECK(distance(i, orthogonal({{120, 0}, {180, 0}, {180, 170}, {120, 170}}, {30, 30, 30, 30})) < 0.02);
}

TEST_CASE("r19a: smoothing is Figma's squircle, the same as a rectangle's") {
  // A lone rectangle in a boolean: its result rounded and smoothed matches the rectangle drawn rounded and smoothed.
  geom::Path square = geom::rectPath({100, 100}, {0, 0, 0, 0});
  for (double s : {0.0, 0.6, 1.0}) {
    geom::Path ours = geom::roundCorners(square, 20, s);
    geom::Path rect = geom::rectPath({100, 100}, {20, 20, 20, 20}, s);
    CHECK(distance(ours, rect) < 0.01);
  }
  // On the Subtract: the notch (60 wide) has no room for 60 % smoothing at radius 30 — it gives smoothing up there, the
  // outer corners keep it.
  Doc d(BooleanOperation::SUBTRACT, 20, 0.6);
  geom::Path r = d.result();
  CHECK(distance(r, svg(kSubtract20)) > 0.15);  // smoothed: not the plain arcs
  CHECK(geom::contains(geom::flatten(r, 0.01), {150, 100}, false) == false);  // the notch stays cut
  // A smoothed corner reaches further along its edges: (1 + 0.6) · 20 = 32 from the corner, the plain one 20.
  auto polys = geom::flatten(r, 0.01);
  CHECK(geom::distanceTo(polys, {300, 240 - 31}) < 0.05);  // still on the right edge, 31 above the corner
  CHECK(geom::distanceTo(polys, {300, 240 - 33}) < 0.01);
}

TEST_CASE("r19a: children keep their own radii; a nested boolean is rounded once, by the outermost") {
  // A radius 40 inside a boolean of radius 0: A's corners stay 40, the cut's corners sharp.
  Doc d(BooleanOperation::SUBTRACT, 0, 0, 40);
  auto polys = geom::flatten(d.result(), 0.01);
  CHECK(!geom::contains(polys, {3, 3}, false));       // A's rounded corner
  CHECK(geom::contains(polys, {119.5, 0.5}, false));  // the cut's corner: sharp
  // Nested: an outer Union holding the Subtract (radius 0) as its only operand, radius 20 on the outer one.
  auto nodes = baseChanges();
  NodeChange outer = make({1, 20}, NodeType::BOOLEAN_OPERATION, kPage, "!", {200, 100, 300, 270}, "Outer");
  outer.props.shape().booleanOperation = BooleanOperation::UNION;
  outer.props.cornerRadii = {20, 20, 20, 20};
  nodes.push_back(outer);
  NodeChange inner = make(kBool, NodeType::BOOLEAN_OPERATION, {1, 20}, "!", {0, 0, 300, 270}, "Inner");
  inner.props.shape().booleanOperation = BooleanOperation::SUBTRACT;
  nodes.push_back(inner);
  nodes.push_back(make(kA, NodeType::ROUNDED_RECTANGLE, kBool, "!", {0, 30, 300, 240}, "A"));
  nodes.push_back(make(kB, NodeType::ROUNDED_RECTANGLE, kBool, "\"", {120, 0, 60, 200}, "B"));
  Editor e;
  e.loadDocument(nodes, kNoGuid);
  const NodeGeometry* g = e.document().geometry({1, 20});
  REQUIRE(g);
  CHECK(distance(g->fills[0].path.transformed(kToA), svg(kSubtract20)) < 0.02);
}

TEST_CASE("r19a: Flatten bakes the rounded result into a vector (radius 0 on it)") {
  Doc d(BooleanOperation::SUBTRACT, 999);
  Editor& e = d.e;
  e.setSelection({kBool});
  REQUIRE(e.command(CommandId::FLATTEN) == OK);
  const NodeProps& v = e.document().get(kBool)->props;
  CHECK(v.type == NodeType::VECTOR);
  CHECK(v.cornerRadii[0] == 0);
  CHECK(e.document().children(kBool).empty());
  const NodeGeometry* g = e.document().geometry(kBool);
  REQUIRE(g);
  geom::Path world;
  for (auto& f : g->fills) world.append(f.path.transformed(e.document().worldTransform(kBool)));
  // A's origin is at (200, 130) on the page.
  CHECK(distance(world.transformed(Mat2x3::translate(-200, -130)), svg(kSubtract999)) < 0.05);
  CHECK(v.size.x == doctest::Approx(300).epsilon(1e-6));
  CHECK(v.size.y == doctest::Approx(240).epsilon(1e-6));
  // Undo brings the live boolean (and its radius) back.
  e.command(CommandId::UNDO);
  CHECK(e.document().get(kBool)->props.type == NodeType::BOOLEAN_OPERATION);
  CHECK(e.document().get(kBool)->props.cornerRadii[0] == 999);
}

TEST_CASE("r19a: hit-testing and bounds follow the rounded outline") {
  Doc d(BooleanOperation::UNION, 20);
  Editor& e = d.e;
  auto click = [&](double x, double y) {
    e.setSelection({});
    e.pointer(PointerEvent::DOWN, x, y, 0, 1, 0, 1);
    e.pointer(PointerEvent::UP, x, y, 0, 0, 0);
    return e.selection();
  };
  // A's origin is at (200, 130) on the page (zoom 1, the page at the origin).
  CHECK(click(200 + 150, 130 + 100) == std::vector<Guid>{kBool});
  CHECK(click(200 + 2, 130 + 2).empty());                            // A's corner, rounded off
  CHECK(click(200 + 118, 130 - 2) == std::vector<Guid>{kBool});      // the concave join's fill, outside both operands
  CHECK(click(200 + 121, 130 - 29).empty());                          // B's top corner, rounded off
  // Bounds: Intersect r999's pill is still its 60 × 170 box.
  Doc pill(BooleanOperation::INTERSECT, 999);
  const NodeGeometry* g = pill.e.document().geometry(kBool);
  REQUIRE(g);
  CHECK(g->bounds.w == doctest::Approx(60).epsilon(1e-4));
  CHECK(g->bounds.h == doctest::Approx(170).epsilon(1e-4));
}

TEST_CASE("r19a: the SVG export writes the rounded outline (and the .fig keeps cornerRadius on the boolean)") {
  Doc d(BooleanOperation::SUBTRACT, 20);
  exporter::Settings s;
  s.format = exporter::Format::SVG;
  exporter::Target t;
  REQUIRE(exporter::resolveTarget(d.e.document(), &d.e, kNoGuid, kBool, s, t));
  std::string out = exporter::writeSvg(d.e.document(), &d.e, t, s);
  size_t at = out.find(" d=\"");
  REQUIRE(at != std::string::npos);
  size_t end = out.find('"', at + 4);
  geom::Path p = svg(out.substr(at + 4, end - at - 4).c_str());
  // Both moved to their own top-left: Figma's file is its render bounds, ours too.
  Rect a = p.bounds(), b = svg(kSubtract20).bounds();
  CHECK(distance(p.transformed(Mat2x3::translate(-a.x, -a.y)), svg(kSubtract20).transformed(Mat2x3::translate(-b.x, -b.y))) < 0.05);
  CHECK(a.w == doctest::Approx(300).epsilon(1e-3));
  CHECK(a.h == doctest::Approx(240).epsilon(1e-3));
  // The radius is the boolean's own field: written, read back.
  NodeChange c = NodeChange::created(kBool, d.e.document().get(kBool)->props);
  codec::KiwiMessage back;
  REQUIRE(codec::readMessage(codec::writeMessage(1, {c}), back));
  REQUIRE(back.changes.size() == 1);
  CHECK(back.changes[0].props.type == NodeType::BOOLEAN_OPERATION);
  CHECK(back.changes[0].props.cornerRadii[0] == 20);
}

TEST_CASE("r19a: removing redundant points merges collinear lines and drops empty segments") {
  geom::Path p;
  p.moveTo({0, 0});
  p.lineTo({50, 0});
  p.lineTo({50, 0});
  p.lineTo({100, 0});
  p.lineTo({100, 100});
  p.lineTo({0, 100});
  p.lineTo({0, 50});
  p.close();
  geom::Path q = geom::removeRedundantPoints(p);
  CHECK(test::countVerb(q, geom::Verb::Line) == 3);  // the fourth side is the one Close draws
  CHECK(distance(p, q) < 1e-9);
}
