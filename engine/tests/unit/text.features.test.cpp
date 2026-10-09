// Text round (docs/engine-build.md "Text round"): Figma's measurement rules, variable font axes, OpenType features,
// lists, hyperlinks, decoration details, vertical trim, wrap styles, truncation at characters, per-range fields kept
// as data, the Typography section's range summary and the paragraph edits (lists, indentation, autoformat).
#include <cmath>
#include <string>

#include "base/Json.h"
#include "doctest.h"
#include "editor/Editor.h"
#include "Helpers.h"
#include "scene/CodecKiwi.h"
#include "TextHelpers.h"
#include "text/TextEdit.h"
#include "text/TextFeatures.h"
#include "text/TextLayout.h"
#include "text/Unicode.h"
#include "proto/Player.h"

using namespace eng;
using namespace eng::test;
using namespace eng::text;

namespace {

std::unique_ptr<TextLayout> lay(const NodeProps& p) { return layoutText(p, optionsFor(p)); }

// A NodeChange field the engine keeps as data, from its JSON (as the panel sends it).
void setExtra(NodeProps& p, const char* key, const char* jsonValue) {
  json::Value v;
  REQUIRE(json::parse(jsonValue, v));
  std::string bytes = codec::extraFromJson("NodeChange", key, v);
  REQUIRE(!bytes.empty());
  p.extra[key] = bytes;
}

std::string extraBytes(const char* key, const char* jsonValue) {
  json::Value v;
  REQUIRE(json::parse(jsonValue, v));
  return codec::extraFromJson("NodeChange", key, v);
}

uint32_t glyphOf(const TextLayout& L, uint32_t cluster) {
  for (const LaidGlyph& g : L.glyphs)
    if (g.cluster == cluster && !g.marker) return g.glyph;
  return 0;
}

double xOf(const TextLayout& L, uint32_t cluster) {
  for (const LaidGlyph& g : L.glyphs)
    if (g.cluster == cluster && !g.marker) return g.x;
  return -1;
}

std::string lineBytes(const char* json) {
  json::Value v;
  REQUIRE(json::parse(json, v));
  std::string out;
  const schema::SchemaTable& table = schema::SchemaTable::get();
  const schema::Def* def = table.def("TextLineData");
  schema::Out o;
  REQUIRE(table.objectToFields(o, *def, v));
  return o.s;
}

const Guid F{1, 1}, T{1, 2};

Editor makeEditor(const NodeChange& text) {
  loadInter();
  auto nodes = baseChanges();
  nodes.push_back(make(F, NodeType::FRAME, kPage, "!", {300, 0, 200, 200}, "Frame 1"));
  nodes.push_back(text);
  Editor e;
  e.setSessionID(1);
  e.setViewport(800, 600, 2, 1600, 1200);
  e.loadDocument(nodes, kNoGuid);
  e.takeEvents();
  return e;
}

NodeChange textNode(const std::string& chars) {
  NodeChange c = make(T, NodeType::TEXT, F, "#", {10, 10, 100, 20}, chars);
  c.props.text().textData.characters = chars;
  c.props.text().textAutoResize = TextAutoResize::WIDTH_AND_HEIGHT;
  loadInter();
  c.props.size = layoutText(c.props, {})->size;
  return c;
}

void key(Editor& e, KeyCode k, uint32_t mods = 0) { e.key(KeyEvent::DOWN, k, 0, mods, false); }

json::Value rangeStyle(Editor& e, Guid id) {
  json::Value v;
  REQUIRE(json::parse(e.textRangeStyle(id, 0, ~0u, true), v));
  return v;
}

bool isMixed(const json::Value& v, const char* field) {
  for (const json::Value& m : v.get("mixed")->array)
    if (m.string == field) return true;
  return false;
}

}  // namespace

