#include "text/Unicode.h"

#include <graphemebreak.h>
#include <hb.h>
#include <linebreak.h>
#include <wordbreak.h>

#include <algorithm>

#include "text/CaseMap.generated.h"

namespace eng::text {

namespace {

void initBreaks() {
  static bool done = false;
  if (done) return;
  done = true;
  init_linebreak();
  init_wordbreak();
  init_graphemebreak();
}

const utf16_t* units(std::u16string_view s) { return reinterpret_cast<const utf16_t*>(s.data()); }

hb_unicode_general_category_t category(uint32_t cp) { return hb_unicode_general_category(hb_unicode_funcs_get_default(), cp); }

template <size_t N>
uint32_t mapCase(const CaseRange (&table)[N], uint32_t cp) {
  // The last range starting at or before cp.
  const CaseRange* it = std::upper_bound(table, table + N, cp, [](uint32_t v, const CaseRange& r) { return v < r.start; });
  if (it == table) return cp;
  const CaseRange& r = *(it - 1);
  if (cp > r.end || (cp - r.start) % r.stride != 0) return cp;
  return static_cast<uint32_t>(static_cast<int64_t>(cp) + r.delta);
}

}  // namespace

std::u16string utf8To16(std::string_view s) {
  std::u16string out;
  out.reserve(s.size());
  for (size_t i = 0; i < s.size();) {
    uint8_t c = static_cast<uint8_t>(s[i]);
    uint32_t cp = 0xFFFD;
    size_t n = 1;
    if (c < 0x80) cp = c;
    else if ((c >> 5) == 6 && i + 1 < s.size()) cp = ((c & 0x1F) << 6) | (s[i + 1] & 0x3F), n = 2;
    else if ((c >> 4) == 14 && i + 2 < s.size()) cp = ((c & 0x0F) << 12) | ((s[i + 1] & 0x3F) << 6) | (s[i + 2] & 0x3F), n = 3;
    else if ((c >> 3) == 30 && i + 3 < s.size())
      cp = ((c & 0x07) << 18) | ((s[i + 1] & 0x3F) << 12) | ((s[i + 2] & 0x3F) << 6) | (s[i + 3] & 0x3F), n = 4;
    i += n;
    if (cp >= 0x10000) {
      cp -= 0x10000;
      out += static_cast<char16_t>(0xD800 + (cp >> 10));
      out += static_cast<char16_t>(0xDC00 + (cp & 0x3FF));
    } else {
      out += static_cast<char16_t>(cp);
    }
  }
  return out;
}

std::string utf16To8(std::u16string_view s) {
  std::string out;
  out.reserve(s.size());
  for (size_t i = 0; i < s.size();) {
    size_t n = 1;
    uint32_t cp = codePointAt(s, i, &n);
    i += n;
    if (cp < 0x80) {
      out += static_cast<char>(cp);
    } else if (cp < 0x800) {
      out += static_cast<char>(0xC0 | (cp >> 6));
      out += static_cast<char>(0x80 | (cp & 0x3F));
    } else if (cp < 0x10000) {
      out += static_cast<char>(0xE0 | (cp >> 12));
      out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
      out += static_cast<char>(0x80 | (cp & 0x3F));
    } else {
      out += static_cast<char>(0xF0 | (cp >> 18));
      out += static_cast<char>(0x80 | ((cp >> 12) & 0x3F));
      out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
      out += static_cast<char>(0x80 | (cp & 0x3F));
    }
  }
  return out;
}

uint32_t codePointAt(std::u16string_view s, size_t i, size_t* n) {
  if (n) *n = 1;
  if (i >= s.size()) return 0;
  char16_t c = s[i];
  if (isHighSurrogate(c) && i + 1 < s.size() && isLowSurrogate(s[i + 1])) {
    if (n) *n = 2;
    return 0x10000 + ((static_cast<uint32_t>(c) - 0xD800) << 10) + (static_cast<uint32_t>(s[i + 1]) - 0xDC00);
  }
  return c;
}

void lineBreaks(std::u16string_view s, std::vector<char>& out) {
  initBreaks();
  out.assign(s.size(), BREAK_NO);
  if (!s.empty()) set_linebreaks_utf16(units(s), s.size(), "en", out.data());
}

void wordBreaks(std::u16string_view s, std::vector<char>& out) {
  initBreaks();
  out.assign(s.size(), BREAK_NO);
  if (!s.empty()) set_wordbreaks_utf16(units(s), s.size(), "en", out.data());
}

void graphemeBreaks(std::u16string_view s, std::vector<char>& out) {
  initBreaks();
  out.assign(s.size(), BREAK_NO);
  if (!s.empty()) set_graphemebreaks_utf16(units(s), s.size(), "en", out.data());
}

size_t prevGrapheme(std::u16string_view s, size_t pos) {
  if (pos == 0) return 0;
  if (pos > s.size()) return s.size();
  std::vector<char> b;
  graphemeBreaks(s, b);
  // b[i] = the break between unit i and i+1.
  for (size_t i = pos - 1; i > 0; i--)
    if (b[i - 1] == BREAK_MUST) return i;
  return 0;
}

size_t nextGrapheme(std::u16string_view s, size_t pos) {
  if (pos >= s.size()) return s.size();
  std::vector<char> b;
  graphemeBreaks(s, b);
  for (size_t i = pos; i < s.size(); i++)
    if (b[i] == BREAK_MUST) return i + 1;
  return s.size();
}

bool isWhitespace(uint32_t cp) {
  if (cp == ' ' || cp == '\t' || cp == '\n' || cp == '\r' || cp == 0x2028 || cp == 0x2029 || cp == 0xA0) return true;
  auto cat = category(cp);
  return cat == HB_UNICODE_GENERAL_CATEGORY_SPACE_SEPARATOR || cat == HB_UNICODE_GENERAL_CATEGORY_LINE_SEPARATOR ||
         cat == HB_UNICODE_GENERAL_CATEGORY_PARAGRAPH_SEPARATOR;
}

bool isWordChar(uint32_t cp) {
  switch (category(cp)) {
    case HB_UNICODE_GENERAL_CATEGORY_UPPERCASE_LETTER:
    case HB_UNICODE_GENERAL_CATEGORY_LOWERCASE_LETTER:
    case HB_UNICODE_GENERAL_CATEGORY_TITLECASE_LETTER:
    case HB_UNICODE_GENERAL_CATEGORY_MODIFIER_LETTER:
    case HB_UNICODE_GENERAL_CATEGORY_OTHER_LETTER:
    case HB_UNICODE_GENERAL_CATEGORY_NON_SPACING_MARK:
    case HB_UNICODE_GENERAL_CATEGORY_SPACING_MARK:
    case HB_UNICODE_GENERAL_CATEGORY_ENCLOSING_MARK:
    case HB_UNICODE_GENERAL_CATEGORY_DECIMAL_NUMBER:
    case HB_UNICODE_GENERAL_CATEGORY_LETTER_NUMBER:
    case HB_UNICODE_GENERAL_CATEGORY_OTHER_NUMBER:
    case HB_UNICODE_GENERAL_CATEGORY_CONNECT_PUNCTUATION: return true;
    default: return cp == '\'' || cp == 0x2019;
  }
}

namespace {
// The code point that ends just before `pos`, and where it starts.
uint32_t cpBefore(std::u16string_view s, size_t pos, size_t& start) {
  start = pos - 1;
  if (start > 0 && isLowSurrogate(s[start]) && isHighSurrogate(s[start - 1])) start--;
  return codePointAt(s, start);
}
}  // namespace

size_t prevWordStart(std::u16string_view s, size_t pos) {
  pos = std::min(pos, s.size());
  // Skip what isn't a word, then the word.
  while (pos > 0) {
    size_t at;
    if (isWordChar(cpBefore(s, pos, at))) break;
    pos = at;
  }
  while (pos > 0) {
    size_t at;
    if (!isWordChar(cpBefore(s, pos, at))) break;
    pos = at;
  }
  return pos;
}

size_t nextWordEnd(std::u16string_view s, size_t pos) {
  size_t n = 1;
  while (pos < s.size() && !isWordChar(codePointAt(s, pos, &n))) pos += n;
  while (pos < s.size() && isWordChar(codePointAt(s, pos, &n))) pos += n;
  return pos;
}

void wordAt(std::u16string_view s, size_t pos, size_t& start, size_t& end) {
  start = end = std::min(pos, s.size());
  if (s.empty()) return;
  // The character under the caret: the one after it, else the one before.
  size_t at = pos < s.size() ? pos : pos - 1;
  if (isLowSurrogate(s[at]) && at > 0) at--;
  size_t n = 1;
  uint32_t cp = codePointAt(s, at, &n);
  if (cp == '\n') {
    if (at == 0) return;
    at--;
    cp = codePointAt(s, at, &n);
    if (cp == '\n') return;
  }
  auto kind = [](uint32_t c) { return isWordChar(c) ? 0 : isWhitespace(c) ? 1 : 2; };
  int k = kind(cp);
  start = at;
  end = at + n;
  if (k == 2) return;  // one punctuation character
  while (start > 0) {
    size_t b;
    uint32_t c = cpBefore(s, start, b);
    if (c == '\n' || kind(c) != k) break;
    start = b;
  }
  while (end < s.size()) {
    uint32_t c = codePointAt(s, end, &n);
    if (c == '\n' || kind(c) != k) break;
    end += n;
  }
}

void paragraphAt(std::u16string_view s, size_t pos, size_t& start, size_t& end) {
  pos = std::min(pos, s.size());
  start = pos;
  while (start > 0 && s[start - 1] != u'\n') start--;
  end = pos;
  while (end < s.size() && s[end] != u'\n') end++;
}

std::u16string applyCase(std::u16string_view s, TextCase textCase) {
  std::u16string out(s);
  if (textCase != TextCase::UPPER && textCase != TextCase::LOWER && textCase != TextCase::TITLE) return out;
  bool wordStart = true;
  for (size_t i = 0; i < s.size();) {
    size_t n = 1;
    uint32_t cp = codePointAt(s, i, &n);
    uint32_t mapped = cp;
    if (textCase == TextCase::UPPER) mapped = mapCase(kUpper, cp);
    else if (textCase == TextCase::LOWER) mapped = mapCase(kLower, cp);
    else if (wordStart && isWordChar(cp)) mapped = mapCase(kTitle, cp);
    if (textCase == TextCase::TITLE) wordStart = !isWordChar(cp);
    size_t m = mapped >= 0x10000 ? 2 : 1;
    if (mapped != cp && m == n) {
      if (m == 1) {
        out[i] = static_cast<char16_t>(mapped);
      } else {
        uint32_t v = mapped - 0x10000;
        out[i] = static_cast<char16_t>(0xD800 + (v >> 10));
        out[i + 1] = static_cast<char16_t>(0xDC00 + (v & 0x3FF));
      }
    }
    i += n;
  }
  return out;
}

}  // namespace eng::text
