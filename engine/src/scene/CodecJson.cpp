#include "scene/CodecJson.h"

#include <algorithm>

namespace eng::codec {

namespace {

const char* kCornerKeys[4] = {"rectangleTopLeftCornerRadius", "rectangleTopRightCornerRadius",
                              "rectangleBottomRightCornerRadius", "rectangleBottomLeftCornerRadius"};

void writeColor(json::Writer& w, const Color& c) {
  w.beginObject().key("r").number(c.r).key("g").number(c.g).key("b").number(c.b).key("a").number(c.a).endObject();
}

void writeVector(json::Writer& w, Vec2 v) { w.beginObject().key("x").number(v.x).key("y").number(v.y).endObject(); }

void writePaints(json::Writer& w, const std::vector<Paint>& paints) {
  w.beginArray();
  for (auto& p : paints) {
    if (p.type == PaintType::OTHER) {
      w.raw(p.raw);
      continue;
    }
    w.beginObject();
    w.key("type").string("SOLID");
    w.key("color");
    writeColor(w, p.color);
    w.key("opacity").number(p.opacity);
    w.key("visible").boolean(p.visible);
    w.endObject();
  }
  w.endArray();
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

// Writes the fields in `mask`; for an update, an optional field that is unset
// in `p` goes to clearedFields instead.
void writeFields(json::Writer& w, const NodeProps& p, FieldMask mask, bool update) {
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

std::vector<Paint> readPaints(const json::Value& v) {
  std::vector<Paint> out;
  if (!v.isArray()) return out;
  for (auto& e : v.array) {
    if (!e.isObject()) continue;
    const json::Value* type = e.get("type");
    Paint p;
    if (type && type->isString() && type->string != "SOLID") {
      // Not drawn yet (E5): kept as it came.
      p.type = PaintType::OTHER;
      p.raw = json::encode(e);
      if (auto* vis = e.get("visible"); vis && vis->isBool()) p.visible = vis->boolean;
      out.push_back(p);
      continue;
    }
    if (auto* c = e.get("color")) p.color = readColor(*c, Color{0, 0, 0, 1});
    if (auto* o = e.get("opacity")) p.opacity = static_cast<float>(o->numberOr(1));
    if (auto* vis = e.get("visible"); vis && vis->isBool()) p.visible = vis->boolean;
    out.push_back(p);
  }
  return out;
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
      "autoRename",
      // Not kept: derived (recomputed) or panel-only.
      "derivedTextData", "childIds"};
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
    else if (k == "fillPaints" && x.isArray()) st.fillPaints = readPaints(x), st.mask |= R_FILLS;
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

void writeChange(json::Writer& w, const NodeChange& c) {
  w.beginObject();
  w.key("guid").string(c.guid.toString());
  if (c.phase == Phase::CREATED) w.key("phase").string("CREATED");
  if (c.phase == Phase::REMOVED) w.key("phase").string("REMOVED");
  if (c.phase != Phase::REMOVED)
    writeFields(w, c.props, c.phase == Phase::CREATED ? presentFields(c.props) : c.mask, c.phase == Phase::CHANGED);
  w.endObject();
}

void writeChanges(json::Writer& w, const std::vector<NodeChange>& changes) {
  w.beginArray();
  for (auto& c : changes) writeChange(w, c);
  w.endArray();
}

void writeNode(json::Writer& w, const Node& node) {
  w.beginObject();
  w.key("guid").string(node.guid.toString());
  writeFields(w, node.props, F_ALL, false);
  w.endObject();
}

bool readChange(const json::Value& v, NodeChange& out) {
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
  if (auto* x = v.get("fillPaints")) { p.fillPaints = readPaints(*x); m |= F_FILLS; }
  if (auto* x = v.get("strokePaints")) { p.strokePaints = readPaints(*x); m |= F_STROKES; }
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

std::vector<NodeChange> readChanges(const json::Value& v) {
  std::vector<NodeChange> out;
  if (!v.isArray()) return out;
  for (auto& e : v.array) {
    NodeChange c;
    if (readChange(e, c)) out.push_back(std::move(c));
  }
  return out;
}

}  // namespace eng::codec
