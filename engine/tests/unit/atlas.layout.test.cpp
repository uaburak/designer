// Atlas wave 2, layout (docs/research/atlas/09-layout.md §11): the layout version (stackLayoutVersion, Legacy /
// Updated) and its six rules, new stacks made Updated, the version command; auto layout inferred from where layers
// sit (grids and wraps too, negative gaps), Suggest auto layout and Remove all auto layout.
#include <cmath>

#include "doctest.h"
#include "base/Json.h"
#include "editor/Editor.h"
#include "layout/Infer.h"
#include "Helpers.h"

using namespace eng;
using namespace eng::test;

namespace {

// A horizontal auto-layout frame of a fixed size at the origin, no gap; `version` 1 Updated, 0 Legacy (absent).
NodeChange stack(Guid id, Rect r, double padding, uint32_t version) {
  NodeChange f = make(id, NodeType::FRAME, kPage, "!", r, "Auto");
  f.props.stack().stackMode = StackMode::HORIZONTAL;
  f.props.stack().stackPaddingLeft = f.props.stack().stackPaddingTop = f.props.stack().stackPaddingRight = f.props.stack().stackPaddingBottom = padding;
  f.props.stack().stackPrimarySizing = StackSize::FIXED;
  if (version) f.props.extra["stackLayoutVersion"] = Layout::stackLayoutVersionBytes(version);
  return f;
}

void stroke(NodeProps& p, StrokeAlign align, double weight) {
  p.strokePaints = {Paint::solid(Color::hex(0x000000))};
  p.strokeWeight = weight;
  p.strokeAlign = align;
}

Editor load(std::vector<NodeChange> nodes) {
  auto all = baseChanges();
  all.insert(all.end(), nodes.begin(), nodes.end());
  Editor e;
  e.setSessionID(1);
  e.loadDocument(all, kNoGuid);
  e.takeEvents();
  return e;
}

// Changes the frame's gap so its layout runs (as a panel edit would).
void touch(Editor& e, Guid frame, double gap = 0) {
  NodeChange c;
  c.mask = F_STACK_SPACING;
  c.props.stack().stackSpacing = gap;
  REQUIRE(e.setProps({frame}, c, 0) == OK);
}

const NodeProps& props(const Editor& e, Guid id) { return e.document().get(id)->props; }
double x(const Editor& e, Guid id) { return props(e, id).transform.m02; }
double y(const Editor& e, Guid id) { return props(e, id).transform.m12; }

CommandArgs args(const char* text) {
  CommandArgs a;
  json::parse(text, a.raw);
  return a;
}

}  // namespace

TEST_CASE("atlas layout: Updated — a frame is never smaller than its padding, its max size notwithstanding") {
  const Guid U{2, 1}, L{2, 2};
  NodeChange u = stack(U, {0, 0, 50, 50}, 30, 1);
  u.props.rare().maxSize = {40, 0};
  NodeChange l = stack(L, {100, 0, 50, 50}, 30, 0);
  l.props.rare().maxSize = {40, 0};
  Editor e = load({u, l});
  touch(e, U);
  touch(e, L);
  CHECK(props(e, U).size == Vec2{60, 60});
  CHECK(props(e, L).size == Vec2{40, 50});  // Legacy: the max holds it
}

TEST_CASE("atlas layout: included strokes — Updated counts an inside one only; Legacy a centre one by half, an outside one whole") {
  for (uint32_t version : {0u, 1u}) {
    for (StrokeAlign align : {StrokeAlign::INSIDE, StrokeAlign::CENTER, StrokeAlign::OUTSIDE}) {
      const Guid F{3, 1}, A{3, 2};
      NodeChange f = stack(F, {0, 0, 100, 100}, 0, version);
      f.props.stack().bordersTakeSpace = true;
      stroke(f.props, align, 4);
      NodeChange a = make(A, NodeType::ROUNDED_RECTANGLE, F, "!", {50, 50, 20, 20});
      Editor e = load({f, a});
      touch(e, F);
      double want = align == StrokeAlign::INSIDE ? 4 : version ? 0 : align == StrokeAlign::CENTER ? 2 : 4;
      CAPTURE(version);
      CHECK(x(e, A) == doctest::Approx(want));
      CHECK(y(e, A) == doctest::Approx(want));
    }
  }
}

