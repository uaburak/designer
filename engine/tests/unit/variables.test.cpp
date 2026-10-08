// Variables, modes and styles (E6, docs/schema.md §6, docs/engine-build.md "E6 variables"): the data on the
// wire, the commands, resolution (modes, aliases across collections, composed colours, every bindable field),
// dependencies (a value, a mode or a style edit reaches every user in the same commit, instances included),
// detaching on edit, styles, undo, round trips and Figma's own encoding (library references by key).
#include <array>
#include <chrono>
#include <cmath>
#include <functional>
#include <string>

#include "doctest.h"
#include "Helpers.h"
#include "base/DerivedIds.h"
#include "editor/Editor.h"
#include "scene/CodecJson.h"
#include "scene/CodecKiwi.h"
#include "text/Fonts.h"

using namespace eng;
using namespace eng::test;

namespace {

const Guid F{1, 1}, R{1, 2}, T{1, 3}, AL{1, 4}, A1{1, 5}, A2{1, 6}, R2{1, 7};

std::vector<NodeChange> doc() {
  auto nodes = baseChanges();
  nodes.push_back(make(F, NodeType::FRAME, kPage, "!", {0, 0, 400, 400}, "Frame"));
  nodes.push_back(make(R, NodeType::ROUNDED_RECTANGLE, F, "!", {10, 10, 50, 50}, "Rect"));
  NodeChange t = make(T, NodeType::TEXT, F, "\"", {10, 100, 100, 20}, "Text");
  t.props.text().textData.characters = "Hello";
  t.props.text().textAutoResize = TextAutoResize::NONE;
  nodes.push_back(t);
  // An auto-layout row (hugging) with two 20 × 20 children.
  NodeChange al = make(AL, NodeType::FRAME, kPage, "\"", {500, 0, 40, 20}, "Row");
  al.props.stack().stackMode = StackMode::HORIZONTAL;
  al.props.stack().stackCounterSizing = StackSize::RESIZE_TO_FIT_WITH_IMPLICIT_SIZE;
  nodes.push_back(al);
  nodes.push_back(make(A1, NodeType::ROUNDED_RECTANGLE, AL, "!", {0, 0, 20, 20}, "A"));
  nodes.push_back(make(A2, NodeType::ROUNDED_RECTANGLE, AL, "\"", {20, 0, 20, 20}, "B"));
  nodes.push_back(make(R2, NodeType::ROUNDED_RECTANGLE, kPage, "#", {0, 500, 50, 50}, "Rect 2"));
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

CommandArgs args(const std::string& jsonText) {
  CommandArgs a;
  REQUIRE(json::parse(jsonText, a.raw));
  return a;
}

std::string q(Guid g) { return "\"" + g.toString() + "\""; }

NodeChange change(FieldMask mask, const std::function<void(NodeProps&)>& f) {
  NodeChange c = NodeChange::changed(Guid{0, 0});
  c.mask = mask;
  f(c.props);
  return c;
}

Status run(Editor& e, CommandId id, const std::string& json) { return e.command(id, args(json)); }

// A collection "Theme" with modes Light / Dark; returns {set, light, dark}.
std::array<Guid, 3> theme(Editor& e) {
  REQUIRE(run(e, CommandId::CREATE_VARIABLE_COLLECTION, R"({"name":"Theme"})") == OK);
  Guid set = e.lastCreated()[0], light = e.lastCreated()[1];
  REQUIRE(run(e, CommandId::RENAME_VARIABLE_MODE, "{\"collection\":" + q(set) + ",\"mode\":" + q(light) + ",\"name\":\"Light\"}") == OK);
  REQUIRE(run(e, CommandId::ADD_VARIABLE_MODE, "{\"collection\":" + q(set) + ",\"name\":\"Dark\"}") == OK);
  Guid dark = e.lastCreated()[0];
  return {set, light, dark};
}

Guid variable(Editor& e, Guid set, const std::string& type, const std::string& name, const std::string& value) {
  REQUIRE(run(e, CommandId::CREATE_VARIABLE,
              "{\"collection\":" + q(set) + ",\"type\":\"" + type + "\",\"name\":\"" + name + "\",\"value\":" + value + "}") == OK);
  REQUIRE(e.lastCreated().size() == 1);
  return e.lastCreated()[0];
}

void setValue(Editor& e, Guid v, Guid mode, const std::string& value, Status expect = OK) {
  CHECK(run(e, CommandId::SET_VARIABLE_VALUE, "{\"variable\":" + q(v) + ",\"mode\":" + q(mode) + ",\"value\":" + value + "}") == expect);
}

void bind(Editor& e, Guid node, const std::string& target, Guid v, Status expect = OK) {
  CHECK(run(e, CommandId::BIND_VARIABLE,
            "{\"refs\":[" + q(node) + "],\"target\":\"" + target + "\",\"variable\":" + (v == kNoGuid ? std::string("null") : q(v)) + "}") ==
        expect);
}

void setMode(Editor& e, Guid node, Guid set, Guid mode) {
  CHECK(run(e, CommandId::SET_VARIABLE_MODE,
            "{\"refs\":[" + q(node) + "],\"collection\":" + q(set) + ",\"mode\":" + (mode == kNoGuid ? std::string("\"\"") : q(mode)) + "}") == OK);
}

Color fill(const Editor& e, Guid id) { return props(e, id).fillPaints.at(0).color; }

const Color kRed{1, 0, 0, 1}, kBlue{0, 0, 1, 1}, kGreen{0, 1, 0, 1};

std::string encoded(const Editor& e) {
  json::Writer w;
  codec::writeChanges(w, e.encodeDocument());
  return w.take();
}

}  // namespace

TEST_CASE("variables: the wire encoding round-trips every variable, mode, binding and style field") {
  const char* json = R"([
    {"guid":"5:1","phase":"CREATED","type":"VARIABLE_SET","name":"Theme","parentIndex":{"guid":"0:2","position":"!"},
     "variableSetModes":[{"id":{"sessionID":5,"localID":2},"name":"Light","sortPosition":"!"},{"id":"5:3","name":"Dark","sortPosition":"\""}],
     "sortPosition":"!","isPublishable":false,"key":"abc","description":"Colours"},
    {"guid":"5:4","phase":"CREATED","type":"VARIABLE","name":"bg/primary","parentIndex":{"guid":"0:2","position":"\""},
     "variableSetID":{"guid":"5:1"},"variableResolvedType":"COLOR","sortPosition":"!",
     "variableDataValues":{"entries":[
       {"modeID":"5:2","variableData":{"value":{"colorValue":{"r":1,"g":0,"b":0,"a":1}},"dataType":"COLOR","resolvedDataType":"COLOR"}},
       {"modeID":"5:3","variableData":{"value":{"expressionValue":{"expressionFunction":"COMPOSE_COLOR","expressionArguments":[
          {"value":{"alias":{"guid":"5:9"}},"dataType":"ALIAS","resolvedDataType":"COLOR"},
          {"value":{"floatValue":50},"dataType":"FLOAT","resolvedDataType":"FLOAT"}]}},"dataType":"EXPRESSION","resolvedDataType":"COLOR"}}]},
     "variableScopes":["ALL_FILLS","STROKE_COLOR"],"codeSyntax":{"entries":[{"platform":"WEB","value":"--bg"}]},
     "isSoftDeleted":false,"key":"def"},
    {"guid":"5:5","phase":"CREATED","type":"VARIABLE","name":"none","parentIndex":{"guid":"0:2","position":"#"},
     "variableSetID":{"assetRef":{"key":"k1","version":"1:2"}},"variableResolvedType":"FLOAT","variableScopes":[],
     "variableDataValues":{"entries":[{"modeID":"5:2","variableData":{"value":{"textDataValue":{"characters":"m"}},"dataType":14,"resolvedDataType":9}}]}},
    {"guid":"1:2","phase":"CREATED","type":"ROUNDED_RECTANGLE","parentIndex":{"guid":"0:1","position":"!"},"size":{"x":10,"y":10},
     "fillPaints":[{"type":"SOLID","color":{"r":1,"g":0,"b":0,"a":1},"colorVar":{"value":{"alias":{"guid":"5:4"}},"dataType":"ALIAS","resolvedDataType":"COLOR"},
                    "opacityVar":{"value":{"alias":{"assetRef":{"key":"xyz","version":"3:4"}}},"dataType":"ALIAS","resolvedDataType":"FLOAT"}},
                   {"type":"GRADIENT_LINEAR","stops":[{"color":{"r":0,"g":0,"b":0,"a":1},"position":0},{"color":{"r":1,"g":1,"b":1,"a":1},"position":1}],
                    "stopsVar":[{"color":{"r":0,"g":0,"b":0,"a":1},"position":0},{"color":{"r":1,"g":1,"b":1,"a":1},"colorVar":{"value":{"alias":{"guid":"5:4"}},"dataType":"ALIAS","resolvedDataType":"COLOR"},"position":1}]}],
     "effects":[{"type":"DROP_SHADOW","radius":4,"radiusVar":{"value":{"alias":{"guid":"5:6"}},"dataType":"ALIAS","resolvedDataType":"FLOAT"}}],
     "layoutGrids":[{"type":"STRETCH","axis":"X","numSections":4,"gutterSizeVar":{"value":{"alias":{"guid":"5:6"}},"dataType":"ALIAS","resolvedDataType":"FLOAT"}}],
     "parameterConsumptionMap":{"entries":[
       {"variableField":"OPACITY","variableData":{"value":{"alias":{"guid":"5:6"}},"dataType":"ALIAS","resolvedDataType":"FLOAT"}},
       {"variableField":"VISIBLE","variableData":{"value":{"propRefValue":{"defId":"7:7"}},"dataType":"PROP_REF","resolvedDataType":"BOOLEAN"}},
       {"variableField":"FONT_STYLE","variableData":{"value":{"fontStyleValue":{"asString":{"value":{"alias":{"guid":"5:7"}},"dataType":"ALIAS","resolvedDataType":"STRING"}}},"dataType":"FONT_STYLE","resolvedDataType":"FONT_STYLE"}}]},
     "variableModeBySetMap":{"entries":[{"variableSetID":{"guid":"5:1"},"variableModeID":"5:3"}]},
     "styleIdForFill":{"guid":"6:1"},"styleIdForText":{"guid":"4294967295:4294967295"},"styleIdForEffect":{"assetRef":{"key":"e1","version":"9:9"}}},
    {"guid":"6:1","phase":"CREATED","type":"ROUNDED_RECTANGLE","name":"Brand/Red","styleType":"FILL","parentIndex":{"guid":"0:2","position":"$"},
     "fillPaints":[{"type":"SOLID","color":{"r":1,"g":0,"b":0,"a":1}}],"sortPosition":"!","description":"d"}
  ])";
  json::Value v;
  REQUIRE(json::parse(json, v));
  auto first = codec::readChanges(v);
  REQUIRE(first.size() == 5);
  const NodeProps& set = first[0].props;
  CHECK(set.asset().variableSetModes.size() == 2);
  CHECK(set.asset().variableSetModes[0].id == Guid{5, 2});
  CHECK(set.defaultMode() == Guid{5, 2});
  CHECK(!set.asset().isPublishable);
  CHECK(set.asset().key == "abc");
  CHECK(set.extra.empty());
  const NodeProps& var = first[1].props;
  CHECK(var.asset().variableSetID.guid == Guid{5, 1});
  CHECK(var.asset().variableResolvedType == VariableResolvedType::COLOR);
  REQUIRE(var.asset().variableDataValues.size() == 2);
  CHECK(var.asset().variableDataValues[0].data.kind == VariableData::Kind::COLOR);
  const VariableData& composed = var.asset().variableDataValues[1].data;
  CHECK(composed.kind == VariableData::Kind::EXPRESSION);
  CHECK(composed.function == ExpressionFunction::COMPOSE_COLOR);
  REQUIRE(composed.args.size() == 2);
  CHECK(composed.args[0].alias.guid == Guid{5, 9});
  CHECK(composed.args[1].floatValue == 50);
  REQUIRE(var.asset().variableScopes.has_value());
  CHECK(*var.asset().variableScopes == std::vector<VariableScope>{VariableScope::ALL_FILLS, VariableScope::STROKE});
  CHECK(var.asset().codeSyntax.size() == 1);
  CHECK(var.extra.empty());
  // An unknown value kind (Figma's IMAGE = 14, dropped from our schema, so a number) is kept whole; an explicitly
  // empty scope list stays empty.
  CHECK(first[2].props.asset().variableDataValues[0].data.kind == VariableData::Kind::OTHER);
  CHECK(first[2].props.asset().variableScopes->empty());
  CHECK(first[2].props.asset().variableSetID.key == "k1");
  const NodeProps& r = first[3].props;
  CHECK(r.fillPaints[0].colorVar->alias.guid == Guid{5, 4});
  CHECK(r.fillPaints[0].opacityVar->alias.key == "xyz");
  REQUIRE(r.fillPaints[1].stopVars.size() == 2);
  CHECK(!r.fillPaints[1].stopVars[0].present());
  CHECK(r.fillPaints[1].stopVars[1].alias.guid == Guid{5, 4});
  CHECK(r.effects[0].radiusVar.present());
  CHECK(r.rare().layoutGrids[0].gutterSizeVar.present());
  REQUIRE(r.parameterConsumptionMap.size() == 3);
  CHECK(r.parameterConsumptionMap[0].isVariable());
  CHECK(r.parameterConsumptionMap[1].propRef == Guid{7, 7});
  CHECK(r.parameterConsumptionMap[2].data.kind == VariableData::Kind::FONT_STYLE);
  CHECK(r.refs().variableModeBySetMap.size() == 1);
  CHECK(r.refs().styleIdForFill.guid == Guid{6, 1});
  CHECK(!r.refs().styleIdForText.present());  // Figma's "none" sentinel
  CHECK(r.refs().styleIdForEffect.key == "e1");
  CHECK(r.hasBindings());
  CHECK(r.extra.empty());
  CHECK(first[4].props.asset().styleType == StyleType::FILL);
  // Out and back in: nothing lost.
  json::Writer w;
  codec::writeChanges(w, first);
  json::Value again;
  REQUIRE(json::parse(w.take(), again));
  auto second = codec::readChanges(again);
  REQUIRE(second.size() == first.size());
  for (size_t i = 0; i < first.size(); i++) CHECK(differingFields(first[i].props, second[i].props) == 0);
  // An update clearing a style reference and the scopes writes clearedFields (and reads back as absent).
  NodeChange clear = NodeChange::changed(Guid{1, 2});
  clear.mask = F_STYLE_ID_FILL | F_VARIABLE_SCOPES;
  json::Writer cw;
  codec::writeChange(cw, clear);
  std::string text = cw.take();
  CHECK(text.find("clearedFields") != std::string::npos);
  CHECK(text.find("332") != std::string::npos);
  CHECK(text.find("353") != std::string::npos);
}

