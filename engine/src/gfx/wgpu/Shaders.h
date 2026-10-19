// The built-in shaders in WGSL (WebGPU): the same programs as gfx/gl/Shaders.h, line for line, so both backends
// draw the same pixels. Interim: translated by hand until tools/shadergen generates both from one source (Figma
// keeps GLSL as the source and generates WGSL with naga, docs/research/figma/R10-webgpu.md).
//
// Uniforms: `u.v[0..19]` are gfx::DrawCall::uniforms (the GLSL `u_v[20]`); the device appends `u.v[20]` = (y sign,
// the framebuffer's height in px, stencil pass, 0). WebGPU's framebuffer y runs down where GL's runs up: offscreen
// targets are drawn with clip y negated (y sign −1), so a target's rows sit in memory as GL leaves them (bottom row
// first) and every texture read, copy and scissor means the same thing on both backends; the canvas is drawn
// unflipped (y sign +1, it is shown top row first). `glFragCoord()` rebuilds GL's gl_FragCoord from either.
// Textures: GL's u_t0 / u_t1 / u_t2 are t0 / t1 / t2, each filtered one with its sampler s0 / s1 / s2.
#pragma once

namespace eng::gfx::wgsl {

inline constexpr const char* kCommon = R"(
diagnostic(off, derivative_uniformity);

struct Uniforms { v: array<vec4f, 21> };
@group(0) @binding(0) var<uniform> u: Uniforms;

// GL's gl_FragCoord.xy (origin bottom left of the framebuffer) from WebGPU's position (origin top left).
fn glFragCoord(p: vec4f) -> vec2f {
  return vec2f(p.x, select(u.v[20].y - p.y, p.y, u.v[20].x < 0.0));
}
// GL's clip position from the draw's: y negated on offscreen targets (see the header).
fn clipOut(x: f32, y: f32) -> vec4f {
  return vec4f(x, y * u.v[20].x, 0.0, 1.0);
}
fn quadCorner(id: u32) -> vec2f {
  return vec2f(select(0.0, 1.0, id == 1u || id == 2u || id == 4u), select(0.0, 1.0, id == 2u || id == 4u || id == 5u));
}
fn glMod(x: f32, y: f32) -> f32 { return x - y * floor(x / y); }
)";


// ---- Curves and clips, shared by Draw and Composite (gl/Shaders.h kCurveFunctions, kClipFunctions); CURVES is
// replaced by the program's curve texture (Draw: t0, Composite: t3) ----
inline constexpr const char* kCurveFunctions = R"(
fn texel(i: i32) -> vec4f { return textureLoad(CURVES, vec2i(i & 2047, i >> 11u), 0); }

fn crossX(p0: vec2f, p1: vec2f, p2: vec2f, ppe: f32, cov: ptr<function, f32>, wgt: ptr<function, f32>) {
  let code = (0x2E74u >> (select(0u, 2u, p0.y > 0.0) + select(0u, 4u, p1.y > 0.0) + select(0u, 8u, p2.y > 0.0))) & 3u;
  if (code == 0u) { return; }
  let ay = p0.y - 2.0 * p1.y + p2.y;
  let by = p0.y - p1.y;
  let ax = p0.x - 2.0 * p1.x + p2.x;
  let bx = p0.x - p1.x;
  var t1v: f32;
  var t2v: f32;
  if (abs(ay) < 1e-5 * max(abs(by), 1e-30) || abs(ay) < 1e-12) {
    t1v = p0.y / (2.0 * by);
    t2v = t1v;
  } else {
    let d = sqrt(max(by * by - ay * p0.y, 0.0));
    t1v = (by - d) / ay;
    t2v = (by + d) / ay;
  }
  let x1 = (ax * t1v - 2.0 * bx) * t1v + p0.x;
  let x2 = (ax * t2v - 2.0 * bx) * t2v + p0.x;
  if ((code & 1u) != 0u) {
    *cov += clamp(x1 * ppe + 0.5, 0.0, 1.0);
    *wgt = max(*wgt, clamp(1.0 - abs(x1 * ppe) * 2.0, 0.0, 1.0));
  }
  if (code > 1u) {
    *cov -= clamp(x2 * ppe + 0.5, 0.0, 1.0);
    *wgt = max(*wgt, clamp(1.0 - abs(x2 * ppe) * 2.0, 0.0, 1.0));
  }
}

fn fold(w: f32, evenOdd: bool) -> f32 { return select(min(abs(w), 1.0), 1.0 - abs(glMod(w, 2.0) - 1.0), evenOdd); }

fn coverage(start: i32, p: vec2f, ppe: vec2f, evenOdd: bool) -> f32 {
  let h = texel(start);
  let b = texel(start + 1);
  let nH = i32(h.x);
  let nV = i32(h.y);
  let size = max(b.zw - b.xy, vec2f(1e-20));
  let bh = clamp(i32(floor((p.y - b.y) / size.y * f32(nH))), 0, nH - 1);
  let bv = clamp(i32(floor((p.x - b.x) / size.x * f32(nV))), 0, nV - 1);
  let dh = texel(start + 2 + bh);
  let dv = texel(start + 2 + nH + bv);
  var hc = 0.0;
  var hw = 0.0;
  var vc = 0.0;
  var vw = 0.0;
  var first = i32(dh.x);
  var count = i32(dh.y);
  for (var k = 0; k < count; k++) {
    let ci = i32(texel(first + (k >> 2u))[k & 3]);
    let a = texel(ci);
    let c = texel(ci + 1);
    if ((c.z - p.x) * ppe.x < -0.5) { break; }
    crossX(a.xy - p, a.zw - p, c.xy - p, ppe.x, &hc, &hw);
  }
  first = i32(dv.x);
  count = i32(dv.y);
  for (var k = 0; k < count; k++) {
    let ci = i32(texel(first + (k >> 2u))[k & 3]);
    let a = texel(ci);
    let c = texel(ci + 1);
    if ((c.w - p.y) * ppe.y < -0.5) { break; }
    crossX((a.xy - p).yx, (a.zw - p).yx, (c.xy - p).yx, ppe.y, &vc, &vw);
  }
  let ch = fold(hc, evenOdd);
  let cv = fold(vc, evenOdd);
  return clamp(max((ch * hw + cv * vw) / max(hw + vw, 1.0 / 65536.0), min(ch, cv)), 0.0, 1.0);
}

)";