TEST_CASE("atlas layout: Legacy measures children with their outside strokes when strokes are included; Updated doesn't") {
  for (uint32_t version : {0u, 1u}) {
    const Guid F{4, 1}, A{4, 2}, B{4, 3};
    NodeChange f = stack(F, {0, 0, 200, 100}, 0, version);
    f.props.stack().bordersTakeSpace = true;
    NodeChange a = make(A, NodeType::ROUNDED_RECTANGLE, F, "!", {0, 0, 20, 20});
    NodeChange b = make(B, NodeType::ROUNDED_RECTANGLE, F, "\"", {0, 0, 20, 20});
    stroke(a.props, StrokeAlign::OUTSIDE, 3);
    stroke(b.props, StrokeAlign::OUTSIDE, 3);
    Editor e = load({f, a, b});
    touch(e, F);
    CAPTURE(version);
    CHECK(x(e, A) == doctest::Approx(version ? 0 : 3));
    CHECK(x(e, B) == doctest::Approx(version ? 20 : 29));
    CHECK(props(e, B).size == Vec2{20, 20});
  }
}

TEST_CASE("atlas layout: Fill children — Updated shares by content box, Legacy by the whole size") {
  for (uint32_t version : {0u, 1u}) {
    const Guid F{5, 1}, A{5, 2}, B{5, 3};
    NodeChange f = stack(F, {0, 0, 200, 50}, 0, version);
    NodeChange a = stack(A, {0, 0, 10, 50}, 0, version);
    a.props.parentIndex = {F, "!"};
    a.props.stack().stackPaddingLeft = a.props.stack().stackPaddingRight = 10;
    a.props.stackChildPrimaryGrow = 1;
    NodeChange b = stack(B, {0, 0, 10, 50}, 0, version);
    b.props.parentIndex = {F, "\""};
    b.props.stack().stackPaddingLeft = b.props.stack().stackPaddingRight = 30;
    b.props.stackChildPrimaryGrow = 1;
    Editor e = load({f, a, b});
    touch(e, F);
    CAPTURE(version);
    // Updated: 20 and 60 of padding, the other 120 shared: 80 / 120 (60 of content each).
    CHECK(props(e, A).size.x == doctest::Approx(version ? 80 : 100));
    CHECK(props(e, B).size.x == doctest::Approx(version ? 120 : 100));
    CHECK(x(e, B) == doctest::Approx(version ? 80 : 100));
  }
}

TEST_CASE("atlas layout: Auto gap (Between) — Updated never below 0 and a lone child at the start; Legacy overlaps and centres") {
  for (uint32_t version : {0u, 1u}) {
    const Guid F{6, 1}, A{6, 2}, B{6, 3}, G{6, 4}, C{6, 5};
    NodeChange f = stack(F, {0, 0, 100, 50}, 0, version);
    f.props.stack().stackPrimaryAlignItems = StackJustify::SPACE_EVENLY;
    NodeChange a = make(A, NodeType::ROUNDED_RECTANGLE, F, "!", {0, 0, 60, 20});
    NodeChange b = make(B, NodeType::ROUNDED_RECTANGLE, F, "\"", {0, 0, 60, 20});
    NodeChange g = stack(G, {200, 0, 100, 50}, 0, version);
    g.props.stack().stackPrimaryAlignItems = StackJustify::SPACE_EVENLY;
    NodeChange c = make(C, NodeType::ROUNDED_RECTANGLE, G, "!", {0, 0, 20, 20});
    Editor e = load({f, a, b, g, c});
    touch(e, F);
    touch(e, G);
    CAPTURE(version);
    CHECK(x(e, B) == doctest::Approx(version ? 60 : 40));
    CHECK(x(e, C) == doctest::Approx(version ? 0 : 40));
  }
}