TEST_CASE("variables: collections, modes and variables are nodes on the internal canvas; commands make them") {
  Editor e = load(doc());
  auto [set, light, dark] = theme(e);
  const NodeProps& sp = props(e, set);
  CHECK(sp.type == NodeType::VARIABLE_SET);
  CHECK(sp.name == "Theme");
  CHECK(e.document().parentOf(set) == kInternal);
  REQUIRE(sp.asset().variableSetModes.size() == 2);
  CHECK(sp.defaultMode() == light);
  CHECK(sp.asset().key.size() == 40);
  CHECK(e.collections() == std::vector<Guid>{set});
  // Default names, groups, values.
  REQUIRE(run(e, CommandId::CREATE_VARIABLE, "{\"collection\":" + q(set) + ",\"type\":\"COLOR\"}") == OK);
  Guid c1 = e.lastCreated()[0];
  REQUIRE(run(e, CommandId::CREATE_VARIABLE, "{\"collection\":" + q(set) + ",\"type\":\"COLOR\"}") == OK);
  Guid c2 = e.lastCreated()[0];
  REQUIRE(run(e, CommandId::CREATE_VARIABLE, "{\"collection\":" + q(set) + ",\"type\":\"FLOAT\",\"group\":\"space\"}") == OK);
  Guid n1 = e.lastCreated()[0];
  CHECK(props(e, c1).name == "Color");
  CHECK(props(e, c2).name == "Color 2");
  CHECK(props(e, n1).name == "space/Number");
  CHECK(props(e, c1).asset().variableDataValues.size() == 2);  // one value per mode
  CHECK(e.variablesOf(set) == std::vector<Guid>{c1, c2, n1});
  Editor::Resolved r;
  REQUIRE(e.resolveVariable(c1, kNoGuid, r));
  CHECK(r.kind == Editor::Resolved::Kind::COLOR);
  CHECK(r.c == Color{1, 1, 1, 1});
  // Names: unique in the collection, no `.`, `{`, `}`; slashes trimmed.
  CHECK(run(e, CommandId::RENAME_VARIABLE, "{\"variable\":" + q(c2) + ",\"name\":\"Color\"}") == E_INVALID);
  CHECK(run(e, CommandId::RENAME_VARIABLE, "{\"variable\":" + q(c2) + ",\"name\":\"a.b\"}") == E_INVALID);
  CHECK(run(e, CommandId::RENAME_VARIABLE, "{\"variable\":" + q(c2) + ",\"name\":\"bg / primary\"}") == OK);
  CHECK(props(e, c2).name == "bg/primary");
  // Type checks on values.
  setValue(e, n1, light, "\"text\"", E_INVALID);
  setValue(e, n1, light, "8");
  REQUIRE(e.resolveVariable(n1, kNoGuid, r));
  CHECK(r.f == 8);
  // Scopes, code syntax, description, hidden.
  CHECK(run(e, CommandId::SET_VARIABLE_SCOPES, "{\"variables\":[" + q(n1) + "],\"scopes\":[\"GAP\",\"WIDTH_HEIGHT\"]}") == OK);
  CHECK(*props(e, n1).asset().variableScopes == std::vector<VariableScope>{VariableScope::GAP, VariableScope::WIDTH_HEIGHT});
  CHECK(run(e, CommandId::SET_VARIABLE_SCOPES, "{\"variables\":[" + q(c1) + "],\"scopes\":[\"ALL_FILLS\",\"FRAME_FILL\",\"STROKE_COLOR\"]}") == OK);
  CHECK(*props(e, c1).asset().variableScopes == std::vector<VariableScope>{VariableScope::ALL_FILLS, VariableScope::STROKE});
  CHECK(run(e, CommandId::SET_VARIABLE_SCOPES, "{\"variables\":[" + q(c1) + "],\"scopes\":[\"GAP\",\"ALL_SCOPES\"]}") == OK);
  CHECK(*props(e, c1).asset().variableScopes == std::vector<VariableScope>{VariableScope::ALL_SCOPES});
  CHECK(run(e, CommandId::SET_VARIABLE_CODE_SYNTAX, "{\"variable\":" + q(n1) + ",\"platform\":\"iOS\",\"value\":\"spaceSm\"}") == OK);
  CHECK(run(e, CommandId::SET_VARIABLE_CODE_SYNTAX, "{\"variable\":" + q(n1) + ",\"platform\":\"WEB\",\"value\":\"--space-sm\"}") == OK);
  REQUIRE(props(e, n1).asset().codeSyntax.size() == 2);
  CHECK(props(e, n1).asset().codeSyntax[0].platform == CodeSyntaxPlatform::WEB);
  CHECK(run(e, CommandId::SET_VARIABLE_CODE_SYNTAX, "{\"variable\":" + q(n1) + ",\"platform\":\"WEB\",\"value\":\"\"}") == OK);
  CHECK(props(e, n1).asset().codeSyntax.size() == 1);
  CHECK(run(e, CommandId::SET_VARIABLE_DESCRIPTION, "{\"variable\":" + q(n1) + ",\"description\":\"Small gap\"}") == OK);
  CHECK(props(e, n1).asset().description == "Small gap");
  CHECK(run(e, CommandId::SET_VARIABLE_HIDDEN, "{\"variables\":[" + q(n1) + "],\"hidden\":true}") == OK);
  CHECK(!props(e, n1).asset().isPublishable);
  // Events.
  auto ev = e.takeEvents();
  CHECK(!ev.variables.empty());
  CHECK(!ev.collections.empty());
}

TEST_CASE("variables: a bound fill resolves in the layer's mode — explicit, inherited from frames and pages, or the default") {
  Editor e = load(doc());
  auto [set, light, dark] = theme(e);
  Guid bg = variable(e, set, "COLOR", "bg", R"({"r":1,"g":0,"b":0,"a":1})");
  setValue(e, bg, dark, R"({"r":0,"g":0,"b":1})");
  bind(e, R, "fillPaints[0].color", bg);
  CHECK(fill(e, R) == kRed);
  CHECK(props(e, R).fillPaints[0].colorVar->alias.guid == bg);
  // The frame in Dark: its child follows (Auto).
  setMode(e, F, set, dark);
  CHECK(fill(e, R) == kBlue);
  CHECK(e.resolvedMode(R, set) == dark);
  // Back to Auto: the default mode.
  setMode(e, F, set, kNoGuid);
  CHECK(fill(e, R) == kRed);
  // The page in Dark; the frame explicitly Light wins for its subtree.
  CHECK(run(e, CommandId::SET_VARIABLE_MODE, "{\"page\":\"0:1\",\"collection\":" + q(set) + ",\"mode\":" + q(dark) + "}") == OK);
  CHECK(fill(e, R) == kBlue);
  setMode(e, F, set, light);
  CHECK(fill(e, R) == kRed);
  // The layer's own mode beats its frame's.
  setMode(e, R, set, dark);
  CHECK(fill(e, R) == kBlue);
  // Moving a layer to another parent resolves it in its new place.
  setMode(e, R, set, kNoGuid);
  CHECK(fill(e, R) == kRed);
  CHECK(e.moveNodes({R}, kPage, 0) == 1);
  CHECK(fill(e, R) == kBlue);  // the page is Dark
  // Undo walks it all back.
  while (e.canUndo()) e.command(CommandId::UNDO);
  CHECK(!e.document().has(set));
  CHECK(props(e, R).fillPaints[0].color == Color::hex(0xD9D9D9));
  CHECK(!props(e, R).fillPaints[0].colorVar.present());
}

TEST_CASE("variables: a value edit updates every user in the same commit, and undo restores both") {
  Editor e = load(doc());
  auto [set, light, dark] = theme(e);
  Guid bg = variable(e, set, "COLOR", "bg", R"({"r":1,"g":0,"b":0,"a":1})");
  bind(e, R, "fillPaints[0].color", bg);
  bind(e, R2, "fillPaints[0].color", bg);
  e.takeEvents();
  setValue(e, bg, light, R"({"r":0,"g":1,"b":0,"a":1})");
  CHECK(fill(e, R) == kGreen);
  CHECK(fill(e, R2) == kGreen);
  auto ev = e.takeEvents();
  REQUIRE(ev.documents.size() == 1);
  std::vector<Guid> touched;
  for (auto& c : ev.documents[0].changes) touched.push_back(c.guid);
  CHECK(std::find(touched.begin(), touched.end(), bg) != touched.end());
  CHECK(std::find(touched.begin(), touched.end(), R) != touched.end());
  CHECK(std::find(touched.begin(), touched.end(), R2) != touched.end());
  CHECK(std::find(ev.variables.begin(), ev.variables.end(), bg) != ev.variables.end());
  e.command(CommandId::UNDO);
  CHECK(fill(e, R) == kRed);
  CHECK(fill(e, R2) == kRed);
  e.command(CommandId::REDO);
  CHECK(fill(e, R) == kGreen);
}

TEST_CASE("variables: aliases resolve in the consumer's mode of each collection; cycles and wrong types are refused") {
  Editor e = load(doc());
  // Primitives with two modes (A, B); Theme (Light, Dark) aliasing them.
  REQUIRE(run(e, CommandId::CREATE_VARIABLE_COLLECTION, R"({"name":"Primitives"})") == OK);
  Guid prim = e.lastCreated()[0], pa = e.lastCreated()[1];
  REQUIRE(run(e, CommandId::ADD_VARIABLE_MODE, "{\"collection\":" + q(prim) + "}") == OK);
  Guid pb = e.lastCreated()[0];
  CHECK(props(e, prim).asset().variableSetModes[1].name == "Mode 2");
  Guid red = variable(e, prim, "COLOR", "red", R"({"r":1,"g":0,"b":0,"a":1})");
  Guid blue = variable(e, prim, "COLOR", "blue", R"({"r":0,"g":0,"b":1,"a":1})");
  setValue(e, blue, pb, R"({"r":0,"g":1,"b":0,"a":1})");  // "blue" is green in mode B
  auto [set, light, dark] = theme(e);
  Guid accent = variable(e, set, "COLOR", "accent", "{\"type\":\"VARIABLE_ALIAS\",\"id\":" + q(red) + "}");
  setValue(e, accent, dark, "{\"type\":\"VARIABLE_ALIAS\",\"id\":" + q(blue) + "}");
  bind(e, R, "fillPaints[0].color", accent);
  CHECK(fill(e, R) == kRed);
  setMode(e, F, set, dark);
  CHECK(fill(e, R) == kBlue);
  // Primitives in B for this frame: the chain crosses into it with the frame's mode for that collection.
  setMode(e, F, prim, pb);
  CHECK(fill(e, R) == kGreen);
  // resolveForConsumer.
  Editor::Resolved r;
  REQUIRE(e.resolveVariable(accent, R, r));
  CHECK(r.c == kGreen);
  REQUIRE(e.resolveVariable(accent, kNoGuid, r));
  CHECK(r.c == kRed);
  REQUIRE(e.resolveVariableInMode(accent, dark, r));
  CHECK(r.c == kBlue);
  // Editing the end of the chain reaches the layer.
  setValue(e, blue, pb, R"({"r":1,"g":1,"b":0,"a":1})");
  CHECK(fill(e, R) == Color{1, 1, 0, 1});
  // Cycles, self aliases and type mismatches.
  setValue(e, red, pa, "{\"type\":\"VARIABLE_ALIAS\",\"id\":" + q(accent) + "}", E_INVALID);
  setValue(e, red, pa, "{\"type\":\"VARIABLE_ALIAS\",\"id\":" + q(red) + "}", E_INVALID);
  Guid size = variable(e, prim, "FLOAT", "size", "4");
  setValue(e, red, pa, "{\"type\":\"VARIABLE_ALIAS\",\"id\":" + q(size) + "}", E_INVALID);
  bind(e, R, "fillPaints[0].color", size, E_INVALID);
  bind(e, R, "OPACITY", red, E_INVALID);
}

