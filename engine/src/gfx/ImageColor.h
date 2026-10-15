// Image colour at upload (docs/engine.md §6.6; docs/research/rea/canvas.md §2.6). Figma's image worker decodes with
// `premultiplyAlpha: "none"` and no colour management, and tags each image with its profile (SRGB 0 / DISPLAY_P3 1,
// read from the PNG iCCP / JPEG APP2 / WebP ICCP profile; anything else counts as sRGB). The pixels reach the GPU
// straight and in their own space; the renderer premultiplies them and converts them into the document's space
// (the canvas's). Here that happens once, at upload: the bitmap goes to a scratch texture as it is, and a pass draws
// it into the image's texture premultiplied and, when the spaces differ, converted (linear light, sRGB ↔ Display P3:
// both use the sRGB transfer curve and D65). The CPU twin below (prepPixel) is what the shaders compute.
#pragma once

#include <array>
#include <cmath>
#include <cstdint>

namespace eng::gfx {

enum class ColorProfile : uint8_t { SRGB = 0, DISPLAY_P3 = 1 };

// engine_image_add_bitmap's flags.
enum : uint32_t { IMAGE_STRAIGHT = 1, IMAGE_DISPLAY_P3 = 2 };

// How a bitmap's pixels are: premultiplied and already in the canvas's space (the browser decoded and converted them:
// the default), or straight and in `profile`.
struct BitmapColor {
  bool straight = false;
  ColorProfile profile = ColorProfile::SRGB;
};

inline BitmapColor bitmapColorOf(uint32_t flags) {
  BitmapColor c;
  c.straight = (flags & IMAGE_STRAIGHT) != 0;
  c.profile = (flags & IMAGE_DISPLAY_P3) ? ColorProfile::DISPLAY_P3 : ColorProfile::SRGB;
  return c;
}

using Mat3 = std::array<float, 9>;  // row-major: out[i] = Σ m[3i + j] · in[j]

// Linear-light RGB from `from` to `to` (CSS Color 4's matrices through XYZ D65); identity when they are the same.
inline const Mat3& conversionMatrix(ColorProfile from, ColorProfile to) {
  static const Mat3 identity{1, 0, 0, 0, 1, 0, 0, 0, 1};
  static const Mat3 srgbToP3{0.8224621f, 0.1775380f, 0.0f,  //
                             0.0331941f, 0.9668058f, 0.0f,  //
                             0.0170827f, 0.0723974f, 0.9105199f};
  static const Mat3 p3ToSrgb{1.2249401f, -0.2249404f, 0.0f,  //
                             -0.0420569f, 1.0420571f, 0.0f,  //
                             -0.0196376f, -0.0786361f, 1.0982735f};
  if (from == to) return identity;
  return from == ColorProfile::SRGB ? srgbToP3 : p3ToSrgb;
}

inline float srgbToLinear(float c) { return c <= 0.04045f ? c / 12.92f : std::pow((c + 0.055f) / 1.055f, 2.4f); }
inline float linearToSrgb(float c) { return c <= 0.0031308f ? c * 12.92f : 1.055f * std::pow(c, 1.0f / 2.4f) - 0.055f; }

// One straight RGBA8 pixel in `from` → premultiplied RGBA8 in `to`, as the upload pass draws it (rounded to nearest,
// as a unorm target stores a float).
inline std::array<uint8_t, 4> prepPixel(const std::array<uint8_t, 4>& in, ColorProfile from, ColorProfile to) {
  float c[3] = {in[0] / 255.0f, in[1] / 255.0f, in[2] / 255.0f};
  float a = in[3] / 255.0f;
  if (from != to) {
    const Mat3& m = conversionMatrix(from, to);
    float l[3] = {srgbToLinear(c[0]), srgbToLinear(c[1]), srgbToLinear(c[2])};
    for (int i = 0; i < 3; i++) {
      float v = m[3 * i] * l[0] + m[3 * i + 1] * l[1] + m[3 * i + 2] * l[2];
      c[i] = linearToSrgb(std::fmin(std::fmax(v, 0.0f), 1.0f));
    }
  }
  auto unorm = [](float v) { return static_cast<uint8_t>(std::lround(std::fmin(std::fmax(v, 0.0f), 1.0f) * 255.0f)); };
  return {unorm(c[0] * a), unorm(c[1] * a), unorm(c[2] * a), in[3]};
}

// The pass's uniforms (four vec4s): three rows of the matrix (xyz) and, in the fourth's x, 1 when it converts.
inline void prepUniforms(ColorProfile from, ColorProfile to, float (*out)[4]) {
  const Mat3& m = conversionMatrix(from, to);
  for (int i = 0; i < 3; i++) {
    out[i][0] = m[3 * i];
    out[i][1] = m[3 * i + 1];
    out[i][2] = m[3 * i + 2];
    out[i][3] = 0;
  }
  out[3][0] = from != to ? 1.0f : 0.0f;
  out[3][1] = out[3][2] = out[3][3] = 0;
}

// The pass's shaders (GLSL ES 3.00 for WebGL2, WGSL for WebGPU): the same steps as prepPixel. `u_rows[0..2]` /
// `u.v[0..2]` are the matrix's rows, `[3].x` 1 when it converts. The source is read texel for texel (rows as stored).
inline constexpr const char* kPrepVertexGlsl = R"(#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
)";

