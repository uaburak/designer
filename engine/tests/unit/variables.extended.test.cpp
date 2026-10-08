// Round 5 (docs/engine-build.md "Round 5 — variables and components"): Figma's expressions in bindings (a boolean bound
// to visibility is IS_TRUTHY(alias)), variants bound to variables (VARIANT_PROPERTIES = RESOLVE_VARIANT(MAP)) on
// instances and nested instances, extended collections (overrides per mode, modes following the parent), component
// property defaults bound to variables, grid gaps bound to numbers, a nested instance's own slot content in a main.
#include <array>
#include <functional>
#include <string>

#include "doctest.h"
#include "Helpers.h"
#include "base/DerivedIds.h"
#include "editor/Editor.h"
#include "scene/CodecJson.h"
#include "scene/CodecKiwi.h"
#include "kiwi.h"

using namespace eng;
using namespace eng::test;

namespace {

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
Status run(Editor& e, CommandId id, const std::string& json) { return e.command(id, args(json)); }

std::array<Guid, 3> collection(Editor& e, const std::string& name, const std::string& a, const std::string& b) {
  REQUIRE(run(e, CommandId::CREATE_VARIABLE_COLLECTION, "{\"name\":\"" + name + "\"}") == OK);
  Guid set = e.lastCreated()[0], first = e.lastCreated()[1];
  REQUIRE(run(e, CommandId::RENAME_VARIABLE_MODE, "{\"collection\":" + q(set) + ",\"mode\":" + q(first) + ",\"name\":\"" + a + "\"}") == OK);
  REQUIRE(run(e, CommandId::ADD_VARIABLE_MODE, "{\"collection\":" + q(set) + ",\"name\":\"" + b + "\"}") == OK);
  return {set, first, e.lastCreated()[0]};
}

Guid variable(Editor& e, Guid set, const std::string& type, const std::string& name, const std::string& value) {
  REQUIRE(run(e, CommandId::CREATE_VARIABLE,
              "{\"collection\":" + q(set) + ",\"type\":\"" + type + "\",\"name\":\"" + name + "\",\"value\":" + value + "}") == OK);
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

// A component set "Logo" (Mode = Light | Dark), each variant a 40 × 40 frame holding one rectangle.
const Guid SET{2, 1}, LIGHT{2, 2}, DARK{2, 3}, LR{2, 4}, DR{2, 5}, MODE_DEF{2, 9};
const Guid FR{1, 1}, INST{1, 2};

void logoSet(std::vector<NodeChange>& nodes) {
  NodeChange set = make(SET, NodeType::FRAME, kPage, "!", {0, 0, 200, 100}, "Logo");
  set.props.comp().isStateGroup = true;
  ComponentPropDef d;
  d.id = MODE_DEF;
  d.name = "Mode";
  d.type = ComponentPropType::VARIANT;
  d.initialValue.hasText = true;
  d.initialValue.textValue.characters = "Light";
  set.props.comp().componentPropDefs = {d};
  nodes.push_back(set);
  for (auto [id, rect, value, pos, color] : {std::tuple{LIGHT, LR, "Light", "!", 0xFFFFFF}, std::tuple{DARK, DR, "Dark", "\"", 0x000000}}) {
    NodeChange v = make(id, NodeType::SYMBOL, SET, pos, {id == LIGHT ? 20.0 : 100.0, 20, 40, 40}, std::string("Mode=") + value);
    v.props.comp().variantPropSpecs = {{MODE_DEF, value}};
    nodes.push_back(v);
    NodeChange r = make(rect, NodeType::ROUNDED_RECTANGLE, id, "!", {0, 0, 40, 40}, "Fill");
    r.props.fillPaints = {Paint::solid(Color::hex(static_cast<uint32_t>(color)))};
    r.props.overrideKey = LR;  // variants share their layers' keys (Add variant keeps them)
    nodes.push_back(r);
  }
}

NodeChange instanceOf(Guid id, Guid main, Guid parent, const std::string& position, Rect r, const std::string& name = "Logo") {
  NodeChange c = make(id, NodeType::INSTANCE, parent, position, r, name);
  c.props.comp().symbolData.symbolID = main;
  c.props.fillPaints.clear();
  return c;
}

std::vector<NodeChange> logoDoc() {
  auto nodes = baseChanges();
  logoSet(nodes);
  nodes.push_back(make(FR, NodeType::FRAME, kPage, "\"", {0, 200, 300, 200}, "Frame"));
  nodes.push_back(instanceOf(INST, LIGHT, FR, "!", {10, 10, 40, 40}));
  return nodes;
}

}  // namespace

TEST_CASE("variables r5: a boolean bound to visibility is IS_TRUTHY(alias), as in Figma's files, and follows the mode") {
  auto nodes = logoDoc();
  Editor e = load(nodes);
  auto [set, on, off] = collection(e, "Flags", "On", "Off");
  Guid shown = variable(e, set, "BOOLEAN", "shown", "true");
  setValue(e, shown, off, "false");
  bind(e, INST, "VISIBLE", shown);
  const ParamBinding* b = nullptr;
  for (const ParamBinding& x : props(e, INST).parameterConsumptionMap)
    if (x.field == VariableField::VISIBLE) b = &x;
  REQUIRE(b);
  CHECK(b->data.kind == VariableData::Kind::EXPRESSION);
  CHECK(b->data.function == ExpressionFunction::IS_TRUTHY);
  CHECK(b->data.resolvedDataType == VariableResolvedType::BOOLEAN);
  CHECK(props(e, INST).visible);
  setMode(e, FR, set, off);
  CHECK(!props(e, INST).visible);
  setMode(e, FR, set, kNoGuid);
  CHECK(props(e, INST).visible);
  // The panel's read names the variable through the expression.
  auto bound = e.boundVariables(INST);
  REQUIRE(!bound.empty());
  CHECK(bound[0].variable == shown);
}

TEST_CASE("variables r5: expressions — negation, comparison, arithmetic, string concatenation, ternary") {
  Editor e = load(logoDoc());
  auto [set, a, b] = collection(e, "Numbers", "A", "B");
  Guid n = variable(e, set, "FLOAT", "n", "4");
  setValue(e, n, b, "10");
  auto alias = [&]() { return VariableData::aliasOf(n, VariableResolvedType::FLOAT); };
  auto lit = [](double v) { return VariableData::number(v); };
  auto expr = [](ExpressionFunction f, std::vector<VariableData> args, VariableResolvedType t) {
    VariableData d;
    d.kind = VariableData::Kind::EXPRESSION;
    d.function = f;
    d.args = std::move(args);
    d.hasDataType = d.hasResolvedType = true;
    d.dataType = VariableDataType::EXPRESSION;
    d.resolvedDataType = t;
    return d;
  };
  // visible = n > 5 (B only); width = n * 3; text = "n=" + n.
  NodeChange c = NodeChange::changed(INST);
  c.mask = F_PARAM_MAP;
  ParamBinding vis, w;
  vis.field = VariableField::VISIBLE;
  vis.data = expr(ExpressionFunction::GREATER_THAN, {alias(), lit(5)}, VariableResolvedType::BOOLEAN);
  w.field = VariableField::WIDTH;
  w.data = expr(ExpressionFunction::MULTIPLY, {alias(), lit(3)}, VariableResolvedType::FLOAT);
  c.props.parameterConsumptionMap = {vis, w};
  e.applyChanges({c}, APPLY_USER);
  CHECK(!props(e, INST).visible);
  CHECK(props(e, INST).size.x == doctest::Approx(12));
  setMode(e, FR, set, b);
  CHECK(props(e, INST).visible);
  CHECK(props(e, INST).size.x == doctest::Approx(30));
  Editor::Resolved r;
  // Through the generic resolver: concatenation, ternary, not.
  VariableData concat = expr(ExpressionFunction::ADDITION, {VariableData::string("n="), alias()}, VariableResolvedType::STRING);
  VariableData neg = expr(ExpressionFunction::NOT, {expr(ExpressionFunction::EQUALS, {alias(), lit(4)}, VariableResolvedType::BOOLEAN)},
                          VariableResolvedType::BOOLEAN);
  NodeChange t = NodeChange::changed(INST);
  t.mask = F_PARAM_MAP;
  ParamBinding vis2;
  vis2.field = VariableField::VISIBLE;
  vis2.data = neg;
  t.props.parameterConsumptionMap = {vis2};
  e.applyChanges({t}, APPLY_USER);
  CHECK(props(e, INST).visible);  // B: n = 10 ≠ 4
  setMode(e, FR, set, a);
  CHECK(!props(e, INST).visible);
  (void)concat;
  (void)r;
}

TEST_CASE("variables r5: a variant property assigned a string variable switches variant with the mode") {
  Editor e = load(logoDoc());
  auto [set, brandA, brandB] = collection(e, "Theme", "Day", "Night");
  Guid theme = variable(e, set, "STRING", "logo", "\"Light\"");
  setValue(e, theme, brandB, "\"Dark\"");
  bind(e, INST, "componentProperties.Mode", theme);
  // Figma's encoding: RESOLVE_VARIANT(MAP {Mode → alias}), resolved type SYMBOL_ID.
  const ParamBinding* b = nullptr;
  for (const ParamBinding& x : props(e, INST).parameterConsumptionMap)
    if (x.field == VariableField::VARIANT_PROPERTIES) b = &x;
  REQUIRE(b);
  CHECK(b->data.function == ExpressionFunction::RESOLVE_VARIANT);
  CHECK(b->data.resolvedDataType == VariableResolvedType::SYMBOL_ID);
  REQUIRE(b->data.args.size() == 1);
  CHECK(b->data.args[0].kind == VariableData::Kind::MAP);
  CHECK(b->data.args[0].mapKeys == std::vector<std::string>{"Mode"});
  CHECK(b->data.args[0].mapGuidKeys == std::vector<Guid>{MODE_DEF});
  CHECK(props(e, INST).comp().symbolData.symbolID == LIGHT);
  setMode(e, FR, set, brandB);
  CHECK(props(e, INST).comp().symbolData.symbolID == DARK);
  Guid fill = derived::intern(INST, {LR});
  REQUIRE(e.document().has(fill));
  CHECK(props(e, fill).fillPaints[0].color == Color::hex(0x000000));
  // The panel's read: the property shows its variable.
  ComponentInfo info;
  REQUIRE(e.componentInfo(INST, info));
  REQUIRE(info.properties.size() == 1);
  CHECK(info.properties[0].boundVariable == theme);
  CHECK(info.properties[0].variantValue == "Dark");
  // A value edit reaches it.
  setValue(e, theme, brandB, "\"Light\"");
  CHECK(props(e, INST).comp().symbolData.symbolID == LIGHT);
  setValue(e, theme, brandB, "\"Dark\"");
  CHECK(props(e, INST).comp().symbolData.symbolID == DARK);
  // Undo the two value edits and the mode switch: back to Light.
  for (int i = 0; i < 3; i++) e.command(CommandId::UNDO);
  CHECK(props(e, INST).comp().symbolData.symbolID == LIGHT);
  for (int i = 0; i < 3; i++) e.command(CommandId::REDO);
  CHECK(props(e, INST).comp().symbolData.symbolID == DARK);
  // Picking a variant by hand detaches the variable (an edit of a bound value).
  e.setSelection({INST});
  REQUIRE(run(e, CommandId::SET_COMPONENT_PROPERTY, R"({"prop":"Mode","value":"Light"})") == OK);
  CHECK(props(e, INST).comp().symbolData.symbolID == LIGHT);
  bool still = false;
  for (const ParamBinding& x : props(e, INST).parameterConsumptionMap) still |= x.field == VariableField::VARIANT_PROPERTIES;
  CHECK(!still);
  // Boolean and number variables too (Figma: true / false values; numbers as text).
  auto [set2, m1, m2] = collection(e, "Flags", "One", "Two");
  Guid dark = variable(e, set2, "STRING", "dark", "\"Light\"");
  (void)dark;
  Guid flag = variable(e, set2, "BOOLEAN", "isDark", "false");
  bind(e, INST, "componentProperties.Mode", flag);
  CHECK(props(e, INST).comp().symbolData.symbolID == LIGHT);  // no variant "false": kept
  bind(e, INST, "componentProperties.Mode", kNoGuid);
  // A boolean/text property of an instance takes no variable (Figma).
  CHECK(run(e, CommandId::BIND_VARIABLE, "{\"refs\":[" + q(INST) + "],\"target\":\"componentProperties.Nope\",\"variable\":" + q(flag) + "}") == OK);
  (void)m1;
  (void)m2;
}

TEST_CASE("variables r5: a nested instance's variant bound in its main resolves in each instance's own modes") {
  auto nodes = logoDoc();
  // A main "Card" holding a nested Logo instance; an instance of Card in the frame.
  const Guid CARD{3, 1}, NESTED{3, 2}, CI{3, 3};
  nodes.push_back(make(CARD, NodeType::SYMBOL, kPage, "#", {400, 0, 100, 100}, "Card"));
  nodes.push_back(instanceOf(NESTED, LIGHT, CARD, "!", {10, 10, 40, 40}));
  nodes.push_back(instanceOf(CI, CARD, FR, "\"", {100, 10, 100, 100}, "Card"));
  Editor e = load(nodes);
  auto [set, day, night] = collection(e, "Theme", "Day", "Night");
  Guid theme = variable(e, set, "STRING", "logo", "\"Light\"");
  setValue(e, theme, night, "\"Dark\"");
  bind(e, NESTED, "componentProperties.Mode", theme);
  Guid row = derived::intern(CI, {NESTED});
  REQUIRE(e.document().has(row));
  CHECK(props(e, row).comp().symbolData.symbolID == LIGHT);
  setMode(e, FR, set, night);
  CHECK(props(e, CARD).visible);
  CHECK(props(e, NESTED).comp().symbolData.symbolID == LIGHT);  // the main sits outside the frame: Day
  REQUIRE(e.document().has(row));
  CHECK(props(e, row).comp().symbolData.symbolID == DARK);
  CHECK(props(e, derived::intern(CI, {NESTED, LR})).fillPaints[0].color == Color::hex(0x000000));
  // Bound at the usage site of a nested instance (an override entry), as Figma's files also hold it.
  bind(e, NESTED, "componentProperties.Mode", kNoGuid);
  REQUIRE(e.document().has(row));
  CHECK(props(e, row).comp().symbolData.symbolID == LIGHT);
  bind(e, row, "componentProperties.Mode", theme);
  CHECK(props(e, row).comp().symbolData.symbolID == DARK);
  setMode(e, FR, set, day);
  CHECK(props(e, row).comp().symbolData.symbolID == LIGHT);
  (void)day;
}

TEST_CASE("variables r5: extended collections override values per mode and follow their parent's modes") {
  auto nodes = logoDoc();
  const Guid RECT{1, 5};
  NodeChange rect = make(RECT, NodeType::ROUNDED_RECTANGLE, FR, "\"", {100, 100, 20, 20}, "Rect");
  nodes.push_back(rect);
  Editor e = load(nodes);
  auto [set, light, dark] = collection(e, "Theme", "Light", "Dark");
  Guid bg = variable(e, set, "COLOR", "bg", R"({"r":1,"g":1,"b":1,"a":1})");
  setValue(e, bg, dark, R"({"r":0,"g":0,"b":0,"a":1})");
  Guid radius = variable(e, set, "FLOAT", "radius", "4");
  bind(e, RECT, "fillPaints[0].color", bg);
  bind(e, RECT, "CORNER_RADIUS", radius);
  REQUIRE(run(e, CommandId::EXTEND_VARIABLE_COLLECTION, "{\"collection\":" + q(set) + ",\"name\":\"Brand B\"}") == OK);
  Guid ext = e.lastCreated()[0];
  CHECK(e.extensionParent(ext) == set);
  CHECK(e.rootCollection(ext) == set);
  auto modes = props(e, ext).orderedModes();
  REQUIRE(modes.size() == 2);
  CHECK(modes[0].name == "Light");
  CHECK(modes[0].parentMode == light);
  CHECK(modes[1].parentMode == dark);
  Guid extLight = modes[0].id, extDark = modes[1].id;
  // Not allowed in an extension: variables, modes (Figma: only values are overridden).
  CHECK(run(e, CommandId::CREATE_VARIABLE, "{\"collection\":" + q(ext) + ",\"type\":\"FLOAT\"}") == E_INVALID);
  CHECK(run(e, CommandId::ADD_VARIABLE_MODE, "{\"collection\":" + q(ext) + "}") == E_INVALID);
  // An override in the extension's Dark only.
  setValue(e, bg, extDark, R"({"r":1,"g":0,"b":0,"a":1})");
  CHECK(e.overrideNode(ext, bg) != kNoGuid);
  CHECK(props(e, e.overrideNode(ext, bg)).type == NodeType::VARIABLE_OVERRIDE);
  CHECK(e.document().parentOf(e.overrideNode(ext, bg)) == ext);
  bool own = false;
  const VariableData* v = e.valueForMode(bg, extDark, &own);
  REQUIRE(v);
  CHECK(own);
  CHECK(v->colorValue == Color{1, 0, 0, 1});
  v = e.valueForMode(bg, extLight, &own);
  REQUIRE(v);
  CHECK(!own);
  CHECK(v->colorValue == Color{1, 1, 1, 1});
  // The frame in the extension's Dark: the override; the radius inherits the parent's Dark (4).
  setMode(e, FR, ext, extDark);
  CHECK(props(e, RECT).fillPaints[0].color == Color{1, 0, 0, 1});
  CHECK(e.resolvedMode(RECT, ext) == extDark);
  CHECK(e.resolvedMode(RECT, set) == dark);
  CHECK(e.explicitModeOf(FR, ext) == extDark);
  CHECK(e.explicitModeOf(FR, set) == kNoGuid);
  // The extension's Light: the parent's Light value.
  setMode(e, FR, ext, extLight);
  CHECK(props(e, RECT).fillPaints[0].color == Color{1, 1, 1, 1});
  // One mode value per collection: the parent's Dark replaces the extension's.
  setMode(e, FR, set, dark);
  CHECK(props(e, RECT).fillPaints[0].color == Color{0, 0, 0, 1});
  CHECK(props(e, FR).refs().variableModeBySetMap.size() == 1);
  setMode(e, FR, ext, extDark);
  // A parent value not overridden reaches the extension.
  setValue(e, radius, dark, "12");
  CHECK(props(e, RECT).cornerRadii[0] == doctest::Approx(12));
  // Editing the override's value reaches users; Reset change brings the parent's back.
  setValue(e, bg, extDark, R"({"r":0,"g":1,"b":0,"a":1})");
  CHECK(props(e, RECT).fillPaints[0].color == Color{0, 1, 0, 1});
  REQUIRE(run(e, CommandId::RESET_VARIABLE_OVERRIDE, "{\"collection\":" + q(ext) + ",\"variable\":" + q(bg) + ",\"mode\":" + q(extDark) + "}") == OK);
  CHECK(props(e, RECT).fillPaints[0].color == Color{0, 0, 0, 1});
  CHECK(e.overrideNode(ext, bg) == kNoGuid);
  e.command(CommandId::UNDO);
  CHECK(props(e, RECT).fillPaints[0].color == Color{0, 1, 0, 1});
  // A mode added to the parent appears in the extension (same name, its own id); renames follow.
  REQUIRE(run(e, CommandId::ADD_VARIABLE_MODE, "{\"collection\":" + q(set) + ",\"name\":\"Dim\"}") == OK);
  Guid dim = e.lastCreated()[0];
  modes = props(e, ext).orderedModes();
  REQUIRE(modes.size() == 3);
  CHECK(modes[2].name == "Dim");
  CHECK(modes[2].parentMode == dim);
  REQUIRE(run(e, CommandId::RENAME_VARIABLE_MODE, "{\"collection\":" + q(set) + ",\"mode\":" + q(light) + ",\"name\":\"Bright\"}") == OK);
  CHECK(props(e, ext).orderedModes()[0].name == "Bright");
  // Round trip through kiwi: the extension, its override and the explicit mode survive.
  std::string bytes = codec::writeMessage(1, e.encodeDocument());
  codec::KiwiMessage m;
  REQUIRE(codec::readMessage(bytes, m));
  Editor again = load(m.changes);
  CHECK(again.extensionParent(ext) == set);
  CHECK(props(again, RECT).fillPaints[0].color == Color{0, 1, 0, 1});
  CHECK(again.explicitModeOf(FR, ext) == extDark);
  // Deleting the parent collection takes its extension and the overrides with it.
  REQUIRE(run(e, CommandId::DELETE_VARIABLE_COLLECTION, "{\"collection\":" + q(set) + "}") == OK);
  CHECK(!e.document().has(ext));
}

TEST_CASE("variables r5: a boolean property's default bound to a variable shows its layer per the instance's mode") {
  auto nodes = baseChanges();
  const Guid M{4, 1}, ICON{4, 2}, I1{4, 3}, F1{4, 4}, DEF{4, 9};
  NodeChange m = make(M, NodeType::SYMBOL, kPage, "!", {0, 0, 100, 40}, "Button");
  ComponentPropDef d;
  d.id = DEF;
  d.name = "Show icon";
  d.type = ComponentPropType::BOOL;
  d.initialValue.hasBool = true;
  d.initialValue.boolValue = true;
  m.props.comp().componentPropDefs = {d};
  nodes.push_back(m);
  NodeChange icon = make(ICON, NodeType::ELLIPSE, M, "!", {0, 0, 10, 10}, "Icon");
  ParamBinding b;
  b.field = VariableField::VISIBLE;
  b.propRef = DEF;
  icon.props.parameterConsumptionMap = {b};
  nodes.push_back(icon);
  nodes.push_back(make(F1, NodeType::FRAME, kPage, "\"", {0, 100, 200, 100}, "Frame"));
  nodes.push_back(instanceOf(I1, M, F1, "!", {0, 0, 100, 40}, "Button"));
  Editor e = load(nodes);
  auto [set, on, off] = collection(e, "Flags", "On", "Off");
  Guid show = variable(e, set, "BOOLEAN", "icons", "true");
  setValue(e, show, off, "false");
  // A text variable can't take a boolean default.
  Guid label = variable(e, set, "STRING", "label", "\"x\"");
  bind(e, M, "componentProperties.Show icon", label);
  CHECK(!props(e, M).comp().componentPropDefs[0].boundValue.present());
  bind(e, M, "componentProperties.Show icon", show);
  CHECK(props(e, M).comp().componentPropDefs[0].boundValue.kind == VariableData::Kind::ALIAS);
  Guid row = derived::intern(I1, {ICON});
  REQUIRE(e.document().has(row));
  CHECK(props(e, row).visible);
  setMode(e, F1, set, off);
  CHECK(!props(e, row).visible);
  ComponentInfo info;
  REQUIRE(e.componentInfo(M, info));
  REQUIRE(info.properties.size() == 1);
  CHECK(info.properties[0].boundVariable == show);
  // Survives the codecs (kiwi: varValue as the alias).
  std::string bytes = codec::writeMessage(1, e.encodeDocument());
  codec::KiwiMessage msg;
  REQUIRE(codec::readMessage(bytes, msg));
  Editor again = load(msg.changes);
  CHECK(props(again, M).comp().componentPropDefs[0].boundValue == props(e, M).comp().componentPropDefs[0].boundValue);
  CHECK(!props(again, derived::intern(I1, {ICON})).visible);
}

TEST_CASE("variables r5: grid gaps bind to number variables") {
  auto nodes = baseChanges();
  const Guid G{5, 1};
  NodeChange g = make(G, NodeType::FRAME, kPage, "!", {0, 0, 200, 200}, "Grid");
  g.props.stack().stackMode = StackMode::GRID;
  nodes.push_back(g);
  Editor e = load(nodes);
  auto [set, a, b] = collection(e, "Spacing", "Compact", "Comfy");
  Guid gap = variable(e, set, "FLOAT", "gap", "8");
  setValue(e, gap, b, "24");
  bind(e, G, "GRID_ROW_GAP", gap);
  bind(e, G, "GRID_COLUMN_GAP", gap);
  auto bytes = [&](const char* key) {
    auto it = props(e, G).extra.find(key);
    return it == props(e, G).extra.end() ? std::string() : it->second;
  };
  auto value = [&](const char* key) {
    std::string s = bytes(key);
    kiwi::ByteBuffer bb(reinterpret_cast<const uint8_t*>(s.data()), s.size());
    uint32_t id = 0;
    float v = -1;
    bb.readVarUint(id);
    bb.readVarFloat(v);
    return v;
  };
  CHECK(value("gridRowGap") == doctest::Approx(8));
  CHECK(value("gridColumnGap") == doctest::Approx(8));
  setMode(e, G, set, b);
  CHECK(value("gridRowGap") == doctest::Approx(24));
  (void)a;
}

TEST_CASE("variables r5: a nested instance's own slot content inside a main shows in that slot in every instance") {
  auto nodes = baseChanges();
  // "List" (a SYMBOL with a SLOT frame holding a default dot), "Card" holding a List instance whose slot holds Card's
  // own content (a content frame under the nested instance), and an instance of Card.
  const Guid LIST{6, 1}, SLOT{6, 2}, DOT{6, 3}, SLOTDEF{6, 9};
  const Guid CARD{6, 10}, NL{6, 11}, CONTENT{6, 12}, ITEM{6, 13}, CI{6, 20};
  NodeChange list = make(LIST, NodeType::SYMBOL, kPage, "!", {0, 0, 100, 100}, "List");
  ComponentPropDef d;
  d.id = SLOTDEF;
  d.name = "Items";
  d.type = ComponentPropType::SLOT;
  list.props.comp().componentPropDefs = {d};
  nodes.push_back(list);
  NodeChange slot = make(SLOT, NodeType::FRAME, LIST, "!", {0, 0, 100, 100}, "Slot");
  slot.props.comp().isSlot = true;
  ParamBinding b;
  b.field = VariableField::SLOT_CONTENT_ID;
  b.propRef = SLOTDEF;
  slot.props.parameterConsumptionMap = {b};
  nodes.push_back(slot);
  nodes.push_back(make(DOT, NodeType::ELLIPSE, SLOT, "!", {5, 5, 10, 10}, "Dot"));
  nodes.push_back(make(CARD, NodeType::SYMBOL, kPage, "\"", {200, 0, 120, 120}, "Card"));
  NodeChange nl = instanceOf(NL, LIST, CARD, "!", {10, 10, 100, 100}, "List");
  ComponentPropAssignment as;
  as.defID = SLOTDEF;
  as.value.guidValue = CONTENT;
  nl.props.comp().componentPropAssignments = {as};
  nodes.push_back(nl);
  NodeChange content = make(CONTENT, NodeType::FRAME, NL, "~", {0, 0, 100, 100}, "Slot");
  content.props.comp().isSlotContent = true;
  nodes.push_back(content);
  nodes.push_back(make(ITEM, NodeType::ROUNDED_RECTANGLE, CONTENT, "!", {20, 20, 30, 30}, "Item"));
  nodes.push_back(instanceOf(CI, CARD, kPage, "#", {0, 300, 120, 120}, "Card"));
  Editor e = load(nodes);
  // The main's nested instance shows its own content (its real child).
  CHECK(e.document().has(ITEM));
  // An instance of Card: the nested List's slot shows Card's content, not List's default dot.
  Guid slotRow = derived::intern(CI, {NL, SLOT});
  REQUIRE(e.document().has(slotRow));
  CHECK(e.document().has(derived::intern(CI, {NL, SLOT, ITEM})));
  CHECK(!e.document().has(derived::intern(CI, {NL, SLOT, DOT})));
  CHECK(e.document().parentOf(derived::intern(CI, {NL, SLOT, ITEM})) == slotRow);
  // Edits to the content reach the instance.
  NodeChange c = NodeChange::changed(ITEM);
  c.mask = F_OPACITY;
  c.props.opacity = 0.5;
  e.applyChanges({c}, APPLY_USER);
  CHECK(props(e, derived::intern(CI, {NL, SLOT, ITEM})).opacity == doctest::Approx(0.5));
}

TEST_CASE("variables r5: Figma's RESOLVE_VARIANT and extension fields round-trip through kiwi and JSON") {
  VariableData map = VariableData::resolveVariant({{"Mode", MODE_DEF}, {"Size", kNoGuid}},
                                                  {VariableData::aliasOf({7, 1}, VariableResolvedType::STRING), VariableData::string("L")});
  NodeChange n = instanceOf(INST, LIGHT, kPage, "!", {0, 0, 10, 10});
  ParamBinding b;
  b.field = VariableField::VARIANT_PROPERTIES;
  b.data = map;
  n.props.parameterConsumptionMap = {b};
  n.props.refs().variableModeBySetMap = {{AssetId::of({7, 2}), {7, 3}, AssetId::of({7, 4})}};
  NodeChange set = make({7, 4}, NodeType::VARIABLE_SET, kInternal, "!", {0, 0, 0, 0}, "Ext");
  set.props.asset().variableSetModes = {{{7, 5}, "Light", "!", AssetId::of({7, 2}), {7, 3}}};
  NodeChange o = make({7, 6}, NodeType::VARIABLE_OVERRIDE, {7, 4}, "!", {0, 0, 0, 0}, "bg");
  o.props.asset().overriddenVariableId = AssetId::of({7, 1});
  o.props.asset().variableSetID = AssetId::of({7, 4});
  o.props.asset().variableDataValues = {{{7, 5}, VariableData::string("x")}};
  std::vector<NodeChange> list{n, set, o};
  std::string bytes = codec::writeMessage(1, list);
  codec::KiwiMessage m;
  REQUIRE(codec::readMessage(bytes, m));
  REQUIRE(m.changes.size() == 3);
  CHECK(m.changes[0].props.parameterConsumptionMap == n.props.parameterConsumptionMap);
  CHECK(m.changes[0].props.refs().variableModeBySetMap == n.props.refs().variableModeBySetMap);
  CHECK(m.changes[1].props.asset().variableSetModes == set.props.asset().variableSetModes);
  CHECK(m.changes[2].props.type == NodeType::VARIABLE_OVERRIDE);
  CHECK(m.changes[2].props.asset().overriddenVariableId == o.props.asset().overriddenVariableId);
  json::Writer w;
  codec::writeChanges(w, list);
  json::Value v;
  REQUIRE(json::parse(w.take(), v));
  std::vector<NodeChange> back = codec::readChanges(v);
  REQUIRE(back.size() == 3);
  CHECK(back[0].props.parameterConsumptionMap == n.props.parameterConsumptionMap);
  CHECK(back[1].props.asset().variableSetModes == set.props.asset().variableSetModes);
  CHECK(back[2].props.asset().overriddenVariableId == o.props.asset().overriddenVariableId);
}