TEST_CASE("atlas layout: auto layout given now is Updated; the version command updates, reverts and undoes") {
  const Guid P{7, 1}, F{7, 2}, C{7, 3};
  NodeChange plain = make(P, NodeType::FRAME, kPage, "!", {0, 300, 100, 100}, "Plain");
  NodeChange f = stack(F, {0, 0, 100, 50}, 0, 0);
  f.props.stack().stackPrimaryAlignItems = StackJustify::SPACE_EVENLY;
  NodeChange c = make(C, NodeType::ROUNDED_RECTANGLE, F, "!", {0, 0, 20, 20});
  Editor e = load({plain, f, c});
  NodeChange al;
  al.mask = F_STACK_MODE;
  al.props.stack().stackMode = StackMode::VERTICAL;
  REQUIRE(e.setProps({P}, al, 0) == OK);
  CHECK(Layout::stackLayoutVersion(props(e, P)) == 1);
  // A frame already marked keeps its version when auto layout comes back.
  CHECK(!Layout::hasStackLayoutVersion(props(e, F)));

  touch(e, F);
  CHECK(x(e, C) == doctest::Approx(40));
  e.setSelection({F});
  CHECK(e.commandState(CommandId::SET_STACK_LAYOUT_VERSION) == CMD_ENABLED);
  REQUIRE(e.command(CommandId::SET_STACK_LAYOUT_VERSION) == OK);
  CHECK(Layout::updatedLayout(props(e, F)));
  CHECK(x(e, C) == doctest::Approx(0));  // re-laid out by the new rules at once
  CHECK(e.commandState(CommandId::SET_STACK_LAYOUT_VERSION) == CMD_CHECKED);
  CHECK(e.command(CommandId::SET_STACK_LAYOUT_VERSION) == E_INVALID);  // nothing left to update
  e.command(CommandId::UNDO);
  CHECK(!Layout::updatedLayout(props(e, F)));
  CHECK(x(e, C) == doctest::Approx(40));
  e.command(CommandId::REDO);
  REQUIRE(e.command(CommandId::SET_STACK_LAYOUT_VERSION, args("{\"version\": 0}")) == OK);
  CHECK(Layout::stackLayoutVersion(props(e, F)) == 0);
  CHECK(Layout::hasStackLayoutVersion(props(e, F)));  // Legacy chosen is written (0), as Figma's dropdown does
  CHECK(x(e, C) == doctest::Approx(40));
  // The whole page: every stack on it.
  e.setSelection({});
  REQUIRE(e.command(CommandId::SET_STACK_LAYOUT_VERSION, args("{\"page\": true}")) == OK);
  CHECK(Layout::updatedLayout(props(e, F)));
}

TEST_CASE("atlas layout: inference — rows, columns, a grid, a wrap, overlaps, a pile") {
  using infer::Kind;
  // A row 8 and 12 apart: horizontal, gap 10, sharing their tops.
  infer::Stack s = infer::stack({{28, 0, 20, 20}, {0, 0, 20, 20}, {60, 0, 20, 30}});
  CHECK(s.kind == Kind::HORIZONTAL);
  CHECK(s.gap == 10);
  CHECK(s.counterAlign == 0);
  CHECK(s.order == std::vector<size_t>{1, 0, 2});
  // A column centred across.
  s = infer::stack({{0, 0, 40, 10}, {10, 20, 20, 10}});
  CHECK(s.kind == Kind::VERTICAL);
  CHECK(s.counterAlign == 1);
  // Overlapping in a row: a negative gap (Figma takes them).
  s = infer::stack({{0, 0, 20, 20}, {15, 0, 20, 20}});
  CHECK(s.kind == Kind::HORIZONTAL);
  CHECK(s.gap == -5);
  // 3 × 2 in step: a grid, 10 between columns, 6 between rows, read row by row.
  std::vector<Rect> grid;
  for (int r = 0; r < 2; r++)
    for (int c = 2; c >= 0; c--) grid.push_back({c * 30.0, r * 26.0, 20, 20});
  s = infer::stack(grid);
  CHECK(s.kind == Kind::GRID);
  CHECK(s.columns == 3);
  CHECK(s.rows == 2);
  CHECK(s.gap == 10);
  CHECK(s.counterGap == 6);
  CHECK(s.order == std::vector<size_t>{2, 1, 0, 5, 4, 3});
  // Ragged rows from one left edge: a wrap.
  s = infer::stack({{0, 0, 30, 20}, {40, 0, 50, 20}, {100, 0, 20, 20}, {0, 30, 60, 20}});
  CHECK(s.kind == Kind::WRAP);
  CHECK(s.gap == 10);
  CHECK(s.counterGap == 10);
  // A pile: the centres' spread decides.
  s = infer::stack({{0, 0, 100, 100}, {10, 60, 50, 30}});
  CHECK(s.kind == Kind::VERTICAL);
}

