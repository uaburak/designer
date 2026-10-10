// Round 17 — actors (docs/engine.md §9.5; the owner: "what I do must not affect the agent and what the agent does
// must not affect me"). An actor (an agent's chat turn today, a multiplayer session later) writes with its own
// selection and page — the user's selection, page, view and edit modes untouched, their events held back — into its
// own undo history; ⌘Z takes back only the user's steps, an actor's undo only its own, and either skips the fields
// someone else wrote since (per property, last writer wins).
#include "doctest.h"
#include "editor/Editor.h"
#include "Helpers.h"

using namespace eng;
using namespace eng::test;

namespace {

const Guid F{1, 1}, A{1, 2}, B{1, 3}, T{1, 4}, P2{0, 5}, C{1, 6};

Editor makeEditor() {
  auto nodes = baseChanges();
  nodes.push_back(make(F, NodeType::FRAME, kPage, "!", {0, 0, 300, 300}, "Frame"));
  nodes.push_back(make(A, NodeType::ROUNDED_RECTANGLE, F, "!", {10, 10, 50, 50}, "A"));
  nodes.push_back(make(B, NodeType::ROUNDED_RECTANGLE, F, "\"", {100, 10, 50, 50}, "B"));
  NodeChange t = make(T, NodeType::TEXT, kPage, "\"", {400, 0, 200, 40}, "Hello world");
  t.props.text().textData.characters = "Hello world";
  t.props.text().textAutoResize = TextAutoResize::NONE;
  nodes.push_back(t);
  NodeChange p2 = make(P2, NodeType::CANVAS, kDoc, "\"", {0, 0, 0, 0}, "Page 2");
  nodes.push_back(p2);
  nodes.push_back(make(C, NodeType::ROUNDED_RECTANGLE, P2, "!", {0, 0, 40, 40}, "C"));
  Editor e;
  e.setSessionID(1);
  e.setViewport(800, 600, 1, 800, 600);
  e.loadDocument(nodes, kNoGuid);
  e.takeEvents();
  return e;
}

const NodeProps& props(const Editor& e, Guid id) { return e.document().get(id)->props; }

void rename(Editor& e, Guid id, const std::string& name) {
  NodeChange c = NodeChange::changed(id);
  c.mask = F_NAME;
  c.props.name = name;
  REQUIRE(e.setProps({id}, c, 0) == OK);
}

void setOpacity(Editor& e, Guid id, float v) {
  NodeChange c = NodeChange::changed(id);
  c.mask = F_OPACITY;
  c.props.opacity = v;
  REQUIRE(e.setProps({id}, c, 0) == OK);
}

// One write of `actor` (a turn's tool call): `fn` runs with the actor's selection.
template <class Fn>
void as(Editor& e, uint32_t actor, std::vector<Guid> sel, Fn fn, bool merge = true) {
  REQUIRE(e.actorBegin(actor, sel, kNoGuid, "Agent edit", merge, actor) == OK);
  fn();
  REQUIRE(e.actorEnd(false) == OK);
}

}  // namespace

TEST_CASE("actors: a write runs on its own selection and page; the user's selection, page and view stay, no events") {
  Editor e = makeEditor();
  e.setSelection({B});
  e.setCamera({10, 20, 1.5});
  e.takeEvents();
  // The agent deletes A (the DELETE command, on its selection) and duplicates C on the other page.
  as(e, 7, {A}, [&] {
    CHECK(e.selection() == std::vector<Guid>{A});
    REQUIRE(e.command(CommandId::DELETE) == OK);
    CHECK(e.selection().empty());
    REQUIRE(e.command(CommandId::ZOOM_TO_FIT) == OK);
  });
  CHECK(!e.document().has(A));
  CHECK(e.selection() == std::vector<Guid>{B});
  CHECK(e.page() == kPage);
  CHECK(e.camera().x == 10);
  CHECK(e.camera().zoom == 1.5);
  auto ev = e.takeEvents();
  CHECK(!ev.selection);
  CHECK(!ev.currentPage);
  CHECK(!ev.camera);
  REQUIRE(ev.documents.size() == 1);
  CHECK(ev.documents[0].actor == 7);
  as(e, 7, {C}, [&] {
    CHECK(e.page() == P2);  // its first layer's page
    REQUIRE(e.command(CommandId::DUPLICATE) == OK);
  });
  CHECK(e.page() == kPage);
  CHECK(e.selection() == std::vector<Guid>{B});
  CHECK(e.document().children(P2).size() == 2);
  ev = e.takeEvents();
  CHECK(!ev.selection);
  CHECK(!ev.currentPage);
  // The user's history has none of it.
  CHECK(!e.canUndo());
}

