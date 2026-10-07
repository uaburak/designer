// The built-in shaders, GLSL ES 3.00 (WebGL2). Interim: written by hand until
// tools/shadergen exists (docs/engine.md §6.10).
//
// Every shader takes `uniform vec4 u_v[12]` (gfx::DrawCall::uniforms): slots 0
// and 1 are the rows mapping draw space to clip space; the rest are per shader,
// listed with it. Textures are u_t0, u_t1, u_t2 (DrawCall::textures).
#pragma once

namespace eng::gfx::gl {

// ---- Shape and Path: the paint, shared ----------------------------------------
//
// Slots: 2 = image adjustments (exposure, contrast, saturation, temperature), 3 = (tint, highlights,
// shadows, 0), 4 = the backdrop texture's place (x, y in window px, width, height in texels).
// u_t1: gradient ramps (256 texels per row, premultiplied), u_t2: the image (premultiplied) or the
// blurred backdrop.
inline constexpr const char* kPaintFunctions = R"(
uniform sampler2D u_t1;
uniform sampler2D u_t2;

vec4 rampAt(float t, float row) {
  vec2 sz = vec2(textureSize(u_t1, 0));
  return texture(u_t1, vec2((clamp(t, 0.0, 1.0) * 255.0 + 0.5) / sz.x, (row + 0.5) / sz.y));
}

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

// Figma's image adjustments, each -1..1 (unverified against Figma's own curves).
vec3 adjust(vec3 c) {
  vec4 a = u_v[2], b = u_v[3];
  c *= exp2(a.x * 2.0);                                   // exposure: ±2 stops
  c = (c - 0.5) * (1.0 + a.y) + 0.5;                      // contrast
  float l = luma(c);
  c = mix(vec3(l), c, 1.0 + a.z);                         // saturation
  c += vec3(a.w, 0.0, -a.w) * 0.1;                        // temperature: warm / cool
  c += vec3(b.x * 0.05, -b.x * 0.1, b.x * 0.05);          // tint: magenta / green
  float l2 = luma(c);
  c += b.y * 0.25 * smoothstep(0.5, 1.0, l2);             // highlights
  c += b.z * 0.25 * (1.0 - smoothstep(0.0, 0.5, l2));     // shadows
  return clamp(c, 0.0, 1.0);
}

vec4 paintAt(vec2 local, int kind) {
  if (kind == 0) return v_color;
  if (kind == 6) {
    vec2 uv = (gl_FragCoord.xy - u_v[4].xy) / u_v[4].zw;
    return texture(u_t2, uv) * v_color.a;
  }
  vec2 g = vec2(dot(v_paint0.xy, local) + v_paint0.z, dot(v_paint1.xy, local) + v_paint1.z);
  vec4 c;
  if (kind == 5) {
    bool repeat = v_paint0.w > 0.5;
    if (!repeat && (g.x < 0.0 || g.y < 0.0 || g.x > 1.0 || g.y > 1.0)) return vec4(0.0);
    c = textureGrad(u_t2, repeat ? fract(g) : g, dFdx(g), dFdy(g));
    if (any(notEqual(u_v[2], vec4(0.0))) || any(notEqual(u_v[3], vec4(0.0)))) {
      vec3 rgb = c.a > 0.0 ? c.rgb / c.a : vec3(0.0);
      c = vec4(adjust(rgb) * c.a, c.a);
    }
  } else {
    float t;
    if (kind == 1) t = g.x;
    else if (kind == 2) t = length(g - 0.5) * 2.0;
    else if (kind == 3) t = fract(atan(g.y - 0.5, g.x - 0.5) / 6.28318530718 + 1.0);
    else t = (abs(g.x - 0.5) + abs(g.y - 0.5)) * 2.0;
    c = rampAt(t, v_paint1.w);
    // Ordered dither against banding.
    float n = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    c.rgb = clamp(c.rgb + (n - 0.5) / 255.0 * c.a, 0.0, c.a);
  }
  return c * v_color.a;
}
)";

