// Layout (docs/engine.md §4): auto layout (horizontal / vertical, wrap, gaps
// incl. auto, padding, alignment, Hug / Fill / Fixed, min / max, absolute
// children), constraints for children of resized frames, and groups fitting
// their children. Results are written back as real `size` / `transform`
// (system writes in the current transaction, through the host).
#pragma once

#include <string>
#include <unordered_map>
#include <vector>

#include "scene/Document.h"

namespace eng {

class LayoutHost {
 public:
  virtual ~LayoutHost() = default;
  virtual const Document& document() const = 0;
  // Writes the node's transform and size (only what differs).
  virtual void writeGeometry(Guid id, const Mat2x3& transform, Vec2 size) = 0;
  // Whether the frame's size was written in this transaction, and what it was
  // when the transaction began (constraints act only then, docs/engine.md §4.4).
  virtual bool resizedInTxn(Guid frame, Vec2& oldSize) const = 0;
  // A node's transform and size when the transaction began (what constraints
  // start from, so a gesture never drifts).
  virtual void base(Guid id, Mat2x3& transform, Vec2& size) const = 0;
  // Taken out of the flow for now: being dragged into an auto-layout frame (it
  // takes no space there until it is dropped).
  virtual bool excludedFromFlow(Guid id) const = 0;
  // Placed by a gesture for now: it keeps its slot in the flow (its frame keeps
  // its shape while it is dragged inside it) but layout doesn't move it.
  virtual bool placedByGesture(Guid id) const = 0;
  // Resizing with ⌘ held: children keep their place (Figma's "ignore constraints").
  virtual bool ignoreConstraints(Guid frame) const = 0;
  // A TEXT node's laid-out size wrapping at `width` (< 0: no wrapping). False when it
  // can't be measured now (its font is loading or missing): its stored size stands.
  virtual bool measureText(Guid id, double width, Vec2& size) { return false; }
  // A TEXT node's first baseline (from its top) at `size`; < 0 when it has none.
  virtual double firstBaseline(Guid id, Vec2 size) { return -1; }
  // A diverged slot inside an instance (a derived slot frame): the content frame it shows, else kNoGuid. A slot
  // that hugs, hugs its content (Figma).
  virtual Guid slotContentOf(Guid id) { return kNoGuid; }
};

class Layout {
 public:
  explicit Layout(LayoutHost& host) : host_(host), doc_(host.document()) {}

  // Lays out everything that depends on the nodes in `dirty` (whose layout
  // inputs changed): their layout roots are found by walking up through
  // auto-layout parents and groups.
  // everyRoot: each dirty node's root is arranged even when it lies inside another root (outer roots first):
  // what laying out each dirty node on its own would give, once per root (instance batches).
  void run(const std::vector<Guid>& dirty, bool everyRoot = false);

  // The size `id` takes on its own (Hug computed, Fixed as is, clamped by
  // min/max); `width` / `height` > 0 fix that axis first (a Fill width decides
  // a wrapping frame's height). `hug` (kHugWidth | kHugHeight): that axis hugs
  // its content whatever its own sizing says (a Fill child measured by a parent
  // that hugs that axis, fillHugAxes).
  static constexpr int kHugWidth = 1, kHugHeight = 2;
  Vec2 natural(Guid id, double width = -1, double height = -1, int hug = 0);
  // Figma: a child that fills the counter axis (STRETCH) of a horizontal /
  // vertical parent hugging that axis counts for its content there (a table row
  // hugging cells that fill its height is as tall as its tallest cell's
  // content). A Fill on the primary axis of a parent hugging it counts for its
  // own size. kHugWidth / kHugHeight, 0 when none.
  static int fillHugAxes(const NodeProps& parent, const NodeProps& child);

  // Where an auto-layout frame's children go, without writing anything:
  // their sizes and the positions of their layout boxes, in the frame's space.
  struct Placement {
    Guid id;
    Vec2 size;
    Vec2 position;  // the top-left of the child's layout box (its bounds in the frame's space)
  };
  std::vector<Placement> place(Guid frame, Vec2 frameSize);

  // Lays out one node on its own (its hug size, its children; a text its measured size), as if it were a layout
  // root. Instance materialization uses it bottom-up on derived subtrees (docs/engine.md §3.3 step 2).
  void settle(Guid id);
  // A frame's children follow its size by their constraints (from where LayoutHost::base says they were).
  void constrainChildren(Guid frame);

