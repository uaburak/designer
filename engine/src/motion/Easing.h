// Easing maths shared by prototypes now and by Motion (round 8, docs/motion.md §4.7) later: CSS cubic-bezier curves,
// Figma's preset numbers, and physical springs with Figma's closed-form settle time (docs/research/rea/motion.md
// §2.3, §2.5 — Figma's easing tables and spring module, read from its current build).
//
// A spring is physical: mass m, stiffness k, damping c, initial velocity v0 (progress per second, towards the end).
// ω₀ = √(k/m), ζ = c / (2√(km)). Its value runs 0 → 1 (springs overshoot), and it lasts Figma's settle time T:
//   T = (−ln 0.001 + ln(1 + (ζω₀ + |v₀|) / ω_d)) / (ζω₀),  ω_d = ω₀√(1 − ζ²),  ζ ≤ 0.9999
// — the time the under-damped envelope needs to stay within 0.1 % of the end. ζ is clamped to ≥ 0.03 everywhere, so
// an undamped spring still settles.
#pragma once

namespace eng::motion {

// cubic-bezier(x1, y1, x2, y2) at x ∈ [0, 1] (CSS's: x is time, solved for y; x1 and x2 are taken as given).
double cubicBezier(double x1, double y1, double x2, double y2, double x);

struct Bezier {
  double x1, y1, x2, y2;
};
// Figma's preset curves (its easing table; prototypes and Motion use the same numbers).
inline constexpr Bezier kEaseIn{0.42, 0, 1, 1};          // IN_CUBIC, EASE_IN
inline constexpr Bezier kEaseOut{0, 0, 0.58, 1};         // OUT_CUBIC, and CUSTOM_CUBIC's default in prototypes
inline constexpr Bezier kEaseInOut{0.42, 0, 0.58, 1};    // INOUT_CUBIC
inline constexpr Bezier kLinear{0, 0, 1, 1};             // LINEAR
inline constexpr Bezier kEaseInBack{0.3, -0.05, 0.7, -0.5};   // IN_BACK_CUBIC
inline constexpr Bezier kEaseOutBack{0.45, 1.45, 0.8, 1};     // OUT_BACK_CUBIC
inline constexpr Bezier kEaseInOutBack{0.7, -0.4, 0.4, 1.4};  // INOUT_BACK_CUBIC

struct Spring {
  double mass = 1, stiffness = 100, damping = 15, initialVelocity = 0;
};
// Figma's spring presets ([mass, stiffness, damping, v0]).
inline constexpr Spring kGentle{1, 100, 15, 0};   // GENTLE_SPRING, legacy SPRING, CUSTOM_SPRING's default
inline constexpr Spring kQuick{1, 300, 20, 0};    // SPRING_PRESET_ONE
inline constexpr Spring kBouncy{1, 600, 15, 0};   // SPRING_PRESET_TWO
inline constexpr Spring kSlow{1, 80, 20, 0};      // SPRING_PRESET_THREE
inline constexpr Spring kInvalidSpring{1, 100, 10, 0};  // what an unreadable custom spring falls back to

// The spring editor's limits (Figma's).
inline constexpr double kMinMass = 0.01, kMaxMass = 100;
inline constexpr double kMinStiffness = 0.01, kMaxStiffness = 10000;
inline constexpr double kMinDamping = 0.01, kMaxDamping = 1000;
inline constexpr double kMinOmega = 0.1, kMaxOmega = 1000;
inline constexpr double kMinZeta = 0.03, kMaxSettleZeta = 0.9999;

double springOmega(const Spring& s);  // ω₀
double springZeta(const Spring& s);   // ζ, clamped to ≥ kMinZeta
// The spring's value at `t` seconds: 0 at t = 0, settling at 1 (under-, critically or over-damped closed form).
double springValue(const Spring& s, double t);
// Figma's settle time T, seconds (what a spring transition lasts).
double springSettleTime(const Spring& s);
// The spring editor's Duration: 6 / (ζω₀) = 12m / c, seconds.
double springEditorDuration(const Spring& s);
// The editor's Duration typed: ω₀ = 6 / (d·ζ) (4 significant digits, kept in [kMinOmega, kMaxOmega]), mass and ζ kept —
// the new stiffness and damping.
Spring springWithEditorDuration(const Spring& s, double seconds);

}  // namespace eng::motion
