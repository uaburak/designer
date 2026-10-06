// Unicode helpers for text layout and editing (docs/engine.md §7.4, §7.6):
// UTF-8 ⇄ UTF-16 (the engine's text offsets are UTF-16 code units, as Figma's
// characterStyleIDs and the JS side), break opportunities from libunibreak
// (UAX #14 lines, UAX #29 words and graphemes), case mapping from a table generated
// from Unicode (tools/gen-casemap.py), categories from HarfBuzz's UCD.
#pragma once

#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

#include "scene/Node.h"

namespace eng::text {

std::u16string utf8To16(std::string_view s);
std::string utf16To8(std::u16string_view s);
// The code point at `i` (a lone surrogate is returned as is) and its length in units.
uint32_t codePointAt(std::u16string_view s, size_t i, size_t* units = nullptr);
inline bool isLowSurrogate(char16_t c) { return c >= 0xDC00 && c <= 0xDFFF; }
inline bool isHighSurrogate(char16_t c) { return c >= 0xD800 && c <= 0xDBFF; }

// Per UTF-16 unit i: the break opportunity between unit i and i+1 (libunibreak's
// LINEBREAK_* / WORDBREAK_* / GRAPHEMEBREAK_* values: 0 must/break, 1 allow, 2 no,
// 3 inside a character).
enum Break : char { BREAK_MUST = 0, BREAK_ALLOW = 1, BREAK_NO = 2, BREAK_INSIDE = 3 };
void lineBreaks(std::u16string_view s, std::vector<char>& out);
void wordBreaks(std::u16string_view s, std::vector<char>& out);
void graphemeBreaks(std::u16string_view s, std::vector<char>& out);

// Caret stops: the grapheme boundary before / after `pos` (0 and size() included).
size_t prevGrapheme(std::u16string_view s, size_t pos);
size_t nextGrapheme(std::u16string_view s, size_t pos);
// ⌥← / ⌥→: the start of the word before `pos`, the end of the word after it
// (whitespace and punctuation are skipped, as on a Mac).
size_t prevWordStart(std::u16string_view s, size_t pos);
size_t nextWordEnd(std::u16string_view s, size_t pos);
// The word around `pos` (double-click): [start, end). A run of spaces or one
// punctuation character when that is what is there.
void wordAt(std::u16string_view s, size_t pos, size_t& start, size_t& end);
// The paragraph around `pos` (triple-click): [start, end), without its "\n".
void paragraphAt(std::u16string_view s, size_t pos, size_t& start, size_t& end);

bool isWhitespace(uint32_t cp);
// Letters and digits (word characters).
bool isWordChar(uint32_t cp);

// textCase applied, unit for unit (Unicode's default simple case mappings, not
// locale-sensitive: "i" → "I", "ı" → "I", "İ" → "i"; a mapping that
// would change a character's UTF-16 length keeps the character). TITLE upper-cases
// the first letter of each word and leaves the rest (CSS capitalize).
std::u16string applyCase(std::u16string_view s, TextCase textCase);

}  // namespace eng::text
