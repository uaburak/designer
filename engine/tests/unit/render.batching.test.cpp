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
  auto shapes = dev.instancesOf<DrawInstance>(0);
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
  c.props.rare().backgroundColor = Color::hex(0x336699);
  d.apply(c);
  r.render(d, kPage, Camera{}, {100, 100, 1}, Overlay{}, kDark);
  CHECK(dev.lastPass.clear[0] == doctest::Approx(0x33 / 255.0));
}

TEST_CASE("renderer: frames clip — a clip rectangle when axis-aligned, a rounded clip when rounded, stencil when turned") {
  Document d;
  base(d);
  d.apply(make({1, 1}, NodeType::FRAME, kPage, "A", {0, 0, 100, 100}));
  d.apply(make({1, 2}, NodeType::ROUNDED_RECTANGLE, {1, 1}, "A", {50, 50, 100, 100}));
  NodeChange rounded = make({1, 3}, NodeType::FRAME, kPage, "B", {200, 0, 100, 100});
  rounded.props.cornerRadii = {16, 16, 16, 16};
  d.apply(rounded);
  d.apply(make({1, 4}, NodeType::ELLIPSE, {1, 3}, "A", {0, 0, 100, 100}));
  NodeChange turned = make({1, 5}, NodeType::FRAME, kPage, "C", {400, 0, 100, 100});
  turned.props.transform = Mat2x3::translate(450, 0) * Mat2x3::rotate(0.3);
  d.apply(turned);
  d.apply(make({1, 6}, NodeType::ELLIPSE, {1, 5}, "A", {0, 0, 100, 100}));
  gfx::NullDevice dev;
  Renderer r(dev);
  r.render(d, kPage, Camera{}, {800, 600, 2}, Overlay{}, kDark);
  bool scissored = false, roundedClip = false, incremented = false, decremented = false, tested = false;
  size_t drawsOfShapes = 0;
  for (size_t i = 0; i < dev.draws.size(); i++) {
    const auto& c = dev.draws[i];
    // The axis-aligned clip travels with each instance (canvas device px), not as a scissor that splits batches.
    if (c.pipeline.shader == gfx::ShaderId::Shape) {
      drawsOfShapes++;
      for (auto& q : dev.instancesOf<DrawInstance>(i)) {
        if (q.clip[0] > -1e8f && q.round[2] <= q.round[0]) {
          scissored = true;
          CHECK(q.clip[2] - q.clip[0] == 200);  // device pixels at dpr 2
        }
        if (q.round[2] > q.round[0]) {
          // The rounded frame's box and radii in device px (dpr 2): the ellipse inside it is clipped by them.
          roundedClip = true;
          CHECK(q.round[0] == doctest::Approx(400));
          CHECK(q.round[2] == doctest::Approx(600));
          CHECK(q.radii[0] == doctest::Approx(32));
        }
      }
    }
    if (c.pipeline.stencil.enabled) {
      incremented |= c.pipeline.stencil.pass == gfx::StencilOp::Increment;
      decremented |= c.pipeline.stencil.pass == gfx::StencilOp::Decrement;
      tested |= c.pipeline.stencil.pass == gfx::StencilOp::Keep && c.call.stencilRef == 1;
      if (c.pipeline.stencil.pass != gfx::StencilOp::Keep) CHECK(c.pipeline.colorMask == gfx::ColorMask::None);
    }
  }
  CHECK(scissored);
  CHECK(roundedClip);
  // Only the turned frame uses the stencil: increment, its clipped content, decrement.
  CHECK(incremented);
  CHECK(decremented);
  CHECK(tested);
}