TEST_CASE("atlas layout: add auto layout makes a grid of layers in step, and an Updated stack") {
  const Guid F{8, 1};
  std::vector<NodeChange> nodes{make(F, NodeType::FRAME, kPage, "!", {0, 0, 200, 200}, "Frame 1")};
  std::vector<Guid> kids;
  std::string key = "!";
  for (int r = 0; r < 2; r++)
    for (int c = 0; c < 2; c++) {
      Guid id{8, static_cast<uint32_t>(10 + r * 2 + c)};
      kids.push_back(id);
      nodes.push_back(make(id, NodeType::ROUNDED_RECTANGLE, F, key, {10 + c * 50.0, 10 + r * 40.0, 40, 30}));
      key[0]++;
    }
  Editor e = load(nodes);
  e.setSelection({F});
  REQUIRE(e.command(CommandId::ADD_AUTO_LAYOUT) == OK);
  const NodeProps& p = props(e, F);
  CHECK(p.stack().stackMode == StackMode::GRID);
  CHECK(Layout::gridTrackDefs(p, true).size() == 2);
  CHECK(Layout::gridTrackDefs(p, false).size() == 2);
  CHECK(Layout::gridGap(p, true) == 10);
  CHECK(Layout::gridGap(p, false) == 10);
  CHECK(Layout::updatedLayout(p));
  // Nothing moves.
  CHECK(x(e, kids[3]) == doctest::Approx(60));
  CHECK(y(e, kids[3]) == doctest::Approx(50));
}

TEST_CASE("atlas layout: suggest auto layout stacks loose layers into nested frames; remove all takes it back out") {
  // A title over two buttons side by side.
  const Guid T{9, 1}, B1{9, 2}, B2{9, 3};
  Editor e = load({make(T, NodeType::ROUNDED_RECTANGLE, kPage, "!", {0, 0, 200, 40}, "Title"),
                   make(B1, NodeType::ROUNDED_RECTANGLE, kPage, "\"", {0, 60, 80, 30}, "Button 1"),
                   make(B2, NodeType::ROUNDED_RECTANGLE, kPage, "#", {100, 60, 80, 30}, "Button 2")});
  e.setSelection({T, B1, B2});
  CHECK(e.commandState(CommandId::SUGGEST_AUTO_LAYOUT) == CMD_ENABLED);
  REQUIRE(e.command(CommandId::SUGGEST_AUTO_LAYOUT) == OK);
  REQUIRE(e.lastCreated().size() == 2);
  Guid row = e.document().parentOf(B1), outer = e.document().parentOf(T);
  CHECK(e.document().parentOf(B2) == row);
  CHECK(e.document().parentOf(row) == outer);
  CHECK(e.selection() == std::vector<Guid>{outer});
  CHECK(props(e, row).stack().stackMode == StackMode::HORIZONTAL);
  CHECK(props(e, row).stack().stackSpacing == 20);
  CHECK(props(e, outer).stack().stackMode == StackMode::VERTICAL);
  CHECK(props(e, outer).stack().stackSpacing == 20);
  CHECK(e.document().worldBounds(B2).x == doctest::Approx(100));
  CHECK(e.document().worldBounds(B2).y == doctest::Approx(60));

  CHECK(e.commandState(CommandId::REMOVE_ALL_AUTO_LAYOUT) == CMD_ENABLED);
  REQUIRE(e.command(CommandId::REMOVE_ALL_AUTO_LAYOUT) == OK);
  CHECK(e.lastCreated().size() == 2);
  CHECK(!props(e, outer).isAutoLayout());
  CHECK(!props(e, row).isAutoLayout());
  CHECK(e.document().worldBounds(B2).x == doctest::Approx(100));
  CHECK(e.commandState(CommandId::REMOVE_ALL_AUTO_LAYOUT) == 0);
  e.command(CommandId::UNDO);
  e.command(CommandId::UNDO);
  CHECK(e.document().parentOf(B1) == kPage);
  CHECK(e.document().has(row) == false);
}

