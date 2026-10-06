#include <vector>

#include "doctest.h"
#include "base/FractionalIndex.h"
#include "gfx/null/NullDevice.h"
#include "Helpers.h"
#include "render/Renderer.h"

using namespace eng;
using namespace eng::test;

namespace {

size_t shapeCount(const gfx::NullDevice& dev) {
  size_t n = 0;
  for (auto& d : dev.draws) n += d.call.instanceCount;
  return n;
}

const OverlayStyle kDark = OverlayStyle::of(Theme::Dark);

}  // namespace

TEST_CASE("renderer: 10k rects are one draw call") {
  Document d;
  base(d);
  std::string key;
  for (uint32_t i = 1; i <= 10000; i++) {
    key = fractional::keyBetween(key, std::nullopt, fractional::Bias::Low);
    d.apply(make({1, i}, NodeType::ROUNDED_RECTANGLE, kPage, key, {(i % 100) * 7.0, (i / 100) * 5.0, 5, 4}));
  }
  gfx::NullDevice dev;
  Renderer r(dev);
  RenderStats s = r.render(d, kPage, Camera{}, {800, 600, 2, 1600, 1200}, Overlay{}, kDark);
  CHECK(s.drawCalls == 1);
  CHECK(s.shapes == 10000);
  CHECK(dev.lastPass.viewport.w == 1600);
  // Screen-space geometry: the camera is applied on the CPU in doubles.
  auto shapes = dev.instancesOf<ShapeInstance>(0);
  CHECK(shapes[0].origin[0] == 7);
}

TEST_CASE("renderer: the page colour, or the theme's for Figma's default") {
  Document d;
  base(d);
  gfx::NullDevice dev;
  Renderer r(dev);
  r.render(d, kPage, Camera{}, {100, 100, 1}, Overlay{}, kDark);
  CHECK(dev.lastPass.clear[0] == doctest::Approx(0x1e / 255.0));
  NodeChange c = NodeChange::changed(kPage);
  c.mask = F_BACKGROUND_COLOR;
  c.props.backgroundColor = Color::hex(0x336699);
  d.apply(c);
  r.render(d, kPage, Camera{}, {100, 100, 1}, Overlay{}, kDark);
  CHECK(dev.lastPass.clear[0] == doctest::Approx(0x33 / 255.0));
}

TEST_CASE("renderer: frames clip — scissor when axis-aligned, stencil when rounded or turned") {
  Document d;
  base(d);
  d.apply(make({1, 1}, NodeType::FRAME, kPage, "A", {0, 0, 100, 100}));
  d.apply(make({1, 2}, NodeType::ROUNDED_RECTANGLE, {1, 1}, "A", {50, 50, 100, 100}));
  NodeChange rounded = make({1, 3}, NodeType::FRAME, kPage, "B", {200, 0, 100, 100});
  rounded.props.cornerRadii = {16, 16, 16, 16};
  d.apply(rounded);
  d.apply(make({1, 4}, NodeType::ELLIPSE, {1, 3}, "A", {0, 0, 100, 100}));
  gfx::NullDevice dev;
  Renderer r(dev);
  r.render(d, kPage, Camera{}, {800, 600, 2}, Overlay{}, kDark);
  bool scissored = false, incremented = false, decremented = false, tested = false;
  for (auto& c : dev.draws) {
    if (c.call.scissorEnabled) {
      scissored = true;
      CHECK(c.call.scissor.w == 200);  // device pixels at dpr 2
    }
    if (c.pipeline.stencil.enabled) {
      incremented |= c.pipeline.stencil.pass == gfx::StencilOp::Increment;
      decremented |= c.pipeline.stencil.pass == gfx::StencilOp::Decrement;
      tested |= c.pipeline.stencil.pass == gfx::StencilOp::Keep && c.call.stencilRef == 1;
      if (c.pipeline.stencil.pass != gfx::StencilOp::Keep) CHECK(c.pipeline.colorMask == gfx::ColorMask::None);
    }
  }
  CHECK(scissored);
  CHECK(incremented);
  CHECK(decremented);
  CHECK(tested);
}

TEST_CASE("renderer: hidden and off-screen nodes are skipped; strokes after fills") {
  Document d;
  base(d);
  NodeChange hidden = make({1, 1}, NodeType::ROUNDED_RECTANGLE, kPage, "A", {0, 0, 10, 10});
  hidden.props.visible = false;
  d.apply(hidden);
  d.apply(make({1, 2}, NodeType::ROUNDED_RECTANGLE, kPage, "B", {5000, 0, 10, 10}));
  NodeChange stroked = make({1, 3}, NodeType::ROUNDED_RECTANGLE, kPage, "C", {0, 0, 10, 10});
  stroked.props.strokePaints = {Paint{}};
  stroked.props.strokeWeight = 4;
  stroked.props.strokeAlign = StrokeAlign::CENTER;
  d.apply(stroked);
  gfx::NullDevice dev;
  Renderer r(dev);
  r.render(d, kPage, Camera{}, {800, 600, 1}, Overlay{}, kDark);
  REQUIRE(shapeCount(dev) == 2);
  auto q = dev.instancesOf<ShapeInstance>(0);
  CHECK(q[0].fill[3] == 1);
  CHECK(q[1].fill[3] == 0);
  CHECK(q[1].params[0] == 2);  // centre: half inside
  CHECK(q[1].params[1] == 2);  // half outside
}

