// The view onto the page: the page's origin on screen (CSS px from the
// viewport's top left) and the zoom — the same arithmetic as
// src/renderer/src/figma/view.ts (zoomAround, fitView).
#pragma once

#include "math/Math.h"

namespace eng {

// Figma Design's zoom range, 1/64 (1.5625 %) … 256 (25,600 %) (docs/research/atlas/04-canvas-selection.md §2.1).
inline constexpr double kMinZoom = 1.0 / 64;
inline constexpr double kMaxZoom = 256;
// The view's centre stays within this far from the origin on each axis, as Figma's does (Atlas 04 §2.1: 2^17; the
// owner's check in Figma, 2026-10-15, saw the view's edge stop at about ±130,000 — the centre's bound less half a view).
// A layer may be placed further out.
inline constexpr double kCanvasBound = 131072;
// Zoom to fit / zoom to selection: the room left on each side of what they show (Atlas 04 §2.3: Figma's zoom-to-rect
// paddings 50 / 80, halved per side).
inline constexpr double kFitPadding = 25;
inline constexpr double kSelectionPadding = 40;

struct Camera {
  double x = 0, y = 0, zoom = 1;

  static double clampZoom(double z) { return z < kMinZoom ? kMinZoom : (z > kMaxZoom ? kMaxZoom : z); }
  // Zoom in / out (the keys, the zoom menu, the Zoom tool's click): Figma Design's steps, to the next / previous power
  // of two (Atlas 04 §2.2: 100 % → 200 %, 150 % → 200 %, 75 % → 100 %; out: 100 % → 50 %, 150 % → 100 %).
  static double zoomedIn(double z) { return clampZoom(std::exp2(std::floor(std::log2(2 * z)))); }
  static double zoomedOut(double z) { return clampZoom(std::exp2(std::ceil(std::log2(z / 2)))); }

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

  // This view moved (never zoomed) so that the world point at the middle of `visible` (screen px) stays within the
  // canvas's ±kCanvasBound on each axis (Figma's clamp of the viewport's centre, Atlas 04 §2.1).
  Camera keptOnCanvas(const Rect& visible) const {
    Camera c = *this;
    if (!(visible.w > 0 && visible.h > 0 && zoom > 0)) return c;
    auto axis = [&](double& off, double lo, double size) {
      double mid = (lo + size / 2 - off) / zoom;
      if (mid < -kCanvasBound) off = lo + size / 2 + kCanvasBound * zoom;
      else if (mid > kCanvasBound) off = lo + size / 2 - kCanvasBound * zoom;
    };
    axis(c.x, visible.x, visible.w);
    axis(c.y, visible.y, visible.h);
    return c;
  }

  // The view fitting `rect` (world) in a viewport of width × height with `padding` px of room on each side, centred —
  // Figma's zoom to rect (Atlas 04 §2.3): no 100 % cap; a rect with no width or height is shown at 100 %. The caller
  // leaves the view as it is when the padding alone fills the viewport.
  static Camera fit(const Rect& rect, double width, double height, double padding) {
    double z = 1;
    if (rect.w > 0 && rect.h > 0) z = clampZoom(std::min((width - padding * 2) / rect.w, (height - padding * 2) / rect.h));
    return {(width - rect.w * z) / 2 - rect.x * z, (height - rect.h * z) / 2 - rect.y * z, z};
  }
};

}  // namespace eng