TEST_CASE("variables: composed colours (a colour alias with its own opacity, itself a variable)") {
  Editor e = load(doc());
  auto [set, light, dark] = theme(e);
  Guid blue = variable(e, set, "COLOR", "blue", R"({"r":0,"g":0,"b":1,"a":1})");
  Guid alpha = variable(e, set, "FLOAT", "alpha", "50");
  Guid overlay = variable(e, set, "COLOR", "overlay",
                          "{\"color\":{\"type\":\"VARIABLE_ALIAS\",\"id\":" + q(blue) + "},\"opacity\":{\"type\":\"VARIABLE_ALIAS\",\"id\":" + q(alpha) + "}}");
  const VariableData& d = props(e, overlay).asset().variableDataValues[0].data;
  CHECK(d.kind == VariableData::Kind::EXPRESSION);
  CHECK(d.function == ExpressionFunction::COMPOSE_COLOR);
  bind(e, R, "fillPaints[0].color", overlay);
  // As Figma stores it: the colour opaque, its alpha the paint's opacity.
  auto boundPaint = [&](Color rgb, float alpha) {
    const Paint& pt = props(e, R).fillPaints.at(0);
    CHECK(pt.color == rgb);
    CHECK(pt.opacity == doctest::Approx(alpha));
  };
  boundPaint({0, 0, 1, 1}, 0.5f);
  setValue(e, alpha, light, "25");
  boundPaint({0, 0, 1, 1}, 0.25f);
  // A literal opacity on the alias.
  setValue(e, overlay, dark, "{\"color\":{\"type\":\"VARIABLE_ALIAS\",\"id\":" + q(blue) + "},\"opacity\":80}");
  setMode(e, F, set, dark);
  boundPaint({0, 0, 1, 1}, 0.8f);
  // Two literals are just a colour.
  setValue(e, overlay, dark, R"({"color":{"r":1,"g":0,"b":0,"a":1},"opacity":10})");
  CHECK(props(e, overlay).asset().variableDataValues[1].data.kind == VariableData::Kind::COLOR);
  boundPaint({1, 0, 0, 1}, 0.1f);
  // The opacity of a paint bound to a number (a percentage).
  setMode(e, F, set, kNoGuid);
  bind(e, R, "fillPaints[0].opacity", alpha);
  CHECK(props(e, R).fillPaints[0].opacity == doctest::Approx(0.25));
}

TEST_CASE("variables: every kind of node field binding (sizes, gaps, paddings, radii, opacity, visibility, text, typography)") {
  Editor e = load(doc());
  auto [set, light, dark] = theme(e);
  Guid gap = variable(e, set, "FLOAT", "gap", "12");
  Guid pad = variable(e, set, "FLOAT", "pad", "5");
  Guid width = variable(e, set, "FLOAT", "width", "300");
  Guid half = variable(e, set, "FLOAT", "half", "50");
  Guid radius = variable(e, set, "FLOAT", "radius", "8");
  Guid show = variable(e, set, "BOOLEAN", "show", "false");
  Guid label = variable(e, set, "STRING", "label", "\"Hi there\"");
  Guid size = variable(e, set, "FLOAT", "size", "24");
  Guid family = variable(e, set, "STRING", "family", "\"Inter\"");
  Guid weight = variable(e, set, "FLOAT", "weight", "700");
  setValue(e, gap, dark, "30");
  // Auto layout: gap and padding move the children (layout runs in the same commit).
  bind(e, AL, "STACK_SPACING", gap);
  CHECK(props(e, AL).stack().stackSpacing == 12);
  CHECK(props(e, A2).transform.m02 == 32);
  bind(e, AL, "STACK_PADDING_LEFT", pad);
  CHECK(props(e, A1).transform.m02 == 5);
  CHECK(props(e, AL).size.x == 5 + 20 + 12 + 20);
  setMode(e, AL, set, dark);
  CHECK(props(e, A2).transform.m02 == 5 + 20 + 30);
  // A bound width fixes a hugging axis.
  bind(e, AL, "WIDTH", width);
  CHECK(props(e, AL).size.x == 300);
  CHECK(props(e, AL).stack().stackPrimarySizing == StackSize::FIXED);
  // Opacity takes a percentage.
  bind(e, R, "OPACITY", half);
  CHECK(props(e, R).opacity == 0.5);
  // Radii: uniform, then one corner on top.
  bind(e, R, "CORNER_RADIUS", radius);
  CHECK(props(e, R).cornerRadii == CornerRadii{8, 8, 8, 8});
  bind(e, R, "RECTANGLE_TOP_LEFT_CORNER_RADIUS", gap);
  CHECK(props(e, R).cornerRadii == CornerRadii{12, 8, 8, 8});
  bind(e, R, "VISIBLE", show);
  CHECK(!props(e, R).visible);
  bind(e, R, "STROKE_WEIGHT", radius);
  CHECK(props(e, R).strokeWeight == 8);
  // Text content and typography.
  bind(e, T, "TEXT_DATA", label);
  CHECK(props(e, T).text().textData.characters == "Hi there");
  bind(e, T, "FONT_SIZE", size);
  CHECK(props(e, T).text().fontSize == 24);
  bind(e, T, "FONT_FAMILY", family);
  bind(e, T, "FONT_STYLE", weight);
  CHECK(props(e, T).text().fontName.style == "Bold");
  CHECK(props(e, T).parameterConsumptionMap.back().data.kind == VariableData::Kind::FONT_STYLE);
  bind(e, T, "LINE_HEIGHT", gap);  // Auto line height becomes pixels
  CHECK(props(e, T).text().lineHeight.units == NumberUnits::PIXELS);
  CHECK(props(e, T).text().lineHeight.value == 12);
  // Wrong types are refused; a binding replaces the field's previous one.
  bind(e, R, "VISIBLE", gap, E_INVALID);
  bind(e, T, "TEXT_DATA", show, E_INVALID);
  size_t before = props(e, R).parameterConsumptionMap.size();
  bind(e, R, "OPACITY", radius);
  CHECK(props(e, R).parameterConsumptionMap.size() == before);
  CHECK(props(e, R).opacity == 0.08);
  // The reads.
  auto bound = e.boundVariables(R);
  bool sawOpacity = false;
  for (auto& b : bound)
    if (b.target == "OPACITY") {
      sawOpacity = true;
      CHECK(b.variable == radius);
      CHECK(b.ok);
      CHECK(b.resolved.f == 8);
    }
  CHECK(sawOpacity);
  Editor::Resolved r;
  CHECK(e.resolvedValue(T, "FONT_STYLE", r));
  CHECK(r.s == "Bold");
}

TEST_CASE("variables: effects and layout guides bind too") {
  Editor e = load(doc());
  auto [set, light, dark] = theme(e);
  Guid blur = variable(e, set, "FLOAT", "blur", "6");
  Guid shadow = variable(e, set, "COLOR", "shadow", R"({"r":0,"g":0,"b":0,"a":0.5})");
  Guid cols = variable(e, set, "FLOAT", "cols", "3.6");
  Effect fx;
  fx.type = EffectType::DROP_SHADOW;
  LayoutGrid g;
  g.type = LayoutGridType::STRETCH;
  g.numSections = 12;
  REQUIRE(e.setProps({F}, change(F_EFFECTS | F_LAYOUT_GRIDS, [&](NodeProps& p) {
    p.effects = {fx};
    p.rare().layoutGrids = {g};
  }), 0) == OK);
  bind(e, F, "effects[0].radius", blur);
  bind(e, F, "effects[0].color", shadow);
  bind(e, F, "layoutGrids[0].numSections", cols);
  CHECK(props(e, F).effects[0].radius == 6);
  CHECK(props(e, F).effects[0].color == Color{0, 0, 0, 0.5f});
  CHECK(props(e, F).rare().layoutGrids[0].numSections == 4);  // whole counts
  bind(e, F, "effects[3].radius", blur);               // no such effect: nothing happens
  CHECK(run(e, CommandId::BIND_VARIABLE, "{\"refs\":[" + q(F) + "],\"target\":\"effects[0].bogus\",\"variable\":" + q(blur) + "}") == E_INVALID);
  // Gradient stops.
  Paint grad;
  grad.type = PaintType::GRADIENT_LINEAR;
  grad.stops = {{Color{0, 0, 0, 1}, 0}, {Color{1, 1, 1, 1}, 1}};
  REQUIRE(e.setProps({R2}, change(F_FILLS, [&](NodeProps& p) { p.fillPaints = {grad}; }), 0) == OK);
  bind(e, R2, "fillPaints[0].stops[1].color", shadow);
  CHECK(props(e, R2).fillPaints[0].stops[1].color == Color{0, 0, 0, 0.5f});
  CHECK(props(e, R2).fillPaints[0].stopVars.size() == 2);
}

TEST_CASE("variables: a typed value, a changed colour or a detach command drops the binding and keeps the value") {
  Editor e = load(doc());
  auto [set, light, dark] = theme(e);
  Guid half = variable(e, set, "FLOAT", "half", "50");
  Guid bg = variable(e, set, "COLOR", "bg", R"({"r":1,"g":0,"b":0,"a":1})");
  bind(e, R, "OPACITY", half);
  bind(e, R, "fillPaints[0].color", bg);
  // The panel types an opacity: the variable is detached.
  REQUIRE(e.setProps({R}, change(F_OPACITY, [](NodeProps& p) { p.opacity = 0.3; }), 0) == OK);
  CHECK(props(e, R).opacity == doctest::Approx(0.3));
  CHECK(props(e, R).parameterConsumptionMap.empty());
  // A new colour in the picker for the bound fill: its colorVar goes.
  NodeProps now = props(e, R);
  now.fillPaints[0].color = kBlue;
  REQUIRE(e.setProps({R}, change(F_FILLS, [&](NodeProps& p) { p.fillPaints = now.fillPaints; }), 0) == OK);
  CHECK(fill(e, R) == kBlue);
  CHECK(!props(e, R).fillPaints[0].colorVar.present());
  // Changing the variable no longer reaches it.
  setValue(e, bg, light, R"({"r":0,"g":1,"b":0,"a":1})");
  CHECK(fill(e, R) == kBlue);
  // Detach keeps the resolved value.
  bind(e, R2, "fillPaints[0].color", bg);
  CHECK(fill(e, R2) == kGreen);
  CHECK(run(e, CommandId::DETACH_VARIABLE, "{\"refs\":[" + q(R2) + "],\"target\":\"fillPaints[0].color\"}") == OK);
  CHECK(fill(e, R2) == kGreen);
  CHECK(!props(e, R2).fillPaints[0].colorVar.present());
  // Resizing by hand detaches a bound width.
  Guid w = variable(e, set, "FLOAT", "w", "80");
  bind(e, R2, "WIDTH", w);
  CHECK(props(e, R2).size.x == 80);
  REQUIRE(e.setProps({R2}, change(F_SIZE, [](NodeProps& p) { p.size = {90, 50}; }), 0) == OK);
  CHECK(props(e, R2).size.x == 90);
  CHECK(props(e, R2).parameterConsumptionMap.empty());
}

TEST_CASE("variables: instances resolve their sublayers in their own modes; a value change reaches them") {
  Editor e = load(doc());
  auto [set, light, dark] = theme(e);
  Guid bg = variable(e, set, "COLOR", "bg", R"({"r":1,"g":0,"b":0,"a":1})");
  setValue(e, bg, dark, R"({"r":0,"g":0,"b":1,"a":1})");
  // A main with a bound rectangle, and an instance of it inside a Dark frame.
  const Guid M{2, 1}, MR{2, 2}, I{2, 3}, DF{2, 4};
  std::vector<NodeChange> add;
  NodeChange m = make(M, NodeType::SYMBOL, kPage, "$", {0, 600, 50, 50}, "Card");
  m.props.fillPaints.clear();
  add.push_back(m);
  add.push_back(make(MR, NodeType::ROUNDED_RECTANGLE, M, "!", {0, 0, 50, 50}, "Fill"));
  add.push_back(make(DF, NodeType::FRAME, kPage, "%", {200, 600, 100, 100}, "Dark frame"));
  NodeChange inst = make(I, NodeType::INSTANCE, DF, "!", {10, 10, 50, 50}, "Card");
  inst.props.comp().symbolData.symbolID = M;
  inst.props.fillPaints.clear();
  add.push_back(inst);
  REQUIRE(e.applyChanges(add, APPLY_USER) == OK);
  bind(e, MR, "fillPaints[0].color", bg);
  setMode(e, DF, set, dark);
  Guid row = derived::intern(I, {MR});
  REQUIRE(e.document().has(row));
  CHECK(fill(e, MR) == kRed);
  CHECK(fill(e, row) == kBlue);
  // A value change reaches the derived sublayer.
  setValue(e, bg, dark, R"({"r":0,"g":1,"b":0,"a":1})");
  CHECK(fill(e, row) == kGreen);
  CHECK(fill(e, MR) == kRed);
  // The instance's own mode (a root override) beats its frame's.
  setMode(e, I, set, light);
  CHECK(fill(e, row) == kRed);
  bool overridden = false;
  for (auto& o : props(e, I).comp().symbolData.overrides) overridden |= o.path.empty() && (o.mask & F_VARIABLE_MODES);
  CHECK(overridden);
  e.command(CommandId::UNDO);
  CHECK(fill(e, row) == kGreen);
  // A sublayer's own mode is an override.
  setMode(e, row, set, light);
  CHECK(fill(e, row) == kRed);
  e.command(CommandId::UNDO);
  // Editing a bound sublayer's colour detaches it there only (an override).
  NodeProps rp = props(e, row);
  rp.fillPaints[0].color = Color{1, 1, 0, 1};
  REQUIRE(e.setProps({row}, change(F_FILLS, [&](NodeProps& p) { p.fillPaints = rp.fillPaints; }), 0) == OK);
  CHECK(fill(e, row) == Color{1, 1, 0, 1});
  setValue(e, bg, dark, R"({"r":0,"g":0,"b":1,"a":1})");
  CHECK(fill(e, row) == Color{1, 1, 0, 1});
  CHECK(fill(e, MR) == kRed);
}

