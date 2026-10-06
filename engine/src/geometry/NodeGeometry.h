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

class GeometryCache {
 public:
  using TextSource = std::function<const text::TextLayout*(Guid)>;
  void setTextSource(TextSource source) { text_ = std::move(source); }

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
  };
  uint64_t inputKey(const Document& doc, Guid id, const NodeProps& p, int depth);
  void build(const Document& doc, Guid id, const NodeProps& p, NodeGeometry& out, int depth);
  const NodeGeometry* get(const Document& doc, Guid id, int depth);

  std::unordered_map<Guid, Entry, GuidHash> entries_;
  std::unordered_map<const void*, std::pair<Bytes, geom::VectorNetwork>> networks_;
  TextSource text_;
};

}  // namespace eng
