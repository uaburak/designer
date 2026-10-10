// Figma's reorder while a layer is dragged inside its own auto-layout flow (docs/engine.md §8.6, round 15; measured on
// the owner's recording of live Figma, docs/research/figma/live/behaviour/autolayout-drag.md finding 4): the layer
// takes a neighbour's place when its leading edge — the side it moves towards — passes that neighbour's centre (not
// the pointer, not its own centre). Pure, on layout boxes in the frame's own space (a rotated frame reorders along
// its own axes), so the Editor and the tests share it.
#pragma once

#include <cstddef>
#include <vector>

#include "math/Math.h"

namespace eng::reorder {

struct Flow {
  // The other flow children's layout boxes in flow order, where layout puts them with the dragged layer's slot at the
  // index being tested (hidden and absolute children are not in the flow: the caller leaves them out).
  std::vector<Rect> others;
  int axis = 0;       // the flow's axis: 0 horizontal, 1 vertical
  bool wrap = false;  // rows (Figma wraps horizontal flows only)
  Rect slot;          // wrap: where layout puts the dragged layer's slot (which row it is on)
  // Several layers dragged together (round 15, round 2): the others still between them (a selection that isn't one
  // run yet: 0 once it is). They are inside the block — its next neighbour is others[index + span].
  size_t span = 0;
};

// The dragged layer's slot (0 … others.size(), the number of others before it) one step on from `index`, or `index`
// when it stays. `dragged`: its box now (following the pointer); several layers: their boxes' union, `index` the
// number of others before the first of them (a step on puts them together, in their order, at the new index). `dir`: its last motion along the flow (−1, 0, +1) —
// what decides when it is past both neighbours' centres at once (a layer larger than both). In a wrapping flow its
// centre picks the row; another row's slot is where its centre falls among that row's centres (a jump of several);
// in its own row the edge rule holds against that row's neighbours.
size_t step(const Flow& flow, size_t index, const Rect& dragged, int dir);

}  // namespace eng::reorder
