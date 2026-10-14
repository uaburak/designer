// The view onto the page: the page's origin on screen (CSS px from the
// viewport's top left) and the zoom — the same arithmetic as
// src/renderer/src/figma/view.ts (zoomAround, fitView).
#pragma once

#include "math/Math.h"

namespace eng {

inline constexpr double kMinZoom = 0.02;
inline constexpr double kMaxZoom = 256;
// The canvas ends this far from the origin on each axis, as Figma's does (owner, checked in Figma 2026-10-15: a layer
// may be placed further out, but the view stops at ±130,000): the view is kept inside it.
inline constexpr double kCanvasBound = 130000;

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

  // This view moved (never zoomed) so that what it shows of the world within `visible` (screen px) stays inside the
  // canvas's ±kCanvasBound on each axis; a view wider than the whole canvas is centred on the origin.
  Camera keptOnCanvas(const Rect& visible) const {
    Camera c = *this;
    if (!(visible.w > 0 && visible.h > 0 && zoom > 0)) return c;
    auto axis = [&](double& off, double lo, double size) {
      double w0 = (lo - off) / zoom, w1 = (lo + size - off) / zoom;
      if (w1 - w0 >= 2 * kCanvasBound) off = lo + size / 2;
      else if (w0 < -kCanvasBound) off = lo + kCanvasBound * zoom;
      else if (w1 > kCanvasBound) off = lo + size - kCanvasBound * zoom;
    };
    axis(c.x, visible.x, visible.w);
    axis(c.y, visible.y, visible.h);
    return c;
  }

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
