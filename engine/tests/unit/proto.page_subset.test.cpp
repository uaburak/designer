// The inline preview's and Present here's document (Editor::encodePage, 2026-10-20): the presented page, the internal
// canvas, and from other pages only what the page reaches — the components its instances show (a variant with its
// whole set), nested instances' components, instance-swap defaults, interactions' destinations — each with its
// ancestors; parents before children. A partial engine skips what happens elsewhere and names what a change needs that
// it lacks.
#include <functional>
#include <sstream>
#include <unordered_set>

#include "doctest.h"
#include "Helpers.h"
#include "editor/Editor.h"
#include "proto/Player.h"
#include "scene/CodecJson.h"
#include "scene/CodecKiwi.h"

using namespace eng;
using namespace eng::test;

namespace {

const Guid COMPONENTS{0, 3}, ICONS{0, 4};
// Page 1: a screen with a button instance (its Default variant) and a card instance; a second screen it navigates to.
const Guid SCREEN{1, 1}, INST{1, 2}, CARD_INST{1, 3}, SCREEN2{1, 4}, CARD_INST2{1, 5};
// Components page: a sheet frame holding the Button set (Default / Hover, each with a nested Icon instance), the Card
// component (an instance-swap property defaulting to Icon 2), and unrelated layers.
const Guid SHEET{2, 1}, SET{2, 2}, DEF{2, 3}, HOV{2, 4}, DEF_BG{2, 5}, HOV_BG{2, 6}, DEF_ICON{2, 7}, HOV_ICON{2, 8}, CARD{2, 9},
    CARD_BG{2, 10}, SWAP_PROP{2, 11}, UNRELATED{2, 20}, UNRELATED_CHILD{2, 21}, LONE_MAIN{2, 22};
// Icons page: Icon 1 (used by the variants), Icon 2 (Card's swap default), Icon 3 (unused).
const Guid ICON1{3, 1}, ICON1_SHAPE{3, 2}, ICON2{3, 3}, ICON3{3, 4}, ICON3_SHAPE{3, 5};
const Guid VAR_SET{4, 1}, VAR{4, 2};

std::string extra(const char* key, const std::string& json) {
  json::Value v;
  REQUIRE(json::parse(json, v));
  std::string bytes = codec::extraFromJson("NodeChange", key, v);
  REQUIRE(!bytes.empty());
  return bytes;
}

std::string action(Guid dest, const char* trigger, const char* nav, const char* transition = "INSTANT_TRANSITION") {
  return std::string("[{\"event\":{\"interactionType\":\"") + trigger + "\"},\"actions\":[{\"connectionType\":\"INTERNAL_NODE\",\"navigationType\":\"" +
         nav + "\",\"transitionNodeID\":\"" + dest.toString() + "\",\"transitionType\":\"" + transition + "\",\"transitionDuration\":0.3,\"easingType\":\"LINEAR\"}]}]";
}

NodeChange page(Guid id, const std::string& position, const std::string& name) {
  NodeProps p;
  p.type = NodeType::CANVAS;
  p.name = name;
  p.parentIndex = {kDoc, position};
  return NodeChange::created(id, p);
}

NodeChange instance(Guid id, Guid main, Guid parent, const std::string& position, Rect r, const std::string& name) {
  NodeChange c = make(id, NodeType::INSTANCE, parent, position, r, name);
  c.props.comp().symbolData.symbolID = main;
  c.props.fillPaints.clear();
  return c;
}

NodeChange rect(Guid id, Guid parent, Rect r, uint32_t color, const std::string& name = "Bg") {
  NodeChange c = make(id, NodeType::RECTANGLE, parent, "!", r, name);
  c.props.fillPaints = {Paint::solid(Color::hex(color))};
  return c;
}

std::vector<NodeChange> file() {
  auto nodes = baseChanges();
  nodes.push_back(page(COMPONENTS, "\"", "Components"));
  nodes.push_back(page(ICONS, "#", "Icons"));
  // Icons
  nodes.push_back(make(ICON1, NodeType::SYMBOL, ICONS, "!", {0, 0, 24, 24}, "Icon 1"));
  nodes.push_back(rect(ICON1_SHAPE, ICON1, {2, 2, 20, 20}, 0xff0000, "Shape"));
  nodes.push_back(make(ICON2, NodeType::SYMBOL, ICONS, "\"", {40, 0, 24, 24}, "Icon 2"));
  nodes.push_back(make(ICON3, NodeType::SYMBOL, ICONS, "#", {80, 0, 24, 24}, "Icon 3"));
  nodes.push_back(rect(ICON3_SHAPE, ICON3, {2, 2, 20, 20}, 0x00ff00, "Shape"));
  // Components: a sheet frame, the Button set in it (Default hovers to Hover), Card, unrelated layers.
  nodes.push_back(make(SHEET, NodeType::FRAME, COMPONENTS, "!", {0, 0, 1000, 1000}, "Sheet"));
  NodeChange set = make(SET, NodeType::FRAME, SHEET, "!", {20, 20, 300, 100}, "Button");
  set.props.comp().isStateGroup = true;
  nodes.push_back(set);
  NodeChange def = make(DEF, NodeType::SYMBOL, SET, "!", {20, 20, 100, 40}, "State=Default");
  def.props.extra["prototypeInteractions"] = extra("prototypeInteractions", action(HOV, "ON_HOVER", "SWAP_STATE"));
  nodes.push_back(def);
  nodes.push_back(rect(DEF_BG, DEF, {0, 0, 100, 40}, 0x0d99ff));
  nodes.push_back(instance(DEF_ICON, ICON1, DEF, "\"", {8, 8, 24, 24}, "Icon"));
  nodes.push_back(make(HOV, NodeType::SYMBOL, SET, "\"", {150, 20, 120, 40}, "State=Hover"));
  nodes.push_back(rect(HOV_BG, HOV, {0, 0, 120, 40}, 0x14ae5c));
  nodes.push_back(instance(HOV_ICON, ICON1, HOV, "\"", {8, 8, 24, 24}, "Icon"));
  NodeChange card = make(CARD, NodeType::SYMBOL, SHEET, "\"", {20, 200, 200, 100}, "Card");
  ComponentPropDef swap;
  swap.id = SWAP_PROP;
  swap.name = "Icon";
  swap.type = ComponentPropType::INSTANCE_SWAP;
  swap.initialValue.guidValue = ICON2;
  card.props.comp().componentPropDefs.push_back(swap);
  nodes.push_back(card);
  nodes.push_back(rect(CARD_BG, CARD, {0, 0, 200, 100}, 0xffc700));
  nodes.push_back(make(UNRELATED, NodeType::FRAME, COMPONENTS, "\"", {2000, 0, 400, 400}, "Unrelated"));
  nodes.push_back(rect(UNRELATED_CHILD, UNRELATED, {10, 10, 50, 50}, 0x9747ff, "Unrelated child"));
  nodes.push_back(make(LONE_MAIN, NodeType::SYMBOL, COMPONENTS, "#", {3000, 0, 50, 50}, "Lone"));
  // Page 1
  nodes.push_back(make(SCREEN, NodeType::FRAME, kPage, "!", {0, 0, 375, 812}, "Screen"));
  NodeChange inst = instance(INST, DEF, SCREEN, "!", {100, 100, 100, 40}, "Button");
  inst.props.extra["prototypeInteractions"] = extra("prototypeInteractions", action(SCREEN2, "ON_CLICK", "NAVIGATE"));
  nodes.push_back(inst);
  nodes.push_back(instance(CARD_INST, CARD, SCREEN, "\"", {20, 300, 200, 100}, "Card"));
  nodes.push_back(make(SCREEN2, NodeType::FRAME, kPage, "\"", {500, 0, 375, 812}, "Second"));
  nodes.push_back(instance(CARD_INST2, CARD, SCREEN2, "!", {20, 20, 200, 100}, "Card"));
  // A variable on the internal canvas.
  NodeChange vs = make(VAR_SET, NodeType::VARIABLE_SET, kInternal, "!", {0, 0, 0, 0}, "Collection");
  nodes.push_back(vs);
  nodes.push_back(make(VAR, NodeType::VARIABLE, kInternal, "\"", {0, 0, 0, 0}, "Color"));
  return nodes;
}

// The subtree's layers as they draw: id, type, world box and first fill, derived sublayers included.
std::string drawn(const Document& d, Guid root) {
  std::ostringstream s;
  std::function<void(Guid)> walk = [&](Guid id) {
    const Node* n = d.get(id);
    if (!n) return;
    Mat2x3 m = d.worldTransform(id);
    s << id.toString() << ' ' << static_cast<int>(n->props.type) << ' ' << m.m02 << ',' << m.m12 << ' ' << n->props.size.x << 'x' << n->props.size.y;
    if (!n->props.fillPaints.empty()) s << " #" << n->props.fillPaints[0].color.r << n->props.fillPaints[0].color.g;
    s << (n->props.visible ? "" : " hidden") << '\n';
    for (Guid c : d.children(id)) walk(c);
  };
  walk(root);
  return s.str();
}

struct Engines {
  Editor full;
  Editor part;
  std::vector<NodeChange> subset;
  Engines() {
    auto nodes = file();
    full.setSessionID(1);
    full.loadDocument(std::move(nodes), kPage);
    full.takeEvents();
    subset = full.encodePage(kPage);
    // Through the wire, as the preview gets it.
    codec::KiwiMessage m;
    REQUIRE(codec::readMessage(codec::writeMessage(1, subset), m));
    part.setSessionID(1);
    part.setViewport(375, 812, 1, 375, 812);
    part.setPartial(true);
    part.setLazyScreens(true);
    part.loadDocument(std::move(m.changes), kPage);
    part.takeEvents();
  }
};

}  // namespace

