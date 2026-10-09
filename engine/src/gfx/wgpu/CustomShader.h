// Figma's shader fills and effects (round 11) in WGSL: gfx/gl/CustomShader.h line for line (its header says what the
// slots hold). Appended to kCommon (u.v, clipOut, quadCorner). Textures: GL's u_t0 is t0 with s0.
#pragma once

namespace eng::gfx::wgsl {

inline constexpr const char* kCustom = R"(
@group(1) @binding(0) var t0: texture_2d<f32>;
@group(1) @binding(1) var s0: sampler;

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

var<private> DEV: vec2f;
var<private> NP: vec2f;
var<private> SIZE: vec2f;
var<private> K: f32;

fn C(i: i32) -> vec4f { return u.v[8 + i]; }
fn S(i: i32) -> f32 { return u.v[14 + i / 4][i - (i / 4) * 4]; }

// ---- helpers ----
fn hash12(p: vec2f) -> f32 {
  var p3 = fract(vec3f(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
fn hash22(p: vec2f) -> vec2f {
  var p3 = fract(vec3f(p.xyx) * vec3f(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
fn vnoise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u2 = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2f(1.0, 0.0)), u2.x), mix(hash12(i + vec2f(0.0, 1.0)), hash12(i + vec2f(1.0, 1.0)), u2.x), u2.y);
}
fn fbm(p0: vec2f, octaves: i32) -> f32 {
  var p = p0;
  var s = 0.0;
  var a = 0.5;
  var norm = 0.0;
  for (var i = 0; i < 8; i++) {
    if (i >= octaves) { break; }
    s += a * vnoise(p);
    norm += a;
    p = mat2x2f(1.6, 1.2, -1.2, 1.6) * p + vec2f(17.0, 9.0);
    a *= 0.5;
  }
  return s / max(norm, 1e-6);
}
fn luma(c: vec3f) -> f32 { return dot(c, vec3f(0.2126, 0.7152, 0.0722)); }
fn rot(p: vec2f, a: f32) -> vec2f {
  let c = cos(a);
  let s = sin(a);
  return vec2f(c * p.x - s * p.y, s * p.x + c * p.y);
}
fn fmod2(a: vec2f, b: f32) -> vec2f { return a - b * floor(a / b); }
fn fmod1(a: f32, b: f32) -> f32 { return a - b * floor(a / b); }
fn cover(d: f32) -> f32 { return clamp(0.5 - d * K, 0.0, 1.0); }
fn unpre(c: vec4f) -> vec3f { return select(vec3f(0.0), c.rgb / max(c.a, 1e-9), c.a > 0.0); }
fn hueShift(c: vec3f, deg: f32) -> vec3f {
  let yiq = mat3x3f(0.299, 0.596, 0.211, 0.587, -0.274, -0.523, 0.114, -0.322, 0.312) * c;
  let h = atan2(yiq.z, yiq.y) + radians(deg);
  let ch = length(yiq.yz);
  return mat3x3f(1.0, 1.0, 1.0, 0.956, -0.272, -1.106, 0.621, -0.647, 1.703) * vec3f(yiq.x, ch * cos(h), ch * sin(h));
}
fn sepia(c: vec3f) -> vec3f { return vec3f(dot(c, vec3f(0.393, 0.769, 0.189)), dot(c, vec3f(0.349, 0.686, 0.168)), dot(c, vec3f(0.272, 0.534, 0.131))); }

fn at(d: vec2f) -> vec4f {
  let map = u.v[3];
  let sz = vec2f(textureDimensions(t0, 0));
  let q = (d - map.xy) * map.w;
  if (q.x < 0.0 || q.y < 0.0 || q.y > map.z || q.x > sz.x) { return vec4f(0.0); }
  return textureSampleLevel(t0, s0, vec2f(q.x / sz.x, (map.z - q.y) / sz.y), 0.0);
}
fn toDev(o: vec2f) -> vec2f { return vec2f(dot(u.v[7].xy, o), dot(u.v[7].zw, o)); }
fn src(o: vec2f) -> vec4f { return at(DEV + toDev(o)); }
fn srcAt(p: vec2f) -> vec4f { return src(p - NP); }

// ---- Shader fills (straight RGBA) ----
fn movingGradient(uv: vec2f) -> vec4f {
  let dist = S(0) / 100.0;
  let scale = max(S(1), 1.0) / 100.0;
  let q = uv + dist * 0.18 * vec2f(sin(uv.y * 5.3 + 1.3) + sin(uv.x * 2.1 + 0.7), cos(uv.x * 4.7 + 2.1) + sin(uv.y * 3.3));
  let c = vec2f(0.5);
  let w0 = 1.0 / (pow(distance(q, c + (vec2f(0.18, 0.22) - c) * scale), 2.5) + 1e-3);
  let w1 = 1.0 / (pow(distance(q, c + (vec2f(0.85, 0.18) - c) * scale), 2.5) + 1e-3);
  let w2 = 1.0 / (pow(distance(q, c + (vec2f(0.80, 0.85) - c) * scale), 2.5) + 1e-3);
  let w3 = 1.0 / (pow(distance(q, c + (vec2f(0.20, 0.80) - c) * scale), 2.5) + 1e-3);
  return (C(0) * w0 + C(1) * w1 + C(2) * w2 + C(3) * w3) / (w0 + w1 + w2 + w3);
}
fn meshGradient(uv: vec2f) -> vec4f {
  var q = uv - 0.5;
  q = rot(q, S(1) / 100.0 * 3.0 * (1.0 - smoothstep(0.0, 0.75, length(q))));
  q += S(0) / 100.0 * 0.15 * vec2f(sin(q.y * 7.0 + 0.5), sin(q.x * 6.0 + 1.7));
  q = clamp(q + 0.5, vec2f(0.0), vec2f(1.0));
  let s = q * q * (3.0 - 2.0 * q);
  return mix(mix(C(0), C(1), s.x), mix(C(3), C(2), s.x), s.y);
}
fn nebula() -> vec4f {
  let p = NP / max(S(0), 1.0);
  let w = fbm(p * 1.7 + 3.1, 4);
  let n = fbm(p + 1.5 * vec2f(w, fbm(p * 1.3 + 7.7, 4)), 6);
  let m = fbm(p * 2.0 + 11.0, 5);
  let gas = smoothstep(0.75 - S(1) / 100.0 * 0.45, 0.95, n + 0.2);
  var col = mix(C(2).rgb, mix(C(1).rgb, C(0).rgb, smoothstep(0.3, 0.7, m)), gas);
  col += C(0).rgb * pow(gas, 3.0) * 0.4;
  let cell = floor(NP / 3.0);
  let star = step(1.0 - S(2) / 100.0 * 0.03, hash12(cell)) * hash12(cell + 17.0);
  return vec4f(clamp(col + vec3f(star), vec3f(0.0), vec3f(1.0)), mix(C(2).a, 1.0, max(gas, star)));
}
fn waterCaustic() -> vec4f {
  let p = fmod2(NP / max(S(0), 1.0) * 6.28318, 6.28318) - 250.0;
  var i = p;
  var c = 1.0;
  let inten = 0.005;
  for (var n = 0; n < 5; n++) {
    let t = 1.0 - 3.5 / f32(n + 1);
    i = p + vec2f(cos(t - i.x) + sin(t + i.y), sin(t - i.y) + cos(t + i.x));
    c += 1.0 / length(vec2f(p.x / (sin(i.x + t) / inten), p.y / (cos(i.y + t) / inten)));
  }
  c /= 5.0;
  c = 1.17 - pow(c, 1.4);
  let v = clamp(pow(abs(c), 8.0) * S(1) / 100.0, 0.0, 1.0);
  return mix(C(1), C(0), v);
}
fn fractalNoise() -> vec4f {
  var n = fbm(NP / max(S(0), 1.0), i32(clamp(S(1), 1.0, 8.0) + 0.5));
  n = clamp((n - 0.5) * (1.0 + S(2) / 25.0) + 0.5, 0.0, 1.0);
  return mix(C(0), C(1), n);
}
fn clouds() -> vec4f {
  let p = NP / max(S(0), 1.0) * vec2f(0.6, 1.2);
  let n = fbm(p + 0.35 * vec2f(fbm(p * 2.0 + 4.0, 3), 0.0), 6);
  let t = 0.75 - S(1) / 100.0 * 0.5;
  let soft = max(S(2) / 100.0, 0.02) * 0.25;
  return mix(C(0), C(1), smoothstep(t - soft, t + soft, n));
}
fn moire() -> vec4f {
  let k = 6.28318 * max(S(0), 0.1) / 100.0;
  let q = NP - SIZE * 0.5;
  let g1 = 0.5 + 0.5 * cos(q.x * k);
  let q2 = rot(q, radians(S(1)));
  let g2 = 0.5 + 0.5 * cos(q2.x * k * (1.0 + S(2) / 1000.0) + S(2) / 100.0 * 6.0 * sin(q2.y * k * 0.05));
  let ink = max(smoothstep(0.45, 0.6, g1), smoothstep(0.45, 0.6, g2));
  return mix(C(1), C(0), ink);
}
fn glowingWave() -> vec4f {
  let uv = NP / SIZE;
  let n = i32(clamp(S(0), 1.0, 8.0) + 0.5);
  let amp = S(1) / 100.0;
  let glow = max(S(2), 1.0) / 100.0 * 0.12 * SIZE.y;
  var acc = 0.0;
  for (var i = 0; i < 8; i++) {
    if (i >= n) { break; }
    let fi = f32(i);
    let y = 0.5 + amp * sin(uv.x * 6.28318 * (1.0 + fi * 0.37) + fi * 1.7) * (0.55 + 0.45 * cos(fi * 2.3));
    let d = abs(uv.y - y) * SIZE.y;
    acc += exp(-d / max(glow, 0.5)) * 0.8 + exp(-d / 1.2) * 0.6;
  }
  return mix(C(1), vec4f(C(0).rgb, 1.0), clamp(acc, 0.0, 1.0) * C(0).a);
}
fn concentric() -> vec4f {
  let c = vec2f(S(1), S(2)) / 100.0 * SIZE;
  let d = abs(NP - c);
  let shape = i32(S(3) + 0.5);
  let r = select(select(length(d), (d.x + d.y) * 0.7071, shape == 2), max(d.x, d.y), shape == 1);
  let R = length(max(c, SIZE - c));
  let band = max(R / max(S(0), 1.0), 1e-3);
  let g = abs(fract(r / band) - 0.5);
  return mix(C(1), C(0), clamp(0.5 + (g - 0.25) * band * K, 0.0, 1.0));
}
fn patternGrid() -> vec4f {
  let cs = max(S(0), 1.0);
  let q = NP - (floor(NP / cs) + 0.5) * cs;
  let r = S(1) / 100.0 * cs * 0.5;
  let a = abs(q);
  let shape = i32(S(2) + 0.5);
  var d = length(q) - r;
  if (shape == 1) { d = max(a.x, a.y) - r; }
  else if (shape == 2) { d = (a.x + a.y) * 0.7071 - r; }
  else if (shape == 3) { d = min(max(a.x - r * 0.3, a.y - r), max(a.x - r, a.y - r * 0.3)); }
  return mix(C(1), C(0), cover(d));
}

// ---- Shader effects (premultiplied) ----
fn particles() -> vec4f {
  let size = max(S(0), 0.5);
  let dens = S(1) / 100.0;
  let spread = S(2);
  let layerColors = S(3) > 0.5;
  let cs = max(size * 2.5, 2.0);
  let base = floor(NP / cs);
  var o = vec4f(0.0);
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      let id = base + vec2f(f32(i), f32(j));
      if (hash12(id + 3.7) > dens) { continue; }
      let center = (id + 0.15 + 0.7 * hash22(id)) * cs;
      let s = srcAt(center - (hash22(id + 9.1) - 0.5) * 2.0 * spread);
      if (s.a < 0.5) { continue; }
      let cov = cover(distance(NP, center) - size * 0.5 * (0.6 + 0.8 * hash12(id + 1.3)));
      let col = select(C(0), vec4f(unpre(s), 1.0), layerColors);
      o += vec4f(col.rgb, 1.0) * col.a * cov * (1.0 - o.a);
    }
  }
  return o;
}
fn refractHeight(p: vec2f, kind: i32, k: f32) -> f32 {
  if (kind == 1) { return sin(p.x * k + 2.0 * sin(p.y * k * 0.5)); }
  if (kind == 2) { return sin(p.x * k) * sin(p.y * k); }
  if (kind == 3) { return sin(length(p - SIZE * 0.5) * k); }
  return sin(p.x * k);
}
fn refraction() -> vec4f {
  let k = 6.28318 / max(S(0), 1.0);
  let kind = i32(S(2) + 0.5);
  let e = vec2f(0.5, 0.0);
  let g = vec2f(refractHeight(NP + e, kind, k) - refractHeight(NP - e, kind, k), refractHeight(NP + e.yx, kind, k) - refractHeight(NP - e.yx, kind, k));
  return src(g / (2.0 * e.x * k) * S(1));
}
fn halftone() -> vec4f {
  let ds = max(S(0), 1.0);
  let ang = radians(S(1));
  let mono = S(2) > 0.5;
  let q = rot(NP, -ang);
  let cell = (floor(q / ds) + 0.5) * ds;
  var o = vec4f(0.0);
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      let cc = cell + vec2f(f32(i), f32(j)) * ds;
      let s = srcAt(rot(cc, ang));
      if (s.a <= 0.0) { continue; }
      let c = unpre(s);
      let amount = select(s.a, (1.0 - luma(c)) * s.a, mono);
      let cov = cover(distance(q, cc) - sqrt(amount) * ds * 0.7071);
      let col = select(vec4f(c, 1.0), vec4f(C(0).rgb, 1.0) * C(0).a, mono);
      o += col * cov * (1.0 - o.a);
    }
  }
  return o;
}
fn metalWave(t: f32) -> f32 { return 0.5 + 0.5 * cos(t * 6.28318); }
fn chromaticMetal() -> vec4f {
  let s = src(vec2f(0.0));
  if (s.a <= 0.0) { return vec4f(0.0); }
  let g = vec2f(src(vec2f(2.0, 0.0)).a - src(vec2f(-2.0, 0.0)).a, src(vec2f(0.0, 2.0)).a - src(vec2f(0.0, -2.0)).a);
  let t = luma(unpre(s)) * 1.5 + NP.y / SIZE.y * 0.8 + (g.x - g.y) * 0.35;
  let d = S(1) / 100.0 * 0.08;
  let m = vec3f(metalWave(t + d), metalWave(t), metalWave(t - d));
  let col = mix(vec3f(0.25), vec3f(1.0), m) * mix(vec3f(1.0), C(0).rgb, 0.5) + S(0) / 100.0 * pow(m, vec3f(12.0));
  return vec4f(clamp(col, vec3f(0.0), vec3f(1.0)), 1.0) * s.a;
}
fn lens() -> vec4f {
  let c = SIZE * 0.5;
  let R = max(length(c), 1.0);
  let d = (NP - c) / R;
  let f = (1.0 + S(0) / 100.0 * dot(d, d) * 0.6) / (max(S(1), 1.0) / 100.0);
  let disp = S(2) / 100.0 * 0.06;
  let r = srcAt(c + d * f * (1.0 + disp) * R);
  let g = srcAt(c + d * f * R);
  let b = srcAt(c + d * f * (1.0 - disp) * R);
  return vec4f(r.r, g.g, b.b, max(max(r.a, g.a), b.a));
}
fn bayer2(a0: vec2f) -> f32 {
  let a = floor(a0);
  return fract(a.x / 2.0 + a.y * a.y * 0.75);
}
fn bayer4(a: vec2f) -> f32 { return bayer2(0.5 * a) * 0.25 + bayer2(a); }
fn bayer8(a: vec2f) -> f32 { return bayer4(0.5 * a) * 0.25 + bayer2(a); }
fn dither() -> vec4f {
  let ps = max(S(0), 1.0);
  let levels = max(floor(S(1) + 0.5), 2.0) - 1.0;
  let cell = floor(NP / ps);
  let s = srcAt((cell + 0.5) * ps);
  if (s.a <= 0.0) { return vec4f(0.0); }
  let c = unpre(s);
  let t = bayer8(cell) - 0.5;
  if (S(2) > 0.5) { return vec4f(clamp(floor(c * levels + 0.5 + t) / levels, vec3f(0.0), vec3f(1.0)), 1.0) * s.a; }
  let col = mix(C(0), C(1), clamp(floor(luma(c) * levels + 0.5 + t) / levels, 0.0, 1.0));
  return vec4f(col.rgb, 1.0) * col.a * s.a;
}
fn gradientMap() -> vec4f {
  let s = src(vec2f(0.0));
  if (s.a <= 0.0) { return vec4f(0.0); }
  let c = unpre(s);
  let l = luma(c);
  let g = select(mix(C(1), C(2), l * 2.0 - 1.0), mix(C(0), C(1), l * 2.0), l < 0.5);
  return vec4f(mix(c, g.rgb, S(0) / 100.0), 1.0) * s.a;
}
fn warp() -> vec4f {
  let p = NP / max(S(1), 1.0);
  let oct = 1 + i32(S(2) / 100.0 * 4.0 + 0.5);
  let off = vec2f(fbm(p, oct), fbm(p + vec2f(5.2, 1.3), oct)) - 0.5;
  return src(off * 2.0 * S(0));
}
fn pixelate() -> vec4f {
  let ps = max(S(0), 1.0);
  let cc = (floor(NP / ps) + 0.5) * ps;
  var s = srcAt(cc);
  if (S(1) > 0.5) { s *= cover(distance(NP, cc) - ps * 0.5); }
  return s;
}
fn bokeh() -> vec4f {
  let R = S(0);
  if (R <= 0.0) { return src(vec2f(0.0)); }
  let boost = S(1) / 100.0 * 4.0;
  var acc = vec4f(0.0);
  var wsum = 0.0;
  for (var i = 0; i < 64; i++) {
    let fi = f32(i) + 0.5;
    let a = fi * 2.39996323;
    let s = src(vec2f(cos(a), sin(a)) * sqrt(fi / 64.0) * R);
    let w = 1.0 + boost * pow(luma(unpre(s)), 4.0) * s.a;
    acc += s * w;
    wsum += w;
  }
  return acc / wsum;
}
fn outlines() -> vec4f {
  let w = max(S(0), 0.5);
  let count = i32(clamp(S(1), 1.0, 6.0) + 0.5);
  let gap = max(S(2), 0.0);
  let s = src(vec2f(0.0));
  let maxD = f32(count) * (w + gap) + 1.0;
  var dist = 0.0;
  if (s.a < 0.5) {
    dist = 1e9;
    for (var i = 1; i <= 24; i++) {
      let r = maxD * f32(i) / 24.0;
      var hit = 0.0;
      for (var k = 0; k < 12; k++) {
        let a = f32(k) * 0.5235988;
        hit = max(hit, src(vec2f(cos(a), sin(a)) * r).a);
      }
      if (hit >= 0.5) {
        dist = r;
        break;
      }
    }
  }
  var ring = 0.0;
  for (var i = 0; i < 6; i++) {
    if (i >= count) { break; }
    let a0 = gap + f32(i) * (w + gap);
    ring = max(ring, clamp(min(dist - a0, a0 + w - dist) * K + 0.5, 0.0, 1.0));
  }
  if (dist <= 0.0) { ring = 0.0; }
  let col = vec4f(C(0).rgb, 1.0) * C(0).a * ring;
  let base = select(vec4f(0.0), s, S(3) > 0.5);
  return base + col * (1.0 - base.a);
}
fn crt() -> vec4f {
  var c = NP / SIZE * 2.0 - 1.0;
  c *= 1.0 + S(0) / 100.0 * 0.25 * (c.yx * c.yx);
  let q = c * 0.5 + 0.5;
  if (q.x < 0.0 || q.y < 0.0 || q.x > 1.0 || q.y > 1.0) { return vec4f(0.0); }
  let qp = q * SIZE;
  let s = srcAt(qp);
  let line = max(S(3), 1.0);
  let scan = 1.0 - S(1) / 100.0 * 0.6 * (0.5 + 0.5 * cos(qp.y * 6.28318 / line));
  let m = fmod1(floor(qp.x / (line / 3.0)), 3.0);
  let mask = S(2) / 100.0 * 0.7;
  let gains = vec3f(select(1.0 - mask, 1.0, m < 0.5), select(1.0 - mask, 1.0, m >= 0.5 && m < 1.5), select(1.0 - mask, 1.0, m >= 1.5));
  let v = q * (1.0 - q);
  let vig = clamp(pow(max(v.x * v.y * 16.0, 0.0), 0.25), 0.0, 1.0);
  return vec4f(s.rgb * scan * gains * vig, s.a);
}
fn bloom() -> vec4f {
  let s = src(vec2f(0.0));
  let thr = S(0) / 100.0;
  let R = max(S(2), 0.0);
  var glow = vec3f(0.0);
  var wsum = 0.0;
  for (var i = 0; i < 48; i++) {
    let fi = f32(i) + 0.5;
    let r = sqrt(fi / 48.0) * R;
    let a = fi * 2.39996323;
    let t = src(vec2f(cos(a), sin(a)) * r);
    let b = max(luma(unpre(t)) - thr, 0.0) / max(1.0 - thr, 1e-3);
    let w = exp(-r * r / max(R * R * 0.5, 1e-3));
    glow += t.rgb * b * w;
    wsum += w;
  }
  glow = glow / max(wsum, 1e-3) * S(1) / 100.0 * 2.0;
  let a = clamp(max(s.a, max(glow.r, max(glow.g, glow.b))), 0.0, 1.0);
  return vec4f(min(s.rgb + glow, vec3f(a)), a);
}
fn glowingParticles() -> vec4f {
  let s = src(vec2f(0.0));
  let size = max(S(0), 0.5);
  let dens = S(1) / 100.0;
  let glow = max(S(2), 0.0);
  let cs = max(size * 4.0, glow * 1.5 + size);
  let base = floor(NP / cs);
  var acc = 0.0;
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      let id = base + vec2f(f32(i), f32(j));
      if (hash12(id + 5.3) > dens) { continue; }
      let center = (id + 0.15 + 0.7 * hash22(id + 2.1)) * cs;
      if (srcAt(center).a < 0.5) { continue; }
      let d = distance(NP, center) - size * 0.5 * (0.5 + hash12(id + 8.8));
      acc += cover(d) + select(0.0, exp(-max(d, 0.0) / max(glow * 0.35, 0.3)) * 0.6, glow > 0.0);
    }
  }
  let col = vec4f(C(0).rgb, 1.0) * clamp(acc, 0.0, 1.0) * C(0).a;
  return col + s * (1.0 - col.a);
}
fn colorAdjust() -> vec4f {
  let s = src(vec2f(0.0));
  if (s.a <= 0.0) { return vec4f(0.0); }
  var c = unpre(s) + S(0) / 100.0;
  c = (c - 0.5) * (1.0 + S(1) / 100.0) + 0.5;
  c = mix(vec3f(luma(c)), c, 1.0 + S(2) / 100.0);
  return vec4f(clamp(hueShift(c, S(3)), vec3f(0.0), vec3f(1.0)), 1.0) * s.a;
}
fn pixelStretch() -> vec4f {
  let dir = i32(S(1) + 0.5);
  let pos = S(0) / 100.0;
  var p = NP;
  if (dir <= 1) {
    let x = pos * SIZE.x;
    if (select((p.x < x), (p.x > x), dir == 0)) { p.x = x + (hash12(vec2f(floor(p.y), 3.1)) - 0.5) * S(2); }
  } else {
    let y = pos * SIZE.y;
    if (select((p.y < y), (p.y > y), dir == 2)) { p.y = y + (hash12(vec2f(floor(p.x), 7.9)) - 0.5) * S(2); }
  }
  return srcAt(p);
}
fn gooey() -> vec4f {
  let R = max(S(0), 0.5);
  let t = S(1) / 100.0;
  var acc = vec4f(0.0);
  var wsum = 0.0;
  for (var i = 0; i < 48; i++) {
    let fi = f32(i) + 0.5;
    let r = sqrt(fi / 48.0) * R;
    let a = fi * 2.39996323;
    let w = exp(-2.0 * r * r / (R * R));
    acc += src(vec2f(cos(a), sin(a)) * r) * w;
    wsum += w;
  }
  acc /= wsum;
  let e = 0.5 / max(R * K, 1.0) + 0.02;
  return vec4f(unpre(acc), 1.0) * smoothstep(t - e, t + e, acc.a);
}
fn blobs() -> vec4f {
  let s = src(vec2f(0.0));
  if (s.a <= 0.0) { return vec4f(0.0); }
  let n = i32(clamp(S(0), 1.0, 12.0) + 0.5);
  let size = S(1) / 100.0 * min(SIZE.x, SIZE.y) * 0.5;
  var field = 0.0;
  var second = 0.0;
  for (var i = 0; i < 12; i++) {
    if (i >= n) { break; }
    let c = (0.15 + 0.7 * hash22(vec2f(f32(i) * 1.37, 4.2))) * SIZE;
    let r = size * (0.6 + 0.8 * hash12(vec2f(f32(i), 9.1)));
    let d = NP - c;
    let f = r * r / max(dot(d, d), 1e-3);
    field += f;
    if (i - (i / 2) * 2 == 1) { second += f; }
  }
  let e = mix(0.02, 0.6, S(2) / 100.0);
  let bc = mix(C(0), C(1), second / max(field, 1e-6));
  let blob = vec4f(bc.rgb, 1.0) * bc.a * smoothstep(1.0 - e, 1.0 + e, field) * s.a;
  return blob + s * (1.0 - blob.a);
}
fn sliceShift() -> vec4f {
  let vertical = S(2) > 0.5;
  let uv = NP / SIZE;
  let idx = floor(select(uv.y, uv.x, vertical) * max(floor(S(0) + 0.5), 1.0));
  let off = (hash12(vec2f(idx, 1.7)) - 0.5) * 2.0 * S(1);
  return src(select(vec2f(off, 0.0), vec2f(0.0, off), vertical));
}
fn lightRays() -> vec4f {
  let s = src(vec2f(0.0));
  let ang = radians(S(0));
  let dir = vec2f(cos(ang), sin(ang));
  let len = max(S(1), 0.0);
  var acc = 0.0;
  for (var i = 0; i < 32; i++) {
    let t = (f32(i) + 0.5) / 32.0;
    acc += src(-dir * t * len).a * (1.0 - t);
  }
  let col = vec4f(C(0).rgb, 1.0) * C(0).a * clamp(acc / 16.0 * S(2) / 100.0 * 1.5, 0.0, 1.0);
  return s + col * (1.0 - s.a);
}
fn hatch(ang: f32, sp: f32, w: f32) -> f32 {
  let q = rot(NP, -radians(ang));
  return cover(abs(fract(q.y / sp) - 0.5) * sp - w * 0.5);
}
fn hatching() -> vec4f {
  let s = src(vec2f(0.0));
  if (s.a <= 0.0) { return vec4f(0.0); }
  let d = 1.0 - luma(unpre(s));
  let sp = max(S(0), 1.0);
  let ang = S(1);
  let w = max(S(2), 0.25);
  var ink = 0.0;
  if (d > 0.15) { ink = max(ink, hatch(ang, sp, w)); }
  if (d > 0.4) { ink = max(ink, hatch(ang + 90.0, sp, w)); }
  if (d > 0.65) { ink = max(ink, hatch(ang + 45.0, sp, w)); }
  if (d > 0.85) { ink = max(ink, hatch(ang - 45.0, sp, w)); }
  let col = mix(C(1), C(0), ink);
  return vec4f(col.rgb, 1.0) * col.a * s.a;
}
fn edgeValue(t: vec4f) -> f32 { return luma(t.rgb) + t.a; }
fn coloredEdges() -> vec4f {
  let s = src(vec2f(0.0));
  let w = max(S(0), 0.5);
  let a = edgeValue(src(vec2f(-w, -w)));
  let b = edgeValue(src(vec2f(0.0, -w)));
  let c = edgeValue(src(vec2f(w, -w)));
  let d = edgeValue(src(vec2f(-w, 0.0)));
  let f = edgeValue(src(vec2f(w, 0.0)));
  let g = edgeValue(src(vec2f(-w, w)));
  let h = edgeValue(src(vec2f(0.0, w)));
  let i = edgeValue(src(vec2f(w, w)));
  let grad = vec2f((c + 2.0 * f + i) - (a + 2.0 * d + g), (g + 2.0 * h + i) - (a + 2.0 * b + c));
  let e = clamp(length(grad) * 0.25 * S(1) / 100.0, 0.0, 1.0);
  let col = vec4f(C(0).rgb, 1.0) * C(0).a * e;
  let base = select(s, vec4f(0.0), S(2) > 0.5);
  return col + base * (1.0 - col.a);
}
fn duotone() -> vec4f {
  let s = src(vec2f(0.0));
  if (s.a <= 0.0) { return vec4f(0.0); }
  let l = clamp((luma(unpre(s)) - 0.5) * (1.0 + S(0) / 100.0) + 0.5, 0.0, 1.0);
  let c = mix(C(0), C(1), l);
  return vec4f(c.rgb, 1.0) * c.a * s.a;
}
fn channelMixer() -> vec4f {
  let s = src(vec2f(0.0));
  if (s.a <= 0.0) { return vec4f(0.0); }
  let c = unpre(s);
  let o = vec3f(dot(c, vec3f(S(0), S(1), S(2))), dot(c, vec3f(S(3), S(4), S(5))), dot(c, vec3f(S(6), S(7), S(8)))) / 100.0;
  return vec4f(clamp(o, vec3f(0.0), vec3f(1.0)), 1.0) * s.a;
}
fn filterPresets() -> vec4f {
  let s = src(vec2f(0.0));
  if (s.a <= 0.0) { return vec4f(0.0); }
  let c = unpre(s);
  let f = i32(S(0) + 0.5);
  let l = luma(c);
  var o = sepia(c);
  if (f == 0) { o = (mix(sepia(c), vec3f(0.94, 0.86, 0.72), 0.15) - 0.5) * 0.9 + 0.53; }
  else if (f == 1) { o = vec3f((l - 0.5) * 1.4 + 0.5); }
  else if (f == 2) { o = c * vec3f(1.08, 1.0, 0.86) + vec3f(0.03, 0.01, 0.0); }
  else if (f == 3) { o = c * vec3f(0.88, 1.0, 1.1) + vec3f(0.0, 0.01, 0.03); }
  else if (f == 4) { o = (mix(vec3f(l), c, 1.45) - 0.5) * 1.1 + 0.5; }
  else if (f == 5) { o = mix(vec3f(l), c, 0.65) * 0.85 + 0.12; }
  return vec4f(mix(c, clamp(o, vec3f(0.0), vec3f(1.0)), S(1) / 100.0), 1.0) * s.a;
}