TEST_CASE("text round: RAW line heights round to whole pixels in float, as Figma's stored layouts do") {
  loadInter();
  NodeProps p = textProps("Hg", 15);
  p.text().lineHeight = {static_cast<float>(1.3), NumberUnits::RAW};  // the file's 1.29999995 × 15 = 19.4999… → 19
  CHECK(lay(p)->lines[0].height == 19);
  p = textProps("Hg", 13);
  p.text().lineHeight = {1.5, NumberUnits::RAW};  // 19.5 → 20
  CHECK(lay(p)->lines[0].height == 20);
  p = textProps("Hg", 12);
  p.text().lineHeight = {static_cast<float>(1.4286), NumberUnits::RAW};  // 17.14 → 17
  CHECK(lay(p)->lines[0].height == 17);
}

TEST_CASE("text round: an auto-width box is its widest line rounded up to whole pixels") {
  loadInter();
  auto L = lay(textProps("ABC"));
  CHECK(L->size.x == std::ceil(L->lines[0].width));
  CHECK(L->size.x > L->lines[0].width);
}

TEST_CASE("text round: a truncated last line is cut at a character where … fits, aligned as it was broken") {
  loadInter();
  NodeProps p = textProps("Hello wonderful world");
  p.text().textAutoResize = TextAutoResize::HEIGHT;
  p.size = {80, 20};
  p.text().textTruncation = TextTruncation::ENDING;
  p.text().maxLines = 1;
  auto L = lay(p);
  REQUIRE(L->lines.size() == 1);
  CHECK(L->truncated);
  // Word wrapping would keep "Hello …"; Figma fills the line with characters of the next word.
  CHECK(L->truncationStart > 6);
  CHECK(L->lines[0].width <= 80 + 0.01);
}

TEST_CASE("text round: variable font axes (fontVariations) on the node and on a run") {
  loadInter();
  NodeProps p = textProps("AAAA");
  double regular = lay(p)->lines[0].width;
  setExtra(p, "fontVariations", R"([{"axisTag": 2003265652, "axisName": "Weight", "value": 900}])");  // 'wght'
  auto L = lay(p);
  CHECK(L->lines[0].width > regular + 1);
  CHECK(L->styles[0].features.variations.size() == 1);
  // The font reports its axes at the run's values.
  bool found = false;
  for (const AxisInfo& a : L->styles[0].font->axes())
    if (tagString(a.tag) == "wght") {
      found = true;
      CHECK(a.value == doctest::Approx(900));
      CHECK(a.min == doctest::Approx(100));
      CHECK(a.max == doctest::Approx(900));
      CHECK(a.name == "Weight");
    }
  CHECK(found);
  // A run's axes: only its characters get heavier.
  NodeProps r = textProps("AAAA");
  TextStyle run;
  run.styleID = 1;
  std::string bytes = extraBytes("fontVariations", R"([{"axisTag": 2003265652, "value": 900}])");
  run.extra = bytes;
  r.text().textData.styleOverrideTable.push_back(run);
  r.text().textData.characterStyleIDs = {0, 0, 1, 1};
  auto R = lay(r);
  CHECK(R->lines[0].width > regular + 0.5);
  CHECK(R->lines[0].width < L->lines[0].width - 0.5);
}

TEST_CASE("text round: OpenType features — slashed zero, tabular figures, ligatures off, the font's feature list") {
  loadInter();
  NodeProps p = textProps("0");
  uint32_t plain = glyphOf(*lay(p), 0);
  setExtra(p, "fontVariantSlashedZero", "true");
  CHECK(glyphOf(*lay(p), 0) != plain);
  // toggledOnOTFeatures: Figma's own list (here 'zero' again, by its schema name).
  NodeProps q = textProps("0");
  setExtra(q, "toggledOnOTFeatures", R"(["ZERO"])");
  CHECK(glyphOf(*lay(q), 0) != plain);
  // Tabular figures: "1" as wide as "0".
  NodeProps n = textProps("10");
  setExtra(n, "fontVariantNumericSpacing", R"("TABULAR")");
  auto L = lay(n);
  double one = xOf(*L, 1) - xOf(*L, 0);
  NodeProps z = textProps("00");
  setExtra(z, "fontVariantNumericSpacing", R"("TABULAR")");
  auto Z = lay(z);
  CHECK(one == doctest::Approx(xOf(*Z, 1) - xOf(*Z, 0)).epsilon(1e-6));
  Font* inter = FontRegistry::get().find({"Inter", "Regular", ""});
  REQUIRE(inter);
  CHECK(inter->hasFeature(tagOf("tnum")));
  CHECK(inter->hasFeature(tagOf("ss01")));
  CHECK(inter->hasFeature(tagOf("kern")));
}

