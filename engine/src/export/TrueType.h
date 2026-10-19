// A TrueType subset for the PDF export's embedded fonts (atlas 15 §9: Figma
// embeds text "as TrueType or Type3" — CID fonts with `/Registry (FigmaPDF)`
// and ToUnicode maps): the face's glyf outlines of the glyphs a document uses,
// composite glyphs' parts with them, every other glyph left empty so glyph ids
// stay as they are (the PDF's CIDToGIDMap is /Identity). The file holds what a
// PDF's FontFile2 needs — head, hhea, maxp, hmtx, loca (long), glyf — plus
// OS/2, name and a version 3 post when the face has them; no cmap (the codes
// are glyph ids), no hinting tables. No dependency (HarfBuzz's subsetter isn't
// built): a face without glyf outlines (CFF) isn't subset, and its text stays
// Type 3.
#pragma once

#include <cstdint>
#include <set>
#include <string>

struct hb_face_t;

namespace eng::exporter {

// What the PDF's font descriptor reads from the face (font units, y up).
struct TrueTypeInfo {
  int unitsPerEm = 1000;
  int bbox[4] = {0, 0, 0, 0};  // head's xMin yMin xMax yMax
  int ascent = 0, descent = 0, capHeight = 0;
  double italicAngle = 0;
  std::string postScriptName;  // name ID 6, empty when the face has none
};

// Whether `face` has the tables a subset is made of (head, hhea, maxp, hmtx, loca, glyf) in a form it reads.
bool canSubsetTrueType(hb_face_t* face);

// The subset font file of `face` with `glyphs` (glyph 0, .notdef, always), or "" when the face has no glyf / loca
// tables or they don't read.
std::string subsetTrueType(hb_face_t* face, const std::set<uint32_t>& glyphs, TrueTypeInfo& info);

}  // namespace eng::exporter
