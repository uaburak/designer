// The engine's half of the designer tools' fixes (2026-10-20, a 10-screen prototype built by an agent): a stretched
// auto-height text decides its auto-layout parent's hug at its stretched width; INSERT_INSTANCE into a parent without
// x / y lands at the parent's origin; duplicates and pastes give interactions fresh ids (an instance's entries for its
// main's keep theirs); Combine as variants names a set after the components' shared base name, else "Component N"
// going on through the file; BIND_COMPONENT_PROPERTY takes Figma's componentPropertyReferences keys.
#include <string>

#include "doctest.h"
#include "Helpers.h"
#include "TextHelpers.h"
#include "editor/Editor.h"
#include "scene/CodecJson.h"
#include "scene/CodecKiwi.h"

using namespace eng;
using namespace eng::test;

namespace {

Editor load(const std::vector<NodeChange>& nodes) {
  Editor e;
  e.setSessionID(1);
  e.setViewport(800, 600, 1, 800, 600);
  e.loadDocument(std::vector<NodeChange>(nodes), kNoGuid);
  e.takeEvents();
  return e;
}

const NodeProps& props(const Editor& e, Guid id) { return e.document().get(id)->props; }

CommandArgs args(const std::string& text) {
  CommandArgs a;
  REQUIRE(json::parse(text, a.raw));
  return a;
}

std::string interactionIds(const NodeProps& p) {
  auto it = p.extra.find("prototypeInteractions");
  if (it == p.extra.end()) return "";
  json::Value v;
  REQUIRE(json::parse(codec::extraValueToJson("NodeChange", it->second), v));
  std::string out;
  for (const json::Value& i : v.array) out += json::encode(*i.get("id")) + ";";
  return out;
}

std::string clickTo(Guid id, Guid dest) {
  json::Value v;
  REQUIRE(json::parse("[{\"id\":\"" + id.toString() + "\",\"event\":{\"interactionType\":\"ON_CLICK\"},\"actions\":[{\"connectionType\":\"INTERNAL_NODE\",\"navigationType\":\"NAVIGATE\",\"transitionNodeID\":\"" +
                          dest.toString() + "\",\"transitionType\":\"INSTANT_TRANSITION\"}]}]",
                      v));
  return codec::extraFromJson("NodeChange", "prototypeInteractions", v);
}

// Inter, the module-wide registry reset afterwards (as devmode.test.cpp): loadInter() loads once per run, and files
// after this one reset the registry.
struct Fonts {
  Fonts() {
    auto& fonts = text::FontRegistry::get();
    int32_t face = addFontFile(interPath());
    fonts.bind("Inter", "Regular", face);
    fonts.takeRequests();
  }
  ~Fonts() { text::FontRegistry::get().reset(); }
};

}  // namespace

TEST_CASE("agent tool fixes: a stretched auto-height text decides its parent's hug at the stretched width") {
  Fonts fonts;
  const Guid CARD{1, 1}, BODY{1, 2};
  auto nodes = baseChanges();
  NodeChange card = make(CARD, NodeType::FRAME, kPage, "!", {0, 0, 320, 100}, "Card");
  card.props.stack().stackMode = StackMode::VERTICAL;
  card.props.stack().stackPrimarySizing = StackSize::RESIZE_TO_FIT_WITH_IMPLICIT_SIZE;
  card.props.stack().stackCounterSizing = StackSize::FIXED;
  card.props.stack().stackPaddingLeft = card.props.stack().stackPaddingRight = 16;
  nodes.push_back(card);
  // Measured at 40 px wide (one word a line) before it was stretched.
  NodeChange body = make(BODY, NodeType::TEXT, CARD, "!", {16, 0, 40, 400}, "Body");
  body.props.text().textData.characters = "Short body text that wraps over a couple of lines when the card is narrow.";
  body.props.text().textAutoResize = TextAutoResize::HEIGHT;
  body.props.text().fontName = {"Inter", "Regular", ""};
  body.props.text().fontSize = 14;
  nodes.push_back(body);
  Editor e = load(nodes);
  NodeChange stretch = NodeChange::changed(BODY);
  stretch.mask = F_STACK_CHILD_ALIGN_SELF;
  stretch.props.stackChildAlignSelf = StackCounterAlign::STRETCH;
  REQUIRE(e.setProps({BODY}, stretch, 0) == OK);
  CHECK(props(e, BODY).size.x == doctest::Approx(288));
  double h = props(e, BODY).size.y;
  CHECK(h > 25);
  CHECK(h < 60);
  CHECK(props(e, CARD).size.y == doctest::Approx(h));
}

