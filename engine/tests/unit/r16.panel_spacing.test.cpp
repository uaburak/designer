// Round 16 — the Design panel's padding / gap fields hatch what they edit on the canvas (owner's request with live
// Figma, 2026-10-10): Editor::setSpacingHighlight's bits — a side's padding, every gap — drawn as the pointer's hover
// would draw them, on the selected auto-layout frame only, none for a side of 0, once when the pointer hatches it too.
#include "doctest.h"
#include "Helpers.h"
#include "editor/Editor.h"

using namespace eng;
using namespace eng::test;

namespace {

const Guid AL{1, 1}, A{1, 2}, B{1, 3}, C{1, 4}, R{1, 5};

// A horizontal auto-layout frame 300 × 100 at the page origin, padding 20 / 10 / 20 / 0 (left / top / right / bottom),
// gap 10, three 80-wide layers; a plain rectangle beside it. Page origin at (100, 100) on screen, zoom 1.
Editor makeEditor() {
  auto nodes = baseChanges();
  NodeChange f = make(AL, NodeType::FRAME, kPage, "!", {0, 0, 300, 100}, "Auto");
  StackFacet& st = f.props.stack();
  st.stackMode = StackMode::HORIZONTAL;
  st.stackPrimarySizing = StackSize::FIXED;
  st.stackCounterSizing = StackSize::FIXED;
  st.stackSpacing = 10;
  st.stackPaddingLeft = st.stackPaddingRight = 20;
  st.stackPaddingTop = 10;
  st.stackPaddingBottom = 0;
  nodes.push_back(f);
  nodes.push_back(make(A, NodeType::ROUNDED_RECTANGLE, AL, "!", {20, 10, 80, 90}, "A"));
  nodes.push_back(make(B, NodeType::ROUNDED_RECTANGLE, AL, "\"", {110, 10, 80, 90}, "B"));
  nodes.push_back(make(C, NodeType::ROUNDED_RECTANGLE, AL, "#", {200, 10, 80, 90}, "C"));
  nodes.push_back(make(R, NodeType::ROUNDED_RECTANGLE, kPage, "\"", {400, 0, 50, 50}, "R"));
  Editor e;
  e.setViewport(1000, 800, 1, 1000, 800);
  e.loadDocument(nodes, kNoGuid);
  e.setCamera({100, 100, 1});
  e.setSelection({AL});
  e.takeEvents();
  return e;
}

}  // namespace

TEST_CASE("r16 panel spacing: a padding / gap field's highlight hatches its sides or every gap") {
  Editor e = makeEditor();
  CHECK(e.overlay().spacingAreas.empty());

  // The horizontal padding field: left and right.
  e.setSpacingHighlight(Editor::SPACING_LEFT | Editor::SPACING_RIGHT);
  Overlay o = e.overlay();
  REQUIRE(o.spacingAreas.size() == 2);
  CHECK(!o.spacingAreas[0].gap);
  CHECK(!o.spacingAreas[0].outline);
  CHECK(o.spacingAreas[0].quad[0] == Vec2{0, 0});
  CHECK(o.spacingAreas[0].quad[2] == Vec2{20, 100});
  CHECK(o.spacingAreas[1].quad[0] == Vec2{280, 0});
  CHECK(o.spacingAreas[1].quad[2] == Vec2{300, 100});

  // The vertical one: the top only — the bottom padding is 0.
  e.setSpacingHighlight(Editor::SPACING_TOP | Editor::SPACING_BOTTOM);
  o = e.overlay();
  REQUIRE(o.spacingAreas.size() == 1);
  CHECK(o.spacingAreas[0].quad[0] == Vec2{0, 0});
  CHECK(o.spacingAreas[0].quad[2] == Vec2{300, 10});

  // The gap field: both gaps, across the content box.
  e.setSpacingHighlight(Editor::SPACING_GAPS);
  o = e.overlay();
  REQUIRE(o.spacingAreas.size() == 2);
  CHECK(o.spacingAreas[0].gap);
  CHECK(o.spacingAreas[0].quad[0] == Vec2{100, 10});
  CHECK(o.spacingAreas[0].quad[2] == Vec2{110, 100});
  CHECK(o.spacingAreas[1].quad[0] == Vec2{190, 10});

  // The pointer over the left padding while its field is hovered: hatched once.
  e.setSpacingHighlight(Editor::SPACING_LEFT);
  e.pointer(PointerEvent::MOVE, 110, 120, 0, 0, 0);
  CHECK(e.overlay().spacingAreas.size() == 1);

  // Off: nothing; a plain rectangle selected: nothing either.
  e.pointer(PointerEvent::MOVE, 900, 700, 0, 0, 0);
  e.setSpacingHighlight(0);
  CHECK(e.overlay().spacingAreas.empty());
  e.setSelection({R});
  e.setSpacingHighlight(Editor::SPACING_LEFT | Editor::SPACING_GAPS);
  CHECK(e.overlay().spacingAreas.empty());
}
