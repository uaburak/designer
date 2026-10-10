// Round 16 — the owner's canvas handle rules (docs/research/canvas-handles16/README.md):
// - auto layout's hatch: a padding under the pointer hatches that padding only; ⌥ held its opposite too (a drag sets
//   and outlines both), ⌥⇧ all four; a gap under the pointer hatches every gap; the Design panel's hovered field
//   hatches the same (engine_spacing_highlight);
// - corner radius handles on rectangles, frames and instances: a drag sets every corner, ⌥ the dragged one; ⌘ rounds
//   inward (inverted corners, our own field invertedCornerMask = 1002), ⌘⌥ the dragged one inward; one undo step;
// - inverted corners drawn, clipped, hit and exported by their outline (a quarter circle around the corner).
#include <algorithm>
#include <cmath>

#include "doctest.h"
#include "Helpers.h"
#include "editor/Editor.h"
#include "export/SvgWriter.h"
#include "geometry/Path.h"
#include "geometry/Shapes.h"
#include "hit/HitTest.h"
#include "scene/CodecKiwi.h"

using namespace eng;
using namespace eng::test;

namespace {

const Guid AL{16, 1}, A{16, 2}, B{16, 3}, C{16, 4}, R{16, 5}, F{16, 6}, FC{16, 7}, MAIN{16, 8}, INST{16, 9};

// A horizontal auto-layout frame 320 × 100 at the page origin, padding 20 / 10 / 20 / 10, gap 20, three 80 × 80
// layers (gaps at x 100–120 and 200–220); a rectangle R 200 × 100 at (0, 200) with a fill; a frame F 200 × 100 at
// (400, 200) with a fill, clipping a child. The page origin at (100, 100) on screen, zoom 1.
Editor makeEditor() {
  auto nodes = baseChanges();
  NodeChange f = make(AL, NodeType::FRAME, kPage, "!", {0, 0, 320, 100}, "Auto");
  StackFacet& st = f.props.stack();
  st.stackMode = StackMode::HORIZONTAL;
  st.stackPrimarySizing = StackSize::FIXED;
  st.stackCounterSizing = StackSize::FIXED;
  st.stackSpacing = 20;
  st.stackPaddingLeft = st.stackPaddingRight = 20;
  st.stackPaddingTop = st.stackPaddingBottom = 10;
  nodes.push_back(f);
  nodes.push_back(make(A, NodeType::ROUNDED_RECTANGLE, AL, "!", {20, 10, 80, 80}, "A"));
  nodes.push_back(make(B, NodeType::ROUNDED_RECTANGLE, AL, "\"", {120, 10, 80, 80}, "B"));
  nodes.push_back(make(C, NodeType::ROUNDED_RECTANGLE, AL, "#", {220, 10, 80, 80}, "C"));
  NodeChange r = make(R, NodeType::ROUNDED_RECTANGLE, kPage, "\"", {0, 200, 200, 100}, "R");
  r.props.fillPaints = {Paint::solid(Color{0.85f, 0.85f, 0.85f, 1})};
  nodes.push_back(r);
  NodeChange fr = make(F, NodeType::FRAME, kPage, "#", {400, 200, 200, 100}, "F");
  fr.props.fillPaints = {Paint::solid(Color{1, 1, 1, 1})};
  nodes.push_back(fr);
  nodes.push_back(make(FC, NodeType::ROUNDED_RECTANGLE, F, "!", {0, 0, 200, 100}, "Inside"));
  // A component and its instance (screen 800..900 × 100..200, 800..900 × 300..400).
  nodes.push_back(make(MAIN, NodeType::SYMBOL, kPage, "$", {700, 0, 100, 100}, "Main"));
  NodeChange inst = make(INST, NodeType::INSTANCE, kPage, "%", {700, 200, 100, 100}, "Main");
  inst.props.comp().symbolData.symbolID = MAIN;
  nodes.push_back(inst);
  Editor e;
  e.setViewport(1000, 800, 1, 1000, 800);
  e.loadDocument(nodes, kNoGuid);
  e.setCamera({100, 100, 1});
  e.takeEvents();
  return e;
}

void down(Editor& e, Vec2 s, uint32_t mods = 0) { e.pointer(PointerEvent::DOWN, s.x, s.y, 0, 1, mods, 1); }
void move(Editor& e, Vec2 s, uint32_t mods = 0) { e.pointer(PointerEvent::MOVE, s.x, s.y, 0, 1, mods); }
void up(Editor& e, Vec2 s, uint32_t mods = 0) { e.pointer(PointerEvent::UP, s.x, s.y, 0, 0, mods); }
void drag(Editor& e, Vec2 from, Vec2 to, uint32_t mods = 0) {
  move(e, from, mods);
  down(e, from, mods);
  for (int i = 1; i <= 4; i++) {
    double t = i / 4.0;
    move(e, {from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t}, mods);
  }
  up(e, to, mods);
}
const NodeProps& props(const Editor& e, Guid id) { return e.document().get(id)->props; }
uint32_t mask(const Editor& e, Guid id) { return props(e, id).stroke().invertedCornerMask; }
// The area's left / right edges (world x).
std::pair<double, double> xs(const Overlay::SpacingArea& a) {
  return {std::min({a.quad[0].x, a.quad[1].x, a.quad[2].x, a.quad[3].x}), std::max({a.quad[0].x, a.quad[1].x, a.quad[2].x, a.quad[3].x})};
}
bool contains(const Editor& e, Guid id, Vec2 local) {
  const NodeGeometry* g = e.document().geometry(id);
  REQUIRE(g);
  REQUIRE(!g->fills.empty());
  return geom::contains(geom::flatten(g->fills[0].path, 0.01), local, false);
}

}  // namespace

