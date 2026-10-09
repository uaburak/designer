// Variable-width strokes (round 12; Figma Draw's Width profile and Variable width tool). A stroke's width along its
// path is a list of width points (schema VariableWidthPoint, NodeChange.variableWidthPoints = 447): each at a
// position along the stroke, with the share of the stroke weight on each side of the path there. Between points the
// width follows a smooth monotone curve; an end of the stroke without a point of its own keeps the stroke's weight. No
// points: the plain (uniform) stroke.
//
// What is from Figma (developers.figma.com VariableWidthStrokeProperties): a point's position runs 0 → 1 along the
// stroke and its width is a fraction of the stroke weight; the presets UNIFORM, WEDGE, TAPER, QUARTER_TAPER, EYE and
// MIRRORED_TAPER and what each does. Unverified (ours): the file fields' exact meaning — `ascent` / `descent` read as
// the shares of the weight left / right of the path (ascent + descent = the width; 0.5 / 0.5 = uniform), `position`
// along the whole contour (each contour of the stroke gets the profile), `segmentId` written 0 and not read; the
// smooth (Fritsch–Carlson monotone cubic) curve between points; the weight at an end without a point; the presets'
// points.
#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include "geometry/Path.h"
#include "scene/Node.h"

namespace eng::geom {

struct WidthPoint {
  double position = 0;  // 0 → 1 along the stroke
  double ascent = 0.5;  // share of the stroke weight left of the path (its "up" side walking along it)
  double descent = 0.5; // … right of it
  double width() const { return ascent + descent; }
  bool operator==(const WidthPoint& o) const { return position == o.position && ascent == o.ascent && descent == o.descent; }
};

// The Width profile presets (the plugin API's names, its order).
enum class WidthProfile : uint8_t { UNIFORM, WEDGE, TAPER, QUARTER_TAPER, EYE, MIRRORED_TAPER, CUSTOM };
constexpr const char* kWidthProfileNames[] = {"UNIFORM", "WEDGE", "TAPER", "QUARTER_TAPER", "EYE", "MIRRORED_TAPER", "CUSTOM"};

// A preset's points (UNIFORM and CUSTOM: none).
std::vector<WidthPoint> presetPoints(WidthProfile profile);
// The preset these points are (within 1e-4), else CUSTOM; none: UNIFORM.
WidthProfile matchPreset(const std::vector<WidthPoint>& points);
// Sorted by position, positions clamped to 0…1, shares to ≥ 0.
std::vector<WidthPoint> normalized(std::vector<WidthPoint> points);
// The shares at `u` (0…1) of sorted points; none: 0.5 / 0.5.
void profileAt(const std::vector<WidthPoint>& sorted, double u, double& ascent, double& descent);
// The largest share on either side (bounds).
double maxShare(const std::vector<WidthPoint>& points);
// The profile mirrored along the path (Flip width points): position → 1 − position.
std::vector<WidthPoint> flipped(const std::vector<WidthPoint>& points);

}  // namespace eng::geom

namespace eng {

// A node's width points (normalized; empty: uniform) from its `variableWidthPoints`.
std::vector<geom::WidthPoint> widthPointsOf(const NodeProps& p);
bool hasWidthPoints(const NodeProps& p);
// A hash of the stored points (caches).
uint64_t widthPointsKey(const NodeProps& p);
// The NodeProps::extra value for `points` (empty: the field removed).
std::string encodeWidthPoints(const std::vector<geom::WidthPoint>& points);
// Figma: "can't be applied to vector networks with branching paths, or to layers using a dynamic or dashed stroke".
// Dashes and a dynamic stroke (dynamicStrokeSettings) here; branching is the network's (VectorNetwork::degrees() > 2).
bool widthProfileAllowed(const NodeProps& p);

}  // namespace eng
