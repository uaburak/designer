#include "text/TextEdit.h"

#include <algorithm>
#include <map>

#include "base/Json.h"
#include "scene/CodecJson.h"
#include "scene/CodecKiwi.h"
#include "schema/SchemaTable.h"
#include "text/TextFeatures.h"
#include "text/Unicode.h"

namespace eng::text {

uint32_t length16(const TextData& t) { return static_cast<uint32_t>(utf8To16(t.characters).size()); }

uint32_t styleIdAt(const TextData& t, uint32_t index) {
  const auto& ids = t.characterStyleIDs;
  uint32_t at = index > 0 ? index - 1 : 0;
  return at < ids.size() ? ids[at] : 0;
}

namespace {

void trimIds(TextData& t) {
  while (!t.characterStyleIDs.empty() && t.characterStyleIDs.back() == 0) t.characterStyleIDs.pop_back();
}

void dropUnused(TextData& t) {
  std::vector<bool> used;
  auto& table = t.styleOverrideTable;
  table.erase(std::remove_if(table.begin(), table.end(),
                             [&](const TextStyle& s) {
                               return std::find(t.characterStyleIDs.begin(), t.characterStyleIDs.end(), s.styleID) ==
                                      t.characterStyleIDs.end();
                             }),
              table.end());
}

bool sameRun(const TextStyle& a, const TextStyle& b) {
  TextStyle x = a, y = b;
  x.styleID = y.styleID = 0;
  return x == y;
}

}  // namespace

std::u16string slice(const TextData& t, uint32_t from, uint32_t to) {
  std::u16string s = utf8To16(t.characters);
  from = std::min<uint32_t>(from, static_cast<uint32_t>(s.size()));
  to = std::clamp<uint32_t>(to, from, static_cast<uint32_t>(s.size()));
  return s.substr(from, to - from);
}

void replaceRange(TextData& t, uint32_t from, uint32_t to, std::u16string_view insert, uint32_t styleID) {
  std::u16string s = utf8To16(t.characters);
  uint32_t n = static_cast<uint32_t>(s.size());
  from = std::min(from, n);
  to = std::clamp(to, from, n);
  // Paragraph lines: the paragraphs merged by the deletion go, the inserted ones copy the one they split.
  if (!t.lines.empty()) {
    size_t paragraph = static_cast<size_t>(std::count(s.begin(), s.begin() + from, u'\n'));
    size_t removed = static_cast<size_t>(std::count(s.begin() + from, s.begin() + to, u'\n'));
    size_t added = static_cast<size_t>(std::count(insert.begin(), insert.end(), u'\n'));
    size_t total = static_cast<size_t>(std::count(s.begin(), s.end(), u'\n')) + 1;
    if (t.lines.size() < total) t.lines.resize(total, t.lines.back());
    paragraph = std::min(paragraph, t.lines.size() - 1);
    size_t eraseEnd = std::min(t.lines.size(), paragraph + 1 + removed);
    t.lines.erase(t.lines.begin() + static_cast<long>(paragraph + 1), t.lines.begin() + static_cast<long>(eraseEnd));
    std::string copy = t.lines[paragraph];
    t.lines.insert(t.lines.begin() + static_cast<long>(paragraph + 1), added, copy);
  }
  s.replace(from, to - from, insert);
  t.characters = utf16To8(s);
  auto& ids = t.characterStyleIDs;
  if (styleID != 0 || from < ids.size()) {
    if (ids.size() < n) ids.resize(n, 0);
    ids.erase(ids.begin() + from, ids.begin() + to);
    ids.insert(ids.begin() + from, insert.size(), styleID);
  }
  trimIds(t);
  dropUnused(t);
}

uint32_t runFieldsOf(FieldMask mask) {
  uint32_t r = 0;
  if (mask & F_FONT_NAME) r |= R_FONT_NAME;
  if (mask & F_FONT_SIZE) r |= R_FONT_SIZE;
  if (mask & F_LINE_HEIGHT) r |= R_LINE_HEIGHT;
  if (mask & F_LETTER_SPACING) r |= R_LETTER_SPACING;
  if (mask & F_TEXT_CASE) r |= R_TEXT_CASE;
  if (mask & F_TEXT_DECORATION) r |= R_TEXT_DECORATION;
  if (mask & F_FILLS) r |= R_FILLS;
  return r;
}

TextStyle runStyleOf(const NodeProps& p, uint32_t runMask) {
  TextStyle s;
  s.mask = runMask;
  s.fontName = p.text().fontName;
  s.fontSize = p.text().fontSize;
  s.lineHeight = p.text().lineHeight;
  s.letterSpacing = p.text().letterSpacing;
  s.textCase = p.text().textCase;
  s.textDecoration = p.text().textDecoration;
  s.fillPaints = p.fillPaints;
  return s;
}

void resetUnset(TextStyle& s);

namespace {

// Drops the fields of `s` that equal the node's own.
void dropBaseFields(TextStyle& s, const NodeProps& p) {
  if ((s.mask & R_FONT_NAME) && s.fontName == p.text().fontName) s.mask &= ~R_FONT_NAME;
  if ((s.mask & R_FONT_SIZE) && s.fontSize == p.text().fontSize) s.mask &= ~R_FONT_SIZE;
  if ((s.mask & R_LINE_HEIGHT) && s.lineHeight == p.text().lineHeight) s.mask &= ~R_LINE_HEIGHT;
  if ((s.mask & R_LETTER_SPACING) && s.letterSpacing == p.text().letterSpacing) s.mask &= ~R_LETTER_SPACING;
  if ((s.mask & R_TEXT_CASE) && s.textCase == p.text().textCase) s.mask &= ~R_TEXT_CASE;
  if ((s.mask & R_TEXT_DECORATION) && s.textDecoration == p.text().textDecoration) s.mask &= ~R_TEXT_DECORATION;
  if ((s.mask & R_FILLS) && s.fillPaints == p.fillPaints) s.mask &= ~R_FILLS;
  resetUnset(s);
}

}  // namespace

// Unset fields carry their defaults, so equal entries compare equal.
void resetUnset(TextStyle& s) {
  TextStyle d;
  if (!(s.mask & R_FONT_NAME)) s.fontName = d.fontName;
  if (!(s.mask & R_FONT_SIZE)) s.fontSize = d.fontSize;
  if (!(s.mask & R_LINE_HEIGHT)) s.lineHeight = d.lineHeight;
  if (!(s.mask & R_LETTER_SPACING)) s.letterSpacing = d.letterSpacing;
  if (!(s.mask & R_TEXT_CASE)) s.textCase = d.textCase;
  if (!(s.mask & R_TEXT_DECORATION)) s.textDecoration = d.textDecoration;
  if (!(s.mask & R_FILLS)) s.fillPaints.clear();
}

namespace {

uint32_t idFor(TextData& t, TextStyle s, const NodeProps& p) {
  dropBaseFields(s, p);
  if (s.mask == 0 && s.extra.empty()) return 0;
  for (const TextStyle& e : t.styleOverrideTable)
    if (sameRun(e, s)) return e.styleID;
  uint32_t next = 1;
  for (const TextStyle& e : t.styleOverrideTable) next = std::max(next, e.styleID + 1);
  s.styleID = next;
  t.styleOverrideTable.push_back(s);
  return next;
}

const TextStyle* entryOf(const TextData& t, uint32_t id) {
  for (const TextStyle& e : t.styleOverrideTable)
    if (e.styleID == id) return &e;
  return nullptr;
}

}  // namespace

void applyRunStyle(TextData& t, uint32_t from, uint32_t to, const TextStyle& fields, const NodeProps& p) {
  uint32_t n = length16(t);
  from = std::min(from, n);
  to = std::clamp(to, from, n);
  if (from == to || !fields.mask) return;
  auto& ids = t.characterStyleIDs;
  if (ids.size() < n) ids.resize(n, 0);
  std::map<uint32_t, uint32_t> remap;  // old id → new id
  for (uint32_t i = from; i < to; i++) {
    uint32_t old = ids[i];
    auto it = remap.find(old);
    if (it == remap.end()) {
      TextStyle s;
      if (const TextStyle* e = entryOf(t, old)) s = *e;
      TextStyle base = runStyleOf(p, 0);
      // Unset fields of the old entry are the node's values.
      if (!(s.mask & R_FONT_NAME)) s.fontName = base.fontName;
      if (!(s.mask & R_FONT_SIZE)) s.fontSize = base.fontSize;
      if (!(s.mask & R_LINE_HEIGHT)) s.lineHeight = base.lineHeight;
      if (!(s.mask & R_LETTER_SPACING)) s.letterSpacing = base.letterSpacing;
      if (!(s.mask & R_TEXT_CASE)) s.textCase = base.textCase;
      if (!(s.mask & R_TEXT_DECORATION)) s.textDecoration = base.textDecoration;
      if (!(s.mask & R_FILLS)) s.fillPaints = base.fillPaints;
      if (fields.mask & R_FONT_NAME) s.fontName = fields.fontName;
      if (fields.mask & R_FONT_SIZE) s.fontSize = fields.fontSize;
      if (fields.mask & R_LINE_HEIGHT) s.lineHeight = fields.lineHeight;
      if (fields.mask & R_LETTER_SPACING) s.letterSpacing = fields.letterSpacing;
      if (fields.mask & R_TEXT_CASE) s.textCase = fields.textCase;
      if (fields.mask & R_TEXT_DECORATION) s.textDecoration = fields.textDecoration;
      if (fields.mask & R_FILLS) s.fillPaints = fields.fillPaints;
      s.mask = R_FONT_NAME | R_FONT_SIZE | R_LINE_HEIGHT | R_LETTER_SPACING | R_TEXT_CASE | R_TEXT_DECORATION | R_FILLS;
      it = remap.emplace(old, idFor(t, s, p)).first;
    }
    ids[i] = it->second;
  }
  trimIds(t);
  dropUnused(t);
}

void clearRunFields(TextData& t, uint32_t runMask) {
  if (!runMask || t.styleOverrideTable.empty()) return;
  std::map<uint32_t, uint32_t> remap;
  std::vector<TextStyle> kept;
  for (TextStyle s : t.styleOverrideTable) {
    s.mask &= ~runMask;
    resetUnset(s);
    if (s.mask == 0 && s.extra.empty()) {
      remap[s.styleID] = 0;
      continue;
    }
    // Merge with an equal entry kept already.
    bool merged = false;
    for (const TextStyle& k : kept)
      if (sameRun(k, s)) {
        remap[s.styleID] = k.styleID;
        merged = true;
        break;
      }
    if (!merged) kept.push_back(s);
  }
  t.styleOverrideTable = std::move(kept);
  for (uint32_t& id : t.characterStyleIDs) {
    auto it = remap.find(id);
    if (it != remap.end()) id = it->second;
  }
  trimIds(t);
  dropUnused(t);
}

bool isRunExtraKey(std::string_view key) {
  static const char* const kKeys[] = {"fontVariations", "detachOpticalSizeFromFontSize", "toggledOnOTFeatures", "toggledOffOTFeatures",
                                      "fontVariantCommonLigatures", "fontVariantContextualLigatures",
                                      "fontVariantDiscretionaryLigatures", "fontVariantHistoricalLigatures", "fontVariantOrdinal",
                                      "fontVariantSlashedZero", "fontVariantNumericFigure", "fontVariantNumericSpacing",
                                      "fontVariantNumericFraction", "fontVariantCaps", "fontVariantPosition", "hyperlink",
                                      "textDecorationStyle", "textDecorationSkipInk", "textUnderlineOffset", "textDecorationThickness",
                                      "textDecorationFillPaints", "styleIdForText", "parameterConsumptionMap", "isOverrideOverTextStyle",
                                      "semanticWeight", "semanticItalic"};
  for (const char* k : kKeys)
    if (key == k) return true;
  return false;
}

bool changesTextLayout(const std::map<std::string, std::string>& extra) {
  for (auto& [k, v] : extra)
    if (isRunExtraKey(k) || k == "leadingTrim" || k == "listSpacing" || k == "hangingList" || k == "hangingPunctuation" ||
        k == "textWrapStyle")
      return true;
  return false;
}

namespace {

// "varuint id + value" → (id, value bytes).
bool splitEntry(std::string_view entry, uint32_t& id, std::string_view& value) {
  kiwi::ByteBuffer bb(reinterpret_cast<const uint8_t*>(entry.data()), entry.size());
  if (!bb.readVarUint(id)) return false;
  value = entry.substr(bb.index());
  return true;
}

}  // namespace

void applyRunExtras(TextData& t, uint32_t from, uint32_t to, const std::map<std::string, std::string>& fields, const NodeProps& p) {
  uint32_t n = length16(t);
  from = std::min(from, n);
  to = std::clamp(to, from, n);
  if (from == to || fields.empty()) return;
  const schema::Def* def = schema::SchemaTable::get().def("NodeChange");
  if (!def) return;
  auto& ids = t.characterStyleIDs;
  if (ids.size() < n) ids.resize(n, 0);
  std::map<uint32_t, uint32_t> remap;
  for (uint32_t i = from; i < to; i++) {
    uint32_t old = ids[i];
    auto it = remap.find(old);
    if (it == remap.end()) {
      TextStyle s;
      if (const TextStyle* e = entryOf(t, old)) s = *e;
      for (auto& [key, entry] : fields) {
        const schema::FieldDef* fd = def->byName(key);
        if (!fd) continue;
        schema::eraseField(*def, s.extra, fd->value);
        if (entry.empty()) continue;
        auto own = p.extra.find(key);
        if (own != p.extra.end() && own->second == entry) continue;
        uint32_t id = 0;
        std::string_view value;
        if (splitEntry(entry, id, value) && id == fd->value) schema::insertField(*def, s.extra, id, value);
      }
      s.styleID = 0;
      it = remap.emplace(old, idFor(t, s, p)).first;
    }
    ids[i] = it->second;
  }
  trimIds(t);
  dropUnused(t);
}

void clearRunExtras(TextData& t, const std::vector<std::string>& keys) {
  if (keys.empty() || t.styleOverrideTable.empty()) return;
  const schema::Def* def = schema::SchemaTable::get().def("NodeChange");
  if (!def) return;
  std::map<uint32_t, uint32_t> remap;
  std::vector<TextStyle> kept;
  for (TextStyle s : t.styleOverrideTable) {
    for (const std::string& k : keys)
      if (const schema::FieldDef* fd = def->byName(k)) schema::eraseField(*def, s.extra, fd->value);
    if (s.mask == 0 && s.extra.empty()) {
      remap[s.styleID] = 0;
      continue;
    }
    bool merged = false;
    for (const TextStyle& k : kept)
      if (sameRun(k, s)) {
        remap[s.styleID] = k.styleID;
        merged = true;
        break;
      }
    if (!merged) kept.push_back(s);
  }
  t.styleOverrideTable = std::move(kept);
  for (uint32_t& id : t.characterStyleIDs) {
    auto it = remap.find(id);
    if (it != remap.end()) id = it->second;
  }
  trimIds(t);
  dropUnused(t);
}

NodeProps runProps(const TextStyle& run) {
  NodeChange c;
  if (run.extra.empty()) return c.props;
  json::Value v;
  if (!json::parse("{\"guid\":\"0:0\"," + codec::extraToJsonMembers("NodeChange", run.extra) + "}", v)) return c.props;
  codec::readChange(v, c);
  return c.props;
}

bool runHasBindings(const TextStyle& run) {
  if (run.extra.empty()) return false;
  const schema::Def* def = schema::SchemaTable::get().def("NodeChange");
  if (!def) return false;
  static const uint32_t kStyle = codec::fieldIdOf("NodeChange", "styleIdForText");
  static const uint32_t kParams = codec::fieldIdOf("NodeChange", "parameterConsumptionMap");
  return !schema::fieldBytes(*def, run.extra, kStyle).empty() || !schema::fieldBytes(*def, run.extra, kParams).empty();
}

std::string extraEntry(const NodeProps& props, FieldMask field, const char* key) {
  json::Writer w;
  codec::writeNode(w, Node{Guid{0, 0}, props}, field, nullptr);
  json::Value v;
  if (!json::parse(w.str(), v)) return {};
  const json::Value* x = v.get(key);
  if (!x || x->isNull()) return {};
  return codec::extraFromJson("NodeChange", key, *x);
}

void paragraphsOf(const TextData& t, uint32_t from, uint32_t to, size_t& first, size_t& last) {
  std::u16string s = utf8To16(t.characters);
  uint32_t n = static_cast<uint32_t>(s.size());
  from = std::min(from, n);
  to = std::clamp(to, from, n);
  first = static_cast<size_t>(std::count(s.begin(), s.begin() + from, u'\n'));
  // A selection ending right after a "\n" doesn't take the next paragraph.
  uint32_t end = to > from && s[to - 1] == u'\n' ? to - 1 : to;
  last = static_cast<size_t>(std::count(s.begin(), s.begin() + std::max(end, from), u'\n'));
}

namespace {

void ensureLines(TextData& t) {
  size_t total = static_cast<size_t>(std::count(t.characters.begin(), t.characters.end(), '\n')) + 1;
  if (t.lines.size() < total) t.lines.resize(total, t.lines.empty() ? std::string() : t.lines.back());
  if (t.lines.size() > total) t.lines.resize(total);
}

}  // namespace

void setListType(TextData& t, size_t first, size_t last, uint8_t lineType) {
  ensureLines(t);
  for (size_t i = first; i <= last && i < t.lines.size(); i++) {
    LineInfo info = readLine(t.lines[i]);
    info.type = static_cast<LineType>(std::min<uint8_t>(lineType, 2));
    if (info.type != LineType::PLAIN) info.indentationLevel = std::max(1, info.indentationLevel);
    else info.indentationLevel = 0;
    info.isFirstLineOfList = false;
    writeLine(t.lines[i], info);
  }
}

void indentParagraphs(TextData& t, size_t first, size_t last, int delta) {
  ensureLines(t);
  for (size_t i = first; i <= last && i < t.lines.size(); i++) {
    LineInfo info = readLine(t.lines[i]);
    int lo = info.type == LineType::PLAIN ? 0 : 1;
    info.indentationLevel = std::clamp(info.indentationLevel + delta, lo, 5);
    writeLine(t.lines[i], info);
  }
}

std::string layerNameFor(const std::string& characters) {
  std::string out;
  for (char c : characters) out += (c == '\n' || c == '\r') ? ' ' : c;
  return out;
}

}  // namespace eng::text