// ---- Draw: shapes, paths and glyphs in one program ------------------------------
// One instanced quad per shape, path or glyph (6 vertices from gl_VertexID; render/DrawInstance.h), so a run of
// them batches into one draw whatever they are (an uber shader branching per instance, docs/engine.md §6.10):
// - Rect / Ellipse / DropShadow / InnerShadow (kind 0–3): the quad around the box; the fragment computes the
//   signed distance in the shape's own space and turns it into coverage with its screen-space derivative
//   (analytic anti-aliasing, no MSAA); shadows are Evan Wallace's blurred rounded rectangle.
// - Path (kind 4): the quad over the curves' bounds; coverage from quadratic curves. Each path's curves live in
//   u_t0 (RGBA32F, 2048 texels per row) after a header: texel 0 = (horizontal bands, vertical bands, curves, 0),
//   texel 1 = the bounds (x0, y0, x1, y1), then one texel per band (first index texel, count), then the bands'
//   curve indices (4 per texel), then the curves (2 texels each: p0 p1, p2 + the curve's max x and max y). Per
//   pixel a ray along +x crosses the curves of its horizontal band and one along +y those of its vertical band
//   (Lengyel, JCGT 2017); each crossing adds or removes coverage by how far into the pixel it lies, the two rays
//   blended by proximity. Bands' curves are sorted by max x / max y, so a ray stops at the first curve wholly
//   behind it. render/CurveCoverage.h is the same code in C++ for the native tests. Flags: the ODD rule, × a
//   clip path's coverage (intersect / subtract).
// - Every instance carries a clip rectangle in canvas device px (a frame's axis-aligned clip: what a scissor
//   did, without breaking the batch). Slot 5 = (the pass's origin x, y in canvas device px, its height).
// u_stencilPass = 1: only discards outside the fill (clip masks).
inline constexpr const char* kDrawVertex = R"(#version 300 es
layout(location = 0) in vec4 a_linear;
layout(location = 1) in vec4 a_origin;
layout(location = 2) in vec4 a_box;
layout(location = 3) in vec4 a_geom;
layout(location = 4) in vec4 a_color;
layout(location = 5) in vec4 a_paint0;
layout(location = 6) in vec4 a_paint1;
layout(location = 7) in vec4 a_clip;
layout(location = 8) in vec4 a_round;
layout(location = 9) in vec4 a_radii;
uniform vec4 u_v[12];
out vec2 v_local;
flat out vec4 v_origin;
flat out vec4 v_box;
flat out vec4 v_geom;
flat out vec4 v_color;
flat out vec4 v_paint0;
flat out vec4 v_paint1;
flat out vec4 v_clip;
flat out vec4 v_round;
flat out vec4 v_radii;
void main() {
  int id = gl_VertexID;
  vec2 corner = vec2((id == 1 || id == 2 || id == 4) ? 1.0 : 0.0, (id == 2 || id == 4 || id == 5) ? 1.0 : 0.0);
  float sx = max(length(a_linear.xy), 1e-6);
  float sy = max(length(a_linear.zw), 1e-6);
  int kind = int(a_geom.z + 0.5);
  vec2 local;
  if (kind == 4) {
    vec2 pad = vec2(1.5 / sx, 1.5 / sy);
    local = mix(a_box.xy - pad, a_box.zw + pad, corner);
  } else {
    vec2 size = a_origin.zw;
    float grow = kind == 2 ? 3.0 * a_geom.x : (kind == 3 ? 0.0 : a_geom.y);
    vec2 pad = vec2(grow) + vec2(2.0 / sx, 2.0 / sy);
    local = mix(-pad, size + pad, corner);
  }
  vec2 p = mat2(a_linear.xy, a_linear.zw) * local + a_origin.xy;
  gl_Position = vec4(dot(u_v[0].xyz, vec3(p, 1.0)), dot(u_v[1].xyz, vec3(p, 1.0)), 0.0, 1.0);
  v_local = local;
  v_origin = a_origin;
  v_box = a_box;
  v_geom = a_geom;
  v_color = a_color;
  v_paint0 = a_paint0;
  v_paint1 = a_paint1;
  v_clip = a_clip;
  v_round = a_round;
  v_radii = a_radii;
}
)";