inline constexpr const char* kClipFunctions = R"(
fn clipRectCoverage(dp: vec2f, r: vec4f) -> f32 {
  let lo = max(dp - 0.5, r.xy);
  let hi = min(dp + 0.5, r.zw);
  let c = clamp(hi - lo, vec2f(0.0), vec2f(1.0));
  return c.x * c.y;
}
fn sdClipBox(p: vec2f, b: vec2f, r: vec4f) -> f32 {
  var rr = select(select(r.x, r.w, p.y > 0.0), select(r.y, r.z, p.y > 0.0), p.x > 0.0);
  rr = clamp(rr, 0.0, min(b.x, b.y));
  let q = abs(p) - b + rr;
  return min(max(q.x, q.y), 0.0) + length(max(q, vec2f(0.0))) - rr;
}
fn shapeClip(dp: vec2f) -> f32 {
  let A = u.v[12];
  if (A.w < 0.5) { return 1.0; }
  let B = u.v[13];
  let l = vec2f(dot(A.xyz, vec3f(dp, 1.0)), dot(B.xyz, vec3f(dp, 1.0)));
  if (A.w < 1.5) {
    let px = max(0.5 * (length(vec2f(A.x, B.x)) + length(vec2f(A.y, B.y))), 1e-6);
    let h = u.v[14].xy * 0.5;
    return clamp(0.5 - sdClipBox(l - h, h, u.v[15]) / px, 0.0, 1.0);
  }
  let ppe = 1.0 / max(vec2f(length(A.xy), length(B.xy)), vec2f(1e-12));
  return coverage(i32(B.w + 0.5), l, ppe, A.w > 2.5);
}

fn effectSpace(dp: vec2f) -> vec2f { return vec2f(dot(u.v[16].xyz, vec3f(dp, 1.0)), dot(u.v[17].xyz, vec3f(dp, 1.0))); }
fn progressT(dp: vec2f) -> f32 {
  let uu = effectSpace(dp);
  let s = u.v[18].xy;
  let d = u.v[18].zw - s;
  return clamp(dot(uu - s, d) / max(dot(d, d), 1e-12), 0.0, 1.0);
}
// Figma's gradient noise (gl/Shaders.h fnFbm, figmaNoise).
fn fnCellHash(cell: vec2f) -> f32 {
  let d = glMod(dot(cell, vec2f(12.9898, 78.233)), 3.14159);
  return fract(sin(d * 2.71828) * 438.5453 + 1.73205);
}
fn fnSeedHash(x: f32) -> f32 { return fract(sin(x * 91.3458 + 12.345) * 43758.5453); }
fn fnWave(cell: vec2f, k: vec2f, s: f32) -> f32 { return 2.0 * (fract(sin(dot(k, cell) * 0.0625) * (s + 312.0)) - 0.5); }
fn fnGradient(cell: vec2f, x: f32) -> vec2f {
  let h = fnCellHash(cell);
  let g = vec2f(fnWave(cell, vec2f(12.42, 78.23) * fnSeedHash(x + 2.6457), x * h * 1.61803 + 18.345),
                fnWave(cell, vec2f(-19.98, 31.21) * fnSeedHash(x + 3.6055), x * h * 0.61803 + 21.543));
  return g / max(length(g), 1e-12);
}
fn fnGradientNoise(p: vec2f, x: f32) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let s = f * f * (3.0 - 2.0 * f);
  let a = dot(f, fnGradient(i, x));
  let b = dot(f - vec2f(1.0, 0.0), fnGradient(i + vec2f(1.0, 0.0), x));
  let c = dot(f - vec2f(0.0, 1.0), fnGradient(i + vec2f(0.0, 1.0), x));
  let d = dot(f - vec2f(1.0, 1.0), fnGradient(i + vec2f(1.0, 1.0), x));
  return mix(mix(a, b, s.x), mix(c, d, s.x), s.y);
}
fn fnFbm(seed: f32, p0: vec2f) -> f32 {
  var sum = 0.0;
  var amplitude = 1.0;
  var p = p0;
  for (var octave = 0; octave < 3; octave++) {
    let x = fract(sin(seed * 91.3458 + f32(octave) * 57.123 + 12.345) * 43758.5453);
    sum += fnGradientNoise(p, x) / amplitude;
    p *= 2.0;
    amplitude *= 2.0;
  }
  return sum;
}
fn fnBand(v0: f32, density: f32, high: bool) -> f32 {
  let lo = 10.0 * (select(0.25, 0.75, high) - density / 4.0);
  let hi = lo + 10.0 * (density / 2.0);
  let v = v0 * 10.0;
  return step(lo, v) * (1.0 - step(hi, v));
}
fn figmaNoise(p: vec2f, seed: f32, density: f32, kind: i32, color: vec4f, second: vec4f) -> vec4f {
  let v = vec3f(fnFbm(seed, p), fnFbm(seed + 1.0, p), fnFbm(seed + 2.0, p)) * 0.5 + 0.5;
  if (kind == 0) {
    let a = fnBand(fnFbm(seed + 3.0, p) * 0.5 + 0.5, density, false) * color.a;
    return vec4f(clamp(2.0 * v - 0.5, vec3f(0.0), vec3f(1.0)) * a, a);
  }
  let l = 0.213 * v.r + 0.715 * v.g + 0.072 * v.b;
  if (kind == 1) { return color * fnBand(l, density, false); }
  if (fnBand(l, density, false) > 0.5) { return second; }
  return color * fnBand(l, density, true);
}
)";

// ---- Draw: shapes, paths and glyphs in one program (gl/Shaders.h kDrawVertex, kPaintFunctions, kDrawFragment*) ----
inline constexpr const char* kDraw = R"(
@group(1) @binding(0) var t0: texture_2d<f32>;
@group(1) @binding(1) var t1: texture_2d<f32>;
@group(1) @binding(2) var s1: sampler;
@group(1) @binding(3) var t2: texture_2d<f32>;
@group(1) @binding(4) var s2: sampler;
@group(1) @binding(5) var t3: texture_2d<f32>;
@group(1) @binding(6) var s3: sampler;

struct VIn {
  @builtin(vertex_index) id: u32,
  @location(0) a_linear: vec4f,
  @location(1) a_origin: vec4f,
  @location(2) a_box: vec4f,
  @location(3) a_geom: vec4f,
  @location(4) a_color: vec4f,
  @location(5) a_paint0: vec4f,
  @location(6) a_paint1: vec4f,
  @location(7) a_clip: vec4f,
  @location(8) a_round: vec4f,
  @location(9) a_radii: vec4f,
};

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) local: vec2f,
  @location(1) @interpolate(flat) origin: vec4f,
  @location(2) @interpolate(flat) box: vec4f,
  @location(3) @interpolate(flat) geom: vec4f,
  @location(4) @interpolate(flat) color: vec4f,
  @location(5) @interpolate(flat) paint0: vec4f,
  @location(6) @interpolate(flat) paint1: vec4f,
  @location(7) @interpolate(flat) clip: vec4f,
  @location(8) @interpolate(flat) round: vec4f,
  @location(9) @interpolate(flat) radii: vec4f,
};

