// Fonts (docs/engine.md §7.1, §7.3): the faces TypeScript hands the engine
// (bytes of TTF/OTF/TTC files, never read from disk here), the instances the
// documents ask for by FontName {family, style}, their metrics and their glyph
// outlines (HarfBuzz's draw API; no FreeType, no hinting).
//
// The registry is module-wide: every engine (tab) in the process shares the
// loaded faces. A FontName nobody answered yet is *requested* (REQUEST_FONT,
// once per name); TS answers with engine_font_add_take + engine_font_bind, or
// engine_font_missing. Text with a missing font draws with Inter at its own
// size and keeps its characters (Figma).
#pragma once

#include <array>
#include <cstdint>
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

#include "scene/Node.h"

struct hb_blob_t;
struct hb_face_t;
struct hb_font_t;

namespace eng::text {

// HarfBuzz scale: font units are mapped to this many units per em.
inline constexpr int kHbScale = 1 << 16;

// A glyph's outline as quadratic Béziers (lines are quadratics with the control
// point in the middle; cubics are approximated), in em units, y down.
struct GlyphOutline {
  std::vector<float> curves;  // 6 floats per curve: x0 y0 x1 y1 x2 y2
  float bounds[4] = {0, 0, 0, 0};  // x0, y0, x1, y1 (em, y down)
  bool empty() const { return curves.empty(); }
  size_t curveCount() const { return curves.size() / 6; }
};

class Face;

// A face at one instance (a named instance of a variable font, or the static
// face as it is): what text is shaped and drawn with.
class Font {
 public:
  Font(std::shared_ptr<Face> face, int namedInstance, std::vector<std::pair<uint32_t, float>> variations);
  // A font with no face: only the outlines given to it (setOutline). Stored glyph outlines (derivedTextData) are
  // drawn through one of these (text/DerivedText).
  Font();
  ~Font();
  Font(const Font&) = delete;
  Font& operator=(const Font&) = delete;

  uint32_t id() const { return id_; }  // unique in the process (glyph caches key on it)
  hb_font_t* hb() const { return font_; }
  // Metrics in em (distances below the baseline are positive).
  double ascent = 0.9, descent = 0.25, lineGap = 0;
  double underlineOffset = 0.1, underlineThickness = 0.05;  // the underline's top, below the baseline
  double strikeoutOffset = 0.3, strikeoutThickness = 0.05;  // the strikeout's top, above the baseline
  double capHeight = 0.7;
  // ascent + descent + lineGap: Figma's fontLineHeight (Auto line height ÷ font size).
  double lineHeightEm() const { return ascent + descent + lineGap; }
  uint32_t glyphFor(uint32_t codePoint) const;  // 0 when the font has none
  bool covers(uint32_t codePoint) const { return glyphFor(codePoint) != 0; }
  const GlyphOutline& outline(uint32_t glyph);
  double advance(uint32_t glyph) const;  // em
  // Outline-only fonts: the outline of `glyph`.
  void setOutline(uint32_t glyph, GlyphOutline outline) { outlines_[glyph] = std::move(outline); }
  // The SHA-1 of the font file the face came from (derivedTextData's FontMetaData.fontDigest); zeros without a face.
  const std::array<uint8_t, 20>& digest() const;

 private:
  static uint32_t nextId_;
  uint32_t id_;
  std::shared_ptr<Face> face_;
  hb_font_t* font_ = nullptr;
  std::unordered_map<uint32_t, GlyphOutline> outlines_;
};

class FontRegistry {
 public:
  static FontRegistry& get();

  // Takes a malloc'd font file (TTF/OTF, or a TTC/OTC with `index`); the
  // registry frees it with the face. Returns the face id, or -1 when it isn't a font.
  int32_t addFace(uint8_t* bytes, size_t length, uint32_t index);
  // `faceId` answers (family, style): the named instance whose subfamily name is
  // `style` (spaces and case ignored), else the weight/italic axes the style's
  // words imply, else the face as it is. False for an unknown face.
  bool bind(const std::string& family, const std::string& style, int32_t faceId);
  // Nobody has (family, style): text using it is drawn with Inter, marked missing.
  void markMissing(const std::string& family, const std::string& style);
  // The ordered families tried for characters the text's own font lacks.
  void setFallbacks(std::vector<std::string> families);

  enum class State : uint8_t { Unknown, Requested, Ready, Missing };
  // The font for `name`, or nullptr while it is requested (the first call
  // requests it) or when it is missing.
  Font* find(const FontName& name, State* state = nullptr);
  State state(const FontName& name) const;
  // Inter Regular: what missing fonts and the overlays draw with (nullptr while it loads).
  Font* defaultFont();
  // A fallback font that has `codePoint` (requesting the list's fonts in turn), or nullptr.
  Font* fallbackFor(uint32_t codePoint);

  // REQUEST_FONT: names asked for since the last call.
  std::vector<FontName> takeRequests();
  bool hasRequests() const { return !requests_.empty(); }
  // Bumped whenever a font arrives or goes missing (text caches compare it).
  uint32_t generation() const { return generation_; }
  // Forgets everything (tests).
  void reset();

 private:
  static std::string keyOf(const std::string& family, const std::string& style);
  struct Entry {
    State state = State::Unknown;
    std::unique_ptr<Font> font;
  };
  std::vector<std::shared_ptr<Face>> faces_;
  std::unordered_map<std::string, Entry> entries_;
  std::vector<FontName> requests_;
  std::vector<std::string> fallbacks_;
  uint32_t generation_ = 1;
};

// "Semi Bold Italic" → "semibolditalic".
std::string normalizeStyle(const std::string& style);
// The weight (100–900) and italic a style name implies ("Regular" → 400).
void styleWeight(const std::string& style, int& weight, bool& italic);

}  // namespace eng::text
