// Text layout: shaping with HarfBuzz, line breaking, line heights, alignment,
// truncation, decorations, case, fallback and missing fonts, against Figma's
// own numbers where a sample has them (docs/research/figma/samples/structure.fig).
#include <cmath>
#include <fstream>
#include <sstream>
#include <string>

#include "base/Json.h"
#include "scene/CodecJson.h"

#include "doctest.h"
#include "render/GlyphCoverage.h"
#include "TextHelpers.h"
#include "text/TextLayout.h"
#include "text/Unicode.h"

using namespace eng;
using namespace eng::test;
using namespace eng::text;

namespace {

std::unique_ptr<TextLayout> lay(const NodeProps& p) { return layoutText(p, optionsFor(p)); }

double lineWidthOf(const TextLayout& L, size_t line) { return L.lines.at(line).width; }

}  // namespace

TEST_CASE("text: Inter loads, its metrics are Figma's font line height") {
  loadInter();
  Font* f = FontRegistry::get().find({"Inter", "Regular", ""});
  REQUIRE(f != nullptr);
  CHECK(f->covers('A'));
  CHECK(f->lineHeightEm() == doctest::Approx(1.21).epsilon(0.01));  // Figma's fontLineHeight for Inter: 1.2102
  CHECK(f->outline(f->glyphFor('A')).curveCount() > 4);
  // Named instances: Bold is heavier than Regular (a wider "A").
  Font* bold = FontRegistry::get().find({"Inter", "Bold", ""});
  REQUIRE(bold != nullptr);
  CHECK(bold->advance(bold->glyphFor('A')) > f->advance(f->glyphFor('A')) - 1e-9);
  CHECK(FontRegistry::get().find({"Inter", "Semi Bold", ""}) != nullptr);
}

TEST_CASE("text: \"ABC\" in Inter Regular 12 lands where Figma puts it (structure.fig)") {
  loadInter();
  NodeProps p = textProps("ABC");
  p.text().textAutoResize = TextAutoResize::NONE;
  p.size = {42, 21};
  auto L = lay(p);
  REQUIRE(L->glyphs.size() == 3);
  // Figma: x = 0, 8.109375, 15.9140625; baseline 11.8636; line height 15; width 24.6445.
  CHECK(std::fabs(L->glyphs[0].x - 0) <= 0.5);
  CHECK(std::fabs(L->glyphs[1].x - 8.109375) <= 0.5);
  CHECK(std::fabs(L->glyphs[2].x - 15.9140625) <= 0.5);
  CHECK(L->lines[0].height == 15);
  CHECK(L->lines[0].baseline == doctest::Approx(11.8636).epsilon(0.01));
  CHECK(std::fabs(L->lines[0].width - 24.64453125) <= 0.5);
  CHECK(L->glyphs[0].y == doctest::Approx(11.8636).epsilon(0.01));
  CHECK_FALSE(L->missingFont);
}

TEST_CASE("text: Auto line height is the font's, rounded (Figma: 15 / 17 / 19 / 29 for Inter 12 / 14 / 16 / 24)") {
  loadInter();
  for (auto [size, want] : {std::pair{12.0, 15.0}, {14.0, 17.0}, {16.0, 19.0}, {24.0, 29.0}}) {
    auto L = lay(textProps("Hg", size));
    CHECK(L->size.y == want);
  }
  NodeProps px = textProps("Hg", 16);
  px.text().lineHeight = {24, NumberUnits::PIXELS};
  CHECK(lay(px)->size.y == 24);
  NodeProps raw = textProps("Hg", 20);
  raw.text().lineHeight = {1.5, NumberUnits::RAW};  // the UI's 150%
  CHECK(lay(raw)->size.y == doctest::Approx(30));
}

