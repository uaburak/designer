// The built-in shaders, GLSL ES 3.00 (WebGL2). Interim: written by hand until
// tools/shadergen exists (docs/engine.md §6.10).
#pragma once

namespace eng::gfx::gl {

// ShaderId::Shape — one instanced quad per shape (6 vertices from gl_VertexID),
// expanded around the shape's box; the fragment shader computes the signed
// distance to a rect / rounded rect (per-corner radii) / ellipse in the
// shape's own space and turns it into coverage with the distance's
// screen-space derivative (analytic anti-aliasing, no MSAA). Fill and stroke
// (inside / centre / outside) in one pass; premultiplied alpha. With
// u_stencilPass = 1 it only discards outside the fill (clip masks).
// Instance layout: render/ShapeInstance.h.
inline constexpr const char* kVertexShader = R"(#version 300 es
layout(location = 0) in vec4 a_linear;
layout(location = 1) in vec4 a_origin;
layout(location = 2) in vec4 a_radii;
layout(location = 3) in vec4 a_fill;
layout(location = 4) in vec4 a_stroke;
layout(location = 5) in vec4 a_params;
uniform vec3 u_row0;
uniform vec3 u_row1;
out vec2 v_local;
flat out vec2 v_size;
flat out vec4 v_radii;
flat out vec4 v_fill;
flat out vec4 v_stroke;
flat out vec4 v_params;
void main() {
  int id = gl_VertexID;
  vec2 corner = vec2((id == 1 || id == 2 || id == 4) ? 1.0 : 0.0, (id == 2 || id == 4 || id == 5) ? 1.0 : 0.0);
  vec2 size = a_origin.zw;
  float sx = max(length(a_linear.xy), 1e-6);
  float sy = max(length(a_linear.zw), 1e-6);
  vec2 pad = vec2(a_params.y) + vec2(2.0 / sx, 2.0 / sy);
  vec2 local = mix(-pad, size + pad, corner);
  vec2 p = mat2(a_linear.xy, a_linear.zw) * local + a_origin.xy;
  gl_Position = vec4(dot(u_row0, vec3(p, 1.0)), dot(u_row1, vec3(p, 1.0)), 0.0, 1.0);
  v_local = local;
  v_size = size;
  v_radii = a_radii;
  v_fill = a_fill;
  v_stroke = a_stroke;
  v_params = a_params;
}
)";

inline constexpr const char* kFragmentShader = R"(#version 300 es
precision highp float;
in vec2 v_local;
flat in vec2 v_size;
flat in vec4 v_radii;
flat in vec4 v_fill;
flat in vec4 v_stroke;
flat in vec4 v_params;
uniform int u_stencilPass;
out vec4 o_color;

float sdRoundedBox(vec2 p, vec2 b, vec4 r) {
  float rr = p.x > 0.0 ? (p.y > 0.0 ? r.z : r.y) : (p.y > 0.0 ? r.w : r.x);
  rr = clamp(rr, 0.0, min(b.x, b.y));
  vec2 q = abs(p) - b + rr;
  return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - rr;
}

float sdEllipse(vec2 p, vec2 r) {
  r = max(r, vec2(1e-6));
  float k0 = length(p / r);
  float k1 = length(p / (r * r));
  return k1 > 0.0 ? k0 * (k0 - 1.0) / k1 : -min(r.x, r.y);
}

void main() {
  vec2 halfSize = v_size * 0.5;
  vec2 p = v_local - halfSize;
  float d = v_params.z > 0.5 ? sdEllipse(p, halfSize) : sdRoundedBox(p, halfSize, v_radii);
  // One device pixel in the shape's units.
  float px = max(0.5 * (length(dFdx(v_local)) + length(dFdy(v_local))), 1e-6);
  float fillCoverage = clamp(0.5 - d / px, 0.0, 1.0);
  if (u_stencilPass == 1) {
    if (fillCoverage < 0.5) discard;
    o_color = vec4(0.0);
    return;
  }
  float inner = v_params.x;
  float outer = v_params.y;
  float strokeCoverage = 0.0;
  if (inner + outer > 0.0)
    strokeCoverage = clamp(clamp(0.5 - (d - outer) / px, 0.0, 1.0) - clamp(0.5 - (d + inner) / px, 0.0, 1.0), 0.0, 1.0);
  vec4 c = v_fill * fillCoverage;
  vec4 s = v_stroke * strokeCoverage;
  c = s + c * (1.0 - s.a);
  if (c.a <= 0.0) discard;
  o_color = c;
}
)";

