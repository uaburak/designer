#include "motion/Easing.h"

#include <algorithm>
#include <cmath>

namespace eng::motion {

double cubicBezier(double x1, double y1, double x2, double y2, double x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  auto sample = [](double a1, double a2, double t) {
    double u = 1 - t;
    return 3 * u * u * t * a1 + 3 * u * t * t * a2 + t * t * t;
  };
  auto slope = [](double a1, double a2, double t) {
    double u = 1 - t;
    return 3 * u * u * a1 + 6 * u * t * (a2 - a1) + 3 * t * t * (1 - a2);
  };
  double t = x;
  for (int i = 0; i < 8; i++) {
    double err = sample(x1, x2, t) - x;
    if (std::fabs(err) < 1e-7) break;
    double d = slope(x1, x2, t);
    if (std::fabs(d) < 1e-6) break;
    t -= err / d;
  }
  if (t < 0 || t > 1 || std::fabs(sample(x1, x2, t) - x) > 1e-4) {
    // Bisection when Newton wanders off.
    double lo = 0, hi = 1;
    t = x;
    for (int i = 0; i < 40; i++) {
      double s = sample(x1, x2, t);
      if (std::fabs(s - x) < 1e-7) break;
      if (s < x) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
  }
  return sample(y1, y2, t);
}

double springOmega(const Spring& s) { return std::sqrt(s.stiffness / s.mass); }

double springZeta(const Spring& s) { return std::max(kMinZeta, s.damping / (2 * std::sqrt(s.stiffness * s.mass))); }

double springValue(const Spring& s, double t) {
  if (t <= 0) return 0;
  double w0 = springOmega(s), zeta = springZeta(s), v0 = s.initialVelocity;
  // x(t) = 1 − value: x(0) = 1, x'(0) = −v0.
  double x;
  if (zeta < 1) {
    double wd = w0 * std::sqrt(1 - zeta * zeta);
    x = std::exp(-zeta * w0 * t) * (std::cos(wd * t) + ((zeta * w0 - v0) / wd) * std::sin(wd * t));
  } else if (zeta == 1) {
    x = std::exp(-w0 * t) * (1 + (w0 - v0) * t);
  } else {
    double r = w0 * std::sqrt(zeta * zeta - 1);
    double r1 = -zeta * w0 + r, r2 = -zeta * w0 - r;
    double c1 = (-v0 - r2) / (r1 - r2);
    x = c1 * std::exp(r1 * t) + (1 - c1) * std::exp(r2 * t);
  }
  return 1 - x;
}

double springSettleTime(const Spring& s) {
  double w0 = springOmega(s), zeta = std::min(springZeta(s), kMaxSettleZeta);
  double wd = w0 * std::sqrt(1 - zeta * zeta);
  return (-std::log(0.001) + std::log(1 + (zeta * w0 + std::fabs(s.initialVelocity)) / wd)) / (zeta * w0);
}

double springEditorDuration(const Spring& s) { return 6 / (springZeta(s) * springOmega(s)); }

Spring springWithEditorDuration(const Spring& s, double seconds) {
  Spring out = s;
  if (!(seconds > 0)) return out;
  double zeta = springZeta(s);
  double w0 = 6 / (seconds * zeta);
  if (w0 > 0) {
    double digits = std::floor(std::log10(w0)) + 1;
    double scale = std::pow(10.0, 4 - digits);
    w0 = std::round(w0 * scale) / scale;
  }
  w0 = std::clamp(w0, kMinOmega, kMaxOmega);
  out.stiffness = w0 * w0 * s.mass;
  out.damping = 2 * zeta * w0 * s.mass;
  return out;
}

}  // namespace eng::motion
