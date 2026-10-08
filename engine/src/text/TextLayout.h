// Text layout (docs/engine.md §7.2, §7.4): a TEXT node's characters and styles
// → shaped glyphs on lines, in the node's space. HarfBuzz shapes runs split by
// style, script and font coverage (fallback fonts); libunibreak gives the line
// break opportunities (greedy fill, words broken at grapheme boundaries when
// they don't fit); Figma's line heights (Auto = the font's own, rounded),
// CSS half-leading, paragraph spacing, alignment, vertical alignment in fixed
// boxes, ENDING truncation with "…", underline and strikethrough.
#pragma once

#include <cstdint>
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

#include "math/Math.h"
#include "scene/Node.h"
#include "text/Fonts.h"
#include "text/TextFeatures.h"

namespace eng::text {

struct StoredText;

// One run style, resolved: the node's own style (index 0) with an override on top.
struct ResolvedStyle {
  uint32_t styleID = 0;
  FontName fontName;
  Font* font = nullptr;  // what it is drawn with (Inter when its own font is missing)
  bool missing = false;  // its own font is missing
  bool pending = false;  // its own font is still loading
  double fontSize = 12;
  Number lineHeight{100, NumberUnits::PERCENT};
  Number letterSpacing{0, NumberUnits::PERCENT};
  TextCase textCase = TextCase::ORIGINAL;
  TextDecoration textDecoration = TextDecoration::NONE;
  const std::vector<Paint>* fills = nullptr;  // the node's fills unless the override has its own
  // Fields kept as data on the node or the run (variable axes, OpenType features, link, decoration details).
  TextFeatures features;
};

struct LaidGlyph {
  Font* font = nullptr;
  uint32_t glyph = 0;
  float x = 0, y = 0;     // the glyph's origin on the baseline, node space
  float size = 12;        // font size
  float advance = 0;      // px, letter spacing included
  uint32_t cluster = 0;   // the first UTF-16 unit of its cluster
  uint16_t style = 0;     // index into TextLayout::styles
  bool marker = false;    // a list's bullet or number (not a character of the text)
};

struct LaidLine {
  double top = 0, height = 0;  // node space
  double baseline = 0;         // node space
  double ascent = 0, descent = 0;
  double x = 0, width = 0;     // where its content starts and how wide it is (trailing spaces left out)
  uint32_t start = 0, end = 0; // UTF-16 [start, end): its characters, the "\n" that ends it included
  uint32_t firstGlyph = 0, glyphCount = 0;
  double caretEnd = 0;         // the caret's x after its last character (trailing spaces included)
  bool paragraphEnd = false;   // ends a paragraph (or the text)
  bool hardEnd = false;        // ends with "\n" (its last unit), so a caret at `end` belongs to the next line
};

struct Decoration {
  Rect rect;  // node space (before `angle`, which turns it about its top-left corner)
  uint16_t style = 0;
  double angle = 0;    // radians: a wavy underline's segments
  bool round = false;  // a dotted underline's dots
};

// Where a decoration's rect sits (node space): its corner, turned by its angle.
inline Mat2x3 decorationTransform(const Decoration& d) { return Mat2x3::translate(d.rect.x, d.rect.y) * Mat2x3::rotate(d.angle); }

// A hyperlink's box on one line (derivedTextData.hyperlinkBoxes): what a click in presentation follows.
struct LinkBox {
  Rect rect;  // node space
  HyperlinkData link;
  uint32_t start = 0, end = 0;  // UTF-16
  uint32_t id = 0;              // 1-based, one per link run (hyperlinkID)
};

struct TextLayout {
  std::u16string text;  // the characters, UTF-16 (before textCase)
  std::vector<ResolvedStyle> styles;
  std::vector<uint16_t> styleOf;  // per UTF-16 unit: index into `styles`
  std::vector<LaidGlyph> glyphs;
  std::vector<LaidLine> lines;  // at least one (an empty text has one empty line)
  std::vector<Decoration> decorations;
  std::vector<LinkBox> links;
  Vec2 size;            // the content's size (Auto width: the widest line; height: the lines and paragraph spacing)
  double boxWidth = 0;  // the width alignment used
  double offsetY = 0;   // textAlignVertical's shift in a fixed box (already in the line and glyph positions)
  bool truncated = false;
  uint32_t truncationStart = 0;  // UTF-16 index where "…" replaces the rest
  bool missingFont = false;      // some run's font is missing (drawn with Inter)
  bool pendingFont = false;      // some run's font is still loading
  // The ink bounds of the glyphs (node space), for culling.
  Rect inkBounds;
  // Per UTF-16 index (size + 1): the caret's x before that unit on its line.
  std::vector<double> caretXs;
  // Made from stored derived data (derivedTextData) instead of shaping: what it was made from (text/DerivedText).
  std::shared_ptr<const StoredText> stored;

  // Caret geometry: the x of the caret before UTF-16 unit `index` on `line`.
  double caretX(uint32_t index, size_t line) const;
  // The line holding `index` (a caret at a soft wrap belongs to the next line unless `upstream`).
  size_t lineOf(uint32_t index, bool upstream = false) const;
  // The UTF-16 index nearest to `p` (node space).
  uint32_t indexAt(Vec2 p) const;
  // Rects (node space) covering [from, to).
  std::vector<Rect> selectionRects(uint32_t from, uint32_t to) const;
};

struct LayoutOptions {
  // The width to wrap at; < 0: no wrapping (Auto width).
  double width = -1;
  // The box height (fixed boxes: vertical alignment and truncation by height); < 0: none.
  double height = -1;
};

// The run styles of a TEXT node: 0 = the node's own, one per styleOverrideTable entry (`byId`: styleID → index).
// Fonts are looked up (and requested) as layoutText does.
void resolveStyles(const NodeProps& p, std::vector<ResolvedStyle>& styles, std::unordered_map<uint32_t, uint16_t>& byId);

// The paints a decoration draws with: the underline's own (textDecorationFillPaints) or its run's fills.
const std::vector<Paint>* decorationFills(const TextLayout& L, const Decoration& d);

// Lays out a TEXT node's text. Fonts that aren't loaded yet are requested
// (FontRegistry) and stood in for by Inter until they arrive.
std::unique_ptr<TextLayout> layoutText(const NodeProps& p, const LayoutOptions& options);

// The width/height a TEXT node's layout uses for its own textAutoResize and size.
LayoutOptions optionsFor(const NodeProps& p, double widthOverride = -1);

// Figma's Auto line height for a font at a size: the font's line height, rounded to whole pixels.
double autoLineHeight(const Font* font, double fontSize);
// A style's line height in px.
double lineHeightPx(const ResolvedStyle& s);

}  // namespace eng::text
