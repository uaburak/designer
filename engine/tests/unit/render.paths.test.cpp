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
#include "scene/CodecKiwi.h"

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
      case gfx::ShaderId::Shape:
        // One program draws shapes, paths and glyphs: told apart by the instance's kind.
        for (auto& q : dev.instancesOf<DrawInstance>(i)) {
          if (q.geom[2] == static_cast<float>(ShapeKind::Path)) f.paths++;
          else f.shapes++;
          f.instances.push_back(q);
        }
        break;
      case gfx::ShaderId::Composite: f.composites++; break;
      case gfx::ShaderId::Blur: f.blurs++; break;
    }
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
  star.props.shape().starInnerScale = 0.4;
  Paint g;
  g.type = PaintType::GRADIENT_RADIAL;
  g.stops = {{Color::hex(0xFF0000), 0}, {Color::hex(0x0000FF), 1}};
  star.props.fillPaints = {g};
  d.apply(star);
  NodeChange dashed = make({1, 2}, NodeType::ROUNDED_RECTANGLE, kPage, "\"", {200, 10, 100, 100});
  dashed.props.strokePaints = {Paint::solid(Color::hex(0))};
  dashed.props.stroke().dashPattern = {4, 4};
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
  CHECK(requests[0].hash.hex() == "1111111111111111111111111111111111111111");
  // Pixels arrive: drawn as an image paint.
  ImageRegistry::get().addRgba(requests[0].hash, 2, 2, std::make_shared<std::vector<uint8_t>>(16, 255));
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
  CHECK(Renderer::darkCanvas(Color::hex(0x1E1E1E)));
  CHECK_FALSE(Renderer::darkCanvas(Color::hex(0xF5F5F5)));
  // A mid-dark page (#555) still gets the light label.
  CHECK(Renderer::darkCanvas(Color::hex(0x555555)));
  // The colours: live Figma's white at 46 % on dark (#ffffff76 over #1e1e1e reads #868686), black at 50 % on light.
  OverlayStyle s = OverlayStyle::of(Theme::Light);
  CHECK(s.titleOnDark.r == 1);
  CHECK(s.titleOnDark.a == doctest::Approx(0x76 / 255.0).epsilon(0.001));
  CHECK(s.titleOnLight.r == 0);
  CHECK(s.titleOnLight.a == doctest::Approx(0.5).epsilon(0.01));
  CHECK(s.titleSelectedOnDark.r == doctest::Approx(0x7C / 255.0).epsilon(0.001));
  CHECK(s.titleSelectedOnDark.b == doctest::Approx(0xF8 / 255.0).epsilon(0.001));
  CHECK(s.titleComponentOnDark.r == doctest::Approx(0xD1 / 255.0).epsilon(0.001));
  CHECK(s.titleComponentOnDark.g == doctest::Approx(0xA8 / 255.0).epsilon(0.001));
}

TEST_CASE("images: ThumbHash placeholders decode as the reference does (github.com/evanw/thumbhash)") {
  // Hashes and decodes from the reference algorithm (the editor's port, src/renderer/src/editor/thumbHash.ts): a
  // 40 × 20 image, red | blue; and a green one, half translucent.
  const std::vector<uint8_t> opaque{21, 246, 2, 244, 168, 120, 143, 77, 130, 135, 120, 119, 136, 151, 143, 120, 248, 136, 136};
  const std::vector<uint8_t> alpha{149, 121, 128, 3, 128, 73, 120, 120, 128, 120, 135, 120, 112, 119, 248, 136, 120, 120, 143, 136, 136, 88, 136};
  ThumbImage a, b;
  REQUIRE(decodeThumbHash(opaque.data(), opaque.size(), a));
  REQUIRE(decodeThumbHash(alpha.data(), alpha.size(), b));
  CHECK(a.width == 32);
  CHECK(a.height == 18);
  CHECK(b.width == 32);
  CHECK(b.height == 19);
  uint64_t sumA = 0, sumB = 0;
  for (uint8_t v : a.rgba) sumA += v;
  for (uint8_t v : b.rgba) sumB += v;
  CHECK(sumA == 294877);
  CHECK(sumB == 178377);
  CHECK(std::vector<uint8_t>(a.rgba.begin(), a.rgba.begin() + 8) == std::vector<uint8_t>{255, 0, 0, 255, 255, 0, 0, 255});
  CHECK(std::vector<uint8_t>(b.rgba.begin(), b.rgba.begin() + 8) == std::vector<uint8_t>{3, 201, 49, 255, 3, 201, 49, 255});
  CHECK(!decodeThumbHash(opaque.data(), 3, a));
}

