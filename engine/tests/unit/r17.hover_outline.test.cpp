// Round 17 — a hovered layer's outline (the owner's 79.png live Figma, 80.png ours): frames, components, instances and
// sections are outlined along their whole box, square whatever their corner radius or inverted corners; shapes along
// their own outline — rectangles' (per-corner, clamped) radii, smoothed and inverted corners as their path, ellipses,
// turned layers turned. The hit rule stays: a frame's or rectangle's cut-away corner hovers it (d880ea2).
#include <algorithm>
#include <cmath>

#include "doctest.h"
#include "Helpers.h"
#include "editor/Editor.h"
#include "gfx/null/NullDevice.h"
#include "render/Renderer.h"

using namespace eng;
using namespace eng::test;

namespace {

// F a frame (radius 40), R a rectangle (radii 40 / 10 / 0 / 80 — clamped), S a rectangle smoothed 100 %, E an ellipse,
// T a rectangle (radius 30) turned 30°, IF a frame with an inverted corner, IR a rectangle with one.
const Guid F{1, 1}, R{1, 2}, S{1, 3}, E{1, 4}, T{1, 5}, IF{1, 6}, IR{1, 7};
const double kCos = std::cos(3.14159265358979 / 6), kSin = std::sin(3.14159265358979 / 6);

std::vector<NodeChange> nodes() {
  auto out = baseChanges();
  NodeChange f = make(F, NodeType::FRAME, kPage, "!", {0, 0, 200, 200}, "Frame");
  f.props.cornerRadii = {40, 40, 40, 40};
  out.push_back(f);
  NodeChange r = make(R, NodeType::ROUNDED_RECTANGLE, kPage, "\"", {300, 0, 200, 100}, "Rect");
  r.props.cornerRadii = {40, 10, 0, 80};
  out.push_back(r);
  NodeChange s = make(S, NodeType::ROUNDED_RECTANGLE, kPage, "#", {0, 300, 200, 200}, "Smooth");
  s.props.cornerRadii = {60, 60, 60, 60};
  s.props.stroke().cornerSmoothing = 1;
  out.push_back(s);
  out.push_back(make(E, NodeType::ELLIPSE, kPage, "$", {300, 300, 200, 120}, "Ellipse"));
  NodeChange t = make(T, NodeType::ROUNDED_RECTANGLE, kPage, "%", {700, 0, 100, 100}, "Turned");
  t.props.cornerRadii = {30, 30, 30, 30};
  t.props.transform = Mat2x3{kCos, -kSin, 700, kSin, kCos, 0};
  out.push_back(t);
  NodeChange inf = make(IF, NodeType::FRAME, kPage, "&", {600, 300, 200, 200}, "Inverted frame");
  inf.props.cornerRadii = {40, 40, 40, 40};
  inf.props.stroke().invertedCornerMask = 1;
  out.push_back(inf);
  NodeChange ir = make(IR, NodeType::ROUNDED_RECTANGLE, kPage, "'", {900, 300, 200, 200}, "Inverted rect");
  ir.props.cornerRadii = {40, 40, 40, 40};
  ir.props.stroke().invertedCornerMask = 1;
  out.push_back(ir);
  return out;
}

// The page origin at (100, 100) on screen, zoom 1.
struct Scene {
  Editor e;
  gfx::NullDevice device;
  Renderer r{device};
  OverlayStyle style;
  Scene() {
    e.setSessionID(1);
    e.setViewport(1400, 900, 1, 1400, 900);
    e.loadDocument(nodes(), kNoGuid);
    e.setCamera({100, 100, 1});
    e.takeEvents();
  }
  void move(Vec2 w) { e.pointer(PointerEvent::MOVE, w.x + 100, w.y + 100, 0, 0, 0); }
  std::vector<DrawInstance> draw() {
    device.draws.clear();
    r.render(e.document(), e.page(), e.camera(), e.viewport(), e.overlay(), style);
    std::vector<DrawInstance> all;
    for (size_t i = 0; i < device.draws.size(); i++)
      for (const DrawInstance& q : device.instancesOf<DrawInstance>(i)) all.push_back(q);
    return all;
  }
};

bool inColor(const DrawInstance& q, const Color& c) {
  return std::fabs(q.color[0] - c.r) < 0.01 && std::fabs(q.color[1] - c.g) < 0.01 && std::fabs(q.color[2] - c.b) < 0.01;
}
// The hover outline: a stroked shape `w` × `h` in the selection colour, hoverWidth inside.
std::vector<DrawInstance> outlines(const std::vector<DrawInstance>& all, const OverlayStyle& st, double w, double h) {
  std::vector<DrawInstance> out;
  for (const DrawInstance& q : all)
    if (inColor(q, st.selection) && std::fabs(q.origin[2] - w) < 0.6 && std::fabs(q.origin[3] - h) < 0.6 &&
        std::fabs(q.geom[0] - st.hoverWidth) < 1e-6)
      out.push_back(q);
  return out;
}
// The short hoverWidth-wide segments a path outline is drawn with.
size_t segments(const std::vector<DrawInstance>& all, const OverlayStyle& st) {
  return static_cast<size_t>(std::count_if(all.begin(), all.end(), [&](const DrawInstance& q) {
    return inColor(q, st.selection) && std::fabs(q.origin[3] - st.hoverWidth) < 1e-6 && q.origin[2] < 40 && q.geom[0] == 0;
  }));
}

}  // namespace

