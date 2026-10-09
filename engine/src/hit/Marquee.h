// What a marquee selects (docs/engine.md §8.2, today's Canvas.tsx:990-1039).
#pragma once

#include <vector>

#include "scene/Document.h"

namespace eng {

// With `scope` (the top-level frame the drag started in): that frame's direct
// children the rect touches. Otherwise the page's children it touches; a frame
// only partly covered contributes its touched children instead of itself.
// Hidden and locked nodes are skipped.
std::vector<Guid> marqueeHits(const Document& doc, Guid page, const Rect& rect, Guid scope);

// ⌘-marquee (Figma: "hold ⌘ while dragging to select nested layers"): the innermost layers the rect touches, at any
// depth — layers without children (an instance counts as one, its sublayers aren't taken), and a nested frame with a
// fill or stroke when nothing in it is touched (the rect only on its padding or gaps), where they show (a clipping
// frame's outside doesn't count). Hidden and locked layers, and what is in them, are skipped. Paint order.
std::vector<Guid> marqueeDeepHits(const Document& doc, Guid page, const Rect& rect);

}  // namespace eng
