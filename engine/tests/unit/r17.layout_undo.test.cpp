// Round 17 (REA canvas, docs/research/rea/canvas.md §2.3–2.4): layout runs again after undo, redo and remote
// changes (Figma's invariant enforcers, `-remote` ones included — restored or received sizes aren't trusted), an
// undo's layout writes join the batch it put on the redo stack, and one ⌘Z always does something visible: a batch
// with no visible effect (a hidden layer's values, or nothing left after the dangling-reference filter) is applied
// and the next one follows in the same press. With nothing selected, undo goes to the page the changes were on.
#include "doctest.h"
#include "editor/Editor.h"
#include "Helpers.h"

using namespace eng;
using namespace eng::test;

namespace {

const Guid H{1, 1}, A{1, 2}, B{1, 3}, F{1, 4}, X{1, 5}, P2{0, 5}, C{1, 6}, Z{1, 7}, S{1, 8}, K{1, 9};

// H: a horizontal auto-layout frame hugging A (50 × 20) and B (50 × 20), gap 10; F: a plain frame holding X; C on
// page 2. `extras`: Z, an absolute 10 × 10 in H pinned to its right edge (constraint MAX); S, a main component
// holding K, a hidden layer.
Editor makeEditor(bool hideX = false, bool extras = false) {
  auto nodes = baseChanges();
  NodeChange h = make(H, NodeType::FRAME, kPage, "!", {0, 0, 110, 20}, "Row");
  h.props.stack().stackMode = StackMode::HORIZONTAL;
  h.props.stack().stackSpacing = 10;
  h.props.stack().stackPrimarySizing = StackSize::RESIZE_TO_FIT_WITH_IMPLICIT_SIZE;
  h.props.stack().stackCounterSizing = StackSize::RESIZE_TO_FIT_WITH_IMPLICIT_SIZE;
  nodes.push_back(h);
  nodes.push_back(make(A, NodeType::ROUNDED_RECTANGLE, H, "!", {0, 0, 50, 20}, "A"));
  nodes.push_back(make(B, NodeType::ROUNDED_RECTANGLE, H, "\"", {60, 0, 50, 20}, "B"));
  nodes.push_back(make(F, NodeType::FRAME, kPage, "\"", {300, 0, 200, 200}, "Frame"));
  NodeChange x = make(X, NodeType::ROUNDED_RECTANGLE, F, "!", {10, 10, 40, 40}, "X");
  x.props.visible = !hideX;
  nodes.push_back(x);
  nodes.push_back(make(P2, NodeType::CANVAS, kDoc, "\"", {0, 0, 0, 0}, "Page 2"));
  nodes.push_back(make(C, NodeType::ROUNDED_RECTANGLE, P2, "!", {0, 0, 40, 40}, "C"));
  if (extras) {
    NodeChange z = make(Z, NodeType::ROUNDED_RECTANGLE, H, "#", {100, 0, 10, 10}, "Z");
    z.props.stackPositioning = StackPositioning::ABSOLUTE;
    z.props.horizontalConstraint = ConstraintType::MAX;
    nodes.push_back(z);
    nodes.push_back(make(S, NodeType::SYMBOL, kPage, "#", {0, 300, 100, 100}, "Main"));
    NodeChange k = make(K, NodeType::ROUNDED_RECTANGLE, S, "!", {0, 0, 20, 20}, "Icon");
    k.props.visible = false;
    nodes.push_back(k);
  }
  Editor e;
  e.setSessionID(1);
  e.setViewport(800, 600, 1, 800, 600);
  e.loadDocument(nodes, kNoGuid);
  e.takeEvents();
  return e;
}

const NodeProps& props(const Editor& e, Guid id) { return e.document().get(id)->props; }
double width(const Editor& e, Guid id) { return props(e, id).size.x; }
double x(const Editor& e, Guid id) { return props(e, id).transform.m02; }

void setSpacing(Editor& e, double v) {
  NodeChange c = NodeChange::changed(H);
  c.mask = F_STACK_SPACING;
  c.props.stack().stackSpacing = v;
  REQUIRE(e.setProps({H}, c, 0) == OK);
}

void setWidth(Editor& e, Guid id, double w) {
  NodeChange c = NodeChange::changed(id);
  c.mask = F_SIZE;
  c.props.size = {w, props(e, id).size.y};
  REQUIRE(e.setProps({id}, c, 0) == OK);
}

void rename(Editor& e, Guid id, const std::string& name) {
  NodeChange c = NodeChange::changed(id);
  c.mask = F_NAME;
  c.props.name = name;
  REQUIRE(e.setProps({id}, c, 0) == OK);
}

void setOpacity(Editor& e, Guid id, double v) {
  NodeChange c = NodeChange::changed(id);
  c.mask = F_OPACITY;
  c.props.opacity = v;
  REQUIRE(e.setProps({id}, c, 0) == OK);
}

template <class Fn>
void asAgent(Editor& e, Fn fn, std::vector<Guid> sel = {}) {
  REQUIRE(e.actorBegin(9, sel, kNoGuid, "Agent edit", true, 9) == OK);
  fn();
  REQUIRE(e.actorEnd(false) == OK);
}

}  // namespace