TEST_CASE("r17 hover outline: a frame's box square whatever its radius; its cut-away corner still hovers it") {
  Scene s;
  for (Vec2 at : {Vec2{100, 100}, Vec2{3, 3}}) {
    s.move(at);
    REQUIRE(s.e.hover() == F);
    auto o = outlines(s.draw(), s.style, 200, 200);
    REQUIRE(o.size() == 1);
    CHECK(o[0].geom[2] == static_cast<float>(ShapeKind::Rect));
    for (int k = 0; k < 4; k++) CHECK(o[0].box[k] == 0);
  }
  // Selected and hovered: the hover outline square too.
  s.e.setSelection({F});
  s.move({100, 100});
  auto o = outlines(s.draw(), s.style, 200, 200);
  REQUIRE(o.size() == 1);
  for (int k = 0; k < 4; k++) CHECK(o[0].box[k] == 0);
  // A frame with an inverted corner: its box, no path.
  s.e.setSelection({});
  s.move({700, 400});
  REQUIRE(s.e.hover() == IF);
  auto all = s.draw();
  CHECK(outlines(all, s.style, 200, 200).size() == 1);
  CHECK(segments(all, s.style) == 0);
}

TEST_CASE("r17 hover outline: a rectangle's own radii, per corner and clamped; its cut-away corner hovers it") {
  Scene s;
  s.move({302, 2});
  REQUIRE(s.e.hover() == R);
  auto o = outlines(s.draw(), s.style, 200, 100);
  REQUIRE(o.size() == 1);
  // 40 / 10 / 0 / 80: the left side's 40 + 80 > 100 scales every corner by 100 / 120 (as the fill).
  const double f = 100.0 / 120.0;
  CHECK(o[0].box[0] == doctest::Approx(40 * f).epsilon(1e-4));
  CHECK(o[0].box[1] == doctest::Approx(10 * f).epsilon(1e-4));
  CHECK(o[0].box[2] == doctest::Approx(0));
  CHECK(o[0].box[3] == doctest::Approx(80 * f).epsilon(1e-4));
}

TEST_CASE("r17 hover outline: smoothed and inverted corners along their path, an ellipse its curve, a turned rectangle turned") {
  Scene s;
  s.move({100, 400});
  REQUIRE(s.e.hover() == S);
  auto all = s.draw();
  CHECK(outlines(all, s.style, 200, 200).empty());
  CHECK(segments(all, s.style) > 16);

  s.move({1000, 400});
  REQUIRE(s.e.hover() == IR);
  all = s.draw();
  CHECK(outlines(all, s.style, 200, 200).empty());
  CHECK(segments(all, s.style) > 8);

  s.move({400, 360});
  REQUIRE(s.e.hover() == E);
  auto o = outlines(s.draw(), s.style, 200, 120);
  REQUIRE(o.size() == 1);
  CHECK(o[0].geom[2] == static_cast<float>(ShapeKind::Ellipse));

  // The turned rectangle's middle: its outline turned 30°, radius 30.
  s.move({700 + 50 * kCos - 50 * kSin, 50 * kSin + 50 * kCos});
  REQUIRE(s.e.hover() == T);
  o = outlines(s.draw(), s.style, 100, 100);
  REQUIRE(o.size() == 1);
  for (int k = 0; k < 4; k++) CHECK(o[0].box[k] == doctest::Approx(30));
  CHECK(std::fabs(o[0].linear[1]) + std::fabs(o[0].linear[2]) > 0.5);  // not axis-aligned
}
