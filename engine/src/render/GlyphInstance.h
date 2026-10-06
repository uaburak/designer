// The instance layout of the Glyph shader (gfx::ShaderId::Glyph): one glyph,
// its em square placed in draw space (CSS px), its curves in the glyph cache's
// texture, its colour.
#pragma once

namespace eng {

struct GlyphInstance {
  float linear[4];  // em → draw space, columns: (m00, m10), (m01, m11)
  float origin[4];  // the em origin (the glyph's point on the baseline) in draw space; first curve texel; curve count
  float bounds[4];  // the outline's bounds in em (x0, y0, x1, y1; y down)
  float color[4];   // premultiplied rgba
};
static_assert(sizeof(GlyphInstance) == 64, "GlyphInstance is 4 vec4s");

}  // namespace eng