TEST_CASE("variables: modes — add copies the default's values, move sets the default, delete and duplicate") {
  Editor e = load(doc());
  auto [set, light, dark] = theme(e);
  Guid bg = variable(e, set, "COLOR", "bg", R"({"r":1,"g":0,"b":0,"a":1})");
  setValue(e, bg, dark, R"({"r":0,"g":0,"b":1,"a":1})");
  bind(e, R, "fillPaints[0].color", bg);
  REQUIRE(run(e, CommandId::ADD_VARIABLE_MODE, "{\"collection\":" + q(set) + "}") == OK);
  Guid third = e.lastCreated()[0];
  Editor::Resolved r;
  REQUIRE(e.resolveVariableInMode(bg, third, r));
  CHECK(r.c == kRed);  // the default mode's value
  CHECK(props(e, set).asset().variableSetModes.back().name == "Mode 3");
  // "Set as default": Dark first; Auto layers follow.
  CHECK(run(e, CommandId::MOVE_VARIABLE_MODE, "{\"collection\":" + q(set) + ",\"mode\":" + q(dark) + ",\"index\":0}") == OK);
  CHECK(props(e, set).defaultMode() == dark);
  CHECK(fill(e, R) == kBlue);
  // Duplicate Dark: its values.
  REQUIRE(run(e, CommandId::DUPLICATE_VARIABLE_MODE, "{\"collection\":" + q(set) + ",\"mode\":" + q(dark) + "}") == OK);
  Guid copy = e.lastCreated()[0];
  REQUIRE(e.resolveVariableInMode(bg, copy, r));
  CHECK(r.c == kBlue);
  bool named = false;
  for (auto& m : props(e, set).asset().variableSetModes) named |= m.id == copy && m.name == "Dark copy";
  CHECK(named);
  // A layer in the deleted mode falls back to the default.
  setMode(e, F, set, light);
  CHECK(fill(e, R) == kRed);
  CHECK(run(e, CommandId::DELETE_VARIABLE_MODE, "{\"collection\":" + q(set) + ",\"mode\":" + q(light) + "}") == OK);
  CHECK(fill(e, R) == kBlue);
  for (auto& v : props(e, bg).asset().variableDataValues) CHECK(v.modeID != light);
  // Names: ≤ 40 characters; the last mode can't go.
  CHECK(run(e, CommandId::RENAME_VARIABLE_MODE,
            "{\"collection\":" + q(set) + ",\"mode\":" + q(dark) + ",\"name\":\"" + std::string(41, 'x') + "\"}") == E_INVALID);
  CHECK(run(e, CommandId::DELETE_VARIABLE_MODE, "{\"collection\":" + q(set) + ",\"mode\":" + q(third) + "}") == OK);
  CHECK(run(e, CommandId::DELETE_VARIABLE_MODE, "{\"collection\":" + q(set) + ",\"mode\":" + q(copy) + "}") == OK);
  CHECK(run(e, CommandId::DELETE_VARIABLE_MODE, "{\"collection\":" + q(set) + ",\"mode\":" + q(dark) + "}") == E_INVALID);
}

TEST_CASE("variables: groups, order, duplicates and deletes (soft while referenced)") {
  Editor e = load(doc());
  auto [set, light, dark] = theme(e);
  Guid a = variable(e, set, "COLOR", "color/a", R"({"r":1,"g":0,"b":0,"a":1})");
  Guid b = variable(e, set, "COLOR", "color/b", R"({"r":0,"g":1,"b":0,"a":1})");
  Guid c = variable(e, set, "FLOAT", "space/c", "4");
  // New group with selection: inside the group they share.
  CHECK(run(e, CommandId::GROUP_VARIABLES, "{\"variables\":[" + q(a) + "," + q(b) + "],\"name\":\"brand\"}") == OK);
  CHECK(props(e, a).name == "color/brand/a");
  CHECK(run(e, CommandId::RENAME_VARIABLE_GROUP, "{\"collection\":" + q(set) + ",\"group\":\"color/brand\",\"name\":\"primary\"}") == OK);
  CHECK(props(e, b).name == "color/primary/b");
  CHECK(run(e, CommandId::UNGROUP_VARIABLES, "{\"collection\":" + q(set) + ",\"group\":\"color/primary\"}") == OK);
  CHECK(props(e, a).name == "color/a");
  // Order.
  CHECK(e.variablesOf(set) == std::vector<Guid>{a, b, c});
  CHECK(run(e, CommandId::MOVE_VARIABLES, "{\"variables\":[" + q(c) + "],\"index\":0}") == OK);
  CHECK(e.variablesOf(set) == std::vector<Guid>{c, a, b});
  CHECK(run(e, CommandId::MOVE_VARIABLES, "{\"variables\":[" + q(c) + "],\"index\":1,\"group\":\"color\"}") == OK);
  CHECK(props(e, c).name == "color/c");
  CHECK(e.variablesOf(set) == std::vector<Guid>{a, c, b});
  // Duplicates sit after their sources.
  CHECK(run(e, CommandId::DUPLICATE_VARIABLES, "{\"variables\":[" + q(a) + "]}") == OK);
  Guid a2 = e.lastCreated()[0];
  CHECK(props(e, a2).name == "color/a copy");
  CHECK(e.variablesOf(set) == std::vector<Guid>{a, a2, c, b});
  CHECK(run(e, CommandId::DUPLICATE_VARIABLE_GROUP, "{\"collection\":" + q(set) + ",\"group\":\"color\"}") == OK);
  CHECK(e.lastCreated().size() == 4);
  CHECK(props(e, e.lastCreated()[0]).name == "color copy/a");
  CHECK(run(e, CommandId::DELETE_VARIABLE_GROUP, "{\"collection\":" + q(set) + ",\"group\":\"color copy\"}") == OK);
  CHECK(e.variablesOf(set).size() == 4);
  // A bound variable is soft-deleted (the layer keeps working); an unused one is removed.
  bind(e, R, "fillPaints[0].color", a);
  CHECK(run(e, CommandId::DELETE_VARIABLES, "{\"variables\":[" + q(a) + "," + q(b) + "]}") == OK);
  CHECK(e.document().has(a));
  CHECK(props(e, a).comp().isSoftDeleted);
  CHECK(!e.document().has(b));
  CHECK(e.variablesOf(set) == std::vector<Guid>{a2, c});
  CHECK(fill(e, R) == kRed);
  e.command(CommandId::UNDO);
  CHECK(e.document().has(b));
  CHECK(!props(e, a).comp().isSoftDeleted);
  // A variable another aliases is referenced too.
  setValue(e, c, light, "8");
  Guid alias = variable(e, set, "COLOR", "alias", "{\"type\":\"VARIABLE_ALIAS\",\"id\":" + q(b) + "}");
  CHECK(run(e, CommandId::DELETE_VARIABLES, "{\"variables\":[" + q(b) + "]}") == OK);
  CHECK(props(e, b).comp().isSoftDeleted);
  (void)alias;
}

TEST_CASE("variables: collections — order, duplicate (aliases inside follow the copies), delete") {
  Editor e = load(doc());
  auto [set, light, dark] = theme(e);
  Guid base = variable(e, set, "COLOR", "base", R"({"r":1,"g":0,"b":0,"a":1})");
  Guid ref = variable(e, set, "COLOR", "ref", "{\"type\":\"VARIABLE_ALIAS\",\"id\":" + q(base) + "}");
  REQUIRE(run(e, CommandId::CREATE_VARIABLE_COLLECTION, "{}") == OK);
  Guid other = e.lastCreated()[0];
  CHECK(props(e, other).name == "Collection");
  CHECK(e.collections() == std::vector<Guid>{set, other});
  CHECK(run(e, CommandId::MOVE_VARIABLE_COLLECTION, "{\"collection\":" + q(other) + ",\"index\":0}") == OK);
  CHECK(e.collections() == std::vector<Guid>{other, set});
  REQUIRE(run(e, CommandId::DUPLICATE_VARIABLE_COLLECTION, "{\"collection\":" + q(set) + "}") == OK);
  Guid copy = e.lastCreated()[0];
  CHECK(props(e, copy).name == "Theme copy");
  CHECK(e.collections() == std::vector<Guid>{other, set, copy});
  auto vars = e.variablesOf(copy);
  REQUIRE(vars.size() == 2);
  CHECK(props(e, vars[1]).asset().variableDataValues[0].data.alias.guid == vars[0]);  // the copy's own base
  CHECK(props(e, copy).asset().variableSetModes[0].id != light);
  // Delete with a used variable: soft.
  bind(e, R, "fillPaints[0].color", ref);
  CHECK(run(e, CommandId::DELETE_VARIABLE_COLLECTION, "{\"collection\":" + q(set) + "}") == OK);
  CHECK(props(e, set).comp().isSoftDeleted);
  CHECK(e.collections() == std::vector<Guid>{other, copy});
  CHECK(fill(e, R) == kRed);
  CHECK(run(e, CommandId::DELETE_VARIABLE_COLLECTION, "{\"collection\":" + q(other) + "}") == OK);
  CHECK(!e.document().has(other));
}

TEST_CASE("styles: create from a layer and apply; edits reach users; styles hold variables; detach and delete keep values") {
  Editor e = load(doc());
  // A colour style from the rectangle's fill, applied to it.
  REQUIRE(run(e, CommandId::CREATE_STYLE, "{\"type\":\"FILL\",\"name\":\"Brand / Red\",\"from\":" + q(R) + ",\"apply\":true}") == OK);
  Guid s = e.lastCreated()[0];
  CHECK(props(e, s).asset().styleType == StyleType::FILL);
  CHECK(props(e, s).name == "Brand/Red");
  CHECK(e.document().parentOf(s) == kInternal);
  CHECK(props(e, R).refs().styleIdForFill.guid == s);
  CHECK(e.styleUsage(s) == 1);
  CHECK(run(e, CommandId::APPLY_STYLE, "{\"refs\":[" + q(R2) + "],\"style\":" + q(s) + "}") == OK);
  CHECK(e.styleUsage(s) == 2);
  e.takeEvents();
  // Editing the style updates both, in the same commit.
  REQUIRE(e.setProps({s}, change(F_FILLS, [](NodeProps& p) { p.fillPaints = {Paint::solid(kRed)}; }), 0) == OK);
  CHECK(fill(e, R) == kRed);
  CHECK(fill(e, R2) == kRed);
  auto ev = e.takeEvents();
  REQUIRE(ev.documents.size() == 1);
  CHECK(ev.documents[0].changes.size() == 3);
  CHECK(std::find(ev.styles.begin(), ev.styles.end(), s) != ev.styles.end());
  // A style bound to a variable: each user resolves it in its own mode.
  auto [set, light, dark] = theme(e);
  Guid bg = variable(e, set, "COLOR", "bg", R"({"r":0,"g":1,"b":0,"a":1})");
  setValue(e, bg, dark, R"({"r":0,"g":0,"b":1,"a":1})");
  bind(e, s, "fillPaints[0].color", bg);
  CHECK(fill(e, s) == kGreen);
  setMode(e, F, set, dark);
  CHECK(fill(e, R) == kBlue);
  CHECK(fill(e, R2) == kGreen);
  // Strokes take a colour style too.
  CHECK(run(e, CommandId::APPLY_STYLE, "{\"refs\":[" + q(R2) + "],\"style\":" + q(s) + ",\"target\":\"STROKE\"}") == OK);
  CHECK(props(e, R2).strokePaints.at(0).color == kGreen);
  CHECK(e.styleUsage(s) == 2);
  // A changed fill detaches the style.
  REQUIRE(e.setProps({R2}, change(F_FILLS, [](NodeProps& p) { p.fillPaints = {Paint::solid(kRed)}; }), 0) == OK);
  CHECK(!props(e, R2).refs().styleIdForFill.present());
  CHECK(props(e, R2).refs().styleIdForStrokeFill.present());
  // Detach keeps the values.
  CHECK(run(e, CommandId::DETACH_STYLE, "{\"refs\":[" + q(R2) + "],\"target\":\"STROKE\"}") == OK);
  CHECK(!props(e, R2).refs().styleIdForStrokeFill.present());
  CHECK(props(e, R2).strokePaints.at(0).color == kGreen);
  // Deleting the style detaches its users.
  CHECK(run(e, CommandId::DELETE_STYLE, "{\"style\":" + q(s) + "}") == OK);
  CHECK(!e.document().has(s));
  CHECK(!props(e, R).refs().styleIdForFill.present());
  CHECK(fill(e, R) == kBlue);
  e.command(CommandId::UNDO);
  CHECK(e.document().has(s));
  CHECK(props(e, R).refs().styleIdForFill.guid == s);
}