// ---- 1. The hatch ---------------------------------------------------------------------------------------------------

TEST_CASE("r16 hatch: a padding hatches only itself, ⌥ its opposite too, ⌥⇧ all four; a gap every gap") {
  Editor e = makeEditor();
  e.setSelection({AL});
  // The left padding (off its bar).
  move(e, {110, 120});
  Overlay o = e.overlay();
  REQUIRE(o.spacingAreas.size() == 1);
  CHECK(!o.spacingAreas[0].gap);
  CHECK(xs(o.spacingAreas[0]) == std::pair<double, double>{0, 20});
  // ⌥ pressed: the right padding too (what a drag would set).
  e.modifiers(MOD_ALT);
  o = e.overlay();
  REQUIRE(o.spacingAreas.size() == 2);
  CHECK(xs(o.spacingAreas[0]) == std::pair<double, double>{0, 20});
  CHECK(xs(o.spacingAreas[1]) == std::pair<double, double>{300, 320});
  // ⌥⇧: all four.
  e.modifiers(MOD_ALT | MOD_SHIFT);
  CHECK(e.overlay().spacingAreas.size() == 4);
  // ⌥ let go: only the one again.
  e.modifiers(0);
  CHECK(e.overlay().spacingAreas.size() == 1);
  // The top padding with ⌥: top and bottom.
  move(e, {150, 104}, MOD_ALT);
  o = e.overlay();
  REQUIRE(o.spacingAreas.size() == 2);
  CHECK(o.spacingAreas[1].quad[0].y == doctest::Approx(90));
  // A gap (no ⌥ needed): both gaps hatched pink.
  e.modifiers(0);
  move(e, {210, 120});
  o = e.overlay();
  REQUIRE(o.spacingAreas.size() == 2);
  CHECK(o.spacingAreas[0].gap);
  CHECK(o.spacingAreas[1].gap);
  CHECK(xs(o.spacingAreas[0]) == std::pair<double, double>{100, 120});
  CHECK(xs(o.spacingAreas[1]) == std::pair<double, double>{200, 220});
  // On a layer: none.
  move(e, {160, 150});
  CHECK(e.overlay().spacingAreas.empty());
}

