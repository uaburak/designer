// Round 17, prototype connections as Figma has them (the owner's report and live 61–65.png; help "Create interactive
// components", "Prototype connections"): a noodle from a variant (or a layer in one) lands on another variant of the
// same set — Change to — never on the set; from a layer onto another in its own frame — Scroll to; a click on a
// connection's line or label selects it (its hotspot, PROTOTYPE_CONNECTION_SELECTED) and only the selected connection
// is in the selection colour; a drag on the line or its end moves the end (onto empty canvas: removed); the selected
// connection's start dragged to another layer moves the interaction there; each step one undo.
#include <cmath>

#include "doctest.h"
#include "editor/Editor.h"
#include "Helpers.h"
#include "proto/Prototype.h"

using namespace eng;
using namespace eng::test;

namespace {

// A component set with two variants (a button in the first), a frame F with two layers, frames G and K.
const Guid SET{2, 1}, V1{2, 2}, V2{2, 3}, BTN{2, 4}, F{2, 10}, H{2, 11}, L{2, 12}, G{2, 20}, K{2, 21};

std::string connection(Guid dest, proto::Trigger trigger, proto::Navigation nav = proto::Navigation::NAVIGATE) {
  proto::Interaction i = proto::newConnection(Guid{9, 1}, dest);
  i.trigger = trigger;
  i.actions[0].navigation = nav;
  return proto::encodeInteractions({i});
}

Editor makeEditor(bool hoverLink = false, bool buttonLink = false, bool variantLink = false) {
  auto nodes = baseChanges();
  NodeChange set = make(SET, NodeType::FRAME, kPage, "!", {100, 100, 400, 200}, "Button");
  set.props.comp().isStateGroup = true;
  nodes.push_back(set);
  NodeChange v1 = make(V1, NodeType::SYMBOL, SET, "!", {20, 20, 150, 100}, "State=Default");
  if (variantLink) v1.props.extra["prototypeInteractions"] = connection(V2, proto::Trigger::ON_HOVER, proto::Navigation::SWAP_STATE);
  nodes.push_back(v1);
  nodes.push_back(make(V2, NodeType::SYMBOL, SET, "\"", {230, 20, 150, 100}, "State=Hover"));
  NodeChange btn = make(BTN, NodeType::ROUNDED_RECTANGLE, V1, "!", {10, 10, 60, 30}, "Bg");
  if (buttonLink) btn.props.extra["prototypeInteractions"] = connection(G, proto::Trigger::ON_CLICK);
  nodes.push_back(btn);
  nodes.push_back(make(F, NodeType::FRAME, kPage, "\"", {700, 100, 300, 300}, "F"));
  NodeChange h = make(H, NodeType::ROUNDED_RECTANGLE, F, "!", {20, 20, 100, 40}, "H");
  if (hoverLink) h.props.extra["prototypeInteractions"] = connection(G, proto::Trigger::ON_HOVER);
  nodes.push_back(h);
  nodes.push_back(make(L, NodeType::ROUNDED_RECTANGLE, F, "\"", {20, 200, 100, 40}, "L"));
  nodes.push_back(make(G, NodeType::FRAME, kPage, "#", {1200, 100, 300, 300}, "G"));
  nodes.push_back(make(K, NodeType::FRAME, kPage, "$", {1200, 600, 300, 300}, "K"));
  Editor e;
  e.setSessionID(1);
  e.setViewport(1600, 1200, 1, 1600, 1200);
  e.loadDocument(nodes, kNoGuid);
  e.setCamera({0, 0, 1});
  e.setPrototypeMode(true);
  e.takeEvents();
  return e;
}

// Drags from a selected layer's nub on the side nearest (x, y) to (tx, ty).
void dragNub(Editor& e, double x, double y, double tx, double ty) {
  e.pointer(PointerEvent::MOVE, x, y, 0, 0, 0);
  REQUIRE(e.pointer(PointerEvent::DOWN, x, y, 0, 1, 0) != 0);
  e.pointer(PointerEvent::MOVE, (x + tx) / 2, (y + ty) / 2, 0, 1, 0);
  e.pointer(PointerEvent::MOVE, tx, ty, 0, 1, 0);
}

void click(Editor& e, Vec2 p) {
  e.pointer(PointerEvent::MOVE, p.x, p.y, 0, 0, 0);
  e.pointer(PointerEvent::DOWN, p.x, p.y, 0, 1, 0);
  e.pointer(PointerEvent::UP, p.x, p.y, 0, 0, 0);
}

std::vector<proto::Interaction> of(Editor& e, Guid id) { return proto::interactions(e.document().get(id)->props); }

const PrototypeLink* linkFrom(const Overlay& o, Rect source) {
  for (const PrototypeLink& l : o.prototype.links)
    if (std::fabs(l.source.x - source.x) < 0.5 && std::fabs(l.source.y - source.y) < 0.5 && std::fabs(l.source.w - source.w) < 0.5) return &l;
  return nullptr;
}

}  // namespace

