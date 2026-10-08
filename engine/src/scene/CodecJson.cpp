#include "scene/CodecJson.h"

#include <algorithm>

#include "base/Base64.h"
#include "scene/CodecKiwi.h"

namespace eng::codec {

namespace {

ImageDataSink gImageDataSink = nullptr;

const char* kCornerKeys[4] = {"rectangleTopLeftCornerRadius", "rectangleTopRightCornerRadius",
                              "rectangleBottomRightCornerRadius", "rectangleBottomLeftCornerRadius"};

const char* paintTypeName(PaintType t) {
  switch (t) {
    case PaintType::SOLID: return "SOLID";
    case PaintType::GRADIENT_LINEAR: return "GRADIENT_LINEAR";
    case PaintType::GRADIENT_RADIAL: return "GRADIENT_RADIAL";
    case PaintType::GRADIENT_ANGULAR: return "GRADIENT_ANGULAR";
    case PaintType::GRADIENT_DIAMOND: return "GRADIENT_DIAMOND";
    case PaintType::IMAGE: return "IMAGE";
    default: return "SOLID";
  }
}

bool paintTypeFromName(std::string_view s, PaintType& out) {
  for (PaintType t : {PaintType::SOLID, PaintType::GRADIENT_LINEAR, PaintType::GRADIENT_RADIAL, PaintType::GRADIENT_ANGULAR,
                      PaintType::GRADIENT_DIAMOND, PaintType::IMAGE})
    if (s == paintTypeName(t)) {
      out = t;
      return true;
    }
  return false;
}

void writeColor(json::Writer& w, const Color& c) {
  w.beginObject().key("r").number(c.r).key("g").number(c.g).key("b").number(c.b).key("a").number(c.a).endObject();
}

void writeVector(json::Writer& w, Vec2 v) { w.beginObject().key("x").number(v.x).key("y").number(v.y).endObject(); }

void writeMatrix(json::Writer& w, const Mat2x3& m) {
  w.beginObject();
  w.key("m00").number(m.m00).key("m01").number(m.m01).key("m02").number(m.m02);
  w.key("m10").number(m.m10).key("m11").number(m.m11).key("m12").number(m.m12);
  w.endObject();
}

// Closes an object written by `w` with already-encoded members ("k":v,…) appended.
std::string withMembers(json::Writer& w, const std::string& members) {
  std::string s = w.take();
  if (!members.empty()) {
    s.pop_back();
    if (s.size() > 1) s += ",";
    s += members + "}";
  }
  return s;
}
// The same, the members being the unmodelled fields of schema message `def` kept as kiwi bytes.
std::string withExtra(json::Writer& w, const char* def, const std::string& extra) { return withMembers(w, extraToJsonMembers(def, extra)); }
// A JSON member the engine doesn't model → its kiwi bytes appended to `extra` (dropped when the schema has no such field).
void appendExtra(std::string& extra, const char* def, const std::string& key, const json::Value& x) {
  if (x.isNull()) return;
  extra += extraFromJson(def, key, x);
}

// ---- Variables (docs/schema.md §6) ----

Color readColor(const json::Value& c, Color fallback);
void writeGuidObject(json::Writer& w, Guid g);

// A GUID inside a structure; Figma's "none" sentinel (4294967295:4294967295) reads as absent.
bool readStructGuid(const json::Value& v, Guid& out) {
  Guid g;
  if (!readGuid(v, g)) return false;
  if (g.sessionID == 0xFFFFFFFFu && g.localID == 0xFFFFFFFFu) return false;
  out = g;
  return true;
}

void writeAssetId(json::Writer& w, const AssetId& a) {
  w.beginObject();
  if (a.guid != kNoGuid) {
    w.key("guid");
    writeGuidObject(w, a.guid);
  }
  if (!a.key.empty()) {
    w.key("assetRef").beginObject().key("key").string(a.key);
    if (!a.version.empty()) w.key("version").string(a.version);
    w.endObject();
  }
  w.endObject();
}

AssetId readAssetId(const json::Value& v) {
  AssetId a;
  if (v.isString()) {  // a bare GUID
    readStructGuid(v, a.guid);
    return a;
  }
  if (!v.isObject()) return a;
  if (auto* g = v.get("guid")) readStructGuid(*g, a.guid);
  if (auto* r = v.get("assetRef"); r && r->isObject()) {
    if (auto* k = r->get("key"); k && k->isString()) a.key = k->string;
    if (auto* ver = r->get("version"); ver && ver->isString()) a.version = ver->string;
  }
  return a;
}

void writeVariableData(json::Writer& out, const VariableData& d) {
  using K = VariableData::Kind;
  if (d.kind == K::OTHER) {
    out.raw("{" + extraToJsonMembers("VariableData", d.extra) + "}");
    return;
  }
  json::Writer w;
  w.beginObject();
  if (d.kind != K::NONE || !d.valueExtra.empty()) {
    json::Writer v;
    v.beginObject();
    switch (d.kind) {
      case K::BOOL: v.key("boolValue").boolean(d.boolValue); break;
      case K::TEXT: v.key("textValue").string(d.textValue); break;
      case K::FLOAT: v.key("floatValue").number(d.floatValue); break;
      case K::ALIAS:
        v.key("alias");
        writeAssetId(v, d.alias);
        break;
      case K::COLOR:
        v.key("colorValue");
        writeColor(v, d.colorValue);
        break;
      case K::EXPRESSION:
        v.key("expressionValue").beginObject().key("expressionFunction").string(enumName(d.function));
        v.key("expressionArguments").beginArray();
        for (const VariableData& a : d.args) writeVariableData(v, a);
        v.endArray().endObject();
        break;
      case K::FONT_STYLE: {
        static const char* kKeys[3] = {"asString", "asFloat", "asVariations"};
        v.key("fontStyleValue").beginObject();
        for (size_t i = 0; i < d.args.size() && i < 3; i++)
          if (d.args[i].present()) {
            v.key(kKeys[i]);
            writeVariableData(v, d.args[i]);
          }
        v.endObject();
        break;
      }
      case K::PROP_REF:
        v.key("propRefValue").beginObject().key("defId");
        writeGuidObject(v, d.propRef);
        v.endObject();
        break;
      default: break;
    }
    v.endObject();
    w.key("value").raw(withExtra(v, "VariableAnyValue", d.valueExtra));
  }
  if (d.hasDataType) w.key("dataType").string(enumName(d.dataType));
  if (d.hasResolvedType) w.key("resolvedDataType").string(enumName(d.resolvedDataType));
  w.endObject();
  out.raw(withExtra(w, "VariableData", d.extra));
}

template <typename E>
bool readEnumMember(const json::Value& x, E& out) {
  if (x.isString()) return enumFromName(x.string, out);
  if (x.isNumber() && x.number >= 0 && static_cast<size_t>(x.number) < EnumNames<E>::count &&
      EnumNames<E>::names[static_cast<size_t>(x.number)][0]) {
    out = static_cast<E>(static_cast<int>(x.number));
    return true;
  }
  return false;
}

VariableData readVariableData(const json::Value& v) {
  using K = VariableData::Kind;
  VariableData d;
  if (!v.isObject()) return d;
  auto other = [&]() {
    // Not a VariableData the engine models: kept whole as kiwi bytes (dropped when it can't be encoded at all).
    VariableData o;
    std::string whole;
    for (auto& [k, x] : v.object) whole += extraFromJson("VariableData", k, x);
    if (whole.empty()) return o;
    o.kind = K::OTHER;
    o.extra = std::move(whole);
    return o;
  };
  const json::Value* value = nullptr;
  for (auto& [k, x] : v.object) {
    if (k == "dataType") {
      if (!readEnumMember(x, d.dataType)) return other();
      d.hasDataType = true;
    } else if (k == "resolvedDataType") {
      if (!readEnumMember(x, d.resolvedDataType)) return other();
      d.hasResolvedType = true;
    } else if (k == "value") {
      value = &x;
    } else {
      appendExtra(d.extra, "VariableData", k, x);
    }
  }
  if (value && value->isObject()) {
    for (auto& [k, x] : value->object) {
      if (k == "boolValue" && x.isBool()) d.kind = K::BOOL, d.boolValue = x.boolean;
      else if (k == "textValue" && x.isString()) d.kind = K::TEXT, d.textValue = x.string;
      else if (k == "floatValue" && x.isNumber()) d.kind = K::FLOAT, d.floatValue = x.number;
      else if (k == "alias" && (x.isObject() || x.isString())) d.kind = K::ALIAS, d.alias = readAssetId(x);
      else if (k == "colorValue" && x.isObject()) d.kind = K::COLOR, d.colorValue = readColor(x, Color{0, 0, 0, 1});
      else if (k == "expressionValue" && x.isObject()) {
        const json::Value* fn = x.get("expressionFunction");
        if (!fn || !readEnumMember(*fn, d.function)) return other();
        for (auto& [ek, ex] : x.object)
          if (ek != "expressionFunction" && ek != "expressionArguments") return other();
        d.kind = K::EXPRESSION;
        if (auto* args = x.get("expressionArguments"); args && args->isArray())
          for (auto& a : args->array) {
            VariableData arg = readVariableData(a);
            if (arg.kind == K::OTHER) return other();
            d.args.push_back(std::move(arg));
          }
      } else if (k == "fontStyleValue" && x.isObject()) {
        d.kind = K::FONT_STYLE;
        d.args.assign(3, VariableData{});
        for (auto& [fk, fx] : x.object) {
          size_t i = fk == "asString" ? 0 : fk == "asFloat" ? 1 : fk == "asVariations" ? 2 : 3;
          if (i == 3) return other();
          d.args[i] = readVariableData(fx);
        }
        while (!d.args.empty() && !d.args.back().present()) d.args.pop_back();
      } else if (k == "propRefValue" && x.isObject()) {
        d.kind = K::PROP_REF;
        if (auto* id = x.get("defId")) readStructGuid(*id, d.propRef);
      } else {
        appendExtra(d.valueExtra, "VariableAnyValue", k, x);
      }
    }
  } else if (value) {
    appendExtra(d.extra, "VariableData", "value", *value);
  }
  return d;
}

void writePaint(json::Writer& out, const Paint& p) {
  if (p.type == PaintType::OTHER) {
    out.raw("{" + extraToJsonMembers("Paint", p.extra) + "}");
    return;
  }
  json::Writer w;
  w.beginObject();
  w.key("type").string(paintTypeName(p.type));
  if (p.type == PaintType::SOLID || !(p.color == Color{})) {
    w.key("color");
    writeColor(w, p.color);
  }
  w.key("opacity").number(p.opacity);
  w.key("visible").boolean(p.visible);
  if (p.blendMode != BlendMode::NORMAL) w.key("blendMode").string(enumName(p.blendMode));
  if (!p.stops.empty()) {
    w.key("stops").beginArray();
    for (auto& st : p.stops) {
      w.beginObject().key("color");
      writeColor(w, st.color);
      w.key("position").number(st.position).endObject();
    }
    w.endArray();
  }
  if (p.type != PaintType::SOLID) {
    w.key("transform");
    writeMatrix(w, p.transform);
  }
  if (p.image.present || !p.imageName.empty()) {
    w.key("image").beginObject();
    if (p.image.present) {
      w.key("hash").beginArray();
      for (uint8_t b : p.image.bytes) w.number(b);
      w.endArray();
    }
    if (!p.imageName.empty()) w.key("name").string(p.imageName);
    w.endObject();
  }
  if (p.type == PaintType::IMAGE) {
    w.key("imageScaleMode").string(enumName(p.imageScaleMode));
    if (p.rotation != 0) w.key("rotation").number(p.rotation);
    if (p.scale != 1) w.key("scale").number(p.scale);
    if (p.originalImageWidth) w.key("originalImageWidth").number(p.originalImageWidth);
    if (p.originalImageHeight) w.key("originalImageHeight").number(p.originalImageHeight);
  }
  if (p.paintFilter.any()) {
    const PaintFilter& f = p.paintFilter;
    w.key("paintFilter").beginObject();
    std::pair<const char*, float> fields[] = {{"tint", f.tint}, {"shadows", f.shadows}, {"highlights", f.highlights},
                                              {"detail", f.detail}, {"exposure", f.exposure}, {"vignette", f.vignette},
                                              {"temperature", f.temperature}, {"vibrance", f.vibrance},
                                              {"contrast", f.contrast}, {"brightness", f.brightness}};
    for (auto& [k, v] : fields)
      if (v != 0) w.key(k).number(v);
    w.endObject();
  }
  if (p.colorVar.present()) {
    w.key("colorVar");
    writeVariableData(w, p.colorVar);
  }
  bool stopVars = false;
  for (auto& sv : p.stopVars) stopVars |= sv.present();
  if (stopVars) {
    w.key("stopsVar").beginArray();
    for (size_t i = 0; i < p.stops.size(); i++) {
      w.beginObject().key("color");
      writeColor(w, p.stops[i].color);
      if (i < p.stopVars.size() && p.stopVars[i].present()) {
        w.key("colorVar");
        writeVariableData(w, p.stopVars[i]);
      }
      w.key("position").number(p.stops[i].position).endObject();
    }
    w.endArray();
  }
  if (p.opacityVar.present()) {
    w.key("opacityVar");
    writeVariableData(w, p.opacityVar);
  }
  w.endObject();
  out.raw(withExtra(w, "Paint", p.extra));
}

void writeEffect(json::Writer& out, const Effect& e) {
  json::Writer w;
  w.beginObject();
  w.key("type").string(enumName(e.type));
  w.key("color");
  writeColor(w, e.color);
  w.key("offset");
  writeVector(w, e.offset);
  w.key("radius").number(e.radius);
  w.key("visible").boolean(e.visible);
  w.key("blendMode").string(enumName(e.blendMode));
  w.key("spread").number(e.spread);
  w.key("showShadowBehindNode").boolean(e.showShadowBehindNode);
  std::pair<const char*, const VariableData*> vars[] = {
      {"radiusVar", &e.radiusVar.get()}, {"colorVar", &e.colorVar.get()}, {"spreadVar", &e.spreadVar.get()}, {"xVar", &e.xVar.get()}, {"yVar", &e.yVar.get()}};
  for (auto& [k, d] : vars)
    if (d->present()) {
      w.key(k);
      writeVariableData(w, *d);
    }
  w.endObject();
  out.raw(withExtra(w, "Effect", e.extra));
}

template <typename E>
void writeEnum(json::Writer& w, const char* key, E value) {
  w.key(key).string(enumName(value));
}

void writeNumberValue(json::Writer& w, const Number& n) {
  w.beginObject().key("value").number(n.value).key("units").string(enumName(n.units)).endObject();
}

void writeFontName(json::Writer& w, const FontName& f) {
  w.beginObject().key("family").string(f.family).key("style").string(f.style).key("postscript").string(f.postscript).endObject();
}

void writeTextStyle(json::Writer& out, const TextStyle& st) {
  json::Writer w;
  w.beginObject();
  w.key("styleID").number(st.styleID);
  if (st.mask & R_FONT_NAME) {
    w.key("fontName");
    writeFontName(w, st.fontName);
  }
  if (st.mask & R_FONT_SIZE) w.key("fontSize").number(st.fontSize);
  if (st.mask & R_LINE_HEIGHT) {
    w.key("lineHeight");
    writeNumberValue(w, st.lineHeight);
  }
  if (st.mask & R_LETTER_SPACING) {
    w.key("letterSpacing");
    writeNumberValue(w, st.letterSpacing);
  }
  if (st.mask & R_TEXT_CASE) w.key("textCase").string(enumName(st.textCase));
  if (st.mask & R_TEXT_DECORATION) w.key("textDecoration").string(enumName(st.textDecoration));
  if (st.mask & R_FILLS) {
    w.key("fillPaints");
    writePaints(w, st.fillPaints);
  }
  w.endObject();
  out.raw(withExtra(w, "NodeChange", st.extra));
}

void writeTextData(json::Writer& w, const TextData& t) {
  w.beginObject();
  w.key("characters").string(t.characters);
  if (!t.characterStyleIDs.empty()) {
    w.key("characterStyleIDs").beginArray();
    for (uint32_t id : t.characterStyleIDs) w.number(id);
    w.endArray();
  }
  if (!t.styleOverrideTable.empty()) {
    w.key("styleOverrideTable").beginArray();
    for (auto& st : t.styleOverrideTable) writeTextStyle(w, st);
    w.endArray();
  }
  if (!t.lines.empty()) {
    w.key("lines").beginArray();
    for (auto& l : t.lines) w.raw("{" + extraToJsonMembers("TextLineData", l) + "}");
    w.endArray();
  }
  w.endObject();
}

void writeVectorStyle(json::Writer& out, const VectorStyle& st) {
  json::Writer w;
  w.beginObject();
  w.key("styleID").number(st.styleID);
  if (st.mask & VS_FILLS) {
    w.key("fillPaints");
    writePaints(w, st.fillPaints);
  }
  if (st.mask & VS_STROKE_CAP) w.key("strokeCap").string(enumName(st.strokeCap));
  if (st.mask & VS_STROKE_JOIN) w.key("strokeJoin").string(enumName(st.strokeJoin));
  if (st.mask & VS_MIRRORING) w.key("handleMirroring").string(enumName(st.handleMirroring));
  if (st.mask & VS_CORNER_RADIUS) w.key("cornerRadius").number(st.cornerRadius);
  w.endObject();
  out.raw(withExtra(w, "NodeChange", st.extra));
}

void writeVectorData(json::Writer& w, const VectorData& v, BlobsOut* blobs) {
  w.beginObject();
  if (v.network && blobs) w.key("vectorNetworkBlob").number(blobs->add(v.network));
  w.key("normalizedSize");
  writeVector(w, v.normalizedSize);
  if (!v.styleOverrideTable.empty()) {
    w.key("styleOverrideTable").beginArray();
    for (auto& st : v.styleOverrideTable) writeVectorStyle(w, st);
    w.endArray();
  }
  w.endObject();
}

// GUIDs inside component structures: {"sessionID","localID"} (as decoded .fig files and the editor's model).
void writeGuidObject(json::Writer& w, Guid g) {
  w.beginObject().key("sessionID").number(g.sessionID).key("localID").number(g.localID).endObject();
}

void writeFields(json::Writer& w, const NodeProps& p, FieldMask mask, bool update, BlobsOut* blobs);

void writePropValue(json::Writer& out, const ComponentPropValue& v) {
  json::Writer w;
  w.beginObject();
  if (v.hasBool) w.key("boolValue").boolean(v.boolValue);
  if (v.hasText) {
    w.key("textValue");
    writeTextData(w, v.textValue);
  }
  if (v.guidValue != kNoGuid) {
    w.key("guidValue");
    writeGuidObject(w, v.guidValue);
  }
  w.endObject();
  out.raw(withExtra(w, "ComponentPropValue", v.extra));
}

void writeComponentFields(json::Writer& w, const NodeProps& p, FieldMask mask, bool update, std::vector<uint32_t>& cleared,
                          BlobsOut* blobs) {
  auto guidOrClear = [&](FieldMask bit, const char* key, Guid g) {
    if (!(mask & bit)) return;
    if (g != kNoGuid) {
      w.key(key);
      writeGuidObject(w, g);
    } else if (update) {
      cleared.push_back(kiwiFieldId(static_cast<Field>(bit)));
    }
  };
  guidOrClear(F_OVERRIDE_KEY, "overrideKey", p.overrideKey);
  if (mask & F_SYMBOL_DATA) {
    if (p.symbolData.present()) {
      w.key("symbolData").beginObject();
      if (p.symbolData.symbolID != kNoGuid) {
        w.key("symbolID");
        writeGuidObject(w, p.symbolData.symbolID);
      }
      w.key("symbolOverrides").beginArray();
      for (const SymbolOverride& o : p.symbolData.overrides) {
        w.beginObject();
        w.key("guidPath").beginObject().key("guids").beginArray();
        for (Guid g : o.path) writeGuidObject(w, g);
        w.endArray().endObject();
        writeFields(w, o.props, o.mask & ~static_cast<FieldMask>(F_PARENT_INDEX | F_TYPE), false, blobs);
        w.endObject();
      }
      w.endArray();
      w.key("uniformScaleFactor").number(p.symbolData.uniformScaleFactor);
      w.endObject();
    } else if (update) {
      cleared.push_back(kiwiFieldId(F_SYMBOL_DATA));
    }
  }
  guidOrClear(F_OVERRIDDEN_SYMBOL_ID, "overriddenSymbolID", p.overriddenSymbolID);
  if (mask & F_COMPONENT_PROP_DEFS) {
    w.key("componentPropDefs").beginArray();
    for (const ComponentPropDef& d : p.componentPropDefs) {
      json::Writer one;
      one.beginObject();
      one.key("id");
      writeGuidObject(one, d.id);
      one.key("name").string(d.name);
      one.key("initialValue");
      writePropValue(one, d.initialValue);
      if (!d.sortPosition.empty()) one.key("sortPosition").string(d.sortPosition);
      one.key("type").string(enumName(d.type));
      if (!d.preferredValues.empty() || !d.preferredExtra.empty()) {
        json::Writer pv;
        pv.beginObject();
        if (!d.preferredValues.empty()) {
          pv.key("instanceSwapValues").beginArray();
          for (const PreferredValue& v : d.preferredValues)
            pv.beginObject().key("type").string(v.stateGroup ? "STATE_GROUP" : "COMPONENT").key("key").string(v.key).endObject();
          pv.endArray();
        }
        pv.endObject();
        one.key("preferredValues").raw(withExtra(pv, "ComponentPropPreferredValues", d.preferredExtra));
      }
      if (!d.description.empty()) one.key("description").string(d.description);
      one.endObject();
      w.raw(withExtra(one, "ComponentPropDef", d.extra));
    }
    w.endArray();
  }
  if (mask & F_COMPONENT_PROP_ASSIGNMENTS) {
    w.key("componentPropAssignments").beginArray();
    for (const ComponentPropAssignment& a : p.componentPropAssignments) {
      json::Writer one;
      one.beginObject();
      one.key("defID");
      writeGuidObject(one, a.defID);
      one.key("value");
      writePropValue(one, a.value);
      one.endObject();
      w.raw(withExtra(one, "ComponentPropAssignment", a.extra));
    }
    w.endArray();
  }
  if (mask & F_PARAM_MAP) {
    w.key("parameterConsumptionMap").beginObject().key("entries").beginArray();
    for (const ParamBinding& b : p.parameterConsumptionMap) {
      w.beginObject();
      w.key("variableField").string(enumName(b.field));
      // No variableData: an override entry's unbind (the field's binding removed there).
      if (b.propRef != kNoGuid || b.data.present()) w.key("variableData");
      if (b.propRef != kNoGuid) {
        const char* resolved = b.field == VariableField::VISIBLE ? "BOOLEAN"
                               : b.field == VariableField::TEXT_DATA ? "TEXT_DATA"
                               : b.field == VariableField::OVERRIDDEN_SYMBOL_ID ? "SYMBOL_ID"
                               : b.field == VariableField::SLOT_CONTENT_ID ? "SLOT_CONTENT_ID" : "STRING";
        w.beginObject().key("value").beginObject().key("propRefValue").beginObject().key("defId");
        writeGuidObject(w, b.propRef);
        w.endObject().endObject().key("dataType").string("PROP_REF").key("resolvedDataType").string(resolved).endObject();
      } else if (b.data.present()) {
        writeVariableData(w, b.data);
      }
      w.endObject();
    }
    w.endArray().endObject();
  }
  if (mask & F_IS_STATE_GROUP) w.key("isStateGroup").boolean(p.isStateGroup);
  if (mask & F_VARIANT_PROP_SPECS) {
    w.key("variantPropSpecs").beginArray();
    for (const VariantPropSpec& v : p.variantPropSpecs) {
      w.beginObject().key("propDefId");
      writeGuidObject(w, v.propDefId);
      w.key("value").string(v.value).endObject();
    }
    w.endArray();
  }
  if (mask & F_STATE_GROUP_ORDERS) {
    w.key("stateGroupPropertyValueOrders").beginArray();
    for (const StateGroupOrder& o : p.stateGroupPropertyValueOrders) {
      w.beginObject().key("property").string(o.property).key("values").beginArray();
      for (auto& v : o.values) w.string(v);
      w.endArray().endObject();
    }
    w.endArray();
  }
  if (mask & F_PROPS_ARE_BUBBLED) w.key("propsAreBubbled").boolean(p.propsAreBubbled);
  if (mask & F_IS_SLOT) w.key("isSlot").boolean(p.isSlot);
  if (mask & F_IS_SLOT_CONTENT) w.key("isSlotContent").boolean(p.isSlotContent);
  if (mask & F_DETACHED_SYMBOL_ID) {
    if (p.detachedSymbolId != kNoGuid) {
      w.key("detachedSymbolId").beginObject().key("guid");
      writeGuidObject(w, p.detachedSymbolId);
      w.endObject();
    } else if (update) {
      cleared.push_back(kiwiFieldId(F_DETACHED_SYMBOL_ID));
    }
  }
  if (mask & F_IS_SOFT_DELETED) w.key("isSoftDeleted").boolean(p.isSoftDeleted);
  if (mask & F_ANCESTOR_PATH) {
    w.key("ancestorPathBeforeDeletion").beginArray();
    for (Guid g : p.ancestorPathBeforeDeletion) writeGuidObject(w, g);
    w.endArray();
  }
}

void writeVariableFields(json::Writer& w, const NodeProps& p, FieldMask mask, bool update, std::vector<uint32_t>& cleared) {
  if (mask & F_VARIABLE_MODES) {
    w.key("variableModeBySetMap").beginObject().key("entries").beginArray();
    for (const VariableModeEntry& e : p.variableModeBySetMap) {
      w.beginObject().key("variableSetID");
      writeAssetId(w, e.set);
      w.key("variableModeID");
      writeGuidObject(w, e.mode);
      w.endObject();
    }
    w.endArray().endObject();
  }
  auto assetOrClear = [&](FieldMask bit, const char* key, const AssetId& a) {
    if (!(mask & bit)) return;
    if (a.present()) {
      w.key(key);
      writeAssetId(w, a);
    } else if (update) {
      cleared.push_back(kiwiFieldId(static_cast<Field>(bit)));
    }
  };
  assetOrClear(F_STYLE_ID_FILL, "styleIdForFill", p.styleIdForFill);
  assetOrClear(F_STYLE_ID_STROKE, "styleIdForStrokeFill", p.styleIdForStrokeFill);
  assetOrClear(F_STYLE_ID_TEXT, "styleIdForText", p.styleIdForText);
  assetOrClear(F_STYLE_ID_EFFECT, "styleIdForEffect", p.styleIdForEffect);
  assetOrClear(F_STYLE_ID_GRID, "styleIdForGrid", p.styleIdForGrid);
  if (mask & F_STYLE_TYPE) writeEnum(w, "styleType", p.styleType);
  if (mask & F_SORT_POSITION) w.key("sortPosition").string(p.sortPosition);
  if (mask & F_DESCRIPTION) w.key("description").string(p.description);
  if (mask & F_KEY) w.key("key").string(p.key);
  if (mask & F_IS_PUBLISHABLE) w.key("isPublishable").boolean(p.isPublishable);
  if (mask & F_VARIABLE_SET_MODES) {
    w.key("variableSetModes").beginArray();
    for (const VariableSetMode& m : p.variableSetModes) {
      w.beginObject().key("id");
      writeGuidObject(w, m.id);
      w.key("name").string(m.name).key("sortPosition").string(m.sortPosition).endObject();
    }
    w.endArray();
  }
  assetOrClear(F_VARIABLE_SET_ID, "variableSetID", p.variableSetID);
  if (mask & F_VARIABLE_RESOLVED_TYPE) writeEnum(w, "variableResolvedType", p.variableResolvedType);
  if (mask & F_VARIABLE_DATA_VALUES) {
    w.key("variableDataValues").beginObject().key("entries").beginArray();
    for (const VariableModeValue& v : p.variableDataValues) {
      w.beginObject().key("modeID");
      writeGuidObject(w, v.modeID);
      w.key("variableData");
      writeVariableData(w, v.data);
      w.endObject();
    }
    w.endArray().endObject();
  }
  if (mask & F_VARIABLE_SCOPES) {
    if (p.variableScopes) {
      w.key("variableScopes").beginArray();
      for (VariableScope sc : *p.variableScopes) w.string(enumName(sc));
      w.endArray();
    } else if (update) {
      cleared.push_back(kiwiFieldId(F_VARIABLE_SCOPES));
    }
  }
  if (mask & F_CODE_SYNTAX) {
    w.key("codeSyntax").beginObject().key("entries").beginArray();
    for (const CodeSyntaxEntry& e : p.codeSyntax) w.beginObject().key("platform").string(enumName(e.platform)).key("value").string(e.value).endObject();
    w.endArray().endObject();
  }
  // Libraries (docs/schema.md §8): absent strings / GUIDs are cleared on update.
  auto stringOrClear = [&](FieldMask bit, const char* key, const std::string& s) {
    if (!(mask & bit)) return;
    if (!s.empty()) w.key(key).string(s);
    else if (update) cleared.push_back(kiwiFieldId(static_cast<Field>(bit)));
  };
  stringOrClear(F_VERSION, "version", p.version);
  stringOrClear(F_PUBLISHED_VERSION, "publishedVersion", p.publishedVersion);
  stringOrClear(F_SOURCE_LIBRARY_KEY, "sourceLibraryKey", p.sourceLibraryKey);
  if (mask & F_PUBLISH_ID) {
    if (p.publishID != kNoGuid) {
      w.key("publishID");
      writeGuidObject(w, p.publishID);
    } else if (update) {
      cleared.push_back(kiwiFieldId(F_PUBLISH_ID));
    }
  }
  if (mask & F_LIBRARY_MOVE_INFO) {
    if (p.libraryMoveInfo.present()) {
      w.key("libraryMoveInfo").beginObject().key("oldKey").string(p.libraryMoveInfo.oldKey);
      w.key("pasteFileKey").string(p.libraryMoveInfo.pasteFileKey).endObject();
    } else if (update) {
      cleared.push_back(kiwiFieldId(F_LIBRARY_MOVE_INFO));
    }
  }
}

// Writes the fields in `mask`; for an update, an optional field that is unset
// in `p` goes to clearedFields instead.
void writeFields(json::Writer& w, const NodeProps& p, FieldMask mask, bool update, BlobsOut* blobs) {
  std::vector<uint32_t> cleared;
  if (mask & F_PARENT_INDEX) {
    w.key("parentIndex").beginObject();
    w.key("guid").string(p.parentIndex.guid == kNoGuid ? std::string() : p.parentIndex.guid.toString());
    w.key("position").string(p.parentIndex.position);
    w.endObject();
  }
  if (mask & F_TYPE) w.key("type").string(nodeTypeName(p.type));
  if (mask & F_NAME) w.key("name").string(p.name);
  if (mask & F_VISIBLE) w.key("visible").boolean(p.visible);
  if (mask & F_LOCKED) w.key("locked").boolean(p.locked);
  if (mask & F_OPACITY) w.key("opacity").number(p.opacity);
  if (mask & F_SIZE) {
    w.key("size");
    writeVector(w, p.size);
  }
  if (mask & F_TRANSFORM) {
    const Mat2x3& m = p.transform;
    w.key("transform").beginObject();
    w.key("m00").number(m.m00).key("m01").number(m.m01).key("m02").number(m.m02);
    w.key("m10").number(m.m10).key("m11").number(m.m11).key("m12").number(m.m12);
    w.endObject();
  }
  if (mask & F_CORNER_RADII) {
    // Figma's encoding: the uniform cornerRadius, and the four corners when they differ.
    const CornerRadii& r = p.cornerRadii;
    bool independent = !(r[0] == r[1] && r[1] == r[2] && r[2] == r[3]);
    w.key("cornerRadius").number(r[0]);
    w.key("rectangleCornerRadiiIndependent").boolean(independent);
    for (int i = 0; i < 4; i++) w.key(kCornerKeys[i]).number(r[static_cast<size_t>(i)]);
  }
  if (mask & F_STROKE_WEIGHT) w.key("strokeWeight").number(p.strokeWeight);
  if (mask & F_STROKE_ALIGN) writeEnum(w, "strokeAlign", p.strokeAlign);
  if (mask & F_FILLS) {
    w.key("fillPaints");
    writePaints(w, p.fillPaints);
  }
  if (mask & F_STROKES) {
    w.key("strokePaints");
    writePaints(w, p.strokePaints);
  }
  if (mask & F_FRAME_MASK_DISABLED) w.key("frameMaskDisabled").boolean(p.frameMaskDisabled);
  if (mask & F_RESIZE_TO_FIT) w.key("resizeToFit").boolean(p.resizeToFit);
  if (mask & F_BACKGROUND_COLOR) {
    w.key("backgroundColor");
    writeColor(w, p.backgroundColor);
  }
  if (mask & F_BACKGROUND_ENABLED) w.key("backgroundEnabled").boolean(p.backgroundEnabled);
  if (mask & F_INTERNAL_ONLY) w.key("internalOnly").boolean(p.internalOnly);
  // Auto layout.
  if (mask & F_STACK_MODE) writeEnum(w, "stackMode", p.stackMode);
  if (mask & F_STACK_SPACING) w.key("stackSpacing").number(p.stackSpacing);
  if (mask & F_STACK_PADDING_LEFT) w.key("stackHorizontalPadding").number(p.stackPaddingLeft);
  if (mask & F_STACK_PADDING_TOP) w.key("stackVerticalPadding").number(p.stackPaddingTop);
  if (mask & F_STACK_PADDING_RIGHT) w.key("stackPaddingRight").number(p.stackPaddingRight);
  if (mask & F_STACK_PADDING_BOTTOM) w.key("stackPaddingBottom").number(p.stackPaddingBottom);
  if (mask & F_STACK_PRIMARY_SIZING) writeEnum(w, "stackPrimarySizing", p.stackPrimarySizing);
  if (mask & F_STACK_COUNTER_SIZING) writeEnum(w, "stackCounterSizing", p.stackCounterSizing);
  if (mask & F_STACK_PRIMARY_ALIGN) writeEnum(w, "stackPrimaryAlignItems", p.stackPrimaryAlignItems);
  if (mask & F_STACK_COUNTER_ALIGN) writeEnum(w, "stackCounterAlignItems", p.stackCounterAlignItems);
  if (mask & F_STACK_COUNTER_ALIGN_CONTENT) writeEnum(w, "stackCounterAlignContent", p.stackCounterAlignContent);
  if (mask & F_STACK_WRAP) writeEnum(w, "stackWrap", p.stackWrap);
  if (mask & F_STACK_COUNTER_SPACING) {
    if (p.stackCounterSpacing) w.key("stackCounterSpacing").number(*p.stackCounterSpacing);
    else if (update) cleared.push_back(kiwiFieldId(F_STACK_COUNTER_SPACING));
  }
  if (mask & F_STACK_REVERSE_Z) w.key("stackReverseZIndex").boolean(p.stackReverseZIndex);
  if (mask & F_BORDERS_TAKE_SPACE) w.key("bordersTakeSpace").boolean(p.bordersTakeSpace);
  if (mask & F_STACK_CHILD_GROW) w.key("stackChildPrimaryGrow").number(p.stackChildPrimaryGrow);
  if (mask & F_STACK_CHILD_ALIGN_SELF) writeEnum(w, "stackChildAlignSelf", p.stackChildAlignSelf);
  if (mask & F_STACK_POSITIONING) writeEnum(w, "stackPositioning", p.stackPositioning);
  if (mask & F_MIN_SIZE) {
    w.key("minSize").beginObject().key("value");
    writeVector(w, p.minSize);
    w.endObject();
  }
  if (mask & F_MAX_SIZE) {
    w.key("maxSize").beginObject().key("value");
    writeVector(w, p.maxSize);
    w.endObject();
  }
  if (mask & F_H_CONSTRAINT) writeEnum(w, "horizontalConstraint", p.horizontalConstraint);
  if (mask & F_V_CONSTRAINT) writeEnum(w, "verticalConstraint", p.verticalConstraint);
  if (mask & F_PROPORTIONS_CONSTRAINED) w.key("proportionsConstrained").boolean(p.proportionsConstrained);
  // Text.
  if (mask & F_TEXT_DATA) {
    w.key("textData");
    writeTextData(w, p.textData);
  }
  if (mask & F_FONT_NAME) {
    w.key("fontName");
    writeFontName(w, p.fontName);
  }
  if (mask & F_FONT_SIZE) w.key("fontSize").number(p.fontSize);
  if (mask & F_LINE_HEIGHT) {
    w.key("lineHeight");
    writeNumberValue(w, p.lineHeight);
  }
  if (mask & F_LETTER_SPACING) {
    w.key("letterSpacing");
    writeNumberValue(w, p.letterSpacing);
  }
  if (mask & F_PARAGRAPH_SPACING) w.key("paragraphSpacing").number(p.paragraphSpacing);
  if (mask & F_PARAGRAPH_INDENT) w.key("paragraphIndent").number(p.paragraphIndent);
  if (mask & F_TEXT_ALIGN_H) writeEnum(w, "textAlignHorizontal", p.textAlignHorizontal);
  if (mask & F_TEXT_ALIGN_V) writeEnum(w, "textAlignVertical", p.textAlignVertical);
  if (mask & F_TEXT_AUTO_RESIZE) writeEnum(w, "textAutoResize", p.textAutoResize);
  if (mask & F_TEXT_TRUNCATION) writeEnum(w, "textTruncation", p.textTruncation);
  if (mask & F_MAX_LINES) w.key("maxLines").number(p.maxLines);
  if (mask & F_TEXT_CASE) writeEnum(w, "textCase", p.textCase);
  if (mask & F_TEXT_DECORATION) writeEnum(w, "textDecoration", p.textDecoration);
  if (mask & F_AUTO_RENAME) w.key("autoRename").boolean(p.autoRename);
  // Paint, stroke, effects, masks.
  if (mask & F_BLEND_MODE) writeEnum(w, "blendMode", p.blendMode);
  if (mask & F_MASK) w.key("mask").boolean(p.mask);
  if (mask & F_MASK_TYPE) writeEnum(w, "maskType", p.maskType);
  if (mask & F_STROKE_CAP) writeEnum(w, "strokeCap", p.strokeCap);
  if (mask & F_STROKE_JOIN) writeEnum(w, "strokeJoin", p.strokeJoin);
  if (mask & F_MITER_LIMIT) w.key("miterLimit").number(p.miterLimit);
  if (mask & F_DASH_PATTERN) {
    w.key("dashPattern").beginArray();
    for (double d : p.dashPattern) w.number(d);
    w.endArray();
  }
  if (mask & F_BORDER_WEIGHTS) {
    w.key("borderTopWeight").number(p.borderWeights[0]);
    w.key("borderRightWeight").number(p.borderWeights[1]);
    w.key("borderBottomWeight").number(p.borderWeights[2]);
    w.key("borderLeftWeight").number(p.borderWeights[3]);
    w.key("borderStrokeWeightsIndependent").boolean(p.borderStrokeWeightsIndependent);
  }
  if (mask & F_CORNER_SMOOTHING) w.key("cornerSmoothing").number(p.cornerSmoothing);
  if (mask & F_EFFECTS) {
    w.key("effects").beginArray();
    for (auto& e : p.effects) writeEffect(w, e);
    w.endArray();
  }
  if (mask & F_COUNT) w.key("count").number(p.count);
  if (mask & F_STAR_INNER_SCALE) w.key("starInnerScale").number(p.starInnerScale);
  if (mask & F_ARC_DATA) {
    w.key("arcData").beginObject();
    w.key("startingAngle").number(p.arcData.startingAngle).key("endingAngle").number(p.arcData.endingAngle);
    w.key("innerRadius").number(p.arcData.innerRadius).endObject();
  }
  if (mask & F_VECTOR_DATA) {
    if (p.vectorData.present) {
      w.key("vectorData");
      writeVectorData(w, p.vectorData, blobs);
    } else if (update) {
      cleared.push_back(kiwiFieldId(F_VECTOR_DATA));
    }
  }
  if (mask & F_HANDLE_MIRRORING) writeEnum(w, "handleMirroring", p.handleMirroring);
  if (mask & F_BOOLEAN_OPERATION) writeEnum(w, "booleanOperation", p.booleanOperation);
  if (mask & F_LAYOUT_GRIDS) {
    w.key("layoutGrids").beginArray();
    for (auto& g : p.layoutGrids) {
      json::Writer one;
      one.beginObject();
      one.key("type").string(enumName(g.type)).key("axis").string(enumName(g.axis)).key("visible").boolean(g.visible);
      one.key("numSections").number(g.numSections).key("offset").number(g.offset).key("sectionSize").number(g.sectionSize);
      one.key("gutterSize").number(g.gutterSize).key("color");
      writeColor(one, g.color);
      one.key("pattern").string(enumName(g.pattern));
      std::pair<const char*, const VariableData*> vars[] = {{"numSectionsVar", &g.numSectionsVar.get()}, {"offsetVar", &g.offsetVar.get()},
                                                            {"sectionSizeVar", &g.sectionSizeVar.get()}, {"gutterSizeVar", &g.gutterSizeVar.get()}};
      for (auto& [k, d] : vars)
        if (d->present()) {
          one.key(k);
          writeVariableData(one, *d);
        }
      one.endObject();
      w.raw(withExtra(one, "LayoutGrid", g.extra));
    }
    w.endArray();
  }
  writeComponentFields(w, p, mask, update, cleared, blobs);
  writeVariableFields(w, p, mask, update, cleared);
  if (mask & F_EXTRA)
    for (auto& [k, v] : p.extra) {
      if (!v.empty()) w.key(k).raw(extraValueToJson("NodeChange", v));
      else if (update) w.key(k).null();
    }
  if (!cleared.empty()) {
    w.key("clearedFields").beginArray();
    for (uint32_t id : cleared) w.number(id);
    w.endArray();
  }
}

Color readColor(const json::Value& c, Color fallback) {
  Color out = fallback;
  if (!c.isObject()) return out;
  if (auto* r = c.get("r")) out.r = static_cast<float>(r->numberOr(0));
  if (auto* g = c.get("g")) out.g = static_cast<float>(g->numberOr(0));
  if (auto* b = c.get("b")) out.b = static_cast<float>(b->numberOr(0));
  if (auto* a = c.get("a")) out.a = static_cast<float>(a->numberOr(1));
  return out;
}

Vec2 readVector(const json::Value& v) {
  Vec2 out;
  if (!v.isObject()) return out;
  if (auto* x = v.get("x")) out.x = x->numberOr(0);
  if (auto* y = v.get("y")) out.y = y->numberOr(0);
  return out;
}

Mat2x3 readMatrix(const json::Value& x) {
  auto num = [&](const char* k, double d) {
    auto* e = x.get(k);
    return e ? e->numberOr(d) : d;
  };
  return {num("m00", 1), num("m01", 0), num("m02", 0), num("m10", 0), num("m11", 1), num("m12", 0)};
}

bool readHash(const json::Value& x, ImageHash& out) {
  if (x.isString()) {
    bool ok = false;
    out = ImageHash::fromHex(x.string, &ok);
    return ok;
  }
  if (x.isArray() && x.array.size() == 20) {
    for (size_t i = 0; i < 20; i++) out.bytes[i] = static_cast<uint8_t>(std::clamp(x.array[i].numberOr(0), 0.0, 255.0));
    out.present = true;
    return true;
  }
  return false;
}

Paint readPaint(const json::Value& e, const BlobsIn* blobs) {
  Paint p;
  const json::Value* type = e.get("type");
  if (type && type->isString() && !paintTypeFromName(type->string, p.type)) {
    // A paint type the schema doesn't know: kept as it came (what the schema can encode of it).
    p.type = PaintType::OTHER;
    for (auto& [k, x] : e.object) p.extra += extraFromJson("Paint", k, x);
    if (auto* vis = e.get("visible"); vis && vis->isBool()) p.visible = vis->boolean;
    return p;
  }
  Bytes imageData;
  const json::Value* stopsVar = nullptr;
  for (auto& [k, x] : e.object) {
    if (k == "type") continue;
    if (k == "color") p.color = readColor(x, Color{0, 0, 0, 1});
    else if (k == "opacity" && x.isNumber()) p.opacity = static_cast<float>(x.number);
    else if (k == "visible" && x.isBool()) p.visible = x.boolean;
    else if (k == "blendMode" && x.isString() && enumFromName(x.string, p.blendMode)) {
    } else if (k == "stops" && x.isArray()) {
      for (auto& st : x.array) {
        ColorStop cs;
        if (auto* c = st.get("color")) cs.color = readColor(*c, Color{0, 0, 0, 1});
        if (auto* pos = st.get("position")) cs.position = pos->numberOr(0);
        p.stops.push_back(cs);
      }
    } else if (k == "transform" && x.isObject()) {
      p.transform = readMatrix(x);
    } else if (k == "image" && x.isObject()) {
      for (auto& [ik, iv] : x.object) {
        if (ik == "hash") readHash(iv, p.image);
        else if (ik == "name" && iv.isString()) p.imageName = iv.string;
        else if (ik == "dataBlob" && blobs) imageData = blobs->get(&iv);
      }
    } else if (k == "imageScaleMode" && x.isString() && enumFromName(x.string, p.imageScaleMode)) {
    } else if (k == "rotation" && x.isNumber()) p.rotation = static_cast<float>(x.number);
    else if (k == "scale" && x.isNumber()) p.scale = static_cast<float>(x.number);
    else if (k == "originalImageWidth" && x.isNumber()) p.originalImageWidth = static_cast<uint32_t>(std::max(0.0, x.number));
    else if (k == "originalImageHeight" && x.isNumber()) p.originalImageHeight = static_cast<uint32_t>(std::max(0.0, x.number));
    else if (k == "paintFilter" && x.isObject()) {
      PaintFilter& f = p.paintFilter;
      std::pair<const char*, float*> fields[] = {{"tint", &f.tint}, {"shadows", &f.shadows}, {"highlights", &f.highlights},
                                                 {"detail", &f.detail}, {"exposure", &f.exposure}, {"vignette", &f.vignette},
                                                 {"temperature", &f.temperature}, {"vibrance", &f.vibrance},
                                                 {"contrast", &f.contrast}, {"brightness", &f.brightness}};
      for (auto& [fk, fv] : fields)
        if (auto* n = x.get(fk)) *fv = static_cast<float>(n->numberOr(0));
    } else if (k == "colorVar" && x.isObject()) {
      p.colorVar = readVariableData(x);
    } else if (k == "opacityVar" && x.isObject()) {
      p.opacityVar = readVariableData(x);
    } else if (k == "stopsVar" && x.isArray()) {
      stopsVar = &x;
    } else {
      appendExtra(p.extra, "Paint", k, x);
    }
  }
  if (stopsVar) {
    // Each stop's binding (index-aligned with `stops`); the stops themselves come from here when `stops` is absent.
    bool fill = p.stops.empty();
    for (auto& st : stopsVar->array) {
      VariableData var;
      if (auto* cv = st.get("colorVar"); cv && cv->isObject()) var = readVariableData(*cv);
      p.stopVars.push_back(std::move(var));
      if (fill) {
        ColorStop cs;
        if (auto* c = st.get("color")) cs.color = readColor(*c, Color{0, 0, 0, 1});
        if (auto* pos = st.get("position")) cs.position = pos->numberOr(0);
        p.stops.push_back(cs);
      }
    }
    while (!p.stopVars.empty() && !p.stopVars.back().present()) p.stopVars.pop_back();
  }
  // A clipboard image travels inside the Message (Image.dataBlob): its bytes go to whoever draws images.
  if (imageData && p.image.present && gImageDataSink) gImageDataSink(p.image, imageData);
  return p;
}

Effect readEffect(const json::Value& e) {
  Effect f;
  for (auto& [k, x] : e.object) {
    if (k == "type" && (x.isString() || x.isNumber())) {
      if (x.isString()) enumFromName(x.string, f.type);
    } else if (k == "color") f.color = readColor(x, Color{0, 0, 0, 1});
    else if (k == "offset") f.offset = readVector(x);
    else if (k == "radius" && x.isNumber()) f.radius = x.number;
    else if (k == "visible" && x.isBool()) f.visible = x.boolean;
    else if (k == "blendMode" && x.isString() && enumFromName(x.string, f.blendMode)) {
    } else if (k == "spread" && x.isNumber()) f.spread = x.number;
    else if (k == "showShadowBehindNode" && x.isBool()) f.showShadowBehindNode = x.boolean;
    else if (k == "radiusVar" && x.isObject()) f.radiusVar = readVariableData(x);
    else if (k == "colorVar" && x.isObject()) f.colorVar = readVariableData(x);
    else if (k == "spreadVar" && x.isObject()) f.spreadVar = readVariableData(x);
    else if (k == "xVar" && x.isObject()) f.xVar = readVariableData(x);
    else if (k == "yVar" && x.isObject()) f.yVar = readVariableData(x);
    else appendExtra(f.extra, "Effect", k, x);
  }
  return f;
}

VectorStyle readVectorStyle(const json::Value& v, const BlobsIn* blobs) {
  VectorStyle st;
  for (auto& [k, x] : v.object) {
    if (k == "styleID") st.styleID = static_cast<uint32_t>(std::max(0.0, x.numberOr(0)));
    else if (k == "fillPaints" && x.isArray()) st.fillPaints = readPaints(x, blobs), st.mask |= VS_FILLS;
    else if (k == "strokeCap" && x.isString() && enumFromName(x.string, st.strokeCap)) st.mask |= VS_STROKE_CAP;
    else if (k == "strokeJoin" && x.isString() && enumFromName(x.string, st.strokeJoin)) st.mask |= VS_STROKE_JOIN;
    else if (k == "handleMirroring" && x.isString() && enumFromName(x.string, st.handleMirroring)) st.mask |= VS_MIRRORING;
    else if (k == "cornerRadius" && x.isNumber()) st.cornerRadius = x.number, st.mask |= VS_CORNER_RADIUS;
    else if (k != "guid" && k != "phase") appendExtra(st.extra, "NodeChange", k, x);
  }
  return st;
}

VectorData readVectorData(const json::Value& v, const BlobsIn* blobs) {
  VectorData d;
  d.present = true;
  if (auto* x = v.get("vectorNetworkBlob"); x && blobs) d.network = blobs->get(x);
  if (auto* x = v.get("normalizedSize")) d.normalizedSize = readVector(*x);
  if (auto* x = v.get("styleOverrideTable"); x && x->isArray())
    for (auto& e : x->array)
      if (e.isObject()) d.styleOverrideTable.push_back(readVectorStyle(e, blobs));
  return d;
}

template <typename E>
void readEnum(const json::Value& v, const char* key, E& out, FieldMask bit, FieldMask& m) {
  const json::Value* x = v.get(key);
  if (!x) return;
  if (x->isString() && enumFromName(x->string, out)) m |= bit;
  else if (x->isNumber() && x->number >= 0 && static_cast<size_t>(x->number) < EnumNames<E>::count) {
    out = static_cast<E>(static_cast<int>(x->number));
    m |= bit;
  }
}

void readNumber(const json::Value& v, const char* key, double& out, FieldMask bit, FieldMask& m) {
  if (auto* x = v.get(key); x && x->isNumber()) {
    out = x->number;
    m |= bit;
  }
}

void readBool(const json::Value& v, const char* key, bool& out, FieldMask bit, FieldMask& m) {
  if (auto* x = v.get(key); x && x->isBool()) {
    out = x->boolean;
    m |= bit;
  }
}

bool readNumberValue(const json::Value& v, Number& out) {
  if (!v.isObject()) return false;
  if (auto* x = v.get("value")) out.value = x->numberOr(0);
  if (auto* u = v.get("units")) {
    NumberUnits units = NumberUnits::RAW;
    if (u->isString() && enumFromName(u->string, units)) out.units = units;
    else if (u->isNumber() && u->number >= 0 && u->number <= 2) out.units = static_cast<NumberUnits>(static_cast<int>(u->number));
  }
  return true;
}

bool readFontName(const json::Value& v, FontName& out) {
  if (!v.isObject()) return false;
  if (auto* x = v.get("family"); x && x->isString()) out.family = x->string;
  if (auto* x = v.get("style"); x && x->isString()) out.style = x->string;
  if (auto* x = v.get("postscript"); x && x->isString()) out.postscript = x->string;
  return true;
}

template <typename E>
bool readEnumValue(const json::Value& x, E& out) {
  if (x.isString()) return enumFromName(x.string, out);
  if (x.isNumber() && x.number >= 0 && static_cast<size_t>(x.number) < EnumNames<E>::count) {
    out = static_cast<E>(static_cast<int>(x.number));
    return true;
  }
  return false;
}

// The members readChange understands; every other one is kept in NodeProps::extra.
bool knownKey(std::string_view k) {
  static constexpr std::string_view kKnown[] = {
      "guid", "phase", "type", "name", "visible", "locked", "opacity", "transform", "size", "fillPaints", "strokePaints",
      "strokeWeight", "strokeAlign", "cornerRadius", "rectangleCornerRadiiIndependent", "rectangleTopLeftCornerRadius",
      "rectangleTopRightCornerRadius", "rectangleBottomRightCornerRadius", "rectangleBottomLeftCornerRadius", "frameMaskDisabled",
      "resizeToFit", "backgroundColor", "backgroundEnabled", "internalOnly", "stackMode", "stackSpacing", "stackHorizontalPadding",
      "stackVerticalPadding", "stackPaddingRight", "stackPaddingBottom", "stackPrimarySizing", "stackCounterSizing",
      "stackPrimaryAlignItems", "stackCounterAlignItems", "stackCounterAlignContent", "stackWrap", "stackCounterSpacing",
      "stackReverseZIndex", "bordersTakeSpace", "stackChildPrimaryGrow", "stackChildAlignSelf", "stackPositioning", "minSize",
      "maxSize", "horizontalConstraint", "verticalConstraint", "proportionsConstrained", "parentIndex", "clearedFields",
      "textData", "fontName", "fontSize", "lineHeight", "letterSpacing", "paragraphSpacing", "paragraphIndent",
      "textAlignHorizontal", "textAlignVertical", "textAutoResize", "textTruncation", "maxLines", "textCase", "textDecoration",
      "autoRename", "blendMode", "mask", "maskType", "strokeCap", "strokeJoin", "miterLimit", "dashPattern",
      "borderTopWeight", "borderRightWeight", "borderBottomWeight", "borderLeftWeight", "borderStrokeWeightsIndependent",
      "cornerSmoothing", "effects", "count", "starInnerScale", "arcData", "vectorData", "handleMirroring", "booleanOperation", "layoutGrids",
      "overrideKey", "symbolData", "overriddenSymbolID", "componentPropDefs", "componentPropAssignments", "parameterConsumptionMap",
      "componentPropRefs", "isStateGroup", "variantPropSpecs", "stateGroupPropertyValueOrders", "propsAreBubbled", "isSlot",
      "isSlotContent", "detachedSymbolId", "isSoftDeleted", "ancestorPathBeforeDeletion", "variableModeBySetMap",
      "styleIdForFill", "styleIdForStrokeFill", "styleIdForText", "styleIdForEffect", "styleIdForGrid", "styleType",
      "sortPosition", "description", "key", "isPublishable", "variableSetModes", "variableSetID", "variableResolvedType",
      "variableDataValues", "variableScopes", "codeSyntax", "version", "publishedVersion", "sourceLibraryKey", "publishID",
      "libraryMoveInfo",
      // Not kept: derived (recomputed) or panel-only.
      "derivedTextData", "derivedSymbolData", "childIds", "fillGeometry", "strokeGeometry", "blobs", "guidPath"};
  for (std::string_view known : kKnown)
    if (k == known) return true;
  return false;
}

TextStyle readTextStyle(const json::Value& v) {
  TextStyle st;
  for (auto& [k, x] : v.object) {
    if (k == "styleID") st.styleID = static_cast<uint32_t>(std::max(0.0, x.numberOr(0)));
    else if (k == "fontName" && readFontName(x, st.fontName)) st.mask |= R_FONT_NAME;
    else if (k == "fontSize" && x.isNumber()) st.fontSize = x.number, st.mask |= R_FONT_SIZE;
    else if (k == "lineHeight" && readNumberValue(x, st.lineHeight)) st.mask |= R_LINE_HEIGHT;
    else if (k == "letterSpacing" && readNumberValue(x, st.letterSpacing)) st.mask |= R_LETTER_SPACING;
    else if (k == "textCase" && readEnumValue(x, st.textCase)) st.mask |= R_TEXT_CASE;
    else if (k == "textDecoration" && readEnumValue(x, st.textDecoration)) st.mask |= R_TEXT_DECORATION;
    else if (k == "fillPaints" && x.isArray()) st.fillPaints = readPaints(x, nullptr), st.mask |= R_FILLS;
    else if (k != "guid" && k != "phase") appendExtra(st.extra, "NodeChange", k, x);
  }
  return st;
}

TextData readTextData(const json::Value& v) {
  TextData t;
  if (!v.isObject()) return t;
  if (auto* x = v.get("characters"); x && x->isString()) t.characters = x->string;
  if (auto* x = v.get("characterStyleIDs"); x && x->isArray()) {
    t.characterStyleIDs.reserve(x->array.size());
    for (auto& e : x->array) t.characterStyleIDs.push_back(static_cast<uint32_t>(std::max(0.0, e.numberOr(0))));
    while (!t.characterStyleIDs.empty() && t.characterStyleIDs.back() == 0) t.characterStyleIDs.pop_back();
  }
  if (auto* x = v.get("styleOverrideTable"); x && x->isArray())
    for (auto& e : x->array)
      if (e.isObject()) t.styleOverrideTable.push_back(readTextStyle(e));
  if (auto* x = v.get("lines"); x && x->isArray())
    for (auto& e : x->array) {
      std::string line;
      if (e.isObject())
        for (auto& [k, y] : e.object) line += extraFromJson("TextLineData", k, y);
      t.lines.push_back(std::move(line));
    }
  return t;
}


// ---- Components ----

void readFields(const json::Value& v, NodeProps& p, FieldMask& m, bool update, const BlobsIn* blobs);

ComponentPropValue readPropValue(const json::Value& v) {
  ComponentPropValue out;
  if (!v.isObject()) return out;
  for (auto& [k, x] : v.object) {
    if (k == "boolValue" && x.isBool()) out.hasBool = true, out.boolValue = x.boolean;
    else if (k == "textValue" && x.isObject()) out.hasText = true, out.textValue = readTextData(x);
    else if (k == "guidValue") readGuid(x, out.guidValue);
    else appendExtra(out.extra, "ComponentPropValue", k, x);
  }
  return out;
}

VariableField variableFieldOf(const json::Value& x) {
  VariableField f = VariableField::MISSING;
  if (x.isString()) enumFromName(x.string, f);
  else if (x.isNumber() && x.number >= 0 && x.number < 64) f = static_cast<VariableField>(static_cast<int>(x.number));
  return f;
}

void readComponentFields(const json::Value& v, NodeProps& p, FieldMask& m, const BlobsIn* blobs) {
  if (auto* x = v.get("overrideKey"); x && readGuid(*x, p.overrideKey)) m |= F_OVERRIDE_KEY;
  if (auto* x = v.get("symbolData"); x && x->isObject()) {
    SymbolData d;
    if (auto* id = x->get("symbolID")) readGuid(*id, d.symbolID);
    if (auto* f = x->get("uniformScaleFactor"); f && f->isNumber()) d.uniformScaleFactor = f->number;
    if (auto* list = x->get("symbolOverrides"); list && list->isArray()) {
      for (auto& e : list->array) {
        if (!e.isObject()) continue;
        SymbolOverride o;
        if (auto* gp = e.get("guidPath"); gp && gp->isObject())
          if (auto* guids = gp->get("guids"); guids && guids->isArray())
            for (auto& g : guids->array) {
              Guid key;
              if (readGuid(g, key)) o.path.push_back(key);
            }
        // Figma writes the root's entry as [symbolID]: the empty path here (docs/schema.md §5.1).
        if (o.path.size() == 1 && o.path[0] == d.symbolID) o.path.clear();
        readFields(e, o.props, o.mask, false, blobs);
        o.mask &= ~static_cast<FieldMask>(F_PARENT_INDEX | F_TYPE);
        // Entries for the same path merge (later fields win).
        auto same = std::find_if(d.overrides.begin(), d.overrides.end(), [&](const SymbolOverride& q) { return q.path == o.path; });
        if (same != d.overrides.end()) {
          copyFields(same->props, o.props, o.mask & ~static_cast<FieldMask>(F_EXTRA));
          for (auto& [k, val] : o.props.extra) same->props.extra[k] = val;
          same->mask |= o.mask;
        } else {
          d.overrides.push_back(std::move(o));
        }
      }
    }
    p.symbolData = std::move(d);
    m |= F_SYMBOL_DATA;
  }
  if (auto* x = v.get("overriddenSymbolID"); x && readGuid(*x, p.overriddenSymbolID)) m |= F_OVERRIDDEN_SYMBOL_ID;
  if (auto* x = v.get("componentPropDefs"); x && x->isArray()) {
    for (auto& e : x->array) {
      if (!e.isObject()) continue;
      ComponentPropDef d;
      for (auto& [k, y] : e.object) {
        if (k == "id") readGuid(y, d.id);
        else if (k == "name" && y.isString()) d.name = y.string;
        else if (k == "initialValue") d.initialValue = readPropValue(y);
        else if (k == "sortPosition" && y.isString()) d.sortPosition = y.string;
        else if (k == "type" && (y.isString() || y.isNumber())) {
          if (y.isString()) enumFromName(y.string, d.type);
          else d.type = static_cast<ComponentPropType>(static_cast<int>(y.number));
        } else if (k == "description" && y.isString()) d.description = y.string;
        else if (k == "preferredValues" && y.isObject()) {
          for (auto& [pk, pv] : y.object) {
            if (pk == "instanceSwapValues" && pv.isArray()) {
              for (auto& iv : pv.array) {
                PreferredValue pref;
                if (auto* t = iv.get("type"); t && t->isString()) pref.stateGroup = t->string == "STATE_GROUP";
                if (auto* key = iv.get("key"); key && key->isString()) pref.key = key->string;
                d.preferredValues.push_back(pref);
              }
            } else {
              appendExtra(d.preferredExtra, "ComponentPropPreferredValues", pk, pv);
            }
          }
        } else {
          appendExtra(d.extra, "ComponentPropDef", k, y);
        }
      }
      p.componentPropDefs.push_back(std::move(d));
    }
    m |= F_COMPONENT_PROP_DEFS;
  }
  if (auto* x = v.get("componentPropAssignments"); x && x->isArray()) {
    for (auto& e : x->array) {
      if (!e.isObject()) continue;
      ComponentPropAssignment a;
      for (auto& [k, y] : e.object) {
        if (k == "defID") readGuid(y, a.defID);
        else if (k == "value") a.value = readPropValue(y);
        else appendExtra(a.extra, "ComponentPropAssignment", k, y);
      }
      p.componentPropAssignments.push_back(std::move(a));
    }
    m |= F_COMPONENT_PROP_ASSIGNMENTS;
  }
  if (auto* x = v.get("parameterConsumptionMap"); x && x->isObject()) {
    if (auto* entries = x->get("entries"); entries && entries->isArray())
      for (auto& e : entries->array) {
        if (!e.isObject()) continue;
        ParamBinding b;
        if (auto* f = e.get("variableField")) b.field = variableFieldOf(*f);
        const json::Value* data = e.get("variableData");
        const json::Value* type = data ? data->get("dataType") : nullptr;
        const json::Value* ref = nullptr;
        if (data && type && type->isString() && type->string == "PROP_REF")
          if (auto* val = data->get("value"))
            if (auto* pr = val->get("propRefValue")) ref = pr->get("defId");
        if (!(ref && readGuid(*ref, b.propRef)) && data) b.data = readVariableData(*data);
        p.parameterConsumptionMap.push_back(std::move(b));
      }
    m |= F_PARAM_MAP;
  }
  // Figma's older componentPropRefs [{defID, componentPropNodeField}] become PROP_REF bindings (docs/schema.md §5.5).
  if (auto* x = v.get("componentPropRefs"); x && x->isArray()) {
    for (auto& e : x->array) {
      ParamBinding b;
      const json::Value* def = e.get("defID");
      const json::Value* field = e.get("componentPropNodeField");
      if (!def || !readGuid(*def, b.propRef) || !field || !field->isString()) continue;
      if (field->string == "VISIBLE") b.field = VariableField::VISIBLE;
      else if (field->string == "TEXT_DATA") b.field = VariableField::TEXT_DATA;
      else if (field->string == "OVERRIDDEN_SYMBOL_ID") b.field = VariableField::OVERRIDDEN_SYMBOL_ID;
      else if (field->string == "SLOT_CONTENT_ID") b.field = VariableField::SLOT_CONTENT_ID;
      else continue;
      bool dup = false;
      for (auto& q : p.parameterConsumptionMap) dup |= q.field == b.field;
      if (!dup) p.parameterConsumptionMap.push_back(b);
      m |= F_PARAM_MAP;
    }
  }
  readBool(v, "isStateGroup", p.isStateGroup, F_IS_STATE_GROUP, m);
  if (auto* x = v.get("variantPropSpecs"); x && x->isArray()) {
    for (auto& e : x->array) {
      VariantPropSpec spec;
      if (auto* id = e.get("propDefId")) readGuid(*id, spec.propDefId);
      if (auto* val = e.get("value"); val && val->isString()) spec.value = val->string;
      p.variantPropSpecs.push_back(spec);
    }
    m |= F_VARIANT_PROP_SPECS;
  }
  if (auto* x = v.get("stateGroupPropertyValueOrders"); x && x->isArray()) {
    for (auto& e : x->array) {
      StateGroupOrder o;
      if (auto* prop = e.get("property"); prop && prop->isString()) o.property = prop->string;
      if (auto* vals = e.get("values"); vals && vals->isArray())
        for (auto& val : vals->array)
          if (val.isString()) o.values.push_back(val.string);
      p.stateGroupPropertyValueOrders.push_back(o);
    }
    m |= F_STATE_GROUP_ORDERS;
  }
  readBool(v, "propsAreBubbled", p.propsAreBubbled, F_PROPS_ARE_BUBBLED, m);
  readBool(v, "isSlot", p.isSlot, F_IS_SLOT, m);
  readBool(v, "isSlotContent", p.isSlotContent, F_IS_SLOT_CONTENT, m);
  if (auto* x = v.get("detachedSymbolId"); x && x->isObject())
    if (auto* g = x->get("guid"); g && readGuid(*g, p.detachedSymbolId)) m |= F_DETACHED_SYMBOL_ID;
  readBool(v, "isSoftDeleted", p.isSoftDeleted, F_IS_SOFT_DELETED, m);
  if (auto* x = v.get("ancestorPathBeforeDeletion"); x && x->isArray()) {
    for (auto& e : x->array) {
      Guid g;
      if (readGuid(e, g)) p.ancestorPathBeforeDeletion.push_back(g);
    }
    m |= F_ANCESTOR_PATH;
  }
}

void readVariableFields(const json::Value& v, NodeProps& p, FieldMask& m) {
  if (auto* x = v.get("variableModeBySetMap"); x && x->isObject()) {
    if (auto* entries = x->get("entries"); entries && entries->isArray())
      for (auto& e : entries->array) {
        VariableModeEntry me;
        if (auto* set = e.get("variableSetID")) me.set = readAssetId(*set);
        if (auto* mode = e.get("variableModeID")) readStructGuid(*mode, me.mode);
        if (me.set.present()) p.variableModeBySetMap.push_back(std::move(me));
      }
    m |= F_VARIABLE_MODES;
  }
  auto asset = [&](const char* key, AssetId& out, FieldMask bit) {
    if (auto* x = v.get(key); x && (x->isObject() || x->isString())) {
      out = readAssetId(*x);
      m |= bit;
    }
  };
  asset("styleIdForFill", p.styleIdForFill, F_STYLE_ID_FILL);
  asset("styleIdForStrokeFill", p.styleIdForStrokeFill, F_STYLE_ID_STROKE);
  asset("styleIdForText", p.styleIdForText, F_STYLE_ID_TEXT);
  asset("styleIdForEffect", p.styleIdForEffect, F_STYLE_ID_EFFECT);
  asset("styleIdForGrid", p.styleIdForGrid, F_STYLE_ID_GRID);
  if (auto* x = v.get("styleType"); x && readEnumMember(*x, p.styleType)) m |= F_STYLE_TYPE;
  if (auto* x = v.get("sortPosition"); x && x->isString()) p.sortPosition = x->string, m |= F_SORT_POSITION;
  if (auto* x = v.get("description"); x && x->isString()) p.description = x->string, m |= F_DESCRIPTION;
  if (auto* x = v.get("key"); x && x->isString()) p.key = x->string, m |= F_KEY;
  readBool(v, "isPublishable", p.isPublishable, F_IS_PUBLISHABLE, m);
  if (auto* x = v.get("variableSetModes"); x && x->isArray()) {
    for (auto& e : x->array) {
      VariableSetMode mode;
      if (auto* id = e.get("id")) readStructGuid(*id, mode.id);
      if (auto* name = e.get("name"); name && name->isString()) mode.name = name->string;
      if (auto* pos = e.get("sortPosition"); pos && pos->isString()) mode.sortPosition = pos->string;
      p.variableSetModes.push_back(std::move(mode));
    }
    m |= F_VARIABLE_SET_MODES;
  }
  asset("variableSetID", p.variableSetID, F_VARIABLE_SET_ID);
  if (auto* x = v.get("variableResolvedType"); x && readEnumMember(*x, p.variableResolvedType)) m |= F_VARIABLE_RESOLVED_TYPE;
  if (auto* x = v.get("variableDataValues"); x && x->isObject()) {
    if (auto* entries = x->get("entries"); entries && entries->isArray())
      for (auto& e : entries->array) {
        VariableModeValue mv;
        if (auto* mode = e.get("modeID")) readStructGuid(*mode, mv.modeID);
        if (auto* data = e.get("variableData")) mv.data = readVariableData(*data);
        p.variableDataValues.push_back(std::move(mv));
      }
    m |= F_VARIABLE_DATA_VALUES;
  }
  if (auto* x = v.get("variableScopes"); x && x->isArray()) {
    std::vector<VariableScope> scopes;
    for (auto& e : x->array) {
      VariableScope sc = VariableScope::ALL_SCOPES;
      if (e.isString() && e.string == "STROKE_COLOR") scopes.push_back(VariableScope::STROKE);  // the plugin API's name
      else if (readEnumMember(e, sc)) scopes.push_back(sc);
    }
    p.variableScopes = std::move(scopes);
    m |= F_VARIABLE_SCOPES;
  }
  if (auto* x = v.get("codeSyntax"); x && x->isObject()) {
    if (auto* entries = x->get("entries"); entries && entries->isArray())
      for (auto& e : entries->array) {
        CodeSyntaxEntry cs;
        if (auto* pl = e.get("platform"); !pl || !readEnumMember(*pl, cs.platform)) continue;
        if (auto* val = e.get("value"); val && val->isString()) cs.value = val->string;
        p.codeSyntax.push_back(std::move(cs));
      }
    m |= F_CODE_SYNTAX;
  }
  if (auto* x = v.get("version"); x && x->isString()) p.version = x->string, m |= F_VERSION;
  if (auto* x = v.get("publishedVersion"); x && x->isString()) p.publishedVersion = x->string, m |= F_PUBLISHED_VERSION;
  if (auto* x = v.get("sourceLibraryKey"); x && x->isString()) p.sourceLibraryKey = x->string, m |= F_SOURCE_LIBRARY_KEY;
  if (auto* x = v.get("publishID"); x && readStructGuid(*x, p.publishID)) m |= F_PUBLISH_ID;
  if (auto* x = v.get("libraryMoveInfo"); x && x->isObject()) {
    if (auto* k = x->get("oldKey"); k && k->isString()) p.libraryMoveInfo.oldKey = k->string;
    if (auto* k = x->get("pasteFileKey"); k && k->isString()) p.libraryMoveInfo.pasteFileKey = k->string;
    m |= F_LIBRARY_MOVE_INFO;
  }
}

}  // namespace

bool readGuid(const json::Value& v, Guid& out) {
  bool ok = false;
  if (v.isString()) {
    out = Guid::parse(v.string, &ok);
    return ok;
  }
  if (v.isObject()) {
    const json::Value* s = v.get("sessionID");
    const json::Value* l = v.get("localID");
    if (s && l && s->isNumber() && l->isNumber() && s->number >= 0 && l->number >= 0) {
      out = {static_cast<uint32_t>(s->number), static_cast<uint32_t>(l->number)};
      return true;
    }
  }
  return false;
}

FieldMask presentFields(const NodeProps& p) {
  // Absent = the absence value (NodeProps{}); type and parentIndex are always carried.
  FieldMask mask = differingFields(p, NodeProps{}, F_ALL) | F_TYPE;
  // A variable's type even when it is the absence value (BOOLEAN = 0): readers outside the engine need it.
  if (p.type == NodeType::VARIABLE) mask |= F_VARIABLE_RESOLVED_TYPE;
  if (p.parentIndex.guid != kNoGuid) mask |= F_PARENT_INDEX;
  else mask &= ~static_cast<FieldMask>(F_PARENT_INDEX);
  return mask;
}

void writeChange(json::Writer& w, const NodeChange& c, BlobsOut* blobs) {
  w.beginObject();
  w.key("guid").string(c.guid.toString());
  if (c.phase == Phase::CREATED) w.key("phase").string("CREATED");
  if (c.phase == Phase::REMOVED) w.key("phase").string("REMOVED");
  if (c.phase != Phase::REMOVED)
    writeFields(w, c.props, c.phase == Phase::CREATED ? presentFields(c.props) : c.mask, c.phase == Phase::CHANGED, blobs);
  w.endObject();
}

void writeChanges(json::Writer& w, const std::vector<NodeChange>& changes, BlobsOut* blobs) {
  w.beginArray();
  for (auto& c : changes) writeChange(w, c, blobs);
  w.endArray();
}

void writeNode(json::Writer& w, const Node& node, BlobsOut* blobs) {
  w.beginObject();
  w.key("guid").string(node.guid.toString());
  writeFields(w, node.props, F_ALL, false, blobs);
  w.endObject();
}

void writeNode(json::Writer& w, const Node& node, FieldMask mask, BlobsOut* blobs) {
  w.beginObject();
  w.key("guid").string(node.guid.toString());
  writeFields(w, node.props, mask | F_TYPE, false, blobs);
  w.endObject();
}

namespace {
void readFields(const json::Value& v, NodeProps& p, FieldMask& m, bool update, const BlobsIn* blobs) {
  if (auto* x = v.get("type"); x && x->isString()) { p.type = nodeTypeFromName(x->string); m |= F_TYPE; }
  if (auto* x = v.get("name"); x && x->isString()) { p.name = x->string; m |= F_NAME; }
  readBool(v, "visible", p.visible, F_VISIBLE, m);
  readBool(v, "locked", p.locked, F_LOCKED, m);
  readNumber(v, "opacity", p.opacity, F_OPACITY, m);
  if (auto* x = v.get("transform"); x && x->isObject()) {
    auto num = [&](const char* k, double d) { auto* e = x->get(k); return e ? e->numberOr(d) : d; };
    p.transform = {num("m00", 1), num("m01", 0), num("m02", 0), num("m10", 0), num("m11", 1), num("m12", 0)};
    m |= F_TRANSFORM;
  }
  if (auto* x = v.get("size"); x && x->isObject()) { p.size = readVector(*x); m |= F_SIZE; }
  if (auto* x = v.get("fillPaints")) { p.fillPaints = readPaints(*x, blobs); m |= F_FILLS; }
  if (auto* x = v.get("strokePaints")) { p.strokePaints = readPaints(*x, blobs); m |= F_STROKES; }
  readNumber(v, "strokeWeight", p.strokeWeight, F_STROKE_WEIGHT, m);
  readEnum(v, "strokeAlign", p.strokeAlign, F_STROKE_ALIGN, m);
  // The uniform cornerRadius sets all four; the per-corner fields override it unless
  // rectangleCornerRadiiIndependent is explicitly false.
  if (auto* x = v.get("cornerRadius"); x && x->isNumber()) {
    p.cornerRadii = {x->number, x->number, x->number, x->number};
    m |= F_CORNER_RADII;
  }
  const json::Value* independent = v.get("rectangleCornerRadiiIndependent");
  if (!(independent && independent->isBool() && !independent->boolean))
    for (int i = 0; i < 4; i++)
      if (auto* x = v.get(kCornerKeys[i]); x && x->isNumber()) {
        p.cornerRadii[static_cast<size_t>(i)] = x->number;
        m |= F_CORNER_RADII;
      }
  readBool(v, "frameMaskDisabled", p.frameMaskDisabled, F_FRAME_MASK_DISABLED, m);
  readBool(v, "resizeToFit", p.resizeToFit, F_RESIZE_TO_FIT, m);
  if (auto* x = v.get("backgroundColor"); x && x->isObject()) { p.backgroundColor = readColor(*x, Color{0, 0, 0, 0}); m |= F_BACKGROUND_COLOR; }
  readBool(v, "backgroundEnabled", p.backgroundEnabled, F_BACKGROUND_ENABLED, m);
  readBool(v, "internalOnly", p.internalOnly, F_INTERNAL_ONLY, m);
  // Auto layout.
  readEnum(v, "stackMode", p.stackMode, F_STACK_MODE, m);
  readNumber(v, "stackSpacing", p.stackSpacing, F_STACK_SPACING, m);
  readNumber(v, "stackHorizontalPadding", p.stackPaddingLeft, F_STACK_PADDING_LEFT, m);
  readNumber(v, "stackVerticalPadding", p.stackPaddingTop, F_STACK_PADDING_TOP, m);
  readNumber(v, "stackPaddingRight", p.stackPaddingRight, F_STACK_PADDING_RIGHT, m);
  readNumber(v, "stackPaddingBottom", p.stackPaddingBottom, F_STACK_PADDING_BOTTOM, m);
  readEnum(v, "stackPrimarySizing", p.stackPrimarySizing, F_STACK_PRIMARY_SIZING, m);
  readEnum(v, "stackCounterSizing", p.stackCounterSizing, F_STACK_COUNTER_SIZING, m);
  readEnum(v, "stackPrimaryAlignItems", p.stackPrimaryAlignItems, F_STACK_PRIMARY_ALIGN, m);
  readEnum(v, "stackCounterAlignItems", p.stackCounterAlignItems, F_STACK_COUNTER_ALIGN, m);
  readEnum(v, "stackCounterAlignContent", p.stackCounterAlignContent, F_STACK_COUNTER_ALIGN_CONTENT, m);
  readEnum(v, "stackWrap", p.stackWrap, F_STACK_WRAP, m);
  if (auto* x = v.get("stackCounterSpacing"); x && x->isNumber()) {
    p.stackCounterSpacing = x->number;
    m |= F_STACK_COUNTER_SPACING;
  }
  readBool(v, "stackReverseZIndex", p.stackReverseZIndex, F_STACK_REVERSE_Z, m);
  readBool(v, "bordersTakeSpace", p.bordersTakeSpace, F_BORDERS_TAKE_SPACE, m);
  readNumber(v, "stackChildPrimaryGrow", p.stackChildPrimaryGrow, F_STACK_CHILD_GROW, m);
  readEnum(v, "stackChildAlignSelf", p.stackChildAlignSelf, F_STACK_CHILD_ALIGN_SELF, m);
  readEnum(v, "stackPositioning", p.stackPositioning, F_STACK_POSITIONING, m);
  if (auto* x = v.get("minSize"); x && x->isObject()) {
    if (auto* value = x->get("value")) p.minSize = readVector(*value);
    m |= F_MIN_SIZE;
  }
  if (auto* x = v.get("maxSize"); x && x->isObject()) {
    if (auto* value = x->get("value")) p.maxSize = readVector(*value);
    m |= F_MAX_SIZE;
  }
  readEnum(v, "horizontalConstraint", p.horizontalConstraint, F_H_CONSTRAINT, m);
  readEnum(v, "verticalConstraint", p.verticalConstraint, F_V_CONSTRAINT, m);
  readBool(v, "proportionsConstrained", p.proportionsConstrained, F_PROPORTIONS_CONSTRAINED, m);
  // Text.
  if (auto* x = v.get("textData"); x && x->isObject()) { p.textData = readTextData(*x); m |= F_TEXT_DATA; }
  if (auto* x = v.get("fontName"); x && readFontName(*x, p.fontName)) m |= F_FONT_NAME;
  readNumber(v, "fontSize", p.fontSize, F_FONT_SIZE, m);
  if (auto* x = v.get("lineHeight"); x && readNumberValue(*x, p.lineHeight)) m |= F_LINE_HEIGHT;
  if (auto* x = v.get("letterSpacing"); x && readNumberValue(*x, p.letterSpacing)) m |= F_LETTER_SPACING;
  readNumber(v, "paragraphSpacing", p.paragraphSpacing, F_PARAGRAPH_SPACING, m);
  readNumber(v, "paragraphIndent", p.paragraphIndent, F_PARAGRAPH_INDENT, m);
  readEnum(v, "textAlignHorizontal", p.textAlignHorizontal, F_TEXT_ALIGN_H, m);
  readEnum(v, "textAlignVertical", p.textAlignVertical, F_TEXT_ALIGN_V, m);
  readEnum(v, "textAutoResize", p.textAutoResize, F_TEXT_AUTO_RESIZE, m);
  readEnum(v, "textTruncation", p.textTruncation, F_TEXT_TRUNCATION, m);
  if (auto* x = v.get("maxLines"); x && x->isNumber()) { p.maxLines = static_cast<int32_t>(x->number); m |= F_MAX_LINES; }
  readEnum(v, "textCase", p.textCase, F_TEXT_CASE, m);
  readEnum(v, "textDecoration", p.textDecoration, F_TEXT_DECORATION, m);
  readBool(v, "autoRename", p.autoRename, F_AUTO_RENAME, m);
  // Paint, stroke, effects, masks.
  readEnum(v, "blendMode", p.blendMode, F_BLEND_MODE, m);
  readBool(v, "mask", p.mask, F_MASK, m);
  readEnum(v, "maskType", p.maskType, F_MASK_TYPE, m);
  if (auto* x = v.get("strokeCap"); x && x->isString() && enumFromName(x->string, p.strokeCap)) m |= F_STROKE_CAP;
  readEnum(v, "strokeJoin", p.strokeJoin, F_STROKE_JOIN, m);
  readNumber(v, "miterLimit", p.miterLimit, F_MITER_LIMIT, m);
  if (auto* x = v.get("dashPattern"); x && x->isArray()) {
    for (auto& d : x->array) p.dashPattern.push_back(d.numberOr(0));
    m |= F_DASH_PATTERN;
  }
  {
    const char* keys[4] = {"borderTopWeight", "borderRightWeight", "borderBottomWeight", "borderLeftWeight"};
    for (size_t i = 0; i < 4; i++)
      if (auto* x = v.get(keys[i]); x && x->isNumber()) p.borderWeights[i] = x->number, m |= F_BORDER_WEIGHTS;
    readBool(v, "borderStrokeWeightsIndependent", p.borderStrokeWeightsIndependent, F_BORDER_WEIGHTS, m);
  }
  readNumber(v, "cornerSmoothing", p.cornerSmoothing, F_CORNER_SMOOTHING, m);
  if (auto* x = v.get("effects"); x && x->isArray()) {
    for (auto& e : x->array)
      if (e.isObject()) p.effects.push_back(readEffect(e));
    m |= F_EFFECTS;
  }
  if (auto* x = v.get("count"); x && x->isNumber()) p.count = static_cast<uint32_t>(std::max(0.0, x->number)), m |= F_COUNT;
  readNumber(v, "starInnerScale", p.starInnerScale, F_STAR_INNER_SCALE, m);
  if (auto* x = v.get("arcData"); x && x->isObject()) {
    if (auto* a = x->get("startingAngle")) p.arcData.startingAngle = a->numberOr(0);
    if (auto* a = x->get("endingAngle")) p.arcData.endingAngle = a->numberOr(0);
    if (auto* a = x->get("innerRadius")) p.arcData.innerRadius = a->numberOr(0);
    m |= F_ARC_DATA;
  }
  if (auto* x = v.get("vectorData"); x && x->isObject()) p.vectorData = readVectorData(*x, blobs), m |= F_VECTOR_DATA;
  readEnum(v, "handleMirroring", p.handleMirroring, F_HANDLE_MIRRORING, m);
  readEnum(v, "booleanOperation", p.booleanOperation, F_BOOLEAN_OPERATION, m);
  if (auto* x = v.get("layoutGrids"); x && x->isArray()) {
    for (auto& e : x->array) {
      if (!e.isObject()) continue;
      LayoutGrid g;
      for (auto& [k, y] : e.object) {
        if (k == "type" && y.isString() && enumFromName(y.string, g.type)) {
        } else if (k == "axis" && y.isString() && enumFromName(y.string, g.axis)) {
        } else if (k == "visible" && y.isBool()) g.visible = y.boolean;
        else if (k == "numSections" && y.isNumber()) g.numSections = static_cast<int32_t>(y.number);
        else if (k == "offset" && y.isNumber()) g.offset = y.number;
        else if (k == "sectionSize" && y.isNumber()) g.sectionSize = y.number;
        else if (k == "gutterSize" && y.isNumber()) g.gutterSize = y.number;
        else if (k == "color") g.color = readColor(y, Color{1, 0, 0, 0.1f});
        else if (k == "pattern" && y.isString() && enumFromName(y.string, g.pattern)) {
        } else if (k == "numSectionsVar" && y.isObject()) g.numSectionsVar = readVariableData(y);
        else if (k == "offsetVar" && y.isObject()) g.offsetVar = readVariableData(y);
        else if (k == "sectionSizeVar" && y.isObject()) g.sectionSizeVar = readVariableData(y);
        else if (k == "gutterSizeVar" && y.isObject()) g.gutterSizeVar = readVariableData(y);
        else appendExtra(g.extra, "LayoutGrid", k, y);
      }
      p.layoutGrids.push_back(g);
    }
    m |= F_LAYOUT_GRIDS;
  }
  if (auto* x = v.get("parentIndex"); x && x->isObject()) {
    if (auto* pg = x->get("guid")) {
      Guid parent;
      p.parentIndex.guid = readGuid(*pg, parent) ? parent : kNoGuid;
    }
    if (auto* pos = x->get("position"); pos && pos->isString()) p.parentIndex.position = pos->string;
    m |= F_PARENT_INDEX;
  }
  readComponentFields(v, p, m, blobs);
  readVariableFields(v, p, m);
  // Everything else the schema knows round-trips as it came (as its kiwi bytes).
  for (auto& [k, x] : v.object)
    if (!knownKey(k)) {
      // An update setting a field the engine doesn't model to null clears it (an empty value removes the key).
      if (x.isNull()) {
        if (!update || !fieldIdOf("NodeChange", k)) continue;
        p.extra[k] = std::string();
        m |= F_EXTRA;
        continue;
      }
      std::string bytes = extraFromJson("NodeChange", k, x);
      if (bytes.empty()) continue;
      p.extra[k] = std::move(bytes);
      m |= F_EXTRA;
    }
  // An update setting a modelled field to null clears it (like clearedFields).
  if (update)
    for (auto& [k, x] : v.object)
      if (x.isNull())
        if (FieldMask f = fieldOfKey(k) & ~static_cast<FieldMask>(F_TYPE | F_PARENT_INDEX)) {
          copyFields(p, NodeProps{}, f);
          m |= f;
        }
  // clearedFields: kiwi field ids reset to absent (their default) — an update only.
  if (auto* x = v.get("clearedFields"); x && x->isArray() && update) {
    NodeProps defaults;
    for (auto& id : x->array) {
      FieldMask f = fieldsOfKiwiId(static_cast<uint32_t>(id.numberOr(0))) & ~static_cast<FieldMask>(F_TYPE | F_PARENT_INDEX);
      if (!f || (m & f)) continue;  // a field set and cleared at once keeps the set value
      copyFields(p, defaults, f);
      m |= f;
    }
  }
}
}  // namespace

bool readChange(const json::Value& v, NodeChange& out, const BlobsIn* blobs) {
  if (!v.isObject()) return false;
  const json::Value* g = v.get("guid");
  out = NodeChange{};
  if (!g || !readGuid(*g, out.guid)) return false;
  if (auto* ph = v.get("phase"); ph && ph->isString()) {
    if (ph->string == "CREATED") out.phase = Phase::CREATED;
    else if (ph->string == "REMOVED") out.phase = Phase::REMOVED;
  }
  FieldMask m = 0;
  readFields(v, out.props, m, out.phase == Phase::CHANGED, blobs);
  out.mask = out.phase == Phase::CREATED ? F_ALL : (out.phase == Phase::REMOVED ? 0 : m);
  return true;
}

std::vector<NodeChange> readChanges(const json::Value& v, const BlobsIn* blobs) {
  std::vector<NodeChange> out;
  if (!v.isArray()) return out;
  for (auto& e : v.array) {
    NodeChange c;
    if (readChange(e, c, blobs)) out.push_back(std::move(c));
  }
  return out;
}

std::vector<NodeChange> readMessage(const json::Value& message) {
  if (message.isArray()) return readChanges(message);
  const json::Value* changes = message.get("nodeChanges");
  if (!changes) return {};
  BlobsIn blobs = readBlobs(message);
  return readChanges(*changes, &blobs);
}

Bytes BlobsIn::get(const json::Value* index) const {
  if (!index || !index->isNumber() || index->number < 0) return nullptr;
  size_t i = static_cast<size_t>(index->number);
  return i < blobs.size() ? blobs[i] : nullptr;
}

BlobsIn readBlobs(const json::Value& message) {
  BlobsIn in;
  const json::Value* list = message.isObject() ? message.get("blobs") : nullptr;
  if (!list || !list->isArray()) return in;
  for (auto& b : list->array) {
    auto bytes = std::make_shared<std::vector<uint8_t>>();
    if (b.isString()) base64::decode(b.string, *bytes);
    else if (b.isObject())  // {"bytes": "base64"} (a kiwi Message's Blob, as JSON)
      if (auto* x = b.get("bytes"); x && x->isString()) base64::decode(x->string, *bytes);
    in.blobs.push_back(std::move(bytes));
  }
  return in;
}

uint32_t BlobsOut::add(const Bytes& bytes) {
  // FNV-1a over the bytes: each distinct blob once.
  uint64_t h = 1469598103934665603ull;
  if (bytes)
    for (uint8_t b : *bytes) h = (h ^ b) * 1099511628211ull;
  auto [from, to] = index_.equal_range(h);
  for (auto it = from; it != to; ++it) {
    const Bytes& have = list_[it->second];
    if (have == bytes || (bytes && have && *have == *bytes) || (!bytes && have && have->empty()) || (bytes && !have && bytes->empty()))
      return it->second;
  }
  list_.push_back(bytes);
  uint32_t i = static_cast<uint32_t>(list_.size() - 1);
  index_.emplace(h, i);
  return i;
}

void BlobsOut::writeMember(json::Writer& w) const {
  if (list_.empty()) return;
  w.key("blobs").beginArray();
  for (auto& b : list_) w.string(b ? base64::encode(*b) : std::string());
  w.endArray();
}

void writeMessage(json::Writer& w, uint32_t sessionID, const std::vector<NodeChange>& changes) {
  BlobsOut blobs;
  w.beginObject();
  w.key("type").string("NODE_CHANGES");
  w.key("sessionID").number(sessionID);
  w.key("nodeChanges");
  writeChanges(w, changes, &blobs);
  blobs.writeMember(w);
  w.endObject();
}

void writePaints(json::Writer& w, const std::vector<Paint>& paints) {
  w.beginArray();
  for (auto& p : paints) writePaint(w, p);
  w.endArray();
}

std::vector<Paint> readPaints(const json::Value& v, const BlobsIn* blobs) {
  std::vector<Paint> out;
  if (!v.isArray()) return out;
  for (auto& e : v.array)
    if (e.isObject()) out.push_back(readPaint(e, blobs));
  return out;
}

void setImageDataSink(ImageDataSink sink) { gImageDataSink = sink; }
ImageDataSink imageDataSink() { return gImageDataSink; }

void writeEffects(json::Writer& w, const std::vector<Effect>& effects) {
  NodeProps p;
  p.effects = effects;
  json::Writer o;
  o.beginObject();
  writeFields(o, p, F_EFFECTS, false, nullptr);
  o.endObject();
  json::Value v;
  json::parse(o.str(), v);
  w.raw(v.get("effects") ? json::encode(*v.get("effects")) : std::string("[]"));
}

void writeLayoutGrids(json::Writer& w, const std::vector<LayoutGrid>& grids) {
  NodeProps p;
  p.layoutGrids = grids;
  json::Writer o;
  o.beginObject();
  writeFields(o, p, F_LAYOUT_GRIDS, false, nullptr);
  o.endObject();
  json::Value v;
  json::parse(o.str(), v);
  w.raw(v.get("layoutGrids") ? json::encode(*v.get("layoutGrids")) : std::string("[]"));
}

void writeVariable(json::Writer& w, const VariableData& d) { writeVariableData(w, d); }
VariableData readVariable(const json::Value& v) { return readVariableData(v); }

namespace {
struct FieldKey {
  FieldMask bit;
  const char* key;
};
const FieldKey kFieldKeys[] = {
    {F_TYPE, "type"}, {F_NAME, "name"}, {F_VISIBLE, "visible"}, {F_LOCKED, "locked"}, {F_OPACITY, "opacity"},
    {F_TRANSFORM, "transform"}, {F_SIZE, "size"}, {F_FILLS, "fillPaints"}, {F_STROKES, "strokePaints"},
    {F_STROKE_WEIGHT, "strokeWeight"}, {F_STROKE_ALIGN, "strokeAlign"}, {F_CORNER_RADII, "cornerRadius"},
    {F_FRAME_MASK_DISABLED, "frameMaskDisabled"}, {F_PARENT_INDEX, "parentIndex"}, {F_RESIZE_TO_FIT, "resizeToFit"},
    {F_BACKGROUND_COLOR, "backgroundColor"}, {F_BACKGROUND_ENABLED, "backgroundEnabled"}, {F_INTERNAL_ONLY, "internalOnly"},
    {F_STACK_MODE, "stackMode"}, {F_STACK_SPACING, "stackSpacing"}, {F_STACK_PADDING_LEFT, "stackHorizontalPadding"},
    {F_STACK_PADDING_TOP, "stackVerticalPadding"}, {F_STACK_PADDING_RIGHT, "stackPaddingRight"},
    {F_STACK_PADDING_BOTTOM, "stackPaddingBottom"}, {F_STACK_PRIMARY_SIZING, "stackPrimarySizing"},
    {F_STACK_COUNTER_SIZING, "stackCounterSizing"}, {F_STACK_PRIMARY_ALIGN, "stackPrimaryAlignItems"},
    {F_STACK_COUNTER_ALIGN, "stackCounterAlignItems"}, {F_STACK_COUNTER_ALIGN_CONTENT, "stackCounterAlignContent"},
    {F_STACK_WRAP, "stackWrap"}, {F_STACK_COUNTER_SPACING, "stackCounterSpacing"}, {F_STACK_REVERSE_Z, "stackReverseZIndex"},
    {F_BORDERS_TAKE_SPACE, "bordersTakeSpace"}, {F_STACK_CHILD_GROW, "stackChildPrimaryGrow"},
    {F_STACK_CHILD_ALIGN_SELF, "stackChildAlignSelf"}, {F_STACK_POSITIONING, "stackPositioning"}, {F_MIN_SIZE, "minSize"},
    {F_MAX_SIZE, "maxSize"}, {F_H_CONSTRAINT, "horizontalConstraint"}, {F_V_CONSTRAINT, "verticalConstraint"},
    {F_PROPORTIONS_CONSTRAINED, "proportionsConstrained"}, {F_TEXT_DATA, "textData"}, {F_FONT_NAME, "fontName"},
    {F_FONT_SIZE, "fontSize"}, {F_LINE_HEIGHT, "lineHeight"}, {F_LETTER_SPACING, "letterSpacing"},
    {F_PARAGRAPH_SPACING, "paragraphSpacing"}, {F_PARAGRAPH_INDENT, "paragraphIndent"}, {F_TEXT_ALIGN_H, "textAlignHorizontal"},
    {F_TEXT_ALIGN_V, "textAlignVertical"}, {F_TEXT_AUTO_RESIZE, "textAutoResize"}, {F_TEXT_TRUNCATION, "textTruncation"},
    {F_MAX_LINES, "maxLines"}, {F_TEXT_CASE, "textCase"}, {F_TEXT_DECORATION, "textDecoration"}, {F_AUTO_RENAME, "autoRename"},
    {F_BLEND_MODE, "blendMode"}, {F_MASK, "mask"}, {F_MASK_TYPE, "maskType"}, {F_STROKE_CAP, "strokeCap"},
    {F_STROKE_JOIN, "strokeJoin"}, {F_MITER_LIMIT, "miterLimit"}, {F_DASH_PATTERN, "dashPattern"},
    {F_BORDER_WEIGHTS, "borderTopWeight"}, {F_CORNER_SMOOTHING, "cornerSmoothing"}, {F_EFFECTS, "effects"}, {F_COUNT, "count"},
    {F_STAR_INNER_SCALE, "starInnerScale"}, {F_ARC_DATA, "arcData"}, {F_VECTOR_DATA, "vectorData"},
    {F_HANDLE_MIRRORING, "handleMirroring"}, {F_BOOLEAN_OPERATION, "booleanOperation"}, {F_LAYOUT_GRIDS, "layoutGrids"},
    {F_OVERRIDE_KEY, "overrideKey"}, {F_SYMBOL_DATA, "symbolData"}, {F_OVERRIDDEN_SYMBOL_ID, "overriddenSymbolID"},
    {F_COMPONENT_PROP_DEFS, "componentPropDefs"}, {F_COMPONENT_PROP_ASSIGNMENTS, "componentPropAssignments"},
    {F_PARAM_MAP, "parameterConsumptionMap"}, {F_IS_STATE_GROUP, "isStateGroup"}, {F_VARIANT_PROP_SPECS, "variantPropSpecs"},
    {F_STATE_GROUP_ORDERS, "stateGroupPropertyValueOrders"}, {F_PROPS_ARE_BUBBLED, "propsAreBubbled"}, {F_IS_SLOT, "isSlot"},
    {F_IS_SLOT_CONTENT, "isSlotContent"}, {F_DETACHED_SYMBOL_ID, "detachedSymbolId"}, {F_IS_SOFT_DELETED, "isSoftDeleted"},
    {F_ANCESTOR_PATH, "ancestorPathBeforeDeletion"}, {F_VARIABLE_MODES, "variableModeBySetMap"},
    {F_STYLE_ID_FILL, "styleIdForFill"}, {F_STYLE_ID_STROKE, "styleIdForStrokeFill"}, {F_STYLE_ID_TEXT, "styleIdForText"},
    {F_STYLE_ID_EFFECT, "styleIdForEffect"}, {F_STYLE_ID_GRID, "styleIdForGrid"}, {F_STYLE_TYPE, "styleType"},
    {F_SORT_POSITION, "sortPosition"}, {F_DESCRIPTION, "description"}, {F_KEY, "key"}, {F_IS_PUBLISHABLE, "isPublishable"},
    {F_VARIABLE_SET_MODES, "variableSetModes"}, {F_VARIABLE_SET_ID, "variableSetID"},
    {F_VARIABLE_RESOLVED_TYPE, "variableResolvedType"}, {F_VARIABLE_DATA_VALUES, "variableDataValues"},
    {F_VARIABLE_SCOPES, "variableScopes"}, {F_CODE_SYNTAX, "codeSyntax"}, {F_VERSION, "version"},
    {F_PUBLISHED_VERSION, "publishedVersion"}, {F_SOURCE_LIBRARY_KEY, "sourceLibraryKey"}, {F_PUBLISH_ID, "publishID"},
    {F_LIBRARY_MOVE_INFO, "libraryMoveInfo"},
};
}  // namespace

const char* fieldKey(FieldMask bit) {
  for (const FieldKey& k : kFieldKeys)
    if (k.bit == bit) return k.key;
  return "";
}

FieldMask fieldOfKey(std::string_view key) {
  for (const FieldKey& k : kFieldKeys)
    if (key == k.key) return k.bit;
  for (int i = 0; i < 4; i++)
    if (key == kCornerKeys[i] || key == "rectangleCornerRadiiIndependent") return F_CORNER_RADII;
  if (key == "borderRightWeight" || key == "borderBottomWeight" || key == "borderLeftWeight" || key == "borderStrokeWeightsIndependent")
    return F_BORDER_WEIGHTS;
  return 0;
}

std::vector<std::string> fieldKeys(FieldMask mask) {
  std::vector<std::string> out;
  for (const FieldKey& k : kFieldKeys)
    if (mask & k.bit) out.push_back(k.key);
  return out;
}

}  // namespace eng::codec
