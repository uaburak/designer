// Figma's shader fills and effects (round 11): the presets of the Fill picker's "Shader fills" and the Effects browser's
// "Shader effects" (src/shared/shaders/presets.json), one program (gfx::ShaderId::Custom) switching on the preset —
// GLSL ES 3.00, line for line with gfx/wgpu/CustomShader.h. Figma runs its shaders on WebGPU only (help: shaders need
// WebGPU); here both backends draw them. What each preset draws is ours: live has no capture of a shader's pixels or
// settings (the names are live's). Static: drawn at time 0 (Figma's animate; not built).
//
// One quad (slot 2 = x0 y0 x1 y1 in canvas device px) into a layer of its own (render/Renderer.cpp drawShaderPaint,
// the effects in drawNode). Slots: 3 = where u_t0 (the layer an effect reads, premultiplied) lies — as Composite's;
// 4–5 = canvas device px → the node's px (rows); 6 = (program, 0 a fill / 1 an effect, the node's width, height in its
// px); 7 = the node's px → device px (m00 m01 m10 m11, an offset's); 8–13 = the preset's colours in order (straight
// RGBA); 14–19 = its other parameters in order, four a slot, in the units the panel shows (%, °, px, a count, a
// choice's index, a toggle 0 / 1). A fill writes its paint (premultiplied), an effect the layer as it leaves it. The
// procedural fills' "Scale" is a share of the layer's shorter side (they look the same at any size).
#pragma once

namespace eng::gfx::gl {

inline constexpr const char* kCustomVertex = R"(#version 300 es
uniform vec4 u_v[20];
out vec2 v_dev;
void main() {
  int id = gl_VertexID;
  vec2 corner = vec2((id == 1 || id == 2 || id == 4) ? 1.0 : 0.0, (id == 2 || id == 4 || id == 5) ? 1.0 : 0.0);
  vec2 p = mix(u_v[2].xy, u_v[2].zw, corner);
  gl_Position = vec4(dot(u_v[0].xyz, vec3(p, 1.0)), dot(u_v[1].xyz, vec3(p, 1.0)), 0.0, 1.0);
  v_dev = p;
}
)";

inline constexpr const char* kCustomFragment = R"(#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
in vec2 v_dev;
uniform vec4 u_v[20];
uniform sampler2D u_t0;
out vec4 o_color;

vec2 NP;    // this pixel in the node's px
vec2 SIZE;  // the node's size
float K;    // device px per node px

vec4 C(int i) { return u_v[8 + i]; }
float S(int i) { return u_v[14 + i / 4][i - (i / 4) * 4]; }
// A procedural fill's space: `features` across the layer's shorter side at 100 % (the parameter `i`, a %).
vec2 scaled(int i, float features) { return NP / (min(SIZE.x, SIZE.y) * max(S(i), 1.0) / 100.0) * features; }

// ---- helpers ----
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x), mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
}
// Fractal noise of `octaves` (1–8), 0..1.
float fbm(vec2 p, int octaves) {
  float s = 0.0;
  float a = 0.5;
  float norm = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= octaves) break;
    s += a * vnoise(p);
    norm += a;
    p = mat2(1.6, 1.2, -1.2, 1.6) * p + vec2(17.0, 9.0);
    a *= 0.5;
  }
  return s / max(norm, 1e-6);
}
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec2 rot(vec2 p, float a) {
  float c = cos(a);
  float s = sin(a);
  return vec2(c * p.x - s * p.y, s * p.x + c * p.y);
}
vec2 fmod2(vec2 a, float b) { return a - b * floor(a / b); }
float fmod1(float a, float b) { return a - b * floor(a / b); }
// A signed distance in the node's px → anti-aliased coverage (one device px wide).
float cover(float d) { return clamp(0.5 - d * K, 0.0, 1.0); }
vec3 unpre(vec4 c) { return c.a > 0.0 ? c.rgb / c.a : vec3(0.0); }
vec3 hueShift(vec3 c, float deg) {
  vec3 yiq = mat3(0.299, 0.596, 0.211, 0.587, -0.274, -0.523, 0.114, -0.322, 0.312) * c;
  float h = atan(yiq.z, yiq.y) + radians(deg);
  float ch = length(yiq.yz);
  return mat3(1.0, 1.0, 1.0, 0.956, -0.272, -1.106, 0.621, -0.647, 1.703) * vec3(yiq.x, ch * cos(h), ch * sin(h));
}
vec3 sepia(vec3 c) { return vec3(dot(c, vec3(0.393, 0.769, 0.189)), dot(c, vec3(0.349, 0.686, 0.168)), dot(c, vec3(0.272, 0.534, 0.131))); }

