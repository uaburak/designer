// E4 / E5 rendering on the recording device: paths through the curve cache (and
// its coverage, computed as the shader does), paints, analytic and generic
// shadows, layers and their composites, masks, blend modes.
#include <cmath>

#include "doctest.h"
#include "geometry/Shapes.h"
#include "gfx/null/NullDevice.h"
#include "Helpers.h"
#include "render/CurveCoverage.h"
#include "render/Renderer.h"

using namespace eng;
using namespace eng::test;

namespace {

const OverlayStyle kDark = OverlayStyle::of(Theme::Dark);

struct Frame {
  size_t paths = 0, shapes = 0, composites = 0, blurs = 0, passes = 0;
  std::vector<DrawInstance> instances;
};

Frame record(Renderer& r, gfx::NullDevice& dev, const Document& d) {
  r.render(d, kPage, Camera{}, {800, 600, 1, 800, 600}, Overlay{}, kDark);
  Frame f;
  f.passes = static_cast<size_t>(dev.passes);
  for (size_t i = 0; i < dev.draws.size(); i++) {
    const auto& c = dev.draws[i];
    switch (c.pipeline.shader) {
      case gfx::ShaderId::Path: f.paths += c.call.instanceCount; break;
      case gfx::ShaderId::Shape: f.shapes += c.call.instanceCount; break;
      case gfx::ShaderId::Composite: f.composites++; break;
      case gfx::ShaderId::Blur: f.blurs++; break;
    }
    if (c.pipeline.shader == gfx::ShaderId::Path || c.pipeline.shader == gfx::ShaderId::Shape)
      for (auto& q : dev.instancesOf<DrawInstance>(i)) f.instances.push_back(q);
  }
  return f;
}

}  // namespace

TEST_CASE("curve coverage: the packed format, bands, both fill rules") {
  // A 10 × 10 square and, inside it, a 4 × 4 one: under ODD a hole, under NONZERO (same direction) filled.
  geom::Path p = geom::rectPath({10, 10}, {0, 0, 0, 0});
  p.append(geom::rectPath({4, 4}, {0, 0, 0, 0}).transformed(Mat2x3::translate(3, 3)));
  std::vector<float> curves;
  geom::toQuads(p, 0.01, curves);
  std::vector<float> data;
  CurveEntry e = CurveCache::pack(curves.data(), curves.size() / 6, 0, data);
  CHECK(e.curves == 8);
  CHECK(e.bounds[2] == 10);
  const float ppe = 1;  // one pixel per unit
  CHECK(curveCoverage(data, 0, 1.5f, 1.5f, ppe, ppe, false) == doctest::Approx(1));
  CHECK(curveCoverage(data, 0, 5.f, 5.f, ppe, ppe, false) == doctest::Approx(1));
  CHECK(curveCoverage(data, 0, 5.f, 5.f, ppe, ppe, true) == doctest::Approx(0));
  CHECK(curveCoverage(data, 0, 1.5f, 1.5f, ppe, ppe, true) == doctest::Approx(1));
  CHECK(curveCoverage(data, 0, 12.f, 5.f, ppe, ppe, false) == doctest::Approx(0));
  CHECK(curveCoverage(data, 0, 10.f, 5.f, ppe, ppe, false) == doctest::Approx(0.5).epsilon(0.05));  // on the edge
  // Many curves: still exact, with bands.
  geom::Path circle = geom::ellipsePath({100, 100}, {});
  std::vector<float> cc;
  geom::toQuads(circle, 0.001, cc);
  std::vector<float> cd;
  CurveEntry ce = CurveCache::pack(cc.data(), cc.size() / 6, 0, cd);
  CHECK(ce.curves > 16);
  CHECK(curveCoverage(cd, 0, 50, 50, 1, 1, false) == doctest::Approx(1));
  CHECK(curveCoverage(cd, 0, 2, 2, 1, 1, false) == doctest::Approx(0));
  CHECK(curveCoverage(cd, 0, 85.3553f, 14.6447f, 1, 1, false) == doctest::Approx(0.5).epsilon(0.1));  // on the edge at 45°
}

