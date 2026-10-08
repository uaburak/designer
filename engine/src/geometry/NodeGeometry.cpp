#include "geometry/NodeGeometry.h"

#include <cstring>

#include "geometry/Boolean.h"
#include "geometry/Shapes.h"
#include "scene/Document.h"
#include "text/TextLayout.h"

namespace eng {

namespace {

constexpr int kMaxDepth = 64;

struct Hasher {
  uint64_t h = 1469598103934665603ull;
  void bytes(const void* data, size_t size) {
    const auto* p = static_cast<const uint8_t*>(data);
    for (size_t i = 0; i < size; i++) {
      h ^= p[i];
      h *= 1099511628211ull;
    }
  }
  template <typename T>
  void pod(const T& v) {
    bytes(&v, sizeof v);
  }
  void d(double v) { pod(v); }
  void m(const Mat2x3& x) {
    d(x.m00), d(x.m01), d(x.m02), d(x.m10), d(x.m11), d(x.m12);
  }
};

bool openEnds(const geom::Path& p) {
  bool open = false;
  geom::forEachSegment(p, [](Vec2) {}, [](geom::Verb, Vec2, const Vec2*) {}, [&](bool closed) { open |= !closed; });
  return open;
}

geom::Path textPath(const text::TextLayout& L) {
  geom::Path path;
  for (const text::LaidGlyph& g : L.glyphs) {
    if (!g.font) continue;
    const text::GlyphOutline& o = g.font->outline(g.glyph);
    Vec2 last{1e300, 1e300};
    bool open = false;
    for (size_t c = 0; c < o.curveCount(); c++) {
      const float* q = &o.curves[c * 6];
      auto at = [&](float x, float y) { return Vec2{g.x + x * g.size, g.y + y * g.size}; };
      Vec2 p0 = at(q[0], q[1]), p1 = at(q[2], q[3]), p2 = at(q[4], q[5]);
      if (!(p0 == last)) {
        if (open) path.close();
        path.moveTo(p0);
        open = true;
      }
      path.quadTo(p1, p2);
      last = p2;
    }
    if (open) path.close();
  }
  return path;
}

}  // namespace

const geom::VectorNetwork* GeometryCache::network(const VectorData& data) {
  if (!data.network || data.network->empty()) return nullptr;
  auto it = networks_.find(data.network.get());
  if (it != networks_.end() && it->second.first == data.network) return &it->second.second;
  if (networks_.size() > 4096) networks_.clear();
  geom::VectorNetwork net;
  if (!geom::VectorNetwork::decode(data.network->data(), data.network->size(), net)) net = {};
  auto& slot = networks_[data.network.get()];
  slot = {data.network, std::move(net)};
  return &slot.second;
}

uint64_t GeometryCache::inputKey(const Document& doc, Guid id, const NodeProps& p, int depth) {
  Hasher h;
  h.pod(p.type);
  h.d(p.size.x), h.d(p.size.y);
  for (double r : p.cornerRadii) h.d(r);
  h.d(p.stroke().cornerSmoothing);
  h.d(p.shape().arcData.startingAngle), h.d(p.shape().arcData.endingAngle), h.d(p.shape().arcData.innerRadius);
  h.pod(p.shape().count);
  h.d(p.shape().starInnerScale);
  h.pod(p.strokeCap);
  h.pod(p.resizeToFit);
  if (p.shape().vectorData.present) {
    const void* bytes = p.shape().vectorData.network.get();
    h.pod(bytes);
    h.d(p.shape().vectorData.normalizedSize.x), h.d(p.shape().vectorData.normalizedSize.y);
    for (auto& st : p.shape().vectorData.styleOverrideTable) h.pod(st.styleID), h.pod(st.strokeCap), h.pod(st.mask), h.d(st.cornerRadius);
  }
  if (p.type == NodeType::TEXT && text_) {
    const text::TextLayout* L = text_(id);
    h.pod(L);
    if (L) {
      h.pod(L->glyphs.size());
      for (auto& g : L->glyphs) h.pod(g.glyph), h.pod(g.x), h.pod(g.y), h.pod(g.size), h.pod(g.font);
    }
  }
  if (p.isBoolean() || p.isGroupLike()) {
    h.pod(p.shape().booleanOperation);
    if (depth < kMaxDepth)
      for (Guid c : doc.children(id)) {
        const Node* n = doc.get(c);
        if (!n || !n->props.visible) continue;
        h.pod(c);
        h.m(n->props.transform);
        h.pod(inputKey(doc, c, n->props, depth + 1));
      }
  }
  return h.h;
}

void GeometryCache::build(const Document& doc, Guid id, const NodeProps& p, NodeGeometry& out, int depth) {
  using namespace geom;
  out = NodeGeometry{};
  auto closedShape = [&](Path path) {
    out.fills.push_back({path, WindingRule::NONZERO, 0});
    out.stroke.path = std::move(path);
  };
  switch (p.type) {
    case NodeType::RECTANGLE:
    case NodeType::ROUNDED_RECTANGLE:
    case NodeType::FRAME:
    case NodeType::SYMBOL:
    case NodeType::INSTANCE:
    case NodeType::SECTION:
      if (p.isGroupLike()) break;
      closedShape(rectPath(p.size, p.cornerRadii, p.stroke().cornerSmoothing));
      break;
    case NodeType::ELLIPSE: closedShape(ellipsePath(p.size, p.shape().arcData)); break;
    case NodeType::REGULAR_POLYGON: closedShape(polygonPath(p.size, p.shape().count ? p.shape().count : 3, p.cornerRadii[0])); break;
    case NodeType::STAR: closedShape(starPath(p.size, p.shape().count ? p.shape().count : 5, p.shape().starInnerScale, p.cornerRadii[0])); break;
    case NodeType::LINE:
    case NodeType::BRUSH:
    case NodeType::VECTOR: {
      const VectorNetwork* net = network(p.shape().vectorData);
      if (net && !net->empty()) {
        bool rounded = p.cornerRadii[0] > 0;
        for (auto& st : p.shape().vectorData.styleOverrideTable) rounded |= (st.mask & VS_CORNER_RADIUS) && st.cornerRadius > 0;
        if (rounded) {
          // Rounded corners are cut in the node's space (the network is scaled there first).
          VectorNetwork scaled = *net;
          double sx = p.shape().vectorData.normalizedSize.x != 0 ? p.size.x / p.shape().vectorData.normalizedSize.x : 1;
          double sy = p.shape().vectorData.normalizedSize.y != 0 ? p.size.y / p.shape().vectorData.normalizedSize.y : 1;
          scaled.scale(sx, sy);
          VectorData unit = p.shape().vectorData;
          unit.normalizedSize = p.size;
          VectorNetwork r = withRoundedCorners(scaled, unit, p.cornerRadii[0]);
          out.fills = networkFills(r, unit, p.size);
          out.stroke = networkStroke(r, unit, p.size, p.strokeCap);
        } else {
          out.fills = networkFills(*net, p.shape().vectorData, p.size);
          out.stroke = networkStroke(*net, p.shape().vectorData, p.size, p.strokeCap);
        }
      } else if (p.type == NodeType::LINE) {
        out.stroke.path = linePath(p.size);
        out.stroke.caps = {{p.strokeCap, p.strokeCap}};
      }
      break;
    }
    case NodeType::TEXT:
      if (text_)
        if (const text::TextLayout* L = text_(id)) closedShape(textPath(*L));
      break;
    case NodeType::BOOLEAN_OPERATION: {
      std::vector<Operand> ops;
      // An operand: a child's fill regions in this node's space (groups contribute their children's union).
      std::function<void(Guid, const Mat2x3&, Path&, int)> collect = [&](Guid c, const Mat2x3& m, Path& acc, int d) {
        const Node* n = doc.get(c);
        if (!n || !n->props.visible || d > kMaxDepth) return;
        Mat2x3 cm = m * n->props.transform;
        if (n->props.isGroupLike()) {
          for (Guid k : doc.children(c)) collect(k, cm, acc, d + 1);
          return;
        }
        const NodeGeometry* g = get(doc, c, d + 1);
        if (!g) return;
        for (auto& f : g->fills) {
          Path piece = f.windingRule == WindingRule::ODD ? simplify(f.path, WindingRule::ODD, 0.01) : f.path;
          acc.append(piece.transformed(cm));
        }
      };
      for (Guid c : doc.children(id)) {
        Operand o;
        collect(c, Mat2x3{}, o.path, depth);
        if (!o.path.empty()) ops.push_back(std::move(o));
      }
      if (!ops.empty()) closedShape(booleanOp(ops, p.shape().booleanOperation, 0.01));
      break;
    }
    default: break;
  }
  out.hasOpenEnds = openEnds(out.stroke.path);
  Rect b;
  bool any = false;
  for (auto& f : out.fills)
    if (!f.path.empty()) b = any ? b.united(f.path.bounds()) : f.path.bounds(), any = true;
  if (!out.stroke.path.empty()) b = any ? b.united(out.stroke.path.bounds()) : out.stroke.path.bounds(), any = true;
  out.bounds = b;
}

const NodeGeometry* GeometryCache::get(const Document& doc, Guid id) { return get(doc, id, 0); }

const NodeGeometry* GeometryCache::get(const Document& doc, Guid id, int depth) {
  const Node* n = doc.get(id);
  if (!n || depth > kMaxDepth) return nullptr;
  const NodeProps& p = n->props;
  switch (p.type) {
    case NodeType::DOCUMENT:
    case NodeType::CANVAS:
    case NodeType::GROUP:
    case NodeType::SLICE:
    case NodeType::VARIABLE:
    case NodeType::VARIABLE_SET:
    case NodeType::NONE: return nullptr;
    default: break;
  }
  if (p.isGroupLike()) return nullptr;
  uint64_t key = inputKey(doc, id, p, depth);
  Entry& e = entries_[id];
  if (!e.valid || e.input != key || e.network != p.shape().vectorData.network) {
    build(doc, id, p, e.geometry, depth);
    e.input = key;
    e.network = p.shape().vectorData.network;
    e.valid = true;
    e.geometry.fillKey = key;
    e.geometry.strokeKey = key * 31 + 7;
  }
  return &e.geometry;
}

}  // namespace eng
