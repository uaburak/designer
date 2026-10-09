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

// Figma's icon before a component's (and a component set's) or an instance's title.
enum class TitleIcon : uint8_t { None, Component, Instance };

struct FrameTitle {
  Guid id = kNoGuid;
  bool section = false;  // a section's pill (else a frame's name above it)
  TitleIcon icon = TitleIcon::None;
  Rect iconBox;          // screen CSS px (icon != None)
  Rect frame;            // screen CSS px: the frame's box (its AABB on screen)
  Rect text;             // screen CSS px: the name's box (a frame's: its width capped at the frame's)
  Rect hit;              // screen CSS px: what a press on the title takes
  double baseline = 0;   // screen y of the name's baseline
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
