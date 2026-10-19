#include "geometry/Pathfinder.h"

#include <algorithm>
#include <map>
#include <numeric>

#include "geometry/CornerRounding.h"
#include "geometry/PlanarFaces.h"

namespace eng::geom {

namespace {

// Big enough for detailed artwork (the Shape builder's interactive limit is 40000 flattened edges).
constexpr size_t kMaxEdges = 400000;

uint32_t findRoot(std::vector<uint32_t>& parent, uint32_t x) {
  while (parent[x] != x) x = parent[x] = parent[parent[x]];
  return x;
}

}  // namespace

const char* pathfinderName(PathfinderOp op) {
  switch (op) {
    case PathfinderOp::DIVIDE: return "Divide";
    case PathfinderOp::TRIM: return "Trim";
    case PathfinderOp::MERGE: return "Merge";
    case PathfinderOp::CROP: return "Crop";
    case PathfinderOp::OUTLINE: return "Outline";
    case PathfinderOp::MINUS_BACK: return "Minus Back";
  }
  return "Divide";
}

std::vector<PathfinderPiece> pathfinder(const std::vector<PathfinderInput>& inputs, PathfinderOp op, const PathfinderOptions& options) {
  std::vector<PathfinderPiece> out;
  // Which inputs take part: "Divide and Outline will remove unpainted artwork" drops the unfilled ones first.
  const bool dropUnpainted = options.removeUnpainted && (op == PathfinderOp::DIVIDE || op == PathfinderOp::OUTLINE);
  std::vector<uint32_t> used;  // map input → our input
  std::vector<FaceInput> faceInputs;
  for (uint32_t i = 0; i < inputs.size(); i++) {
    if (inputs[i].path.empty() || (dropUnpainted && !inputs[i].filled)) continue;
    used.push_back(i);
    faceInputs.push_back({inputs[i].path, inputs[i].rule});
  }
  if (faceInputs.empty()) return out;
  const double tol = std::clamp(options.precision, 0.001, 10.0);
  PlanarMap map = planarMap(faceInputs, tol, kMaxEdges);
  if (map.edges.empty()) return out;
  auto finish = [&](Path p) { return options.removeRedundantPoints ? removeRedundantPoints(p, std::max(1e-4, tol * 0.01)) : p; };
  // The topmost cover of a face that is filled (else −1), and the topmost at all.
  auto topFilled = [&](const PlanarFace& f, uint32_t skip = UINT32_MAX) {
    int best = -1;
    for (uint32_t c : f.covers)
      if (c != skip && inputs[used[c]].filled) best = std::max(best, static_cast<int>(c));
    return best;
  };
  // Unions of faces per owner (map indices), bottom first.
  auto perOwner = [&](const std::vector<int>& owner) {
    std::map<int, std::vector<int>> groups;
    for (size_t f = 0; f < owner.size(); f++)
      if (owner[f] >= 0) groups[owner[f]].push_back(static_cast<int>(f));
    for (auto& [o, faces] : groups) {
      Path p = map.unionOf(faces);
      if (!p.empty()) out.push_back({finish(std::move(p)), used[static_cast<size_t>(o)], false});
    }
  };
  const size_t F = map.faces.size();
  switch (op) {
    case PathfinderOp::DIVIDE: {
      // Each face on its own, with the paint of the filled shape on top there (unpainted pieces where none is).
      std::vector<std::pair<int, size_t>> order;
      for (size_t f = 0; f < F; f++) {
        int o = topFilled(map.faces[f]);
        if (o < 0) o = static_cast<int>(map.faces[f].covers.back());
        order.push_back({o, f});
      }
      std::stable_sort(order.begin(), order.end(), [](auto& a, auto& b) { return a.first < b.first; });
      for (auto& [o, f] : order) out.push_back({finish(map.faces[f].path), used[static_cast<size_t>(o)], false});
      break;
    }
    case PathfinderOp::TRIM: {
      std::vector<int> owner(F);
      for (size_t f = 0; f < F; f++) owner[f] = topFilled(map.faces[f]);
      perOwner(owner);
      break;
    }
    case PathfinderOp::MERGE: {
      std::vector<int> owner(F);
      for (size_t f = 0; f < F; f++) owner[f] = topFilled(map.faces[f]);
      // Faces of the same fill that share an edge are one piece.
      std::vector<uint32_t> parent(F);
      std::iota(parent.begin(), parent.end(), 0u);
      for (size_t h = 0; h < map.faceOfHalf.size(); h++) {
        int a = map.faceOfHalf[h], b = map.faceOfHalf[h ^ 1];
        if (a < 0 || b < 0 || a == b) continue;
        int oa = owner[static_cast<size_t>(a)], ob = owner[static_cast<size_t>(b)];
        if (oa < 0 || ob < 0 || inputs[used[static_cast<size_t>(oa)]].fillKey != inputs[used[static_cast<size_t>(ob)]].fillKey) continue;
        parent[findRoot(parent, static_cast<uint32_t>(a))] = findRoot(parent, static_cast<uint32_t>(b));
      }
      std::map<uint32_t, std::vector<int>> parts;
      for (size_t f = 0; f < F; f++)
        if (owner[f] >= 0) parts[findRoot(parent, static_cast<uint32_t>(f))].push_back(static_cast<int>(f));
      // Each merged piece takes its topmost shape's look; bottom first by that shape.
      std::vector<std::pair<int, std::vector<int>>> pieces;
      for (auto& [root, faces] : parts) {
        int top = -1;
        for (int f : faces) top = std::max(top, owner[static_cast<size_t>(f)]);
        pieces.push_back({top, faces});
      }
      std::stable_sort(pieces.begin(), pieces.end(), [](auto& a, auto& b) { return a.first < b.first; });
      for (auto& [top, faces] : pieces) {
        Path p = map.unionOf(faces);
        if (!p.empty()) out.push_back({finish(std::move(p)), used[static_cast<size_t>(top)], false});
      }
      break;
    }
    case PathfinderOp::CROP: {
      // The top shape is the crop: only what lies inside it stays, each part with the filled shape on top there.
      const uint32_t crop = static_cast<uint32_t>(used.size() - 1);
      if (used.size() < 2) return out;
      std::vector<int> owner(F, -1);
      for (size_t f = 0; f < F; f++) {
        const auto& c = map.faces[f].covers;
        if (std::find(c.begin(), c.end(), crop) == c.end()) continue;
        owner[f] = topFilled(map.faces[f], crop);
      }
      perOwner(owner);
      break;
    }
    case PathfinderOp::MINUS_BACK: {
      // The front shape where nothing behind it is.
      const uint32_t front = static_cast<uint32_t>(used.size() - 1);
      if (used.size() < 2) return out;
      std::vector<int> faces;
      for (size_t f = 0; f < F; f++)
        if (map.faces[f].covers.size() == 1 && map.faces[f].covers[0] == front) faces.push_back(static_cast<int>(f));
      Path p = map.unionOf(faces);
      if (!p.empty()) out.push_back({finish(std::move(p)), used[front], false});
      break;
    }
    case PathfinderOp::OUTLINE: {
      // The edges, chained between crossings (vertices where other than two edges meet) and while one shape's.
      const auto& E = map.edges;
      std::vector<std::vector<uint32_t>> at(map.points.size());
      for (uint32_t e = 0; e < E.size(); e++) at[E[e].u].push_back(e), at[E[e].v].push_back(e);
      auto inputOf = [&](uint32_t e) { return map.curveInput[E[e].curve]; };
      auto halfFrom = [&](uint32_t e, uint32_t vtx) { return E[e].u == vtx ? 2 * e : 2 * e + 1; };
      auto target = [&](uint32_t h) { return h & 1 ? E[h >> 1].u : E[h >> 1].v; };
      std::vector<bool> done(E.size(), false);
      std::vector<std::pair<uint32_t, PathfinderPiece>> chains;
      auto walk = [&](uint32_t e, uint32_t from, bool cycle) {
        std::vector<uint32_t> halves;
        uint32_t in = inputOf(e);
        uint32_t h = halfFrom(e, from);
        for (;;) {
          done[h >> 1] = true;
          halves.push_back(h);
          uint32_t t = target(h);
          if (at[t].size() != 2) break;
          uint32_t next = at[t][0] == (h >> 1) ? at[t][1] : at[t][0];
          if (done[next] || inputOf(next) != in) break;
          h = halfFrom(next, t);
        }
        Path p;
        bool closed = cycle && target(halves.back()) == (halves.front() & 1 ? E[halves.front() >> 1].v : E[halves.front() >> 1].u);
        map.appendChain(p, halves, closed);
        chains.push_back({in, {finish(std::move(p)), used[in], true}});
      };
      for (uint32_t v = 0; v < at.size(); v++) {
        if (at[v].size() == 2) continue;
        for (uint32_t e : at[v])
          if (!done[e]) walk(e, v, false);
      }
      for (uint32_t e = 0; e < E.size(); e++)
        if (!done[e]) walk(e, E[e].u, true);
      std::stable_sort(chains.begin(), chains.end(), [](auto& a, auto& b) { return a.first < b.first; });
      for (auto& c : chains)
        if (!c.second.path.empty()) out.push_back(std::move(c.second));
      break;
    }
  }
  return out;
}

}  // namespace eng::geom
