// (Named to run last: it resets the process-wide font registry; the renderer tests count shapes without Inter.)
// Derived data persisted (docs/engine-build.md "Figma parity round 3" §2; Figma's derivedSymbolData 125 and
// derivedTextData 359): a snapshot written with ENCODE_DERIVED loads into the same geometry without laying the
// instances out, draws its text from the stored outlines before the fonts arrive, and goes stale when it should.
#include <cmath>
#include <cstring>
#include <string>

#include "base/DerivedIds.h"
#include "base/Json.h"
#include "doctest.h"
#include "Helpers.h"
#include "TextHelpers.h"
#include "scene/CodecKiwi.h"
#include "text/DerivedText.h"

using Ptr = uintptr_t;
using Handle = uintptr_t;

extern "C" {
Ptr engine_result_ptr();
uint32_t engine_result_len();
Handle engine_create(const char* selector, Ptr optsPtr, uint32_t optsLen);
void engine_destroy(Handle h);
int32_t engine_load(Handle h, Ptr ptr, uint32_t len);
int32_t engine_load_at(Handle h, Ptr ptr, uint32_t len, uint32_t pageSessionID, uint32_t pageLocalID);
int32_t engine_encode_document(Handle h, uint32_t flags);
int32_t engine_set_current_page(Handle h, uint32_t sessionID, uint32_t localID);
int32_t engine_read_nodes(Handle h, Ptr ptr, uint32_t len, uint32_t flags);
int32_t engine_text_layout(Handle h, uint32_t sessionID, uint32_t localID);
int32_t engine_set_props(Handle h, Ptr refsPtr, uint32_t refsLen, Ptr changePtr, uint32_t changeLen, uint32_t flags);
int32_t engine_stats(Handle h);
int32_t engine_take_events(Handle h);
uint32_t engine_derived_data_version();
}

using namespace eng;