TEST_CASE("proto.page_subset: the page, the internal canvas, and only the components and destinations it reaches") {
  Engines e;
  std::unordered_set<Guid, GuidHash> in;
  for (const NodeChange& c : e.subset) {
    // Parents before children; nothing twice.
    if (c.guid != kDoc) CHECK_MESSAGE(in.count(c.props.parentIndex.guid), c.guid.toString());
    CHECK(in.insert(c.guid).second);
  }
  for (Guid id : {kDoc, kPage, kInternal, COMPONENTS, ICONS, SCREEN, INST, CARD_INST, SCREEN2, VAR_SET, VAR})
    CHECK_MESSAGE(in.count(id), id.toString());
  // The set whole (both variants, for Change to), the sheet as their ancestor; Card; the icons reached transitively
  // (Icon 1 through the variants' nested instances, Icon 2 as Card's swap default).
  for (Guid id : {SHEET, SET, DEF, HOV, DEF_BG, HOV_BG, DEF_ICON, HOV_ICON, CARD, CARD_BG, ICON1, ICON1_SHAPE, ICON2}) CHECK_MESSAGE(in.count(id), id.toString());
  // Nothing else from the other pages.
  for (Guid id : {UNRELATED, UNRELATED_CHILD, LONE_MAIN, ICON3, ICON3_SHAPE}) CHECK_MESSAGE(!in.count(id), id.toString());
  // The sheet is there for its children only: its own fields, not its other children.
  CHECK(e.part.document().children(SHEET).size() == 2);
  CHECK(e.part.document().children(COMPONENTS).size() == 1);
  // A page that doesn't exist: the whole document.
  CHECK(e.full.encodePage(Guid{9, 9}).size() == e.full.encodeDocument().size());
}