inline constexpr const char* kPrepFragmentGlsl = R"(#version 300 es
precision highp float;
uniform sampler2D u_src;
uniform vec4 u_rows[4];
out vec4 o_color;
vec3 toLinear(vec3 c) {
  vec3 lo = c / 12.92, hi = pow((max(c, vec3(0.0)) + 0.055) / 1.055, vec3(2.4));
  return vec3(c.r <= 0.04045 ? lo.r : hi.r, c.g <= 0.04045 ? lo.g : hi.g, c.b <= 0.04045 ? lo.b : hi.b);
}
vec3 toEncoded(vec3 c) {
  vec3 lo = c * 12.92, hi = 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055;
  return vec3(c.r <= 0.0031308 ? lo.r : hi.r, c.g <= 0.0031308 ? lo.g : hi.g, c.b <= 0.0031308 ? lo.b : hi.b);
}
void main() {
  vec4 s = texelFetch(u_src, ivec2(gl_FragCoord.xy), 0);
  vec3 c = s.rgb;
  if (u_rows[3].x > 0.5) {
    vec3 l = toLinear(c);
    vec3 t = vec3(dot(u_rows[0].xyz, l), dot(u_rows[1].xyz, l), dot(u_rows[2].xyz, l));
    c = clamp(toEncoded(clamp(t, 0.0, 1.0)), 0.0, 1.0);
  }
  o_color = vec4(c * s.a, s.a);
}
)";

// WGSL: appended to the device's common prelude (wgpu/Shaders.h kCommon: `u`, quadCorner) with group 1 = the
// utility layout (src, srcSampler).
inline constexpr const char* kPrepWgsl = R"(
@group(1) @binding(0) var src: texture_2d<f32>;
@group(1) @binding(1) var srcSampler: sampler;

@vertex fn vs(@builtin(vertex_index) id: u32) -> @builtin(position) vec4f {
  let corner = quadCorner(id);
  return vec4f(corner * 2.0 - 1.0, 0.0, 1.0);
}

fn toLinear(c: vec3f) -> vec3f {
  let hi = pow((max(c, vec3f(0.0)) + 0.055) / 1.055, vec3f(2.4));
  return select(hi, c / 12.92, c <= vec3f(0.04045));
}
fn toEncoded(c: vec3f) -> vec3f {
  let hi = 1.055 * pow(max(c, vec3f(0.0)), vec3f(1.0 / 2.4)) - 0.055;
  return select(hi, c * 12.92, c <= vec3f(0.0031308));
}

@fragment fn prep(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let s = textureLoad(src, vec2i(floor(pos.xy)), 0);
  var c = s.rgb;
  if (u.v[3].x > 0.5) {
    let l = toLinear(c);
    let t = vec3f(dot(u.v[0].xyz, l), dot(u.v[1].xyz, l), dot(u.v[2].xyz, l));
    c = clamp(toEncoded(clamp(t, vec3f(0.0), vec3f(1.0))), vec3f(0.0), vec3f(1.0));
  }
  return vec4f(c * s.a, s.a);
}
)";

}  // namespace eng::gfx
