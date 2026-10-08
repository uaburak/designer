// Layout (docs/engine.md §4): auto layout, groups, constraints — run by the
// editor inside the transaction that changed their inputs.
#include <cmath>

#include "doctest.h"
#include "editor/Editor.h"
#include "Helpers.h"
#include "base/FractionalIndex.h"
#include "hit/SpatialIndex.h"
#include "base/Json.h"
#include "scene/CodecJson.h"

using namespace eng;
using namespace eng::test;

namespace {

NodeChange autoLayout(Guid id, StackMode mode, Rect r, double spacing, double padding) {
  NodeChange f = make(id, NodeType::FRAME, kPage, "!", r, "Auto");
  f.props.stack().stackMode = mode;
  f.props.stack().stackSpacing = spacing;
  f.props.stack().stackPaddingLeft = f.props.stack().stackPaddingTop = f.props.stack().stackPaddingRight = f.props.stack().stackPaddingBottom = padding;
  f.props.stack().stackPrimarySizing = StackSize::FIXED;
  return f;
}

std::vector<NodeChange> squares(Guid parent, int n, double side) {
  std::vector<NodeChange> out;
  std::string key;
  for (int i = 0; i < n; i++) {
    key = fractional::keyBetween(key, std::nullopt, fractional::Bias::Low);
    out.push_back(make({parent.localID + 100, static_cast<uint32_t>(i + 1)}, NodeType::ROUNDED_RECTANGLE, parent, key, {0, 0, side, side}));
  }
  return out;
}

Editor load(std::vector<NodeChange> nodes) {
  auto all = baseChanges();
  all.insert(all.end(), nodes.begin(), nodes.end());
  Editor e;
  e.loadDocument(all, kNoGuid);
  e.takeEvents();
  return e;
}

// Changes one field of the frame so its layout runs (as a panel edit would).
void touch(Editor& e, Guid frame, double spacing) {
  NodeChange c;
  c.mask = F_STACK_SPACING;
  c.props.stack().stackSpacing = spacing;
  REQUIRE(e.setProps({frame}, c, 0) == OK);
}

Vec2 at(const Editor& e, Guid id) {
  const Mat2x3& t = e.document().get(id)->props.transform;
  return {t.m02, t.m12};
}

}  // namespace

TEST_CASE("layout: horizontal wrap, as Figma lays out stacks_wrap.fig") {
  const Guid F{1, 2};
  NodeChange f = autoLayout(F, StackMode::HORIZONTAL, {0, 0, 280, 195}, 0, 20);
  f.props.stack().stackWrap = StackWrap::WRAP;  // stackCounterSpacing absent: the same as the gap
  auto kids = squares(F, 8, 40);
  std::vector<NodeChange> nodes{f};
  nodes.insert(nodes.end(), kids.begin(), kids.end());
  Editor e = load(nodes);
  touch(e, F, 4);
  const double xs[8] = {20, 64, 108, 152, 196, 20, 64, 108};
  const double ys[8] = {20, 20, 20, 20, 20, 64, 64, 64};
  for (int i = 0; i < 8; i++) {
    Vec2 p = at(e, kids[static_cast<size_t>(i)].guid);
    CHECK(p.x == doctest::Approx(xs[i]));
    CHECK(p.y == doctest::Approx(ys[i]));
  }
  // Centre / centre with a counter gap of 8 (Figma: 32 / 53.5, then 76 / 101.5).
  NodeChange c;
  c.mask = F_STACK_PRIMARY_ALIGN | F_STACK_COUNTER_ALIGN | F_STACK_COUNTER_SPACING;
  c.props.stack().stackPrimaryAlignItems = StackJustify::CENTER;
  c.props.stack().stackCounterAlignItems = StackAlign::CENTER;
  c.props.stack().stackCounterSpacing = 8;
  REQUIRE(e.setProps({F}, c, 0) == OK);
  CHECK(at(e, kids[0].guid).x == doctest::Approx(32));
  CHECK(at(e, kids[0].guid).y == doctest::Approx(53.5));
  CHECK(at(e, kids[5].guid).x == doctest::Approx(76));
  CHECK(at(e, kids[5].guid).y == doctest::Approx(101.5));
}