TEST_CASE("r17 connections: a variant connects to another variant of its set (Change to), never to the set") {
  Editor e = makeEditor();
  REQUIRE(e.setSelection({V1}) == OK);
  // V1 spans (120, 120)–(270, 220): its right nub, dragged over V2.
  dragNub(e, 270, 170, 400, 170);
  Overlay o = e.overlay();
  REQUIRE(o.prototype.hasTarget);
  CHECK(o.prototype.target.x == doctest::Approx(330));  // V2, not the set (100)
  CHECK(o.prototype.target.w == doctest::Approx(150));
  e.pointer(PointerEvent::UP, 400, 170, 0, 0, 0);
  auto list = of(e, V1);
  REQUIRE(list.size() == 1);
  CHECK(list[0].trigger == proto::Trigger::ON_CLICK);
  CHECK(list[0].actions[0].connection == proto::Connection::INTERNAL_NODE);
  CHECK(list[0].actions[0].navigation == proto::Navigation::SWAP_STATE);
  CHECK(list[0].actions[0].dest == V2);
  CHECK(proto::flows(e.document(), kPage).empty());  // no flow starting point for a Change to
  // One undo step.
  e.command(CommandId::UNDO);
  CHECK(of(e, V1).empty());

  // Its own variant and the set's background: nothing to connect to.
  dragNub(e, 270, 170, 150, 200);
  CHECK(!e.overlay().prototype.hasTarget);
  e.pointer(PointerEvent::MOVE, 300, 260, 0, 1, 0);
  CHECK(!e.overlay().prototype.hasTarget);
  e.pointer(PointerEvent::UP, 300, 260, 0, 0, 0);
  CHECK(of(e, V1).empty());
  // Out of its set: a top-level frame, as usual.
  dragNub(e, 270, 170, 1300, 200);
  e.pointer(PointerEvent::UP, 1300, 200, 0, 0, 0);
  list = of(e, V1);
  REQUIRE(list.size() == 1);
  CHECK(list[0].actions[0].navigation == proto::Navigation::NAVIGATE);
  CHECK(list[0].actions[0].dest == G);
}

TEST_CASE("r17 connections: a layer inside a variant connects to another variant") {
  Editor e = makeEditor();
  REQUIRE(e.setSelection({BTN}) == OK);
  // BTN spans (130, 130)–(190, 160).
  dragNub(e, 190, 145, 420, 150);
  CHECK(e.overlay().prototype.target.x == doctest::Approx(330));
  e.pointer(PointerEvent::UP, 420, 150, 0, 0, 0);
  auto list = of(e, BTN);
  REQUIRE(list.size() == 1);
  CHECK(list[0].actions[0].navigation == proto::Navigation::SWAP_STATE);
  CHECK(list[0].actions[0].dest == V2);
}

TEST_CASE("r17 connections: onto a layer in the hotspot's own frame — Scroll to") {
  Editor e = makeEditor();
  REQUIRE(e.setSelection({H}) == OK);
  // H spans (720, 120)–(820, 160); L (720, 300)–(820, 340).
  dragNub(e, 770, 160, 770, 320);
  CHECK(e.overlay().prototype.target.y == doctest::Approx(300));
  e.pointer(PointerEvent::UP, 770, 320, 0, 0, 0);
  auto list = of(e, H);
  REQUIRE(list.size() == 1);
  CHECK(list[0].actions[0].navigation == proto::Navigation::SCROLL_TO);
  CHECK(list[0].actions[0].dest == L);
  CHECK(proto::flows(e.document(), kPage).empty());
}