// The layer an effect reads (premultiplied) at canvas device px `d`.
vec4 at(vec2 d) {
  vec4 map = u_v[3];
  vec2 sz = vec2(textureSize(u_t0, 0));
  vec2 q = (d - map.xy) * map.w;
  if (q.x < 0.0 || q.y < 0.0 || q.y > map.z || q.x > sz.x) return vec4(0.0);
  return texture(u_t0, vec2(q.x / sz.x, (map.z - q.y) / sz.y));
}
vec2 toDev(vec2 o) { return vec2(dot(u_v[7].xy, o), dot(u_v[7].zw, o)); }
// The layer `o` node px from this pixel, and at a point of the node.
vec4 src(vec2 o) { return at(v_dev + toDev(o)); }
vec4 srcAt(vec2 p) { return src(p - NP); }

// ---- Shader fills (straight RGBA) ----
vec4 movingGradient(vec2 uv) {
  float dist = S(0) / 100.0;
  float scale = max(S(1), 1.0) / 100.0;
  vec2 q = uv + dist * 0.18 * vec2(sin(uv.y * 5.3 + 1.3) + sin(uv.x * 2.1 + 0.7), cos(uv.x * 4.7 + 2.1) + sin(uv.y * 3.3));
  vec2 c = vec2(0.5);
  float w0 = 1.0 / (pow(distance(q, c + (vec2(0.18, 0.22) - c) * scale), 2.5) + 1e-3);
  float w1 = 1.0 / (pow(distance(q, c + (vec2(0.85, 0.18) - c) * scale), 2.5) + 1e-3);
  float w2 = 1.0 / (pow(distance(q, c + (vec2(0.80, 0.85) - c) * scale), 2.5) + 1e-3);
  float w3 = 1.0 / (pow(distance(q, c + (vec2(0.20, 0.80) - c) * scale), 2.5) + 1e-3);
  return (C(0) * w0 + C(1) * w1 + C(2) * w2 + C(3) * w3) / (w0 + w1 + w2 + w3);
}
vec4 meshGradient(vec2 uv) {
  vec2 q = uv - 0.5;
  q = rot(q, S(1) / 100.0 * 3.0 * (1.0 - smoothstep(0.0, 0.75, length(q))));
  q += S(0) / 100.0 * 0.15 * vec2(sin(q.y * 7.0 + 0.5), sin(q.x * 6.0 + 1.7));
  q = clamp(q + 0.5, 0.0, 1.0);
  vec2 s = q * q * (3.0 - 2.0 * q);
  return mix(mix(C(0), C(1), s.x), mix(C(3), C(2), s.x), s.y);
}
vec4 nebula() {
  vec2 p = scaled(0, 2.0);
  float w = fbm(p * 1.7 + 3.1, 4);
  float n = fbm(p + 1.5 * vec2(w, fbm(p * 1.3 + 7.7, 4)), 6);
  float m = fbm(p * 2.0 + 11.0, 5);
  float gas = smoothstep(0.75 - S(1) / 100.0 * 0.45, 0.95, n + 0.2);
  vec3 col = mix(C(2).rgb, mix(C(1).rgb, C(0).rgb, smoothstep(0.3, 0.7, m)), gas);
  col += C(0).rgb * pow(gas, 3.0) * 0.4;
  vec2 cell = floor(NP / 3.0);
  float star = step(1.0 - S(2) / 100.0 * 0.03, hash12(cell)) * hash12(cell + 17.0);
  return vec4(clamp(col + vec3(star), 0.0, 1.0), mix(C(2).a, 1.0, max(gas, star)));
}
vec4 waterCaustic() {
  vec2 p = fmod2(scaled(0, 1.5) * 6.28318, 6.28318) - 250.0;
  vec2 i = p;
  float c = 1.0;
  float inten = 0.005;
  for (int n = 0; n < 5; n++) {
    float t = 1.0 - 3.5 / float(n + 1);
    i = p + vec2(cos(t - i.x) + sin(t + i.y), sin(t - i.y) + cos(t + i.x));
    c += 1.0 / length(vec2(p.x / (sin(i.x + t) / inten), p.y / (cos(i.y + t) / inten)));
  }
  c /= 5.0;
  c = 1.17 - pow(c, 1.4);
  float v = clamp(pow(abs(c), 8.0) * S(1) / 100.0, 0.0, 1.0);
  return mix(C(1), C(0), v);
}
vec4 fractalNoise() {
  float n = fbm(scaled(0, 4.0), int(clamp(S(1), 1.0, 8.0) + 0.5));
  n = clamp((n - 0.5) * (1.0 + S(2) / 25.0) + 0.5, 0.0, 1.0);
  return mix(C(0), C(1), n);
}
vec4 clouds() {
  vec2 p = scaled(0, 2.5) * vec2(0.6, 1.2);
  float n = fbm(p + 0.35 * vec2(fbm(p * 2.0 + 4.0, 3), 0.0), 6);
  float t = 0.75 - S(1) / 100.0 * 0.5;
  float soft = max(S(2) / 100.0, 0.02) * 0.25;
  return mix(C(0), C(1), smoothstep(t - soft, t + soft, n));
}
vec4 moire() {
  float k = 6.28318 * max(S(0), 0.1) / 100.0;
  vec2 q = NP - SIZE * 0.5;
  float g1 = 0.5 + 0.5 * cos(q.x * k);
  vec2 q2 = rot(q, radians(S(1)));
  float g2 = 0.5 + 0.5 * cos(q2.x * k * (1.0 + S(2) / 1000.0) + S(2) / 100.0 * 6.0 * sin(q2.y * k * 0.05));
  float ink = max(smoothstep(0.8, 0.92, g1), smoothstep(0.8, 0.92, g2));
  return mix(C(1), C(0), ink);
}
vec4 glowingWave() {
  vec2 uv = NP / SIZE;
  int n = int(clamp(S(0), 1.0, 8.0) + 0.5);
  float amp = S(1) / 100.0;
  float glow = max(S(2), 1.0) / 100.0 * 0.12 * SIZE.y;
  float acc = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= n) break;
    float fi = float(i);
    float y = 0.5 + amp * sin(uv.x * 6.28318 * (1.0 + fi * 0.37) + fi * 1.7) * (0.55 + 0.45 * cos(fi * 2.3));
    float d = abs(uv.y - y) * SIZE.y;
    acc += exp(-d / max(glow, 0.5)) * 0.8 + exp(-d / 1.2) * 0.6;
  }
  return mix(C(1), vec4(C(0).rgb, 1.0), clamp(acc, 0.0, 1.0) * C(0).a);
}
vec4 concentric() {
  vec2 c = vec2(S(1), S(2)) / 100.0 * SIZE;
  vec2 d = abs(NP - c);
  int shape = int(S(3) + 0.5);
  float r = shape == 1 ? max(d.x, d.y) : (shape == 2 ? (d.x + d.y) * 0.7071 : length(d));
  float R = length(max(c, SIZE - c));
  float band = max(R / max(S(0), 1.0), 1e-3);
  float g = abs(fract(r / band) - 0.5);
  return mix(C(1), C(0), clamp(0.5 + (g - 0.25) * band * K, 0.0, 1.0));
}
vec4 patternGrid() {
  float cs = max(S(0), 1.0);
  vec2 q = NP - (floor(NP / cs) + 0.5) * cs;
  float r = S(1) / 100.0 * cs * 0.5;
  vec2 a = abs(q);
  int shape = int(S(2) + 0.5);
  float d = length(q) - r;
  if (shape == 1) d = max(a.x, a.y) - r;
  else if (shape == 2) d = (a.x + a.y) * 0.7071 - r;
  else if (shape == 3) d = min(max(a.x - r * 0.3, a.y - r), max(a.x - r, a.y - r * 0.3));
  return mix(C(1), C(0), cover(d));
}

