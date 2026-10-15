// Figma Draw's dynamic strokes (docs/draw.md §4.3): a stroke whose centre line wanders — Frequency, Wiggle and
// Smoothen (NodeChange.dynamicStrokeSettings 448), seeded by strokeSeed 482. The centre line is displaced along its
// normal by a seeded random wave and then stroked as any stroke is (the node's caps, joins, alignment):
//
//   - wavelength λ = kDynWavelengthPx / frequency (node px); knots every λ/2 of arc length, each with a value
//     u ∈ [−1, 1] from a counter-based hash of (seed, contour, knot); closed contours wrap their knots;
//   - displacement d(s) = kDynAmplitude · wiggle · weight · interp(u, s): linear between knots at smoothen 0,
//     Catmull-Rom at 1, a blend between;
//   - smoothen also low-passes the input (a moving average over smoothen · λ/2 of arc length), so a Pencil stroke's
//     hand jitter goes before the wave is added; no taper at open ends;
//   - wiggle 0: the centre line as it is (exactly a Basic stroke).
//
// Derived geometry, never stored. Constants are ours until a Figma Draw sample calibrates them (§11).
#pragma once

#include <algorithm>
#include <cmath>
#include <cstdint>

#include "geometry/Path.h"
#include "scene/Node.h"

namespace eng {

struct NodeGeometry;

namespace geom {

inline constexpr double kDynWavelengthPx = 100;  // frequency 1 → one wave per 100 px [ours]
inline constexpr double kDynAmplitude = 0.5;     // × wiggle × weight [ours]

// A new Dynamic stroke's settings: Figma's (live 2026-10-15, docs/research/rea/vector.md §2: 0.75 / 0.3 / 0.5 read
// back from the plugin), DYNAMIC_DEFAULTS in src/shared/draw/types.ts.
struct DynamicSettings {
  double frequency = 0.75;
  double wiggle = 0.3;
  double smoothen = 0.5;
};

// Figma's neutral value {frequency 1, wiggle 0, smoothen 0}: what Basic leaves in a present dynamicStrokeSettings,
// read as no dynamic stroke at all (rea/vector.md §1).
inline constexpr DynamicSettings kDynamicNeutral{1, 0, 0};
inline bool isNeutralDynamic(const DynamicSettings& s) {
  auto near = [](double a, double b) { return std::abs(a - b) < 1e-6; };
  return near(s.frequency, kDynamicNeutral.frequency) && near(s.wiggle, kDynamicNeutral.wiggle) && near(s.smoothen, kDynamicNeutral.smoothen);
}
// The engine's cap on wiggle for geometry (the document keeps any wiggle ≥ 0, as Figma's plugin does) [ours].
inline constexpr double kDynWiggleCap = 100;

// The displaced centre line (polylines: one per contour, closed ones closed). `tolerance`: how finely `center`'s
// curves are flattened first (node units).
Path dynamicCenterline(const Path& center, double weight, const DynamicSettings& s, uint64_t seed, double tolerance);

// The wave alone at arc length `s` of a contour `length` long (open or closed): what dynamicCenterline displaces by,
// in units of kDynAmplitude · wiggle · weight (so in [−1, 1] up to Catmull-Rom's overshoot). Tests and bounds.
double dynamicWave(double s, double length, bool closed, double frequency, double smoothen, uint64_t seed, uint32_t contour);

// How far a dynamic stroke's centre line can stray from the original (bounds): the wave's largest reach.
inline double dynamicReach(const DynamicSettings& s, double weight) { return kDynAmplitude * std::max(0.0, s.wiggle) * weight * 1.25; }

}  // namespace geom

// The node's dynamic stroke settings (dynamicStrokeSettings; clamped to the plugin's ranges, wiggle to kDynWiggleCap);
// false when it has none, when they are Figma's neutral {1, 0, 0} (a Basic stroke), or when the stroke is a brush's
// (strokeBrushGuid naming a node — Figma's -1:-1 is no brush).
bool dynamicSettingsOf(const NodeProps& p, geom::DynamicSettings& out);
// dynamicSettingsOf without the settings: the stroke is Dynamic (not Basic, not a brush).
bool hasDynamicStroke(const NodeProps& p);
// The node's strokeSeed (0 when absent).
uint64_t strokeSeedOf(const NodeProps& p);

// A node with a dynamic stroke: `g`'s stroke centre line displaced (node space), cached by (centre line, settings,
// seed, weight, tolerance). False when the node's stroke isn't dynamic. `key` gets a hash of what it was made from.
bool dynamicCenter(const NodeProps& p, const NodeGeometry& g, double tolerance, geom::Path& out, uint64_t* key = nullptr);

}  // namespace eng
