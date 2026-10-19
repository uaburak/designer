#include "layout/Infer.h"

#include <algorithm>
#include <cmath>
#include <numeric>

namespace eng::infer {

namespace {

constexpr double kTol = 0.5;  // what counts as the same edge, in pixels

double lo(const Rect& r, int a) { return a == 0 ? r.x : r.y; }
double hi(const Rect& r, int a) { return a == 0 ? r.right() : r.bottom(); }
double mid(const Rect& r, int a) { return (lo(r, a) + hi(r, a)) / 2; }

// The mean of the spaces between neighbours (each the next one's start less the last one's end), rounded; 0 for none.
double meanGap(const std::vector<double>& spaces) {
  if (spaces.empty()) return 0;
  double g = std::round(std::accumulate(spaces.begin(), spaces.end(), 0.0) / static_cast<double>(spaces.size()));
  return g == 0 ? 0 : g;  // never -0
}

void spacesAlong(const std::vector<Rect>& boxes, const std::vector<size_t>& seq, int a, std::vector<double>& out) {
  for (size_t i = 1; i < seq.size(); i++) out.push_back(lo(boxes[seq[i]], a) - hi(boxes[seq[i - 1]], a));
}

// The counter alignment every line's layers share (their start, centre or end across the flow, `a` the counter axis):
// 0 MIN, 1 CENTER, 2 MAX; MIN when they share none or all three (a line of one).
int counterAlign(const std::vector<Rect>& boxes, const std::vector<std::vector<size_t>>& lines, int a) {
  bool mins = true, mids = true, maxs = true;
  for (const auto& line : lines) {
    if (line.empty()) continue;
    const Rect& f = boxes[line[0]];
    for (size_t i : line) {
      const Rect& b = boxes[i];
      mins &= std::fabs(lo(b, a) - lo(f, a)) < kTol;
      mids &= std::fabs(mid(b, a) - mid(f, a)) < kTol;
      maxs &= std::fabs(hi(b, a) - hi(f, a)) < kTol;
    }
  }
  if (!mins && mids) return 1;
  if (!mins && maxs) return 2;
  return 0;
}

// One line along `P`: the layers in order of their start along it.
void linear(const std::vector<Rect>& boxes, int P, Stack& s) {
  s.kind = P == 0 ? Kind::HORIZONTAL : Kind::VERTICAL;
  s.order.resize(boxes.size());
  std::iota(s.order.begin(), s.order.end(), size_t{0});
  std::stable_sort(s.order.begin(), s.order.end(), [&](size_t x, size_t y) { return lo(boxes[x], P) < lo(boxes[y], P); });
  std::vector<double> spaces;
  spacesAlong(boxes, s.order, P, spaces);
  // A lone layer: Figma's default gap.
  s.gap = boxes.size() > 1 ? meanGap(spaces) : 10;
  s.counterAlign = counterAlign(boxes, {s.order}, 1 - P);
}

}  // namespace

std::vector<std::vector<size_t>> split(const std::vector<Rect>& boxes, int axis) {
  const int other = 1 - axis;
  std::vector<size_t> idx(boxes.size());
  std::iota(idx.begin(), idx.end(), size_t{0});
  std::stable_sort(idx.begin(), idx.end(), [&](size_t x, size_t y) {
    return lo(boxes[x], axis) != lo(boxes[y], axis) ? lo(boxes[x], axis) < lo(boxes[y], axis) : lo(boxes[x], other) < lo(boxes[y], other);
  });
  std::vector<std::vector<size_t>> groups;
  double end = 0;
  for (size_t i : idx) {
    // A layer that starts where the run so far ends (or past it) starts a new run; touching is not overlapping.
    if (groups.empty() || lo(boxes[i], axis) > end - 1e-6) {
      groups.push_back({});
      end = hi(boxes[i], axis);
    }
    groups.back().push_back(i);
    end = std::max(end, hi(boxes[i], axis));
  }
  for (auto& g : groups) std::stable_sort(g.begin(), g.end(), [&](size_t x, size_t y) { return lo(boxes[x], other) < lo(boxes[y], other); });
  return groups;
}

Stack stack(const std::vector<Rect>& boxes) {
  Stack s;
  if (boxes.empty()) {
    s.gap = 10;
    return s;
  }
  const auto rows = split(boxes, 1), cols = split(boxes, 0);
  const bool rowsApart = rows.size() > 1, colsApart = cols.size() > 1;
  if (boxes.size() > 1 && !rowsApart && colsApart) {
    linear(boxes, 0, s);
    return s;
  }
  if (boxes.size() > 1 && rowsApart && !colsApart) {
    linear(boxes, 1, s);
    return s;
  }
  if (rowsApart && colsApart) {
    std::vector<size_t> colOf(boxes.size(), 0);
    for (size_t c = 0; c < cols.size(); c++)
      for (size_t i : cols[c]) colOf[i] = c;
    auto rowMajor = [&] {
      s.order.clear();
      for (const auto& r : rows) s.order.insert(s.order.end(), r.begin(), r.end());
    };
    auto rowSpaces = [&] {
      std::vector<double> between;
      for (size_t r = 1; r < rows.size(); r++) {
        double top = 1e300, bottom = -1e300;
        for (size_t i : rows[r]) top = std::min(top, lo(boxes[i], 1));
        for (size_t i : rows[r - 1]) bottom = std::max(bottom, hi(boxes[i], 1));
        between.push_back(top - bottom);
      }
      return meanGap(between);
    };
    // A grid: every row as long as there are columns, its n-th layer in the n-th column.
    bool grid = true;
    for (const auto& r : rows) {
      grid &= r.size() == cols.size();
      for (size_t j = 0; grid && j < r.size(); j++) grid &= colOf[r[j]] == j;
    }
    if (grid) {
      s.kind = Kind::GRID;
      s.columns = cols.size();
      s.rows = rows.size();
      std::vector<double> between;
      for (size_t c = 1; c < cols.size(); c++) {
        double left = 1e300, right = -1e300;
        for (size_t i : cols[c]) left = std::min(left, lo(boxes[i], 0));
        for (size_t i : cols[c - 1]) right = std::max(right, hi(boxes[i], 0));
        between.push_back(left - right);
      }
      s.gap = meanGap(between);
      s.counterGap = rowSpaces();
      rowMajor();
      return s;
    }
    // A wrap: rows from the same left edge, the first the longest, its layers apart side by side.
    bool wrap = rows[0].size() > 1;
    std::vector<double> spaces;
    for (const auto& r : rows) {
      wrap &= r.size() <= rows[0].size() && std::fabs(lo(boxes[r[0]], 0) - lo(boxes[rows[0][0]], 0)) < kTol;
      for (size_t j = 1; wrap && j < r.size(); j++) wrap &= lo(boxes[r[j]], 0) > hi(boxes[r[j - 1]], 0) - kTol;
      spacesAlong(boxes, r, 0, spaces);
    }
    if (wrap) {
      s.kind = Kind::WRAP;
      s.gap = meanGap(spaces);
      s.counterGap = rowSpaces();
      s.counterAlign = counterAlign(boxes, rows, 1);
      rowMajor();
      return s;
    }
  }
  // The axis their centres spread more along.
  double minCx = 1e300, maxCx = -1e300, minCy = 1e300, maxCy = -1e300;
  for (const Rect& b : boxes) {
    minCx = std::min(minCx, mid(b, 0)), maxCx = std::max(maxCx, mid(b, 0));
    minCy = std::min(minCy, mid(b, 1)), maxCy = std::max(maxCy, mid(b, 1));
  }
  linear(boxes, boxes.size() == 1 || maxCx - minCx >= maxCy - minCy ? 0 : 1, s);
  return s;
}

}  // namespace eng::infer
