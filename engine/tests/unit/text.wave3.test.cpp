// Text, Atlas wave 3 (docs/research/atlas/06-text-typography.md §14): bidi (UAX #9 levels, a line's visual order,
// right-to-left paragraphs, carets and selections), line heights by textUserLayoutVersion, Auto within 0.1, and the
// optical size following the font size.
#include <cmath>
#include <string>

#include "base/Json.h"
#include "doctest.h"
#include "editor/Editor.h"
#include "Helpers.h"
#include "scene/CodecKiwi.h"
#include "TextHelpers.h"
#include "text/Bidi.h"
#include "text/TextFeatures.h"
#include "text/TextLayout.h"
#include "text/Unicode.h"

using namespace eng;
using namespace eng::test;
using namespace eng::text;

namespace {

std::unique_ptr<TextLayout> lay(const NodeProps& p) { return layoutText(p, optionsFor(p)); }

void setExtra(NodeProps& p, const char* key, const char* jsonValue) {
  json::Value v;
  REQUIRE(json::parse(jsonValue, v));
  std::string bytes = codec::extraFromJson("NodeChange", key, v);
  REQUIRE(!bytes.empty());
  p.extra[key] = bytes;
}

std::vector<uint8_t> levelsOf(const char16_t* s, uint8_t base) {
  std::vector<uint8_t> levels;
  std::vector<BidiClass> classes;
  resolveLevels(s, base, levels, classes);
  return levels;
}

// The x of the first glyph of the cluster starting at UTF-16 `cluster`.
double xOf(const TextLayout& L, uint32_t cluster) {
  for (const LaidGlyph& g : L.glyphs)
    if (g.cluster == cluster && !g.marker) return g.x;
  return -1;
}

}  // namespace

TEST_CASE("text wave 3: Bidi_Class from the generated table") {
  CHECK(bidiClass('A') == BidiClass::L);
  CHECK(bidiClass(0x05D0) == BidiClass::R);   // א
  CHECK(bidiClass(0x0627) == BidiClass::AL);  // ا
  CHECK(bidiClass('1') == BidiClass::EN);
  CHECK(bidiClass(0x0661) == BidiClass::AN);  // ١
  CHECK(bidiClass(' ') == BidiClass::WS);
  CHECK(bidiClass('(') == BidiClass::ON);
  CHECK(bidiClass(0x2067) == BidiClass::RLI);
  CHECK(bidiClass(0x0300) == BidiClass::NSM);
  CHECK(bidiClass(0x1F600) == BidiClass::ON);  // 😀
  CHECK(bidiClass(0x05FF) == BidiClass::R);    // unassigned in the Hebrew block: R by default
}

TEST_CASE("text wave 3: UAX #9 levels — paragraphs, numbers, brackets, isolates, L1 and L2") {
  CHECK(paragraphLevel(u"abc") == 0);
  CHECK(paragraphLevel(u"אbc") == 1);
  CHECK(paragraphLevel(u"123 א") == 1);  // numbers aren't strong
  CHECK(paragraphLevel(u"⁦א⁩abc") == 0);  // an isolate's content is skipped
  CHECK(paragraphLevel(u"...", 1) == 1);
  CHECK_FALSE(hasRtl(u"Hello, world 123"));
  CHECK(hasRtl(u"Hello שלום"));

  // Hebrew after Latin: the space between them takes the paragraph's direction.
  CHECK(levelsOf(u"ab אב", 0) == std::vector<uint8_t>{0, 0, 0, 1, 1});
  // European numbers in a right-to-left paragraph go up two levels (left to right inside it).
  CHECK(levelsOf(u"א 12", 1) == std::vector<uint8_t>{1, 1, 2, 2});
  // After an Arabic letter they are Arabic numbers (W2), also at 2.
  CHECK(levelsOf(u"ا 12", 1) == std::vector<uint8_t>{1, 1, 2, 2});
  // A separator between two numbers joins them (W4): 1.5 is one number.
  CHECK(levelsOf(u"א 1.5", 1) == std::vector<uint8_t>{1, 1, 2, 2, 2});
  // Brackets (N0): "(cd)" in Hebrew — the brackets take the context's R, their content stays L.
  CHECK(levelsOf(u"א (cd) ב", 1) == std::vector<uint8_t>{1, 1, 1, 2, 2, 1, 1, 1});
  // An override: LRO … PDF lays Hebrew left to right.
  auto o = levelsOf(u"‭אב‬", 0);
  CHECK(o[1] == 2);
  CHECK(o[2] == 2);
  // A right-to-left isolate inside Latin text: its content is at 1, the text around it at 0.
  auto iso = levelsOf(u"a⁧b⁩c", 0);
  CHECK(iso[0] == 0);
  CHECK(iso[2] == 2);  // L inside an RTL isolate
  CHECK(iso[4] == 0);
  // A surrogate pair's two units share one level.
  auto pair = levelsOf(u"א\U0001F600", 1);
  REQUIRE(pair.size() == 3);
  CHECK(pair[1] == pair[2]);

  // L1: the trailing space goes back to the paragraph's level.
  std::vector<uint8_t> levels;
  std::vector<BidiClass> classes;
  resolveLevels(u"אb ", 1, levels, classes);
  lineLevels(classes, 1, 0, 3, levels);
  CHECK(levels == std::vector<uint8_t>{1, 2, 1});
  // L2: runs reversed from the highest level down.
  CHECK(visualOrder({0, 0, 1, 1, 1, 0}) == std::vector<uint32_t>{0, 1, 4, 3, 2, 5});
  CHECK(visualOrder({1, 1, 2, 2, 1}) == std::vector<uint32_t>{4, 2, 3, 1, 0});
}

