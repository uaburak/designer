// Drawing text: glyph instances on the Path pipeline with their curves in the
// curve cache's texture; decorations as shapes; overlay labels (the size badge).
#include "doctest.h"
#include "editor/Editor.h"
#include "gfx/null/NullDevice.h"
#include "Helpers.h"
#include "render/Renderer.h"
#include "TextHelpers.h"

using namespace eng;
using namespace eng::test;

TEST_CASE("render: a text node draws one glyph instance per visible glyph, curves uploaded") {
  loadInter();
  auto nodes = baseChanges();
  NodeChange t = make({1, 1}, NodeType::TEXT, kPage, "!", {10, 10, 60, 15}, "Hi");
  t.props.textData.characters = "Hi you";
  t.props.textDecoration = TextDecoration::UNDERLINE;
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
  CHECK(stats.glyphs == 5);  // the space has no outline
  bool glyphDraw = false;
  for (auto& d : device.draws)
    if (d.pipeline.shader == gfx::ShaderId::Shape) {
      auto inst = device.instancesOf<DrawInstance>(static_cast<size_t>(&d - &device.draws[0]));
      for (auto& q : inst) {
        if (q.geom[2] != static_cast<float>(ShapeKind::Path) || glyphDraw) continue;
        glyphDraw = true;
        CHECK(d.call.textures[0] != 0);
        CHECK(q.linear[0] == doctest::Approx(12));  // em → px: the font size
        CHECK(q.color[3] == doctest::Approx(1));
        const auto& tex = device.texture(d.call.textures[0]);
        CHECK(tex.width == CurveCache::kWidth);
      }
    }
  CHECK(glyphDraw);
  CHECK(r.curveCache().glyphCount() == 6);  // H, i, space (no curves), y, o, u
  CHECK(stats.shapes >= 1);  // the underline
}

TEST_CASE("render: the selection's size badge has its text") {
  loadInter();
  auto nodes = baseChanges();
  nodes.push_back(make({1, 1}, NodeType::FRAME, kPage, "!", {10, 10, 120, 80}, "Frame 1"));
  Editor e;
  e.setViewport(400, 300, 1, 400, 300);
  e.loadDocument(nodes, kNoGuid);
  e.setSelection({{1, 1}});
  gfx::NullDevice device;
  Renderer r(device);
  r.setTextLayouts(&e);
  RenderStats stats = r.render(e.document(), e.page(), e.camera(), e.viewport(), e.overlay(), OverlayStyle::of(Theme::Dark));
  // "120 × 80" (6 glyphs with outlines) and the title "Frame 1" (6).
  CHECK(stats.glyphs == 12);
  const text::TextLayout* badge = r.label("120 × 80", "Medium", 11);
  REQUIRE(badge);
  CHECK(badge->size.x > 30);
}
