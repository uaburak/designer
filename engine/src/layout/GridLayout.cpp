// Grid auto layout (docs/engine.md §4.3): `stackMode GRID`. Figma's fields are kept as the node's unmodelled kiwi
// bytes (NodeProps::extra) and read here: the frame's `gridColumns` / `gridRows` (tracks: a GUID and a fractional
// position each), `gridColumnsSizing` / `gridRowsSizing` (FIXED px, FLEX fr, HUG), `gridColumnGap` / `gridRowGap`,
// `gridReflowEnabled` (auto placement); a child's `gridColumnAnchor` / `gridRowAnchor` (track GUIDs),
// `gridColumnSpan` / `gridRowSpan` and `gridChildHorizontalAlign` / `gridChildVerticalAlign`.
//
// As Figma lays its own files out (checked on a large private file: 96.6 % of grid items within 0.6 px, the rest stale
// stored geometry): items in layer order; with reflow they flow row by row into the first free cells (spans
// included), else they sit at their anchors (an item without valid anchors flows on from the last); rows past the
// defined ones are HUG. Columns: FIXED, then HUG (the widest single-span item; a spanning item widens the HUG tracks
// it spans, evenly), then FLEX shares the rest by weight (in a frame that hugs its width, FLEX tracks hug). Rows the
// same on the other axis, once the items' widths are known (a text filling its cell wraps there). A Fill-width item
// (stackChildPrimaryGrow) takes its cell's width, a Fill-height one (stackChildAlignSelf STRETCH) its height; the
// others keep their own size, aligned in the cell by gridChildHorizontalAlign / gridChildVerticalAlign (AUTO = MIN).
#include <algorithm>
#include <cmath>
#include <set>
#include <string>
#include <string_view>
#include <utility>

#include "kiwi.h"
#include "layout/Layout.h"

