// An instance's own interactions and its component's, together, as on a web page (docs/engine.md §3.4 "Instance and
// component interactions together"; the owner's homesearch → finder-segmented → search-input, 2026-10-21).
// Three levels: a screen holds "homesearch" (Home) → "Finder" (Tour / Hotel, gap 12; Home sets it to 8) → "Field"
// (Default / Hovered / Selected). The Field's "Location" hovers it (While hovering → Hovered) and its "Pick" selects it
// (On click → Selected) — the component's own states. Finder's main adds, on its Field, On click → open the overlay
// "Menu" on both layers (the instance's actions; stored as Figma stores them: an override entry holding only the click).
// Menu has a "Close" (Close overlay) and a Toggle (Off / On) of its own.
#include <algorithm>
#include <functional>

#include "doctest.h"
#include "Helpers.h"
#include "editor/Editor.h"
#include "proto/Player.h"
#include "proto/Prototype.h"
#include "scene/CodecKiwi.h"

using namespace eng;
using namespace eng::test;

namespace {

const Guid FSET{40, 1}, FD{40, 2}, FH{40, 3}, FS{40, 4}, KSET{40, 10}, TOUR{40, 11}, HOTEL{40, 12}, HOME{40, 20}, NESTED{40, 21},
    TSET{40, 30}, OFF{40, 31}, ON{40, 32}, MENU{40, 40}, SCREEN{40, 50}, HS{40, 51}, FD_LOC{40, 60}, FD_PICK{40, 61};

std::string bytes(const std::string& text) {
  json::Value v;
  REQUIRE(json::parse(text, v));
  std::string b = codec::extraFromJson("NodeChange", "prototypeInteractions", v);
  REQUIRE(!b.empty());
  return b;
}

std::string entry(uint32_t id, const char* trigger, const std::string& action) {
  return std::string(R"({"id":{"sessionID":41,"localID":)") + std::to_string(id) + R"(},"stateManagementVersion":1,"event":{"interactionType":")" +
         trigger + R"("},"actions":[)" + action + "]}";
}
std::string changeTo(Guid dest) {
  return R"({"connectionType":"INTERNAL_NODE","navigationType":"SWAP_STATE","transitionType":"INSTANT_TRANSITION","transitionNodeID":")" +
         dest.toString() + "\"}";
}
std::string overlay(Guid dest) {
  return R"({"connectionType":"INTERNAL_NODE","navigationType":"OVERLAY","transitionType":"INSTANT_TRANSITION","transitionNodeID":")" +
         dest.toString() + "\"}";
}
const char* kClose = R"({"connectionType":"CLOSE"})";

struct Fixture {
  Editor ed;
  proto::Player player{ed};
  double t = 0;
  uint32_t next = 100;