TEST_CASE("renderer: rounded clipping frames batch — no stencil passes between them") {
  // Cards: rounded frames that clip, each with a fill and a child. Rounded clips are per instance, so the page is
  // a handful of draws however many cards there are (stencil clips once cost three or more draws per card).
  Document d;
  base(d);
  std::string key;
  for (uint32_t i = 1; i <= 200; i++) {
    key = fractional::keyBetween(key, std::nullopt, fractional::Bias::Low);
    NodeChange card = make({1, i}, NodeType::FRAME, kPage, key, {(i % 20) * 40.0, (i / 20) * 40.0, 36, 36});
    card.props.cornerRadii = {8, 8, 8, 8};
    card.props.fillPaints = {Paint::solid(Color{1, 1, 1, 1})};
    d.apply(card);
    d.apply(make({2, i}, NodeType::ELLIPSE, {1, i}, "!", {20, 20, 30, 30}));
  }
  gfx::NullDevice dev;
  Renderer r(dev);
  RenderStats s = r.render(d, kPage, Camera{}, {800, 600, 2}, Overlay{}, kDark);
  CHECK(s.shapes == 400);
  CHECK(s.drawCalls <= 2);
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
  auto q = dev.instancesOf<DrawInstance>(0);
  CHECK(q[0].color[3] == 1);
  CHECK((static_cast<uint32_t>(q[0].geom[3]) & DF_STROKE) == 0);
  CHECK((static_cast<uint32_t>(q[1].geom[3]) & DF_STROKE) != 0);  // the stroke band
  CHECK(q[1].geom[0] == 2);  // centre: half inside
  CHECK(q[1].geom[1] == 2);  // half outside
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
  auto all = dev.instancesOf<DrawInstance>(dev.draws.size() - 1);
  const DrawInstance& hover = all[all.size() - 8];
  CHECK(hover.geom[2] == 1);  // follows the ellipse
  CHECK(hover.geom[0] == 2);  // 2 px
  const DrawInstance& handle = all[all.size() - 6];
  CHECK(handle.origin[2] == 7);  // live Figma: 7 px
  CHECK(handle.color[0] == 1);   // white
  CHECK(handle.paint0[3] == 1);  // the blue border
  const DrawInstance& badge = all[all.size() - 2];
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
  for (size_t i = 0; i < dev.draws.size(); i++)
    if (dev.draws[i].pipeline.shader == gfx::ShaderId::Shape)
      for (auto& q : dev.instancesOf<DrawInstance>(i))
        if (q.clip[0] > -1e8f) {
          found = true;
          CHECK(q.clip[0] == 100);
          CHECK(q.clip[2] - q.clip[0] == 200);
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
  auto shapes = dev.instancesOf<DrawInstance>(0);
  CHECK(shapeCount(dev) == base + 1 + 4 + 1 + 4 + 4 + 1 + 1);
  // The guide: x snapped to the device grid, 1 CSS px wide, red.
  bool guide = false, band = false, insertion = false;
  const Color red = Color::hex(0xF24822);
  for (auto& s : shapes) {
    if (s.origin[2] == 1.f && s.origin[3] == 200.f && s.origin[0] == 100.f) guide = s.color[0] == doctest::Approx(red.r);
    if (s.origin[2] == 10.f && s.origin[3] == 50.f) band = s.color[3] == doctest::Approx(0x40 / 255.0);
    if (s.origin[2] == 2.f && s.origin[3] == 50.f) insertion = true;
  }
  CHECK(guide);
  CHECK(band);
  CHECK(insertion);
}

TEST_CASE("renderer: GPU memory stays bounded while a zoom changes layers' sizes every frame") {
  // Faded frames (opacity on a container: an offscreen layer each) seen through a continuous zoom: each frame's
  // layers have new sizes. The layer pool must not keep every size it ever made (it once kept them 120 frames:
  // gigabytes on the GPU during a long zoom).
  Document d;
  base(d);
  std::string key;
  for (uint32_t i = 1; i <= 6; i++) {
    key = fractional::keyBetween(key, std::nullopt, fractional::Bias::Low);
    NodeChange f = make({1, i}, NodeType::FRAME, kPage, key, {(i - 1) * 140.0, 0, 120, 200});
    f.props.opacity = 0.5;
    d.apply(f);
    d.apply(make({2, i}, NodeType::ROUNDED_RECTANGLE, {1, i}, "!", {10, 10, 50, 50}));
    d.apply(make({3, i}, NodeType::ELLIPSE, {1, i}, "\"", {30, 30, 50, 50}));
  }
  gfx::NullDevice dev;
  Renderer r(dev);
  r.setContentCache(true);
  uint64_t peak = 0;
  for (int frame = 0; frame < 400; frame++) {
    double zoom = 0.5 + frame * 0.02;  // 0.5 → 8.5: layers grow from tiny to larger than the viewport
    Overlay o;
    o.zooming = true;
    r.render(d, kPage, Camera{-frame * 3.0, 0, zoom}, {1440, 900, 2, 2880, 1800}, o, kDark);
    peak = std::max(peak, dev.memory().bytes);
  }
  // The pool's budget, the content cache (two canvas-sized targets) and small change (ramps, buffers).
  uint64_t cache = 2ull * 2880 * 1800 * 8;
  MESSAGE("GPU memory peak over the zoom: " << (peak >> 20) << " MB, layer pool " << (r.poolTargetBytes() >> 20) << " MB");
  CHECK(r.poolTargetBytes() <= Renderer::kPoolBudgetBytes);
  CHECK(peak <= Renderer::kPoolBudgetBytes + cache + (64ull << 20));
}

TEST_CASE("renderer: no pass samples the texture it draws into, while the layer pool evicts mid-frame") {
  // The presentation view's layers are screen-sized (a layer may be anywhere there: no culling), so a few shadows
  // and blurs on a Retina screen fill the pool's budget, and acquiring a blur's next target evicts an idle one in
  // the middle of the frame. The pool once erased it from a deque, which moves the targets after it: a blur still
  // holding a pointer into the pool then drew into the very target it sampled — WebGPU rejects the frame ("includes
  // writable usage and another usage in the same synchronization scope"), WebGL draws garbage.
  Document d;
  base(d);
  std::string key;
  for (uint32_t i = 1; i <= 5; i++) {
    key = fractional::keyBetween(key, std::nullopt, fractional::Bias::Low);
    NodeChange e = make({1, i}, NodeType::ELLIPSE, kPage, key, {i * 10.0, i * 10.0, 1400, 860});
    Effect shadow;
    shadow.type = EffectType::DROP_SHADOW;
    shadow.radius = 40;
    shadow.offset = {0, 8};
    Effect blur;
    blur.type = EffectType::FOREGROUND_BLUR;
    blur.radius = 24.0 * i;
    e.props.effects = {shadow, blur};
    if (i % 2) {
      Effect back;
      back.type = EffectType::BACKGROUND_BLUR;
      back.radius = 30;
      e.props.effects.push_back(back);
    }
    e.props.opacity = 0.8;
    d.apply(e);
  }
  gfx::NullDevice dev;
  Renderer r(dev);
  const gfx::TargetId kSentinel = dev.createTarget(1, 1);  // ids made from here on are the pool's
  uint64_t created = 0;
  for (int frame = 0; frame < 24; frame++) {
    // The blurs change every frame (an animation): their downsampled targets change size, the pool evicts.
    for (uint32_t i = 1; i <= 5; i++) {
      NodeChange c = NodeChange::changed({1, i});
      c.mask = F_EFFECTS;
      c.props.effects = d.get({1, i})->props.effects;
      c.props.effects[1].radius = 8.0 + ((frame * 7 + i * 13) % 40) * 4;
      d.apply(c);
    }
    r.render(d, kPage, Camera{}, {1440, 900, 2, 2880, 1800}, Overlay{}, kDark);
    REQUIRE(dev.hazards == 0);
    CHECK(r.poolTargetBytes() <= Renderer::kPoolBudgetBytes);
  }
  created = dev.createTarget(1, 1) - kSentinel - 1;
  // The case this is about happened: the pool made more targets than it keeps (it evicted).
  MESSAGE("pool: " << created << " targets made, " << r.poolTargets() << " kept");
  CHECK(created > r.poolTargets() + 4);
}