@vertex fn vs(a: VIn) -> VOut {
  let corner = quadCorner(a.id);
  let sx = max(length(a.a_linear.xy), 1e-6);
  let sy = max(length(a.a_linear.zw), 1e-6);
  let kind = i32(a.a_geom.z + 0.5);
  var local: vec2f;
  if (kind == 4) {
    let pad = vec2f(1.5 / sx, 1.5 / sy);
    local = mix(a.a_box.xy - pad, a.a_box.zw + pad, corner);
  } else {
    let size = a.a_origin.zw;
    let grow = select(select(a.a_geom.y, 0.0, kind == 3), a.a_geom.x, kind == 2);  // a drop shadow: its blur radius
    let pad = vec2f(grow) + vec2f(2.0 / sx, 2.0 / sy);
    local = mix(-pad, size + pad, corner);
  }
  let p = mat2x2f(a.a_linear.xy, a.a_linear.zw) * local + a.a_origin.xy;
  var o: VOut;
  o.pos = clipOut(dot(u.v[0].xyz, vec3f(p, 1.0)), dot(u.v[1].xyz, vec3f(p, 1.0)));
  o.local = local;
  o.origin = a.a_origin;
  o.box = a.a_box;
  o.geom = a.a_geom;
  o.color = a.a_color;
  o.paint0 = a.a_paint0;
  o.paint1 = a.a_paint1;
  o.clip = a.a_clip;
  o.round = a.a_round;
  o.radii = a.a_radii;
  return o;
}

// The varyings and gl_FragCoord, as the GLSL reads them.
var<private> v_local: vec2f;
var<private> v_origin: vec4f;
var<private> v_box: vec4f;
var<private> v_geom: vec4f;
var<private> v_color: vec4f;
var<private> v_paint0: vec4f;
var<private> v_paint1: vec4f;
var<private> v_clip: vec4f;
var<private> v_round: vec4f;
var<private> v_radii: vec4f;
var<private> fragCoord: vec2f;
var<private> o_color: vec4f;
var<private> g_dp: vec2f;
// For glass (gl/Shaders.h): the shape (-1 a path, 0 a rounded rectangle, 1 an ellipse), its signed distance in its own
// units, the map from its own units to fragCoord px.
var<private> g_glassShape: i32 = -1;
var<private> g_dist: f32 = 0.0;
var<private> g_toFrag: mat2x2f = mat2x2f(1.0, 0.0, 0.0, 1.0);

fn stencilPass() -> bool { return u.v[20].z > 0.5; }

// ---- The paint (kPaintFunctions) ----
fn rampAt(t: f32, row: f32) -> vec4f {
  let sz = vec2f(textureDimensions(t1, 0));
  return textureSampleLevel(t1, s1, vec2f((clamp(t, 0.0, 1.0) * 255.0 + 0.5) / sz.x, (row + 0.5) / sz.y), 0.0);
}

fn luma(c: vec3f) -> f32 { return dot(c, vec3f(0.2126, 0.7152, 0.0722)); }

// Figma's image adjustments (gl/Shaders.h adjust).
fn adjShadowsHighlights(c: vec3f, shadows: f32, highlights: f32) -> f32 {
  let i = luma(c) - pow(0.5, 2.2);
  return 0.75 * i / sqrt(1.0 + 4.0 * i * i) * select(-shadows * 0.999, highlights, i > 0.0);
}
fn adjExposure(c0: vec3f, k: f32) -> vec3f {
  let l = pow(10.0, 2.0 * k) - 1.0;
  var n = 1.0 / (1.0 - 0.75) - 1.0;
  var o = luma(c0);
  n *= 1.0 + o * o * min(0.0, k) / (0.2 - min(0.0, k));
  var c = c0 + (o - c0) * 0.75;
  if (k < 0.0) {
    c *= 1.0 + k / 16.0;
    o *= 1.0 + k / 16.0;
  }
  c *= (l + 1.0) / (c * l + 1.0);
  o *= (l + 1.0) / (o * l + 1.0);
  c += (c - o) * n;
  return clamp(c, vec3f(0.0), vec3f(1.0));
}
fn adjSaturation(c: vec3f, q: f32) -> vec3f {
  let o = luma(c);
  if (q <= 0.0) { return c - (o - c) * q; }
  let lo = o / (o - min(min(c.r, c.g), c.b) + 1e-6);
  let hi = (1.0 - o) / (max(max(c.r, c.g), c.b) - o + 1e-6);
  let k = min(mix(1.0, min(lo, hi), q), 2.0);
  return c + (o - c) * (1.0 - k);
}
fn smootherstep(lo: f32, hi: f32, x0: f32) -> f32 {
  let x = clamp((x0 - lo) / (hi - lo), 0.0, 1.0);
  return x * x * x * (x * (x * 6.0 - 15.0) + 10.0);
}
fn adjLab(c: vec3f, temperature: f32, tint: f32, contrast: f32) -> vec3f {
  var xyz = mat3x3f(0.4124564, 0.2126729, 0.0193339, 0.3575761, 0.7151522, 0.1191920, 0.1804375, 0.0721750, 0.9503041) * c;
  xyz = pow(xyz / vec3f(0.95047, 1.0, 1.08883), vec3f(1.0 / 3.0));
  var lab = vec3f(116.0 * xyz.y - 16.0, 500.0 * (xyz.x - xyz.y), 200.0 * (xyz.y - xyz.z));
  lab.y += 30.0 * tint;
  lab.z += 30.0 * temperature;
  let l0 = select(lab.x, (lab.x - 50.0) * 0.2 + 50.0, contrast < 0.0);
  let l1 = select(smootherstep(20.0, 80.0, lab.x) * 100.0, lab.x, contrast < 0.0);
  lab.x = mix(l0, l1, select(contrast, contrast + 1.0, contrast < 0.0));
  let y = (lab.x + 16.0) / 116.0;
  xyz = vec3f(lab.y / 500.0 + y, y, y - lab.z / 200.0);
  xyz = xyz * xyz * xyz * vec3f(0.95047, 1.0, 1.08883);
  let rgb = mat3x3f(3.2404542, -0.9692660, 0.0556434, -1.5371385, 1.8760108, -0.2040259, -0.4985314, 0.0415560, 1.0572252) * xyz;
  return clamp(rgb, vec3f(0.0), vec3f(1.0));
}
fn adjust(c0: vec3f) -> vec3f {
  let a = u.v[2];
  let b = u.v[3];
  var c = pow(c0, vec3f(2.2));
  let offset = adjShadowsHighlights(c, b.z, b.y);
  c = adjLab(c, a.w, b.x, a.y);
  c = adjExposure(c, a.x + offset);
  c = adjSaturation(c, clamp(a.z, -1.0, 1.0));
  return pow(clamp(c, vec3f(0.0), vec3f(1.0)), vec3f(1.0 / 2.2));
}