inline constexpr const char* kDrawFragmentHead = R"(#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
in vec2 v_local;
flat in vec4 v_origin;
flat in vec4 v_box;
flat in vec4 v_geom;
flat in vec4 v_color;
flat in vec4 v_paint0;
flat in vec4 v_paint1;
flat in vec4 v_clip;
flat in vec4 v_round;
flat in vec4 v_radii;
uniform vec4 u_v[12];
uniform int u_stencilPass;
uniform sampler2D u_t0;
out vec4 o_color;
)";

inline constexpr const char* kDrawFragmentBody = R"(
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

// Evan Wallace's blurred rounded rectangle (closed-form along x, 4 samples along y).
float gaussian(float x, float sigma) { return exp(-(x * x) / (2.0 * sigma * sigma)) / (2.50662827463 * sigma); }
vec2 erf2(vec2 x) {
  vec2 s = sign(x), a = abs(x);
  x = 1.0 + (0.278393 + (0.230389 + 0.078108 * (a * a)) * a) * a;
  x *= x;
  return s - s / (x * x);
}
float shadowX(float x, float y, float sigma, float corner, vec2 halfSize) {
  float delta = min(halfSize.y - corner - abs(y), 0.0);
  float curved = halfSize.x - corner + sqrt(max(0.0, corner * corner - delta * delta));
  vec2 integral = 0.5 + 0.5 * erf2((x + vec2(-curved, curved)) * (0.70710678 / sigma));
  return integral.y - integral.x;
}
// The shadow of the box [lo, hi] with corner radii r (tl tr br bl) at p, blurred by sigma; px = a pixel.
float boxShadow(vec2 lo, vec2 hi, vec4 r, vec2 p, float sigma, float px) {
  vec2 c = (lo + hi) * 0.5, h = max((hi - lo) * 0.5, vec2(0.0));
  vec2 q = p - c;
  float corner = q.x > 0.0 ? (q.y > 0.0 ? r.z : r.y) : (q.y > 0.0 ? r.w : r.x);
  corner = clamp(corner, 0.0, min(h.x, h.y));
  if (sigma < 0.05 * px) return clamp(0.5 - sdRoundedBox(q, h, vec4(corner)) / px, 0.0, 1.0);
  float low = q.y - h.y, high = q.y + h.y;
  float start = clamp(-3.0 * sigma, low, high), end = clamp(3.0 * sigma, low, high);
  float step = (end - start) / 4.0;
  float y = start + step * 0.5, value = 0.0;
  for (int i = 0; i < 4; i++) {
    value += shadowX(q.x, q.y - y, sigma, corner, h) * gaussian(y, sigma) * step;
    y += step;
  }
  return value;
}

void shapeMain() {
  vec2 v_size = v_origin.zw;
  vec2 halfSize = v_size * 0.5;
  vec2 p = v_local - halfSize;
  int kind = int(v_geom.z + 0.5);
  int flags = int(v_geom.w + 0.5);
  float px = max(0.5 * (length(dFdx(v_local)) + length(dFdy(v_local))), 1e-6);
  if (kind == 2) {
    float a = boxShadow(vec2(0.0), v_size, v_box, v_local, v_geom.x, px);
    if (a <= 0.0) discard;
    o_color = v_color * a;
    return;
  }
  float d = kind == 1 ? sdEllipse(p, halfSize) : sdRoundedBox(p, halfSize, v_box);
  float fillCoverage = clamp(0.5 - d / px, 0.0, 1.0);
  if (u_stencilPass == 1) {
    if (fillCoverage < 0.5) discard;
    o_color = vec4(0.0);
    return;
  }
  if (kind == 3) {
    float spread = v_geom.y;
    vec2 off = v_paint0.xy;
    vec4 r = max(v_box - spread, vec4(0.0));
    float s = boxShadow(vec2(spread), v_size - spread, r, v_local - off, v_geom.x, px);
    vec4 c = v_color * (fillCoverage * (1.0 - s));
    if (c.a <= 0.0) discard;
    o_color = c;
    return;
  }
  float inner = v_geom.x, outer = v_geom.y;
  float strokeCoverage = 0.0;
  if (inner + outer > 0.0)
    strokeCoverage = clamp(clamp(0.5 - (d - outer) / px, 0.0, 1.0) - clamp(0.5 - (d + inner) / px, 0.0, 1.0), 0.0, 1.0);
  vec4 c;
  if ((flags & 32) != 0) {
    vec4 f = v_color * fillCoverage;
    vec4 s = v_paint0 * strokeCoverage;
    c = s + f * (1.0 - s.a);
  } else {
    float cov = (flags & 16) != 0 ? strokeCoverage : fillCoverage;
    if (cov <= 0.0) discard;
    c = paintAt(v_local, (flags >> 8) & 15) * cov;
  }
  if (c.a <= 0.0) discard;
  o_color = c;
}

