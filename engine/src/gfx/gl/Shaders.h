// The built-in shaders, GLSL ES 3.00 (WebGL2). Interim: written by hand until
// tools/shadergen exists (docs/engine.md §6.10).
//
// Every shader takes `uniform vec4 u_v[20]` (gfx::DrawCall::uniforms): slots 0
// and 1 are the rows mapping draw space to clip space; the rest are per shader,
// listed with it. Textures are u_t0, u_t1, u_t2 (DrawCall::textures).
#pragma once

namespace eng::gfx::gl {

// ---- Shape and Path: the paint, shared ----------------------------------------
//
// Slots: 2 = image adjustments (exposure, contrast, saturation, temperature), 3 = (tint, highlights,
// shadows, 0), 4 = the backdrop texture's place (x, y in window px, width, height in texels), 9 / 10 = the backdrop's
// slot in u_t2 / u_t3 as uv (x0, y0, x1, y1; x1 <= x0: none): reads past it take its border (2026-10-20: the atlas's
// margin past what the blur reads is not stored, its border holds what lies past it).
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

vec2 slotUv(vec2 uv, vec4 b) { return b.z > b.x ? clamp(uv, b.xy, b.zw) : uv; }

// Figma's image adjustments (docs/research/rea/effects.md §2.24; its image colour-adjust shader), slot 2 = (exposure,
// contrast — stored ±0.3 —, saturation (vibrance), temperature), 3 = (tint, highlights, shadows): in linear light
// (γ 2.2), shadows / highlights become an exposure offset around mid grey; temperature (b*), tint (a*) and contrast (L*,
// a smootherstep of 50 ± 30, or a compression for a negative one) in CIELAB; exposure as a tone curve keeping the
// luminance's saturation; saturation as a luminance mix, boosted no further than the gamut allows (≤ 2×).
float adjShadowsHighlights(vec3 c, float shadows, float highlights) {
  float i = luma(c) - pow(0.5, 2.2);
  return 0.75 * i / sqrt(1.0 + 4.0 * i * i) * (i > 0.0 ? highlights : -shadows * 0.999);
}
vec3 adjExposure(vec3 c, float k) {
  float l = pow(10.0, 2.0 * k) - 1.0;
  float n = 1.0 / (1.0 - 0.75) - 1.0;
  float o = luma(c);
  n *= 1.0 + o * o * min(0.0, k) / (0.2 - min(0.0, k));
  c += (o - c) * 0.75;
  if (k < 0.0) {
    c *= 1.0 + k / 16.0;
    o *= 1.0 + k / 16.0;
  }
  c *= (l + 1.0) / (c * l + 1.0);
  o *= (l + 1.0) / (o * l + 1.0);
  c += (c - o) * n;
  return clamp(c, 0.0, 1.0);
}
vec3 adjSaturation(vec3 c, float q) {
  float o = luma(c);
  if (q <= 0.0) return c - (o - c) * q;
  float lo = o / (o - min(min(c.r, c.g), c.b) + 1e-6);
  float hi = (1.0 - o) / (max(max(c.r, c.g), c.b) - o + 1e-6);
  float k = min(mix(1.0, min(lo, hi), q), 2.0);
  return c + (o - c) * (1.0 - k);
}
float smootherstep(float lo, float hi, float x) {
  x = clamp((x - lo) / (hi - lo), 0.0, 1.0);
  return x * x * x * (x * (x * 6.0 - 15.0) + 10.0);
}
vec3 adjLab(vec3 c, float temperature, float tint, float contrast) {
  vec3 xyz = mat3(0.4124564, 0.2126729, 0.0193339, 0.3575761, 0.7151522, 0.1191920, 0.1804375, 0.0721750, 0.9503041) * c;
  xyz = pow(xyz / vec3(0.95047, 1.0, 1.08883), vec3(1.0 / 3.0));
  vec3 lab = vec3(116.0 * xyz.y - 16.0, 500.0 * (xyz.x - xyz.y), 200.0 * (xyz.y - xyz.z));
  lab.y += 30.0 * tint;
  lab.z += 30.0 * temperature;
  float l0 = contrast < 0.0 ? (lab.x - 50.0) * 0.2 + 50.0 : lab.x;
  float l1 = contrast < 0.0 ? lab.x : smootherstep(20.0, 80.0, lab.x) * 100.0;
  lab.x = mix(l0, l1, contrast < 0.0 ? contrast + 1.0 : contrast);
  float y = (lab.x + 16.0) / 116.0;
  xyz = vec3(lab.y / 500.0 + y, y, y - lab.z / 200.0);
  xyz = xyz * xyz * xyz * vec3(0.95047, 1.0, 1.08883);
  c = mat3(3.2404542, -0.9692660, 0.0556434, -1.5371385, 1.8760108, -0.2040259, -0.4985314, 0.0415560, 1.0572252) * xyz;
  return clamp(c, 0.0, 1.0);
}
vec3 adjust(vec3 c) {
  vec4 a = u_v[2], b = u_v[3];
  c = pow(c, vec3(2.2));
  float offset = adjShadowsHighlights(c, b.z, b.y);
  c = adjLab(c, a.w, b.x, a.y);
  c = adjExposure(c, a.x + offset);
  c = adjSaturation(c, clamp(a.z, -1.0, 1.0));
  return pow(clamp(c, 0.0, 1.0), vec3(1.0 / 2.2));
}

// Glass as Figma draws it (docs/research/rea/effects.md §2.15, its GLASS fragment shader), in the node's own units:
// slots 6 = (depth — refractionRadius —, refraction, dispersion × 0.2, splay), 8 = (the light's angle in the node's
// space — light angle − the frame's rotation + 90° —, intensity, bevel size, 0). The frosted backdrop (u_t2) is read
// displaced inward within min(depth, half the size) of the edge (the displacement ramps as t^3.5 up to the depth, a
// fifth of it in the outer 0.7 of the bevel), split by colour over 8 taps along the displacement, lit on the edges
// facing the light (0.6× on the opposite ones) within the bevel, and shaded faintly along the light across the
// refracting band. A path (no distance, g_glassShape < 0) gets the frost alone.
float glassRamp(float lo, float hi, float x) { return clamp((x - lo) / max(0.00001, hi - lo), 0.0, 1.0); }
vec2 glassUnit(vec2 v) {
  float l = dot(v, v);
  return l > 1.0e-10 ? v / sqrt(l) : vec2(0.0);
}
// The outward normal at p of the box of half size b with corners of radius r: none inside the corners' centres' box
// (deeper than the bevel when r ≤ bevel), the corners' radial direction, the sides' normals between; an ellipse's own.
vec2 glassNormal(vec2 p, vec2 b, float r, float bevel) {
  if (g_glassShape == 1) return glassUnit(p / max(b * b, vec2(1e-6)));
  float k = min(min(b.x, b.y), r);
  vec2 q = abs(p) - (b - k);
  if (max(q.x, q.y) <= -bevel * step(r, bevel)) return vec2(0.0);
  return glassUnit(q + max(-min(q.x, q.y), 0.0)) * sign(p);
}
// The frost at this pixel moved by `off` (the node's units).
vec4 glassFetch(vec2 off) { return texture(u_t2, slotUv((gl_FragCoord.xy - u_v[4].xy + g_toFrag * off) / u_v[4].zw, u_v[9])); }
vec4 glassAt() {
  if (g_glassShape < 0) return glassFetch(vec2(0.0));
  vec4 G = u_v[6], L = u_v[8];
  vec2 hs = v_origin.zw * 0.5;
  vec2 p = v_local - hs;
  float corner = p.x > 0.0 ? (p.y > 0.0 ? v_box.z : v_box.y) : (p.y > 0.0 ? v_box.w : v_box.x);
  float rd = min(min(hs.x, hs.y), G.x);
  float bevel = L.z, eh = g_dist;
  float lim = 0.999 * rd;
  float bend = clamp(pow(glassRamp(-rd - bevel, -bevel, eh), 3.5) * rd * G.y, -lim, lim);
  float rim = glassRamp(-bevel - 0.0001, -bevel * 0.3, eh);
  vec2 dir = mix(glassNormal(p, hs, max(corner, max(bevel, rd)), bevel), glassUnit(p), G.w);
  vec2 dg = -dir * mix(bend, G.y * 0.2 * lim, rim);
  vec4 c = vec4(0.0);
  if (G.z < 0.001) c = glassFetch(dg);
  else {
    float total = 0.0;
    for (int i = 0; i < 8; i++) {
      float t = float(i) / 7.0 - 0.5;
      float w = 1.0 - abs(t * 2.0);
      vec4 r = glassFetch(dg * (1.0 + (t + 0.5) * G.z));
      vec4 g = glassFetch(dg * (1.0 + t * G.z));
      vec4 b = glassFetch(dg * (1.0 + (t - 0.5) * G.z));
      c += vec4(r.r, g.g, b.b, max(max(r.a, g.a), b.a)) * w;
      total += w;
    }
    c /= total;
  }
  vec2 light = vec2(cos(L.x), sin(L.x));
  vec2 n = glassNormal(p, hs, corner, bevel);
  float lit = smoothstep(-bevel - 0.001, -bevel * 0.2, eh) * L.y;
  c.rgb += smoothstep(0.35, 1.0, dot(n, -light)) * lit;
  c.rgb += smoothstep(0.35, 1.0, dot(n, light)) * lit * 0.6;
  c.rgb += dot(dir, light) * pow(glassRamp(-rd, -bevel + 0.0001, eh), 2.0) * 0.05 * L.y;
  return vec4(clamp(c.rgb, vec3(0.0), vec3(c.a)), c.a);
}

// Figma's dither (its gradients and analytic shadows, docs/research/rea/effects.md §2.21): ±1/255 on every channel,
// alpha included, from a sine hash of the pixel; transparent pixels untouched, an opaque one keeps its alpha.
vec4 figDither(vec4 c) {
  if (c.a == 0.0) return c;
  float n = fract(sin(dot(vec2(12.9898, 78.233), gl_FragCoord.xy)) * 43758.5453);
  vec4 q = min(abs(c + (n - 0.5) * (2.0 / 255.0)), 1.0);
  // Kept a valid premultiplied colour (no channel over its alpha): our blur and blend passes divide by alpha.
  return c.a == 1.0 ? vec4(q.rgb, c.a) : vec4(min(q.rgb, vec3(q.a)), q.a);
}

vec4 paintAt(vec2 local, int kind) {
  if (kind == 0) return v_color;
  if (kind == 7) {
    // A progressive background blur: the blur radius along the effect (slot 19 = (the radius at the start, at the end, this interval's
    // lower and upper radius)), the backdrop between the interval's two levels (u_t3 at slot 7, u_t2 at slot 4); pixels
    // whose radius falls in another interval are that one's.
    vec4 P = u_v[19];
    float s = mix(P.x, P.y, progressT(g_dp));
    if (s < P.z || s >= P.w) return vec4(0.0);
    float f = clamp((s - P.z) / max(P.w - P.z, 1e-6), 0.0, 1.0);
    vec2 uv1 = slotUv((gl_FragCoord.xy - u_v[4].xy) / u_v[4].zw, u_v[9]);
    vec2 uv0 = slotUv((gl_FragCoord.xy - u_v[7].xy) / u_v[7].zw, u_v[10]);
    return mix(texture(u_t3, uv0), texture(u_t2, uv1), f) * v_color.a;
  }
  if (kind == 8) return glassAt() * v_color.a;
  if (kind == 9) {
    // A NOISE paint: Figma's noise (seed 0) over the node's space from its centre ÷ noiseSize (v_paint0 / 1 rows);
    // v_paint1.w = the type, + 4 when supersampled (noiseSize ≤ 1: 2 × 2 samples a pixel).
    vec2 g = vec2(dot(v_paint0.xy, local) + v_paint0.z, dot(v_paint1.xy, local) + v_paint1.z);
    int code = int(v_paint1.w + 0.5);
    if (code < 4) return figmaNoise(g, 0.0, v_paint0.w, code, v_color, vec4(0.0));
    vec2 gx = dFdx(g) * 0.25, gy = dFdy(g) * 0.25;
    return 0.25 * (figmaNoise(g - gx - gy, 0.0, v_paint0.w, code & 3, v_color, vec4(0.0)) +
                   figmaNoise(g + gx - gy, 0.0, v_paint0.w, code & 3, v_color, vec4(0.0)) +
                   figmaNoise(g - gx + gy, 0.0, v_paint0.w, code & 3, v_color, vec4(0.0)) +
                   figmaNoise(g + gx + gy, 0.0, v_paint0.w, code & 3, v_color, vec4(0.0)));
  }
  if (kind == 6) {
    vec2 uv = slotUv((gl_FragCoord.xy - u_v[4].xy) / u_v[4].zw, u_v[9]);
    return texture(u_t2, uv) * v_color.a;
  }
  vec2 g = vec2(dot(v_paint0.xy, local) + v_paint0.z, dot(v_paint1.xy, local) + v_paint1.z);
  vec4 c;
  if (kind == 5) {
    bool repeat = v_paint0.w > 0.5;
    if (!repeat && (g.x < 0.0 || g.y < 0.0 || g.x > 1.0 || g.y > 1.0)) return vec4(0.0);
    // Mip level one finer than the footprint (LOD bias −1): Figma's zoomed-out images are about three times as
    // sharp as plain trilinear filtering (audit 2026-10-08 #8, high-frequency energy 1.42 vs 0.48).
    c = textureGrad(u_t2, repeat ? fract(g) : g, dFdx(g) * 0.5, dFdy(g) * 0.5);
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
    // Dithered against banding as Figma's gradients are (after the paint's opacity).
    return figDither(rampAt(t, v_paint1.w) * v_color.a);
  }
  return c * v_color.a;
}
)";


