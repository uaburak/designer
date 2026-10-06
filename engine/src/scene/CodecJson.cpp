#include "scene/CodecJson.h"

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
    if (type && type->isString() && type->string != "SOLID") continue;  // only solid paints so far
    Paint p;
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
  if (auto* x = v.get("parentIndex"); x && x->isObject()) {
    if (auto* pg = x->get("guid")) {
      Guid parent;
      p.parentIndex.guid = readGuid(*pg, parent) ? parent : kNoGuid;
    }
    if (auto* pos = x->get("position"); pos && pos->isString()) p.parentIndex.position = pos->string;
    m |= F_PARENT_INDEX;
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
