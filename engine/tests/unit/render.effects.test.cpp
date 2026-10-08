// Figma's newer effects and paints on the recording device (round 7, item 7): progressive layer and background blurs,
// noise, texture, glass; NOISE and PATTERN paints. What is checked is how they are recorded (passes, composite modes,
// uniform slots); the pixels are checked by scripts/engine-shot.mjs on both GPU backends.
#include <algorithm>
#include <cmath>
#include <set>

#include "doctest.h"
#include "gfx/null/NullDevice.h"
#include "Helpers.h"
#include "render/Renderer.h"
#include "scene/CodecKiwi.h"
#include "scene/Extras.h"

using namespace eng;
using namespace eng::test;

namespace {

const OverlayStyle kDark = OverlayStyle::of(Theme::Dark);

json::Value parsedJson(const char* text) {
  json::Value v;
  REQUIRE(json::parse(text, v));
  return v;
}

// An effect's / paint's newer fields, as the panels write them (JSON members → the schema's bytes in `extra`).
std::string effectExtra(std::initializer_list<std::pair<const char*, const char*>> members) {
  std::string out;
  for (auto& [k, v] : members) out += codec::extraFromJson("Effect", k, parsedJson(v));
  return out;
}
std::string paintExtra(std::initializer_list<std::pair<const char*, const char*>> members) {
  std::string out;
  for (auto& [k, v] : members) out += codec::extraFromJson("Paint", k, parsedJson(v));
  return out;
}

void render(Renderer& r, const Document& d) { r.render(d, kPage, Camera{}, {800, 600, 1, 800, 600}, Overlay{}, kDark); }

std::vector<const gfx::NullDevice::Recorded*> composites(const gfx::NullDevice& dev, int mode) {
  std::vector<const gfx::NullDevice::Recorded*> out;
  for (auto& c : dev.draws)
    if (c.pipeline.shader == gfx::ShaderId::Composite && c.call.uniforms[7][2] == static_cast<float>(mode)) out.push_back(&c);
  return out;
}

std::set<float> blurSigmas(const gfx::NullDevice& dev) {
  std::set<float> out;
  for (auto& c : dev.draws)
    if (c.pipeline.shader == gfx::ShaderId::Blur && c.call.uniforms[2][3] == 0) out.insert(std::round(c.call.uniforms[2][2] * 100) / 100);
  return out;
}

// Draw instances by paint kind.
size_t paintKinds(gfx::NullDevice& dev, PaintKind kind) {
  size_t n = 0;
  for (size_t i = 0; i < dev.draws.size(); i++) {
    if (dev.draws[i].pipeline.shader != gfx::ShaderId::Shape) continue;
    for (auto& q : dev.instancesOf<DrawInstance>(i)) n += ((static_cast<uint32_t>(q.geom[3]) >> 8) & 15) == static_cast<uint32_t>(kind);
  }
  return n;
}

NodeChange card(Guid id, Rect r) {
  NodeChange n = make(id, NodeType::ROUNDED_RECTANGLE, kPage, "!", r);
  n.props.fillPaints = {Paint::solid(Color::hex(0x3366FF))};
  return n;
}

}  // namespace

TEST_CASE("extras: the newer effect and paint fields decode from `extra`, Figma's defaults otherwise") {
  Effect e;
  e.type = EffectType::FOREGROUND_BLUR;
  CHECK(effectExtras(e).blurOpType == BlurOpType::NORMAL);
  e.extra = effectExtra({{"blurOpType", "\"PROGRESSIVE\""}, {"startRadius", "2"}, {"startOffset", "{\"x\":0.5,\"y\":0.25}"},
                         {"endOffset", "{\"x\":0.5,\"y\":0.75}"}});
  const EffectExtras& x = effectExtras(e);
  CHECK(x.blurOpType == BlurOpType::PROGRESSIVE);
  CHECK(x.startRadius == doctest::Approx(2));
  CHECK(x.startOffset.y == doctest::Approx(0.25));
  CHECK(x.endOffset.y == doctest::Approx(0.75));
  Effect n;
  n.type = EffectType::NOISE;
  n.extra = effectExtra({{"noiseType", "\"DUOTONE\""}, {"density", "0.5"}, {"noiseSize", "{\"x\":2,\"y\":3}"},
                         {"secondaryColor", "{\"r\":1,\"g\":0,\"b\":0,\"a\":1}"}});
  CHECK(effectExtras(n).noiseType == NoiseType::DUOTONE);
  CHECK(effectExtras(n).density == doctest::Approx(0.5));
  CHECK(effectExtras(n).noiseSize.y == doctest::Approx(3));
  CHECK(effectExtras(n).secondaryColor.r == doctest::Approx(1));
  Paint p;
  p.type = PaintType::PATTERN;
  p.extra = paintExtra({{"sourceNodeId", "{\"sessionID\":1,\"localID\":9}"}, {"patternTileType", "\"HORIZONTAL_HEXAGONAL\""},
                        {"patternSpacing", "{\"x\":0.5,\"y\":0}"}, {"horizontalAlignment", "\"CENTER\""}});
  CHECK(paintExtras(p).sourceNodeId == Guid{1, 9});
  CHECK(paintExtras(p).tileType == PatternTileType::HORIZONTAL_HEXAGONAL);
  CHECK(paintExtras(p).patternSpacing.x == doctest::Approx(0.5));
  CHECK(paintExtras(p).horizontalAlignment == PatternAlignment::CENTER);
}

