#include "text/TextPathLayout.h"

#include <algorithm>
#include <cmath>

#include "base/Json.h"
#include "scene/CodecKiwi.h"

namespace eng::text {

namespace {

constexpr double kFlatten = 0.05;  // node px: how finely the path's curves are walked

// A network's chains as walks by arc length, and which part of which walk each segment is.
struct SegSpan {
  int walk = -1;
  double s0 = 0, s1 = 0;  // its arc-length range on the walk
  bool reversed = false;  // walked from its end to its start
};
struct Walk {
  std::vector<Vec2> pts;
  std::vector<double> at;
  bool closed = false;
};
struct Walks {
  std::vector<Walk> walks;
  std::vector<SegSpan> segs;
};

Walks walksOf(const geom::VectorNetwork& net0, const VectorData& data, Vec2 size) {
  Walks out;
  if (net0.empty() || net0.segments.empty()) return out;
  geom::VectorNetwork net = net0;
  double sx = data.normalizedSize.x != 0 ? size.x / data.normalizedSize.x : 1;
  double sy = data.normalizedSize.y != 0 ? size.y / data.normalizedSize.y : 1;
  net.scale(sx, sy);
  out.segs.assign(net.segments.size(), SegSpan{});
  for (const geom::VNChain& ch : net.chains()) {
    Walk w;
    w.closed = ch.closed;
    int wi = static_cast<int>(out.walks.size());
    for (size_t k = 0; k < ch.segments.size(); k++) {
      uint32_t si = ch.segments[k];
      bool rev = ch.reversed[k];
      const geom::VNSegment& seg = net.segments[si];
      Vec2 from = net.vertices[rev ? seg.end : seg.start].p;
      geom::Path sp;
      sp.moveTo(from);
      net.appendSegment(sp, si, rev);
      std::vector<geom::Polyline> pl = geom::flatten(sp, kFlatten);
      if (w.pts.empty()) {
        w.pts.push_back(from);
        w.at.push_back(0);
      }
      double start = w.at.back();
      if (!pl.empty())
        for (size_t i = 1; i < pl[0].points.size(); i++) {
          Vec2 p = pl[0].points[i];
          w.at.push_back(w.at.back() + (p - w.pts.back()).length());
          w.pts.push_back(p);
        }
      if (si < out.segs.size()) out.segs[si] = SegSpan{wi, start, w.at.back(), rev};
    }
    if (w.closed && w.pts.size() > 1 && !(w.pts.back() == w.pts.front())) {
      w.at.push_back(w.at.back() + (w.pts.front() - w.pts.back()).length());
      w.pts.push_back(w.pts.front());
    }
    out.walks.push_back(std::move(w));
  }
  return out;
}

void sampleWalk(const std::vector<Vec2>& pts, const std::vector<double>& at, bool closed, double s, Vec2& pos, Vec2& tangent) {
  if (pts.size() < 2) {
    pos = pts.empty() ? Vec2{} : pts[0];
    tangent = {1, 0};
    return;
  }
  double L = at.back();
  if (closed && L > 0) {
    s = std::fmod(s, L);
    if (s < 0) s += L;
  } else {
    s = std::clamp(s, 0.0, L);
  }
  size_t i = static_cast<size_t>(std::upper_bound(at.begin(), at.end(), s) - at.begin());
  i = std::clamp<size_t>(i, 1, pts.size() - 1);
  double seg = at[i] - at[i - 1];
  double f = seg > 0 ? (s - at[i - 1]) / seg : 0;
  pos = pts[i - 1] + (pts[i] - pts[i - 1]) * f;
  // The direction of piece k (pts[k-1] → pts[k]), skipping zero-length ones; closed walks wrap.
  size_t n = pts.size();
  auto unit = [](Vec2 d) {
    double len = d.length();
    return len > 1e-12 ? d * (1 / len) : Vec2{0, 0};
  };
  auto dirOf = [&](long k, int step) {
    for (int guard = 0; guard < static_cast<int>(n); guard++, k += step) {
      if (closed) k = ((k - 1) % static_cast<long>(n - 1) + static_cast<long>(n - 1)) % static_cast<long>(n - 1) + 1;
      if (k < 1 || k >= static_cast<long>(n)) return Vec2{0, 0};
      Vec2 d = unit(pts[static_cast<size_t>(k)] - pts[static_cast<size_t>(k) - 1]);
      if (d.x != 0 || d.y != 0) return d;
    }
    return Vec2{0, 0};
  };
  Vec2 here = dirOf(static_cast<long>(i), 1);
  if (here.x == 0 && here.y == 0) here = dirOf(static_cast<long>(i), -1);
  if (here.x == 0 && here.y == 0) {
    tangent = {1, 0};
    return;
  }
  // A flattened curve turns a little at each point: the tangent eases from one piece's direction to the next across
  // the piece (at a point turning less than ~15°); a real corner keeps each side's own direction.
  auto blend = [&](Vec2 other) {
    if ((other.x == 0 && other.y == 0) || here.x * other.x + here.y * other.y < 0.966) return here;
    return unit(here + other);
  };
  Vec2 start = blend(dirOf(static_cast<long>(i) - 1, -1)), end = blend(dirOf(static_cast<long>(i) + 1, 1));
  Vec2 t = unit(start * (1 - f) + end * f);
  tangent = t.x == 0 && t.y == 0 ? here : t;
}

}  // namespace

double TextPathMap::arcAt(double x) const {
  double s = s0 + dir * (shift + (x - lineX));
  double L = length();
  if (closed && L > 0) {
    s = std::fmod(s, L);
    if (s < 0) s += L;
  }
  return s;
}

bool TextPathMap::onPath(double x) const {
  double L = length();
  if (!(L > 0)) return false;
  if (closed) return x - lineX >= 0 && x - lineX < L;
  double s = s0 + dir * (shift + (x - lineX));
  return s >= 0 && s <= L;
}

void TextPathMap::sample(double s, Vec2& pos, Vec2& tangent) const { sampleWalk(pts, at, closed, s, pos, tangent); }

Mat2x3 TextPathMap::frameAt(double x) const {
  Vec2 pos, t;
  sample(arcAt(x), pos, t);
  t = t * static_cast<double>(dir);
  Vec2 up{t.y, -t.x};  // the text's up: left of its travel (y down)
  Vec2 base = pos + up * v;
  return Mat2x3{t.x, -up.x, base.x, t.y, -up.y, base.y};
}

void textPathStartOf(const NodeProps& p, double& tValue, bool& forward) {
  tValue = 0;
  forward = true;
  auto it = p.extra.find("textPathStart");
  if (it == p.extra.end() || it->second.empty()) return;
  json::Value v;
  if (!json::parse(codec::extraValueToJson("NodeChange", it->second), v) || !v.isObject()) return;
  if (const json::Value* t = v.get("tValue")) tValue = t->numberOr(0);
  // kiwi leaves a false bool out: an entry without `forward` runs backwards only when it says so.
  if (const json::Value* f = v.get("forward")) forward = f->isBool() ? f->boolean : f->numberOr(1) != 0;
  if (!std::isfinite(tValue) || tValue < 0) tValue = 0;
}

bool textPathContour(const geom::VectorNetwork& net, const VectorData& data, Vec2 size, double tValue, std::vector<Vec2>& contour,
                     bool& closed, double& s, int& segmentDir) {
  Walks w = walksOf(net, data, size);
  if (w.segs.empty() || w.walks.empty()) return false;
  size_t n = w.segs.size();
  size_t k = static_cast<size_t>(std::clamp(std::floor(tValue), 0.0, static_cast<double>(n - 1)));
  double pos = std::clamp(tValue - static_cast<double>(k), 0.0, 1.0);
  if (tValue >= static_cast<double>(n)) pos = 1;
  const SegSpan& span = w.segs[k];
  if (span.walk < 0) return false;
  const Walk& walk = w.walks[static_cast<size_t>(span.walk)];
  if (walk.pts.size() < 2 || !(walk.at.back() > 0)) return false;
  contour = walk.pts;
  closed = walk.closed;
  s = span.reversed ? span.s1 - pos * (span.s1 - span.s0) : span.s0 + pos * (span.s1 - span.s0);
  segmentDir = span.reversed ? -1 : 1;
  return true;
}

bool textPathProject(const geom::VectorNetwork& net, const VectorData& data, Vec2 size, Vec2 local, double& tValue) {
  Walks w = walksOf(net, data, size);
  double best = 1e300, bestS = 0;
  int bestWalk = -1;
  for (size_t wi = 0; wi < w.walks.size(); wi++) {
    const Walk& walk = w.walks[wi];
    for (size_t i = 1; i < walk.pts.size(); i++) {
      Vec2 a = walk.pts[i - 1], b = walk.pts[i], d = b - a;
      double len2 = d.x * d.x + d.y * d.y;
      double t = len2 > 0 ? std::clamp(((local.x - a.x) * d.x + (local.y - a.y) * d.y) / len2, 0.0, 1.0) : 0;
      Vec2 q = a + d * t;
      double dist = (local - q).length();
      if (dist < best) {
        best = dist;
        bestS = walk.at[i - 1] + (walk.at[i] - walk.at[i - 1]) * t;
        bestWalk = static_cast<int>(wi);
      }
    }
  }
  if (bestWalk < 0) return false;
  for (size_t k = 0; k < w.segs.size(); k++) {
    const SegSpan& span = w.segs[k];
    if (span.walk != bestWalk || bestS < span.s0 - 1e-9 || bestS > span.s1 + 1e-9) continue;
    double len = span.s1 - span.s0;
    double f = len > 0 ? std::clamp((bestS - span.s0) / len, 0.0, 1.0) : 0;
    tValue = static_cast<double>(k) + (span.reversed ? 1 - f : f);
    if (tValue > static_cast<double>(k) + 1 - 1e-12 && k + 1 < w.segs.size()) tValue = static_cast<double>(k) + 1 - 1e-9;
    return true;
  }
  return false;
}

std::unique_ptr<TextLayout> layoutTextPath(const NodeProps& p, const geom::VectorNetwork* net) {
  // The characters as one line: line breaks become spaces (the UTF-16 offsets stay), nothing wraps or truncates.
  NodeProps q = p;
  q.type = NodeType::TEXT;
  TextFacet& t = q.text();
  std::string& chars = t.textData.characters;
  for (size_t i = 0; i < chars.size(); i++) {
    if (chars[i] == '\n' || chars[i] == '\r') chars[i] = ' ';
    // U+2028 (a line break inside a paragraph): one UTF-16 unit, as the space that replaces it.
    if (i + 2 < chars.size() && static_cast<unsigned char>(chars[i]) == 0xE2 && static_cast<unsigned char>(chars[i + 1]) == 0x80 &&
        static_cast<unsigned char>(chars[i + 2]) == 0xA8)
      chars.replace(i, 3, " ");
  }
  t.textData.lines.clear();
  t.textAutoResize = TextAutoResize::WIDTH_AND_HEIGHT;
  t.textTruncation = TextTruncation::DISABLED;
  t.maxLines = 0;
  t.textAlignHorizontal = TextAlignHorizontal::LEFT;
  t.textAlignVertical = TextAlignVertical::TOP;
  t.paragraphSpacing = 0;
  t.paragraphIndent = 0;
  std::unique_ptr<TextLayout> L = layoutText(q, LayoutOptions{});
  // The styles' fills point into what was laid out: the node's own (the layout lives as long as its props, as TEXT's).
  for (ResolvedStyle& st : L->styles) {
    if (st.fills == &q.fillPaints) {
      st.fills = &p.fillPaints;
      continue;
    }
    const auto& mine = q.text().textData.styleOverrideTable;
    const auto& theirs = p.text().textData.styleOverrideTable;
    for (size_t k = 0; k < mine.size() && k < theirs.size(); k++)
      if (st.fills == &mine[k].fillPaints) st.fills = &theirs[k].fillPaints;
  }
  L->size = p.size;
  L->boxWidth = p.size.x;
  L->decorations.clear();  // not drawn on a path [ours, first version]
  L->links.clear();
  double tValue = 0;
  bool forward = true;
  textPathStartOf(p, tValue, forward);
  auto map = std::make_shared<TextPathMap>();
  int segDir = 1;
  bool ok = net && textPathContour(*net, p.shape().vectorData, p.size, tValue, map->pts, map->closed, map->s0, segDir);
  if (!ok || L->lines.empty()) {
    L->glyphs.clear();
    for (LaidLine& l : L->lines) l.firstGlyph = 0, l.glyphCount = 0;
    L->inkBounds = {0, 0, p.size.x, p.size.y};
    return L;
  }
  map->at.assign(map->pts.size(), 0);
  for (size_t i = 1; i < map->pts.size(); i++) map->at[i] = map->at[i - 1] + (map->pts[i] - map->pts[i - 1]).length();
  map->dir = forward ? segDir : -segDir;
  const LaidLine& line = L->lines[0];
  double W = line.width;
  map->lineX = line.x;
  map->baseline = line.baseline;
  switch (p.text().textAlignHorizontal) {
    case TextAlignHorizontal::CENTER: map->shift = -W / 2; break;
    case TextAlignHorizontal::RIGHT: map->shift = -W; break;
    default: map->shift = 0;  // LEFT, JUSTIFIED
  }
  double asc = line.ascent, desc = line.descent;
  switch (p.text().textAlignVertical) {
    case TextAlignVertical::TOP: map->v = -asc; break;
    case TextAlignVertical::CENTER: map->v = -(asc - desc) / 2; break;
    default: map->v = 0;  // BOTTOM: the baseline on the path
  }
  // Each glyph's centre onto the path, turned to its tangent.
  std::vector<LaidGlyph> kept;
  kept.reserve(L->glyphs.size());
  std::vector<uint32_t> keptBefore(L->glyphs.size() + 1, 0);
  bool anyInk = false;
  Rect ink;
  for (size_t i = 0; i < L->glyphs.size(); i++) {
    keptBefore[i] = static_cast<uint32_t>(kept.size());
    LaidGlyph g = L->glyphs[i];
    double half = g.advance / 2;
    double xc = g.x + half;
    if (!map->onPath(xc)) continue;
    Mat2x3 F = map->frameAt(xc);
    Vec2 origin = F.apply({-half, g.y - map->baseline});
    g.rotation = static_cast<float>(std::atan2(F.m10, F.m00));
    g.x = static_cast<float>(origin.x);
    g.y = static_cast<float>(origin.y);
    Mat2x3 G = Mat2x3::translate(g.x, g.y) * Mat2x3::rotate(g.rotation);
    Rect box = transformedBounds(G * Mat2x3::translate(0, -asc), std::max<double>(g.advance, 0.0), asc + desc);
    ink = anyInk ? ink.united(box) : box;
    anyInk = true;
    kept.push_back(g);
  }
  keptBefore[L->glyphs.size()] = static_cast<uint32_t>(kept.size());
  for (LaidLine& l : L->lines) {
    uint32_t a = std::min<uint32_t>(l.firstGlyph, static_cast<uint32_t>(L->glyphs.size()));
    uint32_t b = std::min<uint32_t>(l.firstGlyph + l.glyphCount, static_cast<uint32_t>(L->glyphs.size()));
    l.firstGlyph = keptBefore[a];
    l.glyphCount = keptBefore[b] - keptBefore[a];
  }
  L->glyphs.swap(kept);
  L->inkBounds = anyInk ? ink : Rect{0, 0, p.size.x, p.size.y};
  L->path = std::move(map);
  return L;
}

}  // namespace eng::text