TEST_CASE("images: the ThumbHash draws until the bitmap; requests carry the drawn size; a tier is asked again, larger") {
  ImageRegistry::get().clear();
  Document d;
  base(d);
  NodeChange rect = make({1, 1}, NodeType::ROUNDED_RECTANGLE, kPage, "!", {0, 0, 200, 100});
  Paint img;
  img.type = PaintType::IMAGE;
  img.image = ImageHash::fromHex("2222222222222222222222222222222222222222");
  img.imageScaleMode = ImageScaleMode::FILL;
  img.originalImageWidth = 2000;
  img.originalImageHeight = 1000;
  const std::vector<uint8_t> hash{21, 246, 2, 244, 168, 120, 143, 77, 130, 135, 120, 119, 136, 151, 143, 120, 248, 136, 136};
  json::Value bytes;
  bytes.kind = json::Value::Kind::Array;
  for (uint8_t v : hash) {
    json::Value n;
    n.kind = json::Value::Kind::Number;
    n.number = v;
    bytes.array.push_back(n);
  }
  img.extra = codec::extraFromJson("Paint", "thumbHash", bytes);
  json::Value thumbnail;
  REQUIRE(json::parse(R"({"hash":"3333333333333333333333333333333333333333"})", thumbnail));
  img.extra += codec::extraFromJson("Paint", "imageThumbnail", thumbnail);
  rect.props.fillPaints = {img};
  d.apply(rect);
  gfx::NullDevice dev;
  Renderer r(dev);
  Overlay o;
  o.frameTitles = false;
  // At zoom 1 on a 2× canvas: 400 device px wide.
  auto imageDraws = [&]() {
    int n = 0;
    for (size_t i = 0; i < dev.draws.size(); i++)
      if (dev.draws[i].pipeline.shader == gfx::ShaderId::Shape)
        for (auto& q : dev.instancesOf<DrawInstance>(i)) n += ((static_cast<uint32_t>(q.geom[3]) >> 8) & 15) == static_cast<uint32_t>(PaintKind::Image);
    return n;
  };
  r.render(d, kPage, Camera{}, Viewport{800, 600, 2, 1600, 1200}, o, OverlayStyle::of(Theme::Dark));
  CHECK(imageDraws() == 1);  // the ThumbHash, not grey
  auto requests = ImageRegistry::get().takeRequests();
  REQUIRE(requests.size() == 1);
  CHECK(requests[0].maxDevicePx == 400);
  CHECK(requests[0].thumbnail.hex() == "3333333333333333333333333333333333333333");
  // The editor answers with a tier (≤ 512 px): drawn; drawn at 4× it is asked for again with the size it needs.
  ImageRegistry::get().addRgba(img.image, 512, 256, std::make_shared<std::vector<uint8_t>>(512 * 256 * 4, 255));
  r.render(d, kPage, Camera{}, Viewport{800, 600, 2, 1600, 1200}, o, OverlayStyle::of(Theme::Dark));
  CHECK(ImageRegistry::get().takeRequests().empty());
  r.render(d, kPage, Camera{0, 0, 4}, Viewport{800, 600, 2, 1600, 1200}, o, OverlayStyle::of(Theme::Dark));
  requests = ImageRegistry::get().takeRequests();
  REQUIRE(requests.size() == 1);
  CHECK(requests[0].maxDevicePx == 1600);
  // The full image arrives; a late tier doesn't replace it; nothing more is asked.
  ImageRegistry::get().addRgba(img.image, 2000, 1000, std::make_shared<std::vector<uint8_t>>(2000 * 1000 * 4, 255));
  ImageRegistry::get().addRgba(img.image, 512, 256, std::make_shared<std::vector<uint8_t>>(512 * 256 * 4, 255));
  r.render(d, kPage, Camera{0, 0, 8}, Viewport{800, 600, 2, 1600, 1200}, o, OverlayStyle::of(Theme::Dark));
  CHECK(ImageRegistry::get().takeRequests().empty());
  CHECK(r.imageCache().bytes() >= 2000ull * 1000 * 4);
  ImageRegistry::get().clear();
}
