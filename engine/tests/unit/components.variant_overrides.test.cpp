// Overrides kept through a variant switch (the owner's rule, 2026-10-21; docs/engine.md §3.3 "Variant switch keeps the
// instance's changes"), and a layer's interactions inside an instance merged with what it inherits (§3.4).
// A "Finder" set: Tour / Hotel, auto layout with gap 12 (Hotel's fill blue, Tour's red), a "Label" text and a "Box"
// rectangle 40 × 20 (Hotel's 40 × 30).
#include <functional>

#include "doctest.h"
#include "Helpers.h"
#include "base/DerivedIds.h"
#include "editor/Editor.h"
#include "proto/Prototype.h"
#include "scene/CodecKiwi.h"

using namespace eng;
using namespace eng::test;

namespace {

const Guid SET{20, 1}, TOUR{20, 2}, HOTEL{20, 3}, TL{20, 4}, TB{20, 5}, HL{20, 6}, HB{20, 7}, INST{20, 10}, HOME{20, 20}, NESTED{20, 21},
    HI{20, 22}, STATE{20, 99};

NodeChange variant(Guid id, double x, const char* name, uint32_t fill) {
  NodeChange v = make(id, NodeType::SYMBOL, SET, x == 0 ? "!" : "\"", {x, 0, 200, 40}, name);
  v.props.stack().stackMode = StackMode::HORIZONTAL;
  v.props.stack().stackSpacing = 12;
  v.props.fillPaints = {Paint::solid(Color::hex(fill))};
  v.props.comp().variantPropSpecs = {{STATE, std::string(name).substr(6)}};
  return v;
}

NodeChange text(Guid id, Guid parent, const std::string& pos, const std::string& chars) {
  NodeChange c = make(id, NodeType::TEXT, parent, pos, {0, 0, 60, 20}, "Label");
  c.props.text().textData.characters = chars;
  c.props.text().textAutoResize = TextAutoResize::NONE;
  return c;
}

std::vector<NodeChange> finderDoc() {
  auto nodes = baseChanges();
  NodeChange set = make(SET, NodeType::FRAME, kPage, "~", {0, 500, 500, 100}, "Finder");
  set.props.comp().isStateGroup = true;
  ComponentPropDef def;
  def.id = STATE;
  def.name = "State";
  def.type = ComponentPropType::VARIANT;
  set.props.comp().componentPropDefs = {def};
  nodes.push_back(set);
  nodes.push_back(variant(TOUR, 0, "State=Tour", 0xFF0000));
  nodes.push_back(text(TL, TOUR, "!", "Tour"));
  nodes.push_back(make(TB, NodeType::RECTANGLE, TOUR, "\"", {0, 0, 40, 20}, "Box"));
  nodes.push_back(variant(HOTEL, 250, "State=Hotel", 0x0000FF));
  nodes.push_back(text(HL, HOTEL, "!", "Hotel"));
  nodes.push_back(make(HB, NodeType::RECTANGLE, HOTEL, "\"", {0, 0, 40, 30}, "Box"));
  NodeChange i = make(INST, NodeType::INSTANCE, kPage, "z", {0, 0, 200, 40}, "Finder");
  i.props.comp().symbolData.symbolID = TOUR;
  i.props.fillPaints.clear();
  nodes.push_back(i);
  return nodes;
}

Editor load(const std::vector<NodeChange>& nodes) {
  Editor e;
  e.setSessionID(1);
  e.setViewport(800, 600, 1, 800, 600);
  e.loadDocument(nodes, kNoGuid);
  e.takeEvents();
  return e;
}

const NodeProps& props(const Editor& e, Guid id) { return e.document().get(id)->props; }

NodeChange change(FieldMask mask, const std::function<void(NodeProps&)>& f) {
  NodeChange c = NodeChange::changed(Guid{0, 0});
  c.mask = mask;
  f(c.props);
  return c;
}

CommandArgs args(const std::string& text) {
  CommandArgs a;
  json::parse(text, a.raw);
  return a;
}

// The panel's variant property (Figma's "State" dropdown) — a nested instance's too.
void toVariant(Editor& e, Guid ref, Guid to) {
  const char* value = to == HOTEL ? "Hotel" : "Tour";
  e.setSelection({ref});
  REQUIRE(e.command(CommandId::SET_COMPONENT_PROPERTY, args(std::string("{\"prop\":\"State\",\"value\":\"") + value + "\"}")) == OK);
}

std::string ix(const std::string& text) {
  json::Value v;
  REQUIRE(json::parse(text, v));
  return codec::extraFromJson("NodeChange", "prototypeInteractions", v);
}

}  // namespace