TEST_CASE("styles: text, effect and layout guide styles; order and folders") {
  Editor e = load(doc());
  REQUIRE(e.setProps({T}, change(F_FONT_SIZE | F_LINE_HEIGHT, [](NodeProps& p) {
    p.text().fontSize = 24;
    p.text().lineHeight = {32, NumberUnits::PIXELS};
  }), 0) == OK);
  REQUIRE(run(e, CommandId::CREATE_STYLE, "{\"type\":\"TEXT\",\"name\":\"Heading\",\"from\":" + q(T) + "}") == OK);
  Guid ts = e.lastCreated()[0];
  CHECK(props(e, ts).type == NodeType::TEXT);
  CHECK(props(e, ts).text().fontSize == 24);
  CHECK(props(e, ts).text().textData.characters == "Ag");
  // Applied to another text: its typography (not its colour).
  const Guid T2{3, 1};
  NodeChange t2 = make(T2, NodeType::TEXT, kPage, "$", {0, 700, 100, 20}, "Other");
  t2.props.text().textData.characters = "Other";
  t2.props.fillPaints = {Paint::solid(kBlue)};
  REQUIRE(e.applyChanges({t2}, APPLY_USER) == OK);
  CHECK(run(e, CommandId::APPLY_STYLE, "{\"refs\":[" + q(T2) + "],\"style\":" + q(ts) + "}") == OK);
  CHECK(props(e, T2).text().fontSize == 24);
  CHECK(props(e, T2).text().lineHeight == Number{32, NumberUnits::PIXELS});
  CHECK(fill(e, T2) == kBlue);
  // A text style with a variable: users resolve it.
  auto [set, light, dark] = theme(e);
  Guid size = variable(e, set, "FLOAT", "size", "40");
  bind(e, ts, "FONT_SIZE", size);
  CHECK(props(e, T2).text().fontSize == 40);
  // Changing a user's font size detaches its text style.
  REQUIRE(e.setProps({T2}, change(F_FONT_SIZE, [](NodeProps& p) { p.text().fontSize = 10; }), 0) == OK);
  CHECK(!props(e, T2).refs().styleIdForText.present());
  // Effect and layout guide styles (Figma's defaults).
  REQUIRE(run(e, CommandId::CREATE_STYLE, R"({"type":"EFFECT"})") == OK);
  Guid es = e.lastCreated()[0];
  CHECK(props(e, es).name == "Effect style");
  CHECK(props(e, es).effects.at(0).type == EffectType::DROP_SHADOW);
  REQUIRE(run(e, CommandId::CREATE_STYLE, R"({"type":"GRID","name":"Grid/8"})") == OK);
  Guid gs = e.lastCreated()[0];
  CHECK(run(e, CommandId::APPLY_STYLE, "{\"refs\":[" + q(F) + "],\"style\":" + q(es) + "}") == OK);
  CHECK(run(e, CommandId::APPLY_STYLE, "{\"refs\":[" + q(F) + "],\"style\":" + q(gs) + "}") == OK);
  CHECK(props(e, F).effects.size() == 1);
  CHECK(props(e, F).rare().layoutGrids.size() == 1);
  CHECK(run(e, CommandId::APPLY_STYLE, "{\"refs\":[" + q(F) + "],\"style\":" + q(ts) + "}") == OK);  // not a text: skipped
  CHECK(!props(e, F).refs().styleIdForText.present());
  // Lists and order.
  CHECK(e.stylesOf(StyleType::NONE) == std::vector<Guid>{ts, es, gs});
  CHECK(e.stylesOf(StyleType::EFFECT) == std::vector<Guid>{es});
  REQUIRE(run(e, CommandId::CREATE_STYLE, R"({"type":"EFFECT","name":"Second"})") == OK);
  Guid es2 = e.lastCreated()[0];
  CHECK(run(e, CommandId::MOVE_STYLE, "{\"style\":" + q(es2) + ",\"index\":0}") == OK);
  CHECK(e.stylesOf(StyleType::EFFECT) == std::vector<Guid>{es2, es});
  // Folders.
  CHECK(run(e, CommandId::GROUP_STYLES, "{\"styles\":[" + q(es) + "," + q(es2) + "],\"name\":\"Shadows\"}") == OK);
  CHECK(props(e, es).name == "Shadows/Effect style");
  CHECK(run(e, CommandId::RENAME_STYLE_GROUP, R"({"type":"EFFECT","group":"Shadows","name":"Elevation"})") == OK);
  CHECK(props(e, es2).name == "Elevation/Second");
  CHECK(run(e, CommandId::UNGROUP_STYLES, R"({"type":"EFFECT","group":"Elevation"})") == OK);
  CHECK(props(e, es2).name == "Second");
}

TEST_CASE("variables: undo restores the document exactly after any sequence of commands") {
  Editor e = load(doc());
  std::string original = encoded(e);
  auto [set, light, dark] = theme(e);
  Guid bg = variable(e, set, "COLOR", "bg", R"({"r":1,"g":0,"b":0,"a":1})");
  Guid gap = variable(e, set, "FLOAT", "gap", "10");
  setValue(e, bg, dark, R"({"r":0,"g":0,"b":1,"a":1})");
  bind(e, R, "fillPaints[0].color", bg);
  bind(e, AL, "STACK_SPACING", gap);
  setMode(e, F, set, dark);
  run(e, CommandId::CREATE_STYLE, "{\"type\":\"FILL\",\"from\":" + q(R) + ",\"apply\":true}");
  run(e, CommandId::GROUP_VARIABLES, "{\"variables\":[" + q(bg) + "],\"name\":\"g\"}");
  run(e, CommandId::DUPLICATE_VARIABLE_MODE, "{\"collection\":" + q(set) + ",\"mode\":" + q(dark) + "}");
  run(e, CommandId::DELETE_VARIABLES, "{\"variables\":[" + q(gap) + "]}");
  int steps = 0;
  while (e.canUndo() && steps < 100) e.command(CommandId::UNDO), steps++;
  CHECK(encoded(e) == original);
  while (e.canRedo()) e.command(CommandId::REDO);
  CHECK(fill(e, R) == kBlue);
  CHECK(props(e, AL).stack().stackSpacing == 10);
}

TEST_CASE("variables: encodeDocument round-trips; stale stored values are fixed when a file loads") {
  Editor e = load(doc());
  auto [set, light, dark] = theme(e);
  Guid bg = variable(e, set, "COLOR", "bg", R"({"r":1,"g":0,"b":0,"a":1})");
  setValue(e, bg, dark, R"({"r":0,"g":0,"b":1,"a":1})");
  bind(e, R, "fillPaints[0].color", bg);
  setMode(e, F, set, dark);
  run(e, CommandId::CREATE_STYLE, "{\"type\":\"FILL\",\"from\":" + q(R2) + ",\"apply\":true}");
  Guid style = e.lastCreated()[0];
  // Through JSON and back into a new editor.
  json::Writer w;
  codec::writeMessage(w, 1, e.encodeDocument());
  json::Value msg;
  REQUIRE(json::parse(w.take(), msg));
  auto nodes = codec::readMessage(msg);
  Editor f = load(nodes);
  CHECK(encoded(f) == encoded(e));
  CHECK(f.collections() == std::vector<Guid>{set});
  CHECK(fill(f, R) == kBlue);
  CHECK(f.styleUsage(style) == 1);
  // A file whose stored copy is stale: corrected on load, as one SYSTEM change.
  for (auto& n : nodes)
    if (n.guid == R) n.props.fillPaints[0].color = Color{1, 1, 1, 1};
  Editor g;
  g.setSessionID(1);
  g.loadDocument(nodes, kNoGuid);
  CHECK(fill(g, R) == kBlue);
  auto ev = g.takeEvents();
  REQUIRE(!ev.documents.empty());
  CHECK(ev.documents.back().kind == TxnKind::SYSTEM);
  // Changing the variable in the loaded file reaches the layer (dependencies are known after a load).
  setValue(g, bg, dark, R"({"r":0,"g":1,"b":0,"a":1})");
  CHECK(fill(g, R) == kGreen);
}

TEST_CASE("variables: Figma's encoding — library collections, variables and styles referenced by key resolve") {
  // As in a real .fig: the collection and the variable carry keys; layers and aliases reference them by assetRef.
  const char* json = R"({"nodeChanges":[
    {"guid":"0:0","phase":"CREATED","type":"DOCUMENT","name":"Document"},
    {"guid":"0:1","phase":"CREATED","type":"CANVAS","name":"Page 1","parentIndex":{"guid":"0:0","position":"!"},
     "variableModeBySetMap":{"entries":[{"variableSetID":{"assetRef":{"key":"setkey","version":"1:1"}},"variableModeID":"29:1"}]}},
    {"guid":"0:2","phase":"CREATED","type":"CANVAS","name":"Internal Only Canvas","internalOnly":true,"parentIndex":{"guid":"0:0","position":"~"}},
    {"guid":"3:1","phase":"CREATED","type":"VARIABLE_SET","name":"Anex","key":"setkey","sourceLibraryKey":"lk-1","parentIndex":{"guid":"0:2","position":"!"},
     "variableSetModes":[{"id":"29:0","name":"Light","sortPosition":"!"},{"id":"29:1","name":"Dark","sortPosition":"\""}]},
    {"guid":"3:2","phase":"CREATED","type":"VARIABLE","name":"Units/unit-4","key":"varkey","parentIndex":{"guid":"0:2","position":"\""},
     "variableSetID":{"assetRef":{"key":"setkey","version":"1:1"}},"variableResolvedType":"FLOAT",
     "variableDataValues":{"entries":[{"modeID":"29:0","variableData":{"value":{"floatValue":4},"dataType":"FLOAT","resolvedDataType":"FLOAT"}},
                                      {"modeID":"29:1","variableData":{"value":{"floatValue":16},"dataType":"FLOAT","resolvedDataType":"FLOAT"}}]}},
    {"guid":"3:3","phase":"CREATED","type":"ROUNDED_RECTANGLE","name":"Shadow","styleType":"EFFECT","key":"stylekey","parentIndex":{"guid":"0:2","position":"#"},
     "effects":[{"type":"DROP_SHADOW","radius":9,"color":{"r":0,"g":0,"b":0,"a":0.5},"offset":{"x":0,"y":2},"visible":true}]},
    {"guid":"1:1","phase":"CREATED","type":"FRAME","name":"Card","parentIndex":{"guid":"0:1","position":"!"},"size":{"x":100,"y":100},
     "stackMode":"VERTICAL","stackPrimarySizing":"FIXED","stackSpacing":0,
     "parameterConsumptionMap":{"entries":[{"variableField":"STACK_SPACING","variableData":{"value":{"alias":{"assetRef":{"key":"varkey","version":"8:1"}}},"dataType":"ALIAS","resolvedDataType":"FLOAT"}}]},
     "styleIdForEffect":{"assetRef":{"key":"stylekey","version":"1:2"}}}
  ]})";
  json::Value v;
  REQUIRE(json::parse(json, v));
  Editor e = load(codec::readMessage(v));
  CHECK(props(e, Guid{1, 1}).stack().stackSpacing == 16);  // the page is Dark
  CHECK(props(e, Guid{1, 1}).effects.size() == 1);
  CHECK(props(e, Guid{1, 1}).effects[0].radius == 9);
  CHECK(e.styleUsage(Guid{3, 3}) == 1);
  CHECK(e.variablesOf(Guid{3, 1}) == std::vector<Guid>{Guid{3, 2}});
  auto bound = e.boundVariables(Guid{1, 1});
  REQUIRE(bound.size() == 1);
  CHECK(bound[0].variable == Guid{3, 2});
  // The page back to Light (Auto): the frame follows.
  CHECK(e.command(CommandId::SET_VARIABLE_MODE, args(R"({"page":"0:1","collection":"3:1","mode":""})")) == OK);
  CHECK(props(e, Guid{1, 1}).stack().stackSpacing == 4);
}

