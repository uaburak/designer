// Hovering frames inside / beside a selected frame (live Figma 2026-10-19, docs/research/figma/live/2026-10-18/
// hover-nested-frames.txt and the owner's hover-figma-*.webp captures): with something selected, the auto-layout frame
// under the pointer gets the hover outline and its DIRECT children are dotted — never the selection's own children,
// never deeper, never the selected layers; a plain frame or nothing selected dots nothing. A selected plain frame's
// equally spaced layers get the smart selection's rings (B).
#include <algorithm>

#include "doctest.h"
#include "Helpers.h"
#include "editor/Editor.h"

using namespace eng;
using namespace eng::test;

namespace {

void move(Editor& e, double x, double y) { e.pointer(PointerEvent::MOVE, x, y, 0, 1, 0); }

// The owner's fixture scaled down (world = screen at 100 %):
//  "ana frame" AF (0, 0) 160 × 340, no auto layout, holding two vertical auto-layout "iç frame"s I1 (20, 15) and
//  I2 (20, 175), 108 × 144, each a rectangle and a label;
//  "test" T (300, 0), horizontal auto layout, holding "test-Frame" TF (a wrapping row of three 100 × 120 vertical
//  auto-layout cells, each with a 50 × 50 rectangle; padding 10, gap 10) and "test-Rectangle" TR (three rectangles).
const Guid AF{1, 10}, I1{1, 11}, I2{1, 12}, R1{1, 13}, L1{1, 14}, R2{1, 15}, L2{1, 16};
const Guid T{1, 20}, TF{1, 21}, TR{1, 22};
Guid cell(int i) { return Guid{1, static_cast<uint32_t>(30 + i)}; }
Guid cellRect(int i) { return Guid{1, static_cast<uint32_t>(40 + i)}; }
Guid rect(int i) { return Guid{1, static_cast<uint32_t>(50 + i)}; }

NodeChange stack(NodeChange c, StackMode mode, bool wrap = false) {
  StackFacet& s = c.props.stack();
  s.stackMode = mode;
  s.stackPrimarySizing = s.stackCounterSizing = StackSize::FIXED;
  if (wrap) {
    s.stackWrap = StackWrap::WRAP;
    s.stackSpacing = 10;
    s.stackCounterSpacing = 10;
    s.stackPaddingLeft = s.stackPaddingTop = s.stackPaddingRight = s.stackPaddingBottom = 10;
  }
  return c;
}

Editor scene() {
  auto nodes = baseChanges();
  nodes.push_back(make(AF, NodeType::FRAME, kPage, "a", {0, 0, 160, 340}, "ana frame"));
  nodes.push_back(stack(make(I1, NodeType::FRAME, AF, "a", {20, 15, 108, 144}, "iç frame"), StackMode::VERTICAL));
  nodes.push_back(make(R1, NodeType::ROUNDED_RECTANGLE, I1, "a", {0, 94, 50, 50}, "çocuk"));
  nodes.push_back(make(L1, NodeType::ROUNDED_RECTANGLE, I1, "b", {30, 20, 48, 14}, "label"));
  nodes.push_back(stack(make(I2, NodeType::FRAME, AF, "b", {20, 175, 108, 144}, "iç frame"), StackMode::VERTICAL));
  nodes.push_back(make(R2, NodeType::ROUNDED_RECTANGLE, I2, "a", {0, 94, 50, 50}, "çocuk"));
  nodes.push_back(make(L2, NodeType::ROUNDED_RECTANGLE, I2, "b", {30, 20, 48, 14}, "label"));
  nodes.push_back(stack(make(T, NodeType::FRAME, kPage, "b", {300, 0, 710, 140}, "test"), StackMode::HORIZONTAL));
  nodes.push_back(stack(make(TF, NodeType::FRAME, T, "a", {0, 0, 340, 140}, "test-Frame"), StackMode::HORIZONTAL, true));
  nodes.push_back(stack(make(TR, NodeType::FRAME, T, "b", {370, 0, 340, 140}, "test-Rectangle"), StackMode::HORIZONTAL, true));
  for (int i = 0; i < 3; i++) {
    std::string pos(1, static_cast<char>('a' + i));
    nodes.push_back(stack(make(cell(i), NodeType::FRAME, TF, pos, {10 + 110.0 * i, 10, 100, 120}, "Frame"), StackMode::VERTICAL));
    nodes.push_back(make(cellRect(i), NodeType::ROUNDED_RECTANGLE, cell(i), "a", {0, 0, 50, 50}, "Rectangle"));
    nodes.push_back(make(rect(i), NodeType::ROUNDED_RECTANGLE, TR, pos, {10 + 110.0 * i, 10, 100, 120}, "Rectangle"));
  }
  Editor e;
  e.setSessionID(1);
  e.setViewport(1200, 800, 1, 1200, 800);
  e.loadDocument(nodes, kNoGuid);
  e.setCamera({0, 0, 1});
  e.takeEvents();
  return e;
}

bool has(const std::vector<Guid>& v, Guid id) { return std::find(v.begin(), v.end(), id) != v.end(); }

}  // namespace

