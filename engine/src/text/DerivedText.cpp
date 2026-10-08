#include "text/DerivedText.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <unordered_map>

#include "text/Unicode.h"

namespace eng::text {

namespace {

// ---- The stored-glyph font ----

struct GlyphStore {
  Font font;  // outline-only
  std::vector<Bytes> commands{nullptr};  // index 0: no outline
  std::unordered_multimap<uint64_t, uint32_t> byHash;
  std::unordered_map<uint64_t, uint32_t> byFontGlyph;  // (font id, glyph) → index, for writing live layouts
};
GlyphStore& store() {
  static GlyphStore* s = new GlyphStore();
  return *s;
}

uint64_t fnv(const uint8_t* d, size_t n) {
  uint64_t h = 1469598103934665603ull;
  for (size_t i = 0; i < n; i++) h = (h ^ d[i]) * 1099511628211ull;
  return h;
}

float readF32(const uint8_t* p) {
  float f;
  std::memcpy(&f, p, 4);
  return f;
}

// Commands (em, y up) → the GPU's quadratics (em, y down), as Font::outline builds them from HarfBuzz: lines are
// quadratics with the control in the middle, cubics split.
GlyphOutline outlineOf(const uint8_t* d, size_t n) {
  GlyphOutline o;
  float sx = 0, sy = 0, cx = 0, cy = 0;
  bool open = false;
  auto quad = [&](float x0, float y0, float x1, float y1, float x2, float y2) {
    float c[6] = {x0, y0, x1, y1, x2, y2};
    o.curves.insert(o.curves.end(), c, c + 6);
  };
  auto line = [&](float x, float y) {
    if (x == cx && y == cy) return;
    quad(cx, cy, (cx + x) / 2, (cy + y) / 2, x, y);
    cx = x, cy = y;
  };
  auto close = [&]() {
    if (open && (cx != sx || cy != sy)) line(sx, sy);
    open = false;
  };
  size_t i = 0;
  while (i < n) {
    uint8_t op = d[i++];
    static const int kFloats[5] = {0, 2, 2, 4, 6};
    if (op > 4 || i + 4 * static_cast<size_t>(kFloats[op]) > n) break;
    float v[6];
    for (int k = 0; k < kFloats[op]; k++) v[k] = readF32(d + i + 4 * static_cast<size_t>(k));
    i += 4 * static_cast<size_t>(kFloats[op]);
    for (int k = 1; k < kFloats[op]; k += 2) v[k] = -v[k];  // y up → y down
    switch (op) {
      case 0: close(); break;
      case 1:
        close();
        sx = cx = v[0], sy = cy = v[1];
        open = true;
        break;
      case 2: line(v[0], v[1]); break;
      case 3:
        quad(cx, cy, v[0], v[1], v[2], v[3]);
        cx = v[2], cy = v[3];
        break;
      case 4: {
        // Split as Font::outline does (its tolerance, in em).
        float x0 = cx, y0 = cy, c1x = v[0], c1y = v[1], c2x = v[2], c2y = v[3], x = v[4], y = v[5];
        float ex = x - 3 * c2x + 3 * c1x - x0, ey = y - 3 * c2y + 3 * c1y - y0;
        float err = std::sqrt(ex * ex + ey * ey) * 0.0481125f;
        int pieces = std::clamp(static_cast<int>(std::ceil(std::cbrt(err / 0.0004f))), 1, 16);
        auto at = [&](float t, float& px, float& py) {
          float u = 1 - t;
          px = u * u * u * x0 + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * x;
          py = u * u * u * y0 + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * y;
        };
        auto deriv = [&](float t, float& dx, float& dy) {
          float u = 1 - t;
          dx = 3 * (u * u * (c1x - x0) + 2 * u * t * (c2x - c1x) + t * t * (x - c2x));
          dy = 3 * (u * u * (c1y - y0) + 2 * u * t * (c2y - c1y) + t * t * (y - c2y));
        };
        for (int k = 0; k < pieces; k++) {
          float t0 = static_cast<float>(k) / pieces, t1 = static_cast<float>(k + 1) / pieces, h = t1 - t0;
          float ax, ay, bx, by, d0x, d0y, d1x, d1y;
          at(t0, ax, ay);
          at(t1, bx, by);
          deriv(t0, d0x, d0y);
          deriv(t1, d1x, d1y);
          float q1x = ax + d0x * h / 3, q1y = ay + d0y * h / 3, q2x = bx - d1x * h / 3, q2y = by - d1y * h / 3;
          quad(ax, ay, (3 * (q1x + q2x) - ax - bx) / 4, (3 * (q1y + q2y) - ay - by) / 4, bx, by);
        }
        cx = x, cy = y;
        break;
      }
    }
  }
  close();
  if (!o.curves.empty()) {
    float x0 = o.curves[0], y0 = o.curves[1], x1 = x0, y1 = y0;
    for (size_t k = 0; k < o.curves.size(); k += 2) {
      x0 = std::min(x0, o.curves[k]);
      x1 = std::max(x1, o.curves[k]);
      y0 = std::min(y0, o.curves[k + 1]);
      y1 = std::max(y1, o.curves[k + 1]);
    }
    o.bounds[0] = x0, o.bounds[1] = y0, o.bounds[2] = x1, o.bounds[3] = y1;
  }
  return o;
}

void putF32(std::vector<uint8_t>& out, float f) {
  uint8_t b[4];
  std::memcpy(b, &f, 4);
  out.insert(out.end(), b, b + 4);
}

}  // namespace

Font* storedGlyphFont() { return &store().font; }

uint32_t internStoredOutline(const uint8_t* data, size_t len) {
  if (!data || !len) return 0;
  GlyphStore& s = store();
  uint64_t h = fnv(data, len);
  auto [from, to] = s.byHash.equal_range(h);
  for (auto it = from; it != to; ++it) {
    const Bytes& have = s.commands[it->second];
    if (have->size() == len && std::memcmp(have->data(), data, len) == 0) return it->second;
  }
  GlyphOutline o = outlineOf(data, len);
  if (o.empty()) return 0;
  uint32_t index = static_cast<uint32_t>(s.commands.size());
  s.commands.push_back(std::make_shared<std::vector<uint8_t>>(data, data + len));
  s.byHash.emplace(h, index);
  s.font.setOutline(index, std::move(o));
  return index;
}

Bytes storedOutlineCommands(uint32_t index) {
  GlyphStore& s = store();
  return index < s.commands.size() ? s.commands[index] : nullptr;
}

Bytes outlineCommands(const GlyphOutline& o) {
  auto out = std::make_shared<std::vector<uint8_t>>();
  std::vector<uint8_t>& b = *out;
  float px = 0, py = 0;
  bool open = false;
  for (size_t i = 0; i + 5 < o.curves.size(); i += 6) {
    const float* c = &o.curves[i];
    if (!open || c[0] != px || c[1] != py) {
      if (open) b.push_back(0);
      b.push_back(1);
      putF32(b, c[0]);
      putF32(b, -c[1]);
      open = true;
    }
    if (c[2] == (c[0] + c[4]) / 2 && c[3] == (c[1] + c[5]) / 2) {
      b.push_back(2);
    } else {
      b.push_back(3);
      putF32(b, c[2]);
      putF32(b, -c[3]);
    }
    putF32(b, c[4]);
    putF32(b, -c[5]);
    px = c[4], py = c[5];
  }
  if (open) b.push_back(0);
  return out;
}

std::shared_ptr<const StoredText> storedFromLayout(const TextLayout& L) {
  if (L.stored) return L.stored;
  if (L.pendingFont || L.missingFont) return nullptr;
  auto out = std::make_shared<StoredText>();
  StoredText& s = *out;
  s.layoutSize = L.size;
  for (const LaidLine& l : L.lines)
    s.lines.push_back({static_cast<float>(l.x), static_cast<float>(l.baseline), static_cast<float>(l.width), static_cast<float>(l.top),
                       static_cast<float>(l.height), static_cast<float>(l.ascent), l.start, l.end});
  GlyphStore& gs = store();
  for (const LaidGlyph& g : L.glyphs) {
    StoredGlyph sg;
    if (g.font && g.glyph) {
      uint64_t key = (static_cast<uint64_t>(g.font->id()) << 32) | g.glyph;
      auto it = gs.byFontGlyph.find(key);
      if (it != gs.byFontGlyph.end()) {
        sg.outline = it->second;
      } else {
        const GlyphOutline& o = g.font->outline(g.glyph);
        Bytes cmd = o.empty() ? nullptr : outlineCommands(o);
        sg.outline = cmd ? internStoredOutline(cmd->data(), cmd->size()) : 0;
        gs.byFontGlyph.emplace(key, sg.outline);
      }
    }
    sg.x = g.x;
    sg.y = g.y;
    sg.styleID = g.style < L.styles.size() ? L.styles[g.style].styleID : 0;
    sg.fontSize = g.size;
    sg.firstCharacter = g.cluster;
    sg.advance = g.size > 0 ? g.advance / g.size : 0;
    s.glyphs.push_back(sg);
  }
  for (const Decoration& d : L.decorations)
    s.decorations.push_back({{d.rect}, d.style < L.styles.size() ? L.styles[d.style].styleID : 0});
  for (const ResolvedStyle& st : L.styles) {
    if (!st.font) continue;
    bool have = false;
    for (const StoredFont& f : s.fonts) have |= f.key.family == st.fontName.family && f.key.style == st.fontName.style;
    if (!have) s.fonts.push_back({st.fontName, static_cast<float>(st.font->lineHeightEm()), st.font->digest()});
  }
  s.truncationStart = L.truncated ? static_cast<int32_t>(L.truncationStart) : -1;
  s.truncatedHeight = L.truncated ? static_cast<float>(L.size.y) : -1;
  s.caretXs.reserve(L.caretXs.size());
  for (double x : L.caretXs) s.caretXs.push_back(static_cast<float>(x));
  return out;
}

bool sameFonts(const StoredText& s, const TextLayout& L) {
  for (const ResolvedStyle& st : L.styles) {
    if (!st.font) return false;
    bool found = false;
    for (const StoredFont& f : s.fonts)
      if (f.key.family == st.fontName.family && f.key.style == st.fontName.style) found = f.digest == st.font->digest();
    if (!found) return false;
  }
  return true;
}

std::unique_ptr<TextLayout> layoutFromStored(const std::shared_ptr<const StoredText>& stored, const NodeProps& p) {
  auto out = std::make_unique<TextLayout>();
  TextLayout& L = *out;
  const StoredText& s = *stored;
  L.stored = stored;
  L.text = utf8To16(p.text().textData.characters);
  const uint32_t n = static_cast<uint32_t>(L.text.size());
  // Styles as layoutText resolves them (their fills are what draws; the font is the stored outlines').
  Font* font = storedGlyphFont();
  ResolvedStyle base;
  base.fontName = p.text().fontName;
  base.font = font;
  base.fontSize = p.text().fontSize;
  base.lineHeight = p.text().lineHeight;
  base.letterSpacing = p.text().letterSpacing;
  base.textCase = p.text().textCase;
  base.textDecoration = p.text().textDecoration;
  base.fills = &p.fillPaints;
  L.styles.push_back(base);
  std::unordered_map<uint32_t, uint16_t> byId{{0, 0}};
  for (const TextStyle& o : p.text().textData.styleOverrideTable) {
    if (o.styleID == 0 || byId.count(o.styleID) || L.styles.size() >= 0xFFFF) continue;
    ResolvedStyle st = base;
    st.styleID = o.styleID;
    if (o.mask & R_FONT_NAME) st.fontName = o.fontName;
    if (o.mask & R_FONT_SIZE) st.fontSize = o.fontSize;
    if (o.mask & R_LINE_HEIGHT) st.lineHeight = o.lineHeight;
    if (o.mask & R_LETTER_SPACING) st.letterSpacing = o.letterSpacing;
    if (o.mask & R_TEXT_CASE) st.textCase = o.textCase;
    if (o.mask & R_TEXT_DECORATION) st.textDecoration = o.textDecoration;
    if (o.mask & R_FILLS) st.fills = &o.fillPaints;
    byId[o.styleID] = static_cast<uint16_t>(L.styles.size());
    L.styles.push_back(st);
  }
  auto styleIndex = [&](uint32_t id) -> uint16_t {
    auto it = byId.find(id);
    return it == byId.end() ? 0 : it->second;
  };
  L.styleOf.assign(n, 0);
  const auto& ids = p.text().textData.characterStyleIDs;
  for (uint32_t i = 0; i < n && i < ids.size(); i++)
    if (ids[i]) L.styleOf[i] = styleIndex(ids[i]);
  bool anyInk = false;
  for (const StoredGlyph& g : s.glyphs) {
    LaidGlyph out;
    out.font = font;
    out.glyph = g.outline;
    out.x = g.x;
    out.y = g.y;
    out.size = g.fontSize;
    out.advance = g.advance * g.fontSize;
    out.cluster = g.firstCharacter;
    out.style = styleIndex(g.styleID);
    if (g.outline) {
      const GlyphOutline& o = font->outline(g.outline);
      if (!o.empty()) {
        Rect r{out.x + o.bounds[0] * out.size, out.y + o.bounds[1] * out.size, (o.bounds[2] - o.bounds[0]) * out.size,
               (o.bounds[3] - o.bounds[1]) * out.size};
        L.inkBounds = anyInk ? L.inkBounds.united(r) : r;
        anyInk = true;
      }
    }
    L.glyphs.push_back(out);
  }
  size_t gi = 0;
  for (size_t li = 0; li < s.lines.size(); li++) {
    const StoredLine& sl = s.lines[li];
    LaidLine l;
    l.x = sl.x;
    l.baseline = sl.baseline;
    l.width = sl.width;
    l.top = sl.top;
    l.height = sl.height;
    l.ascent = sl.ascent;
    l.descent = std::max(0.0, l.top + l.height - l.baseline);
    l.start = sl.first;
    l.end = sl.end;
    l.firstGlyph = static_cast<uint32_t>(gi);
    bool last = li + 1 == s.lines.size();
    while (gi < L.glyphs.size() && (last || L.glyphs[gi].cluster < sl.end)) gi++;
    l.glyphCount = static_cast<uint32_t>(gi) - l.firstGlyph;
    l.caretEnd = sl.x + sl.width;
    l.hardEnd = sl.end > 0 && sl.end <= n && L.text[sl.end - 1] == u'\n';
    l.paragraphEnd = l.hardEnd || last;
    L.lines.push_back(l);
  }
  if (L.lines.empty()) L.lines.push_back(LaidLine{});
  for (const StoredDecoration& d : s.decorations)
    for (const Rect& r : d.rects) L.decorations.push_back({r, styleIndex(d.styleID)});
  L.size = s.layoutSize;
  LayoutOptions o = optionsFor(p);
  L.boxWidth = o.width >= 0 ? o.width : s.layoutSize.x;
  L.truncated = s.truncationStart >= 0;
  L.truncationStart = s.truncationStart >= 0 ? static_cast<uint32_t>(s.truncationStart) : 0;
  L.caretXs.assign(n + 1, 0);
  for (size_t i = 0; i < s.caretXs.size() && i <= n; i++) L.caretXs[i] = s.caretXs[i];
  if (!anyInk) L.inkBounds = {0, 0, L.size.x, L.size.y};
  return out;
}

// ---- Kiwi ----

namespace {

bool getF(kiwi::ByteBuffer& bb, float& f) { return bb.readVarFloat(f); }
bool getVec(kiwi::ByteBuffer& bb, float& x, float& y) { return bb.readVarFloat(x) && bb.readVarFloat(y); }
bool skipField(kiwi::ByteBuffer& bb, const char* def, uint32_t f) {
  const schema::Def* d = schema::SchemaTable::get().def(def);
  const schema::FieldDef* fd = d ? d->byId(f) : nullptr;
  return fd && schema::SchemaTable::get().skipValue(bb, *fd);
}
bool getStr(kiwi::ByteBuffer& bb, std::string& s) {
  const char* c = nullptr;
  if (!bb.readString(c)) return false;
  s = c;
  return true;
}

}  // namespace

bool readStoredText(std::string_view fields, const std::vector<Bytes>& blobs, StoredText& out) {
  kiwi::ByteBuffer bb(reinterpret_cast<const uint8_t*>(fields.data()), fields.size());
  std::unordered_map<uint32_t, uint32_t> outlineOfBlob;
  while (bb.index() < bb.size()) {
    uint32_t f = 0;
    if (!bb.readVarUint(f) || !f) return false;
    switch (f) {
      case 1: {
        float x, y;
        if (!getVec(bb, x, y)) return false;
        out.layoutSize = {x, y};
        break;
      }
      case 2: {
        uint32_t count = 0;
        if (!bb.readVarUint(count)) return false;
        for (uint32_t i = 0; i < count; i++) {
          StoredLine l;
          for (;;) {
            uint32_t g = 0;
            if (!bb.readVarUint(g)) return false;
            if (!g) break;
            bool ok = true;
            switch (g) {
              case 1: ok = getVec(bb, l.x, l.baseline); break;
              case 2: ok = getF(bb, l.width); break;
              case 3: ok = getF(bb, l.top); break;
              case 4: ok = getF(bb, l.height); break;
              case 5: ok = bb.readVarUint(l.first); break;
              case 6: ok = bb.readVarUint(l.end); break;
              case 7: ok = getF(bb, l.ascent); break;
              default: ok = skipField(bb, "Baseline", g);
            }
            if (!ok) return false;
          }
          out.lines.push_back(l);
        }
        break;
      }
      case 3: {
        uint32_t count = 0;
        if (!bb.readVarUint(count)) return false;
        out.glyphs.reserve(count);
        for (uint32_t i = 0; i < count; i++) {
          StoredGlyph sg;
          for (;;) {
            uint32_t g = 0;
            if (!bb.readVarUint(g)) return false;
            if (!g) break;
            bool ok = true;
            switch (g) {
              case 1: {
                uint32_t blob = 0;
                ok = bb.readVarUint(blob);
                if (!ok) break;
                auto it = outlineOfBlob.find(blob);
                if (it != outlineOfBlob.end()) {
                  sg.outline = it->second;
                } else {
                  const Bytes& b = blob < blobs.size() ? blobs[blob] : nullptr;
                  sg.outline = b ? internStoredOutline(b->data(), b->size()) : 0;
                  outlineOfBlob.emplace(blob, sg.outline);
                }
                break;
              }
              case 2: ok = getVec(bb, sg.x, sg.y); break;
              case 3: ok = bb.readVarUint(sg.styleID); break;
              case 4: ok = getF(bb, sg.fontSize); break;
              case 5: ok = bb.readVarUint(sg.firstCharacter); break;
              case 6: ok = getF(bb, sg.advance); break;
              default: ok = skipField(bb, "Glyph", g);
            }
            if (!ok) return false;
          }
          out.glyphs.push_back(sg);
        }
        break;
      }
      case 4: {
        uint32_t count = 0;
        if (!bb.readVarUint(count)) return false;
        for (uint32_t i = 0; i < count; i++) {
          StoredDecoration d;
          for (;;) {
            uint32_t g = 0;
            if (!bb.readVarUint(g)) return false;
            if (!g) break;
            if (g == 1) {
              uint32_t k = 0;
              if (!bb.readVarUint(k)) return false;
              for (uint32_t j = 0; j < k; j++) {
                float x, y, w, h;
                if (!getVec(bb, x, y) || !getVec(bb, w, h)) return false;
                d.rects.push_back({x, y, w, h});
              }
            } else if (g == 2) {
              if (!bb.readVarUint(d.styleID)) return false;
            } else if (!skipField(bb, "Decoration", g)) {
              return false;
            }
          }
          out.decorations.push_back(std::move(d));
        }
        break;
      }
      case 6: {
        uint32_t count = 0;
        if (!bb.readVarUint(count)) return false;
        for (uint32_t i = 0; i < count; i++) {
          StoredFont sf;
          for (;;) {
            uint32_t g = 0;
            if (!bb.readVarUint(g)) return false;
            if (!g) break;
            if (g == 1) {
              if (!getStr(bb, sf.key.family) || !getStr(bb, sf.key.style) || !getStr(bb, sf.key.postscript)) return false;
            } else if (g == 2) {
              if (!getF(bb, sf.lineHeight)) return false;
            } else if (g == 3) {
              uint32_t k = 0;
              if (!bb.readVarUint(k)) return false;
              for (uint32_t j = 0; j < k; j++) {
                uint8_t b;
                if (!bb.readByte(b)) return false;
                if (j < 20) sf.digest[j] = b;
              }
            } else if (!skipField(bb, "FontMetaData", g)) {
              return false;
            }
          }
          out.fonts.push_back(std::move(sf));
        }
        break;
      }
      case 8:
        if (!bb.readVarInt(out.truncationStart)) return false;
        break;
      case 9:
        if (!getF(bb, out.truncatedHeight)) return false;
        break;
      case 10: {
        uint32_t count = 0;
        if (!bb.readVarUint(count)) return false;
        out.caretXs.resize(count);
        for (uint32_t i = 0; i < count; i++)
          if (!getF(bb, out.caretXs[i])) return false;
        break;
      }
      default:
        if (!skipField(bb, "DerivedTextData", f)) return false;
    }
  }
  return true;
}

void writeStoredText(schema::Out& o, const StoredText& s, codec::BlobsOut& blobs) {
  o.varuint(1);
  o.varfloat(static_cast<float>(s.layoutSize.x));
  o.varfloat(static_cast<float>(s.layoutSize.y));
  o.varuint(2);
  o.varuint(static_cast<uint32_t>(s.lines.size()));
  for (const StoredLine& l : s.lines) {
    o.varuint(1);
    o.varfloat(l.x);
    o.varfloat(l.baseline);
    o.varuint(2), o.varfloat(l.width);
    o.varuint(3), o.varfloat(l.top);
    o.varuint(4), o.varfloat(l.height);
    o.varuint(5), o.varuint(l.first);
    o.varuint(6), o.varuint(l.end);
    o.varuint(7), o.varfloat(l.ascent);
    o.byte(0);
  }
  o.varuint(3);
  o.varuint(static_cast<uint32_t>(s.glyphs.size()));
  std::unordered_map<uint32_t, uint32_t> blobOf;
  for (const StoredGlyph& g : s.glyphs) {
    if (g.outline) {
      auto it = blobOf.find(g.outline);
      uint32_t index;
      if (it != blobOf.end()) {
        index = it->second;
      } else {
        index = blobs.add(storedOutlineCommands(g.outline));
        blobOf.emplace(g.outline, index);
      }
      o.varuint(1), o.varuint(index);
    }
    o.varuint(2);
    o.varfloat(g.x);
    o.varfloat(g.y);
    if (g.styleID) o.varuint(3), o.varuint(g.styleID);
    o.varuint(4), o.varfloat(g.fontSize);
    o.varuint(5), o.varuint(g.firstCharacter);
    o.varuint(6), o.varfloat(g.advance);
    o.byte(0);
  }
  if (!s.decorations.empty()) {
    o.varuint(4);
    o.varuint(static_cast<uint32_t>(s.decorations.size()));
    for (const StoredDecoration& d : s.decorations) {
      o.varuint(1);
      o.varuint(static_cast<uint32_t>(d.rects.size()));
      for (const Rect& r : d.rects) {
        o.varfloat(static_cast<float>(r.x));
        o.varfloat(static_cast<float>(r.y));
        o.varfloat(static_cast<float>(r.w));
        o.varfloat(static_cast<float>(r.h));
      }
      o.varuint(2), o.varuint(d.styleID);
      o.byte(0);
    }
  }
  if (!s.fonts.empty()) {
    o.varuint(6);
    o.varuint(static_cast<uint32_t>(s.fonts.size()));
    for (const StoredFont& f : s.fonts) {
      o.varuint(1);
      o.str(f.key.family);
      o.str(f.key.style);
      o.str(f.key.postscript);
      o.varuint(2), o.varfloat(f.lineHeight);
      o.varuint(3);
      o.varuint(20);
      o.bytes(f.digest.data(), 20);
      o.byte(0);
    }
  }
  o.varuint(8), o.varint(s.truncationStart);
  o.varuint(9), o.varfloat(s.truncatedHeight);
  if (!s.caretXs.empty()) {
    o.varuint(10);
    o.varuint(static_cast<uint32_t>(s.caretXs.size()));
    for (float x : s.caretXs) o.varfloat(x);
  }
  o.byte(0);
}

}  // namespace eng::text