TEST_CASE("renderer: overlays — hover 2px, selection box, 4 handles, size badge, marquee") {
  Document d;
  base(d);
  d.apply(make({1, 1}, NodeType::ROUNDED_RECTANGLE, kPage, "A", {10, 10, 50, 50}));
  d.apply(make({1, 2}, NodeType::ELLIPSE, kPage, "B", {100, 10, 50, 50}));
  Overlay o;
  o.selection = {{1, 1}};
  o.hover = {{1, 2}};
  o.hasMarquee = true;
  o.marquee = {0, 0, 5, 5};
  gfx::NullDevice dev;
  Renderer r(dev);
  r.render(d, kPage, Camera{}, {800, 600, 1}, o, kDark);
  // 2 shapes + hover + box + 4 handles + badge + marquee.
  CHECK(shapeCount(dev) == 10);
  auto all = dev.instancesOf<ShapeInstance>(dev.draws.size() - 1);
  const ShapeInstance& hover = all[all.size() - 8];
  CHECK(hover.params[2] == 1);  // follows the ellipse
  CHECK(hover.params[0] == 2);  // 2 px
  const ShapeInstance& handle = all[all.size() - 6];
  CHECK(handle.origin[2] == 8);
  CHECK(handle.fill[0] == 1);  // white
  CHECK(handle.stroke[3] == 1);
  const ShapeInstance& badge = all[all.size() - 2];
  CHECK(badge.origin[3] == 16);
  CHECK(badge.origin[1] == 66);  // 6 px under the box
  // Small on screen: no handles.
  r.render(d, kPage, Camera{0, 0, 0.25}, {800, 600, 1}, o, kDark);
  CHECK(shapeCount(dev) == 6);
}

TEST_CASE("renderer: scissors use the canvas's real backing scale") {
  Document d;
  base(d);
  d.apply(make({1, 1}, NodeType::FRAME, kPage, "A", {100, 50, 200, 100}));
  d.apply(make({1, 2}, NodeType::ROUNDED_RECTANGLE, {1, 1}, "A", {0, 0, 10, 10}));
  gfx::NullDevice dev;
  Renderer r(dev);
  // dpr 2, but the backing store is only 1× (as under an emulated device scale).
  r.render(d, kPage, Camera{}, {800, 600, 2, 800, 600}, Overlay{}, kDark);
  bool found = false;
  for (auto& c : dev.draws)
    if (c.call.scissorEnabled) {
      found = true;
      CHECK(c.call.scissor.x == 100);
      CHECK(c.call.scissor.w == 200);
    }
  CHECK(found);
}

TEST_CASE("renderer: guides, spacing, ⌥ measurement, insertion and bands are drawn crisp, in their colours") {
  Document d;
  base(d);
  d.apply(make({1, 1}, NodeType::ROUNDED_RECTANGLE, kPage, "!", {0, 0, 50, 50}));
  gfx::NullDevice dev;
  Renderer r(dev);
  Overlay none;
  r.render(d, kPage, Camera{}, {800, 600, 2, 1600, 1200}, none, kDark);
  size_t base = shapeCount(dev);

  Overlay o;
  o.guides.push_back({{100.3, 0}, {100.3, 200}});  // vertical: 1 px wide on device pixels
  o.spacings.push_back({{0, 10}, {40, 10}});         // a line, two ticks, a pill
  o.measureTarget = {1, 1};
  o.measures.push_back({{50, 25}, {90, 25}});
  o.measureGuides.push_back({{90, 0}, {90, 32}});    // dashed: 4 dashes
  o.hasInsertion = true;
  o.insertion = {{60, 0}, {60, 50}};
  o.bands.push_back({0, 0, 10, 50});
  r.render(d, kPage, Camera{}, {800, 600, 2, 1600, 1200}, o, kDark);
  auto shapes = dev.instancesOf<ShapeInstance>(0);
  CHECK(shapeCount(dev) == base + 1 + 4 + 1 + 4 + 4 + 1 + 1);
  // The guide: x snapped to the device grid, 1 CSS px wide, red.
  bool guide = false, band = false, insertion = false;
  const Color red = Color::hex(0xF24822);
  for (auto& s : shapes) {
    if (s.origin[2] == 1.f && s.origin[3] == 200.f && s.origin[0] == 100.f) guide = s.fill[0] == doctest::Approx(red.r);
    if (s.origin[2] == 10.f && s.origin[3] == 50.f) band = s.fill[3] == doctest::Approx(0.15);
    if (s.origin[2] == 2.f && s.origin[3] == 50.f) insertion = true;
  }
  CHECK(guide);
  CHECK(band);
  CHECK(insertion);
}