// ShaderId::Glyph — one instanced quad per glyph over its outline's bounds
// (grown by a pixel); the fragment shader computes coverage from the glyph's
// quadratic curves (u_curves, two RGBA32F texels per curve) with a ray along
// +x and one along +y — render/GlyphCoverage.h is the same code in C++ and
// says how it works. Instance layout: render/GlyphInstance.h.
inline constexpr const char* kGlyphVertexShader = R"(#version 300 es
layout(location = 0) in vec4 a_linear;
layout(location = 1) in vec4 a_origin;
layout(location = 2) in vec4 a_bounds;
layout(location = 3) in vec4 a_color;
uniform vec3 u_row0;
uniform vec3 u_row1;
out vec2 v_em;
flat out vec2 v_curves;
flat out vec4 v_color;
void main() {
  int id = gl_VertexID;
  vec2 corner = vec2((id == 1 || id == 2 || id == 4) ? 1.0 : 0.0, (id == 2 || id == 4 || id == 5) ? 1.0 : 0.0);
  vec2 pad = vec2(1.5 / max(length(a_linear.xy), 1e-6), 1.5 / max(length(a_linear.zw), 1e-6));
  vec2 em = mix(a_bounds.xy - pad, a_bounds.zw + pad, corner);
  vec2 p = mat2(a_linear.xy, a_linear.zw) * em + a_origin.xy;
  gl_Position = vec4(dot(u_row0, vec3(p, 1.0)), dot(u_row1, vec3(p, 1.0)), 0.0, 1.0);
  v_em = em;
  v_curves = a_origin.zw;
  v_color = a_color;
}
)";

inline constexpr const char* kGlyphFragmentShader = R"(#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
in vec2 v_em;
flat in vec2 v_curves;
flat in vec4 v_color;
uniform sampler2D u_curves;
uniform int u_stencilPass;
out vec4 o_color;

vec4 texel(int i) { return texelFetch(u_curves, ivec2(i & 2047, i >> 11), 0); }

// Crossings of the ray from the sample along +x with a curve (points relative to the sample).
void crossX(vec2 p0, vec2 p1, vec2 p2, float ppe, inout float cov, inout float wgt) {
  uint code = (0x2E74u >> (((p0.y > 0.0) ? 2u : 0u) + ((p1.y > 0.0) ? 4u : 0u) + ((p2.y > 0.0) ? 8u : 0u))) & 3u;
  if (code == 0u) return;
  float ay = p0.y - 2.0 * p1.y + p2.y, by = p0.y - p1.y;
  float ax = p0.x - 2.0 * p1.x + p2.x, bx = p0.x - p1.x;
  float t1, t2;
  if (abs(ay) < 1e-5) {
    t1 = p0.y / (2.0 * by);
    t2 = t1;
  } else {
    float d = sqrt(max(by * by - ay * p0.y, 0.0));
    t1 = (by - d) / ay;
    t2 = (by + d) / ay;
  }
  float x1 = (ax * t1 - 2.0 * bx) * t1 + p0.x;
  float x2 = (ax * t2 - 2.0 * bx) * t2 + p0.x;
  if ((code & 1u) != 0u) {
    cov += clamp(x1 * ppe + 0.5, 0.0, 1.0);
    wgt = max(wgt, clamp(1.0 - abs(x1 * ppe) * 2.0, 0.0, 1.0));
  }
  if (code > 1u) {
    cov -= clamp(x2 * ppe + 0.5, 0.0, 1.0);
    wgt = max(wgt, clamp(1.0 - abs(x2 * ppe) * 2.0, 0.0, 1.0));
  }
}

void main() {
  vec2 dx = dFdx(v_em), dy = dFdy(v_em);
  vec2 ppe = 1.0 / max(vec2(length(vec2(dx.x, dy.x)), length(vec2(dx.y, dy.y))), vec2(1e-7));
  float hc = 0.0, hw = 0.0, vc = 0.0, vw = 0.0;
  int start = int(v_curves.x), count = int(v_curves.y);
  for (int k = 0; k < count; k++) {
    vec4 a = texel(start + 2 * k);
    vec4 b = texel(start + 2 * k + 1);
    vec2 p0 = a.xy - v_em, p1 = a.zw - v_em, p2 = b.xy - v_em;
    crossX(p0, p1, p2, ppe.x, hc, hw);
    crossX(p0.yx, p1.yx, p2.yx, ppe.y, vc, vw);
  }
  float ch = min(abs(hc), 1.0), cv = min(abs(vc), 1.0);
  float coverage = clamp(max((ch * hw + cv * vw) / max(hw + vw, 1.0 / 65536.0), min(ch, cv)), 0.0, 1.0);
  if (u_stencilPass == 1) {
    if (coverage < 0.5) discard;
    o_color = vec4(0.0);
    return;
  }
  if (coverage <= 0.0) discard;
  o_color = v_color * coverage;
}
)";

}  // namespace eng::gfx::gl
