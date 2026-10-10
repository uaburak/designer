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

// Whether the canvas draws `id`'s hover and selection in the component purple: a component, a component set or an
// instance, or any layer inside one (live Figma: the owner's screenshots, docs/research/components15/; Layers names
// them purple too).
bool inComponentChrome(const Document& doc, Guid id);

// Whether `id` is a layer inside an instance (not the outermost instance itself): its hover is drawn dotted in the
// component purple (live Figma, docs/research/components15/figma-instance-child-hover.png).
bool insideInstance(const Document& doc, Guid id);

}  // namespace eng
