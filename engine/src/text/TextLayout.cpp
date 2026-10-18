#include "text/TextLayout.h"

#include <hb.h>

#include <algorithm>
#include <cmath>
#include <unordered_map>

#include "text/Bidi.h"
#include "text/Unicode.h"

namespace eng::text {

namespace {

// Metrics used while a style has no font at all yet (not even Inter).
constexpr double kStandInAscent = 0.96875, kStandInDescent = 0.2412, kStandInLineHeight = 1.2099;
// Lists: each indentation level indents by this many ems; a marker sits this far before its item's text.
constexpr double kListIndentEm = 1.5, kMarkerGapEm = 0.5;
// Positions as Figma's (kFigmaUnitsPerEm): shaped in font units, a glyph's advance and its adjustment (kerning) are
// each rounded to 1/1024 em from the font's own numbers (396 units of 1000 -> 406 = round(405.504); HarfBuzz at a
// 1024 scale truncates its multiplier and says 405, and a 65536 scale rounds 618.496 up through 618.5). Pen positions
// are then multiples of size / 1024 (3/256 px at 12 px) as Figma's are, and widths and line fits are exact: a line
// fits when it isn't wider than the box (the epsilon only absorbs a float's rounding).
constexpr double kFitSlack = 1e-6;

// A shaped glyph's position in px, Figma's way.
struct FigmaPos {
  double dx, dy, advance;
};
FigmaPos figmaPos(const Font& font, const hb_glyph_info_t& info, const hb_glyph_position_t& pos, double fontSize) {
  double upem = font.unitsPerEm();
  auto em1024 = [&](double units) { return std::round(units * kFigmaUnitsPerEm / upem); };
  double own = hb_font_get_glyph_h_advance(font.hbUnits(), info.codepoint);
  double k = fontSize / kFigmaUnitsPerEm;
  return {em1024(pos.x_offset) * k, -em1024(pos.y_offset) * k, (em1024(own) + em1024(pos.x_advance - own)) * k};
}

double letterSpacingPx(const ResolvedStyle& s) {
  // RAW letter spacing (legacy files: {1, RAW}, {0.5, RAW}) adds nothing in Figma's stored layouts.
  if (s.letterSpacing.units == NumberUnits::RAW) return 0;
  return s.letterSpacing.units == NumberUnits::PIXELS ? s.letterSpacing.value : s.letterSpacing.value / 100.0 * s.fontSize;
}

double ascentPx(const ResolvedStyle& s) { return (s.font ? s.font->ascent : kStandInAscent) * s.fontSize; }
double descentPx(const ResolvedStyle& s) { return (s.font ? s.font->descent : kStandInDescent) * s.fontSize; }

// A shaped cluster: the glyphs of UTF-16 units [start, end).
struct Cluster {
  uint32_t start = 0, end = 0;
  uint32_t firstGlyph = 0, glyphCount = 0;  // into the paragraph's glyphs
  double width = 0;                          // advance, letter spacing included
  double spacing = 0;                        // the letter spacing in `width`
  uint16_t style = 0;
  bool space = false;     // whitespace (hangs at a line's end)
  char breakAfter = BREAK_NO;
  uint8_t level = 0;      // bidi embedding level (odd: right to left); its glyphs are in visual order
};

struct Glyph {
  Font* font;
  uint32_t glyph;
  double dx, dy;  // offset from the pen
  double advance;
  uint32_t cluster;
  uint16_t style;
};

hb_script_t scriptOf(uint32_t cp) { return hb_unicode_script(hb_unicode_funcs_get_default(), cp); }

bool joinsPrevious(uint32_t cp) {
  // Marks, joiners and variation selectors stay in their base character's run.
  hb_unicode_general_category_t cat = hb_unicode_general_category(hb_unicode_funcs_get_default(), cp);
  return cat == HB_UNICODE_GENERAL_CATEGORY_NON_SPACING_MARK || cat == HB_UNICODE_GENERAL_CATEGORY_SPACING_MARK ||
         cat == HB_UNICODE_GENERAL_CATEGORY_ENCLOSING_MARK || cat == HB_UNICODE_GENERAL_CATEGORY_FORMAT ||
         (cp >= 0xFE00 && cp <= 0xFE0F) || (cp >= 0xE0100 && cp <= 0xE01EF);
}

// Each style's OpenType features as HarfBuzz takes them.
using FeatureSets = std::vector<std::vector<hb_feature_t>>;

FeatureSets featureSets(const TextLayout& L) {
  FeatureSets out;
  out.reserve(L.styles.size());
  for (const ResolvedStyle& s : L.styles) {
    std::vector<hb_feature_t> v;
    for (auto& [tag, on] : s.features.shapingFeatures(s.textCase)) v.push_back({tag, on ? 1u : 0u, HB_FEATURE_GLOBAL_START, HB_FEATURE_GLOBAL_END});
    out.push_back(std::move(v));
  }
  return out;
}

void shapeWith(hb_font_t* font, hb_buffer_t* buf, const std::vector<hb_feature_t>& features) {
  hb_shape(font, buf, features.empty() ? nullptr : features.data(), static_cast<unsigned>(features.size()));
}

// Shapes [from, to) of `display` (a paragraph is [pStart, pEnd), the context) into glyphs and clusters, in logical
// order. `levels`: the paragraph's bidi levels per unit (empty: all left to right); a right-to-left run is shaped
// right to left (HarfBuzz mirrors its brackets), its clusters put back in logical order, each one's glyphs left as
// HarfBuzz placed them.
void shapeParagraph(const std::u16string& display, uint32_t pStart, uint32_t pEnd, const TextLayout& L, const FeatureSets& feats,
                    const std::vector<uint8_t>& levels, std::vector<Glyph>& glyphs, std::vector<Cluster>& clusters) {
  glyphs.clear();
  clusters.clear();
  if (pEnd <= pStart) return;
  FontRegistry& fonts = FontRegistry::get();

  // Itemize: style, bidi level, font (fallback by coverage), script.
  struct Run {
    uint32_t start, end;
    uint16_t style;
    Font* font;
    hb_script_t script;
    uint8_t level;
  };
  std::vector<Run> runs;
  for (uint32_t i = pStart; i < pEnd;) {
    size_t n = 1;
    uint32_t cp = codePointAt(display, i, &n);
    uint16_t style = L.styleOf[i];
    uint8_t level = levels.empty() ? 0 : levels[i - pStart];
    Font* primary = L.styles[style].font;
    Font* font = primary;
    hb_script_t script = scriptOf(cp);
    bool common = script == HB_SCRIPT_COMMON || script == HB_SCRIPT_INHERITED || script == HB_SCRIPT_UNKNOWN;
    if (!runs.empty() && runs.back().style == style && runs.back().level == level && (joinsPrevious(cp) || cp == 0x200D)) {
      font = runs.back().font;
    } else if (primary && !primary->covers(cp) && !isWhitespace(cp) && cp >= 0x20) {
      if (Font* fb = fonts.fallbackFor(cp)) font = fb;
    }
    if (common && !runs.empty()) script = runs.back().script;
    auto vague = [](hb_script_t s) { return s == HB_SCRIPT_COMMON || s == HB_SCRIPT_INHERITED || s == HB_SCRIPT_UNKNOWN; };
    if (!runs.empty() && runs.back().style == style && runs.back().font == font && runs.back().level == level &&
        (runs.back().script == script || common || vague(runs.back().script))) {
      // A run of common characters ("/", digits' punctuation) takes the script that follows it: one run, so the pair
      // kerns ("/s" kerns in fonts that kern it, as Figma lays it out).
      if (vague(runs.back().script)) runs.back().script = script;
      runs.back().end = i + static_cast<uint32_t>(n);
    } else {
      runs.push_back({i, i + static_cast<uint32_t>(n), style, font, script, level});
    }
    i += static_cast<uint32_t>(n);
  }
  // Resolve the leading common run's script from the next run.
  for (size_t r = 0; r + 1 < runs.size(); r++)
    if ((runs[r].script == HB_SCRIPT_COMMON || runs[r].script == HB_SCRIPT_INHERITED || runs[r].script == HB_SCRIPT_UNKNOWN) &&
        runs[r + 1].style == runs[r].style && runs[r + 1].font == runs[r].font && runs[r + 1].level == runs[r].level)
      runs[r].script = runs[r + 1].script;

  hb_buffer_t* buf = hb_buffer_create();
  const uint16_t* paragraph = reinterpret_cast<const uint16_t*>(display.data()) + pStart;
  for (const Run& run : runs) {
    const ResolvedStyle& st = L.styles[run.style];
    size_t firstGlyph = glyphs.size();
    if (!run.font) {
      // No font yet: one empty glyph per character keeps the clusters (and the caret) in place.
      for (uint32_t i = run.start; i < run.end; i++)
        if (!isLowSurrogate(display[i])) glyphs.push_back({nullptr, 0, 0, 0, 0, i, run.style});
    } else {
      hb_buffer_clear_contents(buf);
      hb_buffer_add_utf16(buf, paragraph, static_cast<int>(pEnd - pStart), run.start - pStart, static_cast<int>(run.end - run.start));
      hb_buffer_set_script(buf, run.script);
      const bool rtl = run.level & 1;
      hb_buffer_set_direction(buf, rtl ? HB_DIRECTION_RTL : HB_DIRECTION_LTR);
      hb_buffer_set_language(buf, hb_language_get_default());
      hb_buffer_set_cluster_level(buf, HB_BUFFER_CLUSTER_LEVEL_MONOTONE_CHARACTERS);
      shapeWith(run.font->hbUnits(), buf, feats[run.style]);
      unsigned count = 0;
      hb_glyph_info_t* info = hb_buffer_get_glyph_infos(buf, &count);
      hb_glyph_position_t* pos = hb_buffer_get_glyph_positions(buf, &count);
      for (unsigned g = 0; g < count; g++) {
        FigmaPos fp = figmaPos(*run.font, info[g], pos[g], st.fontSize);
        glyphs.push_back({run.font, info[g].codepoint, fp.dx, fp.dy, fp.advance, info[g].cluster + pStart, run.style});
      }
      if (rtl) {
        // HarfBuzz gives a right-to-left run in visual order (clusters descending): its clusters go back to logical
        // order, each cluster's glyphs kept in their visual order.
        auto first = glyphs.begin() + static_cast<long>(firstGlyph);
        std::reverse(first, glyphs.end());
        for (auto g = first; g != glyphs.end();) {
          auto h = g;
          while (h != glyphs.end() && h->cluster == g->cluster) ++h;
          std::reverse(g, h);
          g = h;
        }
      }
    }
    // Clusters of this run (cluster values never decrease in logical order).
    for (size_t g = firstGlyph; g < glyphs.size();) {
      size_t h = g;
      double width = 0;
      while (h < glyphs.size() && glyphs[h].cluster == glyphs[g].cluster) width += glyphs[h++].advance;
      Cluster c;
      c.start = glyphs[g].cluster;
      c.end = h < glyphs.size() ? glyphs[h].cluster : run.end;
      c.firstGlyph = static_cast<uint32_t>(g);
      c.glyphCount = static_cast<uint32_t>(h - g);
      c.style = run.style;
      c.level = run.level;
      c.spacing = letterSpacingPx(st);
      c.width = width + c.spacing;
      c.space = isWhitespace(codePointAt(display, c.start));
      clusters.push_back(c);
      g = h;
    }
  }
  hb_buffer_destroy(buf);
}

// Shapes a short string ("…", a list marker) in a style's font: its glyphs (offsets from their pen) and total advance.
double shapeString(const std::u16string& s, const ResolvedStyle& st, uint16_t style, const std::vector<hb_feature_t>& feats,
                   std::vector<Glyph>& out) {
  out.clear();
  if (!st.font || s.empty()) return 0;
  hb_buffer_t* buf = hb_buffer_create();
  hb_buffer_add_utf16(buf, reinterpret_cast<const uint16_t*>(s.data()), static_cast<int>(s.size()), 0, static_cast<int>(s.size()));
  hb_buffer_guess_segment_properties(buf);
  shapeWith(st.font->hbUnits(), buf, feats);
  unsigned count = 0;
  hb_glyph_info_t* info = hb_buffer_get_glyph_infos(buf, &count);
  hb_glyph_position_t* pos = hb_buffer_get_glyph_positions(buf, &count);
  double pen = 0;
  for (unsigned g = 0; g < count; g++) {
    FigmaPos fp = figmaPos(*st.font, info[g], pos[g], st.fontSize);
    out.push_back({st.font, info[g].codepoint, fp.dx, fp.dy, fp.advance, 0, style});
    pen += out.back().advance;
  }
  hb_buffer_destroy(buf);
  return pen;
}

// Where a paragraph's lines break: [from, to) cluster ranges.
struct Span {
  size_t from, to;
};

// Greedy line filling at the break opportunities (a word wider than the line breaks at clusters; U+2028 always
// breaks). `limit(first)`: the width available to the paragraph's first / other lines.
template <typename Limit>
std::vector<Span> fillLines(const std::vector<Cluster>& pc, uint32_t pEnd, bool wrap, Limit limit) {
  std::vector<Span> out;
  size_t i0 = 0;
  double x = 0;
  long lastBreak = -1;
  for (size_t k = 0; k < pc.size(); k++) {
    const Cluster& c = pc[k];
    double lim = limit(out.empty());
    if (wrap && k > i0 && !c.space && x + c.width - c.spacing > lim + kFitSlack) {
      size_t cut = lastBreak >= static_cast<long>(i0) ? static_cast<size_t>(lastBreak) + 1 : k;
      out.push_back({i0, cut});
      i0 = cut;
      x = 0;
      for (size_t j = i0; j < k; j++) x += pc[j].width;
      lastBreak = -1;
    }
    x += c.width;
    if (c.breakAfter == BREAK_ALLOW) lastBreak = static_cast<long>(k);
    if (c.breakAfter == BREAK_MUST && c.end < pEnd) {
      // U+2028: a line break inside the paragraph.
      out.push_back({i0, k + 1});
      i0 = k + 1;
      x = 0;
      lastBreak = -1;
    }
  }
  out.push_back({i0, pc.size()});
  return out;
}

// The number of words (runs of non-space clusters) in [from, to).
size_t wordsIn(const std::vector<Cluster>& pc, Span s) {
  size_t words = 0;
  bool in = false;
  for (size_t k = s.from; k < s.to; k++) {
    if (!pc[k].space && !in) words++;
    in = !pc[k].space;
  }
  return words;
}

}  // namespace

void followOpticalSize(const Font& font, double fontSize, std::vector<std::pair<uint32_t, float>>& axes) {
  float lo = 0, hi = 0;
  if (!font.opticalSizeRange(lo, hi)) return;
  constexpr uint32_t kOpsz = HB_TAG('o', 'p', 's', 'z');
  float v = static_cast<float>(std::clamp(fontSize, static_cast<double>(lo), static_cast<double>(hi)));
  for (auto& a : axes)
    if (a.first == kOpsz) {
      a.second = v;
      return;
    }
  axes.push_back({kOpsz, v});
}

const std::vector<Paint>* decorationFills(const TextLayout& L, const Decoration& d) {
  const ResolvedStyle& s = L.styles[d.style];
  return s.features.hasDecorationFills ? &s.features.decorationFills : s.fills;
}

double autoLineHeight(const Font* font, double fontSize, bool whole) {
  double v = (font ? font->lineHeightEm() : kStandInLineHeight) * fontSize;
  return whole ? std::round(v) : v;
}

bool wholePixelLineHeights(const TextFeatures& f) { return f.userLayoutVersion != 0; }

double lineHeightPx(const ResolvedStyle& s) {
  // textUserLayoutVersion ≥ 1 (and texts without one) round a multiple to whole pixels; an older text (version 0)
  // keeps its fraction (Atlas 06 §2.4, figma_app 387610: Math.round unless the version is 0).
  const bool whole = wholePixelLineHeights(s.features);
  auto px = [&](double v) { return whole ? std::round(v) : v; };
  switch (s.lineHeight.units) {
    case NumberUnits::PIXELS: return s.lineHeight.value;
    // A multiple of the font size is rounded to whole pixels (Figma's stored layouts): 1.3 × 15 = 19.4999… → 19,
    // 1.5 × 13 = 19.5 → 20, 1.4286 × 12 → 17 (every RAW line height a large private file's derivedTextData holds).
    // (The value is the file's float: 1.3 is 1.29999995.)
    case NumberUnits::RAW: return px(s.lineHeight.value * s.fontSize);
    case NumberUnits::PERCENT:
    default:
      // Auto is {100, PERCENT}, within 0.1 (387610).
      if (std::fabs(s.lineHeight.value - 100) < 0.1) return autoLineHeight(s.font, s.fontSize, whole);
      return px(s.lineHeight.value / 100.0 * (s.font ? s.font->lineHeightEm() : kStandInLineHeight) * s.fontSize);
  }
}

LayoutOptions optionsFor(const NodeProps& p, double widthOverride) {
  LayoutOptions o;
  switch (p.text().textAutoResize) {
    case TextAutoResize::WIDTH_AND_HEIGHT: break;
    case TextAutoResize::HEIGHT: o.width = p.size.x; break;
    case TextAutoResize::NONE:
    default:
      o.width = p.size.x;
      o.height = p.size.y;
      break;
  }
  if (widthOverride >= 0) o.width = widthOverride;
  return o;
}

void resolveStyles(const NodeProps& p, std::vector<ResolvedStyle>& styles, std::unordered_map<uint32_t, uint16_t>& byId) {
  FontRegistry& fonts = FontRegistry::get();
  ResolvedStyle base;
  base.fontName = p.text().fontName;
  base.fontSize = p.text().fontSize;
  base.lineHeight = p.text().lineHeight;
  base.letterSpacing = p.text().letterSpacing;
  base.textCase = p.text().textCase;
  base.textDecoration = p.text().textDecoration;
  base.fills = &p.fillPaints;
  base.features = nodeFeatures(p.extra);
  styles.push_back(base);
  byId[0] = 0;
  for (const TextStyle& o : p.text().textData.styleOverrideTable) {
    if (o.styleID == 0 || byId.count(o.styleID) || styles.size() >= 0xFFFF) continue;
    ResolvedStyle s = base;
    s.styleID = o.styleID;
    if (o.mask & R_FONT_NAME) s.fontName = o.fontName;
    if (o.mask & R_FONT_SIZE) s.fontSize = o.fontSize;
    if (o.mask & R_LINE_HEIGHT) s.lineHeight = o.lineHeight;
    if (o.mask & R_LETTER_SPACING) s.letterSpacing = o.letterSpacing;
    if (o.mask & R_TEXT_CASE) s.textCase = o.textCase;
    if (o.mask & R_TEXT_DECORATION) s.textDecoration = o.textDecoration;
    if (o.mask & R_FILLS) s.fills = &o.fillPaints;
    if (!o.extra.empty()) s.features = runFeatures(base.features, o.extra);
    byId[o.styleID] = static_cast<uint16_t>(styles.size());
    styles.push_back(std::move(s));
  }
  for (ResolvedStyle& s : styles) {
    FontRegistry::State state;
    s.font = fonts.find(s.fontName, &state);
    if (!s.font) {
      s.missing = state == FontRegistry::State::Missing;
      s.pending = !s.missing;
      // A missing font keeps its weight and slant (Inter at the nearest one); a font still loading waits in Regular.
      s.font = s.missing ? fonts.substituteFor(s.fontName) : fonts.defaultFont();
    } else {
      if (s.fontSize <= 0) s.fontSize = 1;
      std::vector<std::pair<uint32_t, float>> axes = s.features.variations;
      if (!s.features.detachOpticalSize) followOpticalSize(*s.font, s.fontSize, axes);
      if (!axes.empty()) s.font = s.font->withVariations(axes);
    }
    if (s.fontSize <= 0) s.fontSize = 1;
  }
}

std::unique_ptr<TextLayout> layoutText(const NodeProps& p, const LayoutOptions& opt) {
  auto out = std::make_unique<TextLayout>();
  TextLayout& L = *out;
  L.text = utf8To16(p.text().textData.characters);
  const uint32_t n = static_cast<uint32_t>(L.text.size());

  std::unordered_map<uint32_t, uint16_t> byId;
  resolveStyles(p, L.styles, byId);
  for (const ResolvedStyle& s : L.styles) {
    L.missingFont |= s.missing;
    L.pendingFont |= s.pending;
  }
  const TextFeatures& nodeF = L.styles[0].features;
  L.styleOf.assign(n, 0);
  const auto& ids = p.text().textData.characterStyleIDs;
  for (uint32_t i = 0; i < n && i < ids.size(); i++)
    if (ids[i]) {
      auto it = byId.find(ids[i]);
      if (it != byId.end()) L.styleOf[i] = it->second;
    }
  const FeatureSets feats = featureSets(L);

  // textCase, run by run (small caps are a feature, shaped).
  std::u16string display = L.text;
  for (uint32_t i = 0; i < n;) {
    uint32_t j = i;
    while (j < n && L.styleOf[j] == L.styleOf[i]) j++;
    TextCase tc = L.styles[L.styleOf[i]].textCase;
    if (tc == TextCase::UPPER || tc == TextCase::LOWER || tc == TextCase::TITLE) {
      std::u16string mapped = applyCase(std::u16string_view(L.text).substr(i, j - i), tc);
      std::copy(mapped.begin(), mapped.end(), display.begin() + i);
    }
    i = j;
  }

  std::vector<char> breaks;
  lineBreaks(display, breaks);
  for (uint32_t i = 0; i < n; i++)
    if (display[i] == 0x2028) breaks[i] = BREAK_MUST;

  const bool wrap = opt.width >= 0;
  const double maxWidth = wrap ? opt.width : 0;
  L.caretXs.assign(n + 1, 0);

  // Paragraphs' list data (TextData.lines, one per paragraph).
  const auto& lineData = p.text().textData.lines;
  auto paragraphInfo = [&](size_t index) { return index < lineData.size() ? readLine(lineData[index]) : LineInfo{}; };

  struct LineDraft {
    std::vector<Cluster> clusters;
    std::vector<Glyph> glyphs;
    uint32_t start, end;
    bool paragraphStart, paragraphEnd, hardEnd;
    uint16_t emptyStyle;
    size_t paragraph;
    double startX;  // where its content starts (indents)
    double alignWidth = -1;  // a truncated line: the width alignment places (its content before "…")
    bool bidi = false;       // some cluster is right to left, or the paragraph is: placed in visual order
  };
  std::vector<LineDraft> drafts;
  struct Para {
    LineInfo info;
    double contentX = 0;  // a list item's text (every line)
    bool list = false;
    uint8_t level = 0;    // bidi paragraph level: 1 right to left
  };
  std::vector<Para> paras;

  std::vector<Glyph> pg;
  std::vector<Cluster> pc;
  std::vector<uint8_t> levels, lineLv;
  std::vector<BidiClass> classes;
  // Bidi (UAX #9) per paragraph, unless the text is older than it (textBidiVersion 0: left to right only).
  const bool bidi = nodeF.bidiVersion != 0;
  uint32_t pStart = 0;
  while (true) {
    uint32_t pEnd = pStart;
    while (pEnd < n && L.text[pEnd] != u'\n') pEnd++;
    bool last = pEnd >= n;
    Para para;
    para.info = paragraphInfo(paras.size());
    // The paragraph's direction: its own (Text direction), else its first strong character's (P2 / P3).
    std::u16string_view ptext = std::u16string_view(display).substr(pStart, pEnd - pStart);
    levels.clear();
    if (bidi) {
      para.level = para.info.direction == 2 ? 1 : para.info.direction == 1 ? 0 : paragraphLevel(ptext);
      if (para.level == 1 || hasRtl(ptext)) resolveLevels(ptext, para.level, levels, classes);
    }
    shapeParagraph(display, pStart, pEnd, L, feats, levels, pg, pc);
    for (Cluster& c : pc) c.breakAfter = c.end > 0 && c.end - 1 < n ? breaks[c.end - 1] : BREAK_NO;
    uint16_t emptyStyle = pStart < n ? L.styleOf[pStart] : (pStart > 0 ? L.styleOf[pStart - 1] : 0);

    para.list = para.info.type != LineType::PLAIN;
    int level = std::max(para.info.indentationLevel, para.list ? 1 : 0);
    double unit = std::round(L.styles[emptyStyle].fontSize * kListIndentEm);
    if (level > 0) para.contentX = (level - ((para.list && nodeF.hangingList) ? 1 : 0)) * unit;
    double firstIndent = para.contentX + (para.list ? 0 : p.text().paragraphIndent);
    auto limit = [&](bool first) { return maxWidth - (first ? firstIndent : para.contentX); };
    std::vector<Span> spans = fillLines(pc, pEnd, wrap, limit);
    // Wrap style: Balance evens the lines out (the narrowest width that keeps their number); Pretty avoids a
    // single word on the last line.
    if (wrap && spans.size() > 1 && nodeF.wrapStyle != WrapStyle::AUTO) {
      size_t count = spans.size();
      if (nodeF.wrapStyle == WrapStyle::BALANCE) {
        double lo = 0, hi = maxWidth;
        for (int it = 0; it < 18; it++) {
          double mid = (lo + hi) / 2;
          auto narrower = [&](bool first) { return mid - (first ? firstIndent : para.contentX); };
          if (fillLines(pc, pEnd, wrap, narrower).size() == count) hi = mid;
          else lo = mid;
        }
        auto best = [&](bool first) { return hi - (first ? firstIndent : para.contentX); };
        spans = fillLines(pc, pEnd, wrap, best);
      } else if (wordsIn(pc, spans.back()) < 2) {
        for (int k = 1; k <= 25; k++) {
          double w = maxWidth * (1 - 0.02 * k);
          auto narrower = [&](bool first) { return w - (first ? firstIndent : para.contentX); };
          std::vector<Span> s = fillLines(pc, pEnd, wrap, narrower);
          if (s.size() != count) break;
          if (wordsIn(pc, s.back()) >= 2) {
            spans = std::move(s);
            break;
          }
        }
      }
    }
    for (size_t si = 0; si < spans.size(); si++) {
      size_t from = spans[si].from, to = spans[si].to;
      bool paragraphStart = si == 0, paragraphEnd = si + 1 == spans.size();
      LineDraft d;
      d.paragraphStart = paragraphStart;
      d.paragraphEnd = paragraphEnd;
      d.hardEnd = paragraphEnd && !last;
      d.paragraph = paras.size();
      d.start = from < to ? pc[from].start : (from < pc.size() ? pc[from].start : pEnd);
      d.end = to > from ? pc[to - 1].end : d.start;
      if (paragraphEnd) d.end = last ? pEnd : pEnd + 1;  // the "\n" belongs to the line it ends
      if (from == to && paragraphStart) d.start = pStart;
      d.emptyStyle = from < to ? pc[from].style : emptyStyle;
      d.startX = paragraphStart ? firstIndent : para.contentX;
      // L1: the line's trailing whitespace (and separators) back to the paragraph's level.
      if (!levels.empty()) {
        lineLv = levels;
        size_t a = from < to ? pc[from].start - pStart : 0, b = to > from ? pc[to - 1].end - pStart : a;
        lineLevels(classes, para.level, a, b, lineLv);
      }
      d.bidi = para.level == 1;
      for (size_t k = from; k < to; k++) {
        Cluster c = pc[k];
        c.firstGlyph = static_cast<uint32_t>(d.glyphs.size());
        if (!levels.empty()) c.level = lineLv[c.start - pStart];
        d.bidi |= (c.level & 1) != 0;
        for (uint32_t g = 0; g < pc[k].glyphCount; g++) d.glyphs.push_back(pg[pc[k].firstGlyph + g]);
        d.clusters.push_back(c);
      }
      drafts.push_back(std::move(d));
    }
    paras.push_back(para);
    if (last) break;
    pStart = pEnd + 1;
  }

  // Lists: each item's marker (counters per level; a list restarts after a non-list paragraph or at
  // isFirstLineOfList; listStartOffset shifts its first number).
  std::vector<std::u16string> markers(paras.size());
  {
    std::vector<int32_t> counters(8, 0);
    for (size_t i = 0; i < paras.size(); i++) {
      const Para& pa = paras[i];
      if (!pa.list) {
        std::fill(counters.begin(), counters.end(), 0);
        continue;
      }
      size_t lvl = static_cast<size_t>(std::clamp(pa.info.indentationLevel, 1, 7));
      if (pa.info.isFirstLineOfList) std::fill(counters.begin(), counters.end(), 0);
      for (size_t k = lvl + 1; k < counters.size(); k++) counters[k] = 0;
      if (counters[lvl] == 0) counters[lvl] = pa.info.listStartOffset;
      counters[lvl]++;
      markers[i] = listMarker(pa.info.type, static_cast<int32_t>(lvl), counters[lvl]);
    }
  }

  // Truncation (ENDING): by maxLines, or by the box's height for fixed boxes.
  size_t keep = drafts.size();
  auto spacingBefore = [&](size_t li) {
    if (li == 0 || !drafts[li - 1].paragraphEnd) return 0.0;
    bool lists = paras[drafts[li - 1].paragraph].list && paras[drafts[li].paragraph].list;
    return lists ? nodeF.listSpacing : p.text().paragraphSpacing;
  };
  if (p.text().textTruncation == TextTruncation::ENDING) {
    if (p.text().maxLines > 0) keep = std::min(keep, static_cast<size_t>(p.text().maxLines));
    if (opt.height >= 0 && p.text().textAutoResize == TextAutoResize::NONE) {
      double y = 0;
      size_t fit = 0;
      for (size_t i = 0; i < keep; i++) {
        const LineDraft& d = drafts[i];
        double lh = 0;
        if (d.clusters.empty()) lh = lineHeightPx(L.styles[d.emptyStyle]);
        for (auto& c : d.clusters) lh = std::max(lh, lineHeightPx(L.styles[c.style]));
        y += spacingBefore(i);
        if (y + lh > opt.height + 1e-3 && i > 0) break;
        y += lh;
        fit = i + 1;
      }
      keep = std::max<size_t>(1, std::min(keep, fit));
    }
  }
  if (keep < drafts.size()) {
    L.truncated = true;
    LineDraft& d = drafts[keep - 1];
    // The last visible line takes the rest of its paragraph and is cut at a character, not a word, where "…" fits
    // (Figma: "Hello World" too wide for one line → "Hello Wo…", not "Hello…").
    for (size_t k = keep; k < drafts.size() && !drafts[k - 1].paragraphEnd; k++)
      for (Cluster c : drafts[k].clusters) {
        uint32_t g0 = c.firstGlyph;
        c.firstGlyph = static_cast<uint32_t>(d.glyphs.size());
        for (uint32_t g = 0; g < c.glyphCount; g++) d.glyphs.push_back(drafts[k].glyphs[g0 + g]);
        d.clusters.push_back(c);
      }
    uint16_t st = d.clusters.empty() ? d.emptyStyle : d.clusters.back().style;
    std::vector<Glyph> dotsGlyphs;
    double dotsWidth = shapeString(u"…", L.styles[st], st, feats[st], dotsGlyphs);
    if (!dotsGlyphs.empty()) {
      double limit = wrap ? maxWidth - d.startX : 1e300;
      // The line as it breaks at characters (trailing spaces hang): what alignment places, before "…" replaces its
      // end (Figma keeps the glyphs where that line put them: centred as "Hello " broke, then "Hel…").
      {
        double cw = 0, content = 0;
        size_t fit = 0;
        for (size_t k = 0; k < d.clusters.size(); k++) {
          const Cluster& c = d.clusters[k];
          if (!c.space && k > 0 && cw + c.width - c.spacing > limit + kFitSlack) break;
          cw += c.width;
          if (!c.space) content = cw - c.spacing;
          fit = k + 1;
        }
        if (fit < d.clusters.size()) {
          d.glyphs.resize(d.clusters[fit].firstGlyph);
          d.clusters.resize(fit);
        }
        d.alignWidth = content;
      }
      double w = 0;
      for (auto& c : d.clusters) w += c.width;
      while (!d.clusters.empty() && (w + dotsWidth > limit + kFitSlack || d.clusters.back().space)) {
        w -= d.clusters.back().width;
        d.glyphs.resize(d.clusters.back().firstGlyph);
        d.clusters.pop_back();
      }
      uint32_t at = d.clusters.empty() ? d.start : d.clusters.back().end;
      L.truncationStart = at;
      Cluster c;
      c.start = at;
      c.end = at;
      c.firstGlyph = static_cast<uint32_t>(d.glyphs.size());
      c.glyphCount = static_cast<uint32_t>(dotsGlyphs.size());
      c.width = dotsWidth;
      c.style = st;
      c.level = paras[d.paragraph].level;
      for (Glyph g : dotsGlyphs) {
        g.cluster = at;
        g.style = st;
        d.glyphs.push_back(g);
      }
      d.clusters.push_back(c);
    }
    d.end = drafts.back().end;  // the hidden text belongs to the last visible line (for the caret)
    d.paragraphEnd = true;
    d.hardEnd = false;
    drafts.resize(keep);
  }

  // Lines: metrics, widths, vertical placement.
  double y = 0, widest = 0;
  for (size_t li = 0; li < drafts.size(); li++) {
    LineDraft& d = drafts[li];
    LaidLine line;
    line.start = d.start;
    line.end = d.end;
    line.paragraphEnd = d.paragraphEnd;
    line.hardEnd = d.hardEnd;
    double asc = 0, desc = 0, lh = 0;
    auto take = [&](uint16_t s) {
      asc = std::max(asc, ascentPx(L.styles[s]));
      desc = std::max(desc, descentPx(L.styles[s]));
      lh = std::max(lh, lineHeightPx(L.styles[s]));
    };
    if (d.clusters.empty()) take(d.emptyStyle);
    for (auto& c : d.clusters) take(c.style);
    // Width: trailing whitespace hangs; no letter spacing after the last character.
    size_t contentEnd = d.clusters.size();
    while (contentEnd > 0 && d.clusters[contentEnd - 1].space) contentEnd--;
    double w = 0;
    for (size_t k = 0; k < contentEnd; k++) w += d.clusters[k].width;
    if (contentEnd > 0) w -= d.clusters[contentEnd - 1].spacing;
    y += spacingBefore(li);
    line.top = y;
    line.height = lh;
    line.ascent = asc;
    line.descent = desc;
    line.baseline = y + (lh - (asc + desc)) / 2 + asc;
    line.width = w;
    widest = std::max(widest, w + d.startX);
    y += lh;
    L.lines.push_back(line);
  }
  // Vertical trim (leadingTrim CAP_HEIGHT): the box runs from the first line's cap height to the last line's baseline.
  if (nodeF.leadingTrim == LeadingTrim::CAP_HEIGHT && !L.lines.empty()) {
    const LineDraft& d0 = drafts.front();
    double cap = 0;
    auto capOf = [&](uint16_t s) { cap = std::max(cap, (L.styles[s].font ? L.styles[s].font->capHeight : 0.7) * L.styles[s].fontSize); };
    if (d0.clusters.empty()) capOf(d0.emptyStyle);
    for (auto& c : d0.clusters) capOf(c.style);
    double top = L.lines.front().baseline - cap;
    for (LaidLine& l : L.lines) {
      l.top -= top;
      l.baseline -= top;
    }
    y = L.lines.back().baseline;
  }
  // Auto width: Figma's box is the widest line rounded up to whole pixels (layoutSize.x of every auto-width text in a
  // large private file is ⌈its widest baseline⌉); alignment uses that box. The widths are sums of 1/1024 em steps, so
  // a whole-pixel width stays whole (the epsilon only absorbs a float's rounding).
  if (!wrap) widest = std::ceil(widest - kFitSlack);
  L.size = {widest, y};
  L.boxWidth = wrap ? maxWidth : widest;
  if (opt.height >= 0 && p.text().textAutoResize == TextAutoResize::NONE) {
    double f = p.text().textAlignVertical == TextAlignVertical::CENTER ? 0.5 : p.text().textAlignVertical == TextAlignVertical::BOTTOM ? 1 : 0;
    L.offsetY = (opt.height - L.size.y) * f;
  }

  // Horizontal placement, glyphs, carets, markers, decorations, links.
  bool anyInk = false;
  auto addInk = [&](const LaidGlyph& g) {
    if (!g.font || !g.glyph) return;
    const GlyphOutline& o = g.font->outline(g.glyph);
    if (o.empty()) return;
    Rect r{g.x + o.bounds[0] * g.size, g.y + o.bounds[1] * g.size, (o.bounds[2] - o.bounds[0]) * g.size, (o.bounds[3] - o.bounds[1]) * g.size};
    L.inkBounds = anyInk ? L.inkBounds.united(r) : r;
    anyInk = true;
  };
  uint32_t linkId = 0;
  const HyperlinkData* prevLink = nullptr;
  // A cluster as placed: its index on the line and its left / right x (letter spacing and justification included).
  struct Placed {
    size_t k;
    double x0, x1;
  };
  std::vector<Placed> vis;
  std::vector<uint8_t> clusterLevels;
  for (size_t li = 0; li < drafts.size(); li++) {
    LineDraft& d = drafts[li];
    LaidLine& line = L.lines[li];
    line.top += L.offsetY;
    line.baseline += L.offsetY;
    const bool rtl = paras[d.paragraph].level == 1;
    // Indents (a list's levels, the first line's paragraph indent) are taken from the paragraph's start side: the
    // right of a right-to-left one, whose markers then sit in that indent.
    double indent = rtl ? 0 : d.startX;
    double free = L.boxWidth - d.startX - (d.alignWidth >= 0 ? d.alignWidth : line.width);
    double x0 = indent, extraPerSpace = 0;
    switch (p.text().textAlignHorizontal) {
      case TextAlignHorizontal::CENTER: x0 += free / 2; break;
      case TextAlignHorizontal::RIGHT: x0 += free; break;
      case TextAlignHorizontal::JUSTIFIED: {
        if (!d.paragraphEnd && free > 0) {
          size_t contentEnd = d.clusters.size();
          while (contentEnd > 0 && d.clusters[contentEnd - 1].space) contentEnd--;
          int spaces = 0;
          for (size_t k = 0; k < contentEnd; k++) spaces += d.clusters[k].space ? 1 : 0;
          if (spaces > 0) extraPerSpace = free / spaces;
        }
        break;
      }
      default: break;
    }
    if (p.text().textAlignHorizontal == TextAlignHorizontal::JUSTIFIED && extraPerSpace > 0) line.width = L.boxWidth - d.startX;
    line.x = x0;
    line.firstGlyph = static_cast<uint32_t>(L.glyphs.size());
    size_t contentEnd = d.clusters.size();
    while (contentEnd > 0 && d.clusters[contentEnd - 1].space) contentEnd--;
    // A list item's marker, before its first line (after it, on the right, in a right-to-left paragraph).
    if (d.paragraphStart && !markers[d.paragraph].empty()) {
      uint16_t ms = d.clusters.empty() ? d.emptyStyle : d.clusters.front().style;
      std::vector<Glyph> mg;
      double mw = shapeString(markers[d.paragraph], L.styles[ms], ms, feats[ms], mg);
      double gap = std::round(L.styles[ms].fontSize * kMarkerGapEm);
      double mx = rtl ? x0 + line.width + gap : x0 - gap - mw;
      for (const Glyph& g : mg) {
        LaidGlyph out;
        out.font = g.font;
        out.glyph = g.glyph;
        out.x = static_cast<float>(mx + g.dx);
        mx += g.advance;
        out.y = static_cast<float>(line.baseline + g.dy);
        out.size = static_cast<float>(L.styles[ms].fontSize);
        out.advance = static_cast<float>(g.advance);
        out.cluster = line.start;
        out.style = ms;
        out.marker = true;
        addInk(out);
        L.glyphs.push_back(out);
      }
    }
    // The clusters in visual order (L2). A right-to-left paragraph's trailing spaces end up on the left: they hang
    // there, as they hang on the right of a left-to-right one.
    std::vector<uint32_t> order;
    if (d.bidi) {
      clusterLevels.resize(d.clusters.size());
      for (size_t k = 0; k < d.clusters.size(); k++) clusterLevels[k] = d.clusters[k].level;
      order = visualOrder(clusterLevels);
    }
    double pen = x0;
    if (rtl)
      for (size_t k = contentEnd; k < d.clusters.size(); k++) pen -= d.clusters[k].width + (d.clusters[k].space ? extraPerSpace : 0);
    const double lineLeft = pen;
    vis.clear();
    for (size_t m = 0; m < d.clusters.size(); m++) {
      size_t k = d.bidi ? order[m] : m;
      Cluster& c = d.clusters[k];
      double startX = pen;
      for (uint32_t g = 0; g < c.glyphCount; g++) {
        const Glyph& gl = d.glyphs[c.firstGlyph + g];
        LaidGlyph out;
        out.font = gl.font;
        out.glyph = gl.glyph;
        out.x = static_cast<float>(pen + gl.dx);
        out.y = static_cast<float>(line.baseline + gl.dy);
        out.size = static_cast<float>(L.styles[gl.style].fontSize);
        out.advance = static_cast<float>(gl.advance);
        out.cluster = gl.cluster;
        out.style = gl.style;
        pen += gl.advance;
        addInk(out);
        L.glyphs.push_back(out);
      }
      pen += c.spacing;
      if (c.space) pen += extraPerSpace;
      vis.push_back({k, startX, pen});
      // Carets inside the cluster (ligatures split evenly; from its right edge when it runs right to left).
      uint32_t span = c.end > c.start ? c.end - c.start : 0;
      const bool back = c.level & 1;
      for (uint32_t u = 0; u < span && c.start + u <= n; u++)
        L.caretXs[c.start + u] = back ? pen - (pen - startX) * u / static_cast<double>(span) : startX + (pen - startX) * u / static_cast<double>(span);
    }
    line.glyphCount = static_cast<uint32_t>(L.glyphs.size()) - line.firstGlyph;
    // After the line's last character: its right end, or its left end in a right-to-left paragraph.
    line.caretEnd = rtl ? lineLeft : pen;
    line.rtl = rtl;
    if (d.clusters.empty()) line.caretEnd = x0;
    if (d.bidi) {
      line.firstBox = static_cast<uint32_t>(L.boxes.size());
      for (const Placed& v : vis) L.boxes.push_back({d.clusters[v.k].start, d.clusters[v.k].end, v.x0, v.x1, (d.clusters[v.k].level & 1) != 0});
      line.boxCount = static_cast<uint32_t>(vis.size());
    }
    // Positions without a cluster (the "\n", the end of the text, an empty line).
    uint32_t tail = d.clusters.empty() ? line.start : d.clusters.back().end;
    for (uint32_t u = tail; u < line.end && u <= n; u++) L.caretXs[u] = line.caretEnd;
    if (li + 1 == drafts.size()) L.caretXs[n] = line.caretEnd;

    // Underline / strikethrough, per visual run of a decorated style (trailing spaces left out; no letter spacing
    // after the last character).
    auto runEnd = [&](size_t m) {
      double to = vis[m].x1;
      if (vis[m].k + 1 == contentEnd) to -= d.clusters[vis[m].k].spacing;
      return to;
    };
    for (size_t m = 0; m < vis.size();) {
      if (vis[m].k >= contentEnd) {
        m++;
        continue;
      }
      uint16_t st = d.clusters[vis[m].k].style;
      size_t j = m;
      while (j < vis.size() && vis[j].k < contentEnd && d.clusters[vis[j].k].style == st) j++;
      const ResolvedStyle& s = L.styles[st];
      if (s.textDecoration != TextDecoration::NONE) {
        double from = vis[m].x0, to = runEnd(j - 1);
        double size = s.fontSize;
        Font* f = s.font;
        const TextFeatures& tf = s.features;
        bool under = s.textDecoration == TextDecoration::UNDERLINE;
        double h = under ? (f ? f->underlineThickness : 0.06) * size : (f ? f->strikeoutThickness : 0.06) * size;
        if (tf.hasDecorationThickness && tf.decorationThickness.units != NumberUnits::RAW)
          h = tf.decorationThickness.units == NumberUnits::PIXELS ? tf.decorationThickness.value : tf.decorationThickness.value / 100 * size;
        double top = under ? line.baseline + (f ? f->underlineOffset : 0.1) * size : line.baseline - (f ? f->strikeoutOffset : 0.3) * size;
        if (under && tf.hasUnderlineOffset && tf.underlineOffset.units != NumberUnits::RAW)
          top = line.baseline + (tf.underlineOffset.units == NumberUnits::PIXELS ? tf.underlineOffset.value : tf.underlineOffset.value / 100 * size);
        h = std::max(h, 0.0);
        double len = std::max(0.0, to - from);
        if (tf.decorationStyle == DecorationStyle::DOTTED && h > 0) {
          // Round dots one thickness wide, a thickness apart.
          for (double x = from; x + h <= from + len + 1e-6; x += 2 * h) L.decorations.push_back({Rect{x, top, h, h}, st, 0, true});
        } else if (tf.decorationStyle == DecorationStyle::WAVY && h > 0) {
          // A sine wave (amplitude 1.5 thickness, wavelength 6 thicknesses, at least 4 px) as short turned segments.
          double wave = std::max(4.0, 6 * h), amp = 1.5 * h, mid = top + h / 2 + amp / 2;
          int steps = std::max(1, static_cast<int>(std::ceil(len / (wave / 8))));
          double dx = len / steps;
          for (int i = 0; i < steps; i++) {
            double x1 = from + i * dx, x2 = x1 + dx;
            double y1 = mid - amp * std::sin(2 * M_PI * (x1 - from) / wave), y2 = mid - amp * std::sin(2 * M_PI * (x2 - from) / wave);
            double seg = std::hypot(x2 - x1, y2 - y1), angle = std::atan2(y2 - y1, x2 - x1);
            // The segment's centre line runs from (x1, y1): offset by half the thickness across it.
            double ox = std::sin(angle) * h / 2, oy = -std::cos(angle) * h / 2;
            L.decorations.push_back({Rect{x1 + ox, y1 + oy, seg + h * 0.25, h}, st, angle, false});
          }
        } else {
          L.decorations.push_back({Rect{from, top, len, h}, st});
        }
      }
      m = j;
    }
    // Links: one box per visual run of a link on this line (Figma's hyperlinkBoxes: the glyphs' extent, ascent to
    // descent).
    for (size_t m = 0; m < vis.size();) {
      if (vis[m].k >= contentEnd) {
        m++;
        continue;
      }
      const HyperlinkData& link = L.styles[d.clusters[vis[m].k].style].features.hyperlink;
      size_t j = m + 1;
      while (j < vis.size() && vis[j].k < contentEnd && L.styles[d.clusters[vis[j].k].style].features.hyperlink == link) j++;
      if (!link.empty()) {
        uint32_t start = d.clusters[vis[m].k].start, end = d.clusters[vis[m].k].end;
        for (size_t q = m; q < j; q++) {
          start = std::min(start, d.clusters[vis[q].k].start);
          end = std::max(end, d.clusters[vis[q].k].end);
        }
        if (!prevLink || !(*prevLink == link) || L.links.empty() || L.links.back().end != start) linkId++;
        double from = vis[m].x0, to = runEnd(j - 1);
        const ResolvedStyle& s = L.styles[d.clusters[vis[m].k].style];
        double asc = ascentPx(s), desc = descentPx(s);
        L.links.push_back({Rect{from, line.baseline - asc, std::max(0.0, to - from), asc + desc}, link, start, end, linkId});
        prevLink = &L.styles[d.clusters[vis[m].k].style].features.hyperlink;
      }
      m = j;
    }
  }
  if (!anyInk) L.inkBounds = {0, 0, L.size.x, L.size.y};
  return out;
}

// ---- Caret queries ----------------------------------------------------------------------

size_t TextLayout::lineOf(uint32_t index, bool upstream) const {
  for (size_t i = 0; i < lines.size(); i++) {
    const LaidLine& l = lines[i];
    if (index < l.end) return i;
    if (index == l.end && (upstream || i + 1 == lines.size()) && !(l.hardEnd)) return i;
  }
  return lines.empty() ? 0 : lines.size() - 1;
}

double TextLayout::caretX(uint32_t index, size_t line) const {
  if (line >= lines.size()) return 0;
  const LaidLine& l = lines[line];
  if (index >= l.end && !l.hardEnd) return l.caretEnd;
  if (index < caretXs.size()) return caretXs[index];
  return l.caretEnd;
}

uint32_t TextLayout::indexAt(Vec2 p) const {
  if (lines.empty()) return 0;
  size_t li = 0;
  while (li + 1 < lines.size() && p.y >= lines[li].top + lines[li].height) li++;
  const LaidLine& l = lines[li];
  // Caret stops on this line: [start, end] without the "\n" (the stop before it is the line's end).
  uint32_t last = l.hardEnd ? l.end - 1 : l.end;
  if (truncated && li + 1 == lines.size()) last = std::min(last, truncationStart);
  uint32_t best = l.start;
  double bestD = 1e300;
  for (uint32_t i = l.start; i <= last && i <= text.size(); i++) {
    if (i < text.size() && isLowSurrogate(text[i])) continue;
    double x = i == last ? (l.hardEnd ? caretXs[i] : l.caretEnd) : caretXs[i];
    double d = std::fabs(x - p.x);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

std::vector<Rect> TextLayout::selectionRects(uint32_t from, uint32_t to) const {
  std::vector<Rect> out;
  if (from > to) std::swap(from, to);
  if (from == to) return out;
  for (size_t i = 0; i < lines.size(); i++) {
    const LaidLine& l = lines[i];
    if (to <= l.start || from >= l.end) continue;
    if (l.boxCount > 0) {
      // A line in visual order: the selected part of each cluster, joined where they touch.
      size_t first = out.size();
      for (uint32_t b = l.firstBox; b < l.firstBox + l.boxCount; b++) {
        const ClusterBox& c = boxes[b];
        uint32_t a = std::max(from, c.start), z = std::min(to, c.end);
        if (c.end == c.start || a >= z) continue;
        double span = c.end - c.start, w = c.x1 - c.x0;
        double u0 = (a - c.start) / span, u1 = (z - c.start) / span;
        double x0 = c.rtl ? c.x1 - u1 * w : c.x0 + u0 * w, x1 = c.rtl ? c.x1 - u0 * w : c.x0 + u1 * w;
        if (out.size() > first && std::fabs(out.back().x + out.back().w - x0) < 1e-3) out.back().w = x1 - out.back().x;
        else out.push_back({x0, l.top, x1 - x0, l.height});
      }
      if (l.hardEnd && to >= l.end) out.push_back({l.caretEnd - (l.rtl ? 4 : 0), l.top, 4, l.height});  // the selected "\n"
      continue;
    }
    double x0 = caretX(std::max(from, l.start), i);
    double x1;
    if (to >= l.end) x1 = l.caretEnd + (l.hardEnd && to >= l.end ? 0 : 0);
    else x1 = caretX(to, i);
    if (from <= l.start && l.end == l.start) x1 = x0 + 4;  // an empty line: a sliver
    if (l.hardEnd && to >= l.end) x1 = std::max(x1, l.caretEnd + 4);  // the selected "\n"
    out.push_back({std::min(x0, x1), l.top, std::fabs(x1 - x0), l.height});
  }
  return out;
}

}  // namespace eng::text
