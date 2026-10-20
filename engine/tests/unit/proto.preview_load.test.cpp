// A prototype engine's load and play on a heavy file (2026-10-20, the owner's B2C page: 134k nodes, 17k interactions):
// interactions read once per distinct value (they were read as kiwi → JSON text → parsed again on every look: 0.6 s a
// click, 2.4 s an opening); an instance's own connections told without building its played list; bound values copied
// from a live engine not resolved again at load (only their dependencies, later — at once when a variable, a style or
// a mode changes); a page's bound values resolved per screen as it is derived; what comes next derived ahead (the
// player's upcoming screens), not the whole page.
#include <string>

#include "doctest.h"
#include "Helpers.h"
#include "editor/Editor.h"
#include "proto/Player.h"
#include "proto/Prototype.h"
#include "scene/CodecKiwi.h"

using namespace eng;
using namespace eng::test;

namespace {

std::string extra(const char* key, const std::string& json) {
  json::Value v;
  REQUIRE(json::parse(json, v));
  std::string bytes = codec::extraFromJson("NodeChange", key, v);
  REQUIRE(!bytes.empty());
  return bytes;
}

// One interaction: an id, On click → Navigate to `dest` with `transition`.
std::string entry(Guid id, Guid dest, const char* transition = "INSTANT_TRANSITION") {
  return std::string("{\"id\":\"") + id.toString() + "\",\"event\":{\"interactionType\":\"ON_CLICK\"},\"actions\":[{\"connectionType\":\"INTERNAL_NODE\"," +
         "\"navigationType\":\"NAVIGATE\",\"transitionNodeID\":\"" + dest.toString() + "\",\"transitionType\":\"" + transition +
         "\",\"transitionDuration\":0.3,\"easingType\":\"LINEAR\"}]}";
}

NodeProps withInteractions(const std::string& list) {
  NodeProps p;
  p.type = NodeType::SYMBOL;
  p.extra["prototypeInteractions"] = extra("prototypeInteractions", list);
  return p;
}

const Guid A{7, 1}, B{7, 2}, C{7, 3}, D1{7, 10}, D2{7, 11};

}  // namespace

TEST_CASE("proto.preview_load: interactions are read once per value, and a changed value reads anew") {
  NodeProps p = withInteractions("[" + entry(A, D1) + "]");
  auto first = proto::sharedInteractions(p), again = proto::sharedInteractions(p);
  CHECK(first.get() == again.get());  // the same list, not read again
  REQUIRE(first->size() == 1);
  CHECK((*first)[0].actions.at(0).dest == D1);
  // Another node with the same bytes (an instance's copy of its main's): the same list too.
  NodeProps copy = p;
  CHECK(proto::sharedInteractions(copy).get() == first.get());
  // Changed: its new list.
  p.extra["prototypeInteractions"] = extra("prototypeInteractions", "[" + entry(A, D2) + "]");
  auto changed = proto::sharedInteractions(p);
  CHECK(changed.get() != first.get());
  CHECK((*changed)[0].actions.at(0).dest == D2);
  CHECK((*first)[0].actions.at(0).dest == D1);  // what a caller holds stays as it was
  CHECK(proto::interactions(p).size() == 1);
  // None: empty.
  NodeProps none;
  CHECK(proto::sharedInteractions(none)->empty());
  CHECK(!proto::hasInteractions(none));
}