TEST_CASE("agent tool fixes: INSERT_INSTANCE into a parent without x / y lands at its origin") {
  const Guid MAIN{1, 1}, SCREEN{1, 2};
  auto nodes = baseChanges();
  nodes.push_back(make(MAIN, NodeType::SYMBOL, kPage, "!", {-12000, -600, 80, 32}, "Chip"));
  nodes.push_back(make(SCREEN, NodeType::FRAME, kPage, "\"", {3000, 2000, 390, 844}, "Screen"));
  Editor e = load(nodes);
  REQUIRE(e.command(CommandId::INSERT_INSTANCE, args("{\"main\":\"1:1\",\"parent\":\"1:2\"}")) == OK);
  Guid inst = e.selection().at(0);
  CHECK(e.lastCreated() == std::vector<Guid>{inst});  // (run_command's `created`)
  CHECK(props(e, inst).parentIndex.guid == SCREEN);
  CHECK(props(e, inst).transform.m02 == 0);
  CHECK(props(e, inst).transform.m12 == 0);
  // x / y still place its centre on the page.
  REQUIRE(e.command(CommandId::INSERT_INSTANCE, args("{\"main\":\"1:1\",\"parent\":\"1:2\",\"x\":3100,\"y\":2100}")) == OK);
  Guid placed = e.selection().at(0);
  CHECK(props(e, placed).transform.m02 == 60);
  CHECK(props(e, placed).transform.m12 == 84);
}

TEST_CASE("agent tool fixes: a duplicate's interactions get ids of their own; an instance keeps its main's") {
  const Guid A{1, 1}, B{1, 2}, MAIN{1, 3}, INST{1, 4}, R1{1, 900}, R2{1, 901};
  auto nodes = baseChanges();
  NodeChange a = make(A, NodeType::FRAME, kPage, "!", {0, 0, 100, 100}, "A");
  a.props.extra["prototypeInteractions"] = clickTo(R1, B);
  nodes.push_back(a);
  nodes.push_back(make(B, NodeType::FRAME, kPage, "\"", {200, 0, 100, 100}, "B"));
  NodeChange m = make(MAIN, NodeType::SYMBOL, kPage, "#", {0, 300, 100, 40}, "Button");
  m.props.extra["prototypeInteractions"] = clickTo(R2, B);
  nodes.push_back(m);
  NodeChange inst = make(INST, NodeType::INSTANCE, kPage, "$", {200, 300, 100, 40}, "Button");
  inst.props.comp().symbolData.symbolID = MAIN;
  inst.props.extra["prototypeInteractions"] = clickTo(R2, A);  // the main's interaction, changed on the instance
  nodes.push_back(inst);
  Editor e = load(nodes);
  e.setSelection({A, INST});
  REQUIRE(e.command(CommandId::DUPLICATE) == OK);
  REQUIRE(e.selection().size() == 2);
  Guid copyA = e.selection()[0], copyInst = e.selection()[1];
  if (props(e, copyA).type == NodeType::INSTANCE) std::swap(copyA, copyInst);
  CHECK(!interactionIds(props(e, copyA)).empty());
  CHECK(interactionIds(props(e, copyA)) != interactionIds(props(e, A)));
  CHECK(interactionIds(props(e, copyInst)) == interactionIds(props(e, INST)));
  // Copy and paste: fresh again.
  e.setSelection({A});
  Clipboard clip;
  REQUIRE(e.copySelection(clip));
  REQUIRE(e.paste(clip, true) == 1);
  Guid pasted = e.selection().at(0);
  CHECK(pasted != A);
  CHECK(interactionIds(props(e, pasted)) != interactionIds(props(e, A)));
  CHECK(interactionIds(props(e, pasted)) != interactionIds(props(e, copyA)));
}