TEST_CASE("text wave 3: a Hebrew word in a Latin line runs right to left; the paragraph's direction comes from its text") {
  loadInter();
  // "ab אבג cd": the Hebrew word is reversed in place.
  NodeProps p = textProps("ab \xD7\x90\xD7\x91\xD7\x92 cd");
  auto L = lay(p);
  REQUIRE(L->lines.size() == 1);
  CHECK(L->lines[0].boxCount == 9);
  CHECK_FALSE(L->lines[0].rtl);
  CHECK(xOf(*L, 0) < xOf(*L, 1));
  CHECK(xOf(*L, 3) > xOf(*L, 5));  // א right of ג
  CHECK(xOf(*L, 5) > xOf(*L, 1));  // after "ab "
  CHECK(xOf(*L, 7) > xOf(*L, 3));  // "cd" after the word
  // Carets: inside the Hebrew word they run leftwards.
  CHECK(L->caretXs[4] < L->caretXs[3]);
  CHECK(L->caretXs[5] < L->caretXs[4]);
  // Selecting the Hebrew word gives one box over it.
  auto rects = L->selectionRects(3, 6);
  REQUIRE(rects.size() == 1);
  CHECK(rects[0].x == doctest::Approx(xOf(*L, 5)).epsilon(0.001));
  // Selecting "b אב" (from inside Latin into Hebrew): two boxes, not one spanning the unselected ג.
  CHECK(L->selectionRects(1, 5).size() == 2);

  // A Hebrew paragraph is right to left: its first letter on the right, its end caret on the left.
  NodeProps h = textProps("\xD7\x90\xD7\x91\xD7\x92");
  auto H = lay(h);
  CHECK(H->lines[0].rtl);
  CHECK(xOf(*H, 0) > xOf(*H, 2));
  CHECK(H->caretXs[0] > H->caretXs[3]);
  CHECK(H->lines[0].caretEnd == doctest::Approx(H->lines[0].x));
}

TEST_CASE("text wave 3: Text direction RTL lays a Latin paragraph out from the right; textBidiVersion 0 stays left to right") {
  loadInter();
  // "abc 12" in a paragraph set right to left: its words keep their order, its end caret is on the left, and the
  // trailing space hangs on the left (the content keeps its place).
  NodeProps p = textProps("abc ");
  std::string line;
  writeLineDirection(line, 2);
  p.text().textData.lines = {line};
  auto L = lay(p);
  CHECK(L->lines[0].rtl);
  CHECK(xOf(*L, 0) < xOf(*L, 1));
  CHECK(L->lines[0].caretEnd < xOf(*L, 0));
  CHECK(xOf(*L, 0) == doctest::Approx(L->lines[0].x));

  // An older text (textBidiVersion 0): Hebrew is drawn in logical order, as before bidi.
  NodeProps old = textProps("\xD7\x90\xD7\x91\xD7\x92");
  setExtra(old, "textBidiVersion", "0");
  auto O = lay(old);
  CHECK_FALSE(O->lines[0].rtl);
  CHECK(O->lines[0].boxCount == 0);
  CHECK(xOf(*O, 0) < xOf(*O, 2));
  // Version 1 (Figma's current) is bidi, as is a text without the field.
  setExtra(old, "textBidiVersion", "1");
  CHECK(lay(old)->lines[0].rtl);
}