  Fixture() {
    auto nodes = baseChanges();
    auto set = [&](Guid id, double y, const char* name) {
      NodeChange s = make(id, NodeType::FRAME, kPage, "~" + std::to_string(id.localID), {0, y, 600, 100}, name);
      s.props.comp().isStateGroup = true;
      nodes.push_back(s);
    };
    auto rect = [&](Guid id, Guid parent, const std::string& pos, Rect r, const char* name, const std::string& ix = "") {
      NodeChange c = make(id == kNoGuid ? Guid{41, next++} : id, NodeType::RECTANGLE, parent, pos, r, name);
      if (!ix.empty()) c.props.extra["prototypeInteractions"] = bytes(ix);
      nodes.push_back(c);
    };
    auto instance = [&](Guid id, Guid parent, const std::string& pos, Rect r, const char* name, Guid main) -> NodeChange& {
      NodeChange c = make(id == kNoGuid ? Guid{41, next++} : id, NodeType::INSTANCE, parent, pos, r, name);
      c.props.comp().symbolData.symbolID = main;
      c.props.fillPaints.clear();
      nodes.push_back(c);
      return nodes.back();
    };
    // Level 3: Field.
    set(FSET, 2000, "Field");
    nodes.push_back(make(FD, NodeType::SYMBOL, FSET, "!", {0, 0, 120, 30}, "State=Default"));
    rect(FD_LOC, FD, "!", {0, 0, 40, 30}, "Location", "[" + entry(1, "ON_HOVER", changeTo(FH)) + "]");
    rect(FD_PICK, FD, "\"", {60, 0, 40, 30}, "Pick", "[" + entry(2, "ON_CLICK", changeTo(FS)) + "]");
    nodes.push_back(make(FH, NodeType::SYMBOL, FSET, "\"", {150, 0, 120, 30}, "State=Hovered"));
    rect(kNoGuid, FH, "!", {0, 0, 40, 30}, "Location");
    rect(kNoGuid, FH, "\"", {60, 0, 40, 30}, "Pick", "[" + entry(3, "ON_CLICK", changeTo(FS)) + "]");
    nodes.push_back(make(FS, NodeType::SYMBOL, FSET, "#", {300, 0, 120, 30}, "State=Selected"));
    rect(kNoGuid, FS, "!", {0, 0, 40, 30}, "Location");
    rect(kNoGuid, FS, "\"", {60, 0, 40, 30}, "Pick", "[" + entry(4, "ON_CLICK", changeTo(FD)) + "]");
    // Level 2: Finder — its Field gets the overlay click on Location and Pick (only the click in the entry).
    set(KSET, 2200, "Finder");
    for (auto [id, pos, x, button, dest] : {std::tuple{TOUR, "!", 0.0, "Hotel", HOTEL}, std::tuple{HOTEL, "\"", 300.0, "Tour", TOUR}}) {
      NodeChange v = make(id, NodeType::SYMBOL, KSET, pos, {x, 0, 260, 60}, id == TOUR ? "State=Tour" : "State=Hotel");
      v.props.stack().stackMode = StackMode::HORIZONTAL;
      v.props.stack().stackSpacing = 12;
      nodes.push_back(v);
      NodeChange& f = instance(kNoGuid, id, "!", {0, 0, 120, 30}, "Field", FD);
      for (auto [key, n] : {std::pair{FD_LOC, 10u}, std::pair{FD_PICK, 11u}}) {
        SymbolOverride o;
        o.path = {key};
        o.mask = F_EXTRA;
        o.props.extra["prototypeInteractions"] = bytes("[" + entry(n, "ON_CLICK", overlay(MENU)) + "]");
        f.props.comp().symbolData.overrides.push_back(o);
      }
      rect(kNoGuid, id, "\"", {0, 0, 40, 30}, button, "[" + entry(id == TOUR ? 20 : 21, "ON_CLICK", changeTo(dest)) + "]");
    }
    // Level 1: Home, its Finder's gap set to 8.
    nodes.push_back(make(HOME, NodeType::SYMBOL, kPage, "#", {0, 2400, 300, 80}, "Home"));
    NodeChange& k = instance(NESTED, HOME, "!", {10, 10, 260, 60}, "Finder", TOUR);
    SymbolOverride gap;
    gap.mask = F_STACK_SPACING;
    gap.props.stack().stackSpacing = 8;
    k.props.comp().symbolData.overrides.push_back(gap);
    // The overlay: Close, and a Toggle of its own.
    set(TSET, 2600, "Toggle");
    nodes.push_back(make(OFF, NodeType::SYMBOL, TSET, "!", {0, 0, 40, 20}, "State=Off"));
    rect(kNoGuid, OFF, "!", {0, 0, 40, 20}, "Knob", "[" + entry(30, "ON_CLICK", changeTo(ON)) + "]");
    nodes.push_back(make(ON, NodeType::SYMBOL, TSET, "\"", {60, 0, 40, 20}, "State=On"));
    rect(kNoGuid, ON, "!", {0, 0, 40, 20}, "Knob", "[" + entry(31, "ON_CLICK", changeTo(OFF)) + "]");
    nodes.push_back(make(MENU, NodeType::FRAME, kPage, "&", {1000, 0, 200, 100}, "Menu"));
    rect(kNoGuid, MENU, "!", {10, 10, 40, 20}, "Close", std::string("[") + entry(40, "ON_CLICK", kClose) + "]");
    instance(kNoGuid, MENU, "\"", {10, 50, 40, 20}, "Toggle", OFF);
    // The screen.
    nodes.push_back(make(SCREEN, NodeType::FRAME, kPage, "!", {0, 0, 800, 400}, "Screen"));
    instance(HS, SCREEN, "!", {20, 20, 300, 80}, "homesearch", HOME);
    ed.setSessionID(1);
    ed.setViewport(800, 400, 1, 800, 400);
    ed.loadDocument(nodes, kNoGuid);
    ed.takeEvents();
    REQUIRE(player.start(kPage, SCREEN));
    advance(16);
  }
  void advance(double ms) {
    while (ms > 0) {
      double step = std::min(10.0, ms);
      t += step;
      ms -= step;
      player.tick(t);
    }
  }
  Guid at(Guid root, std::initializer_list<const char*> names) {
    Guid cur = root;
    for (const char* name : names) {
      Guid found = kNoGuid;
      for (Guid c : ed.document().children(cur))
        if (ed.document().get(c)->props.name == name) {
          found = c;
          break;
        }
      REQUIRE(found != kNoGuid);
      cur = found;
    }
    return cur;
  }
  Guid field() { return ed.mainOf(at(HS, {"Finder", "Field"})); }
  // Where a layer shows: on the screen (at the page's origin), or in the open overlay (centred on the screen).
  Vec2 centre(Guid id) {
    Mat2x3 m = ed.document().worldTransform(id);
    const NodeProps& p = ed.document().get(id)->props;
    Vec2 c{m.m02 + p.size.x / 2, m.m12 + p.size.y / 2};
    if (ed.document().isAncestor(MENU, id)) c = {c.x - 1000 + (800 - 200) / 2.0, c.y + (400 - 100) / 2.0};
    return c;
  }
  void move(Vec2 p) {
    player.pointer(PointerEvent::MOVE, p.x, p.y, 0, 0);
    advance(100);
  }
  void click(Vec2 p) {
    move(p);
    player.pointer(PointerEvent::DOWN, p.x, p.y, 1, 0);
    player.pointer(PointerEvent::UP, p.x, p.y, 0, 0);
    advance(100);
  }
};

}  // namespace

