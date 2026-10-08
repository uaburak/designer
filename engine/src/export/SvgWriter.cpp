#include "export/SvgWriter.h"

#include <cmath>
#include <cstdio>
#include <unordered_map>
#include <unordered_set>

#include "export/Scene.h"
#include "geometry/Shapes.h"
#include "text/Fonts.h"
#include "text/Unicode.h"

namespace eng::exporter {

namespace {

std::string escape(std::string_view s) {
  std::string out;
  out.reserve(s.size());
  for (char c : s) {
    switch (c) {
      case '&': out += "&amp;"; break;
      case '<': out += "&lt;"; break;
      case '>': out += "&gt;"; break;
      case '"': out += "&quot;"; break;
      default: out += c;
    }
  }
  return out;
}

int byte(float v) { return std::clamp(static_cast<int>(std::lround(v * 255.0)), 0, 255); }

// Figma's colours: black and white by name, the rest as upper-case hex.
std::string colorText(const Color& c) {
  int r = byte(c.r), g = byte(c.g), b = byte(c.b);
  if (r == 0 && g == 0 && b == 0) return "black";
  if (r == 255 && g == 255 && b == 255) return "white";
  char buf[8];
  std::snprintf(buf, sizeof buf, "#%02X%02X%02X", r, g, b);
  return buf;
}

std::string rgba(const Color& c, double alpha) {
  return "rgba(" + std::to_string(byte(c.r)) + "," + std::to_string(byte(c.g)) + "," + std::to_string(byte(c.b)) + "," +
         num(c.a * alpha, 3) + ")";
}

const char* blendCss(BlendMode m) {
  switch (m) {
    case BlendMode::DARKEN: return "darken";
    case BlendMode::MULTIPLY: return "multiply";
    case BlendMode::LINEAR_BURN: return "plus-darker";
    case BlendMode::COLOR_BURN: return "color-burn";
    case BlendMode::LIGHTEN: return "lighten";
    case BlendMode::SCREEN: return "screen";
    case BlendMode::LINEAR_DODGE: return "plus-lighter";
    case BlendMode::COLOR_DODGE: return "color-dodge";
    case BlendMode::OVERLAY: return "overlay";
    case BlendMode::SOFT_LIGHT: return "soft-light";
    case BlendMode::HARD_LIGHT: return "hard-light";
    case BlendMode::DIFFERENCE: return "difference";
    case BlendMode::EXCLUSION: return "exclusion";
    case BlendMode::HUE: return "hue";
    case BlendMode::SATURATION: return "saturation";
    case BlendMode::COLOR: return "color";
    case BlendMode::LUMINOSITY: return "luminosity";
    default: return nullptr;
  }
}

std::string matrixText(const Mat2x3& m) {
  return "matrix(" + num(m.m00, 6) + " " + num(m.m10, 6) + " " + num(m.m01, 6) + " " + num(m.m11, 6) + " " + num(m.m02, 4) + " " +
         num(m.m12, 4) + ")";
}

bool axisAligned(const Mat2x3& m) { return std::fabs(m.m01) < 1e-9 && std::fabs(m.m10) < 1e-9 && m.m00 > 0 && m.m11 > 0; }
bool translationOnly(const Mat2x3& m) { return axisAligned(m) && std::fabs(m.m00 - 1) < 1e-9 && std::fabs(m.m11 - 1) < 1e-9; }
double scaleOf(const Mat2x3& m) { return std::sqrt(std::fabs(m.determinant())); }

// Path data in Figma's style: absolute commands, H / V for axis lines, numbers separated by spaces.
std::string pathData(const geom::Path& path, const Mat2x3& m) {
  std::string d;
  size_t pi = 0;
  std::string cx, cy, sx, sy;  // the current and the contour's start point, formatted
  auto add = [&](char cmd, std::initializer_list<Vec2> pts) {
    d += cmd;
    bool first = true;
    for (Vec2 p : pts) {
      if (!first) d += ' ';
      d += num(p.x) + " " + num(p.y);
      first = false;
    }
  };
  for (geom::Verb v : path.verbs) {
    switch (v) {
      case geom::Verb::Move: {
        Vec2 p = m.apply(path.points[pi++]);
        add('M', {p});
        cx = sx = num(p.x), cy = sy = num(p.y);
        break;
      }
      case geom::Verb::Line: {
        Vec2 p = m.apply(path.points[pi++]);
        std::string x = num(p.x), y = num(p.y);
        if (y == cy && x != cx) d += "H" + x;
        else if (x == cx && y != cy) d += "V" + y;
        else if (x != cx || y != cy) d += "L" + x + " " + y;
        cx = x, cy = y;
        break;
      }
      case geom::Verb::Quad: {
        Vec2 c = m.apply(path.points[pi]), p = m.apply(path.points[pi + 1]);
        pi += 2;
        add('Q', {c, p});
        cx = num(p.x), cy = num(p.y);
        break;
      }
      case geom::Verb::Cubic: {
        Vec2 c1 = m.apply(path.points[pi]), c2 = m.apply(path.points[pi + 1]), p = m.apply(path.points[pi + 2]);
        pi += 3;
        add('C', {c1, c2, p});
        cx = num(p.x), cy = num(p.y);
        break;
      }
      case geom::Verb::Close:
        d += 'Z';
        cx = sx, cy = sy;
        break;
    }
  }
  return d;
}

class Writer {
 public:
  Writer(const Document& doc, TextLayouts* texts, const Target& t, const Settings& s) : doc_(doc), texts_(texts), t_(t), s_(s) {
    origin_ = Mat2x3::translate(-t.bounds.x, -t.bounds.y);
    Guid g = t.node != kNoGuid ? t.node : t.page;
    std::string id = g.toString();
    for (char& c : id)
      if (c == ':' || c == ';') c = '_';
    suffix_ = "_" + id;
  }

