#include "geometry/Repeat.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <functional>
#include <string>
#include <unordered_map>

#include "base/Json.h"
#include "scene/CodecKiwi.h"
#include "scene/Document.h"

namespace eng {

namespace geom {

namespace {

constexpr double kPi = 3.14159265358979323846;

Rect boxOf(const Mat2x3& m, const Rect& r) { return transformedBounds(m * Mat2x3::translate(r.x, r.y), r.w, r.h); }

}  // namespace

RepeatResult evaluateRepeat(const std::vector<TransformModifier>& modifiers, const Rect& content, size_t cap) {
  RepeatResult out;
  out.instances.push_back(Mat2x3{});
  out.bounds = content;
  cap = std::max<size_t>(cap, 1);
  for (const TransformModifier& m : modifiers) {
    if (!m.visible || m.type != TransformModifier::Type::REPEAT) continue;  // SYMMETRY / SKEW: kept, not evaluated
    uint32_t count = std::clamp<uint32_t>(m.count, 1, kMaxRepeatCount);
    if (count == 1) continue;
    const Rect B = out.bounds;
    // Copy k's matrix (group space).
    std::function<Mat2x3(uint32_t)> place;
    if (m.repeatType == TransformModifier::Repeat::RADIAL) {
      double r = m.unitType == TransformModifier::Unit::RELATIVE ? m.offset.x * B.h : m.offset.x;
      Vec2 pivot{B.x + B.w / 2, B.y + B.h + r};
      place = [=](uint32_t k) {
        double a = 2 * kPi * k / count;  // clockwise on screen (y down)
        return Mat2x3::translate(pivot.x, pivot.y) * Mat2x3::rotate(a) * Mat2x3::translate(-pivot.x, -pivot.y);
      };
    } else {
      bool rel = m.unitType == TransformModifier::Unit::RELATIVE;
      Vec2 step;
      switch (m.axis) {
        case TransformModifier::Axis::X: step = {B.w + (rel ? m.offset.x * B.w : m.offset.x), 0}; break;
        case TransformModifier::Axis::Y: step = {0, B.h + (rel ? m.offset.x * B.h : m.offset.x)}; break;
        case TransformModifier::Axis::X_AND_Y:
          step = {B.w + (rel ? m.offset.x * B.w : m.offset.x), B.h + (rel ? m.offset.y * B.h : m.offset.y)};
          break;
      }
      place = [=](uint32_t k) { return Mat2x3::translate(step.x * k, step.y * k); };
    }
    std::vector<Mat2x3> next;
    size_t want = out.instances.size() * count;
    next.reserve(std::min(want, cap));
    Rect u = B;
    for (uint32_t k = 0; k < count && next.size() < cap; k++) {
      Mat2x3 Mk = place(k);
      for (const Mat2x3& inst : out.instances) {
        if (next.size() >= cap) break;
        next.push_back(Mk * inst);
      }
      if (k > 0) u = u.united(boxOf(Mk, B));
    }
    if (want > cap) out.capped = true;
    if (m.order == TransformModifier::Order::REVERSE) {
      // The last copy lowest, the source on top: the blocks of copies in the other order (each block's own order kept).
      size_t block = out.instances.size();
      std::vector<Mat2x3> rev;
      rev.reserve(next.size());
      for (size_t end = next.size(); end > 0;) {
        size_t start = end > block ? ((end - 1) / block) * block : 0;
        rev.insert(rev.end(), next.begin() + static_cast<long>(start), next.begin() + static_cast<long>(end));
        end = start;
      }
      next.swap(rev);
    }
    out.instances.swap(next);
    out.bounds = u;
  }
  return out;
}

}  // namespace geom

namespace {

int enumOf(const json::Value* v, std::initializer_list<const char*> names, int fallback) {
  if (!v) return fallback;
  if (v->isNumber()) return static_cast<int>(v->number);
  if (v->isString()) {
    int i = 0;
    for (const char* n : names) {
      if (v->string == n) return i;
      i++;
    }
  }
  return fallback;
}

std::vector<geom::TransformModifier> parseModifiers(const std::string& bytes) {
  std::vector<geom::TransformModifier> out;
  json::Value v;
  if (bytes.empty() || !json::parse(codec::extraValueToJson("NodeChange", bytes), v) || !v.isArray()) return out;
  for (const json::Value& e : v.array) {
    if (!e.isObject()) continue;
    geom::TransformModifier m;
    using M = geom::TransformModifier;
    m.type = static_cast<M::Type>(enumOf(e.get("type"), {"REPEAT", "SYMMETRY", "SKEW"}, 0));
    m.repeatType = static_cast<M::Repeat>(enumOf(e.get("repeatType"), {"LINEAR", "RADIAL"}, 0));
    m.axis = static_cast<M::Axis>(enumOf(e.get("axis"), {"X", "Y", "X_AND_Y"}, 0));
    m.unitType = static_cast<M::Unit>(enumOf(e.get("unitType"), {"PIXELS", "RELATIVE"}, 0));
    m.order = static_cast<M::Order>(enumOf(e.get("order"), {"FORWARD", "REVERSE"}, 0));
    if (const json::Value* o = e.get("offset"); o && o->isObject()) {
      if (const json::Value* x = o->get("x")) m.offset.x = x->numberOr(0);
      if (const json::Value* y = o->get("y")) m.offset.y = y->numberOr(0);
    }
    // Absent booleans read as false in kiwi; a modifier Figma writes always carries `visible`.
    if (const json::Value* vis = e.get("visible")) m.visible = vis->isBool() ? vis->boolean : vis->numberOr(1) != 0;
    if (const json::Value* c = e.get("count")) m.count = static_cast<uint32_t>(std::max(0.0, c->numberOr(1)));
    if (const json::Value* x = e.get("skewX")) m.skewX = x->numberOr(0);
    if (const json::Value* y = e.get("skewY")) m.skewY = y->numberOr(0);
    out.push_back(m);
  }
  return out;
}

uint64_t mix(uint64_t h, double v) {
  uint64_t b = 0;
  static_assert(sizeof b == sizeof v);
  std::memcpy(&b, &v, sizeof b);
  return (h ^ b) * 1099511628211ull;
}

}  // namespace

const std::vector<geom::TransformModifier>& transformModifiersOf(const NodeProps& p) {
  static const std::vector<geom::TransformModifier> kNone;
  if (p.extra.empty()) return kNone;
  auto it = p.extra.find("transformModifiers");
  if (it == p.extra.end() || it->second.empty()) return kNone;
  // Decoded once per distinct bytes (the bytes are the key: equal bytes, equal modifiers).
  static std::unordered_map<std::string, std::vector<geom::TransformModifier>> cache;
  auto c = cache.find(it->second);
  if (c != cache.end()) return c->second;
  if (cache.size() > 1024) cache.clear();
  return cache.emplace(it->second, parseModifiers(it->second)).first->second;
}

bool repeatContent(const Document& doc, Guid id, Rect& out) {
  bool any = false;
  for (Guid c : doc.children(id)) {
    const Node* n = doc.get(c);
    if (!n || !n->props.visible) continue;
    Rect b = transformedBounds(n->props.transform, n->props.size.x, n->props.size.y);
    out = any ? out.united(b) : b;
    any = true;
  }
  return any;
}

const geom::RepeatResult* repeatOf(const Document& doc, Guid id) {
  const Node* n = doc.get(id);
  if (!n || n->props.type != NodeType::TRANSFORM) return nullptr;
  Rect content;
  if (!repeatContent(doc, id, content)) return nullptr;
  const auto& mods = transformModifiersOf(n->props);
  struct Entry {
    uint64_t key = 0;
    geom::RepeatResult result;
  };
  static std::unordered_map<Guid, Entry, GuidHash> cache;
  uint64_t key = 1469598103934665603ull;
  key = mix(mix(mix(mix(key, content.x), content.y), content.w), content.h);
  auto bytes = n->props.extra.find("transformModifiers");
  if (bytes != n->props.extra.end()) key = (key ^ std::hash<std::string>()(bytes->second)) * 1099511628211ull;
  auto it = cache.find(id);
  if (it != cache.end() && it->second.key == key) return &it->second.result;
  if (cache.size() > 4096) cache.clear();
  Entry& e = cache[id];
  e.key = key;
  e.result = geom::evaluateRepeat(mods, content);
  return &e.result;
}

Guid repeatAncestor(const Document& doc, Guid id) {
  for (Guid a = doc.parentOf(id); a != kNoGuid; a = doc.parentOf(a)) {
    const Node* n = doc.get(a);
    if (!n || n->props.type == NodeType::CANVAS) break;
    if (n->props.type == NodeType::TRANSFORM) return a;
  }
  return kNoGuid;
}

}  // namespace eng
