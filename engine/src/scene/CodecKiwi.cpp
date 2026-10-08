#include "scene/CodecKiwi.h"

#include <algorithm>
#include <cmath>
#include <cstring>

#include "schema/SchemaTable.h"

namespace eng::codec {

using schema::Def;
using schema::FieldDef;
using schema::Out;
using schema::SchemaTable;

// schema/document.kiwi NodeChange field ids the reader handles besides ENG_NODE_FIELDS' (Node.cpp).
namespace id {
constexpr uint32_t kGuid = 1, kPhase = 2, kParentIndex = 3, kType = 4, kStyleID = 49, kGuidPath = 111, kClearedFields = 1000;
constexpr uint32_t kCornerRadius = 20, kCornerTL = 145, kCornerTR = 146, kCornerBL = 147, kCornerBR = 148, kCornersIndependent = 149;
constexpr uint32_t kBorderTop = 295, kBorderBottom = 296, kBorderLeft = 297, kBorderRight = 298, kBordersIndependent = 299;
constexpr uint32_t kFillGeometry = 51, kStrokeGeometry = 52, kDerivedSymbolData = 125, kDerivedTextData = 359;
// Message.
constexpr uint32_t kMsgType = 1, kMsgSession = 2, kMsgAck = 3, kMsgChanges = 4, kMsgBlobs = 6, kMsgPasteFileKey = 14,
                   kMsgPastePage = 20, kMsgIsCut = 21, kMsgRegions = 33, kMsgDerivedVersion = 100;
}  // namespace id

// ---- Helpers ---------------------------------------------------------------------------------------------

namespace {

const SchemaTable& table() { return SchemaTable::get(); }
const Def& defOf(const char* name) {
  const Def* d = table().def(name);
  // The schema always has the definitions this file names (schemagen generated both from the same source).
  static Def empty;
  return d ? *d : empty;
}

// Definitions the codec reads unmodelled fields of (looked up once).
struct Defs {
  const Def& nodeChange = defOf("NodeChange");
  const Def& paint = defOf("Paint");
  const Def& effect = defOf("Effect");
  const Def& variableData = defOf("VariableData");
  const Def& anyValue = defOf("VariableAnyValue");
  const Def& layoutGrid = defOf("LayoutGrid");
  const Def& propDef = defOf("ComponentPropDef");
  const Def& propAssignment = defOf("ComponentPropAssignment");
  const Def& propValue = defOf("ComponentPropValue");
  const Def& preferredValues = defOf("ComponentPropPreferredValues");
  const Def& textLine = defOf("TextLineData");
  const Def& message = defOf("Message");
};
const Defs& defs() {
  static const Defs* d = new Defs();
  return *d;
}

// ---- reading primitives ----

bool getString(kiwi::ByteBuffer& bb, std::string& out) {
  const char* s = nullptr;
  if (!bb.readString(s)) return false;
  out.assign(s);
  return true;
}
bool getFloat(kiwi::ByteBuffer& bb, double& out) {
  float f;
  if (!bb.readVarFloat(f)) return false;
  out = f;
  return true;
}
bool getFloat(kiwi::ByteBuffer& bb, float& out) { return bb.readVarFloat(out); }
bool getBool(kiwi::ByteBuffer& bb, bool& out) {
  uint8_t b;
  if (!bb.readByte(b)) return false;
  out = b != 0;
  return true;
}
bool getGuid(kiwi::ByteBuffer& bb, Guid& out) {
  return bb.readVarUint(out.sessionID) && bb.readVarUint(out.localID);
}
bool getColor(kiwi::ByteBuffer& bb, Color& c) { return getFloat(bb, c.r) && getFloat(bb, c.g) && getFloat(bb, c.b) && getFloat(bb, c.a); }
bool getVector(kiwi::ByteBuffer& bb, Vec2& v) { return getFloat(bb, v.x) && getFloat(bb, v.y); }
bool getMatrix(kiwi::ByteBuffer& bb, Mat2x3& m) {
  return getFloat(bb, m.m00) && getFloat(bb, m.m01) && getFloat(bb, m.m02) && getFloat(bb, m.m10) && getFloat(bb, m.m11) &&
         getFloat(bb, m.m12);
}
bool getNumber(kiwi::ByteBuffer& bb, Number& n) {
  uint32_t units = 0;
  if (!getFloat(bb, n.value) || !bb.readVarUint(units)) return false;
  if (units <= 2) n.units = static_cast<NumberUnits>(units);
  return true;
}
bool getFontName(kiwi::ByteBuffer& bb, FontName& f) { return getString(bb, f.family) && getString(bb, f.style) && getString(bb, f.postscript); }
// An enum value the engine knows (unknown values leave `out` as it was and return false, as the JSON reader does).
template <typename E>
bool getEnum(kiwi::ByteBuffer& bb, E& out) {
  uint32_t v = 0;
  if (!bb.readVarUint(v)) return false;
  if (v < EnumNames<E>::count && EnumNames<E>::names[v][0]) {
    out = static_cast<E>(v);
    return true;
  }
  return false;
}
NodeType nodeTypeOf(uint32_t v) {
  switch (v) {
    case 1: return NodeType::DOCUMENT;
    case 2: return NodeType::CANVAS;
    case 3: return NodeType::GROUP;
    case 4: return NodeType::FRAME;
    case 5: return NodeType::BOOLEAN_OPERATION;
    case 6: return NodeType::VECTOR;
    case 7: return NodeType::STAR;
    case 8: return NodeType::LINE;
    case 9: return NodeType::ELLIPSE;
    case 10: return NodeType::RECTANGLE;
    case 11: return NodeType::REGULAR_POLYGON;
    case 12: return NodeType::ROUNDED_RECTANGLE;
    case 13: return NodeType::TEXT;
    case 14: return NodeType::SLICE;
    case 15: return NodeType::SYMBOL;
    case 16: return NodeType::INSTANCE;
    case 25: return NodeType::SECTION;
    case 28: return NodeType::VARIABLE;
    case 31: return NodeType::VARIABLE_SET;
    case 35: return NodeType::VARIABLE_OVERRIDE;
    case 46: return NodeType::BRUSH;
    default: return NodeType::NONE;
  }
}

// Figma's "none" sentinel reads as absent.
Guid noneToAbsent(Guid g) { return g.sessionID == 0xFFFFFFFFu && g.localID == 0xFFFFFFFFu ? kNoGuid : g; }

// The bytes of one unknown field (positioned after its id), kept id-prefixed in `extra`; false when the schema
// doesn't know the field (its length is then unknown and the message can't be read).
bool keepUnknown(kiwi::ByteBuffer& bb, const Def& def, uint32_t fieldId, std::string& extra) {
  const FieldDef* f = def.byId(fieldId);
  if (!f) return false;
  size_t start = bb.index();
  if (!table().skipValue(bb, *f)) return false;
  schema::insertField(def, extra, fieldId, std::string_view(reinterpret_cast<const char*>(bb.data()) + start, bb.index() - start));
  return true;
}
bool skipUnknown(kiwi::ByteBuffer& bb, const Def& def, uint32_t fieldId) {
  const FieldDef* f = def.byId(fieldId);
  return f && table().skipValue(bb, *f);
}

// An AssetId (schema VariableID / VariableSetID / StyleId / SymbolId: {guid, assetRef{key, version}}).
bool getAssetId(kiwi::ByteBuffer& bb, AssetId& a) {
  for (;;) {
    uint32_t f = 0;
    if (!bb.readVarUint(f)) return false;
    if (!f) return true;
    if (f == 1) {
      Guid g;
      if (!getGuid(bb, g)) return false;
      a.guid = noneToAbsent(g);
    } else if (f == 2) {
      for (;;) {
        uint32_t r = 0;
        if (!bb.readVarUint(r)) return false;
        if (!r) break;
        if (r == 1) {
          if (!getString(bb, a.key)) return false;
        } else if (r == 2) {
          if (!getString(bb, a.version)) return false;
        } else {
          return false;
        }
      }
    } else {
      return false;
    }
  }
}
// GUIDPath {guids: GUID[]}.
bool getGuidPath(kiwi::ByteBuffer& bb, std::vector<Guid>& path) {
  for (;;) {
    uint32_t f = 0;
    if (!bb.readVarUint(f)) return false;
    if (!f) return true;
    if (f != 1) return false;
    uint32_t n = 0;
    if (!bb.readVarUint(n)) return false;
    for (uint32_t i = 0; i < n; i++) {
      Guid g;
      if (!getGuid(bb, g)) return false;
      path.push_back(g);
    }
  }
}

// ---- writing primitives ----

void putGuid(Out& o, Guid g) {
  o.varuint(g.sessionID);
  o.varuint(g.localID);
}
void putColor(Out& o, const Color& c) {
  o.varfloat(c.r);
  o.varfloat(c.g);
  o.varfloat(c.b);
  o.varfloat(c.a);
}
void putVector(Out& o, Vec2 v) {
  o.varfloat(static_cast<float>(v.x));
  o.varfloat(static_cast<float>(v.y));
}
void putMatrix(Out& o, const Mat2x3& m) {
  o.varfloat(static_cast<float>(m.m00));
  o.varfloat(static_cast<float>(m.m01));
  o.varfloat(static_cast<float>(m.m02));
  o.varfloat(static_cast<float>(m.m10));
  o.varfloat(static_cast<float>(m.m11));
  o.varfloat(static_cast<float>(m.m12));
}
void putNumber(Out& o, const Number& n) {
  o.varfloat(static_cast<float>(n.value));
  o.varuint(static_cast<uint32_t>(n.units));
}
void putFontName(Out& o, const FontName& f) {
  o.str(f.family);
  o.str(f.style);
  o.str(f.postscript);
}
template <typename E>
void putEnum(Out& o, uint32_t id, E v) {
  o.varuint(id);
  o.varuint(static_cast<uint32_t>(v));
}
void putFloat(Out& o, uint32_t id, double v) {
  o.varuint(id);
  o.varfloat(static_cast<float>(v));
}
void putBool(Out& o, uint32_t id, bool v) {
  o.varuint(id);
  o.byte(v ? 1 : 0);
}
void putUint(Out& o, uint32_t id, uint32_t v) {
  o.varuint(id);
  o.varuint(v);
}
void putInt(Out& o, uint32_t id, int32_t v) {
  o.varuint(id);
  o.varint(v);
}
void putString(Out& o, uint32_t id, const std::string& s) {
  o.varuint(id);
  o.str(s);
}
void putGuidField(Out& o, uint32_t id, Guid g) {
  o.varuint(id);
  putGuid(o, g);
}
void putAssetId(Out& o, uint32_t id, const AssetId& a) {
  o.varuint(id);
  if (a.guid != kNoGuid) {
    o.varuint(1);
    putGuid(o, a.guid);
  }
  if (!a.key.empty()) {
    o.varuint(2);
    o.varuint(1);
    o.str(a.key);
    if (!a.version.empty()) {
      o.varuint(2);
      o.str(a.version);
    }
    o.byte(0);
  }
  o.byte(0);
}
void putGuidPath(Out& o, uint32_t id, const std::vector<Guid>& path) {
  o.varuint(id);
  o.varuint(1);
  o.varuint(static_cast<uint32_t>(path.size()));
  for (Guid g : path) putGuid(o, g);
  o.byte(0);
}

// ---- Variables (docs/schema.md §6) ----

bool readAnyValue(kiwi::ByteBuffer& bb, VariableData& d);

// Re-reads a message from `start` into a raw field sequence (`keep` decides what each field becomes) and
// advances `bb` past it. For values the engine doesn't model as a whole (a paint type or variable kind it doesn't
// know): kept verbatim, written back as they came.
template <typename Keep>
bool captureMessage(kiwi::ByteBuffer& bb, size_t start, std::string& whole, Keep&& keep) {
  kiwi::ByteBuffer again(bb.data() + start, bb.size() - start);
  for (;;) {
    uint32_t f = 0;
    if (!again.readVarUint(f)) return false;
    if (!f) break;
    if (!keep(again, f, whole)) return false;
  }
  size_t end = start + again.index();
  while (bb.index() < end) {
    uint8_t b;
    if (!bb.readByte(b)) return false;
  }
  return true;
}

bool readVariableDataInto(kiwi::ByteBuffer& bb, VariableData& d) {
  using K = VariableData::Kind;
  size_t start = bb.index();
  auto other = [&]() {
    // Not a VariableData the engine models: kept whole.
    std::string whole;
    if (!captureMessage(bb, start, whole, [](kiwi::ByteBuffer& b, uint32_t f, std::string& w) { return keepUnknown(b, defs().variableData, f, w); }))
      return false;
    VariableData o;
    o.kind = K::OTHER;
    o.extra = std::move(whole);
    d = std::move(o);
    return true;
  };
  for (;;) {
    uint32_t f = 0;
    if (!bb.readVarUint(f)) return false;
    if (!f) return true;
    switch (f) {
      case 1:
        if (!readAnyValue(bb, d)) return false;
        break;
      case 2:
        if (!getEnum(bb, d.dataType)) return other();
        d.hasDataType = true;
        break;
      case 3:
        if (!getEnum(bb, d.resolvedDataType)) return other();
        d.hasResolvedType = true;
        break;
      default:
        if (!keepUnknown(bb, defs().variableData, f, d.extra)) return false;
    }
  }
}

// Into a boxed binding (paints, effects, grids): left unboxed when it reads as empty.
bool readVariableDataInto(kiwi::ByteBuffer& bb, VarBox& box) {
  VariableData d;
  if (!readVariableDataInto(bb, d)) return false;
  box = std::move(d);
  return true;
}

bool readAnyValue(kiwi::ByteBuffer& bb, VariableData& d) {
  using K = VariableData::Kind;
  for (;;) {
    uint32_t f = 0;
    if (!bb.readVarUint(f)) return false;
    if (!f) return true;
    switch (f) {
      case 1:
        d.kind = K::BOOL;
        if (!getBool(bb, d.boolValue)) return false;
        break;
      case 2:
        d.kind = K::TEXT;
        if (!getString(bb, d.textValue)) return false;
        break;
      case 3:
        d.kind = K::FLOAT;
        if (!getFloat(bb, d.floatValue)) return false;
        break;
      case 4:
        d.kind = K::ALIAS;
        if (!getAssetId(bb, d.alias)) return false;
        break;
      case 5:
        d.kind = K::COLOR;
        if (!getColor(bb, d.colorValue)) return false;
        break;
      case 6: {  // Expression {expressionFunction, expressionArguments}
        d.kind = K::EXPRESSION;
        for (;;) {
          uint32_t e = 0;
          if (!bb.readVarUint(e)) return false;
          if (!e) break;
          if (e == 1) {
            if (!getEnum(bb, d.function)) return false;
          } else if (e == 2) {
            uint32_t n = 0;
            if (!bb.readVarUint(n)) return false;
            for (uint32_t i = 0; i < n; i++) {
              VariableData arg;
              if (!readVariableDataInto(bb, arg)) return false;
              d.args.push_back(std::move(arg));
            }
          } else {
            return false;
          }
        }
        break;
      }
      case 7: {  // VariableMap {values: [VariableMapValue {key, value, guidKey}]}
        d.kind = K::MAP;
        for (;;) {
          uint32_t e = 0;
          if (!bb.readVarUint(e)) return false;
          if (!e) break;
          if (e != 1) return false;
          uint32_t n = 0;
          if (!bb.readVarUint(n)) return false;
          for (uint32_t i = 0; i < n; i++) {
            std::string key;
            Guid guidKey = kNoGuid;
            VariableData value;
            for (;;) {
              uint32_t h = 0;
              if (!bb.readVarUint(h)) return false;
              if (!h) break;
              if (h == 1) {
                if (!getString(bb, key)) return false;
              } else if (h == 2) {
                if (!readVariableDataInto(bb, value)) return false;
              } else if (h == 3) {
                if (!getGuid(bb, guidKey)) return false;
                guidKey = noneToAbsent(guidKey);
              } else {
                return false;
              }
            }
            d.mapKeys.push_back(std::move(key));
            d.mapGuidKeys.push_back(guidKey);
            d.args.push_back(std::move(value));
          }
        }
        break;
      }
      case 9: {  // VariableFontStyle {asString, asFloat, asVariations}
        d.kind = K::FONT_STYLE;
        d.args.assign(3, VariableData{});
        for (;;) {
          uint32_t e = 0;
          if (!bb.readVarUint(e)) return false;
          if (!e) break;
          if (e < 1 || e > 3) return false;
          if (!readVariableDataInto(bb, d.args[e - 1])) return false;
        }
        while (!d.args.empty() && !d.args.back().present()) d.args.pop_back();
        break;
      }
      case 13: {  // PropRefValue {defId}
        d.kind = K::PROP_REF;
        for (;;) {
          uint32_t e = 0;
          if (!bb.readVarUint(e)) return false;
          if (!e) break;
          if (e != 1) return false;
          Guid g;
          if (!getGuid(bb, g)) return false;
          d.propRef = noneToAbsent(g);
        }
        break;
      }
      case 18: {  // SlotContentId {guid}
        d.kind = K::SLOT_CONTENT;
        for (;;) {
          uint32_t e = 0;
          if (!bb.readVarUint(e)) return false;
          if (!e) break;
          if (e != 1) return false;
          Guid g;
          if (!getGuid(bb, g)) return false;
          d.slotContent = noneToAbsent(g);
        }
        break;
      }
      default:
        if (!keepUnknown(bb, defs().anyValue, f, d.valueExtra)) return false;
    }
  }
}

void putVariableData(Out& o, const VariableData& d);

void putAnyValue(Out& o, const VariableData& d) {
  using K = VariableData::Kind;
  switch (d.kind) {
    case K::BOOL: putBool(o, 1, d.boolValue); break;
    case K::TEXT: putString(o, 2, d.textValue); break;
    case K::FLOAT: putFloat(o, 3, d.floatValue); break;
    case K::ALIAS: putAssetId(o, 4, d.alias); break;
    case K::COLOR:
      o.varuint(5);
      putColor(o, d.colorValue);
      break;
    case K::EXPRESSION:
      o.varuint(6);
      putEnum(o, 1, d.function);
      o.varuint(2);
      o.varuint(static_cast<uint32_t>(d.args.size()));
      for (const VariableData& a : d.args) putVariableData(o, a);
      o.byte(0);
      break;
    case K::MAP:
      o.varuint(7);
      o.varuint(1);
      o.varuint(static_cast<uint32_t>(d.args.size()));
      for (size_t i = 0; i < d.args.size(); i++) {
        if (i < d.mapKeys.size()) putString(o, 1, d.mapKeys[i]);
        o.varuint(2);
        putVariableData(o, d.args[i]);
        if (i < d.mapGuidKeys.size() && d.mapGuidKeys[i] != kNoGuid) putGuidField(o, 3, d.mapGuidKeys[i]);
        o.byte(0);
      }
      o.byte(0);
      break;
    case K::FONT_STYLE:
      o.varuint(9);
      for (size_t i = 0; i < d.args.size() && i < 3; i++)
        if (d.args[i].present()) {
          o.varuint(static_cast<uint32_t>(i + 1));
          putVariableData(o, d.args[i]);
        }
      o.byte(0);
      break;
    case K::PROP_REF:
      o.varuint(13);
      putGuidField(o, 1, d.propRef);
      o.byte(0);
      break;
    case K::SLOT_CONTENT:
      o.varuint(18);
      if (d.slotContent != kNoGuid) putGuidField(o, 1, d.slotContent);
      o.byte(0);
      break;
    default: break;
  }
  o.raw(d.valueExtra);
}

void putVariableData(Out& o, const VariableData& d) {
  using K = VariableData::Kind;
  if (d.kind == K::OTHER) {
    o.raw(d.extra);
    o.byte(0);
    return;
  }
  if (d.kind != K::NONE || !d.valueExtra.empty()) {
    o.varuint(1);
    putAnyValue(o, d);
    o.byte(0);
  }
  if (d.hasDataType) putEnum(o, 2, d.dataType);
  if (d.hasResolvedType) putEnum(o, 3, d.resolvedDataType);
  o.raw(d.extra);
  o.byte(0);
}

// A PROP_REF binding as Figma writes it: {value: {propRefValue: {defId}}, dataType: PROP_REF, resolvedDataType}.
void putPropRef(Out& o, const ParamBinding& b) {
  VariableResolvedType resolved = b.field == VariableField::VISIBLE               ? VariableResolvedType::BOOLEAN
                                  : b.field == VariableField::TEXT_DATA           ? VariableResolvedType::TEXT_DATA
                                  : b.field == VariableField::OVERRIDDEN_SYMBOL_ID ? VariableResolvedType::SYMBOL_ID
                                  : b.field == VariableField::SLOT_CONTENT_ID     ? VariableResolvedType::SLOT_CONTENT_ID
                                                                                  : VariableResolvedType::STRING;
  o.varuint(1);
  o.varuint(13);
  putGuidField(o, 1, b.propRef);
  o.byte(0);
  o.byte(0);
  putEnum(o, 2, VariableDataType::PROP_REF);
  putEnum(o, 3, resolved);
  o.byte(0);
}

// ---- Paints, effects, grids ----

bool readPaintInto(kiwi::ByteBuffer& bb, Paint& p, KiwiBlobs* blobs) {
  size_t start = bb.index();
  struct StopVar {
    ColorStop stop;
    VariableData var;
  };
  std::vector<StopVar> stopVars;
  bool hasStopVars = false;
  bool imageData = false;
  uint32_t imageBlob = 0;
  for (;;) {
    uint32_t f = 0;
    if (!bb.readVarUint(f)) return false;
    if (!f) break;
    switch (f) {
      case 1: {
        uint32_t t = 0;
        if (!bb.readVarUint(t)) return false;
        if (t <= 5 || (t >= 7 && t <= 9)) {
          p.type = static_cast<PaintType>(t);
          break;
        }
        // A paint type the schema doesn't know: kept whole (its visibility read, so it can be hidden).
        std::string whole;
        if (!captureMessage(bb, start, whole, [&](kiwi::ByteBuffer& b, uint32_t g, std::string& w) {
              if (g == 4) {
                if (!getBool(b, p.visible)) return false;
                schema::insertField(defs().paint, w, 4, std::string_view(p.visible ? "\x01" : "\x00", 1));
                return true;
              }
              return keepUnknown(b, defs().paint, g, w);
            }))
          return false;
        p.type = PaintType::OTHER;
        p.extra = std::move(whole);
        return true;
      }
      case 2:
        if (!getColor(bb, p.color)) return false;
        break;
      case 3:
        if (!getFloat(bb, p.opacity)) return false;
        break;
      case 4:
        if (!getBool(bb, p.visible)) return false;
        break;
      case 5:
        if (!getEnum(bb, p.blendMode)) return false;
        break;
      case 6: {
        uint32_t n = 0;
        if (!bb.readVarUint(n)) return false;
        p.stops.clear();
        for (uint32_t i = 0; i < n; i++) {
          ColorStop cs;
          if (!getColor(bb, cs.color) || !getFloat(bb, cs.position)) return false;
          p.stops.push_back(cs);
        }
        break;
      }
      case 7:
        if (!getMatrix(bb, p.transform)) return false;
        break;
      case 8: {  // Image {hash, name, dataBlob}
        for (;;) {
          uint32_t g = 0;
          if (!bb.readVarUint(g)) return false;
          if (!g) break;
          if (g == 1) {
            uint32_t n = 0;
            if (!bb.readVarUint(n)) return false;
            if (n == 20) {
              for (int i = 0; i < 20; i++)
                if (!bb.readByte(p.image.bytes[static_cast<size_t>(i)])) return false;
              p.image.present = true;
            } else {
              for (uint32_t i = 0; i < n; i++) {
                uint8_t b;
                if (!bb.readByte(b)) return false;
              }
            }
          } else if (g == 2) {
            if (!getString(bb, p.imageName)) return false;
          } else if (g == 3) {
            if (!bb.readVarUint(imageBlob)) return false;
            imageData = true;
          } else {
            return false;
          }
        }
        break;
      }
      case 10:
        if (!getEnum(bb, p.imageScaleMode)) return false;
        break;
      case 11:
        if (!getFloat(bb, p.rotation)) return false;
        break;
      case 12:
        if (!getFloat(bb, p.scale)) return false;
        break;
      case 14: {  // PaintFilterMessage
        PaintFilter& pf = p.paintFilter;
        float* slots[] = {nullptr, &pf.tint, &pf.shadows, &pf.highlights, &pf.detail, &pf.exposure, &pf.vignette, &pf.temperature,
                          &pf.vibrance, &pf.contrast, &pf.brightness};
        for (;;) {
          uint32_t g = 0;
          if (!bb.readVarUint(g)) return false;
          if (!g) break;
          if (g < 1 || g > 10) return false;
          if (!getFloat(bb, *slots[g])) return false;
        }
        break;
      }
      case 19:
        if (!bb.readVarUint(p.originalImageWidth)) return false;
        break;
      case 20:
        if (!bb.readVarUint(p.originalImageHeight)) return false;
        break;
      case 21:
        if (!readVariableDataInto(bb, p.colorVar)) return false;
        break;
      case 23: {  // ColorStopVar[] {color, colorVar, position}
        uint32_t n = 0;
        if (!bb.readVarUint(n)) return false;
        hasStopVars = true;
        for (uint32_t i = 0; i < n; i++) {
          StopVar sv;
          for (;;) {
            uint32_t g = 0;
            if (!bb.readVarUint(g)) return false;
            if (!g) break;
            if (g == 1) {
              if (!getColor(bb, sv.stop.color)) return false;
            } else if (g == 2) {
              if (!readVariableDataInto(bb, sv.var)) return false;
            } else if (g == 3) {
              if (!getFloat(bb, sv.stop.position)) return false;
            } else {
              return false;
            }
          }
          stopVars.push_back(std::move(sv));
        }
        break;
      }
      case 38:
        if (!readVariableDataInto(bb, p.opacityVar)) return false;
        break;
      default:
        if (!keepUnknown(bb, defs().paint, f, p.extra)) return false;
    }
  }
  if (hasStopVars) {
    // Each stop's binding (index-aligned with `stops`); the stops themselves come from here when `stops` is absent.
    bool fill = p.stops.empty();
    for (StopVar& sv : stopVars) {
      p.stopVars.push_back(std::move(sv.var));
      if (fill) p.stops.push_back(sv.stop);
    }
    while (!p.stopVars.empty() && !p.stopVars.back().present()) p.stopVars.pop_back();
  }
  if (imageData && blobs && p.image.present) blobs->deferImage(p.image, imageBlob);
  return true;
}

void putPaint(Out& o, const Paint& p, BlobsOut* /*blobs*/) {
  if (p.type == PaintType::OTHER) {
    o.raw(p.extra);
    o.byte(0);
    return;
  }
  putEnum(o, 1, p.type);
  if (p.type == PaintType::SOLID || !(p.color == Color{})) {
    o.varuint(2);
    putColor(o, p.color);
  }
  putFloat(o, 3, p.opacity);
  putBool(o, 4, p.visible);
  if (p.blendMode != BlendMode::NORMAL) putEnum(o, 5, p.blendMode);
  if (!p.stops.empty()) {
    o.varuint(6);
    o.varuint(static_cast<uint32_t>(p.stops.size()));
    for (const ColorStop& st : p.stops) {
      putColor(o, st.color);
      o.varfloat(static_cast<float>(st.position));
    }
  }
  if (p.type != PaintType::SOLID) {
    o.varuint(7);
    putMatrix(o, p.transform);
  }
  if (p.image.present || !p.imageName.empty()) {
    o.varuint(8);
    if (p.image.present) {
      o.varuint(1);
      o.varuint(20);
      o.bytes(p.image.bytes.data(), 20);
    }
    if (!p.imageName.empty()) putString(o, 2, p.imageName);
    o.byte(0);
  }
  if ((isImageLike(p.type) || p.type == PaintType::PATTERN) && p.scale != 1) putFloat(o, 12, p.scale);  // TILE / pattern "Scale"
  if (isImageLike(p.type)) {
    putEnum(o, 10, p.imageScaleMode);
    if (p.rotation != 0) putFloat(o, 11, p.rotation);
    if (p.originalImageWidth) putUint(o, 19, p.originalImageWidth);
    if (p.originalImageHeight) putUint(o, 20, p.originalImageHeight);
  }
  if (p.paintFilter.any()) {
    const PaintFilter& f = p.paintFilter;
    const float values[] = {f.tint, f.shadows, f.highlights, f.detail, f.exposure, f.vignette, f.temperature, f.vibrance, f.contrast, f.brightness};
    o.varuint(14);
    for (uint32_t i = 0; i < 10; i++)
      if (values[i] != 0) putFloat(o, i + 1, values[i]);
    o.byte(0);
  }
  if (p.colorVar.present()) {
    o.varuint(21);
    putVariableData(o, p.colorVar);
  }
  bool stopVars = false;
  for (const VariableData& v : p.stopVars) stopVars |= v.present();
  if (stopVars) {
    o.varuint(23);
    o.varuint(static_cast<uint32_t>(p.stops.size()));
    for (size_t i = 0; i < p.stops.size(); i++) {
      o.varuint(1);
      putColor(o, p.stops[i].color);
      if (i < p.stopVars.size() && p.stopVars[i].present()) {
        o.varuint(2);
        putVariableData(o, p.stopVars[i]);
      }
      putFloat(o, 3, p.stops[i].position);
      o.byte(0);
    }
  }
  if (p.opacityVar.present()) {
    o.varuint(38);
    putVariableData(o, p.opacityVar);
  }
  o.raw(p.extra);
  o.byte(0);
}

bool readPaints(kiwi::ByteBuffer& bb, std::vector<Paint>& out, KiwiBlobs* blobs) {
  uint32_t n = 0;
  if (!bb.readVarUint(n)) return false;
  out.clear();
  out.reserve(n);
  for (uint32_t i = 0; i < n; i++) {
    Paint p;
    if (!readPaintInto(bb, p, blobs)) return false;
    out.push_back(std::move(p));
  }
  return true;
}

void putPaints(Out& o, uint32_t id, const std::vector<Paint>& paints, BlobsOut* blobs) {
  o.varuint(id);
  o.varuint(static_cast<uint32_t>(paints.size()));
  for (const Paint& p : paints) putPaint(o, p, blobs);
}

bool readEffect(kiwi::ByteBuffer& bb, Effect& e) {
  for (;;) {
    uint32_t f = 0;
    if (!bb.readVarUint(f)) return false;
    if (!f) return true;
    switch (f) {
      case 1:
        if (!getEnum(bb, e.type)) return false;
        break;
      case 2:
        if (!getColor(bb, e.color)) return false;
        break;
      case 3:
        if (!getVector(bb, e.offset)) return false;
        break;
      case 4:
        if (!getFloat(bb, e.radius)) return false;
        break;
      case 5:
        if (!getBool(bb, e.visible)) return false;
        break;
      case 6:
        if (!getEnum(bb, e.blendMode)) return false;
        break;
      case 7:
        if (!getFloat(bb, e.spread)) return false;
        break;
      case 8:
        if (!getBool(bb, e.showShadowBehindNode)) return false;
        break;
      case 9:
        if (!readVariableDataInto(bb, e.radiusVar)) return false;
        break;
      case 10:
        if (!readVariableDataInto(bb, e.colorVar)) return false;
        break;
      case 11:
        if (!readVariableDataInto(bb, e.spreadVar)) return false;
        break;
      case 12:
        if (!readVariableDataInto(bb, e.xVar)) return false;
        break;
      case 13:
        if (!readVariableDataInto(bb, e.yVar)) return false;
        break;
      default:
        if (!keepUnknown(bb, defs().effect, f, e.extra)) return false;
    }
  }
}

void putEffect(Out& o, const Effect& e) {
  putEnum(o, 1, e.type);
  o.varuint(2);
  putColor(o, e.color);
  o.varuint(3);
  putVector(o, e.offset);
  putFloat(o, 4, e.radius);
  putBool(o, 5, e.visible);
  putEnum(o, 6, e.blendMode);
  putFloat(o, 7, e.spread);
  putBool(o, 8, e.showShadowBehindNode);
  const VariableData* vars[] = {&e.radiusVar.get(), &e.colorVar.get(), &e.spreadVar.get(), &e.xVar.get(), &e.yVar.get()};
  for (uint32_t i = 0; i < 5; i++)
    if (vars[i]->present()) {
      o.varuint(9 + i);
      putVariableData(o, *vars[i]);
    }
  o.raw(e.extra);
  o.byte(0);
}

bool readLayoutGrid(kiwi::ByteBuffer& bb, LayoutGrid& g) {
  for (;;) {
    uint32_t f = 0;
    if (!bb.readVarUint(f)) return false;
    if (!f) return true;
    switch (f) {
      case 1:
        if (!getEnum(bb, g.type)) return false;
        break;
      case 2:
        if (!getEnum(bb, g.axis)) return false;
        break;
      case 3:
        if (!getBool(bb, g.visible)) return false;
        break;
      case 4:
        if (!bb.readVarInt(g.numSections)) return false;
        break;
      case 5:
        if (!getFloat(bb, g.offset)) return false;
        break;
      case 6:
        if (!getFloat(bb, g.sectionSize)) return false;
        break;
      case 7:
        if (!getFloat(bb, g.gutterSize)) return false;
        break;
      case 8:
        if (!getColor(bb, g.color)) return false;
        break;
      case 9:
        if (!getEnum(bb, g.pattern)) return false;
        break;
      case 10:
        if (!readVariableDataInto(bb, g.numSectionsVar)) return false;
        break;
      case 11:
        if (!readVariableDataInto(bb, g.offsetVar)) return false;
        break;
      case 12:
        if (!readVariableDataInto(bb, g.sectionSizeVar)) return false;
        break;
      case 13:
        if (!readVariableDataInto(bb, g.gutterSizeVar)) return false;
        break;
      default:
        if (!keepUnknown(bb, defs().layoutGrid, f, g.extra)) return false;
    }
  }
}

void putLayoutGrid(Out& o, const LayoutGrid& g) {
  putEnum(o, 1, g.type);
  putEnum(o, 2, g.axis);
  putBool(o, 3, g.visible);
  putInt(o, 4, g.numSections);
  putFloat(o, 5, g.offset);
  putFloat(o, 6, g.sectionSize);
  putFloat(o, 7, g.gutterSize);
  o.varuint(8);
  putColor(o, g.color);
  putEnum(o, 9, g.pattern);
  const VariableData* vars[] = {&g.numSectionsVar.get(), &g.offsetVar.get(), &g.sectionSizeVar.get(), &g.gutterSizeVar.get()};
  for (uint32_t i = 0; i < 4; i++)
    if (vars[i]->present()) {
      o.varuint(10 + i);
      putVariableData(o, *vars[i]);
    }
  o.raw(g.extra);
  o.byte(0);
}

// ---- Text ----

bool readFieldsInto(kiwi::ByteBuffer& bb, NodeProps& p, FieldMask& m, bool update, KiwiBlobs* blobs, int mode, Guid* guid,
                    Phase* phase, std::vector<Guid>* guidPath, uint32_t* styleID, bool* sawGuidPath, DerivedSink* derived);

enum Mode { kNodeMode = 0, kTextRunMode = 1, kVectorStyleMode = 2 };

bool readTextStyle(kiwi::ByteBuffer& bb, TextStyle& st, KiwiBlobs* blobs) {
  for (;;) {
    uint32_t f = 0;
    if (!bb.readVarUint(f)) return false;
    if (!f) return true;
    switch (f) {
      case id::kStyleID:
        if (!bb.readVarUint(st.styleID)) return false;
        break;
      case 41:
        if (!getFontName(bb, st.fontName)) return false;
        st.mask |= R_FONT_NAME;
        break;
      case 21:
        if (!getFloat(bb, st.fontSize)) return false;
        st.mask |= R_FONT_SIZE;
        break;
      case 40:
        if (!getNumber(bb, st.lineHeight)) return false;
        st.mask |= R_LINE_HEIGHT;
        break;
      case 165:
        if (!getNumber(bb, st.letterSpacing)) return false;
        st.mask |= R_LETTER_SPACING;
        break;
      case 34:
        if (getEnum(bb, st.textCase)) st.mask |= R_TEXT_CASE;
        break;
      case 35:
        if (getEnum(bb, st.textDecoration)) st.mask |= R_TEXT_DECORATION;
        break;
      case 38:
        if (!readPaints(bb, st.fillPaints, blobs)) return false;
        st.mask |= R_FILLS;
        break;
      case id::kGuid:
      case id::kPhase:
        if (!skipUnknown(bb, defs().nodeChange, f)) return false;
        break;
      default:
        if (!keepUnknown(bb, defs().nodeChange, f, st.extra)) return false;
    }
  }
}

void putTextStyle(Out& o, const TextStyle& st, BlobsOut* blobs) {
  putUint(o, id::kStyleID, st.styleID);
  if (st.mask & R_FONT_NAME) {
    o.varuint(41);
    putFontName(o, st.fontName);
  }
  if (st.mask & R_FONT_SIZE) putFloat(o, 21, st.fontSize);
  if (st.mask & R_LINE_HEIGHT) {
    o.varuint(40);
    putNumber(o, st.lineHeight);
  }
  if (st.mask & R_LETTER_SPACING) {
    o.varuint(165);
    putNumber(o, st.letterSpacing);
  }
  if (st.mask & R_TEXT_CASE) putEnum(o, 34, st.textCase);
  if (st.mask & R_TEXT_DECORATION) putEnum(o, 35, st.textDecoration);
  if (st.mask & R_FILLS) putPaints(o, 38, st.fillPaints, blobs);
  o.raw(st.extra);
  o.byte(0);
}

bool readTextData(kiwi::ByteBuffer& bb, TextData& t, KiwiBlobs* blobs) {
  for (;;) {
    uint32_t f = 0;
    if (!bb.readVarUint(f)) return false;
    if (!f) return true;
    switch (f) {
      case 1:
        if (!getString(bb, t.characters)) return false;
        break;
      case 2: {
        uint32_t n = 0;
        if (!bb.readVarUint(n)) return false;
        t.characterStyleIDs.clear();
        t.characterStyleIDs.reserve(n);
        for (uint32_t i = 0; i < n; i++) {
          uint32_t v = 0;
          if (!bb.readVarUint(v)) return false;
          t.characterStyleIDs.push_back(v);
        }
        while (!t.characterStyleIDs.empty() && t.characterStyleIDs.back() == 0) t.characterStyleIDs.pop_back();
        break;
      }
      case 3: {
        uint32_t n = 0;
        if (!bb.readVarUint(n)) return false;
        for (uint32_t i = 0; i < n; i++) {
          TextStyle st;
          if (!readTextStyle(bb, st, blobs)) return false;
          t.styleOverrideTable.push_back(std::move(st));
        }
        break;
      }
      case 12: {  // TextLineData[]: each line kept as its raw field sequence
        uint32_t n = 0;
        if (!bb.readVarUint(n)) return false;
        for (uint32_t i = 0; i < n; i++) {
          std::string line;
          for (;;) {
            uint32_t g = 0;
            if (!bb.readVarUint(g)) return false;
            if (!g) break;
            if (!keepUnknown(bb, defs().textLine, g, line)) return false;
          }
          t.lines.push_back(std::move(line));
        }
        break;
      }
      default:
        // Reserved numbers only: nothing to keep (TextData has no extra).
        if (!skipUnknown(bb, defOf("TextData"), f)) return false;
    }
  }
}

void putTextData(Out& o, const TextData& t, BlobsOut* blobs) {
  putString(o, 1, t.characters);
  if (!t.characterStyleIDs.empty()) {
    o.varuint(2);
    o.varuint(static_cast<uint32_t>(t.characterStyleIDs.size()));
    for (uint32_t v : t.characterStyleIDs) o.varuint(v);
  }
  if (!t.styleOverrideTable.empty()) {
    o.varuint(3);
    o.varuint(static_cast<uint32_t>(t.styleOverrideTable.size()));
    for (const TextStyle& st : t.styleOverrideTable) putTextStyle(o, st, blobs);
  }
  if (!t.lines.empty()) {
    o.varuint(12);
    o.varuint(static_cast<uint32_t>(t.lines.size()));
    for (const std::string& l : t.lines) {
      o.raw(l);
      o.byte(0);
    }
  }
  o.byte(0);
}

// ---- Vectors ----

bool readVectorStyle(kiwi::ByteBuffer& bb, VectorStyle& st, KiwiBlobs* blobs) {
  for (;;) {
    uint32_t f = 0;
    if (!bb.readVarUint(f)) return false;
    if (!f) return true;
    switch (f) {
      case id::kStyleID:
        if (!bb.readVarUint(st.styleID)) return false;
        break;
      case 38:
        if (!readPaints(bb, st.fillPaints, blobs)) return false;
        st.mask |= VS_FILLS;
        break;
      case 30:
        if (getEnum(bb, st.strokeCap)) st.mask |= VS_STROKE_CAP;
        break;
      case 31:
        if (getEnum(bb, st.strokeJoin)) st.mask |= VS_STROKE_JOIN;
        break;
      case 44:
        if (getEnum(bb, st.handleMirroring)) st.mask |= VS_MIRRORING;
        break;
      case 20:
        if (!getFloat(bb, st.cornerRadius)) return false;
        st.mask |= VS_CORNER_RADIUS;
        break;
      case id::kGuid:
      case id::kPhase:
        if (!skipUnknown(bb, defs().nodeChange, f)) return false;
        break;
      default:
        if (!keepUnknown(bb, defs().nodeChange, f, st.extra)) return false;
    }
  }
}

void putVectorStyle(Out& o, const VectorStyle& st, BlobsOut* blobs) {
  putUint(o, id::kStyleID, st.styleID);
  if (st.mask & VS_FILLS) putPaints(o, 38, st.fillPaints, blobs);
  if (st.mask & VS_STROKE_CAP) putEnum(o, 30, st.strokeCap);
  if (st.mask & VS_STROKE_JOIN) putEnum(o, 31, st.strokeJoin);
  if (st.mask & VS_MIRRORING) putEnum(o, 44, st.handleMirroring);
  if (st.mask & VS_CORNER_RADIUS) putFloat(o, 20, st.cornerRadius);
  o.raw(st.extra);
  o.byte(0);
}

bool readVectorData(kiwi::ByteBuffer& bb, VectorData& d, KiwiBlobs* blobs) {
  d.present = true;
  for (;;) {
    uint32_t f = 0;
    if (!bb.readVarUint(f)) return false;
    if (!f) return true;
    switch (f) {
      case 1: {
        uint32_t index = 0;
        if (!bb.readVarUint(index)) return false;
        if (blobs) d.network = blobs->get(index);
        break;
      }
      case 2:
        if (!getVector(bb, d.normalizedSize)) return false;
        break;
      case 3: {
        uint32_t n = 0;
        if (!bb.readVarUint(n)) return false;
        for (uint32_t i = 0; i < n; i++) {
          VectorStyle st;
          if (!readVectorStyle(bb, st, blobs)) return false;
          d.styleOverrideTable.push_back(std::move(st));
        }
        break;
      }
      default:
        if (!skipUnknown(bb, defOf("VectorData"), f)) return false;
    }
  }
}

void putVectorData(Out& o, const VectorData& v, BlobsOut* blobs) {
  if (v.network && blobs) putUint(o, 1, blobs->add(v.network));
  o.varuint(2);
  putVector(o, v.normalizedSize);
  if (!v.styleOverrideTable.empty()) {
    o.varuint(3);
    o.varuint(static_cast<uint32_t>(v.styleOverrideTable.size()));
    for (const VectorStyle& st : v.styleOverrideTable) putVectorStyle(o, st, blobs);
  }
  o.byte(0);
}

// ---- Components ----

bool readPropValue(kiwi::ByteBuffer& bb, ComponentPropValue& v, KiwiBlobs* blobs) {
  for (;;) {
    uint32_t f = 0;
    if (!bb.readVarUint(f)) return false;
    if (!f) return true;
    switch (f) {
      case 1:
        v.hasBool = true;
        if (!getBool(bb, v.boolValue)) return false;
        break;
      case 2:
        v.hasText = true;
        if (!readTextData(bb, v.textValue, blobs)) return false;
        break;
      case 3: {
        Guid g;
        if (!getGuid(bb, g)) return false;
        v.guidValue = g;
        break;
      }
      default:
        if (!keepUnknown(bb, defs().propValue, f, v.extra)) return false;
    }
  }
}

void putPropValue(Out& o, const ComponentPropValue& v, BlobsOut* blobs) {
  if (v.hasBool) putBool(o, 1, v.boolValue);
  if (v.hasText) {
    o.varuint(2);
    putTextData(o, v.textValue, blobs);
  }
  if (v.guidValue != kNoGuid) putGuidField(o, 3, v.guidValue);
  o.raw(v.extra);
  o.byte(0);
}

// A varValue (ComponentPropDef 9, ComponentPropAssignment 3): a binding to a variable (an alias) is modelled; any other
// value (Figma mirrors every property value there) stays kiwi bytes in `extra`.
bool readVarValue(kiwi::ByteBuffer& bb, const Def& def, uint32_t f, VariableData& bound, std::string& extra) {
  size_t start = bb.index();
  kiwi::ByteBuffer peek(bb.data() + start, bb.size() - start);
  VariableData d;
  if (readVariableDataInto(peek, d) && d.kind == VariableData::Kind::ALIAS) return readVariableDataInto(bb, bound);
  return keepUnknown(bb, def, f, extra);
}

// `extra` without its varValue when the value is bound (the binding is written instead).
void putExtraAndBound(Out& o, const Def& def, uint32_t f, const VariableData& bound, const std::string& extra) {
  if (!bound.present()) {
    o.raw(extra);
    return;
  }
  std::string rest = extra;
  schema::eraseField(def, rest, f);
  o.raw(rest);
  o.varuint(f);
  putVariableData(o, bound);
}

bool readPropDef(kiwi::ByteBuffer& bb, ComponentPropDef& d, KiwiBlobs* blobs) {
  for (;;) {
    uint32_t f = 0;
    if (!bb.readVarUint(f)) return false;
    if (!f) return true;
    switch (f) {
      case 1:
        if (!getGuid(bb, d.id)) return false;
        break;
      case 2:
        if (!getString(bb, d.name)) return false;
        break;
      case 3:
        if (!readPropValue(bb, d.initialValue, blobs)) return false;
        break;
      case 4:
        if (!getString(bb, d.sortPosition)) return false;
        break;
      case 6:
        if (!getEnum(bb, d.type)) {
        }
        break;
      case 8: {  // ComponentPropPreferredValues {stringValues, instanceSwapValues}
        for (;;) {
          uint32_t g = 0;
          if (!bb.readVarUint(g)) return false;
          if (!g) break;
          if (g == 2) {
            uint32_t n = 0;
            if (!bb.readVarUint(n)) return false;
            for (uint32_t i = 0; i < n; i++) {
              PreferredValue pv;
              for (;;) {
                uint32_t h = 0;
                if (!bb.readVarUint(h)) return false;
                if (!h) break;
                if (h == 1) {
                  uint32_t t = 0;
                  if (!bb.readVarUint(t)) return false;
                  pv.stateGroup = t == 1;
                } else if (h == 2) {
                  if (!getString(bb, pv.key)) return false;
                } else {
                  return false;
                }
              }
              d.preferredValues.push_back(std::move(pv));
            }
          } else if (!keepUnknown(bb, defs().preferredValues, g, d.preferredExtra)) {
            return false;
          }
        }
        break;
      }
      case 11:
        if (!getString(bb, d.description)) return false;
        break;
      case 9:
        if (!readVarValue(bb, defs().propDef, f, d.boundValue, d.extra)) return false;
        break;
      default:
        if (!keepUnknown(bb, defs().propDef, f, d.extra)) return false;
    }
  }
}

void putPropDef(Out& o, const ComponentPropDef& d, BlobsOut* blobs) {
  putGuidField(o, 1, d.id);
  putString(o, 2, d.name);
  o.varuint(3);
  putPropValue(o, d.initialValue, blobs);
  if (!d.sortPosition.empty()) putString(o, 4, d.sortPosition);
  putEnum(o, 6, d.type);
  if (!d.preferredValues.empty() || !d.preferredExtra.empty()) {
    o.varuint(8);
    o.raw(d.preferredExtra);
    if (!d.preferredValues.empty()) {
      o.varuint(2);
      o.varuint(static_cast<uint32_t>(d.preferredValues.size()));
      for (const PreferredValue& v : d.preferredValues) {
        putUint(o, 1, v.stateGroup ? 1 : 0);
        putString(o, 2, v.key);
        o.byte(0);
      }
    }
    o.byte(0);
  }
  if (!d.description.empty()) putString(o, 11, d.description);
  putExtraAndBound(o, defs().propDef, 9, d.boundValue, d.extra);
  o.byte(0);
}

bool readPropAssignment(kiwi::ByteBuffer& bb, ComponentPropAssignment& a, KiwiBlobs* blobs) {
  for (;;) {
    uint32_t f = 0;
    if (!bb.readVarUint(f)) return false;
    if (!f) return true;
    switch (f) {
      case 1:
        if (!getGuid(bb, a.defID)) return false;
        break;
      case 2:
        if (!readPropValue(bb, a.value, blobs)) return false;
        break;
      case 3:
        if (!readVarValue(bb, defs().propAssignment, f, a.boundValue, a.extra)) return false;
        break;
      default:
        if (!keepUnknown(bb, defs().propAssignment, f, a.extra)) return false;
    }
  }
}

void putPropAssignment(Out& o, const ComponentPropAssignment& a, BlobsOut* blobs) {
  putGuidField(o, 1, a.defID);
  o.varuint(2);
  putPropValue(o, a.value, blobs);
  putExtraAndBound(o, defs().propAssignment, 3, a.boundValue, a.extra);
  o.byte(0);
}

// VariableDataMap {entries: [{variableData = 2, variableField = 3}]}
bool readParamMap(kiwi::ByteBuffer& bb, std::vector<ParamBinding>& out) {
  for (;;) {
    uint32_t f = 0;
    if (!bb.readVarUint(f)) return false;
    if (!f) return true;
    if (f != 1) return false;
    uint32_t n = 0;
    if (!bb.readVarUint(n)) return false;
    for (uint32_t i = 0; i < n; i++) {
      ParamBinding b;
      VariableData data;
      bool hasData = false;
      for (;;) {
        uint32_t g = 0;
        if (!bb.readVarUint(g)) return false;
        if (!g) break;
        if (g == 2) {
          hasData = true;
          if (!readVariableDataInto(bb, data)) return false;
        } else if (g == 3) {
          uint32_t v = 0;
          if (!bb.readVarUint(v)) return false;
          if (v < EnumNames<VariableField>::count && EnumNames<VariableField>::names[v][0]) b.field = static_cast<VariableField>(v);
        } else {
          return false;
        }
      }
      if (hasData) {
        if (data.kind == VariableData::Kind::PROP_REF && data.hasDataType && data.dataType == VariableDataType::PROP_REF &&
            data.propRef != kNoGuid)
          b.propRef = data.propRef;
        else
          b.data = std::move(data);
      }
      out.push_back(std::move(b));
    }
  }
}

void putParamMap(Out& o, uint32_t fieldId, const std::vector<ParamBinding>& map) {
  o.varuint(fieldId);
  o.varuint(1);
  o.varuint(static_cast<uint32_t>(map.size()));
  for (const ParamBinding& b : map) {
    if (b.propRef != kNoGuid) {
      o.varuint(2);
      putPropRef(o, b);
    } else if (b.data.present()) {
      o.varuint(2);
      putVariableData(o, b.data);
    }
    putEnum(o, 3, b.field);
    o.byte(0);
  }
  o.byte(0);
}

// ---- NodeChange fields ----

// Reads one NodeChange message's fields into `p` / `m`. `mode`: a node (overrides included), a text run or a vector
// style. `guid` / `phase` / `guidPath` / `styleID` receive the identity fields when given.
bool readFieldsInto(kiwi::ByteBuffer& bb, NodeProps& p, FieldMask& m, bool update, KiwiBlobs* blobs, int mode, Guid* guid,
                    Phase* phase, std::vector<Guid>* guidPath, uint32_t* styleID, bool* sawGuidPath, DerivedSink* derived) {
  (void)mode;
  // Corner radii and border weights come as several fields: combined after the loop.
  bool hasUniform = false, cornersIndependentFalse = false;
  double uniform = 0;
  bool hasCorner[4] = {false, false, false, false};
  double corner[4] = {0, 0, 0, 0};
  std::vector<uint32_t> cleared;
  std::vector<DerivedSymbolEntry> derivedSymbol;
  bool hasDerivedSymbol = false;
  DerivedTextEntry derivedText;
  bool hasDerivedText = false;
  for (;;) {
    uint32_t f = 0;
    if (!bb.readVarUint(f)) return false;
    if (!f) break;
    switch (f) {
      case id::kGuid: {
        Guid g;
        if (!getGuid(bb, g)) return false;
        if (guid) *guid = g;
        break;
      }
      case id::kPhase: {
        uint32_t v = 0;
        if (!bb.readVarUint(v)) return false;
        if (phase) *phase = v == 0 ? Phase::CREATED : Phase::REMOVED;
        break;
      }
      case id::kParentIndex: {
        Guid g;
        if (!getGuid(bb, g) || !getString(bb, p.parentIndex.position)) return false;
        p.parentIndex.guid = noneToAbsent(g);
        m |= F_PARENT_INDEX;
        break;
      }
      case id::kType: {
        uint32_t v = 0;
        if (!bb.readVarUint(v)) return false;
        p.type = nodeTypeOf(v);
        m |= F_TYPE;
        break;
      }
      case id::kGuidPath:
        if (guidPath) {
          if (!getGuidPath(bb, *guidPath)) return false;
          if (sawGuidPath) *sawGuidPath = true;
        } else if (!skipUnknown(bb, defs().nodeChange, f)) {
          return false;
        }
        break;
      case id::kStyleID: {
        uint32_t v = 0;
        if (!bb.readVarUint(v)) return false;
        if (styleID) *styleID = v;
        break;
      }
      case id::kClearedFields: {
        uint32_t n = 0;
        if (!bb.readVarUint(n)) return false;
        for (uint32_t i = 0; i < n; i++) {
          uint32_t v = 0;
          if (!bb.readVarUint(v)) return false;
          cleared.push_back(v);
        }
        break;
      }
      // Derived data (docs/schema.md §1.4): read for the sink, never into the node.
      case id::kFillGeometry:
      case id::kStrokeGeometry:
        if (!skipUnknown(bb, defs().nodeChange, f)) return false;
        break;
      case id::kDerivedSymbolData: {
        uint32_t n = 0;
        if (!bb.readVarUint(n)) return false;
        hasDerivedSymbol = true;
        struct EntryText : DerivedSink {
          std::string* text;
          void symbolData(Guid, std::vector<DerivedSymbolEntry>&&) override {}
          void textData(Guid, DerivedTextEntry&& t) override { *text = std::move(t.bytes); }
        };
        for (uint32_t i = 0; i < n; i++) {
          DerivedSymbolEntry e;
          NodeProps q;
          FieldMask qm = 0;
          EntryText sink;
          sink.text = &e.text;
          Guid none = kNoGuid;
          if (!readFieldsInto(bb, q, qm, false, blobs, kNodeMode, &none, nullptr, &e.path, nullptr, nullptr, &sink)) return false;
          e.hasSize = (qm & F_SIZE) != 0;
          e.hasTransform = (qm & F_TRANSFORM) != 0;
          e.size = q.size;
          e.transform = q.transform;
          derivedSymbol.push_back(std::move(e));
        }
        break;
      }
      case id::kDerivedTextData: {
        hasDerivedText = true;
        const Def& dt = defOf("DerivedTextData");
        for (;;) {
          uint32_t g = 0;
          if (!bb.readVarUint(g)) return false;
          if (!g) break;
          if (!keepUnknown(bb, dt, g, derivedText.bytes)) return false;
        }
        break;
      }
      // ---- modelled fields (ENG_NODE_FIELDS) ----
      case 5:
        if (!getString(bb, p.name)) return false;
        m |= F_NAME;
        break;
      case 6:
        if (!getBool(bb, p.visible)) return false;
        m |= F_VISIBLE;
        break;
      case 7:
        if (!getBool(bb, p.locked)) return false;
        m |= F_LOCKED;
        break;
      case 8:
        if (!getFloat(bb, p.opacity)) return false;
        m |= F_OPACITY;
        break;
      case 12:
        if (!getMatrix(bb, p.transform)) return false;
        m |= F_TRANSFORM;
        break;
      case 11:
        if (!getVector(bb, p.size)) return false;
        m |= F_SIZE;
        break;
      case 38:
        if (!readPaints(bb, p.fillPaints, blobs)) return false;
        m |= F_FILLS;
        break;
      case 39:
        if (!readPaints(bb, p.strokePaints, blobs)) return false;
        m |= F_STROKES;
        break;
      case 26:
        if (!getFloat(bb, p.strokeWeight)) return false;
        m |= F_STROKE_WEIGHT;
        break;
      case 29:
        if (getEnum(bb, p.strokeAlign)) m |= F_STROKE_ALIGN;
        break;
      case id::kCornerRadius:
        if (!getFloat(bb, uniform)) return false;
        hasUniform = true;
        break;
      case id::kCornerTL:
        if (!getFloat(bb, corner[0])) return false;
        hasCorner[0] = true;
        break;
      case id::kCornerTR:
        if (!getFloat(bb, corner[1])) return false;
        hasCorner[1] = true;
        break;
      case id::kCornerBR:
        if (!getFloat(bb, corner[2])) return false;
        hasCorner[2] = true;
        break;
      case id::kCornerBL:
        if (!getFloat(bb, corner[3])) return false;
        hasCorner[3] = true;
        break;
      case id::kCornersIndependent: {
        bool v = false;
        if (!getBool(bb, v)) return false;
        cornersIndependentFalse = !v;
        break;
      }
      case 115:
        if (!getBool(bb, p.frameMaskDisabled)) return false;
        m |= F_FRAME_MASK_DISABLED;
        break;
      case 117:
        if (!getBool(bb, p.resizeToFit)) return false;
        m |= F_RESIZE_TO_FIT;
        break;
      case 50:
        if (!getColor(bb, p.rare().backgroundColor)) return false;
        m |= F_BACKGROUND_COLOR;
        break;
      case 15:
        if (!getBool(bb, p.rare().backgroundEnabled)) return false;
        m |= F_BACKGROUND_ENABLED;
        break;
      case 142:
        if (!getBool(bb, p.rare().internalOnly)) return false;
        m |= F_INTERNAL_ONLY;
        break;
      case 105:
        if (getEnum(bb, p.stack().stackMode)) m |= F_STACK_MODE;
        break;
      case 107:
        if (!getFloat(bb, p.stack().stackSpacing)) return false;
        m |= F_STACK_SPACING;
        break;
      case 209:
        if (!getFloat(bb, p.stack().stackPaddingLeft)) return false;
        m |= F_STACK_PADDING_LEFT;
        break;
      case 210:
        if (!getFloat(bb, p.stack().stackPaddingTop)) return false;
        m |= F_STACK_PADDING_TOP;
        break;
      case 233:
        if (!getFloat(bb, p.stack().stackPaddingRight)) return false;
        m |= F_STACK_PADDING_RIGHT;
        break;
      case 234:
        if (!getFloat(bb, p.stack().stackPaddingBottom)) return false;
        m |= F_STACK_PADDING_BOTTOM;
        break;
      case 229:
        if (getEnum(bb, p.stack().stackPrimarySizing)) m |= F_STACK_PRIMARY_SIZING;
        break;
      case 221:
        if (getEnum(bb, p.stack().stackCounterSizing)) m |= F_STACK_COUNTER_SIZING;
        break;
      case 230:
        if (getEnum(bb, p.stack().stackPrimaryAlignItems)) m |= F_STACK_PRIMARY_ALIGN;
        break;
      case 231:
        if (getEnum(bb, p.stack().stackCounterAlignItems)) m |= F_STACK_COUNTER_ALIGN;
        break;
      case 343:
        if (getEnum(bb, p.stack().stackCounterAlignContent)) m |= F_STACK_COUNTER_ALIGN_CONTENT;
        break;
      case 323:
        if (getEnum(bb, p.stack().stackWrap)) m |= F_STACK_WRAP;
        break;
      case 324: {
        double v = 0;
        if (!getFloat(bb, v)) return false;
        // Figma writes NaN for a wrap's row gap that follows the column gap (its "Auto"): the same as absent.
        if (std::isfinite(v)) p.stack().stackCounterSpacing = v;
        else p.stack().stackCounterSpacing.reset();
        m |= F_STACK_COUNTER_SPACING;
        break;
      }
      case 271:
        if (!getBool(bb, p.stack().stackReverseZIndex)) return false;
        m |= F_STACK_REVERSE_Z;
        break;
      case 294:
        if (!getBool(bb, p.stack().bordersTakeSpace)) return false;
        m |= F_BORDERS_TAKE_SPACE;
        break;
      case 232:
        if (!getFloat(bb, p.stackChildPrimaryGrow)) return false;
        m |= F_STACK_CHILD_GROW;
        break;
      case 236:
        if (getEnum(bb, p.stackChildAlignSelf)) m |= F_STACK_CHILD_ALIGN_SELF;
        break;
      case 269:
        if (getEnum(bb, p.stackPositioning)) m |= F_STACK_POSITIONING;
        break;
      case 325:
      case 326: {  // OptionalVector {value}: no value = no limit (0 here)
        Vec2& target = f == 325 ? p.rare().minSize : p.rare().maxSize;
        target = Vec2{};
        for (;;) {
          uint32_t g = 0;
          if (!bb.readVarUint(g)) return false;
          if (!g) break;
          if (g != 1 || !getVector(bb, target)) return false;
        }
        m |= f == 325 ? F_MIN_SIZE : F_MAX_SIZE;
        break;
      }
      case 28:
        if (getEnum(bb, p.horizontalConstraint)) m |= F_H_CONSTRAINT;
        break;
      case 37:
        if (getEnum(bb, p.verticalConstraint)) m |= F_V_CONSTRAINT;
        break;
      case 151:
        if (!getBool(bb, p.proportionsConstrained)) return false;
        m |= F_PROPORTIONS_CONSTRAINED;
        break;
      case 42:
        p.text().textData = TextData{};
        if (!readTextData(bb, p.text().textData, blobs)) return false;
        m |= F_TEXT_DATA;
        break;
      case 41:
        if (!getFontName(bb, p.text().fontName)) return false;
        m |= F_FONT_NAME;
        break;
      case 21:
        if (!getFloat(bb, p.text().fontSize)) return false;
        m |= F_FONT_SIZE;
        break;
      case 40:
        if (!getNumber(bb, p.text().lineHeight)) return false;
        m |= F_LINE_HEIGHT;
        break;
      case 165:
        if (!getNumber(bb, p.text().letterSpacing)) return false;
        m |= F_LETTER_SPACING;
        break;
      case 23:
        if (!getFloat(bb, p.text().paragraphSpacing)) return false;
        m |= F_PARAGRAPH_SPACING;
        break;
      case 22:
        if (!getFloat(bb, p.text().paragraphIndent)) return false;
        m |= F_PARAGRAPH_INDENT;
        break;
      case 32:
        if (getEnum(bb, p.text().textAlignHorizontal)) m |= F_TEXT_ALIGN_H;
        break;
      case 33:
        if (getEnum(bb, p.text().textAlignVertical)) m |= F_TEXT_ALIGN_V;
        break;
      case 46:
        if (getEnum(bb, p.text().textAutoResize)) m |= F_TEXT_AUTO_RESIZE;
        break;
      case 280:
        if (getEnum(bb, p.text().textTruncation)) m |= F_TEXT_TRUNCATION;
        break;
      case 351:
        if (!bb.readVarInt(p.text().maxLines)) return false;
        m |= F_MAX_LINES;
        break;
      case 34:
        if (getEnum(bb, p.text().textCase)) m |= F_TEXT_CASE;
        break;
      case 35:
        if (getEnum(bb, p.text().textDecoration)) m |= F_TEXT_DECORATION;
        break;
      case 14:
        if (!getBool(bb, p.text().autoRename)) return false;
        m |= F_AUTO_RENAME;
        break;
      case 9:
        if (getEnum(bb, p.blendMode)) m |= F_BLEND_MODE;
        break;
      case 16:
        if (!getBool(bb, p.mask)) return false;
        m |= F_MASK;
        break;
      case 317:
        if (getEnum(bb, p.maskType)) m |= F_MASK_TYPE;
        break;
      case 30:
        if (getEnum(bb, p.strokeCap)) m |= F_STROKE_CAP;
        break;
      case 31:
        if (getEnum(bb, p.strokeJoin)) m |= F_STROKE_JOIN;
        break;
      case 25:
        if (!getFloat(bb, p.miterLimit)) return false;
        m |= F_MITER_LIMIT;
        break;
      case 13: {
        uint32_t n = 0;
        if (!bb.readVarUint(n)) return false;
        p.stroke().dashPattern.clear();
        for (uint32_t i = 0; i < n; i++) {
          double v = 0;
          if (!getFloat(bb, v)) return false;
          p.stroke().dashPattern.push_back(v);
        }
        m |= F_DASH_PATTERN;
        break;
      }
      case id::kBorderTop:
        if (!getFloat(bb, p.stroke().borderWeights[0])) return false;
        m |= F_BORDER_WEIGHTS;
        break;
      case id::kBorderRight:
        if (!getFloat(bb, p.stroke().borderWeights[1])) return false;
        m |= F_BORDER_WEIGHTS;
        break;
      case id::kBorderBottom:
        if (!getFloat(bb, p.stroke().borderWeights[2])) return false;
        m |= F_BORDER_WEIGHTS;
        break;
      case id::kBorderLeft:
        if (!getFloat(bb, p.stroke().borderWeights[3])) return false;
        m |= F_BORDER_WEIGHTS;
        break;
      case id::kBordersIndependent:
        if (!getBool(bb, p.stroke().borderStrokeWeightsIndependent)) return false;
        m |= F_BORDER_WEIGHTS;
        break;
      case 160:
        if (!getFloat(bb, p.stroke().cornerSmoothing)) return false;
        m |= F_CORNER_SMOOTHING;
        break;
      case 43: {
        uint32_t n = 0;
        if (!bb.readVarUint(n)) return false;
        p.effects.clear();
        for (uint32_t i = 0; i < n; i++) {
          Effect e;
          if (!readEffect(bb, e)) return false;
          p.effects.push_back(std::move(e));
        }
        m |= F_EFFECTS;
        break;
      }
      case 10:
        if (!bb.readVarUint(p.shape().count)) return false;
        m |= F_COUNT;
        break;
      case 24:
        if (!getFloat(bb, p.shape().starInnerScale)) return false;
        m |= F_STAR_INNER_SCALE;
        break;
      case 195: {
        for (;;) {
          uint32_t g = 0;
          if (!bb.readVarUint(g)) return false;
          if (!g) break;
          double* target = g == 1 ? &p.shape().arcData.startingAngle : g == 2 ? &p.shape().arcData.endingAngle : g == 3 ? &p.shape().arcData.innerRadius : nullptr;
          if (!target || !getFloat(bb, *target)) return false;
        }
        m |= F_ARC_DATA;
        break;
      }
      case 48:
        p.shape().vectorData = VectorData{};
        if (!readVectorData(bb, p.shape().vectorData, blobs)) return false;
        m |= F_VECTOR_DATA;
        break;
      case 44:
        if (getEnum(bb, p.shape().handleMirroring)) m |= F_HANDLE_MIRRORING;
        break;
      case 36:
        if (getEnum(bb, p.shape().booleanOperation)) m |= F_BOOLEAN_OPERATION;
        break;
      case 47: {
        uint32_t n = 0;
        if (!bb.readVarUint(n)) return false;
        p.rare().layoutGrids.clear();
        for (uint32_t i = 0; i < n; i++) {
          LayoutGrid g;
          if (!readLayoutGrid(bb, g)) return false;
          p.rare().layoutGrids.push_back(std::move(g));
        }
        m |= F_LAYOUT_GRIDS;
        break;
      }
      // Components.
      case 213: {
        Guid g;
        if (!getGuid(bb, g)) return false;
        p.overrideKey = noneToAbsent(g);
        m |= F_OVERRIDE_KEY;
        break;
      }
      case 113: {  // SymbolData {symbolID, symbolOverrides, uniformScaleFactor}
        SymbolData d;
        for (;;) {
          uint32_t g = 0;
          if (!bb.readVarUint(g)) return false;
          if (!g) break;
          if (g == 1) {
            Guid s;
            if (!getGuid(bb, s)) return false;
            d.symbolID = noneToAbsent(s);
          } else if (g == 2) {
            uint32_t n = 0;
            if (!bb.readVarUint(n)) return false;
            for (uint32_t i = 0; i < n; i++) {
              SymbolOverride o;
              if (!readFieldsInto(bb, o.props, o.mask, false, blobs, kNodeMode, nullptr, nullptr, &o.path, nullptr, nullptr, nullptr))
                return false;
              o.mask &= ~static_cast<FieldMask>(F_PARENT_INDEX | F_TYPE);
              d.overrides.push_back(std::move(o));
            }
          } else if (g == 3) {
            if (!getFloat(bb, d.uniformScaleFactor)) return false;
          } else if (!skipUnknown(bb, defOf("SymbolData"), g)) {
            return false;
          }
        }
        // Figma writes the root's entry as [symbolID]: the empty path here (docs/schema.md §5.1); entries for the
        // same path merge (later fields win).
        std::vector<SymbolOverride> merged;
        for (SymbolOverride& o : d.overrides) {
          if (o.path.size() == 1 && o.path[0] == d.symbolID) o.path.clear();
          auto same = std::find_if(merged.begin(), merged.end(), [&](const SymbolOverride& q) { return q.path == o.path; });
          if (same != merged.end()) {
            copyFields(same->props, o.props, o.mask & ~static_cast<FieldMask>(F_EXTRA));
            for (auto& [k, val] : o.props.extra) same->props.extra[k] = val;
            same->mask |= o.mask;
          } else {
            merged.push_back(std::move(o));
          }
        }
        d.overrides = std::move(merged);
        p.comp().symbolData = std::move(d);
        m |= F_SYMBOL_DATA;
        break;
      }
      case 143: {
        Guid g;
        if (!getGuid(bb, g)) return false;
        p.comp().overriddenSymbolID = noneToAbsent(g);
        m |= F_OVERRIDDEN_SYMBOL_ID;
        break;
      }
      case 266: {
        uint32_t n = 0;
        if (!bb.readVarUint(n)) return false;
        p.comp().componentPropDefs.clear();
        for (uint32_t i = 0; i < n; i++) {
          ComponentPropDef d;
          if (!readPropDef(bb, d, blobs)) return false;
          p.comp().componentPropDefs.push_back(std::move(d));
        }
        m |= F_COMPONENT_PROP_DEFS;
        break;
      }
      case 268: {
        uint32_t n = 0;
        if (!bb.readVarUint(n)) return false;
        p.comp().componentPropAssignments.clear();
        for (uint32_t i = 0; i < n; i++) {
          ComponentPropAssignment a;
          if (!readPropAssignment(bb, a, blobs)) return false;
          p.comp().componentPropAssignments.push_back(std::move(a));
        }
        m |= F_COMPONENT_PROP_ASSIGNMENTS;
        break;
      }
      case 445:
        p.parameterConsumptionMap.clear();
        if (!readParamMap(bb, p.parameterConsumptionMap)) return false;
        m |= F_PARAM_MAP;
        break;
      case 225:
        if (!getBool(bb, p.comp().isStateGroup)) return false;
        m |= F_IS_STATE_GROUP;
        break;
      case 483: {
        uint32_t n = 0;
        if (!bb.readVarUint(n)) return false;
        p.comp().variantPropSpecs.clear();
        for (uint32_t i = 0; i < n; i++) {
          VariantPropSpec spec;
          for (;;) {
            uint32_t g = 0;
            if (!bb.readVarUint(g)) return false;
            if (!g) break;
            if (g == 1) {
              if (!getGuid(bb, spec.propDefId)) return false;
            } else if (g == 2) {
              if (!getString(bb, spec.value)) return false;
            } else {
              return false;
            }
          }
          p.comp().variantPropSpecs.push_back(std::move(spec));
        }
        m |= F_VARIANT_PROP_SPECS;
        break;
      }
      case 238: {
        uint32_t n = 0;
        if (!bb.readVarUint(n)) return false;
        p.comp().stateGroupPropertyValueOrders.clear();
        for (uint32_t i = 0; i < n; i++) {
          StateGroupOrder o;
          for (;;) {
            uint32_t g = 0;
            if (!bb.readVarUint(g)) return false;
            if (!g) break;
            if (g == 1) {
              if (!getString(bb, o.property)) return false;
            } else if (g == 2) {
              uint32_t k = 0;
              if (!bb.readVarUint(k)) return false;
              for (uint32_t j = 0; j < k; j++) {
                std::string s;
                if (!getString(bb, s)) return false;
                o.values.push_back(std::move(s));
              }
            } else {
              return false;
            }
          }
          p.comp().stateGroupPropertyValueOrders.push_back(std::move(o));
        }
        m |= F_STATE_GROUP_ORDERS;
        break;
      }
      case 305:
        if (!getBool(bb, p.comp().propsAreBubbled)) return false;
        m |= F_PROPS_ARE_BUBBLED;
        break;
      case 463:
        if (!getBool(bb, p.comp().isSlot)) return false;
        m |= F_IS_SLOT;
        break;
      case 495:
        if (!getBool(bb, p.comp().isSlotContent)) return false;
        m |= F_IS_SLOT_CONTENT;
        break;
      case 342: {  // SymbolId {guid, assetRef}
        AssetId a;
        if (!getAssetId(bb, a)) return false;
        if (a.present()) {
          p.comp().detachedSymbolId = std::move(a);
          m |= F_DETACHED_SYMBOL_ID;
        }
        break;
      }
      case 330:
        if (!getBool(bb, p.comp().isSoftDeleted)) return false;
        m |= F_IS_SOFT_DELETED;
        break;
      case 235: {
        uint32_t n = 0;
        if (!bb.readVarUint(n)) return false;
        p.comp().ancestorPathBeforeDeletion.clear();
        for (uint32_t i = 0; i < n; i++) {
          Guid g;
          if (!getGuid(bb, g)) return false;
          p.comp().ancestorPathBeforeDeletion.push_back(g);
        }
        m |= F_ANCESTOR_PATH;
        break;
      }
      // Variables, modes, styles.
      case 316: {  // VariableModeBySetMap {entries: [{variableSetID, variableModeID}]}
        p.refs().variableModeBySetMap.clear();
        for (;;) {
          uint32_t g = 0;
          if (!bb.readVarUint(g)) return false;
          if (!g) break;
          if (g != 1) return false;
          uint32_t n = 0;
          if (!bb.readVarUint(n)) return false;
          for (uint32_t i = 0; i < n; i++) {
            VariableModeEntry me;
            for (;;) {
              uint32_t h = 0;
              if (!bb.readVarUint(h)) return false;
              if (!h) break;
              if (h == 1) {
                if (!getAssetId(bb, me.set)) return false;
              } else if (h == 2) {
                Guid mode;
                if (!getGuid(bb, mode)) return false;
                me.mode = noneToAbsent(mode);
              } else if (h == 3) {
                if (!getAssetId(bb, me.extension)) return false;
              } else {
                return false;
              }
            }
            if (me.set.present()) p.refs().variableModeBySetMap.push_back(std::move(me));
          }
        }
        m |= F_VARIABLE_MODES;
        break;
      }
      case 332:
        if (!getAssetId(bb, p.refs().styleIdForFill)) return false;
        m |= F_STYLE_ID_FILL;
        break;
      case 333:
        if (!getAssetId(bb, p.refs().styleIdForStrokeFill)) return false;
        m |= F_STYLE_ID_STROKE;
        break;
      case 334:
        if (!getAssetId(bb, p.refs().styleIdForText)) return false;
        m |= F_STYLE_ID_TEXT;
        break;
      case 335:
        if (!getAssetId(bb, p.refs().styleIdForEffect)) return false;
        m |= F_STYLE_ID_EFFECT;
        break;
      case 336:
        if (!getAssetId(bb, p.refs().styleIdForGrid)) return false;
        m |= F_STYLE_ID_GRID;
        break;
      case 163:
        if (getEnum(bb, p.asset().styleType)) m |= F_STYLE_TYPE;
        break;
      case 320:
        if (!getString(bb, p.asset().sortPosition)) return false;
        m |= F_SORT_POSITION;
        break;
      case 318:
        if (!getString(bb, p.asset().description)) return false;
        m |= F_DESCRIPTION;
        break;
      case 319:
        if (!getString(bb, p.asset().key)) return false;
        m |= F_KEY;
        break;
      case 174:
        if (!getBool(bb, p.asset().isPublishable)) return false;
        m |= F_IS_PUBLISHABLE;
        break;
      case 312: {
        uint32_t n = 0;
        if (!bb.readVarUint(n)) return false;
        p.asset().variableSetModes.clear();
        for (uint32_t i = 0; i < n; i++) {
          VariableSetMode mode;
          for (;;) {
            uint32_t g = 0;
            if (!bb.readVarUint(g)) return false;
            if (!g) break;
            if (g == 1) {
              Guid mid;
              if (!getGuid(bb, mid)) return false;
              mode.id = noneToAbsent(mid);
            } else if (g == 2) {
              if (!getString(bb, mode.name)) return false;
            } else if (g == 3) {
              if (!getString(bb, mode.sortPosition)) return false;
            } else if (g == 4) {
              if (!getAssetId(bb, mode.parentSet)) return false;
            } else if (g == 5) {
              Guid pm;
              if (!getGuid(bb, pm)) return false;
              mode.parentMode = noneToAbsent(pm);
            } else {
              return false;
            }
          }
          p.asset().variableSetModes.push_back(std::move(mode));
        }
        m |= F_VARIABLE_SET_MODES;
        break;
      }
      case 313:
        if (!getAssetId(bb, p.asset().variableSetID)) return false;
        m |= F_VARIABLE_SET_ID;
        break;
      case 464:
        if (!getAssetId(bb, p.asset().overriddenVariableId)) return false;
        m |= F_OVERRIDDEN_VARIABLE;
        break;
      case 314:
        if (getEnum(bb, p.asset().variableResolvedType)) m |= F_VARIABLE_RESOLVED_TYPE;
        break;
      case 315: {  // VariableDataValues {entries: [{modeID, variableData}]}
        p.asset().variableDataValues.clear();
        for (;;) {
          uint32_t g = 0;
          if (!bb.readVarUint(g)) return false;
          if (!g) break;
          if (g != 1) return false;
          uint32_t n = 0;
          if (!bb.readVarUint(n)) return false;
          for (uint32_t i = 0; i < n; i++) {
            VariableModeValue mv;
            for (;;) {
              uint32_t h = 0;
              if (!bb.readVarUint(h)) return false;
              if (!h) break;
              if (h == 1) {
                Guid mode;
                if (!getGuid(bb, mode)) return false;
                mv.modeID = noneToAbsent(mode);
              } else if (h == 2) {
                if (!readVariableDataInto(bb, mv.data)) return false;
              } else {
                return false;
              }
            }
            p.asset().variableDataValues.push_back(std::move(mv));
          }
        }
        m |= F_VARIABLE_DATA_VALUES;
        break;
      }
      case 353: {
        uint32_t n = 0;
        if (!bb.readVarUint(n)) return false;
        std::vector<VariableScope> scopes;
        for (uint32_t i = 0; i < n; i++) {
          VariableScope sc = VariableScope::ALL_SCOPES;
          if (getEnum(bb, sc)) scopes.push_back(sc);
        }
        p.asset().variableScopes = std::move(scopes);
        m |= F_VARIABLE_SCOPES;
        break;
      }
      case 358: {  // CodeSyntaxMap {entries: [{platform, value}]}
        p.asset().codeSyntax.clear();
        for (;;) {
          uint32_t g = 0;
          if (!bb.readVarUint(g)) return false;
          if (!g) break;
          if (g != 1) return false;
          uint32_t n = 0;
          if (!bb.readVarUint(n)) return false;
          for (uint32_t i = 0; i < n; i++) {
            CodeSyntaxEntry cs;
            bool ok = true;
            for (;;) {
              uint32_t h = 0;
              if (!bb.readVarUint(h)) return false;
              if (!h) break;
              if (h == 1) {
                if (!getEnum(bb, cs.platform)) ok = false;
              } else if (h == 2) {
                if (!getString(bb, cs.value)) return false;
              } else {
                return false;
              }
            }
            if (ok) p.asset().codeSyntax.push_back(std::move(cs));
          }
        }
        m |= F_CODE_SYNTAX;
        break;
      }
      case 171:
        if (!getString(bb, p.asset().version)) return false;
        m |= F_VERSION;
        break;
      case 218:
        if (!getString(bb, p.asset().publishedVersion)) return false;
        m |= F_PUBLISHED_VERSION;
        break;
      case 395:
        if (!getString(bb, p.asset().sourceLibraryKey)) return false;
        m |= F_SOURCE_LIBRARY_KEY;
        break;
      case 215: {
        Guid g;
        if (!getGuid(bb, g)) return false;
        p.asset().publishID = noneToAbsent(g);
        m |= F_PUBLISH_ID;
        break;
      }
      case 256: {
        for (;;) {
          uint32_t g = 0;
          if (!bb.readVarUint(g)) return false;
          if (!g) break;
          if (g == 1) {
            if (!getString(bb, p.asset().libraryMoveInfo.oldKey)) return false;
          } else if (g == 2) {
            if (!getString(bb, p.asset().libraryMoveInfo.pasteFileKey)) return false;
          } else {
            return false;
          }
        }
        m |= F_LIBRARY_MOVE_INFO;
        break;
      }
      default: {
        // Every other field keeps its bytes (id-prefixed), by its schema name.
        const FieldDef* fd = defs().nodeChange.byId(f);
        if (!fd) return false;
        size_t start = bb.index();
        if (!table().skipValue(bb, *fd)) return false;
        std::string entry;
        schema::appendField(entry, f, std::string_view(reinterpret_cast<const char*>(bb.data()) + start, bb.index() - start));
        p.extra[fd->name] = std::move(entry);
        m |= F_EXTRA;
      }
    }
  }
  // Corner radii: the uniform radius sets all four; the per-corner fields override it unless
  // rectangleCornerRadiiIndependent is explicitly false (as the JSON reader).
  // Without the uniform radius only the corners given are set (an override of one corner keeps its main's others).
  if (hasUniform) {
    p.cornerRadii = {uniform, uniform, uniform, uniform};
    m |= F_CORNER_RADII;
  }
  static constexpr Field kCornerBit[4] = {F_CORNER_TL, F_CORNER_TR, F_CORNER_BR, F_CORNER_BL};
  if (!cornersIndependentFalse)
    for (size_t i = 0; i < 4; i++)
      if (hasCorner[i]) {
        p.cornerRadii[i] = corner[i];
        m |= kCornerBit[i];
      }
  // clearedFields (updates only): modelled fields back to their defaults; unmodelled ones removed from `extra`.
  if (update && !cleared.empty()) {
    NodeProps defaults;
    for (uint32_t cid : cleared) {
      FieldMask fm = fieldsOfKiwiId(cid) & ~static_cast<FieldMask>(F_TYPE | F_PARENT_INDEX);
      if (fm) {
        if (m & fm) continue;  // a field set and cleared at once keeps the set value
        copyFields(p, defaults, fm);
        m |= fm;
      } else if (const FieldDef* fd = defs().nodeChange.byId(cid)) {
        if (!p.extra.count(fd->name)) {
          p.extra[fd->name] = std::string();
          m |= F_EXTRA;
        }
      }
    }
  }
  if (derived && guid) {
    if (hasDerivedSymbol) derived->symbolData(*guid, std::move(derivedSymbol));
    if (hasDerivedText) derived->textData(*guid, std::move(derivedText));
  }
  return true;
}

// Writes the fields in `mask`; for an update, an optional field that is unset in `p` goes to clearedFields instead.
void putFields(Out& o, const NodeProps& p, FieldMask mask, bool update, BlobsOut* blobs, std::vector<uint32_t>& cleared) {
  if (mask & F_PARENT_INDEX) {
    o.varuint(id::kParentIndex);
    putGuid(o, p.parentIndex.guid);
    o.str(p.parentIndex.position);
  }
  if (mask & F_TYPE) putUint(o, id::kType, static_cast<uint32_t>(p.type));
  if (mask & F_NAME) putString(o, 5, p.name);
  if (mask & F_VISIBLE) putBool(o, 6, p.visible);
  if (mask & F_LOCKED) putBool(o, 7, p.locked);
  if (mask & F_OPACITY) putFloat(o, 8, p.opacity);
  if (mask & F_SIZE) {
    o.varuint(11);
    putVector(o, p.size);
  }
  if (mask & F_TRANSFORM) {
    o.varuint(12);
    putMatrix(o, p.transform);
  }
  if ((mask & F_CORNER_RADII) == F_CORNER_RADII) {
    const CornerRadii& r = p.cornerRadii;
    bool independent = !(r[0] == r[1] && r[1] == r[2] && r[2] == r[3]);
    putFloat(o, id::kCornerRadius, r[0]);
    putFloat(o, id::kCornerTL, r[0]);
    putFloat(o, id::kCornerTR, r[1]);
    putFloat(o, id::kCornerBL, r[3]);
    putFloat(o, id::kCornerBR, r[2]);
    putBool(o, id::kCornersIndependent, independent);
  } else if (mask & F_CORNER_RADII) {
    // Some corners only (an override): just those, as Figma writes them.
    if (mask & F_CORNER_TL) putFloat(o, id::kCornerTL, p.cornerRadii[0]);
    if (mask & F_CORNER_TR) putFloat(o, id::kCornerTR, p.cornerRadii[1]);
    if (mask & F_CORNER_BL) putFloat(o, id::kCornerBL, p.cornerRadii[3]);
    if (mask & F_CORNER_BR) putFloat(o, id::kCornerBR, p.cornerRadii[2]);
  }
  if (mask & F_STROKE_WEIGHT) putFloat(o, 26, p.strokeWeight);
  if (mask & F_STROKE_ALIGN) putEnum(o, 29, p.strokeAlign);
  if (mask & F_FILLS) putPaints(o, 38, p.fillPaints, blobs);
  if (mask & F_STROKES) putPaints(o, 39, p.strokePaints, blobs);
  if (mask & F_FRAME_MASK_DISABLED) putBool(o, 115, p.frameMaskDisabled);
  if (mask & F_RESIZE_TO_FIT) putBool(o, 117, p.resizeToFit);
  if (mask & F_BACKGROUND_COLOR) {
    o.varuint(50);
    putColor(o, p.rare().backgroundColor);
  }
  if (mask & F_BACKGROUND_ENABLED) putBool(o, 15, p.rare().backgroundEnabled);
  if (mask & F_INTERNAL_ONLY) putBool(o, 142, p.rare().internalOnly);
  // Auto layout.
  if (mask & F_STACK_MODE) putEnum(o, 105, p.stack().stackMode);
  if (mask & F_STACK_SPACING) putFloat(o, 107, p.stack().stackSpacing);
  if (mask & F_STACK_PADDING_LEFT) putFloat(o, 209, p.stack().stackPaddingLeft);
  if (mask & F_STACK_PADDING_TOP) putFloat(o, 210, p.stack().stackPaddingTop);
  if (mask & F_STACK_PADDING_RIGHT) putFloat(o, 233, p.stack().stackPaddingRight);
  if (mask & F_STACK_PADDING_BOTTOM) putFloat(o, 234, p.stack().stackPaddingBottom);
  if (mask & F_STACK_PRIMARY_SIZING) putEnum(o, 229, p.stack().stackPrimarySizing);
  if (mask & F_STACK_COUNTER_SIZING) putEnum(o, 221, p.stack().stackCounterSizing);
  if (mask & F_STACK_PRIMARY_ALIGN) putEnum(o, 230, p.stack().stackPrimaryAlignItems);
  if (mask & F_STACK_COUNTER_ALIGN) putEnum(o, 231, p.stack().stackCounterAlignItems);
  if (mask & F_STACK_COUNTER_ALIGN_CONTENT) putEnum(o, 343, p.stack().stackCounterAlignContent);
  if (mask & F_STACK_WRAP) putEnum(o, 323, p.stack().stackWrap);
  if (mask & F_STACK_COUNTER_SPACING) {
    if (p.stack().stackCounterSpacing) putFloat(o, 324, *p.stack().stackCounterSpacing);
    else if (update) cleared.push_back(324);
  }
  if (mask & F_STACK_REVERSE_Z) putBool(o, 271, p.stack().stackReverseZIndex);
  if (mask & F_BORDERS_TAKE_SPACE) putBool(o, 294, p.stack().bordersTakeSpace);
  if (mask & F_STACK_CHILD_GROW) putFloat(o, 232, p.stackChildPrimaryGrow);
  if (mask & F_STACK_CHILD_ALIGN_SELF) putEnum(o, 236, p.stackChildAlignSelf);
  if (mask & F_STACK_POSITIONING) putEnum(o, 269, p.stackPositioning);
  // OptionalVector: no limit (0, 0) is written as Figma does, with no value.
  auto optionalVector = [&](uint32_t fid, Vec2 v) {
    o.varuint(fid);
    if (v.x != 0 || v.y != 0) {
      o.varuint(1);
      putVector(o, v);
    }
    o.byte(0);
  };
  if (mask & F_MIN_SIZE) optionalVector(325, p.rare().minSize);
  if (mask & F_MAX_SIZE) optionalVector(326, p.rare().maxSize);
  if (mask & F_H_CONSTRAINT) putEnum(o, 28, p.horizontalConstraint);
  if (mask & F_V_CONSTRAINT) putEnum(o, 37, p.verticalConstraint);
  if (mask & F_PROPORTIONS_CONSTRAINED) putBool(o, 151, p.proportionsConstrained);
  // Text.
  if (mask & F_TEXT_DATA) {
    o.varuint(42);
    putTextData(o, p.text().textData, blobs);
  }
  if (mask & F_FONT_NAME) {
    o.varuint(41);
    putFontName(o, p.text().fontName);
  }
  if (mask & F_FONT_SIZE) putFloat(o, 21, p.text().fontSize);
  if (mask & F_LINE_HEIGHT) {
    o.varuint(40);
    putNumber(o, p.text().lineHeight);
  }
  if (mask & F_LETTER_SPACING) {
    o.varuint(165);
    putNumber(o, p.text().letterSpacing);
  }
  if (mask & F_PARAGRAPH_SPACING) putFloat(o, 23, p.text().paragraphSpacing);
  if (mask & F_PARAGRAPH_INDENT) putFloat(o, 22, p.text().paragraphIndent);
  if (mask & F_TEXT_ALIGN_H) putEnum(o, 32, p.text().textAlignHorizontal);
  if (mask & F_TEXT_ALIGN_V) putEnum(o, 33, p.text().textAlignVertical);
  if (mask & F_TEXT_AUTO_RESIZE) putEnum(o, 46, p.text().textAutoResize);
  if (mask & F_TEXT_TRUNCATION) putEnum(o, 280, p.text().textTruncation);
  if (mask & F_MAX_LINES) putInt(o, 351, p.text().maxLines);
  if (mask & F_TEXT_CASE) putEnum(o, 34, p.text().textCase);
  if (mask & F_TEXT_DECORATION) putEnum(o, 35, p.text().textDecoration);
  if (mask & F_AUTO_RENAME) putBool(o, 14, p.text().autoRename);
  // Paint, stroke, effects, masks.
  if (mask & F_BLEND_MODE) putEnum(o, 9, p.blendMode);
  if (mask & F_MASK) putBool(o, 16, p.mask);
  if (mask & F_MASK_TYPE) putEnum(o, 317, p.maskType);
  if (mask & F_STROKE_CAP) putEnum(o, 30, p.strokeCap);
  if (mask & F_STROKE_JOIN) putEnum(o, 31, p.strokeJoin);
  if (mask & F_MITER_LIMIT) putFloat(o, 25, p.miterLimit);
  if (mask & F_DASH_PATTERN) {
    o.varuint(13);
    o.varuint(static_cast<uint32_t>(p.stroke().dashPattern.size()));
    for (double d : p.stroke().dashPattern) o.varfloat(static_cast<float>(d));
  }
  if (mask & F_BORDER_WEIGHTS) {
    putFloat(o, id::kBorderTop, p.stroke().borderWeights[0]);
    putFloat(o, id::kBorderBottom, p.stroke().borderWeights[2]);
    putFloat(o, id::kBorderLeft, p.stroke().borderWeights[3]);
    putFloat(o, id::kBorderRight, p.stroke().borderWeights[1]);
    putBool(o, id::kBordersIndependent, p.stroke().borderStrokeWeightsIndependent);
  }
  if (mask & F_CORNER_SMOOTHING) putFloat(o, 160, p.stroke().cornerSmoothing);
  if (mask & F_EFFECTS) {
    o.varuint(43);
    o.varuint(static_cast<uint32_t>(p.effects.size()));
    for (const Effect& e : p.effects) putEffect(o, e);
  }
  if (mask & F_COUNT) putUint(o, 10, p.shape().count);
  if (mask & F_STAR_INNER_SCALE) putFloat(o, 24, p.shape().starInnerScale);
  if (mask & F_ARC_DATA) {
    o.varuint(195);
    putFloat(o, 1, p.shape().arcData.startingAngle);
    putFloat(o, 2, p.shape().arcData.endingAngle);
    putFloat(o, 3, p.shape().arcData.innerRadius);
    o.byte(0);
  }
  if (mask & F_VECTOR_DATA) {
    if (p.shape().vectorData.present) {
      o.varuint(48);
      putVectorData(o, p.shape().vectorData, blobs);
    } else if (update) {
      cleared.push_back(48);
    }
  }
  if (mask & F_HANDLE_MIRRORING) putEnum(o, 44, p.shape().handleMirroring);
  if (mask & F_BOOLEAN_OPERATION) putEnum(o, 36, p.shape().booleanOperation);
  if (mask & F_LAYOUT_GRIDS) {
    o.varuint(47);
    o.varuint(static_cast<uint32_t>(p.rare().layoutGrids.size()));
    for (const LayoutGrid& g : p.rare().layoutGrids) putLayoutGrid(o, g);
  }
  // Components.
  auto guidOrClear = [&](FieldMask bit, uint32_t fid, Guid g) {
    if (!(mask & bit)) return;
    if (g != kNoGuid) putGuidField(o, fid, g);
    else if (update) cleared.push_back(fid);
  };
  guidOrClear(F_OVERRIDE_KEY, 213, p.overrideKey);
  if (mask & F_SYMBOL_DATA) {
    if (p.comp().symbolData.present()) {
      o.varuint(113);
      if (p.comp().symbolData.symbolID != kNoGuid) putGuidField(o, 1, p.comp().symbolData.symbolID);
      o.varuint(2);
      o.varuint(static_cast<uint32_t>(p.comp().symbolData.overrides.size()));
      for (const SymbolOverride& ov : p.comp().symbolData.overrides) {
        putGuidPath(o, id::kGuidPath, ov.path);
        std::vector<uint32_t> none;
        putFields(o, ov.props, ov.mask & ~static_cast<FieldMask>(F_PARENT_INDEX | F_TYPE), false, blobs, none);
        o.byte(0);
      }
      putFloat(o, 3, p.comp().symbolData.uniformScaleFactor);
      o.byte(0);
    } else if (update) {
      cleared.push_back(113);
    }
  }
  guidOrClear(F_OVERRIDDEN_SYMBOL_ID, 143, p.comp().overriddenSymbolID);
  if (mask & F_COMPONENT_PROP_DEFS) {
    o.varuint(266);
    o.varuint(static_cast<uint32_t>(p.comp().componentPropDefs.size()));
    for (const ComponentPropDef& d : p.comp().componentPropDefs) putPropDef(o, d, blobs);
  }
  if (mask & F_COMPONENT_PROP_ASSIGNMENTS) {
    o.varuint(268);
    o.varuint(static_cast<uint32_t>(p.comp().componentPropAssignments.size()));
    for (const ComponentPropAssignment& a : p.comp().componentPropAssignments) putPropAssignment(o, a, blobs);
  }
  if (mask & F_PARAM_MAP) putParamMap(o, 445, p.parameterConsumptionMap);
  if (mask & F_IS_STATE_GROUP) putBool(o, 225, p.comp().isStateGroup);
  if (mask & F_VARIANT_PROP_SPECS) {
    o.varuint(483);
    o.varuint(static_cast<uint32_t>(p.comp().variantPropSpecs.size()));
    for (const VariantPropSpec& v : p.comp().variantPropSpecs) {
      putGuidField(o, 1, v.propDefId);
      putString(o, 2, v.value);
      o.byte(0);
    }
  }
  if (mask & F_STATE_GROUP_ORDERS) {
    o.varuint(238);
    o.varuint(static_cast<uint32_t>(p.comp().stateGroupPropertyValueOrders.size()));
    for (const StateGroupOrder& so : p.comp().stateGroupPropertyValueOrders) {
      putString(o, 1, so.property);
      o.varuint(2);
      o.varuint(static_cast<uint32_t>(so.values.size()));
      for (const std::string& v : so.values) o.str(v);
      o.byte(0);
    }
  }
  if (mask & F_PROPS_ARE_BUBBLED) putBool(o, 305, p.comp().propsAreBubbled);
  if (mask & F_IS_SLOT) putBool(o, 463, p.comp().isSlot);
  if (mask & F_IS_SLOT_CONTENT) putBool(o, 495, p.comp().isSlotContent);
  if (mask & F_DETACHED_SYMBOL_ID) {
    if (p.comp().detachedSymbolId.present()) {
      putAssetId(o, 342, p.comp().detachedSymbolId);
    } else if (update) {
      cleared.push_back(342);
    }
  }
  if (mask & F_IS_SOFT_DELETED) putBool(o, 330, p.comp().isSoftDeleted);
  if (mask & F_ANCESTOR_PATH) {
    o.varuint(235);
    o.varuint(static_cast<uint32_t>(p.comp().ancestorPathBeforeDeletion.size()));
    for (Guid g : p.comp().ancestorPathBeforeDeletion) putGuid(o, g);
  }
  // Variables, modes, styles.
  if (mask & F_VARIABLE_MODES) {
    o.varuint(316);
    o.varuint(1);
    o.varuint(static_cast<uint32_t>(p.refs().variableModeBySetMap.size()));
    for (const VariableModeEntry& e : p.refs().variableModeBySetMap) {
      putAssetId(o, 1, e.set);
      if (e.mode != kNoGuid) putGuidField(o, 2, e.mode);  // an entry without a mode stays without one
      if (e.extension.present()) putAssetId(o, 3, e.extension);
      o.byte(0);
    }
    o.byte(0);
  }
  auto assetOrClear = [&](FieldMask bit, uint32_t fid, const AssetId& a) {
    if (!(mask & bit)) return;
    if (a.present()) putAssetId(o, fid, a);
    else if (update) cleared.push_back(fid);
  };
  assetOrClear(F_STYLE_ID_FILL, 332, p.refs().styleIdForFill);
  assetOrClear(F_STYLE_ID_STROKE, 333, p.refs().styleIdForStrokeFill);
  assetOrClear(F_STYLE_ID_TEXT, 334, p.refs().styleIdForText);
  assetOrClear(F_STYLE_ID_EFFECT, 335, p.refs().styleIdForEffect);
  assetOrClear(F_STYLE_ID_GRID, 336, p.refs().styleIdForGrid);
  if (mask & F_STYLE_TYPE) putEnum(o, 163, p.asset().styleType);
  if (mask & F_SORT_POSITION) putString(o, 320, p.asset().sortPosition);
  if (mask & F_DESCRIPTION) putString(o, 318, p.asset().description);
  if (mask & F_KEY) putString(o, 319, p.asset().key);
  if (mask & F_IS_PUBLISHABLE) putBool(o, 174, p.asset().isPublishable);
  if (mask & F_VARIABLE_SET_MODES) {
    o.varuint(312);
    o.varuint(static_cast<uint32_t>(p.asset().variableSetModes.size()));
    for (const VariableSetMode& mode : p.asset().variableSetModes) {
      putGuidField(o, 1, mode.id);
      putString(o, 2, mode.name);
      putString(o, 3, mode.sortPosition);
      if (mode.parentSet.present()) putAssetId(o, 4, mode.parentSet);
      if (mode.parentMode != kNoGuid) putGuidField(o, 5, mode.parentMode);
      o.byte(0);
    }
  }
  assetOrClear(F_VARIABLE_SET_ID, 313, p.asset().variableSetID);
  assetOrClear(F_OVERRIDDEN_VARIABLE, 464, p.asset().overriddenVariableId);
  if (mask & F_VARIABLE_RESOLVED_TYPE) putEnum(o, 314, p.asset().variableResolvedType);
  if (mask & F_VARIABLE_DATA_VALUES) {
    o.varuint(315);
    o.varuint(1);
    o.varuint(static_cast<uint32_t>(p.asset().variableDataValues.size()));
    for (const VariableModeValue& v : p.asset().variableDataValues) {
      putGuidField(o, 1, v.modeID);
      o.varuint(2);
      putVariableData(o, v.data);
      o.byte(0);
    }
    o.byte(0);
  }
  if (mask & F_VARIABLE_SCOPES) {
    if (p.asset().variableScopes) {
      o.varuint(353);
      o.varuint(static_cast<uint32_t>(p.asset().variableScopes->size()));
      for (VariableScope sc : *p.asset().variableScopes) o.varuint(static_cast<uint32_t>(sc));
    } else if (update) {
      cleared.push_back(353);
    }
  }
  if (mask & F_CODE_SYNTAX) {
    o.varuint(358);
    o.varuint(1);
    o.varuint(static_cast<uint32_t>(p.asset().codeSyntax.size()));
    for (const CodeSyntaxEntry& e : p.asset().codeSyntax) {
      putEnum(o, 1, e.platform);
      putString(o, 2, e.value);
      o.byte(0);
    }
    o.byte(0);
  }
  // Libraries: absent strings / GUIDs are cleared on update.
  auto stringOrClear = [&](FieldMask bit, uint32_t fid, const std::string& s) {
    if (!(mask & bit)) return;
    if (!s.empty()) putString(o, fid, s);
    else if (update) cleared.push_back(fid);
  };
  stringOrClear(F_VERSION, 171, p.asset().version);
  stringOrClear(F_PUBLISHED_VERSION, 218, p.asset().publishedVersion);
  stringOrClear(F_SOURCE_LIBRARY_KEY, 395, p.asset().sourceLibraryKey);
  guidOrClear(F_PUBLISH_ID, 215, p.asset().publishID);
  if (mask & F_LIBRARY_MOVE_INFO) {
    if (p.asset().libraryMoveInfo.present()) {
      o.varuint(256);
      putString(o, 1, p.asset().libraryMoveInfo.oldKey);
      putString(o, 2, p.asset().libraryMoveInfo.pasteFileKey);
      o.byte(0);
    } else if (update) {
      cleared.push_back(256);
    }
  }
  // Unmodelled fields, as they came; an empty value is a removal (clearedFields) on an update.
  if (mask & F_EXTRA)
    for (auto& [k, v] : p.extra) {
      if (!v.empty()) o.raw(v);
      else if (update)
        if (const FieldDef* fd = defs().nodeChange.byName(k)) cleared.push_back(fd->value);
    }
}

}  // namespace

// ---- Blobs ----------------------------------------------------------------------------------------------

Bytes KiwiBlobs::get(uint32_t index) {
  if (index >= slots_.size()) slots_.resize(static_cast<size_t>(index) + 1);
  auto& slot = slots_[index];
  if (!slot) slot = std::make_shared<std::vector<uint8_t>>();
  return slot;
}

void KiwiBlobs::fill(uint32_t index, const uint8_t* data, size_t len) {
  if (index >= slots_.size()) slots_.resize(static_cast<size_t>(index) + 1);
  auto& slot = slots_[index];
  if (!slot) slot = std::make_shared<std::vector<uint8_t>>();
  slot->assign(data, data + len);
}

void KiwiBlobs::deferImage(const ImageHash& hash, uint32_t index) { images_.emplace_back(hash, index); }

std::vector<Bytes> KiwiBlobs::table() const {
  std::vector<Bytes> out;
  out.reserve(slots_.size());
  for (auto& s : slots_) out.push_back(s);
  return out;
}

void KiwiBlobs::finish() {
  // Clipboard images: their bytes go to whoever draws images, now that the table is in.
  for (auto& [hash, index] : images_)
    if (index < slots_.size() && slots_[index] && !slots_[index]->empty())
      if (ImageDataSink sink = imageDataSink()) sink(hash, slots_[index]);
  images_.clear();
}

// ---- Changes and Messages --------------------------------------------------------------------------------

bool readChange(kiwi::ByteBuffer& bb, NodeChange& out, KiwiBlobs* blobs, DerivedSink* derived) {
  out = NodeChange{};
  Guid guid = kNoGuid;
  Phase phase = Phase::CHANGED;
  FieldMask m = 0;
  // The phase decides how clearedFields read: it may come after them. Read the fields once with update semantics
  // deferred: readFieldsInto applies clearedFields only when `update` — and the phase isn't known until the end.
  // So: read with update = true, then drop what an update would have done for a CREATED/REMOVED change.
  if (!readFieldsInto(bb, out.props, m, true, blobs, kNodeMode, &guid, &phase, nullptr, nullptr, nullptr, derived)) return false;
  if (guid == kNoGuid) return false;
  out.guid = guid;
  out.phase = phase;
  if (phase == Phase::CREATED) {
    out.mask = F_ALL;
    // Removal entries (empty extra values) mean nothing on a creation.
    for (auto it = out.props.extra.begin(); it != out.props.extra.end();) {
      if (it->second.empty()) it = out.props.extra.erase(it);
      else ++it;
    }
  } else if (phase == Phase::REMOVED) {
    out.mask = 0;
    out.props = NodeProps{};
  } else {
    out.mask = m;
  }
  return true;
}

void writeChange(kiwi::ByteBuffer& bb, const NodeChange& c, BlobsOut& blobs) {
  Out o;
  putGuidField(o, id::kGuid, c.guid);
  if (c.phase == Phase::CREATED) putUint(o, id::kPhase, 0);
  if (c.phase == Phase::REMOVED) putUint(o, id::kPhase, 1);
  if (c.phase != Phase::REMOVED) {
    std::vector<uint32_t> cleared;
    putFields(o, c.props, c.phase == Phase::CREATED ? presentFields(c.props) : c.mask, c.phase == Phase::CHANGED, &blobs, cleared);
    if (!cleared.empty()) {
      o.varuint(id::kClearedFields);
      o.varuint(static_cast<uint32_t>(cleared.size()));
      for (uint32_t cid : cleared) o.varuint(cid);
    }
  }
  o.byte(0);
  for (unsigned char ch : o.s) bb.writeByte(ch);
}

bool looksKiwi(std::string_view bytes) {
  for (char c : bytes) {
    if (c == ' ' || c == '\n' || c == '\r' || c == '\t') continue;
    return c != '{' && c != '[';
  }
  return false;
}

bool isMessageList(std::string_view bytes) { return !bytes.empty() && bytes[0] == '\0'; }

namespace {

void putRegions(Out& o, const std::vector<KiwiRegion>& regions) {
  o.varuint(id::kMsgRegions);
  o.varuint(static_cast<uint32_t>(regions.size()));
  for (const KiwiRegion& r : regions) {
    putGuidField(o, 1, r.parent);
    o.varuint(2);
    o.varuint(static_cast<uint32_t>(r.nodes.size()));
    for (Guid g : r.nodes) putGuid(o, g);
    o.varuint(3);
    putVector(o, r.offset);
    o.byte(0);
  }
}

bool readRegions(kiwi::ByteBuffer& bb, std::vector<KiwiRegion>& out) {
  uint32_t n = 0;
  if (!bb.readVarUint(n)) return false;
  const Def& def = defOf("ClipboardSelectionRegion");
  for (uint32_t i = 0; i < n; i++) {
    KiwiRegion r;
    for (;;) {
      uint32_t f = 0;
      if (!bb.readVarUint(f)) return false;
      if (!f) break;
      if (f == 1) {
        if (!getGuid(bb, r.parent)) return false;
      } else if (f == 2) {
        uint32_t k = 0;
        if (!bb.readVarUint(k)) return false;
        for (uint32_t j = 0; j < k; j++) {
          Guid g;
          if (!getGuid(bb, g)) return false;
          r.nodes.push_back(g);
        }
      } else if (f == 3) {
        if (!getVector(bb, r.offset)) return false;
      } else if (!skipUnknown(bb, def, f)) {
        return false;
      }
    }
    out.push_back(std::move(r));
  }
  return true;
}

}  // namespace

bool readMessage(std::string_view bytes, KiwiMessage& out, DerivedSink* derived) {
  kiwi::ByteBuffer bb(reinterpret_cast<const uint8_t*>(bytes.data()), bytes.size());
  KiwiBlobs blobs;
  out = KiwiMessage{};
  for (;;) {
    uint32_t f = 0;
    if (!bb.readVarUint(f)) return false;
    if (!f) break;
    switch (f) {
      case id::kMsgType:
      case id::kMsgAck: {
        uint32_t v;
        if (!bb.readVarUint(v)) return false;
        break;
      }
      case id::kMsgSession:
        if (!bb.readVarUint(out.sessionID)) return false;
        break;
      case id::kMsgChanges: {
        uint32_t n = 0;
        if (!bb.readVarUint(n)) return false;
        out.changes.reserve(n);
        for (uint32_t i = 0; i < n; i++) {
          NodeChange c;
          if (!readChange(bb, c, &blobs, derived)) return false;
          out.changes.push_back(std::move(c));
        }
        break;
      }
      case id::kMsgBlobs: {
        uint32_t n = 0;
        if (!bb.readVarUint(n)) return false;
        for (uint32_t i = 0; i < n; i++) {
          uint32_t len = 0;
          if (!bb.readVarUint(len)) return false;
          if (bb.index() + len > bb.size()) return false;
          blobs.fill(i, bb.data() + bb.index(), len);
          for (uint32_t k = 0; k < len; k++) {
            uint8_t b;
            bb.readByte(b);
          }
        }
        break;
      }
      case id::kMsgPasteFileKey:
        if (!getString(bb, out.pasteFileKey)) return false;
        break;
      case id::kMsgPastePage:
        if (!getGuid(bb, out.pastePageId)) return false;
        out.hasPastePage = true;
        break;
      case id::kMsgIsCut:
        if (!getBool(bb, out.isCut)) return false;
        break;
      case id::kMsgRegions:
        if (!readRegions(bb, out.regions)) return false;
        break;
      case id::kMsgDerivedVersion:
        if (!bb.readVarUint(out.derivedDataVersion)) return false;
        break;
      default:
        if (!skipUnknown(bb, defs().message, f)) return false;
    }
  }
  blobs.finish();
  out.blobs = blobs.table();
  return true;
}

bool readMessageList(std::string_view bytes, std::vector<KiwiMessage>& out) {
  if (!isMessageList(bytes)) return false;
  kiwi::ByteBuffer bb(reinterpret_cast<const uint8_t*>(bytes.data()), bytes.size());
  uint8_t zero;
  bb.readByte(zero);
  uint32_t n = 0;
  if (!bb.readVarUint(n)) return false;
  for (uint32_t i = 0; i < n; i++) {
    uint32_t len = 0;
    if (!bb.readVarUint(len) || bb.index() + len > bb.size()) return false;
    KiwiMessage m;
    if (!readMessage(bytes.substr(bb.index(), len), m)) return false;
    out.push_back(std::move(m));
    for (uint32_t k = 0; k < len; k++) {
      uint8_t b;
      bb.readByte(b);
    }
  }
  return true;
}

std::string writeMessageList(const std::vector<std::string>& messages) {
  Out o;
  o.byte(0);
  o.varuint(static_cast<uint32_t>(messages.size()));
  for (const std::string& m : messages) {
    o.varuint(static_cast<uint32_t>(m.size()));
    o.raw(m);
  }
  return std::move(o.s);
}

std::string writeMessage(uint32_t sessionID, const std::vector<NodeChange>& changes, const KiwiWriteOptions& opts) {
  Out o;
  putUint(o, id::kMsgType, 1);  // NODE_CHANGES
  putUint(o, id::kMsgSession, sessionID);
  putUint(o, id::kMsgAck, 0);
  BlobsOut blobs;
  {
    Out body;
    body.varuint(static_cast<uint32_t>(changes.size()));
    for (const NodeChange& c : changes) {
      putGuidField(body, id::kGuid, c.guid);
      if (c.phase == Phase::CREATED) putUint(body, id::kPhase, 0);
      if (c.phase == Phase::REMOVED) putUint(body, id::kPhase, 1);
      if (c.phase != Phase::REMOVED) {
        std::vector<uint32_t> cleared;
        putFields(body, c.props, c.phase == Phase::CREATED ? presentFields(c.props) : c.mask, c.phase == Phase::CHANGED, &blobs, cleared);
        if (!cleared.empty()) {
          body.varuint(id::kClearedFields);
          body.varuint(static_cast<uint32_t>(cleared.size()));
          for (uint32_t cid : cleared) body.varuint(cid);
        }
        if (c.phase == Phase::CREATED && opts.extraFields) opts.extraFields(c, body.s, blobs);
      }
      body.byte(0);
    }
    o.varuint(id::kMsgChanges);
    o.raw(body.s);
  }
  if (!blobs.empty()) {
    o.varuint(id::kMsgBlobs);
    o.varuint(static_cast<uint32_t>(blobs.list().size()));
    for (const Bytes& b : blobs.list()) {
      o.varuint(b ? static_cast<uint32_t>(b->size()) : 0);
      if (b) o.bytes(b->data(), b->size());
    }
  }
  if (!opts.pasteFileKey.empty()) putString(o, id::kMsgPasteFileKey, opts.pasteFileKey);
  if (opts.pastePageId) putGuidField(o, id::kMsgPastePage, *opts.pastePageId);
  if (opts.isCut) putBool(o, id::kMsgIsCut, true);
  if (opts.regions) putRegions(o, *opts.regions);
  if (opts.derivedDataVersion) putUint(o, id::kMsgDerivedVersion, opts.derivedDataVersion);
  o.byte(0);
  return std::move(o.s);
}

void writePaint(kiwi::ByteBuffer& bb, const Paint& p, BlobsOut* blobs) {
  Out o;
  putPaint(o, p, blobs);
  for (unsigned char ch : o.s) bb.writeByte(ch);
}
bool readPaint(kiwi::ByteBuffer& bb, Paint& out, KiwiBlobs* blobs) {
  out = Paint{};
  return readPaintInto(bb, out, blobs);
}
void writeVariableData(kiwi::ByteBuffer& bb, const VariableData& d) {
  Out o;
  putVariableData(o, d);
  for (unsigned char ch : o.s) bb.writeByte(ch);
}
bool readVariableData(kiwi::ByteBuffer& bb, VariableData& out) {
  out = VariableData{};
  return readVariableDataInto(bb, out);
}

// ---- Unmodelled fields ⇄ JSON ------------------------------------------------------------------------------

std::string withoutField(const char* defName, std::string sequence, uint32_t id) {
  if (const Def* d = table().def(defName)) schema::eraseField(*d, sequence, id);
  return sequence;
}

std::string extraToJsonMembers(const char* defName, std::string_view sequence) {
  if (sequence.empty()) return std::string();
  const Def* d = table().def(defName);
  if (!d) return std::string();
  json::Writer w;
  w.beginObject();
  if (!table().fieldsToJson(w, *d, sequence)) return std::string();
  w.endObject();
  std::string s = w.take();
  // Strip the braces: the members alone.
  return s.size() >= 2 ? s.substr(1, s.size() - 2) : std::string();
}

std::string extraValueToJson(const char* defName, std::string_view entry) {
  const Def* d = table().def(defName);
  if (!d || entry.empty()) return "null";
  kiwi::ByteBuffer bb(reinterpret_cast<const uint8_t*>(entry.data()), entry.size());
  uint32_t fid = 0;
  if (!bb.readVarUint(fid)) return "null";
  const FieldDef* f = d->byId(fid);
  if (!f) return "null";
  json::Writer w;
  if (!table().valueToJson(w, *f, bb)) return "null";
  return w.take();
}

std::string extraFromJson(const char* defName, std::string_view key, const json::Value& value) {
  const Def* d = table().def(defName);
  if (!d) return std::string();
  const FieldDef* f = d->byName(key);
  if (!f) return std::string();
  Out o;
  if (!table().fieldFromJson(o, *f, value)) return std::string();
  return std::move(o.s);
}

uint32_t fieldIdOf(const char* defName, std::string_view key) {
  const Def* d = table().def(defName);
  const FieldDef* f = d ? d->byName(key) : nullptr;
  return f ? f->value : 0;
}

bool assignmentVarValue(std::string_view extra, VariableData& out) {
  if (extra.empty()) return false;
  kiwi::ByteBuffer bb(reinterpret_cast<const uint8_t*>(extra.data()), extra.size());
  while (bb.index() < extra.size()) {
    uint32_t f = 0;
    if (!bb.readVarUint(f) || !f) return false;
    if (f == 3) return readVariableDataInto(bb, out);  // varValue
    const FieldDef* fd = defs().propAssignment.byId(f);
    if (!fd || !table().skipValue(bb, *fd)) return false;
  }
  return false;
}

bool assignmentVarProp(std::string_view extra, ComponentPropValue& out) {
  VariableData d;
  if (!assignmentVarValue(extra, d)) return false;
  if (d.kind == VariableData::Kind::BOOL) {
    out.hasBool = true;
    out.boolValue = d.boolValue;
    return true;
  }
  if (d.valueExtra.empty()) return false;
  // The members the engine keeps as bytes: symbolIdValue (8, SymbolId {1 guid}), textDataValue (10, TextData).
  kiwi::ByteBuffer bb(reinterpret_cast<const uint8_t*>(d.valueExtra.data()), d.valueExtra.size());
  uint32_t f = 0;
  if (!bb.readVarUint(f)) return false;
  if (f == 10) {
    TextData t;
    if (!readTextData(bb, t, nullptr)) return false;
    out.hasText = true;
    out.textValue = std::move(t);
    return true;
  }
  if (f == 8) {
    for (;;) {
      uint32_t e = 0;
      if (!bb.readVarUint(e) || !e) break;
      if (e != 1) return false;
      Guid g;
      if (!getGuid(bb, g)) return false;
      out.guidValue = noneToAbsent(g);
    }
    return out.guidValue != kNoGuid;
  }
  return false;
}

Guid assignmentSlotContent(std::string_view extra) {
  VariableData d;
  if (!assignmentVarValue(extra, d)) return kNoGuid;
  return d.kind == VariableData::Kind::SLOT_CONTENT ? d.slotContent : kNoGuid;
}

bool extraBool(const std::map<std::string, std::string>& extra, const char* key, bool fallback) {
  auto it = extra.find(key);
  if (it == extra.end() || it->second.empty()) return fallback;
  kiwi::ByteBuffer bb(reinterpret_cast<const uint8_t*>(it->second.data()), it->second.size());
  uint32_t fid;
  uint8_t b = fallback ? 1 : 0;
  if (!bb.readVarUint(fid) || !bb.readByte(b)) return fallback;
  return b != 0;
}

}  // namespace eng::codec
