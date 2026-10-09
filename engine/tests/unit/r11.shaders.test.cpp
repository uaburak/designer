// Round 11: Figma's shader fills and effects (Paint / Effect type CUSTOM, customEffectId + componentPropAssignments;
// src/shared/shaders/presets.json) on the recording device — the preset and its parameters decoded from the paint's /
// effect's `extra`, the Custom program's quad with its uniform slots (gfx/gl/CustomShader.h), a fill through the
// node's shape, an effect reading the layer under it and reaching past it, the kiwi round trip. The pixels are
// checked by scripts/engine-shot.mjs on both GPU backends.
#include <cmath>
#include <string>

#include "doctest.h"
#include "editor/Editor.h"
#include "gfx/null/NullDevice.h"
#include "Helpers.h"
#include "TextHelpers.h"
#include "render/Renderer.h"
#include "render/shader_presets.h"
#include "scene/CodecKiwi.h"
#include "scene/Extras.h"

using namespace eng;
using namespace eng::test;

namespace {

const OverlayStyle kDark = OverlayStyle::of(Theme::Dark);

std::string extraOf(const char* def, std::initializer_list<std::pair<const char*, const char*>> members) {
  std::string out;
  for (auto& [k, v] : members) {
    json::Value j;
    REQUIRE(json::parse(v, j));
    out += codec::extraFromJson(def, k, j);
  }
  return out;
}

// A preset by key, as the panels write it: customEffectId.assetRef.key and the parameters assigned (JSON).
std::string shaderExtra(const char* def, const char* key, const char* assignments = "[]") {
  std::string id = std::string("{\"assetRef\":{\"key\":\"") + key + "\",\"version\":\"\"}}";
  return extraOf(def, {{"customEffectId", id.c_str()}, {"componentPropAssignments", assignments}});
}

void render(Renderer& r, const Document& d) { r.render(d, kPage, Camera{}, {800, 600, 1, 800, 600}, Overlay{}, kDark); }

std::vector<const gfx::NullDevice::Recorded*> customs(const gfx::NullDevice& dev) {
  std::vector<const gfx::NullDevice::Recorded*> out;
  for (auto& c : dev.draws)
    if (c.pipeline.shader == gfx::ShaderId::Custom) out.push_back(&c);
  return out;
}

size_t composites(const gfx::NullDevice& dev, int mode) {
  size_t n = 0;
  for (auto& c : dev.draws) n += c.pipeline.shader == gfx::ShaderId::Composite && c.call.uniforms[7][2] == static_cast<float>(mode);
  return n;
}

NodeChange card(Guid id, Rect r) {
  NodeChange n = make(id, NodeType::ROUNDED_RECTANGLE, kPage, "!", r);
  n.props.fillPaints = {Paint::solid(Color::hex(0x3366FF))};
  return n;
}

}  // namespace

TEST_CASE("shader presets: Figma's 10 fills and 25 effects, live's names, in the browsers' order") {
  CHECK(shaders::kFillPresets == 10);
  CHECK(shaders::kEffectPresets == 25);
  CHECK(std::string(shaders::kPresets[0].name) == "Moving gradient");
  CHECK(std::string(shaders::kPresets[9].name) == "Pattern grid");
  CHECK(std::string(shaders::kPresets[10].name) == "Shape-based particles");
  CHECK(std::string(shaders::kPresets[34].name) == "Filter presets");
  for (const shaders::PresetDef& p : shaders::kPresets) {
    int colors = 0, others = 0;
    for (int i = 0; i < p.count; i++) (p.params[i].type == shaders::ParamType::Color ? colors : others)++;
    CHECK(colors <= 6);   // uniform slots 8–13
    CHECK(others <= 24);  // slots 14–19
  }
}

