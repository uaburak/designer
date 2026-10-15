// Figma Draw's tools (docs/draw.md §4.4–4.5; Phase 7 round 7b): the Pencil's and the Brush's settings (the secondary
// toolbar), the strokes they make, ⌘-click sampling (DRAW_TOOL_SAMPLED), the Text on path tool (and the Text tool) on a
// path's edge, a text path's start handle (gesture TEXT_PATH_START) and its caret and selection turned along the path.

#include <algorithm>
#include <cmath>
#include <cstdio>

#include "editor/Editor.h"
#include "geometry/Brush.h"
#include "geometry/DynamicStroke.h"
#include "hit/HitTest.h"
#include "scene/CodecKiwi.h"
#include "text/TextPathLayout.h"

namespace eng {

namespace {

constexpr double kEdgeReach = 6;    // CSS px: a path's edge under the Text on path tool (docs/draw.md §4.4)
constexpr double kHandleReach = 6;  // CSS px: the start handle

bool parseHex(const json::Value* v, Color& out) {
  if (!v || !v->isString()) return false;
  std::string s = v->string;
  if (!s.empty() && s[0] == '#') s.erase(0, 1);
  if (s.size() != 6 && s.size() != 8) return false;
  unsigned long x = std::strtoul(s.substr(0, 6).c_str(), nullptr, 16);
  out = Color::hex(static_cast<uint32_t>(x), 1);
  return true;
}

std::string hexOf(const Color& c) {
  auto ch = [](float v) { return static_cast<int>(std::lround(std::clamp(v, 0.f, 1.f) * 255)); };
  char buf[8];
  std::snprintf(buf, sizeof buf, "#%02X%02X%02X", ch(c.r), ch(c.g), ch(c.b));
  return buf;
}

double numberOf(const json::Value* v, double fallback) { return v && v->isNumber() ? v->number : fallback; }

std::string encode(const char* key, const std::string& jsonText) {
  json::Value v;
  if (!json::parse(jsonText, v)) return {};
  return codec::extraFromJson("NodeChange", key, v);
}

std::string num(double v) {
  json::Writer w;
  w.number(std::isfinite(v) ? v : 0);
  return w.take();
}

// Arc length → point on a polyline contour (closed ones wrap).
Vec2 pointAt(const std::vector<Vec2>& pts, bool closed, double s) {
  if (pts.empty()) return {};
  double total = 0;
  for (size_t i = 1; i < pts.size(); i++) total += (pts[i] - pts[i - 1]).length();
  if (total <= 0) return pts[0];
  if (closed) s = std::fmod(std::fmod(s, total) + total, total);
  else s = std::clamp(s, 0.0, total);
  for (size_t i = 1; i < pts.size(); i++) {
    double l = (pts[i] - pts[i - 1]).length();
    if (s <= l || i + 1 == pts.size()) return l > 0 ? pts[i - 1] + (pts[i] - pts[i - 1]) * (std::min(s, l) / l) : pts[i - 1];
    s -= l;
  }
  return pts.back();
}

}  // namespace

// ---- The tools' settings ------------------------------------------------------------------------------------------------

Status Editor::setDrawToolSettings(const json::Value& v) {
  if (!v.isObject()) return E_INVALID;
  if (const json::Value* p = v.get("pencil"); p && p->isObject()) {
    DrawTools::Pencil& d = drawTools_.pencil;
    parseHex(p->get("color"), d.color);
    d.opacity = std::clamp(numberOf(p->get("opacity"), d.opacity), 0.0, 1.0);
    d.weight = std::clamp(numberOf(p->get("weight"), d.weight), 0.5, 100.0);
    if (const json::Value* k = p->get("kind"); k && k->isString()) d.dynamic = k->string == "DYNAMIC";
    if (const json::Value* dy = p->get("dynamic"); dy && dy->isObject()) {
      d.settings.frequency = std::clamp(numberOf(dy->get("frequency"), d.settings.frequency), 0.01, 20.0);
      d.settings.wiggle = std::clamp(numberOf(dy->get("wiggle"), d.settings.wiggle), 0.0, 100.0);
      d.settings.smoothen = std::clamp(numberOf(dy->get("smoothen"), d.settings.smoothen), 0.0, 1.0);
    }
  }
  if (const json::Value* b = v.get("brush"); b && b->isObject()) {
    DrawTools::Brush& d = drawTools_.brush;
    parseHex(b->get("color"), d.color);
    d.opacity = std::clamp(numberOf(b->get("opacity"), d.opacity), 0.0, 1.0);
    d.weight = std::clamp(numberOf(b->get("weight"), d.weight), 0.5, 100.0);
    if (const json::Value* g = b->get("brush")) {
      bool ok = false;
      Guid id = g->isString() ? Guid::parse(g->string, &ok) : kNoGuid;
      d.brush = ok ? id : kNoGuid;
    }
  }
  return OK;
}

void Editor::drawStrokeProps(NodeProps& p, bool brush) {
  p.fillPaints.clear();
  if (brush) {
    const DrawTools::Brush& b = drawTools_.brush;
    p.strokePaints = {Paint::solid(b.color, static_cast<float>(b.opacity))};
    p.strokeWeight = static_cast<float>(b.weight);
    const Node* bn = b.brush != kNoGuid ? doc_.get(b.brush) : nullptr;
    if (bn && bn->props.type == NodeType::BRUSH) {
      json::Value t;
      auto it = bn->props.extra.find("brushType");
      bool scatter = it != bn->props.extra.end() && json::parse(codec::extraValueToJson("NodeChange", it->second), t) && t.isString() &&
                     t.string == "SCATTER";
      p.extra["strokeBrushGuid"] = encode("strokeBrushGuid", "{\"sessionID\":" + std::to_string(b.brush.sessionID) + ",\"localID\":" +
                                                                 std::to_string(b.brush.localID) + "}");
      // Figma's {base, ...the brush's own settings} (docs/research/rea/vector.md §5).
      p.extra[scatter ? "scatterStrokeSettings" : "stretchStrokeSettings"] = appliedBrushSettings(b.brush, scatter, nullptr);
      p.extra["strokeSeed"] = encode("strokeSeed", num(static_cast<double>(newStrokeSeed())));
    }
    return;
  }
  const DrawTools::Pencil& d = drawTools_.pencil;
  p.strokePaints = {Paint::solid(d.color, static_cast<float>(d.opacity))};
  p.strokeWeight = static_cast<float>(d.weight);
  if (d.dynamic) {
    p.extra["dynamicStrokeSettings"] = encode("dynamicStrokeSettings", "{\"frequency\":" + num(d.settings.frequency) + ",\"wiggle\":" +
                                                                             num(d.settings.wiggle) + ",\"smoothen\":" + num(d.settings.smoothen) + "}");
    p.extra["strokeSeed"] = encode("strokeSeed", num(static_cast<double>(newStrokeSeed())));
  }
}

// ⌘-click with the Pencil or the Brush on a stroked layer: its colour, weight and style become the tool's
// (DRAW_TOOL_SAMPLED; the chrome updates its settings and sends them back).
bool Editor::drawSample(Vec2 world, uint32_t mods) {
  (void)mods;
  if (page_ == kNoGuid) return false;
  auto path = hitPath(doc_, page_, world, pixel());
  for (auto it = path.rbegin(); it != path.rend(); ++it) {
    const Node* n = doc_.get(*it);
    if (!n) continue;
    const Paint* solid = nullptr;
    for (const Paint& pt : n->props.strokePaints)
      if (pt.visible && pt.type == PaintType::SOLID) solid = &pt;
    if (!solid || n->props.strokeWeight <= 0) continue;
    const bool brushTool = tool_ == Tool::BRUSH;
    Guid brush = strokeBrushOf(n->props);
    if (brush != kNoGuid && !(doc_.get(brush) && doc_.get(brush)->props.type == NodeType::BRUSH)) brush = kNoGuid;
    geom::DynamicSettings dyn;
    bool dynamic = dynamicSettingsOf(n->props, dyn);
    double opacity = solid->opacity * solid->color.a;
    json::Writer w;
    w.beginObject().key("tool").string(brushTool ? "BRUSH" : "PENCIL").key("color").string(hexOf(solid->color));
    w.key("opacity").number(opacity).key("weight").number(n->props.strokeWeight);
    w.key("kind").string(brush != kNoGuid ? "BRUSH" : dynamic ? "DYNAMIC" : "BASIC");
    if (dynamic)
      w.key("dynamic").beginObject().key("frequency").number(dyn.frequency).key("wiggle").number(dyn.wiggle).key("smoothen").number(dyn.smoothen).endObject();
    if (brush != kNoGuid) w.key("brush").string(brush.toString());
    w.endObject();
    events_.drawSampled.push_back(w.take());
    // The engine's own copy follows at once (the chrome's echo sets the same).
    if (brushTool) {
      drawTools_.brush.color = Color{solid->color.r, solid->color.g, solid->color.b, 1};
      drawTools_.brush.opacity = opacity;
      drawTools_.brush.weight = n->props.strokeWeight;
      if (brush != kNoGuid) drawTools_.brush.brush = brush;
    } else {
      drawTools_.pencil.color = Color{solid->color.r, solid->color.g, solid->color.b, 1};
      drawTools_.pencil.opacity = opacity;
      drawTools_.pencil.weight = n->props.strokeWeight;
      drawTools_.pencil.dynamic = dynamic;
      if (dynamic) drawTools_.pencil.settings = dyn;
    }
    return true;
  }
  return false;
}

// ---- Text on a path -------------------------------------------------------------------------------------------------------

Guid Editor::textPathTargetAt(Vec2 world) const {
  if (page_ == kNoGuid) return kNoGuid;
  const double slop = kEdgeReach / camera_.zoom;
  Guid found = kNoGuid;
  auto candidate = [](const NodeProps& p) {
    return p.type == NodeType::VECTOR || p.type == NodeType::LINE || p.isRectLike() || p.type == NodeType::ELLIPSE || p.type == NodeType::STAR ||
           p.type == NodeType::REGULAR_POLYGON;
  };
  // Topmost first: children back to front, each before its parent.
  auto visit = [&](auto&& self, Guid id) -> bool {
    const Node* n = doc_.get(id);
    if (!n || !n->props.visible || n->props.locked || id.isDerived()) return false;
    Rect rb = doc_.renderBounds(id);
    if (!(world.x >= rb.x - slop && world.x <= rb.right() + slop && world.y >= rb.y - slop && world.y <= rb.bottom() + slop)) return false;
    if (n->props.type != NodeType::INSTANCE) {
      const auto& kids = doc_.children(id);
      for (auto it = kids.rbegin(); it != kids.rend(); ++it)
        if (self(self, *it)) return true;
    }
    if (!candidate(n->props)) return false;
    Mat2x3 W = doc_.worldTransform(id);
    double unit = std::sqrt(std::fabs(W.determinant()));
    Vec2 local = W.inverse().apply(world);
    if (!hitsEdge(doc_, id, local, unit > 0 ? slop / unit : slop)) return false;
    found = id;
    return true;
  };
  const auto& top = doc_.children(page_);
  for (auto it = top.rbegin(); it != top.rend(); ++it)
    if (visit(visit, *it)) break;
  return found;
}

bool Editor::textPathHandle(Guid& node, Vec2& world) const {
  if (selection_.size() != 1 || text_.node != kNoGuid || vector_.node != kNoGuid || viewer_ || !selectingTool()) return false;
  const Node* n = doc_.get(selection_[0]);
  if (!n || n->props.type != NodeType::TEXT_PATH) return false;
  const geom::VectorNetwork* net = const_cast<Document&>(doc_).geometryCache().network(n->props.shape().vectorData);
  if (!net) return false;
  double t = 0;
  bool forward = true;
  text::textPathStartOf(n->props, t, forward);
  std::vector<Vec2> contour;
  bool closed = false;
  double s = 0;
  int dir = 1;
  if (!text::textPathContour(*net, n->props.shape().vectorData, n->props.size, t, contour, closed, s, dir)) return false;
  node = selection_[0];
  world = doc_.worldTransform(node).apply(pointAt(contour, closed, s));
  return true;
}

void Editor::textPathStartMove(Vec2 world) {
  const Node* n = doc_.get(textPathDrag_);
  if (!n || n->props.type != NodeType::TEXT_PATH) return;
  const geom::VectorNetwork* net = doc_.geometryCache().network(n->props.shape().vectorData);
  if (!net) return;
  Vec2 local = doc_.worldTransform(textPathDrag_).inverse().apply(world);
  double t = 0, old = 0;
  bool forward = true;
  text::textPathStartOf(n->props, old, forward);
  if (!text::textPathProject(*net, n->props.shape().vectorData, n->props.size, local, t) || t == old) return;
  NodeChange c = NodeChange::changed(textPathDrag_);
  c.mask = F_EXTRA;
  c.props.extra["textPathStart"] = encode("textPathStart", "{\"tValue\":" + num(t) + ",\"forward\":" + (forward ? "true" : "false") + "}");
  write(c);
  needsRender_ = true;
}

uint32_t Editor::drawPointerDown(Vec2 s, uint32_t mods) {
  if (viewer_ || page_ == kNoGuid) return 0;
  Vec2 world = camera_.toWorld(s);
  // ⌘-click with the Pencil or the Brush: sampling, no stroke.
  if ((tool_ == Tool::PENCIL || tool_ == Tool::BRUSH) && vector_.node == kNoGuid && (mods & MOD_PRIMARY)) {
    if (drawSample(world, mods)) return P_HANDLED;
    return 0;
  }
  // A selected text path's start handle: dragged along the path ("Move text start", one step).
  Guid hn;
  Vec2 hw;
  if (textPathHandle(hn, hw) && (camera_.toScreen(hw) - s).length() <= kHandleReach) {
    begin(TxnKind::GESTURE, "Move text start");
    textPathDrag_ = hn;
    gesture_ = Gesture::TextPathStart;
    return P_HANDLED | P_CAPTURE;
  }
  // Text on path, and the Text tool over a path's edge: a TEXT_PATH above that layer, its text edited from empty.
  if (tool_ == Tool::TEXT_PATH || tool_ == Tool::TEXT) {
    if (tool_ == Tool::TEXT) {
      auto path = hitPath(doc_, page_, world, pixel());
      if (!path.empty())
        if (const Node* hit = doc_.get(path.back()); hit && hit->props.isTextLike()) return 0;  // the Text tool edits that text
    }
    Guid target = textPathTargetAt(world);
    if (target == kNoGuid) return tool_ == Tool::TEXT_PATH ? P_HANDLED : 0;
    geom::VectorNetwork net;
    bool convert = false;
    if (!networkOf(target, net, convert)) return tool_ == Tool::TEXT_PATH ? P_HANDLED : 0;
    const Node* tn = doc_.get(target);
    VectorData d;
    d.present = true;
    d.normalizedSize = tn->props.size;
    Vec2 local = doc_.worldTransform(target).inverse().apply(world);
    double t = 0;
    text::textPathProject(net, d, tn->props.size, local, t);
    Guid made = kNoGuid;
    if (createTextPath(target, t, false, &made) != OK) return P_HANDLED;
    textPathHover_ = kNoGuid;
    setTool(Tool::MOVE);
    startTextEdit(made, false);
    text_.created = true;
    text_.undoCount = undo_.undoCount();
    return P_HANDLED;
  }
  return 0;
}

bool Editor::drawCursor(Vec2 s) {
  if (tool_ == Tool::BRUSH) {
    changeCursor(CursorKind::BRUSH);
    return true;
  }
  Guid hover = kNoGuid;
  if ((tool_ == Tool::TEXT_PATH || tool_ == Tool::TEXT) && gesture_ == Gesture::None && text_.node == kNoGuid && !viewer_)
    hover = textPathTargetAt(camera_.toWorld(s));
  if (hover != textPathHover_) {
    textPathHover_ = hover;
    needsRender_ = true;
  }
  if (hover != kNoGuid) {
    changeCursor(CursorKind::TEXT_PATH);
    return true;
  }
  if (tool_ == Tool::TEXT_PATH) {
    changeCursor(CursorKind::IBEAM);
    return true;
  }
  return false;
}

void Editor::textPathOverlay(Overlay& o) const {
  Guid hn;
  Vec2 hw;
  if (gesture_ == Gesture::TextPathStart && textPathDrag_ != kNoGuid) {
    o.handles = false;
    o.sizeBadge = false;
  }
  if (textPathHandle(hn, hw)) {
    // The start handle: a vector point in the selection colour [look unverified, docs/draw.md §4.4].
    OverlayMark m;
    m.shape = OverlayMark::Shape::Vertex;
    m.world = hw;
    m.selected = true;
    o.marks.push_back(m);
  }
  // The edge the Text on path tool would write on: outlined as a hover.
  if ((tool_ == Tool::TEXT_PATH || tool_ == Tool::TEXT) && textPathHover_ != kNoGuid && doc_.has(textPathHover_)) o.hover = {textPathHover_};
}

void Editor::textPathEditOverlay(Overlay& o, const text::TextLayout& L) const {
  if (!L.path || L.lines.empty()) return;
  const text::LaidLine& l = L.lines[0];
  Mat2x3 W = doc_.worldTransform(text_.node);
  auto at = [&](double x, double y) { return W.apply(L.path->toNode({x, y})); };
  // The selection: its rects cut into short quads turned along the path.
  for (const Rect& r : L.selectionRects(textSelStart(), textSelEnd())) {
    int pieces = std::clamp(static_cast<int>(std::ceil(r.w / std::max(1.0, r.h / 3))), 1, 256);
    for (int i = 0; i < pieces; i++) {
      double x0 = r.x + r.w * i / pieces, x1 = r.x + r.w * (i + 1) / pieces;
      Overlay::Region q;
      q.path.moveTo(at(x0, r.y));
      q.path.lineTo(at(x1, r.y));
      q.path.lineTo(at(x1, r.bottom()));
      q.path.lineTo(at(x0, r.bottom()));
      q.path.close();
      q.alpha = 0.3;
      o.regions.push_back(std::move(q));
    }
  }
  // The caret: a bar across the line at the glyph boundary, turned with the path.
  if (text_.anchor == text_.focus && text_.caretOn) {
    double x = L.caretX(text_.focus, 0);
    Vec2 a = at(x, l.top), b = at(x, l.top + l.height);
    o.curves.push_back({a, a, b, b, 1, true});
  }
}

}  // namespace eng
