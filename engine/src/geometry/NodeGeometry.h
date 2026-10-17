// What a node's paints cover, as paths in the node's own space (docs/engine.md
// §5): the fill regions and the stroke's centre line of every shape — vectors
// from their networks, stars, polygons, lines, arcs, smoothed corners, plain
// rectangles and ellipses, text (its glyph outlines), and boolean operations
// computed live from their operands. Cached per node and recomputed only when
// the inputs change (each entry keeps a key of what it was built from; vector
// blobs are immutable, so the bytes' identity stands for their content).
// Shared by the renderer, hit-testing and the vector commands.
#pragma once

#include <functional>
#include <unordered_map>

#include "geometry/VectorNetwork.h"
#include "scene/Node.h"

namespace eng {

class Document;
namespace text {
struct TextLayout;
}

struct NodeGeometry {
  std::vector<geom::FillRegion> fills;  // node space
  geom::StrokeCenter stroke;            // node space
  bool hasOpenEnds = false;             // the stroke has open contours (caps)
  uint64_t fillKey = 0, strokeKey = 0;  // change whenever the paths do
  Rect bounds;                          // of the fills and the stroke centre line
};

// Figma's path trim on a node (`pathTrim` in `extra`, x = start, y = end; docs/motion.md §4.13): true with its start
// and end (0–1) when it cuts anything (present, and not [0, 1]). The geometry's stroke centre line is the trimmed one
// where the stroke is centred or open (Figma trims center strokes only), so the renderer, exports and hit-testing all
// draw and test what is left.
bool pathTrimOf(const NodeProps& p, double& start, double& end);

class GeometryCache {
 public:
  using TextSource = std::function<const text::TextLayout*(Guid)>;
  void setTextSource(TextSource source) { text_ = std::move(source); }
  // TEXT_PATH layouts (Figma Draw's text on a path, text/TextPathLayout.h): its geometry is its placed glyphs' outlines,
  // and hit-testing reads its glyph boxes. The editor sets it (Editor::textLayout).
  void setTextPathSource(TextSource source) { pathText_ = std::move(source); }
  const text::TextLayout* textPathLayout(Guid id) const { return pathText_ ? pathText_(id) : nullptr; }

  // The node's geometry (nullptr for nodes without one: pages, groups, frames' children…).
  // Frames and rectangles: their (rounded, smoothed) box; ellipses: their arc; vectors, stars,
  // polygons, lines, booleans, text: their own paths.
  const NodeGeometry* get(const Document& doc, Guid id);
  void clear() { entries_.clear(); }

  // A vector network as the node holds it (decoded once per blob).
  const geom::VectorNetwork* network(const VectorData& data);

 private:
  struct Entry {
    uint64_t input = 0;
    Bytes network;  // the blob the entry was built from (its identity is part of the input)
    NodeGeometry geometry;
    bool valid = false;
    // The document and its version it was last checked against: unchanged since, a shape's inputs are too (every
    // change bumps the version) — its key isn't hashed again each frame (round 18: ~1.4 ms a frame at 3 % on B2C).
    // Text keeps hashing: its layout can change with the document as it was (a font arriving).
    const Document* doc = nullptr;
    uint64_t checkedAt = 0;
  };
  uint64_t inputKey(const Document& doc, Guid id, const NodeProps& p, int depth);
  void build(const Document& doc, Guid id, const NodeProps& p, NodeGeometry& out, int depth);
  const NodeGeometry* get(const Document& doc, Guid id, int depth);

  std::unordered_map<Guid, Entry, GuidHash> entries_;
  std::unordered_map<const void*, std::pair<Bytes, geom::VectorNetwork>> networks_;
  TextSource text_;
  TextSource pathText_;
};

}  // namespace eng