TEST_CASE("variables: a mode switch on a page of many bound layers re-resolves them by dependency") {
  auto nodes = baseChanges();
  const int kLayers = 10000;
  nodes.push_back(make(F, NodeType::FRAME, kPage, "!", {0, 0, 4000, 4000}, "Frame"));
  Editor e = load(nodes);
  auto [set, light, dark] = theme(e);
  Guid bg = variable(e, set, "COLOR", "bg", R"({"r":1,"g":0,"b":0,"a":1})");
  setValue(e, bg, dark, R"({"r":0,"g":0,"b":1,"a":1})");
  std::vector<NodeChange> many;
  for (int i = 0; i < kLayers; i++) {
    NodeChange c = make({4, static_cast<uint32_t>(i + 1)}, NodeType::ROUNDED_RECTANGLE, F, std::to_string(i),
                        {static_cast<double>(i % 100) * 40, static_cast<double>(i / 100) * 40, 30, 30});
    c.props.fillPaints[0].colorVar = VariableData::aliasOf(bg, VariableResolvedType::COLOR);
    many.push_back(c);
  }
  REQUIRE(e.applyChanges(many, APPLY_USER) == OK);
  CHECK(fill(e, Guid{4, 1}) == kRed);
  auto t0 = std::chrono::steady_clock::now();
  setMode(e, F, set, dark);
  double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
  CHECK(fill(e, Guid{4, 1}) == kBlue);
  CHECK(fill(e, Guid{4, static_cast<uint32_t>(kLayers)}) == kBlue);
  MESSAGE("mode switch, " << kLayers << " bound layers: " << ms << " ms");
  // A value edit reaches them all, too.
  t0 = std::chrono::steady_clock::now();
  setValue(e, bg, dark, R"({"r":0,"g":1,"b":0,"a":1})");
  ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
  CHECK(fill(e, Guid{4, 5000}) == kGreen);
  MESSAGE("value edit, " << kLayers << " bound layers: " << ms << " ms");
}

TEST_CASE("variables: undo of a creation is an event too (the panels refresh)") {
  Editor e = load(doc());
  auto [set, light, dark] = theme(e);
  Guid bg = variable(e, set, "COLOR", "bg", R"({"r":1,"g":0,"b":0,"a":1})");
  e.takeEvents();
  e.command(CommandId::UNDO);
  CHECK(!e.document().has(bg));
  auto ev = e.takeEvents();
  CHECK(std::find(ev.variables.begin(), ev.variables.end(), bg) != ev.variables.end());
  CHECK(std::find(ev.collections.begin(), ev.collections.end(), set) != ev.collections.end());
  e.command(CommandId::UNDO);  // the Dark mode
  e.command(CommandId::UNDO);  // the rename
  e.command(CommandId::UNDO);  // the collection
  ev = e.takeEvents();
  CHECK(!e.document().has(set));
  CHECK(std::find(ev.collections.begin(), ev.collections.end(), set) != ev.collections.end());
}

// ---- The C ABI ----

using Ptr = uintptr_t;
using Handle = uintptr_t;
extern "C" {
Ptr engine_result_ptr();
uint32_t engine_result_len();
Handle engine_create(const char* selector, Ptr optsPtr, uint32_t optsLen);
void engine_destroy(Handle h);
int32_t engine_load(Handle h, Ptr ptr, uint32_t len);
int32_t engine_command(Handle h, uint32_t commandId, Ptr argsPtr, uint32_t argsLen);
int32_t engine_take_events(Handle h);
int32_t engine_variable_collections(Handle h, uint32_t flags);
int32_t engine_variables(Handle h, Ptr collPtr, uint32_t collLen, uint32_t flags);
int32_t engine_variable(Handle h, Ptr idPtr, uint32_t idLen);
int32_t engine_resolve_variable(Handle h, Ptr varPtr, uint32_t varLen, Ptr consumerPtr, uint32_t consumerLen);
int32_t engine_bound_variables(Handle h, Ptr refPtr, uint32_t refLen);
int32_t engine_resolved_value(Handle h, Ptr refPtr, uint32_t refLen, Ptr targetPtr, uint32_t targetLen);
int32_t engine_variable_modes(Handle h, Ptr refPtr, uint32_t refLen);
int32_t engine_styles(Handle h, uint32_t type, uint32_t flags);
int32_t engine_style_usage(Handle h, Ptr idPtr, uint32_t idLen);
}

namespace {
struct Text {
  std::string s;
  Ptr ptr() const { return reinterpret_cast<Ptr>(s.data()); }
  uint32_t len() const { return static_cast<uint32_t>(s.size()); }
};
json::Value resultJson() {
  json::Value v;
  REQUIRE(json::parse(std::string(reinterpret_cast<const char*>(engine_result_ptr()), engine_result_len()), v));
  return v;
}
int32_t cmd(Handle h, CommandId id, const std::string& a) {
  Text t{a};
  return engine_command(h, static_cast<uint32_t>(id), t.ptr(), t.len());
}
std::string createdId(size_t i = 0) {
  json::Value v = resultJson();
  const json::Value* list = v.get("created");
  REQUIRE(list);
  REQUIRE(list->array.size() > i);
  return list->array[i].string;
}
}  // namespace

