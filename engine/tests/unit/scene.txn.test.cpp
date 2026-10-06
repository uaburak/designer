// Transactions: one DOCUMENT_CHANGED Message per commit carrying only what
// changed (docs/engine.md §9.1, docs/schema.md §4.2), NODES_CHANGED for live
// changes, rollback emitting nothing to storage.
#include "doctest.h"
#include "editor/Editor.h"
#include "Helpers.h"

using namespace eng;
using namespace eng::test;

namespace {

const Guid F{1, 1}, R1{1, 2}, R2{1, 3};

Editor makeEditor() {
  auto nodes = baseChanges();
  nodes.push_back(make(F, NodeType::FRAME, kPage, "!", {0, 0, 300, 300}, "Frame 1"));
  nodes.push_back(make(R1, NodeType::ROUNDED_RECTANGLE, F, "!", {10, 10, 50, 50}, "Rectangle 1"));
  nodes.push_back(make(R2, NodeType::ROUNDED_RECTANGLE, F, "\"", {100, 10, 50, 50}, "Rectangle 2"));
  Editor e;
  e.setViewport(800, 600, 1, 800, 600);
  e.loadDocument(nodes, kNoGuid);
  e.takeEvents();
  return e;
}

void drag(Editor& e, Vec2 from, Vec2 to, uint32_t mods = 0, int steps = 10) {
  e.pointer(PointerEvent::DOWN, from.x, from.y, 0, 1, mods);
  for (int i = 1; i <= steps; i++) {
    double t = static_cast<double>(i) / steps;
    e.pointer(PointerEvent::MOVE, from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, 0, 1, mods);
  }
  e.pointer(PointerEvent::UP, to.x, to.y, 0, 0, mods);
}

}  // namespace

TEST_CASE("txn: a drag is one message with only the transform") {
  Editor e = makeEditor();
  drag(e, {20, 20}, {70, 20}, 0, 25);
  auto ev = e.takeEvents();
  REQUIRE(ev.documents.size() == 1);
  CHECK(ev.documents[0].kind == TxnKind::GESTURE);
  CHECK(ev.documents[0].label == "Move");
  REQUIRE(ev.documents[0].changes.size() == 1);
  const NodeChange& c = ev.documents[0].changes[0];
  CHECK(c.guid == R1);
  CHECK(c.phase == Phase::CHANGED);
  CHECK(c.mask == F_TRANSFORM);
  CHECK(c.props.transform.m02 == 60);
  // Live changes reached the panels while dragging.
  REQUIRE(!ev.nodes.empty());
  CHECK(ev.nodes[0].first == R1);
  CHECK((ev.nodes[0].second & G_GEOMETRY));
  CHECK(ev.undo);
}

TEST_CASE("txn: Esc rolls a drag back exactly and stores nothing") {
  Editor e = makeEditor();
  e.pointer(PointerEvent::DOWN, 20, 20, 0, 1, 0);
  e.pointer(PointerEvent::MOVE, 90, 140, 0, 1, 0);
  CHECK(e.document().get(R1)->props.transform.m02 != 10);
  e.key(KeyEvent::DOWN, KeyCode::Escape, 0, 0, false);
  CHECK(e.document().get(R1)->props.transform == Mat2x3::translate(10, 10));
  auto ev = e.takeEvents();
  CHECK(ev.documents.empty());
  CHECK_FALSE(e.canUndo());
  e.pointer(PointerEvent::UP, 90, 140, 0, 0, 0);
  CHECK(e.takeEvents().documents.empty());
}

TEST_CASE("txn: draw → one CREATED with the new node's state; undo → REMOVED, kind UNDO") {
  Editor e = makeEditor();
  e.setTool(Tool::RECTANGLE);
  drag(e, {400, 100}, {450, 160});
  auto ev = e.takeEvents();
  REQUIRE(ev.documents.size() == 1);
  REQUIRE(ev.documents[0].changes.size() == 1);
  const NodeChange& c = ev.documents[0].changes[0];
  CHECK(c.phase == Phase::CREATED);
  CHECK(c.props.type == NodeType::ROUNDED_RECTANGLE);
  CHECK(c.props.size == Vec2{50, 60});
  CHECK(c.props.parentIndex.guid == kPage);
  CHECK(c.props.parentIndex.position == "\"");  // after Frame 1's "!": LOW bias
  CHECK(c.guid.sessionID == e.sessionID());
  CHECK(ev.tool);
  e.command(CommandId::UNDO);
  ev = e.takeEvents();
  REQUIRE(ev.documents.size() == 1);
  CHECK(ev.documents[0].kind == TxnKind::UNDO);
  REQUIRE(ev.documents[0].changes.size() == 1);
  CHECK(ev.documents[0].changes[0].phase == Phase::REMOVED);
  e.command(CommandId::REDO);
  ev = e.takeEvents();
  CHECK(ev.documents[0].kind == TxnKind::REDO);
  CHECK(ev.documents[0].changes[0].phase == Phase::CREATED);
}

