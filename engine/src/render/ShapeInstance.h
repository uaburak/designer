// The instance layout of the Shape shader (gfx::ShaderId::Shape): one rect,
// rounded rect or ellipse with its fill and stroke, in draw space (CSS px).
#pragma once

namespace eng {

struct ShapeInstance {
  float linear[4];  // m00, m10, m01, m11: shape space → draw space (columns)
  float origin[4];  // tx, ty, width, height
  float radii[4];   // tl, tr, br, bl (rectangles)
  float fill[4];    // premultiplied rgba
  float stroke[4];  // premultiplied rgba
  float params[4];  // stroke inner extent, stroke outer extent, shape (0 rect, 1 ellipse), unused
};
static_assert(sizeof(ShapeInstance) == 96, "ShapeInstance is 6 vec4s");

enum class ShapeKind : unsigned char { Rect = 0, Ellipse = 1 };

}  // namespace eng