TEST_CASE("hover A: a frame selected, the pointer over its sibling auto-layout frame — the sibling's children dotted") {
  Editor e = scene();
  e.setSelection({I1});
  move(e, 110, 280);  // I2's empty area
  Overlay o = e.overlay();
  REQUIRE(o.hover == std::vector<Guid>{I2});
  CHECK(o.hoverDotted.size() == 2);
  CHECK(has(o.hoverDotted, R2));
  CHECK(has(o.hoverDotted, L2));
  // The selection's own children are never dotted.
  CHECK_FALSE(has(o.hoverDotted, R1));
  CHECK_FALSE(has(o.hoverDotted, L1));
  // Over the sibling's rectangle: still the sibling hovered, its children dotted.
  move(e, 40, 300);
  o = e.overlay();
  REQUIRE(o.hover == std::vector<Guid>{I2});
  CHECK(o.hoverDotted.size() == 2);
}

TEST_CASE("hover B: the parent selected, the pointer over a child frame — that child's children dotted, rings on the parent's layers") {
  Editor e = scene();
  e.setSelection({AF});
  move(e, 110, 280);
  Overlay o = e.overlay();
  REQUIRE(o.hover == std::vector<Guid>{I2});
  CHECK(o.hoverDotted.size() == 2);
  CHECK(has(o.hoverDotted, R2));
  CHECK(has(o.hoverDotted, L2));
  CHECK_FALSE(has(o.hoverDotted, I1));  // the selected parent's other children: not dotted
  CHECK_FALSE(has(o.hoverDotted, R1));
  // The two equally spaced frames of the selected plain frame: the smart selection's rings (the pointer is on it).
  CHECK(o.centreDots.size() == 2);
  CHECK_FALSE(o.centreDotsIdle);
  move(e, 600, 600);  // off it: the dots
  o = e.overlay();
  CHECK(o.centreDots.size() == 2);
  CHECK(o.centreDotsIdle);
  CHECK(o.hoverDotted.empty());
}

TEST_CASE("hover C: the wrap grid selected, the pointer over a cell — the cell's rectangle dotted, nothing deeper or wider") {
  Editor e = scene();
  e.setSelection({TF});
  move(e, 300 + 120 + 80, 10 + 100);  // cell 1's empty area
  Overlay o = e.overlay();
  REQUIRE(o.hover == std::vector<Guid>{cell(1)});
  CHECK(o.hoverDotted == std::vector<Guid>{cellRect(1)});
  // The selected grid's other cells, and their rectangles: not dotted.
  CHECK_FALSE(has(o.hoverDotted, cell(0)));
  CHECK_FALSE(has(o.hoverDotted, cellRect(0)));
  // An auto-layout frame (an alignment of the selection's own children) never smart-selects.
  CHECK(o.centreDots.empty());
}

TEST_CASE("hover C': the wrap grid selected, the pointer over its sibling — the sibling's rectangles dotted") {
  Editor e = scene();
  e.setSelection({TF});
  move(e, 670 + 5, 70);  // test-Rectangle's left padding
  Overlay o = e.overlay();
  REQUIRE(o.hover == std::vector<Guid>{TR});
  CHECK(o.hoverDotted.size() == 3);
  for (int i = 0; i < 3; i++) CHECK(has(o.hoverDotted, rect(i)));
}

TEST_CASE("hover D: a cell selected, the pointer over the next cell — that cell's rectangle dotted") {
  Editor e = scene();
  e.setSelection({cell(0)});
  move(e, 300 + 120 + 80, 10 + 100);
  Overlay o = e.overlay();
  REQUIRE(o.hover == std::vector<Guid>{cell(1)});
  CHECK(o.hoverDotted == std::vector<Guid>{cellRect(1)});
}

TEST_CASE("hover Group 1 kept: a cell selected, the pointer over its auto-layout parent — the other cells dotted") {
  Editor e = scene();
  e.setSelection({cell(0)});
  move(e, 300 + 5, 70);  // test-Frame's left padding
  Overlay o = e.overlay();
  REQUIRE(o.hover == std::vector<Guid>{TF});
  CHECK(o.hoverDotted.size() == 2);
  CHECK(has(o.hoverDotted, cell(1)));
  CHECK(has(o.hoverDotted, cell(2)));
  CHECK_FALSE(has(o.hoverDotted, cell(0)));  // the selected one keeps its selection outline
}

TEST_CASE("hover: nothing dotted with nothing selected, over the selection itself, or over a plain frame") {
  Editor e = scene();
  move(e, 110, 280);
  Overlay o = e.overlay();
  CHECK(o.hoverDotted.empty());  // nothing selected (unverified live: kept as before)
  e.setSelection({I2});
  move(e, 111, 281);
  o = e.overlay();
  REQUIRE(o.hover == std::vector<Guid>{I2});
  CHECK(o.hoverDotted.empty());  // the hovered frame is the selection: its children are the selection's own
  e.setSelection({TF});
  move(e, 150, 5);  // "ana frame"'s top padding: a plain frame
  o = e.overlay();
  REQUIRE(o.hover == std::vector<Guid>{AF});
  CHECK(o.hoverDotted.empty());
}
