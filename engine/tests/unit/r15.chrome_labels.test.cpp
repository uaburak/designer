// Round 15 — a turned frame's canvas labels as live Figma draws them (docs/engine.md §6.11, the owner's 42.png in
// docs/research/chrome-cursors/): the frame's name along its top edge from its top-left corner and the W × H badge
// centred under its bottom edge, both turned with it and never upside down; a press on the turned name selects and
// moves the frame; no `</>` over a turned frame.
#include <algorithm>
#include <cmath>

#include "doctest.h"
#include "Helpers.h"
#include "TextHelpers.h"
#include "editor/Editor.h"
#include "gfx/null/NullDevice.h"
#include "render/FrameTitles.h"
#include "render/Renderer.h"
#include "text/Fonts.h"

using namespace eng;
using namespace eng::test;

namespace {

const double kPi = 3.14159265358979323846;
double rad(double deg) { return deg * kPi / 180; }

const Guid F{1, 1};

struct Fonts {
  Fonts() {
    auto& fonts = text::FontRegistry::get();
    int32_t upright = addFontFile(std::string(ENG_FONTS_DIR) + "/InterVariable.ttf");
    for (const char* style : {"Regular", "Medium", "Semi Bold", "Bold"}) fonts.bind("Inter", style, upright);
    fonts.takeRequests();
  }
  ~Fonts() { text::FontRegistry::get().reset(); }
};

// "Frame 406", 332 × 423, its top-left corner at (200, 100), turned by `deg` on screen (clockwise, y down: the owner's
// 42.png is 37°, Figma's rotation −37°); the page origin at (100, 100) on screen, zoom 1.
struct Scene {
  Fonts fonts;
  Editor e;
  gfx::NullDevice device;
  Renderer r{device};
  Mat2x3 world;
  explicit Scene(double deg) {
    auto nodes = baseChanges();
    NodeChange f = make(F, NodeType::FRAME, kPage, "!", {0, 0, 332, 423}, "Frame 406");
    world = Mat2x3::translate(200, 100) * Mat2x3::rotate(rad(deg));
    f.props.transform = world;
    nodes.push_back(f);
    e.setSessionID(1);
    e.setViewport(1400, 900, 1, 1400, 900);
    e.loadDocument(nodes, kNoGuid);
    e.setCamera({100, 100, 1});
    e.takeEvents();
    r.setTextLayouts(&e);
  }
  Mat2x3 toScreen() const { return Mat2x3::translate(100, 100) * world; }
  FrameTitle title() const {
    for (const FrameTitle& t : e.titles())
      if (t.id == F) return t;
    FAIL("no title");
    return {};
  }
  std::vector<DrawInstance> draw() {
    device.draws.clear();
    r.render(e.document(), e.page(), e.camera(), e.viewport(), e.overlay(), OverlayStyle::of(Theme::Dark));
    std::vector<DrawInstance> all;
    for (size_t i = 0; i < device.draws.size(); i++)
      for (const DrawInstance& q : device.instancesOf<DrawInstance>(i)) all.push_back(q);
    return all;
  }
  void press(Vec2 s, int clicks = 1) {
    e.pointer(PointerEvent::MOVE, s.x, s.y, 0, 0, 0);
    e.pointer(PointerEvent::DOWN, s.x, s.y, 0, 1, 0, clicks);
  }
  void release(Vec2 s) { e.pointer(PointerEvent::UP, s.x, s.y, 0, 0, 0); }
};

bool near(Vec2 a, Vec2 b, double eps = 1e-6) { return std::fabs(a.x - b.x) < eps && std::fabs(a.y - b.y) < eps; }

}  // namespace