  std::string run() {
    std::vector<std::string> body;
    if (t_.background) {
      body.push_back("<rect width=\"" + num(t_.bounds.w) + "\" height=\"" + num(t_.bounds.h) + "\" fill=\"" + colorText(t_.backgroundColor) +
                     "\"/>\n");
    }
    if (!t_.region) {
      if (t_.nodes.empty()) append(body, nodeEls(t_.node));
      for (Guid id : t_.nodes) append(body, nodeEls(id));
    } else if (t_.scope != t_.page) {
      append(body, nodeEls(t_.scope));
    } else {
      std::vector<Drawn> roots;
      for (const Drawn& d : drawnChildren(doc_, t_.page))
        if (doc_.renderBounds(d.id).intersects(t_.bounds)) roots.push_back(d);
      append(body, siblingsEls(roots, 0));
    }
    std::string w = num(t_.bounds.w), h = num(t_.bounds.h);
    std::string out = "<svg width=\"" + w + "\" height=\"" + h + "\" viewBox=\"0 0 " + w + " " + h +
                      "\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\"";
    if (xlink_) out += " xmlns:xlink=\"http://www.w3.org/1999/xlink\"";
    out += ">\n";
    for (auto& e : body) out += e;
    if (!defs_.empty()) out += "<defs>\n" + defs_ + "</defs>\n";
    out += "</svg>\n";
    return out;
  }

 private:
  using Els = std::vector<std::string>;
  static void append(Els& to, Els from) {
    for (auto& e : from) to.push_back(std::move(e));
  }
  static std::string join(const Els& els) {
    std::string s;
    for (auto& e : els) s += e;
    return s;
  }
  // A single element's start tag with the layer's id first (as Figma writes it) and `attrs` last.
  static std::string inject(const std::string& el, const std::string& id, const std::string& attrs) {
    size_t gt = el.find('>');
    if (gt == std::string::npos) return el;
    size_t at = gt > 0 && el[gt - 1] == '/' ? gt - 1 : gt;
    std::string out = el.substr(0, at) + attrs + el.substr(at);
    if (!id.empty()) {
      size_t name = out.find_first_of(" />");
      if (name != std::string::npos) out.insert(name, id);
    }
    return out;
  }

  std::string idAttr(const std::string& name) {
    if (!s_.svgIds) return "";
    std::string base = name.empty() ? "Layer" : name;
    int& n = ids_[base];
    n++;
    return " id=\"" + escape(n == 1 ? base : base + "_" + std::to_string(n)) + "\"";
  }

  double tolerance(const Mat2x3& E) const { return 0.05 / std::max(scaleOf(E), 1e-9); }

  // ---- Geometry ----

  // A shape as an element with `attrs` (fill / stroke …) after its geometry.
  std::string shapeEl(const Shape& sh, const Mat2x3& E, const std::string& attrs) {
    if (sh.kind == Shape::Kind::Rect) {
      const CornerRadii& r = sh.radii;
      bool uniform = r[0] == r[1] && r[1] == r[2] && r[2] == r[3];
      if (uniform && axisAligned(E) && (r[0] == 0 || std::fabs(E.m00 - E.m11) < 1e-9)) {
        std::string el = "<rect";
        if (num(E.m02) != "0") el += " x=\"" + num(E.m02) + "\"";
        if (num(E.m12) != "0") el += " y=\"" + num(E.m12) + "\"";
        el += " width=\"" + num(sh.size.x * E.m00) + "\" height=\"" + num(sh.size.y * E.m11) + "\"";
        if (r[0] > 0) el += " rx=\"" + num(r[0] * E.m00) + "\"";
        return el + attrs + "/>\n";
      }
      if (uniform) {
        std::string el = "<rect width=\"" + num(sh.size.x) + "\" height=\"" + num(sh.size.y) + "\"";
        if (r[0] > 0) el += " rx=\"" + num(r[0]) + "\"";
        return el + " transform=\"" + matrixText(E) + "\"" + attrs + "/>\n";
      }
    } else if (sh.kind == Shape::Kind::Ellipse) {
      if (axisAligned(E)) {
        Vec2 c = E.apply({sh.size.x / 2, sh.size.y / 2});
        double rx = sh.size.x / 2 * E.m00, ry = sh.size.y / 2 * E.m11;
        if (num(rx) == num(ry)) return "<circle cx=\"" + num(c.x) + "\" cy=\"" + num(c.y) + "\" r=\"" + num(rx) + "\"" + attrs + "/>\n";
        return "<ellipse cx=\"" + num(c.x) + "\" cy=\"" + num(c.y) + "\" rx=\"" + num(rx) + "\" ry=\"" + num(ry) + "\"" + attrs + "/>\n";
      }
      return "<ellipse cx=\"" + num(sh.size.x / 2) + "\" cy=\"" + num(sh.size.y / 2) + "\" rx=\"" + num(sh.size.x / 2) + "\" ry=\"" +
             num(sh.size.y / 2) + "\" transform=\"" + matrixText(E) + "\"" + attrs + "/>\n";
    }
    geom::Path path = sh.path();
    if (path.empty()) return "";
    std::string el = "<path";
    if (sh.evenOdd()) el += " fill-rule=\"evenodd\" clip-rule=\"evenodd\"";
    return el + " d=\"" + pathData(path, E) + "\"" + attrs + "/>\n";
  }