TEST_CASE("layout: Figma's space between is SPACE_EVENLY in its files; a lone child is centred; CSS evenly is SPACE_EVENLY_CSS") {
  // Figma's own numbers (a vertical 150 tall frame, padding 16: children 17 and 49 tall at 16 and 85; a lone 286 tall
  // child in an 804 tall frame, padding 24, at 259).
  const Guid F{3, 1}, G{3, 2};
  NodeChange f = autoLayout(F, StackMode::VERTICAL, {0, 0, 130, 150}, 0, 16);
  f.props.stack().stackPrimaryAlignItems = StackJustify::SPACE_EVENLY;
  NodeChange a = make({3, 11}, NodeType::ROUNDED_RECTANGLE, F, "!", {0, 0, 98, 17});
  NodeChange b = make({3, 12}, NodeType::ROUNDED_RECTANGLE, F, "\"", {0, 0, 98, 49});
  NodeChange g = autoLayout(G, StackMode::VERTICAL, {200, 0, 300, 804}, 0, 24);
  g.props.stack().stackPrimaryAlignItems = StackJustify::SPACE_EVENLY;
  NodeChange lone = make({3, 21}, NodeType::ROUNDED_RECTANGLE, G, "!", {0, 0, 100, 286});
  Editor e = load({f, a, b, g, lone});
  touch(e, F, 0);
  touch(e, G, 0);
  CHECK(at(e, a.guid).y == doctest::Approx(16));
  CHECK(at(e, b.guid).y == doctest::Approx(85));
  CHECK(at(e, lone.guid).y == doctest::Approx(259));
  // The kiwi SPACE_BETWEEN lays out the same; SPACE_EVENLY_CSS spaces evenly: (150 - 32 - 66) / 3 = 17.33.
  NodeChange c;
  c.mask = F_STACK_PRIMARY_ALIGN;
  c.props.stack().stackPrimaryAlignItems = StackJustify::SPACE_BETWEEN;
  REQUIRE(e.setProps({F}, c, 0) == OK);
  CHECK(at(e, b.guid).y == doctest::Approx(85));
  c.props.stack().stackPrimaryAlignItems = StackJustify::SPACE_EVENLY_CSS;
  REQUIRE(e.setProps({F}, c, 0) == OK);
  CHECK(at(e, a.guid).y == doctest::Approx(16 + 52.0 / 3));
}