vec4 texel(int i) { return texelFetch(u_t0, ivec2(i & 2047, i >> 11), 0); }

void crossX(vec2 p0, vec2 p1, vec2 p2, float ppe, inout float cov, inout float wgt) {
  uint code = (0x2E74u >> (((p0.y > 0.0) ? 2u : 0u) + ((p1.y > 0.0) ? 4u : 0u) + ((p2.y > 0.0) ? 8u : 0u))) & 3u;
  if (code == 0u) return;
  float ay = p0.y - 2.0 * p1.y + p2.y, by = p0.y - p1.y;
  float ax = p0.x - 2.0 * p1.x + p2.x, bx = p0.x - p1.x;
  float t1, t2;
  if (abs(ay) < 1e-5 * max(abs(by), 1e-30) || abs(ay) < 1e-12) {
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

float fold(float w, bool evenOdd) { return evenOdd ? 1.0 - abs(mod(w, 2.0) - 1.0) : min(abs(w), 1.0); }

float coverage(int start, vec2 p, vec2 ppe, bool evenOdd) {
  vec4 h = texel(start);
  vec4 b = texel(start + 1);
  int nH = int(h.x), nV = int(h.y);
  vec2 size = max(b.zw - b.xy, vec2(1e-20));
  int bh = clamp(int(floor((p.y - b.y) / size.y * float(nH))), 0, nH - 1);
  int bv = clamp(int(floor((p.x - b.x) / size.x * float(nV))), 0, nV - 1);
  vec4 dh = texel(start + 2 + bh);
  vec4 dv = texel(start + 2 + nH + bv);
  float hc = 0.0, hw = 0.0, vc = 0.0, vw = 0.0;
  int first = int(dh.x), count = int(dh.y);
  for (int k = 0; k < count; k++) {
    int ci = int(texel(first + (k >> 2))[k & 3]);
    vec4 a = texel(ci), c = texel(ci + 1);
    if ((c.z - p.x) * ppe.x < -0.5) break;
    crossX(a.xy - p, a.zw - p, c.xy - p, ppe.x, hc, hw);
  }
  first = int(dv.x);
  count = int(dv.y);
  for (int k = 0; k < count; k++) {
    int ci = int(texel(first + (k >> 2))[k & 3]);
    vec4 a = texel(ci), c = texel(ci + 1);
    if ((c.w - p.y) * ppe.y < -0.5) break;
    crossX((a.xy - p).yx, (a.zw - p).yx, (c.xy - p).yx, ppe.y, vc, vw);
  }
  float ch = fold(hc, evenOdd), cv = fold(vc, evenOdd);
  return clamp(max((ch * hw + cv * vw) / max(hw + vw, 1.0 / 65536.0), min(ch, cv)), 0.0, 1.0);
}

void pathMain() {
  vec2 dx = dFdx(v_local), dy = dFdy(v_local);
  vec2 ppe = 1.0 / max(vec2(length(vec2(dx.x, dy.x)), length(vec2(dx.y, dy.y))), vec2(1e-12));
  int flags = int(v_geom.w + 0.5);
  float cov = coverage(int(v_origin.z), v_local, ppe, (flags & 1) != 0);
  if ((flags & 6) != 0 && v_origin.w >= 0.0) {
    float clip = coverage(int(v_origin.w), v_local, ppe, (flags & 8) != 0);
    cov *= (flags & 2) != 0 ? clip : 1.0 - clip;
  }
  if (u_stencilPass == 1) {
    if (cov < 0.5) discard;
    o_color = vec4(0.0);
    return;
  }
  if (cov <= 0.0) discard;
  vec4 c = paintAt(v_local, (flags >> 8) & 15) * cov;
  if (c.a <= 0.0) discard;
  o_color = c;
}

// An axis-aligned rounded clip's coverage at canvas device px `dp` (1 when there is none).
float roundClip(vec2 dp) {
  if (v_round.z <= v_round.x) return 1.0;
  vec2 half_ = (v_round.zw - v_round.xy) * 0.5;
  return clamp(0.5 - sdRoundedBox(dp - (v_round.xy + half_), half_, v_radii), 0.0, 1.0);
}

void main() {
  vec2 dp = vec2(gl_FragCoord.x, u_v[5].z - gl_FragCoord.y) + u_v[5].xy;
  if (dp.x < v_clip.x || dp.y < v_clip.y || dp.x >= v_clip.z || dp.y >= v_clip.w) discard;
  float clipCoverage = roundClip(dp);
  if (clipCoverage <= 0.0 || (u_stencilPass == 1 && clipCoverage < 0.5)) discard;
  if (int(v_geom.z + 0.5) == 4) pathMain();
  else shapeMain();
  o_color *= clipCoverage;
}
)";

// ---- Composite: a layer onto its parent ----------------------------------------
// One quad. Slots: 2 = the quad (x0, y0, x1, y1, device px); 3 / 4 / 5 = where u_t0 (source) / u_t1 (mask or
// node alpha) / u_t2 (backdrop) lie: (origin x, y in device px, content height in texels, texels per device px);
// 6 = colour (shadows, premultiplied); 7 = (opacity, blend mode, mode, knockout); 8 = the source's offset in
// device px (shadows). Modes: 0 source, 1 × the mask's alpha, 2 × the mask's luminance, 3 drop shadow (colour ×
// the blurred alpha behind, knocked out by the node's alpha), 4 inner shadow (colour × the node's alpha × (1 −
// the blurred alpha)). Blend modes other than NORMAL read the backdrop and write the result (Blend::Replace).
inline constexpr const char* kCompositeVertex = R"(#version 300 es
uniform vec4 u_v[12];
out vec2 v_dev;
void main() {
  int id = gl_VertexID;
  vec2 corner = vec2((id == 1 || id == 2 || id == 4) ? 1.0 : 0.0, (id == 2 || id == 4 || id == 5) ? 1.0 : 0.0);
  vec2 p = mix(u_v[2].xy, u_v[2].zw, corner);
  gl_Position = vec4(dot(u_v[0].xyz, vec3(p, 1.0)), dot(u_v[1].xyz, vec3(p, 1.0)), 0.0, 1.0);
  v_dev = p;
}
)";