TEST_CASE("text: auto width is the widest line; paragraphs and paragraph spacing") {
  loadInter();
  NodeProps p = textProps("Hello\nWorld wide web");
  p.text().paragraphSpacing = 10;
  auto L = lay(p);
  REQUIRE(L->lines.size() == 2);
  // Auto width: the widest line rounded up to whole pixels (Figma's layoutSize).
  CHECK(L->size.x == std::ceil(lineWidthOf(*L, 1)));
  CHECK(lineWidthOf(*L, 1) > lineWidthOf(*L, 0));
  CHECK(L->lines[1].top == doctest::Approx(15 + 10));
  CHECK(L->size.y == doctest::Approx(15 + 10 + 15));
  CHECK(L->lines[0].start == 0);
  CHECK(L->lines[0].end == 6);  // "Hello\n"
  CHECK(L->lines[0].hardEnd);
  CHECK(L->lines[1].start == 6);
}

TEST_CASE("text: line breaking at word boundaries, long words at characters, trailing spaces hang") {
  loadInter();
  NodeProps p = textProps("The quick brown fox jumps over the lazy dog");
  p.text().textAutoResize = TextAutoResize::HEIGHT;
  p.size = {80, 0};
  auto L = lay(p);
  CHECK(L->lines.size() >= 3);
  for (auto& l : L->lines) CHECK(l.width <= 80 + 1e-3);
  // Each soft line ends after a space, the next starts with a letter.
  for (size_t i = 0; i + 1 < L->lines.size(); i++) {
    CHECK(L->text[L->lines[i].end - 1] == u' ');
    CHECK(L->text[L->lines[i + 1].start] != u' ');
  }
  NodeProps longWord = textProps("Supercalifragilisticexpialidocious");
  longWord.text().textAutoResize = TextAutoResize::HEIGHT;
  longWord.size = {60, 0};
  auto W = lay(longWord);
  CHECK(W->lines.size() >= 3);
  for (auto& l : W->lines) CHECK(l.width <= 60 + 1e-3);
  // U+2028 breaks a line inside a paragraph.
  auto B = lay(textProps(std::string("one\xE2\x80\xA8two")));
  CHECK(B->lines.size() == 2);
  CHECK_FALSE(B->lines[0].paragraphEnd);
}

TEST_CASE("text: horizontal alignment in a fixed width, vertical alignment in a fixed box") {
  loadInter();
  NodeProps p = textProps("Hi");
  p.text().textAutoResize = TextAutoResize::NONE;
  p.size = {100, 60};
  double w = lay(p)->lines[0].width;
  p.text().textAlignHorizontal = TextAlignHorizontal::CENTER;
  CHECK(lay(p)->lines[0].x == doctest::Approx((100 - w) / 2));
  p.text().textAlignHorizontal = TextAlignHorizontal::RIGHT;
  CHECK(lay(p)->lines[0].x == doctest::Approx(100 - w));
  p.text().textAlignVertical = TextAlignVertical::BOTTOM;
  CHECK(lay(p)->lines[0].top == doctest::Approx(60 - 15));
  p.text().textAlignVertical = TextAlignVertical::CENTER;
  CHECK(lay(p)->lines[0].top == doctest::Approx((60 - 15) / 2.0));
  // Justified: every line but a paragraph's last fills the width.
  NodeProps j = textProps("aaa bbb ccc ddd eee fff ggg hhh");
  j.text().textAutoResize = TextAutoResize::HEIGHT;
  j.size = {90, 0};
  j.text().textAlignHorizontal = TextAlignHorizontal::JUSTIFIED;
  auto J = lay(j);
  REQUIRE(J->lines.size() >= 2);
  CHECK(J->lines[0].width == doctest::Approx(90));
  CHECK(J->lines.back().width < 90);
}

TEST_CASE("text: letter spacing widens every gap but not after the line's last character") {
  loadInter();
  NodeProps p = textProps("ABCD");
  double w0 = lay(p)->lines[0].width;
  p.text().letterSpacing = {10, NumberUnits::PERCENT};  // 1.2 px at 12
  CHECK(lay(p)->lines[0].width == doctest::Approx(w0 + 3 * 1.2).epsilon(1e-6));
  CHECK(lay(p)->size.x == std::ceil(w0 + 3 * 1.2));
  p.text().letterSpacing = {2, NumberUnits::PIXELS};
  CHECK(lay(p)->lines[0].width == doctest::Approx(w0 + 3 * 2).epsilon(1e-6));
}