  std::string pathEl(const geom::Path& path, const Mat2x3& E, bool evenOdd, const std::string& attrs) {
    if (path.empty()) return "";
    std::string el = "<path";
    if (evenOdd) el += " fill-rule=\"evenodd\" clip-rule=\"evenodd\"";
    return el + " d=\"" + pathData(path, E) + "\"" + attrs + "/>\n";
  }

  // ---- Paints ----

  std::string stops(const Paint& paint) {
    std::string s;
    for (const ColorStop& st : paint.stops) {
      s += "<stop";
      if (st.position != 0) s += " offset=\"" + num(st.position) + "\"";
      s += " stop-color=\"" + colorText(st.color) + "\"";
      if (st.color.a < 1) s += " stop-opacity=\"" + num(st.color.a) + "\"";
      s += "/>\n";
    }
    return s;
  }

  // `prop`="…" (+ `prop`-opacity) for a solid, linear / radial gradient or image paint; "" when it can't be one.
  std::string paintAttr(const char* prop, const Paint& paint, Vec2 size, const Mat2x3& E) {
    std::string out;
    double opacity = paint.opacity;
    if (paint.type == PaintType::SOLID) {
      out = std::string(" ") + prop + "=\"" + colorText(paint.color) + "\"";
      opacity *= paint.color.a;
    } else if (paint.type == PaintType::GRADIENT_LINEAR || paint.type == PaintType::GRADIENT_RADIAL) {
      if (paint.stops.empty()) return "";
      Mat2x3 G = gradientMatrix(paint, size);
      if (G.determinant() == 0) return "";
      Mat2x3 A = E * G.inverse();
      bool linear = paint.type == PaintType::GRADIENT_LINEAR;
      std::string id = "paint" + std::to_string(paintN_++) + (linear ? "_linear" : "_radial") + suffix_;
      if (linear) {
        Vec2 p1 = A.apply({0, 0.5}), p2 = A.apply({1, 0.5});
        Vec2 dir = p2 - p1, iso = A.applyLinear({0, 1});
        double dot = dir.x * iso.x + dir.y * iso.y;
        defs_ += "<linearGradient id=\"" + id + "\"";
        if (std::fabs(dot) <= 1e-6 * std::max(dir.length() * iso.length(), 1e-12)) {
          defs_ += " x1=\"" + num(p1.x) + "\" y1=\"" + num(p1.y) + "\" x2=\"" + num(p2.x) + "\" y2=\"" + num(p2.y) + "\" gradientUnits=\"userSpaceOnUse\"";
        } else {
          defs_ += " x1=\"0\" y1=\"0.5\" x2=\"1\" y2=\"0.5\" gradientUnits=\"userSpaceOnUse\" gradientTransform=\"" + matrixText(A) + "\"";
        }
        defs_ += ">\n" + stops(paint) + "</linearGradient>\n";
      } else {
        Mat2x3 R = A * Mat2x3::translate(0.5, 0.5) * Mat2x3::scale(0.5);
        defs_ += "<radialGradient id=\"" + id + "\" cx=\"0\" cy=\"0\" r=\"1\" gradientUnits=\"userSpaceOnUse\" gradientTransform=\"" + matrixText(R) +
                 "\">\n" + stops(paint) + "</radialGradient>\n";
      }
      out = std::string(" ") + prop + "=\"url(#" + id + ")\"";
    } else if (paint.type == PaintType::IMAGE) {
      const ImageData* data = paint.image.present ? ImageStore::get().find(paint.image) : nullptr;
      if (!data || data->encoded.empty()) {
        // Not handed in: Figma's grey for an image that hasn't loaded.
        out = std::string(" ") + prop + "=\"#E6E6E6\"";
      } else {
        double iw = 0, ih = 0;
        imageSize(paint, data->width, data->height, iw, ih);
        Mat2x3 I = imageMatrix(paint, size, iw, ih);
        if (I.determinant() == 0) return "";
        Mat2x3 B = E * I.inverse();
        std::string n = std::to_string(patternN_++);
        std::string pid = "pattern" + n + suffix_;
        std::string iid = imageId(paint.image, *data);
        bool tile = paint.imageScaleMode == ImageScaleMode::TILE;
        // The pattern's cell: the image's uv square (TILE); otherwise the layer's box in uv space with the image in it,
        // so the image shows once (Fit leaves the rest empty) and the cell stays the layer's size when rasterized.
        Rect cell{0, 0, 1, 1};
        if (!tile) {
          cell = cell.united(transformedBounds(I, size.x, size.y));
          cell = {cell.x - 0.01, cell.y - 0.01, cell.w + 0.02, cell.h + 0.02};
        }
        std::string at = tile ? "" : " x=\"" + num(cell.x, 6) + "\" y=\"" + num(cell.y, 6) + "\"";
        defs_ += "<pattern id=\"" + pid + "\" patternUnits=\"userSpaceOnUse\"" + at + " width=\"" + num(cell.w, 6) + "\" height=\"" + num(cell.h, 6) +
                 "\" patternTransform=\"" + matrixText(B) + "\">\n<use xlink:href=\"#" + iid + "\"/>\n</pattern>\n";
        out = std::string(" ") + prop + "=\"url(#" + pid + ")\"";
      }
    } else {
      return "";
    }
    if (opacity < 1) out += std::string(" ") + prop + "-opacity=\"" + num(opacity) + "\"";
    return out;
  }