TEST_CASE("renderer: a progressive layer blur composites its layer between blurred copies, one interval per pixel") {
  Document d;
  base(d);
  NodeChange n = card({1, 1}, {10, 10, 200, 100});
  Effect blur;
  blur.type = EffectType::FOREGROUND_BLUR;
  blur.radius = 16;  // "End"
  blur.extra = effectExtra({{"blurOpType", "\"PROGRESSIVE\""}, {"startRadius", "0"}});
  n.props.effects = {blur};
  d.apply(n);
  gfx::NullDevice dev;
  Renderer r(dev);
  render(r, d);
  auto modes = composites(dev, 5);
  // σ 8 halved to 0: levels 0, 1, 2, 4, 8 → four intervals.
  REQUIRE(modes.size() == 4);
  std::set<float> sigmas = blurSigmas(dev);
  CHECK(sigmas.count(8.f));
  CHECK(sigmas.count(4.f));
  CHECK(sigmas.count(1.f));
  // Slot 19: σ from 0 at the start to 8 at the end; the intervals tile [0, 8].
  float lo = 1e9f, hi = 0;
  for (auto* c : modes) {
    CHECK(c->call.uniforms[19][0] == doctest::Approx(0));
    CHECK(c->call.uniforms[19][1] == doctest::Approx(8));
    lo = std::min(lo, c->call.uniforms[19][2]);
    hi = std::max(hi, c->call.uniforms[19][3]);
    // Figma's default direction: top to bottom of the node's box.
    CHECK(c->call.uniforms[18][1] == doctest::Approx(0));
    CHECK(c->call.uniforms[18][3] == doctest::Approx(1));
    // Slots 16–17 map canvas device px to the node's box: its top-left → (0, 0), its bottom-right → (1, 1).
    const float* A = c->call.uniforms[16];
    const float* B = c->call.uniforms[17];
    CHECK(A[0] * 10 + A[1] * 10 + A[2] == doctest::Approx(0).epsilon(1e-4));
    CHECK(B[0] * 210 + B[1] * 110 + B[2] == doctest::Approx(1).epsilon(1e-4));
  }
  CHECK(lo == doctest::Approx(0));
  CHECK(hi >= 8);
  // Uniform: one composite of the blurred layer (mode 0), no intervals.
  n.props.effects[0].extra.clear();
  d.apply(n);
  render(r, d);
  CHECK(composites(dev, 5).empty());
  CHECK(blurSigmas(dev).count(8.f));
}

TEST_CASE("renderer: a progressive background blur draws the shape once per interval; glass refracts the backdrop") {
  Document d;
  base(d);
  NodeChange n = card({1, 1}, {10, 10, 200, 100});
  n.props.fillPaints[0].opacity = 0.3;
  Effect blur;
  blur.type = EffectType::BACKGROUND_BLUR;
  blur.radius = 8;
  blur.extra = effectExtra({{"blurOpType", "\"PROGRESSIVE\""}, {"startRadius", "0"}});
  n.props.effects = {blur};
  d.apply(n);
  gfx::NullDevice dev;
  Renderer r(dev);
  int copies = dev.copies;
  render(r, d);
  // σ 4 → levels 0, 1, 2, 4: the backdrop copied for each, the shape drawn over three intervals.
  CHECK(dev.copies - copies >= 4);
  CHECK(paintKinds(dev, PaintKind::Progressive) == 3);
  bool levels = false;
  for (auto& c : dev.draws)
    if (c.pipeline.shader == gfx::ShaderId::Shape && c.call.uniforms[19][1] == doctest::Approx(4)) levels = true;
  CHECK(levels);
  // Glass: the frost blurs the backdrop (σ = 4 / 2), the shape paints it refracted (kind 8, slots 6 and 8).
  Effect glass;
  glass.type = EffectType::GLASS;
  glass.radius = 4;
  n.props.effects = {glass};
  d.apply(n);
  render(r, d);
  CHECK(paintKinds(dev, PaintKind::Glass) == 1);
  CHECK(blurSigmas(dev).count(2.f));
  bool params = false;
  for (auto& c : dev.draws)
    if (c.pipeline.shader == gfx::ShaderId::Shape && c.call.uniforms[6][0] == doctest::Approx(20)) {
      params = true;
      CHECK(c.call.uniforms[6][1] == doctest::Approx(0.8));  // Refraction 80
      CHECK(c.call.uniforms[8][2] == doctest::Approx(0.8));  // Intensity 80 %
      // Light angle −45°: the light up and to the left (canvas y down).
      CHECK(c.call.uniforms[8][0] < 0);
      CHECK(c.call.uniforms[8][1] < 0);
    }
  CHECK(params);
}