TEST_CASE("actors: a turn's writes are one step in its own history; ⌘Z takes back only the user's steps") {
  Editor e = makeEditor();
  e.setSelection({B});
  rename(e, B, "User B");  // the user's step
  as(e, 3, {}, [&] { rename(e, A, "Agent A"); });
  as(e, 3, {}, [&] { setOpacity(e, A, 0.5f); });  // merged into the turn's step
  rename(e, F, "User F");  // the user again, between
  CHECK(e.actorInfo(3).canUndo);
  // ⌘Z: the user's steps only, newest first.
  REQUIRE(e.command(CommandId::UNDO) == OK);
  CHECK(props(e, F).name == "Frame");
  CHECK(props(e, A).name == "Agent A");
  REQUIRE(e.command(CommandId::UNDO) == OK);
  CHECK(props(e, B).name == "B");
  CHECK(!e.canUndo());
  CHECK(props(e, A).name == "Agent A");
  CHECK(props(e, A).opacity == doctest::Approx(0.5));
  // The turn's Undo: both its writes at once, the user's redo untouched.
  e.setSelection({B});
  e.takeEvents();
  REQUIRE(e.actorUndo(3, false));
  CHECK(props(e, A).name == "A");
  CHECK(props(e, A).opacity == doctest::Approx(1));
  CHECK(e.selection() == std::vector<Guid>{B});
  CHECK(!e.takeEvents().selection);
  CHECK(e.canRedo());
  CHECK(e.actorInfo(3).canRedo);
  // Apply again.
  REQUIRE(e.actorUndo(3, true));
  CHECK(props(e, A).name == "Agent A");
  // ⇧⌘Z: the user's.
  REQUIRE(e.command(CommandId::REDO) == OK);
  CHECK(props(e, B).name == "User B");
  CHECK(props(e, A).name == "Agent A");
}

TEST_CASE("actors: undo skips the fields someone else wrote since (per property, last writer wins)") {
  Editor e = makeEditor();
  // The agent renames A and sets its opacity; the user then renames A.
  as(e, 4, {}, [&] {
    rename(e, A, "Agent A");
    setOpacity(e, A, 0.3f);
  });
  rename(e, A, "Mine");
  auto info = e.actorInfo(4);
  REQUIRE(info.overwritten.size() == 1);
  CHECK(info.overwritten[0] == A);
  REQUIRE(e.actorUndo(4, false));
  CHECK(props(e, A).name == "Mine");                     // the user's, kept
  CHECK(props(e, A).opacity == doctest::Approx(1));      // the agent's, taken back
  // And the other way: the user's ⌘Z leaves what an agent wrote after it.
  setOpacity(e, B, 0.5f);
  as(e, 5, {}, [&] { setOpacity(e, B, 0.2f); });
  rename(e, F, "F2");
  REQUIRE(e.command(CommandId::UNDO) == OK);  // F2
  CHECK(props(e, F).name == "Frame");
  REQUIRE(e.command(CommandId::UNDO) == OK);  // the opacity step: nothing of it left — skipped, the one before undone
  CHECK(props(e, B).opacity == doctest::Approx(0.2));
  CHECK(props(e, A).name == "Agent A");  // "Mine" taken back (the agent's undo had not touched the name)
}