namespace eng {

namespace {

// Figma's kiwi field ids (schema/document.kiwi).
constexpr uint32_t kGridRows = 435, kGridColumns = 436, kGridRowGap = 437, kGridColumnGap = 438, kGridRowAnchor = 439,
                   kGridColumnAnchor = 440, kGridRowSpan = 441, kGridColumnSpan = 442, kGridColumnsSizing = 474,
                   kGridRowsSizing = 475, kGridChildVerticalAlign = 476, kGridChildHorizontalAlign = 477,
                   kGridReflowEnabled = 556;

enum class Sizing : uint8_t { FLEX = 0, FIXED = 1, HUG = 2 };

struct Track {
  Guid id;
  std::string position;
  Sizing sizing = Sizing::HUG;
  double value = 1;
};

struct Spec {
  std::vector<Track> cols, rows;
  double colGap = 0, rowGap = 0;
  bool reflow = false;
};

struct ItemSpec {
  Guid colAnchor = kNoGuid, rowAnchor = kNoGuid;
  uint32_t colSpan = 1, rowSpan = 1;
  uint32_t hAlign = 0, vAlign = 0;  // GridChildAlign: AUTO 0, MIN 1, CENTER 2, MAX 3
};

// One field of NodeProps::extra (its value as kiwi bytes, after the field id), or empty.
std::string_view field(const NodeProps& p, const char* name, uint32_t id) {
  auto it = p.extra.find(name);
  if (it == p.extra.end() || it->second.empty()) return {};
  kiwi::ByteBuffer bb(reinterpret_cast<const uint8_t*>(it->second.data()), it->second.size());
  uint32_t f = 0;
  if (!bb.readVarUint(f) || f != id) return {};
  return std::string_view(it->second).substr(bb.index());
}

#define GRID_FIELD(bb, p, name, id, fail)                                              \
  std::string_view bytes_##bb = field(p, name, id);                                    \
  if (bytes_##bb.empty()) fail;                                                        \
  kiwi::ByteBuffer bb(reinterpret_cast<const uint8_t*>(bytes_##bb.data()), bytes_##bb.size())

bool readGuid(kiwi::ByteBuffer& bb, Guid& g) { return bb.readVarUint(g.sessionID) && bb.readVarUint(g.localID); }

// min / max (0 = no limit on that axis), never below 0 (as Layout.cpp's).
double clampAxis(double v, const NodeProps& p, int a) {
  double mx = a == 0 ? p.maxSize.x : p.maxSize.y, mn = a == 0 ? p.minSize.x : p.minSize.y;
  if (mx > 0 && v > mx) v = mx;
  if (mn > 0 && v < mn) v = mn;
  return std::max(0.0, v);
}

bool readFloatField(const NodeProps& p, const char* name, uint32_t id, double& out) {
  GRID_FIELD(bb, p, name, id, return false);
  float v = 0;
  if (!bb.readVarFloat(v) || !std::isfinite(v)) return false;
  out = v;
  return true;
}

bool readUintField(const NodeProps& p, const char* name, uint32_t id, uint32_t& out) {
  GRID_FIELD(bb, p, name, id, return false);
  return bb.readVarUint(out);
}

bool readGuidField(const NodeProps& p, const char* name, uint32_t id, Guid& out) {
  GRID_FIELD(bb, p, name, id, return false);
  return readGuid(bb, out);
}

// GUIDPositionMap {entries: [{1 id: GUID, 2 position: string}]}.
void readTracks(const NodeProps& p, const char* name, uint32_t id, std::vector<Track>& out) {
  GRID_FIELD(bb, p, name, id, return);
  for (;;) {
    uint32_t f = 0;
    if (!bb.readVarUint(f) || f == 0) break;
    if (f != 1) return;
    uint32_t n = 0;
    if (!bb.readVarUint(n)) return;
    for (uint32_t i = 0; i < n; i++) {
      Track t;
      for (;;) {
        uint32_t ef = 0;
        if (!bb.readVarUint(ef)) return;
        if (ef == 0) break;
        if (ef == 1) {
          if (!readGuid(bb, t.id)) return;
        } else if (ef == 2) {
          const char* s = nullptr;
          if (!bb.readString(s)) return;
          t.position = s;
        } else {
          return;
        }
      }
      out.push_back(std::move(t));
    }
  }
  std::stable_sort(out.begin(), out.end(), [](const Track& a, const Track& b) { return a.position < b.position; });
}

// GridTrackSizingFunction {1 type: GridTrackSizingType, 2 value: float}.
bool readSizingFunction(kiwi::ByteBuffer& bb, Sizing& type, double& value) {
  for (;;) {
    uint32_t f = 0;
    if (!bb.readVarUint(f)) return false;
    if (f == 0) return true;
    if (f == 1) {
      uint32_t t = 0;
      if (!bb.readVarUint(t)) return false;
      type = t <= 2 ? static_cast<Sizing>(t) : Sizing::HUG;
    } else if (f == 2) {
      float v = 0;
      if (!bb.readVarFloat(v)) return false;
      value = std::isfinite(v) ? v : 0;
    } else {
      return false;
    }
  }
}

// GUIDGridTrackSizeMap {entries: [{1 id: GUID, 2 trackSize: GridTrackSize {1 minSizing, 2 maxSizing}}]}: the max
// sizing decides (Figma writes the same function in both).
void readSizing(const NodeProps& p, const char* name, uint32_t id, std::vector<Track>& tracks) {
  GRID_FIELD(bb, p, name, id, return);
  for (;;) {
    uint32_t f = 0;
    if (!bb.readVarUint(f) || f == 0) break;
    if (f != 1) return;
    uint32_t n = 0;
    if (!bb.readVarUint(n)) return;
    for (uint32_t i = 0; i < n; i++) {
      Guid g = kNoGuid;
      Sizing type = Sizing::HUG;
      double value = 1;
      bool have = false;
      for (;;) {
        uint32_t ef = 0;
        if (!bb.readVarUint(ef)) return;
        if (ef == 0) break;
        if (ef == 1) {
          if (!readGuid(bb, g)) return;
        } else if (ef == 2) {
          for (;;) {
            uint32_t sf = 0;
            if (!bb.readVarUint(sf)) return;
            if (sf == 0) break;
            if (sf != 1 && sf != 2) return;
            Sizing t = Sizing::HUG;
            double v = 1;
            if (!readSizingFunction(bb, t, v)) return;
            if (sf == 2 || !have) type = t, value = v, have = true;
          }
        } else {
          return;
        }
      }
      for (Track& t : tracks)
        if (t.id == g && have) t.sizing = type, t.value = value;
    }
  }
}

Spec readSpec(const NodeProps& p) {
  Spec s;
  readTracks(p, "gridColumns", kGridColumns, s.cols);
  readTracks(p, "gridRows", kGridRows, s.rows);
  readSizing(p, "gridColumnsSizing", kGridColumnsSizing, s.cols);
  readSizing(p, "gridRowsSizing", kGridRowsSizing, s.rows);
  readFloatField(p, "gridColumnGap", kGridColumnGap, s.colGap);
  readFloatField(p, "gridRowGap", kGridRowGap, s.rowGap);
  if (std::string_view r = field(p, "gridReflowEnabled", kGridReflowEnabled); !r.empty()) s.reflow = r[0] != 0;
  if (s.cols.empty()) s.cols.push_back(Track{});
  return s;
}

ItemSpec readItem(const NodeProps& p) {
  ItemSpec it;
  readGuidField(p, "gridColumnAnchor", kGridColumnAnchor, it.colAnchor);
  readGuidField(p, "gridRowAnchor", kGridRowAnchor, it.rowAnchor);
  readUintField(p, "gridColumnSpan", kGridColumnSpan, it.colSpan);
  readUintField(p, "gridRowSpan", kGridRowSpan, it.rowSpan);
  readUintField(p, "gridChildHorizontalAlign", kGridChildHorizontalAlign, it.hAlign);
  readUintField(p, "gridChildVerticalAlign", kGridChildVerticalAlign, it.vAlign);
  it.colSpan = std::max<uint32_t>(1, it.colSpan);
  it.rowSpan = std::max<uint32_t>(1, std::min<uint32_t>(it.rowSpan, 1000));
  return it;
}

double alignOf(uint32_t a) { return a == 2 ? 0.5 : a == 3 ? 1 : 0; }

}  // namespace

// Tracks sized, items placed: the grid of a frame for a given size (hugW / hugH: that axis hugs its content).
struct Layout::Grid {
  Spec spec;
  struct Item {
    Guid id;
    size_t col = 0, row = 0, cs = 1, rs = 1;
    bool fillW = false, fillH = false;
    double hAlign = 0, vAlign = 0;
    Vec2 size;
  };
  std::vector<Item> items;
  std::vector<double> colW, rowH;
  double padL = 0, padT = 0, padR = 0, padB = 0;
  double span(const std::vector<double>& sizes, size_t from, size_t n, double gap) const {
    double s = 0;
    for (size_t i = from; i < from + n && i < sizes.size(); i++) s += sizes[i];
    return s + gap * static_cast<double>(n > 0 ? n - 1 : 0);
  }
  double offset(const std::vector<double>& sizes, size_t i, double gap) const {
    double s = 0;
    for (size_t k = 0; k < i && k < sizes.size(); k++) s += sizes[k] + gap;
    return s;
  }
};

Layout::Grid Layout::grid(Guid frame, Vec2 size, bool hugW, bool hugH) {
  const NodeProps& p = doc_.get(frame)->props;
  Grid g;
  g.spec = readSpec(p);
  double pad[4];
  padding(p, pad);
  g.padL = pad[0], g.padT = pad[1], g.padR = pad[2], g.padB = pad[3];
  const Spec& s = g.spec;
  const size_t C = s.cols.size();

  // Placement, in layer order.
  std::set<std::pair<size_t, size_t>> taken;  // (row, col)
  auto freeAt = [&](size_t r, size_t c, size_t rs, size_t cs) {
    for (size_t y = 0; y < rs; y++)
      for (size_t x = 0; x < cs; x++)
        if (taken.count({r + y, c + x})) return false;
    return true;
  };
  size_t cursor = 0;
  for (Guid c : flowChildren(frame)) {
    const NodeProps& cp = doc_.get(c)->props;
    ItemSpec is = readItem(cp);
    Grid::Item it;
    it.id = c;
    it.cs = std::min<size_t>(is.colSpan, C);
    it.rs = is.rowSpan;
    it.fillW = cp.stackChildPrimaryGrow > 0 && !cp.fitsChildren();
    it.fillH = cp.stackChildAlignSelf == StackCounterAlign::STRETCH && !cp.fitsChildren();
    it.hAlign = alignOf(is.hAlign);
    it.vAlign = alignOf(is.vAlign);
    bool placed = false;
    if (!s.reflow && is.colAnchor != kNoGuid && is.rowAnchor != kNoGuid) {
      size_t ci = C, ri = s.rows.size();
      for (size_t i = 0; i < C; i++)
        if (s.cols[i].id == is.colAnchor) ci = i;
      for (size_t i = 0; i < s.rows.size(); i++)
        if (s.rows[i].id == is.rowAnchor) ri = i;
      if (ci < C && ri < s.rows.size()) {
        it.col = std::min(ci, C - it.cs);
        it.row = ri;
        placed = true;
      }
    }
    if (!placed) {
      for (size_t i = cursor;; i++) {
        size_t r = i / C, col = i % C;
        if (col + it.cs > C || !freeAt(r, col, it.rs, it.cs)) continue;
        it.col = col;
        it.row = r;
        cursor = i + it.cs;
        break;
      }
    }
    for (size_t y = 0; y < it.rs; y++)
      for (size_t x = 0; x < it.cs; x++) taken.insert({it.row + y, it.col + x});
    g.items.push_back(it);
  }
  size_t R = s.rows.size();
  for (const Grid::Item& it : g.items) R = std::max(R, it.row + it.rs);
  R = std::max<size_t>(R, 1);
  auto rowTrack = [&](size_t i) -> Track { return i < s.rows.size() ? s.rows[i] : Track{}; };

  // Columns: fixed, hug (single-span items, then spanning items), flex.
  for (Grid::Item& it : g.items) it.size = natural(it.id);
  g.colW.assign(C, 0);
  for (size_t i = 0; i < C; i++)
    if (s.cols[i].sizing == Sizing::FIXED) g.colW[i] = std::max(0.0, s.cols[i].value);
  auto hugsCol = [&](size_t i) { return s.cols[i].sizing == Sizing::HUG || (s.cols[i].sizing == Sizing::FLEX && hugW); };
  for (const Grid::Item& it : g.items)
    if (it.cs == 1 && hugsCol(it.col)) g.colW[it.col] = std::max(g.colW[it.col], it.size.x);
  for (const Grid::Item& it : g.items) {
    if (it.cs < 2) continue;
    double have = g.span(g.colW, it.col, it.cs, s.colGap);
    std::vector<size_t> hugs;
    for (size_t i = it.col; i < it.col + it.cs; i++)
      if (hugsCol(i)) hugs.push_back(i);
    if (!hugs.empty() && it.size.x > have)
      for (size_t i : hugs) g.colW[i] += (it.size.x - have) / static_cast<double>(hugs.size());
  }
  if (!hugW) {
    double used = s.colGap * static_cast<double>(C - 1), fr = 0;
    for (size_t i = 0; i < C; i++) {
      if (s.cols[i].sizing == Sizing::FLEX) fr += std::max(0.0, s.cols[i].value);
      else used += g.colW[i];
    }
    double free = std::max(0.0, size.x - g.padL - g.padR - used);
    for (size_t i = 0; i < C; i++)
      if (s.cols[i].sizing == Sizing::FLEX) g.colW[i] = fr > 0 ? free * std::max(0.0, s.cols[i].value) / fr : 0;
  }

  // The items' widths are known: a Fill-width text wraps in its cell.
  for (Grid::Item& it : g.items) {
    double cellW = g.span(g.colW, it.col, it.cs, s.colGap);
    const NodeProps& cp = doc_.get(it.id)->props;
    if (it.fillW) {
      it.size = (cp.type == NodeType::TEXT || cp.isAutoLayout()) ? natural(it.id, std::max(0.0, cellW), -1) : Vec2{cellW, it.size.y};
      it.size.x = clampAxis(cellW, cp, 0);
    }
  }

  // Rows.
  g.rowH.assign(R, 0);
  auto hugsRow = [&](size_t i) { Track t = rowTrack(i); return t.sizing == Sizing::HUG || (t.sizing == Sizing::FLEX && hugH); };
  for (size_t i = 0; i < R; i++)
    if (rowTrack(i).sizing == Sizing::FIXED) g.rowH[i] = std::max(0.0, rowTrack(i).value);
  for (const Grid::Item& it : g.items)
    if (it.rs == 1 && hugsRow(it.row)) g.rowH[it.row] = std::max(g.rowH[it.row], it.size.y);
  for (const Grid::Item& it : g.items) {
    if (it.rs < 2) continue;
    double have = g.span(g.rowH, it.row, it.rs, s.rowGap);
    std::vector<size_t> hugs;
    for (size_t i = it.row; i < it.row + it.rs; i++)
      if (hugsRow(i)) hugs.push_back(i);
    if (!hugs.empty() && it.size.y > have)
      for (size_t i : hugs) g.rowH[i] += (it.size.y - have) / static_cast<double>(hugs.size());
  }
  if (!hugH) {
    double used = s.rowGap * static_cast<double>(R - 1), fr = 0;
    for (size_t i = 0; i < R; i++) {
      if (rowTrack(i).sizing == Sizing::FLEX) fr += std::max(0.0, rowTrack(i).value);
      else used += g.rowH[i];
    }
    double free = std::max(0.0, size.y - g.padT - g.padB - used);
    for (size_t i = 0; i < R; i++)
      if (rowTrack(i).sizing == Sizing::FLEX) g.rowH[i] = fr > 0 ? free * std::max(0.0, rowTrack(i).value) / fr : 0;
  }
  for (Grid::Item& it : g.items)
    if (it.fillH) it.size.y = clampAxis(g.span(g.rowH, it.row, it.rs, s.rowGap), doc_.get(it.id)->props, 1);
  return g;
}

Vec2 Layout::gridContentSize(Guid frame, Vec2 frameSize, bool hugW, bool hugH) {
  Grid g = grid(frame, frameSize, hugW, hugH);
  return {g.padL + g.padR + g.span(g.colW, 0, g.colW.size(), g.spec.colGap), g.padT + g.padB + g.span(g.rowH, 0, g.rowH.size(), g.spec.rowGap)};
}

std::vector<Layout::Placement> Layout::gridPlace(Guid frame, Vec2 size) {
  const NodeProps& p = doc_.get(frame)->props;
  Grid g = grid(frame, size, false, false);
  (void)p;
  std::vector<Placement> out;
  out.reserve(g.items.size());
  for (const Grid::Item& it : g.items) {
    double cellW = g.span(g.colW, it.col, it.cs, g.spec.colGap), cellH = g.span(g.rowH, it.row, it.rs, g.spec.rowGap);
    Placement pl;
    pl.id = it.id;
    pl.size = it.size;
    pl.position = {g.padL + g.offset(g.colW, it.col, g.spec.colGap) + (cellW - it.size.x) * it.hAlign,
                   g.padT + g.offset(g.rowH, it.row, g.spec.rowGap) + (cellH - it.size.y) * it.vAlign};
    out.push_back(pl);
  }
  return out;
}

}  // namespace eng