TEST_CASE("r16 hatch: an ⌥-drag on a padding's bar sets both and outlines both; one undo step") {
  Editor e = makeEditor();
  e.setSelection({AL});
  // The left padding's bar: (10, 50) → screen (110, 150).
  move(e, {110, 150});
  down(e, {110, 150}, MOD_ALT);
  move(e, {115, 150}, MOD_ALT);
  move(e, {120, 150}, MOD_ALT);
  Overlay o = e.overlay();
  REQUIRE(o.spacingAreas.size() == 2);
  CHECK(o.spacingAreas[0].outline);
  CHECK(o.spacingAreas[1].outline);
  CHECK(props(e, AL).stack().stackPaddingLeft == 30);
  CHECK(props(e, AL).stack().stackPaddingRight == 30);
  // ⌥ let go mid-drag: the right padding back, one outline.
  e.modifiers(0);
  CHECK(props(e, AL).stack().stackPaddingRight == 20);
  CHECK(e.overlay().spacingAreas.size() == 1);
  e.modifiers(MOD_ALT);
  up(e, {120, 150}, MOD_ALT);
  CHECK(props(e, AL).stack().stackPaddingLeft == 30);
  CHECK(props(e, AL).stack().stackPaddingRight == 30);
  CHECK(e.undoStack().undoCount() == 1);
  e.command(CommandId::UNDO);
  CHECK(props(e, AL).stack().stackPaddingLeft == 20);
  CHECK(props(e, AL).stack().stackPaddingRight == 20);
}

TEST_CASE("r16 hatch: the Design panel's hovered field hatches its paddings or the gaps") {
  Editor e = makeEditor();
  e.setSelection({AL});
  move(e, {900, 700});  // the pointer off the canvas' frame
  CHECK(e.overlay().spacingAreas.empty());
  // "Horizontal padding": left and right.
  e.setSpacingHighlight(Editor::SPACING_LEFT | Editor::SPACING_RIGHT);
  Overlay o = e.overlay();
  REQUIRE(o.spacingAreas.size() == 2);
  CHECK(!o.spacingAreas[0].outline);
  CHECK(xs(o.spacingAreas[1]) == std::pair<double, double>{300, 320});
  // The bottom padding only.
  e.setSpacingHighlight(Editor::SPACING_BOTTOM);
  o = e.overlay();
  REQUIRE(o.spacingAreas.size() == 1);
  CHECK(o.spacingAreas[0].quad[0].y == doctest::Approx(90));
  // Gap: every gap.
  e.setSpacingHighlight(Editor::SPACING_GAPS);
  o = e.overlay();
  REQUIRE(o.spacingAreas.size() == 2);
  CHECK(o.spacingAreas[0].gap);
  // Cleared.
  e.setSpacingHighlight(0);
  CHECK(e.overlay().spacingAreas.empty());
  // A layer without auto layout selected: nothing.
  e.setSelection({R});
  e.setSpacingHighlight(Editor::SPACING_GAPS);
  CHECK(e.overlay().spacingAreas.empty());
}

// ---- 2. Corner radius handles ---------------------------------------------------------------------------------------

TEST_CASE("r16 radius: all corners, ⌥ one, ⌘ inward, ⌘⌥ one inward — one undo step each") {
  Editor e = makeEditor();
  e.setSelection({R});  // screen 100..300 × 300..400
  move(e, {200, 350});
  Overlay o = e.overlay();
  REQUIRE(o.radiusHandles.size() == 4);
  CHECK(o.radiusHandles[0] == Vec2{12, 212});
  // No modifier: every corner 10, none inverted.
  drag(e, {112, 312}, {122, 322});
  CHECK(props(e, R).cornerRadii == CornerRadii{10, 10, 10, 10});
  CHECK(mask(e, R) == 0);
  CHECK(e.undoStack().undoCount() == 1);
  // ⌘: every corner 30, inward.
  move(e, {200, 350});
  drag(e, {112, 312}, {132, 332}, MOD_PRIMARY);
  CHECK(props(e, R).cornerRadii == CornerRadii{30, 30, 30, 30});
  CHECK(mask(e, R) == 15);
  CHECK(props(e, R).invertedCorners() == 15);
  CHECK(e.undoStack().undoCount() == 2);
  e.command(CommandId::UNDO);
  CHECK(props(e, R).cornerRadii == CornerRadii{10, 10, 10, 10});
  CHECK(mask(e, R) == 0);
  // ⌘⌥ on the bottom-right handle (12 px in: radius 10): that corner only, inward.
  move(e, {200, 350});
  drag(e, {288, 388}, {278, 378}, MOD_PRIMARY | MOD_ALT);
  CHECK(props(e, R).cornerRadii == CornerRadii{10, 10, 20, 10});
  CHECK(mask(e, R) == 4);
  // ⌥ on the top-left: that corner only, outward; the bottom-right stays inward.
  move(e, {200, 350});
  drag(e, {112, 312}, {122, 322}, MOD_ALT);
  CHECK(props(e, R).cornerRadii == CornerRadii{20, 10, 20, 10});
  CHECK(mask(e, R) == 4);
  // ⌥ on the inverted bottom-right (on its radius, 20 in): outward again.
  move(e, {200, 350});
  REQUIRE(e.overlay().radiusHandles.size() == 4);
  CHECK(e.overlay().radiusHandles[2] == Vec2{180, 280});
  drag(e, {280, 380}, {280, 380}, MOD_ALT);
  CHECK(mask(e, R) == 0);
  // No modifier puts every corner back outward; ⌘ pressed then let go mid-drag ends outward.
  move(e, {200, 350});
  down(e, {120, 320});
  move(e, {125, 325}, MOD_PRIMARY);
  CHECK(mask(e, R) == 15);
  e.modifiers(0);
  CHECK(mask(e, R) == 0);
  up(e, {125, 325});
  CHECK(mask(e, R) == 0);
}

