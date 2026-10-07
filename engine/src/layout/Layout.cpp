#include "layout/Layout.h"

#include <algorithm>
#include <cmath>
#include <unordered_set>

namespace eng {

namespace {

constexpr double kEps = 1e-4;

double axis(Vec2 v, int a) { return a == 0 ? v.x : v.y; }
void setAxis(Vec2& v, int a, double value) { (a == 0 ? v.x : v.y) = value; }

bool axisAligned(const Mat2x3& m) { return std::fabs(m.m01) < 1e-9 && std::fabs(m.m10) < 1e-9; }

// min/max (0 = no limit on that axis), never below 0.
double clampSize(double v, const NodeProps& p, int a) {
  double mx = axis(p.maxSize, a), mn = axis(p.minSize, a);
  if (mx > 0 && v > mx) v = mx;
  if (mn > 0 && v < mn) v = mn;
  return std::max(0.0, v);
}

Vec2 clampSize(Vec2 v, const NodeProps& p) { return {clampSize(v.x, p, 0), clampSize(v.y, p, 1)}; }

double alignFactor(StackAlign a) {
  switch (a) {
    case StackAlign::CENTER: return 0.5;
    case StackAlign::MAX: return 1;
    default: return 0;  // MIN, BASELINE (text comes with E3)
  }
}

double selfFactor(StackCounterAlign self, StackAlign container) {
  switch (self) {
    case StackCounterAlign::MIN: return 0;
    case StackCounterAlign::CENTER: return 0.5;
    case StackCounterAlign::MAX: return 1;
    default: return alignFactor(container);  // AUTO, BASELINE
  }
}

void constrain(ConstraintType t, double x0, double w0, double W0, double W1, double& x1, double& w1) {
  x1 = x0;
  w1 = w0;
  switch (t) {
    case ConstraintType::MAX:
    case ConstraintType::FIXED_MAX: x1 = x0 + (W1 - W0); break;
    case ConstraintType::CENTER: x1 = x0 + (W1 - W0) / 2; break;
    case ConstraintType::STRETCH: w1 = std::max(0.0, w0 + (W1 - W0)); break;
    case ConstraintType::SCALE:
      if (W0 > 0) {
        x1 = x0 * W1 / W0;
        w1 = w0 * W1 / W0;
      }
      break;
    default: break;  // MIN, FIXED_MIN
  }
}

bool sameSize(Vec2 a, Vec2 b) { return std::fabs(a.x - b.x) < kEps && std::fabs(a.y - b.y) < kEps; }

}  // namespace

Rect layoutBox(const Mat2x3& transform, Vec2 size) { return transformedBounds(transform, size.x, size.y); }

void Layout::padding(const NodeProps& p, double out[4]) {
  out[0] = p.stackPaddingLeft;
  out[1] = p.stackPaddingTop;
  out[2] = p.stackPaddingRight;
  out[3] = p.stackPaddingBottom;
  if (!p.bordersTakeSpace || p.strokeWeight <= 0) return;
  bool stroke = false;
  for (auto& s : p.strokePaints) stroke |= s.visible;
  if (!stroke) return;
  // "Strokes included in layout": what the stroke covers inside the frame takes space.
  double inside = p.strokeAlign == StrokeAlign::INSIDE ? p.strokeWeight : p.strokeAlign == StrokeAlign::CENTER ? p.strokeWeight / 2 : 0;
  for (int i = 0; i < 4; i++) out[i] += inside;
}

std::vector<Guid> Layout::flowChildren(Guid frame) const {
  std::vector<Guid> out;
  for (Guid c : doc_.children(frame)) {
    const Node* n = doc_.get(c);
    if (n && n->props.inFlow() && !host_.excludedFromFlow(c)) out.push_back(c);
  }
  return out;
}

// ---- Measure ------------------------------------------------------------------------

Vec2 Layout::natural(Guid id, double width, double height) {
  MemoKey key{id, width, height};
  auto hit = memo_.find(key);
  if (hit != memo_.end()) return hit->second;
  const Node* n = doc_.get(id);
  if (!n) return {};
  const NodeProps& p = n->props;
  Vec2 size = p.size;
  if (width > 0) size.x = width;
  if (height > 0) size.y = height;
  if (p.isAutoLayout()) {
    int P = p.stackMode == StackMode::HORIZONTAL ? 0 : 1, C = 1 - P;
    bool hugP = p.hugsPrimary() && !(P == 0 ? width > 0 : height > 0);
    bool hugC = p.hugsCounter() && !(C == 0 ? width > 0 : height > 0);
    if (hugP || hugC) {
      Vec2 content = contentSize(id, size);
      if (hugP) setAxis(size, P, axis(content, P));
      if (hugC) setAxis(size, C, axis(content, C));
    }
  } else if (p.type == NodeType::TEXT && p.textAutoResize != TextAutoResize::NONE) {
    // Auto width hugs its text (wrapping when a width is imposed: Fill); auto height wraps at its width.
    double w = width > 0 ? width : (p.textAutoResize == TextAutoResize::HEIGHT ? p.size.x : -1);
    Vec2 measured;
    if (host_.measureText(id, w, measured)) size = {w >= 0 ? w : measured.x, measured.y};
  } else if (p.fitsChildren()) {
    bool any = false;
    Rect u;
    for (Guid c : doc_.children(id)) {
      const Node* cn = doc_.get(c);
      if (!cn) continue;
      Rect b = layoutBox(cn->props.transform, natural(c));
      u = any ? u.united(b) : b;
      any = true;
    }
    if (any) size = {u.w, u.h};
  }
  size = clampSize(size, p);
  memo_[key] = size;
  return size;
}

double Layout::baselineOf(Guid id, Vec2 size, int depth) {
  const Node* n = doc_.get(id);
  if (!n) return size.y;
  const NodeProps& p = n->props;
  if (p.type == NodeType::TEXT) {
    double b = host_.firstBaseline(id, size);
    return b >= 0 ? b : size.y;
  }
  if (p.isAutoLayout() && depth < 16) {
    auto kids = flowChildren(id);
    if (!kids.empty()) {
      const NodeProps& cp = doc_.get(kids[0])->props;
      return cp.transform.m12 + baselineOf(kids[0], cp.size, depth + 1);
    }
  }
  return size.y;
}

Vec2 Layout::contentSize(Guid frame, Vec2 frameSize) {
  const NodeProps& p = doc_.get(frame)->props;
  int P = p.stackMode == StackMode::HORIZONTAL ? 0 : 1, C = 1 - P;
  double pad[4];
  padding(p, pad);
  double padP = P == 0 ? pad[0] + pad[2] : pad[1] + pad[3];
  double padC = C == 0 ? pad[0] + pad[2] : pad[1] + pad[3];
  double gap = p.stackSpacing, counterGap = p.stackCounterSpacing.value_or(p.stackSpacing);
  bool wrap = p.stackWrap == StackWrap::WRAP && P == 0 && !p.hugsPrimary();
  double main = 0, cross = 0;
  std::vector<Guid> kids = flowChildren(frame);
  if (!wrap) {
    bool baseline = P == 0 && p.stackCounterAlignItems == StackAlign::BASELINE;
    double above = 0, below = 0;
    for (size_t i = 0; i < kids.size(); i++) {
      const NodeProps& cp = doc_.get(kids[i])->props;
      Vec2 s = natural(kids[i]);
      Rect b = layoutBox(cp.transform, s);
      main += (P == 0 ? b.w : b.h) + (i ? gap : 0);
      cross = std::max(cross, C == 0 ? b.w : b.h);
      if (baseline) {
        double base = baselineOf(kids[i], s);
        above = std::max(above, base);
        below = std::max(below, b.h - base);
      }
    }
    if (baseline) cross = std::max(cross, above + below);
  } else {
    double avail = axis(frameSize, P) - padP;
    double lineMain = 0, lineCross = 0;
    int inLine = 0, lines = 0;
    for (Guid c : kids) {
      const NodeProps& cp = doc_.get(c)->props;
      Rect b = layoutBox(cp.transform, natural(c));
      double bp = P == 0 ? b.w : b.h, bc = C == 0 ? b.w : b.h;
      if (inLine && lineMain + gap + bp > avail + kEps) {
        cross += lineCross + (lines ? counterGap : 0);
        main = std::max(main, lineMain);
        lines++;
        lineMain = 0;
        lineCross = 0;
        inLine = 0;
      }
      lineMain += (inLine ? gap : 0) + bp;
      lineCross = std::max(lineCross, bc);
      inLine++;
    }
    if (inLine) {
      cross += lineCross + (lines ? counterGap : 0);
      main = std::max(main, lineMain);
    }
  }
  Vec2 out;
  setAxis(out, P, main + padP);
  setAxis(out, C, cross + padC);
  return out;
}

// ---- Place --------------------------------------------------------------------------

std::vector<Layout::Placement> Layout::place(Guid frame, Vec2 size) {
  const NodeProps& p = doc_.get(frame)->props;
  int P = p.stackMode == StackMode::HORIZONTAL ? 0 : 1, C = 1 - P;
  double pad[4];
  padding(p, pad);
  double padP0 = P == 0 ? pad[0] : pad[1], padP1 = P == 0 ? pad[2] : pad[3];
  double padC0 = C == 0 ? pad[0] : pad[1], padC1 = C == 0 ? pad[2] : pad[3];
  double innerP = axis(size, P) - padP0 - padP1, innerC = axis(size, C) - padC0 - padC1;
  double gap = p.stackSpacing, counterGap = p.stackCounterSpacing.value_or(p.stackSpacing);
  bool wrap = p.stackWrap == StackWrap::WRAP && P == 0 && !p.hugsPrimary();

  struct Item {
    Guid id;
    Vec2 size;              // the node's size
    double bp = 0, bc = 0;  // its layout box along the axes
    double grow = 0;
    bool stretch = false;
    bool aligned = true;
    double pos = 0, cpos = 0;
  };
  std::vector<Item> items;
  for (Guid c : flowChildren(frame)) {
    const NodeProps& cp = doc_.get(c)->props;
    Item it;
    it.id = c;
    it.size = natural(c);
    it.aligned = axisAligned(cp.transform);
    Rect b = layoutBox(cp.transform, it.size);
    it.bp = P == 0 ? b.w : b.h;
    it.bc = C == 0 ? b.w : b.h;
    it.grow = cp.stackChildPrimaryGrow > 0 && !p.hugsPrimary() && it.aligned && !cp.fitsChildren() ? cp.stackChildPrimaryGrow : 0;
    it.stretch = cp.stackChildAlignSelf == StackCounterAlign::STRETCH && it.aligned && !cp.fitsChildren();
    if (it.stretch && C == 0 && !wrap && cp.type == NodeType::TEXT) {
      // Stretched across a vertical flow: the text wraps at the frame's inner width, its height follows.
      it.size = natural(c, std::max(0.0, innerC), -1);
      Rect b2 = layoutBox(cp.transform, it.size);
      it.bp = b2.h;
    }
    items.push_back(it);
  }

  // Lines (one unless wrapping).
  std::vector<std::pair<size_t, size_t>> lines;  // [begin, end)
  if (!wrap) {
    lines.push_back({0, items.size()});
  } else {
    size_t begin = 0;
    double lineMain = 0;
    for (size_t i = 0; i < items.size(); i++) {
      if (i > begin && lineMain + gap + items[i].bp > innerP + kEps) {
        lines.push_back({begin, i});
        begin = i;
        lineMain = 0;
      }
      lineMain += (i > begin ? gap : 0) + items[i].bp;
    }
    if (begin < items.size()) lines.push_back({begin, items.size()});
  }

  // Primary axis, line by line: Fill shares what's left (frozen at min/max, CSS flex style), then justify.
  std::vector<double> lineCross;
  for (auto [b, e] : lines) {
    size_t k = e - b;
    double fixed = 0, growTotal = 0;
    for (size_t i = b; i < e; i++) {
      if (items[i].grow > 0) growTotal += items[i].grow;
      else fixed += items[i].bp;
    }
    double gaps = k > 1 ? gap * static_cast<double>(k - 1) : 0;
    if (growTotal > 0) {
      std::vector<bool> frozen(k, false);
      double remaining = innerP - fixed - gaps;
      for (int round = 0; round < 8; round++) {
        double share = 0, weights = 0;
        for (size_t i = b; i < e; i++)
          if (items[i].grow > 0 && !frozen[i - b]) weights += items[i].grow;
        if (weights <= 0) break;
        share = remaining / weights;
        bool changed = false;
        for (size_t i = b; i < e; i++) {
          if (items[i].grow <= 0 || frozen[i - b]) continue;
          const NodeProps& cp = doc_.get(items[i].id)->props;
          double want = std::max(0.0, share * items[i].grow);
          double got = clampSize(want, cp, P);
          items[i].bp = got;
          if (got != want) {
            frozen[i - b] = true;
            remaining -= got;
            changed = true;
          }
        }
        if (!changed) break;
      }
      for (size_t i = b; i < e; i++)
        if (items[i].grow > 0) {
          setAxis(items[i].size, P, items[i].bp);
          // Its other axis may follow from this one (a wrapping frame's height from its width).
          const NodeProps& cp = doc_.get(items[i].id)->props;
          if ((cp.isAutoLayout() || (cp.type == NodeType::TEXT && P == 0)) && !items[i].stretch) {
            Vec2 n2 = natural(items[i].id, P == 0 ? items[i].bp : -1, P == 1 ? items[i].bp : -1);
            items[i].size = n2;
            setAxis(items[i].size, P, items[i].bp);
            items[i].bc = axis(n2, C);
          }
        }
    }
    double used = gaps;
    for (size_t i = b; i < e; i++) used += items[i].bp;
    double free = innerP - used, start = 0, g = gap;
    switch (p.stackPrimaryAlignItems) {
      case StackJustify::CENTER: start = free / 2; break;
      case StackJustify::MAX: start = free; break;
      case StackJustify::SPACE_BETWEEN:
        if (k > 1 && !p.hugsPrimary()) g = std::max(0.0, (innerP - (used - gaps)) / static_cast<double>(k - 1));
        break;
      case StackJustify::SPACE_EVENLY:
      case StackJustify::SPACE_EVENLY_CSS:
        if (!p.hugsPrimary()) {
          g = std::max(0.0, (innerP - (used - gaps)) / static_cast<double>(k + 1));
          start = g;
        }
        break;
      case StackJustify::SPACE_AROUND:
        if (!p.hugsPrimary() && k > 0) {
          g = std::max(0.0, (innerP - (used - gaps)) / static_cast<double>(k));
          start = g / 2;
        }
        break;
      default: break;
    }
    double at = padP0 + start;
    double cross = 0;
    for (size_t i = b; i < e; i++) {
      items[i].pos = at;
      at += items[i].bp + g;
      cross = std::max(cross, items[i].bc);
    }
    lineCross.push_back(cross);
  }

  // Counter axis: lines as a block (wrap), each item aligned within its line.
  double total = 0;
  for (double c : lineCross) total += c;
  double cg = counterGap, start = 0;
  if (wrap) {
    size_t L = lines.size();
    total += L > 1 ? counterGap * static_cast<double>(L - 1) : 0;
    if (p.stackCounterAlignContent == StackCounterAlignContent::SPACE_BETWEEN && L > 1) {
      double sum = 0;
      for (double c : lineCross) sum += c;
      cg = std::max(0.0, (innerC - sum) / static_cast<double>(L - 1));
      start = 0;
    } else {
      start = (innerC - total) * alignFactor(p.stackCounterAlignItems);
    }
  }
  double lineTop = padC0 + start;
  const bool baseline = P == 0 && p.stackCounterAlignItems == StackAlign::BASELINE;
  for (size_t l = 0; l < lines.size(); l++) {
    double room = wrap ? lineCross[l] : innerC;
    // Align text baseline: the line's items share their first baselines.
    double maxBase = 0;
    std::vector<double> bases;
    if (baseline) {
      for (size_t i = lines[l].first; i < lines[l].second; i++) {
        bases.push_back(baselineOf(items[i].id, items[i].size));
        maxBase = std::max(maxBase, bases.back());
      }
    }
    for (size_t i = lines[l].first; i < lines[l].second; i++) {
      Item& it = items[i];
      const NodeProps& cp = doc_.get(it.id)->props;
      if (baseline && !it.stretch && (cp.stackChildAlignSelf == StackCounterAlign::AUTO || cp.stackChildAlignSelf == StackCounterAlign::BASELINE)) {
        it.cpos = lineTop + maxBase - bases[i - lines[l].first];
        continue;
      }
      if (it.stretch) {
        it.bc = clampSize(room, cp, C);
        setAxis(it.size, C, it.bc);
        it.cpos = lineTop;
      } else {
        it.cpos = lineTop + (room - it.bc) * selfFactor(cp.stackChildAlignSelf, p.stackCounterAlignItems);
      }
    }
    lineTop += (wrap ? lineCross[l] + cg : 0);
  }

  std::vector<Placement> out;
  out.reserve(items.size());
  for (const Item& it : items) {
    Placement pl;
    pl.id = it.id;
    pl.size = it.size;
    if (it.aligned) {
      // Back from the layout box to the node's size (its transform may flip it, never scale it).
      const NodeProps& cp = doc_.get(it.id)->props;
      double sx = std::fabs(cp.transform.m00), sy = std::fabs(cp.transform.m11);
      double bw = P == 0 ? it.bp : it.bc, bh = P == 0 ? it.bc : it.bp;
      pl.size = {sx > 0 ? bw / sx : it.size.x, sy > 0 ? bh / sy : it.size.y};
    }
    setAxis(pl.position, P, it.pos);
    setAxis(pl.position, C, it.cpos);
    out.push_back(pl);
  }
  return out;
}

// ---- Arrange ------------------------------------------------------------------------

void Layout::arrange(Guid id, Vec2 size, bool sizeFromParent) {
  const Node* n = doc_.get(id);
  if (!n) return;
  NodeProps p = n->props;  // a copy: writes below change the node
  if (p.isAutoLayout()) {
    if (!sizeFromParent) size = natural(id);
    if (!sameSize(size, p.size)) host_.writeGeometry(id, p.transform, size);
    arrangeAutoLayout(id, size);
    applyConstraints(id, false);  // absolute children follow the frame
  } else if (p.fitsChildren()) {
    for (Guid c : std::vector<Guid>(doc_.children(id))) {
      const Node* cn = doc_.get(c);
      if (cn && (cn->props.isAutoLayout() || cn->props.fitsChildren() || cn->props.isFrameLike())) arrange(c, natural(c), false);
    }
    fitGroup(id);
  } else {
    if (!sizeFromParent) {
      if (p.type == NodeType::TEXT) size = natural(id);
      size = clampSize(size, p);
    }
    Mat2x3 t = p.transform;
    if (p.type == NodeType::TEXT && !sizeFromParent && p.textAutoResize == TextAutoResize::WIDTH_AND_HEIGHT &&
        std::fabs(size.x - p.size.x) > kEps) {
      // An auto-width text grows from the side its alignment holds (centre, right).
      double f = p.textAlignHorizontal == TextAlignHorizontal::CENTER ? 0.5 : p.textAlignHorizontal == TextAlignHorizontal::RIGHT ? 1 : 0;
      Vec2 shift = t.applyLinear({(p.size.x - size.x) * f, 0});
      t.m02 += shift.x;
      t.m12 += shift.y;
    }
    if (!sameSize(size, p.size) || !(t == p.transform)) host_.writeGeometry(id, t, size);
    if (p.isFrameLike()) applyConstraints(id, true);
  }
}

void Layout::arrangeAutoLayout(Guid id, Vec2 size) {
  const NodeProps p = doc_.get(id)->props;
  for (const Placement& pl : place(id, size)) {
    const Node* cn = doc_.get(pl.id);
    if (!cn || host_.placedByGesture(pl.id)) continue;
    const NodeProps& cp = cn->props;
    bool decided = (cp.stackChildPrimaryGrow > 0 && !p.hugsPrimary()) || cp.stackChildAlignSelf == StackCounterAlign::STRETCH;
    // The child's own layout first (its children, its group fitting)…
    if (cp.isAutoLayout() || cp.fitsChildren() || cp.isFrameLike()) arrange(pl.id, pl.size, decided || !cp.isAutoLayout());
    else if (!sameSize(pl.size, cp.size)) host_.writeGeometry(pl.id, cp.transform, pl.size);
    // …then its place: the layout box's top-left at the placement.
    const NodeProps& now = doc_.get(pl.id)->props;
    Mat2x3 linear = now.transform;
    linear.m02 = linear.m12 = 0;
    Rect b = layoutBox(linear, now.size);
    Mat2x3 t = now.transform;
    t.m02 = pl.position.x - b.x;
    t.m12 = pl.position.y - b.y;
    host_.writeGeometry(pl.id, t, now.size);
  }
}

void Layout::applyConstraints(Guid frame, bool flowChildrenToo) {
  Vec2 oldSize;
  if (!host_.resizedInTxn(frame, oldSize)) return;
  const NodeProps fp = doc_.get(frame)->props;
  Vec2 newSize = fp.size;
  bool ignore = host_.ignoreConstraints(frame);
  for (Guid c : std::vector<Guid>(doc_.children(frame))) {
    const Node* cn = doc_.get(c);
    if (!cn) continue;
    const NodeProps& cp = cn->props;
    if (host_.excludedFromFlow(c)) continue;  // being dragged: the gesture places it
    if (!flowChildrenToo && fp.isAutoLayout() && cp.inFlow()) continue;
    Mat2x3 t0;
    Vec2 s0;
    host_.base(c, t0, s0);
    Rect b0 = layoutBox(t0, s0);
    double x1, w1, y1, h1;
    constrain(ignore ? ConstraintType::MIN : cp.horizontalConstraint, b0.x, b0.w, oldSize.x, newSize.x, x1, w1);
    constrain(ignore ? ConstraintType::MIN : cp.verticalConstraint, b0.y, b0.h, oldSize.y, newSize.y, y1, h1);
    Vec2 s1 = s0;
    if (axisAligned(t0)) {
      double sx = std::fabs(t0.m00), sy = std::fabs(t0.m11);
      if (sx > 0) s1.x = w1 / sx;
      if (sy > 0) s1.y = h1 / sy;
    }
    Mat2x3 linear = t0;
    linear.m02 = linear.m12 = 0;
    Rect b1 = layoutBox(linear, s1);
    Mat2x3 t1 = t0;
    t1.m02 = x1 - b1.x;
    t1.m12 = y1 - b1.y;
    Vec2 before = cp.size;
    host_.writeGeometry(c, t1, s1);
    // A child that changed size lays out its own content in turn.
    const NodeProps& now = doc_.get(c)->props;
    if (!sameSize(before, s1) || !sameSize(s0, s1)) {
      if (now.isAutoLayout()) arrange(c, s1, true);
      else if (now.isFrameLike()) applyConstraints(c, true);
    }
  }
}

void Layout::fitGroup(Guid id) {
  const auto kids = std::vector<Guid>(doc_.children(id));
  if (kids.empty()) return;  // an empty group is deleted when the transaction commits
  bool any = false;
  Rect u;
  for (Guid c : kids) {
    const NodeProps& cp = doc_.get(c)->props;
    Rect b = layoutBox(cp.transform, cp.size);
    u = any ? u.united(b) : b;
    any = true;
  }
  const NodeProps gp = doc_.get(id)->props;
  if (std::fabs(u.x) < kEps && std::fabs(u.y) < kEps && std::fabs(u.w - gp.size.x) < kEps && std::fabs(u.h - gp.size.y) < kEps) return;
  // The group's box becomes the union; the children shift so nothing moves on the page.
  Mat2x3 t = gp.transform;
  Vec2 shift = gp.transform.applyLinear({u.x, u.y});
  t.m02 += shift.x;
  t.m12 += shift.y;
  host_.writeGeometry(id, t, {u.w, u.h});
  for (Guid c : kids) {
    const NodeProps cp = doc_.get(c)->props;
    Mat2x3 ct = cp.transform;
    ct.m02 -= u.x;
    ct.m12 -= u.y;
    host_.writeGeometry(c, ct, cp.size);
  }
}

void Layout::settle(Guid id) {
  memo_.clear();
  const Node* n = doc_.get(id);
  if (n) arrange(id, n->props.size, false);
  memo_.clear();
}

void Layout::constrainChildren(Guid frame) {
  memo_.clear();
  if (doc_.has(frame)) applyConstraints(frame, true);
  memo_.clear();
}

void Layout::run(const std::vector<Guid>& dirty) {
  memo_.clear();
  std::unordered_set<Guid, GuidHash> roots;
  for (Guid d : dirty) {
    if (!doc_.has(d)) continue;
    Guid r = d;
    for (int guard = 0; guard < 10000; guard++) {
      Guid parent = doc_.parentOf(r);
      const Node* pn = doc_.get(parent);
      if (!pn || !(pn->props.isAutoLayout() || pn->props.fitsChildren())) break;
      r = parent;
    }
    roots.insert(r);
  }
  std::vector<Guid> ordered;
  for (Guid r : roots) {
    bool nested = false;
    for (Guid a = doc_.parentOf(r); a != kNoGuid && !nested; a = doc_.parentOf(a)) nested = roots.count(a) != 0;
    if (!nested) ordered.push_back(r);
  }
  std::sort(ordered.begin(), ordered.end());  // deterministic
  for (Guid r : ordered) {
    const Node* n = doc_.get(r);
    if (!n) continue;
    arrange(r, n->props.size, false);
    memo_.clear();
  }
}

}  // namespace eng
