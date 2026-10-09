// Round 11 — Type settings › Details (docs/editor.md "Round 11 — Design panel and popovers"): the features that act on
// the selected text (Font::featuresIn, engine_font_features_in). Live (popovers/type-settings-details.txt, Inter on
// "Hello Figma text") dims Case-sensitive forms, Slashed zero, Open digits, Alternate one, Open four, Open six, Open
// nine and Fraction denominators; Capital spacing, Stylistic alternates, Disambiguation, Lower-case L with tail,
// Single-storey a and Kerning pairs act.
#include <algorithm>
#include <string>

#include "doctest.h"
#include "Helpers.h"
#include "TextHelpers.h"
#include "text/Fonts.h"
#include "text/TextFeatures.h"

using namespace eng;
using namespace eng::test;

namespace {

struct Inter {
  text::Font* font = nullptr;
  Inter() {
    auto& fonts = text::FontRegistry::get();
    int32_t upright = addFontFile(std::string(ENG_FONTS_DIR) + "/InterVariable.ttf");
    fonts.bind("Inter", "Regular", upright);
    fonts.takeRequests();
    font = fonts.find({"Inter", "Regular", ""});
  }
  ~Inter() { text::FontRegistry::get().reset(); }
  bool acts(const std::string& text, const char* tag) const {
    auto tags = font->featuresIn(text);
    return std::find(tags.begin(), tags.end(), text::tagOf(tag)) != tags.end();
  }
};

}  // namespace

TEST_CASE("r11: the features that act on the selected text — live's applicable rows on \"Hello Figma text\"") {
  Inter inter;
  REQUIRE(inter.font);
  const std::string live = "Hello Figma text";
  for (const char* tag : {"cpsp", "salt", "ss02", "cv05", "cv11", "kern"}) {
    CAPTURE(tag);
    CHECK(inter.acts(live, tag));
  }
  for (const char* tag : {"case", "zero", "ss01", "cv01", "cv02", "cv03", "cv04", "dnom"}) {
    CAPTURE(tag);
    CHECK_FALSE(inter.acts(live, tag));
  }
  // A digit zero makes Slashed zero and Open digits act; nothing acts on an empty text.
  CHECK(inter.acts("0", "zero"));
  CHECK(inter.acts("Open 4", "cv02"));
  CHECK(inter.font->featuresIn("").empty());
}