TEST_CASE("layout after undo: a hugging frame re-measures around a child an agent changed since; redo is symmetric") {
  Editor e = makeEditor();
  setSpacing(e, 20);  // the user's step
  CHECK(width(e, H) == 120);
  CHECK(x(e, B) == 70);
  asAgent(e, [&] { setWidth(e, A, 100); });  // the agent widens A: the row hugs it (its size and B's place yield)
  CHECK(width(e, H) == 170);
  CHECK(x(e, B) == 120);
  e.takeEvents();
  REQUIRE(e.command(CommandId::UNDO) == OK);
  CHECK(props(e, H).stack().stackSpacing == 10);
  // Before: the row kept 170 and B its place (the stored sizes were trusted). Now layout runs again.
  CHECK(width(e, H) == 160);
  CHECK(x(e, B) == 110);
  CHECK(width(e, A) == 100);  // the agent's value stays
  auto ev = e.takeEvents();
  REQUIRE(ev.documents.size() == 1);
  CHECK(ev.documents[0].kind == TxnKind::UNDO);
  bool sizeSent = false;  // the undo's message carries layout's writes (as Figma's do)
  for (const NodeChange& c : ev.documents[0].changes)
    if (c.guid == H && (c.mask & F_SIZE)) sizeSent = true;
  CHECK(sizeSent);
  REQUIRE(e.command(CommandId::REDO) == OK);
  CHECK(props(e, H).stack().stackSpacing == 20);
  CHECK(width(e, H) == 170);
  CHECK(x(e, B) == 120);
  REQUIRE(e.command(CommandId::UNDO) == OK);
  CHECK(width(e, H) == 160);
  CHECK(x(e, B) == 110);
}

TEST_CASE("layout after undo: when nothing else changed, undo and redo give back exactly what was there") {
  Editor e = makeEditor();
  auto snapshot = [&] {
    std::vector<NodeProps> out;
    for (Guid id : {H, A, B}) out.push_back(props(e, id));
    return out;
  };
  auto same = [](const std::vector<NodeProps>& a, const std::vector<NodeProps>& b) {
    for (size_t i = 0; i < a.size(); i++)
      if (differingFields(a[i], b[i])) return false;
    return true;
  };
  auto before = snapshot();
  setWidth(e, A, 80);
  CHECK(width(e, H) == 140);
  auto after = snapshot();
  REQUIRE(e.command(CommandId::UNDO) == OK);
  CHECK(same(snapshot(), before));
  REQUIRE(e.command(CommandId::REDO) == OK);
  CHECK(same(snapshot(), after));
  REQUIRE(e.command(CommandId::UNDO) == OK);
  CHECK(same(snapshot(), before));
}

TEST_CASE("layout after remote changes: a child's new size reflows its parent; nothing is emitted or undoable") {
  Editor e = makeEditor();
  NodeChange c = NodeChange::changed(A);
  c.mask = F_SIZE;
  c.props.size = {90, 20};
  REQUIRE(e.applyChanges({c}, APPLY_REMOTE) == OK);
  CHECK(width(e, H) == 150);
  CHECK(x(e, B) == 100);
  auto ev = e.takeEvents();
  CHECK(ev.documents.empty());
  CHECK(!e.canUndo());
  // On a page not shown yet, nothing is laid out until it is (derivePage).
  CHECK(!e.pageDerived(P2));
}

TEST_CASE("undo: a batch whose node is gone is skipped (dangling-reference filter); the one before it is undone") {
  Editor e = makeEditor();
  rename(e, A, "Renamed");  // step 1
  setOpacity(e, X, 0.5);    // step 2
  asAgent(e, [&] { REQUIRE(e.command(CommandId::DELETE) == OK); }, {X});
  REQUIRE(!e.document().has(X));
  e.takeEvents();
  REQUIRE(e.command(CommandId::UNDO) == OK);  // step 2 has nothing left: step 1 in the same press
  CHECK(props(e, A).name == "A");
  CHECK(!e.document().has(X));
  CHECK(!e.canUndo());
  CHECK(e.takeEvents().documents.size() == 1);
}

TEST_CASE("undo: a move back into a parent that is gone keeps the layer where it is (never parked outside the tree)") {
  Editor e = makeEditor();
  NodeChange out = NodeChange::changed(X);
  out.mask = F_PARENT_INDEX | F_TRANSFORM;
  out.props.parentIndex = {kPage, "~"};
  out.props.transform = Mat2x3::translate(600, 0);
  REQUIRE(e.setProps({X}, out, 0) == OK);  // the user moves X out of F
  REQUIRE(e.document().parentOf(X) == kPage);
  asAgent(e, [&] { REQUIRE(e.command(CommandId::DELETE) == OK); }, {F});
  REQUIRE(!e.document().has(F));
  REQUIRE(e.command(CommandId::UNDO) == OK);
  CHECK(e.document().has(X));
  CHECK(e.document().parentOf(X) == kPage);
  CHECK(x(e, X) == 600);
  CHECK(e.document().pageOf(X) == kPage);
}