namespace {

struct Text {
  std::string s;
  Ptr ptr() const { return reinterpret_cast<Ptr>(s.data()); }
  uint32_t len() const { return static_cast<uint32_t>(s.size()); }
};
std::string result() { return std::string(reinterpret_cast<const char*>(engine_result_ptr()), engine_result_len()); }
json::Value resultJson() {
  json::Value v;
  REQUIRE(json::parse(result(), v));
  return v;
}

// Two pages. Page 1: a hugging auto-layout main "Button" (a square, a label), a column (auto layout) of two of its
// instances — the second with a longer label — and a free one stretched wider than the main. Page 2: an instance and
// a text in a font of its own.
const char* kDoc = R"({"type":"NODE_CHANGES","sessionID":0,"nodeChanges":[
  {"guid":"0:0","phase":"CREATED","type":"DOCUMENT","name":"Document"},
  {"guid":"0:1","phase":"CREATED","type":"CANVAS","name":"Page 1","parentIndex":{"guid":"0:0","position":"!"}},
  {"guid":"0:3","phase":"CREATED","type":"CANVAS","name":"Page 2","parentIndex":{"guid":"0:0","position":"#"}},
  {"guid":"0:2","phase":"CREATED","type":"CANVAS","name":"Internal Only Canvas","internalOnly":true,"visible":false,"parentIndex":{"guid":"0:0","position":"~"}},
  {"guid":"1:1","phase":"CREATED","type":"SYMBOL","name":"Button","parentIndex":{"guid":"0:1","position":"!"},"size":{"x":10,"y":10},
   "stackMode":"HORIZONTAL","stackSpacing":4,"stackHorizontalPadding":8,"stackVerticalPadding":6,"stackPaddingRight":8,"stackPaddingBottom":6,
   "stackCounterSizing":"RESIZE_TO_FIT","stackCounterAlignItems":"CENTER","fillPaints":[{"type":"SOLID","color":{"r":0,"g":0.5,"b":1,"a":1}}]},
  {"guid":"1:2","phase":"CREATED","type":"ROUNDED_RECTANGLE","name":"Icon","parentIndex":{"guid":"1:1","position":"!"},"size":{"x":16,"y":16},
   "fillPaints":[{"type":"SOLID","color":{"r":1,"g":1,"b":1,"a":1}}]},
  {"guid":"1:3","phase":"CREATED","type":"TEXT","name":"Label","parentIndex":{"guid":"1:1","position":"\""},"size":{"x":10,"y":10},
   "textData":{"characters":"Label"},"textAutoResize":"WIDTH_AND_HEIGHT","fontSize":14,"textDecoration":"UNDERLINE",
   "fillPaints":[{"type":"SOLID","color":{"r":1,"g":1,"b":1,"a":1}}]},
  {"guid":"1:20","phase":"CREATED","type":"FRAME","name":"Column","parentIndex":{"guid":"0:1","position":"\""},"size":{"x":10,"y":10},
   "transform":{"m00":1,"m01":0,"m02":0,"m10":0,"m11":1,"m12":100},"stackMode":"VERTICAL","stackSpacing":10,"stackCounterSizing":"RESIZE_TO_FIT"},
  {"guid":"1:21","phase":"CREATED","type":"INSTANCE","name":"Button","parentIndex":{"guid":"1:20","position":"!"},"size":{"x":10,"y":10},
   "symbolData":{"symbolID":{"sessionID":1,"localID":1}}},
  {"guid":"1:22","phase":"CREATED","type":"INSTANCE","name":"Button","parentIndex":{"guid":"1:20","position":"\""},"size":{"x":10,"y":10},
   "symbolData":{"symbolID":{"sessionID":1,"localID":1},"symbolOverrides":[{"guidPath":{"guids":[{"sessionID":1,"localID":3}]},"textData":{"characters":"A longer label"}}]}},
  {"guid":"1:23","phase":"CREATED","type":"INSTANCE","name":"Wide","parentIndex":{"guid":"0:1","position":"#"},"size":{"x":10,"y":10},
   "transform":{"m00":1,"m01":0,"m02":300,"m10":0,"m11":1,"m12":0},"stackPrimarySizing":"FIXED",
   "symbolData":{"symbolID":{"sessionID":1,"localID":1},"symbolOverrides":[{"guidPath":{"guids":[]},"stackPrimarySizing":"FIXED","size":{"x":200,"y":40}}]}},
  {"guid":"1:30","phase":"CREATED","type":"INSTANCE","name":"Button","parentIndex":{"guid":"0:3","position":"!"},"size":{"x":10,"y":10},
   "symbolData":{"symbolID":{"sessionID":1,"localID":1}}},
  {"guid":"1:31","phase":"CREATED","type":"TEXT","name":"Note","parentIndex":{"guid":"0:3","position":"\""},"size":{"x":120,"y":10},
   "transform":{"m00":1,"m01":0,"m02":0,"m10":0,"m11":1,"m12":80},"textData":{"characters":"A note that wraps over lines"},
   "textAutoResize":"HEIGHT","fontName":{"family":"Inter","style":"Bold","postscript":""},"fontSize":16,
   "fillPaints":[{"type":"SOLID","color":{"r":0,"g":0,"b":0,"a":1}}]}
]})";

Handle open(const std::string& payload, Guid page) {
  Text opts{R"({"sessionID":5,"wire":"kiwi"})"};
  Handle h = engine_create(nullptr, opts.ptr(), opts.len());
  REQUIRE(h);
  // engine_load takes kiwi only: a JSON payload (the tests' readable form) is encoded first.
  std::string bytes = payload;
  if (!codec::looksKiwi(bytes)) {
    json::Value v;
    REQUIRE(json::parse(payload, v));
    bytes = codec::writeMessage(0, codec::readMessage(v));
  }
  Text doc{bytes};
  REQUIRE(engine_load_at(h, doc.ptr(), doc.len(), page.sessionID, page.localID) == 0);
  engine_take_events(h);
  return h;
}