  std::string imageId(const ImageHash& hash, const ImageData& data) {
    std::string key = hash.hex();
    auto it = images_.find(key);
    if (it != images_.end()) return it->second;
    std::string id = "image" + std::to_string(images_.size()) + suffix_;
    images_[key] = id;
    xlink_ = true;
    imageDefs_ += "<image id=\"" + id + "\" width=\"1\" height=\"1\" preserveAspectRatio=\"none\" xlink:href=\"data:" + data.mime + ";base64," +
                  base64(data.encoded) + "\"/>\n";
    return id;
  }

  static std::string blendAttr(BlendMode m) {
    const char* css = blendCss(m);
    return css ? std::string(" style=\"mix-blend-mode:") + css + "\"" : "";
  }

  // Angular and diamond gradients: CSS gradients in a foreignObject, clipped to the shape (as Figma writes them).
  std::string cssGradientEl(const Paint& paint, Vec2 size, const Mat2x3& E, const std::string& clipGeometry) {
    if (paint.stops.empty()) return "";
    Mat2x3 G = gradientMatrix(paint, size);
    if (G.determinant() == 0) return "";
    Mat2x3 A = E * G.inverse() * Mat2x3::scale(0.01);
    bool angular = paint.type == PaintType::GRADIENT_ANGULAR;
    std::string id = "paint" + std::to_string(paintN_++) + (angular ? "_angular" : "_diamond") + suffix_ + "_clip_path";
    defs_ += "<clipPath id=\"" + id + "\">\n" + clipGeometry + "</clipPath>\n";
    std::string style;
    if (angular) {
      style = "background:conic-gradient(from 90deg at 50% 50%";
      for (const ColorStop& s : paint.stops) style += "," + rgba(s.color, 1) + " " + num(s.position * 360, 2) + "deg";
      style += ");height:100%;width:100%";
    } else {
      std::string st;
      for (const ColorStop& s : paint.stops) st += "," + rgba(s.color, 1) + " " + num(s.position * 50, 2) + "%";
      const ColorStop& last = paint.stops.back();
      style = "background:" + rgba(last.color, 1) + ";height:100%;width:100%;position:relative";
      std::string q = "position:absolute;left:100px;top:100px;width:100px;height:100px;background:";
      q += "linear-gradient(to bottom right" + st + ") 50px 50px/50px 50px no-repeat,";
      q += "linear-gradient(to bottom left" + st + ") 0 50px/50px 50px no-repeat,";
      q += "linear-gradient(to top right" + st + ") 50px 0/50px 50px no-repeat,";
      q += "linear-gradient(to top left" + st + ") 0 0/50px 50px no-repeat";
      style += "\"><div style=\"" + q;
    }
    if (paint.opacity < 1) style += ";opacity:" + num(paint.opacity);
    std::string inner = "<div xmlns=\"http://www.w3.org/1999/xhtml\" style=\"" + style + "\"></div>";
    if (!angular) inner += "</div>";
    return "<g clip-path=\"url(#" + id + ")\"" + blendAttr(paint.blendMode) + "><g transform=\"" + matrixText(A) +
           "\"><foreignObject x=\"-100\" y=\"-100\" width=\"300\" height=\"300\">" + inner + "</foreignObject></g></g>\n";
  }

  // One element per visible fill, bottom first.
  void fillEls(const Shape& sh, const std::vector<Paint>& paints, Vec2 size, const Mat2x3& E, Els& out, const std::string& extra = "") {
    if (sh.empty()) return;
    for (const Paint& paint : paints) {
      if (!drawable(paint)) continue;
      if (paint.type == PaintType::GRADIENT_ANGULAR || paint.type == PaintType::GRADIENT_DIAMOND) {
        out.push_back(cssGradientEl(paint, size, E, shapeEl(sh, E, "")));
        continue;
      }
      std::string a = paintAttr("fill", paint, size, E);
      if (a.empty()) continue;
      out.push_back(shapeEl(sh, E, a + extra + blendAttr(paint.blendMode)));
    }
  }

  // A layer's fills: per region when a vector's regions have their own fills or rules.
  void nodeFills(const Shape& sh, const NodeProps& p, const Mat2x3& E, Els& out) {
    if (sh.kind != Shape::Kind::Path || sh.regions.size() <= 1) {
      bool overrides = sh.kind == Shape::Kind::Path && sh.regions.size() == 1 && sh.regions[0].styleID &&
                       p.vectorData.style(sh.regions[0].styleID) && (p.vectorData.style(sh.regions[0].styleID)->mask & VS_FILLS);
      fillEls(sh, overrides ? p.vectorData.style(sh.regions[0].styleID)->fillPaints : p.fillPaints, p.size, E, out);
      return;
    }
    bool same = true;
    for (auto& r : sh.regions) {
      const VectorStyle* st = r.styleID ? p.vectorData.style(r.styleID) : nullptr;
      if ((st && (st->mask & VS_FILLS)) || r.windingRule != sh.regions[0].windingRule) same = false;
    }
    if (same) {
      Shape one = sh;
      one.regions.clear();
      geom::FillRegion all;
      all.windingRule = sh.regions[0].windingRule;
      for (auto& r : sh.regions) all.path.append(r.path);
      one.regions.push_back(std::move(all));
      fillEls(one, p.fillPaints, p.size, E, out);
      return;
    }
    for (auto& r : sh.regions) {
      Shape one;
      one.kind = Shape::Kind::Path;
      one.size = sh.size;
      one.regions.push_back(r);
      const VectorStyle* st = r.styleID ? p.vectorData.style(r.styleID) : nullptr;
      fillEls(one, st && (st->mask & VS_FILLS) ? st->fillPaints : p.fillPaints, p.size, E, out);
    }
  }

