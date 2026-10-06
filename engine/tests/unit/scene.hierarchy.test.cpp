#include <algorithm>

#include "doctest.h"
#include "Helpers.h"

using namespace eng;
using namespace eng::test;

TEST_CASE("hierarchy: children sorted by position, back to front, ties by GUID") {
  Document d;
  base(d);
  d.apply(make({1, 1}, NodeType::ROUNDED_RECTANGLE, kPage, "a", {0, 0, 10, 10}));
  d.apply(make({1, 2}, NodeType::ROUNDED_RECTANGLE, kPage, "B", {0, 0, 10, 10}));
  d.apply(make({1, 3}, NodeType::ROUNDED_RECTANGLE, kPage, "Z", {0, 0, 10, 10}));
  d.apply(make({1, 0}, NodeType::ROUNDED_RECTANGLE, kPage, "Z", {0, 0, 10, 10}));
  auto& kids = d.children(kPage);
  REQUIRE(kids.size() == 4);
  CHECK(kids[0] == Guid{1, 2});
  CHECK(kids[1] == Guid{1, 0});
  CHECK(kids[2] == Guid{1, 3});
  CHECK(kids[3] == Guid{1, 1});
}

TEST_CASE("hierarchy: apply returns the inverse") {
  Document d;
  base(d);
  NodeChange inv;
  REQUIRE(d.apply(make({1, 1}, NodeType::ROUNDED_RECTANGLE, kPage, "O", {5, 6, 10, 20}), &inv));
  CHECK(inv.phase == Phase::REMOVED);

  NodeChange c = NodeChange::changed({1, 1});
  c.mask = F_NAME | F_OPACITY;
  c.props.name = "Renamed";
  c.props.opacity = 0.5;
  REQUIRE(d.apply(c, &inv));
  CHECK(inv.phase == Phase::CHANGED);
  CHECK(inv.mask == (F_NAME | F_OPACITY));
  CHECK(inv.props.name == "ROUNDED_RECTANGLE");
  CHECK(inv.props.opacity == 1);
  CHECK(d.get({1, 1})->props.name == "Renamed");
  CHECK(d.get({1, 1})->props.size == Vec2{10, 20});  // fields outside the mask untouched

  REQUIRE(d.apply(inv));
  CHECK(d.get({1, 1})->props.name == "ROUNDED_RECTANGLE");

  REQUIRE(d.apply(NodeChange::removed({1, 1}), &inv));
  CHECK_FALSE(d.has({1, 1}));
  CHECK(inv.phase == Phase::CREATED);
  REQUIRE(d.apply(inv));
  CHECK(d.get({1, 1})->props.transform.m02 == 5);
  CHECK(d.children(kPage).size() == 1);
}

TEST_CASE("hierarchy: CREATED for a live GUID is a full replace") {
  Document d;
  base(d);
  d.apply(make({1, 1}, NodeType::FRAME, kPage, "O", {0, 0, 100, 100}, "A"));
  d.apply(make({1, 2}, NodeType::FRAME, kPage, "P", {0, 0, 100, 100}, "B"));
  NodeChange inv;
  REQUIRE(d.apply(make({1, 1}, NodeType::ELLIPSE, {1, 2}, "O", {1, 2, 3, 4}, "C"), &inv));
  CHECK(d.get({1, 1})->props.type == NodeType::ELLIPSE);
  CHECK(d.parentOf({1, 1}) == Guid{1, 2});
  CHECK(d.children(kPage).size() == 1);
  REQUIRE(d.apply(inv));
  CHECK(d.get({1, 1})->props.name == "A");
  CHECK(d.parentOf({1, 1}) == kPage);
}

TEST_CASE("hierarchy: refusals, cycles and orphans") {
  Document d;
  base(d);
  d.apply(make({1, 1}, NodeType::FRAME, kPage, "O", {0, 0, 100, 100}));
  d.apply(make({1, 2}, NodeType::FRAME, {1, 1}, "O", {0, 0, 50, 50}));
  CHECK_FALSE(d.apply(NodeChange::removed({9, 9})));  // unknown: ignored
  NodeChange cycle = NodeChange::changed({1, 1});
  cycle.mask = F_PARENT_INDEX;
  cycle.props.parentIndex = {{1, 2}, "O"};
  CHECK_FALSE(d.apply(cycle));
  CHECK(d.parentOf({1, 1}) == kPage);
  // A child that arrives before its parent is parked, then joins it.
  d.apply(make({2, 2}, NodeType::ROUNDED_RECTANGLE, {2, 1}, "O", {0, 0, 1, 1}));
  CHECK(d.pathFromPage({2, 2}).empty());
  d.apply(make({2, 1}, NodeType::FRAME, kPage, "P", {0, 0, 10, 10}));
  CHECK(d.pathFromPage({2, 2}) == std::vector<Guid>{{2, 1}, {2, 2}});
}