TEST_CASE("renderer: noise goes over the layer within its alpha, texture reads it through a shift, both in a layer") {
  Document d;
  base(d);
  NodeChange n = card({1, 1}, {10, 10, 100, 100});
  Effect noise;
  noise.type = EffectType::NOISE;
  noise.color = {0, 0, 0, 0.25f};
  noise.blendMode = BlendMode::MULTIPLY;
  noise.extra = effectExtra({{"noiseType", "\"MONOTONE\""}, {"density", "0.5"}, {"noiseSize", "{\"x\":2,\"y\":2}"}});
  n.props.effects = {noise};
  d.apply(n);
  gfx::NullDevice dev;
  Renderer r(dev);
  render(r, d);
  auto nm = composites(dev, 6);
  REQUIRE(nm.size() == 1);
  CHECK(nm[0]->call.uniforms[7][1] == static_cast<float>(BlendMode::MULTIPLY));
  CHECK(nm[0]->call.uniforms[18][0] == doctest::Approx(2));
  CHECK(nm[0]->call.uniforms[18][2] == doctest::Approx(0.5));
  CHECK(nm[0]->call.uniforms[18][3] == static_cast<float>(NoiseType::MONOTONE));
  CHECK(nm[0]->call.uniforms[6][3] == doctest::Approx(0.25));
  // Slots 16–17: canvas device px → node px.
  CHECK(nm[0]->call.uniforms[16][0] * 60 + nm[0]->call.uniforms[16][2] == doctest::Approx(50));

  Effect texture;
  texture.type = EffectType::GRAIN;
  texture.radius = 4;
  texture.extra = effectExtra({{"clipToShape", "true"}});
  n.props.effects = {texture};
  d.apply(n);
  render(r, d);
  auto tm = composites(dev, 7);
  REQUIRE(tm.size() == 1);
  CHECK(tm[0]->call.uniforms[18][2] == doctest::Approx(4));  // the radius in device px
  CHECK(tm[0]->call.uniforms[18][3] == 1.f);                 // clip to shape
}

TEST_CASE("renderer: NOISE paints are noise cells; PATTERN paints tile their source through the fill's shape") {
  Document d;
  base(d);
  NodeChange n = card({1, 1}, {10, 10, 100, 100});
  Paint noise;
  noise.type = PaintType::NOISE;
  noise.color = Color::hex(0x000000);
  noise.extra = paintExtra({{"noiseType", "\"MULTITONE\""}, {"density", "0.75"}, {"noiseSize", "{\"x\":4,\"y\":4}"}});
  n.props.fillPaints = {noise};
  d.apply(n);
  gfx::NullDevice dev;
  Renderer r(dev);
  render(r, d);
  REQUIRE(paintKinds(dev, PaintKind::Noise) == 1);
  for (size_t i = 0; i < dev.draws.size(); i++)
    if (dev.draws[i].pipeline.shader == gfx::ShaderId::Shape)
      for (auto& q : dev.instancesOf<DrawInstance>(i)) {
        CHECK(q.paint0[0] == doctest::Approx(0.25));  // 4 px cells
        CHECK(q.paint0[3] == doctest::Approx(0.75));
        CHECK(q.paint1[3] == static_cast<float>(NoiseType::MULTITONE));
      }

  // A 10 × 10 source tiled over a 100 × 100 rectangle at 50 % scale: 20 × 20 tiles, through the rectangle's shape.
  NodeChange source = make({1, 2}, NodeType::ELLIPSE, kPage, "\"", {300, 10, 10, 10});
  source.props.fillPaints = {Paint::solid(Color::hex(0xFF0000))};
  d.apply(source);
  Paint pattern;
  pattern.type = PaintType::PATTERN;
  pattern.scale = 0.5;
  pattern.extra = paintExtra({{"sourceNodeId", "{\"sessionID\":1,\"localID\":2}"}});
  n.props.fillPaints = {pattern};
  d.apply(n);
  render(r, d);
  size_t ellipses = 0;
  for (size_t i = 0; i < dev.draws.size(); i++)
    if (dev.draws[i].pipeline.shader == gfx::ShaderId::Shape)
      for (auto& q : dev.instancesOf<DrawInstance>(i)) ellipses += q.geom[2] == static_cast<float>(ShapeKind::Ellipse);
  CHECK(ellipses == 20 * 20 + 1);  // the tiles and the source itself
  CHECK(composites(dev, 1).size() == 1);
  // Spacing 100 %: every other place is empty.
  n.props.fillPaints[0].extra = paintExtra({{"sourceNodeId", "{\"sessionID\":1,\"localID\":2}"}, {"patternSpacing", "{\"x\":1,\"y\":1}"}});
  d.apply(n);
  render(r, d);
  ellipses = 0;
  for (size_t i = 0; i < dev.draws.size(); i++)
    if (dev.draws[i].pipeline.shader == gfx::ShaderId::Shape)
      for (auto& q : dev.instancesOf<DrawInstance>(i)) ellipses += q.geom[2] == static_cast<float>(ShapeKind::Ellipse);
  CHECK(ellipses == 10 * 10 + 1);
}
