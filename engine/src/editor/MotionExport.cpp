// What Motion's vector exports read (docs/motion.md §7.5, §7.6; round 8e): the shapes of a timeline root's layers at
// their base values — each layer's fills and strokes as SVG path data in its own space with their paints, its local
// transform, opacity and clipping, the layers that can't be shapes (images, shaders, angular gradients, blurs, masks)
// marked to be exported as a raster of their base state — and the samples: each layer's evaluated transform, opacity,
// path trim, solid colours and stroke weight at given times. The Lottie / dotLottie and animated SVG writers
// (editor/motion/export/) build their files from the two.
//
// Strokes are their centre line with the stroke's style where Lottie and SVG draw them the same way (a centred or open
// stroke; path trim then trims that line, as Figma's own does), else their outline as a filled area. The path trim of
// the base is left out of the shapes (the full centre line); the samples carry it.
#include <cmath>

#include "editor/Editor.h"
#include "export/Export.h"
#include "export/Scene.h"
#include "geometry/NodeGeometry.h"
#include "geometry/Shapes.h"
#include "scene/Extras.h"

namespace eng {

namespace {

using exporter::num;

// A path as SVG path data with absolute M / L / Q / C / Z (the TypeScript writers parse exactly these).
std::string pathD(const geom::Path& path) {
  std::string d;
  size_t pi = 0;
  auto pt = [&](Vec2 p) { return num(p.x) + " " + num(p.y); };
  for (geom::Verb v : path.verbs) {
    switch (v) {
      case geom::Verb::Move: d += "M" + pt(path.points[pi++]); break;
      case geom::Verb::Line: d += "L" + pt(path.points[pi++]); break;
      case geom::Verb::Quad:
        d += "Q" + pt(path.points[pi]) + " " + pt(path.points[pi + 1]);
        pi += 2;
        break;
      case geom::Verb::Cubic:
        d += "C" + pt(path.points[pi]) + " " + pt(path.points[pi + 1]) + " " + pt(path.points[pi + 2]);
        pi += 3;
        break;
      case geom::Verb::Close: d += "Z"; break;
    }
  }
  return d;
}

void writeMatrix(json::Writer& w, const Mat2x3& m) {
  // SVG's matrix(a b c d e f): x' = a x + c y + e, y' = b x + d y + f.
  w.beginArray().number(m.m00).number(m.m10).number(m.m01).number(m.m11).number(m.m02).number(m.m12).endArray();
}

void writeColor(json::Writer& w, Color c, double alpha) {
  w.beginObject().key("r").number(c.r).key("g").number(c.g).key("b").number(c.b).key("a").number(c.a * alpha).endObject();
}

// A paint the shapes can carry: solid, linear or radial (the gradients by their two ends in node space).
bool vectorPaint(const Paint& p) { return p.type == PaintType::SOLID || p.type == PaintType::GRADIENT_LINEAR || p.type == PaintType::GRADIENT_RADIAL; }

void writeShapePaint(json::Writer& w, const Paint& p, Vec2 size) {
  w.beginObject();
  if (p.type == PaintType::SOLID) {
    w.key("type").string("SOLID").key("color");
    writeColor(w, p.color, p.opacity);
  } else {
    // The gradient's unit space (linear: t = x; radial: |g − ½| × 2) mapped back to node space.
    Mat2x3 inv = exporter::gradientMatrix(p, size).inverse();
    bool linear = p.type == PaintType::GRADIENT_LINEAR;
    Vec2 from = inv.apply(linear ? Vec2{0, 0.5} : Vec2{0.5, 0.5}), to = inv.apply({1, 0.5});
    w.key("type").string(linear ? "GRADIENT_LINEAR" : "GRADIENT_RADIAL");
    w.key("from").beginObject().key("x").number(from.x).key("y").number(from.y).endObject();
    w.key("to").beginObject().key("x").number(to.x).key("y").number(to.y).endObject();
    w.key("stops").beginArray();
    for (const ColorStop& s : p.stops) {
      w.beginObject().key("position").number(s.position).key("color");
      writeColor(w, s.color, p.opacity);
      w.endObject();
    }
    w.endArray();
  }
  w.endObject();
}

const char* capName(StrokeCap c) { return c == StrokeCap::ROUND ? "ROUND" : c == StrokeCap::SQUARE ? "SQUARE" : "NONE"; }
const char* joinName(StrokeJoin j) { return j == StrokeJoin::ROUND ? "ROUND" : j == StrokeJoin::BEVEL ? "BEVEL" : "MITER"; }

// Effects a vector file can't draw (blurs, grain, noise, glass, shaders); shadows are left out (drawn by neither).
bool rasterEffect(const NodeProps& p) {
  for (const Effect& e : p.effects)
    if (visibleForRendering(e) && e.type != EffectType::DROP_SHADOW && e.type != EffectType::INNER_SHADOW) return true;
  return false;
}

}  // namespace

// The layers of a root as the vector exports walk them: the root first, then each drawn child after its parent, back
// to front; a layer to be rasterised is a leaf (its subtree is in its raster).
std::vector<std::pair<Guid, Guid>> Editor::motionExportLayers(Guid root) {
  std::vector<std::pair<Guid, Guid>> out;
  derivePageOf(root);
  auto visit = [&](auto&& self, Guid id, Guid parent) -> void {
    out.push_back({id, parent});
    const Node* n = doc_.get(id);
    if (!n || !exporter::drawsChildren(n->props) || motionRasterized(id)) return;
    for (const exporter::Drawn& d : exporter::drawnChildren(doc_, id)) self(self, d.id, id);
  };
  visit(visit, root, kNoGuid);
  return out;
}

// A layer the vector exports draw as a raster of its base state: a leaf with a paint shapes can't carry (images,
// videos, angular / diamond gradients, patterns, noise, shaders) or an effect they can't draw; any layer holding a mask.
bool Editor::motionRasterized(Guid id) const {
  const Node* n = doc_.get(id);
  if (!n) return false;
  const NodeProps& p = n->props;
  bool kids = false;
  if (exporter::drawsChildren(p))
    for (const exporter::Drawn& d : exporter::drawnChildren(doc_, id)) {
      kids = true;
      if (d.node && d.node->props.mask) return true;
    }
  if (kids) return false;  // a frame or group: its own unsupported paints are left out, its children drawn
  for (const std::vector<Paint>* list : {&p.fillPaints, &p.strokePaints})
    for (const Paint& paint : *list)
      if (exporter::drawable(paint) && !vectorPaint(paint)) return true;
  return rasterEffect(p);
}

void Editor::writeMotionShapes(json::Writer& w, Guid rootIn) {
  Guid root = motionIndex().rootOf(doc_, rootIn);
  if (root == kNoGuid || !doc_.has(root)) {
    w.null();
    return;
  }
  motion::Suspend hold = motionSuspended();  // the base values
  std::vector<std::pair<Guid, Guid>> layers = motionExportLayers(root);
  // The full centre lines of path-trimmed strokes: the trim is the samples' (preview writes, put back below).
  for (auto& [id, parent] : layers) {
    const Node* n = doc_.get(id);
    if (!n || n->props.extra.find("pathTrim") == n->props.extra.end()) continue;
    NodeChange c = NodeChange::changed(id);
    c.mask = F_EXTRA;
    c.props.extra["pathTrim"] = "";
    motionLayer_.preview(doc_, c);
  }
  w.beginArray();
  for (auto& [id, parent] : layers) {
    const Node* n = doc_.get(id);
    if (!n) continue;
    const NodeProps& p = n->props;
    w.beginObject();
    w.key("node").string(id.toString()).key("parent");
    if (parent == kNoGuid) w.null();
    else w.string(parent.toString());
    w.key("name").string(p.name).key("type").string(nodeTypeName(p.type));
    w.key("transform");
    writeMatrix(w, id == root ? Mat2x3{} : p.transform);  // the root drawn at the origin
    w.key("size").beginObject().key("width").number(p.size.x).key("height").number(p.size.y).endObject();
    w.key("opacity").number(id == root ? 1 : p.opacity);
    w.key("clips").boolean(p.clipsContent() && !doc_.children(id).empty());
    bool raster = motionRasterized(id);
    w.key("rasterize").boolean(raster);
    if (raster) {
      // Its base state's pixels cover its visual bounds; placed in its own space (image px at scale 1 → node space).
      Rect b = exporter::contentBounds(doc_, this, id);
      Mat2x3 place = doc_.worldTransform(id).inverse() * Mat2x3::translate(b.x, b.y);
      w.key("raster").beginObject().key("width").number(b.w).key("height").number(b.h).key("transform");
      writeMatrix(w, place);
      w.endObject();
    }
    w.key("paths").beginArray();
    if (!raster) {
      // Fills (bottom first), text as its glyphs' outlines, then strokes.
      auto fillPath = [&](const std::string& d, bool evenOdd, const Paint& paint, const char* collection, size_t index) {
        w.beginObject().key("d").string(d).key("windingRule").string(evenOdd ? "EVENODD" : "NONZERO").key("paint");
        writeShapePaint(w, paint, p.size);
        w.key("source").beginObject().key("collection").string(collection).key("index").number(static_cast<double>(index)).endObject();
        w.endObject();
      };
      if (p.isTextLike()) {
        if (const text::TextLayout* L = textLayout(id))
          for (const exporter::GlyphFill& g : exporter::glyphFills(*L))
            if (g.paint && exporter::drawable(*g.paint) && vectorPaint(*g.paint)) {
              size_t index = 0;
              for (size_t i = 0; i < p.fillPaints.size(); i++)
                if (&p.fillPaints[i] == g.paint) index = i;
              fillPath(pathD(g.path), false, *g.paint, "fills", index);
            }
      } else {
        exporter::Shape sh = exporter::fillShape(doc_, id, p);
        if (!sh.empty()) {
          std::string d = pathD(sh.path());
          for (size_t i = 0; i < p.fillPaints.size(); i++)
            if (exporter::drawable(p.fillPaints[i]) && vectorPaint(p.fillPaints[i])) fillPath(d, sh.evenOdd(), p.fillPaints[i], "fills", i);
        }
        exporter::Stroke st = exporter::strokeOf(doc_, id, p);
        if (st.present()) {
          bool line = !st.outlineOnly && !st.ring && !st.aligned && st.profile.empty() && !(st.fitDashes && !st.dashes.empty());
          std::string d = pathD(line ? st.center : exporter::strokeArea(st, sh, 0.05));
          for (size_t i = 0; i < p.strokePaints.size(); i++) {
            const Paint& paint = p.strokePaints[i];
            if (!exporter::drawable(paint) || !vectorPaint(paint)) continue;
            w.beginObject().key("d").string(d).key("windingRule").string("NONZERO").key("paint");
            writeShapePaint(w, paint, p.size);
            w.key("source").beginObject().key("collection").string("strokes").key("index").number(static_cast<double>(i)).endObject();
            if (line) {
              w.key("stroke").beginObject().key("weight").number(st.weight).key("cap").string(capName(st.cap)).key("join").string(joinName(st.join));
              w.key("miterLimit").number(st.miterLimit).key("dashes").beginArray();
              for (double x : st.dashes) w.number(x);
              w.endArray().endObject();
            }
            w.endObject();
          }
        }
      }
    }
    w.endArray();
    w.endObject();
  }
  w.endArray();
  motionLayer_.restore(doc_);
}

void Editor::writeMotionSamples(json::Writer& w, Guid rootIn, const std::vector<int64_t>& times) {
  Guid root = motionIndex().rootOf(doc_, rootIn);
  if (root == kNoGuid || !doc_.has(root)) {
    w.null();
    return;
  }
  std::vector<std::pair<Guid, Guid>> layers;
  {
    motion::Suspend hold = motionSuspended();
    layers = motionExportLayers(root);
  }
  // Each time: the motion layer at it, each layer's values read; the view state put back after.
  struct Restore {
    Editor& ed;
    motion::State prev;
    ~Restore() { ed.setMotion(prev); }
  } restore{*this, motion_};
  std::vector<std::string> frames(layers.size());
  for (int64_t t : times) {
    motion::State at = restore.prev;
    at.on = true;
    at.root = root;
    at.timeUs = std::max<int64_t>(0, t);
    setMotion(at);
    for (size_t i = 0; i < layers.size(); i++) {
      Guid id = layers[i].first;
      const Node* n = doc_.get(id);
      if (!n) continue;
      const NodeProps& p = n->props;
      json::Writer f;
      f.beginObject().key("t");
      writeMatrix(f, id == root ? Mat2x3{} : p.transform);
      f.key("o").number(id == root ? 1 : p.opacity).key("w").number(p.size.x).key("h").number(p.size.y);
      if (double s = 0, e = 1; pathTrimOf(p, s, e)) f.key("trim").beginArray().number(s).number(e).endArray();
      auto colours = [&](const char* key, const std::vector<Paint>& list) {
        f.key(key).beginArray();
        for (const Paint& paint : list) {
          if (paint.type == PaintType::SOLID) writeColor(f, paint.color, paint.opacity);
          else f.null();
        }
        f.endArray();
      };
      colours("fills", p.fillPaints);
      colours("strokes", p.strokePaints);
      f.key("sw").number(p.strokeWeight).endObject();
      if (!frames[i].empty()) frames[i] += ",";
      frames[i] += f.take();
    }
  }
  w.beginObject().key("root").string(root.toString()).key("times").beginArray();
  for (int64_t t : times) w.number(static_cast<double>(t));
  w.endArray().key("layers").beginArray();
  for (size_t i = 0; i < layers.size(); i++) {
    w.beginObject().key("node").string(layers[i].first.toString()).key("frames");
    w.raw("[" + frames[i] + "]");
    w.endObject();
  }
  w.endArray().endObject();
}

}  // namespace eng