inline constexpr const char* kCompositeFragment = R"(#version 300 es
precision highp float;
in vec2 v_dev;
uniform vec4 u_v[12];
uniform sampler2D u_t0;
uniform sampler2D u_t1;
uniform sampler2D u_t2;
out vec4 o_color;

vec4 at(sampler2D t, vec4 map, vec2 d) {
  vec2 sz = vec2(textureSize(t, 0));
  vec2 q = (d - map.xy) * map.w;
  if (q.x < 0.0 || q.y < 0.0 || q.y > map.z) return vec4(0.0);
  return texture(t, vec2(q.x / sz.x, (map.z - q.y) / sz.y));
}

float lum(vec3 c) { return dot(c, vec3(0.3, 0.59, 0.11)); }
vec3 clipColor(vec3 c) {
  float l = lum(c), n = min(min(c.r, c.g), c.b), x = max(max(c.r, c.g), c.b);
  if (n < 0.0) c = l + (c - l) * l / max(l - n, 1e-6);
  if (x > 1.0) c = l + (c - l) * (1.0 - l) / max(x - l, 1e-6);
  return c;
}
vec3 setLum(vec3 c, float l) { return clipColor(c + (l - lum(c))); }
float sat(vec3 c) { return max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b); }
vec3 setSat(vec3 c, float s) {
  float mx = max(max(c.r, c.g), c.b), mn = min(min(c.r, c.g), c.b);
  return mx > mn ? (c - mn) * s / (mx - mn) : vec3(0.0);
}
float softLight(float b, float s) {
  if (s <= 0.5) return b - (1.0 - 2.0 * s) * b * (1.0 - b);
  float d = b <= 0.25 ? ((16.0 * b - 12.0) * b + 4.0) * b : sqrt(b);
  return b + (2.0 * s - 1.0) * (d - b);
}
float colorDodge(float b, float s) { return b == 0.0 ? 0.0 : (s >= 1.0 ? 1.0 : min(1.0, b / (1.0 - s))); }
float colorBurn(float b, float s) { return b >= 1.0 ? 1.0 : (s <= 0.0 ? 0.0 : 1.0 - min(1.0, (1.0 - b) / s)); }

