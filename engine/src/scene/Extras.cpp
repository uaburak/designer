#include "scene/Extras.h"

#include <algorithm>
#include <cstdlib>
#include <string>
#include <unordered_map>

#include "base/Json.h"
#include "render/shader_presets.h"
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
  bool hasRefractionRadius = false, hasReflection = false;
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
    else if (k == "opacity") x.opacity = m.numberOr(0);
    else if (k == "seed") x.seed = static_cast<uint32_t>(m.numberOr(0));
    else if (k == "refractionRadius") x.refractionRadius = m.numberOr(x.refractionRadius), hasRefractionRadius = true;
    else if (k == "specularAngle") x.specularAngle = m.numberOr(x.specularAngle);
    else if (k == "specularIntensity") x.specularIntensity = m.numberOr(x.specularIntensity);
    else if (k == "bevelSize") x.bevelSize = m.numberOr(x.bevelSize);
    else if (k == "chromaticAberration") x.chromaticAberration = m.numberOr(x.chromaticAberration);
    else if (k == "reflectionDistance") x.reflectionDistance = m.numberOr(x.reflectionDistance), hasReflection = true;
    else if (k == "refractionIntensity") x.refractionIntensity = m.numberOr(x.refractionIntensity);
  }
  // Wecra's glass before round 17: Depth in bevelSize, Splay (0–100) in refractionRadius. Figma writes bevelSize 1.
  if (x.bevelSize > 1) {
    double splay = hasRefractionRadius ? x.refractionRadius / 100 : 0;
    x.refractionRadius = x.bevelSize;
    if (!hasReflection) x.reflectionDistance = std::clamp(splay, 0.0, 1.0);
    x.bevelSize = 1;
  }
  return cache.map.emplace(e.extra, x).first->second;
}

float imageContrast(float stored) {
  if (std::fabs(stored) > 0.3f + 1e-6f) return std::clamp(stored, -1.f, 1.f) * 0.3f;  // Wecra's −1…1 before round 17
  return stored;
}

bool visibleForRendering(const Effect& e) {
  if (!e.visible) return false;
  switch (e.type) {
    case EffectType::DROP_SHADOW: return e.color.a > 0;
    case EffectType::INNER_SHADOW:
      return e.color.a > 0 && (e.radius > 0 || e.offset.x != 0 || e.offset.y != 0 || e.spread > 0);
    case EffectType::FOREGROUND_BLUR:
    case EffectType::BACKGROUND_BLUR: return e.radius > 0 || effectExtras(e).startRadius > 0;
    case EffectType::GRAIN: return e.radius > 0;
    default: return true;  // noise, glass, shader effects
  }
}

double shadowSpread(const NodeProps& p, const Effect& e) {
  if (e.spread == 0) return 0;
  if (p.isFrameLike()) {
    bool fill = false;
    for (const Paint& f : p.fillPaints)
      fill |= f.visible && f.opacity * (f.type == PaintType::SOLID ? f.color.a : 1.f) >= 0.01f;
    return p.clipsContent() && fill ? e.spread : 0;
  }
  return p.isRectLike() || p.type == NodeType::ELLIPSE ? e.spread : 0;
}

Rect effectsBounds(const NodeProps& p, const Rect& box, double scale) {
  auto grow = [](const Rect& r, double d) { return Rect{r.x - d, r.y - d, r.w + 2 * d, r.h + 2 * d}; };
  double blur = 0, shader = 0;
  for (const Effect& e : p.effects) {
    if (!visibleForRendering(e)) continue;
    if (e.type == EffectType::FOREGROUND_BLUR) blur += std::max(e.radius, effectExtras(e).startRadius);  // progressive: the larger end
    else if (e.type == EffectType::GRAIN && !effectExtras(e).clipToShape) blur += e.radius;  // "how far past the layer's boundary"
    else if (e.type == EffectType::CUSTOM) shader = std::max(shader, shaderReach(shaderOf(e)));
  }
  Rect out = grow(box, (blur + shader) * scale);
  for (const Effect& e : p.effects) {
    if (e.type != EffectType::DROP_SHADOW || !visibleForRendering(e)) continue;
    Rect s = grow(box, (std::max(0.0, e.radius + shadowSpread(p, e)) + blur) * scale);  // spread only where it's drawn
    s.x += e.offset.x * scale;
    s.y += e.offset.y * scale;
    out = out.united(s);
  }
  return out;
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
    else if (k == "interpolationColorSpace")
      x.interpolationColorSpace = named(m, {"DEFAULT", "OKLAB", "OKLCH", "HSL", "SRGB_LINEAR"}, InterpolationColorSpace::DEFAULT);
    else if (k == "interpolationHueMethod")
      x.interpolationHueMethod = named(m, {"SHORTER", "LONGER", "INCREASING", "DECREASING"}, InterpolationHueMethod::SHORTER);
  }
  return cache.map.emplace(p.extra, x).first->second;
}