TEST_CASE("r17 connections: only the selected connection is highlighted; labels for every trigger but On click") {
  Editor e = makeEditor(true, true);
  Overlay o = e.overlay();
  const PrototypeLink* hover = linkFrom(o, {720, 120, 100, 40});
  const PrototypeLink* button = linkFrom(o, {130, 130, 60, 30});
  REQUIRE(hover);
  REQUIRE(button);
  CHECK(hover->label == "While hovering");
  CHECK(button->label.empty());
  CHECK(!hover->highlighted);
  // The hotspot selected: still quiet (65.png).
  REQUIRE(e.setSelection({H}) == OK);
  CHECK(!linkFrom(e.overlay(), {720, 120, 100, 40})->highlighted);
  // Its interaction open in the panel: highlighted.
  e.setPrototypeSelection(H, 0);
  CHECK(linkFrom(e.overlay(), {720, 120, 100, 40})->highlighted);
  CHECK(!linkFrom(e.overlay(), {130, 130, 60, 30})->highlighted);
  // Another layer selected: not.
  REQUIRE(e.setSelection({L}) == OK);
  CHECK(!linkFrom(e.overlay(), {720, 120, 100, 40})->highlighted);
  e.setPrototypeSelection(kNoGuid, -1);
}

TEST_CASE("r17 connections: a click on the line or its label selects the connection") {
  Editor e = makeEditor(true);
  NoodleCurve n = prototypeNoodle({720, 120, 100, 40}, {1200, 100, 300, 300}, false, {});
  // 6 px off the line: nothing.
  Vec2 q = noodlePoint(n, 0.25);
  Vec2 d = noodlePoint(n, 0.26) - q;
  Vec2 nrm{-d.y / d.length(), d.x / d.length()};
  click(e, q + Vec2{nrm.x * 6, nrm.y * 6});
  CHECK(e.takeEvents().prototypeSelected.empty());
  // 2 px off: selected, its hotspot too.
  click(e, q + Vec2{nrm.x * 2, nrm.y * 2});
  auto ev = e.takeEvents();
  REQUIRE(ev.prototypeSelected.size() == 1);
  CHECK(ev.prototypeSelected[0].node == H);
  CHECK(ev.prototypeSelected[0].index == 0);
  // The details open under the press (live: the popover's arrow at the clicked point).
  Vec2 at = q + Vec2{nrm.x * 2, nrm.y * 2};
  CHECK(ev.prototypeSelected[0].x == doctest::Approx(at.x));
  CHECK(ev.prototypeSelected[0].y == doctest::Approx(at.y));
  CHECK(ev.prototypeSelected[0].w == 0);
  CHECK(e.selection() == std::vector<Guid>{H});
  CHECK(e.prototypeSelectionNode() == H);
  CHECK(linkFrom(e.overlay(), {720, 120, 100, 40})->highlighted);
  CHECK(of(e, H).size() == 1);  // a click changes nothing
  CHECK(!e.canUndo());
  // On its label, away from the line.
  e.setSelection({});
  e.setPrototypeSelection(kNoGuid, -1);
  Vec2 mid = noodlePoint(n, 0.5);
  click(e, mid + Vec2{0, 12});
  ev = e.takeEvents();
  REQUIRE(ev.prototypeSelected.size() == 1);
  CHECK(ev.prototypeSelected[0].node == H);
  // …under its label (62–63.png): the chip's box, 30 high, centred on the curve's middle.
  CHECK(ev.prototypeSelected[0].x + ev.prototypeSelected[0].w / 2 == doctest::Approx(mid.x).epsilon(0.01));
  CHECK(ev.prototypeSelected[0].h == doctest::Approx(30));
}

