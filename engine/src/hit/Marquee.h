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

}  // namespace eng
