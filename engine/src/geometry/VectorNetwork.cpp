#include "geometry/VectorNetwork.h"

#include <algorithm>
#include <cstring>

namespace eng::geom {

namespace {

struct ByteReader {
  const uint8_t* data;
  size_t size;
  size_t at = 0;
  bool ok = true;
  uint32_t u32() {
    if (at + 4 > size) {
      ok = false;
      return 0;
    }
    uint32_t v = static_cast<uint32_t>(data[at]) | (static_cast<uint32_t>(data[at + 1]) << 8) |
                 (static_cast<uint32_t>(data[at + 2]) << 16) | (static_cast<uint32_t>(data[at + 3]) << 24);
    at += 4;
    return v;
  }
  double f32() {
    uint32_t bits = u32();
    float f;
    std::memcpy(&f, &bits, 4);
    return f;
  }
};

void putU32(std::vector<uint8_t>& out, uint32_t v) {
  for (int i = 0; i < 4; i++) out.push_back(static_cast<uint8_t>((v >> (8 * i)) & 0xff));
}
void putF32(std::vector<uint8_t>& out, double v) {
  float f = static_cast<float>(v);
  uint32_t bits;
  std::memcpy(&bits, &f, 4);
  putU32(out, bits);
}

}  // namespace

bool VectorNetwork::decode(const uint8_t* data, size_t size, VectorNetwork& out) {
  out = VectorNetwork{};
  ByteReader r{data, size};
  uint32_t nv = r.u32(), ns = r.u32(), nr = r.u32();
  if (!r.ok || nv > size / 12 || ns > size / 28 || nr > size / 8) return false;
  out.vertices.resize(nv);
  for (auto& v : out.vertices) {
    v.styleID = r.u32();
    v.p.x = r.f32();
    v.p.y = r.f32();
  }
  out.segments.resize(ns);
  for (auto& s : out.segments) {
    s.styleID = r.u32();
    s.start = r.u32();
    s.tangentStart.x = r.f32();
    s.tangentStart.y = r.f32();
    s.end = r.u32();
    s.tangentEnd.x = r.f32();
    s.tangentEnd.y = r.f32();
    if (s.start >= nv || s.end >= nv) r.ok = false;
  }
  out.regions.resize(nr);
  for (auto& reg : out.regions) {
    uint32_t bits = r.u32();
    reg.styleID = bits >> 1;
    reg.windingRule = (bits & 1) ? WindingRule::NONZERO : WindingRule::ODD;
    uint32_t loops = r.u32();
    if (!r.ok || loops > size) return false;
    reg.loops.resize(loops);
    for (auto& loop : reg.loops) {
      uint32_t n = r.u32();
      if (!r.ok || n > size) return false;
      loop.resize(n);
      for (auto& s : loop) {
        s = r.u32();
        if (s >= ns) r.ok = false;
      }
    }
  }
  return r.ok;
}

std::vector<uint8_t> VectorNetwork::encode() const {
  std::vector<uint8_t> out;
  putU32(out, static_cast<uint32_t>(vertices.size()));
  putU32(out, static_cast<uint32_t>(segments.size()));
  putU32(out, static_cast<uint32_t>(regions.size()));
  for (auto& v : vertices) {
    putU32(out, v.styleID);
    putF32(out, v.p.x);
    putF32(out, v.p.y);
  }
  for (auto& s : segments) {
    putU32(out, s.styleID);
    putU32(out, s.start);
    putF32(out, s.tangentStart.x);
    putF32(out, s.tangentStart.y);
    putU32(out, s.end);
    putF32(out, s.tangentEnd.x);
    putF32(out, s.tangentEnd.y);
  }
  for (auto& reg : regions) {
    putU32(out, (reg.styleID << 1) | (reg.windingRule == WindingRule::NONZERO ? 1u : 0u));
    putU32(out, static_cast<uint32_t>(reg.loops.size()));
    for (auto& loop : reg.loops) {
      putU32(out, static_cast<uint32_t>(loop.size()));
      for (uint32_t s : loop) putU32(out, s);
    }
  }
  return out;
}

void VectorNetwork::appendSegment(Path& path, uint32_t index, bool reversed) const {
  const VNSegment& s = segments[index];
  Vec2 a = vertices[s.start].p, b = vertices[s.end].p;
  if (s.isLine()) {
    path.lineTo(reversed ? a : b);
    return;
  }
  Vec2 c1 = a + s.tangentStart, c2 = b + s.tangentEnd;
  if (reversed) path.cubicTo(c2, c1, a);
  else path.cubicTo(c1, c2, b);
}

Path VectorNetwork::regionPath(const VNRegion& region) const {
  Path path;
  for (const auto& loop : region.loops) {
    if (loop.empty()) continue;
    // The first segment's direction: towards the vertex it shares with the second.
    const VNSegment& first = segments[loop[0]];
    bool rev = false;
    if (loop.size() > 1) {
      const VNSegment& second = segments[loop[1]];
      rev = !(first.end == second.start || first.end == second.end);
    }
    uint32_t cur = rev ? first.end : first.start;
    path.moveTo(vertices[cur].p);
    for (uint32_t si : loop) {
      const VNSegment& s = segments[si];
      bool backwards = s.start != cur && s.end == cur;
      appendSegment(path, si, backwards);
      cur = backwards ? s.start : s.end;
    }
    path.close();
  }
  return path;
}

std::vector<uint32_t> VectorNetwork::degrees() const {
  std::vector<uint32_t> deg(vertices.size(), 0);
  for (auto& s : segments) {
    deg[s.start]++;
    deg[s.end]++;
  }
  return deg;
}

std::vector<VNChain> VectorNetwork::chains() const {
  std::vector<VNChain> out;
  std::vector<uint32_t> deg = degrees();
  std::vector<std::vector<uint32_t>> incident(vertices.size());
  for (uint32_t i = 0; i < segments.size(); i++) {
    incident[segments[i].start].push_back(i);
    if (segments[i].end != segments[i].start) incident[segments[i].end].push_back(i);
  }
  std::vector<bool> used(segments.size(), false);
  auto walk = [&](uint32_t from, uint32_t firstSeg) {
    VNChain c;
    c.firstVertex = from;
    uint32_t cur = from, seg = firstSeg;
    for (;;) {
      used[seg] = true;
      const VNSegment& s = segments[seg];
      bool rev = s.start != cur;
      c.segments.push_back(seg);
      c.reversed.push_back(rev);
      cur = rev ? s.start : s.end;
      if (cur == from) {
        c.closed = true;
        break;
      }
      if (deg[cur] != 2) break;
      uint32_t next = UINT32_MAX;
      for (uint32_t cand : incident[cur])
        if (!used[cand]) {
          next = cand;
          break;
        }
      if (next == UINT32_MAX) break;
      seg = next;
    }
    c.lastVertex = cur;
    out.push_back(std::move(c));
  };
  // Open chains start at ends and junctions.
  for (uint32_t v = 0; v < vertices.size(); v++)
    if (deg[v] != 2)
      for (uint32_t seg : incident[v])
        if (!used[seg]) walk(v, seg);
  // What is left are cycles through degree-2 vertices.
  for (uint32_t i = 0; i < segments.size(); i++)
    if (!used[i]) walk(segments[i].start, i);
  return out;
}

Path VectorNetwork::chainPath(const VNChain& chain) const {
  Path path;
  path.moveTo(vertices[chain.firstVertex].p);
  for (size_t i = 0; i < chain.segments.size(); i++) appendSegment(path, chain.segments[i], chain.reversed[i]);
  if (chain.closed) path.close();
  return path;
}

void VectorNetwork::scale(double sx, double sy) {
  for (auto& v : vertices) v.p = {v.p.x * sx, v.p.y * sy};
  for (auto& s : segments) {
    s.tangentStart = {s.tangentStart.x * sx, s.tangentStart.y * sy};
    s.tangentEnd = {s.tangentEnd.x * sx, s.tangentEnd.y * sy};
  }
}

Rect VectorNetwork::bounds() const {
  Path p;
  for (auto& c : chains()) p.append(chainPath(c));
  for (auto& v : vertices) {
    p.moveTo(v.p);
  }
  return p.bounds();
}

namespace {

VectorNetwork scaledTo(const VectorNetwork& net, const VectorData& data, Vec2 size) {
  VectorNetwork n = net;
  double sx = data.normalizedSize.x != 0 ? size.x / data.normalizedSize.x : 1;
  double sy = data.normalizedSize.y != 0 ? size.y / data.normalizedSize.y : 1;
  if (sx != 1 || sy != 1) n.scale(sx, sy);
  return n;
}

}  // namespace

std::vector<FillRegion> networkFills(const VectorNetwork& net0, const VectorData& data, Vec2 size) {
  std::vector<FillRegion> out;
  if (net0.empty()) return out;
  VectorNetwork net = scaledTo(net0, data, size);
  if (!net.regions.empty()) {
    for (const VNRegion& r : net.regions) out.push_back({net.regionPath(r), r.windingRule, r.styleID});
    return out;
  }
  FillRegion all;
  for (const VNChain& c : net.chains()) all.path.append(net.chainPath(c));
  if (!all.path.empty()) out.push_back(std::move(all));
  return out;
}

StrokeCenter networkStroke(const VectorNetwork& net0, const VectorData& data, Vec2 size, StrokeCap defaultCap) {
  StrokeCenter out;
  if (net0.empty()) return out;
  VectorNetwork net = scaledTo(net0, data, size);
  auto capOf = [&](uint32_t vertex) {
    uint32_t id = net.vertices[vertex].styleID;
    if (id) {
      const VectorStyle* st = data.style(id);
      if (st && (st->mask & VS_STROKE_CAP)) return st->strokeCap;
    }
    return defaultCap;
  };
  for (const VNChain& c : net.chains()) {
    out.path.append(net.chainPath(c));
    if (c.closed) out.caps.push_back({StrokeCap::NONE, StrokeCap::NONE});
    else out.caps.push_back({capOf(c.firstVertex), capOf(c.lastVertex)});
  }
  return out;
}

VectorNetwork withRoundedCorners(const VectorNetwork& net, const VectorData& data, double nodeRadius) {
  VectorNetwork out = net;
  std::vector<uint32_t> deg = net.degrees();
  for (uint32_t v = 0; v < net.vertices.size(); v++) {
    double r = nodeRadius;
    if (const VectorStyle* st = data.style(net.vertices[v].styleID); st && (st->mask & VS_CORNER_RADIUS)) r = st->cornerRadius;
    if (!(r > 0) || deg[v] != 2) continue;
    uint32_t sa = UINT32_MAX, sb = UINT32_MAX;
    for (uint32_t s = 0; s < out.segments.size(); s++) {
      const VNSegment& g = out.segments[s];
      if (g.start != v && g.end != v) continue;
      if (sa == UINT32_MAX) sa = s;
      else sb = s;
    }
    if (sb == UINT32_MAX || !out.segments[sa].isLine() || !out.segments[sb].isLine()) continue;
    VNSegment& a = out.segments[sa];
    VNSegment& b = out.segments[sb];
    if (a.start == a.end || b.start == b.end) continue;
    uint32_t u = a.start == v ? a.end : a.start, w = b.start == v ? b.end : b.start;
    Vec2 pv = out.vertices[v].p, pu = out.vertices[u].p, pw = out.vertices[w].p;
    double lu = (pu - pv).length(), lw = (pw - pv).length();
    if (lu < 1e-9 || lw < 1e-9) continue;
    Vec2 da = (pu - pv) * (1 / lu), db = (pw - pv) * (1 / lw);
    double cosT = std::clamp(da.x * db.x + da.y * db.y, -1.0, 1.0);
    double theta = std::acos(cosT);
    if (theta < 1e-3 || theta > 3.14159265358979 - 1e-3) continue;
    double cut = r / std::tan(theta / 2), maxCut = std::min(lu, lw) / 2;
    if (cut > maxCut) {
      cut = maxCut;
      r = cut * std::tan(theta / 2);
    }
    Vec2 A = pv + da * cut, B = pv + db * cut;
    uint32_t ia = static_cast<uint32_t>(out.vertices.size());
    out.vertices.push_back({A, 0});
    uint32_t ib = static_cast<uint32_t>(out.vertices.size());
    out.vertices.push_back({B, 0});
    VNSegment& a2 = out.segments[sa];
    VNSegment& b2 = out.segments[sb];
    (a2.start == v ? a2.start : a2.end) = ia;
    (b2.start == v ? b2.start : b2.end) = ib;
    double k = 4.0 / 3 * std::tan((3.14159265358979 - theta) / 4) * r;
    out.segments.push_back(VNSegment{ia, ib, da * -k, db * -k, 0});
    uint32_t sc = static_cast<uint32_t>(out.segments.size() - 1);
    for (auto& reg : out.regions)
      for (auto& loop : reg.loops)
        for (size_t i = 0; i < loop.size(); i++) {
          size_t j = (i + 1) % loop.size();
          if ((loop[i] == sa && loop[j] == sb) || (loop[i] == sb && loop[j] == sa)) {
            // Walking sa → sb the arc goes A → B; sb → sa: B → A (a reversed segment walks fine).
            loop.insert(loop.begin() + static_cast<long>(i + 1), sc);
            break;
          }
        }
  }
  return out;
}

VectorNetwork networkFromPath(const Path& path, WindingRule rule) {
  VectorNetwork net;
  VNRegion region;
  region.windingRule = rule;
  uint32_t contourStart = 0;
  std::vector<uint32_t> loop;
  auto vertexAt = [&](Vec2 p) {
    if (!net.vertices.empty() && net.vertices.back().p == p) return static_cast<uint32_t>(net.vertices.size() - 1);
    net.vertices.push_back({p, 0});
    return static_cast<uint32_t>(net.vertices.size() - 1);
  };
  forEachSegment(
      path,
      [&](Vec2 p) {
        net.vertices.push_back({p, 0});
        contourStart = static_cast<uint32_t>(net.vertices.size() - 1);
        loop.clear();
      },
      [&](Verb v, Vec2 from, const Vec2* p) {
        uint32_t a = static_cast<uint32_t>(net.vertices.size() - 1);
        Vec2 end = v == Verb::Line ? p[0] : v == Verb::Quad ? p[1] : p[2];
        uint32_t b = (end == net.vertices[contourStart].p && a != contourStart) ? contourStart : vertexAt(end);
        if (b == a && v == Verb::Line) return;  // a zero-length line
        VNSegment s;
        s.start = a;
        s.end = b;
        if (v == Verb::Quad) {
          s.tangentStart = (p[0] - from) * (2.0 / 3);
          s.tangentEnd = (p[0] - end) * (2.0 / 3);
        } else if (v == Verb::Cubic) {
          s.tangentStart = p[0] - from;
          s.tangentEnd = p[1] - end;
        }
        loop.push_back(static_cast<uint32_t>(net.segments.size()));
        net.segments.push_back(s);
      },
      [&](bool closed) {
        if (closed && !loop.empty()) region.loops.push_back(loop);
        loop.clear();
      });
  if (!region.loops.empty()) net.regions.push_back(std::move(region));
  return net;
}

}  // namespace eng::geom
