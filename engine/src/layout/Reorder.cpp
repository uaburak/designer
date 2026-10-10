#include "layout/Reorder.h"

#include <algorithm>

namespace eng::reorder {

namespace {

double lo(const Rect& r, int axis) { return axis == 0 ? r.x : r.y; }
double hi(const Rect& r, int axis) { return axis == 0 ? r.right() : r.bottom(); }
double mid(const Rect& r, int axis) { return (lo(r, axis) + hi(r, axis)) / 2; }

// The edge rule between the neighbours [first, last) the slot at `index` has on its line (a row of a wrapping flow,
// or the whole flow).
size_t edgeStep(const std::vector<Rect>& others, size_t first, size_t last, size_t index, const Rect& dragged, int axis,
                int dir) {
  bool forward = index < last && index >= first && hi(dragged, axis) > mid(others[index], axis);
  bool back = index > first && index <= last && lo(dragged, axis) < mid(others[index - 1], axis);
  if (forward && back) {
    if (dir > 0) return index + 1;
    if (dir < 0) return index - 1;
    return index;
  }
  if (forward) return index + 1;
  if (back) return index - 1;
  return index;
}

}  // namespace

size_t step(const Flow& flow, size_t index, const Rect& dragged, int dir) {
  const std::vector<Rect>& others = flow.others;
  const size_t n = others.size();
  index = std::min(index, n);
  if (!flow.wrap || flow.axis != 0) return edgeStep(others, 0, n, index, dragged, flow.axis, dir);

  // Rows: a box that starts at or left of the one before it began a new row.
  struct Band {
    size_t first, last;  // the others on it [first, last)
    double top, bottom;
  };
  std::vector<Band> bands;
  for (size_t i = 0; i < n; i++) {
    if (bands.empty() || others[i].x <= others[i - 1].x) bands.push_back({i, i, others[i].y, others[i].bottom()});
    Band& b = bands.back();
    b.last = i + 1;
    b.top = std::min(b.top, others[i].y);
    b.bottom = std::max(b.bottom, others[i].bottom());
  }
  // The slot's row: the band its centre is in, else a row of its own (alone on it, before or after the others').
  double slotY = flow.slot.y + flow.slot.h / 2;
  size_t slotBand = bands.size();
  for (size_t k = 0; k < bands.size(); k++)
    if (slotY >= bands[k].top && slotY <= bands[k].bottom) slotBand = k;
  if (slotBand == bands.size()) {
    size_t at = 0;
    while (at < bands.size() && bands[at].bottom < slotY) at++;
    bands.insert(bands.begin() + static_cast<long>(at), Band{index, index, flow.slot.y, flow.slot.bottom()});
    slotBand = at;
  }
  // The dragged layer's row: the band its centre is in, the boundaries half-way between rows.
  double y = dragged.y + dragged.h / 2;
  size_t row = 0;
  while (row + 1 < bands.size() && y > (bands[row].bottom + bands[row + 1].top) / 2) row++;
  if (row == slotBand) {
    const Band& b = bands[row];
    return edgeStep(others, b.first, b.last, index, dragged, 0, dir);
  }
  // Another row: before the first of its layers whose centre is past the dragged layer's.
  const Band& b = bands[row];
  double x = dragged.x + dragged.w / 2;
  size_t j = b.first;
  while (j < b.last && mid(others[j], 0) <= x) j++;
  return j;
}

}  // namespace eng::reorder
