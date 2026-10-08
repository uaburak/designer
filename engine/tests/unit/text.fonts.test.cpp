// The fonts a document names (engine_document_fonts) and Figma's "Replace fonts" (REPLACE_FONTS): text nodes, their
// runs, instance overrides; one undo step.
#include <algorithm>

#include "doctest.h"
#include "editor/Editor.h"
#include "Helpers.h"
#include "TextHelpers.h"

using namespace eng;
using namespace eng::test;

namespace {

const Guid M{1, 1}, LABEL{1, 2}, I{1, 10}, T1{1, 20}, T2{1, 21};

NodeChange text(Guid id, Guid parent, const std::string& position, const std::string& chars, FontName font) {
  NodeChange c = make(id, NodeType::TEXT, parent, position, {0, 0, 100, 20}, chars);
  c.props.text().textData.characters = chars;
  c.props.text().textAutoResize = TextAutoResize::NONE;
  c.props.text().fontName = font;
  return c;
}

Editor load() {
  loadInter();
  auto nodes = baseChanges();
  NodeChange m = make(M, NodeType::SYMBOL, kPage, "!", {0, 0, 100, 40}, "Button");
  nodes.push_back(m);
  nodes.push_back(text(LABEL, M, "!", "Label", {"Matter", "Medium", ""}));
  NodeChange inst = make(I, NodeType::INSTANCE, kPage, "#", {200, 0, 100, 40}, "Button");
  inst.props.comp().symbolData.symbolID = M;
  SymbolOverride o;
  o.path = {LABEL};
  o.mask = F_FONT_NAME;
  o.props.text().fontName = {"Matter", "Bold", ""};
  inst.props.comp().symbolData.overrides.push_back(o);
  nodes.push_back(inst);
  // "Hello world": "Hello " in the node's font, "world" in a run of another.
  NodeChange t1 = text(T1, kPage, "$", "Hello world", {"Matter", "Medium", ""});
  TextStyle run;
  run.styleID = 1;
  run.mask = R_FONT_NAME;
  run.fontName = {"Proxima Nova", "Bold", ""};
  t1.props.text().textData.styleOverrideTable = {run};
  t1.props.text().textData.characterStyleIDs = {0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1};
  nodes.push_back(t1);
  // Every character in a run: the node's own font names nothing.
  NodeChange t2 = text(T2, kPage, "%", "ab", {"Unused", "Regular", ""});
  t2.props.text().textData.styleOverrideTable = {run};
  t2.props.text().textData.characterStyleIDs = {1, 1};
  nodes.push_back(t2);
  Editor e;
  e.setSessionID(1);
  e.setViewport(800, 600, 2, 1600, 1200);
  e.loadDocument(nodes, kNoGuid);
  e.takeEvents();
  return e;
}

uint32_t uses(const Editor& e, const std::string& family, const std::string& style) {
  for (const auto& f : e.documentFonts())
    if (f.font.family == family && f.font.style == style) return f.uses;
  return 0;
}

CommandArgs replace(const std::string& json) {
  CommandArgs a;
  REQUIRE(json::parse(json, a.raw));
  return a;
}

}  // namespace

TEST_CASE("fonts: the document's fonts — text, runs, instance overrides; a font no character takes isn't named") {
  Editor e = load();
  CHECK(uses(e, "Matter", "Medium") == 2);  // the main's label, "Hello "
  CHECK(uses(e, "Matter", "Bold") == 1);    // the instance's override
  CHECK(uses(e, "Proxima Nova", "Bold") == 2);
  CHECK(uses(e, "Unused", "Regular") == 0);
  // Instance sublayers (derived) add nothing of their own.
  CHECK(e.documentFonts().size() == 3);
}

TEST_CASE("fonts: Replace fonts rewrites nodes, runs and overrides in one undo step") {
  Editor e = load();
  CHECK(e.command(CommandId::REPLACE_FONTS, replace(R"({"fonts":[
    {"from":{"family":"Matter","style":"Medium"},"to":{"family":"Inter","style":"Medium"}},
    {"from":{"family":"Matter","style":"Bold"},"to":{"family":"Inter","style":"Bold"}},
    {"from":{"family":"Proxima Nova","style":"Bold"},"to":{"family":"Inter","style":"Semi Bold"}}]})")) == OK);
  CHECK(uses(e, "Matter", "Medium") == 0);
  CHECK(uses(e, "Inter", "Medium") == 2);
  CHECK(uses(e, "Inter", "Bold") == 1);
  CHECK(uses(e, "Inter", "Semi Bold") == 2);
  const NodeProps& t1 = e.document().get(T1)->props;
  CHECK(t1.text().fontName.family == "Inter");
  CHECK(t1.text().textData.styleOverrideTable[0].fontName.style == "Semi Bold");
  CHECK(t1.text().textData.characters == "Hello world");
  REQUIRE(e.command(CommandId::UNDO) == OK);
  CHECK(uses(e, "Matter", "Medium") == 2);
  CHECK(uses(e, "Proxima Nova", "Bold") == 2);
  CHECK(uses(e, "Matter", "Bold") == 1);
  // Nothing to replace: no undo step; malformed arguments refused.
  CHECK(e.command(CommandId::REPLACE_FONTS, replace(R"({"fonts":[{"from":{"family":"Nope","style":"X"},"to":{"family":"Inter","style":"Regular"}}]})")) == OK);
  CHECK(e.command(CommandId::REPLACE_FONTS, replace(R"({"fonts":[{"from":{"family":"Matter"}}]})")) == E_INVALID);
  CHECK(e.command(CommandId::REPLACE_FONTS, replace(R"({})")) == E_INVALID);
}