TEST_CASE("r17 connections: a drag on the line moves its end; onto empty canvas removes it; undo") {
  Editor e = makeEditor(true);
  NoodleCurve n = prototypeNoodle({720, 120, 100, 40}, {1200, 100, 300, 300}, false, {});
  Vec2 q = noodlePoint(n, 0.3);
  e.pointer(PointerEvent::MOVE, q.x, q.y, 0, 0, 0);
  REQUIRE(e.pointer(PointerEvent::DOWN, q.x, q.y, 0, 1, 0) != 0);
  e.pointer(PointerEvent::MOVE, 1300, 500, 0, 1, 0);
  e.pointer(PointerEvent::MOVE, 1300, 700, 0, 1, 0);  // over K
  Overlay o = e.overlay();
  CHECK(o.prototype.hasTarget);
  CHECK(o.prototype.target.y == doctest::Approx(600));
  e.pointer(PointerEvent::UP, 1300, 700, 0, 0, 0);
  auto list = of(e, H);
  REQUIRE(list.size() == 1);
  CHECK(list[0].actions[0].dest == K);
  CHECK(list[0].trigger == proto::Trigger::ON_HOVER);  // the rest stays
  CHECK(e.takeEvents().prototypeSelected.empty());     // a drag selects nothing
  // Its end (now on K) — the hotspot selected — dragged off to empty canvas: gone.
  REQUIRE(e.setSelection({H}) == OK);
  NoodleCurve n2 = prototypeNoodle({720, 120, 100, 40}, {1200, 600, 300, 300}, false, {});
  e.pointer(PointerEvent::MOVE, n2.b.x, n2.b.y, 0, 0, 0);
  REQUIRE(e.pointer(PointerEvent::DOWN, n2.b.x, n2.b.y, 0, 1, 0) != 0);
  e.pointer(PointerEvent::MOVE, 600, 1000, 0, 1, 0);
  e.pointer(PointerEvent::UP, 600, 1000, 0, 0, 0);
  CHECK(of(e, H).empty());
  e.command(CommandId::UNDO);
  REQUIRE(of(e, H).size() == 1);
  CHECK(of(e, H)[0].actions[0].dest == K);
  e.command(CommandId::UNDO);
  CHECK(of(e, H)[0].actions[0].dest == G);
}

TEST_CASE("r17 connections: retargeting onto a variant makes it Change to") {
  Editor e = makeEditor(false, true);
  REQUIRE(e.setSelection({BTN}) == OK);
  NoodleCurve n = prototypeNoodle({130, 130, 60, 30}, {1200, 100, 300, 300}, false, {});
  e.pointer(PointerEvent::MOVE, n.b.x, n.b.y, 0, 0, 0);
  REQUIRE(e.pointer(PointerEvent::DOWN, n.b.x, n.b.y, 0, 1, 0) != 0);
  e.pointer(PointerEvent::MOVE, 800, 400, 0, 1, 0);
  e.pointer(PointerEvent::MOVE, 400, 170, 0, 1, 0);
  e.pointer(PointerEvent::UP, 400, 170, 0, 0, 0);
  auto list = of(e, BTN);
  REQUIRE(list.size() == 1);
  CHECK(list[0].actions[0].dest == V2);
  CHECK(list[0].actions[0].navigation == proto::Navigation::SWAP_STATE);
}

TEST_CASE("r17 connections: the selected connection's start moves the interaction to another layer") {
  Editor e = makeEditor(true);
  NoodleCurve n = prototypeNoodle({720, 120, 100, 40}, {1200, 100, 300, 300}, false, {});
  click(e, noodlePoint(n, 0.4));
  REQUIRE(e.prototypeSelectionNode() == H);
  e.takeEvents();
  // Its start dot, dragged onto L.
  e.pointer(PointerEvent::MOVE, n.a.x, n.a.y, 0, 0, 0);
  REQUIRE(e.pointer(PointerEvent::DOWN, n.a.x, n.a.y, 0, 1, 0) != 0);
  e.pointer(PointerEvent::MOVE, 790, 250, 0, 1, 0);
  e.pointer(PointerEvent::MOVE, 770, 320, 0, 1, 0);
  CHECK(e.overlay().prototype.target.y == doctest::Approx(300));
  e.pointer(PointerEvent::UP, 770, 320, 0, 0, 0);
  CHECK(of(e, H).empty());
  auto list = of(e, L);
  REQUIRE(list.size() == 1);
  CHECK(list[0].trigger == proto::Trigger::ON_HOVER);
  CHECK(list[0].actions[0].dest == G);
  // Still the selected connection, now L's.
  CHECK(e.selection() == std::vector<Guid>{L});
  auto ev = e.takeEvents();
  REQUIRE(ev.prototypeSelected.size() == 1);
  CHECK(ev.prototypeSelected[0].node == L);
  CHECK(linkFrom(e.overlay(), {720, 300, 100, 40})->highlighted);
  // One undo puts it back on H.
  e.command(CommandId::UNDO);
  CHECK(of(e, L).empty());
  REQUIRE(of(e, H).size() == 1);
  // The start dragged off to empty canvas: removed.
  click(e, noodlePoint(n, 0.4));
  e.takeEvents();
  e.pointer(PointerEvent::MOVE, n.a.x, n.a.y, 0, 0, 0);
  REQUIRE(e.pointer(PointerEvent::DOWN, n.a.x, n.a.y, 0, 1, 0) != 0);
  e.pointer(PointerEvent::MOVE, 600, 900, 0, 1, 0);
  e.pointer(PointerEvent::UP, 600, 900, 0, 0, 0);
  CHECK(of(e, H).empty());
  ev = e.takeEvents();
  REQUIRE(ev.prototypeSelected.size() == 1);
  CHECK(ev.prototypeSelected[0].index == -1);
}