// ---- Shader effects (premultiplied) ----
vec4 particles() {
  float size = max(S(0), 0.5);
  float dens = S(1) / 100.0;
  float spread = S(2);
  bool layerColors = S(3) > 0.5;
  float cs = max(size * 2.5, 2.0);
  vec2 base = floor(NP / cs);
  vec4 o = vec4(0.0);
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 id = base + vec2(float(i), float(j));
      if (hash12(id + 3.7) > dens) continue;
      vec2 center = (id + 0.15 + 0.7 * hash22(id)) * cs;
      vec4 s = srcAt(center - (hash22(id + 9.1) - 0.5) * 2.0 * spread);
      if (s.a < 0.5) continue;
      float cov = cover(distance(NP, center) - size * 0.5 * (0.6 + 0.8 * hash12(id + 1.3)));
      vec4 col = layerColors ? vec4(unpre(s), 1.0) : C(0);
      o += vec4(col.rgb, 1.0) * col.a * cov * (1.0 - o.a);
    }
  }
  return o;
}
float refractHeight(vec2 p, int kind, float k) {
  if (kind == 1) return sin(p.x * k + 2.0 * sin(p.y * k * 0.5));
  if (kind == 2) return sin(p.x * k) * sin(p.y * k);
  if (kind == 3) return sin(length(p - SIZE * 0.5) * k);
  return sin(p.x * k);
}
vec4 refraction() {
  float k = 6.28318 / max(S(0), 1.0);
  int kind = int(S(2) + 0.5);
  vec2 e = vec2(0.5, 0.0);
  vec2 g = vec2(refractHeight(NP + e, kind, k) - refractHeight(NP - e, kind, k), refractHeight(NP + e.yx, kind, k) - refractHeight(NP - e.yx, kind, k));
  return src(g / (2.0 * e.x * k) * S(1));
}
vec4 halftone() {
  float ds = max(S(0), 1.0);
  float ang = radians(S(1));
  bool mono = S(2) > 0.5;
  vec2 q = rot(NP, -ang);
  vec2 cell = (floor(q / ds) + 0.5) * ds;
  vec4 o = vec4(0.0);
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 cc = cell + vec2(float(i), float(j)) * ds;
      vec4 s = srcAt(rot(cc, ang));
      if (s.a <= 0.0) continue;
      vec3 c = unpre(s);
      float amount = (1.0 - luma(c) * 0.9) * s.a;
      float cov = cover(distance(q, cc) - sqrt(amount) * ds * 0.7071);
      vec4 col = mono ? vec4(C(0).rgb, 1.0) * C(0).a : vec4(c, 1.0);
      o += col * cov * (1.0 - o.a);
    }
  }
  return o;
}
float metalWave(float t) { return 0.5 + 0.5 * cos(t * 6.28318); }
vec4 chromaticMetal() {
  vec4 s = src(vec2(0.0));
  if (s.a <= 0.0) return vec4(0.0);
  vec2 g = vec2(src(vec2(2.0, 0.0)).a - src(vec2(-2.0, 0.0)).a, src(vec2(0.0, 2.0)).a - src(vec2(0.0, -2.0)).a);
  float t = luma(unpre(s)) * 1.5 + NP.y / SIZE.y * 0.8 + (g.x - g.y) * 0.35;
  float d = S(1) / 100.0 * 0.08;
  vec3 m = vec3(metalWave(t + d), metalWave(t), metalWave(t - d));
  vec3 col = mix(vec3(0.25), vec3(1.0), m) * mix(vec3(1.0), C(0).rgb, 0.5) + S(0) / 100.0 * pow(m, vec3(12.0));
  return vec4(clamp(col, 0.0, 1.0), 1.0) * s.a;
}
vec4 lens() {
  vec2 c = SIZE * 0.5;
  float R = max(length(c), 1.0);
  vec2 d = (NP - c) / R;
  float f = (1.0 + S(0) / 100.0 * dot(d, d) * 0.6) / (max(S(1), 1.0) / 100.0);
  float disp = S(2) / 100.0 * 0.06;
  vec4 r = srcAt(c + d * f * (1.0 + disp) * R);
  vec4 g = srcAt(c + d * f * R);
  vec4 b = srcAt(c + d * f * (1.0 - disp) * R);
  return vec4(r.r, g.g, b.b, max(max(r.a, g.a), b.a));
}
float bayer2(vec2 a) {
  a = floor(a);
  return fract(a.x / 2.0 + a.y * a.y * 0.75);
}
float bayer4(vec2 a) { return bayer2(0.5 * a) * 0.25 + bayer2(a); }
float bayer8(vec2 a) { return bayer4(0.5 * a) * 0.25 + bayer2(a); }
vec4 dither() {
  float ps = max(S(0), 1.0);
  float levels = max(floor(S(1) + 0.5), 2.0) - 1.0;
  vec2 cell = floor(NP / ps);
  vec4 s = srcAt((cell + 0.5) * ps);
  if (s.a <= 0.0) return vec4(0.0);
  vec3 c = unpre(s);
  float t = bayer8(cell) - 0.5;
  if (S(2) > 0.5) return vec4(clamp(floor(c * levels + 0.5 + t) / levels, 0.0, 1.0), 1.0) * s.a;
  vec4 col = mix(C(0), C(1), clamp(floor(luma(c) * levels + 0.5 + t) / levels, 0.0, 1.0));
  return vec4(col.rgb, 1.0) * col.a * s.a;
}
vec4 gradientMap() {
  vec4 s = src(vec2(0.0));
  if (s.a <= 0.0) return vec4(0.0);
  vec3 c = unpre(s);
  float l = luma(c);
  vec4 g = l < 0.5 ? mix(C(0), C(1), l * 2.0) : mix(C(1), C(2), l * 2.0 - 1.0);
  return vec4(mix(c, g.rgb, S(0) / 100.0), 1.0) * s.a;
}
vec4 warp() {
  vec2 p = NP / max(S(1), 1.0);
  int oct = 1 + int(S(2) / 100.0 * 4.0 + 0.5);
  vec2 off = vec2(fbm(p, oct), fbm(p + vec2(5.2, 1.3), oct)) - 0.5;
  return src(off * 2.0 * S(0));
}
vec4 pixelate() {
  float ps = max(S(0), 1.0);
  vec2 cc = (floor(NP / ps) + 0.5) * ps;
  vec4 s = srcAt(cc);
  if (S(1) > 0.5) s *= cover(distance(NP, cc) - ps * 0.5);
  return s;
}
vec4 bokeh() {
  float R = S(0);
  if (R <= 0.0) return src(vec2(0.0));
  float boost = S(1) / 100.0 * 4.0;
  vec4 acc = vec4(0.0);
  float wsum = 0.0;
  for (int i = 0; i < 64; i++) {
    float fi = float(i) + 0.5;
    float a = fi * 2.39996323;
    vec4 s = src(vec2(cos(a), sin(a)) * sqrt(fi / 64.0) * R);
    float w = 1.0 + boost * pow(luma(unpre(s)), 4.0) * s.a;
    acc += s * w;
    wsum += w;
  }
  return acc / wsum;
}
vec4 outlines() {
  float w = max(S(0), 0.5);
  int count = int(clamp(S(1), 1.0, 6.0) + 0.5);
  float gap = max(S(2), 0.0);
  vec4 s = src(vec2(0.0));
  float maxD = float(count) * (w + gap) + 1.0;
  float dist = 0.0;
  if (s.a < 0.5) {
    dist = 1e9;
    for (int i = 1; i <= 24; i++) {
      float r = maxD * float(i) / 24.0;
      float hit = 0.0;
      for (int k = 0; k < 12; k++) {
        float a = float(k) * 0.5235988;
        hit = max(hit, src(vec2(cos(a), sin(a)) * r).a);
      }
      if (hit >= 0.5) {
        dist = r;
        break;
      }
    }
  }
  float ring = 0.0;
  for (int i = 0; i < 6; i++) {
    if (i >= count) break;
    float a0 = gap + float(i) * (w + gap);
    ring = max(ring, clamp(min(dist - a0, a0 + w - dist) * K + 0.5, 0.0, 1.0));
  }
  if (dist <= 0.0) ring = 0.0;
  vec4 col = vec4(C(0).rgb, 1.0) * C(0).a * ring;
  vec4 base = S(3) > 0.5 ? s : vec4(0.0);
  return base + col * (1.0 - base.a);
}
vec4 crt() {
  vec2 c = NP / SIZE * 2.0 - 1.0;
  c *= 1.0 + S(0) / 100.0 * 0.25 * (c.yx * c.yx);
  vec2 q = c * 0.5 + 0.5;
  if (q.x < 0.0 || q.y < 0.0 || q.x > 1.0 || q.y > 1.0) return vec4(0.0);
  vec2 qp = q * SIZE;
  vec4 s = srcAt(qp);
  float line = max(S(3), 1.0);
  float scan = 1.0 - S(1) / 100.0 * 0.6 * (0.5 + 0.5 * cos(qp.y * 6.28318 / line));
  float m = fmod1(floor(qp.x / (line / 3.0)), 3.0);
  float mask = S(2) / 100.0 * 0.7;
  vec3 gains = vec3(m < 0.5 ? 1.0 : 1.0 - mask, (m >= 0.5 && m < 1.5) ? 1.0 : 1.0 - mask, m >= 1.5 ? 1.0 : 1.0 - mask);
  vec2 v = q * (1.0 - q);
  float vig = clamp(pow(max(v.x * v.y * 16.0, 0.0), 0.25), 0.0, 1.0);
  return vec4(s.rgb * scan * gains * vig, s.a);
}
vec4 bloom() {
  vec4 s = src(vec2(0.0));
  float thr = S(0) / 100.0;
  float R = max(S(2), 0.0);
  vec3 glow = vec3(0.0);
  float wsum = 0.0;
  for (int i = 0; i < 48; i++) {
    float fi = float(i) + 0.5;
    float r = sqrt(fi / 48.0) * R;
    float a = fi * 2.39996323;
    vec4 t = src(vec2(cos(a), sin(a)) * r);
    float b = max(luma(unpre(t)) - thr, 0.0) / max(1.0 - thr, 1e-3);
    float w = exp(-r * r / max(R * R * 0.5, 1e-3));
    glow += t.rgb * b * w;
    wsum += w;
  }
  glow = glow / max(wsum, 1e-3) * S(1) / 100.0 * 2.0;
  float a = clamp(max(s.a, max(glow.r, max(glow.g, glow.b))), 0.0, 1.0);
  return vec4(min(s.rgb + glow, vec3(a)), a);
}
vec4 glowingParticles() {
  vec4 s = src(vec2(0.0));
  float size = max(S(0), 0.5);
  float dens = S(1) / 100.0;
  float glow = max(S(2), 0.0);
  float cs = max(size * 4.0, glow * 1.5 + size);
  vec2 base = floor(NP / cs);
  float acc = 0.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 id = base + vec2(float(i), float(j));
      if (hash12(id + 5.3) > dens) continue;
      vec2 center = (id + 0.15 + 0.7 * hash22(id + 2.1)) * cs;
      if (srcAt(center).a < 0.5) continue;
      float d = distance(NP, center) - size * 0.5 * (0.5 + hash12(id + 8.8));
      acc += cover(d) + (glow > 0.0 ? exp(-max(d, 0.0) / max(glow * 0.35, 0.3)) * 0.6 : 0.0);
    }
  }
  vec4 col = vec4(C(0).rgb, 1.0) * clamp(acc, 0.0, 1.0) * C(0).a;
  return col + s * (1.0 - col.a);
}
vec4 colorAdjust() {
  vec4 s = src(vec2(0.0));
  if (s.a <= 0.0) return vec4(0.0);
  vec3 c = unpre(s) + S(0) / 100.0;
  c = (c - 0.5) * (1.0 + S(1) / 100.0) + 0.5;
  c = mix(vec3(luma(c)), c, 1.0 + S(2) / 100.0);
  return vec4(clamp(hueShift(c, S(3)), 0.0, 1.0), 1.0) * s.a;
}
vec4 pixelStretch() {
  int dir = int(S(1) + 0.5);
  float pos = S(0) / 100.0;
  vec2 p = NP;
  if (dir <= 1) {
    float x = pos * SIZE.x;
    if (dir == 0 ? p.x > x : p.x < x) p.x = x + (hash12(vec2(floor(p.y), 3.1)) - 0.5) * S(2);
  } else {
    float y = pos * SIZE.y;
    if (dir == 2 ? p.y > y : p.y < y) p.y = y + (hash12(vec2(floor(p.x), 7.9)) - 0.5) * S(2);
  }
  return srcAt(p);
}
vec4 gooey() {
  float R = max(S(0), 0.5);
  float t = S(1) / 100.0;
  vec4 acc = vec4(0.0);
  float wsum = 0.0;
  for (int i = 0; i < 48; i++) {
    float fi = float(i) + 0.5;
    float r = sqrt(fi / 48.0) * R;
    float a = fi * 2.39996323;
    float w = exp(-2.0 * r * r / (R * R));
    acc += src(vec2(cos(a), sin(a)) * r) * w;
    wsum += w;
  }
  acc /= wsum;
  float e = 0.5 / max(R * K, 1.0) + 0.02;
  return vec4(unpre(acc), 1.0) * smoothstep(t - e, t + e, acc.a);
}
vec4 blobs() {
  vec4 s = src(vec2(0.0));
  if (s.a <= 0.0) return vec4(0.0);
  int n = int(clamp(S(0), 1.0, 12.0) + 0.5);
  float size = S(1) / 100.0 * min(SIZE.x, SIZE.y) * 0.5;
  float field = 0.0;
  float second = 0.0;
  for (int i = 0; i < 12; i++) {
    if (i >= n) break;
    vec2 c = (0.15 + 0.7 * hash22(vec2(float(i) * 1.37, 4.2))) * SIZE;
    float r = size * (0.6 + 0.8 * hash12(vec2(float(i), 9.1)));
    vec2 d = NP - c;
    float f = r * r / max(dot(d, d), 1e-3);
    field += f;
    if (i - (i / 2) * 2 == 1) second += f;
  }
  float e = mix(0.02, 0.6, S(2) / 100.0);
  vec4 bc = mix(C(0), C(1), second / max(field, 1e-6));
  vec4 blob = vec4(bc.rgb, 1.0) * bc.a * smoothstep(1.0 - e, 1.0 + e, field) * s.a;
  return blob + s * (1.0 - blob.a);
}
vec4 sliceShift() {
  bool vertical = S(2) > 0.5;
  vec2 uv = NP / SIZE;
  float idx = floor((vertical ? uv.x : uv.y) * max(floor(S(0) + 0.5), 1.0));
  float off = (hash12(vec2(idx, 1.7)) - 0.5) * 2.0 * S(1);
  return src(vertical ? vec2(0.0, off) : vec2(off, 0.0));
}
vec4 lightRays() {
  vec4 s = src(vec2(0.0));
  float ang = radians(S(0));
  vec2 dir = vec2(cos(ang), sin(ang));
  float len = max(S(1), 0.0);
  float acc = 0.0;
  for (int i = 0; i < 32; i++) {
    float t = (float(i) + 0.5) / 32.0;
    acc += src(-dir * t * len).a * (1.0 - t);
  }
  vec4 col = vec4(C(0).rgb, 1.0) * C(0).a * clamp(acc / 16.0 * S(2) / 100.0 * 1.5, 0.0, 1.0);
  return s + col * (1.0 - s.a);
}
float hatch(float ang, float sp, float w) {
  vec2 q = rot(NP, -radians(ang));
  return cover(abs(fract(q.y / sp) - 0.5) * sp - w * 0.5);
}
vec4 hatching() {
  vec4 s = src(vec2(0.0));
  if (s.a <= 0.0) return vec4(0.0);
  float d = 1.0 - luma(unpre(s));
  float sp = max(S(0), 1.0);
  float ang = S(1);
  float w = max(S(2), 0.25);
  float ink = 0.0;
  if (d > 0.15) ink = max(ink, hatch(ang, sp, w));
  if (d > 0.4) ink = max(ink, hatch(ang + 90.0, sp, w));
  if (d > 0.65) ink = max(ink, hatch(ang + 45.0, sp, w));
  if (d > 0.85) ink = max(ink, hatch(ang - 45.0, sp, w));
  vec4 col = mix(C(1), C(0), ink);
  return vec4(col.rgb, 1.0) * col.a * s.a;
}
float edgeValue(vec4 t) { return luma(t.rgb) + t.a; }
vec4 coloredEdges() {
  vec4 s = src(vec2(0.0));
  float w = max(S(0), 0.5);
  float a = edgeValue(src(vec2(-w, -w)));
  float b = edgeValue(src(vec2(0.0, -w)));
  float c = edgeValue(src(vec2(w, -w)));
  float d = edgeValue(src(vec2(-w, 0.0)));
  float f = edgeValue(src(vec2(w, 0.0)));
  float g = edgeValue(src(vec2(-w, w)));
  float h = edgeValue(src(vec2(0.0, w)));
  float i = edgeValue(src(vec2(w, w)));
  vec2 grad = vec2((c + 2.0 * f + i) - (a + 2.0 * d + g), (g + 2.0 * h + i) - (a + 2.0 * b + c));
  float e = clamp(length(grad) * 0.25 * S(1) / 100.0, 0.0, 1.0);
  vec4 col = vec4(C(0).rgb, 1.0) * C(0).a * e;
  vec4 base = S(2) > 0.5 ? vec4(0.0) : s;
  return col + base * (1.0 - col.a);
}
vec4 duotone() {
  vec4 s = src(vec2(0.0));
  if (s.a <= 0.0) return vec4(0.0);
  float l = clamp((luma(unpre(s)) - 0.5) * (1.0 + S(0) / 100.0) + 0.5, 0.0, 1.0);
  vec4 c = mix(C(0), C(1), l);
  return vec4(c.rgb, 1.0) * c.a * s.a;
}
vec4 channelMixer() {
  vec4 s = src(vec2(0.0));
  if (s.a <= 0.0) return vec4(0.0);
  vec3 c = unpre(s);
  vec3 o = vec3(dot(c, vec3(S(0), S(1), S(2))), dot(c, vec3(S(3), S(4), S(5))), dot(c, vec3(S(6), S(7), S(8)))) / 100.0;
  return vec4(clamp(o, 0.0, 1.0), 1.0) * s.a;
}
vec4 filterPresets() {
  vec4 s = src(vec2(0.0));
  if (s.a <= 0.0) return vec4(0.0);
  vec3 c = unpre(s);
  int f = int(S(0) + 0.5);
  float l = luma(c);
  vec3 o = sepia(c);
  if (f == 0) o = (mix(sepia(c), vec3(0.94, 0.86, 0.72), 0.15) - 0.5) * 0.9 + 0.53;
  else if (f == 1) o = vec3((l - 0.5) * 1.4 + 0.5);
  else if (f == 2) o = c * vec3(1.08, 1.0, 0.86) + vec3(0.03, 0.01, 0.0);
  else if (f == 3) o = c * vec3(0.88, 1.0, 1.1) + vec3(0.0, 0.01, 0.03);
  else if (f == 4) o = (mix(vec3(l), c, 1.45) - 0.5) * 1.1 + 0.5;
  else if (f == 5) o = mix(vec3(l), c, 0.65) * 0.85 + 0.12;
  return vec4(mix(c, clamp(o, 0.0, 1.0), S(1) / 100.0), 1.0) * s.a;
}

