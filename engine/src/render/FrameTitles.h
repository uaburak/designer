// Frame and section titles on the canvas (docs/engine.md §6.11): which frames show their name and where, shared by
// the overlay that draws them (render/Overlay.cpp) and the editor that hit-tests them (tools/Gestures.cpp), so a
// press lands exactly on what is drawn.
#pragma once

#include <functional>
#include <string>
#include <vector>

#include "render/OverlayStyle.h"
#include "scene/Document.h"

namespace eng {

// Where a layer's canvas labels lie (its frame name above it, its W × H badge below it): along its edges, turned with
// it, never upside down (live Figma, docs/research/chrome-cursors/: a frame turned 37° shows "Frame 406" along its
// top edge from its top-left corner and "332 × 423" centred under its bottom edge, both turned 37°). The labels read
// along the layer's x axis on screen, turned half a turn when that axis points left (or straight down), so their text
// always reads left to right, or bottom to top when vertical; a layer past ±90° then has its name over what is its
// bottom edge — the edge that is on top on screen. `place` maps label-local coordinates to the screen (a rotation
// about the screen's origin; the identity for an upright layer, whose labels are where they always were); `box` is
// the layer's box in label-local coordinates (the hull of its corners: for a skewed or flipped layer too).
struct LabelFrame {
  Mat2x3 place;
  Rect box;
  bool upright = true;  // `place` is the identity
};
LabelFrame labelFrame(const Mat2x3& toScreen, Vec2 size);

// Figma's icon before a component's (and a component set's) or an instance's title.
enum class TitleIcon : uint8_t { None, Component, Instance };

// The rects and the baseline below are label-local (`place` maps them to the screen; the identity for an upright frame,
// so they are screen CSS px then).
struct FrameTitle {
  Guid id = kNoGuid;
  bool section = false;  // a section's pill (else a frame's name above it)
  TitleIcon icon = TitleIcon::None;
  Rect iconBox;          // icon != None
  Rect frame;            // the frame's box (upright: its AABB on screen)
  Rect text;             // the name's box (a frame's: its width capped at the frame's)
  Rect hit;              // what a press on the title takes
  double baseline = 0;   // y of the name's baseline
  Mat2x3 place;          // label-local → screen CSS px (labelFrame)
  bool upright = true;   // place is the identity
  bool hits(Vec2 screen) const { return hit.contains(upright ? screen : place.inverse().apply(screen)); }
  // A label-local rect's bounds on screen.
  Rect onScreen(const Rect& r) const {
    return upright ? r : transformedBounds(place * Mat2x3::translate(r.x, r.y), r.w, r.h);
  }
};

// Whether `id` shows a title: a frame (component, instance, set — not a group) that is a direct child of the page or
// of a section (Figma: "top-level" frames, including those inside sections), or a section.
bool showsTitle(const Document& doc, Guid id);

// The titles on `page` whose frames are near `screen` (CSS px), in paint order — every titled frame's but an
// instance's (live Figma draws no name over a top-level instance, selected or not). `view` maps world to screen;
// `measure(name, section)` is the name's width in CSS px at the title's size. `focus` (Dev Mode's focus view): only
// that frame's.
std::vector<FrameTitle> frameTitles(const Document& doc, Guid page, const Mat2x3& view, const Rect& screen, const OverlayStyle& style,
                                    const std::function<double(const std::string&, bool)>& measure, Guid focus = kNoGuid);

}  // namespace eng
