#include "doctest.h"
#include "Helpers.h"
#include "editor/Undo.h"

using namespace eng;
using namespace eng::test;

namespace {
void move(Document& d, UndoStack& u, Guid id, double x) {
  NodeChange c = NodeChange::changed(id);
  c.mask = F_TRANSFORM;
  c.props.transform = Mat2x3::translate(x, 0);
  NodeChange inv;
  REQUIRE(d.apply(c, &inv));
  u.record(inv);
}
}  // namespace

TEST_CASE("undo: a gesture is one step, folded to its first values") {
  Document d;
  base(d);
  d.apply(make({1, 1}, NodeType::ROUNDED_RECTANGLE, kPage, "O", {0, 0, 10, 10}));
  UndoStack u;
  u.begin({});
  for (int i = 1; i <= 50; i++) move(d, u, {1, 1}, i);
  u.commit({{1, 1}});
  CHECK(u.undoCount() == 1);
  CHECK(d.get({1, 1})->props.transform.m02 == 50);

  std::vector<Guid> sel{{1, 1}};
  auto applied = u.undo(d, sel);
  CHECK(applied.size() == 1);  // folded into one inverse
  CHECK(d.get({1, 1})->props.transform.m02 == 0);
  CHECK(sel.empty());  // the selection before the gesture
  CHECK(u.canRedo());

  u.redo(d, sel);
  CHECK(d.get({1, 1})->props.transform.m02 == 50);
  CHECK(sel == std::vector<Guid>{{1, 1}});
}

TEST_CASE("undo: create, change, remove in one batch") {
  Document d;
  base(d);
  UndoStack u;
  u.begin({});
  NodeChange inv;
  d.apply(make({1, 1}, NodeType::ROUNDED_RECTANGLE, kPage, "O", {0, 0, 10, 10}), &inv);
  u.record(inv);
  move(d, u, {1, 1}, 30);
  d.apply(NodeChange::removed({1, 1}), &inv);
  u.record(inv);
  d.apply(make({1, 2}, NodeType::ELLIPSE, kPage, "P", {0, 0, 10, 10}), &inv);
  u.record(inv);
  u.commit({});
  std::vector<Guid> sel;
  u.undo(d, sel);
  CHECK_FALSE(d.has({1, 1}));
  CHECK_FALSE(d.has({1, 2}));
  u.redo(d, sel);
  CHECK_FALSE(d.has({1, 1}));
  CHECK(d.has({1, 2}));
}

TEST_CASE("undo: subtree delete comes back in order") {
  Document d;
  base(d);
  d.apply(make({1, 1}, NodeType::FRAME, kPage, "O", {0, 0, 100, 100}));
  d.apply(make({1, 2}, NodeType::ROUNDED_RECTANGLE, {1, 1}, "O", {0, 0, 10, 10}));
  d.apply(make({1, 3}, NodeType::ROUNDED_RECTANGLE, {1, 1}, "P", {0, 0, 10, 10}));
  UndoStack u;
  u.begin({{1, 1}});
  for (Guid id : {Guid{1, 2}, Guid{1, 3}, Guid{1, 1}}) {
    NodeChange inv;
    REQUIRE(d.apply(NodeChange::removed(id), &inv));
    u.record(inv);
  }
  u.commit({});
  CHECK(d.size() == 3);
  std::vector<Guid> sel;
  u.undo(d, sel);
  CHECK(d.size() == 6);
  CHECK(d.children({1, 1}).size() == 2);
  CHECK(sel == std::vector<Guid>{{1, 1}});
}

TEST_CASE("undo: a new step clears redo; rollback restores") {
  Document d;
  base(d);
  d.apply(make({1, 1}, NodeType::ROUNDED_RECTANGLE, kPage, "O", {0, 0, 10, 10}));
  UndoStack u;
  std::vector<Guid> sel;
  u.begin({});
  move(d, u, {1, 1}, 5);
  u.commit({});
  u.undo(d, sel);
  CHECK(u.canRedo());
  u.begin({});
  move(d, u, {1, 1}, 7);
  u.commit({});
  CHECK_FALSE(u.canRedo());

  u.begin({});
  move(d, u, {1, 1}, 99);
  auto back = u.rollback(d);
  CHECK(back.size() == 1);
  CHECK(d.get({1, 1})->props.transform.m02 == 7);
  CHECK_FALSE(u.inTransaction());
  CHECK(u.undoCount() == 1);

  // Empty transactions leave no step.
  u.begin({});
  u.commit({});
  CHECK(u.undoCount() == 1);
}

TEST_CASE("undo: merging into the last step; labels") {
  Document d;
  base(d);
  d.apply(make({1, 1}, NodeType::ROUNDED_RECTANGLE, kPage, "O", {0, 0, 10, 10}));
  UndoStack u;
  std::vector<Guid> sel;
  u.begin({}, "Nudge");
  move(d, u, {1, 1}, 1);
  u.commit({});
  u.begin({}, "Nudge");
  move(d, u, {1, 1}, 2);
  u.commit({}, true);
  CHECK(u.undoCount() == 1);
  CHECK(u.undoLabel() == "Nudge");
  u.undo(d, sel);
  CHECK(d.get({1, 1})->props.transform.m02 == 0);
  CHECK(u.redoLabel() == "Nudge");
}