TEST_CASE("r15 labelFrame: upright layers keep their AABB; a turned one reads along its x axis, never upside down") {
  const Vec2 size{332, 423};
  // Upright (and scaled): the identity, the AABB.
  LabelFrame up = labelFrame(Mat2x3{2, 0, 10, 0, 2, 20}, size);
  CHECK(up.upright);
  CHECK(up.place == Mat2x3{});
  CHECK(up.box == Rect{10, 20, 664, 846});
  // Turned 37° clockwise on screen: the labels read along the top edge, the box is the layer's own.
  Mat2x3 m = Mat2x3::translate(300, 200) * Mat2x3::rotate(rad(37));
  LabelFrame f = labelFrame(m, size);
  CHECK_FALSE(f.upright);
  CHECK(f.place.m00 == doctest::Approx(std::cos(rad(37))));
  CHECK(f.place.m10 == doctest::Approx(std::sin(rad(37))));
  CHECK(f.box.w == doctest::Approx(332));
  CHECK(f.box.h == doctest::Approx(423));
  CHECK(near(f.place.apply({f.box.x, f.box.y}), m.apply({0, 0})));                       // the top-left corner
  CHECK(near(f.place.apply({f.box.x + f.box.w / 2, f.box.bottom()}), m.apply({166, 423})));  // the bottom edge's middle
  // Up to ±90°: along the top edge; Figma's 90° (a quarter turn anticlockwise) reads bottom to top on the left.
  LabelFrame q = labelFrame(Mat2x3::translate(300, 500) * Mat2x3::rotate(rad(-90)), size);
  CHECK_FALSE(q.upright);
  CHECK(near(q.place.applyLinear({1, 0}), {0, -1}));
  CHECK(near(q.place.apply({q.box.x, q.box.y}), {300, 500}));  // the name starts at the layer's top-left corner
  // Figma's −90°: the x axis points down, so the labels read the other way — bottom to top, over the layer's bottom
  // edge, which is on the left on screen.
  Mat2x3 down = Mat2x3::translate(300, 100) * Mat2x3::rotate(rad(90));
  LabelFrame d = labelFrame(down, size);
  CHECK(near(d.place.applyLinear({1, 0}), {0, -1}));
  CHECK(near(d.place.apply({d.box.x, d.box.y}), down.apply({332, 423})));  // the bottom-right corner, bottom left on screen
  CHECK(d.box.w == doctest::Approx(332));
  // 135°: upside down along the top edge, so along the bottom edge read left to right.
  Mat2x3 m135 = Mat2x3::translate(500, 500) * Mat2x3::rotate(rad(135));
  LabelFrame h = labelFrame(m135, size);
  CHECK(h.place.applyLinear({1, 0}).x > 0);
  CHECK(h.place.m10 == doctest::Approx(std::sin(rad(-45))));
  CHECK(near(h.place.apply({h.box.x, h.box.y}), m135.apply({332, 423})));
  // Half a turn: upright again, the name over what is the layer's bottom edge.
  LabelFrame half = labelFrame(Mat2x3::translate(500, 500) * Mat2x3::rotate(rad(180)), size);
  CHECK(half.upright);
  CHECK(half.box.x == doctest::Approx(168));
  CHECK(half.box.y == doctest::Approx(77));
  // Flipped horizontally: upright, the AABB.
  CHECK(labelFrame(Mat2x3{-1, 0, 400, 0, 1, 0}, size).upright);
  // Flipped and turned: the labels still read left to right.
  LabelFrame fl = labelFrame(Mat2x3::rotate(rad(30)) * Mat2x3{-1, 0, 0, 0, 1, 0}, size);
  CHECK(fl.place.applyLinear({1, 0}).x > 0);
  CHECK(fl.box.w == doctest::Approx(332));
}

