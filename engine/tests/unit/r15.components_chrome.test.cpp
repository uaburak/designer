// Round 15 — components and instances on the canvas as live Figma (the owner's screenshots, docs/research/components15/):
// the hover and selection of a component, a set, an instance and of every layer inside one in the component purple; a
// layer inside an instance hovered dotted; the instance picked whole by the first click (hover likewise), a click /
// double-click going one level deeper, ⌘ straight to the deepest; rectangles and frames hit in the corners their radii
// cut off, ellipses not.
#include <algorithm>
#include <cmath>

#include "doctest.h"
#include "Helpers.h"
#include "base/DerivedIds.h"
#include "editor/Editor.h"
#include "editor/Selection.h"
#include "gfx/null/NullDevice.h"
#include "hit/HitTest.h"
#include "render/Renderer.h"

using namespace eng;
using namespace eng::test;

namespace {

// BTN: a pill-shaped main component (200 × 44, radius 22) holding ICON and LABEL; INST its instance on the page; F a
// top-level frame holding the instance INST2; RR a rectangle of radius 50, EL an ellipse; BOX a plain frame with a
// rectangle in it (blue chrome).
const Guid BTN{1, 1}, ICON{1, 2}, LABEL{1, 3}, INST{1, 10}, F{1, 20}, INST2{1, 21}, RR{1, 30}, EL{1, 31}, BOX{1, 40}, BOXR{1, 41};

std::vector<NodeChange> nodes() {
  auto out = baseChanges();
  NodeChange btn = make(BTN, NodeType::SYMBOL, kPage, "!", {0, 0, 200, 44}, "Button");
  btn.props.cornerRadii = {22, 22, 22, 22};
  btn.props.fillPaints = {Paint::solid(Color::hex(0xE30613))};
  out.push_back(btn);
  out.push_back(make(ICON, NodeType::ROUNDED_RECTANGLE, BTN, "!", {30, 10, 24, 24}, "Icon"));
  out.push_back(make(LABEL, NodeType::ROUNDED_RECTANGLE, BTN, "\"", {70, 10, 100, 24}, "Label"));
  NodeChange inst = make(INST, NodeType::INSTANCE, kPage, "\"", {0, 100, 200, 44}, "Button");
  inst.props.comp().symbolData.symbolID = BTN;
  inst.props.cornerRadii = {22, 22, 22, 22};
  inst.props.fillPaints = btn.props.fillPaints;
  out.push_back(inst);
  out.push_back(make(F, NodeType::FRAME, kPage, "#", {400, 0, 300, 200}, "Frame"));
  NodeChange inst2 = make(INST2, NodeType::INSTANCE, F, "!", {20, 20, 200, 44}, "Button");
  inst2.props.comp().symbolData.symbolID = BTN;
  inst2.props.cornerRadii = {22, 22, 22, 22};
  inst2.props.fillPaints = btn.props.fillPaints;
  out.push_back(inst2);
  NodeChange rr = make(RR, NodeType::ROUNDED_RECTANGLE, kPage, "$", {0, 300, 100, 100}, "Round");
  rr.props.cornerRadii = {50, 50, 50, 50};
  out.push_back(rr);
  out.push_back(make(EL, NodeType::ELLIPSE, kPage, "%", {200, 300, 100, 100}, "Ellipse"));
  out.push_back(make(BOX, NodeType::FRAME, kPage, "&", {400, 300, 200, 100}, "Box"));
  out.push_back(make(BOXR, NodeType::ROUNDED_RECTANGLE, BOX, "!", {20, 20, 60, 60}, "In box"));
  return out;
}

// The page origin at (100, 100) on screen, zoom 1.
struct Scene {
  Editor e;
  gfx::NullDevice device;
  Renderer r{device};
  Scene() {
    e.setSessionID(1);
    e.setViewport(1400, 900, 1, 1400, 900);
    e.loadDocument(nodes(), kNoGuid);
    e.setCamera({100, 100, 1});
    e.takeEvents();
  }
  void move(Vec2 w, uint32_t mods = 0) { e.pointer(PointerEvent::MOVE, w.x + 100, w.y + 100, 0, 0, mods); }
  void click(Vec2 w, uint32_t mods = 0, int clicks = 1) {
    move(w, mods);
    e.pointer(PointerEvent::DOWN, w.x + 100, w.y + 100, 0, 1, mods, clicks);
    e.pointer(PointerEvent::UP, w.x + 100, w.y + 100, 0, 0, mods);
  }
  std::vector<DrawInstance> draw(const OverlayStyle& style) {
    device.draws.clear();
    r.render(e.document(), e.page(), e.camera(), e.viewport(), e.overlay(), style);
    std::vector<DrawInstance> all;
    for (size_t i = 0; i < device.draws.size(); i++)
      for (const DrawInstance& q : device.instancesOf<DrawInstance>(i)) all.push_back(q);
    return all;
  }
};

bool sameColor(const DrawInstance& q, const Color& c) {
  return std::fabs(q.color[0] - c.r) < 0.01 && std::fabs(q.color[1] - c.g) < 0.01 && std::fabs(q.color[2] - c.b) < 0.01;
}
size_t count(const std::vector<DrawInstance>& all, const Color& c) {
  return static_cast<size_t>(std::count_if(all.begin(), all.end(), [&](const DrawInstance& q) { return sameColor(q, c); }));
}
// The shapes the overlay draws in `c` whose box is about `w` × `h` (a stroke's box, a dash).
size_t countSized(const std::vector<DrawInstance>& all, const Color& c, double w, double h) {
  return static_cast<size_t>(std::count_if(all.begin(), all.end(), [&](const DrawInstance& q) {
    return sameColor(q, c) && std::fabs(q.origin[2] - w) < 0.6 && std::fabs(q.origin[3] - h) < 0.6;
  }));
}

}  // namespace