TEST_CASE("proto.preview_load: an instance's own connections are told as instanceInteractions tells them") {
  NodeProps main = withInteractions("[" + entry(A, D1) + "]");
  NodeProps other = withInteractions("[" + entry(C, D1) + "]");  // another variant of the set
  // One instance stores a copy of its main's A, an added B and C left from a variant switch; another, A changed.
  NodeProps own = withInteractions("[" + entry(A, D1) + "," + entry(B, D2) + "," + entry(C, D1) + "]");
  NodeProps changed = withInteractions("[" + entry(A, D2, "DISSOLVE") + "]");
  std::vector<const NodeProps*> variants{&main, &other};
  for (const NodeProps* inst : {&own, &changed}) {
    std::vector<int> index;
    proto::instanceInteractions(*inst, &main, variants, &index);
    std::vector<bool> expect(proto::interactions(*inst).size(), false);
    for (int k : index)
      if (k >= 0) expect[static_cast<size_t>(k)] = true;
    CHECK(proto::instanceOwnEntries(*inst, &main, variants) == expect);
  }
  CHECK(proto::instanceOwnEntries(own, &main, variants) == std::vector<bool>{false, true, false});
  CHECK(proto::instanceOwnEntries(changed, &main, variants) == std::vector<bool>{true});
  // Without a main: all of them its own.
  CHECK(proto::instanceOwnEntries(own, nullptr, {}) == std::vector<bool>{true, true, true});
}

namespace {

// (Session 9: the commands below make session 1 nodes.)
const Guid F{9, 1}, R{9, 2}, SCREEN2{9, 3}, R2{9, 4}, INST{9, 5};
const Guid OTHER{0, 5}, MAIN{5, 1}, MAIN_BG{5, 2};
const Color kRed{1, 0, 0, 1}, kBlue{0, 0, 1, 1}, kGreen{0, 1, 0, 1};

CommandArgs args(const std::string& jsonText) {
  CommandArgs a;
  REQUIRE(json::parse(jsonText, a.raw));
  return a;
}
std::string q(Guid g) { return "\"" + g.toString() + "\""; }
Status run(Editor& e, CommandId id, const std::string& json) { return e.command(id, args(json)); }
Color fill(const Editor& e, Guid id) { return e.document().get(id)->props.fillPaints.at(0).color; }

struct Modes {
  Guid set, light, dark, bg;
};

// A file: page 1 — a screen F with a rect R bound to `bg`, a second screen with a bound rect R2 and an instance of
// MAIN; page 2 — MAIN, its background bound to `bg`. Light red, Dark blue.
std::vector<NodeChange> file(Modes& t) {
  auto nodes = baseChanges();
  NodeProps other;
  other.type = NodeType::CANVAS;
  other.name = "Components";
  other.parentIndex = {kDoc, "\""};
  nodes.push_back(NodeChange::created(OTHER, other));
  nodes.push_back(make(F, NodeType::FRAME, kPage, "!", {0, 0, 400, 400}, "Screen"));
  nodes.push_back(make(SCREEN2, NodeType::FRAME, kPage, "\"", {500, 0, 400, 400}, "Second"));
  nodes.push_back(make(MAIN, NodeType::SYMBOL, OTHER, "!", {0, 0, 100, 100}, "Main"));
  Editor b;
  b.setSessionID(1);
  b.loadDocument(nodes, kPage);
  REQUIRE(run(b, CommandId::CREATE_VARIABLE_COLLECTION, R"({"name":"Modes"})") == OK);
  t.set = b.lastCreated()[0];
  t.light = b.lastCreated()[1];
  REQUIRE(run(b, CommandId::ADD_VARIABLE_MODE, "{\"collection\":" + q(t.set) + ",\"name\":\"Dark\"}") == OK);
  t.dark = b.lastCreated()[0];
  REQUIRE(run(b, CommandId::CREATE_VARIABLE, "{\"collection\":" + q(t.set) + R"(,"type":"COLOR","name":"bg","value":{"r":1,"g":0,"b":0,"a":1}})") == OK);
  t.bg = b.lastCreated()[0];
  REQUIRE(run(b, CommandId::SET_VARIABLE_VALUE, "{\"variable\":" + q(t.bg) + ",\"mode\":" + q(t.dark) + R"(,"value":{"r":0,"g":0,"b":1,"a":1}})") == OK);
  std::vector<NodeChange> more;
  for (auto [id, parent, pos] : {std::tuple{R, F, "!"}, std::tuple{R2, SCREEN2, "!"}, std::tuple{MAIN_BG, MAIN, "!"}}) {
    NodeChange c = make(id, NodeType::ROUNDED_RECTANGLE, parent, pos, {10, 10, 50, 50}, "Bound");
    c.props.fillPaints[0].colorVar = VariableData::aliasOf(t.bg, VariableResolvedType::COLOR);
    more.push_back(c);
  }
  NodeChange inst = make(INST, NodeType::INSTANCE, SCREEN2, "\"", {100, 100, 100, 100}, "Instance");
  inst.props.comp().symbolData.symbolID = MAIN;
  inst.props.fillPaints.clear();
  more.push_back(inst);
  REQUIRE(b.applyChanges(more, APPLY_USER) == OK);
  auto out = b.encodeDocument();
  // As a file whose stored values went stale: every bound fill stored green.
  for (NodeChange& c : out)
    if (c.guid == R || c.guid == R2 || c.guid == MAIN_BG) c.props.fillPaints[0].color = kGreen;
  return out;
}

}  // namespace