TEST_CASE("r15 a turned frame's name lies along its top edge; a press on it selects and moves the frame") {
  Scene s(37);
  FrameTitle t = s.title();
  CHECK_FALSE(t.upright);
  const OverlayStyle style = OverlayStyle::of(Theme::Dark);
  // The name's baseline starts over the top-left corner, titleBaselineGap above the top edge (perpendicular to it).
  Vec2 corner = s.toScreen().apply({0, 0});
  Vec2 upward{std::sin(rad(37)), -std::cos(rad(37))};
  CHECK(near(t.place.apply({t.text.x, t.baseline}), corner + upward * style.titleBaselineGap, 1e-6));
  CHECK(t.frame.w == doctest::Approx(332));
  // A press on the turned name selects the frame…
  Vec2 on = t.place.apply({t.text.x + 20, t.baseline - 4});
  s.press(on);
  s.release(on);
  CHECK(s.e.selection() == std::vector<Guid>{F});
  // …where an upright title would be (over the AABB's top left) is empty canvas.
  s.e.setSelection({});
  Rect aabb = transformedBounds(s.toScreen(), 332, 423);
  s.press({aabb.x + 20, aabb.y - 6});
  s.release({aabb.x + 20, aabb.y - 6});
  CHECK(s.e.selection().empty());
  // A drag from the name moves the frame.
  s.press(on);
  for (int i = 1; i <= 4; i++) s.e.pointer(PointerEvent::MOVE, on.x + 10 * i, on.y + 5 * i, 0, 1, 0);
  s.release({on.x + 40, on.y + 20});
  CHECK(s.e.selection() == std::vector<Guid>{F});
  // (by the drag, give or take the pixel grid's snap of its bounds)
  CHECK(std::fabs(s.e.document().get(F)->props.transform.m02 - 240) < 1);
  CHECK(std::fabs(s.e.document().get(F)->props.transform.m12 - 120) < 1);
  // A double-click asks to rename it over the name (its bounds on screen).
  s.e.takeEvents();
  t = s.title();
  Vec2 at = t.place.apply({t.text.x + 20, t.baseline - 4});
  s.press(at);
  s.release(at);
  s.press(at, 2);
  s.release(at);
  auto ev = s.e.takeEvents();
  REQUIRE(ev.renames.size() == 1);
  CHECK(ev.renames[0].rect.contains(at));
}

TEST_CASE("r15 a turned selection's W × H badge is centred under its bottom edge, turned with it") {
  Scene s(37);
  s.e.setSelection({F});
  const OverlayStyle style = OverlayStyle::of(Theme::Dark);
  auto all = s.draw();
  const DrawInstance* badge = nullptr;
  for (const DrawInstance& q : all) {
    uint32_t fl = static_cast<uint32_t>(q.geom[3]);
    bool fill = (fl & (DF_STROKE | DF_FILL_AND_STROKE)) == 0;
    if (fill && q.geom[2] == static_cast<float>(ShapeKind::Rect) && std::fabs(q.box[0] - style.badgeRadius) < 1e-3 &&
        std::fabs(q.color[2] - style.selection.b) < 0.01 && std::fabs(q.linear[1]) > 0.1)
      badge = &q;
  }
  REQUIRE(badge);
  CHECK(badge->linear[0] == doctest::Approx(std::cos(rad(37))).epsilon(1e-4));
  CHECK(badge->linear[1] == doctest::Approx(std::sin(rad(37))).epsilon(1e-4));
  CHECK(badge->origin[3] == doctest::Approx(style.badgeHeight));
  // Its centre: the bottom edge's middle, badgeGap + half its height below the edge.
  Mat2x3 m{badge->linear[0], badge->linear[2], badge->origin[0], badge->linear[1], badge->linear[3], badge->origin[1]};
  Vec2 centre = m.apply({badge->origin[2] / 2, badge->origin[3] / 2});
  Vec2 mid = s.toScreen().apply({166, 423});
  Vec2 downward{-std::sin(rad(37)), std::cos(rad(37))};
  Vec2 want = mid + downward * (style.badgeGap + style.badgeHeight / 2);
  CHECK(centre.x == doctest::Approx(want.x).epsilon(1e-3));
  CHECK(centre.y == doctest::Approx(want.y).epsilon(1e-3));
}

TEST_CASE("r15 an upright frame's labels are where they were; a turned one's name has no </>") {
  Scene up(0);
  FrameTitle t = up.title();
  CHECK(t.upright);
  CHECK(t.hit.x == doctest::Approx(300));  // screen px, as before
  // Dev Mode's `</>` over a selected frame: upright only (live Figma, 42.png: none over a turned frame).
  up.e.setSelection({F});
  up.draw();
  bool mark = false;
  for (const auto& m : up.r.canvasHits().statuses) mark |= m.kind == DevStatusMark::Kind::MarkButton;
  CHECK(mark);
  Scene turned(37);
  turned.e.setSelection({F});
  turned.draw();
  for (const auto& m : turned.r.canvasHits().statuses) CHECK(m.kind != DevStatusMark::Kind::MarkButton);
}
