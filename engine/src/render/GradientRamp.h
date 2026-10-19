// A gradient's colour ramp, blended in the space Figma's Paint names (interpolationColorSpace 41 /
// interpolationHueMethod 42, docs/research/rea/effects.md §2.22) the way CSS Color 4 interpolates: straight colours →
// that space, alpha premultiplied into its non-hue components, hue taken the chosen way round (a missing hue — grey —
// takes the other stop's), back to the document's components. The renderer bakes it into a ramp texture row; the
// shaders only sample it.
#pragma once

#include <cstdint>
#include <vector>

#include "scene/Extras.h"
#include "scene/Node.h"

namespace eng {

// Straight (not premultiplied) components of the stop colours' space, unclipped: the colour `t` (0..1) of the way
// from `a` to `b`.
struct RampColor {
  double r = 0, g = 0, b = 0, a = 0;
};
RampColor interpolateColor(const Color& a, const Color& b, double t, InterpolationColorSpace space, InterpolationHueMethod hue);

// `width` premultiplied RGBA8 texels (t = i / (width - 1)) of the stops (in any order) into `out`.
void bakeGradientRamp(const std::vector<ColorStop>& stops, InterpolationColorSpace space, InterpolationHueMethod hue, int width,
                      std::vector<uint8_t>& out);

// OKLab ↔ gamma-encoded sRGB components (tests; the ramp's own conversions).
void srgbToOklab(const double rgb[3], double lab[3]);
void oklabToSrgb(const double lab[3], double rgb[3]);

}  // namespace eng