// Glass as Figma draws it (gl/Shaders.h glassAt): slots 6 = (depth, refraction, dispersion × 0.2, splay), 8 = (the
// light's angle in the node's space, intensity, bevel size, 0), in the node's own units.
fn glassRamp(lo: f32, hi: f32, x: f32) -> f32 { return clamp((x - lo) / max(0.00001, hi - lo), 0.0, 1.0); }
fn glassUnit(v: vec2f) -> vec2f {
  let l = dot(v, v);
  return select(vec2f(0.0), v / sqrt(l), l > 1.0e-10);
}
fn glassNormal(p: vec2f, b: vec2f, r: f32, bevel: f32) -> vec2f {
  if (g_glassShape == 1) { return glassUnit(p / max(b * b, vec2f(1e-6))); }
  let k = min(min(b.x, b.y), r);
  let q = abs(p) - (b - k);
  if (max(q.x, q.y) <= -bevel * step(r, bevel)) { return vec2f(0.0); }
  return glassUnit(q + max(-min(q.x, q.y), 0.0)) * sign(p);
}
fn glassFetch(off: vec2f) -> vec4f {
  return textureSampleLevel(t2, s2, (fragCoord - u.v[4].xy + g_toFrag * off) / u.v[4].zw, 0.0);
}
fn glassAt() -> vec4f {
  if (g_glassShape < 0) { return glassFetch(vec2f(0.0)); }
  let G = u.v[6];
  let L = u.v[8];
  let hs = v_origin.zw * 0.5;
  let p = v_local - hs;
  let corner = select(select(v_box.x, v_box.w, p.y > 0.0), select(v_box.y, v_box.z, p.y > 0.0), p.x > 0.0);
  let rd = min(min(hs.x, hs.y), G.x);
  let bevel = L.z;
  let eh = g_dist;
  let lim = 0.999 * rd;
  let bend = clamp(pow(glassRamp(-rd - bevel, -bevel, eh), 3.5) * rd * G.y, -lim, lim);
  let rim = glassRamp(-bevel - 0.0001, -bevel * 0.3, eh);
  let dir = mix(glassNormal(p, hs, max(corner, max(bevel, rd)), bevel), glassUnit(p), G.w);
  let dg = -dir * mix(bend, G.y * 0.2 * lim, rim);
  var c = vec4f(0.0);
  if (G.z < 0.001) {
    c = glassFetch(dg);
  } else {
    var total = 0.0;
    for (var i = 0; i < 8; i++) {
      let t = f32(i) / 7.0 - 0.5;
      let w = 1.0 - abs(t * 2.0);
      let r = glassFetch(dg * (1.0 + (t + 0.5) * G.z));
      let g = glassFetch(dg * (1.0 + t * G.z));
      let b = glassFetch(dg * (1.0 + (t - 0.5) * G.z));
      c += vec4f(r.r, g.g, b.b, max(max(r.a, g.a), b.a)) * w;
      total += w;
    }
    c /= total;
  }
  let light = vec2f(cos(L.x), sin(L.x));
  let n = glassNormal(p, hs, corner, bevel);
  let lit = smoothstep(-bevel - 0.001, -bevel * 0.2, eh) * L.y;
  var rgb = c.rgb + smoothstep(0.35, 1.0, dot(n, -light)) * lit + smoothstep(0.35, 1.0, dot(n, light)) * lit * 0.6;
  rgb += dot(dir, light) * pow(glassRamp(-rd, -bevel + 0.0001, eh), 2.0) * 0.05 * L.y;
  return vec4f(clamp(rgb, vec3f(0.0), vec3f(c.a)), c.a);
}

// Figma's dither (gl/Shaders.h figDither): ±1/255 on every channel; transparent untouched, opaque keeps its alpha.
fn figDither(c: vec4f) -> vec4f {
  if (c.a == 0.0) { return c; }
  let n = fract(sin(dot(vec2f(12.9898, 78.233), fragCoord)) * 43758.5453);
  let q = min(abs(c + (n - 0.5) * (2.0 / 255.0)), vec4f(1.0));
  return select(vec4f(min(q.rgb, vec3f(q.a)), q.a), vec4f(q.rgb, c.a), c.a == 1.0);  // premultiplied kept valid
}