TEST_CASE("proto.instance_interactions: a hover the main defines plays three levels deep under an instance's click") {
  // Before: the override's list (the click alone) replaced the layer's — Location never hovered (owner: "search-input's
  // hovers don't work inside homesearch; after Reset instance they do").
  Fixture f;
  CHECK(f.field() == FD);
  f.move(f.centre(f.at(HS, {"Finder", "Field", "Location"})));
  CHECK(f.field() == FH);
  f.move({700, 350});
  CHECK(f.field() == FD);
}

TEST_CASE("proto.instance_interactions: the same trigger on the instance and its component — both run, the component's first") {
  Fixture f;
  // Pick: the component's On click (→ Selected) and the instance's On click (→ the overlay) — Figma keeps only the
  // instance's; a web page runs the component's handler and the one passed in.
  f.click(f.centre(f.at(HS, {"Finder", "Field", "Pick"})));
  CHECK(f.field() == FS);
  REQUIRE(f.player.overlays().size() == 1);
  CHECK(f.player.overlays()[0].frame == MENU);
  // The overlay's own interactive component: its toggle switches; the base screen's states stay.
  Guid knob = f.at(f.at(MENU, {"Toggle"}), {"Knob"});
  f.click(f.centre(knob));
  CHECK(f.ed.mainOf(f.at(MENU, {"Toggle"})) == ON);
  CHECK(f.field() == FS);
  // Closing keeps every state: the Field still Selected.
  f.click(f.centre(f.at(MENU, {"Close"})));
  CHECK(f.player.overlays().empty());
  CHECK(f.field() == FS);
  CHECK(f.ed.mainOf(f.at(HS, {"Finder"})) == TOUR);
}

TEST_CASE("proto.instance_interactions: hover, then a click opening an overlay from three levels deep; the hover ends under the overlay") {
  Fixture f;
  Vec2 loc = f.centre(f.at(HS, {"Finder", "Field", "Location"}));
  f.move(loc);
  CHECK(f.field() == FH);
  // Hovered's Location has no click of its own: the instance's click followed it by name (it was set on Default's).
  f.click(loc);
  REQUIRE(f.player.overlays().size() == 1);
  // The overlay has no background: the screen under it still reacts (Figma's), the pointer still hovers Location.
  f.move({loc.x + 1, loc.y});
  CHECK(f.field() == FH);
  // Onto the overlay: the pointer is no longer over Location — its hover is undone, the overlay stays.
  f.move(f.centre(f.at(MENU, {"Close"})));
  CHECK(f.field() == FD);
  CHECK(f.player.overlays().size() == 1);
  f.click(f.centre(f.at(MENU, {"Close"})));
  CHECK(f.player.overlays().empty());
  // Back on Location: it hovers again.
  f.move(loc);
  CHECK(f.field() == FH);
}

TEST_CASE("proto.instance_interactions: a gap set on a nested instance stays through its Change to") {
  Fixture f;
  CHECK(f.ed.document().get(f.at(HS, {"Finder"}))->props.stack().stackSpacing == 8);
  f.click(f.centre(f.at(HS, {"Finder", "Hotel"})));
  CHECK(f.ed.mainOf(f.at(HS, {"Finder"})) == HOTEL);
  CHECK(f.ed.document().get(f.at(HS, {"Finder"}))->props.stack().stackSpacing == 8);
  f.click(f.centre(f.at(HS, {"Finder", "Tour"})));
  CHECK(f.ed.mainOf(f.at(HS, {"Finder"})) == TOUR);
  CHECK(f.ed.document().get(f.at(HS, {"Finder"}))->props.stack().stackSpacing == 8);
  CHECK(f.ed.document().get(TOUR)->props.stack().stackSpacing == 12);
  CHECK(f.ed.document().get(HOTEL)->props.stack().stackSpacing == 12);
}
