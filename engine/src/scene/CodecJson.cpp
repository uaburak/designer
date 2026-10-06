#include "scene/CodecJson.h"

#include <algorithm>

#include "base/Base64.h"

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
std::string withExtra(json::Writer& w, const std::string& extra) {
  std::string s = w.take();
  if (!extra.empty()) {
    s.pop_back();
    if (s.size() > 1) s += ",";
    s += extra + "}";
  }
  return s;
}

void writePaint(json::Writer& out, const Paint& p) {
  if (p.type == PaintType::OTHER) {
    out.raw(p.extra);
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
  w.endObject();
  out.raw(withExtra(w, p.extra));
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
  w.endObject();
  out.raw(withExtra(w, e.extra));
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
  std::string s = w.take();
  if (!st.extra.empty()) {
    s.pop_back();
    s += "," + st.extra + "}";
  }
  out.raw(s);
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
    for (auto& l : t.lines) w.raw(l);
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
  out.raw(withExtra(w, st.extra));
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
      one.endObject();
      w.raw(withExtra(one, g.extra));
    }
    w.endArray();
  }
  if (mask & F_EXTRA)
    for (auto& [k, v] : p.extra)
      if (!v.empty()) w.key(k).raw(v);
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

// A member written back as encoded JSON ("key":value) for an `extra` string.
void appendMember(std::string& extra, const std::string& key, const json::Value& x) {
  json::Writer one;
  one.beginObject().key(key);
  json::write(one, x);
  one.endObject();
  std::string member = one.take();
  if (!extra.empty()) extra += ",";
  extra += member.substr(1, member.size() - 2);
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
    // A paint type the schema doesn't know: kept as it came.
    p.type = PaintType::OTHER;
    p.extra = json::encode(e);
    if (auto* vis = e.get("visible"); vis && vis->isBool()) p.visible = vis->boolean;
    return p;
  }
  Bytes imageData;
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
    } else {
      appendMember(p.extra, k, x);
    }
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
    else appendMember(f.extra, k, x);
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
    else if (k != "guid" && k != "phase") appendMember(st.extra, k, x);
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
      // Not kept: derived (recomputed) or panel-only.
      "derivedTextData", "childIds", "fillGeometry", "strokeGeometry", "blobs"};
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
    else if (k != "guid" && k != "phase") {
      json::Writer one;
      one.beginObject().key(k);
      json::write(one, x);
      one.endObject();
      std::string member = one.take();
      if (!st.extra.empty()) st.extra += ",";
      st.extra += member.substr(1, member.size() - 2);
    }
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
    for (auto& e : x->array) t.lines.push_back(json::encode(e));
  return t;
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

bool readChange(const json::Value& v, NodeChange& out, const BlobsIn* blobs) {
  if (!v.isObject()) return false;
  const json::Value* g = v.get("guid");
  out = NodeChange{};
  if (!g || !readGuid(*g, out.guid)) return false;
  if (auto* ph = v.get("phase"); ph && ph->isString()) {
    if (ph->string == "CREATED") out.phase = Phase::CREATED;
    else if (ph->string == "REMOVED") out.phase = Phase::REMOVED;
  }
  NodeProps& p = out.props;
  FieldMask m = 0;
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
        } else appendMember(g.extra, k, y);
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
  // Everything else round-trips as it came.
  for (auto& [k, x] : v.object)
    if (!knownKey(k)) {
      p.extra[k] = json::encode(x);
      m |= F_EXTRA;
    }
  // clearedFields: kiwi field ids reset to absent (their default) — an update only.
  if (auto* x = v.get("clearedFields"); x && x->isArray() && out.phase == Phase::CHANGED) {
    NodeProps defaults;
    for (auto& id : x->array) {
      FieldMask f = fieldsOfKiwiId(static_cast<uint32_t>(id.numberOr(0))) & ~static_cast<FieldMask>(F_TYPE | F_PARENT_INDEX);
      if (!f || (m & f)) continue;  // a field set and cleared at once keeps the set value
      copyFields(p, defaults, f);
      m |= f;
    }
  }
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
  for (size_t i = 0; i < list_.size(); i++)
    if (list_[i] == bytes || (bytes && list_[i] && *list_[i] == *bytes)) return static_cast<uint32_t>(i);
  list_.push_back(bytes);
  return static_cast<uint32_t>(list_.size() - 1);
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

}  // namespace eng::codec