TEST_CASE("proto.page_subset: instances of components on other pages draw the same as in the whole document") {
  Engines e;
  e.full.derivePage(kPage);
  // The partial engine derived nothing of the page at its load: its screens are derived as they are shown.
  CHECK(e.part.document().children(INST).empty());
  CHECK(e.part.document().children(CARD_INST2).empty());
  e.part.deriveTree(SCREEN);
  CHECK(!e.part.document().children(INST).empty());
  CHECK(e.part.document().children(CARD_INST2).empty());
  std::string a = drawn(e.full.document(), SCREEN), b = drawn(e.part.document(), SCREEN);
  CHECK(a == b);
  // The nested icon instance drew its shape (red), from the Icons page.
  CHECK(b.find(" #10") != std::string::npos);
  CHECK(e.part.mainOf(INST) == DEF);
}

TEST_CASE("proto.page_subset: screens are derived as they are shown, the rest between frames") {
  Engines e;
  proto::Player player{e.part};
  REQUIRE(player.start(kPage, SCREEN));
  CHECK(!e.part.document().children(INST).empty());
  CHECK(e.part.document().children(CARD_INST2).empty());
  // An edit of Card (its main) while the second screen isn't shown: that screen's instance still waits.
  NodeChange resize;
  resize.guid = CARD_BG;
  resize.phase = Phase::CHANGED;
  resize.mask = F_FILLS;
  resize.props.fillPaints = {Paint::solid(Color::hex(0x123456))};
  CHECK(e.part.applyChanges({resize}, APPLY_REMOTE) == OK);
  CHECK(e.part.document().children(CARD_INST2).empty());
  // Going there derives it (with the edit).
  player.pointer(PointerEvent::DOWN, 120, 110, 1, 0);
  player.pointer(PointerEvent::UP, 120, 110, 0, 0);
  REQUIRE(player.screen() == SCREEN2);
  REQUIRE(!e.part.document().children(CARD_INST2).empty());
  CHECK(drawn(e.part.document(), SCREEN2).find("0.0705882") != std::string::npos);
  // Between frames: nothing left on the page.
  CHECK(!e.part.deriveNextTrees(kPage, 0));
}

