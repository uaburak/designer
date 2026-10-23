// Wecra's frame scrollbar (Prototype › Scroll behavior › Scrollbar: NodeChange.prototypeScrollbar, @ours; docs/engine.md
// §3.4). A scrolling frame with it on draws a thumb over its content, inside its visible box: along the right edge
// for vertical scrolling, along the bottom for horizontal (both for both directions). The look is Figma's own panel
// scrollbar (the owner's reference): 6 px thick (or the frame's prototypeScrollbarWidth, 2–24), fully rounded, 4 px in
// from the edge and from the track's ends, as long as the visible part of the content (at least 24 px), placed by the
// scroll offset; only on an axis whose content runs past the box. Its ink is the frame's prototypeScrollbarColor, else
// white or black at 30 % (frameScrollbarInk). Drawn by the renderer after the frame's children (the canvas at scroll 0,
// the presentation at the player's scroll); the player hit-tests the same thumbs to drag them.
#pragma once

#include <algorithm>

#include "math/Math.h"
#include "scene/CodecKiwi.h"
#include "scene/Document.h"
#include "scene/Node.h"

namespace eng {

// What a frame's scrollbar is drawn from, in the frame's own space.
struct FrameScrollbarState {
  Rect box;           // the part of the frame shown (a top-level frame cut to the screen; else the whole frame)
  Vec2 scroll;        // how far it is scrolled
  Vec2 range;         // how far it scrolls on each axis (0: not on that axis)
  bool horizontal = false, vertical = false;  // the axes its overflow scrolls
  double thickness = 6;  // the thumb's thickness (frameScrollbarWidth)
};

struct FrameScrollbarThumbs {
  bool h = false, v = false;
  Rect hTrack, hThumb, vTrack, vThumb;
};

constexpr double kFrameScrollbarThickness = 6;
constexpr double kFrameScrollbarInset = 4;
constexpr double kFrameScrollbarMinThumb = 24;
constexpr double kFrameScrollbarMinThickness = 2, kFrameScrollbarMaxThickness = 24;

// A frame's thumb thickness: its prototypeScrollbarWidth (@ours) clamped to 2–24, else 6.
inline double frameScrollbarWidth(const NodeProps& p) {
  double w;
  if (!codec::extraFloat(p.extra, "prototypeScrollbarWidth", w)) return kFrameScrollbarThickness;
  return std::clamp(w, kFrameScrollbarMinThickness, kFrameScrollbarMaxThickness);
}

// A frame's thumb colour with its alpha (prototypeScrollbarColor, @ours): false when it has none (the automatic ink).
inline bool frameScrollbarColor(const NodeProps& p, Color& out) {
  if (!codec::extraColor(p.extra, "prototypeScrollbarColor", out)) return false;
  out.r = std::clamp(out.r, 0.f, 1.f);
  out.g = std::clamp(out.g, 0.f, 1.f);
  out.b = std::clamp(out.b, 0.f, 1.f);
  out.a = std::clamp(out.a, 0.f, 1.f);
  return true;
}

// What a frame's thumbs are drawn in, its alpha the thumb's: the frame's own colour (prototypeScrollbarColor), else a
// neutral grey over the content — white at 30 % on a dark frame (the owner's reference, Figma's own panels), black at
// 30 % on a light one. A frame without a solid fill shows what is behind it: the nearest one up its parents decides (a
// list in a dark panel); none at all, black.
inline Color frameScrollbarInk(const Document& doc, Guid id, const NodeProps& p) {
  Color own;
  if (frameScrollbarColor(p, own)) return own;
  for (Guid at = id; at != kNoGuid; at = doc.parentOf(at)) {
    const Node* an = doc.get(at);
    if (!an && at != id) break;
    const NodeProps& ap = at == id ? p : an->props;
    for (auto f = ap.fillPaints.rbegin(); f != ap.fillPaints.rend(); ++f) {
      if (!f->visible || f->type != PaintType::SOLID || f->opacity * f->color.a < 0.5f) continue;
      bool dark = 0.2126 * f->color.r + 0.7152 * f->color.g + 0.0722 * f->color.b < 0.5;
      return dark ? Color{1, 1, 1, 0.3f} : Color{0, 0, 0, 0.3f};
    }
  }
  return Color{0, 0, 0, 0.3f};
}

inline FrameScrollbarThumbs frameScrollbarThumbs(const FrameScrollbarState& s) {
  const double T = s.thickness, I = kFrameScrollbarInset, M = kFrameScrollbarMinThumb;
  FrameScrollbarThumbs out;
  bool v = s.vertical && s.range.y > 0.5 && s.box.h > 0;
  bool h = s.horizontal && s.range.x > 0.5 && s.box.w > 0;
  // One axis: its track along the whole edge; both: each stops short of the corner the other takes.
  auto place = [&](bool vertical, bool other, Rect& track, Rect& thumb) {
    double view = vertical ? s.box.h : s.box.w, range = vertical ? s.range.y : s.range.x;
    double len = view - 2 * I - (other ? T + I : 0);
    if (len < M) return false;
    double thumbLen = std::min(len, std::max(M, len * view / (view + range)));
    double p = range > 0 ? std::clamp((vertical ? s.scroll.y : s.scroll.x) / range, 0.0, 1.0) : 0;
    double at = p * (len - thumbLen);
    if (vertical) {
      track = {s.box.right() - I - T, s.box.y + I, T, len};
      thumb = {track.x, track.y + at, T, thumbLen};
    } else {
      track = {s.box.x + I, s.box.bottom() - I - T, len, T};
      thumb = {track.x + at, track.y, thumbLen, T};
    }
    return true;
  };
  bool vOk = v && place(true, h, out.vTrack, out.vThumb);
  bool hOk = h && place(false, v, out.hTrack, out.hThumb);
  out.v = vOk;
  out.h = hOk;
  return out;
}

}  // namespace eng