namespace {

const Guid F_GRID_FRAME{8, 1};

// A GRID frame as Figma writes it (its grid fields are kept as the node's kiwi bytes), from the JSON wire.
NodeChange gridNode(const std::string& json) {
  json::Value v;
  REQUIRE(json::parse(json, v));
  NodeChange c;
  REQUIRE(codec::readChange(v, c));
  c.phase = Phase::CREATED;
  c.mask = F_ALL;
  return c;
}

std::string track(int id, const char* pos) { return R"({"id":{"sessionID":9,"localID":)" + std::to_string(id) + R"(},"position":")" + pos + R"("})"; }
std::string sizing(int id, const char* type, double v) {
  std::string f = std::string(R"({"type":")") + type + R"(","value":)" + std::to_string(v) + "}";
  return R"({"id":{"sessionID":9,"localID":)" + std::to_string(id) + R"(},"trackSize":{"minSizing":)" + f + R"(,"maxSizing":)" + f + "}}";
}

}  // namespace

TEST_CASE("layout: grid — tracks (fixed, hug, flex), gaps, reflow placement with spans, fill and alignment") {
  // 3 columns (FLEX 1, FLEX 2, FIXED 60) in 400 wide, padding 10, gaps 8 / 6; rows hug; height hugs. Reflow: the
  // items flow by layer order; the second spans two columns.
  std::string cols = "[" + track(1, "!") + "," + track(2, "#") + "," + track(3, "$") + "]";
  std::string colSizing = "[" + sizing(1, "FLEX", 1) + "," + sizing(2, "FLEX", 2) + "," + sizing(3, "FIXED", 60) + "]";
  std::string rows = "[" + track(11, "!") + "]";
  NodeChange f = gridNode(R"({"guid":"8:1","type":"FRAME","name":"Grid","parentIndex":{"guid":"0:1","position":"!"},"size":{"x":400,"y":10},)"
                          R"("stackMode":"GRID","stackPrimarySizing":"FIXED","stackCounterSizing":"RESIZE_TO_FIT_WITH_IMPLICIT_SIZE",)"
                          R"("stackHorizontalPadding":10,"stackVerticalPadding":10,"stackPaddingRight":10,"stackPaddingBottom":10,)"
                          R"("gridColumnGap":8,"gridRowGap":6,"gridReflowEnabled":true,"gridColumns":{"entries":)" + cols +
                          R"(},"gridColumnsSizing":{"entries":)" + colSizing + R"(},"gridRows":{"entries":)" + rows + "}}");
  REQUIRE(f.props.stack().stackMode == StackMode::GRID);
  REQUIRE(f.props.extra.count("gridColumns"));
  auto child = [](int id, const char* pos, double w, double h, const std::string& more = "") {
    return gridNode(R"({"guid":"8:)" + std::to_string(id) + R"(","type":"ROUNDED_RECTANGLE","parentIndex":{"guid":"8:1","position":")" + pos +
                    R"("},"size":{"x":)" + std::to_string(w) + R"(,"y":)" + std::to_string(h) + "}" + more + "}");
  };
  NodeChange a = child(2, "!", 30, 20);                                                          // (0,0)
  NodeChange b = child(3, "#", 50, 40, R"(,"gridColumnSpan":2,"stackChildPrimaryGrow":1)");    // (1..2, 0), fill width
  NodeChange c = child(4, "$", 20, 10, R"(,"gridChildHorizontalAlign":"CENTER","gridChildVerticalAlign":"MAX")");  // (0,1)
  NodeChange d = child(5, "%", 10, 10, R"(,"stackChildAlignSelf":"STRETCH")");                  // (1,1), fill height
  Editor e = load({f, a, b, c, d});
  touch(e, F_GRID_FRAME, 0);
  // Inner width 380 - gaps 16 - fixed 60 = 304: flex 101.33 / 202.67.
  const double c0 = 304.0 / 3, c1 = 608.0 / 3;
  CHECK(at(e, a.guid).x == doctest::Approx(10));
  CHECK(at(e, a.guid).y == doctest::Approx(10));
  CHECK(at(e, b.guid).x == doctest::Approx(10 + c0 + 8));
  CHECK(e.document().get(b.guid)->props.size.x == doctest::Approx(c1 + 8 + 60));
  // Row 0 is 40 tall (b), row 1 is 10 (c and d): c centred in column 0, at the row's bottom.
  CHECK(at(e, c.guid).x == doctest::Approx(10 + (c0 - 20) / 2));
  CHECK(at(e, c.guid).y == doctest::Approx(10 + 40 + 6));
  CHECK(at(e, d.guid).x == doctest::Approx(10 + c0 + 8));
  CHECK(e.document().get(d.guid)->props.size.y == doctest::Approx(10));
  // The frame hugs its rows: 10 + 40 + 6 + 10 + 10.
  CHECK(e.document().get(F_GRID_FRAME)->props.size.y == doctest::Approx(76));
}