// ---- Curves and clips: shared by Draw and Composite ------------------------------
// The path coverage (Draw's paths; a clip path in both), read from CURVES (Draw: u_t0, Composite: u_t3).
inline constexpr const char* kCurveFunctions = R"(
vec4 texel(int i) { return texelFetch(CURVES, ivec2(i & 2047, i >> 11), 0); }

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

)";

// A clip, anti-aliased, at canvas device px `dp` (pixel centres): what a clipping frame lets through.
// - The clip rectangle (x0 y0 x1 y1, canvas device px, fractional): the pixel's area inside it (a box filter), so a
//   frame's square edge clips at its exact place, partly covering the pixels it crosses.
// - The clip shape (slots 12–15; slot 12.w = 0: none): a turned or smoothed frame's, or a second rounded one —
//   slot 12 = (a, b, c, kind), 13 = (d, e, f, first curve texel): canvas device px → the shape's own space
//   (x = a·dp.x + b·dp.y + c, y = d·dp.x + e·dp.y + f); kind 1 = a rounded box (14 = size, 15 = radii tl tr br bl),
//   2 = a path (NONZERO), 3 = a path (ODD). Its coverage multiplies.
inline constexpr const char* kClipFunctions = R"(
float clipRectCoverage(vec2 dp, vec4 r) {
  vec2 lo = max(dp - 0.5, r.xy), hi = min(dp + 0.5, r.zw);
  vec2 c = clamp(hi - lo, 0.0, 1.0);
  return c.x * c.y;
}
float sdClipBox(vec2 p, vec2 b, vec4 r) {
  float rr = p.x > 0.0 ? (p.y > 0.0 ? r.z : r.y) : (p.y > 0.0 ? r.w : r.x);
  rr = clamp(rr, 0.0, min(b.x, b.y));
  vec2 q = abs(p) - b + rr;
  return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - rr;
}
float shapeClip(vec2 dp) {
  vec4 A = u_v[12];
  if (A.w < 0.5) return 1.0;
  vec4 B = u_v[13];
  vec2 l = vec2(dot(A.xyz, vec3(dp, 1.0)), dot(B.xyz, vec3(dp, 1.0)));
  if (A.w < 1.5) {
    float px = max(0.5 * (length(vec2(A.x, B.x)) + length(vec2(A.y, B.y))), 1e-6);
    vec2 h = u_v[14].xy * 0.5;
    return clamp(0.5 - sdClipBox(l - h, h, u_v[15]) / px, 0.0, 1.0);
  }
  vec2 ppe = 1.0 / max(vec2(length(A.xy), length(B.xy)), vec2(1e-12));
  return coverage(int(B.w + 0.5), l, ppe, A.w > 2.5);
}

