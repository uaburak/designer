// Track evaluation (docs/motion.md §4.4, §4.7, §4.8): a keyframe's easing, interpolation per value type (floats,
// vectors along the motion path by arc length, colours in their interpolation space), a track's value at a local time,
// and the fold of a binding's tracks over its base value (SET / OFFSET / SCALE).
#pragma once

#include <cstdint>
#include <vector>

#include "motion/Model.h"

namespace eng::motion {

// The eased progress into a keyframe: its easing at p ∈ [0, 1] (absent / IN_CUBIC → CUSTOM_CUBIC (0.5, 0, 0.5, 1);
// springs normalised; HOLD a step).
double easeKeyframe(const EasingSpec& e, double p);
// The resting bezier of an easing type (nullptr for springs and HOLD), for the chrome and codegen.
const Bezier* presetBezier(EasingType t);
const Spring* presetSpring(EasingType t);  // nullptr for the beziers and HOLD

// Interpolation (docs/motion.md §4.8).
double lerp(double a, double b, double e);
Color lerpColor(const Color& a, const Color& b, double e, ColorSpace space, HueMethod hue);
// A motion-path segment: P₀ = a, P₁ = a + outA, P₂ = b + inB, P₃ = b; `e` applied by arc length (a 64-sample table).
Vec2 motionPathPoint(Vec2 a, Vec2 outA, Vec2 inB, Vec2 b, double e);
// The value between two keyframes at eased progress e (the second keyframe's colour space, path handles).
KeyframeValue interpolate(const Keyframe& a, const Keyframe& b, double e);

// A track's value at local time τ (µs): the first value before t₀, the last after tₙ, eased in between; `loop` wraps τ.
// False for an empty track.
bool trackValue(const Track& t, int64_t tauUs, KeyframeValue& out);
// Local time under a playback style over a duration (ONCE clamps, LOOP wraps, BOOMERANG triangles).
int64_t localTime(int64_t timeUs, int64_t durationUs, Playback playback);

// The fold of a binding over its resolved base: each parameter's track combined by its operation, in list order — a
// preset's in its clip's time (τ − the clip's offset; a disabled clip is skipped). `tracks(id)` returns the track or
// nullptr. False when nothing applied (no track found).
template <typename TrackLookup>
bool foldValue(const KeyframeValue& base, const std::vector<Param>& params, int64_t tauUs, TrackLookup&& tracks, KeyframeValue& out) {
  out = base;
  bool any = false;
  for (const Param& p : params) {
    if (p.disabled) continue;
    const Track* t = tracks(p.track);
    if (!t) continue;
    KeyframeValue v;
    if (!trackValue(*t, p.kind == Param::Kind::ANIMATION_PRESET ? tauUs - p.offsetUs : tauUs, v)) continue;
    any = true;
    switch (t->operation) {
      case Operation::SET: out = v; break;
      case Operation::OFFSET:
        if (out.kind == ValueKind::VECTOR || v.kind == ValueKind::VECTOR) {
          Vec2 o = out.kind == ValueKind::VECTOR ? out.v : Vec2{out.f, out.f};
          Vec2 d = v.kind == ValueKind::VECTOR ? v.v : Vec2{v.f, v.f};
          out = KeyframeValue::vector(o + d);
        } else if (out.kind == ValueKind::COLOR && v.kind == ValueKind::COLOR) {
          out.c = {out.c.r + v.c.r, out.c.g + v.c.g, out.c.b + v.c.b, out.c.a + v.c.a};
        } else {
          out.f += v.f;
        }
        break;
      case Operation::SCALE:
        if (out.kind == ValueKind::VECTOR || v.kind == ValueKind::VECTOR) {
          Vec2 o = out.kind == ValueKind::VECTOR ? out.v : Vec2{out.f, out.f};
          Vec2 d = v.kind == ValueKind::VECTOR ? v.v : Vec2{v.f, v.f};
          out = KeyframeValue::vector({o.x * d.x, o.y * d.y});
        } else {
          out.f *= v.f;
        }
        break;
    }
  }
  return any;
}

}  // namespace eng::motion