  std::string strokeStyleAttrs(const Stroke& st, double weight, bool caps) {
    std::string a;
    if (weight != 1) a += " stroke-width=\"" + num(weight) + "\"";
    if (caps) {
      if (st.cap == StrokeCap::ROUND) a += " stroke-linecap=\"round\"";
      else if (st.cap == StrokeCap::SQUARE) a += " stroke-linecap=\"square\"";
    }
    if (st.join == StrokeJoin::ROUND) a += " stroke-linejoin=\"round\"";
    else if (st.join == StrokeJoin::BEVEL) a += " stroke-linejoin=\"bevel\"";
    else if (st.miterLimit != 4) a += " stroke-miterlimit=\"" + num(st.miterLimit) + "\"";
    if (!st.dashes.empty()) {
      a += " stroke-dasharray=\"";
      for (size_t i = 0; i < st.dashes.size(); i++) a += (i ? " " : "") + num(st.dashes[i]);
      a += "\"";
    }
    return a;
  }

  Shape centerShape(const Stroke& st) const {
    Shape c;
    c.size = st.size;
    if (st.primitive == Shape::Kind::Rect) {
      c.kind = Shape::Kind::Rect;
      c.radii = st.radii;
    } else if (st.primitive == Shape::Kind::Ellipse) {
      c.kind = Shape::Kind::Ellipse;
    }
    return c;
  }

  // The stroke's elements, per paint (Figma's simplified forms; see the header).
  void strokeEls(const Stroke& st, const Shape& fill, Vec2 size, const Mat2x3& E, Els& out) {
    if (!st.present()) return;
    double scale = scaleOf(E);
    for (const Paint* paint : st.paints) {
      bool css = paint->type == PaintType::GRADIENT_ANGULAR || paint->type == PaintType::GRADIENT_DIAMOND;
      auto area = [&]() {
        geom::Path a = strokeArea(st, fill, tolerance(E));
        Shape sh;
        sh.kind = Shape::Kind::Path;
        sh.size = size;
        sh.regions.push_back({std::move(a), WindingRule::NONZERO, 0});
        std::vector<Paint> one{*paint};
        fillEls(sh, one, size, E, out);
      };
      if (st.outlineOnly || css) {
        area();
        continue;
      }
      std::string paintA = paintAttr("stroke", *paint, size, E) + blendAttr(paint->blendMode);
      if (!st.aligned) {
        std::string attrs = paintA + strokeStyleAttrs(st, st.weight * scale, true);
        if (st.primitive != Shape::Kind::Path) out.push_back(shapeEl(centerShape(st), E, attrs));
        else out.push_back(pathEl(st.center, E, false, attrs));
        continue;
      }
      if (s_.svgSimplifyStroke) {
        if (st.primitive != Shape::Kind::Path) {
          // Inset (INSIDE) or outset (OUTSIDE) by half the weight: a centre stroke on the same spot.
          double o = (st.align == StrokeAlign::INSIDE ? -0.5 : 0.5) * st.weight;
          Shape c = centerShape(st);
          c.size = {st.size.x + 2 * o, st.size.y + 2 * o};
          if (c.size.x <= 0 || c.size.y <= 0) {
            area();
            continue;
          }
          for (auto& r : c.radii) r = r > 0 ? std::max(0.0, r + o) : 0;
          out.push_back(shapeEl(c, E * Mat2x3::translate(-o, -o), paintA + strokeStyleAttrs(st, st.weight * scale, true)));
        } else {
          area();
        }
        continue;
      }
      // Simplify off: twice the weight, masked to the fill's inside (INSIDE) or outside (OUTSIDE).
      int n = ++strokeMaskN_;
      bool inside = st.align == StrokeAlign::INSIDE;
      std::string id = "path-" + std::to_string(n) + (inside ? "-inside-" : "-outside-") + std::to_string(n) + suffix_;
      Shape geometry = st.primitive != Shape::Kind::Path ? centerShape(st) : fill;
      if (geometry.empty()) {
        area();
        continue;
      }
      std::string fillGeom = shapeEl(geometry, E, "");
      if (inside) {
        out.push_back("<mask id=\"" + id + "\" fill=\"white\">\n" + fillGeom + "</mask>\n");
      } else {
        Rect b = geometry.path().transformed(E).bounds();
        double g = 2 * st.weight * scale + 1;
        b = {std::floor(b.x - g), std::floor(b.y - g), std::ceil(b.w + 2 * g) + 1, std::ceil(b.h + 2 * g) + 1};
        std::string box = " x=\"" + num(b.x) + "\" y=\"" + num(b.y) + "\" width=\"" + num(b.w) + "\" height=\"" + num(b.h) + "\"";
        out.push_back("<mask id=\"" + id + "\" maskUnits=\"userSpaceOnUse\"" + box + " fill=\"black\">\n<rect fill=\"white\"" + box + "/>\n" +
                      fillGeom + "</mask>\n");
      }
      std::string attrs = paintA + strokeStyleAttrs(st, 2 * st.weight * scale, true) + " mask=\"url(#" + id + ")\"";
      if (st.primitive != Shape::Kind::Path) out.push_back(shapeEl(geometry, E, attrs));
      else out.push_back(pathEl(st.center, E, false, attrs));
    }
  }

  // ---- Text ----