TEST_CASE("hierarchy: reparenting moves between children lists") {
  Document d;
  base(d);
  d.apply(make({1, 1}, NodeType::FRAME, kPage, "O", {100, 100, 200, 200}));
  d.apply(make({1, 2}, NodeType::ROUNDED_RECTANGLE, kPage, "P", {0, 0, 10, 10}));
  NodeChange c = NodeChange::changed({1, 2});
  c.mask = F_PARENT_INDEX;
  c.props.parentIndex = {{1, 1}, "O"};
  REQUIRE(d.apply(c));
  CHECK(d.children(kPage).size() == 1);
  CHECK(d.children({1, 1}).size() == 1);
  CHECK(d.isAncestor({1, 1}, {1, 2}));
  CHECK(d.pathFromPage({1, 2}) == std::vector<Guid>{{1, 1}, {1, 2}});
  CHECK(d.pageOf({1, 2}) == kPage);
}

TEST_CASE("hierarchy: world transforms and bounds; groups are their children's box") {
  Document d;
  base(d);
  d.apply(make({1, 1}, NodeType::FRAME, kPage, "O", {100, 50, 200, 200}));
  d.apply(make({1, 2}, NodeType::ROUNDED_RECTANGLE, {1, 1}, "O", {10, 20, 30, 40}));
  Mat2x3 w = d.worldTransform({1, 2});
  CHECK(w.m02 == 110);
  CHECK(w.m12 == 70);
  CHECK(d.worldBounds({1, 2}) == Rect{110, 70, 30, 40});

  // A group carries its own box (layout fits it to its children, see layout.test.cpp).
  NodeChange group = make({1, 3}, NodeType::FRAME, kPage, "P", {10, 10, 30, 40}, "Group 1");
  group.props.resizeToFit = true;
  group.props.fillPaints.clear();
  d.apply(group);
  d.apply(make({1, 4}, NodeType::ROUNDED_RECTANGLE, {1, 3}, "O", {0, 0, 10, 10}));
  d.apply(make({1, 5}, NodeType::ROUNDED_RECTANGLE, {1, 3}, "P", {20, 30, 10, 10}));
  CHECK(d.localBounds({1, 3}) == Rect{0, 0, 30, 40});
  CHECK(d.worldBounds({1, 3}) == Rect{10, 10, 30, 40});
  CHECK(d.worldBounds({1, 5}) == Rect{30, 40, 10, 10});
}

TEST_CASE("hierarchy: the spatial index follows moves, reparents and removals") {
  Document d;
  base(d);
  d.apply(make({1, 1}, NodeType::FRAME, kPage, "O", {0, 0, 100, 100}));
  d.apply(make({1, 2}, NodeType::ROUNDED_RECTANGLE, {1, 1}, "O", {10, 10, 10, 10}));
  auto at = [&](Rect r) {
    std::vector<Guid> out;
    d.query(kPage, r, [&](Guid id) {
      out.push_back(id);
      return true;
    });
    std::sort(out.begin(), out.end());
    return out;
  };
  CHECK(at({12, 12, 1, 1}) == std::vector<Guid>{{1, 1}, {1, 2}});
  NodeChange move = NodeChange::changed({1, 1});
  move.mask = F_TRANSFORM;
  move.props.transform = Mat2x3::translate(500, 0);
  d.apply(move);
  CHECK(at({12, 12, 1, 1}).empty());
  CHECK(at({512, 12, 1, 1}) == std::vector<Guid>{{1, 1}, {1, 2}});  // the child moved with its parent
  d.apply(NodeChange::removed({1, 2}));
  CHECK(at({512, 12, 1, 1}) == std::vector<Guid>{{1, 1}});
  REQUIRE(d.indexOf(kPage));
  CHECK(d.indexOf(kPage)->valid());
}

TEST_CASE("hierarchy: positionAtEnd and maxLocalID") {
  Document d;
  base(d);
  CHECK(d.positionAtEnd(kPage) == "!");
  d.apply(make({3, 7}, NodeType::ROUNDED_RECTANGLE, kPage, d.positionAtEnd(kPage), {0, 0, 1, 1}));
  CHECK(d.positionAtEnd(kPage) == "\"");
  CHECK(d.maxLocalID(3) == 7);
  CHECK(d.maxLocalID(4) == 0);
}