// The W3C blend modes (Figma's BlendMode values): B(backdrop, source), unpremultiplied.
vec3 blendColor(int m, vec3 b, vec3 s) {
  if (m == 2) return min(b, s);                                              // DARKEN
  if (m == 3) return b * s;                                                  // MULTIPLY
  if (m == 4) return max(b + s - 1.0, 0.0);                                  // LINEAR_BURN
  if (m == 5) return vec3(colorBurn(b.r, s.r), colorBurn(b.g, s.g), colorBurn(b.b, s.b));
  if (m == 6) return max(b, s);                                              // LIGHTEN
  if (m == 7) return b + s - b * s;                                          // SCREEN
  if (m == 8) return min(b + s, 1.0);                                        // LINEAR_DODGE
  if (m == 9) return vec3(colorDodge(b.r, s.r), colorDodge(b.g, s.g), colorDodge(b.b, s.b));
  if (m == 10) return mix(2.0 * b * s, 1.0 - 2.0 * (1.0 - b) * (1.0 - s), step(0.5, b));  // OVERLAY
  if (m == 11) return vec3(softLight(b.r, s.r), softLight(b.g, s.g), softLight(b.b, s.b));
  if (m == 12) return mix(2.0 * b * s, 1.0 - 2.0 * (1.0 - b) * (1.0 - s), step(0.5, s));  // HARD_LIGHT
  if (m == 13) return abs(b - s);                                            // DIFFERENCE
  if (m == 14) return b + s - 2.0 * b * s;                                   // EXCLUSION
  if (m == 15) return setLum(setSat(s, sat(b)), lum(b));                     // HUE
  if (m == 16) return setLum(setSat(b, sat(s)), lum(b));                     // SATURATION
  if (m == 17) return setLum(s, lum(b));                                     // COLOR
  if (m == 18) return setLum(b, lum(s));                                     // LUMINOSITY
  return s;
}

// The rounded clip the layer lands in (slots 9: x0 y0 x1 y1, 10: radii; canvas device px; x1 < x0: none).
float sdBox4(vec2 p, vec2 b, vec4 r) {
  float rr = p.x > 0.0 ? (p.y > 0.0 ? r.z : r.y) : (p.y > 0.0 ? r.w : r.x);
  rr = clamp(rr, 0.0, min(b.x, b.y));
  vec2 q = abs(p) - b + rr;
  return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - rr;
}
float roundClip(vec2 d) {
  vec4 r = u_v[9];
  if (r.z <= r.x) return 1.0;
  vec2 h = (r.zw - r.xy) * 0.5;
  return clamp(0.5 - sdBox4(d - (r.xy + h), h, u_v[10]), 0.0, 1.0);
}

