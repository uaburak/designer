// ⌘-resize crops an image fill (Figma; docs/engine.md "Resize gestures"): the picture stays where it is on the page,
// the dragged side shows more or less of it, the paint becomes Crop (STRETCH). A plain drag still scales it.

#include <cmath>

#include "doctest.h"
#include "editor/Editor.h"
#include "export/Scene.h"
#include "Helpers.h"

using namespace eng;
using namespace eng::test;

namespace {

const Guid IMG{1, 1}, FR{1, 2}, CHILD{1, 3};

Paint imagePaint(ImageScaleMode mode) {
  Paint p;
  p.type = PaintType::IMAGE;
  p.image.present = true;
  p.image.bytes[0] = 7;
  p.imageScaleMode = mode;
  p.originalImageWidth = 400;  // a square picture in a 200×100 layer: FILL shows its middle band
  p.originalImageHeight = 400;
  return p;
}

Editor makeEditor(ImageScaleMode mode = ImageScaleMode::FILL) {
  auto nodes = baseChanges();
  NodeChange img = make(IMG, NodeType::ROUNDED_RECTANGLE, kPage, "!", {100, 100, 200, 100}, "Image");
  img.props.fillPaints = {imagePaint(mode)};
  nodes.push_back(img);
  // A frame with an image fill and a child, far from the image.
  NodeChange fr = make(FR, NodeType::FRAME, kPage, "\"", {100, 400, 200, 100}, "Frame");
  fr.props.fillPaints = {imagePaint(ImageScaleMode::FILL)};
  nodes.push_back(fr);
  nodes.push_back(make(CHILD, NodeType::ROUNDED_RECTANGLE, FR, "!", {150, 20, 40, 40}, "Child"));
  Editor e;
  e.setViewport(800, 600, 2, 1600, 1200);
  e.loadDocument(nodes, kNoGuid);
  e.takeEvents();
  return e;
}

void drag(Editor& e, Vec2 from, Vec2 to, uint32_t mods, uint32_t lastMods) {
  e.pointer(PointerEvent::DOWN, from.x, from.y, 0, 1, mods);
  for (int i = 1; i <= 4; i++) {
    double t = i / 4.0;
    e.pointer(PointerEvent::MOVE, from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, 0, 1, i == 4 ? lastMods : mods);
  }
  e.pointer(PointerEvent::UP, to.x, to.y, 0, 0, lastMods);
}
void drag(Editor& e, Vec2 from, Vec2 to, uint32_t mods = 0) { drag(e, from, to, mods, mods); }

const NodeProps& props(const Editor& e, Guid id) { return e.document().get(id)->props; }

// Where a page point falls in the layer's picture (uv, 0…1).
Vec2 uvAt(const Editor& e, Guid id, Vec2 world) {
  const NodeProps& p = props(e, id);
  Mat2x3 m = exporter::imageMatrix(p.fillPaints[0], p.size, 400, 400) * e.document().worldTransform(id).inverse();
  return m.apply(world);
}

void checkSamePixels(const Editor& e, Guid id, const std::vector<Vec2>& before, const std::vector<Vec2>& points) {
  for (size_t i = 0; i < points.size(); i++) {
    Vec2 uv = uvAt(e, id, points[i]);
    CHECK(uv.x == doctest::Approx(before[i].x));
    CHECK(uv.y == doctest::Approx(before[i].y));
  }
}

}  // namespace

TEST_CASE("crop: ⌘-drag of the right edge narrows the layer, the picture stays put") {
  Editor e = makeEditor();
  e.setSelection({IMG});
  std::vector<Vec2> pts{{150, 120}, {240, 180}, {120, 150}};
  std::vector<Vec2> before;
  for (Vec2 p : pts) before.push_back(uvAt(e, IMG, p));
  drag(e, {300, 150}, {250, 150}, MOD_META | MOD_PRIMARY);
  CHECK(props(e, IMG).size == Vec2{150, 100});
  CHECK(props(e, IMG).transform.m02 == 100);
  CHECK(props(e, IMG).fillPaints[0].imageScaleMode == ImageScaleMode::STRETCH);
  checkSamePixels(e, IMG, before, pts);
  // One undo step: the size and the paint come back.
  e.command(CommandId::UNDO);
  CHECK(props(e, IMG).size == Vec2{200, 100});
  CHECK(props(e, IMG).fillPaints[0].imageScaleMode == ImageScaleMode::FILL);
}