TEST_CASE("r15 hit-test: rectangles and frames take their rounded-off corners; ellipses don't") {
  Scene s;
  const Document& d = s.e.document();
  // The rectangle's corner (outside its radius-50 shape, inside its box).
  auto p = hitPath(d, kPage, {3, 303}, 1);
  REQUIRE(!p.empty());
  CHECK(p.back() == RR);
  // The ellipse's: nothing.
  CHECK(hitPath(d, kPage, {203, 303}, 1).empty());
  // The pill-shaped instance and main component: their corners.
  p = hitPath(d, kPage, {2, 102}, 1);
  REQUIRE(!p.empty());
  CHECK(p.front() == INST);
  p = hitPath(d, kPage, {198, 42}, 1);
  REQUIRE(!p.empty());
  CHECK(p.front() == BTN);
  // An instance inside a frame (not top-level, filled): its corner too.
  p = hitPath(d, kPage, {422, 22}, 1);
  REQUIRE(p.size() >= 2);
  CHECK(p[1] == INST2);
  // A clipping frame still cuts its content at its rounded edge (hitsOwnShape's clip form).
  NodeProps f = d.get(BTN)->props;
  CHECK(hitsOwnShape(f, {1, 1}, 0.5, true));
  CHECK(!hitsOwnShape(f, {1, 1}, 0.5, true, true));
  // Hovering the corner outlines the instance (the owner's 46.png: the pointer in the pill's corner).
  s.move({2, 102});
  CHECK(s.e.hover() == INST);
}

TEST_CASE("r15 instances: the first click (and hover) takes the instance whole; clicks go one level deeper; ⌘ the deepest") {
  Scene s;
  Guid label = derived::intern(INST, {LABEL});
  // Hover over the instance's label: the instance.
  s.move({120, 122});
  CHECK(s.e.hover() == INST);
  s.click({120, 122});
  REQUIRE(s.e.selection().size() == 1);
  CHECK(s.e.selection()[0] == INST);
  // Selected, the instance's layers hover and click one at a time.
  s.move({121, 122});
  CHECK(s.e.hover() == label);
  s.click({121, 122});
  REQUIRE(s.e.selection().size() == 1);
  CHECK(s.e.selection()[0] == label);
  // Another instance's layer: that instance first.
  Guid label2 = derived::intern(INST2, {LABEL});
  s.click({495, 42});
  REQUIRE(s.e.selection().size() == 1);
  CHECK(s.e.selection()[0] == INST2);
  // A double-click goes one level in.
  s.e.setSelection({});
  s.click({496, 42}, 0, 1);
  CHECK(s.e.selection()[0] == INST2);
  s.click({496, 42}, 0, 2);
  REQUIRE(s.e.selection().size() == 1);
  CHECK(s.e.selection()[0] == label2);
  // ⌘: straight to the deepest layer (hover too).
  s.e.setSelection({});
  s.move({122, 122}, MOD_PRIMARY);
  CHECK(s.e.hover() == label);
  s.click({122, 122}, MOD_PRIMARY);
  REQUIRE(s.e.selection().size() == 1);
  CHECK(s.e.selection()[0] == label);
}

TEST_CASE("r15 chrome: components, instances and every layer inside them in the component purple; instance layers hover dotted") {
  Scene s;
  OverlayStyle style = OverlayStyle::of(Theme::Dark);
  const Document& d = s.e.document();
  Guid label = derived::intern(INST, {LABEL});
  CHECK(inComponentChrome(d, BTN));
  CHECK(inComponentChrome(d, LABEL));
  CHECK(inComponentChrome(d, INST));
  CHECK(inComponentChrome(d, label));
  CHECK(!inComponentChrome(d, BOX));
  CHECK(!inComponentChrome(d, BOXR));
  CHECK(insideInstance(d, label));
  CHECK(!insideInstance(d, INST));
  CHECK(!insideInstance(d, LABEL));

  // A layer inside an instance selected: its box (no blue anywhere) and the instance — its auto-layout-less parent —
  // purple too.
  s.e.setSelection({label});
  s.e.takeEvents();
  auto all = s.draw(style);
  CHECK(count(all, style.selection) == 0);
  CHECK(countSized(all, style.component, 100, 24) >= 1);  // the selection's box
  // The main component's own layer selected: purple.
  s.e.setSelection({LABEL});
  all = s.draw(style);
  CHECK(count(all, style.selection) == 0);
  CHECK(countSized(all, style.component, 100, 24) >= 1);
  // A plain frame's layer: blue.
  s.e.setSelection({BOXR});
  all = s.draw(style);
  CHECK(countSized(all, style.selection, 60, 60) >= 1);
  CHECK(countSized(all, style.component, 60, 60) == 0);

  // The instance selected, its label hovered: dotted — 1.5 px dashes in the component purple around the label (the
  // owner's 46.png), and no solid 2 px outline.
  s.e.setSelection({});
  s.click({120, 122});
  s.move({121, 122});
  REQUIRE(s.e.hover() == label);
  all = s.draw(style);
  size_t dashes = countSized(all, style.component, 1.5, 1);
  CHECK(dashes >= 2 * (100 + 24) / 3 - 4);  // ≈ one per 3 px of its perimeter
  CHECK(count(all, style.selection) == 0);
  // The main component's own label hovered (the main selected): a solid purple outline, no dashes.
  s.e.setSelection({BTN});
  s.move({120, 22});
  REQUIRE(s.e.hover() == LABEL);
  all = s.draw(style);
  CHECK(countSized(all, style.component, 1.5, 1) == 0);
  CHECK(countSized(all, style.component, 100, 24) >= 1);
  CHECK(count(all, style.selection) == 0);
}
