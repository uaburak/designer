// The canvas spans the window and the panels sit over it (Figma UI3; owner, 2026-10-10): the view's insets. Zoom to
// fit / selection / 100 % and keyboard zoom work in the part the panels leave visible; the canvas's size (and so its
// drawing buffer) doesn't change when a panel does — only the insets.
#include <cmath>

#include "doctest.h"
#include "editor/Editor.h"
#include "Helpers.h"

using namespace eng;
using namespace eng::test;

namespace {

const Guid F{1, 1}, R{1, 2};

Editor makeEditor() {
  auto nodes = baseChanges();
  nodes.push_back(make(F, NodeType::FRAME, kPage, "!", {0, 0, 400, 300}, "Frame"));
  nodes.push_back(make(R, NodeType::ROUNDED_RECTANGLE, kPage, "\"", {1000, 0, 100, 100}, "Rectangle"));
  Editor e;
  e.setSessionID(1);
  e.setViewport(1440, 900, 1, 1440, 900);
  e.loadDocument(nodes, kNoGuid);
  e.takeEvents();
  return e;
}

// The centre, on screen, of a world rect under the editor's camera.
Vec2 centreOnScreen(const Editor& e, const Rect& r) { return e.camera().toScreen({r.x + r.w / 2, r.y + r.h / 2}); }

}  // namespace

TEST_CASE("insets: zoom to selection centres in the visible part, between the panels") {
  Editor e = makeEditor();
  e.setViewportInsets(299, 0, 241, 0);  // rail + left panel, right panel
  REQUIRE(e.setSelection({F}) == OK);
  e.command(CommandId::ZOOM_TO_SELECTION);
  Vec2 c = centreOnScreen(e, e.document().worldBounds(F));
  CHECK(std::abs(c.x - (299 + (1440 - 299 - 241) / 2.0)) <= 1);
  CHECK(std::abs(c.y - 450) <= 1);
  // Fitted to the visible width (900 − 2 × 64 room), not the canvas's 1440.
  CHECK(e.camera().zoom * 400 <= 900 - 128 + 0.5);
}

TEST_CASE("insets: zoom to fit puts the page's content in the visible part") {
  Editor e = makeEditor();
  e.setViewportInsets(299, 0, 241, 0);
  e.command(CommandId::ZOOM_TO_FIT);
  Rect all = e.document().worldBounds(F).united(e.document().worldBounds(R));
  Vec2 a = e.camera().toScreen({all.x, all.y}), b = e.camera().toScreen({all.right(), all.bottom()});
  CHECK(a.x >= 299 + 63);
  CHECK(b.x <= 1440 - 241 - 63);
}

TEST_CASE("insets: a canvas resize keeps them; keyboard zoom is about the visible centre") {
  Editor e = makeEditor();
  e.setViewportInsets(299, 0, 241, 0);
  e.setViewport(1500, 900, 1, 1500, 900);
  CHECK(e.viewport().insetLeft == 299);
  CHECK(e.viewport().insetRight == 241);
  e.setCamera({0, 0, 1});
  Vec2 centre{299 + (1500 - 299 - 241) / 2.0, 450};
  Vec2 before = e.camera().toWorld(centre);
  e.command(CommandId::ZOOM_IN);
  Vec2 after = e.camera().toWorld(centre);
  CHECK(std::abs(before.x - after.x) <= 1);
  CHECK(std::abs(before.y - after.y) <= 1);
}

TEST_CASE("insets: none — the whole canvas is the view, as before") {
  Editor e = makeEditor();
  REQUIRE(e.setSelection({F}) == OK);
  e.command(CommandId::ZOOM_TO_SELECTION);
  Vec2 c = centreOnScreen(e, e.document().worldBounds(F));
  CHECK(std::abs(c.x - 720) <= 1);
}
