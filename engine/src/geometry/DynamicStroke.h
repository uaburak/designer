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
#include <cstdint>

#include "geometry/Path.h"
#include "scene/Node.h"

namespace eng {

struct NodeGeometry;

namespace geom {

inline constexpr double kDynWavelengthPx = 100;  // frequency 1 → one wave per 100 px [ours]
inline constexpr double kDynAmplitude = 0.5;     // × wiggle × weight [ours]

struct DynamicSettings {
  double frequency = 2;  // DYNAMIC_DEFAULTS (src/shared/draw/types.ts)
  double wiggle = 1;
  double smoothen = 0.5;
};

// The displaced centre line (polylines: one per contour, closed ones closed). `tolerance`: how finely `center`'s
// curves are flattened first (node units).
Path dynamicCenterline(const Path& center, double weight, const DynamicSettings& s, uint64_t seed, double tolerance);

// The wave alone at arc length `s` of a contour `length` long (open or closed): what dynamicCenterline displaces by,
// in units of kDynAmplitude · wiggle · weight (so in [−1, 1] up to Catmull-Rom's overshoot). Tests and bounds.
double dynamicWave(double s, double length, bool closed, double frequency, double smoothen, uint64_t seed, uint32_t contour);

// How far a dynamic stroke's centre line can stray from the original (bounds): the wave's largest reach.
inline double dynamicReach(const DynamicSettings& s, double weight) { return kDynAmplitude * std::max(0.0, s.wiggle) * weight * 1.25; }

}  // namespace geom

// The node's dynamic stroke settings (dynamicStrokeSettings; clamped to the plugin's ranges); false when it has none.
// A brush stroke (strokeBrushGuid set) is not dynamic.
bool dynamicSettingsOf(const NodeProps& p, geom::DynamicSettings& out);
// The node's strokeSeed (0 when absent).
uint64_t strokeSeedOf(const NodeProps& p);

// A node with a dynamic stroke: `g`'s stroke centre line displaced (node space), cached by (centre line, settings,
// seed, weight, tolerance). False when the node's stroke isn't dynamic. `key` gets a hash of what it was made from.
bool dynamicCenter(const NodeProps& p, const NodeGeometry& g, double tolerance, geom::Path& out, uint64_t* key = nullptr);

}  // namespace eng
