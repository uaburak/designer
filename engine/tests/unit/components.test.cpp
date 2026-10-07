// Components and instances (E6, docs/schema.md §5, docs/engine-build.md "E6"):
// materialization into derived rows, overrides, nested instances, component
// properties, variants, the component commands, copy / paste / duplicate rules,
// soft delete and restore, and Figma's own instances (structure.fig) against
// their derivedSymbolData.
#include <cmath>
#include <functional>
#include <fstream>
#include <sstream>

#include "doctest.h"
#include "Helpers.h"
#include "base/DerivedIds.h"
#include "editor/Editor.h"
#include "gfx/null/NullDevice.h"
#include "hit/HitTest.h"
#include "render/Renderer.h"
#include "hit/Picking.h"
#include "scene/CodecJson.h"

using namespace eng;
using namespace eng::test;

namespace {

// A main "Button" (1:1) with a background (1:2) and a label (1:3), and its instance (1:10) on the page.
const Guid M{1, 1}, BG{1, 2}, LABEL{1, 3}, I{1, 10};

NodeChange textNode(Guid id, Guid parent, const std::string& position, Rect r, const std::string& chars) {
  NodeChange c = make(id, NodeType::TEXT, parent, position, r, chars);
  c.props.textData.characters = chars;
  c.props.textAutoResize = TextAutoResize::NONE;
  return c;
}

NodeChange instanceOf(Guid id, Guid main, Guid parent, const std::string& position, Rect r) {
  NodeChange c = make(id, NodeType::INSTANCE, parent, position, r, "Button");
  c.props.symbolData.symbolID = main;
  c.props.fillPaints.clear();
  return c;
}

std::vector<NodeChange> buttonDoc() {
  auto nodes = baseChanges();
  NodeChange m = make(M, NodeType::SYMBOL, kPage, "!", {0, 0, 100, 40}, "Button");
  m.props.fillPaints.clear();
  nodes.push_back(m);
  NodeChange bg = make(BG, NodeType::ROUNDED_RECTANGLE, M, "!", {0, 0, 100, 40}, "Background");
  bg.props.horizontalConstraint = ConstraintType::STRETCH;
  bg.props.verticalConstraint = ConstraintType::STRETCH;
  nodes.push_back(bg);
  nodes.push_back(textNode(LABEL, M, "\"", {10, 10, 80, 20}, "Label"));
  nodes.push_back(instanceOf(I, M, kPage, "\"", {0, 100, 100, 40}));
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

Guid sub(Guid instance, std::vector<Guid> keys) { return derived::intern(instance, keys); }
const NodeProps& props(const Editor& e, Guid id) { return e.document().get(id)->props; }

NodeChange change(FieldMask mask, const std::function<void(NodeProps&)>& f) {
  NodeChange c = NodeChange::changed(Guid{0, 0});
  c.mask = mask;
  f(c.props);
  return c;
}

CommandArgs args(const std::string& jsonText) {
  CommandArgs a;
  json::parse(jsonText, a.raw);
  return a;
}

bool hasOverride(const Editor& e, Guid instance, const std::vector<Guid>& path, FieldMask bit) {
  for (const SymbolOverride& o : props(e, instance).symbolData.overrides)
    if (o.path == path && (o.mask & bit)) return true;
  return false;
}

}  // namespace

TEST_CASE("components: derived ids print and parse as Figma's I…;… strings") {
  Guid d = derived::intern({1, 38}, {{1, 42}});
  CHECK(d.isDerived());
  CHECK(d.toString() == "I1:38;1:42");
  bool ok = false;
  CHECK(Guid::parse("I1:38;1:42", &ok) == d);
  CHECK(ok);
  CHECK(derived::child({1, 38}, {1, 42}) == d);
  Guid deeper = derived::child(d, {2, 7});
  CHECK(deeper.toString() == "I1:38;1:42;2:7");
  CHECK(derived::instanceOf(deeper) == Guid{1, 38});
  Guid::parse("I1:38", &ok);
  CHECK(!ok);
}

TEST_CASE("components: an instance materializes its main as derived rows, never stored") {
  Editor e = load(buttonDoc());
  const Document& doc = e.document();
  Guid bg = sub(I, {BG}), label = sub(I, {LABEL});
  REQUIRE(doc.children(I) == std::vector<Guid>{bg, label});
  CHECK(props(e, bg).type == NodeType::ROUNDED_RECTANGLE);
  CHECK(props(e, label).textData.characters == "Label");
  CHECK(doc.worldBounds(label) == Rect{10, 110, 80, 20});
  // Never stored.
  for (const NodeChange& c : e.encodeDocument()) CHECK(!c.guid.isDerived());
  CHECK(props(e, I).name == "Button");
}

TEST_CASE("components: editing the main updates every instance; overrides survive main edits") {
  Editor e = load(buttonDoc());
  Guid bg = sub(I, {BG});
  // An override on the instance's background fill.
  REQUIRE(e.setProps({bg}, change(F_FILLS, [](NodeProps& p) { p.fillPaints = {Paint::solid(Color::hex(0xFF0000))}; }), 0) == OK);
  CHECK(hasOverride(e, I, {BG}, F_FILLS));
  CHECK(props(e, bg).fillPaints[0].color == Color::hex(0xFF0000));
  auto ev = e.takeEvents();
  REQUIRE(ev.documents.size() == 1);
  for (auto& c : ev.documents[0].changes) CHECK(!c.guid.isDerived());
  // The main's background: a new fill and a corner radius. The fill stays overridden; the radius arrives.
  e.setProps({BG}, change(F_FILLS | F_CORNER_RADII, [](NodeProps& p) {
    p.fillPaints = {Paint::solid(Color::hex(0x00FF00))};
    p.cornerRadii = {8, 8, 8, 8};
  }), 0);
  CHECK(props(e, bg).fillPaints[0].color == Color::hex(0xFF0000));
  CHECK(props(e, bg).cornerRadii[0] == 8);
  // A new layer in the main appears in the instance.
  e.applyChanges({make({1, 4}, NodeType::ELLIPSE, M, "#", {0, 0, 10, 10}, "Dot")}, APPLY_USER);
  CHECK(e.document().has(sub(I, {{1, 4}})));
  // Undo takes it away again, and the fill override can be undone too.
  e.command(CommandId::UNDO);
  CHECK(!e.document().has(sub(I, {{1, 4}})));
  e.command(CommandId::UNDO);
  e.command(CommandId::UNDO);
  CHECK(!hasOverride(e, I, {BG}, F_FILLS));
  CHECK(props(e, bg).fillPaints[0].color == Color::hex(0xD9D9D9));
}

TEST_CASE("components: structure is refused inside instances; position isn't overridable; ⌫ hides") {
  Editor e = load(buttonDoc());
  Guid label = sub(I, {LABEL});
  Rect before = e.document().worldBounds(label);
  e.setProps({label}, change(F_TRANSFORM, [](NodeProps& p) { p.transform = Mat2x3::translate(50, 50); }), 0);
  CHECK(e.document().worldBounds(label) == before);
  CHECK(props(e, I).symbolData.overrides.empty());
  // A layer can't be created inside an instance.
  e.applyChanges({make({1, 20}, NodeType::ELLIPSE, I, "z", {0, 0, 5, 5})}, APPLY_USER);
  CHECK(!e.document().has({1, 20}));
  // Delete hides it.
  e.setSelection({label});
  e.command(CommandId::DELETE);
  CHECK(e.document().has(label));
  CHECK(!props(e, label).visible);
  CHECK(hasOverride(e, I, {LABEL}, F_VISIBLE));
  // Group / duplicate are refused there.
  e.setSelection({label});
  CHECK(e.command(CommandId::GROUP) == E_INVALID);
  CHECK(e.commandState(CommandId::DUPLICATE) == 0);
}

TEST_CASE("components: resizing an instance applies its children's constraints from the main") {
  Editor e = load(buttonDoc());
  e.setProps({I}, change(F_SIZE, [](NodeProps& p) { p.size = {200, 60}; }), 0);
  CHECK(hasOverride(e, I, {}, F_SIZE));
  Guid bg = sub(I, {BG}), label = sub(I, {LABEL});
  CHECK(props(e, bg).size == Vec2{200, 60});  // STRETCH both ways
  CHECK(props(e, label).transform.m02 == 10);  // MIN (left / top)
  // Again from the main's sizes, never drifting.
  e.setProps({I}, change(F_SIZE, [](NodeProps& p) { p.size = {150, 40}; }), 0);
  CHECK(props(e, bg).size == Vec2{150, 40});
  // A main edit keeps the instance's size (its override).
  e.setProps({M}, change(F_OPACITY, [](NodeProps& p) { p.opacity = 0.5; }), 0);
  CHECK(props(e, I).size == Vec2{150, 40});
  CHECK(props(e, I).opacity == doctest::Approx(0.5));
}

TEST_CASE("components: nested instances, usage-site overrides over the nested instance's own") {
  // Icon (2:1) with a shape (2:2); Button (1:1) holds an instance of Icon (1:5) that overrides its fill blue.
  auto nodes = buttonDoc();
  const Guid ICON{2, 1}, SHAPE{2, 2}, NESTED{1, 5};
  nodes.push_back(make(ICON, NodeType::SYMBOL, kPage, "#", {300, 0, 16, 16}, "Icon"));
  nodes.push_back(make(SHAPE, NodeType::ELLIPSE, ICON, "!", {0, 0, 16, 16}, "Shape"));
  NodeChange nested = instanceOf(NESTED, ICON, M, "#", {80, 12, 16, 16});
  SymbolOverride own;
  own.path = {SHAPE};
  own.mask = F_FILLS;
  own.props.fillPaints = {Paint::solid(Color::hex(0x0000FF))};
  nested.props.symbolData.overrides.push_back(own);
  nodes.push_back(nested);
  Editor e = load(nodes);
  Guid row = sub(I, {NESTED}), shape = sub(I, {NESTED, SHAPE});
  REQUIRE(e.document().has(row));
  CHECK(props(e, row).type == NodeType::INSTANCE);
  CHECK(props(e, shape).fillPaints[0].color == Color::hex(0x0000FF));  // the nested instance's own override
  // The main's nested instance itself shows the same.
  CHECK(props(e, sub(NESTED, {SHAPE})).fillPaints[0].color == Color::hex(0x0000FF));
  // The usage site wins.
  e.setProps({shape}, change(F_FILLS, [](NodeProps& p) { p.fillPaints = {Paint::solid(Color::hex(0x00FF00))}; }), 0);
  CHECK(hasOverride(e, I, {NESTED, SHAPE}, F_FILLS));
  CHECK(props(e, shape).fillPaints[0].color == Color::hex(0x00FF00));
  // Editing the Icon main reaches both levels.
  e.setProps({SHAPE}, change(F_OPACITY, [](NodeProps& p) { p.opacity = 0.25; }), 0);
  CHECK(props(e, shape).opacity == doctest::Approx(0.25));
  // Swapping the nested instance (an override at its path).
  const Guid OTHER{3, 1}, OTHER_SHAPE{3, 2};
  e.applyChanges({make(OTHER, NodeType::SYMBOL, kPage, "$", {400, 0, 16, 16}, "Other"),
                  make(OTHER_SHAPE, NodeType::ROUNDED_RECTANGLE, OTHER, "!", {0, 0, 16, 16}, "Square")},
                 APPLY_USER);
  e.setSelection({row});
  REQUIRE(e.command(CommandId::SWAP_INSTANCE, args("{\"main\":\"3:1\"}")) == OK);
  CHECK(e.document().has(sub(I, {NESTED, OTHER_SHAPE})));
  CHECK(!e.document().has(shape));
  ComponentInfo info;
  REQUIRE(e.componentInfo(row, info));
  CHECK(info.kind == ComponentInfo::Kind::NESTED_INSTANCE);
  CHECK(info.main == OTHER);
}

TEST_CASE("components: boolean and text properties; editing a bound field writes the property value") {
  auto nodes = buttonDoc();
  const Guid SHOW{1, 0x7fffffff}, TXT{1, 0x7ffffffe};
  NodeChange& m = nodes[3];
  REQUIRE(m.guid == M);
  ComponentPropDef b;
  b.id = SHOW;
  b.name = "Show label";
  b.type = ComponentPropType::BOOL;
  b.initialValue.hasBool = true;
  b.initialValue.boolValue = true;
  ComponentPropDef t;
  t.id = TXT;
  t.name = "Label";
  t.type = ComponentPropType::TEXT;
  t.initialValue.hasText = true;
  t.initialValue.textValue.characters = "Label";
  m.props.componentPropDefs = {b, t};
  NodeChange& label = nodes[5];
  REQUIRE(label.guid == LABEL);
  ParamBinding vis;
  vis.field = VariableField::VISIBLE;
  vis.propRef = SHOW;
  ParamBinding chars;
  chars.field = VariableField::TEXT_DATA;
  chars.propRef = TXT;
  label.props.parameterConsumptionMap = {vis, chars};
  Editor e = load(nodes);
  Guid row = sub(I, {LABEL});
  CHECK(props(e, row).visible);
  e.setSelection({I});
  REQUIRE(e.command(CommandId::SET_COMPONENT_PROPERTY, args("{\"prop\":\"Show label\",\"value\":false}")) == OK);
  CHECK(!props(e, row).visible);
  REQUIRE(props(e, I).componentPropAssignments.size() == 1);
  REQUIRE(e.command(CommandId::SET_COMPONENT_PROPERTY, args("{\"prop\":\"Label#1:2147483646\",\"value\":\"Buy\"}")) == OK);
  CHECK(props(e, row).textData.characters == "Buy");
  // Editing the bound text in the instance changes the property value, not an override.
  e.setProps({row}, change(F_TEXT_DATA, [](NodeProps& p) { p.textData.characters = "Sell"; }), 0);
  CHECK(!hasOverride(e, I, {LABEL}, F_TEXT_DATA));
  CHECK(props(e, row).textData.characters == "Sell");
  ComponentInfo info;
  REQUIRE(e.componentInfo(I, info));
  REQUIRE(info.properties.size() == 2);
  CHECK(info.properties[1].value.textValue.characters == "Sell");
  CHECK(info.properties[1].overridden);
  CHECK(info.properties[0].boundLayers == std::vector<Guid>{row});
  // A new default reaches instances that didn't set the value.
  e.setSelection({M});
  REQUIRE(e.command(CommandId::EDIT_COMPONENT_PROPERTY, args("{\"prop\":\"Show label\",\"defaultValue\":false}")) == OK);
  e.setSelection({I});
  REQUIRE(e.command(CommandId::RESET_OVERRIDES) == OK);
  CHECK(props(e, I).componentPropAssignments.empty());
  CHECK(!props(e, row).visible);
  CHECK(props(e, row).textData.characters == "Label");
}

TEST_CASE("components: create component, combine as variants, add variant, switch variants keeping overrides") {
  auto nodes = baseChanges();
  const Guid A{1, 1}, B{1, 2}, AR{1, 3}, BR{1, 4};
  NodeChange a = make(A, NodeType::FRAME, kPage, "!", {0, 0, 100, 40}, "Button/Primary");
  NodeChange b = make(B, NodeType::FRAME, kPage, "\"", {0, 60, 100, 40}, "Button/Secondary");
  nodes.push_back(a);
  nodes.push_back(b);
  nodes.push_back(make(AR, NodeType::ROUNDED_RECTANGLE, A, "!", {0, 0, 100, 40}, "Fill"));
  nodes.push_back(make(BR, NodeType::ROUNDED_RECTANGLE, B, "!", {0, 0, 100, 40}, "Fill"));
  Editor e = load(nodes);
  e.setSelection({A, B});
  REQUIRE(e.commandState(CommandId::CREATE_COMPONENT) == CMD_ENABLED);
  REQUIRE(e.command(CommandId::CREATE_COMPONENT, args("{\"mode\":\"SET\"}")) == OK);
  REQUIRE(e.selection().size() == 1);
  Guid set = e.selection()[0];
  CHECK(props(e, set).isComponentSet());
  CHECK(props(e, set).name == "Button");
  CHECK(props(e, A).type == NodeType::SYMBOL);
  CHECK(props(e, A).name == "Variant=Button, Property 2=Primary");
  CHECK(props(e, set).strokePaints[0].color == Color::hex(0x9747FF));
  CHECK(props(e, set).dashPattern == std::vector<double>{10, 5});
  CHECK(e.document().worldBounds(A) == Rect{0, 0, 100, 40});  // the variants stay put
  CHECK(e.undoStack().undoLabel() == "Create component set");
  // An instance of the primary variant, with a fill override that both variants started from the same value.
  e.applyChanges({instanceOf({1, 50}, A, kPage, "z", {300, 0, 100, 40})}, APPLY_USER);
  Guid inst{1, 50};
  e.setProps({sub(inst, {AR})}, change(F_FILLS, [](NodeProps& p) { p.fillPaints = {Paint::solid(Color::hex(0xFF00FF))}; }), 0);
  e.setSelection({inst});
  REQUIRE(e.command(CommandId::SET_COMPONENT_PROPERTY, args("{\"prop\":\"Property 2\",\"value\":\"Secondary\"}")) == OK);
  CHECK(props(e, inst).symbolData.symbolID == B);
  // Kept by layer name ("Fill"), its fill override with it.
  Guid moved = sub(inst, {BR});
  REQUIRE(e.document().has(moved));
  CHECK(props(e, moved).fillPaints[0].color == Color::hex(0xFF00FF));
  ComponentInfo info;
  REQUIRE(e.componentInfo(inst, info));
  REQUIRE(info.properties.size() == 2);
  CHECK(info.properties[1].variantValue == "Secondary");
  CHECK(info.properties[1].variantOptions == std::vector<std::string>{"Primary", "Secondary"});
  // Add variant: a copy of the selected variant below it, keys kept, a new value.
  e.setSelection({B});
  REQUIRE(e.command(CommandId::ADD_VARIANT) == OK);
  Guid nv = e.selection()[0];
  CHECK(e.document().parentOf(nv) == set);
  CHECK(props(e, nv).name == "Variant=Variant2, Property 2=Secondary");
  CHECK(props(e, e.document().children(nv)[0]).overrideKey == BR);
}

TEST_CASE("components: create component from a frame converts it; from a shape wraps it") {
  auto nodes = baseChanges();
  const Guid F{1, 1}, R{1, 2};
  nodes.push_back(make(F, NodeType::FRAME, kPage, "!", {0, 0, 100, 100}, "Card"));
  nodes.push_back(make(R, NodeType::ROUNDED_RECTANGLE, kPage, "\"", {200, 0, 50, 50}, "Dot"));
  Editor e = load(nodes);
  e.setSelection({F});
  REQUIRE(e.command(CommandId::CREATE_COMPONENT) == OK);
  CHECK(props(e, F).type == NodeType::SYMBOL);
  auto ev = e.takeEvents();
  bool typeEmitted = false;
  for (auto& c : ev.documents.back().changes) typeEmitted |= c.guid == F && (c.mask & F_TYPE) && c.props.type == NodeType::SYMBOL;
  CHECK(typeEmitted);
  e.setSelection({R});
  REQUIRE(e.command(CommandId::CREATE_COMPONENT) == OK);
  Guid c = e.selection()[0];
  CHECK(props(e, c).type == NodeType::SYMBOL);
  CHECK(props(e, c).name == "Dot");
  CHECK(e.document().parentOf(R) == c);
  CHECK(e.document().worldBounds(R) == Rect{200, 0, 50, 50});
}

TEST_CASE("components: detach makes a frame with real layers; a nested instance detaches its ancestors first") {
  auto nodes = buttonDoc();
  const Guid ICON{2, 1}, SHAPE{2, 2}, NESTED{1, 5};
  nodes.push_back(make(ICON, NodeType::SYMBOL, kPage, "#", {300, 0, 16, 16}, "Icon"));
  nodes.push_back(make(SHAPE, NodeType::ELLIPSE, ICON, "!", {0, 0, 16, 16}, "Shape"));
  nodes.push_back(instanceOf(NESTED, ICON, M, "#", {80, 12, 16, 16}));
  Editor e = load(nodes);
  e.setProps({sub(I, {LABEL})}, change(F_TEXT_DATA, [](NodeProps& p) { p.textData.characters = "Go"; }), 0);
  e.setProps({sub(I, {NESTED, SHAPE})}, change(F_OPACITY, [](NodeProps& p) { p.opacity = 0.5; }), 0);
  // Detaching the nested instance detaches the button first; the icon becomes a frame too.
  e.setSelection({sub(I, {NESTED})});
  REQUIRE(e.command(CommandId::DETACH_INSTANCE) == OK);
  CHECK(props(e, I).type == NodeType::FRAME);
  CHECK(props(e, I).detachedSymbolId == M);
  REQUIRE(e.selection().size() == 1);
  Guid icon = e.selection()[0];
  CHECK(!icon.isDerived());
  CHECK(props(e, icon).type == NodeType::FRAME);
  CHECK(props(e, icon).detachedSymbolId == ICON);
  REQUIRE(e.document().children(icon).size() == 1);
  CHECK(props(e, e.document().children(icon)[0]).opacity == doctest::Approx(0.5));
  bool found = false;
  for (Guid k : e.document().children(I)) {
    CHECK(!k.isDerived());
    if (props(e, k).type == NodeType::TEXT) found = props(e, k).textData.characters == "Go";
  }
  CHECK(found);
  // One undo step brings the instance back.
  e.command(CommandId::UNDO);
  CHECK(props(e, I).type == NodeType::INSTANCE);
  CHECK(props(e, sub(I, {LABEL})).textData.characters == "Go");
}

TEST_CASE("components: push changes to main, reset one property, go to main and back") {
  Editor e = load(buttonDoc());
  Guid bg = sub(I, {BG});
  e.setProps({bg}, change(F_FILLS | F_OPACITY, [](NodeProps& p) {
    p.fillPaints = {Paint::solid(Color::hex(0x123456))};
    p.opacity = 0.5;
  }), 0);
  e.setSelection({bg});
  REQUIRE(e.command(CommandId::RESET_OVERRIDES, args("{\"field\":\"opacity\"}")) == OK);
  CHECK(props(e, bg).opacity == 1);
  CHECK(hasOverride(e, I, {BG}, F_FILLS));
  e.setSelection({I});
  REQUIRE(e.commandState(CommandId::PUSH_CHANGES_TO_MAIN) == CMD_ENABLED);
  REQUIRE(e.command(CommandId::PUSH_CHANGES_TO_MAIN) == OK);
  CHECK(props(e, BG).fillPaints[0].color == Color::hex(0x123456));
  CHECK(props(e, I).symbolData.overrides.empty());
  CHECK(props(e, bg).fillPaints[0].color == Color::hex(0x123456));
  REQUIRE(e.command(CommandId::GO_TO_MAIN_COMPONENT) == OK);
  CHECK(e.selection() == std::vector<Guid>{M});
  CHECK(e.returnToInstance() == I);
  auto ev = e.takeEvents();
  CHECK(ev.navigation);
  REQUIRE(e.command(CommandId::RETURN_TO_INSTANCE) == OK);
  CHECK(e.selection() == std::vector<Guid>{I});
}

TEST_CASE("components: copy/paste, ⌘D and ⌥-drag of a main make instances; deleting a used main keeps it restorable") {
  Editor e = load(buttonDoc());
  e.setSelection({M});
  Clipboard clip;
  REQUIRE(e.copySelection(clip));
  e.setSelection({});
  REQUIRE(e.paste(clip, true) == 1);
  Guid pasted = e.selection()[0];
  CHECK(props(e, pasted).type == NodeType::INSTANCE);
  CHECK(props(e, pasted).symbolData.symbolID == M);
  e.setSelection({M});
  e.command(CommandId::DUPLICATE);
  CHECK(props(e, e.selection()[0]).type == NodeType::INSTANCE);
  // An instance copies as an instance (its sublayers aren't on the clipboard).
  e.setSelection({I});
  REQUIRE(e.copySelection(clip));
  CHECK(clip.nodes.size() == 1);
  // Delete the main: its instances keep rendering; Restore component puts it back.
  e.setSelection({M});
  e.command(CommandId::DELETE);
  REQUIRE(e.document().has(M));
  CHECK(props(e, M).isSoftDeleted);
  CHECK(e.document().pageOf(M) == kInternal);
  CHECK(e.document().has(sub(I, {LABEL})));
  ComponentInfo info;
  REQUIRE(e.componentInfo(I, info));
  CHECK(info.mainDeleted);
  e.setSelection({I});
  REQUIRE(e.commandState(CommandId::RESTORE_COMPONENT) == CMD_ENABLED);
  REQUIRE(e.command(CommandId::RESTORE_COMPONENT) == OK);
  CHECK(!props(e, M).isSoftDeleted);
  CHECK(e.document().parentOf(M) == kPage);
  CHECK(e.document().worldBounds(M) == Rect{0, 0, 100, 40});
}

TEST_CASE("components: text editing inside an instance writes overrides") {
  Editor e = load(buttonDoc());
  Guid label = sub(I, {LABEL});
  REQUIRE(e.startTextEdit(label, true) == OK);
  e.textInput("Hi");
  e.endTextEdit();
  CHECK(props(e, label).textData.characters == "Hi");
  CHECK(hasOverride(e, I, {LABEL}, F_TEXT_DATA));
  CHECK(!hasOverride(e, I, {LABEL}, F_NAME));
  CHECK(props(e, LABEL).textData.characters == "Label");
}

TEST_CASE("components: picking takes an instance whole; inside once it is selected") {
  Editor e = load(buttonDoc());
  auto path = hitPath(e.document(), kPage, {50, 120}, 1);
  REQUIRE(!path.empty());
  CHECK(pick(e.document(), path, {}, false) == I);
  CHECK(pick(e.document(), path, {I}, false) == path.back());
  CHECK(path.back().isDerived());
  CHECK(pick(e.document(), path, {}, true) == path.back());
}

TEST_CASE("components: structure.fig's instances match Figma's derivedSymbolData") {
  std::ifstream in(std::string(ENG_TEST_DATA "/figma/structure.full.json"));
  REQUIRE(in.good());
  std::stringstream text;
  text << in.rdbuf();
  json::Value v;
  REQUIRE(json::parse(text.str(), v));
  Editor e;
  e.setSessionID(9);
  e.loadDocument(codec::readMessage(v), kNoGuid);
  int compared = 0;
  for (auto& n : v.get("nodeChanges")->array) {
    auto* type = n.get("type");
    if (!type || type->string != "INSTANCE") continue;
    Guid inst;
    REQUIRE(codec::readGuid(*n.get("guid"), inst));
    Guid symbol;
    codec::readGuid(*n.get("symbolData")->get("symbolID"), symbol);
    for (auto& d : n.get("derivedSymbolData")->array) {
      std::vector<Guid> path;
      for (auto& g : d.get("guidPath")->get("guids")->array) {
        Guid k;
        codec::readGuid(g, k);
        path.push_back(k);
      }
      if (path.size() == 1 && path[0] == symbol) path.clear();  // the root
      Guid id = derived::intern(inst, path);
      REQUIRE(e.document().has(id));
      const NodeProps& p = props(e, id);
      if (auto* s = d.get("size")) {
        CHECK(std::fabs(p.size.x - s->get("x")->numberOr(0)) < 0.01);
        CHECK(std::fabs(p.size.y - s->get("y")->numberOr(0)) < 0.01);
        compared++;
      }
      if (auto* t = d.get("transform")) {
        CHECK(std::fabs(p.transform.m02 - t->get("m02")->numberOr(0)) < 0.01);
        CHECK(std::fabs(p.transform.m12 - t->get("m12")->numberOr(0)) < 0.01);
        compared++;
      }
      if (auto* td = d.get("textData")) CHECK(p.textData.characters == td->get("characters")->string);
    }
  }
  CHECK(compared >= 8);
  // The overrides as Figma shows them: "XYZ" in Component 2, a red rectangle in Component 3.
  CHECK(props(e, derived::intern({1, 38}, {{1, 42}})).textData.characters == "XYZ");
  CHECK(props(e, derived::intern({1, 45}, {{1, 35}})).fillPaints[0].color == Color{1, 0, 0, 1});
  CHECK(props(e, {1, 45}).name == "Component 3");
  // And it round-trips: the instances encode with their overrides, no derived rows.
  for (const NodeChange& c : e.encodeDocument()) {
    CHECK(!c.guid.isDerived());
    if (c.guid == Guid{1, 45}) CHECK(c.props.symbolData.overrides.size() == 2);
  }
}

TEST_CASE("components: the codec round-trips component fields") {
  NodeChange c = NodeChange::created({1, 2}, defaultProps(NodeType::INSTANCE));
  c.props.symbolData.symbolID = {1, 1};
  SymbolOverride o;
  o.path = {{1, 3}, {1, 4}};
  o.mask = F_FILLS | F_NAME;
  o.props.name = "x";
  o.props.fillPaints = {Paint::solid(Color::hex(0xFF0000))};
  c.props.symbolData.overrides = {o};
  ComponentPropAssignment a;
  a.defID = {1, 99};
  a.value.hasBool = true;
  c.props.componentPropAssignments = {a};
  ParamBinding b;
  b.field = VariableField::VISIBLE;
  b.propRef = {1, 98};
  c.props.parameterConsumptionMap = {b};
  c.props.overrideKey = {5, 5};
  json::Writer w;
  codec::writeChange(w, c);
  json::Value v;
  REQUIRE(json::parse(w.take(), v));
  NodeChange back;
  REQUIRE(codec::readChange(v, back));
  CHECK(back.props.symbolData == c.props.symbolData);
  CHECK(back.props.componentPropAssignments == c.props.componentPropAssignments);
  CHECK(back.props.parameterConsumptionMap == c.props.parameterConsumptionMap);
  CHECK(back.props.overrideKey == c.props.overrideKey);
  CHECK(back.props.extra.empty());
}

TEST_CASE("components: an edit inside an instance's slot diverges the whole slot; Reset slot brings the main's back") {
  auto nodes = buttonDoc();
  const Guid SLOT{1, 6}, DEFAULT{1, 7}, SLOTDEF{1, 0x7ffffffd};
  NodeChange& m = nodes[3];
  ComponentPropDef d;
  d.id = SLOTDEF;
  d.name = "Content";
  d.type = ComponentPropType::SLOT;
  m.props.componentPropDefs = {d};
  NodeChange slot = make(SLOT, NodeType::FRAME, M, "$", {0, 0, 100, 40}, "Slot");
  slot.props.isSlot = true;
  slot.props.fillPaints.clear();
  ParamBinding b;
  b.field = VariableField::SLOT_CONTENT_ID;
  b.propRef = SLOTDEF;
  slot.props.parameterConsumptionMap = {b};
  nodes.push_back(slot);
  nodes.push_back(make(DEFAULT, NodeType::ELLIPSE, SLOT, "!", {5, 5, 10, 10}, "Default"));
  Editor e = load(nodes);
  Guid row = sub(I, {SLOT});
  REQUIRE(e.document().has(sub(I, {SLOT, DEFAULT})));
  // A new layer into the slot: a content frame under the instance with the default copied, plus the new one.
  e.applyChanges({make({1, 30}, NodeType::ROUNDED_RECTANGLE, row, "z", {50, 5, 10, 10}, "Mine")}, APPLY_USER);
  REQUIRE(e.document().has({1, 30}));
  Guid content = e.document().parentOf({1, 30});
  CHECK(props(e, content).isSlotContent);
  CHECK(e.document().parentOf(content) == I);
  CHECK(e.document().children(content).size() == 2);
  CHECK(!e.document().has(sub(I, {SLOT, DEFAULT})));  // the slot shows the content now
  CHECK(e.document().worldBounds({1, 30}) == Rect{50, 105, 10, 10});
  // The main's later edits don't reach a diverged slot.
  e.setProps({DEFAULT}, change(F_OPACITY, [](NodeProps& p) { p.opacity = 0.3; }), 0);
  for (Guid k : e.document().children(content)) CHECK(props(e, k).opacity == 1);
  e.setSelection({row});
  REQUIRE(e.command(CommandId::RESET_SLOT) == OK);
  CHECK(!e.document().has(content));
  CHECK(e.document().has(sub(I, {SLOT, DEFAULT})));
  CHECK(props(e, sub(I, {SLOT, DEFAULT})).opacity == doctest::Approx(0.3));
}

TEST_CASE("components: Add variant on a lone component makes a set; the variants keep their place") {
  auto nodes = baseChanges();
  nodes.push_back(make({60, 1}, NodeType::FRAME, kPage, "~", {800, 0, 120, 40}, "Button"));
  Editor e = load(nodes);
  e.setSelection({{60, 1}});
  REQUIRE(e.command(CommandId::CREATE_COMPONENT) == OK);
  REQUIRE(e.command(CommandId::ADD_VARIANT) == OK);
  Guid set = e.document().parentOf({60, 1});
  CHECK(props(e, set).isComponentSet());
  CHECK(props(e, set).name == "Button");
  CHECK(e.document().worldBounds({60, 1}) == Rect{800, 0, 120, 40});
  CHECK(props(e, {60, 1}).name == "Property 1=Default");
  Guid nv = e.selection()[0];
  CHECK(e.document().worldBounds(nv) == Rect{800, 60, 120, 40});
  CHECK(props(e, nv).name == "Property 1=Variant2");
  CHECK(e.document().worldBounds(set) == Rect{780, -20, 160, 140});
}

TEST_CASE("components: an inserted instance draws its purple selection; no vector editing inside instances") {
  auto nodes = baseChanges();
  nodes.push_back(make({60, 1}, NodeType::FRAME, kPage, "~", {800, 0, 120, 40}, "Button"));
  nodes.push_back(textNode({60, 2}, {60, 1}, "!", {20, 10, 80, 20}, "Button"));
  Editor e = load(nodes);
  e.setSelection({{60, 1}});
  e.command(CommandId::CREATE_COMPONENT);
  REQUIRE(e.command(CommandId::INSERT_INSTANCE, args("{\"main\":\"60:1\",\"x\":1100,\"y\":20}")) == OK);
  Guid inst = e.selection()[0];
  CHECK(e.document().worldBounds(inst) == Rect{1040, 0, 120, 40});
  CHECK(e.startVectorEdit(derived::intern(inst, {{60, 2}})) == E_UNSUPPORTED);
  Overlay o = e.overlay();
  gfx::NullDevice dev;
  Renderer r(dev);
  Viewport vp{1280, 800, 1, 1280, 800};
  RenderStats with = r.render(e.document(), kPage, {-900, 100, 1}, vp, o, OverlayStyle::of(Theme::Dark));
  o.selection.clear();
  RenderStats without = r.render(e.document(), kPage, {-900, 100, 1}, vp, o, OverlayStyle::of(Theme::Dark));
  CHECK(with.shapes > without.shapes);
}