TEST_CASE("proto.preview_load: a live engine's bound values aren't resolved again at load, but follow a variable or a mode") {
  Modes t;
  Editor src;
  src.setSessionID(1);
  src.loadDocument(file(t), kPage);  // its page's bound values resolved; the Components page's not yet (not shown)
  CHECK(fill(src, R) == kRed);
  CHECK(fill(src, MAIN_BG) == kGreen);
  Editor part;
  part.setSessionID(1);
  part.setViewport(400, 400, 1, 400, 400);
  part.setPartial(true);
  part.setLazyScreens(true);
  part.setFreshBindings(src.pagesUnresolved());
  part.loadDocument(src.encodePage(kPage), kPage);
  CHECK(fill(part, R) == kRed);
  // The page the source hadn't shown: resolved at load (its stored values may be stale) — the instance draws it so.
  CHECK(fill(part, MAIN_BG) == kRed);
  proto::Player player{part};
  REQUIRE(player.start(kPage, SCREEN2));
  REQUIRE(!part.document().children(INST).empty());
  CHECK(part.document().get(part.document().children(INST)[0])->props.fillPaints.at(0).color == kRed);
  // A mode switch (the player's Set variable mode writes the same field) reaches them, though their dependencies
  // were never noted at load.
  REQUIRE(run(part, CommandId::SET_VARIABLE_MODE, "{\"refs\":[" + q(F) + "," + q(SCREEN2) + "],\"collection\":" + q(t.set) + ",\"mode\":" + q(t.dark) + "}") == OK);
  CHECK(fill(part, R) == kBlue);
  CHECK(fill(part, R2) == kBlue);
  CHECK(part.document().get(part.document().children(INST)[0])->props.fillPaints.at(0).color == kBlue);
  // A value edit, too.
  REQUIRE(run(part, CommandId::SET_VARIABLE_VALUE, "{\"variable\":" + q(t.bg) + ",\"mode\":" + q(t.dark) + R"(,"value":{"r":0,"g":1,"b":0,"a":1}})") == OK);
  CHECK(fill(part, R) == kGreen);
}

TEST_CASE("proto.preview_load: a value edit right after the load reaches the layers loaded current (their dependencies noted then)") {
  Modes t;
  Editor src;
  src.setSessionID(1);
  src.loadDocument(file(t), kPage);
  Editor part;
  part.setSessionID(1);
  part.setViewport(400, 400, 1, 400, 400);
  part.setPartial(true);
  part.setLazyScreens(true);
  part.setFreshBindings(src.pagesUnresolved());
  part.loadDocument(src.encodePage(kPage), kPage);
  REQUIRE(run(part, CommandId::SET_VARIABLE_VALUE, "{\"variable\":" + q(t.bg) + ",\"mode\":" + q(t.light) + R"(,"value":{"r":0,"g":0,"b":1,"a":1}})") == OK);
  CHECK(fill(part, R) == kBlue);
  CHECK(fill(part, R2) == kBlue);
}

