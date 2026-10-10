// Canvas navigation, round 16 (docs/engine.md §6.11 "Scrollbars", §6.12 "Camera animation"):
// - the camera gliding to a target (a Layers row's glyph clicked: the layer zoomed to fit, as ⇧2, over 300 ms);
// - the canvas scrollbars (the owner's live Figma 58 / 59 / 61–63.png): shown while the view moves and while the
//   pointer is over a bar's zone, fading out after; a thumb drags the view, a press on the track pages it.

#include <algorithm>
#include <cmath>

#include "editor/Editor.h"

namespace eng {

namespace {

// A bar's zone: its track, widened inwards (the pointer shows it, a press there is the bar's).
constexpr double kZoneReach = 6;

Rect zoneOf(const ScrollbarAxis& a) {
  if (a.vertical) return {a.track.x - kZoneReach, a.track.y, a.track.w + kZoneReach + Scrollbars::kInset, a.track.h};
  return {a.track.x, a.track.y - kZoneReach, a.track.w, a.track.h + kZoneReach + Scrollbars::kInset};
}

double easeInOut(double t) { return t < 0.5 ? 4 * t * t * t : 1 - std::pow(-2 * t + 2, 3) / 2; }

}  // namespace

// ---- Camera animation ---------------------------------------------------------

void Editor::animateCamera(const Camera& to, double ms) {
  Camera target{to.x, to.y, Camera::clampZoom(to.zoom)};
  if (ms <= 0 || (target.x == camera_.x && target.y == camera_.y && target.zoom == camera_.zoom)) {
    stopCameraAnimation();
    changeCamera(target);
    return;
  }
  camAnim_ = {true, camera_, target, -1, ms};
  needsRender_ = true;
}

void Editor::stopCameraAnimation() {
  if (!camAnim_.on) return;
  camAnim_.on = false;
  zooming_ = false;
  needsRender_ = true;
}

void Editor::cameraTick(double timeMs) {
  if (!camAnim_.on) return;
  if (camAnim_.start < 0) camAnim_.start = timeMs;
  double t = std::clamp((timeMs - camAnim_.start) / camAnim_.duration, 0.0, 1.0);
  if (t >= 1) {
    camAnim_.on = false;
    zooming_ = false;  // settled: the page drawn sharp at the new zoom
    changeCamera(camAnim_.to);
    needsRender_ = true;
    return;
  }
  const Camera& a = camAnim_.from;
  const Camera& b = camAnim_.to;
  double e = easeInOut(t);
  Vec2 vc = visibleCentre();
  Vec2 c0 = a.toWorld(vc), c1 = b.toWorld(vc);
  // The zoom geometric; the world point at the view's centre moving with 1 / zoom — a zoom about a fixed point is
  // exactly that path, so a target that is one glides as one (else it reads as a zoom towards the target).
  double z = a.zoom * std::pow(b.zoom / a.zoom, e);
  double w = e;
  double span = 1 / b.zoom - 1 / a.zoom;
  if (std::fabs(span) > 1e-9 / std::min(a.zoom, b.zoom)) w = (1 / z - 1 / a.zoom) / span;
  Vec2 c{c0.x + (c1.x - c0.x) * w, c0.y + (c1.y - c0.y) * w};
  zooming_ = a.zoom != b.zoom;
  changeCamera({vc.x - c.x * z, vc.y - c.y * z, z});
}

// ---- Scrollbars -----------------------------------------------------------------

Rect Editor::pageContentBounds(bool& any) {
  if (scroll_.version != doc_.version() || scroll_.page != page_) {
    scroll_.version = doc_.version();
    scroll_.page = page_;
    scroll_.any = false;
    scroll_.content = {};
    if (page_ != kNoGuid)
      for (Guid c : doc_.children(page_)) {
        const Node* n = doc_.get(c);
        if (!n || !n->props.visible) continue;
        Rect b = doc_.worldBounds(c);
        scroll_.content = scroll_.any ? scroll_.content.united(b) : b;
        scroll_.any = true;
      }
  }
  any = scroll_.any;
  return scroll_.content;
}

Scrollbars Editor::scrollbars() {
  bool any = false;
  Rect w = pageContentBounds(any);
  Rect s = any ? transformedBounds(camera_.matrix() * Mat2x3::translate(w.x, w.y), w.w, w.h) : Rect{};
  // A panel on the right: its resize handle reaches 6 px over the canvas (live: the handle at 1193, the panel's line at
  // 1199), so the bar keeps clear of it and stays reachable.
  return scrollbarGeometry(viewport_.visible(), s, any, viewport_.insetRight > 0 ? 6 : 0);
}

bool Editor::scrollbarHover(Vec2 s) {
  Scrollbars b = scrollbars();
  bool h = b.h.show && zoneOf(b.h).contains(s);
  bool v = !h && b.v.show && zoneOf(b.v).contains(s);
  if (h != scroll_.hoverH || v != scroll_.hoverV) {
    scroll_.hoverH = h;
    scroll_.hoverV = v;
    needsRender_ = true;
  }
  if (h || v) scroll_.pendingShow = true;
  return h || v;
}

uint32_t Editor::scrollbarPointerDown(Vec2 s) {
  Scrollbars b = scrollbars();
  for (int axis = 0; axis < 2; axis++) {
    const ScrollbarAxis& a = axis == 0 ? b.h : b.v;
    if (!a.show || !zoneOf(a).contains(s)) continue;
    stopCameraAnimation();
    double at = a.vertical ? s.y : s.x;
    double from = a.vertical ? a.thumb.y : a.thumb.x, to = a.vertical ? a.thumb.bottom() : a.thumb.right();
    gesture_ = Gesture::Scrollbar;
    downScreen_ = lastScreen_ = s;
    downCamera_ = camera_;
    scroll_.pendingShow = true;
    changeCursor(CursorKind::DEFAULT);
    if (at >= from && at <= to) {
      // The thumb: dragged, the view follows (the extent as it is now).
      scroll_.drag = axis + 1;
      scroll_.panPerPx = a.panPerThumbPx();
    } else {
      // The track: a page (the visible length) towards the press.
      scroll_.drag = 0;
      double page = (at > to ? 1 : -1) * a.viewLength;
      changeCamera(snapped(a.vertical ? camera_.panned(0, -page) : camera_.panned(-page, 0)));
    }
    needsRender_ = true;
    return P_HANDLED | P_CAPTURE;
  }
  return 0;
}

void Editor::scrollbarPointerMove(Vec2 s) {
  scroll_.pendingShow = true;
  if (scroll_.drag == 0) return;
  double d = (scroll_.drag == 2 ? s.y - downScreen_.y : s.x - downScreen_.x) * scroll_.panPerPx;
  // By whole device pixels (the cached page pixels shift, §6.9).
  double sx = viewport_.scaleX() > 0 ? viewport_.scaleX() : 1, sy = viewport_.scaleY() > 0 ? viewport_.scaleY() : 1;
  if (scroll_.drag == 2) changeCamera(downCamera_.panned(0, -std::round(d * sy) / sy));
  else changeCamera(downCamera_.panned(-std::round(d * sx) / sx, 0));
}

void Editor::scrollbarTick(double timeMs) {
  if (scroll_.pendingShow) {
    scroll_.pendingShow = false;
    scroll_.shownAt = timeMs;
  }
  if (gesture_ == Gesture::Scrollbar || scroll_.hoverH || scroll_.hoverV) scroll_.shownAt = timeMs;
  double since = timeMs - scroll_.shownAt;
  double a = since <= kScrollbarShowMs ? 1 : since >= kScrollbarShowMs + kScrollbarFadeMs ? 0 : 1 - (since - kScrollbarShowMs) / kScrollbarFadeMs;
  if (a == scroll_.alpha) return;
  // Only a frame when there is a bar to show or hide.
  Scrollbars b = scrollbars();
  if (b.h.show || b.v.show) needsRender_ = true;
  scroll_.alpha = a;
}

int32_t Editor::scrollbarDelay() const {
  if (scroll_.pendingShow) return 0;
  if (scroll_.alpha <= 0) return -1;
  double since = timeMs_ - scroll_.shownAt;
  if (since < kScrollbarShowMs) return static_cast<int32_t>(std::max(1.0, std::ceil(kScrollbarShowMs - since)));
  return 16;  // fading
}

void Editor::scrollbarOverlay(Overlay& o) const {
  if (scroll_.alpha <= 0) return;
  o.scrollbars.bars = const_cast<Editor*>(this)->scrollbars();
  o.scrollbars.alpha = scroll_.alpha;
  o.scrollbars.hotH = scroll_.hoverH || (gesture_ == Gesture::Scrollbar && scroll_.drag == 1);
  o.scrollbars.hotV = scroll_.hoverV || (gesture_ == Gesture::Scrollbar && scroll_.drag == 2);
}

}  // namespace eng
