// Wecra's agents (docs/research/motion-for-agents.md §3b, phase 1): the fields the motion layer evaluates but Figma's public
// list leaves out — skew (MOTION_SHEAR), an ellipse's arc (ARC_DATA_*), a star's inner radius and a polygon's point count —
// are written by MOTION_ADD_KEYFRAME under their schema names and played at the playhead; an unknown name stays refused.
#include <cmath>
#include <string>

#include "Helpers.h"
#include "doctest.h"
#include "editor/Editor.h"
#include "motion/Evaluate.h"

using namespace eng;
using namespace eng::test;

namespace {

const Guid kRoot{1, 1}, kRect{1, 2}, kRing{1, 3}, kStar{1, 4};
constexpr double kPi = 3.14159265358979323846;

void load(Editor& e) {
  std::vector<NodeChange> nodes = baseChanges();
  nodes.push_back(make(kRoot, NodeType::FRAME, kPage, "!", {0, 0, 400, 300}, "Root"));
  nodes.push_back(make(kRect, NodeType::ROUNDED_RECTANGLE, kRoot, "!", {20, 30, 100, 50}, "Rect"));
  nodes.push_back(make(kRing, NodeType::ELLIPSE, kRoot, "\"", {200, 30, 80, 80}, "Ring"));
  nodes.push_back(make(kStar, NodeType::STAR, kRoot, "#", {300, 30, 80, 80}, "Star"));
  e.setSessionID(1);
  e.setViewport(800, 600, 1, 800, 600);
  e.loadDocument(nodes, kPage);
  e.takeEvents();
}

CommandArgs args(const std::string& json) {
  CommandArgs a;
  REQUIRE(json::parse(json, a.raw));
  return a;
}

motion::State on(int64_t timeUs) {
  motion::State s;
  s.on = true;
  s.root = kRoot;
  s.timeUs = timeUs;
  return s;
}

Status key(Editor& e, Guid node, const char* field, int64_t at, double value) {
  return e.command(CommandId::MOTION_ADD_KEYFRAME, args(R"({"nodes":[")" + node.toString() + R"("],"field":{"type":"PROPERTY","name":")" + field +
                                                        R"("},"timeUs":)" + std::to_string(at) + R"(,"value":{"type":"FLOAT","value":)" +
                                                        std::to_string(value) + "}}"));
}

}  // namespace

TEST_CASE("motion agent fields: skew, arc, star and polygon keyframed by their schema names and played") {
  Editor e;
  load(e);
  const Document& doc = e.document();
  e.setMotion(on(0));
  // Skew: the shear factor (tan of skewX), about the anchor (the centre).
  REQUIRE(key(e, kRect, "MOTION_SHEAR", 0, 0) == OK);
  REQUIRE(key(e, kRect, "MOTION_SHEAR", 1000000, 0.5) == OK);
  // A progress ring: the arc's end angle 0 → 2π (radians, stored as is), its hole 0.8.
  REQUIRE(key(e, kRing, "ARC_DATA_ENDING_ANGLE", 0, 0) == OK);
  REQUIRE(key(e, kRing, "ARC_DATA_ENDING_ANGLE", 1000000, 2 * kPi) == OK);
  REQUIRE(key(e, kRing, "ARC_DATA_INNER_RADIUS", 0, 0.8) == OK);
  REQUIRE(key(e, kStar, "STAR_INNER_SCALE", 0, 0.2) == OK);
  REQUIRE(key(e, kStar, "STAR_INNER_SCALE", 1000000, 0.6) == OK);
  REQUIRE(key(e, kStar, "POLYGON_COUNT", 0, 4) == OK);
  REQUIRE(key(e, kStar, "POLYGON_COUNT", 1000000, 8) == OK);
  // Unknown and never-evaluated names stay refused.
  CHECK(key(e, kRect, "SHEAR", 0, 1) == E_INVALID);
  CHECK(key(e, kRect, "TRANSFORM_3D_ROTATION_X", 0, 1) == E_INVALID);

  // The default keyframe easing (0.5, 0, 0.5, 1) is symmetric: half way at the middle.
  e.setMotion(on(500000));
  CHECK(doc.get(kRect)->props.transform.m01 == doctest::Approx(0.25));
  CHECK(doc.get(kRing)->props.shape().arcData.endingAngle == doctest::Approx(kPi));
  CHECK(doc.get(kRing)->props.shape().arcData.innerRadius == doctest::Approx(0.8));
  CHECK(doc.get(kStar)->props.shape().starInnerScale == doctest::Approx(0.4));
  CHECK(doc.get(kStar)->props.shape().count == 6);

  e.setMotion(on(1000000));
  const Mat2x3& m = doc.get(kRect)->props.transform;
  CHECK(m.m00 == doctest::Approx(1));
  CHECK(m.m01 == doctest::Approx(0.5));
  // x' = x + k·y about the centre (50, 25): the left edge moves by −k·25.
  CHECK(m.m02 == doctest::Approx(20 - 0.5 * 25));
  CHECK(doc.get(kRing)->props.shape().arcData.endingAngle == doctest::Approx(2 * kPi));
  CHECK(doc.get(kStar)->props.shape().count == 8);

  // Motion off: the base values come back.
  e.setMotion(motion::State{});
  CHECK(doc.get(kRect)->props.transform.m01 == 0);
  CHECK(doc.get(kStar)->props.shape().count != 8);
}