  // The flow children of an auto-layout frame, in order.
  std::vector<Guid> flowChildren(Guid frame) const;

  // Padding (left, top, right, bottom) of an auto-layout frame, strokes included when they take space.
  static void padding(const NodeProps& p, double out[4]);

  // A grid frame's cells as laid out now (frame space): track offsets and sizes, track GUIDs (kNoGuid for rows past
  // the defined ones), automatic placement, and where each flow item sits. Gestures and overlays use it.
  struct GridCells {
    std::vector<double> colX, colW, rowY, rowH;
    std::vector<Guid> colIds, rowIds;
    std::vector<std::string> colLabels, rowLabels;  // Figma's: "1fr", "120", "Hug"
    bool reflow = false;
    struct Item {
      Guid id;
      size_t col = 0, row = 0, colSpan = 1, rowSpan = 1;
    };
    std::vector<Item> items;
    // The cell (col, row) a point falls in, the nearest one when it is outside or in a gap; false without tracks.
    bool cellAt(Vec2 p, size_t& col, size_t& row) const;
  };
  GridCells gridCells(Guid frame);
  // A grid item's placement fields as kiwi bytes for NodeProps::extra: gridColumnAnchor / gridRowAnchor (a track's
  // GUID), gridColumnSpan / gridRowSpan.
  static std::string gridAnchorBytes(bool column, Guid track);
  static std::string gridSpanBytes(bool column, uint32_t span);
  // A grid's track definitions along an axis, in order (sizing: 0 FLEX fr, 1 FIXED px, 2 HUG), read from and written
  // to the frame's kiwi bytes (gridColumns / gridRows with gridColumnsSizing / gridRowsSizing, both written whole).
  struct GridTrackDef {
    Guid id = kNoGuid;
    std::string position;
    uint8_t sizing = 2;
    double value = 1;
  };
  static std::vector<GridTrackDef> gridTrackDefs(const NodeProps& p, bool column);
  static void setGridTrackDefs(NodeProps& p, bool column, const std::vector<GridTrackDef>& tracks);
  // gridAutoTracks ROWS ("Number of rows: Auto"): the rows are as many as the items need (empty ones go).
  static bool gridAutoRows(const NodeProps& p);
  static std::string gridAutoRowsBytes(bool on);

 private:
  // Grid auto layout (GridLayout.cpp): tracks sized and items placed for a size (hugW / hugH: that axis hugs).
  struct Grid;
  Grid grid(Guid frame, Vec2 size, bool hugW, bool hugH);
  Vec2 gridContentSize(Guid frame, Vec2 frameSize, bool hugW, bool hugH);
  // An auto-layout frame's content size; `hug` as natural's (the axes it hugs, its own sizing or forced).
  Vec2 contentSize(Guid frame, Vec2 frameSize, int hug);
  std::vector<Placement> gridPlace(Guid frame, Vec2 size);

  void arrange(Guid id, Vec2 size, bool sizeFromParent);
  void arrangeAutoLayout(Guid id, Vec2 size);
  void applyConstraints(Guid frame, bool flowChildrenToo);
  void fitGroup(Guid id);
  // Where a child's first baseline is, from the top of its layout box (BASELINE alignment): a text's
  // first line, an auto-layout frame's first child's, else the box's bottom.
  double baselineOf(Guid id, Vec2 size, int depth = 0);

  LayoutHost& host_;
  const Document& doc_;
  struct MemoKey {
    Guid id;
    double w, h;
    int hug;
    bool operator==(const MemoKey& o) const { return id == o.id && w == o.w && h == o.h && hug == o.hug; }
  };
  struct MemoHash {
    size_t operator()(const MemoKey& k) const noexcept {
      return GuidHash()(k.id) ^ (std::hash<double>()(k.w) * 31) ^ (std::hash<double>()(k.h) * 131) ^ (static_cast<size_t>(k.hug) * 7919);
    }
  };
  std::unordered_map<MemoKey, Vec2, MemoHash> memo_;
};

// A child's layout box: the bounds of its box in its parent's space, for a given size.
Rect layoutBox(const Mat2x3& transform, Vec2 size);

}  // namespace eng
