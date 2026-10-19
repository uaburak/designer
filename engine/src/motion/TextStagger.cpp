#include "motion/TextStagger.h"

#include <algorithm>
#include <cmath>
#include <numeric>

#include "text/TextLayout.h"

namespace eng::motion {

namespace {

bool isSpace(char16_t c) { return c == u' ' || c == u'\t' || c == u'\n' || c == u'\r' || c == 0x00a0 || c == 0x2028 || c == 0x2029 || c == 0x3000; }

}  // namespace

TextElements groupElements(const text::TextLayout& L, Grouping g) {
  TextElements out;
  out.elementOf.assign(L.glyphs.size(), -1);
  // Raw element numbers first (a line or paragraph of spaces only takes one too), then numbered again in order of
  // the elements that have a glyph to draw.
  int32_t current = -1;
  bool open = false;  // WORD: inside a word; LINE / PARAGRAPH: its element started
  std::vector<int32_t> compact;
  for (const text::LaidLine& line : L.lines) {
    if (g == Grouping::LINE) open = false;
    for (uint32_t k = line.firstGlyph; k < line.firstGlyph + line.glyphCount && k < L.glyphs.size(); k++) {
      const text::LaidGlyph& gl = L.glyphs[k];
      if (gl.marker) continue;  // a list's bullet is not a character of the text
      bool space = gl.cluster < L.text.size() && isSpace(L.text[gl.cluster]);
      int32_t e = -1;
      switch (g) {
        case Grouping::CHARACTER: e = ++current; break;
        case Grouping::CHARACTER_NO_WHITESPACE: e = space ? -1 : ++current; break;
        case Grouping::WORD:
          if (space) open = false;
          else e = open ? current : (open = true, ++current);
          break;
        case Grouping::LINE:
        case Grouping::PARAGRAPH:
          if (!open) open = true, ++current;
          e = space ? -1 : current;
          break;
      }
      if (e < 0) continue;
      if (static_cast<size_t>(e) >= compact.size()) compact.resize(static_cast<size_t>(e) + 1, -1);
      Rect box{gl.x, line.top, std::max<double>(gl.advance, 0), line.height};
      if (compact[static_cast<size_t>(e)] < 0) {
        compact[static_cast<size_t>(e)] = static_cast<int32_t>(out.boxes.size());
        out.boxes.push_back(box);
      } else {
        Rect& b = out.boxes[static_cast<size_t>(compact[static_cast<size_t>(e)])];
        b = b.united(box);
      }
      out.elementOf[k] = compact[static_cast<size_t>(e)];
    }
    if (g == Grouping::PARAGRAPH && line.paragraphEnd) open = false;
  }
  return out;
}

std::vector<uint32_t> staggerRanks(size_t count, StaggerOrder order, Guid seed) {
  std::vector<uint32_t> ranks(count);
  switch (order) {
    case StaggerOrder::LEFT_RIGHT:
      for (size_t i = 0; i < count; i++) ranks[i] = static_cast<uint32_t>(i);
      break;
    case StaggerOrder::RIGHT_LEFT:
      for (size_t i = 0; i < count; i++) ranks[i] = static_cast<uint32_t>(count - 1 - i);
      break;
    case StaggerOrder::CENTER_OUT: {
      double mid = (static_cast<double>(count) - 1) / 2;
      for (size_t i = 0; i < count; i++) ranks[i] = static_cast<uint32_t>(std::floor(std::fabs(static_cast<double>(i) - mid)));
      break;
    }
    case StaggerOrder::RANDOM: {
      // A permutation by a hash of (the node's GUID, i): the same text shuffles the same way every time.
      auto hash = [&](size_t i) {
        uint64_t h = (static_cast<uint64_t>(seed.sessionID) << 32 | seed.localID) ^ (0x9e3779b97f4a7c15ull * (i + 1));
        h ^= h >> 33;
        h *= 0xff51afd7ed558ccdull;
        h ^= h >> 33;
        return h;
      };
      std::vector<size_t> idx(count);
      std::iota(idx.begin(), idx.end(), size_t{0});
      std::sort(idx.begin(), idx.end(), [&](size_t a, size_t b) { return hash(a) < hash(b); });
      for (size_t r = 0; r < count; r++) ranks[idx[r]] = static_cast<uint32_t>(r);
      break;
    }
  }
  return ranks;
}

void staggerTiming(int64_t clipUs, uint32_t slots, double overlap, int64_t& elementUs, int64_t& stepUs) {
  double o = std::clamp(overlap, 0.0, 1.0);
  double m = std::max<uint32_t>(slots, 1);
  double g = static_cast<double>(clipUs) / (1 + (m - 1) * (1 - o));
  elementUs = std::max<int64_t>(1, static_cast<int64_t>(std::llround(g)));
  stepUs = static_cast<int64_t>(std::llround(g * (1 - o)));
}

}  // namespace eng::motion