TEST_CASE("r16 radius: frames and instances have the handles too; a frame drag rounds it, ⌘ inward") {
  Editor e = makeEditor();
  e.setSelection({F});  // screen 500..700 × 300..400
  move(e, {600, 350});
  Overlay o = e.overlay();
  REQUIRE(o.radiusHandles.size() == 4);
  drag(e, {512, 312}, {532, 332}, MOD_PRIMARY);
  CHECK(props(e, F).cornerRadii == CornerRadii{20, 20, 20, 20});
  CHECK(mask(e, F) == 15);
  CHECK(e.undoStack().undoCount() == 1);
  // A component and an instance: handles; ⌘⌥ on the instance's top-left: that corner inward (an override).
  e.setSelection({MAIN});
  move(e, {850, 150});
  CHECK(e.overlay().radiusHandles.size() == 4);
  e.setSelection({INST});
  move(e, {850, 350});
  REQUIRE(e.overlay().radiusHandles.size() == 4);
  drag(e, {812, 312}, {822, 322}, MOD_PRIMARY | MOD_ALT);
  CHECK(props(e, INST).cornerRadii == CornerRadii{10, 0, 0, 0});
  CHECK(mask(e, INST) == 1);
  move(e, {850, 350});
  CHECK(e.overlay().radiusHandles.size() == 4);
}

// ---- 3. Inverted corners: geometry, hit-testing, codecs, export -----------------------------------------------------

TEST_CASE("r16 inverted corners: a quarter circle around the corner — geometry, hits, clipping") {
  Editor e = makeEditor();
  NodeChange c = NodeChange::changed(R);
  c.mask = F_CORNER_RADII | F_INVERTED_CORNERS;
  c.props.cornerRadii = {30, 30, 30, 30};
  c.props.stroke().invertedCornerMask = 1;  // top-left inward, the others rounded outward
  REQUIRE(e.applyChanges({c}, APPLY_USER) == OK);
  CHECK(props(e, R).isPathShape());
  // The outline: the disc of radius 30 around (0, 0) is out, just past it is in.
  CHECK(!contains(e, R, {5, 5}));
  CHECK(!contains(e, R, {20, 20}));  // 28.3 from the corner
  CHECK(contains(e, R, {22.5, 22.5}));  // 31.8
  CHECK(contains(e, R, {100, 50}));
  CHECK(contains(e, R, {31, 1}));
  CHECK(!contains(e, R, {199, 1}));  // the top-right rounded outward
  // Hits: nothing in the inverted corner; the outward corner by the box (live Figma's rule).
  CHECK(!hitsNode(e.document(), R, {5, 5}, 0.5, true));
  CHECK(!hitsNode(e.document(), R, {20, 20}, 0.5, true));
  CHECK(hitsNode(e.document(), R, {25, 25}, 0.5, true));
  CHECK(hitsNode(e.document(), R, {199, 1}, 0.5, true));
  // A click there selects nothing (the page under it).
  e.setSelection({});
  down(e, {105, 305});
  up(e, {105, 305});
  CHECK(e.selection().empty());
  down(e, {130, 330});
  up(e, {130, 330});
  CHECK(e.selection() == std::vector<Guid>{R});
  // A smoothed inverted corner: still out near the corner, in past the curve.
  NodeChange s = NodeChange::changed(R);
  s.mask = F_CORNER_SMOOTHING;
  s.props.stroke().cornerSmoothing = 0.6;
  REQUIRE(e.applyChanges({s}, APPLY_USER) == OK);
  CHECK(!contains(e, R, {5, 5}));
  CHECK(contains(e, R, {40, 40}));
  // A frame: the same; its own hit area and its child cut in the corner (the child is hit where it shows only).
  NodeChange fc = NodeChange::changed(F);
  fc.mask = F_CORNER_RADII | F_INVERTED_CORNERS;
  fc.props.cornerRadii = {0, 0, 40, 0};
  fc.props.stroke().invertedCornerMask = 4;
  REQUIRE(e.applyChanges({fc}, APPLY_USER) == OK);
  CHECK(props(e, F).invertedCorners() == 4);
  CHECK(!contains(e, F, {195, 95}));
  CHECK(contains(e, F, {100, 50}));
  CHECK(!hitsNode(e.document(), F, {195, 95}, 0.5, true));
  CHECK(hitsNode(e.document(), F, {150, 50}, 0.5, true));
  // A bit on a square corner shows nothing.
  NodeChange sq = NodeChange::changed(F);
  sq.mask = F_INVERTED_CORNERS;
  sq.props.stroke().invertedCornerMask = 4 | 1;
  REQUIRE(e.applyChanges({sq}, APPLY_USER) == OK);
  CHECK(props(e, F).invertedCorners() == 4);
}

