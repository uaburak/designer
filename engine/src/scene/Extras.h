// The newer effect and paint fields (schema Effect 19–36: progressive blur, noise, texture, glass; Paint 26–37:
// pattern and noise paints; Paint 39–40 / Effect 43–44: shaders), read for drawing. They travel in the effect's / paint's `extra` (the schema's encoding,
// round-tripped untouched by both codecs and edited by the panels through the JSON API); these are their typed
// values, decoded once per distinct encoding (a small cache).
#pragma once

#include <cstdint>

#include "scene/Node.h"

namespace eng {

namespace shaders {
struct PresetDef;  // <build>/generated/render/shader_presets.h (src/shared/shaders/presets.json)
}

enum class BlurOpType : uint8_t { NORMAL = 0, PROGRESSIVE = 1 };
enum class NoiseType : uint8_t { MULTITONE = 0, MONOTONE = 1, DUOTONE = 2 };
enum class PatternTileType : uint8_t { RECTANGULAR = 0, HORIZONTAL_HEXAGONAL = 1, VERTICAL_HEXAGONAL = 2 };
enum class PatternAlignment : uint8_t { START = 0, CENTER = 1, END = 2 };

// An absent field reads as Figma's Effect reads it (docs/research/rea/effects.md §2.27: noiseSize 0, opacity 0,
// blurOpType NORMAL, seed 0; clipToShape is Figma's `type == CUSTOM`, and only texture reads it here); glass's as
// Figma's new glass effect (§2.14).
struct EffectExtras {
  BlurOpType blurOpType = BlurOpType::NORMAL;
  Vec2 startOffset{0.5, 0}, endOffset{0.5, 1};  // the node's box, 0..1 (Figma's default direction: top to bottom)
  double startRadius = 0;
  Vec2 noiseSize{0, 0};                         // noise "Noise size", texture "Size" (px)
  bool clipToShape = false;
  Color secondaryColor{1, 1, 1, 0.25f};
  double density = 1;
  NoiseType noiseType = NoiseType::MONOTONE;
  double opacity = 0;                           // noise, Multi
  uint32_t seed = 0;
  // Glass (Figma's Plugin API names): Depth = refractionRadius (1–100), light Angle = specularAngle (degrees), light
  // Intensity = specularIntensity, Dispersion = chromaticAberration, Splay = reflectionDistance (0–1), Refraction =
  // refractionIntensity; bevelSize is always 1. "Frost" is the effect's radius.
  double refractionRadius = 20, specularAngle = -45, specularIntensity = 0.8, bevelSize = 1, chromaticAberration = 0.5,
         reflectionDistance = 0, refractionIntensity = 0.8;
};

struct PaintExtras {
  Guid sourceNodeId = kNoGuid;
  Vec2 patternSpacing{0, 0};  // a share of the tile
  PatternTileType tileType = PatternTileType::RECTANGULAR;
  PatternAlignment horizontalAlignment = PatternAlignment::START, verticalAlignment = PatternAlignment::START;
  NoiseType noiseType = NoiseType::MONOTONE;
  double density = 1;
  Vec2 noiseSize{0.5, 0.5};
};

// A shader paint or effect (PaintType / EffectType CUSTOM): the preset its customEffectId names (assetRef.key) and its
// parameters' values in the preset's order — an assignment's (componentPropAssignments, by defID), else the preset's
// default. Colours r g b a (straight), the others in .x (a toggle 0 / 1, a choice its index).
struct ShaderSetup {
  const shaders::PresetDef* preset = nullptr;  // null: none, or a shader this engine doesn't know (not drawn)
  float values[12][4] = {};
};

// The effect's newer fields (defaults where it has none). A glass written by Wecra before round 17 (Depth in
// bevelSize, Splay 0–100 in refractionRadius; Figma always writes bevelSize 1) reads as Figma's fields.
const EffectExtras& effectExtras(const Effect& e);
// An image paint's contrast as Figma stores it: ±0.3, the panel's ±100 (its shader's range,
// docs/research/rea/effects.md §2.24). Wecra stored −1…1 before round 17: a value past ±0.3 is such, read × 0.3.
float imageContrast(float stored);
// Whether the effect draws anything (Figma's Effect::isVisibleForRendering, docs/research/rea/effects.md §2.27):
// shadows need a colour with alpha, an inner shadow also a blur, an offset or a positive spread; blurs a radius (or a
// progressive start), texture a radius; noise, glass and shader effects only being on.
bool visibleForRendering(const Effect& e);
// A shadow's spread as Figma draws it: "only supported on rectangles, ellipses, frames, and components" (help
// 360041488473) — a frame or component only when it clips its content and has a visible fill (≥ 1 % opacity); 0
// elsewhere.
double shadowSpread(const NodeProps& p, const Effect& e);
// What the node's effects draw past `box` (its rendered box, in the same units; `scale` = those units per node unit),
// as Figma grows a node's bounds (docs/research/rea/effects.md §2.3): every visible layer blur and an unclipped texture
// by their radius, summed (they compound); each drop shadow by its offset ± (radius + its drawn spread, shadowSpread), then by the blurs;
// shader effects by their reach. Inner shadows, background blurs, glass and noise draw inside it.
Rect effectsBounds(const NodeProps& p, const Rect& box, double scale);
// The paint's pattern / noise fields.
const PaintExtras& paintExtras(const Paint& p);
// A CUSTOM paint's / effect's shader.
const ShaderSetup& shaderOf(const Paint& p);
const ShaderSetup& shaderOf(const Effect& e);
// How far (node px) a shader effect draws past the layer it reads (particles, glows, rays, outlines, offsets).
double shaderReach(const ShaderSetup& s);

}  // namespace eng