fn paintAt(local: vec2f, kind: i32) -> vec4f {
  if (kind == 0) { return v_color; }
  if (kind == 7) {
    let P = u.v[19];
    let s = mix(P.x, P.y, progressT(g_dp));
    if (s < P.z || s >= P.w) { return vec4f(0.0); }
    let f = clamp((s - P.z) / max(P.w - P.z, 1e-6), 0.0, 1.0);
    let uv1 = (fragCoord - u.v[4].xy) / u.v[4].zw;
    let uv0 = (fragCoord - u.v[7].xy) / u.v[7].zw;
    return mix(textureSampleLevel(t3, s3, uv0, 0.0), textureSampleLevel(t2, s2, uv1, 0.0), f) * v_color.a;
  }
  if (kind == 8) { return glassAt() * v_color.a; }
  if (kind == 9) {
    let gn = vec2f(dot(v_paint0.xy, local) + v_paint0.z, dot(v_paint1.xy, local) + v_paint1.z);
    let code = i32(v_paint1.w + 0.5);
    if (code < 4) { return figmaNoise(gn, 0.0, v_paint0.w, code, v_color, vec4f(0.0)); }
    let nx = dpdx(gn) * 0.25;
    let ny = dpdy(gn) * 0.25;
    let k = code & 3;
    return 0.25 * (figmaNoise(gn - nx - ny, 0.0, v_paint0.w, k, v_color, vec4f(0.0)) +
                   figmaNoise(gn + nx - ny, 0.0, v_paint0.w, k, v_color, vec4f(0.0)) +
                   figmaNoise(gn - nx + ny, 0.0, v_paint0.w, k, v_color, vec4f(0.0)) +
                   figmaNoise(gn + nx + ny, 0.0, v_paint0.w, k, v_color, vec4f(0.0)));
  }
  if (kind == 6) {
    let uv = (fragCoord - u.v[4].xy) / u.v[4].zw;
    return textureSampleLevel(t2, s2, uv, 0.0) * v_color.a;
  }
  let g = vec2f(dot(v_paint0.xy, local) + v_paint0.z, dot(v_paint1.xy, local) + v_paint1.z);
  let gx = dpdx(g);
  let gy = dpdy(g);
  var c: vec4f;
  if (kind == 5) {
    let repeat = v_paint0.w > 0.5;
    if (!repeat && (g.x < 0.0 || g.y < 0.0 || g.x > 1.0 || g.y > 1.0)) { return vec4f(0.0); }
    c = textureSampleGrad(t2, s2, select(g, fract(g), repeat), gx * 0.5, gy * 0.5);  // LOD bias −1 (gl/Shaders.h)
    if (any(u.v[2] != vec4f(0.0)) || any(u.v[3] != vec4f(0.0))) {
      let rgb = select(vec3f(0.0), c.rgb / c.a, c.a > 0.0);
      c = vec4f(adjust(rgb) * c.a, c.a);
    }
  } else {
    var t: f32;
    if (kind == 1) { t = g.x; }
    else if (kind == 2) { t = length(g - 0.5) * 2.0; }
    else if (kind == 3) { t = fract(atan2(g.y - 0.5, g.x - 0.5) / 6.28318530718 + 1.0); }
    else { t = (abs(g.x - 0.5) + abs(g.y - 0.5)) * 2.0; }
    return figDither(rampAt(t, v_paint1.w) * v_color.a);
  }
  return c * v_color.a;
}

// ---- Shapes (kDrawFragmentBody) ----
fn sdRoundedBox(p: vec2f, b: vec2f, r: vec4f) -> f32 {
  var rr = select(select(r.x, r.w, p.y > 0.0), select(r.y, r.z, p.y > 0.0), p.x > 0.0);
  rr = clamp(rr, 0.0, min(b.x, b.y));
  let q = abs(p) - b + rr;
  return min(max(q.x, q.y), 0.0) + length(max(q, vec2f(0.0))) - rr;
}

fn sdEllipse(p: vec2f, r0: vec2f) -> f32 {
  let r = max(r0, vec2f(1e-6));
  let k0 = length(p / r);
  let k1 = length(p / (r * r));
  return select(-min(r.x, r.y), k0 * (k0 - 1.0) / k1, k1 > 0.0);
}

fn tentCdf(h: f32) -> f32 {
  if (h < -1.0) { return 0.0; }
  if (h < 0.0) { return 0.5 * (h + 1.0) * (h + 1.0); }
  if (h < 1.0) { return 1.0 - 0.5 * (1.0 - h) * (1.0 - h); }
  return 1.0;
}
fn shadowX(x: f32, y: f32, R: f32, corner: f32, halfSize: vec2f) -> f32 {
  let delta = min(halfSize.y - corner - abs(y), 0.0);
  let curved = halfSize.x - corner + sqrt(max(0.0, corner * corner - delta * delta));
  return tentCdf((x + curved) / R) - tentCdf((x - curved) / R);
}
fn boxShadow(lo: vec2f, hi: vec2f, r: vec4f, p: vec2f, R: f32, px: f32) -> f32 {
  let c = (lo + hi) * 0.5;
  let h = max((hi - lo) * 0.5, vec2f(0.0));
  let q = p - c;
  var corner = select(select(r.x, r.w, q.y > 0.0), select(r.y, r.z, q.y > 0.0), q.x > 0.0);
  corner = clamp(corner, 0.0, min(h.x, h.y));
  if (R < 0.1 * px) { return clamp(0.5 - sdRoundedBox(q, h, vec4f(corner)) / px, 0.0, 1.0); }
  if (corner <= 0.0) {
    return (tentCdf((q.x + h.x) / R) - tentCdf((q.x - h.x) / R)) * (tentCdf((q.y + h.y) / R) - tentCdf((q.y - h.y) / R));
  }
  let low = q.y - h.y;
  let high = q.y + h.y;
  let start = clamp(-R, low, high);
  let end = clamp(R, low, high);
  let stp = (end - start) / 4.0;
  var y = start + stp * 0.5;
  var value = 0.0;
  for (var i = 0; i < 4; i++) {
    value += shadowX(q.x, q.y - y, R, corner, h) * max(0.0, 1.0 - abs(y) / R) / R * stp;
    y += stp;
  }
  return value;
}

// False: discarded.
fn shapeMain() -> bool {
  let v_size = v_origin.zw;
  let halfSize = v_size * 0.5;
  let p = v_local - halfSize;
  let kind = i32(v_geom.z + 0.5);
  let flags = i32(v_geom.w + 0.5);
  let px = max(0.5 * (length(dpdx(v_local)) + length(dpdy(v_local))), 1e-6);
  if (kind == 2) {
    let a = boxShadow(vec2f(0.0), v_size, v_box, v_local, v_geom.x, px);
    if (a <= 0.0) { return false; }
    o_color = figDither(v_color * a);
    return true;
  }
  let d = select(sdRoundedBox(p, halfSize, v_box), sdEllipse(p, halfSize), kind == 1);
  let fillCoverage = clamp(0.5 - d / px, 0.0, 1.0);
  g_glassShape = select(0, 1, kind == 1);
  g_dist = d;
  // fragCoord (GL's) runs up where WebGPU's dpdy runs down on the canvas (y sign +1), the same way offscreen.
  let lx = dpdx(v_local);
  let ly = dpdy(v_local) * select(1.0, -1.0, u.v[20].x > 0.0);
  let det = lx.x * ly.y - ly.x * lx.y;
  let inv = select(0.0, 1.0 / det, abs(det) > 1e-12);
  g_toFrag = mat2x2f(ly.y * inv, -lx.y * inv, -ly.x * inv, lx.x * inv);
  if (stencilPass()) {
    if (fillCoverage < 0.5) { return false; }
    o_color = vec4f(0.0);
    return true;
  }
  if (kind == 3) {
    let spread = v_geom.y;
    let off = v_paint0.xy;
    let r = max(v_box - spread, vec4f(0.0));
    let s = boxShadow(vec2f(spread), v_size - spread, r, v_local - off, v_geom.x, px);
    let c = v_color * (fillCoverage * (1.0 - s));
    if (c.a <= 0.0) { return false; }
    o_color = c;
    return true;
  }
  let inner = v_geom.x;
  let outer = v_geom.y;
  var strokeCoverage = 0.0;
  if (inner + outer > 0.0) {
    strokeCoverage = clamp(clamp(0.5 - (d - outer) / px, 0.0, 1.0) - clamp(0.5 - (d + inner) / px, 0.0, 1.0), 0.0, 1.0);
  }
  var c: vec4f;
  if ((flags & 32) != 0) {
    let f = v_color * fillCoverage;
    let s = v_paint0 * strokeCoverage;
    c = s + f * (1.0 - s.a);
  } else {
    let cov = select(fillCoverage, strokeCoverage, (flags & 16) != 0);
    if (cov <= 0.0) { return false; }
    c = paintAt(v_local, (flags >> 8u) & 15) * cov;
  }
  if (c.a <= 0.0) { return false; }
  o_color = c;
  return true;
}