TEST_CASE("extras: a shader's preset and parameters decode from `extra`, its defaults where unassigned") {
  Paint p;
  p.type = PaintType::CUSTOM;
  CHECK(shaderOf(p).preset == nullptr);
  p.extra = shaderExtra("Paint", "shader.mesh-gradient",
                        "[{\"defID\":{\"sessionID\":0,\"localID\":5},\"value\":{\"floatValue\":80}},"
                        "{\"defID\":\"0:1\",\"varValue\":{\"dataType\":\"COLOR\",\"resolvedDataType\":\"COLOR\",\"value\":{\"colorValue\":{\"r\":1,\"g\":0,\"b\":0,\"a\":0.5}}}}]");
  const ShaderSetup& s = shaderOf(p);
  REQUIRE(s.preset != nullptr);
  CHECK(std::string(s.preset->name) == "Mesh gradient");
  CHECK_FALSE(s.preset->effect);
  CHECK(s.values[0][0] == doctest::Approx(1));    // Top left, assigned
  CHECK(s.values[0][3] == doctest::Approx(0.5));
  CHECK(s.values[4][0] == doctest::Approx(80));   // Distortion, assigned
  CHECK(s.values[5][0] == doctest::Approx(30));   // Swirl, the default
  // A preset this engine doesn't know: none (not drawn).
  p.extra = shaderExtra("Paint", "shader.unknown");
  CHECK(shaderOf(p).preset == nullptr);

  Effect e;
  e.type = EffectType::CUSTOM;
  e.extra = shaderExtra("Effect", "shader.shape-based-particles", "[{\"defID\":\"0:3\",\"value\":{\"floatValue\":40}}]");
  REQUIRE(shaderOf(e).preset != nullptr);
  CHECK(shaderOf(e).preset->effect);
  CHECK(shaderReach(shaderOf(e)) == doctest::Approx(40 + 4));  // spread + size
}

TEST_CASE("renderer: a shader fill is the Custom program's quad over the node, through the node's shape") {
  Document d;
  base(d);
  NodeChange n = card({1, 1}, {10, 20, 100, 50});
  Paint fill;
  fill.type = PaintType::CUSTOM;
  fill.extra = shaderExtra("Paint", "shader.mesh-gradient", "[{\"defID\":\"0:5\",\"value\":{\"floatValue\":80}}]");
  n.props.fillPaints = {fill};
  d.apply(n);
  gfx::NullDevice dev;
  Renderer r(dev);
  render(r, d);
  auto c = customs(dev);
  REQUIRE(c.size() == 1);
  const auto& u = c[0]->call.uniforms;
  CHECK(u[6][0] == 1.f);  // Mesh gradient's program
  CHECK(u[6][1] == 0.f);  // a fill
  CHECK(u[6][2] == doctest::Approx(100));
  CHECK(u[6][3] == doctest::Approx(50));
  // Slots 4–5: canvas device px → the node's px (its top left at 10, 20).
  CHECK(u[4][0] * 60 + u[4][2] == doctest::Approx(50));
  CHECK(u[5][1] * 45 + u[5][2] == doctest::Approx(25));
  // The colours from slot 8 (Top left #4F46E5), the others from 14 (Distortion 80, Swirl 30).
  CHECK(u[8][0] == doctest::Approx(0x4F / 255.0));
  CHECK(u[8][3] == doctest::Approx(1));
  CHECK(u[14][0] == doctest::Approx(80));
  CHECK(u[14][1] == doctest::Approx(30));
  // Through the shape: one masked composite.
  CHECK(composites(dev, 1) == 1);
  // Hidden: nothing.
  n.props.fillPaints[0].visible = false;
  d.apply(n);
  render(r, d);
  CHECK(customs(dev).empty());
}

TEST_CASE("renderer: a text's shader fill is drawn through its glyphs") {
  // Inter bound here without loadInter()'s once-only flag: tests that run later (r7–r9) reset the registry, and the
  // text tests after them must still load it.
  {
    auto& fonts = text::FontRegistry::get();
    int32_t face = addFontFile(interPath());
    fonts.bind("Inter", "Regular", face);
    fonts.takeRequests();
  }
  auto nodes = baseChanges();
  NodeChange t = make({1, 1}, NodeType::TEXT, kPage, "!", {10, 10, 120, 30}, "Hi");
  t.props.text().textData.characters = "Shader";
  t.props.text().fontSize = 24;
  Paint fill;
  fill.type = PaintType::CUSTOM;
  fill.extra = shaderExtra("Paint", "shader.moving-gradient");
  t.props.fillPaints = {fill};
  nodes.push_back(t);
  Editor e;
  e.setViewport(400, 300, 1, 400, 300);
  e.loadDocument(nodes, kNoGuid);
  gfx::NullDevice device;
  Renderer r(device);
  r.setTextLayouts(&e);
  Overlay none;
  none.frameTitles = false;
  RenderStats stats = r.render(e.document(), e.page(), e.camera(), e.viewport(), none, OverlayStyle::of(Theme::Light));
  CHECK(customs(device).size() == 1);
  CHECK(composites(device, 1) == 1);  // through the glyphs
  CHECK(stats.paths >= 5);            // the glyphs, white, in the mask
}

