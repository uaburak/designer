// Bidirectional text (UAX #9, docs/engine.md §7.2; Atlas 06 §10): the embedding level of each character of a
// paragraph, and a line's visual order. Figma resolves it with ICU's ubidi per paragraph; this is the Unicode
// algorithm itself over a Bidi_Class table generated from Unicode (tools/gen-bidi.py): explicit embeddings,
// overrides and isolates (X1–X10, isolating run sequences), weak types (W1–W7), bracket pairs (N0, brackets
// from HarfBuzz's mirroring), neutrals (N1–N2), implicit levels (I1–I2), and per line L1 (trailing whitespace back
// to the paragraph's level) and L2 (reversal). Mirrored glyphs (L4) are HarfBuzz's when it shapes a run right to
// left.
#pragma once

#include <cstdint>
#include <string_view>
#include <vector>

#include "text/BidiClass.generated.h"

namespace eng::text {

BidiClass bidiClass(uint32_t codePoint);

// P2 / P3: a paragraph's level from its first strong character (isolates skipped): 0 left to right, 1 right to left;
// `fallback` when it has none.
uint8_t paragraphLevel(std::u16string_view paragraph, uint8_t fallback = 0);

// Whether anything in `s` can be right to left (R, AL, AN, or an explicit RTL embedding / override / isolate): when
// not, and the paragraph's level is 0, every level is 0 and layout skips the algorithm.
bool hasRtl(std::u16string_view s);

// The resolved level (I2) of each UTF-16 unit of a paragraph at `baseLevel` (a pair's two units share one), and each
// unit's Bidi_Class (for lineLevels). Characters X9 removes (embedding controls, BN) take their neighbour's level.
void resolveLevels(std::u16string_view paragraph, uint8_t baseLevel, std::vector<uint8_t>& levels, std::vector<BidiClass>& classes);

// L1 for one line [from, to) of the paragraph: segment and paragraph separators, and the whitespace and isolate
// controls before them or at the line's end, go back to the paragraph's level.
void lineLevels(const std::vector<BidiClass>& classes, uint8_t baseLevel, size_t from, size_t to, std::vector<uint8_t>& levels);

// L2: the visual order of items at `levels` (indices, left to right).
std::vector<uint32_t> visualOrder(const std::vector<uint8_t>& levels);

}  // namespace eng::text
