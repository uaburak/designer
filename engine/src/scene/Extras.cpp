#include "scene/Extras.h"

#include <cstdlib>
#include <string>
#include <unordered_map>

#include "base/Json.h"
#include "scene/CodecKiwi.h"

namespace eng {

namespace {

// The members of `extra` (kiwi bytes of `def`'s fields) as a JSON object.
json::Value membersOf(const char* def, const std::string& extra) {
  json::Value v;
  if (extra.empty()) return v;
  std::string members = codec::extraToJsonMembers(def, extra);
  if (members.empty()) return v;
  json::parse("{" + members + "}", v);
  return v;
}

Vec2 vec(const json::Value& v, Vec2 fallback) {
  if (!v.isObject()) return fallback;
  const json::Value* x = v.get("x");
  const json::Value* y = v.get("y");
  return {x ? x->numberOr(fallback.x) : fallback.x, y ? y->numberOr(fallback.y) : fallback.y};
}

Color color(const json::Value& v, Color fallback) {
  if (!v.isObject()) return fallback;
  auto c = [&](const char* k, float f) {
    const json::Value* x = v.get(k);
    return x ? static_cast<float>(x->numberOr(f)) : f;
  };
  return {c("r", fallback.r), c("g", fallback.g), c("b", fallback.b), c("a", fallback.a)};
}

template <typename E>
E named(const json::Value& v, std::initializer_list<const char*> names, E fallback) {
  if (v.isNumber()) return static_cast<E>(static_cast<int>(v.number));
  if (!v.isString()) return fallback;
  int i = 0;
  for (const char* n : names) {
    if (v.string == n) return static_cast<E>(i);
    i++;
  }
  return fallback;
}

constexpr std::initializer_list<const char*> kNoiseTypes = {"MULTITONE", "MONOTONE", "DUOTONE"};

template <typename T>
struct Cache {
  std::unordered_map<std::string, T> map;
  T none;
};

}  // namespace

const EffectExtras& effectExtras(const Effect& e) {
  static Cache<EffectExtras> cache;
  if (e.extra.empty()) return cache.none;
  auto it = cache.map.find(e.extra);
  if (it != cache.map.end()) return it->second;
  if (cache.map.size() > 4096) cache.map.clear();
  EffectExtras x;
  json::Value v = membersOf("Effect", e.extra);
  for (auto& [k, m] : v.object) {
    if (k == "blurOpType") x.blurOpType = named(m, {"NORMAL", "PROGRESSIVE"}, BlurOpType::NORMAL);
    else if (k == "startOffset") x.startOffset = vec(m, x.startOffset);
    else if (k == "endOffset") x.endOffset = vec(m, x.endOffset);
    else if (k == "startRadius") x.startRadius = m.numberOr(0);
    else if (k == "noiseSize") x.noiseSize = vec(m, x.noiseSize);
    else if (k == "clipToShape") x.clipToShape = m.isBool() && m.boolean;
    else if (k == "secondaryColor") x.secondaryColor = color(m, x.secondaryColor);
    else if (k == "density") x.density = m.numberOr(1);
    else if (k == "noiseType") x.noiseType = named(m, kNoiseTypes, NoiseType::MONOTONE);
    else if (k == "opacity") x.opacity = m.numberOr(1);
    else if (k == "seed") x.seed = static_cast<uint32_t>(m.numberOr(0));
    else if (k == "refractionRadius") x.refractionRadius = m.numberOr(x.refractionRadius);
    else if (k == "specularAngle") x.specularAngle = m.numberOr(x.specularAngle);
    else if (k == "specularIntensity") x.specularIntensity = m.numberOr(x.specularIntensity);
    else if (k == "bevelSize") x.bevelSize = m.numberOr(x.bevelSize);
    else if (k == "chromaticAberration") x.chromaticAberration = m.numberOr(x.chromaticAberration);
    else if (k == "reflectionDistance") x.reflectionDistance = m.numberOr(x.reflectionDistance);
    else if (k == "refractionIntensity") x.refractionIntensity = m.numberOr(x.refractionIntensity);
  }
  return cache.map.emplace(e.extra, x).first->second;
}

const PaintExtras& paintExtras(const Paint& p) {
  static Cache<PaintExtras> cache;
  if (p.extra.empty()) return cache.none;
  auto it = cache.map.find(p.extra);
  if (it != cache.map.end()) return it->second;
  if (cache.map.size() > 4096) cache.map.clear();
  PaintExtras x;
  json::Value v = membersOf("Paint", p.extra);
  for (auto& [k, m] : v.object) {
    if (k == "sourceNodeId" && m.isObject()) {
      const json::Value* s = m.get("sessionID");
      const json::Value* l = m.get("localID");
      if (s && l) x.sourceNodeId = Guid{static_cast<uint32_t>(s->numberOr(0)), static_cast<uint32_t>(l->numberOr(0))};
    } else if (k == "sourceNodeId" && m.isString()) {
      size_t colon = m.string.find(':');
      if (colon != std::string::npos)
        x.sourceNodeId = Guid{static_cast<uint32_t>(std::strtoul(m.string.substr(0, colon).c_str(), nullptr, 10)),
                              static_cast<uint32_t>(std::strtoul(m.string.substr(colon + 1).c_str(), nullptr, 10))};
    } else if (k == "patternSpacing") x.patternSpacing = vec(m, x.patternSpacing);
    else if (k == "spacing" && m.isNumber()) x.patternSpacing = {m.number, m.number};
    else if (k == "patternTileType")
      x.tileType = named(m, {"RECTANGULAR", "HORIZONTAL_HEXAGONAL", "VERTICAL_HEXAGONAL"}, PatternTileType::RECTANGULAR);
    else if (k == "horizontalAlignment") x.horizontalAlignment = named(m, {"START", "CENTER", "END"}, PatternAlignment::START);
    else if (k == "verticalAlignment") x.verticalAlignment = named(m, {"START", "CENTER", "END"}, PatternAlignment::START);
    else if (k == "noiseType") x.noiseType = named(m, kNoiseTypes, NoiseType::MONOTONE);
    else if (k == "density") x.density = m.numberOr(1);
    else if (k == "noiseSize") x.noiseSize = vec(m, x.noiseSize);
  }
  return cache.map.emplace(p.extra, x).first->second;
}

}  // namespace eng