TEST_CASE("atlas layout: suggest auto layout on a frame makes the frame itself the outer stack") {
  const Guid F{10, 1}, A{10, 2}, B{10, 3}, C{10, 4};
  Editor e = load({make(F, NodeType::FRAME, kPage, "!", {0, 0, 300, 200}, "Card"),
                   make(A, NodeType::ROUNDED_RECTANGLE, F, "!", {16, 16, 100, 20}),
                   make(B, NodeType::ROUNDED_RECTANGLE, F, "\"", {16, 44, 100, 20}),
                   make(C, NodeType::ROUNDED_RECTANGLE, F, "#", {16, 72, 100, 20})});
  e.setSelection({F});
  REQUIRE(e.command(CommandId::SUGGEST_AUTO_LAYOUT) == OK);
  CHECK(e.lastCreated().empty());
  CHECK(props(e, F).stack().stackMode == StackMode::VERTICAL);
  CHECK(props(e, F).stack().stackSpacing == 8);
  CHECK(props(e, F).stack().stackPaddingLeft == 16);
  CHECK(e.document().parentOf(C) == F);
  // Beside loose layers, a frame whose content spills out of it (a clipped illustration) is left as it is.
  const Guid L{10, 8}, I{10, 9}, S1{10, 10}, S2{10, 11};
  Editor spill = load({make(L, NodeType::ROUNDED_RECTANGLE, kPage, "!", {0, 0, 100, 20}), make(I, NodeType::FRAME, kPage, "\"", {0, 40, 100, 100}),
                       make(S1, NodeType::ELLIPSE, I, "!", {60, 20, 80, 80}), make(S2, NodeType::ELLIPSE, I, "\"", {0, 20, 40, 40})});
  spill.setSelection({L, I});
  REQUIRE(spill.command(CommandId::SUGGEST_AUTO_LAYOUT) == OK);
  CHECK(spill.lastCreated().size() == 1);
  CHECK(!props(spill, I).isAutoLayout());
  CHECK(props(spill, I).size == Vec2{100, 100});
  // Nothing left to suggest on a pile.
  const Guid G{10, 5}, P{10, 6}, Q{10, 7};
  Editor pile = load({make(G, NodeType::FRAME, kPage, "!", {0, 0, 100, 100}), make(P, NodeType::ROUNDED_RECTANGLE, G, "!", {0, 0, 50, 50}),
                      make(Q, NodeType::ROUNDED_RECTANGLE, G, "\"", {10, 10, 50, 50})});
  pile.setSelection({P, Q});
  CHECK(pile.command(CommandId::SUGGEST_AUTO_LAYOUT) == E_INVALID);
}

TEST_CASE("atlas layout: a layout guide's Count Auto (0x7fffffff) is as many as fit, never billions") {
  LayoutGrid g;
  g.pattern = LayoutGridPattern::STRIPES;
  g.type = LayoutGridType::MIN;
  g.sectionSize = 40;
  g.gutterSize = 20;
  g.numSections = 0x7fffffff;
  CHECK(layoutGridCount(g, 300) == 5);  // 5 × 40 + 4 × 20 = 280
  g.type = LayoutGridType::STRETCH;
  CHECK(layoutGridCount(g, 300) == 5);
  g.numSections = 0;
  CHECK(layoutGridCount(g, 300) == 1);
  g.numSections = 12;
  CHECK(layoutGridCount(g, 300) == 12);
  g.sectionSize = 0;
  g.gutterSize = 0;
  g.numSections = 0x7fffffff;
  CHECK(layoutGridCount(g, 1e6) == 2048);
}