TEST_CASE("layout: grid without reflow places items at their anchors") {
  std::string cols = "[" + track(1, "!") + "," + track(2, "#") + "]";
  std::string colSizing = "[" + sizing(1, "FIXED", 50) + "," + sizing(2, "FIXED", 50) + "]";
  std::string rows = "[" + track(11, "!") + "," + track(12, "#") + "]";
  std::string rowSizing = "[" + sizing(11, "FIXED", 30) + "," + sizing(12, "FIXED", 30) + "]";
  NodeChange f = gridNode(R"({"guid":"8:1","type":"FRAME","parentIndex":{"guid":"0:1","position":"!"},"size":{"x":100,"y":60},)"
                          R"("stackMode":"GRID","stackPrimarySizing":"FIXED","stackCounterSizing":"FIXED","gridColumns":{"entries":)" + cols +
                          R"(},"gridColumnsSizing":{"entries":)" + colSizing + R"(},"gridRows":{"entries":)" + rows + R"(},"gridRowsSizing":{"entries":)" +
                          rowSizing + "}}");
  NodeChange a = gridNode(R"({"guid":"8:2","type":"ROUNDED_RECTANGLE","parentIndex":{"guid":"8:1","position":"!"},"size":{"x":10,"y":10},)"
                          R"("gridColumnAnchor":{"sessionID":9,"localID":2},"gridRowAnchor":{"sessionID":9,"localID":12}})");
  Editor e = load({f, a});
  touch(e, F_GRID_FRAME, 0);
  CHECK(at(e, a.guid).x == doctest::Approx(50));
  CHECK(at(e, a.guid).y == doctest::Approx(30));
}

TEST_CASE("layout: vertical, centred, overflowing (stacks_wrap.fig 'Vertical middle center')") {
  const Guid F{2, 11};
  NodeChange f = autoLayout(F, StackMode::VERTICAL, {0, 0, 280, 195}, 0, 20);
  f.props.stack().stackPrimaryAlignItems = StackJustify::CENTER;
  f.props.stack().stackCounterAlignItems = StackAlign::CENTER;
  auto kids = squares(F, 8, 40);
  std::vector<NodeChange> nodes{f};
  nodes.insert(nodes.end(), kids.begin(), kids.end());
  Editor e = load(nodes);
  touch(e, F, 8);
  for (int i = 0; i < 8; i++) {
    Vec2 p = at(e, kids[static_cast<size_t>(i)].guid);
    CHECK(p.x == doctest::Approx(120));
    CHECK(p.y == doctest::Approx(-90.5 + 48 * i));
  }
}

TEST_CASE("layout: hug, fill and undo") {
  const Guid F{3, 1};
  NodeChange f = autoLayout(F, StackMode::HORIZONTAL, {0, 0, 10, 10}, 0, 10);
  f.props.stack().stackPrimarySizing = StackSize::RESIZE_TO_FIT_WITH_IMPLICIT_SIZE;
  f.props.stack().stackCounterSizing = StackSize::RESIZE_TO_FIT_WITH_IMPLICIT_SIZE;
  auto kids = squares(F, 3, 20);
  std::vector<NodeChange> nodes{f};
  nodes.insert(nodes.end(), kids.begin(), kids.end());
  Editor e = load(nodes);
  touch(e, F, 5);
  CHECK(e.document().get(F)->props.size == Vec2{10 + 20 * 3 + 5 * 2 + 10, 10 + 20 + 10});
  CHECK(at(e, kids[2].guid).x == doctest::Approx(10 + 25 * 2));
  // Fixed width 200: the middle child fills what's left.
  NodeChange fixed;
  fixed.mask = F_STACK_PRIMARY_SIZING | F_SIZE;
  fixed.props.stack().stackPrimarySizing = StackSize::FIXED;
  fixed.props.size = {200, 40};
  REQUIRE(e.setProps({F}, fixed, 0) == OK);
  NodeChange grow;
  grow.mask = F_STACK_CHILD_GROW;
  grow.props.stackChildPrimaryGrow = 1;
  REQUIRE(e.setProps({kids[1].guid}, grow, 0) == OK);
  CHECK(e.document().get(kids[1].guid)->props.size.x == doctest::Approx(200 - 20 - 40 - 10));
  CHECK(at(e, kids[2].guid).x == doctest::Approx(200 - 10 - 20));
  e.command(CommandId::UNDO);
  CHECK(e.document().get(kids[1].guid)->props.size.x == doctest::Approx(20));
}