// Every node of a page (instance sublayers included) with its geometry, as the panels read it.
std::string geometry(Handle h, const char* page) {
  Text refs{std::string(R"({"refs":[")") + page + R"("],"fields":["transform","size","name"]})"};
  REQUIRE(engine_read_nodes(h, refs.ptr(), refs.len(), 2) == 0);
  return result();
}

std::string snapshot(Handle h) {
  REQUIRE(engine_encode_document(h, 1) == 0);
  return result();
}

double stat(Handle h, const char* key) {
  REQUIRE(engine_stats(h) == 0);
  return resultJson().get(key)->number;
}

// A text's laid-out glyph positions and line boxes (engine_text_layout), without the glyph ids (a stored layout's
// are its outlines').
std::string layoutOf(Handle h, Guid id) {
  REQUIRE(engine_text_layout(h, id.sessionID, id.localID) == 0);
  json::Value v = resultJson();
  std::string out;
  for (auto& g : v.get("glyphs")->array)
    out += std::to_string(g.get("position")->get("x")->number) + "," + std::to_string(g.get("position")->get("y")->number) + "," +
           std::to_string(g.get("fontSize")->number) + "," + std::to_string(g.get("firstCharacter")->number) + ";";
  for (auto& b : v.get("baselines")->array) out += "|" + std::to_string(b.get("position")->get("y")->number) + "," + std::to_string(b.get("width")->number);
  out += "|" + std::to_string(v.get("layoutSize")->get("x")->number) + "x" + std::to_string(v.get("layoutSize")->get("y")->number);
  return out;
}

void reloadFonts() {
  auto& fonts = text::FontRegistry::get();
  int32_t upright = test::addFontFile(std::string(ENG_FONTS_DIR) + "/InterVariable.ttf");
  int32_t italic = test::addFontFile(std::string(ENG_FONTS_DIR) + "/InterVariable-Italic.ttf");
  for (const char* s : {"Thin", "Extra Light", "Light", "Regular", "Medium", "Semi Bold", "Bold", "Extra Bold", "Black"}) {
    fonts.bind("Inter", s, upright);
    std::string it = std::string(s) == "Regular" ? "Italic" : std::string(s) + " Italic";
    fonts.bind("Inter", it, italic);
  }
  fonts.takeRequests();
}

const Guid kPage1{0, 1}, kPage2{0, 3};

}  // namespace

TEST_CASE("derived data: a snapshot with derivedSymbolData / derivedTextData loads into the same geometry, unlaid-out") {
  test::loadInter();
  // The reference: the document derived the usual way (every page shown once, so every page's data is current).
  Handle a = open(kDoc, kPage1);
  REQUIRE(engine_set_current_page(a, kPage2.sessionID, kPage2.localID) == 0);
  REQUIRE(engine_set_current_page(a, kPage1.sessionID, kPage1.localID) == 0);
  std::string page1 = geometry(a, "0:1"), page2 = geometry(a, "0:3");
  std::string stored = snapshot(a);
  codec::KiwiMessage m;
  REQUIRE(codec::readMessage(stored, m));
  CHECK(m.derivedDataVersion == engine_derived_data_version());
  CHECK(engine_derived_data_version() == 3);

  // Loaded from it: every instance takes its stored sublayers (no layout pass), the geometry is the same, node for
  // node, the sublayers included; another page's instance too, on its first show.
  Handle b = open(stored, kPage1);
  CHECK(geometry(b, "0:1") == page1);
  CHECK(stat(b, "derivedUsed") == 3);
  CHECK(stat(b, "derivedStale") == 0);
  REQUIRE(engine_set_current_page(b, kPage2.sessionID, kPage2.localID) == 0);
  CHECK(geometry(b, "0:3") == page2);
  CHECK(stat(b, "derivedUsed") == 4);
  // Its own snapshot carries the same derived data (nothing was lost by not deriving it).
  CHECK(snapshot(b) == stored);

  // Without the stamp (another engine's derived data, or none): derived as usual, the same result.
  std::string unstamped = codec::writeMessage(0, m.changes);
  Handle c = open(unstamped, kPage1);
  CHECK(geometry(c, "0:1") == page1);
  CHECK(stat(c, "derivedUsed") == 0);

  // A page never shown keeps its stored data through a snapshot.
  Handle d = open(stored, kPage1);
  CHECK(snapshot(d) == stored);
  // An edit of the main makes the stored layout of the instances not derived yet stale: page 2 lays out again and
  // follows the main.
  Text refs{R"({"refs":["1:1"]})"}, change{R"({"stackSpacing":20})"};
  REQUIRE(engine_set_props(d, refs.ptr(), refs.len(), change.ptr(), change.len(), 0) == 0);
  REQUIRE(engine_set_props(a, refs.ptr(), refs.len(), change.ptr(), change.len(), 0) == 0);
  REQUIRE(engine_set_current_page(d, kPage2.sessionID, kPage2.localID) == 0);
  CHECK(geometry(d, "0:3") == geometry(a, "0:3"));
  CHECK(stat(d, "derivedUsed") == 3);  // page 1's only
  for (Handle h : {a, b, c, d}) engine_destroy(h);
}