TEST_CASE("text: truncation with an ellipsis (maxLines, and a fixed box's height)") {
  loadInter();
  NodeProps p = textProps("one two three four five six seven eight nine ten");
  p.text().textAutoResize = TextAutoResize::HEIGHT;
  p.size = {70, 0};
  p.text().textTruncation = TextTruncation::ENDING;
  p.text().maxLines = 2;
  auto L = lay(p);
  REQUIRE(L->lines.size() == 2);
  CHECK(L->truncated);
  CHECK(L->size.y == 30);
  Font* inter = FontRegistry::get().find({"Inter", "Regular", ""});
  CHECK(L->glyphs.back().glyph == inter->glyphFor(0x2026));
  CHECK(L->lines[1].width <= 70 + 1e-3);
  NodeProps box = p;
  box.text().maxLines = 0;
  box.text().textAutoResize = TextAutoResize::NONE;
  box.size = {70, 46};  // three lines of 15
  auto B = lay(box);
  CHECK(B->lines.size() == 3);
  CHECK(B->truncated);
}

TEST_CASE("text: case mapping (Unicode default, not locale-sensitive) and decorations") {
  loadInter();
  CHECK(applyCase(u"istanbul ılık", TextCase::UPPER) == u"ISTANBUL ILIK");
  CHECK(applyCase(u"İSTANBUL", TextCase::LOWER) == u"istanbul");
  CHECK(applyCase(u"hello big world", TextCase::TITLE) == u"Hello Big World");
  NodeProps p = textProps("abc");
  p.text().textCase = TextCase::UPPER;
  auto L = lay(p);
  Font* inter = FontRegistry::get().find({"Inter", "Regular", ""});
  CHECK(L->glyphs[0].glyph == inter->glyphFor('A'));
  CHECK(L->text == u"abc");  // the characters stay as typed
  p.text().textDecoration = TextDecoration::UNDERLINE;
  auto U = lay(p);
  REQUIRE(U->decorations.size() == 1);
  CHECK(U->decorations[0].rect.y > U->lines[0].baseline);
  CHECK(U->decorations[0].rect.w == doctest::Approx(U->lines[0].width));
  p.text().textDecoration = TextDecoration::STRIKETHROUGH;
  auto S = lay(p);
  REQUIRE(S->decorations.size() == 1);
  CHECK(S->decorations[0].rect.y < S->lines[0].baseline);
}

TEST_CASE("text: run styles from styleOverrideTable (per UTF-16 unit)") {
  loadInter();
  NodeProps p = textProps("Hello world");
  TextStyle big;
  big.styleID = 1;
  big.mask = R_FONT_SIZE | R_FONT_NAME;
  big.fontSize = 24;
  big.fontName = {"Inter", "Bold", ""};
  p.text().textData.styleOverrideTable = {big};
  p.text().textData.characterStyleIDs = {0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1};
  auto L = lay(p);
  CHECK(L->glyphs[0].size == 12);
  CHECK(L->glyphs.back().size == 24);
  CHECK(L->lines[0].height == 29);  // the line takes its tallest run's height
  CHECK(L->styles[L->styleOf[10]].font == FontRegistry::get().find({"Inter", "Bold", ""}));
}

