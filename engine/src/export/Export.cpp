#include "export/Export.h"

#include <algorithm>
#include <cmath>
#include <unordered_set>

#include "export/Scene.h"
#include "geometry/Shapes.h"
#include "geometry/Stroker.h"

namespace eng::exporter {

namespace {

Rect intersect(const Rect& a, const Rect& b) {
  double l = std::max(a.x, b.x), t = std::max(a.y, b.y);
  double r = std::min(a.right(), b.right()), bt = std::min(a.bottom(), b.bottom());
  return {l, t, std::max(0.0, r - l), std::max(0.0, bt - t)};
}

Rect grow(const Rect& r, double by) { return {r.x - by, r.y - by, r.w + 2 * by, r.h + 2 * by}; }

double worldScale(const Mat2x3& m) { return std::sqrt(std::fabs(m.determinant())); }

struct Bounder {
  const Document& doc;
  TextLayouts* texts;

  // `id`'s visual bounds (world); false when nothing of it shows.
  bool visual(Guid id, Rect& out, int depth = 0) {
    const Node* n = doc.get(id);
    if (!n || depth > 256) return false;
    const NodeProps& p = n->props;
    if (!p.visible || p.opacity <= 0 || p.type == NodeType::SLICE) return false;
    Mat2x3 W = doc.worldTransform(id);
    bool any = false;
    Rect r;
    auto add = [&](const Rect& b) {
      r = any ? r.united(b) : b;
      any = true;
    };
    auto addPath = [&](const geom::Path& path) {
      if (!path.empty()) add(path.transformed(W).bounds());
    };
    if (p.type == NodeType::TEXT) {
      const text::TextLayout* L = texts ? texts->textLayout(id) : nullptr;
      if (L) {
        bool ink = false;
        Rect u;
        if (!L->glyphs.empty() && (L->inkBounds.w > 0 || L->inkBounds.h > 0)) {
          u = L->inkBounds;
          ink = true;
        }
        for (const auto& d : L->decorations) {
          u = ink ? u.united(d.rect) : d.rect;
          ink = true;
        }
        if (ink) add(transformedBounds(W * Mat2x3::translate(u.x, u.y), u.w, u.h));
      }
    } else if (!p.isGroupLike()) {
      Shape s = fillShape(doc, id, p);
      if (p.isFrameLike()) add(transformedBounds(W, p.size.x, p.size.y));
      else if (s.kind == Shape::Kind::Rect || s.kind == Shape::Kind::Ellipse) addPath(s.path());
      else if (!s.empty()) addPath(s.path());
      Stroke st = strokeOf(doc, id, p);
      if (st.present()) {
        if (st.primitive != Shape::Kind::Path) {
          double o = st.align == StrokeAlign::CENTER ? st.weight / 2 : st.align == StrokeAlign::OUTSIDE ? st.weight : 0;
          if (st.primitive == Shape::Kind::Ellipse)
            addPath(geom::ellipsePath({p.size.x + 2 * o, p.size.y + 2 * o}, ArcData{}).transformed(Mat2x3::translate(-o, -o)));
          else
            add(transformedBounds(W * Mat2x3::translate(-o, -o), p.size.x + 2 * o, p.size.y + 2 * o));
        } else if (st.ring) {
          addPath(st.center);
        } else if (!(st.aligned && st.align == StrokeAlign::INSIDE)) {
          addPath(strokeOutline(st, 0.25 / std::max(worldScale(W), 1e-9)));
        }
      }
    }
    if (drawsChildren(p)) {
      bool cany = false;
      Rect cr;
      std::vector<Drawn> kids = drawnChildren(doc, id);
      for (size_t i = 0; i < kids.size(); i++) {
        const NodeProps& k = kids[i].node->props;
        if (k.mask) {
          // A mask: what it masks (every sibling above it) shows only within it.
          Rect mb;
          if (!visual(kids[i].id, mb, depth + 1)) break;
          bool many = false;
          Rect m;
          for (size_t j = i + 1; j < kids.size(); j++) {
            Rect b;
            if (!visual(kids[j].id, b, depth + 1)) continue;
            m = many ? m.united(b) : b;
            many = true;
          }
          if (many) {
            m = intersect(m, mb);
            cr = cany ? cr.united(m) : m;
            cany = true;
          }
          break;
        }
        Rect b;
        if (!visual(kids[i].id, b, depth + 1)) continue;
        cr = cany ? cr.united(b) : b;
        cany = true;
      }
      if (cany && p.clipsContent()) cr = intersect(cr, transformedBounds(W, p.size.x, p.size.y));
      if (cany && (cr.w > 0 || cr.h > 0)) add(cr);
    }
    if (!any) return false;
    // Effects: drop shadows (offset, blur, spread) and the layer blur reach past the content.
    double scale = worldScale(W);
    Rect base = r;
    double blur = 0;
    for (const Effect& e : p.effects) {
      if (!e.visible) continue;
      if (e.type == EffectType::DROP_SHADOW) {
        Rect s = grow(base, std::max(0.0, e.radius + e.spread) * scale);
        s.x += e.offset.x * scale;
        s.y += e.offset.y * scale;
        r = r.united(s);
      } else if (e.type == EffectType::FOREGROUND_BLUR) {
        blur = std::max(blur, e.radius);
      }
    }
    if (blur > 0) r = grow(r, blur * scale);
    out = r;
    return true;
  }
};

void walk(const Document& doc, Guid id, const std::function<void(Guid, const Node&)>& f, int depth) {
  const Node* n = doc.get(id);
  if (!n || !n->props.visible || depth > 256) return;
  f(id, *n);
  for (Guid c : doc.children(id)) walk(doc, c, f, depth + 1);
}

void paintsOf(const NodeProps& p, const std::function<void(const Paint&)>& f) {
  for (const Paint& x : p.fillPaints) f(x);
  for (const Paint& x : p.strokePaints) f(x);
  for (const TextStyle& t : p.textData.styleOverrideTable)
    for (const Paint& x : t.fillPaints) f(x);
  for (const VectorStyle& v : p.vectorData.styleOverrideTable)
    for (const Paint& x : v.fillPaints) f(x);
}

}  // namespace

Settings parseSettings(const json::Value& v) {
  Settings s;
  if (!v.isObject()) return s;
  if (auto* t = v.get("imageType")) {
    if (t->isString()) {
      if (t->string == "JPEG" || t->string == "JPG") s.format = Format::JPEG;
      else if (t->string == "SVG") s.format = Format::SVG;
      else if (t->string == "PDF") s.format = Format::PDF;
      else s.format = Format::PNG;
    } else if (t->isNumber()) {
      int k = static_cast<int>(t->number);
      s.format = k == 1 ? Format::JPEG : k == 2 ? Format::SVG : k == 3 ? Format::PDF : Format::PNG;
    }
  }
  if (auto* c = v.get("constraint"); c && c->isObject()) {
    if (auto* t = c->get("type"); t && t->isString()) {
      s.constraint = t->string == "CONTENT_WIDTH" ? Constraint::WIDTH : t->string == "CONTENT_HEIGHT" ? Constraint::HEIGHT : Constraint::SCALE;
    }
    if (auto* x = c->get("value")) s.value = x->numberOr(1);
  }
  if (!(s.value > 0) || !std::isfinite(s.value)) s.value = 1;
  auto flag = [&](const char* key, bool& out) {
    if (auto* x = v.get(key); x && x->isBool()) out = x->boolean;
  };
  flag("contentsOnly", s.contentsOnly);
  flag("useAbsoluteBounds", s.useAbsoluteBounds);
  flag("svgOutlineText", s.svgOutlineText);
  bool force = !s.svgSimplifyStroke;
  flag("svgForceStrokeMasks", force);
  s.svgSimplifyStroke = !force;
  if (auto* x = v.get("svgIDMode"); x && x->isString()) s.svgIds = x->string == "ALWAYS";
  // SVG and PDF are written at 1x (Figma: "SVG and PDF export only at 1x").
  if (s.format == Format::SVG || s.format == Format::PDF) {
    s.constraint = Constraint::SCALE;
    s.value = 1;
  }
  return s;
}

const char* extensionOf(Format f) {
  switch (f) {
    case Format::JPEG: return "jpg";
    case Format::SVG: return "svg";
    case Format::PDF: return "pdf";
    default: return "png";
  }
}

Rect contentBounds(const Document& doc, TextLayouts* texts, Guid id, bool* any) {
  Bounder b{doc, texts};
  Rect r;
  bool ok = b.visual(id, r);
  if (any) *any = ok;
  return ok ? r : Rect{};
}

bool resolveTarget(const Document& doc, TextLayouts* texts, Guid page, Guid node, const Settings& s, Target& out) {
  out = Target{};
  if (node == kNoGuid) {
    // The canvas: everything on the page, on the page colour when it shows in exports.
    const Node* pg = doc.get(page);
    if (!pg || pg->props.type != NodeType::CANVAS) return false;
    bool any = false;
    Rect u;
    for (const Drawn& d : drawnChildren(doc, page)) {
      bool ok = false;
      Rect b = contentBounds(doc, texts, d.id, &ok);
      if (!ok) continue;
      u = any ? u.united(b) : b;
      any = true;
    }
    if (!any || !(u.w > 0) || !(u.h > 0)) return false;
    out.page = page;
    out.region = true;
    out.scope = page;
    out.bounds = u;
    out.background = pg->props.backgroundEnabled;
    out.backgroundColor = pg->props.backgroundColor;
    out.backgroundColor.a = 1;
    return true;
  }
  const Node* n = doc.get(node);
  if (!n) return false;
  out.page = doc.pageOf(node);
  out.node = node;
  if (out.page == kNoGuid) return false;
  const NodeProps& p = n->props;
  Mat2x3 W = doc.worldTransform(node);
  if (p.type == NodeType::SLICE) {
    // A slice: its box, with what shows under it — its frame's content (contents only) or the page's.
    out.region = true;
    out.bounds = transformedBounds(W, p.size.x, p.size.y);
    Guid parent = doc.parentOf(node);
    const Node* pn = doc.get(parent);
    out.scope = s.contentsOnly && pn && pn->props.type != NodeType::CANVAS ? parent : out.page;
    return out.bounds.w > 0 && out.bounds.h > 0;
  }
  if (!p.visible) return false;
  if (s.useAbsoluteBounds) {
    out.bounds = transformedBounds(W, p.size.x, p.size.y);
  } else {
    bool any = false;
    out.bounds = contentBounds(doc, texts, node, &any);
    if (!any) {
      if (!p.isFrameLike()) return false;
      out.bounds = transformedBounds(W, p.size.x, p.size.y);
    }
  }
  if (!s.contentsOnly) {
    out.region = true;
    out.scope = out.page;
  }
  return out.bounds.w > 0 && out.bounds.h > 0;
}

bool resolveTargets(const Document& doc, TextLayouts* texts, const std::vector<Guid>& nodes, const Settings& s, Target& out) {
  if (nodes.size() == 1) return resolveTarget(doc, texts, kNoGuid, nodes[0], s, out);
  std::vector<Guid> order;
  bool any = false;
  Target merged;
  for (Guid id : nodes) {
    Target t;
    if (!resolveTarget(doc, texts, kNoGuid, id, s, t)) continue;
    if (any && t.page != merged.page) continue;  // one page's layers
    merged.bounds = any ? merged.bounds.united(t.bounds) : t.bounds;
    if (!any) merged.page = t.page;
    any = true;
    order.push_back(id);
  }
  if (!any) return false;
  std::stable_sort(order.begin(), order.end(), [&](Guid a, Guid b) { return doc.paintsBefore(a, b); });
  out = Target{};
  out.page = merged.page;
  out.node = order.front();
  out.bounds = merged.bounds;
  if (order.size() > 1) out.nodes = order;
  if (!s.contentsOnly) {
    out.region = true;
    out.scope = out.page;
  }
  return true;
}

Raster rasterOf(const Rect& b, const Settings& s) {
  Raster r;
  double scale = s.value;
  if (s.constraint == Constraint::WIDTH) scale = s.value / std::max(b.w, 1e-9);
  else if (s.constraint == Constraint::HEIGHT) scale = s.value / std::max(b.h, 1e-9);
  if (!(scale > 0) || !std::isfinite(scale)) scale = 1;
  // Too large: scaled down to the largest export there can be.
  double w = b.w * scale, h = b.h * scale;
  double fit = 1;
  if (w > kMaxSide) fit = std::min(fit, kMaxSide / w);
  if (h > kMaxSide) fit = std::min(fit, kMaxSide / h);
  if (w * h * fit * fit > kMaxPixels) fit = std::min(fit, std::sqrt(kMaxPixels / (w * h)));
  scale *= fit;
  r.scale = scale;
  r.origin = {b.x, b.y};
  r.width = std::max(1, static_cast<int>(std::lround(b.w * scale)));
  r.height = std::max(1, static_cast<int>(std::lround(b.h * scale)));
  return r;
}

void forEachDrawnImpl(const Document& doc, const Target& t, const std::function<void(Guid, const Node&)>& f) {
  if (!t.region) {
    if (t.nodes.empty()) walk(doc, t.node, f, 0);
    for (Guid id : t.nodes) walk(doc, id, f, 0);
    return;
  }
  for (Guid c : doc.children(t.scope)) {
    const Node* n = doc.get(c);
    if (!n || !n->props.visible) continue;
    if (!doc.renderBounds(c).intersects(t.bounds)) continue;
    walk(doc, c, f, 0);
  }
  if (t.scope != t.page) {
    // A slice in a frame: the frame itself draws (its fills under its content).
    if (const Node* s = doc.get(t.scope)) f(t.scope, *s);
  }
}

std::vector<ImageHash> imagesOf(const Document& doc, TextLayouts* texts, const Target& t) {
  (void)texts;
  std::vector<ImageHash> out;
  std::unordered_set<std::string> seen;
  forEachDrawn(doc, t, [&](Guid, const Node& n) {
    paintsOf(n.props, [&](const Paint& paint) {
      if (paint.type != PaintType::IMAGE || !paint.image.present || !paint.visible) return;
      if (seen.insert(paint.image.hex()).second) out.push_back(paint.image);
    });
  });
  return out;
}

bool ready(const Document& doc, TextLayouts* texts, const Target& t, double scale) {
  bool ok = true;
  forEachDrawn(doc, t, [&](Guid id, const Node& n) {
    const NodeProps& p = n.props;
    if (p.type == NodeType::TEXT && texts) {
      const text::TextLayout* L = texts->textLayout(id);
      if (L && L->pendingFont) ok = false;
    }
    double devicePx = std::max(p.size.x, p.size.y) * worldScale(doc.worldTransform(id)) * scale;
    paintsOf(p, [&](const Paint& paint) {
      if (paint.type != PaintType::IMAGE || !paint.image.present || !paint.visible) return;
      ImageHints hints = imageHints(paint);
      const ImageRegistry::Source* src = ImageRegistry::get().find(paint.image, devicePx, &hints);
      if (!src) {
        ok = false;
        return;
      }
      if (src->failed) return;
      // A low-res tier where the original is larger and drawn larger: the original was asked for.
      double have = std::max(src->width, src->height);
      double original = std::max(hints.originalWidth, hints.originalHeight);
      if (original > 0 && have + 1 < original && have + 1 < devicePx) ok = false;
    });
  });
  return ok;
}

ImageStore& ImageStore::get() {
  static ImageStore* store = new ImageStore();
  return *store;
}

void ImageStore::put(const ImageHash& hash, uint32_t kind, uint32_t width, uint32_t height, std::string data, std::string alpha) {
  ImageData& d = images_[hash];
  if (width) d.width = width;
  if (height) d.height = height;
  switch (kind) {
    case ENCODED:
      d.mime = sniffMime(data);
      d.encoded = std::move(data);
      break;
    case JPEG:
      d.jpeg = std::move(data);
      d.rgb.clear();
      d.alpha = std::move(alpha);
      break;
    case RGB:
      d.rgb = std::move(data);
      d.jpeg.clear();
      d.alpha = std::move(alpha);
      break;
    default: break;
  }
}

const ImageData* ImageStore::find(const ImageHash& hash) const {
  auto it = images_.find(hash);
  return it == images_.end() ? nullptr : &it->second;
}

std::string sniffMime(std::string_view b) {
  auto starts = [&](std::string_view sig, size_t at = 0) { return b.size() >= at + sig.size() && b.substr(at, sig.size()) == sig; };
  if (starts("\x89PNG")) return "image/png";
  if (starts("\xff\xd8\xff")) return "image/jpeg";
  if (starts("GIF8")) return "image/gif";
  if (starts("RIFF") && starts("WEBP", 8)) return "image/webp";
  return "";
}

}  // namespace eng::exporter
