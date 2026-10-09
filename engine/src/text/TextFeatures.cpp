#include "text/TextFeatures.h"

#include <algorithm>
#include <cstring>

#include "base/Json.h"
#include "scene/CodecJson.h"
#include "scene/CodecKiwi.h"
#include "schema/SchemaTable.h"

namespace eng::text {

namespace {

constexpr uint32_t T(const char (&s)[5]) {
  return (static_cast<uint32_t>(static_cast<uint8_t>(s[0])) << 24) | (static_cast<uint32_t>(static_cast<uint8_t>(s[1])) << 16) |
         (static_cast<uint32_t>(static_cast<uint8_t>(s[2])) << 8) | static_cast<uint32_t>(static_cast<uint8_t>(s[3]));
}

int8_t tri(const json::Value& v) { return v.isBool() ? (v.boolean ? 1 : 0) : -1; }

template <size_t N>
uint8_t enumIndex(const json::Value& v, const char* const (&names)[N]) {
  if (v.isNumber()) return static_cast<uint8_t>(v.number);
  if (!v.isString()) return 0;
  for (size_t i = 0; i < N; i++)
    if (v.string == names[i]) return static_cast<uint8_t>(i);
  return 0;
}

bool readGuidValue(const json::Value& v, Guid& out) {
  if (v.isObject() && v.get("sessionID") && v.get("localID")) {
    out = Guid{static_cast<uint32_t>(v.get("sessionID")->numberOr(0)), static_cast<uint32_t>(v.get("localID")->numberOr(0))};
    return true;
  }
  return codec::readGuid(v, out);
}

Number readNumber(const json::Value& v) {
  Number n;
  if (const json::Value* x = v.get("value")) n.value = x->numberOr(0);
  if (const json::Value* u = v.get("units"); u && u->isString())
    n.units = u->string == "PIXELS" ? NumberUnits::PIXELS : u->string == "PERCENT" ? NumberUnits::PERCENT : NumberUnits::RAW;
  return n;
}

// Applies one field (schema name, JSON value) to `f`; `run`: a run's (paragraph fields don't apply).
void apply(TextFeatures& f, std::string_view key, const json::Value& v, bool run) {
  static const char* const kFigure[] = {"NORMAL", "LINING", "OLDSTYLE"};
  static const char* const kSpacing[] = {"NORMAL", "PROPORTIONAL", "TABULAR"};
  static const char* const kFraction[] = {"NORMAL", "DIAGONAL", "STACKED"};
  static const char* const kCaps[] = {"NORMAL", "SMALL", "ALL_SMALL", "PETITE", "ALL_PETITE", "UNICASE", "TITLING"};
  static const char* const kPosition[] = {"NORMAL", "SUB", "SUPER"};
  static const char* const kDecoration[] = {"SOLID", "DOTTED", "WAVY"};
  static const char* const kTrim[] = {"NONE", "CAP_HEIGHT"};
  static const char* const kWrap[] = {"AUTO", "BALANCE", "PRETTY"};
  if (key == "fontVariations") {
    f.variations.clear();
    for (const json::Value& a : v.array) {
      const json::Value* tag = a.get("axisTag");
      const json::Value* value = a.get("value");
      if (!tag || !value) continue;
      uint32_t t = tag->isString() ? tagOf(tag->string) : static_cast<uint32_t>(tag->numberOr(0));
      if (t) f.variations.push_back({t, static_cast<float>(value->numberOr(0))});
    }
  } else if (key == "detachOpticalSizeFromFontSize") {
    f.detachOpticalSize = v.isBool() && v.boolean;
  } else if (key == "toggledOnOTFeatures" || key == "toggledOffOTFeatures") {
    std::vector<uint32_t>& list = key == "toggledOnOTFeatures" ? f.featuresOn : f.featuresOff;
    list.clear();
    for (const json::Value& x : v.array)
      if (uint32_t t = x.isString() ? featureTag(x.string) : 0) list.push_back(t);
  } else if (key == "fontVariantCommonLigatures") {
    f.commonLigatures = tri(v);
  } else if (key == "fontVariantContextualLigatures") {
    f.contextualLigatures = tri(v);
  } else if (key == "fontVariantDiscretionaryLigatures") {
    f.discretionaryLigatures = tri(v);
  } else if (key == "fontVariantHistoricalLigatures") {
    f.historicalLigatures = tri(v);
  } else if (key == "fontVariantOrdinal") {
    f.ordinal = tri(v);
  } else if (key == "fontVariantSlashedZero") {
    f.slashedZero = tri(v);
  } else if (key == "fontVariantNumericFigure") {
    f.numericFigure = enumIndex(v, kFigure);
  } else if (key == "fontVariantNumericSpacing") {
    f.numericSpacing = enumIndex(v, kSpacing);
  } else if (key == "fontVariantNumericFraction") {
    f.numericFraction = enumIndex(v, kFraction);
  } else if (key == "fontVariantCaps") {
    f.caps = enumIndex(v, kCaps);
  } else if (key == "fontVariantPosition") {
    f.position = enumIndex(v, kPosition);
  } else if (key == "hyperlink") {
    f.hyperlink = {};
    if (const json::Value* u = v.get("url"); u && u->isString()) f.hyperlink.url = u->string;
    if (const json::Value* g = v.get("guid")) readGuidValue(*g, f.hyperlink.guid);
    if (const json::Value* o = v.get("openInNewTab"); o && o->isBool()) f.hyperlink.openInNewTab = o->boolean;
  } else if (key == "textDecorationStyle") {
    f.decorationStyle = static_cast<DecorationStyle>(enumIndex(v, kDecoration));
  } else if (key == "textDecorationSkipInk") {
    f.skipInk = v.isBool() && v.boolean;
  } else if (key == "textUnderlineOffset") {
    f.underlineOffset = readNumber(v);
    f.hasUnderlineOffset = true;
  } else if (key == "textDecorationThickness") {
    f.decorationThickness = readNumber(v);
    f.hasDecorationThickness = true;
  } else if (key == "textDecorationFillPaints") {
    f.decorationFills = codec::readPaints(v);
    f.hasDecorationFills = true;
  } else if (run) {
    return;
  } else if (key == "leadingTrim") {
    f.leadingTrim = static_cast<LeadingTrim>(enumIndex(v, kTrim));
  } else if (key == "listSpacing") {
    f.listSpacing = v.numberOr(0);
  } else if (key == "hangingList") {
    f.hangingList = v.isBool() && v.boolean;
  } else if (key == "hangingPunctuation") {
    f.hangingPunctuation = v.isBool() && v.boolean;
  } else if (key == "textWrapStyle") {
    f.wrapStyle = static_cast<WrapStyle>(enumIndex(v, kWrap));
  }
}

constexpr const char* kKeys[] = {"fontVariations", "detachOpticalSizeFromFontSize", "toggledOnOTFeatures", "toggledOffOTFeatures",
                                 "fontVariantCommonLigatures", "fontVariantContextualLigatures",
                                 "fontVariantDiscretionaryLigatures", "fontVariantHistoricalLigatures", "fontVariantOrdinal",
                                 "fontVariantSlashedZero", "fontVariantNumericFigure", "fontVariantNumericSpacing",
                                 "fontVariantNumericFraction", "fontVariantCaps", "fontVariantPosition", "hyperlink",
                                 "textDecorationStyle", "textDecorationSkipInk", "textUnderlineOffset", "textDecorationThickness",
                                 "textDecorationFillPaints", "leadingTrim", "listSpacing", "hangingList", "hangingPunctuation",
                                 "textWrapStyle"};

}  // namespace

uint32_t tagOf(std::string_view s) {
  if (s.size() != 4) return 0;
  return (static_cast<uint32_t>(static_cast<uint8_t>(s[0])) << 24) | (static_cast<uint32_t>(static_cast<uint8_t>(s[1])) << 16) |
         (static_cast<uint32_t>(static_cast<uint8_t>(s[2])) << 8) | static_cast<uint32_t>(static_cast<uint8_t>(s[3]));
}

std::string tagString(uint32_t tag) {
  std::string s(4, ' ');
  for (int i = 0; i < 4; i++) s[static_cast<size_t>(i)] = static_cast<char>((tag >> (24 - 8 * i)) & 0xFF);
  return s;
}

uint32_t featureTag(std::string_view name) {
  if (name.size() != 4) return 0;
  std::string lower(name);
  for (char& c : lower)
    if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
  return tagOf(lower);
}

std::string featureName(uint32_t tag) {
  std::string s = tagString(tag);
  for (char& c : s)
    if (c >= 'a' && c <= 'z') c = static_cast<char>(c - 'a' + 'A');
  return s;
}

std::vector<std::pair<uint32_t, bool>> TextFeatures::shapingFeatures(TextCase textCase) const {
  std::vector<std::pair<uint32_t, bool>> out;
  auto set = [&](uint32_t tag, bool on) {
    for (auto& f : out)
      if (f.first == tag) {
        f.second = on;
        return;
      }
    out.push_back({tag, on});
  };
  if (commonLigatures >= 0) {
    set(T("liga"), commonLigatures == 1);
    set(T("clig"), commonLigatures == 1);
  }
  if (contextualLigatures >= 0) set(T("calt"), contextualLigatures == 1);
  if (discretionaryLigatures >= 0) set(T("dlig"), discretionaryLigatures == 1);
  if (historicalLigatures >= 0) set(T("hlig"), historicalLigatures == 1);
  if (ordinal >= 0) set(T("ordn"), ordinal == 1);
  if (slashedZero >= 0) set(T("zero"), slashedZero == 1);
  if (numericFigure == 1) set(T("lnum"), true);
  if (numericFigure == 2) set(T("onum"), true);
  if (numericSpacing == 1) set(T("pnum"), true);
  if (numericSpacing == 2) set(T("tnum"), true);
  if (numericFraction == 1) set(T("frac"), true);
  if (numericFraction == 2) set(T("afrc"), true);
  switch (caps) {
    case 1: set(T("smcp"), true); break;
    case 2: set(T("smcp"), true), set(T("c2sc"), true); break;
    case 3: set(T("pcap"), true); break;
    case 4: set(T("pcap"), true), set(T("c2pc"), true); break;
    case 5: set(T("unic"), true); break;
    case 6: set(T("titl"), true); break;
    default: break;
  }
  if (textCase == TextCase::SMALL_CAPS) set(T("smcp"), true);
  if (textCase == TextCase::SMALL_CAPS_FORCED) set(T("smcp"), true), set(T("c2sc"), true);
  if (position == 1) set(T("subs"), true);
  if (position == 2) set(T("sups"), true);
  for (uint32_t t : featuresOn) set(t, true);
  for (uint32_t t : featuresOff) set(t, false);
  return out;
}

bool TextFeatures::operator==(const TextFeatures& o) const {
  return variations == o.variations && detachOpticalSize == o.detachOpticalSize && featuresOn == o.featuresOn &&
         featuresOff == o.featuresOff && commonLigatures == o.commonLigatures && contextualLigatures == o.contextualLigatures &&
         discretionaryLigatures == o.discretionaryLigatures && historicalLigatures == o.historicalLigatures &&
         ordinal == o.ordinal && slashedZero == o.slashedZero && numericFigure == o.numericFigure &&
         numericSpacing == o.numericSpacing && numericFraction == o.numericFraction && caps == o.caps && position == o.position &&
         hyperlink == o.hyperlink && decorationStyle == o.decorationStyle && skipInk == o.skipInk &&
         underlineOffset == o.underlineOffset && hasUnderlineOffset == o.hasUnderlineOffset &&
         decorationThickness == o.decorationThickness && hasDecorationThickness == o.hasDecorationThickness &&
         decorationFills == o.decorationFills && hasDecorationFills == o.hasDecorationFills && leadingTrim == o.leadingTrim &&
         listSpacing == o.listSpacing && hangingList == o.hangingList && hangingPunctuation == o.hangingPunctuation &&
         wrapStyle == o.wrapStyle;
}

TextFeatures nodeFeatures(const std::map<std::string, std::string>& extra) {
  TextFeatures f;
  if (extra.empty()) return f;
  for (const char* key : kKeys) {
    auto it = extra.find(key);
    if (it == extra.end() || it->second.empty()) continue;
    json::Value v;
    if (json::parse(codec::extraValueToJson("NodeChange", it->second), v)) apply(f, key, v, false);
  }
  return f;
}

bool runHasFeatures(std::string_view runExtra) {
  if (runExtra.empty()) return false;
  const schema::SchemaTable& table = schema::SchemaTable::get();
  const schema::Def* def = table.def("NodeChange");
  if (!def) return false;
  bool any = false;
  table.forEachField(*def, runExtra, [&](const schema::FieldDef& fd, std::string_view) {
    for (const char* key : kKeys)
      if (fd.name == key) any = true;
  });
  return any;
}

TextFeatures runFeatures(const TextFeatures& base, std::string_view runExtra) {
  TextFeatures f = base;
  if (runExtra.empty()) return f;
  json::Value v;
  if (!json::parse("{" + codec::extraToJsonMembers("NodeChange", runExtra) + "}", v)) return f;
  for (auto& [k, x] : v.object) apply(f, k, x, true);
  return f;
}

// ---- Lines --------------------------------------------------------------------------------------

LineInfo readLine(std::string_view bytes) {
  LineInfo out;
  if (bytes.empty()) return out;
  const schema::SchemaTable& table = schema::SchemaTable::get();
  const schema::Def* def = table.def("TextLineData");
  if (!def) return out;
  table.forEachField(*def, bytes, [&](const schema::FieldDef& fd, std::string_view value) {
    kiwi::ByteBuffer bb(reinterpret_cast<const uint8_t*>(value.data()), value.size());
    if (fd.name == "lineType") {
      uint32_t t = 0;
      if (bb.readVarUint(t) && t <= 2) out.type = static_cast<LineType>(t);
    } else if (fd.name == "indentationLevel") {
      bb.readVarInt(out.indentationLevel);
    } else if (fd.name == "listStartOffset") {
      bb.readVarInt(out.listStartOffset);
    } else if (fd.name == "isFirstLineOfList") {
      bool b = false;
      if (bb.readByte(b)) out.isFirstLineOfList = b;
    } else if (fd.name == "sourceDirectionality") {
      uint32_t d = 0;
      if (bb.readVarUint(d) && d <= 2) out.direction = static_cast<uint8_t>(d);
    }
  });
  return out;
}

void writeLineDirection(std::string& bytes, uint8_t direction) {
  const schema::SchemaTable& table = schema::SchemaTable::get();
  const schema::Def* def = table.def("TextLineData");
  if (!def) return;
  auto put = [&](uint32_t id, uint32_t value) {
    schema::Out o;
    o.varuint(value);
    schema::eraseField(*def, bytes, id);
    schema::insertField(*def, bytes, id, o.s);
  };
  put(3, direction == 2 ? 1 : 0);  // directionality: LTR 0, RTL 1
  put(4, direction == 0 ? 0 : 1);  // directionalityIntent: IMPLICIT 0, EXPLICIT 1
  put(9, std::min<uint8_t>(direction, 2));
}

void writeLine(std::string& bytes, const LineInfo& info) {
  const schema::SchemaTable& table = schema::SchemaTable::get();
  const schema::Def* def = table.def("TextLineData");
  if (!def) return;
  auto put = [&](uint32_t id, std::string value) {
    schema::eraseField(*def, bytes, id);
    schema::insertField(*def, bytes, id, value);
  };
  schema::Out o;
  o.varuint(static_cast<uint32_t>(info.type));
  put(1, o.s);
  o = {};
  o.varint(info.indentationLevel);
  put(2, o.s);
  o = {};
  o.varint(info.listStartOffset);
  put(7, o.s);
  o = {};
  o.byte(info.isFirstLineOfList ? 1 : 0);
  put(8, o.s);
}

std::u16string listMarker(LineType type, int32_t level, int32_t index) {
  if (type == LineType::UNORDERED_LIST) return u"•";
  if (type != LineType::ORDERED_LIST) return u"";
  int32_t n = std::max(1, index);
  std::string s;
  switch ((std::max(1, level) - 1) % 3) {
    case 0: s = std::to_string(n); break;
    case 1: {
      // a … z, aa … (spreadsheet-style).
      int32_t k = n;
      while (k > 0) {
        k--;
        s.insert(s.begin(), static_cast<char>('a' + k % 26));
        k /= 26;
      }
      break;
    }
    default: {
      static const std::pair<int, const char*> kRoman[] = {{1000, "m"}, {900, "cm"}, {500, "d"}, {400, "cd"}, {100, "c"},
                                                           {90, "xc"},  {50, "l"},   {40, "xl"},  {10, "x"},   {9, "ix"},
                                                           {5, "v"},    {4, "iv"},   {1, "i"}};
      int32_t k = std::min(n, 3999);
      for (auto& [v, r] : kRoman)
        while (k >= v) {
          s += r;
          k -= v;
        }
      break;
    }
  }
  s += '.';
  return std::u16string(s.begin(), s.end());
}

}  // namespace eng::text