TEST_CASE("renderer: a shader effect reads the layer under it, reaches past it, and effects stack in order") {
  Document d;
  base(d);
  NodeChange n = card({1, 1}, {100, 100, 100, 100});
  Effect halftone;
  halftone.type = EffectType::CUSTOM;
  halftone.extra = shaderExtra("Effect", "shader.halftone");
  n.props.effects = {halftone};
  d.apply(n);
  gfx::NullDevice dev;
  Renderer r(dev);
  render(r, d);
  auto c = customs(dev);
  REQUIRE(c.size() == 1);
  CHECK(c[0]->call.uniforms[6][0] == 2.f);  // Halftone
  CHECK(c[0]->call.uniforms[6][1] == 1.f);  // an effect
  CHECK(c[0]->call.textures[0] != 0);
  CHECK(c[0]->call.uniforms[14][0] == doctest::Approx(8));   // Dot size
  CHECK(c[0]->call.uniforms[14][1] == doctest::Approx(45));  // Angle
  CHECK(c[0]->call.uniforms[8][3] == doctest::Approx(1));    // Ink #000000

  // Particles spread 20 px past the layer: the effect's quad reaches past the 100 px box.
  Effect particles;
  particles.type = EffectType::CUSTOM;
  particles.extra = shaderExtra("Effect", "shader.shape-based-particles");
  n.props.effects = {particles, halftone};
  d.apply(n);
  render(r, d);
  c = customs(dev);
  REQUIRE(c.size() == 2);
  float w = c[0]->call.uniforms[2][2] - c[0]->call.uniforms[2][0];
  CHECK(w >= 100 + 2 * 24);
  // The second reads the first's layer.
  CHECK(c[1]->call.textures[0] != c[0]->call.textures[0]);
  CHECK(c[0]->call.uniforms[6][0] == 0.f);
  CHECK(c[1]->call.uniforms[6][0] == 2.f);
  // The document's bounds grow by the reach (damage, culling).
  CHECK(d.renderBounds({1, 1}).w >= 100 + 2 * 24 - 0.01);
}

TEST_CASE("codecs: CUSTOM paints and effects round-trip through kiwi with their shader") {
  NodeChange n = card({1, 1}, {0, 0, 10, 10});
  Paint fill;
  fill.type = PaintType::CUSTOM;
  fill.extra = shaderExtra("Paint", "shader.nebula", "[{\"defID\":\"0:4\",\"value\":{\"floatValue\":120}}]");
  n.props.fillPaints = {fill};
  Effect e;
  e.type = EffectType::CUSTOM;
  e.extra = shaderExtra("Effect", "shader.bloom");
  n.props.effects = {e};
  std::string bytes = codec::writeMessage(1, {n});
  codec::KiwiMessage m;
  REQUIRE(codec::readMessage(bytes, m));
  REQUIRE(m.changes.size() == 1);
  const NodeProps& p = m.changes[0].props;
  REQUIRE(p.fillPaints.size() == 1);
  CHECK(p.fillPaints[0].type == PaintType::CUSTOM);
  REQUIRE(shaderOf(p.fillPaints[0]).preset != nullptr);
  CHECK(std::string(shaderOf(p.fillPaints[0]).preset->name) == "Nebula");
  CHECK(shaderOf(p.fillPaints[0]).values[3][0] == doctest::Approx(120));
  REQUIRE(p.effects.size() == 1);
  CHECK(p.effects[0].type == EffectType::CUSTOM);
  CHECK(std::string(enumName(p.effects[0].type)) == "CUSTOM");
  CHECK(std::string(shaderOf(p.effects[0]).preset->name) == "Bloom");
}