TEST_CASE("renderer: vectors, stars and dashed strokes are paths; gradients and images are paints") {
  Document d;
  base(d);
  NodeChange star = make({1, 1}, NodeType::STAR, kPage, "!", {10, 10, 100, 100});
  star.props.starInnerScale = 0.4;
  Paint g;
  g.type = PaintType::GRADIENT_RADIAL;
  g.stops = {{Color::hex(0xFF0000), 0}, {Color::hex(0x0000FF), 1}};
  star.props.fillPaints = {g};
  d.apply(star);
  NodeChange dashed = make({1, 2}, NodeType::ROUNDED_RECTANGLE, kPage, "\"", {200, 10, 100, 100});
  dashed.props.strokePaints = {Paint::solid(Color::hex(0))};
  dashed.props.dashPattern = {4, 4};
  d.apply(dashed);
  NodeChange img = make({1, 3}, NodeType::ROUNDED_RECTANGLE, kPage, "#", {400, 10, 100, 100});
  Paint ip;
  ip.type = PaintType::IMAGE;
  ip.image = ImageHash::fromHex("1111111111111111111111111111111111111111");
  ip.imageScaleMode = ImageScaleMode::FILL;
  img.props.fillPaints = {ip};
  d.apply(img);
  gfx::NullDevice dev;
  Renderer r(dev);
  Frame f = record(r, dev, d);
  CHECK(f.paths >= 3);  // the star's fill, the dashed rectangle's fill and stroke
  bool radial = false, grey = false;
  for (auto& q : f.instances) {
    uint32_t kind = (static_cast<uint32_t>(q.geom[3]) >> 8) & 15;
    radial |= kind == static_cast<uint32_t>(PaintKind::Radial);
    // An image still loading draws Figma's grey.
    grey |= q.color[0] == doctest::Approx(0xE6 / 255.0) && kind == 0;
  }
  CHECK(radial);
  CHECK(grey);
  CHECK(r.curveCache().pathCount() >= 3);
  // The image was asked for once.
  auto requests = ImageRegistry::get().takeRequests();
  REQUIRE(requests.size() == 1);
  CHECK(requests[0].hex() == "1111111111111111111111111111111111111111");
  // Pixels arrive: drawn as an image paint.
  ImageRegistry::get().addRgba(requests[0], 2, 2, std::make_shared<std::vector<uint8_t>>(16, 255));
  Frame f2 = record(r, dev, d);
  bool image = false;
  for (auto& q : f2.instances) image |= ((static_cast<uint32_t>(q.geom[3]) >> 8) & 15) == static_cast<uint32_t>(PaintKind::Image);
  CHECK(image);
}

TEST_CASE("renderer: shadows, layers, blend modes and masks") {
  Document d;
  base(d);
  Effect drop;
  drop.type = EffectType::DROP_SHADOW;
  drop.color = {0, 0, 0, 0.25f};
  drop.offset = {0, 4};
  drop.radius = 8;
  // A white card: the analytic shadow, no layer.
  NodeChange card = make({1, 1}, NodeType::ROUNDED_RECTANGLE, kPage, "!", {10, 10, 100, 100});
  card.props.fillPaints = {Paint::solid(Color::hex(0xFFFFFF))};
  card.props.effects = {drop};
  d.apply(card);
  gfx::NullDevice dev;
  Renderer r(dev);
  Frame f = record(r, dev, d);
  bool analytic = false;
  for (auto& q : f.instances) analytic |= q.geom[2] == static_cast<float>(ShapeKind::DropShadow);
  CHECK(analytic);
  CHECK(f.composites == 0);
  // An ellipse: the generic path — its alpha into a layer, blurred, composited under it.
  NodeChange ball = make({1, 2}, NodeType::ELLIPSE, kPage, "\"", {200, 10, 100, 100});
  ball.props.effects = {drop};
  d.apply(ball);
  f = record(r, dev, d);
  CHECK(f.blurs >= 2);
  CHECK(f.composites >= 2);  // the shadow and the ellipse itself
  // A group at 50 %: one layer, composited at 0.5.
  NodeChange group = make({1, 3}, NodeType::FRAME, kPage, "#", {400, 10, 100, 100});
  group.props.resizeToFit = true;
  group.props.fillPaints.clear();
  group.props.opacity = 0.5;
  d.apply(group);
  d.apply(make({1, 4}, NodeType::ROUNDED_RECTANGLE, {1, 3}, "!", {0, 0, 60, 60}));
  d.apply(make({1, 5}, NodeType::ROUNDED_RECTANGLE, {1, 3}, "\"", {40, 40, 60, 60}));
  f = record(r, dev, d);
  bool half = false;
  for (auto& c : dev.draws)
    if (c.pipeline.shader == gfx::ShaderId::Composite) half |= c.call.uniforms[7][0] == doctest::Approx(0.5f);
  CHECK(half);
  // MULTIPLY reads the backdrop.
  NodeChange mul = make({1, 6}, NodeType::ROUNDED_RECTANGLE, kPage, "$", {20, 20, 50, 50});
  mul.props.blendMode = BlendMode::MULTIPLY;
  d.apply(mul);
  int copies = dev.copies;
  f = record(r, dev, d);
  CHECK(dev.copies > copies);
  bool replace = false;
  for (auto& c : dev.draws) replace |= c.pipeline.blend == gfx::Blend::Replace && c.call.uniforms[7][1] == static_cast<float>(BlendMode::MULTIPLY);
  CHECK(replace);
  // A mask: the masked layers and the mask in layers, composited with mode 1 (alpha).
  NodeChange m = make({1, 7}, NodeType::ELLIPSE, kPage, "%", {600, 10, 100, 100});
  m.props.mask = true;
  d.apply(m);
  d.apply(make({1, 8}, NodeType::ROUNDED_RECTANGLE, kPage, "&", {620, 30, 100, 100}));
  f = record(r, dev, d);
  bool masked = false;
  for (auto& c : dev.draws)
    if (c.pipeline.shader == gfx::ShaderId::Composite) masked |= c.call.uniforms[7][2] == 1.f;
  CHECK(masked);
}

TEST_CASE("renderer: frame titles read on the page's colour") {
  double a = 0;
  Color dark = Renderer::titleColor(Color::hex(0x1E1E1E), &a);
  CHECK(dark.r == 1);
  CHECK(a == doctest::Approx(0.7));
  Color light = Renderer::titleColor(Color::hex(0xF5F5F5), &a);
  CHECK(light.r == 0);
  CHECK(a == doctest::Approx(0.5));
  // A mid-dark page (#555) still gets the light label.
  CHECK(Renderer::titleColor(Color::hex(0x555555), &a).r == 1);
}
