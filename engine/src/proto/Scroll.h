// Scroll physics of Figma's prototype viewer (docs/research/atlas/13-prototyping.md §8.2): a frame dragged and let
// go flings by the platform's rules — iOS and macOS bounce (friction, resistance past the ends, a spring back), Android,
// Windows and Linux clamp (Android's OverScroller curve, stopped at the ends). Figma's numbers are those of Flutter's
// scroll simulations (BouncingScrollSimulation, ClampingScrollSimulation, FrictionSimulation, the scroll spring), so
// these follow their shape. One axis at a time, in CSS px and seconds.
#pragma once

#include <cstdint>

namespace eng::proto::scroll {

enum class Physics : uint8_t { NONE, BOUNCING, CLAMPING };

// When a motion counts as at rest: 1 device pixel, and 1 device pixel per 50 ms.
struct Tolerance {
  double distance = 1;
  double velocity = 20;
};
Tolerance toleranceFor(double dpr);

// Bouncing: how much of a drag's `delta` moves the content when it is past an end (`position` outside [min, max],
// `viewport` the frame's length on that axis) — 0.52 · (1 − overscroll / viewport)², easier on the way back in.
double applyDrag(double position, double delta, double min, double max, double viewport);

class Simulation {
 public:
  Simulation() = default;
  // Bouncing: friction (drag 0.135) inside [min, max], a spring (mass 0.5, stiffness 100, damping ratio 1.1) back
  // from past an end; the velocity a fling carries into the spring is at most 5000 px/s.
  static Simulation bouncing(double position, double velocity, double min, double max, Tolerance tol);
  // Clamping: Android's fling curve (friction 0.015), positions kept in [min, max]; `duration` > 0 replaces the
  // curve's own (the cross axis of a fling shares the main axis's).
  static Simulation clamping(double position, double velocity, double min, double max, Tolerance tol, double duration = -1);
  // The fling's own length (clamping), seconds.
  static double clampingDuration(double velocity);

  double x(double t) const;
  double dx(double t) const;
  bool done(double t) const;
  bool active() const { return kind_ != Kind::NONE; }

 private:
  enum class Kind : uint8_t { NONE, BOUNCING, CLAMPING } kind_ = Kind::NONE;
  Tolerance tol_;
  double min_ = 0, max_ = 0;
  // Friction: x(t) = p + v·dragᵗ / ln drag − v / ln drag.
  double p_ = 0, v_ = 0;
  // The spring (overdamped): x(t) = end + c1·e^(r1 t) + c2·e^(r2 t), from `springAt` on (−∞: from the start).
  double springAt_ = 0, end_ = 0, r1_ = 0, r2_ = 0, c1_ = 0, c2_ = 0;
  bool spring_ = false;
  // Clamping: the fling's length and distance.
  double duration_ = 0, distance_ = 0;
  void setSpring(double start, double end, double velocity);
  double springX(double t) const;
  double springDx(double t) const;
};

}  // namespace eng::proto::scroll