// ---- Paths: coverage from quadratic curves ----
fn pathMain() -> bool {
  let dx = dpdx(v_local);
  let dy = dpdy(v_local);
  let ppe = 1.0 / max(vec2f(length(vec2f(dx.x, dy.x)), length(vec2f(dx.y, dy.y))), vec2f(1e-12));
  let flags = i32(v_geom.w + 0.5);
  var cov = coverage(i32(v_origin.z), v_local, ppe, (flags & 1) != 0);
  if ((flags & 6) != 0 && v_origin.w >= 0.0) {
    let clip = coverage(i32(v_origin.w), v_local, ppe, (flags & 8) != 0);
    cov *= select(1.0 - clip, clip, (flags & 2) != 0);
  }
  if (stencilPass()) {
    if (cov < 0.5) { return false; }
    o_color = vec4f(0.0);
    return true;
  }
  if (cov <= 0.0) { return false; }
  let c = paintAt(v_local, (flags >> 8u) & 15) * cov;
  if (c.a <= 0.0) { return false; }
  o_color = c;
  return true;
}

fn roundClip(dp: vec2f) -> f32 {
  if (v_round.z <= v_round.x) { return 1.0; }
  let half_ = (v_round.zw - v_round.xy) * 0.5;
  return clamp(0.5 - sdRoundedBox(dp - (v_round.xy + half_), half_, v_radii), 0.0, 1.0);
}

@fragment fn fs(vin: VOut) -> @location(0) vec4f {
  v_local = vin.local;
  v_origin = vin.origin;
  v_box = vin.box;
  v_geom = vin.geom;
  v_color = vin.color;
  v_paint0 = vin.paint0;
  v_paint1 = vin.paint1;
  v_clip = vin.clip;
  v_round = vin.round;
  v_radii = vin.radii;
  fragCoord = glFragCoord(vin.pos);
  let dp = vec2f(fragCoord.x, u.v[5].z - fragCoord.y) + u.v[5].xy;
  g_dp = dp;
  var clipCoverage = clipRectCoverage(dp, v_clip);
  if (clipCoverage <= 0.0) { discard; }
  clipCoverage *= roundClip(dp) * shapeClip(dp);
  if (clipCoverage <= 0.0 || (stencilPass() && clipCoverage < 0.5)) { discard; }
  var kept: bool;
  if (i32(v_geom.z + 0.5) == 4) { kept = pathMain(); }
  else { kept = shapeMain(); }
  if (!kept) { discard; }
  return o_color * clipCoverage;
}
)";

// ---- Composite: a layer onto its parent (gl/Shaders.h kCompositeVertex, kCompositeFragment) ----
inline constexpr const char* kComposite = R"(
@group(1) @binding(0) var t0: texture_2d<f32>;
@group(1) @binding(1) var s0: sampler;
@group(1) @binding(2) var t1: texture_2d<f32>;
@group(1) @binding(3) var s1: sampler;
@group(1) @binding(4) var t2: texture_2d<f32>;
@group(1) @binding(5) var s2: sampler;
@group(1) @binding(6) var t3: texture_2d<f32>;

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) dev: vec2f,
};

@vertex fn vs(@builtin(vertex_index) id: u32) -> VOut {
  let corner = quadCorner(id);
  let p = mix(u.v[2].xy, u.v[2].zw, corner);
  var o: VOut;
  o.pos = clipOut(dot(u.v[0].xyz, vec3f(p, 1.0)), dot(u.v[1].xyz, vec3f(p, 1.0)));
  o.dev = p;
  return o;
}

fn at0(map: vec4f, d: vec2f) -> vec4f {
  let sz = vec2f(textureDimensions(t0, 0));
  let q = (d - map.xy) * map.w;
  if (q.x < 0.0 || q.y < 0.0 || q.y > map.z) { return vec4f(0.0); }
  return textureSampleLevel(t0, s0, vec2f(q.x / sz.x, (map.z - q.y) / sz.y), 0.0);
}
fn at1(map: vec4f, d: vec2f) -> vec4f {
  let sz = vec2f(textureDimensions(t1, 0));
  let q = (d - map.xy) * map.w;
  if (q.x < 0.0 || q.y < 0.0 || q.y > map.z) { return vec4f(0.0); }
  return textureSampleLevel(t1, s1, vec2f(q.x / sz.x, (map.z - q.y) / sz.y), 0.0);
}
fn at2(map: vec4f, d: vec2f) -> vec4f {
  let sz = vec2f(textureDimensions(t2, 0));
  let q = (d - map.xy) * map.w;
  if (q.x < 0.0 || q.y < 0.0 || q.y > map.z) { return vec4f(0.0); }
  return textureSampleLevel(t2, s2, vec2f(q.x / sz.x, (map.z - q.y) / sz.y), 0.0);
}

fn noiseAt(dp: vec2f) -> vec4f {
  let P = u.v[18];
  let frequency = 1.0 / max(P.xy, vec2f(1e-3));
  let code = i32(P.w + 0.5);
  if (code < 4) { return figmaNoise(effectSpace(dp) * frequency, u.v[8].x, P.z, code, u.v[6], u.v[19]); }
  var sum = vec4f(0.0);
  for (var k = 0; k < 4; k++) {
    let o = vec2f(f32(k & 1), f32(k >> 1u)) * 0.5 - 0.25;
    sum += figmaNoise(effectSpace(dp + o) * frequency, u.v[8].x, P.z, code & 3, u.v[6], u.v[19]);
  }
  return sum * 0.25;
}
fn textureShift(dp: vec2f) -> vec2f {
  let q = effectSpace(dp) / max(u.v[18].xy, vec2f(1e-3));
  let d = vec2f(fnFbm(u.v[8].x, q), fnFbm(u.v[8].x + 1.0, q)) * u.v[18].z;
  return vec2f(dot(u.v[19].xy, d), dot(u.v[19].zw, d));
}