TEST_CASE("text: a font nobody has is requested, then missing: drawn with Inter, marked") {
  loadInter();
  auto& fonts = FontRegistry::get();
  NodeProps p = textProps("Hey");
  p.text().fontName = {"No Such Font", "Regular", ""};
  auto L = lay(p);
  CHECK(L->pendingFont);
  bool requested = false;
  for (auto& r : fonts.takeRequests()) requested |= r.family == "No Such Font";
  CHECK(requested);
  CHECK(L->glyphs.size() == 3);  // stood in for by Inter meanwhile
  fonts.markMissing("No Such Font", "Regular");
  auto M = lay(p);
  CHECK(M->missingFont);
  CHECK_FALSE(M->pendingFont);
  CHECK(M->glyphs[0].font == fonts.find({"Inter", "Regular", ""}));
  // A missing Bold stays bold (audit 2026-10-08 #12: the bold title drawn regular): Inter at the nearest weight.
  p.text().fontName = {"No Such Font", "Bold", ""};
  lay(p);
  fonts.markMissing("No Such Font", "Bold");
  auto B = lay(p);
  CHECK(B->missingFont);
  CHECK(B->glyphs[0].font == fonts.find({"Inter", "Bold", ""}));
  p.text().fontName = {"No Such Font", "SemiBold Italic", ""};
  lay(p);
  fonts.markMissing("No Such Font", "SemiBold Italic");
  CHECK(lay(p)->glyphs[0].font == fonts.find({"Inter", "Semi Bold Italic", ""}));
}

TEST_CASE("text: caret positions, line lookup, hit-testing, selection rects") {
  loadInter();
  NodeProps p = textProps("ab cd\nef");
  auto L = lay(p);
  REQUIRE(L->caretXs.size() == 9);
  CHECK(L->caretXs[0] == 0);
  CHECK(L->caretXs[1] > 0);
  CHECK(L->caretXs[2] > L->caretXs[1]);
  CHECK(L->lineOf(5) == 0);  // before the "\n"
  CHECK(L->lineOf(6) == 1);
  CHECK(L->caretX(5, 0) == doctest::Approx(L->lines[0].caretEnd));
  CHECK(L->indexAt({L->caretXs[2] + 0.1, 5}) == 2);
  CHECK(L->indexAt({1000, 5}) == 5);
  CHECK(L->indexAt({-10, 20}) == 6);
  auto rects = L->selectionRects(1, 7);
  CHECK(rects.size() == 2);
}

TEST_CASE("text: Unicode helpers (UTF-16, graphemes, words)") {
  std::u16string s = utf8To16("a\xF0\x9F\x98\x80" "b");  // a 😀 b
  CHECK(s.size() == 4);
  CHECK(utf16To8(s) == "a\xF0\x9F\x98\x80" "b");
  CHECK(nextGrapheme(s, 1) == 3);
  CHECK(prevGrapheme(s, 3) == 1);
  std::u16string w = u"hello, big world";
  CHECK(prevWordStart(w, 16) == 11);
  CHECK(prevWordStart(w, 11) == 7);
  CHECK(nextWordEnd(w, 0) == 5);
  CHECK(nextWordEnd(w, 5) == 10);
  size_t a, b;
  wordAt(w, 8, a, b);
  CHECK(a == 7);
  CHECK(b == 10);
  std::vector<char> breaks;
  lineBreaks(u"ab cd", breaks);
  CHECK(breaks[2] == BREAK_ALLOW);  // after the space
  CHECK(breaks[0] == BREAK_NO);
}

