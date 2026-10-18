// The Atlas sweep of 2026-10-18, chapter 22 (docs/research/atlas/22-undo-file.md §2.1, §2.3): Figma's ignore-undo
// scope (openIgnoreUndoRedoScope) keeps writes out of the history, and undoing a step made in vector edit mode goes
// back into that mode on its layer ("update-edit-mode-for-undo").
#include "doctest.h"
#include "editor/Editor.h"
#include "geometry/VectorNetwork.h"
#include "Helpers.h"

using namespace eng;
using namespace eng::test;

namespace {

const Guid A{1, 1}, B{1, 2}, V{1, 3};

NodeChange vectorNode(Guid id, const std::string& pos, Rect r) {
  geom::VectorNetwork net;
  net.vertices = {{{0, 0}, 0}, {{50, 50}, 0}, {{100, 0}, 0}};
  net.segments = {geom::VNSegment{0, 1, {}, {}, 0}, geom::VNSegment{1, 2, {}, {}, 0}};
  NodeChange c = make(id, NodeType::VECTOR, kPage, pos, r, "Vector");
  VectorData d;
  d.present = true;
  d.normalizedSize = {r.w, r.h};
  d.network = std::make_shared<std::vector<uint8_t>>(net.encode());
  c.props.shape().vectorData = d;
  c.props.fillPaints.clear();
  c.props.strokePaints = {Paint::solid(Color::hex(0x000000))};
  c.props.strokeWeight = 1;
  return c;
}

Editor makeEditor() {
  auto nodes = baseChanges();
  nodes.push_back(make(A, NodeType::ROUNDED_RECTANGLE, kPage, "!", {0, 0, 100, 50}, "A"));
  nodes.push_back(make(B, NodeType::ROUNDED_RECTANGLE, kPage, "\"", {200, 0, 100, 50}, "B"));
  nodes.push_back(vectorNode(V, "#", {100, 600, 100, 50}));
  Editor e;
  e.setSessionID(1);
  e.setViewport(1200, 900, 1, 1200, 900);
  e.loadDocument(nodes, kNoGuid);
  e.setCamera({100, 100, 1});
  e.takeEvents();
  return e;
}

NodeChange opacity(float value) {
  NodeChange c;
  c.mask = F_OPACITY;
  c.props.opacity = value;
  return c;
}

}  // namespace

TEST_CASE("atlas 22: an ignore-undo scope's writes reach the document and leave no step, nor join one") {
  Editor e = makeEditor();
  e.openIgnoreUndo();
  REQUIRE(e.setProps({A}, opacity(0.5f), 0) == OK);
  e.closeIgnoreUndo();
  CHECK(e.document().get(A)->props.opacity == doctest::Approx(0.5));
  CHECK_FALSE(e.canUndo());

  // Inside a step: the step keeps the user's write only.
  REQUIRE(e.txnBegin("Change") == OK);
  REQUIRE(e.setProps({B}, opacity(0.25f), 0) == OK);
  e.openIgnoreUndo();
  e.openIgnoreUndo();  // they nest
  REQUIRE(e.setProps({A}, opacity(0.75f), 0) == OK);
  e.closeIgnoreUndo();
  CHECK(e.ignoringUndo());
  e.closeIgnoreUndo();
  e.closeIgnoreUndo();  // one too many: nothing
  CHECK_FALSE(e.ignoringUndo());
  REQUIRE(e.txnCommit() == OK);
  REQUIRE(e.canUndo());
  e.command(CommandId::UNDO);
  CHECK(e.document().get(B)->props.opacity == doctest::Approx(1));
  CHECK(e.document().get(A)->props.opacity == doctest::Approx(0.75));
}

TEST_CASE("atlas 22: undoing a step made in vector edit mode goes back into it on its layer") {
  Editor e = makeEditor();
  e.setSelection({V});
  REQUIRE(e.startVectorEdit(V) == OK);
  // A point dragged in edit mode: a step made in it.
  e.pointer(PointerEvent::DOWN, 250, 750, 0, 1, 0, 1);
  e.pointer(PointerEvent::MOVE, 260, 760, 0, 1, 0, 1);
  e.pointer(PointerEvent::MOVE, 270, 770, 0, 1, 0, 1);
  e.pointer(PointerEvent::UP, 270, 770, 0, 0, 0, 1);
  REQUIRE(e.canUndo());
  e.endVectorEdit();
  CHECK_FALSE(e.vectorEditing());
  // A step outside it, then the two undone.
  REQUIRE(e.setProps({A}, opacity(0.5f), 0) == OK);
  e.command(CommandId::UNDO);
  CHECK_FALSE(e.vectorEditing());  // made outside: the mode stays as it is
  e.command(CommandId::UNDO);
  CHECK(e.vectorEditing());
  CHECK(e.vectorLayers() == std::vector<Guid>{V});
  // Redone from outside it: back in again.
  e.endVectorEdit();
  e.command(CommandId::REDO);
  CHECK(e.vectorEditing());
}
