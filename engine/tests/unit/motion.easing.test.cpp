// Easing maths (motion/Easing.h): Figma's curve and spring numbers, its closed-form settle time T, the ζ clamp, the
// initial velocity, and the spring editor's 6 / (ζω₀) duration (docs/research/rea/motion.md §2.3, §2.5).
#include <cmath>

#include "doctest.h"
#include "motion/Easing.h"
#include "proto/Prototype.h"

using namespace eng;

TEST_CASE("motion.easing: Figma's preset numbers") {
  CHECK(motion::kEaseIn.x1 == 0.42);
  CHECK(motion::kEaseIn.x2 == 1);
  CHECK(motion::kEaseOut.x1 == 0);
  CHECK(motion::kEaseOut.x2 == 0.58);
  CHECK(motion::kEaseInOutBack.y2 == 1.4);
  CHECK(motion::kQuick.stiffness == 300);
  CHECK(motion::kQuick.damping == 20);
  CHECK(motion::kBouncy.stiffness == 600);
  CHECK(motion::kBouncy.damping == 15);
  CHECK(motion::kSlow.stiffness == 80);
  CHECK(motion::kSlow.damping == 20);
  CHECK(motion::kInvalidSpring.damping == 10);
  CHECK(motion::cubicBezier(0, 0, 1, 1, 0.3) == doctest::Approx(0.3).epsilon(0.001));
  CHECK(motion::cubicBezier(0.42, 0, 0.58, 1, 0.5) == doctest::Approx(0.5).epsilon(0.001));
}

TEST_CASE("motion.easing: the settle time is Figma's closed form T (GENTLE ≈ 1.022 s)") {
  // GENTLE: ω₀ = 10, ζ = 0.75, ω_d = 6.614 → T = (6.9078 + ln(1 + 7.5 / 6.614)) / 7.5.
  CHECK(motion::springOmega(motion::kGentle) == doctest::Approx(10));
  CHECK(motion::springZeta(motion::kGentle) == doctest::Approx(0.75));
  double T = motion::springSettleTime(motion::kGentle);
  CHECK(T == doctest::Approx((-std::log(0.001) + std::log(1 + 7.5 / (10 * std::sqrt(1 - 0.5625)))) / 7.5));
  CHECK(T == doctest::Approx(1.022).epsilon(0.001));
  // Within 0.1 % of the end from T on (the envelope bound).
  for (double t = T; t < T + 2; t += 0.01) CHECK(std::fabs(motion::springValue(motion::kGentle, t) - 1) <= 0.001);
  // The prototype's spring transitions last T.
  proto::Action a;
  a.easing = proto::Easing::GENTLE_SPRING;
  CHECK(proto::durationOf(a) == doctest::Approx(T));
  CHECK(proto::ease(a, 1) == 1);
  a.easing = proto::Easing::SPRING;  // legacy: Gentle
  CHECK(proto::durationOf(a) == doctest::Approx(T));
}

TEST_CASE("motion.easing: ζ is clamped to ≥ 0.03 (an undamped spring settles) and ≤ 0.9999 in T") {
  motion::Spring undamped{1, 100, 0, 0};
  CHECK(motion::springZeta(undamped) == doctest::Approx(0.03));
  double T = motion::springSettleTime(undamped);
  CHECK(std::isfinite(T));
  CHECK(T > 10);
  // Critically and over-damped springs: finite T, a value that rises to 1 without overshoot.
  motion::Spring critical{1, 100, 20, 0}, over{1, 100, 40, 0};
  CHECK(std::isfinite(motion::springSettleTime(critical)));
  CHECK(std::isfinite(motion::springSettleTime(over)));
  for (double t = 0; t < 3; t += 0.05) {
    CHECK(motion::springValue(critical, t) <= 1 + 1e-9);
    CHECK(motion::springValue(over, t) <= 1 + 1e-9);
  }
  CHECK(motion::springValue(critical, 0) == 0);
  CHECK(motion::springValue(over, 0) == doctest::Approx(0));
}

TEST_CASE("motion.easing: the initial velocity starts the spring moving and lengthens T") {
  motion::Spring still = motion::kGentle, moving = motion::kGentle;
  moving.initialVelocity = 5;
  double dt = 1e-4;
  CHECK(motion::springValue(still, dt) / dt == doctest::Approx(0).epsilon(0.01));
  CHECK(motion::springValue(moving, dt) / dt == doctest::Approx(5).epsilon(0.01));
  CHECK(motion::springSettleTime(moving) > motion::springSettleTime(still));
  // A custom spring reads v0 as easingFunction's fourth value.
  proto::Action a;
  a.easing = proto::Easing::CUSTOM_SPRING;
  a.easingFunction = {1, 100, 15, 5};
  CHECK(proto::durationOf(a) == doctest::Approx(motion::springSettleTime(moving)));
  // Unreadable custom springs fall back to Figma's {1, 100, 10}.
  a.easingFunction = {1, 100};
  CHECK(proto::durationOf(a) == doctest::Approx(motion::springSettleTime(motion::kInvalidSpring)));
  a.easingFunction = {0, 100, 15};
  CHECK(proto::durationOf(a) == doctest::Approx(motion::springSettleTime(motion::kInvalidSpring)));
}

TEST_CASE("motion.easing: the spring editor's duration 6 / (ζω₀) = 12m / c and its inverse") {
  CHECK(motion::springEditorDuration(motion::kGentle) == doctest::Approx(12.0 / 15));
  CHECK(motion::springEditorDuration(motion::kQuick) == doctest::Approx(12.0 / 20));
  motion::Spring s = motion::springWithEditorDuration(motion::kGentle, 1.6);
  // ζ and the mass kept; ω₀ = 6 / (1.6 · 0.75) = 5.
  CHECK(s.mass == 1);
  CHECK(motion::springZeta(s) == doctest::Approx(0.75));
  CHECK(motion::springOmega(s) == doctest::Approx(5));
  CHECK(s.stiffness == doctest::Approx(25));
  CHECK(motion::springEditorDuration(s) == doctest::Approx(1.6));
  // ω₀ rounds to 4 significant digits: 6 / (0.7 · 0.75) = 11.428571… → 11.43.
  CHECK(motion::springOmega(motion::springWithEditorDuration(motion::kGentle, 0.7)) == doctest::Approx(11.43));
}
