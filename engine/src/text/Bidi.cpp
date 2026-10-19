#include "text/Bidi.h"

#include <hb.h>

#include <algorithm>

#include "text/Unicode.h"

namespace eng::text {

namespace {

using enum BidiClass;

constexpr uint8_t kMaxDepth = 125;
constexpr size_t kMaxBrackets = 63;

bool removedByX9(BidiClass c) { return c == LRE || c == RLE || c == LRO || c == RLO || c == PDF || c == BN; }
bool isolateInitiator(BidiClass c) { return c == LRI || c == RLI || c == FSI; }
bool neutralOrIsolate(BidiClass c) { return c == B || c == S || c == WS || c == ON || c == LRI || c == RLI || c == FSI || c == PDI; }
// N1's strong types: numbers count as R.
BidiClass strongOf(BidiClass c) { return c == L ? L : (c == R || c == AL || c == EN || c == AN) ? R : ON; }

// P2: the first strong character of [from, to) (characters inside isolates skipped); -1 when none, 0 L, 1 R / AL.
// `toPdi`: an FSI's content, which ends at the PDI closing it.
int firstStrong(const std::vector<BidiClass>& t, size_t from, size_t to, bool toPdi) {
  int depth = 0;
  for (size_t i = from; i < to; i++) {
    BidiClass c = t[i];
    if (isolateInitiator(c)) depth++;
    else if (c == PDI) {
      if (depth > 0) depth--;
      else if (toPdi) return -1;
    } else if (c == B) {
      return -1;
    } else if (depth == 0 && (c == L || c == R || c == AL)) {
      return c == L ? 0 : 1;
    }
  }
  return -1;
}

// A paired bracket (BD14, BD15): an opening one's closing partner, or 0. HarfBuzz's mirroring with the general
// category (Ps / Pe) stands in for BidiBrackets.txt; U+2329 / U+232A are canonically U+3008 / U+3009.
uint32_t canonicalBracket(uint32_t cp) { return cp == 0x2329 ? 0x3008 : cp == 0x232A ? 0x3009 : cp; }
bool openingBracket(uint32_t cp, uint32_t& closing) {
  hb_unicode_funcs_t* u = hb_unicode_funcs_get_default();
  if (hb_unicode_general_category(u, cp) != HB_UNICODE_GENERAL_CATEGORY_OPEN_PUNCTUATION) return false;
  uint32_t m = hb_unicode_mirroring(u, cp);
  if (m == cp) return false;
  closing = canonicalBracket(m);
  return true;
}
bool closingBracket(uint32_t cp) {
  hb_unicode_funcs_t* u = hb_unicode_funcs_get_default();
  return hb_unicode_general_category(u, cp) == HB_UNICODE_GENERAL_CATEGORY_CLOSE_PUNCTUATION && hb_unicode_mirroring(u, cp) != cp;
}

// Resolves one isolating run sequence (W1–W7, N0–N2, I1–I2): `seq` its characters' indices, in order.
void resolveSequence(const std::vector<uint32_t>& seq, const std::vector<uint32_t>& cps, const std::vector<BidiClass>& original,
                     std::vector<BidiClass>& t, std::vector<uint8_t>& levels, BidiClass sos, BidiClass eos) {
  const size_t n = seq.size();
  const uint8_t level = levels[seq[0]];
  const BidiClass e = (level & 1) ? R : L;
  auto at = [&](size_t k) -> BidiClass& { return t[seq[k]]; };

  // W1: a mark takes the type before it (ON after an isolate initiator or a PDI).
  for (size_t k = 0; k < n; k++)
    if (at(k) == NSM) at(k) = k == 0 ? sos : (isolateInitiator(at(k - 1)) || at(k - 1) == PDI) ? ON : at(k - 1);
  // W2: European numbers after Arabic letters are Arabic numbers; W3: AL is R.
  {
    BidiClass last = sos;
    for (size_t k = 0; k < n; k++) {
      BidiClass c = at(k);
      if (c == L || c == R || c == AL) last = c;
      else if (c == EN && last == AL) at(k) = AN;
    }
    for (size_t k = 0; k < n; k++)
      if (at(k) == AL) at(k) = R;
  }
  // W4: a single separator between two numbers of a kind.
  for (size_t k = 1; k + 1 < n; k++) {
    BidiClass c = at(k), a = at(k - 1), b = at(k + 1);
    if (c == ES && a == EN && b == EN) at(k) = EN;
    else if (c == CS && a == b && (a == EN || a == AN)) at(k) = a;
  }
  // W5: terminators next to European numbers.
  for (size_t k = 0; k < n;) {
    if (at(k) != ET) {
      k++;
      continue;
    }
    size_t j = k;
    while (j < n && at(j) == ET) j++;
    if ((k > 0 && at(k - 1) == EN) || (j < n && at(j) == EN))
      for (size_t m = k; m < j; m++) at(m) = EN;
    k = j;
  }
  // W6: the rest of the separators and terminators are neutral; W7: European numbers after L are L.
  for (size_t k = 0; k < n; k++)
    if (at(k) == ES || at(k) == ET || at(k) == CS) at(k) = ON;
  {
    BidiClass last = sos;
    for (size_t k = 0; k < n; k++) {
      BidiClass c = at(k);
      if (c == L || c == R) last = c;
      else if (c == EN && last == L) at(k) = L;
    }
  }

  // N0: bracket pairs take the embedding direction, or the context's.
  {
    struct Open {
      uint32_t closing;
      size_t k;
    };
    std::vector<Open> stack;
    std::vector<std::pair<size_t, size_t>> pairs;
    for (size_t k = 0; k < n; k++) {
      if (at(k) != ON) continue;
      uint32_t cp = cps[seq[k]], closing = 0;
      if (openingBracket(cp, closing)) {
        if (stack.size() >= kMaxBrackets) break;
        stack.push_back({closing, k});
      } else if (closingBracket(cp)) {
        uint32_t c = canonicalBracket(cp);
        for (size_t s = stack.size(); s-- > 0;)
          if (stack[s].closing == c) {
            pairs.push_back({stack[s].k, k});
            stack.resize(s);
            break;
          }
      }
    }
    std::sort(pairs.begin(), pairs.end());
    for (auto [open, close] : pairs) {
      bool same = false, opposite = false;
      for (size_t k = open + 1; k < close; k++) {
        BidiClass s = strongOf(at(k));
        if (s == e) same = true;
        else if (s != ON) opposite = true;
      }
      BidiClass to = ON;
      if (same) {
        to = e;
      } else if (opposite) {
        BidiClass before = sos;
        for (size_t k = open; k-- > 0;)
          if (BidiClass s = strongOf(at(k)); s != ON) {
            before = s;
            break;
          }
        to = before != e ? before : e;
      }
      if (to == ON) continue;
      at(open) = at(close) = to;
      // Marks after a bracket that changed follow it.
      for (size_t b : {open, close})
        for (size_t k = b + 1; k < n && original[seq[k]] == NSM; k++) at(k) = to;
    }
  }

  // N1 / N2: neutrals between two strong types of a direction take it, else the embedding direction.
  for (size_t k = 0; k < n;) {
    if (!neutralOrIsolate(at(k))) {
      k++;
      continue;
    }
    size_t j = k;
    while (j < n && neutralOrIsolate(at(j))) j++;
    BidiClass before = k == 0 ? sos : strongOf(at(k - 1));
    BidiClass after = j == n ? eos : strongOf(at(j));
    BidiClass to = before == after && before != ON ? before : e;
    for (size_t m = k; m < j; m++) at(m) = to;
    k = j;
  }

  // I1 / I2.
  for (size_t k = 0; k < n; k++) {
    BidiClass c = at(k);
    uint8_t& lv = levels[seq[k]];
    if ((lv & 1) == 0) {
      if (c == R) lv += 1;
      else if (c == AN || c == EN) lv += 2;
    } else if (c == L || c == EN || c == AN) {
      lv += 1;
    }
  }
}

}  // namespace

BidiClass bidiClass(uint32_t cp) {
  const auto& table = bidi_table::kRanges;
  auto it = std::upper_bound(std::begin(table), std::end(table), cp, [](uint32_t c, const BidiRange& r) { return c < r.start; });
  if (it == std::begin(table)) return L;
  --it;
  return cp <= it->end ? it->cls : L;
}

uint8_t paragraphLevel(std::u16string_view s, uint8_t fallback) {
  // P2 as firstStrong, reading the classes as it goes (a Latin paragraph stops at its first letter).
  int depth = 0;
  for (size_t i = 0; i < s.size();) {
    size_t len = 1;
    BidiClass c = bidiClass(codePointAt(s, i, &len));
    i += len;
    if (isolateInitiator(c)) depth++;
    else if (c == PDI && depth > 0) depth--;
    else if (c == B) break;
    else if (depth == 0 && (c == L || c == R || c == AL)) return c == L ? 0 : 1;
  }
  return fallback;
}

bool hasRtl(std::u16string_view s) {
  for (size_t i = 0; i < s.size(); i++) {
    char16_t u = s[i];
    // Everything below U+0590 is left to right or neutral, apart from the explicit controls (U+202B, U+202E,
    // U+2067, U+2068 are above it).
    if (u < 0x0590) continue;
    size_t len = 1;
    BidiClass c = bidiClass(codePointAt(s, i, &len));
    if (c == R || c == AL || c == AN || c == RLE || c == RLO || c == RLI || c == FSI) return true;
    i += len - 1;
  }
  return false;
}

void resolveLevels(std::u16string_view s, uint8_t base, std::vector<uint8_t>& unitLevels, std::vector<BidiClass>& unitClasses) {
  // Code points (the algorithm's characters) and the unit each starts at.
  std::vector<uint32_t> cps, startOf;
  cps.reserve(s.size());
  startOf.reserve(s.size());
  for (size_t i = 0; i < s.size();) {
    size_t len = 1;
    cps.push_back(codePointAt(s, i, &len));
    startOf.push_back(static_cast<uint32_t>(i));
    i += len;
  }
  const size_t n = cps.size();
  std::vector<BidiClass> original(n);
  for (size_t i = 0; i < n; i++) original[i] = bidiClass(cps[i]);
  std::vector<BidiClass> t = original;
  std::vector<uint8_t> levels(n, base);

  // BD9: each isolate initiator's matching PDI.
  std::vector<int64_t> match(n, -1);
  std::vector<bool> matchedPdi(n, false);
  {
    std::vector<size_t> open;
    for (size_t i = 0; i < n; i++) {
      if (isolateInitiator(original[i])) open.push_back(i);
      else if (original[i] == PDI && !open.empty()) {
        match[open.back()] = static_cast<int64_t>(i);
        matchedPdi[i] = true;
        open.pop_back();
      } else if (original[i] == B) {
        open.clear();
      }
    }
  }

  // X1–X8: explicit levels and directions.
  struct Entry {
    uint8_t level;
    BidiClass override;  // ON: none
    bool isolate;
  };
  std::vector<Entry> stack{{base, ON, false}};
  int overflowIsolates = 0, overflowEmbeddings = 0, validIsolates = 0;
  auto nextOdd = [](uint8_t l) { return static_cast<uint8_t>((l + 1) | 1); };
  auto nextEven = [](uint8_t l) { return static_cast<uint8_t>((l + 2) & ~1); };
  for (size_t i = 0; i < n; i++) {
    BidiClass c = original[i];
    const Entry& top = stack.back();
    switch (c) {
      case RLE: case LRE: case RLO: case LRO: {
        uint8_t level = (c == RLE || c == RLO) ? nextOdd(top.level) : nextEven(top.level);
        levels[i] = top.level;
        if (level <= kMaxDepth && overflowIsolates == 0 && overflowEmbeddings == 0)
          stack.push_back({level, c == RLO ? R : c == LRO ? L : ON, false});
        else if (overflowIsolates == 0)
          overflowEmbeddings++;
        break;
      }
      case RLI: case LRI: case FSI: {
        bool rtl = c == RLI;
        if (c == FSI) rtl = firstStrong(original, i + 1, match[i] >= 0 ? static_cast<size_t>(match[i]) : n, true) == 1;
        levels[i] = top.level;
        if (top.override != ON) t[i] = top.override;
        uint8_t level = rtl ? nextOdd(top.level) : nextEven(top.level);
        if (level <= kMaxDepth && overflowIsolates == 0 && overflowEmbeddings == 0) {
          validIsolates++;
          stack.push_back({level, ON, true});
        } else {
          overflowIsolates++;
        }
        break;
      }
      case PDI:
        if (overflowIsolates > 0) {
          overflowIsolates--;
        } else if (validIsolates > 0) {
          overflowEmbeddings = 0;
          while (!stack.back().isolate) stack.pop_back();
          stack.pop_back();
          validIsolates--;
        }
        levels[i] = stack.back().level;
        if (stack.back().override != ON) t[i] = stack.back().override;
        break;
      case PDF:
        levels[i] = top.level;
        if (overflowIsolates > 0) break;
        if (overflowEmbeddings > 0) overflowEmbeddings--;
        else if (!top.isolate && stack.size() >= 2) stack.pop_back();
        break;
      case B: levels[i] = base; break;
      case BN: levels[i] = top.level; break;
      default:
        levels[i] = top.level;
        if (top.override != ON) t[i] = top.override;
        break;
    }
  }

  // X9 / X10: level runs of the characters kept, linked across matched isolates into isolating run sequences.
  std::vector<std::vector<uint32_t>> runs;
  std::vector<int64_t> runStartingAt(n, -1);
  for (size_t i = 0; i < n; i++) {
    if (removedByX9(original[i])) continue;
    if (runs.empty() || levels[runs.back().back()] != levels[i]) {
      runStartingAt[i] = static_cast<int64_t>(runs.size());
      runs.push_back({});
    }
    runs.back().push_back(static_cast<uint32_t>(i));
  }
  auto keptBefore = [&](size_t i) -> int64_t {
    for (size_t k = i; k-- > 0;)
      if (!removedByX9(original[k])) return static_cast<int64_t>(k);
    return -1;
  };
  auto keptAfter = [&](size_t i) -> int64_t {
    for (size_t k = i + 1; k < n; k++)
      if (!removedByX9(original[k])) return static_cast<int64_t>(k);
    return -1;
  };
  for (const std::vector<uint32_t>& first : runs) {
    if (matchedPdi[first.front()]) continue;  // continues the sequence of its initiator
    std::vector<uint32_t> seq = first;
    while (isolateInitiator(original[seq.back()]) && match[seq.back()] >= 0) {
      int64_t r = runStartingAt[static_cast<size_t>(match[seq.back()])];
      if (r < 0) break;
      seq.insert(seq.end(), runs[static_cast<size_t>(r)].begin(), runs[static_cast<size_t>(r)].end());
    }
    uint8_t level = levels[seq.front()];
    int64_t before = keptBefore(seq.front());
    uint8_t prev = before >= 0 ? levels[static_cast<size_t>(before)] : base;
    uint32_t last = seq.back();
    int64_t after = isolateInitiator(original[last]) ? -1 : keptAfter(last);
    uint8_t next = after >= 0 ? levels[static_cast<size_t>(after)] : base;
    BidiClass sos = (std::max(level, prev) & 1) ? R : L;
    BidiClass eos = (std::max(level, next) & 1) ? R : L;
    resolveSequence(seq, cps, original, t, levels, sos, eos);
  }
  // Characters X9 removed take the level before them (the paragraph's at its start).
  for (size_t i = 0; i < n; i++)
    if (removedByX9(original[i])) levels[i] = i > 0 ? levels[i - 1] : base;

  unitLevels.assign(s.size(), base);
  unitClasses.assign(s.size(), L);
  for (size_t i = 0; i < n; i++) {
    size_t end = i + 1 < n ? startOf[i + 1] : s.size();
    for (size_t u = startOf[i]; u < end; u++) {
      unitLevels[u] = levels[i];
      unitClasses[u] = original[i];
    }
  }
}

void lineLevels(const std::vector<BidiClass>& classes, uint8_t base, size_t from, size_t to, std::vector<uint8_t>& levels) {
  auto trailing = [](BidiClass c) { return c == WS || isolateInitiator(c) || c == PDI || removedByX9(c); };
  auto reset = [&](size_t end) {
    for (size_t k = end; k-- > from && trailing(classes[k]);) levels[k] = base;
  };
  for (size_t i = from; i < to; i++)
    if (classes[i] == S || classes[i] == B) {
      levels[i] = base;
      reset(i);
    }
  reset(to);
}

std::vector<uint32_t> visualOrder(const std::vector<uint8_t>& levels) {
  std::vector<uint32_t> order(levels.size());
  for (size_t i = 0; i < order.size(); i++) order[i] = static_cast<uint32_t>(i);
  if (levels.empty()) return order;
  uint8_t highest = *std::max_element(levels.begin(), levels.end());
  uint8_t lowestOdd = 255;
  for (uint8_t l : levels)
    if (l & 1) lowestOdd = std::min(lowestOdd, l);
  // From the highest level down to the lowest odd one, every run at that level or higher is reversed.
  for (int level = highest; level >= lowestOdd && level > 0; level--)
    for (size_t i = 0; i < order.size();) {
      if (levels[order[i]] < level) {
        i++;
        continue;
      }
      size_t j = i;
      while (j < order.size() && levels[order[j]] >= level) j++;
      std::reverse(order.begin() + static_cast<long>(i), order.begin() + static_cast<long>(j));
      i = j;
    }
  return order;
}

}  // namespace eng::text
