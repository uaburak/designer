// The built-in shaders in WGSL (WebGPU): the same programs as gfx/gl/Shaders.h, line for line, so both backends
// draw the same pixels. Interim: translated by hand until tools/shadergen generates both from one source (Figma
// keeps GLSL as the source and generates WGSL with naga, docs/research/figma/R10-webgpu.md).
//
// Uniforms: `u.v[0..11]` are gfx::DrawCall::uniforms (the GLSL `u_v[12]`); the device appends `u.v[12]` = (y sign,
// the framebuffer's height in px, stencil pass, 0). WebGPU's framebuffer y runs down where GL's runs up: offscreen
// targets are drawn with clip y negated (y sign −1), so a target's rows sit in memory as GL leaves them (bottom row
// first) and every texture read, copy and scissor means the same thing on both backends; the canvas is drawn
// unflipped (y sign +1, it is shown top row first). `glFragCoord()` rebuilds GL's gl_FragCoord from either.
// Textures: GL's u_t0 / u_t1 / u_t2 are t0 / t1 / t2, each filtered one with its sampler s0 / s1 / s2.
#pragma once

namespace eng::gfx::wgsl {

inline constexpr const char* kCommon = R"(
diagnostic(off, derivative_uniformity);

struct Uniforms { v: array<vec4f, 13> };
@group(0) @binding(0) var<uniform> u: Uniforms;

// GL's gl_FragCoord.xy (origin bottom left of the framebuffer) from WebGPU's position (origin top left).
fn glFragCoord(p: vec4f) -> vec2f {
  return vec2f(p.x, select(u.v[12].y - p.y, p.y, u.v[12].x < 0.0));
}
// GL's clip position from the draw's: y negated on offscreen targets (see the header).
fn clipOut(x: f32, y: f32) -> vec4f {
  return vec4f(x, y * u.v[12].x, 0.0, 1.0);
}
fn quadCorner(id: u32) -> vec2f {
  return vec2f(select(0.0, 1.0, id == 1u || id == 2u || id == 4u), select(0.0, 1.0, id == 2u || id == 4u || id == 5u));
}
fn glMod(x: f32, y: f32) -> f32 { return x - y * floor(x / y); }
)";

// ---- Draw: shapes, paths and glyphs in one program (gl/Shaders.h kDrawVertex, kPaintFunctions, kDrawFragment*) ----
inline constexpr const char* kDraw = R"(
@group(1) @binding(0) var t0: texture_2d<f32>;
@group(1) @binding(1) var t1: texture_2d<f32>;
@group(1) @binding(2) var s1: sampler;
@group(1) @binding(3) var t2: texture_2d<f32>;
@group(1) @binding(4) var s2: sampler;

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
    let grow = select(select(a.a_geom.y, 0.0, kind == 3), 3.0 * a.a_geom.x, kind == 2);
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

fn stencilPass() -> bool { return u.v[12].z > 0.5; }

// ---- The paint (kPaintFunctions) ----
fn rampAt(t: f32, row: f32) -> vec4f {
  let sz = vec2f(textureDimensions(t1, 0));
  return textureSampleLevel(t1, s1, vec2f((clamp(t, 0.0, 1.0) * 255.0 + 0.5) / sz.x, (row + 0.5) / sz.y), 0.0);
}

fn luma(c: vec3f) -> f32 { return dot(c, vec3f(0.2126, 0.7152, 0.0722)); }

fn adjust(c0: vec3f) -> vec3f {
  let a = u.v[2];
  let b = u.v[3];
  var c = c0;
  c *= exp2(a.x * 2.0);
  c = (c - 0.5) * (1.0 + a.y) + 0.5;
  let l = luma(c);
  c = mix(vec3f(l), c, 1.0 + a.z);
  c += vec3f(a.w, 0.0, -a.w) * 0.1;
  c += vec3f(b.x * 0.05, -b.x * 0.1, b.x * 0.05);
  let l2 = luma(c);
  c += b.y * 0.25 * smoothstep(0.5, 1.0, l2);
  c += b.z * 0.25 * (1.0 - smoothstep(0.0, 0.5, l2));
  return clamp(c, vec3f(0.0), vec3f(1.0));
}

