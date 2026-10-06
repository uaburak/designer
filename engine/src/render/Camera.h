// The view onto the page: the page's origin on screen (CSS px from the
// viewport's top left) and the zoom — the same arithmetic as
// src/renderer/src/figma/view.ts (zoomAround, fitView).
#pragma once

#include "math/Math.h"

namespace eng {

inline constexpr double kMinZoom = 0.02;
inline constexpr double kMaxZoom = 256;

struct Camera {
  double x = 0, y = 0, zoom = 1;

  static double clampZoom(double z) { return z < kMinZoom ? kMinZoom : (z > kMaxZoom ? kMaxZoom : z); }

  Vec2 toWorld(Vec2 screen) const { return {(screen.x - x) / zoom, (screen.y - y) / zoom}; }
  Vec2 toScreen(Vec2 world) const { return {world.x * zoom + x, world.y * zoom + y}; }
  // World → screen as an affine map.
  Mat2x3 matrix() const { return {zoom, 0, x, 0, zoom, y}; }

  // Zoomed to `z`, the world point under `at` (screen px) staying put.
  Camera zoomedAround(double z, Vec2 at) const {
    double next = clampZoom(z);
    Vec2 p = toWorld(at);
    return {at.x - p.x * next, at.y - p.y * next, next};
  }
  Camera panned(double dx, double dy) const { return {x + dx, y + dy, zoom}; }

  // The view fitting `rect` (world) in a viewport of width × height with 64px
  // of room around it; never above 100% when `upTo100`.
  static Camera fit(const Rect& rect, double width, double height, bool upTo100) {
    const double room = 64;
    double z = std::min((width - room * 2) / std::max(1.0, rect.w), (height - room * 2) / std::max(1.0, rect.h));
    if (upTo100) z = std::min(z, 1.0);
    z = clampZoom(z);
    return {(width - rect.w * z) / 2 - rect.x * z, (height - rect.h * z) / 2 - rect.y * z, z};
  }
};

}  // namespace eng