  void textEls(Guid id, const NodeProps& p, const Mat2x3& E, Els& out) {
    const text::TextLayout* L = texts_ ? texts_->textLayout(id) : nullptr;
    if (!L) return;
    if (s_.svgOutlineText) {
      for (const GlyphFill& g : glyphFills(*L)) {
        Shape sh;
        sh.kind = Shape::Kind::Path;
        sh.size = p.size;
        sh.regions.push_back({g.path, WindingRule::NONZERO, 0});
        std::vector<Paint> one{*g.paint};
        fillEls(sh, one, p.size, E, out);
      }
      return;
    }
    // <text> per run of one style, lines of the same style and fill in one element (one <tspan> per line).
    bool plain = translationOnly(E);
    std::string lastAttrs, tspans;
    auto flush = [&]() {
      if (!tspans.empty()) out.push_back("<text" + lastAttrs + ">" + tspans + "</text>\n");
      tspans.clear();
    };
    std::u16string_view text16(L->text);
    for (const text::LaidLine& line : L->lines) {
      uint32_t g0 = line.firstGlyph, g1 = line.firstGlyph + line.glyphCount;
      for (uint32_t i = g0; i < g1;) {
        uint32_t j = i;
        while (j < g1 && L->glyphs[j].style == L->glyphs[i].style) j++;
        const text::LaidGlyph& first = L->glyphs[i];
        uint32_t from = first.cluster, to = j < g1 ? L->glyphs[j].cluster : line.end;
        if (to > text16.size()) to = static_cast<uint32_t>(text16.size());
        if (from > to) std::swap(from, to);
        std::u16string chars(text16.substr(from, to - from));
        while (!chars.empty() && (chars.back() == u'\n' || chars.back() == u' ' || chars.back() == u'\r')) chars.pop_back();
        const text::ResolvedStyle& rs = L->styles[first.style];
        chars = text::applyCase(chars, rs.textCase);
        std::string utf8 = escape(text::utf16To8(chars));
        if (!utf8.empty() && rs.fills) {
          for (const Paint& paint : *rs.fills) {
            if (!drawable(paint)) continue;
            std::string fill = paintAttr("fill", paint, p.size, E);
            if (fill.empty()) continue;
            std::string attrs = fill + " xml:space=\"preserve\" style=\"white-space: pre\" font-family=\"" + escape(rs.fontName.family) +
                                "\" font-size=\"" + num(rs.fontSize) + "\"";
            int weight = 400;
            bool italic = false;
            text::styleWeight(rs.fontName.style, weight, italic);
            if (weight != 400) attrs += " font-weight=\"" + std::to_string(weight) + "\"";
            if (italic) attrs += " font-style=\"italic\"";
            if (rs.letterSpacing.units == NumberUnits::PIXELS) attrs += " letter-spacing=\"" + num(rs.letterSpacing.value) + "px\"";
            else attrs += " letter-spacing=\"" + num(rs.letterSpacing.value / 100) + "em\"";
            if (rs.textDecoration == TextDecoration::UNDERLINE) attrs += " text-decoration=\"underline\"";
            else if (rs.textDecoration == TextDecoration::STRIKETHROUGH) attrs += " text-decoration=\"line-through\"";
            Vec2 at{first.x, line.baseline};
            if (plain) at = E.apply(at);
            else attrs += " transform=\"" + matrixText(E) + "\"";
            if (attrs != lastAttrs) {
              flush();
              lastAttrs = attrs;
            }
            tspans += "<tspan x=\"" + num(at.x) + "\" y=\"" + num(at.y) + "\">" + utf8 + "</tspan>";
          }
        }
        i = j;
      }
    }
    flush();
  }

  // ---- Effects ----

