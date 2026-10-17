// The auto layout a set of layers suggests by where they sit (Atlas 09 §4): what Add auto layout (⇧A) gives a frame or
// the layers it wraps, and what Suggest auto layout (⌃⇧A) builds its nested stacks from. Figma's own heuristics are C++
// it doesn't name (InferredAutoLayoutManager); its help says it "will try to determine" vertical, horizontal or grid,
// and its result shape carries wrap and the counter gap. These rules are ours until a live probe settles them (Atlas 09
// §12 question 2):
//
// - rows are runs of layers that overlap vertically (sorted by top), columns runs that overlap horizontally;
// - one row: horizontal; one column: vertical;
// - several rows whose layers line up in the same columns, every row full: a grid of those columns and rows;
// - several rows starting at the same left edge, none longer than the first: a horizontal flow that wraps;
// - anything else: the axis the layers' centres spread more along (horizontal on a tie);
// - gaps: the mean space between neighbours, rounded, negative when they overlap (Figma takes negative gaps); a wrap's
//   or grid's gap between rows the mean space between rows;
// - the counter alignment: the edge or centre every layer shares across the flow (within half a pixel), else MIN.
//
// Pure, on layout boxes in the parent's space, so the Editor and the tests share it.
#pragma once

#include <cstddef>
#include <vector>

#include "math/Math.h"

namespace eng::infer {

enum class Kind { HORIZONTAL, VERTICAL, WRAP, GRID };

struct Stack {
  Kind kind = Kind::VERTICAL;
  double gap = 0;         // along the flow (a grid: between columns)
  double counterGap = 0;  // between a wrap's rows, a grid's rows
  int counterAlign = 0;   // 0 MIN, 1 CENTER, 2 MAX
  size_t columns = 0, rows = 0;  // a grid's
  std::vector<size_t> order;     // the boxes in flow order (rows: left to right, top to bottom)
};

Stack stack(const std::vector<Rect>& boxes);

// The groups `boxes` split into across one axis (0: side by side in columns, 1: one above another in rows): runs that
// overlap along that axis, in order, each holding indices into `boxes` (sorted along the other axis). One group when
// nothing splits them.
std::vector<std::vector<size_t>> split(const std::vector<Rect>& boxes, int axis);

}  // namespace eng::infer