namespace {

// A GUID's localID from JSON ({sessionID, localID} or "s:l"); false unless its session is 0 (a preset's defIDs).
bool presetLocal(const json::Value& v, uint32_t& out) {
  if (v.isObject()) {
    const json::Value* s = v.get("sessionID");
    const json::Value* l = v.get("localID");
    if (!l || (s && s->numberOr(0) != 0)) return false;
    out = static_cast<uint32_t>(l->numberOr(0));
    return true;
  }
  if (v.isString()) {
    size_t colon = v.string.find(':');
    if (colon == std::string::npos || v.string.substr(0, colon) != "0") return false;
    out = static_cast<uint32_t>(std::strtoul(v.string.substr(colon + 1).c_str(), nullptr, 10));
    return true;
  }
  return false;
}

ShaderSetup shaderFrom(const char* def, const std::string& extra) {
  ShaderSetup out;
  json::Value v = membersOf(def, extra);
  const json::Value* id = v.get("customEffectId");
  const json::Value* ref = id ? id->get("assetRef") : nullptr;
  const json::Value* key = ref ? ref->get("key") : nullptr;
  if (!key || !key->isString()) return out;
  for (const shaders::PresetDef& p : shaders::kPresets)
    if (key->string == p.key) out.preset = &p;
  if (!out.preset) return out;
  const shaders::PresetDef& p = *out.preset;
  for (int i = 0; i < p.count; i++)
    for (int k = 0; k < 4; k++) out.values[i][k] = p.params[i].value[k];
  const json::Value* list = v.get("componentPropAssignments");
  if (!list || !list->isArray()) return out;
  for (const json::Value& a : list->array) {
    uint32_t local = 0;
    const json::Value* defId = a.get("defID");
    if (!defId || !presetLocal(*defId, local)) continue;
    int at = -1;
    for (int i = 0; i < p.count; i++)
      if (p.params[i].id == local) at = i;
    if (at < 0) continue;
    float* x = out.values[at];
    if (p.params[at].type == shaders::ParamType::Color) {
      // A colour: the assignment's varValue, a COLOR literal.
      const json::Value* var = a.get("varValue");
      const json::Value* val = var ? var->get("value") : nullptr;
      const json::Value* c = val ? val->get("colorValue") : nullptr;
      if (c && c->isObject()) {
        Color col = color(*c, Color{x[0], x[1], x[2], x[3]});
        x[0] = col.r, x[1] = col.g, x[2] = col.b, x[3] = col.a;
      }
      continue;
    }
    const json::Value* val = a.get("value");
    if (!val || !val->isObject()) continue;
    if (const json::Value* f = val->get("floatValue"); f && f->isNumber()) x[0] = static_cast<float>(f->number);
    else if (const json::Value* b = val->get("boolValue"); b && b->isBool()) x[0] = b->boolean ? 1.f : 0.f;
  }
  return out;
}

const ShaderSetup& cachedShader(const char* def, const std::string& extra, Cache<ShaderSetup>& cache) {
  if (extra.empty()) return cache.none;
  auto it = cache.map.find(extra);
  if (it != cache.map.end()) return it->second;
  if (cache.map.size() > 4096) cache.map.clear();
  return cache.map.emplace(extra, shaderFrom(def, extra)).first->second;
}

}  // namespace

const ShaderSetup& shaderOf(const Paint& p) {
  static Cache<ShaderSetup> cache;
  return cachedShader("Paint", p.extra, cache);
}

const ShaderSetup& shaderOf(const Effect& e) {
  static Cache<ShaderSetup> cache;
  return cachedShader("Effect", e.extra, cache);
}

double shaderReach(const ShaderSetup& s) {
  if (!s.preset || !s.preset->effect) return 0;
  auto v = [&](uint32_t id) {
    for (int i = 0; i < s.preset->count; i++)
      if (s.preset->params[i].id == id) return std::max(0.0, static_cast<double>(s.values[i][0]));
    return 0.0;
  };
  // The effects' programs (src/shared/shaders/presets.json's order) whose pixels land past the layer they read.
  switch (s.preset->program) {
    case 0: return v(3) + v(1);              // Shape-based particles: spread + size
    case 1: return v(2);                     // Pattern refraction: strength
    case 2: return v(1) * 0.25;              // Halftone: dots past the edge (up to 0.7 of a cell around its centre)
    case 7: return v(1);                     // Warp: strength
    case 9: return v(1);                     // Bokeh blur: radius
    case 10: return std::min(v(3), 6.0) * (v(2) + v(4)) + 1;  // Outlines: count × (width + gap)
    case 12: return v(3);                    // Bloom: radius
    case 13: return v(4) + v(2);             // Glowing particles: glow + size
    case 16: return v(1);                    // Gooey merge: radius
    case 18: return v(2);                    // Slice shift: offset
    case 19: return v(3);                    // Light rays: length
    case 21: return v(2);                    // Colored edges: width
    default: return 0;
  }
}

}  // namespace eng