TEST_CASE("derived data: text draws from its stored outlines before its fonts arrive, then from the fonts, the same") {
  test::loadInter();
  Handle a = open(kDoc, kPage1);
  REQUIRE(engine_set_current_page(a, kPage2.sessionID, kPage2.localID) == 0);
  REQUIRE(engine_set_current_page(a, kPage1.sessionID, kPage1.localID) == 0);
  const Guid label = derived::intern({1, 22}, {{1, 3}});
  std::string realLabel = layoutOf(a, label), realMain = layoutOf(a, {1, 3}), realNote = layoutOf(a, {1, 31});
  std::string page1 = geometry(a, "0:1");
  std::string stored = snapshot(a);
  engine_destroy(a);

  // No fonts at all (a fresh process, before the font files have crossed): the stored layouts draw.
  text::FontRegistry::get().reset();
  Handle b = open(stored, kPage1);
  CHECK(geometry(b, "0:1") == page1);
  CHECK(layoutOf(b, label) == realLabel);
  CHECK(layoutOf(b, {1, 3}) == realMain);
  REQUIRE(engine_text_layout(b, label.sessionID, label.localID) == 0);
  CHECK(resultJson().get("pendingFont")->boolean);
  // The fonts arrive: the same layout, now shaped (no visible relayout; the faces' digests match what was stored).
  reloadFonts();
  CHECK(layoutOf(b, label) == realLabel);
  CHECK(geometry(b, "0:1") == page1);
  REQUIRE(engine_text_layout(b, label.sessionID, label.localID) == 0);
  CHECK(!resultJson().get("pendingFont")->boolean);
  REQUIRE(engine_set_current_page(b, kPage2.sessionID, kPage2.localID) == 0);
  CHECK(layoutOf(b, {1, 31}) == realNote);
  engine_destroy(b);
}

TEST_CASE("derived data: stored outlines are Figma's commands (em, y up) and intern once") {
  test::loadInter();
  text::Font* inter = text::FontRegistry::get().find(FontName{"Inter", "Regular", ""});
  REQUIRE(inter);
  const text::GlyphOutline& a = inter->outline(inter->glyphFor('A'));
  Bytes cmd = text::outlineCommands(a);
  REQUIRE(cmd);
  CHECK((*cmd)[0] == 1);  // moveTo first
  // y up: the A's apex is above the baseline.
  float maxY = -1;
  for (size_t i = 0; i + 4 < cmd->size();) {
    uint8_t op = (*cmd)[i++];
    int n = op == 0 ? 0 : op == 3 ? 4 : op == 4 ? 6 : 2;
    for (int k = 0; k < n; k++, i += 4) {
      float f;
      std::memcpy(&f, cmd->data() + i, 4);
      if (k % 2) maxY = std::max(maxY, f);
    }
  }
  CHECK(maxY > 0.6f);
  uint32_t index = text::internStoredOutline(cmd->data(), cmd->size());
  CHECK(index != 0);
  CHECK(text::internStoredOutline(cmd->data(), cmd->size()) == index);
  const text::GlyphOutline& back = text::storedGlyphFont()->outline(index);
  CHECK(back.curves == a.curves);  // exactly the shape the font gave
}
