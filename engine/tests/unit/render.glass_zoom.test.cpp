// 2026-10-20 (the owner): zooming over a glass layer lagged, and at the deepest zooms the glass vanished. Its
// backdrop's slot in the capture's atlas kept a margin of the frost's radius plus the refraction's reach, both in
// device px, both growing with the zoom: 8,000 px atlases at 6,400 %, past the GPU's texture size at 25,600 % (the
// target couldn't be made, the glass wasn't drawn). Now the margin is bounded and the readers clamp to the slot.
#include <algorithm>
#include <string>

#include "doctest.h"
#include "base/FractionalIndex.h"
#include "gfx/null/NullDevice.h"
#include "Helpers.h"
#include "render/DrawInstance.h"
#include "render/Renderer.h"

using namespace eng;
using namespace eng::test;

namespace {

const OverlayStyle kDark = OverlayStyle::of(Theme::Dark);
const Viewport kView{1280, 800, 2, 2560, 1600};

// Stripes under a glass rectangle (Frost 8, Depth 20 — Figma's default glass), as engine-shot's "glasszoom".
void scene(Document& d) {
  base(d);
  std::string key;
  auto next = [&] { return key = fractional::keyBetween(key, std::nullopt, fractional::Bias::Low); };
  uint32_t n = 1;
  for (double x = 20; x < 460; x += 12) {
    NodeChange s = make({5, n++}, NodeType::ROUNDED_RECTANGLE, kPage, next(), {x, 20, 8, 260});
    s.props.fillPaints = {Paint::solid(Color::hex(n % 2 ? 0xF0B030 : 0x3070F0))};
    d.apply(s);
  }
  NodeChange g = make({5, 900}, NodeType::ROUNDED_RECTANGLE, kPage, next(), {120, 80, 240, 140});
  g.props.cornerRadii = {32, 32, 32, 32};
  g.props.fillPaints = {Paint::solid(Color{1, 1, 1, 0.05f})};
  Effect glass;
  glass.type = EffectType::GLASS;
  glass.radius = 8;
  g.props.effects = {glass};
  d.apply(g);
}

// The camera with world point (x, y) at the canvas's middle.
Camera at(double zoom, double x = 248, double y = 150) { return Camera{640 - x * zoom, 400 - y * zoom, zoom}; }

bool isGlassPaint(const gfx::NullDevice& dev, size_t i) {
  if (dev.draws[i].pipeline.shader != gfx::ShaderId::Shape) return false;
  for (const DrawInstance& q : dev.instancesOf<DrawInstance>(i))
    if ((static_cast<uint32_t>(q.geom[3]) >> 8) == static_cast<uint32_t>(PaintKind::Glass)) return true;
  return false;
}

struct Frame {
  bool glassDrawn = false;      // its paint drawn, reading a blurred backdrop
  uint32_t largestTarget = 0;   // the largest side of any target drawn into
  size_t blurDraws = 0;
  RenderStats stats;
};

Frame frame(double zoom) {
  Document d;
  scene(d);
  gfx::NullDevice dev;
  Renderer r(dev);
  Overlay o;
  o.frameTitles = false;
  Frame f;
  f.stats = r.render(d, kPage, at(zoom), kView, o, kDark);
  for (size_t i = 0; i < dev.draws.size(); i++) {
    const auto& c = dev.draws[i];
    if (c.target) f.largestTarget = std::max({f.largestTarget, dev.texture(c.target).width, dev.texture(c.target).height});
    if (c.pipeline.shader == gfx::ShaderId::Blur) f.blurDraws++;
    if (isGlassPaint(dev, i) && c.call.textures[2]) {
      // It reads within its slot of the frosted atlas (slot 9 = the slot as uv, inside [0, 1]).
      const float* s = c.call.uniforms[9];
      if (s[2] > s[0] && s[3] > s[1] && s[0] >= 0 && s[1] >= 0 && s[2] <= 1 && s[3] <= 1) f.glassDrawn = true;
    }
  }
  CHECK(dev.hazards == 0);
  return f;
}

}  // namespace

TEST_CASE("glass at every zoom: drawn, its atlas within the GPU's texture size, its cost bounded (2026-10-20)") {
  // 100 % … 25,600 % (Figma's deepest zoom). The canvas is 2560 × 1600 device px.
  size_t mostBlurDraws = 0;
  for (double zoom : {1.0, 4.0, 16.0, 64.0, 128.0, 200.0, 256.0}) {
    CAPTURE(zoom);
    Frame f = frame(zoom);
    CHECK(f.glassDrawn);
    CHECK(f.stats.backdrops == 1);
    CHECK(f.stats.captures == 1);
    // The atlas: the copy (at most the canvas) plus a bounded margin, aligned — never past the default caps' 4096.
    CHECK(f.largestTarget <= 4096);
    mostBlurDraws = std::max(mostBlurDraws, f.blurDraws);
  }
  // The frost's tent: two draws (across, down) per backdrop, whatever the zoom.
  CHECK(mostBlurDraws == 2);
}

TEST_CASE("glass: the backdrop's margin is bounded — at 25,600 % the atlas is the canvas plus at most kMaxBackdropPad a side") {
  Document d;
  scene(d);
  gfx::NullDevice dev;
  Renderer r(dev);
  Overlay o;
  o.frameTitles = false;
  r.render(d, kPage, at(256), kView, o, kDark);
  REQUIRE(dev.copySteps == 1);
  REQUIRE(dev.copyPlaces.size() == 1);
  // The copy is the canvas (the glass covers it), placed past a margin of at most kMaxBackdropPad.
  CHECK(dev.copyRects.back().w == 2560);
  CHECK(dev.copyRects.back().h == 1600);
  CHECK(dev.copyPlaces[0].first <= 256);
  CHECK(dev.copyPlaces[0].second <= 256);
  // Its tent's taps clamp to the copy where the canvas's edge cut it (slot 9 of the blur draws: inside the atlas).
  for (const auto& c : dev.draws) {
    if (c.pipeline.shader != gfx::ShaderId::Blur) continue;
    const float* s = c.call.uniforms[9];
    CHECK(s[2] > s[0]);
    CHECK(s[3] > s[1]);
  }
}

TEST_CASE("glass at normal zooms: the slot keeps the whole margin the frost and refraction read (no clamping reached)") {
  // At 100 % the margin is the frost's radius + the refraction's reach + 2, as before: the look is unchanged.
  Document d;
  scene(d);
  gfx::NullDevice dev;
  Renderer r(dev);
  Overlay o;
  o.frameTitles = false;
  r.render(d, kPage, at(1, 240, 150), kView, o, kDark);
  REQUIRE(dev.copyPlaces.size() == 1);
  // Frost 8 × 2 device px = 16; the glass's reach: min(20, 70, 120) × 2 × refraction × (1 + dispersion) — under the bound.
  CHECK(dev.copyPlaces[0].first > 16);
  CHECK(dev.copyPlaces[0].first < 256);
}