TEST_CASE("layout: a group fits its children and nothing moves on the page") {
  const Guid G{4, 1}, A{4, 2};
  NodeChange g = make(G, NodeType::FRAME, kPage, "!", {10, 310, 40, 40}, "Group 1");
  g.props.resizeToFit = true;
  g.props.fillPaints.clear();
  Editor e = load({g, make(A, NodeType::ROUNDED_RECTANGLE, G, "!", {0, 0, 40, 40})});
  e.setSelection({A});
  e.command(CommandId::NUDGE, 10, 0);
  CHECK(at(e, G).x == doctest::Approx(20));
  CHECK(at(e, A).x == doctest::Approx(0));
  CHECK(e.document().worldBounds(A).x == doctest::Approx(20));
  CHECK(e.document().get(G)->props.size == Vec2{40, 40});
  // Its last child deleted: the group goes too (Figma).
  e.command(CommandId::DELETE);
  CHECK_FALSE(e.document().has(G));
  e.command(CommandId::UNDO);
  CHECK(e.document().has(G));
  CHECK(e.document().has(A));
}

TEST_CASE("layout: constraints when a frame is resized") {
  const Guid F{5, 1}, R{5, 2}, S{5, 3};
  NodeChange r = make(R, NodeType::ROUNDED_RECTANGLE, F, "!", {10, 10, 20, 20});
  r.props.horizontalConstraint = ConstraintType::MAX;
  r.props.verticalConstraint = ConstraintType::STRETCH;
  NodeChange s = make(S, NodeType::ROUNDED_RECTANGLE, F, "\"", {40, 40, 20, 20});
  s.props.horizontalConstraint = ConstraintType::SCALE;
  s.props.verticalConstraint = ConstraintType::CENTER;
  Editor e = load({make(F, NodeType::FRAME, kPage, "!", {0, 0, 100, 100}), r, s});
  NodeChange size;
  size.mask = F_SIZE;
  size.props.size = {200, 150};
  REQUIRE(e.setProps({F}, size, 0) == OK);
  CHECK(at(e, R).x == doctest::Approx(110));                                  // right: kept 70 from the right edge
  CHECK(e.document().get(R)->props.size.y == doctest::Approx(70));            // top & bottom: grows with the frame
  CHECK(at(e, S).x == doctest::Approx(80));                                   // scale
  CHECK(e.document().get(S)->props.size.x == doctest::Approx(40));
  CHECK(at(e, S).y == doctest::Approx(65));                                   // centre
}

TEST_CASE("spatial index: stays balanced and valid under churn") {
  SpatialIndex index;
  std::vector<int> proxies;
  for (uint32_t i = 0; i < 2000; i++) proxies.push_back(index.insert({double(i % 50) * 10, double(i / 50) * 10, 5, 5}, {1, i}));
  CHECK(index.valid());
  CHECK(index.height() < 30);
  for (size_t i = 0; i < proxies.size(); i += 3) index.move(proxies[i], {1000.0 + double(i), 7, 5, 5});
  for (size_t i = 1; i < proxies.size(); i += 5) index.remove(proxies[i]);
  CHECK(index.valid());
  int found = 0;
  index.query({0, 0, 15, 15}, [&](Guid) {
    found++;
    return true;
  });
  CHECK(found > 0);
}

// ---- Figma's hug rules, as its files lay out (round 5: engine layout against a large file's stored geometry) -------