TEST_CASE("text wave 3: line heights keep their fraction on an older text (textUserLayoutVersion 0); Auto is within 0.1 of 100%") {
  loadInter();
  NodeProps p = textProps("Hg", 13);
  p.text().lineHeight = {1.5, NumberUnits::RAW};  // 19.5
  CHECK(lay(p)->lines[0].height == 20);
  setExtra(p, "textUserLayoutVersion", "0");
  CHECK(lay(p)->lines[0].height == doctest::Approx(19.5));
  setExtra(p, "textUserLayoutVersion", "1");
  CHECK(lay(p)->lines[0].height == 20);
  // PERCENT of the font's own line height, and Auto: rounded on version 1, as is on version 0.
  NodeProps a = textProps("Hg", 13);
  double whole = lay(a)->lines[0].height;
  CHECK(whole == std::round(whole));
  setExtra(a, "textUserLayoutVersion", "0");
  double exact = lay(a)->lines[0].height;
  CHECK(exact != std::round(exact));
  CHECK(std::fabs(exact - whole) <= 0.5);
  // 100.05 % is Auto (|v − 100| < 0.1), 100.2 % is not.
  NodeProps near = textProps("Hg", 13);
  near.text().lineHeight = {100.05f, NumberUnits::PERCENT};
  CHECK(lay(near)->lines[0].height == whole);
  CHECK(autoLineHeight(lay(near)->styles[0].font, 13) == whole);
}

TEST_CASE("text wave 3: a font's optical size follows the font size unless the text detaches it") {
  loadInter();
  auto& fonts = FontRegistry::get();
  int32_t face = addFontFile(std::string(ENG_FONTS_DIR) + "/InterVariable.ttf");  // Inter 4: opsz 14 … 32
  REQUIRE(face >= 0);
  fonts.bind("Inter Wave3", "Regular", face);
  fonts.takeRequests();
  auto opsz = [](const TextLayout& L) {
    for (const AxisInfo& a : L.styles[0].font->axes())
      if (tagString(a.tag) == "opsz") return a.value;
    return -1.f;
  };
  NodeProps p = textProps("Hamburgefonstiv", 24);
  p.text().fontName = {"Inter Wave3", "Regular", ""};
  CHECK(opsz(*lay(p)) == doctest::Approx(24));
  p.text().fontSize = 8;
  CHECK(opsz(*lay(p)) == doctest::Approx(14));  // clamped into the axis
  p.text().fontSize = 64;
  CHECK(opsz(*lay(p)) == doctest::Approx(32));
  // A stored opsz is replaced while it follows …
  setExtra(p, "fontVariations", R"([{"axisTag": 1869640570, "value": 20}])");  // 'opsz'
  CHECK(opsz(*lay(p)) == doctest::Approx(32));
  // … and kept once detached ("Set optical size automatically" off).
  setExtra(p, "detachOpticalSizeFromFontSize", "true");
  CHECK(opsz(*lay(p)) == doctest::Approx(20));
  // Inter 3.19 has no opsz: nothing changes.
  NodeProps q = textProps("Hamburgefonstiv", 30);
  CHECK(lay(q)->styles[0].font == fonts.find({"Inter", "Regular", ""}));
}

namespace {

const Guid F{1, 1}, T{1, 2};

Editor editorWith(const std::string& chars) {
  loadInter();
  NodeChange c = make(T, NodeType::TEXT, F, "#", {10, 10, 100, 20}, chars);
  c.props.text().textData.characters = chars;
  c.props.text().textAutoResize = TextAutoResize::WIDTH_AND_HEIGHT;
  c.props.size = layoutText(c.props, {})->size;
  auto nodes = baseChanges();
  nodes.push_back(make(F, NodeType::FRAME, kPage, "!", {300, 0, 200, 200}, "Frame 1"));
  nodes.push_back(c);
  Editor e;
  e.setSessionID(1);
  e.setViewport(800, 600, 2, 1600, 1200);
  e.loadDocument(nodes, kNoGuid);
  e.takeEvents();
  return e;
}

json::Value summaryOf(Editor& e) {
  json::Value v;
  REQUIRE(json::parse(e.textRangeStyle(T, 0, ~0u, false), v));
  return v;
}

std::string versionBytes(const char* key, const char* value) {
  json::Value v;
  REQUIRE(json::parse(value, v));
  return codec::extraFromJson("NodeChange", key, v);
}

}  // namespace