TEST_CASE("r17 connections: a hotspot's next new connection takes the first trigger it doesn't use yet (live)") {
  Editor e = makeEditor();
  REQUIRE(e.setSelection({H}) == OK);
  // Three connections out of H's right nub in a row: On click, On drag, While hovering (live Figma 2026-10-10).
  const double targets[3][2] = {{1300, 200}, {1300, 700}, {1400, 250}};
  for (auto& t : targets) {
    dragNub(e, 820, 140, t[0], t[1]);
    e.pointer(PointerEvent::UP, t[0], t[1], 0, 0, 0);
  }
  auto list = of(e, H);
  REQUIRE(list.size() == 3);
  CHECK(list[0].trigger == proto::Trigger::ON_CLICK);
  CHECK(list[1].trigger == proto::Trigger::DRAG);
  CHECK(list[2].trigger == proto::Trigger::ON_HOVER);
  CHECK(list[1].actions[0].dest == K);
}

TEST_CASE("r17 connections: a Change to between variants is drawn as one (lavender), the others not") {
  // V1 → V2, Change to (live 2026-10-10: lavender line, ring and chip; the component purple when selected).
  Editor e = makeEditor(true, false, true);
  Overlay o = e.overlay();
  const PrototypeLink* change = linkFrom(o, {120, 120, 150, 100});
  const PrototypeLink* hover = linkFrom(o, {720, 120, 100, 40});
  REQUIRE(change);
  REQUIRE(hover);
  CHECK(change->changeTo);
  CHECK(change->label == "While hovering");
  CHECK(!change->highlighted);
  CHECK(!hover->changeTo);
  REQUIRE(e.setSelection({V1}) == OK);
  e.setPrototypeSelection(V1, 0);
  Overlay o2 = e.overlay();
  change = linkFrom(o2, {120, 120, 150, 100});
  REQUIRE(change);
  CHECK(change->changeTo);
  CHECK(change->highlighted);
  e.setPrototypeSelection(kNoGuid, -1);
}

TEST_CASE("r17 connections: Delete with a connection selected removes its interaction, not the layer; undo") {
  Editor e = makeEditor(true);
  NoodleCurve n = prototypeNoodle({720, 120, 100, 40}, {1200, 100, 300, 300}, false, {});
  click(e, noodlePoint(n, 0.25));
  REQUIRE(e.prototypeSelectionNode() == H);
  e.takeEvents();
  e.command(CommandId::DELETE);
  REQUIRE(e.document().get(H));
  CHECK(of(e, H).empty());
  CHECK(e.selection() == std::vector<Guid>{H});
  CHECK(e.prototypeSelectionNode() == kNoGuid);
  auto ev = e.takeEvents();
  REQUIRE(ev.prototypeSelected.size() == 1);
  CHECK(ev.prototypeSelected[0].node == H);
  CHECK(ev.prototypeSelected[0].index == -1);  // the details close
  e.command(CommandId::UNDO);
  REQUIRE(of(e, H).size() == 1);
  CHECK(of(e, H)[0].actions[0].dest == G);
  // No connection selected now: Delete removes the selected layer as ever.
  REQUIRE(e.setSelection({H}) == OK);
  e.command(CommandId::DELETE);
  CHECK(e.selection().empty());
}
