#include "text/TextLayout.h"

#include <hb.h>

#include <algorithm>
#include <cmath>
#include <unordered_map>

#include "text/Unicode.h"

namespace eng::text {

namespace {

// Metrics used while a style has no font at all yet (not even Inter).
constexpr double kStandInAscent = 0.96875, kStandInDescent = 0.2412, kStandInLineHeight = 1.2099;

double letterSpacingPx(const ResolvedStyle& s) {
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

// Shapes [from, to) of `display` (a paragraph is [pStart, pEnd), the context) into glyphs and clusters.
void shapeParagraph(const std::u16string& display, uint32_t pStart, uint32_t pEnd, const TextLayout& L, std::vector<Glyph>& glyphs,
                    std::vector<Cluster>& clusters) {
  glyphs.clear();
  clusters.clear();
  if (pEnd <= pStart) return;
  FontRegistry& fonts = FontRegistry::get();

  // Itemize: style, font (fallback by coverage), script.
  struct Run {
    uint32_t start, end;
    uint16_t style;
    Font* font;
    hb_script_t script;
  };
  std::vector<Run> runs;
  for (uint32_t i = pStart; i < pEnd;) {
    size_t n = 1;
    uint32_t cp = codePointAt(display, i, &n);
    uint16_t style = L.styleOf[i];
    Font* primary = L.styles[style].font;
    Font* font = primary;
    hb_script_t script = scriptOf(cp);
    bool common = script == HB_SCRIPT_COMMON || script == HB_SCRIPT_INHERITED || script == HB_SCRIPT_UNKNOWN;
    if (!runs.empty() && runs.back().style == style && (joinsPrevious(cp) || cp == 0x200D)) {
      font = runs.back().font;
    } else if (primary && !primary->covers(cp) && !isWhitespace(cp) && cp >= 0x20) {
      if (Font* fb = fonts.fallbackFor(cp)) font = fb;
    }
    if (common && !runs.empty()) script = runs.back().script;
    if (!runs.empty() && runs.back().style == style && runs.back().font == font &&
        (runs.back().script == script || common)) {
      runs.back().end = i + static_cast<uint32_t>(n);
    } else {
      if (!runs.empty() && common == false && runs.back().style == style && runs.back().font == font) {
        // A new script: earlier common characters stay where they were.
      }
      runs.push_back({i, i + static_cast<uint32_t>(n), style, font, script});
    }
    i += static_cast<uint32_t>(n);
  }
  // Resolve the leading common run's script from the next run.
  for (size_t r = 0; r + 1 < runs.size(); r++)
    if ((runs[r].script == HB_SCRIPT_COMMON || runs[r].script == HB_SCRIPT_INHERITED || runs[r].script == HB_SCRIPT_UNKNOWN) &&
        runs[r + 1].style == runs[r].style && runs[r + 1].font == runs[r].font)
      runs[r].script = runs[r + 1].script;

  hb_buffer_t* buf = hb_buffer_create();
  const uint16_t* paragraph = reinterpret_cast<const uint16_t*>(display.data()) + pStart;
  for (const Run& run : runs) {
    const ResolvedStyle& st = L.styles[run.style];
    double scale = st.fontSize / kHbScale;
    size_t firstGlyph = glyphs.size();
    if (!run.font) {
      // No font yet: one empty glyph per character keeps the clusters (and the caret) in place.
      for (uint32_t i = run.start; i < run.end; i++)
        if (!isLowSurrogate(display[i])) glyphs.push_back({nullptr, 0, 0, 0, 0, i, run.style});
    } else {
      hb_buffer_clear_contents(buf);
      hb_buffer_add_utf16(buf, paragraph, static_cast<int>(pEnd - pStart), run.start - pStart, static_cast<int>(run.end - run.start));
      hb_buffer_set_script(buf, run.script);
      hb_buffer_set_direction(buf, HB_DIRECTION_LTR);  // bidi comes with E3.2
      hb_buffer_set_language(buf, hb_language_get_default());
      hb_buffer_set_cluster_level(buf, HB_BUFFER_CLUSTER_LEVEL_MONOTONE_CHARACTERS);
      hb_shape(run.font->hb(), buf, nullptr, 0);
      unsigned count = 0;
      hb_glyph_info_t* info = hb_buffer_get_glyph_infos(buf, &count);
      hb_glyph_position_t* pos = hb_buffer_get_glyph_positions(buf, &count);
      for (unsigned g = 0; g < count; g++)
        glyphs.push_back({run.font, info[g].codepoint, pos[g].x_offset * scale, -pos[g].y_offset * scale, pos[g].x_advance * scale,
                          info[g].cluster + pStart, run.style});
    }
    // Clusters of this run (cluster values never decrease in an LTR run).
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
      c.spacing = letterSpacingPx(st);
      c.width = width + c.spacing;
      c.space = isWhitespace(codePointAt(display, c.start));
      clusters.push_back(c);
      g = h;
    }
  }
  hb_buffer_destroy(buf);
}

// Shapes "…" in a style's font: its glyph and advance.
bool ellipsis(const ResolvedStyle& st, Glyph& out) {
  if (!st.font) return false;
  hb_buffer_t* buf = hb_buffer_create();
  const uint16_t dots[1] = {0x2026};
  hb_buffer_add_utf16(buf, dots, 1, 0, 1);
  hb_buffer_guess_segment_properties(buf);
  hb_shape(st.font->hb(), buf, nullptr, 0);
  unsigned count = 0;
  hb_glyph_info_t* info = hb_buffer_get_glyph_infos(buf, &count);
  hb_glyph_position_t* pos = hb_buffer_get_glyph_positions(buf, &count);
  bool ok = count > 0;
  if (ok) {
    double scale = st.fontSize / kHbScale;
    out = {st.font, info[0].codepoint, 0, 0, pos[0].x_advance * scale, 0, 0};
  }
  hb_buffer_destroy(buf);
  return ok;
}

}  // namespace

double autoLineHeight(const Font* font, double fontSize) {
  return std::round((font ? font->lineHeightEm() : kStandInLineHeight) * fontSize);
}

double lineHeightPx(const ResolvedStyle& s) {
  switch (s.lineHeight.units) {
    case NumberUnits::PIXELS: return s.lineHeight.value;
    case NumberUnits::RAW: return s.lineHeight.value * s.fontSize;
    case NumberUnits::PERCENT:
    default:
      if (std::fabs(s.lineHeight.value - 100) < 1e-6) return autoLineHeight(s.font, s.fontSize);
      return s.lineHeight.value / 100.0 * (s.font ? s.font->lineHeightEm() : kStandInLineHeight) * s.fontSize;
  }
}

LayoutOptions optionsFor(const NodeProps& p, double widthOverride) {
  LayoutOptions o;
  switch (p.textAutoResize) {
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

std::unique_ptr<TextLayout> layoutText(const NodeProps& p, const LayoutOptions& opt) {
  auto out = std::make_unique<TextLayout>();
  TextLayout& L = *out;
  FontRegistry& fonts = FontRegistry::get();
  L.text = utf8To16(p.textData.characters);
  const uint32_t n = static_cast<uint32_t>(L.text.size());

  // Styles: 0 = the node's own; one per override entry.
  ResolvedStyle base;
  base.fontName = p.fontName;
  base.fontSize = p.fontSize;
  base.lineHeight = p.lineHeight;
  base.letterSpacing = p.letterSpacing;
  base.textCase = p.textCase;
  base.textDecoration = p.textDecoration;
  base.fills = &p.fillPaints;
  L.styles.push_back(base);
  std::unordered_map<uint32_t, uint16_t> byId;
  for (const TextStyle& o : p.textData.styleOverrideTable) {
    if (o.styleID == 0 || byId.count(o.styleID) || L.styles.size() >= 0xFFFF) continue;
    ResolvedStyle s = base;
    s.styleID = o.styleID;
    if (o.mask & R_FONT_NAME) s.fontName = o.fontName;
    if (o.mask & R_FONT_SIZE) s.fontSize = o.fontSize;
    if (o.mask & R_LINE_HEIGHT) s.lineHeight = o.lineHeight;
    if (o.mask & R_LETTER_SPACING) s.letterSpacing = o.letterSpacing;
    if (o.mask & R_TEXT_CASE) s.textCase = o.textCase;
    if (o.mask & R_TEXT_DECORATION) s.textDecoration = o.textDecoration;
    if (o.mask & R_FILLS) s.fills = &o.fillPaints;
    byId[o.styleID] = static_cast<uint16_t>(L.styles.size());
    L.styles.push_back(s);
  }
  for (ResolvedStyle& s : L.styles) {
    FontRegistry::State state;
    s.font = fonts.find(s.fontName, &state);
    if (!s.font) {
      s.missing = state == FontRegistry::State::Missing;
      s.pending = !s.missing;
      s.font = fonts.defaultFont();
      L.missingFont |= s.missing;
      L.pendingFont |= s.pending;
    }
    if (s.fontSize <= 0) s.fontSize = 1;
  }
  L.styleOf.assign(n, 0);
  const auto& ids = p.textData.characterStyleIDs;
  for (uint32_t i = 0; i < n && i < ids.size(); i++)
    if (ids[i]) {
      auto it = byId.find(ids[i]);
      if (it != byId.end()) L.styleOf[i] = it->second;
    }

  // textCase, run by run.
  std::u16string display = L.text;
  for (uint32_t i = 0; i < n;) {
    uint32_t j = i;
    while (j < n && L.styleOf[j] == L.styleOf[i]) j++;
    TextCase tc = L.styles[L.styleOf[i]].textCase;
    if (tc != TextCase::ORIGINAL) {
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

  struct LineDraft {
    std::vector<Cluster> clusters;
    std::vector<Glyph> glyphs;
    uint32_t start, end;
    bool paragraphStart, paragraphEnd, hardEnd;
    uint16_t emptyStyle;
  };
  std::vector<LineDraft> drafts;

  std::vector<Glyph> pg;
  std::vector<Cluster> pc;
  uint32_t pStart = 0;
  while (true) {
    uint32_t pEnd = pStart;
    while (pEnd < n && L.text[pEnd] != u'\n') pEnd++;
    bool last = pEnd >= n;
    shapeParagraph(display, pStart, pEnd, L, pg, pc);
    for (Cluster& c : pc) c.breakAfter = c.end > 0 && c.end - 1 < n ? breaks[c.end - 1] : BREAK_NO;
    uint16_t emptyStyle = pStart < n ? L.styleOf[pStart] : (pStart > 0 ? L.styleOf[pStart - 1] : 0);

    // Greedy line filling.
    auto emit = [&](size_t from, size_t to, bool paragraphStart, bool paragraphEnd) {
      LineDraft d;
      d.paragraphStart = paragraphStart;
      d.paragraphEnd = paragraphEnd;
      d.hardEnd = paragraphEnd && !last;
      d.start = from < to ? pc[from].start : (from < pc.size() ? pc[from].start : pEnd);
      d.end = to > from ? pc[to - 1].end : d.start;
      if (paragraphEnd) d.end = last ? pEnd : pEnd + 1;  // the "\n" belongs to the line it ends
      if (from == to && paragraphStart) d.start = pStart;
      d.emptyStyle = from < to ? pc[from].style : emptyStyle;
      for (size_t k = from; k < to; k++) {
        Cluster c = pc[k];
        c.firstGlyph = static_cast<uint32_t>(d.glyphs.size());
        for (uint32_t g = 0; g < pc[k].glyphCount; g++) d.glyphs.push_back(pg[pc[k].firstGlyph + g]);
        d.clusters.push_back(c);
      }
      drafts.push_back(std::move(d));
    };
    size_t i0 = 0;
    bool firstLine = true;
    double x = 0;
    long lastBreak = -1;
    for (size_t k = 0; k < pc.size(); k++) {
      const Cluster& c = pc[k];
      double limit = maxWidth - (firstLine ? p.paragraphIndent : 0);
      if (wrap && k > i0 && !c.space && x + c.width - c.spacing > limit + 1e-4) {
        size_t cut = lastBreak >= static_cast<long>(i0) ? static_cast<size_t>(lastBreak) + 1 : k;
        emit(i0, cut, firstLine, false);
        firstLine = false;
        i0 = cut;
        x = 0;
        for (size_t j = i0; j < k; j++) x += pc[j].width;
        lastBreak = -1;
      }
      x += c.width;
      if (c.breakAfter == BREAK_ALLOW) lastBreak = static_cast<long>(k);
      if (c.breakAfter == BREAK_MUST && c.end < pEnd) {
        // U+2028: a line break inside the paragraph.
        emit(i0, k + 1, firstLine, false);
        firstLine = false;
        i0 = k + 1;
        x = 0;
        lastBreak = -1;
      }
    }
    emit(i0, pc.size(), firstLine, true);
    if (last) break;
    pStart = pEnd + 1;
  }

  // Truncation (ENDING): by maxLines, or by the box's height for fixed boxes.
  size_t keep = drafts.size();
  if (p.textTruncation == TextTruncation::ENDING) {
    if (p.maxLines > 0) keep = std::min(keep, static_cast<size_t>(p.maxLines));
    if (opt.height >= 0 && p.textAutoResize == TextAutoResize::NONE) {
      double y = 0;
      size_t fit = 0;
      for (size_t i = 0; i < keep; i++) {
        const LineDraft& d = drafts[i];
        double lh = 0;
        if (d.clusters.empty()) lh = lineHeightPx(L.styles[d.emptyStyle]);
        for (auto& c : d.clusters) lh = std::max(lh, lineHeightPx(L.styles[c.style]));
        if (i > 0 && drafts[i - 1].paragraphEnd) y += p.paragraphSpacing;
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
    uint16_t st = d.clusters.empty() ? d.emptyStyle : d.clusters.back().style;
    Glyph dots{};
    if (ellipsis(L.styles[st], dots)) {
      double limit = wrap ? maxWidth - (d.paragraphStart ? p.paragraphIndent : 0) : 1e300;
      auto width = [&]() {
        double w = 0;
        for (auto& c : d.clusters) w += c.width;
        return w;
      };
      while (!d.clusters.empty() && (width() + dots.advance > limit + 1e-4 || d.clusters.back().space)) {
        d.glyphs.resize(d.clusters.back().firstGlyph);
        d.clusters.pop_back();
      }
      uint32_t at = d.clusters.empty() ? d.start : d.clusters.back().end;
      L.truncationStart = at;
      dots.cluster = at;
      dots.style = st;
      Cluster c;
      c.start = at;
      c.end = at;
      c.firstGlyph = static_cast<uint32_t>(d.glyphs.size());
      c.glyphCount = 1;
      c.width = dots.advance;
      c.style = st;
      d.glyphs.push_back(dots);
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
    if (li > 0 && drafts[li - 1].paragraphEnd) y += p.paragraphSpacing;
    line.top = y;
    line.height = lh;
    line.ascent = asc;
    line.descent = desc;
    line.baseline = y + (lh - (asc + desc)) / 2 + asc;
    line.width = w;
    double indent = d.paragraphStart ? p.paragraphIndent : 0;
    widest = std::max(widest, w + indent);
    y += lh;
    L.lines.push_back(line);
  }
  L.size = {widest, y};
  L.boxWidth = wrap ? maxWidth : widest;
  if (opt.height >= 0 && p.textAutoResize == TextAutoResize::NONE) {
    double f = p.textAlignVertical == TextAlignVertical::CENTER ? 0.5 : p.textAlignVertical == TextAlignVertical::BOTTOM ? 1 : 0;
    L.offsetY = (opt.height - L.size.y) * f;
  }

  // Horizontal placement, glyphs, carets, decorations.
  bool anyInk = false;
  for (size_t li = 0; li < drafts.size(); li++) {
    LineDraft& d = drafts[li];
    LaidLine& line = L.lines[li];
    line.top += L.offsetY;
    line.baseline += L.offsetY;
    double indent = d.paragraphStart ? p.paragraphIndent : 0;
    double free = L.boxWidth - indent - line.width;
    double x0 = indent, extraPerSpace = 0;
    switch (p.textAlignHorizontal) {
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
    if (p.textAlignHorizontal == TextAlignHorizontal::JUSTIFIED && extraPerSpace > 0) line.width = L.boxWidth - indent;
    line.x = x0;
    line.firstGlyph = static_cast<uint32_t>(L.glyphs.size());
    double pen = x0;
    for (size_t k = 0; k < d.clusters.size(); k++) {
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
        if (out.font && out.glyph) {
          const GlyphOutline& o = out.font->outline(out.glyph);
          if (!o.empty()) {
            Rect r{out.x + o.bounds[0] * out.size, out.y + o.bounds[1] * out.size, (o.bounds[2] - o.bounds[0]) * out.size,
                   (o.bounds[3] - o.bounds[1]) * out.size};
            L.inkBounds = anyInk ? L.inkBounds.united(r) : r;
            anyInk = true;
          }
        }
        L.glyphs.push_back(out);
      }
      pen += c.spacing;
      if (c.space) pen += extraPerSpace;
      // Carets inside the cluster (ligatures split evenly).
      uint32_t span = c.end > c.start ? c.end - c.start : 0;
      for (uint32_t u = 0; u < span && c.start + u <= n; u++)
        L.caretXs[c.start + u] = startX + (pen - startX) * u / static_cast<double>(span);
    }
    line.glyphCount = static_cast<uint32_t>(L.glyphs.size()) - line.firstGlyph;
    line.caretEnd = pen;
    if (d.clusters.empty()) line.caretEnd = x0;
    // Positions without a cluster (the "\n", the end of the text, an empty line).
    uint32_t tail = d.clusters.empty() ? line.start : d.clusters.back().end;
    for (uint32_t u = tail; u < line.end && u <= n; u++) L.caretXs[u] = line.caretEnd;
    if (li + 1 == drafts.size()) L.caretXs[n] = line.caretEnd;

    // Underline / strikethrough, per run of a decorated style (trailing spaces left out).
    size_t contentEnd = d.clusters.size();
    while (contentEnd > 0 && d.clusters[contentEnd - 1].space) contentEnd--;
    for (size_t k = 0; k < contentEnd;) {
      uint16_t st = d.clusters[k].style;
      size_t j = k;
      while (j < contentEnd && d.clusters[j].style == st) j++;
      const ResolvedStyle& s = L.styles[st];
      if (s.textDecoration != TextDecoration::NONE) {
        double from = L.caretXs[d.clusters[k].start], to = j < d.clusters.size() ? L.caretXs[d.clusters[j].start] : line.caretEnd;
        if (j == contentEnd) to -= d.clusters[j - 1].spacing;
        if (d.clusters[k].start == d.clusters[k].end) from = line.caretEnd - d.clusters[k].width;  // the ellipsis
        double size = s.fontSize;
        Font* f = s.font;
        double top, h;
        if (s.textDecoration == TextDecoration::UNDERLINE) {
          top = line.baseline + (f ? f->underlineOffset : 0.1) * size;
          h = (f ? f->underlineThickness : 0.06) * size;
        } else {
          top = line.baseline - (f ? f->strikeoutOffset : 0.3) * size;
          h = (f ? f->strikeoutThickness : 0.06) * size;
        }
        L.decorations.push_back({Rect{from, top, std::max(0.0, to - from), h}, st});
      }
      k = j;
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