TEST_CASE("agent tool fixes: Combine as variants names the set after a shared base name, else Component N going on") {
  auto nodes = baseChanges();
  const char* names[] = {"Accordion/State=Closed", "Accordion/State=Open", "Size=S", "Size=L", "Tone=Light", "Tone=Dark", "Kind=A", "Kind=B"};
  for (uint32_t i = 0; i < 8; i++) nodes.push_back(make({1, 1 + i}, NodeType::SYMBOL, kPage, std::string(1, static_cast<char>('!' + i)), {i * 120.0, 0, 100, 40}, names[i]));
  Editor e = load(nodes);
  auto combine = [&](uint32_t first) {
    e.setSelection({{1, first}, {1, first + 1}});
    REQUIRE(e.command(CommandId::COMBINE_AS_VARIANTS) == OK);
    CHECK(e.lastCreated() == e.selection());
    return e.selection().at(0);
  };
  Guid accordion = combine(1);
  CHECK(props(e, accordion).name == "Accordion");
  REQUIRE(props(e, accordion).comp().componentPropDefs.size() == 1);
  CHECK(props(e, accordion).comp().componentPropDefs[0].name == "State");
  CHECK(props(e, Guid{1, 1}).name == "State=Closed");
  Guid size = combine(3);
  CHECK(props(e, size).name == "Component 1");
  Guid tone = combine(5);
  CHECK(props(e, tone).name == "Component 2");
  NodeChange rename = NodeChange::changed(size);
  rename.mask = F_NAME;
  rename.props.name = "Size";
  REQUIRE(e.setProps({size}, rename, 0) == OK);
  rename.props.name = "Tone";
  REQUIRE(e.setProps({tone}, rename, 0) == OK);
  CHECK(props(e, combine(7)).name == "Component 3");
}

TEST_CASE("agent tool fixes: BIND_COMPONENT_PROPERTY takes characters / visible / mainComponent and the enum names") {
  const Guid MAIN{1, 1}, LABEL{1, 2}, DOT{1, 3};
  auto nodes = baseChanges();
  nodes.push_back(make(MAIN, NodeType::SYMBOL, kPage, "!", {0, 0, 100, 40}, "Tag"));
  NodeChange label = make(LABEL, NodeType::TEXT, MAIN, "!", {0, 0, 60, 20}, "Label");
  label.props.text().textData.characters = "Tag";
  nodes.push_back(label);
  nodes.push_back(make(DOT, NodeType::ELLIPSE, MAIN, "\"", {70, 10, 8, 8}, "Dot"));
  Editor e = load(nodes);
  REQUIRE(e.command(CommandId::ADD_COMPONENT_PROPERTY, args("{\"ref\":\"1:1\",\"name\":\"Text\",\"type\":\"TEXT\",\"defaultValue\":\"Tag\"}")) == OK);
  REQUIRE(e.command(CommandId::ADD_COMPONENT_PROPERTY, args("{\"ref\":\"1:1\",\"name\":\"Show dot\",\"type\":\"BOOLEAN\",\"defaultValue\":true}")) == OK);
  CHECK(e.command(CommandId::BIND_COMPONENT_PROPERTY, args("{\"refs\":[\"1:2\"],\"field\":\"characters\",\"prop\":\"Text\"}")) == OK);
  CHECK(e.command(CommandId::BIND_COMPONENT_PROPERTY, args("{\"refs\":[\"1:3\"],\"field\":\"visible\",\"prop\":\"Show dot\"}")) == OK);
  CHECK(e.command(CommandId::BIND_COMPONENT_PROPERTY, args("{\"refs\":[\"1:3\"],\"field\":\"VISIBLE\",\"prop\":\"Show dot\"}")) == OK);
  CHECK(props(e, LABEL).parameterConsumptionMap.size() == 1);
  CHECK(props(e, DOT).parameterConsumptionMap.size() == 1);
  CHECK(e.command(CommandId::BIND_COMPONENT_PROPERTY, args("{\"refs\":[\"1:3\"],\"field\":\"fills\",\"prop\":\"Show dot\"}")) == E_INVALID);
  CHECK(e.lastRefusal() == "property_reference_field_invalid");
}