TEST_CASE("undo: a batch that only changed a hidden layer is applied, and the next one follows in the same press") {
  Editor e = makeEditor(true);  // X hidden
  rename(e, A, "Renamed");  // step 1: visible
  setOpacity(e, X, 0.5);    // step 2: a hidden layer's value
  e.takeEvents();
  REQUIRE(e.command(CommandId::UNDO) == OK);
  CHECK(props(e, X).opacity == doctest::Approx(1));
  CHECK(props(e, A).name == "A");
  CHECK(!e.canUndo());
  CHECK(e.takeEvents().documents.size() == 1);  // one press, one change message
  // Redo: step 1 (visible) first; step 2 then comes back on its own press.
  REQUIRE(e.command(CommandId::REDO) == OK);
  CHECK(props(e, A).name == "Renamed");
  CHECK(props(e, X).opacity == doctest::Approx(1));
  REQUIRE(e.command(CommandId::REDO) == OK);
  CHECK(props(e, X).opacity == doctest::Approx(0.5));
  CHECK(!e.canRedo());
  // Showing a hidden layer is visible: a step that does so is its own press.
  NodeChange show = NodeChange::changed(X);
  show.mask = F_VISIBLE;
  show.props.visible = true;
  REQUIRE(e.setProps({X}, show, 0) == OK);
  REQUIRE(e.command(CommandId::UNDO) == OK);
  CHECK(!props(e, X).visible);
  CHECK(props(e, X).opacity == doctest::Approx(0.5));
}

TEST_CASE("undo: with nothing selected, the page goes to the one the changes were on") {
  Editor e = makeEditor();
  REQUIRE(e.page() == kPage);
  setOpacity(e, C, 0.4);  // C is on page 2; nothing selected
  REQUIRE(e.selection().empty());
  REQUIRE(e.page() == kPage);
  REQUIRE(e.command(CommandId::UNDO) == OK);
  CHECK(props(e, C).opacity == doctest::Approx(1));
  CHECK(e.page() == P2);
  // A change on the page shown keeps it.
  REQUIRE(e.setCurrentPage(kPage) == OK);
  setOpacity(e, A, 0.4);
  REQUIRE(e.command(CommandId::UNDO) == OK);
  CHECK(e.page() == kPage);
}

TEST_CASE("layout after undo: an absolute child's constraints follow the size layout gives its frame (once per step)") {
  Editor e = makeEditor(false, true);
  setSpacing(e, 20);  // the user's step: the row grows by 10 and Z, pinned right, follows
  REQUIRE(width(e, H) == 120);
  CHECK(x(e, Z) == 110);
  asAgent(e, [&] { setWidth(e, A, 100); });
  REQUIRE(width(e, H) == 170);
  CHECK(x(e, Z) == 160);
  REQUIRE(e.command(CommandId::UNDO) == OK);
  CHECK(width(e, H) == 160);
  CHECK(x(e, Z) == 150);  // the row's right edge, not left 10 past it
  REQUIRE(e.command(CommandId::REDO) == OK);
  CHECK(width(e, H) == 170);
  CHECK(x(e, Z) == 160);
}

TEST_CASE("undo: a hidden layer inside a main component counts as visible (its instances may show it)") {
  Editor e = makeEditor(false, true);
  rename(e, A, "Renamed");  // step 1
  setOpacity(e, K, 0.5);    // step 2: hidden in the main, but an instance may show it
  REQUIRE(e.command(CommandId::UNDO) == OK);
  CHECK(props(e, K).opacity == doctest::Approx(1));
  CHECK(props(e, A).name == "Renamed");  // step 1 waits for its own press
  CHECK(e.canUndo());
}

TEST_CASE("undo: with nothing selected, the page is the one the visible batch was on, not a skipped batch's") {
  Editor e = makeEditor();
  NodeChange hide = NodeChange::changed(C);
  hide.mask = F_VISIBLE;
  hide.props.visible = false;
  REQUIRE(e.setProps({C}, hide, 0) == OK);  // C (page 2) hidden
  setOpacity(e, A, 0.4);                     // page 1, visible
  setOpacity(e, C, 0.5);                     // page 2, hidden: skipped
  REQUIRE(e.setCurrentPage(P2) == OK);
  REQUIRE(e.selection().empty());
  REQUIRE(e.command(CommandId::UNDO) == OK);
  CHECK(props(e, C).opacity == doctest::Approx(1));
  CHECK(props(e, A).opacity == doctest::Approx(1));
  CHECK(e.page() == kPage);  // where the change shows
}