TEST_CASE("components.variant_overrides: a gap set on an instance stays in every variant; the mains keep theirs") {
  Editor e = load(finderDoc());
  e.setProps({INST}, change(F_STACK_SPACING, [](NodeProps& p) { p.stack().stackSpacing = 8; }), 0);
  CHECK(props(e, INST).stack().stackSpacing == 8);
  toVariant(e, INST, HOTEL);
  CHECK(e.mainOf(INST) == HOTEL);
  CHECK(props(e, INST).stack().stackSpacing == 8);
  toVariant(e, INST, TOUR);
  CHECK(props(e, INST).stack().stackSpacing == 8);
  CHECK(props(e, TOUR).stack().stackSpacing == 12);
  CHECK(props(e, HOTEL).stack().stackSpacing == 12);
  // Stored as Figma stores it: one root entry with the gap.
  const auto& o = props(e, INST).comp().symbolData.overrides;
  REQUIRE(o.size() == 1);
  CHECK(o[0].path.empty());
  CHECK((o[0].mask & F_STACK_SPACING));
}

TEST_CASE("components.variant_overrides: text and fill overrides travel; a property the variants differ in keeps the instance's") {
  Editor e = load(finderDoc());
  e.setProps({derived::intern(INST, {TL})}, change(F_TEXT_DATA, [](NodeProps& p) { p.text().textData.characters = "Trips"; }), 0);
  // The root's fill: Tour red, Hotel blue — the variants differ; the instance's green stays (Figma would drop it).
  e.setProps({INST}, change(F_FILLS, [](NodeProps& p) { p.fillPaints = {Paint::solid(Color::hex(0x00FF00))}; }), 0);
  toVariant(e, INST, HOTEL);
  CHECK(props(e, derived::intern(INST, {HL})).text().textData.characters == "Trips");
  CHECK(props(e, INST).fillPaints[0].color == Color::hex(0x00FF00));
  toVariant(e, INST, TOUR);
  CHECK(props(e, derived::intern(INST, {TL})).text().textData.characters == "Trips");
  CHECK(props(e, INST).fillPaints[0].color == Color::hex(0x00FF00));
  CHECK(props(e, TOUR).fillPaints[0].color == Color::hex(0xFF0000));
}

TEST_CASE("components.variant_overrides: an entry at the old variant's own value is no change — the new variant's design shows") {
  Editor e = load(finderDoc());
  // A Box stretched to 90 wide (its height Tour's own 20): the width stays, the height follows Hotel's 30.
  e.setProps({derived::intern(INST, {TB})}, change(F_SIZE, [](NodeProps& p) { p.size = {90, 20}; }), 0);
  // A root fill entry that holds Tour's own red (written by an older file, say): Hotel's blue shows.
  e.setProps({INST}, change(F_FILLS, [](NodeProps& p) { p.fillPaints = {Paint::solid(Color::hex(0x123456))}; }), 0);
  e.setProps({INST}, change(F_FILLS, [](NodeProps& p) { p.fillPaints = {Paint::solid(Color::hex(0xFF0000))}; }), 0);
  toVariant(e, INST, HOTEL);
  const NodeProps& box = props(e, derived::intern(INST, {HB}));
  CHECK(box.size.x == doctest::Approx(90));
  CHECK(box.size.y == doctest::Approx(30));
  CHECK(props(e, INST).fillPaints[0].color == Color::hex(0x0000FF));
}