TEST_CASE("txn: deleting a subtree removes every node, children first; undo recreates parents first") {
  Editor e = makeEditor();
  e.setSelection({F});
  e.command(CommandId::DELETE);
  auto ev = e.takeEvents();
  REQUIRE(ev.documents.size() == 1);
  auto& removed = ev.documents[0].changes;
  REQUIRE(removed.size() == 3);
  for (auto& c : removed) CHECK(c.phase == Phase::REMOVED);
  CHECK(removed.back().guid == F);
  e.command(CommandId::UNDO);
  ev = e.takeEvents();
  auto& created = ev.documents[0].changes;
  REQUIRE(created.size() == 3);
  CHECK(created.front().guid == F);
  for (auto& c : created) CHECK(c.phase == Phase::CREATED);
  CHECK(e.selection() == std::vector<Guid>{F});
}

TEST_CASE("txn: a panel scrub is one step and one message") {
  Editor e = makeEditor();
  REQUIRE(e.txnBegin("Opacity") == OK);
  for (int i = 1; i <= 10; i++) {
    NodeChange c;
    c.mask = F_OPACITY;
    c.props.opacity = 1 - i * 0.05;
    REQUIRE(e.setProps({R1, R2}, c, 0) == OK);
  }
  CHECK(e.takeEvents().documents.empty());  // nothing leaves before the commit
  REQUIRE(e.txnCommit() == OK);
  auto ev = e.takeEvents();
  REQUIRE(ev.documents.size() == 1);
  CHECK(ev.documents[0].changes.size() == 2);
  CHECK(ev.documents[0].changes[0].props.opacity == doctest::Approx(0.5));
  CHECK(e.undoStack().undoCount() == 1);
  e.command(CommandId::UNDO);
  CHECK(e.document().get(R1)->props.opacity == 1);
  // Equal values are no-ops: no message.
  NodeChange same;
  same.mask = F_OPACITY;
  same.props.opacity = 1;
  e.takeEvents();
  e.setProps({R1}, same, 0);
  CHECK(e.takeEvents().documents.empty());
}

TEST_CASE("txn: a cancelled panel transaction restores and stores nothing") {
  Editor e = makeEditor();
  e.txnBegin("Name");
  NodeChange c;
  c.mask = F_NAME;
  c.props.name = "Hero";
  e.setProps({R1}, c, 0);
  CHECK(e.document().get(R1)->props.name == "Hero");
  e.txnCancel();
  CHECK(e.document().get(R1)->props.name == "Rectangle 1");
  CHECK(e.takeEvents().documents.empty());
}

TEST_CASE("txn: remote changes are neither undoable nor echoed") {
  Editor e = makeEditor();
  NodeChange c = NodeChange::changed(R1);
  c.mask = F_NAME;
  c.props.name = "From elsewhere";
  e.applyChanges({c}, APPLY_REMOTE);
  CHECK(e.document().get(R1)->props.name == "From elsewhere");
  auto ev = e.takeEvents();
  CHECK(ev.documents.empty());
  CHECK_FALSE(e.canUndo());
  CHECK(!ev.nodes.empty());
  e.applyChanges({c}, APPLY_USER);
  CHECK(e.takeEvents().documents.size() == 0);  // nothing changed (same value): the message is empty
}

TEST_CASE("txn: long keys rebalance the siblings inside the same transaction") {
  Editor e = makeEditor();
  // Many children whose keys crowd one end: each append under the frame would grow.
  std::vector<NodeChange> crowd;
  std::string key = "!";
  for (int i = 0; i < 3; i++) {
    NodeChange c = make({5, static_cast<uint32_t>(i + 1)}, NodeType::ROUNDED_RECTANGLE, F, key, {0, 0, 1, 1});
    crowd.push_back(c);
  }
  // Three siblings ending with a 24-character key of '~': the next append would be 25 characters.
  crowd[0].props.parentIndex.position = "!";
  crowd[1].props.parentIndex.position = "#";
  crowd[2].props.parentIndex.position = std::string(24, '~');
  e.applyChanges(crowd, APPLY_LOAD);
  e.takeEvents();
  e.setTool(Tool::RECTANGLE);
  e.pointer(PointerEvent::DOWN, 200, 200, 0, 1, 0);
  e.pointer(PointerEvent::UP, 200, 200, 0, 0, 0);
  auto ev = e.takeEvents();
  REQUIRE(ev.documents.size() == 1);
  size_t parentWrites = 0;
  for (auto& c : ev.documents[0].changes)
    if (c.phase == Phase::CHANGED && (c.mask & F_PARENT_INDEX)) parentWrites++;
  CHECK(parentWrites >= 3);
  for (Guid c : e.document().children(F)) CHECK(e.document().get(c)->props.parentIndex.position.size() <= 24);
  e.command(CommandId::UNDO);
  CHECK(e.document().get({5, 3})->props.parentIndex.position == std::string(24, '~'));
}