  // The filter for a layer's shadows and layer blur ("" when it has none).
  std::string filterFor(Guid node, const NodeProps& p, const Mat2x3& E) {
    std::string letters;
    std::vector<const Effect*> drops, inners;
    double blur = 0;
    for (const Effect& e : p.effects) {
      if (!e.visible) continue;
      if (e.type == EffectType::DROP_SHADOW) drops.push_back(&e), letters += "d";
      else if (e.type == EffectType::INNER_SHADOW) inners.push_back(&e), letters += "i";
      else if (e.type == EffectType::FOREGROUND_BLUR && e.radius > 0) blur = std::max(blur, e.radius);
    }
    if (blur > 0) letters += "f";
    if (letters.empty()) return "";
    std::string id = "filter" + std::to_string(filterN_++) + "_" + letters + suffix_;
    double scale = scaleOf(E);
    Rect r = contentBounds(doc_, texts_, node);
    r = {r.x - t_.bounds.x, r.y - t_.bounds.y, r.w, r.h};
    std::string out = "<filter id=\"" + id + "\" x=\"" + num(r.x) + "\" y=\"" + num(r.y) + "\" width=\"" + num(r.w) + "\" height=\"" + num(r.h) +
                      "\" filterUnits=\"userSpaceOnUse\" color-interpolation-filters=\"sRGB\">\n";
    out += "<feFlood flood-opacity=\"0\" result=\"BackgroundImageFix\"/>\n";
    std::string hardAlpha = "<feColorMatrix in=\"SourceAlpha\" type=\"matrix\" values=\"0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0\" result=\"hardAlpha\"/>\n";
    auto color = [&](const Color& c) {
      return "<feColorMatrix type=\"matrix\" values=\"0 0 0 0 " + num(c.r, 4) + " 0 0 0 0 " + num(c.g, 4) + " 0 0 0 0 " + num(c.b, 4) + " 0 0 0 " +
             num(c.a, 4) + " 0\"/>\n";
    };
    auto offsetBlur = [&](const Effect& e) {
      std::string s;
      if (e.offset.x != 0 || e.offset.y != 0) {
        s += "<feOffset";
        if (e.offset.x != 0) s += " dx=\"" + num(e.offset.x * scale) + "\"";
        if (e.offset.y != 0) s += " dy=\"" + num(e.offset.y * scale) + "\"";
        s += "/>\n";
      }
      if (e.radius > 0) s += "<feGaussianBlur stdDeviation=\"" + num(e.radius / 2 * scale) + "\"/>\n";
      return s;
    };
    auto mode = [](BlendMode m) {
      const char* c = blendCss(m);
      return std::string(c ? c : "normal");
    };
    std::string prev = "BackgroundImageFix";
    int k = 1;
    for (const Effect* e : drops) {
      std::string result = "effect" + std::to_string(k) + "_dropShadow" + suffix_;
      out += hardAlpha;
      if (e->spread != 0)
        out += "<feMorphology radius=\"" + num(std::fabs(e->spread) * scale) + "\" operator=\"" + (e->spread > 0 ? "dilate" : "erode") +
               "\" in=\"SourceAlpha\" result=\"" + result + "\"/>\n";
      out += offsetBlur(*e);
      if (!e->showShadowBehindNode) out += "<feComposite in2=\"hardAlpha\" operator=\"out\"/>\n";
      out += color(e->color);
      out += "<feBlend mode=\"" + mode(e->blendMode) + "\" in2=\"" + prev + "\" result=\"" + result + "\"/>\n";
      prev = result;
      k++;
    }
    out += "<feBlend mode=\"normal\" in=\"SourceGraphic\" in2=\"" + prev + "\" result=\"shape\"/>\n";
    prev = "shape";
    for (const Effect* e : inners) {
      std::string result = "effect" + std::to_string(k) + "_innerShadow" + suffix_;
      out += hardAlpha;
      if (e->spread != 0)
        out += "<feMorphology radius=\"" + num(std::fabs(e->spread) * scale) + "\" operator=\"erode\" in=\"SourceAlpha\" result=\"" + result + "\"/>\n";
      out += offsetBlur(*e);
      out += "<feComposite in2=\"hardAlpha\" operator=\"arithmetic\" k2=\"-1\" k3=\"1\"/>\n";
      out += color(e->color);
      out += "<feBlend mode=\"" + mode(e->blendMode) + "\" in2=\"" + prev + "\" result=\"" + result + "\"/>\n";
      prev = result;
      k++;
    }
    if (blur > 0)
      out += "<feGaussianBlur stdDeviation=\"" + num(blur / 2 * scale) + "\" result=\"effect" + std::to_string(k) + "_foregroundBlur" + suffix_ + "\"/>\n";
    out += "</filter>\n";
    defs_ += out;
    return id;
  }

  // Background blur: the backdrop blurred within the layer's shape (a CSS backdrop-filter, as Figma writes it).
  void backgroundBlur(const NodeProps& p, const Shape& sh, const Mat2x3& E, Els& out) {
    for (const Effect& e : p.effects) {
      if (!e.visible || e.type != EffectType::BACKGROUND_BLUR || e.radius <= 0 || sh.empty()) continue;
      geom::Path path = sh.path().transformed(E);
      Rect b = path.bounds();
      std::string id = "bgblur_" + std::to_string(bgBlurN_++) + suffix_ + "_clip_path";
      defs_ += "<clipPath id=\"" + id + "\" transform=\"translate(" + num(-b.x) + " " + num(-b.y) + ")\">\n<path d=\"" +
               pathData(path, Mat2x3{}) + "\"/>\n</clipPath>\n";
      out.push_back("<foreignObject x=\"" + num(b.x) + "\" y=\"" + num(b.y) + "\" width=\"" + num(b.w) + "\" height=\"" + num(b.h) +
                    "\"><div xmlns=\"http://www.w3.org/1999/xhtml\" style=\"backdrop-filter:blur(" + num(e.radius / 2 * scaleOf(E)) +
                    "px);clip-path:url(#" + id + ");height:100%;width:100%\"></div></foreignObject>\n");
    }
  }

  // ---- Layers ----

  Els siblingsEls(const std::vector<Drawn>& list, size_t from) {
    Els out;
    for (size_t i = from; i < list.size(); i++) {
      if (list[i].node->props.mask) {
        out.push_back(maskGroup(list, i));
        break;
      }
      append(out, nodeEls(list[i].id));
    }
    return out;
  }

  std::string maskGroup(const std::vector<Drawn>& list, size_t i) {
    Guid mid = list[i].id;
    const NodeProps& m = list[i].node->props;
    std::string id = "mask" + std::to_string(maskN_++) + suffix_;
    Rect b = contentBounds(doc_, texts_, mid);
    b = {b.x - t_.bounds.x, b.y - t_.bounds.y, b.w, b.h};
    std::string content;
    if (m.maskType == MaskType::OUTLINE) {
      Mat2x3 E = origin_ * doc_.worldTransform(mid);
      Shape sh = fillShape(doc_, mid, m);
      if (!sh.empty()) content += shapeEl(sh, E, " fill=\"white\"");
      if (m.fitsChildren()) content += join(siblingsEls(drawnChildren(doc_, mid), 0));
    } else {
      content = join(nodeEls(mid));
    }
    std::string out = "<mask id=\"" + id + "\" style=\"mask-type:" + (m.maskType == MaskType::LUMINANCE ? "luminance" : "alpha") +
                      "\" maskUnits=\"userSpaceOnUse\" x=\"" + num(b.x) + "\" y=\"" + num(b.y) + "\" width=\"" + num(b.w) + "\" height=\"" +
                      num(b.h) + "\">\n" + content + "</mask>\n";
    out += "<g mask=\"url(#" + id + ")\">\n" + join(siblingsEls(list, i + 1)) + "</g>\n";
    return out;
  }

