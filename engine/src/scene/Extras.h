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

struct EffectExtras {
  BlurOpType blurOpType = BlurOpType::NORMAL;
  Vec2 startOffset{0.5, 0}, endOffset{0.5, 1};  // the node's box, 0..1 (Figma's default direction: top to bottom)
  double startRadius = 0;
  Vec2 noiseSize{0.5, 0.5};                     // noise "Noise size", texture "Size" (px)
  bool clipToShape = false;
  Color secondaryColor{1, 1, 1, 0.25f};
  double density = 1;
  NoiseType noiseType = NoiseType::MONOTONE;
  double opacity = 1;                           // noise, Multi
  uint32_t seed = 0;
  // Glass (the panel's names): Splay, light Angle (degrees), light Intensity, Depth, Dispersion, —, Refraction.
  double refractionRadius = 0, specularAngle = -45, specularIntensity = 0.8, bevelSize = 20, chromaticAberration = 0.5,
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

// The effect's newer fields (defaults where it has none).
const EffectExtras& effectExtras(const Effect& e);
// The paint's pattern / noise fields.
const PaintExtras& paintExtras(const Paint& p);
// A CUSTOM paint's / effect's shader.
const ShaderSetup& shaderOf(const Paint& p);
const ShaderSetup& shaderOf(const Effect& e);
// How far (node px) a shader effect draws past the layer it reads (particles, glows, rays, outlines, offsets).
double shaderReach(const ShaderSetup& s);

}  // namespace eng