TEST_CASE("actors: two turns at once on the same layer — last write wins; each undoes only its own") {
  Editor e = makeEditor();
  as(e, 10, {}, [&] { rename(e, A, "Turn 1"); });
  as(e, 11, {}, [&] { rename(e, A, "Turn 2"); });
  as(e, 10, {}, [&] { setOpacity(e, A, 0.4f); });
  CHECK(props(e, A).name == "Turn 2");
  CHECK(e.actorInfo(10).overwritten == std::vector<Guid>{A});
  CHECK(e.actorInfo(11).overwritten.empty());
  REQUIRE(e.actorUndo(10, false));
  CHECK(props(e, A).name == "Turn 2");
  CHECK(props(e, A).opacity == doctest::Approx(1));
  REQUIRE(e.actorUndo(11, false));
  CHECK(props(e, A).name == "Turn 1");  // the value turn 2 found
  // Forgotten actors have nothing to undo.
  e.forgetActor(11);
  CHECK(!e.actorUndo(11, true));
}

TEST_CASE("actors: never inside the user's gesture or step; a cancelled write leaves nothing") {
  Editor e = makeEditor();
  e.setSelection({B});
  // A drag on B (past its threshold).
  e.pointer(PointerEvent::DOWN, 125, 35, 0, 1, 0);
  for (int i = 1; i <= 4; i++) e.pointer(PointerEvent::MOVE, 125 + i * 10, 35, 0, 1, 0);
  CHECK(!e.idle());
  CHECK(e.actorBegin(2, {A}, kNoGuid, "Agent edit", true, 2) == E_BUSY);
  e.pointer(PointerEvent::UP, 165, 35, 0, 0, 0);
  CHECK(e.idle());
  CHECK(props(e, B).transform.m02 == doctest::Approx(140));
  // A panel scrub is open: wait too.
  REQUIRE(e.txnBegin("Opacity") == OK);
  CHECK(e.actorBegin(2, {A}, kNoGuid, "Agent edit", true, 2) == E_BUSY);
  REQUIRE(e.txnCommit() == OK);
  // Cancelled: rolled back, nothing recorded, the user's state back.
  REQUIRE(e.actorBegin(2, {A}, kNoGuid, "Agent edit", true, 2) == OK);
  rename(e, A, "Gone");
  REQUIRE(e.actorEnd(true) == OK);
  CHECK(props(e, A).name == "A");
  CHECK(!e.actorInfo(2).canUndo);
  CHECK(e.selection() == std::vector<Guid>{B});
  // The user's ⌘Z: the drag.
  REQUIRE(e.command(CommandId::UNDO) == OK);
  CHECK(props(e, B).transform.m02 == doctest::Approx(100));
}

TEST_CASE("actors: an outside client's write (undoTo 0) is the user's step, the selection still its own") {
  Editor e = makeEditor();
  e.setSelection({B});
  REQUIRE(e.actorBegin(99, {A}, kNoGuid, "Cursor edit", false, 0) == OK);
  rename(e, A, "From Cursor");
  REQUIRE(e.actorEnd(false) == OK);
  CHECK(e.selection() == std::vector<Guid>{B});
  CHECK(e.canUndo());
  REQUIRE(e.command(CommandId::UNDO) == OK);
  CHECK(props(e, A).name == "A");
}

TEST_CASE("actors: the user typing in a text the agent rewrites keeps a caret inside it") {
  Editor e = makeEditor();
  REQUIRE(e.startTextEdit(T, false) == OK);
  REQUIRE(e.textInput("!") == OK);
  e.takeEvents();
  as(e, 6, {}, [&] {
    CHECK(!e.textEditing());  // the user's edit is set aside while the agent writes
    NodeChange c = NodeChange::changed(T);
    c.mask = F_TEXT_DATA;
    c.props.text().textData.characters = "Hi";
    REQUIRE(e.setProps({T}, c, 0) == OK);
  });
  REQUIRE(e.textEditing());
  CHECK(e.textSelEnd() <= 2);
  REQUIRE(e.textInput("?") == OK);
  CHECK(props(e, T).text().textData.characters.size() == 3);
  e.endTextEdit();
  // The agent's undo leaves the user's typing (textData is theirs now).
  e.actorUndo(6, false);
  CHECK(props(e, T).text().textData.characters.size() == 3);
}
