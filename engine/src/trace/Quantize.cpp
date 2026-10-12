#include "trace/Quantize.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <limits>
#include <numeric>

namespace eng::trace {

namespace {

// sRGB → linear, per byte.
struct LinearTable {
  float v[256];
  LinearTable() {
    for (int i = 0; i < 256; i++) {
      double c = i / 255.0;
      v[i] = static_cast<float>(c <= 0.04045 ? c / 12.92 : std::pow((c + 0.055) / 1.055, 2.4));
    }
  }
};
const LinearTable& linear() {
  static const LinearTable t;
  return t;
}

struct Lab {
  float l, a, b;
};

// Björn Ottosson's OKLab (2020), from linear sRGB.
Lab oklab(const uint8_t* px) {
  const LinearTable& t = linear();
  float r = t.v[px[0]], g = t.v[px[1]], b = t.v[px[2]];
  float l = std::cbrt(0.4122214708f * r + 0.5363325363f * g + 0.0514459929f * b);
  float m = std::cbrt(0.2119034982f * r + 0.6806995451f * g + 0.1073969566f * b);
  float s = std::cbrt(0.0883024619f * r + 0.2817188376f * g + 0.6299787005f * b);
  return {0.2104542553f * l + 0.7936177850f * m - 0.0040720468f * s, 1.9779984951f * l - 2.4285922050f * m + 0.4505937099f * s,
          0.0259040371f * l + 0.7827717662f * m - 0.8086757660f * s};
}

float dist2(const Lab& x, const Lab& y) {
  float dl = x.l - y.l, da = x.a - y.a, db = x.b - y.b;
  return dl * dl + da * da + db * db;
}

// Rec. 709 luma of the encoded values, 0–255.
double luma(const uint8_t* px) { return 0.2126 * px[0] + 0.7152 * px[1] + 0.0722 * px[2]; }

// SplitMix64: the seeded generator k-means++ draws from (seed 1, docs/ai.md §5).
struct Rng {
  uint64_t s;
  uint64_t next() {
    uint64_t z = (s += 0x9E3779B97F4A7C15ull);
    z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9ull;
    z = (z ^ (z >> 27)) * 0x94D049BB133111EBull;
    return z ^ (z >> 31);
  }
  double unit() { return static_cast<double>(next() >> 11) * (1.0 / 9007199254740992.0); }
};

// The labels' colours: the mean sRGB of their pixels; colours nobody uses are dropped (labels renumbered).
void finish(const Image& img, Palette& p, int k) {
  std::vector<uint64_t> sum(static_cast<size_t>(k) * 3, 0);
  std::vector<uint32_t> count(static_cast<size_t>(k), 0);
  const size_t n = p.labels.size();
  for (size_t i = 0; i < n; i++) {
    uint8_t l = p.labels[i];
    if (l == kNoLabel) continue;
    const uint8_t* px = img.rgba.data() + i * 4;
    for (int c = 0; c < 3; c++) sum[static_cast<size_t>(l) * 3 + c] += px[c];
    count[l]++;
  }
  std::vector<uint8_t> remap(static_cast<size_t>(k), kNoLabel);
  p.colors.clear();
  p.area.clear();
  for (int l = 0; l < k; l++) {
    if (!count[l]) continue;
    remap[l] = static_cast<uint8_t>(p.colors.size());
    std::array<uint8_t, 3> c{};
    for (int j = 0; j < 3; j++) c[j] = static_cast<uint8_t>((sum[static_cast<size_t>(l) * 3 + j] + count[l] / 2) / count[l]);
    p.colors.push_back(c);
    p.area.push_back(count[l]);
  }
  for (auto& l : p.labels)
    if (l != kNoLabel) l = remap[l];
}

void fullColor(const Image& img, Palette& p, int k) {
  const size_t n = p.labels.size();
  std::vector<uint32_t> opaque;
  opaque.reserve(n);
  for (size_t i = 0; i < n; i++)
    if (img.rgba[i * 4 + 3] >= kAlphaCutoff) opaque.push_back(static_cast<uint32_t>(i));
  if (opaque.empty()) return;
  // The samples: every opaque pixel, or an even stride through them.
  std::vector<Lab> samples;
  size_t count = std::min<size_t>(opaque.size(), kMaxSamples);
  samples.reserve(count);
  // In 64 bits: size_t is 32 bits in wasm, where s × 1,048,576 overflowed for a 1024² picture and every sample came
  // from its first rows (a three-colour logo traced as one layer of its mean colour).
  for (size_t s = 0; s < count; s++) samples.push_back(oklab(img.rgba.data() + static_cast<size_t>(opaque[static_cast<size_t>(static_cast<uint64_t>(s) * opaque.size() / count)]) * 4));
  // k-means++ (Arthur & Vassilvitskii 2007): the first centre drawn uniformly, each next one with probability ∝ D².
  Rng rng{1};
  std::vector<Lab> centres;
  centres.push_back(samples[static_cast<size_t>(rng.unit() * static_cast<double>(samples.size())) % samples.size()]);
  std::vector<float> d2(samples.size());
  for (size_t i = 0; i < samples.size(); i++) d2[i] = dist2(samples[i], centres[0]);
  while (static_cast<int>(centres.size()) < k) {
    double total = 0;
    for (float d : d2) total += d;
    if (total <= 0) break;  // fewer distinct colours than k
    double pick = rng.unit() * total;
    size_t chosen = samples.size() - 1;
    for (size_t i = 0; i < samples.size(); i++) {
      pick -= d2[i];
      if (pick < 0) {
        chosen = i;
        break;
      }
    }
    centres.push_back(samples[chosen]);
    for (size_t i = 0; i < samples.size(); i++) d2[i] = std::min(d2[i], dist2(samples[i], centres.back()));
  }
  // Lloyd's iterations on the samples.
  const size_t kc = centres.size();
  std::vector<uint8_t> assign(samples.size(), 0);
  auto nearest = [&](const Lab& x) {
    size_t best = 0;
    float bd = std::numeric_limits<float>::max();
    for (size_t c = 0; c < kc; c++) {
      float d = dist2(x, centres[c]);
      if (d < bd) {
        bd = d;
        best = c;
      }
    }
    return static_cast<uint8_t>(best);
  };
  for (int it = 0; it < kMaxIterations; it++) {
    bool moved = false;
    std::vector<double> acc(kc * 3, 0.0);
    std::vector<uint32_t> members(kc, 0);
    for (size_t i = 0; i < samples.size(); i++) {
      uint8_t c = nearest(samples[i]);
      moved |= c != assign[i] || it == 0;
      assign[i] = c;
      acc[c * 3] += samples[i].l;
      acc[c * 3 + 1] += samples[i].a;
      acc[c * 3 + 2] += samples[i].b;
      members[c]++;
    }
    for (size_t c = 0; c < kc; c++)
      if (members[c])
        centres[c] = {static_cast<float>(acc[c * 3] / members[c]), static_cast<float>(acc[c * 3 + 1] / members[c]),
                      static_cast<float>(acc[c * 3 + 2] / members[c])};
    if (!moved) break;
  }
  // Every pixel to its nearest centre, through a cache by 5-6-5 bits of colour: a cell (8 × 4 × 8 sRGB levels, far
  // finer than any palette here) takes its own middle colour's centre.
  std::vector<uint8_t> cache(65536, kNoLabel);
  for (uint32_t i : opaque) {
    const uint8_t* px = img.rgba.data() + static_cast<size_t>(i) * 4;
    uint32_t key = (static_cast<uint32_t>(px[0] >> 3) << 11) | (static_cast<uint32_t>(px[1] >> 2) << 5) | (px[2] >> 3);
    uint8_t& l = cache[key];
    if (l == kNoLabel) {
      const uint8_t mid[3] = {static_cast<uint8_t>((px[0] & 0xF8) | 4), static_cast<uint8_t>((px[1] & 0xFC) | 2), static_cast<uint8_t>((px[2] & 0xF8) | 4)};
      l = nearest(oklab(mid));
    }
    p.labels[i] = l;
  }
  finish(img, p, static_cast<int>(kc));
}

void grayscale(const Image& img, Palette& p, int k) {
  const size_t n = p.labels.size();
  // 1-D k-means over the luminance histogram (exact, every pixel counted).
  std::vector<uint8_t> y(n, 0);
  std::array<uint64_t, 256> hist{};
  uint64_t total = 0;
  for (size_t i = 0; i < n; i++) {
    if (img.rgba[i * 4 + 3] < kAlphaCutoff) continue;
    y[i] = static_cast<uint8_t>(std::lround(luma(img.rgba.data() + i * 4)));
    hist[y[i]]++;
    total++;
  }
  if (!total) return;
  // Initial centres at the quantiles' middles (deterministic).
  std::vector<double> centres;
  {
    uint64_t seen = 0;
    int next = 0;
    for (int v = 0; v < 256 && next < k; v++) {
      seen += hist[v];
      while (next < k && seen * static_cast<uint64_t>(k) >= (2 * static_cast<uint64_t>(next) + 1) * total / 2) {
        centres.push_back(v);
        next++;
      }
    }
    centres.erase(std::unique(centres.begin(), centres.end()), centres.end());
  }
  std::array<uint8_t, 256> labelOf{};
  for (int it = 0; it < 64; it++) {
    for (int v = 0; v < 256; v++) {
      size_t best = 0;
      for (size_t c = 1; c < centres.size(); c++)
        if (std::abs(v - centres[c]) < std::abs(v - centres[best])) best = c;
      labelOf[v] = static_cast<uint8_t>(best);
    }
    std::vector<double> acc(centres.size(), 0);
    std::vector<uint64_t> cnt(centres.size(), 0);
    for (int v = 0; v < 256; v++) {
      acc[labelOf[v]] += static_cast<double>(hist[v]) * v;
      cnt[labelOf[v]] += hist[v];
    }
    bool moved = false;
    for (size_t c = 0; c < centres.size(); c++) {
      if (!cnt[c]) continue;
      double m = acc[c] / static_cast<double>(cnt[c]);
      moved |= std::abs(m - centres[c]) > 1e-6;
      centres[c] = m;
    }
    if (!moved) break;
  }
  for (size_t i = 0; i < n; i++)
    if (img.rgba[i * 4 + 3] >= kAlphaCutoff) p.labels[i] = labelOf[y[i]];
  // Grey colours: each label's mean luminance.
  std::vector<double> acc(centres.size(), 0);
  std::vector<uint64_t> cnt(centres.size(), 0);
  for (int v = 0; v < 256; v++) {
    acc[labelOf[v]] += static_cast<double>(hist[v]) * v;
    cnt[labelOf[v]] += hist[v];
  }
  std::vector<uint8_t> remap(centres.size(), kNoLabel);
  for (size_t c = 0; c < centres.size(); c++) {
    if (!cnt[c]) continue;
    remap[c] = static_cast<uint8_t>(p.colors.size());
    auto g = static_cast<uint8_t>(std::lround(acc[c] / static_cast<double>(cnt[c])));
    p.colors.push_back({g, g, g});
    p.area.push_back(static_cast<uint32_t>(cnt[c]));
  }
  for (auto& l : p.labels)
    if (l != kNoLabel) l = remap[l];
}

void blackAndWhite(const Image& img, Palette& p, double threshold) {
  const size_t n = p.labels.size();
  const double cut = std::clamp(threshold, 0.0, 100.0) * 2.55;
  uint32_t count[2] = {0, 0};
  for (size_t i = 0; i < n; i++) {
    if (img.rgba[i * 4 + 3] < kAlphaCutoff) continue;
    uint8_t l = luma(img.rgba.data() + i * 4) < cut ? 0 : 1;
    p.labels[i] = l;
    count[l]++;
  }
  uint8_t remap[2] = {kNoLabel, kNoLabel};
  for (uint8_t l = 0; l < 2; l++) {
    if (!count[l]) continue;
    remap[l] = static_cast<uint8_t>(p.colors.size());
    uint8_t v = l ? 255 : 0;
    p.colors.push_back({v, v, v});
    p.area.push_back(count[l]);
  }
  for (auto& l : p.labels)
    if (l != kNoLabel) l = remap[l];
}

}  // namespace

Palette quantize(const Image& img, Mode mode, int k, double threshold) {
  Palette p;
  p.w = img.w;
  p.h = img.h;
  p.labels.assign(static_cast<size_t>(img.w) * img.h, kNoLabel);
  k = std::clamp(k, 1, 64);
  switch (mode) {
    case Mode::FULL_COLOR: fullColor(img, p, k); break;
    case Mode::GRAYSCALE: grayscale(img, p, k); break;
    case Mode::BLACK_AND_WHITE: blackAndWhite(img, p, threshold); break;
  }
  return p;
}

void despeckle(Palette& p, int speckle) {
  if (speckle <= 1 || p.colors.size() < 2) return;
  const int w = p.w, h = p.h;
  const size_t n = p.labels.size();
  // Regions by union-find over 4-neighbours of one label.
  std::vector<uint32_t> parent(n);
  std::iota(parent.begin(), parent.end(), 0u);
  auto find = [&](uint32_t x) {
    while (parent[x] != x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  auto unite = [&](uint32_t a, uint32_t b) {
    a = find(a);
    b = find(b);
    if (a != b) parent[std::max(a, b)] = std::min(a, b);
  };
  for (int y = 0; y < h; y++)
    for (int x = 0; x < w; x++) {
      size_t i = static_cast<size_t>(y) * w + x;
      uint8_t l = p.labels[i];
      if (l == kNoLabel) continue;
      if (x + 1 < w && p.labels[i + 1] == l) unite(static_cast<uint32_t>(i), static_cast<uint32_t>(i + 1));
      if (y + 1 < h && p.labels[i + w] == l) unite(static_cast<uint32_t>(i), static_cast<uint32_t>(i + w));
    }
  std::vector<uint32_t> size(n, 0);
  for (size_t i = 0; i < n; i++)
    if (p.labels[i] != kNoLabel) size[find(static_cast<uint32_t>(i))]++;
  // The small regions' pixels, smallest regions first (ties: by position, so the result is deterministic).
  std::vector<uint32_t> small;
  for (size_t i = 0; i < n; i++)
    if (p.labels[i] != kNoLabel && size[find(static_cast<uint32_t>(i))] < static_cast<uint32_t>(speckle)) small.push_back(static_cast<uint32_t>(i));
  if (small.empty()) return;
  std::stable_sort(small.begin(), small.end(), [&](uint32_t a, uint32_t b) {
    uint32_t ra = find(a), rb = find(b);
    if (size[ra] != size[rb]) return size[ra] < size[rb];
    return ra < rb;
  });
  for (size_t s = 0; s < small.size();) {
    uint32_t root = find(small[s]);
    size_t e = s;
    while (e < small.size() && find(small[e]) == root) e++;
    if (size[root] < static_cast<uint32_t>(speckle)) {
      // The largest neighbouring region of another label.
      uint32_t best = UINT32_MAX, bestSize = 0;
      for (size_t q = s; q < e; q++) {
        int x = static_cast<int>(small[q] % w), y = static_cast<int>(small[q] / w);
        const int nx[4] = {x - 1, x + 1, x, x}, ny[4] = {y, y, y - 1, y + 1};
        for (int d = 0; d < 4; d++) {
          if (nx[d] < 0 || ny[d] < 0 || nx[d] >= w || ny[d] >= h) continue;
          uint32_t j = static_cast<uint32_t>(ny[d]) * w + nx[d];
          if (p.labels[j] == kNoLabel) continue;
          uint32_t r = find(j);
          if (r == root) continue;
          if (size[r] > bestSize || (size[r] == bestSize && r < best)) {
            best = r;
            bestSize = size[r];
          }
        }
      }
      if (best != UINT32_MAX) {
        uint8_t to = p.labels[best];
        for (size_t q = s; q < e; q++) p.labels[small[q]] = to;
        uint32_t merged = size[root] + size[best];
        parent[root] = best;
        size[best] = merged;
      }
    }
    s = e;
  }
  // A small region merged into another small one that merged on: its pixels follow their final region.
  for (uint32_t q : small) p.labels[q] = p.labels[find(q)];
  std::fill(p.area.begin(), p.area.end(), 0);
  for (uint8_t l : p.labels)
    if (l != kNoLabel) p.area[l]++;
}

void sortByArea(Palette& p) {
  std::vector<uint8_t> order;
  for (size_t l = 0; l < p.colors.size(); l++)
    if (p.area[l]) order.push_back(static_cast<uint8_t>(l));
  auto lum = [&](uint8_t l) { return luma(p.colors[l].data()); };
  std::stable_sort(order.begin(), order.end(), [&](uint8_t a, uint8_t b) {
    if (p.area[a] != p.area[b]) return p.area[a] > p.area[b];
    return lum(a) < lum(b);
  });
  std::vector<uint8_t> rank(p.colors.size(), kNoLabel);
  std::vector<std::array<uint8_t, 3>> colors;
  std::vector<uint32_t> area;
  for (size_t r = 0; r < order.size(); r++) {
    rank[order[r]] = static_cast<uint8_t>(r);
    colors.push_back(p.colors[order[r]]);
    area.push_back(p.area[order[r]]);
  }
  for (auto& l : p.labels)
    if (l != kNoLabel) l = rank[l];
  p.colors = std::move(colors);
  p.area = std::move(area);
}

}  // namespace eng::trace
