// Selection geometry and helpers (docs/engine.md §8.3).
#pragma once

#include <vector>

#include "scene/Document.h"

namespace eng {

// The selection's box: one node's own (rotated) box; several nodes' combined
// rotated box when they all share a rotation, otherwise their world AABB.
// `toWorld` maps box space [0,size] to world.
struct SelectionBox {
  bool valid = false;
  Mat2x3 toWorld;
  Vec2 size;
};
SelectionBox selectionBox(const Document& doc, const std::vector<Guid>& selection);

// The selection without nodes whose ancestor is selected too.
std::vector<Guid> topLevelSelection(const Document& doc, const std::vector<Guid>& selection);

}  // namespace eng