fn lum(c: vec3f) -> f32 { return dot(c, vec3f(0.3, 0.59, 0.11)); }
fn clipColor(c0: vec3f) -> vec3f {
  var c = c0;
  let l = lum(c);
  let n = min(min(c.r, c.g), c.b);
  let x = max(max(c.r, c.g), c.b);
  if (n < 0.0) { c = l + (c - l) * l / max(l - n, 1e-6); }
  if (x > 1.0) { c = l + (c - l) * (1.0 - l) / max(x - l, 1e-6); }
  return c;
}
fn setLum(c: vec3f, l: f32) -> vec3f { return clipColor(c + (l - lum(c))); }
fn sat(c: vec3f) -> f32 { return max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b); }
fn setSat(c: vec3f, s: f32) -> vec3f {
  let mx = max(max(c.r, c.g), c.b);
  let mn = min(min(c.r, c.g), c.b);
  return select(vec3f(0.0), (c - mn) * s / (mx - mn), mx > mn);
}
fn softLight(b: f32, s: f32) -> f32 {
  if (s <= 0.5) { return b - (1.0 - 2.0 * s) * b * (1.0 - b); }
  let d = select(sqrt(b), ((16.0 * b - 12.0) * b + 4.0) * b, b <= 0.25);
  return b + (2.0 * s - 1.0) * (d - b);
}
fn colorDodge(b: f32, s: f32) -> f32 {
  if (b < 0.003922) { return 0.0; }
  return min(1.0, b / max(1.0 - s, 0.003922));
}
fn colorBurn(b: f32, s: f32) -> f32 {
  if (1.0 - b < 0.003922) { return 1.0; }
  return 1.0 - min(1.0, (1.0 - b) / max(s, 0.003922));
}

fn blendColor(m: i32, b: vec3f, s: vec3f) -> vec3f {
  if (m == 2) { return min(b, s); }
  if (m == 3) { return b * s; }
  if (m == 4) { return max(b + s - 1.0, vec3f(0.0)); }
  if (m == 5) { return vec3f(colorBurn(b.r, s.r), colorBurn(b.g, s.g), colorBurn(b.b, s.b)); }
  if (m == 6) { return max(b, s); }
  if (m == 7) { return b + s - b * s; }
  if (m == 8) { return min(b + s, vec3f(1.0)); }
  if (m == 9) { return vec3f(colorDodge(b.r, s.r), colorDodge(b.g, s.g), colorDodge(b.b, s.b)); }
  if (m == 10) { return mix(2.0 * b * s, 1.0 - 2.0 * (1.0 - b) * (1.0 - s), step(vec3f(0.5), b)); }
  if (m == 11) { return vec3f(softLight(b.r, s.r), softLight(b.g, s.g), softLight(b.b, s.b)); }
  if (m == 12) { return mix(2.0 * b * s, 1.0 - 2.0 * (1.0 - b) * (1.0 - s), step(vec3f(0.5), s)); }
  if (m == 13) { return abs(b - s); }
  if (m == 14) { return b + s - 2.0 * b * s; }
  if (m == 15) { return setLum(setSat(s, sat(b)), lum(b)); }
  if (m == 16) { return setLum(setSat(b, sat(s)), lum(b)); }
  if (m == 17) { return setLum(s, lum(b)); }
  if (m == 18) { return setLum(b, lum(s)); }
  return s;
}

fn sdBox4(p: vec2f, b: vec2f, r: vec4f) -> f32 {
  var rr = select(select(r.x, r.w, p.y > 0.0), select(r.y, r.z, p.y > 0.0), p.x > 0.0);
  rr = clamp(rr, 0.0, min(b.x, b.y));
  let q = abs(p) - b + rr;
  return min(max(q.x, q.y), 0.0) + length(max(q, vec2f(0.0))) - rr;
}
fn roundClip(d: vec2f) -> f32 {
  let r = u.v[9];
  if (r.z <= r.x) { return 1.0; }
  let h = (r.zw - r.xy) * 0.5;
  return clamp(0.5 - sdBox4(d - (r.xy + h), h, u.v[10]), 0.0, 1.0);
}

@fragment fn fs(vin: VOut) -> @location(0) vec4f {
  let v_dev = vin.dev;
  let params = u.v[7];
  let mode = i32(params.z + 0.5);
  let blend = i32(params.y + 0.5);
  var c: vec4f;
  var cov = select(1.0, clipRectCoverage(v_dev, u.v[11]), u.v[11].z > u.v[11].x);
  if (cov <= 0.0) { discard; }
  cov *= roundClip(v_dev) * shapeClip(v_dev);
  if (cov <= 0.0) { discard; }
  if (mode == 5) {
    let P = u.v[19];
    let s = mix(P.x, P.y, progressT(v_dev));
    if (s < P.z || s >= P.w) { discard; }
    let f = clamp((s - P.z) / max(P.w - P.z, 1e-6), 0.0, 1.0);
    c = mix(at0(u.v[3], v_dev), at1(u.v[4], v_dev), f);
  } else if (mode == 6) {
    c = noiseAt(v_dev) * at0(u.v[3], v_dev).a;
  } else if (mode == 7) {
    let d = textureShift(v_dev);
    if (u.v[18].w < 0.5) {
      c = at0(u.v[3], v_dev + d);
    } else {
      let src = at0(u.v[3], v_dev);
      let k = pow(src.a, 0.2) * pow(at0(u.v[3], v_dev + d).a, 0.2);
      let moved = at0(u.v[3], v_dev + d * k);
      c = select(src, moved, src.a > 0.0 && moved.a > 0.0);
    }
  } else if (mode == 3) {
    var a = at0(u.v[3], v_dev - u.v[8].xy).a;
    if (params.w > 0.5) { a *= 1.0 - at1(u.v[4], v_dev).a; }
    c = u.v[6] * a;
  } else if (mode == 4) {
    let inside = at1(u.v[4], v_dev).a;
    let blurred = at0(u.v[3], v_dev - u.v[8].xy).a;
    c = u.v[6] * (inside * (1.0 - blurred));
  } else {
    c = at0(u.v[3], v_dev);
    if (mode == 1) { c *= at1(u.v[4], v_dev).a; }
    else if (mode == 2) {
      let m = at1(u.v[4], v_dev);
      let rgb = select(vec3f(0.0), m.rgb / m.a, m.a > 0.0);
      c *= dot(rgb, vec3f(0.2126, 0.7152, 0.0722)) * m.a;
    }
  }
  c *= params.x;
  if (blend > 1) {
    let b = at2(u.v[5], v_dev);
    let cb = select(vec3f(0.0), b.rgb / b.a, b.a > 0.0);
    let cs = select(vec3f(0.0), c.rgb / c.a, c.a > 0.0);
    let mixed = (1.0 - b.a) * cs + b.a * clamp(blendColor(blend, cb, cs), vec3f(0.0), vec3f(1.0));
    let a = c.a + b.a * (1.0 - c.a);
    c = vec4f(c.a * mixed + (1.0 - c.a) * b.rgb, a);
    c = mix(b, c, cov);
  } else {
    c *= cov;
  }
  return c;
}
)";

