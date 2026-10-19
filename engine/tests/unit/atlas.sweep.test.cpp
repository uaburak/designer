// The Atlas sweep of 2026-10-18 (the "As built … not done" lists of chapters 06, 09, 10, 11, 12, 13 and 15): a
// right-to-left list's indent from the right, ← / → moving visually on a line with right-to-left text, emoji falling
// back to Noto Emoji. (The Missing fonts dialog's scopes are in text.fonts.test.cpp.)
#include <algorithm>
#include <string>

#include "base/Json.h"
#include "doctest.h"
#include "editor/Editor.h"
#include "Helpers.h"
#include "TextHelpers.h"
#include "text/TextFeatures.h"
#include "text/TextLayout.h"

using namespace eng;
using namespace eng::test;
using namespace eng::text;

namespace {

// "אבג" (Hebrew, right to left).
const char* kHebrew = "\xD7\x90\xD7\x91\xD7\x92";

std::string listLine(LineType type, int32_t level, uint8_t direction = 0) {
  std::string bytes;
  writeLine(bytes, {type, level, 0, true, 0});
  if (direction) writeLineDirection(bytes, direction);
  return bytes;
}

// The x of the first glyph of the cluster starting at UTF-16 `cluster`; the list marker's when `marker`.
double glyphX(const TextLayout& L, uint32_t cluster, bool marker = false) {
  for (const LaidGlyph& g : L.glyphs)
    if (g.cluster == cluster && g.marker == marker) return g.x;
  return -1;
}

// Inter for these texts, and the module-wide font registry reset afterwards (as devmode.test.cpp): loadInter() loads
// once per run, and this file runs before the files that reset the registry.
struct Fonts {
  Fonts() {
    auto& fonts = FontRegistry::get();
    int32_t face = addFontFile(interPath());
    for (const char* style : {"Regular", "Medium", "Bold"}) fonts.bind("Inter", style, face);
    fonts.takeRequests();
  }
  ~Fonts() { FontRegistry::get().reset(); }
};

}  // namespace

TEST_CASE("atlas sweep: a right-to-left list item is indented from the right, its marker in that indent") {
  Fonts fonts;
  NodeProps p = textProps(kHebrew);
  p.text().textAutoResize = TextAutoResize::HEIGHT;
  p.size = {200, 20};
  p.text().textAlignHorizontal = TextAlignHorizontal::RIGHT;
  p.text().textData.lines = {listLine(LineType::UNORDERED_LIST, 1)};
  auto L = layoutText(p, optionsFor(p));
  REQUIRE(L->lines.size() == 1);
  const LaidLine& line = L->lines[0];
  CHECK(line.rtl);
  const double unit = std::round(12 * 1.5);
  // Right-aligned: the content ends one level short of the box's right edge; the marker sits right of it.
  CHECK(line.x + line.width == doctest::Approx(200 - unit));
  CHECK(glyphX(*L, 0, true) > line.x + line.width);
  CHECK(glyphX(*L, 0, true) < 200);
  // Left-aligned (alignment stays absolute): the content starts at the box's left edge, not one level in.
  p.text().textAlignHorizontal = TextAlignHorizontal::LEFT;
  auto Left = layoutText(p, optionsFor(p));
  CHECK(Left->lines[0].x == doctest::Approx(0));

  // A left-to-right list keeps its indent on the left.
  NodeProps l = textProps("abc");
  l.text().textAutoResize = TextAutoResize::HEIGHT;
  l.size = {200, 20};
  l.text().textData.lines = {listLine(LineType::UNORDERED_LIST, 1)};
  auto LL = layoutText(l, optionsFor(l));
  CHECK(LL->lines[0].x == doctest::Approx(unit));
  CHECK(glyphX(*LL, 0, true) < unit);
}