TEST_CASE("variables: the C ABI — created ids, collections, variables, resolution, bindings, modes, styles, events") {
  Text opts{R"({"sessionID":3})"};
  Handle h = engine_create(nullptr, opts.ptr(), opts.len());
  REQUIRE(h);
  Text d{codec::writeMessage(0, doc())};
  REQUIRE(engine_load(h, d.ptr(), d.len()) == OK);
  engine_take_events(h);
  REQUIRE(cmd(h, CommandId::CREATE_VARIABLE_COLLECTION, R"({"name":"Theme"})") == OK);
  std::string set = createdId(0), light = createdId(1);
  REQUIRE(cmd(h, CommandId::ADD_VARIABLE_MODE, "{\"collection\":\"" + set + "\",\"name\":\"Dark\"}") == OK);
  std::string dark = createdId();
  REQUIRE(cmd(h, CommandId::CREATE_VARIABLE, "{\"collection\":\"" + set + R"(","type":"COLOR","name":"bg","value":{"r":1,"g":0,"b":0,"a":1}})") == OK);
  std::string bg = createdId();
  REQUIRE(cmd(h, CommandId::CREATE_VARIABLE, "{\"collection\":\"" + set + R"(","type":"COLOR","name":"ref","value":{"type":"VARIABLE_ALIAS","id":")" + bg + "\"}}") == OK);
  std::string ref = createdId();
  REQUIRE(cmd(h, CommandId::SET_VARIABLE_VALUE, "{\"variable\":\"" + bg + "\",\"mode\":\"" + dark + R"(","value":{"r":0,"g":0,"b":1,"a":1}})") == OK);
  REQUIRE(cmd(h, CommandId::BIND_VARIABLE, "{\"refs\":[\"1:2\"],\"target\":\"fillPaints[0].color\",\"variable\":\"" + ref + "\"}") == OK);
  REQUIRE(cmd(h, CommandId::SET_VARIABLE_MODE, "{\"refs\":[\"1:1\"],\"collection\":\"" + set + "\",\"mode\":\"" + dark + "\"}") == OK);
  // Events.
  REQUIRE(engine_take_events(h) == OK);
  std::string events(reinterpret_cast<const char*>(engine_result_ptr()), engine_result_len());
  CHECK(events.find("\"VARIABLES_CHANGED\"") != std::string::npos);
  // Collections.
  REQUIRE(engine_variable_collections(h, 0) == OK);
  json::Value cols = resultJson();
  REQUIRE(cols.array.size() == 1);
  CHECK(cols.array[0].get("name")->string == "Theme");
  CHECK(cols.array[0].get("defaultModeId")->string == light);
  CHECK(cols.array[0].get("modes")->array.size() == 2);
  CHECK(cols.array[0].get("variableIds")->array.size() == 2);
  // Variables (values in Figma's shapes, resolved per mode).
  Text s{set};
  REQUIRE(engine_variables(h, s.ptr(), s.len(), 0) == OK);
  json::Value vars = resultJson();
  REQUIRE(vars.array.size() == 2);
  const json::Value& refInfo = vars.array[1];
  CHECK(refInfo.get("resolvedType")->string == "COLOR");
  const json::Value* aliasValue = refInfo.get("valuesByMode")->get(light);
  REQUIRE(aliasValue);
  CHECK(aliasValue->get("type")->string == "VARIABLE_ALIAS");
  CHECK(aliasValue->get("id")->string == bg);
  CHECK(refInfo.get("resolvedValuesByMode")->get(dark)->get("b")->number == 1);
  CHECK(refInfo.get("scopes")->array[0].string == "ALL_SCOPES");
  Text r{ref};
  REQUIRE(engine_variable(h, r.ptr(), r.len()) == OK);
  CHECK(resultJson().get("name")->string == "ref");
  // Resolution for a consumer.
  Text consumer{"1:2"};
  REQUIRE(engine_resolve_variable(h, r.ptr(), r.len(), consumer.ptr(), consumer.len()) == OK);
  CHECK(resultJson().get("b")->number == 1);
  REQUIRE(engine_resolve_variable(h, r.ptr(), r.len(), 0, 0) == OK);
  CHECK(resultJson().get("r")->number == 1);
  // Bindings.
  REQUIRE(engine_bound_variables(h, consumer.ptr(), consumer.len()) == OK);
  json::Value bound = resultJson();
  REQUIRE(bound.array.size() == 1);
  CHECK(bound.array[0].get("target")->string == "fillPaints[0].color");
  CHECK(bound.array[0].get("variable")->string == ref);
  CHECK(bound.array[0].get("resolved")->get("b")->number == 1);
  Text target{"fillPaints[0].color"};
  REQUIRE(engine_resolved_value(h, consumer.ptr(), consumer.len(), target.ptr(), target.len()) == OK);
  CHECK(resultJson().get("b")->number == 1);
  // Modes.
  Text frame{"1:1"};
  REQUIRE(engine_variable_modes(h, frame.ptr(), frame.len()) == OK);
  json::Value modes = resultJson();
  REQUIRE(modes.array.size() == 1);
  CHECK(modes.array[0].get("explicitModeId")->string == dark);
  REQUIRE(engine_variable_modes(h, consumer.ptr(), consumer.len()) == OK);
  modes = resultJson();
  CHECK(modes.array[0].get("explicitModeId")->isNull());
  CHECK(modes.array[0].get("resolvedModeId")->string == dark);
  // Styles.
  REQUIRE(cmd(h, CommandId::CREATE_STYLE, R"({"type":"FILL","name":"Brand","from":"1:2","apply":true})") == OK);
  std::string style = createdId();
  REQUIRE(engine_styles(h, 0, 0) == OK);
  json::Value styles = resultJson();
  REQUIRE(styles.array.size() == 1);
  CHECK(styles.array[0].get("styleType")->string == "FILL");
  CHECK(styles.array[0].get("usageCount")->number == 1);
  CHECK(styles.array[0].get("fillPaints")->array.size() == 1);
  CHECK(styles.array[0].get("boundVariables")->array.size() == 1);
  REQUIRE(engine_styles(h, static_cast<uint32_t>(StyleType::TEXT), 0) == OK);
  CHECK(resultJson().array.empty());
  Text st{style};
  CHECK(engine_style_usage(h, st.ptr(), st.len()) == 1);
  engine_destroy(h);
}

TEST_CASE("variables: an instance lays its sublayers out with values resolved in its own modes") {
  Editor e = load(doc());
  auto [set, light, dark] = theme(e);
  Guid pad = variable(e, set, "FLOAT", "pad", "16");
  setValue(e, pad, dark, "32");
  const Guid M{2, 1}, MT{2, 2}, DF{2, 4};
  std::vector<NodeChange> add;
  NodeChange m = make(M, NodeType::SYMBOL, kPage, "$", {0, 600, 200, 100}, "Card");
  m.props.stack().stackMode = StackMode::VERTICAL;
  m.props.stack().stackPrimarySizing = StackSize::FIXED;
  m.props.stack().stackPaddingLeft = m.props.stack().stackPaddingTop = 16;
  add.push_back(m);
  add.push_back(make(MT, NodeType::ROUNDED_RECTANGLE, M, "!", {16, 16, 50, 20}, "Bar"));
  add.push_back(make(DF, NodeType::FRAME, kPage, "%", {300, 600, 400, 300}, "Dark frame"));
  REQUIRE(e.applyChanges(add, APPLY_USER) == OK);
  bind(e, M, "STACK_PADDING_LEFT", pad);
  CHECK(run(e, CommandId::INSERT_INSTANCE, "{\"main\":" + q(M) + ",\"x\":400,\"y\":700,\"parent\":" + q(DF) + "}") == OK);
  Guid inst = e.selection().at(0);
  Guid bar = derived::intern(inst, {MT});
  CHECK(props(e, bar).transform.m02 == 16);
  setMode(e, DF, set, dark);
  CHECK(props(e, inst).stack().stackPaddingLeft == 32);
  CHECK(props(e, bar).transform.m02 == 32);
  CHECK(props(e, MT).transform.m02 == 16);
}

TEST_CASE("variables: commands inside an open transaction apply live and are one undo step (a scrub)") {
  Editor e = load(doc());
  auto [set, light, dark] = theme(e);
  Guid bg = variable(e, set, "COLOR", "bg", R"({"r":1,"g":0,"b":0,"a":1})");
  bind(e, R, "fillPaints[0].color", bg);
  size_t steps = e.undoStack().undoCount();
  REQUIRE(e.txnBegin("Edit variable") == OK);
  setValue(e, bg, light, R"({"r":0,"g":0.5,"b":0,"a":1})");
  CHECK(fill(e, R) == Color{0, 0.5f, 0, 1});  // live
  setValue(e, bg, light, R"({"r":0,"g":1,"b":0,"a":1})");
  CHECK(fill(e, R) == kGreen);
  REQUIRE(e.txnCommit() == OK);
  CHECK(e.undoStack().undoCount() == steps + 1);
  e.command(CommandId::UNDO);
  CHECK(fill(e, R) == kRed);
}

TEST_CASE("variables: a field set to null in an update clears it, modelled or not") {
  json::Value v;
  REQUIRE(json::parse(R"({"guid":"1:2","styleIdForFill":null,"exportSettings":null,"variableScopes":null})", v));
  NodeChange c;
  REQUIRE(codec::readChange(v, c));
  CHECK((c.mask & F_STYLE_ID_FILL));
  CHECK(!c.props.refs().styleIdForFill.present());
  CHECK((c.mask & F_VARIABLE_SCOPES));
  CHECK(!c.props.asset().variableScopes.has_value());
  REQUIRE((c.mask & F_EXTRA));
  CHECK(c.props.extra.at("exportSettings").empty());  // removes the key when applied
  Editor e = load(doc());
  REQUIRE(run(e, CommandId::CREATE_STYLE, "{\"type\":\"FILL\",\"from\":" + q(R) + ",\"apply\":true}") == OK);
  NodeChange ex = NodeChange::changed(R);
  ex.mask = F_EXTRA;
  ex.props.extra["exportSettings"] = "[]";
  REQUIRE(e.setProps({R}, ex, 0) == OK);
  CHECK(props(e, R).extra.count("exportSettings"));
  c.guid = R;
  REQUIRE(e.applyChanges({c}, APPLY_USER) == OK);
  CHECK(!props(e, R).refs().styleIdForFill.present());
  CHECK(!props(e, R).extra.count("exportSettings"));
}

// Figma's files keep an instance's slot content under the Internal Only Canvas (isSlotContent), named by the
// instance's SLOT assignment (varValue.slotContentIdValue); the slot layer in the main is only bound to the property
// (no isSlot). The content's variables resolve where the slot shows it: the instance's modes, the page's — what
// Figma stored (a private test file: frames bound to "Table/Padding" stored 3 = the page's "md", read 0 = the
// default mode's, before this).
TEST_CASE("variables: slot content in Figma's form resolves in the modes of the slot that shows it") {
  const char* json = R"([
    {"guid":"0:0","phase":"CREATED","type":"DOCUMENT","name":"Document"},
    {"guid":"0:1","phase":"CREATED","type":"CANVAS","name":"Page","parentIndex":{"guid":"0:0","position":"!"},
     "variableModeBySetMap":{"entries":[{"variableSetID":{"guid":"5:1"},"variableModeID":"5:3"}]}},
    {"guid":"0:3","phase":"CREATED","type":"CANVAS","name":"Other","parentIndex":{"guid":"0:0","position":"\""}},
    {"guid":"0:2","phase":"CREATED","type":"CANVAS","name":"Internal Only Canvas","internalOnly":true,"parentIndex":{"guid":"0:0","position":"#"}},
    {"guid":"5:1","phase":"CREATED","type":"VARIABLE_SET","name":"Sizing","parentIndex":{"guid":"0:2","position":"!"},
     "variableSetModes":[{"id":"5:2","name":"none","sortPosition":"!"},{"id":"5:3","name":"md","sortPosition":"\""}]},
    {"guid":"5:4","phase":"CREATED","type":"VARIABLE","name":"Table/Padding","parentIndex":{"guid":"0:2","position":"\""},
     "variableSetID":{"guid":"5:1"},"variableResolvedType":"FLOAT",
     "variableDataValues":{"entries":[
       {"modeID":"5:2","variableData":{"value":{"floatValue":0},"dataType":"FLOAT","resolvedDataType":"FLOAT"}},
       {"modeID":"5:3","variableData":{"value":{"floatValue":3},"dataType":"FLOAT","resolvedDataType":"FLOAT"}}]}},
    {"guid":"2:1","phase":"CREATED","type":"SYMBOL","name":"Item","parentIndex":{"guid":"0:3","position":"!"},
     "size":{"x":200,"y":100},"transform":{"m00":1,"m01":0,"m02":0,"m10":0,"m11":1,"m12":500},
     "componentPropDefs":[{"id":"2:9","name":"buttons","type":"SLOT","initialValue":{},"sortPosition":"!"}]},
    {"guid":"2:2","phase":"CREATED","type":"FRAME","name":"buttons","parentIndex":{"guid":"2:1","position":"!"},
     "size":{"x":100,"y":40},
     "parameterConsumptionMap":{"entries":[{"variableField":"SLOT_CONTENT_ID",
       "variableData":{"value":{"propRefValue":{"defId":"2:9"}},"dataType":"PROP_REF","resolvedDataType":"SLOT_CONTENT_ID"}}]}},
    {"guid":"3:1","phase":"CREATED","type":"INSTANCE","name":"Item","parentIndex":{"guid":"0:1","position":"!"},
     "size":{"x":200,"y":100},"symbolData":{"symbolID":"2:1"},
     "componentPropAssignments":[{"defID":"2:9","value":{},"varValue":{"value":{"slotContentIdValue":{"guid":"4:1"}},
       "dataType":"SLOT_CONTENT_ID","resolvedDataType":"SLOT_CONTENT_ID"}}]},
    {"guid":"3:2","phase":"CREATED","type":"INSTANCE","name":"Item","parentIndex":{"guid":"0:3","position":"\""},
     "size":{"x":200,"y":100},"symbolData":{"symbolID":"2:1"},
     "componentPropAssignments":[{"defID":"2:9","value":{},"varValue":{"value":{"slotContentIdValue":{"guid":"4:3"}},
       "dataType":"SLOT_CONTENT_ID","resolvedDataType":"SLOT_CONTENT_ID"}}]},
    {"guid":"4:1","phase":"CREATED","type":"FRAME","name":"buttons","isSlotContent":true,"parentIndex":{"guid":"0:2","position":"$"},
     "size":{"x":100,"y":40}},
    {"guid":"4:2","phase":"CREATED","type":"FRAME","name":"content","parentIndex":{"guid":"4:1","position":"!"},
     "size":{"x":60,"y":20},"stackMode":"HORIZONTAL","stackHorizontalPadding":3,
     "parameterConsumptionMap":{"entries":[{"variableField":"STACK_PADDING_LEFT",
       "variableData":{"value":{"alias":{"guid":"5:4"}},"dataType":"ALIAS","resolvedDataType":"FLOAT"}}]}},
    {"guid":"4:3","phase":"CREATED","type":"FRAME","name":"buttons","isSlotContent":true,"parentIndex":{"guid":"0:2","position":"%"},
     "size":{"x":100,"y":40}},
    {"guid":"4:4","phase":"CREATED","type":"FRAME","name":"content","parentIndex":{"guid":"4:3","position":"!"},
     "size":{"x":60,"y":20},"stackMode":"HORIZONTAL","stackHorizontalPadding":7,
     "parameterConsumptionMap":{"entries":[{"variableField":"STACK_PADDING_LEFT",
       "variableData":{"value":{"alias":{"guid":"5:4"}},"dataType":"ALIAS","resolvedDataType":"FLOAT"}}]}}
  ])";
  json::Value v;
  REQUIRE(json::parse(json, v));
  Editor e;
  e.setSessionID(1);
  e.setViewport(800, 600, 1, 800, 600);
  e.loadDocument(codec::readChanges(v), Guid{0, 1});
  e.takeEvents();
  const Guid page{0, 1}, other{0, 3}, set{5, 1}, none{5, 2}, md{5, 3};
  // Hosted by the instance on the shown page: the page's "md".
  CHECK(props(e, {4, 2}).stack().stackPaddingLeft == 3);
  CHECK(e.resolvedMode({4, 2}, set) == md);
  // Its slot's instance is on a page not shown yet: the value Figma stored stays (it is not re-resolved where the
  // content is parked, the internal canvas's default mode).
  CHECK(props(e, {4, 4}).stack().stackPaddingLeft == 7);
  // Shown: resolved where its slot is (that page has no explicit mode: the default).
  REQUIRE(e.setCurrentPage(other) == OK);
  CHECK(props(e, {4, 4}).stack().stackPaddingLeft == 0);
  // The host's modes change: the content follows.
  setMode(e, page, set, none);
  CHECK(props(e, {4, 2}).stack().stackPaddingLeft == 0);
  setMode(e, page, set, md);
  CHECK(props(e, {4, 2}).stack().stackPaddingLeft == 3);
  // And the assignment keeps Figma's slotContentIdValue through the engine's own snapshot.
  std::string bytes = codec::writeMessage(1, e.encodeDocument());
  codec::KiwiMessage back;
  REQUIRE(codec::readMessage(bytes, back));
  bool found = false;
  for (const NodeChange& c : back.changes)
    if (c.guid == Guid{3, 1}) found = codec::assignmentSlotContent(c.props.comp().componentPropAssignments.at(0).extra) == Guid{4, 1};
  CHECK(found);
}

TEST_CASE("variables: Figma-form slot content is drawn in its slot and resolved in the slot's own modes") {
  // As a .fig imported before the import adopted it: the content on the Internal Only Canvas, the slot frame marked by
  // its SLOT_CONTENT_ID binding alone, the instance's assignment by varValue.slotContentIdValue. The slot frame sets
  // its own mode ("none") under a page in "md".
  const char* json = R"([
    {"guid":"0:0","phase":"CREATED","type":"DOCUMENT","name":"Document"},
    {"guid":"0:1","phase":"CREATED","type":"CANVAS","name":"Page","parentIndex":{"guid":"0:0","position":"!"},
     "variableModeBySetMap":{"entries":[{"variableSetID":{"guid":"5:1"},"variableModeID":"5:3"}]}},
    {"guid":"0:2","phase":"CREATED","type":"CANVAS","name":"Internal Only Canvas","internalOnly":true,"parentIndex":{"guid":"0:0","position":"#"}},
    {"guid":"5:1","phase":"CREATED","type":"VARIABLE_SET","name":"Sizing","parentIndex":{"guid":"0:2","position":"!"},
     "variableSetModes":[{"id":"5:2","name":"none","sortPosition":"!"},{"id":"5:3","name":"md","sortPosition":"\""}]},
    {"guid":"5:4","phase":"CREATED","type":"VARIABLE","name":"Table/Padding","parentIndex":{"guid":"0:2","position":"\""},
     "variableSetID":{"guid":"5:1"},"variableResolvedType":"FLOAT",
     "variableDataValues":{"entries":[
       {"modeID":"5:2","variableData":{"value":{"floatValue":1},"dataType":"FLOAT","resolvedDataType":"FLOAT"}},
       {"modeID":"5:3","variableData":{"value":{"floatValue":3},"dataType":"FLOAT","resolvedDataType":"FLOAT"}}]}},
    {"guid":"2:1","phase":"CREATED","type":"SYMBOL","name":"Item","parentIndex":{"guid":"0:1","position":"!"},
     "size":{"x":200,"y":100},"transform":{"m00":1,"m01":0,"m02":0,"m10":0,"m11":1,"m12":500},
     "componentPropDefs":[{"id":"2:9","name":"buttons","type":"SLOT","initialValue":{},"sortPosition":"!"}]},
    {"guid":"2:2","phase":"CREATED","type":"FRAME","name":"buttons","parentIndex":{"guid":"2:1","position":"!"},
     "size":{"x":100,"y":40},"transform":{"m00":1,"m01":0,"m02":30,"m10":0,"m11":1,"m12":20},
     "variableModeBySetMap":{"entries":[{"variableSetID":{"guid":"5:1"},"variableModeID":"5:2"}]},
     "parameterConsumptionMap":{"entries":[{"variableField":"SLOT_CONTENT_ID",
       "variableData":{"value":{"propRefValue":{"defId":"2:9"}},"dataType":"PROP_REF","resolvedDataType":"SLOT_CONTENT_ID"}}]}},
    {"guid":"2:3","phase":"CREATED","type":"ROUNDED_RECTANGLE","name":"default","parentIndex":{"guid":"2:2","position":"!"},
     "size":{"x":10,"y":10}},
    {"guid":"3:1","phase":"CREATED","type":"INSTANCE","name":"Item","parentIndex":{"guid":"0:1","position":"\""},
     "size":{"x":200,"y":100},"symbolData":{"symbolID":"2:1"},
     "componentPropAssignments":[{"defID":"2:9","value":{},"varValue":{"value":{"slotContentIdValue":{"guid":"4:1"}},
       "dataType":"SLOT_CONTENT_ID","resolvedDataType":"SLOT_CONTENT_ID"}}]},
    {"guid":"4:1","phase":"CREATED","type":"FRAME","name":"buttons","isSlotContent":true,"parentIndex":{"guid":"0:2","position":"$"},
     "size":{"x":100,"y":40}},
    {"guid":"4:2","phase":"CREATED","type":"FRAME","name":"content","parentIndex":{"guid":"4:1","position":"!"},
     "size":{"x":60,"y":20},"stackMode":"HORIZONTAL","stackHorizontalPadding":3,
     "parameterConsumptionMap":{"entries":[{"variableField":"STACK_PADDING_LEFT",
       "variableData":{"value":{"alias":{"guid":"5:4"}},"dataType":"ALIAS","resolvedDataType":"FLOAT"}}]}}
  ])";
  json::Value v;
  REQUIRE(json::parse(json, v));
  Editor e;
  e.setSessionID(1);
  e.setViewport(800, 600, 1, 800, 600);
  e.loadDocument(codec::readChanges(v), Guid{0, 1});
  e.takeEvents();
  const Guid inst{3, 1}, content{4, 1}, set{5, 1}, none{5, 2};
  // Drawn in its slot: a layer of the instance, over the slot row; the slot shows it instead of the main's children.
  REQUIRE(e.document().has(content));
  CHECK(e.document().get(content)->props.parentIndex.guid == inst);
  const Guid slotRow = derived::intern(inst, {Guid{2, 2}});
  REQUIRE(e.document().has(slotRow));
  CHECK(e.document().worldBounds(content) == e.document().worldBounds(slotRow));
  CHECK(!e.document().has(derived::intern(inst, {Guid{2, 3}})));
  // Resolved in the slot's modes (the slot's own "none"), not the page's "md".
  CHECK(e.resolvedMode({4, 2}, set) == none);
  CHECK(props(e, {4, 2}).stack().stackPaddingLeft == 1);
  // The assignment keeps Figma's slotContentIdValue.
  CHECK(codec::assignmentSlotContent(props(e, inst).comp().componentPropAssignments.at(0).extra) == content);
}