TEST_CASE("text round: lists — bullets and counters per level, indents, list spacing, hanging") {
  loadInter();
  NodeProps p = textProps("One\nTwo\nSub\nThree");
  auto& lines = p.text().textData.lines;
  lines.push_back(lineBytes(R"({"lineType": "ORDERED_LIST", "indentationLevel": 1})"));
  lines.push_back(lineBytes(R"({"lineType": "ORDERED_LIST", "indentationLevel": 1})"));
  lines.push_back(lineBytes(R"({"lineType": "ORDERED_LIST", "indentationLevel": 2})"));
  lines.push_back(lineBytes(R"({"lineType": "ORDERED_LIST", "indentationLevel": 1})"));
  setExtra(p, "listSpacing", "6");
  auto L = lay(p);
  REQUIRE(L->lines.size() == 4);
  // Level 1 text at 18 px (1.5 em at 12), level 2 at 36.
  CHECK(xOf(*L, 0) == doctest::Approx(18).epsilon(0.02));
  CHECK(xOf(*L, 8) == doctest::Approx(36).epsilon(0.02));
  // Markers before each item, left of its text.
  int markers = 0;
  for (const LaidGlyph& g : L->glyphs)
    if (g.marker) {
      markers++;
      CHECK(g.x < 18 + 18 * (g.cluster == 8 ? 1 : 0));
    }
  CHECK(markers >= 8);  // "1." "2." "a." "3."
  CHECK(listMarker(LineType::ORDERED_LIST, 1, 3) == u"3.");
  CHECK(listMarker(LineType::ORDERED_LIST, 2, 1) == u"a.");
  CHECK(listMarker(LineType::ORDERED_LIST, 3, 4) == u"iv.");
  CHECK(listMarker(LineType::UNORDERED_LIST, 2, 1) == u"•");
  // List spacing between items.
  CHECK(L->lines[1].top - (L->lines[0].top + L->lines[0].height) == doctest::Approx(6));
  // Hanging lists: level 1 text at the box's edge, markers outside.
  setExtra(p, "hangingList", "true");
  auto H = lay(p);
  CHECK(xOf(*H, 0) == doctest::Approx(0));
  for (const LaidGlyph& g : H->glyphs)
    if (g.marker && g.cluster == 0) CHECK(g.x < 0);
}