TEST_CASE("components.variant_overrides: a nested instance's own overrides (its main's) carry when it switches variant") {
  // "Home" holds a Finder (Tour) whose gap its main set to 8 — homesearch's finder-segmented: a variant switch of the
  // nested one (the panel, or a Change to) kept 8 only in Tour.
  auto nodes = finderDoc();
  nodes.push_back(make(HOME, NodeType::SYMBOL, kPage, "#", {0, 200, 300, 100}, "Home"));
  NodeChange n = make(NESTED, NodeType::INSTANCE, HOME, "!", {0, 0, 200, 40}, "Finder");
  n.props.comp().symbolData.symbolID = TOUR;
  SymbolOverride gap;
  gap.mask = F_STACK_SPACING;
  gap.props.stack().stackSpacing = 8;
  n.props.comp().symbolData.overrides.push_back(gap);
  nodes.push_back(n);
  NodeChange hi = make(HI, NodeType::INSTANCE, kPage, "$", {0, 400, 300, 100}, "Home");
  hi.props.comp().symbolData.symbolID = HOME;
  nodes.push_back(hi);
  Editor e = load(nodes);
  Guid finder = derived::intern(HI, {NESTED});
  REQUIRE(e.document().has(finder));
  CHECK(props(e, finder).stack().stackSpacing == 8);
  toVariant(e, finder, HOTEL);
  CHECK(e.mainOf(finder) == HOTEL);
  CHECK(props(e, finder).stack().stackSpacing == 8);
  toVariant(e, finder, TOUR);
  CHECK(props(e, finder).stack().stackSpacing == 8);
  CHECK(props(e, NESTED).comp().symbolData.overrides.size() == 1);  // the main's own data untouched
}

TEST_CASE("components.variant_overrides: a layer's interactions in an instance merge with its main's; a removed one stays removed") {
  // The owner's search-input in homesearch: "Location" has While hovering → Variant22 on the main; the instance added
  // On click → an overlay. Its override list holds only the click (Figma's form) — the hover played no more.
  const char* hover = R"([{"id":{"sessionID":30,"localID":1},"event":{"interactionType":"ON_HOVER"},"actions":[{"connectionType":"INTERNAL_NODE","navigationType":"SWAP_STATE","transitionNodeID":{"sessionID":20,"localID":3}}]}])";
  const char* click = R"([{"id":{"sessionID":30,"localID":2},"event":{"interactionType":"ON_CLICK"},"actions":[{"connectionType":"INTERNAL_NODE","navigationType":"OVERLAY","transitionNodeID":{"sessionID":20,"localID":1}}]}])";
  auto nodes = finderDoc();
  for (auto& c : nodes)
    if (c.guid == TB) c.props.extra["prototypeInteractions"] = ix(hover);
  nodes.push_back(make(HOME, NodeType::SYMBOL, kPage, "#", {0, 200, 300, 100}, "Home"));
  NodeChange n = make(NESTED, NodeType::INSTANCE, HOME, "!", {0, 0, 200, 40}, "Finder");
  n.props.comp().symbolData.symbolID = TOUR;
  SymbolOverride o;
  o.path = {TB};
  o.mask = F_EXTRA;
  o.props.extra["prototypeInteractions"] = ix(click);
  n.props.comp().symbolData.overrides.push_back(o);
  nodes.push_back(n);
  NodeChange hi = make(HI, NodeType::INSTANCE, kPage, "$", {0, 400, 300, 100}, "Home");
  hi.props.comp().symbolData.symbolID = HOME;
  nodes.push_back(hi);
  Editor e = load(nodes);
  Guid box = derived::intern(HI, {NESTED, TB});
  REQUIRE(e.document().has(box));
  auto list = proto::interactions(props(e, box));
  REQUIRE(list.size() == 2);
  CHECK(list[0].trigger == proto::Trigger::ON_HOVER);  // the component's own first
  CHECK(list[1].trigger == proto::Trigger::ON_CLICK);
  // Removed on the instance (the panel writes the list without it): kept out as an isDeleted copy, not inherited again.
  const std::string only = ix(click);
  REQUIRE(e.setProps({box}, change(F_EXTRA, [&](NodeProps& p) { p.extra["prototypeInteractions"] = only; }), 0) == OK);
  list = proto::interactions(props(e, box));
  REQUIRE(list.size() == 1);
  CHECK(list[0].trigger == proto::Trigger::ON_CLICK);
  bool deletedCopy = false;
  for (const SymbolOverride& s : props(e, HI).comp().symbolData.overrides)
    if (auto it = s.props.extra.find("prototypeInteractions"); it != s.props.extra.end())
      deletedCopy |= codec::extraValueToJson("NodeChange", it->second).find("\"isDeleted\":true") != std::string::npos;
  CHECK(deletedCopy);
}

