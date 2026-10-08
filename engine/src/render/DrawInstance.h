// The instance layout of the Draw shader (gfx::ShaderId::Shape, gfx/gl/Shaders.h
// kDraw*): one shape, path or glyph, placed in draw space (CSS px), with one
// paint, a clip rectangle and a rounded clip. 10 vec4s.
//
//   linear  local → draw space, columns (m00, m10), (m01, m11)
//   origin  tx, ty, then — Shape: width, height; Path: first curve texel, clip path's first texel (−1: none)
//   box     Shape: corner radii tl tr br bl; Path: the quad's bounds x0 y0 x1 y1 (local)
//   geom    Shape: stroke inner extent, outer extent (or σ, spread for shadows), kind, flags;
//           Path: unused, unused, kind (Path), flags
//   color   premultiplied colour (SOLID; shadows), else (1, 1, 1, alpha) multiplying the paint
//   paint0  paint matrix row 0 (local → paint space: gradient / image uv / noise cells) + aux (images: 1 = repeat;
//           noise: density)
//   paint1  paint matrix row 1 + gradient ramp row (noise: its type); Shape kind FILL_AND_STROKE: paint0 = the
//           stroke colour
//   clip    x0 y0 x1 y1 in canvas device px: pixels outside are not drawn (a frame's axis-aligned clip)
//   round   x0 y0 x1 y1 in canvas device px of an axis-aligned rounded clip (x1 < x0: none), anti-aliased
//   radii   its corner radii in device px: top-left, top-right, bottom-right, bottom-left
#pragma once

#include <cstdint>

namespace eng {

struct DrawInstance {
  float linear[4];
  float origin[4];
  float box[4];
  float geom[4];
  float color[4];
  float paint0[4];
  float paint1[4];
  float clip[4] = {-1e9f, -1e9f, 1e9f, 1e9f};
  float round[4] = {0, 0, -1, -1};
  float radii[4] = {0, 0, 0, 0};
};
static_assert(sizeof(DrawInstance) == 160, "DrawInstance is 10 vec4s");

// geom[2]: what the instance is.
enum class ShapeKind : uint8_t {
  Rect = 0,         // SDF rectangle / rounded rectangle
  Ellipse = 1,      // SDF ellipse
  DropShadow = 2,   // analytic blurred rounded rectangle (σ = geom[0]); the box is already offset and spread
  InnerShadow = 3,  // the box's coverage × (1 − the shadow of the box shrunk by spread, offset by paint0.xy)
  Path = 4,         // coverage from curves (Path shader)
};

// geom[3] bits.
enum DrawFlags : uint32_t {
  DF_EVEN_ODD = 1,        // Path: the ODD rule
  DF_CLIP_INTERSECT = 2,  // Path: × the clip path's coverage (INSIDE strokes)
  DF_CLIP_SUBTRACT = 4,   // Path: × (1 − the clip path's coverage) (OUTSIDE strokes)
  DF_CLIP_EVEN_ODD = 8,   // the clip path's rule
  DF_STROKE = 16,         // Shape: the stroke band [−inner, outer] (else the fill)
  DF_FILL_AND_STROKE = 32,  // Shape: solid fill (color) and solid stroke (paint0) in one (overlays)
  // bits 8–11: the paint type (PaintKind)
};

enum class PaintKind : uint32_t {
  Solid = 0,
  Linear = 1,
  Radial = 2,
  Angular = 3,
  Diamond = 4,
  Image = 5,
  Backdrop = 6,     // the blurred backdrop (background blur), by gl_FragCoord
  Progressive = 7,  // a progressive background blur: the backdrop between two blur levels (u_t3 → u_t2)
  Glass = 8,        // glass: the frosted backdrop refracted at the shape's edge, lit
  Noise = 9,        // a NOISE paint: paint0 / paint1 rows map local → noise cells; .w = density, type
};

inline float drawFlags(uint32_t flags, PaintKind paint) { return static_cast<float>(flags | (static_cast<uint32_t>(paint) << 8)); }

}  // namespace eng
