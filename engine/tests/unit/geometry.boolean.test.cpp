// Path booleans: Clipper2 on flattened curves, the curves recovered (docs/engine.md §5).
#include <cmath>

#include "GeometryHelpers.h"
#include "doctest.h"
#include "geometry/Boolean.h"
#include "geometry/Shapes.h"

using namespace eng;
using namespace eng::geom;

namespace {
constexpr double kPi = 3.14159265358979323846;

Path square(double x, double y, double s) {
  return rectPath({s, s}, {0, 0, 0, 0}).transformed(Mat2x3::translate(x, y));
}
Path circle(double cx, double cy, double r) {
  return ellipsePath({2 * r, 2 * r}, {}).transformed(Mat2x3::translate(cx - r, cy - r));
}
}  // namespace

TEST_CASE("booleans of two squares: union, subtract, intersect, exclude") {
  std::vector<Operand> ops{{square(0, 0, 100), WindingRule::NONZERO}, {square(50, 50, 100), WindingRule::NONZERO}};
  auto area = [&](BooleanOperation op) { return test::sampledArea(booleanOp(ops, op, 0.01), false, 0.5); };
  CHECK(std::fabs(area(BooleanOperation::UNION) - 17500) < 30);
  CHECK(std::fabs(area(BooleanOperation::SUBTRACT) - 7500) < 30);
  CHECK(std::fabs(area(BooleanOperation::INTERSECT) - 2500) < 30);
  CHECK(std::fabs(area(BooleanOperation::XOR) - 15000) < 30);
  // Exact corners: the union is one 8-corner outline of lines only.
  Path u = booleanOp(ops, BooleanOperation::UNION, 0.01);
  CHECK(test::countVerb(u, Verb::Move) == 1);
  CHECK(test::countVerb(u, Verb::Cubic) == 0);
}

TEST_CASE("booleans keep curves: two circles") {
  std::vector<Operand> ops{{circle(50, 50, 50), WindingRule::NONZERO}, {circle(110, 50, 50), WindingRule::NONZERO}};
  Path u = booleanOp(ops, BooleanOperation::UNION, 0.01);
  // The result is arcs of the original cubics, not a polyline.
  CHECK(test::countVerb(u, Verb::Cubic) >= 6);
  CHECK(test::countVerb(u, Verb::Cubic) <= 12);
  CHECK(test::countVerb(u, Verb::Line) <= 2);
  // Two unit-area lenses: union = 2·πr² − lens.
  double d = 60, r = 50;
  double lens = 2 * r * r * std::acos(d / (2 * r)) - (d / 2) * std::sqrt(4 * r * r - d * d);
  CHECK(std::fabs(test::sampledArea(u, false, 0.25) - (2 * kPi * r * r - lens)) < 25);
  Path i = booleanOp(ops, BooleanOperation::INTERSECT, 0.01);
  CHECK(std::fabs(test::sampledArea(i, false, 0.25) - lens) < 15);
  // The recovered outline matches the true shape closely.
  Path both = circle(50, 50, 50);
  both.append(circle(110, 50, 50));
  CHECK(test::mismatch(u, false, both, false, 0.2) < 0.002);
}

TEST_CASE("booleans: winding rules, holes, subtract with several cutters, simplify") {
  // An even-odd ring (two contours, same direction) is a ring; under NONZERO it is a disc.
  Path ring = circle(50, 50, 50);
  ring.append(circle(50, 50, 25));
  double ringArea = kPi * (2500 - 625);
  CHECK(std::fabs(test::sampledArea(simplify(ring, WindingRule::ODD, 0.01), false, 0.25) - ringArea) < 20);
  CHECK(std::fabs(test::sampledArea(simplify(ring, WindingRule::NONZERO, 0.01), false, 0.25) - kPi * 2500) < 20);
  // Subtract two squares from a big one.
  std::vector<Operand> ops{{square(0, 0, 100), WindingRule::NONZERO}, {square(10, 10, 20), WindingRule::NONZERO},
                           {square(60, 60, 20), WindingRule::NONZERO}};
  Path sub = booleanOp(ops, BooleanOperation::SUBTRACT, 0.01);
  CHECK(std::fabs(test::sampledArea(sub, false, 0.5) - (10000 - 800)) < 30);
  // Disjoint union keeps both pieces.
  std::vector<Operand> apart{{square(0, 0, 10), WindingRule::NONZERO}, {square(100, 0, 10), WindingRule::NONZERO}};
  CHECK(test::countVerb(booleanOp(apart, BooleanOperation::UNION, 0.01), Verb::Move) == 2);
  // Nothing in common: an empty intersection.
  CHECK(booleanOp(apart, BooleanOperation::INTERSECT, 0.01).empty());
}
