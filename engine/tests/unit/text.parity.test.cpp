// Text measurement parity with Figma (docs/engine-build.md "Text round"): our layout of a .fig's texts against the
// glyph positions Figma stored for them (derivedTextData), in the very font files Figma laid them out with.
//
// The data is a file's own content, so it is never in the repository: DESIGNER_TEXT_PARITY names a JSON file
//   { fonts: [{family, style, path}], texts: [{node: <NodeChange JSON>, glyphs: [[x, y, firstCharacter, advance, size]],
//     baselines: [[x, y, width, lineY, lineHeight, first, end]], layoutSize: {x, y}}] }
// that a local script writes from a .fig (fonts whose SHA-1 equals the file's FontMetaData.fontDigest only). Without
// it the case does nothing. With it, it prints the statistics and checks the glyphs land within 0.01 px.
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

#include "base/Json.h"
#include "doctest.h"
#include "scene/CodecJson.h"
#include "TextHelpers.h"
#include "text/TextLayout.h"

using namespace eng;
using namespace eng::test;
using namespace eng::text;

TEST_CASE("text: parity with Figma's stored glyph positions (DESIGNER_TEXT_PARITY, local files only)") {
  const char* path = std::getenv("DESIGNER_TEXT_PARITY");
  if (!path || !*path) return;
  std::ifstream in(path);
  REQUIRE(in.good());
  std::stringstream ss;
  ss << in.rdbuf();
  json::Value root;
  REQUIRE(json::parse(ss.str(), root));
  loadInter();
  auto& fonts = FontRegistry::get();
  for (const json::Value& f : root.get("fonts")->array) {
    int32_t face = addFontFile(f.get("path")->string);
    REQUIRE(face >= 0);
    fonts.bind(f.get("family")->string, f.get("style")->string, face);
  }
  fonts.takeRequests();

  size_t lineCountOff = 0, skipped = 0, texts = 0, glyphs = 0, over001 = 0, over01 = 0, over05 = 0, widthOver01 = 0, baselineOver001 = 0;
  double sumAbs = 0, maxAbs = 0, sumSigned = 0, sumWidth = 0, maxWidth = 0;
  const char* verbose = std::getenv("DESIGNER_TEXT_PARITY_VERBOSE");
  int printed = 0;
  for (const json::Value& t : root.get("texts")->array) {
    NodeChange c;
    if (!codec::readChange(*t.get("node"), c)) continue;
    NodeProps& p = c.props;
    auto L = layoutText(p, optionsFor(p));
    if (L->missingFont || L->pendingFont) continue;
    // Figma's stored layout of a wrapping text made at another width than the node has now (an override, a stale
    // derivation): nothing to compare.
    if (p.text().textAutoResize != TextAutoResize::WIDTH_AND_HEIGHT && std::fabs(t.get("layoutSize")->get("x")->number - p.size.x) > 1e-3) {
      skipped++;
      continue;
    }
    texts++;
    // Our glyphs by their first character (ligatures and spaces may differ in count; match by cluster).
    double worst = 0;
    for (const json::Value& g : t.get("glyphs")->array) {
      if (!g.array[2].isNumber()) continue;  // Figma's "…" has no first character
      double fx = g.array[0].number, fy = g.array[1].number;
      uint32_t first = static_cast<uint32_t>(g.array[2].number);
      const LaidGlyph* ours = nullptr;
      for (const LaidGlyph& o : L->glyphs)
        if (o.cluster == first && o.glyph) {
          ours = &o;
          break;
        }
      if (!ours) continue;
      if (L->truncated && first >= L->truncationStart) continue;  // Figma keeps the hidden lines' glyphs; we drop them
      double dx = ours->x - fx, dy = ours->y - fy;
      double d = std::max(std::fabs(dx), std::fabs(dy));
      if (const char* detail = std::getenv("DESIGNER_TEXT_PARITY_DETAIL"))
        if (p.text().textData.characters.rfind(detail, 0) == 0)
          std::printf("  [%u] ours %.5f, %.5f adv %.5f  figma %.5f, %.5f adv %.5f  dx %.5f\n", first, ours->x, ours->y, ours->advance, fx, fy,
                      g.array[3].number * g.array[4].number, dx);
      glyphs++;
      sumAbs += std::fabs(dx);
      sumSigned += dx;
      maxAbs = std::max(maxAbs, d);
      worst = std::max(worst, d);
      if (d > 0.01) over001++;
      if (d > 0.1) over01++;
      if (d > 0.5) over05++;
    }
    // Line counts (a truncated text: Figma keeps its hidden lines; compare the visible ones only).
    size_t figmaLines = t.get("baselines")->array.size();
    if (!L->truncated && figmaLines != L->lines.size()) {
      lineCountOff++;
      if (verbose && printed < 40) {
        printed++;
        std::printf("parity: lines \"%s\" ours %zu figma %zu (width %.3f)\n", p.text().textData.characters.substr(0, 40).c_str(), L->lines.size(), figmaLines, p.size.x);
      }
    }
    for (size_t i = 0; i < t.get("baselines")->array.size() && i < L->lines.size(); i++) {
      const json::Value& b = t.get("baselines")->array[i];
      if (std::fabs(L->lines[i].baseline - b.array[1].number) > 0.01) baselineOver001++;
    }
    double fw = t.get("layoutSize")->get("x")->number;
    // DESIGNER_TEXT_PARITY_DUMP=<path>: one line per auto-width text — our widest line, Figma's widest stored
    // baseline (x + width) and Figma's box width (for studying the rounding rule).
    if (const char* dump = std::getenv("DESIGNER_TEXT_PARITY_DUMP"); dump && p.text().textAutoResize == TextAutoResize::WIDTH_AND_HEIGHT) {
      static FILE* out = std::fopen(dump, "w");
      double ours = 0, theirs = 0;
      for (const LaidLine& l : L->lines) ours = std::max(ours, l.width);
      for (const json::Value& b : t.get("baselines")->array) theirs = std::max(theirs, b.array[2].number);
      if (out) std::fprintf(out, "%.6f\t%.8f\t%.4f\t%s\n", ours, theirs, fw, p.text().textData.characters.substr(0, 30).c_str());
    }
    double dw = std::fabs(L->size.x - fw);
    if (p.text().textAutoResize == TextAutoResize::WIDTH_AND_HEIGHT) {
      sumWidth += dw;
      maxWidth = std::max(maxWidth, dw);
      if (dw > 0.1) {
        widthOver01++;
        if (std::getenv("DESIGNER_TEXT_PARITY_WIDTHS"))
          std::printf("parity: width \"%s\" ours %.4f figma %.4f (line %.4f)\n", p.text().textData.characters.substr(0, 40).c_str(), L->size.x, fw,
                      L->lines.empty() ? 0.0 : L->lines[0].width);
      }
    }
    if (verbose && worst > std::atof(verbose) && printed < 40) {
      printed++;
      std::printf("parity: \"%s\" %s/%s %.2f: worst %.4f, width ours %.4f figma %.4f\n", p.text().textData.characters.substr(0, 40).c_str(),
                  p.text().fontName.family.c_str(), p.text().fontName.style.c_str(), p.text().fontSize, worst, L->size.x, fw);
    }
  }
  std::printf(
      "parity: %zu texts (%zu skipped), %zu glyphs: mean |dx| %.5f, mean dx %.5f, max %.4f; >0.01 px %zu, >0.1 px %zu, >0.5 px %zu; "
      "auto-width |dw| mean %.5f max %.4f (>0.1 px: %zu); baselines off >0.01 px: %zu; line counts off: %zu\n",
      texts, skipped, glyphs, glyphs ? sumAbs / glyphs : 0, glyphs ? sumSigned / glyphs : 0, maxAbs, over001, over01, over05,
      texts ? sumWidth / texts : 0, maxWidth, widthOver01, baselineOver001, lineCountOff);
  CHECK(glyphs > 0);
  CHECK(over01 == 0);
  CHECK(lineCountOff == 0);
}