  Els nodeEls(Guid id) {
    Els out;
    const Node* n = doc_.get(id);
    if (!n) return out;
    const NodeProps& p = n->props;
    if (!p.visible || p.opacity <= 0) return out;
    Mat2x3 E = origin_ * doc_.worldTransform(id);
    std::string ida = idAttr(p.name);
    Els els;
    Els before;
    Shape sh = fillShape(doc_, id, p);
    Stroke st = strokeOf(doc_, id, p);
    backgroundBlur(p, sh, E, before);
    if (p.type == NodeType::TEXT) {
      textEls(id, p, E, els);
      if (st.present()) {
        Shape glyphs;
        if (const NodeGeometry* g = doc_.geometry(id); g && !g->fills.empty()) {
          glyphs.kind = Shape::Kind::Path;
          glyphs.size = p.size;
          glyphs.regions = g->fills;
        }
        strokeEls(st, glyphs, p.size, E, els);
      }
    } else if (p.isGroupLike()) {
      els = siblingsEls(drawnChildren(doc_, id), 0);
    } else {
      Els kids;
      if (drawsChildren(p)) kids = siblingsEls(drawnChildren(doc_, id), 0);
      // One fill and one centre stroke on a plain shape: one element with both (as Figma writes it).
      int fills = 0;
      const Paint* fill = nullptr;
      for (const Paint& f : p.fillPaints)
        if (drawable(f)) fills++, fill = &f;
      bool simple = [&](const Paint* x) {
        return x && x->type != PaintType::GRADIENT_ANGULAR && x->type != PaintType::GRADIENT_DIAMOND && x->blendMode == BlendMode::NORMAL;
      }(fill);
      if (kids.empty() && fills == 1 && simple && st.present() && st.paints.size() == 1 && !st.outlineOnly && !st.aligned &&
          st.primitive != Shape::Kind::Path && st.primitive == sh.kind && st.paints[0]->blendMode == BlendMode::NORMAL &&
          st.paints[0]->type != PaintType::GRADIENT_ANGULAR && st.paints[0]->type != PaintType::GRADIENT_DIAMOND) {
        std::string a = paintAttr("fill", *fill, p.size, E) + paintAttr("stroke", *st.paints[0], p.size, E) +
                        strokeStyleAttrs(st, st.weight * scaleOf(E), true);
        els.push_back(shapeEl(sh, E, a));
      } else {
        Els body;
        nodeFills(sh, p, E, body);
        if (!kids.empty() && p.clipsContent()) {
          std::string cid = "clip" + std::to_string(clipN_++) + suffix_;
          Shape clip = sh;
          if (clip.empty()) {
            clip.kind = Shape::Kind::Rect;
            clip.size = p.size;
          }
          defs_ += "<clipPath id=\"" + cid + "\">\n" + shapeEl(clip, E, " fill=\"white\"") + "</clipPath>\n";
          // The frame's fills and its content in the clip (Figma's shape for a frame).
          append(body, std::move(kids));
          els.push_back("<g clip-path=\"url(#" + cid + ")\">\n" + join(body) + "</g>\n");
        } else {
          append(els, std::move(body));
          append(els, std::move(kids));
        }
        strokeEls(st, sh, p.size, E, els);
      }
    }
    // The layer itself: opacity, blend mode, filter, id.
    std::string attrs;
    if (p.opacity < 1) attrs += " opacity=\"" + num(p.opacity) + "\"";
    if (const char* css = blendCss(p.blendMode)) attrs += std::string(" style=\"mix-blend-mode:") + css + "\"";
    std::string filter = filterFor(id, p, E);
    if (!filter.empty()) attrs += " filter=\"url(#" + filter + ")\"";
    append(out, std::move(before));
    bool single = els.size() == 1 && filter.empty() && els[0].rfind("<g", 0) != 0 && els[0].rfind("<mask", 0) != 0 &&
                  els[0].find("style=\"mix-blend-mode") == std::string::npos;
    if (els.empty()) {
      // Nothing drawn (an empty frame without fills): an empty group keeps its id.
      if (!ida.empty() && p.isFrameLike()) out.push_back("<g" + ida + "/>\n");
    } else if (single) {
      out.push_back(inject(els[0], ida, attrs));
    } else if (!ida.empty() || !attrs.empty()) {
      out.push_back("<g" + ida + attrs + ">\n" + join(els) + "</g>\n");
    } else {
      append(out, std::move(els));
    }
    return out;
  }

  const Document& doc_;
  TextLayouts* texts_;
  const Target& t_;
  const Settings& s_;
  Mat2x3 origin_;
  std::string suffix_;
  std::string defs_, imageDefs_;
  std::unordered_map<std::string, std::string> images_;
  std::unordered_map<std::string, int> ids_;
  int clipN_ = 0, paintN_ = 0, filterN_ = 0, maskN_ = 0, patternN_ = 0, strokeMaskN_ = 0, bgBlurN_ = 0;
  bool xlink_ = false;

 public:
  std::string finish(std::string svg) {
    if (imageDefs_.empty()) return svg;
    // The images after the patterns that use them, inside <defs>.
    size_t at = svg.rfind("</defs>");
    if (at == std::string::npos) return svg;
    return svg.substr(0, at) + imageDefs_ + svg.substr(at);
  }
};

}  // namespace

std::string writeSvg(const Document& doc, TextLayouts* texts, const Target& target, const Settings& settings) {
  Writer w(doc, texts, target, settings);
  std::string svg = w.run();
  return w.finish(std::move(svg));
}

}  // namespace eng::exporter
