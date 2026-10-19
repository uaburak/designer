// Phase 6 — another session's changes as an actor (docs/engine.md §9.5, docs/multiplayer.md §18): APPLY_REMOTE |
// APPLY_PEER waits while the user's step, gesture or an agent's write is open (E_BUSY: the editor tries again once idle,
// so a collaborator's change never joins the user's undo step nor goes out as theirs), and its commit makes every
// history yield the fields it wrote — the user's ⌘Z never puts back a value someone else changed since (Figma: undo
// touches only one's own changes; per property, last writer wins).
#include "doctest.h"
#include "editor/Editor.h"
#include "Helpers.h"

using namespace eng;
using namespace eng::test;

namespace {

const Guid F{1, 1}, A{1, 2}, B{1, 3}, T{1, 4};

Editor makeEditor() {
  auto nodes = baseChanges();
  nodes.push_back(make(F, NodeType::FRAME, kPage, "!", {0, 0, 300, 300}, "Frame"));
  nodes.push_back(make(A, NodeType::ROUNDED_RECTANGLE, F, "!", {10, 10, 50, 50}, "A"));
  nodes.push_back(make(B, NodeType::ROUNDED_RECTANGLE, F, "\"", {100, 10, 50, 50}, "B"));
  NodeChange t = make(T, NodeType::TEXT, kPage, "\"", {400, 0, 200, 40}, "Hello world");
  t.props.text().textData.characters = "Hello world";
  t.props.text().textAutoResize = TextAutoResize::NONE;
  nodes.push_back(t);
  Editor e;
  e.setSessionID(1);
  e.setViewport(800, 600, 1, 800, 600);
  e.loadDocument(nodes, kNoGuid);
  e.takeEvents();
  return e;
}

const NodeProps& props(const Editor& e, Guid id) { return e.document().get(id)->props; }

void setOpacity(Editor& e, Guid id, float v) {
  NodeChange c = NodeChange::changed(id);
  c.mask = F_OPACITY;
  c.props.opacity = v;
  REQUIRE(e.setProps({id}, c, 0) == OK);
}

NodeChange opacity(Guid id, float v) {
  NodeChange c = NodeChange::changed(id);
  c.mask = F_OPACITY;
  c.props.opacity = v;
  return c;
}

NodeChange name(Guid id, const std::string& v) {
  NodeChange c = NodeChange::changed(id);
  c.mask = F_NAME;
  c.props.name = v;
  return c;
}

constexpr uint32_t PEER = APPLY_REMOTE | APPLY_PEER;

}  // namespace

TEST_CASE("peer: the user's undo skips a property another session changed since; the rest of the step is undone") {
  Editor e = makeEditor();
  // The user sets A's opacity and B's in one step; a collaborator then sets A's.
  REQUIRE(e.txnBegin("Opacity") == OK);
  setOpacity(e, A, 0.5f);
  setOpacity(e, B, 0.5f);
  REQUIRE(e.txnCommit() == OK);
  e.takeEvents();
  REQUIRE(e.applyChanges({opacity(A, 0.2f)}, PEER) == OK);
  auto ev = e.takeEvents();
  CHECK(ev.documents.empty());  // not emitted: the store journaled it already
  REQUIRE(e.command(CommandId::UNDO) == OK);
  CHECK(props(e, A).opacity == doctest::Approx(0.2));  // the collaborator's, kept
  CHECK(props(e, B).opacity == doctest::Approx(1));    // the user's own, taken back
  // Redo puts back only what the undo took.
  REQUIRE(e.command(CommandId::REDO) == OK);
  CHECK(props(e, A).opacity == doctest::Approx(0.2));
  CHECK(props(e, B).opacity == doctest::Approx(0.5));
}

TEST_CASE("peer: a step whose every property someone else overwrote is skipped; the one before it is undone") {
  Editor e = makeEditor();
  setOpacity(e, B, 0.7f);
  setOpacity(e, A, 0.5f);
  REQUIRE(e.applyChanges({opacity(A, 0.3f)}, PEER) == OK);
  REQUIRE(e.command(CommandId::UNDO) == OK);
  CHECK(props(e, A).opacity == doctest::Approx(0.3));
  CHECK(props(e, B).opacity == doctest::Approx(1));
}

TEST_CASE("peer: APPLY_REMOTE alone (the prototype player's writes) still leaves the histories as they are") {
  Editor e = makeEditor();
  setOpacity(e, A, 0.5f);
  REQUIRE(e.applyChanges({opacity(A, 0.2f)}, APPLY_REMOTE) == OK);
  REQUIRE(e.command(CommandId::UNDO) == OK);
  CHECK(props(e, A).opacity == doctest::Approx(1));
}

TEST_CASE("peer: refused while a step is open, so it never joins the user's undo step or goes out as theirs") {
  Editor e = makeEditor();
  REQUIRE(e.txnBegin("Scrub") == OK);
  setOpacity(e, A, 0.5f);
  CHECK(e.applyChanges({name(B, "From Bob")}, PEER) == E_BUSY);
  CHECK(props(e, B).name == "B");
  REQUIRE(e.txnCommit() == OK);
  auto ev = e.takeEvents();
  REQUIRE(ev.documents.size() == 1);
  for (const NodeChange& c : ev.documents[0].changes) CHECK(c.guid != B);
  // Idle again: it applies, and the user's undo takes back only the scrub.
  REQUIRE(e.applyChanges({name(B, "From Bob")}, PEER) == OK);
  REQUIRE(e.command(CommandId::UNDO) == OK);
  CHECK(props(e, A).opacity == doctest::Approx(1));
  CHECK(props(e, B).name == "From Bob");
  // A plain remote change inside a step is taken as before (APPLY_REMOTE alone: the player's).
  REQUIRE(e.txnBegin("Scrub") == OK);
  CHECK(e.applyChanges({name(B, "Player")}, APPLY_REMOTE) == OK);
  REQUIRE(e.txnCommit() == OK);
}

TEST_CASE("peer: refused during an agent's write; yields the agent's history too") {
  Editor e = makeEditor();
  REQUIRE(e.actorBegin(7, {}, kNoGuid, "Agent edit", true, 7) == OK);
  setOpacity(e, A, 0.4f);
  CHECK(e.applyChanges({opacity(A, 0.9f)}, PEER) == E_BUSY);
  REQUIRE(e.actorEnd(false) == OK);
  REQUIRE(e.applyChanges({opacity(A, 0.9f)}, PEER) == OK);
  auto info = e.actorInfo(7);
  REQUIRE(info.overwritten.size() == 1);
  CHECK(info.overwritten[0] == A);
  REQUIRE_FALSE(e.actorUndo(7, false));  // nothing of the agent's step left to undo
  CHECK(props(e, A).opacity == doctest::Approx(0.9));
}

TEST_CASE("peer: the user typing in a text another session rewrites keeps a caret inside it") {
  Editor e = makeEditor();
  REQUIRE(e.startTextEdit(T, false) == OK);
  REQUIRE(e.textInput("!") == OK);
  e.takeEvents();
  NodeChange c = NodeChange::changed(T);
  c.mask = F_TEXT_DATA;
  c.props.text().textData.characters = "Hi";
  REQUIRE(e.applyChanges({c}, PEER) == OK);
  REQUIRE(e.textEditing());
  CHECK(e.textSelEnd() <= 2);
  REQUIRE(e.textInput("?") == OK);
  CHECK(props(e, T).text().textData.characters.size() == 3);
  e.endTextEdit();
}
