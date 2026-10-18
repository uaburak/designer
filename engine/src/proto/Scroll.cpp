#include "proto/Scroll.h"

#include <algorithm>
#include <cmath>
#include <limits>

namespace eng::proto::scroll {

namespace {

// Bouncing (iOS, macOS).
constexpr double kDrag = 0.135;                // FrictionSimulation's drag
constexpr double kSpringMass = 0.5, kSpringStiffness = 100, kSpringRatio = 1.1;
constexpr double kMaxSpringTransfer = 5000;    // px/s a fling carries into the spring at an end
// Clamping (Android, Windows, Linux): Android's OverScroller.
constexpr double kFriction = 0.015;
constexpr double kInflexion = 0.35;
constexpr double kPhysicalCoeff = 9.80665 * 39.37 * 160.0 * 0.84;  // 61774.04968 × 0.84
const double kDecelerationRate = std::log(0.78) / std::log(0.9);

constexpr double kInf = std::numeric_limits<double>::infinity();

double frictionFactor(double overscrollFraction) { return 0.52 * std::pow(1 - overscrollFraction, 2); }

double applyFriction(double extentOutside, double absDelta, double gamma) {
  double total = 0;
  if (extentOutside > 0) {
    double toLimit = extentOutside / gamma;
    if (absDelta < toLimit) return absDelta * gamma;
    total += extentOutside;
    absDelta -= toLimit;
  }
  return total + absDelta;
}

double sign(double v) { return v > 0 ? 1 : v < 0 ? -1 : 0; }

}  // namespace

Tolerance toleranceFor(double dpr) {
  double d = dpr > 0 ? dpr : 1;
  return {1 / d, 1 / (0.05 * d)};
}

double applyDrag(double position, double delta, double min, double max, double viewport) {
  if (delta == 0 || (position >= min && position <= max)) return delta;
  double pastStart = std::max(min - position, 0.0), pastEnd = std::max(position - max, 0.0);
  double past = std::max(pastStart, pastEnd);
  bool easing = (pastStart > 0 && delta > 0) || (pastEnd > 0 && delta < 0);
  double v = std::max(1.0, viewport);
  double gamma = frictionFactor(std::clamp((easing ? past - std::fabs(delta) : past) / v, 0.0, 1.0));
  if (gamma <= 0) return 0;
  return sign(delta) * applyFriction(past, std::fabs(delta), gamma);
}

void Simulation::setSpring(double start, double end, double velocity) {
  // Overdamped: c² > 4mk with the ratio 1.1.
  double c = kSpringRatio * 2 * std::sqrt(kSpringMass * kSpringStiffness);
  double cmk = c * c - 4 * kSpringMass * kSpringStiffness;
  r1_ = (-c - std::sqrt(cmk)) / (2 * kSpringMass);
  r2_ = (-c + std::sqrt(cmk)) / (2 * kSpringMass);
  double d = start - end;
  c2_ = (velocity - r1_ * d) / (r2_ - r1_);
  c1_ = d - c2_;
  end_ = end;
  spring_ = true;
}

double Simulation::springX(double t) const { return end_ + c1_ * std::exp(r1_ * t) + c2_ * std::exp(r2_ * t); }
double Simulation::springDx(double t) const { return c1_ * r1_ * std::exp(r1_ * t) + c2_ * r2_ * std::exp(r2_ * t); }

Simulation Simulation::bouncing(double position, double velocity, double min, double max, Tolerance tol) {
  Simulation s;
  s.kind_ = Kind::BOUNCING;
  s.tol_ = tol;
  s.min_ = min;
  s.max_ = std::max(min, max);
  s.p_ = position;
  s.v_ = velocity;
  if (position < s.min_ || position > s.max_) {
    // Past an end already: the spring brings it back.
    s.setSpring(position, position < s.min_ ? s.min_ : s.max_, velocity);
    s.springAt_ = 0;
    return s;
  }
  double dragLog = std::log(kDrag);
  double finalX = position - velocity / dragLog;
  auto timeAt = [&](double x) { return std::log(dragLog * (x - position) / velocity + 1) / dragLog; };
  if (velocity > 0 && finalX > s.max_) {
    s.springAt_ = timeAt(s.max_);
    s.setSpring(s.max_, s.max_, std::clamp(s.dx(s.springAt_), -kMaxSpringTransfer, kMaxSpringTransfer));
  } else if (velocity < 0 && finalX < s.min_) {
    s.springAt_ = timeAt(s.min_);
    s.setSpring(s.min_, s.min_, std::clamp(s.dx(s.springAt_), -kMaxSpringTransfer, kMaxSpringTransfer));
  } else {
    s.springAt_ = kInf;
  }
  return s;
}

double Simulation::clampingDuration(double velocity) {
  double v = std::fabs(velocity);
  if (v <= 0) return 0;
  double l = std::log(kInflexion * v / (kFriction * kPhysicalCoeff));
  return std::exp(l / (kDecelerationRate - 1));
}

Simulation Simulation::clamping(double position, double velocity, double min, double max, Tolerance tol, double duration) {
  Simulation s;
  s.kind_ = Kind::CLAMPING;
  s.tol_ = tol;
  s.min_ = min;
  s.max_ = std::max(min, max);
  s.p_ = std::clamp(position, s.min_, s.max_);
  s.v_ = velocity;
  double v = std::fabs(velocity);
  if (v > 0) {
    double l = std::log(kInflexion * v / (kFriction * kPhysicalCoeff));
    s.distance_ = kFriction * kPhysicalCoeff * std::exp(kDecelerationRate / (kDecelerationRate - 1) * l);
    s.duration_ = duration > 0 ? duration : std::exp(l / (kDecelerationRate - 1));
  }
  return s;
}

double Simulation::x(double t) const {
  switch (kind_) {
    case Kind::BOUNCING: {
      if (spring_ && t >= springAt_) {
        double ts = t - springAt_;
        // At rest: exactly at the end.
        if (std::fabs(springX(ts) - end_) < tol_.distance && std::fabs(springDx(ts)) < tol_.velocity) return end_;
        return springX(ts);
      }
      double dragLog = std::log(kDrag);
      return p_ + v_ * std::pow(kDrag, t) / dragLog - v_ / dragLog;
    }
    case Kind::CLAMPING: {
      if (duration_ <= 0) return p_;
      double u = std::clamp(t / duration_, 0.0, 1.0);
      double pen = 1.2 * u * u * u - 3.27 * u * u + 3.065 * u;
      return std::clamp(p_ + distance_ * pen * sign(v_), min_, max_);
    }
    case Kind::NONE: break;
  }
  return p_;
}

double Simulation::dx(double t) const {
  switch (kind_) {
    case Kind::BOUNCING:
      if (spring_ && t >= springAt_) return springDx(t - springAt_);
      return v_ * std::pow(kDrag, t);
    case Kind::CLAMPING: {
      if (duration_ <= 0 || t >= duration_) return 0;
      double here = x(t);
      if ((here <= min_ && v_ < 0) || (here >= max_ && v_ > 0)) return 0;  // stopped at an end
      double u = std::clamp(t / duration_, 0.0, 1.0);
      return distance_ * (3.6 * u * u - 6.54 * u + 3.065) * sign(v_) / duration_;
    }
    case Kind::NONE: break;
  }
  return 0;
}

bool Simulation::done(double t) const {
  switch (kind_) {
    case Kind::BOUNCING:
      if (spring_ && t >= springAt_) {
        double ts = t - springAt_;
        return std::fabs(springX(ts) - end_) < tol_.distance && std::fabs(springDx(ts)) < tol_.velocity;
      }
      return std::fabs(dx(t)) < tol_.velocity;
    case Kind::CLAMPING: return t >= duration_ || dx(t) == 0;
    case Kind::NONE: break;
  }
  return true;
}

}  // namespace eng::proto::scroll