void main() {
  NP = vec2(dot(u_v[4].xyz, vec3(v_dev, 1.0)), dot(u_v[5].xyz, vec3(v_dev, 1.0)));
  SIZE = max(u_v[6].zw, vec2(1e-3));
  K = sqrt(abs(u_v[7].x * u_v[7].w - u_v[7].y * u_v[7].z));
  int program = int(u_v[6].x + 0.5);
  if (u_v[6].y < 0.5) {
    vec2 uv = NP / SIZE;
    vec4 c = vec4(0.0);
    if (program == 0) c = movingGradient(uv);
    else if (program == 1) c = meshGradient(uv);
    else if (program == 2) c = nebula();
    else if (program == 3) c = waterCaustic();
    else if (program == 4) c = fractalNoise();
    else if (program == 5) c = clouds();
    else if (program == 6) c = moire();
    else if (program == 7) c = glowingWave();
    else if (program == 8) c = concentric();
    else if (program == 9) c = patternGrid();
    c = clamp(c, 0.0, 1.0);
    o_color = vec4(c.rgb * c.a, c.a);
    return;
  }
  vec4 o = vec4(0.0);
  if (program == 0) o = particles();
  else if (program == 1) o = refraction();
  else if (program == 2) o = halftone();
  else if (program == 3) o = chromaticMetal();
  else if (program == 4) o = lens();
  else if (program == 5) o = dither();
  else if (program == 6) o = gradientMap();
  else if (program == 7) o = warp();
  else if (program == 8) o = pixelate();
  else if (program == 9) o = bokeh();
  else if (program == 10) o = outlines();
  else if (program == 11) o = crt();
  else if (program == 12) o = bloom();
  else if (program == 13) o = glowingParticles();
  else if (program == 14) o = colorAdjust();
  else if (program == 15) o = pixelStretch();
  else if (program == 16) o = gooey();
  else if (program == 17) o = blobs();
  else if (program == 18) o = sliceShift();
  else if (program == 19) o = lightRays();
  else if (program == 20) o = hatching();
  else if (program == 21) o = coloredEdges();
  else if (program == 22) o = duotone();
  else if (program == 23) o = channelMixer();
  else if (program == 24) o = filterPresets();
  else o = src(vec2(0.0));
  float a = clamp(o.a, 0.0, 1.0);
  o_color = vec4(clamp(o.rgb, vec3(0.0), vec3(a)), a);
}
)";

}  // namespace eng::gfx::gl
