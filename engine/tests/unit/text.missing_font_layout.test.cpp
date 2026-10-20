// A text whose font is missing is laid out with the fallback the renderer draws it with (Inter at the style's
// weight, the font marked missing — Figma) once it changes: the main component's texts, plain texts and instance
// overrides (a text property, characters on the instance's sublayer) alike. Untouched texts keep the size they were
// stored with.
#include "doctest.h"
#include "Helpers.h"
#include "TextHelpers.h"
#include "base/DerivedIds.h"
#include "editor/Editor.h"

using namespace eng;
using namespace eng::test;

namespace {

const Guid M{1, 1}, LABEL{1, 2}, I{1, 10}, PLAIN{1, 20}, TXT{1, 2147483646};
const FontName kMissing{"Proxima Nova", "Semibold", ""};

NodeChange label(Guid id, Guid parent, const std::string& position, Rect r, const std::string& chars) {
  NodeChange c = make(id, NodeType::TEXT, parent, position, r, chars);
  c.props.text().textData.characters = chars;
  c.props.text().textAutoResize = TextAutoResize::WIDTH_AND_HEIGHT;
  c.props.text().fontName = kMissing;
  c.props.text().fontSize = 14;
  return c;
}

Editor load() {
  loadInter();
  text::FontRegistry::get().markMissing(kMissing.family, kMissing.style);
  auto nodes = baseChanges();
  // A hugging horizontal button: 12 px each side of its label (46 px wide as stored).
  NodeChange m = make(M, NodeType::SYMBOL, kPage, "!", {0, 0, 70, 40}, "Button");
  m.props.stack().stackMode = StackMode::HORIZONTAL;
  m.props.stack().stackPrimarySizing = StackSize::RESIZE_TO_FIT_WITH_IMPLICIT_SIZE;
  m.props.stack().stackPaddingLeft = 12;
  m.props.stack().stackPaddingRight = 12;
  m.props.stack().stackPaddingTop = 10;
  m.props.stack().stackPaddingBottom = 10;
  ComponentPropDef t;
  t.id = TXT;
  t.name = "Label";
  t.type = ComponentPropType::TEXT;
  t.initialValue.hasText = true;
  t.initialValue.textValue.characters = "Next";
  m.props.comp().componentPropDefs = {t};
  nodes.push_back(m);
  NodeChange l = label(LABEL, M, "!", {12, 10, 46, 20}, "Next");
  ParamBinding chars;
  chars.field = VariableField::TEXT_DATA;
  chars.propRef = TXT;
  l.props.parameterConsumptionMap = {chars};
  nodes.push_back(l);
  NodeChange inst = make(I, NodeType::INSTANCE, kPage, "\"", {0, 100, 70, 40}, "Button");
  inst.props.comp().symbolData.symbolID = M;
  inst.props.stack() = m.props.stack();
  nodes.push_back(inst);
  nodes.push_back(label(PLAIN, kPage, "#", {0, 200, 46, 20}, "Next"));
  Editor e;
  e.setSessionID(1);
  e.setViewport(800, 600, 1, 800, 600);
  e.loadDocument(nodes, kNoGuid);
  e.takeEvents();
  return e;
}

const NodeProps& props(const Editor& e, Guid id) { return e.document().get(id)->props; }

CommandArgs args(const std::string& text) {
  CommandArgs a;
  json::parse(text, a.raw);
  return a;
}

NodeChange characters(const std::string& s) {
  NodeChange c = NodeChange::changed(Guid{0, 0});
  c.mask = F_TEXT_DATA;
  c.props.text().textData.characters = s;
  return c;
}

const std::string kLong = "Smart animate \xE2\x86\x92 B";

}  // namespace

TEST_CASE("missing font: untouched texts keep their stored size") {
  Editor e = load();
  CHECK(props(e, PLAIN).size.x == doctest::Approx(46));
  CHECK(props(e, LABEL).size.x == doctest::Approx(46));
  const text::TextLayout* L = e.textLayout(PLAIN);
  REQUIRE(L != nullptr);
  CHECK(L->missingFont);
}

TEST_CASE("missing font: a plain text's new characters are measured with the fallback it draws with") {
  Editor e = load();
  REQUIRE(e.setProps({PLAIN}, characters(kLong), 0) == OK);
  double w = props(e, PLAIN).size.x;
  CHECK(w > 80);
  const text::TextLayout* L = e.textLayout(PLAIN);
  REQUIRE(L != nullptr);
  CHECK(L->missingFont);
  CHECK(w == doctest::Approx(L->size.x).epsilon(0.01));
}

TEST_CASE("missing font: a text property on an instance grows the hugging instance") {
  Editor e = load();
  e.setSelection({I});
  REQUIRE(e.command(CommandId::SET_COMPONENT_PROPERTY, args("{\"prop\":\"Label\",\"value\":\"" + kLong + "\"}")) == OK);
  Guid row = derived::intern(I, {LABEL});
  CHECK(props(e, row).text().textData.characters == kLong);
  double w = props(e, row).size.x;
  CHECK(w > 80);
  CHECK(props(e, I).size.x == doctest::Approx(w + 24).epsilon(0.01));
  // The main is untouched.
  CHECK(props(e, M).size.x == doctest::Approx(70));
}

TEST_CASE("missing font: characters set on the instance's text (an override) grow the hugging instance") {
  Editor e = load();
  Guid row = derived::intern(I, {LABEL});
  REQUIRE(e.setProps({row}, characters(kLong), 0) == OK);
  double w = props(e, row).size.x;
  CHECK(w > 80);
  CHECK(props(e, I).size.x == doctest::Approx(w + 24).epsilon(0.01));
}

TEST_CASE("missing font: the main component's text grows the main and its instances") {
  Editor e = load();
  REQUIRE(e.setProps({LABEL}, characters(kLong), 0) == OK);
  double w = props(e, LABEL).size.x;
  CHECK(w > 80);
  CHECK(props(e, M).size.x == doctest::Approx(w + 24).epsilon(0.01));
  CHECK(props(e, I).size.x == doctest::Approx(w + 24).epsilon(0.01));
}
