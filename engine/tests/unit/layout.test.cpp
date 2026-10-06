// Layout (docs/engine.md §4): auto layout, groups, constraints — run by the
// editor inside the transaction that changed their inputs.
#include <cmath>

#include "doctest.h"
#include "editor/Editor.h"
#include "Helpers.h"
#include "base/FractionalIndex.h"
#include "hit/SpatialIndex.h"

using namespace eng;
using namespace eng::test;

namespace {

NodeChange autoLayout(Guid id, StackMode mode, Rect r, double spacing, double padding) {
  NodeChange f = make(id, NodeType::FRAME, kPage, "!", r, "Auto");
  f.props.stackMode = mode;
  f.props.stackSpacing = spacing;
  f.props.stackPaddingLeft = f.props.stackPaddingTop = f.props.stackPaddingRight = f.props.stackPaddingBottom = padding;
  f.props.stackPrimarySizing = StackSize::FIXED;
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
  c.props.stackSpacing = spacing;
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
  f.props.stackWrap = StackWrap::WRAP;  // stackCounterSpacing absent: the same as the gap
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
  c.props.stackPrimaryAlignItems = StackJustify::CENTER;
  c.props.stackCounterAlignItems = StackAlign::CENTER;
  c.props.stackCounterSpacing = 8;
  REQUIRE(e.setProps({F}, c, 0) == OK);
  CHECK(at(e, kids[0].guid).x == doctest::Approx(32));
  CHECK(at(e, kids[0].guid).y == doctest::Approx(53.5));
  CHECK(at(e, kids[5].guid).x == doctest::Approx(76));
  CHECK(at(e, kids[5].guid).y == doctest::Approx(101.5));
}

TEST_CASE("layout: vertical, centred, overflowing (stacks_wrap.fig 'Vertical middle center')") {
  const Guid F{2, 11};
  NodeChange f = autoLayout(F, StackMode::VERTICAL, {0, 0, 280, 195}, 0, 20);
  f.props.stackPrimaryAlignItems = StackJustify::CENTER;
  f.props.stackCounterAlignItems = StackAlign::CENTER;
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
  f.props.stackPrimarySizing = StackSize::RESIZE_TO_FIT_WITH_IMPLICIT_SIZE;
  f.props.stackCounterSizing = StackSize::RESIZE_TO_FIT_WITH_IMPLICIT_SIZE;
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
  fixed.props.stackPrimarySizing = StackSize::FIXED;
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