TEST_CASE("proto.page_subset: deriveNextTrees derives a screen at least per call") {
  Engines e;
  proto::Player player{e.part};
  REQUIRE(player.start(kPage, SCREEN));
  CHECK(e.part.document().children(CARD_INST2).empty());
  CHECK(!e.part.deriveNextTrees(kPage, 0));
  CHECK(!e.part.document().children(CARD_INST2).empty());
  // A whole engine: a no-op.
  CHECK(!e.full.deriveNextTrees(kPage, 0));
}

TEST_CASE("proto.page_subset: Change to between variants on another page plays in the subset") {
  Engines e;
  proto::Player player{e.part};
  REQUIRE(player.start(kPage, SCREEN));
  player.pointer(PointerEvent::MOVE, 120, 110, 0, 0);
  CHECK(e.part.mainOf(INST) == HOV);
  player.pointer(PointerEvent::MOVE, 10, 500, 0, 0);
  CHECK(e.part.mainOf(INST) == DEF);
  // Its click navigates to the second screen.
  player.pointer(PointerEvent::DOWN, 120, 110, 1, 0);
  player.pointer(PointerEvent::UP, 120, 110, 0, 0);
  CHECK(player.screen() == SCREEN2);
}

TEST_CASE("proto.page_subset: a partial engine keeps out what happens elsewhere and names what it lacks") {
  Engines e;
  auto apply = [&](const NodeChange& c) { CHECK(e.part.applyChanges({c}, APPLY_REMOTE) == OK); };
  // A layer added on another page, under a frame the subset doesn't have: skipped.
  apply(rect(Guid{5, 1}, UNRELATED, {0, 0, 10, 10}, 0x000000, "Elsewhere"));
  CHECK(!e.part.document().has(Guid{5, 1}));
  // At the top of another page (an instance of a component it doesn't have, too): skipped, nothing lacking.
  apply(instance(Guid{5, 3}, ICON3, COMPONENTS, "~", {0, 0, 24, 24}, "Icon 3"));
  CHECK(!e.part.document().has(Guid{5, 3}));
  CHECK(e.part.takeLacking().empty());
  // An edit of a layer it doesn't have: nothing, and nothing lacking.
  NodeChange rename;
  rename.guid = UNRELATED_CHILD;
  rename.phase = Phase::CHANGED;
  rename.mask = F_NAME;
  rename.props.name = "Renamed";
  apply(rename);
  CHECK(e.part.takeLacking().empty());
  // An edit of a component it has (the Default variant's background): applied.
  NodeChange recolor;
  recolor.guid = DEF_BG;
  recolor.phase = Phase::CHANGED;
  recolor.mask = F_FILLS;
  recolor.props.fillPaints = {Paint::solid(Color::hex(0x000000))};
  apply(recolor);
  CHECK(e.part.document().get(DEF_BG)->props.fillPaints[0].color.r == 0);
  // A layer moved onto the screen from elsewhere: lacking.
  NodeChange move;
  move.guid = UNRELATED_CHILD;
  move.phase = Phase::CHANGED;
  move.mask = F_PARENT_INDEX;
  move.props.parentIndex = {SCREEN, "~"};
  apply(move);
  // An instance now showing a component the subset doesn't have: lacking.
  NodeChange swapTo;
  swapTo.guid = CARD_INST;
  swapTo.phase = Phase::CHANGED;
  swapTo.mask = F_SYMBOL_DATA;
  swapTo.props.comp().symbolData.symbolID = LONE_MAIN;
  apply(swapTo);
  // A new instance of Icon 3 on the screen: lacking.
  apply(instance(Guid{5, 2}, ICON3, SCREEN, "|", {0, 0, 24, 24}, "Icon 3"));
  std::vector<Guid> lacking = e.part.takeLacking();
  CHECK(lacking == std::vector<Guid>{UNRELATED_CHILD, LONE_MAIN, ICON3});
  CHECK(e.part.takeLacking().empty());
  // A subset of the same change applied to the whole document has them all: a new subset is complete again.
  for (const NodeChange& c : {move, swapTo}) CHECK(e.full.applyChanges({c}, APPLY_REMOTE) == OK);
  CHECK(e.full.applyChanges({instance(Guid{5, 2}, ICON3, SCREEN, "|", {0, 0, 24, 24}, "Icon 3")}, APPLY_REMOTE) == OK);
  std::unordered_set<Guid, GuidHash> again;
  for (const NodeChange& c : e.full.encodePage(kPage)) again.insert(c.guid);
  for (Guid id : {UNRELATED_CHILD, LONE_MAIN, ICON3, ICON3_SHAPE}) CHECK_MESSAGE(again.count(id), id.toString());
  CHECK(!again.count(UNRELATED));
}

TEST_CASE("proto.page_subset: a whole document presented (its own tab) derives its screens as shown too") {
  Editor ed;
  ed.setSessionID(1);
  ed.setViewport(375, 812, 1, 375, 812);
  ed.setLazyScreens(true);
  ed.loadDocument(file(), kPage);
  ed.takeEvents();
  CHECK(ed.document().children(INST).empty());
  proto::Player player{ed};
  REQUIRE(player.start(kPage, SCREEN));
  CHECK(!ed.document().children(INST).empty());
  CHECK(ed.document().children(CARD_INST2).empty());
  // Everything else on it, between frames; nothing kept out (not a subset): a layer added on another page arrives.
  CHECK(!ed.deriveNextTrees(kPage, 1000));
  CHECK(!ed.document().children(CARD_INST2).empty());
  CHECK(ed.applyChanges({rect(Guid{5, 4}, COMPONENTS, {0, 0, 10, 10}, 0, "Top")}, APPLY_REMOTE) == OK);
  CHECK(ed.document().has(Guid{5, 4}));
}
