// Which node of a hit path a press picks — the port of
// src/renderer/src/figma/picking.ts:54-68 (docs/engine.md §8.2).
#pragma once

#include <vector>

#include "scene/Document.h"

namespace eng {

// `deep` (⌘): the innermost. Otherwise the innermost one whose parent is "open"
// (an ancestor of a selected node — with `enter`, a double-click, the selected
// node itself too); by default a top-level frame's direct child; otherwise the
// top-level node. A hit inside a group picks the outermost unopened group (it
// is on the path above what was hit). Live Figma: docs/research/figma/live/
// behaviour/selection.md.
// `sameDepth` (⇧, adding to the selection): a hit in another branch picks at the selected layers' depth — ⇧-click a
// variant's "label" frame with another variant's selected and that one is added (live Figma, 2026-10-23) — not past an
// unopened instance.
Guid pick(const Document& doc, const std::vector<Guid>& path, const std::vector<Guid>& selection, bool deep, bool enter = false,
          bool sameDepth = false);

// Where the "top level" of a hit path is: past the sections it starts with (a section's children are top-level
// layers, Figma), but never past its last node.
size_t topLevelIndex(const Document& doc, const std::vector<Guid>& path);

}  // namespace eng