TEST_CASE("text wave 3: a new text is stamped with today's layout versions; Revert and Update lay the text out again") {
  Editor e = editorWith("Hg");
  REQUIRE(e.setTool(Tool::TEXT) == OK);
  e.pointer(PointerEvent::DOWN, 40, 300, 0, 1, 0, 1);
  e.pointer(PointerEvent::UP, 40, 300, 0, 0, 0);
  REQUIRE(e.textEditing());
  REQUIRE(e.selection().size() == 1);
  TextFeatures made = nodeFeatures(e.document().get(e.selection()[0])->props.extra);
  CHECK(made.userLayoutVersion == kLatestTextLayoutVersion);
  CHECK(made.explicitLayoutVersion == kLatestTextLayoutVersion);
  CHECK(made.bidiVersion == kLatestTextLayoutVersion);
  e.endTextEdit();

  // A 13 px text at 150 %: 20 px lines; Revert (textUserLayoutVersion 0): 19.5; Update: 20 again.
  NodeChange lh = NodeChange::changed(T);
  lh.mask = F_FONT_SIZE | F_LINE_HEIGHT;
  lh.props.text().fontSize = 13;
  lh.props.text().lineHeight = {1.5, NumberUnits::RAW};
  REQUIRE(e.setProps({T}, lh, 0) == OK);
  CHECK(e.textLayout(T)->lines[0].height == 20);
  NodeChange revert = NodeChange::changed(T);
  revert.mask = F_EXTRA;
  revert.props.extra["textUserLayoutVersion"] = versionBytes("textUserLayoutVersion", "0");
  REQUIRE(e.setProps({T}, revert, 0) == OK);
  CHECK(e.textLayout(T)->lines[0].height == doctest::Approx(19.5));
  NodeChange update = NodeChange::changed(T);
  update.mask = F_EXTRA;
  update.props.extra["textUserLayoutVersion"] = versionBytes("textUserLayoutVersion", "1");
  REQUIRE(e.setProps({T}, update, 0) == OK);
  CHECK(e.textLayout(T)->lines[0].height == 20);
}

TEST_CASE("text wave 3: the Typography summary tells the paragraphs' direction and whether the text has right-to-left characters") {
  Editor latin = editorWith("Hello");
  json::Value a = summaryOf(latin);
  CHECK(a.get("values")->get("direction")->string == "LTR");
  CHECK_FALSE(a.get("values")->get("hasRtlText")->boolean);
  Editor hebrew = editorWith("\xD7\xA9\xD7\x9C\xD7\x95\xD7\x9D world");  // "שלום world": Auto resolves right to left
  json::Value h = summaryOf(hebrew);
  CHECK(h.get("values")->get("direction")->string == "RTL");
  CHECK(h.get("values")->get("sourceDirectionality")->string == "AUTO");
  CHECK(h.get("values")->get("hasRtlText")->boolean);
}

TEST_CASE("text wave 3: fallback fonts — a script's own Noto family is asked for first, other scripts' are skipped") {
  CHECK(std::string(scriptFallback(0x0E01)) == "Noto Sans Thai");
  CHECK(std::string(scriptFallback(0x0627)) == "Noto Sans Arabic");
  CHECK(std::string(scriptFallback(0x4E00)) == "Noto Sans SC");
  CHECK(std::string(scriptFallback(0x3042)) == "Noto Sans JP");
  CHECK(std::string(scriptFallback(0xAC00)) == "Noto Sans KR");
  CHECK(scriptFallback('A') == nullptr);
  CHECK(scriptFallback(0x2192) == nullptr);  // →: a symbol, for the general families

  loadInter();
  auto& fonts = FontRegistry::get();
  fonts.takeRequests();
  fonts.setFallbacks({"Wave3 Noto Sans", "Noto Sans Arabic", "Noto Sans Thai"});
  // ก: Noto Sans Thai first (requested: nothing until it arrives); Noto Sans Arabic is never asked for.
  CHECK(fonts.fallbackFor(0x0E01) == nullptr);
  auto asked = fonts.takeRequests();
  REQUIRE(asked.size() == 1);
  CHECK(asked[0].family == "Noto Sans Thai");
  // It turns out missing: the general families are tried next, the Arabic one still not.
  fonts.markMissing("Noto Sans Thai", "Regular");
  CHECK(fonts.fallbackFor(0x0E01) == nullptr);
  asked = fonts.takeRequests();
  REQUIRE(asked.size() == 1);
  CHECK(asked[0].family == "Wave3 Noto Sans");
  fonts.markMissing("Wave3 Noto Sans", "Regular");
  CHECK(fonts.fallbackFor(0x0E01) == nullptr);
  CHECK(fonts.takeRequests().empty());
  fonts.setFallbacks({});
}

TEST_CASE("text wave 3: a variable font's axes list their named instances' values (the Variable tab's hints)") {
  loadInter();
  Font* f = FontRegistry::get().find({"Inter", "Regular", ""});
  REQUIRE(f != nullptr);
  bool found = false;
  for (const AxisInfo& a : f->axes())
    if (tagString(a.tag) == "wght") {
      found = true;
      CHECK(a.instances.size() == 9);  // Thin … Black
      CHECK(a.instances.front() == doctest::Approx(100));
      CHECK(a.instances.back() == doctest::Approx(900));
    }
  CHECK(found);
}