TEST_CASE("atlas sweep: ← / → move visually on a line with right-to-left text") {
  Fonts fonts;
  auto nodes = baseChanges();
  const Guid T{1, 2};
  // "ab אבג cd": logical 0 1 2 | 3 4 5 | 6 7 8; visually a b ␠ ג ב א ␠ c d.
  NodeChange t = make(T, NodeType::TEXT, kPage, "!", {10, 10, 0, 0}, "t");
  t.props.text().textData.characters = std::string("ab ") + kHebrew + " cd";
  t.props.text().textAutoResize = TextAutoResize::WIDTH_AND_HEIGHT;
  t.props.size = layoutText(t.props, {})->size;
  nodes.push_back(t);
  const Guid H{1, 3};
  NodeChange h = make(H, NodeType::TEXT, kPage, "\"", {10, 100, 0, 0}, "h");
  h.props.text().textData.characters = kHebrew;
  h.props.text().textAutoResize = TextAutoResize::WIDTH_AND_HEIGHT;
  h.props.size = layoutText(h.props, {})->size;
  nodes.push_back(h);
  Editor e;
  e.setSessionID(1);
  e.setViewport(800, 600, 1, 800, 600);
  e.loadDocument(nodes, kNoGuid);
  REQUIRE(e.startTextEdit(T, false) == OK);
  auto key = [&](KeyCode k, uint32_t mods = 0) { e.key(KeyEvent::DOWN, k, 0, mods, false); };
  key(KeyCode::ArrowLeft, MOD_PRIMARY);
  REQUIRE(e.textSelStart() == 0);
  // → through "ab ", then into the Hebrew word at its visual left (after ג, index 6), leftwards through it.
  std::vector<uint32_t> seen;
  for (int i = 0; i < 9; i++) {
    key(KeyCode::ArrowRight);
    seen.push_back(e.textSelStart());
  }
  const text::TextLayout* L = e.textLayout(T);
  REQUIRE(L);
  // Every step goes right on the screen, and the caret ends at the line's end.
  double x = L->caretX(0, 0);
  for (uint32_t i : seen) {
    double xi = L->caretX(i, 0);
    CHECK(xi >= x - 0.01);
    x = xi;
  }
  CHECK(seen.back() == 9);
  // Inside the Hebrew word → goes back through the text (its letters run right to left).
  CHECK(std::find(seen.begin(), seen.end(), 4u) != seen.end());
  // ← comes back the same way.
  for (int i = 0; i < 9; i++) key(KeyCode::ArrowLeft);
  CHECK(e.textSelStart() == 0);

  // A right-to-left paragraph: ← goes on through the text (its start is on the right), ⌘← to the line's end.
  e.endTextEdit();
  REQUIRE(e.startTextEdit(H, false) == OK);
  key(KeyCode::ArrowRight, MOD_PRIMARY);
  CHECK(e.textSelStart() == 0);
  key(KeyCode::ArrowLeft);
  CHECK(e.textSelStart() == 1);
  key(KeyCode::ArrowLeft, MOD_PRIMARY);
  CHECK(e.textSelStart() == 3);
}

TEST_CASE("atlas sweep: emoji fall back to Noto Emoji first, and nothing else asks for it") {
  CHECK(std::string(scriptFallback(0x1F600)) == "Noto Emoji");  // 😀
  CHECK(std::string(scriptFallback(0x1F44D)) == "Noto Emoji");  // 👍
  CHECK(scriptFallback(0x2192) == nullptr);
  Fonts fonts;
  auto& registry = FontRegistry::get();
  registry.setFallbacks({"Sweep Noto Sans", "Noto Emoji"});
  // 😀: Noto Emoji at once (requested: nothing until it arrives).
  CHECK(registry.fallbackFor(0x1F600) == nullptr);
  auto asked = registry.takeRequests();
  REQUIRE(asked.size() == 1);
  CHECK(asked[0].family == "Noto Emoji");
  // A Thai letter never downloads it on the way: the general family, then nothing.
  CHECK(registry.fallbackFor(0x0E01) == nullptr);
  asked = registry.takeRequests();
  REQUIRE(asked.size() == 1);
  CHECK(asked[0].family == "Sweep Noto Sans");
  registry.markMissing("Sweep Noto Sans", "Regular");
  CHECK(registry.fallbackFor(0x0E01) == nullptr);
  CHECK(registry.takeRequests().empty());
}