TEST_CASE("variables: soft-deleted variables, collections and styles stay at load; unused deleted mains go") {
  const char* json = R"([
    {"guid":"0:0","phase":"CREATED","type":"DOCUMENT","name":"Document"},
    {"guid":"0:1","phase":"CREATED","type":"CANVAS","name":"Page","parentIndex":{"guid":"0:0","position":"!"},
     "variableModeBySetMap":{"entries":[{"variableSetID":{"guid":"5:1"},"variableModeID":"5:3"}]}},
    {"guid":"0:2","phase":"CREATED","type":"CANVAS","name":"Internal Only Canvas","internalOnly":true,"parentIndex":{"guid":"0:0","position":"\""}},
    {"guid":"5:1","phase":"CREATED","type":"VARIABLE_SET","name":"1 - Color","isSoftDeleted":true,"parentIndex":{"guid":"0:2","position":"!"},
     "variableSetModes":[{"id":"5:2","name":"White","sortPosition":"!"},{"id":"5:3","name":"Primary","sortPosition":"\""}]},
    {"guid":"5:4","phase":"CREATED","type":"VARIABLE","name":"Select","parentIndex":{"guid":"0:2","position":"\""},
     "variableSetID":{"guid":"5:1"},"variableResolvedType":"STRING",
     "variableDataValues":{"entries":[
       {"modeID":"5:2","variableData":{"value":{"textValue":"White"},"dataType":"STRING","resolvedDataType":"STRING"}},
       {"modeID":"5:3","variableData":{"value":{"textValue":"Primary"},"dataType":"STRING","resolvedDataType":"STRING"}}]}},
    {"guid":"5:5","phase":"CREATED","type":"VARIABLE","name":"old","isSoftDeleted":true,"parentIndex":{"guid":"0:2","position":"#"},
     "variableSetID":{"guid":"5:1"},"variableResolvedType":"FLOAT"},
    {"guid":"6:1","phase":"CREATED","type":"TEXT","name":"ds","styleType":"TEXT","isSoftDeleted":true,"parentIndex":{"guid":"0:2","position":"$"}},
    {"guid":"7:1","phase":"CREATED","type":"SYMBOL","name":"Gone","isSoftDeleted":true,"parentIndex":{"guid":"0:2","position":"%"},"size":{"x":10,"y":10}},
    {"guid":"7:2","phase":"CREATED","type":"SYMBOL","name":"Published","isSoftDeleted":true,"publishedVersion":"abc","parentIndex":{"guid":"0:2","position":"&"},"size":{"x":10,"y":10}},
    {"guid":"1:1","phase":"CREATED","type":"TEXT","name":"Primary","parentIndex":{"guid":"0:1","position":"!"},"size":{"x":50,"y":20},
     "textData":{"characters":"Primary"},
     "parameterConsumptionMap":{"entries":[{"variableField":"TEXT_DATA",
       "variableData":{"value":{"alias":{"guid":"5:4"}},"dataType":"ALIAS","resolvedDataType":"STRING"}}]}}
  ])";
  json::Value v;
  REQUIRE(json::parse(json, v));
  Editor e;
  e.setSessionID(1);
  e.setViewport(800, 600, 1, 800, 600);
  e.loadDocument(codec::readChanges(v), Guid{0, 1});
  e.takeEvents();
  CHECK(e.document().has({5, 1}));
  CHECK(e.document().has({5, 5}));
  CHECK(e.document().has({6, 1}));
  CHECK(!e.document().has({7, 1}));  // an unused deleted main (docs/schema.md §5.7)
  CHECK(e.document().has({7, 2}));   // published: the next publish lists it as Removed
  // The page's explicit mode of the deleted collection still picks the value (Figma stored "Primary").
  CHECK(props(e, {1, 1}).text().textData.characters == "Primary");
}

// Figma's files may address an instance's root by its main's key (guidPath [key of the main]) as well as by [].
TEST_CASE("variables: a root override addressed by the main's key applies (size, unbound fields)") {
  const char* json = R"([
    {"guid":"0:0","phase":"CREATED","type":"DOCUMENT","name":"Document"},
    {"guid":"0:1","phase":"CREATED","type":"CANVAS","name":"Page","parentIndex":{"guid":"0:0","position":"!"}},
    {"guid":"0:2","phase":"CREATED","type":"CANVAS","name":"Internal Only Canvas","internalOnly":true,"parentIndex":{"guid":"0:0","position":"\""}},
    {"guid":"5:1","phase":"CREATED","type":"VARIABLE_SET","name":"Size","parentIndex":{"guid":"0:2","position":"!"},
     "variableSetModes":[{"id":"5:2","name":"Mode 1","sortPosition":"!"}]},
    {"guid":"5:4","phase":"CREATED","type":"VARIABLE","name":"avatar","parentIndex":{"guid":"0:2","position":"\""},
     "variableSetID":{"guid":"5:1"},"variableResolvedType":"FLOAT",
     "variableDataValues":{"entries":[{"modeID":"5:2","variableData":{"value":{"floatValue":40},"dataType":"FLOAT","resolvedDataType":"FLOAT"}}]}},
    {"guid":"2:1","phase":"CREATED","type":"SYMBOL","name":"Avatar","overrideKey":"9:1","parentIndex":{"guid":"0:1","position":"!"},
     "size":{"x":40,"y":40},
     "parameterConsumptionMap":{"entries":[
       {"variableField":"WIDTH","variableData":{"value":{"alias":{"guid":"5:4"}},"dataType":"ALIAS","resolvedDataType":"FLOAT"}},
       {"variableField":"HEIGHT","variableData":{"value":{"alias":{"guid":"5:4"}},"dataType":"ALIAS","resolvedDataType":"FLOAT"}}]}},
    {"guid":"3:1","phase":"CREATED","type":"INSTANCE","name":"Avatar","parentIndex":{"guid":"0:1","position":"\""},
     "size":{"x":32,"y":32},"transform":{"m00":1,"m01":0,"m02":100,"m10":0,"m11":1,"m12":0},
     "symbolData":{"symbolID":"2:1","symbolOverrides":[{"guidPath":{"guids":["9:1"]},"size":{"x":32,"y":32},
       "parameterConsumptionMap":{"entries":[{"variableField":"WIDTH"},{"variableField":"HEIGHT"}]}}]}}
  ])";
  json::Value v;
  REQUIRE(json::parse(json, v));
  Editor e;
  e.setSessionID(1);
  e.setViewport(800, 600, 1, 800, 600);
  e.loadDocument(codec::readChanges(v), Guid{0, 1});
  e.takeEvents();
  CHECK(props(e, {2, 1}).size.x == 40);
  CHECK(props(e, {3, 1}).size.x == 32);
  CHECK(props(e, {3, 1}).size.y == 32);
}

// Figma's per-page loading: a page not shown resolves nothing, derives no instance and asks for no font at load —
// even when its bound values are stale; all of it happens when the page is first shown.
TEST_CASE("variables: bound values, instances and fonts of a page not shown wait for the page") {
  const char* json = R"([
    {"guid":"0:0","phase":"CREATED","type":"DOCUMENT","name":"Document"},
    {"guid":"0:1","phase":"CREATED","type":"CANVAS","name":"Shown","parentIndex":{"guid":"0:0","position":"!"}},
    {"guid":"0:3","phase":"CREATED","type":"CANVAS","name":"Other","parentIndex":{"guid":"0:0","position":"\""}},
    {"guid":"0:2","phase":"CREATED","type":"CANVAS","name":"Internal Only Canvas","internalOnly":true,"parentIndex":{"guid":"0:0","position":"#"}},
    {"guid":"5:1","phase":"CREATED","type":"VARIABLE_SET","name":"Text","parentIndex":{"guid":"0:2","position":"!"},
     "variableSetModes":[{"id":"5:2","name":"Mode 1","sortPosition":"!"}]},
    {"guid":"5:4","phase":"CREATED","type":"VARIABLE","name":"size","parentIndex":{"guid":"0:2","position":"\""},
     "variableSetID":{"guid":"5:1"},"variableResolvedType":"FLOAT",
     "variableDataValues":{"entries":[{"modeID":"5:2","variableData":{"value":{"floatValue":20},"dataType":"FLOAT","resolvedDataType":"FLOAT"}}]}},
    {"guid":"2:1","phase":"CREATED","type":"SYMBOL","name":"Label","parentIndex":{"guid":"0:3","position":"!"},"size":{"x":100,"y":30}},
    {"guid":"2:2","phase":"CREATED","type":"TEXT","name":"Text","parentIndex":{"guid":"2:1","position":"!"},"size":{"x":80,"y":20},
     "textData":{"characters":"Hi"},"fontName":{"family":"Only On Other","style":"Bold"},"textAutoResize":"WIDTH_AND_HEIGHT"},
    {"guid":"3:1","phase":"CREATED","type":"INSTANCE","name":"Label","parentIndex":{"guid":"0:3","position":"\""},
     "size":{"x":100,"y":30},"symbolData":{"symbolID":"2:1"}},
    {"guid":"1:1","phase":"CREATED","type":"TEXT","name":"Stale","parentIndex":{"guid":"0:3","position":"#"},"size":{"x":80,"y":20},
     "textData":{"characters":"Hi"},"fontName":{"family":"Only On Other","style":"Bold"},"fontSize":12,"textAutoResize":"WIDTH_AND_HEIGHT",
     "parameterConsumptionMap":{"entries":[{"variableField":"FONT_SIZE",
       "variableData":{"value":{"alias":{"guid":"5:4"}},"dataType":"ALIAS","resolvedDataType":"FLOAT"}}]}},
    {"guid":"1:2","phase":"CREATED","type":"FRAME","name":"Here","parentIndex":{"guid":"0:1","position":"!"},"size":{"x":10,"y":10}},
    {"guid":"6:1","phase":"CREATED","type":"FRAME","name":"Parked","parentIndex":{"guid":"0:2","position":"$"},"size":{"x":100,"y":30}},
    {"guid":"6:2","phase":"CREATED","type":"INSTANCE","name":"Label","parentIndex":{"guid":"6:1","position":"!"},
     "size":{"x":100,"y":30},"symbolData":{"symbolID":"2:1"}}
  ])";
  json::Value v;
  REQUIRE(json::parse(json, v));
  text::FontRegistry& fonts = text::FontRegistry::get();
  fonts.takeRequests();
  Editor e;
  e.setSessionID(1);
  e.setViewport(800, 600, 1, 800, 600);
  e.loadDocument(codec::readChanges(v), Guid{0, 1});
  e.takeEvents();
  auto asked = [&](const char* family) {
    bool any = false;
    for (const FontName& f : fonts.takeRequests()) any |= f.family == family;
    return any;
  };
  CHECK(!asked("Only On Other"));
  CHECK(props(e, {1, 1}).text().fontSize == 12);  // stale, as stored, until the page is shown
  CHECK(!e.document().has(derived::intern({3, 1}, {{2, 2}})));
  REQUIRE(e.setCurrentPage({0, 3}) == OK);
  CHECK(props(e, {1, 1}).text().fontSize == 20);
  CHECK(e.document().has(derived::intern({3, 1}, {{2, 2}})));
  CHECK(asked("Only On Other"));
  // The Internal Only Canvas is never derived whole: a read of a container there derives nothing, a read of an
  // instance derives its container's instances.
  CHECK(!e.document().has(derived::intern({6, 2}, {{2, 2}})));
  e.derivePageOf({6, 1});
  CHECK(!e.document().has(derived::intern({6, 2}, {{2, 2}})));
  e.derivePageOf({6, 2});
  CHECK(e.document().has(derived::intern({6, 2}, {{2, 2}})));
}