// Effects' node space: slots 16–17 map canvas device px to it ((a b c ·), (d e f ·)).
vec2 effectSpace(vec2 dp) { return vec2(dot(u_v[16].xyz, vec3(dp, 1.0)), dot(u_v[17].xyz, vec3(dp, 1.0))); }
// A progressive blur's place between its start (0) and its end (1): slot 18 = (start x, y, end x, y) in the node's
// box (0..1), effectSpace being that box.
float progressT(vec2 dp) {
  vec2 u = effectSpace(dp), s = u_v[18].xy, d = u_v[18].zw - s;
  return clamp(dot(u - s, d) / max(dot(d, d), 1e-12), 0.0, 1.0);
}
// Noise and texture: Figma's gradient noise (docs/research/rea/effects.md §2.17, §2.19) — a lattice of pseudo-random
// unit gradients (sine hashes of the cell and the octave's seed), Perlin's smoothstep interpolation, three octaves
// summed (frequency ×2, amplitude ÷2 each). `p` is node space relative to the node's centre, times the frequency
// (1 / noiseSize); the result is signed, about −1…1.
float fnCellHash(vec2 cell) {
  float d = mod(dot(cell, vec2(12.9898, 78.233)), 3.14159);
  return fract(sin(d * 2.71828) * 438.5453 + 1.73205);
}
float fnSeedHash(float x) { return fract(sin(x * 91.3458 + 12.345) * 43758.5453); }
float fnWave(vec2 cell, vec2 k, float s) { return 2.0 * (fract(sin(dot(k, cell) * 0.0625) * (s + 312.0)) - 0.5); }
vec2 fnGradient(vec2 cell, float x) {
  float h = fnCellHash(cell);
  vec2 g = vec2(fnWave(cell, vec2(12.42, 78.23) * fnSeedHash(x + 2.6457), x * h * 1.61803 + 18.345),
                fnWave(cell, vec2(-19.98, 31.21) * fnSeedHash(x + 3.6055), x * h * 0.61803 + 21.543));
  return g / max(length(g), 1e-12);
}
float fnGradientNoise(vec2 p, float x) {
  vec2 i = floor(p), f = fract(p);
  vec2 s = f * f * (3.0 - 2.0 * f);
  float a = dot(f, fnGradient(i, x));
  float b = dot(f - vec2(1.0, 0.0), fnGradient(i + vec2(1.0, 0.0), x));
  float c = dot(f - vec2(0.0, 1.0), fnGradient(i + vec2(0.0, 1.0), x));
  float d = dot(f - vec2(1.0, 1.0), fnGradient(i + vec2(1.0, 1.0), x));
  return mix(mix(a, b, s.x), mix(c, d, s.x), s.y);
}
float fnFbm(float seed, vec2 p) {
  float sum = 0.0, amplitude = 1.0;
  for (int octave = 0; octave < 3; octave++) {
    float x = fract(sin(seed * 91.3458 + float(octave) * 57.123 + 12.345) * 43758.5453);
    sum += fnGradientNoise(p, x) / amplitude;
    p *= 2.0;
    amplitude *= 2.0;
  }
  return sum;
}
// A grain shows where v (0..1) falls in a band `density` / 2 wide around 0.25 (the high band: 0.75).
float fnBand(float v, float density, bool high) {
  float lo = 10.0 * ((high ? 0.75 : 0.25) - density / 4.0), hi = lo + 10.0 * (density / 2.0);
  v *= 10.0;
  return step(lo, v) * (1.0 - step(hi, v));
}
// Figma's noise at `p` (node space from the centre × the frequency): type 0 Multi (every channel its own noise; the
// alpha color.a), 1 Mono (the colour where the noise's luminance is in the band), 2 Duo (`second` in the low band,
// the colour in the high one). Colours premultiplied; the result premultiplied, before the source's alpha.
vec4 figmaNoise(vec2 p, float seed, float density, int type, vec4 color, vec4 second) {
  vec3 v = vec3(fnFbm(seed, p), fnFbm(seed + 1.0, p), fnFbm(seed + 2.0, p)) * 0.5 + 0.5;
  if (type == 0) {
    float a = fnBand(fnFbm(seed + 3.0, p) * 0.5 + 0.5, density, false) * color.a;
    return vec4(clamp(2.0 * v - 0.5, 0.0, 1.0) * a, a);
  }
  float l = 0.213 * v.r + 0.715 * v.g + 0.072 * v.b;
  if (type == 1) return color * fnBand(l, density, false);
  if (fnBand(l, density, false) > 0.5) return second;
  return color * fnBand(l, density, true);
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
uniform vec4 u_v[20];
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
    float grow = kind == 2 ? a_geom.x : (kind == 3 ? 0.0 : a_geom.y);  // a drop shadow: its blur radius
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
uniform vec4 u_v[20];
uniform int u_stencilPass;
uniform sampler2D u_t0;
uniform sampler2D u_t3;
out vec4 o_color;
#define CURVES u_t0
// The fragment's canvas device px. For glass: the shape (-1 none — a path —, 0 a rounded rectangle, 1 an ellipse), its
// signed distance in its own units (< 0 inside) and the map from its own units to gl_FragCoord px.
vec2 g_dp;
int g_glassShape = -1;
float g_dist = 0.0;
mat2 g_toFrag = mat2(1.0);
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

// The blurred rounded rectangle with Figma's kernel (docs/research/rea/effects.md §2.4): the tent of half-width R,
// closed-form along x (its CDF, g), 4 samples along y weighted by the tent (Evan Wallace's scheme otherwise).
// The tent's CDF on [−1, 1] (h in units of R).
float tentCdf(float h) {
  if (h < -1.0) return 0.0;
  if (h < 0.0) return 0.5 * (h + 1.0) * (h + 1.0);
  if (h < 1.0) return 1.0 - 0.5 * (1.0 - h) * (1.0 - h);
  return 1.0;
}
float shadowX(float x, float y, float R, float corner, vec2 halfSize) {
  float delta = min(halfSize.y - corner - abs(y), 0.0);
  float curved = halfSize.x - corner + sqrt(max(0.0, corner * corner - delta * delta));
  return tentCdf((x + curved) / R) - tentCdf((x - curved) / R);
}
// The shadow of the box [lo, hi] with corner radii r (tl tr br bl) at p, blurred by radius R; px = a pixel.
float boxShadow(vec2 lo, vec2 hi, vec4 r, vec2 p, float R, float px) {
  vec2 c = (lo + hi) * 0.5, h = max((hi - lo) * 0.5, vec2(0.0));
  vec2 q = p - c;
  float corner = q.x > 0.0 ? (q.y > 0.0 ? r.z : r.y) : (q.y > 0.0 ? r.w : r.x);
  corner = clamp(corner, 0.0, min(h.x, h.y));
  if (R < 0.1 * px) return clamp(0.5 - sdRoundedBox(q, h, vec4(corner)) / px, 0.0, 1.0);
  // A square corner: the tent is separable, (g(x0) − g(x1))(g(y0) − g(y1)) exactly.
  if (corner <= 0.0) return (tentCdf((q.x + h.x) / R) - tentCdf((q.x - h.x) / R)) * (tentCdf((q.y + h.y) / R) - tentCdf((q.y - h.y) / R));
  float low = q.y - h.y, high = q.y + h.y;
  float start = clamp(-R, low, high), end = clamp(R, low, high);
  float step = (end - start) / 4.0;
  float y = start + step * 0.5, value = 0.0;
  for (int i = 0; i < 4; i++) {
    value += shadowX(q.x, q.y - y, R, corner, h) * max(0.0, 1.0 - abs(y) / R) / R * step;
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
    o_color = figDither(v_color * a);
    return;
  }
  float d = kind == 1 ? sdEllipse(p, halfSize) : sdRoundedBox(p, halfSize, v_box);
  float fillCoverage = clamp(0.5 - d / px, 0.0, 1.0);
  g_glassShape = kind == 1 ? 1 : 0;
  g_dist = d;
  g_toFrag = inverse(mat2(dFdx(v_local), dFdy(v_local)));
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
  g_dp = dp;
  float clipCoverage = clipRectCoverage(dp, v_clip);
  if (clipCoverage <= 0.0) discard;
  clipCoverage *= roundClip(dp) * shapeClip(dp);
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
// the blurred alpha)), 5 progressive blur (one interval between two blurred copies), 6 noise (within the source's
// alpha), 7 texture (the source read through Figma's noise displacement). Modes 5–7 read slots 16–19
// (kClipFunctions' effectSpace, progressT, figmaNoise, fnFbm; noiseAt, textureShift). Blend modes other than NORMAL read the backdrop and write the
// result (Blend::Replace).
inline constexpr const char* kCompositeVertex = R"(#version 300 es
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

inline constexpr const char* kCompositeFragmentHead = R"(#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
in vec2 v_dev;
uniform vec4 u_v[20];
uniform sampler2D u_t0;
uniform sampler2D u_t1;
uniform sampler2D u_t2;
uniform sampler2D u_t3;
out vec4 o_color;
#define CURVES u_t3
)";

inline constexpr const char* kCompositeFragmentBody = R"(

vec4 at(sampler2D t, vec4 map, vec2 d) {
  vec2 sz = vec2(textureSize(t, 0));
  vec2 q = (d - map.xy) * map.w;
  if (q.x < 0.0 || q.y < 0.0 || q.y > map.z) return vec4(0.0);
  return texture(t, vec2(q.x / sz.x, (map.z - q.y) / sz.y));
}

// Noise (slots 16–17: canvas device px → the node's space from its centre; 18 = (noiseSize x, y, density, type: 0
// Multi, 1 Mono, 2 Duo, + 4 supersampled — noiseSize ≤ 1: 2 × 2 samples a pixel); 6 = the colour (Multi: its alpha the
// effect's opacity), 19 = the second colour (premultiplied); 8.x = the seed).
vec4 noiseAt(vec2 dp) {
  vec4 P = u_v[18];
  vec2 frequency = 1.0 / max(P.xy, vec2(1e-3));
  int code = int(P.w + 0.5);
  if (code < 4) return figmaNoise(effectSpace(dp) * frequency, u_v[8].x, P.z, code, u_v[6], u_v[19]);
  vec4 sum = vec4(0.0);
  for (int k = 0; k < 4; k++) {
    vec2 o = vec2(float(k & 1), float(k >> 1)) * 0.5 - 0.25;
    sum += figmaNoise(effectSpace(dp + o) * frequency, u_v[8].x, P.z, code & 3, u_v[6], u_v[19]);
  }
  return sum * 0.25;
}
// Texture (slot 18 = (noiseSize x, y, radius in node units, clip to shape); 19 = the node's space → canvas device px,
// its linear part (a b c d: x' = a x + b y, y' = c x + d y); 8.x = the seed): Figma's displacement — two noises (seed,
// seed + 1) times the radius, in the node's space — in canvas device px.
vec2 textureShift(vec2 dp) {
  vec2 q = effectSpace(dp) / max(u_v[18].xy, vec2(1e-3));
  vec2 d = vec2(fnFbm(u_v[8].x, q), fnFbm(u_v[8].x + 1.0, q)) * u_v[18].z;
  return vec2(dot(u_v[19].xy, d), dot(u_v[19].zw, d));
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
// COLOR_DODGE / COLOR_BURN with Figma's epsilon of 1/255 (its blend-mode shader) in place of exact 0 / 1 tests.
float colorDodge(float b, float s) { return b < 0.003922 ? 0.0 : min(1.0, b / max(1.0 - s, 0.003922)); }
float colorBurn(float b, float s) { return 1.0 - b < 0.003922 ? 1.0 : 1.0 - min(1.0, (1.0 - b) / max(s, 0.003922)); }

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

// The rounded clip the layer lands in (slots 9: x0 y0 x1 y1, 10: radii; canvas device px; x1 < x0: none); slot 11:
// the clip rectangle (x1 ≤ x0: none), 12–15: the clip shape (kClipFunctions).
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
  float cov = u_v[11].z > u_v[11].x ? clipRectCoverage(v_dev, u_v[11]) : 1.0;
  if (cov <= 0.0) discard;
  cov *= roundClip(v_dev) * shapeClip(v_dev);
  if (cov <= 0.0) discard;
  if (mode == 5) {
    // A progressive layer blur, one interval of it (slot 19 = (the radius at the start, at the end, the interval's lower and
    // upper radius)): the layer between its copies at the two (u_t0, u_t1); pixels whose radius is elsewhere are another's.
    vec4 P = u_v[19];
    float s = mix(P.x, P.y, progressT(v_dev));
    if (s < P.z || s >= P.w) discard;
    float f = clamp((s - P.z) / max(P.w - P.z, 1e-6), 0.0, 1.0);
    c = mix(at(u_t0, u_v[3], v_dev), at(u_t1, u_v[4], v_dev), f);
  } else if (mode == 6) {
    // Noise over the layer (its alpha).
    c = noiseAt(v_dev) * at(u_t0, u_v[3], v_dev).a;
  } else if (mode == 7) {
    // Texture: the layer read through Figma's displacement. Clipped to the shape: the displacement scaled by
    // (source α · displaced α)^0.2, and the pixel kept where either is transparent (the silhouette stays).
    vec2 d = textureShift(v_dev);
    if (u_v[18].w < 0.5) {
      c = at(u_t0, u_v[3], v_dev + d);
    } else {
      vec4 src = at(u_t0, u_v[3], v_dev);
      float k = pow(src.a, 0.2) * pow(at(u_t0, u_v[3], v_dev + d).a, 0.2);
      vec4 moved = at(u_t0, u_v[3], v_dev + d * k);
      c = src.a > 0.0 && moved.a > 0.0 ? moved : src;
    }
  } else if (mode == 3) {
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

// ---- Blur: separable tent, dilate, erode -----------------------------------------
// A quad over the whole viewport; the source texture has the target's layout. Slots: 2 = (direction x, y in
// texels, the blur's radius in texels, mode: 0 tent, 1 dilate, 2 erode, 3 tent clamped to a box), 3 = (radius in
// texels for dilate / erode), 9 = the backdrop's slot in the atlas (texels, x0, y0, x1, y1 as gl_FragCoord counts;
// x1 <= x0: none): tent taps past it read its border, which holds what lies past it (2026-10-20: the margin past a
// big blur's reach is not stored).
// Figma's blur (docs/research/rea/effects.md §2.1): a tent of half-width R — tap weights R − |i| — one pass per
// axis, two adjacent taps read by one bilinear fetch; at most 64 taps a side (the renderer halves the layer first).
// Clamped (a background blur, §2.11; Figma's CLAMPED_BLUR_TILE_NODE_SPACE): slots 4–5 map the target's pixels
// (gl_FragCoord) to the node's space, 6 = the box there (x0, y0, x1, y1), 7–8 map the node's space back. The centre
// is clamped into the box and every tap outside it weighs 0 (the rest renormalised), so nothing outside the box
// reaches the blur.
inline constexpr const char* kBlurVertex = R"(#version 300 es
void main() {
  int id = gl_VertexID;
  vec2 corner = vec2((id == 1 || id == 2 || id == 4) ? 1.0 : 0.0, (id == 2 || id == 4 || id == 5) ? 1.0 : 0.0);
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}
)";

inline constexpr const char* kBlurFragment = R"(#version 300 es
precision highp float;
uniform vec4 u_v[20];
uniform sampler2D u_t0;
out vec4 o_color;
vec2 slot(vec2 uv, vec2 sz) {
  vec4 b = u_v[9];
  return b.z > b.x ? clamp(uv, (b.xy + 0.5) / sz, (b.zw - 0.5) / sz) : uv;
}
void main() {
  vec2 sz = vec2(textureSize(u_t0, 0));
  vec2 uv = gl_FragCoord.xy / sz;
  vec2 dir = u_v[2].xy / sz;
  int mode = int(u_v[2].w + 0.5);
  if (mode == 0) {
    float R = clamp(u_v[2].z, 1e-3, 64.0);
    vec4 sum = texture(u_t0, uv) * R;
    float total = R;
    for (int i = 1; i <= 64; i += 2) {
      float w1 = max(R - float(i), 0.0), w2 = max(R - float(i + 1), 0.0), w = w1 + w2;
      if (w <= 0.0) break;
      vec2 o = dir * (float(i) + w2 / w);
      sum += (texture(u_t0, slot(uv + o, sz)) + texture(u_t0, slot(uv - o, sz))) * w;
      total += 2.0 * w;
    }
    vec4 c = sum / total;
    // Dithered (±½ of an 8-bit step of its alpha) against banding in the falloff.
    float d = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    o_color = c.a > 0.0 ? c * (max(c.a + (d - 0.5) / 255.0, 0.0) / c.a) : c;
    return;
  }
  if (mode == 3) {
    float R = clamp(u_v[2].z, 1e-3, 64.0);
    vec4 B = u_v[6];
    vec2 n = vec2(dot(u_v[4].xyz, vec3(gl_FragCoord.xy, 1.0)), dot(u_v[5].xyz, vec3(gl_FragCoord.xy, 1.0)));
    vec2 nc = clamp(n, B.xy, B.zw);
    vec2 p = vec2(dot(u_v[7].xyz, vec3(nc, 1.0)), dot(u_v[8].xyz, vec3(nc, 1.0)));  // the centre, in the target's px
    vec2 step1 = vec2(dot(u_v[4].xy, u_v[2].xy), dot(u_v[5].xy, u_v[2].xy));      // one tap, in the node's space
    vec4 sum = texture(u_t0, slot(p / sz, sz)) * R;
    float total = R;
    // Taps i and i + 1 on each side, the ones inside the box read by one bilinear fetch between them (Figma's).
    for (int i = 1; i < 64; i += 2) {
      float k = float(i), l = min(k + 1.0, R);
      if (k > R) break;
      for (int side = -1; side <= 1; side += 2) {
        float s = float(side);
        vec2 qk = nc + step1 * (s * k), ql = nc + step1 * (s * l);
        float wk = qk == clamp(qk, B.xy, B.zw) ? R - k : 0.0;
        float wl = ql == clamp(ql, B.xy, B.zw) ? R - l : 0.0;
        float w = wk + wl;
        if (w <= 0.0) continue;
        sum += texture(u_t0, slot((p + u_v[2].xy * (s * (k * wk + l * wl) / w)) / sz, sz)) * w;
        total += w;
      }
    }
    vec4 c = sum / total;
    float d = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    o_color = c.a > 0.0 ? c * (max(c.a + (d - 0.5) / 255.0, 0.0) / c.a) : c;
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
