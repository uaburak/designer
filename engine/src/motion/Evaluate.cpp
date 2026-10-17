#include "motion/Evaluate.h"

#include <algorithm>
#include <cmath>

namespace eng::motion {

namespace {

constexpr double kPi = 3.14159265358979323846;

// ---- Colour spaces (docs/motion.md §4.8): gamma-encoded sRGB components in, the same out ----

double srgbToLinear(double c) { return c <= 0.04045 ? c / 12.92 : std::pow((c + 0.055) / 1.055, 2.4); }
double linearToSrgb(double c) { return c <= 0.0031308 ? c * 12.92 : 1.055 * std::pow(c, 1 / 2.4) - 0.055; }

struct Lab {
  double l, a, b;
};

Lab toOklab(const Color& c) {
  double r = srgbToLinear(c.r), g = srgbToLinear(c.g), b = srgbToLinear(c.b);
  double l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  double m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  double s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
  double l_ = std::cbrt(l), m_ = std::cbrt(m), s_ = std::cbrt(s);
  return {0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_, 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
          0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_};
}

Color fromOklab(const Lab& lab, float alpha) {
  double l_ = lab.l + 0.3963377774 * lab.a + 0.2158037573 * lab.b;
  double m_ = lab.l - 0.1055613458 * lab.a - 0.0638541728 * lab.b;
  double s_ = lab.l - 0.0894841775 * lab.a - 1.2914855480 * lab.b;
  double l = l_ * l_ * l_, m = m_ * m_ * m_, s = s_ * s_ * s_;
  double r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  double g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  double b = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
  auto enc = [](double v) { return static_cast<float>(std::clamp(linearToSrgb(std::clamp(v, 0.0, 1.0)), 0.0, 1.0)); };
  return {enc(r), enc(g), enc(b), alpha};
}

struct Hsl {
  double h, s, l;  // h degrees
};

Hsl toHsl(const Color& c) {
  double r = c.r, g = c.g, b = c.b;
  double mx = std::max({r, g, b}), mn = std::min({r, g, b});
  double l = (mx + mn) / 2, d = mx - mn, h = 0, s = 0;
  if (d > 1e-9) {
    s = d / (1 - std::fabs(2 * l - 1));
    if (mx == r) h = std::fmod((g - b) / d, 6.0);
    else if (mx == g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return {h, s, l};
}

Color fromHsl(const Hsl& x, float alpha) {
  double c = (1 - std::fabs(2 * x.l - 1)) * x.s;
  double hp = std::fmod(std::fmod(x.h, 360.0) + 360.0, 360.0) / 60;
  double m = x.l - c / 2;
  double xx = c * (1 - std::fabs(std::fmod(hp, 2.0) - 1));
  double r = 0, g = 0, b = 0;
  if (hp < 1) r = c, g = xx;
  else if (hp < 2) r = xx, g = c;
  else if (hp < 3) g = c, b = xx;
  else if (hp < 4) g = xx, b = c;
  else if (hp < 5) r = xx, b = c;
  else r = c, b = xx;
  auto f = [&](double v) { return static_cast<float>(std::clamp(v + m, 0.0, 1.0)); };
  return {f(r), f(g), f(b), alpha};
}

// The hue path from a to b (degrees) under a hue method, as CSS Color 4 defines them.
double hueTo(double a, double b, HueMethod m) {
  double d = b - a;
  switch (m) {
    case HueMethod::SHORTER:
      if (d > 180) return b - 360;
      if (d < -180) return b + 360;
      return b;
    case HueMethod::LONGER:
      if (d > 0 && d < 180) return b - 360;
      if (d <= 0 && d > -180) return b + 360;
      return b;
    case HueMethod::INCREASING: return d < 0 ? b + 360 : b;
    case HueMethod::DECREASING: return d > 0 ? b - 360 : b;
  }
  return b;
}

}  // namespace

const Bezier* presetBezier(EasingType t) {
  switch (t) {
    case EasingType::LINEAR: return &kLinear;
    case EasingType::IN_CUBIC:
    case EasingType::EASE_IN: return &kEaseIn;
    case EasingType::OUT_CUBIC: return &kEaseOut;
    case EasingType::INOUT_CUBIC: return &kEaseInOut;
    case EasingType::IN_BACK_CUBIC: return &kEaseInBack;
    case EasingType::OUT_BACK_CUBIC: return &kEaseOutBack;
    case EasingType::INOUT_BACK_CUBIC: return &kEaseInOutBack;
    default: return nullptr;
  }
}

const Spring* presetSpring(EasingType t) {
  switch (t) {
    case EasingType::SPRING:
    case EasingType::GENTLE_SPRING: return &kGentle;
    case EasingType::SPRING_PRESET_ONE: return &kQuick;
    case EasingType::SPRING_PRESET_TWO: return &kBouncy;
    case EasingType::SPRING_PRESET_THREE: return &kSlow;
    default: return nullptr;
  }
}

double easeKeyframe(const EasingSpec& e, double p) {
  p = std::clamp(p, 0.0, 1.0);
  // "No easing" (absent, or the kiwi default IN_CUBIC) is Figma's CUSTOM_CUBIC (0.5, 0, 0.5, 1) on a keyframe.
  if (!e.present || e.type == EasingType::IN_CUBIC) return cubicBezier(0.5, 0, 0.5, 1, p);
  if (e.type == EasingType::HOLD) return hold(p);
  if (e.type == EasingType::CUSTOM_CUBIC) return bezierAt(e.bezier, p);
  if (e.type == EasingType::CUSTOM_SPRING) return springNormalized(e.springValid ? e.spring : kInvalidSpring, p);
  if (const Spring* s = presetSpring(e.type)) return springNormalized(*s, p);
  if (const Bezier* b = presetBezier(e.type)) return bezierAt(*b, p);
  return cubicBezier(0.5, 0, 0.5, 1, p);
}

double lerp(double a, double b, double e) { return a + (b - a) * e; }

Color lerpColor(const Color& a, const Color& b, double e, ColorSpace space, HueMethod hue) {
  float alpha = static_cast<float>(lerp(a.a, b.a, e));  // alpha linear, not premultiplied
  switch (space) {
    case ColorSpace::SRGB_LINEAR: {
      auto ch = [&](float x, float y) {
        return static_cast<float>(std::clamp(linearToSrgb(lerp(srgbToLinear(x), srgbToLinear(y), e)), 0.0, 1.0));
      };
      return {ch(a.r, b.r), ch(a.g, b.g), ch(a.b, b.b), alpha};
    }
    case ColorSpace::OKLAB: {
      Lab la = toOklab(a), lb = toOklab(b);
      return fromOklab({lerp(la.l, lb.l, e), lerp(la.a, lb.a, e), lerp(la.b, lb.b, e)}, alpha);
    }
    case ColorSpace::OKLCH: {
      Lab la = toOklab(a), lb = toOklab(b);
      double ca = std::hypot(la.a, la.b), cb = std::hypot(lb.a, lb.b);
      double ha = ca < 1e-6 ? 0 : std::atan2(la.b, la.a) * 180 / kPi, hb = cb < 1e-6 ? 0 : std::atan2(lb.b, lb.a) * 180 / kPi;
      if (ha < 0) ha += 360;
      if (hb < 0) hb += 360;
      if (ca < 1e-6) ha = hb;  // an achromatic end takes the other's hue
      if (cb < 1e-6) hb = ha;
      double h = lerp(ha, hueTo(ha, hb, hue), e) * kPi / 180, c = lerp(ca, cb, e), l = lerp(la.l, lb.l, e);
      return fromOklab({l, c * std::cos(h), c * std::sin(h)}, alpha);
    }
    case ColorSpace::HSL: {
      Hsl ha = toHsl(a), hb = toHsl(b);
      if (ha.s < 1e-6) ha.h = hb.h;
      if (hb.s < 1e-6) hb.h = ha.h;
      return fromHsl({lerp(ha.h, hueTo(ha.h, hb.h, hue), e), lerp(ha.s, hb.s, e), lerp(ha.l, hb.l, e)}, alpha);
    }
    case ColorSpace::DEFAULT:
    default: {
      auto ch = [&](float x, float y) { return static_cast<float>(lerp(x, y, e)); };
      return {ch(a.r, b.r), ch(a.g, b.g), ch(a.b, b.b), alpha};
    }
  }
}

Vec2 motionPathPoint(Vec2 a, Vec2 outA, Vec2 inB, Vec2 b, double e) {
  Vec2 p1 = a + outA, p2 = b + inB;
  bool straight = outA.x == 0 && outA.y == 0 && inB.x == 0 && inB.y == 0;
  if (straight) return a + (b - a) * e;
  auto at = [&](double t) {
    double u = 1 - t;
    return a * (u * u * u) + p1 * (3 * u * u * t) + p2 * (3 * u * t * t) + b * (t * t * t);
  };
  // Arc length: 64 samples, the eased progress mapped to a parameter by length.
  constexpr int kSamples = 64;
  double len[kSamples + 1];
  len[0] = 0;
  Vec2 prev = a;
  for (int i = 1; i <= kSamples; i++) {
    Vec2 cur = at(static_cast<double>(i) / kSamples);
    len[i] = len[i - 1] + (cur - prev).length();
    prev = cur;
  }
  double total = len[kSamples];
  if (total <= 0) return a;
  double target = std::clamp(e, 0.0, 1.0) * total;
  int i = 1;
  while (i < kSamples && len[i] < target) i++;
  double seg = len[i] - len[i - 1];
  double f = seg > 0 ? (target - len[i - 1]) / seg : 0;
  return at((static_cast<double>(i - 1) + f) / kSamples);
}

KeyframeValue interpolate(const Keyframe& a, const Keyframe& b, double e) {
  const KeyframeValue& va = a.value;
  const KeyframeValue& vb = b.value;
  switch (vb.kind) {
    case ValueKind::FLOAT: return KeyframeValue::number(lerp(va.f, vb.f, e));
    case ValueKind::VECTOR: {
      Vec2 outA = a.hasPathHandles ? a.pathOut : Vec2{0, 0};
      Vec2 inB = b.hasPathHandles ? b.pathIn : Vec2{0, 0};
      return KeyframeValue::vector(motionPathPoint(va.v, outA, inB, vb.v, e));
    }
    case ValueKind::COLOR: return KeyframeValue::color(lerpColor(va.c, vb.c, e, b.colorSpace, b.hueMethod));
    default: return e >= 1 ? vb : va;  // BOOL, TEXT_DATA, the rest: a step at the next keyframe
  }
}

int64_t localTime(int64_t timeUs, int64_t durationUs, Playback playback) {
  if (durationUs <= 0) return 0;
  switch (playback) {
    case Playback::ONCE: return std::clamp<int64_t>(timeUs, 0, durationUs);
    case Playback::LOOP: {
      int64_t m = timeUs % durationUs;
      return m < 0 ? m + durationUs : m;
    }
    case Playback::BOOMERANG: {
      int64_t period = 2 * durationUs;
      int64_t m = timeUs % period;
      if (m < 0) m += period;
      return m <= durationUs ? m : period - m;
    }
  }
  return timeUs;
}

bool trackValue(const Track& t, int64_t tauUs, KeyframeValue& out) {
  const auto& k = t.keyframes;
  if (k.empty()) return false;
  if (t.loop && k.size() >= 2 && k.back().timeUs > k.front().timeUs) {
    int64_t span = k.back().timeUs - k.front().timeUs;
    int64_t m = (tauUs - k.front().timeUs) % span;
    if (m < 0) m += span;
    tauUs = k.front().timeUs + m;
  }
  if (tauUs <= k.front().timeUs) {
    out = k.front().value;
    return true;
  }
  if (tauUs >= k.back().timeUs) {
    out = k.back().value;
    return true;
  }
  // Binary search for the segment kᵢ < τ < kᵢ₊₁.
  size_t lo = 0, hi = k.size() - 1;
  while (hi - lo > 1) {
    size_t mid = (lo + hi) / 2;
    if (k[mid].timeUs <= tauUs) lo = mid;
    else hi = mid;
  }
  const Keyframe& a = k[lo];
  const Keyframe& b = k[hi];
  if (tauUs == a.timeUs) {
    out = a.value;
    return true;
  }
  double p = static_cast<double>(tauUs - a.timeUs) / static_cast<double>(b.timeUs - a.timeUs);
  out = interpolate(a, b, easeKeyframe(b.easing, p));
  return true;
}

}  // namespace eng::motion