TEST_CASE("layout: a stretched child of a parent hugging that axis counts for its content (Figma's table rows)") {
  // A row hugging its height holds two cells that fill it (STRETCH), each a vertical stack of fixed height 28: the
  // first holds two 28 px rows (gap 4), so the row — and both cells — are 60 tall, not the cells' stored 28.
  const Guid ROW{9, 1}, A{9, 2}, B{9, 3};
  NodeChange row = autoLayout(ROW, StackMode::HORIZONTAL, {0, 0, 200, 28}, 0, 0);
  row.props.stack().stackCounterSizing = StackSize::RESIZE_TO_FIT_WITH_IMPLICIT_SIZE;
  NodeChange a = autoLayout(A, StackMode::VERTICAL, {0, 0, 100, 28}, 4, 0);
  NodeChange b = autoLayout(B, StackMode::VERTICAL, {100, 0, 100, 28}, 4, 0);
  for (NodeChange* c : {&a, &b}) {
    c->props.parentIndex.guid = ROW;
    c->props.stackChildAlignSelf = StackCounterAlign::STRETCH;
  }
  b.props.parentIndex.position = "#";
  auto rowsA = squares(A, 2, 28), rowsB = squares(B, 1, 28);
  std::vector<NodeChange> nodes{row, a, b};
  nodes.insert(nodes.end(), rowsA.begin(), rowsA.end());
  nodes.insert(nodes.end(), rowsB.begin(), rowsB.end());
  Editor e = load(nodes);
  touch(e, ROW, 0);
  CHECK(e.document().get(ROW)->props.size.y == doctest::Approx(60));
  CHECK(e.document().get(A)->props.size.y == doctest::Approx(60));
  CHECK(e.document().get(B)->props.size.y == doctest::Approx(60));
  CHECK(at(e, rowsA[1].guid).y == doctest::Approx(32));
}

TEST_CASE("layout: a Fill child on the primary axis of a parent hugging it keeps its own size") {
  // A vertical stack hugging its height holds a child set to Fill height (grow), fixed at 28, whose content is 40:
  // Figma measures it at its own 28, not its content.
  const Guid V{9, 11}, C{9, 12};
  NodeChange v = autoLayout(V, StackMode::VERTICAL, {0, 0, 100, 10}, 0, 2);
  v.props.stack().stackPrimarySizing = StackSize::RESIZE_TO_FIT_WITH_IMPLICIT_SIZE;
  NodeChange c = autoLayout(C, StackMode::HORIZONTAL, {0, 0, 100, 28}, 0, 0);
  c.props.parentIndex.guid = V;
  c.props.stackChildPrimaryGrow = 1;
  NodeChange tall = make({9, 13}, NodeType::ROUNDED_RECTANGLE, C, "!", {0, 0, 40, 40});
  Editor e = load({v, c, tall});
  touch(e, V, 0);
  CHECK(e.document().get(C)->props.size.y == doctest::Approx(28));
  CHECK(e.document().get(V)->props.size.y == doctest::Approx(32));
}

TEST_CASE("layout: an auto-layout frame with nothing in its flow keeps its size") {
  // Figma: emptying (or hiding everything in) a Hug frame doesn't collapse it to its padding.
  const Guid H{9, 21};
  NodeChange h = autoLayout(H, StackMode::HORIZONTAL, {0, 0, 12, 24}, 10, 2);
  h.props.stack().stackPrimarySizing = StackSize::RESIZE_TO_FIT_WITH_IMPLICIT_SIZE;
  h.props.stack().stackCounterSizing = StackSize::RESIZE_TO_FIT_WITH_IMPLICIT_SIZE;
  NodeChange hidden = make({9, 22}, NodeType::ROUNDED_RECTANGLE, H, "!", {0, 0, 40, 40});
  hidden.props.visible = false;
  Editor e = load({h, hidden});
  touch(e, H, 4);
  CHECK(e.document().get(H)->props.size == Vec2{12, 24});
}

TEST_CASE("layout: an absolute auto-layout child is laid out too") {
  const Guid F{9, 31}, A{9, 32};
  NodeChange f = autoLayout(F, StackMode::VERTICAL, {0, 0, 200, 200}, 0, 0);
  NodeChange a = autoLayout(A, StackMode::HORIZONTAL, {50, 50, 10, 10}, 0, 0);
  a.props.parentIndex.guid = F;
  a.props.stackPositioning = StackPositioning::ABSOLUTE;
  a.props.stack().stackPrimarySizing = StackSize::RESIZE_TO_FIT_WITH_IMPLICIT_SIZE;
  a.props.stack().stackCounterSizing = StackSize::RESIZE_TO_FIT_WITH_IMPLICIT_SIZE;
  NodeChange r = make({9, 33}, NodeType::ROUNDED_RECTANGLE, A, "!", {0, 0, 50, 20});
  Editor e = load({f, a, r});
  touch(e, F, 0);
  CHECK(e.document().get(A)->props.size == Vec2{50, 20});
  CHECK(at(e, A).x == doctest::Approx(50));  // still where it was: absolute
}