TEST_CASE("crop: ⌘-drag of the left edge crops from the left") {
  Editor e = makeEditor();
  e.setSelection({IMG});
  std::vector<Vec2> pts{{150, 120}, {240, 180}, {290, 110}};
  std::vector<Vec2> before;
  for (Vec2 p : pts) before.push_back(uvAt(e, IMG, p));
  drag(e, {100, 150}, {140, 150}, MOD_PRIMARY);  // Ctrl on Windows arrives as PRIMARY too
  CHECK(props(e, IMG).size == Vec2{160, 100});
  CHECK(props(e, IMG).transform.m02 == 140);
  checkSamePixels(e, IMG, before, pts);
  // Growing past the picture's edge again (a crop of a crop): still the same pixels where they are.
  drag(e, {140, 150}, {60, 150}, MOD_PRIMARY);
  CHECK(props(e, IMG).size == Vec2{240, 100});
  checkSamePixels(e, IMG, before, pts);
}

TEST_CASE("crop: a corner crops both sides; FIT and Crop paints crop too; TILE is left as it is") {
  for (ImageScaleMode mode : {ImageScaleMode::FIT, ImageScaleMode::STRETCH}) {
    Editor e = makeEditor(mode);
    e.setSelection({IMG});
    std::vector<Vec2> pts{{150, 120}, {200, 150}};
    std::vector<Vec2> before;
    for (Vec2 p : pts) before.push_back(uvAt(e, IMG, p));
    drag(e, {300, 200}, {260, 170}, MOD_PRIMARY);
    CHECK(props(e, IMG).size == Vec2{160, 70});
    CHECK(props(e, IMG).fillPaints[0].imageScaleMode == ImageScaleMode::STRETCH);
    checkSamePixels(e, IMG, before, pts);
  }
  Editor e = makeEditor(ImageScaleMode::TILE);
  e.setSelection({IMG});
  drag(e, {300, 150}, {250, 150}, MOD_PRIMARY);
  CHECK(props(e, IMG).size == Vec2{150, 100});
  CHECK(props(e, IMG).fillPaints[0].imageScaleMode == ImageScaleMode::TILE);
}

TEST_CASE("crop: a plain drag still scales the picture; letting ⌘ go mid-drag gives the plain resize back") {
  Editor e = makeEditor();
  e.setSelection({IMG});
  drag(e, {300, 150}, {250, 150});
  CHECK(props(e, IMG).size == Vec2{150, 100});
  CHECK(props(e, IMG).fillPaints[0].imageScaleMode == ImageScaleMode::FILL);
  e.command(CommandId::UNDO);
  drag(e, {300, 150}, {250, 150}, MOD_PRIMARY, 0);
  CHECK(props(e, IMG).size == Vec2{150, 100});
  CHECK(props(e, IMG).fillPaints[0].imageScaleMode == ImageScaleMode::FILL);
}

TEST_CASE("crop: ⌘-resize of a frame crops its image fill and leaves its children where they are") {
  Editor e = makeEditor();
  e.setSelection({FR});
  Vec2 childBefore = e.document().worldTransform(CHILD).apply({0, 0});
  std::vector<Vec2> pts{{180, 450}, {270, 480}};
  std::vector<Vec2> before;
  for (Vec2 p : pts) before.push_back(uvAt(e, FR, p));
  drag(e, {100, 450}, {130, 450}, MOD_PRIMARY);
  CHECK(props(e, FR).size == Vec2{170, 100});
  checkSamePixels(e, FR, before, pts);
  Vec2 childAfter = e.document().worldTransform(CHILD).apply({0, 0});
  CHECK(childAfter.x == doctest::Approx(childBefore.x));
  CHECK(childAfter.y == doctest::Approx(childBefore.y));
}
