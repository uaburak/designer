#include "export/TrueType.h"

#include <hb-ot.h>
#include <hb.h>

#include <algorithm>
#include <map>
#include <vector>

namespace eng::exporter {

namespace {

uint32_t tag(const char t[5]) { return HB_TAG(t[0], t[1], t[2], t[3]); }

// A table's bytes (empty when the face has none).
std::string table(hb_face_t* face, uint32_t t) {
  hb_blob_t* b = hb_face_reference_table(face, t);
  unsigned len = 0;
  const char* data = hb_blob_get_data(b, &len);
  std::string out(data ? data : "", data ? len : 0);
  hb_blob_destroy(b);
  return out;
}

uint16_t u16(const std::string& s, size_t at) {
  return at + 2 <= s.size() ? static_cast<uint16_t>(static_cast<uint8_t>(s[at]) << 8 | static_cast<uint8_t>(s[at + 1])) : 0;
}
int16_t i16(const std::string& s, size_t at) { return static_cast<int16_t>(u16(s, at)); }
uint32_t u32(const std::string& s, size_t at) { return static_cast<uint32_t>(u16(s, at)) << 16 | u16(s, at + 2); }

void put16(std::string& s, size_t at, uint16_t v) {
  s[at] = static_cast<char>(v >> 8);
  s[at + 1] = static_cast<char>(v & 0xff);
}
void put32(std::string& s, size_t at, uint32_t v) {
  put16(s, at, static_cast<uint16_t>(v >> 16));
  put16(s, at + 2, static_cast<uint16_t>(v & 0xffff));
}
void append16(std::string& s, uint16_t v) {
  s += static_cast<char>(v >> 8);
  s += static_cast<char>(v & 0xff);
}
void append32(std::string& s, uint32_t v) {
  append16(s, static_cast<uint16_t>(v >> 16));
  append16(s, static_cast<uint16_t>(v & 0xffff));
}

uint32_t checksum(const std::string& s) {
  uint32_t sum = 0;
  for (size_t i = 0; i < s.size(); i += 4) {
    uint32_t v = 0;
    for (size_t k = 0; k < 4; k++) v = v << 8 | (i + k < s.size() ? static_cast<uint8_t>(s[i + k]) : 0);
    sum += v;
  }
  return sum;
}

size_t tableLength(hb_face_t* face, uint32_t t) {
  hb_blob_t* b = hb_face_reference_table(face, t);
  size_t len = hb_blob_get_length(b);
  hb_blob_destroy(b);
  return len;
}

}  // namespace

bool canSubsetTrueType(hb_face_t* face) {
  std::string head = table(face, tag("head")), maxp = table(face, tag("maxp"));
  if (head.size() < 54 || maxp.size() < 6 || tableLength(face, tag("hhea")) < 36 || !tableLength(face, tag("hmtx")) || !tableLength(face, tag("glyf")))
    return false;
  uint32_t count = u16(maxp, 4);
  return tableLength(face, tag("loca")) >= (count + 1) * (i16(head, 50) == 1 ? 4u : 2u);
}

std::string subsetTrueType(hb_face_t* face, const std::set<uint32_t>& used, TrueTypeInfo& info) {
  std::string head = table(face, tag("head")), maxp = table(face, tag("maxp")), hhea = table(face, tag("hhea"));
  std::string hmtx = table(face, tag("hmtx")), loca = table(face, tag("loca")), glyf = table(face, tag("glyf"));
  if (head.size() < 54 || maxp.size() < 6 || hhea.size() < 36 || hmtx.empty() || loca.empty() || glyf.empty()) return "";
  uint32_t count = u16(maxp, 4);
  bool longLoca = i16(head, 50) == 1;
  auto offsetOf = [&](uint32_t g) -> size_t { return longLoca ? u32(loca, g * 4) : static_cast<size_t>(u16(loca, g * 2)) * 2; };
  if (loca.size() < (count + 1) * (longLoca ? 4u : 2u)) return "";

  // The glyphs to keep: those asked for, .notdef, and every composite's parts (to any depth).
  std::set<uint32_t> keep;
  std::vector<uint32_t> todo(used.begin(), used.end());
  todo.push_back(0);
  while (!todo.empty()) {
    uint32_t g = todo.back();
    todo.pop_back();
    if (g >= count || !keep.insert(g).second) continue;
    size_t from = offsetOf(g), to = offsetOf(g + 1);
    if (to <= from + 10 || to > glyf.size() || i16(glyf, from) >= 0) continue;
    for (size_t at = from + 10; at + 4 <= to;) {
      uint16_t flags = u16(glyf, at);
      todo.push_back(u16(glyf, at + 2));
      at += 4 + ((flags & 0x0001) ? 4 : 2);
      if (flags & 0x0008) at += 2;
      else if (flags & 0x0040) at += 4;
      else if (flags & 0x0080) at += 8;
      if (!(flags & 0x0020)) break;
    }
  }

  // glyf with the kept glyphs (each 4-byte aligned), loca in the long form.
  std::string newGlyf, newLoca;
  for (uint32_t g = 0; g < count; g++) {
    append32(newLoca, static_cast<uint32_t>(newGlyf.size()));
    if (!keep.count(g)) continue;
    size_t from = offsetOf(g), to = std::min(offsetOf(g + 1), glyf.size());
    if (to > from) newGlyf.append(glyf, from, to - from);
    while (newGlyf.size() % 4) newGlyf += '\0';
  }
  append32(newLoca, static_cast<uint32_t>(newGlyf.size()));
  put16(head, 50, 1);
  put32(head, 8, 0);

  info.unitsPerEm = std::max<int>(16, u16(head, 18));
  info.bbox[0] = i16(head, 36), info.bbox[1] = i16(head, 38), info.bbox[2] = i16(head, 40), info.bbox[3] = i16(head, 42);
  info.ascent = i16(hhea, 4), info.descent = i16(hhea, 6);
  std::string os2 = table(face, tag("OS/2"));
  info.capHeight = os2.size() >= 90 && u16(os2, 0) >= 2 ? i16(os2, 88) : info.ascent;
  std::string post = table(face, tag("post"));
  if (post.size() >= 32) {
    info.italicAngle = static_cast<int32_t>(u32(post, 4)) / 65536.0;
    post.resize(32);
    put32(post, 0, 0x00030000);  // version 3: no glyph names
  }
  std::string name = table(face, tag("name"));
  unsigned len = 64;
  char buf[64];
  if (hb_ot_name_get_utf8(face, HB_OT_NAME_ID_POSTSCRIPT_NAME, HB_LANGUAGE_INVALID, &len, buf) > 0) info.postScriptName = buf;

  std::map<uint32_t, std::string> tables{{tag("head"), head}, {tag("hhea"), hhea}, {tag("maxp"), maxp}, {tag("hmtx"), hmtx},
                                         {tag("loca"), newLoca}, {tag("glyf"), newGlyf}};
  if (!os2.empty()) tables[tag("OS/2")] = os2;
  if (!name.empty()) tables[tag("name")] = name;
  if (!post.empty()) tables[tag("post")] = post;

  // The sfnt: the offset table, the records sorted by tag, the tables 4-byte aligned; then head's checkSumAdjustment.
  uint16_t numTables = static_cast<uint16_t>(tables.size());
  uint16_t pow2 = 1, log2 = 0;
  while (pow2 * 2 <= numTables) pow2 *= 2, log2++;
  std::string out;
  append32(out, 0x00010000);
  append16(out, numTables);
  append16(out, static_cast<uint16_t>(pow2 * 16));
  append16(out, log2);
  append16(out, static_cast<uint16_t>(numTables * 16 - pow2 * 16));
  size_t offset = 12 + 16 * static_cast<size_t>(numTables), headAt = 0;
  std::string body;
  for (auto& [t, data] : tables) {
    append32(out, t);
    append32(out, checksum(data));
    append32(out, static_cast<uint32_t>(offset + body.size()));
    append32(out, static_cast<uint32_t>(data.size()));
    if (t == tag("head")) headAt = offset + body.size();
    body += data;
    while (body.size() % 4) body += '\0';
  }
  out += body;
  put32(out, headAt + 8, 0xB1B0AFBA - checksum(out));
  return out;
}

}  // namespace eng::exporter