// ---- Blur: separable tent, dilate, erode (gl/Shaders.h kBlurVertex, kBlurFragment) ----
inline constexpr const char* kBlur = R"(
@group(1) @binding(0) var t0: texture_2d<f32>;
@group(1) @binding(1) var s0: sampler;

@vertex fn vs(@builtin(vertex_index) id: u32) -> @builtin(position) vec4f {
  let corner = quadCorner(id);
  return vec4f(corner * 2.0 - 1.0, 0.0, 1.0);
}

@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let sz = vec2f(textureDimensions(t0, 0));
  let uv = glFragCoord(pos) / sz;
  let dir = u.v[2].xy / sz;
  let mode = i32(u.v[2].w + 0.5);
  if (mode == 0) {
    let R = clamp(u.v[2].z, 1e-3, 64.0);
    var sum = textureSampleLevel(t0, s0, uv, 0.0) * R;
    var total = R;
    for (var i = 1; i <= 64; i += 2) {
      let w1 = max(R - f32(i), 0.0);
      let w2 = max(R - f32(i + 1), 0.0);
      let w = w1 + w2;
      if (w <= 0.0) { break; }
      let o = dir * (f32(i) + w2 / w);
      sum += (textureSampleLevel(t0, s0, uv + o, 0.0) + textureSampleLevel(t0, s0, uv - o, 0.0)) * w;
      total += 2.0 * w;
    }
    let c = sum / total;
    let d = fract(52.9829189 * fract(dot(glFragCoord(pos), vec2f(0.06711056, 0.00583715))));
    return select(c, c * (max(c.a + (d - 0.5) / 255.0, 0.0) / max(c.a, 1e-9)), c.a > 0.0);
  }
  if (mode == 3) {
    // Clamped to a box in the node's space (gl/Shaders.h kBlurFragment).
    let R = clamp(u.v[2].z, 1e-3, 64.0);
    let B = u.v[6];
    let fc = glFragCoord(pos);
    let n = vec2f(dot(u.v[4].xyz, vec3f(fc, 1.0)), dot(u.v[5].xyz, vec3f(fc, 1.0)));
    let nc = clamp(n, B.xy, B.zw);
    let p = vec2f(dot(u.v[7].xyz, vec3f(nc, 1.0)), dot(u.v[8].xyz, vec3f(nc, 1.0)));
    let step1 = vec2f(dot(u.v[4].xy, u.v[2].xy), dot(u.v[5].xy, u.v[2].xy));
    var sum = textureSampleLevel(t0, s0, p / sz, 0.0) * R;
    var total = R;
    for (var i = 1; i < 64; i += 2) {
      let k = f32(i);
      let l = min(k + 1.0, R);
      if (k > R) { break; }
      for (var side = -1; side <= 1; side += 2) {
        let s = f32(side);
        let qk = nc + step1 * (s * k);
        let ql = nc + step1 * (s * l);
        let wk = select(0.0, R - k, all(qk == clamp(qk, B.xy, B.zw)));
        let wl = select(0.0, R - l, all(ql == clamp(ql, B.xy, B.zw)));
        let w = wk + wl;
        if (w <= 0.0) { continue; }
        sum += textureSampleLevel(t0, s0, (p + u.v[2].xy * (s * (k * wk + l * wl) / w)) / sz, 0.0) * w;
        total += w;
      }
    }
    let c = sum / total;
    let d = fract(52.9829189 * fract(dot(fc, vec2f(0.06711056, 0.00583715))));
    return select(c, c * (max(c.a + (d - 0.5) / 255.0, 0.0) / max(c.a, 1e-9)), c.a > 0.0);
  }
  let r = min(i32(ceil(u.v[3].x)), 64);
  var m = select(1.0, 0.0, mode == 1);
  for (var i = -r; i <= r; i++) {
    let a = textureSampleLevel(t0, s0, uv + dir * f32(i), 0.0).a;
    m = select(min(m, a), max(m, a), mode == 1);
  }
  return vec4f(m);
}
)";

// ---- The device's own passes (no GL counterpart: GL has glGenerateMipmap and glCopyTexSubImage2D) ----
// Mip level n from level n − 1: the 2×2 box GL's glGenerateMipmap averages (one bilinear tap at the shared corner).
// Copy: `rect` of a texture stored top row first (the canvas) into one stored bottom row first (as GL's
// glCopyTexSubImage2D from the canvas leaves it): v[0] = (x, last row's y, 0, 0) in the source.
inline constexpr const char* kUtility = R"(
@group(1) @binding(0) var src: texture_2d<f32>;
@group(1) @binding(1) var srcSampler: sampler;

@vertex fn vs(@builtin(vertex_index) id: u32) -> @builtin(position) vec4f {
  let corner = quadCorner(id);
  return vec4f(corner * 2.0 - 1.0, 0.0, 1.0);
}

@fragment fn mip(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let sz = vec2f(textureDimensions(src, 0));
  return textureSampleLevel(src, srcSampler, (floor(pos.xy) * 2.0 + 1.0) / sz, 0.0);
}

// The source texel of texel d: (u0.x + d.x, u0.y − d.y) on the canvas (rows top first), (u0.x + d.x, u0.y + d.y) on a
// target (u0.z = 1); clamped into slot 1's (x0, y0, x1, y1) when u0.w = 1 (the region's edge repeated past it).
@fragment fn flipCopy(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let d = vec2i(floor(pos.xy));
  var s = vec2i(i32(u.v[0].x) + d.x, select(i32(u.v[0].y) - d.y, i32(u.v[0].y) + d.y, u.v[0].z > 0.5));
  if (u.v[0].w > 0.5) {
    s = clamp(s, vec2i(u.v[1].xy), vec2i(u.v[1].zw));
  }
  return textureLoad(src, s, 0);
}
)";

}  // namespace eng::gfx::wgsl
