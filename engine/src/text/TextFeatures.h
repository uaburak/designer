// The text fields the engine keeps as data (NodeProps::extra on the node, TextStyle::extra on a run — the raw kiwi
// fields of schema/document.kiwi's NodeChange) read into types for layout and drawing: variable font axes,
// OpenType features (Figma's fontVariant* switches and toggledOn/OffOTFeatures), hyperlinks, the underline's
// style / thickness / offset / colour, vertical trim, lists' spacing and hanging, wrap style.
//
// A run's fields replace the node's one by one (Figma's styleOverrideTable is sparse): `merge` applies a run's.
#pragma once

#include <cstdint>
#include <map>
#include <string>
#include <string_view>
#include <vector>

#include "scene/Node.h"

namespace eng::text {

// schema Hyperlink: a URL, or a node of this file.
struct HyperlinkData {
  std::string url;
  Guid guid = kNoGuid;
  bool openInNewTab = false;
  bool empty() const { return url.empty() && guid == kNoGuid; }
  bool operator==(const HyperlinkData& o) const { return url == o.url && guid == o.guid && openInNewTab == o.openInNewTab; }
};

enum class DecorationStyle : uint8_t { SOLID = 0, DOTTED = 1, WAVY = 2 };
enum class LeadingTrim : uint8_t { NONE = 0, CAP_HEIGHT = 1 };
enum class WrapStyle : uint8_t { AUTO = 0, BALANCE = 1, PRETTY = 2 };

// Tri-state switches: -1 = absent (the font's default), 0 off, 1 on.
struct TextFeatures {
  // Variable font axes, OpenType tag → value (schema FontVariation).
  std::vector<std::pair<uint32_t, float>> variations;
  bool detachOpticalSize = false;  // detachOpticalSizeFromFontSize
  // OpenType: explicit toggles (schema OpenTypeFeature names → tags) and the fontVariant* switches.
  std::vector<uint32_t> featuresOn, featuresOff;
  int8_t commonLigatures = -1, contextualLigatures = -1, discretionaryLigatures = -1, historicalLigatures = -1;
  int8_t ordinal = -1, slashedZero = -1;
  uint8_t numericFigure = 0;    // NORMAL, LINING, OLDSTYLE
  uint8_t numericSpacing = 0;   // NORMAL, PROPORTIONAL, TABULAR
  uint8_t numericFraction = 0;  // NORMAL, DIAGONAL, STACKED
  uint8_t caps = 0;             // NORMAL, SMALL, ALL_SMALL, PETITE, ALL_PETITE, UNICASE, TITLING
  uint8_t position = 0;         // NORMAL, SUB, SUPER
  // Links.
  HyperlinkData hyperlink;
  // Decorations (underline / strikethrough details).
  DecorationStyle decorationStyle = DecorationStyle::SOLID;
  bool skipInk = false;
  Number underlineOffset{0, NumberUnits::RAW};  // RAW 0 = Auto; PIXELS or PERCENT (of the font size)
  bool hasUnderlineOffset = false;
  Number decorationThickness{0, NumberUnits::RAW};
  bool hasDecorationThickness = false;
  std::vector<Paint> decorationFills;  // textDecorationFillPaints; empty = the text's own fill
  bool hasDecorationFills = false;
  // Node-level paragraph fields (a run's are ignored).
  LeadingTrim leadingTrim = LeadingTrim::NONE;
  double listSpacing = 0;
  bool hangingList = false;
  bool hangingPunctuation = false;
  WrapStyle wrapStyle = WrapStyle::AUTO;

  // The OpenType feature list HarfBuzz shapes with (tag, on), `textCase` adding small caps.
  std::vector<std::pair<uint32_t, bool>> shapingFeatures(TextCase textCase) const;
  bool operator==(const TextFeatures& o) const;
};

// The node's own (NodeProps::extra).
TextFeatures nodeFeatures(const std::map<std::string, std::string>& extra);
// A run's fields on top of `base` (TextStyle::extra: a raw NodeChange field sequence).
TextFeatures runFeatures(const TextFeatures& base, std::string_view runExtra);
// Whether a run's raw fields hold any of the fields above.
bool runHasFeatures(std::string_view runExtra);

// The OpenType tag of a schema OpenTypeFeature value name ("SS01" → 'ss01'); 0 when unknown.
uint32_t featureTag(std::string_view name);
std::string featureName(uint32_t tag);
std::string tagString(uint32_t tag);
uint32_t tagOf(std::string_view s);

// ---- TextData.lines (schema TextLineData, kept as raw bytes per paragraph) ----

enum class LineType : uint8_t { PLAIN = 0, ORDERED_LIST = 1, UNORDERED_LIST = 2 };
struct LineInfo {
  LineType type = LineType::PLAIN;
  int32_t indentationLevel = 0;
  int32_t listStartOffset = 0;
  bool isFirstLineOfList = false;
};
LineInfo readLine(std::string_view bytes);
// `bytes` with these fields written (the line's other fields kept).
void writeLine(std::string& bytes, const LineInfo& info);

// List markers: Figma's counters rotate 1. → a. → i. by indentation level; bullets are "•" at every level.
std::u16string listMarker(LineType type, int32_t level, int32_t index);

}  // namespace eng::text
