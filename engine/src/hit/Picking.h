// Which node of a hit path a press picks — the port of
// src/renderer/src/figma/picking.ts:54-68 (docs/engine.md §8.2).
#pragma once

#include <vector>

#include "scene/Document.h"

namespace eng {

// `deep` (⌘): the innermost. Otherwise the innermost one whose parent is "open"
// (a selected node or an ancestor of one); by default a top-level frame's
// direct child; otherwise the top-level node. A hit inside a group picks the
// outermost unopened group (it is on the path above what was hit).
Guid pick(const Document& doc, const std::vector<Guid>& path, const std::vector<Guid>& selection, bool deep);

}  // namespace eng