void main() {
  vec4 params = u_v[7];
  int mode = int(params.z + 0.5);
  int blend = int(params.y + 0.5);
  vec4 c;
  float cov = roundClip(v_dev);
  if (cov <= 0.0) discard;
  if (mode == 3) {
    float a = at(u_t0, u_v[3], v_dev - u_v[8].xy).a;
    if (params.w > 0.5) a *= 1.0 - at(u_t1, u_v[4], v_dev).a;
    c = u_v[6] * a;
  } else if (mode == 4) {
    float inside = at(u_t1, u_v[4], v_dev).a;
    float blurred = at(u_t0, u_v[3], v_dev - u_v[8].xy).a;
    c = u_v[6] * (inside * (1.0 - blurred));
  } else {
    c = at(u_t0, u_v[3], v_dev);
    if (mode == 1) c *= at(u_t1, u_v[4], v_dev).a;
    else if (mode == 2) {
      vec4 m = at(u_t1, u_v[4], v_dev);
      vec3 rgb = m.a > 0.0 ? m.rgb / m.a : vec3(0.0);
      c *= dot(rgb, vec3(0.2126, 0.7152, 0.0722)) * m.a;
    }
  }
  c *= params.x;
  if (blend > 1) {
    vec4 b = at(u_t2, u_v[5], v_dev);
    vec3 cb = b.a > 0.0 ? b.rgb / b.a : vec3(0.0);
    vec3 cs = c.a > 0.0 ? c.rgb / c.a : vec3(0.0);
    vec3 mixed = (1.0 - b.a) * cs + b.a * clamp(blendColor(blend, cb, cs), 0.0, 1.0);
    float a = c.a + b.a * (1.0 - c.a);
    c = vec4(c.a * mixed + (1.0 - c.a) * b.rgb, a);
    c = mix(b, c, cov);  // written over the backdrop: outside the clip the backdrop stays
  } else {
    c *= cov;
  }
  o_color = c;
}
)";

// ---- Blur: separable Gaussian, dilate, erode -----------------------------------
// A quad over the whole viewport; the source texture has the target's layout. Slots: 2 = (direction x, y in
// texels, σ in texels, mode: 0 Gaussian, 1 dilate, 2 erode), 3 = (radius in texels for dilate / erode).
inline constexpr const char* kBlurVertex = R"(#version 300 es
void main() {
  int id = gl_VertexID;
  vec2 corner = vec2((id == 1 || id == 2 || id == 4) ? 1.0 : 0.0, (id == 2 || id == 4 || id == 5) ? 1.0 : 0.0);
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}
)";

inline constexpr const char* kBlurFragment = R"(#version 300 es
precision highp float;
uniform vec4 u_v[12];
uniform sampler2D u_t0;
out vec4 o_color;
void main() {
  vec2 sz = vec2(textureSize(u_t0, 0));
  vec2 uv = gl_FragCoord.xy / sz;
  vec2 dir = u_v[2].xy / sz;
  int mode = int(u_v[2].w + 0.5);
  if (mode == 0) {
    float sigma = max(u_v[2].z, 1e-3);
    int n = min(int(ceil(3.0 * sigma)), 48);
    vec4 sum = vec4(0.0);
    float total = 0.0;
    for (int i = -n; i <= n; i++) {
      float w = exp(-float(i * i) / (2.0 * sigma * sigma));
      sum += texture(u_t0, uv + dir * float(i)) * w;
      total += w;
    }
    o_color = sum / total;
    return;
  }
  int r = min(int(ceil(u_v[3].x)), 64);
  float m = mode == 1 ? 0.0 : 1.0;
  for (int i = -r; i <= r; i++) {
    float a = texture(u_t0, uv + dir * float(i)).a;
    m = mode == 1 ? max(m, a) : min(m, a);
  }
  o_color = vec4(m);
}
)";

}  // namespace eng::gfx::gl