TEST_CASE("proto.preview_load: the dependencies are noted between frames, then a value edit reaches every layer") {
  Modes t;
  Editor src;
  src.setSessionID(1);
  src.loadDocument(file(t), kPage);
  Editor part;
  part.setSessionID(1);
  part.setViewport(400, 400, 1, 400, 400);
  part.setPartial(true);
  part.setLazyScreens(true);
  part.setFreshBindings(src.pagesUnresolved());
  part.loadDocument(src.encodePage(kPage), kPage);
  // Between frames (no player): the pending dependencies first, then the page's screens.
  for (int i = 0; i < 16 && part.deriveNextTrees(kPage, 0); i++) {
  }
  REQUIRE(run(part, CommandId::SET_VARIABLE_VALUE, "{\"variable\":" + q(t.bg) + ",\"mode\":" + q(t.light) + R"(,"value":{"r":0,"g":0,"b":1,"a":1}})") == OK);
  CHECK(fill(part, R) == kBlue);
  CHECK(fill(part, R2) == kBlue);
}

TEST_CASE("proto.preview_load: a presented file's bound values are resolved per screen, as the screen is shown") {
  Modes t;
  Editor ed;
  ed.setSessionID(1);
  ed.setViewport(400, 400, 1, 400, 400);
  ed.setLazyScreens(true);
  ed.loadDocument(file(t), kPage);  // stored values stale (green)
  CHECK(fill(ed, R2) == kGreen);
  proto::Player player{ed};
  REQUIRE(player.start(kPage, F));
  CHECK(fill(ed, R) == kRed);
  CHECK(fill(ed, R2) == kGreen);  // not shown yet
  // Derived ahead (what the shown screen leads to — → goes there), or when shown.
  ed.deriveTree(SCREEN2);
  CHECK(fill(ed, R2) == kRed);
}

TEST_CASE("proto.preview_load: what comes next is derived ahead, not the whole page") {
  Modes t;
  auto nodes = file(t);
  const Guid THIRD{9, 20}, THIRD_INST{9, 21}, HOT{9, 22};
  nodes.push_back(make(THIRD, NodeType::FRAME, kPage, "#", {1000, 0, 400, 400}, "Third"));
  NodeChange ti = make(THIRD_INST, NodeType::INSTANCE, THIRD, "!", {0, 0, 100, 100}, "Instance");
  ti.props.comp().symbolData.symbolID = MAIN;
  ti.props.fillPaints.clear();
  nodes.push_back(ti);
  // F's hotspot goes to the third screen.
  NodeChange hot = make(HOT, NodeType::ROUNDED_RECTANGLE, F, "\"", {200, 200, 50, 50}, "Hotspot");
  hot.props.extra["prototypeInteractions"] = extra("prototypeInteractions", "[" + entry(A, THIRD) + "]");
  nodes.push_back(hot);
  Editor ed;
  ed.setSessionID(1);
  ed.setViewport(400, 400, 1, 400, 400);
  ed.setLazyScreens(true);
  ed.loadDocument(nodes, kPage);
  proto::Player player{ed};
  REQUIRE(player.start(kPage, F));
  // Upcoming from F: its hotspot's destination (the third screen); with no flow → also goes to the next in reading order.
  auto next = player.upcoming();
  CHECK(std::find(next.begin(), next.end(), THIRD) != next.end());
  CHECK(std::find(next.begin(), next.end(), F) == next.end());
  CHECK(ed.document().children(THIRD_INST).empty());
  // Derived ahead: those, one a call; nothing else of the page.
  std::vector<Guid> only{THIRD};
  CHECK(!ed.deriveNextTrees(kPage, 0, &only));
  CHECK(!ed.document().children(THIRD_INST).empty());
  CHECK(ed.document().children(INST).empty());
}