fn paintAt(local: vec2f, kind: i32) -> vec4f {
  if (kind == 0) { return v_color; }
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
    c = textureSampleGrad(t2, s2, select(g, fract(g), repeat), gx, gy);
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
    c = rampAt(t, v_paint1.w);
    let n = fract(52.9829189 * fract(dot(fragCoord, vec2f(0.06711056, 0.00583715))));
    c = vec4f(clamp(c.rgb + (n - 0.5) / 255.0 * c.a, vec3f(0.0), vec3f(c.a)), c.a);
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

fn gaussian(x: f32, sigma: f32) -> f32 { return exp(-(x * x) / (2.0 * sigma * sigma)) / (2.50662827463 * sigma); }
fn erf2(x0: vec2f) -> vec2f {
  let s = sign(x0);
  let a = abs(x0);
  var x = 1.0 + (0.278393 + (0.230389 + 0.078108 * (a * a)) * a) * a;
  x *= x;
  return s - s / (x * x);
}
fn shadowX(x: f32, y: f32, sigma: f32, corner: f32, halfSize: vec2f) -> f32 {
  let delta = min(halfSize.y - corner - abs(y), 0.0);
  let curved = halfSize.x - corner + sqrt(max(0.0, corner * corner - delta * delta));
  let integral = 0.5 + 0.5 * erf2((x + vec2f(-curved, curved)) * (0.70710678 / sigma));
  return integral.y - integral.x;
}
fn boxShadow(lo: vec2f, hi: vec2f, r: vec4f, p: vec2f, sigma: f32, px: f32) -> f32 {
  let c = (lo + hi) * 0.5;
  let h = max((hi - lo) * 0.5, vec2f(0.0));
  let q = p - c;
  var corner = select(select(r.x, r.w, q.y > 0.0), select(r.y, r.z, q.y > 0.0), q.x > 0.0);
  corner = clamp(corner, 0.0, min(h.x, h.y));
  if (sigma < 0.05 * px) { return clamp(0.5 - sdRoundedBox(q, h, vec4f(corner)) / px, 0.0, 1.0); }
  let low = q.y - h.y;
  let high = q.y + h.y;
  let start = clamp(-3.0 * sigma, low, high);
  let end = clamp(3.0 * sigma, low, high);
  let stp = (end - start) / 4.0;
  var y = start + stp * 0.5;
  var value = 0.0;
  for (var i = 0; i < 4; i++) {
    value += shadowX(q.x, q.y - y, sigma, corner, h) * gaussian(y, sigma) * stp;
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
    o_color = v_color * a;
    return true;
  }
  let d = select(sdRoundedBox(p, halfSize, v_box), sdEllipse(p, halfSize), kind == 1);
  let fillCoverage = clamp(0.5 - d / px, 0.0, 1.0);
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
fn texel(i: i32) -> vec4f { return textureLoad(t0, vec2i(i & 2047, i >> 11u), 0); }

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
  if (dp.x < v_clip.x || dp.y < v_clip.y || dp.x >= v_clip.z || dp.y >= v_clip.w) { discard; }
  let clipCoverage = roundClip(dp);
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
  if (b == 0.0) { return 0.0; }
  if (s >= 1.0) { return 1.0; }
  return min(1.0, b / (1.0 - s));
}
fn colorBurn(b: f32, s: f32) -> f32 {
  if (b >= 1.0) { return 1.0; }
  if (s <= 0.0) { return 0.0; }
  return 1.0 - min(1.0, (1.0 - b) / s);
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
  let cov = roundClip(v_dev);
  if (cov <= 0.0) { discard; }
  if (mode == 3) {
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

// ---- Blur: separable Gaussian, dilate, erode (gl/Shaders.h kBlurVertex, kBlurFragment) ----
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
    let sigma = max(u.v[2].z, 1e-3);
    let n = min(i32(ceil(3.0 * sigma)), 48);
    var sum = vec4f(0.0);
    var total = 0.0;
    for (var i = -n; i <= n; i++) {
      let w = exp(-f32(i * i) / (2.0 * sigma * sigma));
      sum += textureSampleLevel(t0, s0, uv + dir * f32(i), 0.0) * w;
      total += w;
    }
    return sum / total;
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

@fragment fn flipCopy(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let d = vec2i(floor(pos.xy));
  return textureLoad(src, vec2i(i32(u.v[0].x) + d.x, i32(u.v[0].y) - d.y), 0);
}
)";

}  // namespace eng::gfx::wgsl