TEST_CASE("r16 inverted corners: kiwi and JSON round-trip; the path shape is Figma-free; SVG writes a path") {
  NodeChange c = make(R, NodeType::ROUNDED_RECTANGLE, kPage, "!", {0, 0, 100, 60}, "R");
  c.props.cornerRadii = {12, 12, 12, 12};
  c.props.stroke().invertedCornerMask = 10;
  // Kiwi.
  std::string bytes = codec::writeMessage(1, {c});
  codec::KiwiMessage m;
  REQUIRE(codec::readMessage(bytes, m));
  REQUIRE(m.changes.size() == 1);
  CHECK(m.changes[0].props.stroke().invertedCornerMask == 10);
  CHECK(differingFields(m.changes[0].props, c.props) == 0);
  // The field id is ours (1002) and only that field changes.
  CHECK(kiwiFieldId(F_INVERTED_CORNERS) == 1002);
  CHECK(fieldsOfKiwiId(1002) == F_INVERTED_CORNERS);
  CHECK((fieldGroups(F_INVERTED_CORNERS) & G_GEOMETRY) != 0);
  // JSON.
  json::Writer w;
  codec::writeChange(w, c);
  json::Value v;
  REQUIRE(json::parse(w.str(), v));
  REQUIRE(v.get("invertedCornerMask"));
  CHECK(v.get("invertedCornerMask")->number == 10);
  NodeChange back;
  REQUIRE(codec::readChange(v, back));
  CHECK(back.props.stroke().invertedCornerMask == 10);
  // The shape: top-right (2) and bottom-left (8) inward.
  geom::Path p = geom::rectPath({100, 60}, c.props.cornerRadii, 0, 10);
  auto polys = geom::flatten(p, 0.01);
  CHECK(!geom::contains(polys, {2, 2}, false));     // top-left rounded outward: 14 from its centre (12, 12)
  CHECK(geom::contains(polys, {6, 6}, false));      // 8.5 from it
  CHECK(!geom::contains(polys, {98, 2}, false));    // top-right inward
  CHECK(geom::contains(polys, {85, 15}, false));    // past its circle
  CHECK(!geom::contains(polys, {2, 58}, false));    // bottom-left inward
  CHECK(!geom::contains(polys, {99, 59}, false));   // bottom-right rounded outward
  // SVG: a path, not a <rect>.
  Editor e;
  auto nodes = baseChanges();
  NodeChange r = c;
  r.props.fillPaints = {Paint::solid(Color{0, 0, 0, 1})};
  nodes.push_back(r);
  e.loadDocument(nodes, kNoGuid);
  exporter::Settings s;
  s.format = exporter::Format::SVG;
  exporter::Target t;
  REQUIRE(exporter::resolveTarget(e.document(), &e, kNoGuid, {R}, s, t));
  std::string svg = exporter::writeSvg(e.document(), &e, t, s);
  CHECK(svg.find("<rect") == std::string::npos);
  CHECK(svg.find("<path d=\"M") != std::string::npos);
}
