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

// The tent blur passes' radii (texels of the layer they blur).
std::set<float> blurRadii(const gfx::NullDevice& dev) {
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
  // Radius 16 halved to 0: levels 0, 2, 4, 8, 16 → four intervals.
  REQUIRE(modes.size() == 4);
  // The tent's radius in texels: 16 and 8 on the layer halved once (Figma's ×2 level above 4 texels), 4 and 2 as is.
  std::set<float> radii = blurRadii(dev);
  CHECK(radii == std::set<float>{8.f, 4.f, 2.f});
  // Slot 19: the radius from 0 at the start to 16 at the end; the intervals tile [0, 16].
  float lo = 1e9f, hi = 0;
  for (auto* c : modes) {
    CHECK(c->call.uniforms[19][0] == doctest::Approx(0));
    CHECK(c->call.uniforms[19][1] == doctest::Approx(16));
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
  CHECK(hi >= 16);
  // Uniform: one composite of the blurred layer (mode 0), no intervals.
  n.props.effects[0].extra.clear();
  d.apply(n);
  render(r, d);
  CHECK(composites(dev, 5).empty());
  CHECK(blurRadii(dev) == std::set<float>{8.f});
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
  // Radius 8 → levels 0, 2, 4, 8: the backdrop copied for each, the shape drawn over three intervals.
  CHECK(dev.copies - copies >= 4);
  CHECK(paintKinds(dev, PaintKind::Progressive) == 3);
  bool levels = false;
  for (auto& c : dev.draws)
    if (c.pipeline.shader == gfx::ShaderId::Shape && c.call.uniforms[19][1] == doctest::Approx(8)) levels = true;
  CHECK(levels);
  // Glass: the frost blurs the backdrop (a tent of radius 4), the shape paints it refracted (kind 8, slots 6 and 8):
  // Depth 20 (refractionRadius, Figma's default), Splay 0 (reflectionDistance).
  Effect glass;
  glass.type = EffectType::GLASS;
  glass.radius = 4;
  n.props.effects = {glass};
  d.apply(n);
  render(r, d);
  CHECK(paintKinds(dev, PaintKind::Glass) == 1);
  CHECK(blurRadii(dev).count(4.f));
  bool params = false;
  for (auto& c : dev.draws)
    if (c.pipeline.shader == gfx::ShaderId::Shape && c.call.uniforms[6][0] == doctest::Approx(20)) {
      params = true;
      CHECK(c.call.uniforms[6][1] == doctest::Approx(0.8));  // Refraction 80
      CHECK(c.call.uniforms[6][3] == doctest::Approx(0));    // Splay 0
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

TEST_CASE("render tree: a change to a pattern's source, or inside it, on any page, damages the layers that tile it") {
  Document d;
  base(d);
  const Guid kOther{0, 7};
  NodeProps other;
  other.type = NodeType::CANVAS;
  other.name = "Page 2";
  other.parentIndex = {kDoc, "\""};
  d.apply(NodeChange::created(kOther, other));
  // The source: a frame with an ellipse in it, on page 2; the user: a rectangle on page 1 tiling it.
  NodeChange frame = make({1, 2}, NodeType::FRAME, kOther, "!", {300, 10, 10, 10});
  d.apply(frame);
  NodeChange dot = make({1, 3}, NodeType::ELLIPSE, {1, 2}, "!", {0, 0, 10, 10});
  dot.props.fillPaints = {Paint::solid(Color::hex(0xFF0000))};
  d.apply(dot);
  NodeChange user = card({1, 1}, {10, 10, 100, 100});
  Paint pattern;
  pattern.type = PaintType::PATTERN;
  pattern.extra = paintExtra({{"sourceNodeId", "{\"sessionID\":1,\"localID\":2}"}});
  user.props.fillPaints = {pattern};
  d.apply(user);
  NodeChange plain = card({1, 4}, {500, 500, 20, 20});
  d.apply(plain);
  RenderTree t;
  t.sync(d, kPage);
  (void)t.takeDamage();
  auto damagedUser = [&](const RenderTree::Damage& dmg) {
    for (const Rect& r : dmg.rects)
      if (r.x <= 10 && r.y <= 10 && r.right() >= 110 && r.bottom() >= 110) return true;
    return dmg.all;
  };
  // The ellipse inside the source changes colour: the user is damaged (the source is on another page).
  NodeChange c = NodeChange::changed({1, 3});
  c.mask = F_FILLS;
  c.props.fillPaints = {Paint::solid(Color::hex(0x00FF00))};
  d.apply(c);
  t.sync(d, kPage);
  CHECK(damagedUser(t.takeDamage()));
  // A change elsewhere doesn't touch it.
  NodeChange p = NodeChange::changed({1, 4});
  p.mask = F_FILLS;
  p.props.fillPaints = {Paint::solid(Color::hex(0x000000))};
  d.apply(p);
  t.sync(d, kPage);
  CHECK_FALSE(damagedUser(t.takeDamage()));
  // The ellipse taken out of the source: damaged too.
  d.apply(NodeChange::removed({1, 3}));
  t.sync(d, kPage);
  CHECK(damagedUser(t.takeDamage()));
  // No longer a pattern: the source's changes don't reach it any more.
  NodeChange u = NodeChange::changed({1, 1});
  u.mask = F_FILLS;
  u.props.fillPaints = {Paint::solid(Color::hex(0x3366FF))};
  d.apply(u);
  t.sync(d, kPage);
  (void)t.takeDamage();
  NodeChange f = NodeChange::changed({1, 2});
  f.mask = F_FILLS;
  f.props.fillPaints = {Paint::solid(Color::hex(0x00FF00))};
  d.apply(f);
  t.sync(d, kPage);
  CHECK_FALSE(damagedUser(t.takeDamage()));
}

// ---- Round 17 (docs/research/rea/effects.md): Figma's glass fields, visibility rules, blur reach and bounds ----------

TEST_CASE("extras: glass in Figma's fields (Depth = refractionRadius, Splay = reflectionDistance); absent fields as Figma reads them") {
  // A glass with no fields of its own: Figma's new glass.
  Effect g;
  g.type = EffectType::GLASS;
  CHECK(effectExtras(g).refractionRadius == doctest::Approx(20));
  CHECK(effectExtras(g).bevelSize == doctest::Approx(1));
  CHECK(effectExtras(g).reflectionDistance == doctest::Approx(0));
  CHECK(effectExtras(g).specularAngle == doctest::Approx(-45));
  // Figma's own fields read as they are.
  g.extra = effectExtra({{"refractionRadius", "40"}, {"bevelSize", "1"}, {"reflectionDistance", "0.5"}});
  CHECK(effectExtras(g).refractionRadius == doctest::Approx(40));
  CHECK(effectExtras(g).reflectionDistance == doctest::Approx(0.5));
  // Wecra's glass before round 17: Depth 30 in bevelSize, Splay 50 (0–100) in refractionRadius.
  g.extra = effectExtra({{"bevelSize", "30"}, {"refractionRadius", "50"}});
  CHECK(effectExtras(g).refractionRadius == doctest::Approx(30));
  CHECK(effectExtras(g).reflectionDistance == doctest::Approx(0.5));
  CHECK(effectExtras(g).bevelSize == doctest::Approx(1));
  // Noise / texture fields left out: Figma's Effect defaults (size 0, Multi opacity 0).
  Effect n;
  n.type = EffectType::NOISE;
  n.extra = effectExtra({{"noiseType", "\"MULTITONE\""}});
  CHECK(effectExtras(n).noiseSize.x == doctest::Approx(0));
  CHECK(effectExtras(n).opacity == doctest::Approx(0));
}

TEST_CASE("effects: Figma's visibility rules (isVisibleForRendering) per type") {
  Effect drop;
  drop.type = EffectType::DROP_SHADOW;
  drop.color = {0, 0, 0, 0.25f};
  CHECK(visibleForRendering(drop));
  drop.visible = false;
  CHECK_FALSE(visibleForRendering(drop));
  drop.visible = true;
  drop.color.a = 0;
  CHECK_FALSE(visibleForRendering(drop));  // a transparent shadow draws nothing

  // An inner shadow also needs a blur, an offset or a positive spread.
  Effect inner;
  inner.type = EffectType::INNER_SHADOW;
  inner.color = {0, 0, 0, 0.25f};
  CHECK_FALSE(visibleForRendering(inner));
  inner.spread = -2;
  CHECK_FALSE(visibleForRendering(inner));
  inner.spread = 2;
  CHECK(visibleForRendering(inner));
  inner.spread = 0;
  inner.offset = {0, 1};
  CHECK(visibleForRendering(inner));
  inner.offset = {};
  inner.radius = 1;
  CHECK(visibleForRendering(inner));

  // Blurs need a radius (a progressive one its start will do), texture a radius.
  for (EffectType t : {EffectType::FOREGROUND_BLUR, EffectType::BACKGROUND_BLUR}) {
    Effect b;
    b.type = t;
    CHECK_FALSE(visibleForRendering(b));
    b.extra = effectExtra({{"blurOpType", "\"PROGRESSIVE\""}, {"startRadius", "4"}});
    CHECK(visibleForRendering(b));
  }
  Effect grain;
  grain.type = EffectType::GRAIN;
  CHECK_FALSE(visibleForRendering(grain));
  grain.radius = 1;
  CHECK(visibleForRendering(grain));
  // Noise and glass: on is enough.
  for (EffectType t : {EffectType::NOISE, EffectType::GLASS}) {
    Effect e;
    e.type = t;
    CHECK(visibleForRendering(e));
    e.visible = false;
    CHECK_FALSE(visibleForRendering(e));
  }

  // The renderer: an inner shadow that draws nothing takes no layer, nor does a transparent drop shadow.
  Document d;
  base(d);
  NodeChange c = card({1, 1}, {10, 10, 100, 100});
  c.props.strokePaints = {Paint::solid(Color::hex(0x000000))};
  c.props.strokeWeight = 2;
  inner.radius = 0;
  drop.color.a = 0;
  c.props.effects = {inner, drop};
  d.apply(c);
  gfx::NullDevice dev;
  Renderer r(dev);
  CHECK(r.render(d, kPage, Camera{}, {800, 600, 1, 800, 600}, Overlay{}, kDark).layers == 0);
}

TEST_CASE("effects: the render bounds — a shadow's offset on its side only, layer blurs summed") {
  Document d;
  base(d);
  NodeChange n = card({1, 1}, {10, 10, 100, 100});
  Effect drop;
  drop.type = EffectType::DROP_SHADOW;
  drop.color = {0, 0, 0, 0.25f};
  drop.offset = {10, -6};
  drop.radius = 4;
  drop.spread = 2;
  Effect b1, b2;
  b1.type = b2.type = EffectType::FOREGROUND_BLUR;
  b1.radius = 3;
  b2.radius = 5;
  n.props.effects = {drop, b1, b2};
  d.apply(n);
  // The box grown by the blurs (3 + 5); the shadow: the box offset (10, −6), grown by 4 + 2 and the blurs.
  Rect b = d.renderBounds({1, 1});
  CHECK(b.x == doctest::Approx(2));
  CHECK(b.y == doctest::Approx(-10));
  CHECK(b.right() == doctest::Approx(134));
  CHECK(b.bottom() == doctest::Approx(118));
  // A spread the node doesn't take (a frame that doesn't clip) isn't drawn, so it doesn't shrink the reach either: a
  // radius-10 shadow with spread −8 still reaches 10.
  {
    NodeChange f = make({1, 2}, NodeType::FRAME, kPage, "\"", {300, 10, 100, 100});
    f.props.fillPaints = {Paint::solid(Color::hex(0x3366FF))};
    f.props.frameMaskDisabled = true;
    Effect s = drop;
    s.offset = {};
    s.radius = 10;
    s.spread = -8;
    f.props.effects = {s};
    d.apply(f);
    CHECK(d.renderBounds({1, 2}) == Rect{290, 0, 120, 120});
    f.props.frameMaskDisabled = false;  // clipping, with a fill: the spread is drawn, the shadow reaches 2
    d.apply(f);
    CHECK(d.renderBounds({1, 2}) == Rect{298, 8, 104, 104});
  }
  // An inner shadow, a background blur and a texture clipped to the shape don't grow it.
  Effect in, bg, grain;
  in.type = EffectType::INNER_SHADOW;
  in.radius = 30;
  bg.type = EffectType::BACKGROUND_BLUR;
  bg.radius = 30;
  grain.type = EffectType::GRAIN;
  grain.radius = 30;
  grain.extra = effectExtra({{"clipToShape", "true"}});
  n.props.effects = {in, bg, grain};
  d.apply(n);
  CHECK(d.renderBounds({1, 1}) == Rect{10, 10, 100, 100});
  // Unclipped, the texture spreads past the layer by its radius.
  n.props.effects[2].extra.clear();
  d.apply(n);
  CHECK(d.renderBounds({1, 1}).x == doctest::Approx(-20));
}

TEST_CASE("renderer: Figma's tent blur reaches its radius (R = 20 → ~20 px), not 3σ = 30") {
  // A layer blur of 20 at 100 %: the bounds grow by 20, the tent runs on the layer halved once (10 texels).
  Document d;
  base(d);
  NodeChange n = card({1, 1}, {100, 100, 100, 100});
  Effect blur;
  blur.type = EffectType::FOREGROUND_BLUR;
  blur.radius = 20;
  n.props.effects = {blur};
  d.apply(n);
  CHECK(d.renderBounds({1, 1}) == Rect{80, 80, 140, 140});
  gfx::NullDevice dev;
  Renderer r(dev);
  render(r, d);
  CHECK(blurRadii(dev) == std::set<float>{10.f});
  // A blur under one device px is skipped (Figma's).
  n.props.effects[0].radius = 0.5;
  d.apply(n);
  render(r, d);
  CHECK(blurRadii(dev).empty());

  // A background blur of 20: the backdrop copied 20 px (+ 2 for the ×2 level's bilinear reads) past the box.
  n.props.fillPaints[0].opacity = 0.3;
  n.props.effects[0].type = EffectType::BACKGROUND_BLUR;
  n.props.effects[0].radius = 20;
  d.apply(n);
  int before = static_cast<int>(dev.copyRects.size());
  render(r, d);
  REQUIRE(static_cast<int>(dev.copyRects.size()) > before);
  CHECK(dev.copyRects.back().w == 144);
  CHECK(dev.copyRects.back().h == 144);

  // The analytic drop shadow: its blur radius in the instance (the tent's half-width), the box offset.
  Effect drop;
  drop.type = EffectType::DROP_SHADOW;
  drop.color = {0, 0, 0, 0.25f};
  drop.offset = {0, 4};
  drop.radius = 20;
  n.props.fillPaints[0].opacity = 1;
  n.props.effects = {drop};
  d.apply(n);
  render(r, d);
  bool found = false;
  for (size_t i = 0; i < dev.draws.size(); i++) {
    if (dev.draws[i].pipeline.shader != gfx::ShaderId::Shape) continue;
    for (auto& q : dev.instancesOf<DrawInstance>(i))
      if (q.geom[2] == static_cast<float>(ShapeKind::DropShadow)) {
        found = true;
        CHECK(q.geom[0] == doctest::Approx(20));
      }
  }
  CHECK(found);
}