TEST_CASE("components.variant_overrides: a nested instance that is another component in the new variant keeps its property values by name") {
  // The owner's Page row: Default holds a Button "Field" (Label "Inputs" on the row), Editing a Text input "Field" — the
  // input showed its own "Buttons". Figma keeps a property's value across a swap where the new component has one of the
  // same name and type.
  const Guid BTN{21, 1}, BL{21, 2}, INP{21, 3}, IL{21, 4}, RSET{21, 5}, R1{21, 6}, R2{21, 7}, F1{21, 8}, F2{21, 9}, RI{21, 10}, RS{21, 11};
  auto nodes = baseChanges();
  auto comp = [&](Guid id, Guid def, double y, const char* name) {
    NodeChange c = make(id, NodeType::SYMBOL, kPage, y == 0 ? "a" : "b", {600, y, 100, 24}, name);
    ComponentPropDef d;
    d.id = def;
    d.name = "Label";
    d.type = ComponentPropType::TEXT;
    d.initialValue.hasText = true;
    d.initialValue.textValue.characters = name;
    c.props.comp().componentPropDefs = {d};
    nodes.push_back(c);
  };
  comp(BTN, BL, 0, "Button");
  comp(INP, IL, 100, "Input");
  NodeChange set = make(RSET, NodeType::FRAME, kPage, "c", {0, 800, 500, 100}, "Page row");
  set.props.comp().isStateGroup = true;
  ComponentPropDef st;
  st.id = RS;
  st.name = "State";
  st.type = ComponentPropType::VARIANT;
  set.props.comp().componentPropDefs = {st};
  nodes.push_back(set);
  for (auto [r, f, main, name, x] : {std::tuple{R1, F1, BTN, "State=Default", 0.0}, std::tuple{R2, F2, INP, "State=Editing", 250.0}}) {
    NodeChange v = make(r, NodeType::SYMBOL, RSET, x == 0 ? "!" : "\"", {x, 0, 200, 32}, name);
    v.props.comp().variantPropSpecs = {{RS, std::string(name).substr(6)}};
    nodes.push_back(v);
    NodeChange fi = make(f, NodeType::INSTANCE, r, "!", {0, 0, 100, 24}, "Field");
    fi.props.comp().symbolData.symbolID = main;
    nodes.push_back(fi);
  }
  NodeChange ri = make(RI, NodeType::INSTANCE, kPage, "d", {0, 0, 200, 32}, "Page row");
  ri.props.comp().symbolData.symbolID = R1;
  SymbolOverride o;
  o.path = {F1};
  o.mask = F_COMPONENT_PROP_ASSIGNMENTS;
  ComponentPropAssignment a;
  a.defID = BL;
  a.value.hasText = true;
  a.value.textValue.characters = "Inputs";
  o.props.comp().componentPropAssignments = {a};
  ri.props.comp().symbolData.overrides = {o};
  nodes.push_back(ri);
  Editor e = load(nodes);
  e.setSelection({RI});
  REQUIRE(e.command(CommandId::SWAP_INSTANCE, args("{\"main\":\"21:7\"}")) == OK);
  bool carried = false;
  for (const SymbolOverride& s : props(e, RI).comp().symbolData.overrides)
    for (const ComponentPropAssignment& x : s.props.comp().componentPropAssignments)
      carried |= x.defID == IL && x.value.textValue.characters == "Inputs";
  CHECK(carried);
  // Back to the button: the input's Label value goes to the button's Label.
  e.setSelection({RI});
  REQUIRE(e.command(CommandId::SWAP_INSTANCE, args("{\"main\":\"21:6\"}")) == OK);
  carried = false;
  for (const SymbolOverride& s : props(e, RI).comp().symbolData.overrides)
    for (const ComponentPropAssignment& x : s.props.comp().componentPropAssignments)
      carried |= x.defID == BL && x.value.textValue.characters == "Inputs";
  CHECK(carried);
}