TEST_CASE("text round: hyperlinks give boxes per line; decoration style, thickness, offset and colour") {
  loadInter();
  NodeProps p = textProps("Visit figma");
  TextStyle run;
  run.styleID = 1;
  run.mask = R_TEXT_DECORATION;
  run.textDecoration = TextDecoration::UNDERLINE;
  run.extra = extraBytes("hyperlink", R"({"url": "https://www.figma.com"})");
  p.text().textData.styleOverrideTable.push_back(run);
  p.text().textData.characterStyleIDs = {0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1};
  auto L = lay(p);
  REQUIRE(L->links.size() == 1);
  CHECK(L->links[0].link.url == "https://www.figma.com");
  CHECK(L->links[0].start == 6);
  CHECK(L->links[0].id == 1);
  CHECK(L->links[0].rect.x == doctest::Approx(xOf(*L, 6)).epsilon(0.01));
  REQUIRE(L->decorations.size() == 1);

  NodeProps d = textProps("Dotted");
  d.text().textDecoration = TextDecoration::UNDERLINE;
  setExtra(d, "textDecorationStyle", R"("DOTTED")");
  setExtra(d, "textDecorationThickness", R"({"value": 2, "units": "PIXELS"})");
  setExtra(d, "textUnderlineOffset", R"({"value": 3, "units": "PIXELS"})");
  setExtra(d, "textDecorationFillPaints", R"([{"type": "SOLID", "color": {"r": 1, "g": 0, "b": 0, "a": 1}, "opacity": 1, "visible": true}])");
  auto D = lay(d);
  REQUIRE(D->decorations.size() > 4);
  CHECK(D->decorations[0].round);
  CHECK(D->decorations[0].rect.h == doctest::Approx(2));
  CHECK(D->decorations[0].rect.y == doctest::Approx(D->lines[0].baseline + 3));
  const auto* fills = decorationFills(*D, D->decorations[0]);
  REQUIRE(fills);
  CHECK((*fills)[0].color.r == doctest::Approx(1));
  CHECK((*fills)[0].color.g == doctest::Approx(0));

  setExtra(d, "textDecorationStyle", R"("WAVY")");
  auto W = lay(d);
  bool turned = false;
  for (const Decoration& x : W->decorations) turned |= std::fabs(x.angle) > 0.1;
  CHECK(turned);
}

TEST_CASE("text round: vertical trim (cap height to baseline), wrap balance") {
  loadInter();
  NodeProps p = textProps("Hg\nHg");
  double standard = lay(p)->size.y;
  setExtra(p, "leadingTrim", R"("CAP_HEIGHT")");
  auto L = lay(p);
  CHECK(L->size.y < standard);
  CHECK(L->size.y == doctest::Approx(L->lines.back().baseline));
  Font* f = FontRegistry::get().find({"Inter", "Regular", ""});
  CHECK(L->lines[0].baseline == doctest::Approx(f->capHeight * 12).epsilon(0.001));

  NodeProps b = textProps("aaa bbb ccc ddd eee fff ggg hhh iii");
  b.text().textAutoResize = TextAutoResize::HEIGHT;
  b.size = {160, 20};
  auto A = lay(b);
  REQUIRE(A->lines.size() == 2);
  setExtra(b, "textWrapStyle", R"("BALANCE")");
  auto B = lay(b);
  REQUIRE(B->lines.size() == 2);
  CHECK(std::fabs(B->lines[0].width - B->lines[1].width) < std::fabs(A->lines[0].width - A->lines[1].width));
}

TEST_CASE("text round: run fields kept as data go to the edited range; the Typography summary shows them mixed") {
  Editor e = makeEditor(textNode("Hello world"));
  REQUIRE(e.startTextEdit(T, false) == OK);
  // Select "world" and link it.
  for (int i = 0; i < 5; i++) key(e, KeyCode::ArrowLeft, MOD_SHIFT);
  NodeChange c = NodeChange::changed(T);
  c.mask = F_EXTRA | F_TEXT_DECORATION;
  c.props.extra["hyperlink"] = extraBytes("hyperlink", R"({"url": "https://example.com"})");
  c.props.text().textDecoration = TextDecoration::UNDERLINE;
  REQUIRE(e.setProps({T}, c, 0) == OK);
  const NodeProps& p = e.document().get(T)->props;
  CHECK(p.extra.count("hyperlink") == 0);  // not the node's
  REQUIRE(p.text().textData.styleOverrideTable.size() == 1);
  CHECK(!p.text().textData.styleOverrideTable[0].extra.empty());
  const TextLayout* L = e.textLayout(T);
  REQUIRE(L->links.size() == 1);
  CHECK(L->links[0].start == 6);
  // The selection's summary: one link; the whole text's: mixed.
  json::Value sel;
  REQUIRE(json::parse(e.textRangeStyle(T, 0, 0, true), sel));
  CHECK(!isMixed(sel, "hyperlink"));
  CHECK(sel.get("values")->get("hyperlink")->get("url")->string == "https://example.com");
  json::Value all;
  REQUIRE(json::parse(e.textRangeStyle(T, 0, ~0u, false), all));
  CHECK(isMixed(all, "hyperlink"));
  CHECK(isMixed(all, "textDecoration"));
  CHECK(!isMixed(all, "fontSize"));
  // A whole-layer edit removes it from the runs.
  e.endTextEdit();
  NodeChange off = NodeChange::changed(T);
  off.mask = F_EXTRA;
  off.props.extra["hyperlink"] = "";
  REQUIRE(e.setProps({T}, off, 0) == OK);
  CHECK(e.textLayout(T)->links.empty());
  json::Value after = rangeStyle(e, T);
  CHECK(!isMixed(after, "hyperlink"));
}

TEST_CASE("text round: lists from the keyboard — ⇧⌘8, Tab / ⇧Tab, Return on an empty item, \"- \" autoformat, ⌘Z") {
  Editor e = makeEditor(textNode("Alpha"));
  REQUIRE(e.startTextEdit(T, false) == OK);
  key(e, KeyCode::Digit8, MOD_PRIMARY | MOD_SHIFT);
  auto line0 = [&]() { return readLine(e.document().get(T)->props.text().textData.lines.at(0)); };
  CHECK(line0().type == LineType::UNORDERED_LIST);
  CHECK(line0().indentationLevel == 1);
  key(e, KeyCode::Tab);
  CHECK(line0().indentationLevel == 2);
  key(e, KeyCode::Tab, MOD_SHIFT);
  CHECK(line0().indentationLevel == 1);
  CHECK(e.document().get(T)->props.text().textData.characters == "Alpha");  // no tab typed
  // Return twice: a new item, then (empty) out of the list.
  key(e, KeyCode::Enter);
  auto& t = e.document().get(T)->props.text().textData;
  REQUIRE(t.lines.size() == 2);
  CHECK(readLine(t.lines[1]).type == LineType::UNORDERED_LIST);
  key(e, KeyCode::Enter);
  CHECK(readLine(e.document().get(T)->props.text().textData.lines[1]).type == LineType::PLAIN);
  // "1. " at a paragraph's start: a numbered item, the prefix gone.
  e.textInput("1");
  e.textInput(".");
  e.textInput(" ");
  const TextData& d = e.document().get(T)->props.text().textData;
  CHECK(d.characters == "Alpha\n");
  CHECK(readLine(d.lines[1]).type == LineType::ORDERED_LIST);
  // ⇧⌘7 on a numbered item takes the list away.
  key(e, KeyCode::Digit7, MOD_PRIMARY | MOD_SHIFT);
  CHECK(readLine(e.document().get(T)->props.text().textData.lines[1]).type == LineType::PLAIN);
  // The paragraph op outside editing: the whole text.
  e.endTextEdit();
  REQUIRE(e.textParagraphs(T, 0, 1) == OK);
  for (const std::string& l : e.document().get(T)->props.text().textData.lines) CHECK(readLine(l).type == LineType::ORDERED_LIST);
  json::Value v = rangeStyle(e, T);
  CHECK(v.get("values")->get("lineType")->string == "ORDERED_LIST");
}

TEST_CASE("r10 Text › Text direction: the paragraphs' sourceDirectionality, as Figma writes it; one undo step") {
  Editor e = makeEditor(textNode("Alpha\nBeta"));
  auto lines = [&]() { return e.document().get(T)->props.text().textData.lines; };
  REQUIRE(e.textParagraphs(T, 2, 2) == OK);
  REQUIRE(lines().size() == 2);
  for (const std::string& l : lines()) CHECK(readLine(l).direction == 2);
  json::Value v = rangeStyle(e, T);
  CHECK(v.get("values")->get("sourceDirectionality")->string == "RTL");
  // Editing: only the caret's paragraph.
  REQUIRE(e.startTextEdit(T, false) == OK);
  key(e, KeyCode::ArrowUp, MOD_PRIMARY);
  REQUIRE(e.textParagraphs(T, 2, 1) == OK);
  CHECK(readLine(lines()[0]).direction == 1);
  CHECK(readLine(lines()[1]).direction == 2);
  e.endTextEdit();
  e.command(CommandId::UNDO);
  CHECK(readLine(lines()[0]).direction == 2);
  // Auto again: the default (no explicit intent).
  REQUIRE(e.textParagraphs(T, 2, 0) == OK);
  CHECK(readLine(lines()[1]).direction == 0);
}

TEST_CASE("r10 Text › Spell check: the edited text's misspelled words underlined, gone when the edit ends") {
  Editor e = makeEditor(textNode("Helo wrld"));
  CommandArgs a;
  REQUIRE(json::parse(R"({"ranges":[[0,4],[5,9]]})", a.raw));
  CHECK(e.command(CommandId::SET_SPELLING_MARKS, a) == E_INVALID);  // nothing edited
  REQUIRE(e.startTextEdit(T, false) == OK);
  REQUIRE(e.command(CommandId::SET_SPELLING_MARKS, a) == OK);
  CHECK(e.overlay().misspelled.size() == 2);
  e.endTextEdit();
  REQUIRE(e.startTextEdit(T, false) == OK);
  CHECK(e.overlay().misspelled.empty());
}

TEST_CASE("text round: a variable, a fill variable and a text style applied to part of a text go to its runs") {
  Editor e = makeEditor(textNode("Hello world"));
  auto run = [&](CommandId id, const std::string& a) {
    CommandArgs args;
    REQUIRE(json::parse(a, args.raw));
    return e.command(id, args);
  };
  auto q = [](Guid g) { return "\"" + g.toString() + "\""; };
  REQUIRE(run(CommandId::CREATE_VARIABLE_COLLECTION, R"({"name":"Type"})") == OK);
  Guid set = e.lastCreated()[0], mode = e.lastCreated()[1];
  REQUIRE(run(CommandId::CREATE_VARIABLE, "{\"collection\":" + q(set) + R"(,"type":"FLOAT","name":"big","value":24})") == OK);
  Guid big = e.lastCreated()[0];
  REQUIRE(run(CommandId::CREATE_VARIABLE, "{\"collection\":" + q(set) + R"(,"type":"COLOR","name":"red","value":{"r":1,"g":0,"b":0,"a":1}})") == OK);
  Guid red = e.lastCreated()[0];
  REQUIRE(e.startTextEdit(T, false) == OK);
  for (int i = 0; i < 5; i++) key(e, KeyCode::ArrowLeft, MOD_SHIFT);  // "world"
  REQUIRE(run(CommandId::BIND_VARIABLE, "{\"refs\":[" + q(T) + "],\"target\":\"FONT_SIZE\",\"variable\":" + q(big) + "}") == OK);
  REQUIRE(run(CommandId::BIND_VARIABLE, "{\"refs\":[" + q(T) + "],\"target\":\"fillPaints[0].color\",\"variable\":" + q(red) + "}") == OK);
  const NodeProps& p = e.document().get(T)->props;
  CHECK(p.text().fontSize == 12);  // the layer keeps its own
  CHECK(p.parameterConsumptionMap.empty());
  const TextLayout* L = e.textLayout(T);
  CHECK(L->styles[L->styleOf[0]].fontSize == 12);
  CHECK(L->styles[L->styleOf[6]].fontSize == 24);  // resolved from the variable
  REQUIRE(L->styles[L->styleOf[6]].fills);
  CHECK((*L->styles[L->styleOf[6]].fills)[0].color.r == doctest::Approx(1));
  CHECK((*L->styles[L->styleOf[6]].fills)[0].color.g == doctest::Approx(0));
  json::Value sel;
  REQUIRE(json::parse(e.textRangeStyle(T, 0, 0, true), sel));
  CHECK(sel.get("values")->get("fontSize")->number == 24);
  CHECK(!sel.get("values")->get("parameterConsumptionMap")->isNull());
  // The variable's value changes: the run follows.
  e.endTextEdit();
  REQUIRE(run(CommandId::SET_VARIABLE_VALUE, "{\"variable\":" + q(big) + ",\"mode\":" + q(mode) + ",\"value\":30}") == OK);
  L = e.textLayout(T);
  CHECK(L->styles[L->styleOf[6]].fontSize == 30);
  CHECK(L->styles[L->styleOf[0]].fontSize == 12);

  // A text style (Inter Bold 20) on "Hello".
  NodeChange src = textNode("Style");
  src.guid = Guid{1, 60};
  src.props.text().fontName = {"Inter", "Bold", ""};
  src.props.text().fontSize = 20;
  REQUIRE(e.applyChanges({src}, 0) == OK);
  REQUIRE(run(CommandId::CREATE_STYLE, "{\"type\":\"TEXT\",\"name\":\"Heading\",\"from\":" + q(src.guid) + "}") == OK);
  Guid style = e.lastCreated()[0];
  REQUIRE(e.startTextEdit(T, false) == OK);
  key(e, KeyCode::ArrowUp, MOD_PRIMARY);  // the text's start
  for (int i = 0; i < 5; i++) key(e, KeyCode::ArrowRight, MOD_SHIFT);
  REQUIRE(run(CommandId::APPLY_STYLE, "{\"refs\":[" + q(T) + "],\"style\":" + q(style) + ",\"target\":\"TEXT\"}") == OK);
  L = e.textLayout(T);
  CHECK(L->styles[L->styleOf[0]].fontSize == 20);
  CHECK(L->styles[L->styleOf[0]].fontName.style == "Bold");
  CHECK(L->styles[L->styleOf[6]].fontSize == 30);  // "world" keeps its variable
  CHECK(!e.document().get(T)->props.refs().styleIdForText.present());
  json::Value all;
  REQUIRE(json::parse(e.textRangeStyle(T, 0, ~0u, false), all));
  CHECK(isMixed(all, "styleIdForText"));
  CHECK(isMixed(all, "fontSize"));
}

TEST_CASE("text round: links in text work in presentation — a URL opens, a frame link navigates") {
  loadInter();
  const Guid A{1, 1}, B{1, 2}, L1{1, 11}, L2{1, 12};
  auto nodes = baseChanges();
  nodes.push_back(make(A, NodeType::FRAME, kPage, "!", {0, 0, 375, 812}, "Home"));
  nodes.push_back(make(B, NodeType::FRAME, kPage, "\"", {500, 0, 375, 812}, "Details"));
  NodeChange url = make(L1, NodeType::TEXT, A, "!", {20, 100, 200, 20}, "Docs");
  url.props.text().textData.characters = "Docs";
  url.props.text().textAutoResize = TextAutoResize::WIDTH_AND_HEIGHT;
  url.props.extra["hyperlink"] = extraBytes("hyperlink", R"({"url": "https://help.figma.com"})");
  nodes.push_back(url);
  NodeChange node = make(L2, NodeType::TEXT, A, "\"", {20, 200, 200, 20}, "Next");
  node.props.text().textData.characters = "Next";
  node.props.text().textAutoResize = TextAutoResize::WIDTH_AND_HEIGHT;
  node.props.extra["hyperlink"] = extraBytes("hyperlink", R"({"guid": {"sessionID": 1, "localID": 2}})");
  nodes.push_back(node);
  Editor ed;
  ed.setSessionID(1);
  ed.setViewport(375, 812, 1, 375, 812);
  ed.loadDocument(nodes, kNoGuid);
  ed.takeEvents();
  proto::Player player{ed};
  REQUIRE(player.start(kPage, kNoGuid));
  player.tick(16);
  auto click = [&](double x, double y) {
    player.pointer(PointerEvent::MOVE, x, y, 0, 0);
    player.pointer(PointerEvent::DOWN, x, y, 1, 0);
    player.pointer(PointerEvent::UP, x, y, 0, 0);
  };
  player.pointer(PointerEvent::MOVE, 25, 108, 0, 0);
  CHECK(player.hotspotUnder());  // a hand over the link
  player.takeEvents();
  click(25, 108);
  bool opened = false;
  for (auto& ev : player.takeEvents())
    if (ev.kind == proto::Player::Event::Kind::OPEN_URL) opened = ev.url == "https://help.figma.com";
  CHECK(opened);
  CHECK(player.screen() == A);
  click(25, 208);
  CHECK(player.screen() == B);
}