TEST_CASE("layout: a group with a mask is the mask's size") {
  // What is above a mask is clipped by it: Figma sizes the group to the mask (the circle a 28 px avatar mask cuts).
  const Guid G{9, 41}, MASK{9, 42}, PIC{9, 43};
  NodeChange g = make(G, NodeType::FRAME, kPage, "!", {100, 100, 60, 60}, "Group");
  g.props.resizeToFit = true;
  g.props.fillPaints.clear();
  NodeChange mask = make(MASK, NodeType::ROUNDED_RECTANGLE, G, "!", {10, 10, 28, 28}, "mask");
  mask.props.mask = true;
  NodeChange pic = make(PIC, NodeType::ROUNDED_RECTANGLE, G, "#", {0, 0, 60, 60}, "picture");
  Editor e = load({g, mask, pic});
  e.setSelection({MASK});
  e.command(CommandId::NUDGE, 1, 0);
  CHECK(e.document().get(G)->props.size == Vec2{28, 28});
  CHECK(e.document().worldBounds(MASK).x == doctest::Approx(111));
}

TEST_CASE("layout: grid — items that fill a row's height don't size a Hug row; a row nothing sizes takes the frame's height") {
  // One Hug row; both items fill its height (as a table's cells do). Nothing sizes the row: the frame (Hug height)
  // keeps its 32, the row takes it and the items fill it — Figma, not CSS's content height.
  std::string cols = "[" + track(1, "!") + "," + track(2, "#") + "]";
  std::string colSizing = "[" + sizing(1, "FLEX", 1) + "," + sizing(2, "FLEX", 1) + "]";
  std::string rows = "[" + track(11, "!") + "]";
  NodeChange f = gridNode(R"({"guid":"8:1","type":"FRAME","parentIndex":{"guid":"0:1","position":"!"},"size":{"x":200,"y":32},)"
                          R"("stackMode":"GRID","stackPrimarySizing":"FIXED","stackCounterSizing":"RESIZE_TO_FIT_WITH_IMPLICIT_SIZE",)"
                          R"("gridReflowEnabled":true,"gridColumns":{"entries":)" + cols + R"(},"gridColumnsSizing":{"entries":)" + colSizing +
                          R"(},"gridRows":{"entries":)" + rows + "}}");
  auto cell = [](int id, const char* pos) {
    return gridNode(R"({"guid":"8:)" + std::to_string(id) + R"(","type":"ROUNDED_RECTANGLE","parentIndex":{"guid":"8:1","position":")" + pos +
                    R"("},"size":{"x":100,"y":26},"stackChildPrimaryGrow":1,"stackChildAlignSelf":"STRETCH"})");
  };
  NodeChange a = cell(2, "!"), b = cell(3, "#");
  Editor e = load({f, a, b});
  touch(e, F_GRID_FRAME, 0);
  CHECK(e.document().get(F_GRID_FRAME)->props.size.y == doctest::Approx(32));
  CHECK(e.document().get(a.guid)->props.size.y == doctest::Approx(32));
  CHECK(e.document().get(b.guid)->props.size == Vec2{100, 32});
  // An item that doesn't fill the row (fixed at 26) sizes it.
  NodeChange c;
  c.mask = F_STACK_CHILD_ALIGN_SELF | F_SIZE;
  c.props.stackChildAlignSelf = StackCounterAlign::AUTO;
  c.props.size = {100, 26};
  REQUIRE(e.setProps({b.guid}, c, 0) == OK);
  CHECK(e.document().get(F_GRID_FRAME)->props.size.y == doctest::Approx(26));
  CHECK(e.document().get(a.guid)->props.size.y == doctest::Approx(26));
}
