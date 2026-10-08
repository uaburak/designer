// A TEXT node's layout as Figma stores it (schema/document.kiwi DerivedTextData, field 359; docs/schema.md §7):
// line boxes, glyphs with their outlines (commandsBlob, em units, y up — Figma's convention, checked on
// structure.fig), decorations, the fonts' digests. A snapshot that carries it draws its text before the fonts
// arrive (Figma's viewer and first frame do the same), and keeps drawing it when a font is missing.
//
// Outlines are interned process-wide: every stored glyph with the same outline is one glyph of one outline-only
// Font (text::storedGlyphFont), so the renderer's curve cache holds each shape once.
#pragma once

#include <array>
#include <cstdint>
#include <memory>
#include <string>
#include <string_view>
#include <vector>

#include "scene/CodecJson.h"
#include "scene/Node.h"
#include "schema/SchemaTable.h"
#include "text/TextLayout.h"

namespace eng::text {

struct StoredGlyph {
  uint32_t outline = 0;  // index in the stored-glyph font (0: no outline, e.g. a space)
  float x = 0, y = 0;    // origin on the baseline, node space
  uint32_t styleID = 0;
  float fontSize = 12;
  uint32_t firstCharacter = 0;
  float advance = 0;  // em
};
struct StoredLine {
  float x = 0, baseline = 0, width = 0, top = 0, height = 0, ascent = 0;
  uint32_t first = 0, end = 0;
};
struct StoredDecoration {
  std::vector<Rect> rects;
  uint32_t styleID = 0;
};
struct StoredFont {
  FontName key;
  float lineHeight = 0;
  std::array<uint8_t, 20> digest{};
};

struct StoredText {
  Vec2 layoutSize;
  std::vector<StoredLine> lines;
  std::vector<StoredGlyph> glyphs;
  std::vector<StoredDecoration> decorations;
  std::vector<StoredFont> fonts;
  int32_t truncationStart = -1;
  float truncatedHeight = -1;
  std::vector<float> caretXs;  // logicalIndexToCharacterOffsetMap
};

// The outline-only font every stored glyph draws with, and its outlines.
Font* storedGlyphFont();
// Interns an outline given as commands (Figma's commandsBlob, em, y up); 0 for an empty one.
uint32_t internStoredOutline(const uint8_t* data, size_t len);
// The commands of an interned outline (for writing it back).
Bytes storedOutlineCommands(uint32_t index);
// A glyph of a real font as commands (em, y up).
Bytes outlineCommands(const GlyphOutline& o);

// A laid-out text → what is stored. Nullptr when the layout can't be stored (a font pending or missing).
std::shared_ptr<const StoredText> storedFromLayout(const TextLayout& L);
// What is stored → a layout the renderer draws (glyphs from the stored outlines, styles from `p`).
std::unique_ptr<TextLayout> layoutFromStored(const std::shared_ptr<const StoredText>& s, const NodeProps& p);
// Whether the faces the stored layout was made with are the ones `L` (a real layout) used.
bool sameFonts(const StoredText& s, const TextLayout& L);

// DerivedTextData's raw field sequence (as scene/CodecKiwi keeps it) → StoredText, glyph outlines resolved through
// the Message's blobs.
bool readStoredText(std::string_view fields, const std::vector<Bytes>& blobs, StoredText& out);
// A DerivedTextData message (fields and terminator) into `o`, outlines into `blobs`.
void writeStoredText(schema::Out& o, const StoredText& s, codec::BlobsOut& blobs);

}  // namespace eng::text