@fragment fn fs(v: VOut) -> @location(0) vec4f {
  DEV = v.dev;
  NP = vec2f(dot(u.v[4].xyz, vec3f(DEV, 1.0)), dot(u.v[5].xyz, vec3f(DEV, 1.0)));
  SIZE = max(u.v[6].zw, vec2f(1e-3));
  K = sqrt(abs(u.v[7].x * u.v[7].w - u.v[7].y * u.v[7].z));
  let program = i32(u.v[6].x + 0.5);
  if (u.v[6].y < 0.5) {
    let uv = NP / SIZE;
    var c = vec4f(0.0);
    if (program == 0) { c = movingGradient(uv); }
    else if (program == 1) { c = meshGradient(uv); }
    else if (program == 2) { c = nebula(); }
    else if (program == 3) { c = waterCaustic(); }
    else if (program == 4) { c = fractalNoise(); }
    else if (program == 5) { c = clouds(); }
    else if (program == 6) { c = moire(); }
    else if (program == 7) { c = glowingWave(); }
    else if (program == 8) { c = concentric(); }
    else if (program == 9) { c = patternGrid(); }
    c = clamp(c, vec4f(0.0), vec4f(1.0));
    return vec4f(c.rgb * c.a, c.a);
  }
  var o = vec4f(0.0);
  if (program == 0) { o = particles(); }
  else if (program == 1) { o = refraction(); }
  else if (program == 2) { o = halftone(); }
  else if (program == 3) { o = chromaticMetal(); }
  else if (program == 4) { o = lens(); }
  else if (program == 5) { o = dither(); }
  else if (program == 6) { o = gradientMap(); }
  else if (program == 7) { o = warp(); }
  else if (program == 8) { o = pixelate(); }
  else if (program == 9) { o = bokeh(); }
  else if (program == 10) { o = outlines(); }
  else if (program == 11) { o = crt(); }
  else if (program == 12) { o = bloom(); }
  else if (program == 13) { o = glowingParticles(); }
  else if (program == 14) { o = colorAdjust(); }
  else if (program == 15) { o = pixelStretch(); }
  else if (program == 16) { o = gooey(); }
  else if (program == 17) { o = blobs(); }
  else if (program == 18) { o = sliceShift(); }
  else if (program == 19) { o = lightRays(); }
  else if (program == 20) { o = hatching(); }
  else if (program == 21) { o = coloredEdges(); }
  else if (program == 22) { o = duotone(); }
  else if (program == 23) { o = channelMixer(); }
  else if (program == 24) { o = filterPresets(); }
  else { o = src(vec2f(0.0)); }
  let a = clamp(o.a, 0.0, 1.0);
  return vec4f(clamp(o.rgb, vec3f(0.0), vec3f(a)), a);
}
)";

}  // namespace eng::gfx::wgsl