TEST_CASE("text: glyph coverage from curves (the Glyph shader's math in C++)") {
  // A unit square contour (clockwise in y-down em space) as line-quadratics.
  const float sq[] = {0.f, 0.f, 0.5f, 0.f, 1.f, 0.f,   1.f, 0.f, 1.f, 0.5f, 1.f, 1.f,
                      1.f, 1.f, 0.5f, 1.f, 0.f, 1.f,   0.f, 1.f, 0.f, 0.5f, 0.f, 0.f};
  float ppe = 100;  // 100 px per em
  CHECK(glyphCoverage(sq, 4, 0.5f, 0.5f, ppe, ppe) == doctest::Approx(1));
  CHECK(glyphCoverage(sq, 4, 1.5f, 0.5f, ppe, ppe) == doctest::Approx(0));
  CHECK(glyphCoverage(sq, 4, -0.2f, 0.5f, ppe, ppe) == doctest::Approx(0));
  // On the left edge: half a pixel in.
  CHECK(glyphCoverage(sq, 4, 0.0f, 0.5f, ppe, ppe) == doctest::Approx(0.5).epsilon(0.05));
  CHECK(glyphCoverage(sq, 4, 0.5f, 1.0f, ppe, ppe) == doctest::Approx(0.5).epsilon(0.05));
  // Rasterizing Inter's "O" at 40 px: the hole is empty, the ring is ink, the area is plausible.
  loadInter();
  Font* f = FontRegistry::get().find({"Inter", "Regular", ""});
  const GlyphOutline& o = f->outline(f->glyphFor('O'));
  float s = 40;
  double area = 0;
  int px = 0;
  for (float y = o.bounds[1] - 0.05f; y < o.bounds[3] + 0.05f; y += 1 / s)
    for (float x = o.bounds[0] - 0.05f; x < o.bounds[2] + 0.05f; x += 1 / s) {
      float c = glyphCoverage(o.curves.data(), o.curveCount(), x, y, s, s);
      CHECK(c >= 0);
      CHECK(c <= 1);
      area += c;
      px++;
    }
  float cx = (o.bounds[0] + o.bounds[2]) / 2, cy = (o.bounds[1] + o.bounds[3]) / 2;
  CHECK(glyphCoverage(o.curves.data(), o.curveCount(), cx, cy, s, s) == doctest::Approx(0));
  CHECK(glyphCoverage(o.curves.data(), o.curveCount(), o.bounds[0] + 0.02f, cy, s, s) == doctest::Approx(1));
  CHECK(area > px * 0.15);
  CHECK(area < px * 0.6);
}

TEST_CASE("text: structure.fig's text node, decoded from Figma's file, lays out as Figma's derived data says") {
  loadInter();
  std::ifstream in(std::string(ENG_TEST_DATA) + "/../../../docs/research/figma/samples/structure.fig.json");
  REQUIRE(in.good());
  std::stringstream text;
  text << in.rdbuf();
  json::Value v;
  REQUIRE(json::parse(text.str(), v));
  const json::Value* changes = v.get("nodeChanges");
  REQUIRE(changes);
  int texts = 0;
  for (const json::Value& raw : changes->array) {
    const json::Value* type = raw.get("type");
    if (!type || type->string != "TEXT") continue;
    texts++;
    NodeChange c;
    REQUIRE(codec::readChange(raw, c));
    CHECK(c.props.type == NodeType::TEXT);
    CHECK(c.props.text().textData.characters == "ABC");
    // Figma's own result, kept in its file's textData (ours keeps it in derivedTextData).
    const json::Value& figma = *raw.get("textData");
    auto L = layoutText(c.props, optionsFor(c.props));
    const auto& glyphs = figma.get("glyphs")->array;
    REQUIRE(L->glyphs.size() == glyphs.size());
    for (size_t i = 0; i < glyphs.size(); i++) {
      const json::Value& pos = *glyphs[i].get("position");
      INFO("glyph " << i);
      CHECK(std::fabs(L->glyphs[i].x - pos.get("x")->number) <= 0.5);  // E3's acceptance: ≤ 0.5 px with Inter
      CHECK(std::fabs(L->glyphs[i].y - pos.get("y")->number) <= 0.5);
    }
    const json::Value& baseline = figma.get("baselines")->array[0];
    CHECK(L->lines[0].height == baseline.get("lineHeight")->number);
    CHECK(std::fabs(L->lines[0].width - baseline.get("width")->number) <= 0.5);
    // Fields the engine doesn't model but the schema has (fontVariant*) ride along as their kiwi bytes; fields
    // outside schema/document.kiwi (Figma's textUserLayoutVersion, dropped) can't be encoded and go.
    CHECK(c.props.extra.count("textUserLayoutVersion") == 0);
    CHECK(c.props.extra.count("fontVariantCommonLigatures") == 1);
  }
  CHECK(texts == 1);
}
