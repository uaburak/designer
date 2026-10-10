// Auto layout's padding and gap handles on the canvas (round 15; live Figma, the owner's recording and screenshots —
// docs/research/figma/live/behaviour/spacing-handles.md, help.figma.com "Explore auto layout properties"):
//
// - A selected auto-layout frame with the pointer over it shows a short bar (handle) in the middle of each padding
//   (blue) and each gap (pink). The padding or gap under the pointer is hatched in its colour; the arrow stays.
// - Over a bar: the spacing cursor (a double arrow across a bar, along the drag) and the value in a badge right of and
//   above the pointer. A drag changes the value 1:1 (a gap keeps its bar under the pointer: ½ a gap per gap before
//   it), every other bar gone and the dragged padding / gap outlined 1 px; ⌥ the opposite padding too, ⌥⇧ all four,
//   ⇧ steps of the big nudge (10). Gaps may go negative (the layers overlap), paddings stop at 0. A click edits the
//   value in place (REQUEST_INLINE_EDIT); ⌥-click on a padding edits its pair, ⌥⇧-click all four.
// - An Auto gap (space between) reads "Auto"; dragging it makes it a number.
// - A turned frame's handles turn with it. A grid shows its paddings' bars; its gaps are GridGestures.cpp's.

#include <algorithm>
#include <cmath>

#include "editor/Editor.h"
#include "layout/Layout.h"
#include "render/OverlayStyle.h"

namespace eng {

namespace {

bool axisAligned(const Mat2x3& m) { return std::fabs(m.m01) < 1e-9 && std::fabs(m.m10) < 1e-9; }
double dot(Vec2 a, Vec2 b) { return a.x * b.x + a.y * b.y; }
Vec2 unit(Vec2 v) {
  double l = v.length();
  return l > 1e-12 ? Vec2{v.x / l, v.y / l} : Vec2{1, 0};
}

// The handle: 12 px along its bar, a press within 4 px past its ends and 5 px either side of it takes it (unverified:
// the recording shows the pointer on the bar taking it and ~17 px off it not).
constexpr double kBarHalfLength = 6, kHitAlong = 4, kHitAcross = 5;
// Below this size on screen (either way) a frame shows no handles (unverified; Figma hides them on small frames).
constexpr double kMinFrameOnScreen = 24;

void quadOf(const Mat2x3& W, const Rect& r, Vec2 out[4]) {
  out[0] = W.apply({r.x, r.y});
  out[1] = W.apply({r.right(), r.y});
  out[2] = W.apply({r.right(), r.bottom()});
  out[3] = W.apply({r.x, r.bottom()});
}

}  // namespace

void Editor::updateAutoLayoutBands(Vec2 world) {
  std::vector<Rect> bands;
  std::vector<Overlay::LayoutBar> bars;
  std::vector<Overlay::SpacingArea> areas;
  int hovered = -1, bandHover = -1;
  GridGapHover gap;
  bool dragging = gesture_ == Gesture::LayoutBar;
  if ((gesture_ == Gesture::None || dragging) && tool_ == Tool::MOVE && !spaceHeld_ && selection_.size() == 1 && !viewer_) {
    Guid id = selection_[0];
    const Node* n = doc_.get(id);
    Mat2x3 W = doc_.worldTransform(id);
    double det = W.m00 * W.m11 - W.m01 * W.m10;
    bool grid = n && n->props.stack().stackMode == StackMode::GRID;
    bool upright = axisAligned(W) && W.m00 > 0 && W.m11 > 0;
    // A grid too: its paddings' bars (live Figma, canvas-grid-frame-selected: the mid-edge bars), no gap bars — the
    // pointer in a gap outlines that axis's gaps instead (round 12, grid-selected-hover-gap; gridGapOverlay). A turned
    // frame's handles turn with it (round 15, the recording at 34 s); a turned grid shows none.
    if (n && n->props.isAutoLayout() && std::fabs(det) > 1e-12 && (!grid || upright) && !n->props.locked && !id.isDerived()) {
      const NodeProps& p = n->props;
      Vec2 q = W.inverse().apply(world);
      double w = p.size.x, h = p.size.y;
      const Mat2x3 S = camera_.matrix() * W;  // the frame's space → screen
      Vec2 onScreen{w * Vec2{S.m00, S.m10}.length(), h * Vec2{S.m01, S.m11}.length()};
      bool big = onScreen.x >= kMinFrameOnScreen && onScreen.y >= kMinFrameOnScreen;
      // A grid's bars also while the pointer is on its pills' bands (live Figma, canvas-grid-hover-top-pill).
      bool onPills = grid && gesture_ == Gesture::None && gridHitAt(camera_.toScreen(world)).kind != GridHit::Kind::None;
      if ((dragging || onPills || (q.x >= 0 && q.y >= 0 && q.x <= w && q.y <= h)) && (big || dragging)) {
        int P = p.stack().stackMode == StackMode::HORIZONTAL ? 0 : 1;
        double pad[4];
        Layout::padding(p, pad);
        const double own[4] = {p.stack().stackPaddingLeft, p.stack().stackPaddingTop, p.stack().stackPaddingRight, p.stack().stackPaddingBottom};
        auto inside = [&](const Rect& r) { return r.w > 0 && r.h > 0 && r.contains(q); };
        bool onChild = false;
        std::vector<Rect> boxes;
        for (Guid c : Layout(*this).flowChildren(id)) {
          const NodeProps& cp = doc_.get(c)->props;
          boxes.push_back(layoutBox(cp.transform, cp.size));
          onChild |= boxes.back().contains(q);
        }
        bool between = p.stack().stackPrimaryAlignItems == StackJustify::SPACE_BETWEEN;
        // Each gap between consecutive layers, across the content box; a negative gap is where they overlap, a zero gap
        // a line.
        std::vector<Rect> gaps;
        for (size_t i = 1; i < boxes.size() && p.stack().stackWrap != StackWrap::WRAP && !grid; i++) {
          const Rect& a = boxes[i - 1];
          const Rect& b = boxes[i];
          if (P == 0) gaps.push_back({std::min(a.right(), b.x), pad[1], std::fabs(b.x - a.right()), h - pad[1] - pad[3]});
          else gaps.push_back({pad[0], std::min(a.bottom(), b.y), w - pad[0] - pad[2], std::fabs(b.y - a.bottom())});
        }
        Rect sides[4] = {{0, 0, pad[0], h}, {0, 0, w, pad[1]}, {w - pad[2], 0, pad[2], h}, {0, h - pad[3], w, pad[3]}};
        int band = -1;  // 0..3 a side, 4 + i a gap
        // A grid's gap under the pointer, or the one being dragged: its axis's gaps, no bars (live Figma: the padding
        // bars give way, grid-selected-hover-gap).
        if (grid && dragging && gridGap_.axis >= 0 && gridGap_.frame == id) gap = gridGap_;
        else if (grid && !dragging && !onChild && q.x >= 0 && q.y >= 0 && q.x <= w && q.y <= h) gap = gridGapAt(id, q);
        if (gap.axis >= 0) {
          for (const GridGapBox& b : gridGapBoxes(id, gap.axis)) bands.push_back(b.rect);
        } else if (dragging) {
          band = layoutBar_;
        } else if (!onChild) {
          for (size_t i = 0; i < gaps.size() && band < 0; i++)
            if (inside(gaps[i])) band = 4 + static_cast<int>(i);
          for (int k = 0; k < 4 && band < 0; k++)
            if (inside(sides[k])) band = k;
        }
        // The bars: each side with padding, each gap — in the middle of the padding, at the middle of the content across
        // (live: the frame's middle); top / bottom bars run across the frame, left / right ones down it.
        std::vector<Overlay::LayoutBar> all;
        if (gap.axis < 0) {
          for (int k = 0; k < 4; k++) {
            if (pad[k] <= 0) continue;
            const Rect& r = sides[k];
            Overlay::LayoutBar bar;
            bar.side = k;
            bar.vertical = k == 0 || k == 2;
            Vec2 local{k == 0 ? r.w / 2 : k == 2 ? w - r.w / 2 : w / 2, k == 1 ? r.h / 2 : k == 3 ? h - r.h / 2 : h / 2};
            bar.at = W.apply(local);
            bar.edge = world;
            bar.axis = unit(W.applyLinear(bar.vertical ? Vec2{0, 1} : Vec2{1, 0}));
            bar.value = own[k];
            all.push_back(bar);
          }
          for (size_t i = 0; i < gaps.size(); i++) {
            const Rect& g = gaps[i];
            Overlay::LayoutBar bar;
            bar.gap = true;
            bar.index = static_cast<int>(i);
            bar.vertical = P == 0;
            bar.at = W.apply({g.x + g.w / 2, g.y + g.h / 2});
            bar.edge = world;
            bar.axis = unit(W.applyLinear(bar.vertical ? Vec2{0, 1} : Vec2{1, 0}));
            bar.autoGap = between;
            bar.value = between ? (P == 0 ? g.w : g.h) : p.stack().stackSpacing;
            all.push_back(bar);
          }
        }
        if (dragging) {
          // Only the dragged one's value, by the pointer; its padding or gap outlined.
          for (Overlay::LayoutBar bar : all) {
            int b = bar.gap ? 4 + bar.index : bar.side;
            if (b != layoutBar_) continue;
            bar.box = bar.hovered = true;
            bars.push_back(bar);
          }
          if (band >= 0 && gap.axis < 0) {
            Rect r = band >= 4 ? (static_cast<size_t>(band - 4) < gaps.size() ? gaps[static_cast<size_t>(band - 4)] : Rect{}) : sides[band];
            Overlay::SpacingArea a;
            quadOf(W, r, a.quad);
            a.gap = band >= 4;
            a.outline = true;
            areas.push_back(a);
          }
        } else {
          // The bar under the pointer (the nearest when two are), which also hatches its padding or gap.
          Vec2 s = camera_.toScreen(world);
          double best = 1e300;
          for (size_t i = 0; i < all.size(); i++) {
            Vec2 c = camera_.toScreen(all[i].at);
            Vec2 a = unit(camera_.matrix().applyLinear(all[i].axis));
            Vec2 d = s - c;
            double along = std::fabs(dot(d, a)), across = std::fabs(dot(d, Vec2{-a.y, a.x}));
            if (along > kBarHalfLength + kHitAlong || across > kHitAcross) continue;
            double dist = along + across;
            if (dist < best) best = dist, hovered = static_cast<int>(i);
          }
          if (hovered >= 0) {
            all[static_cast<size_t>(hovered)].hovered = true;
            band = all[static_cast<size_t>(hovered)].gap ? 4 + all[static_cast<size_t>(hovered)].index : all[static_cast<size_t>(hovered)].side;
          }
          if (big) bars = std::move(all);
          else hovered = -1;
          bandHover = gap.axis < 0 ? band : -1;
          if (band >= 0 && gap.axis < 0) {
            Rect r = band >= 4 ? gaps[static_cast<size_t>(band - 4)] : sides[band];
            if (r.w > 0 && r.h > 0) {
              Overlay::SpacingArea a;
              quadOf(W, r, a.quad);
              a.gap = band >= 4;
              areas.push_back(a);
            }
          }
        }
        if (gap.axis < 0) {
          if (band >= 4) bands = gaps;
          else if (band >= 0) bands.push_back(sides[band]);
        }
        for (auto& b : bands) b = transformedBounds(W * Mat2x3::translate(b.x, b.y), b.w, b.h);
      }
    }
  }
  if (!(bands.size() == bands_.size() && std::equal(bands.begin(), bands.end(), bands_.begin()))) needsRender_ = true;
  if (bars.size() != layoutBars_.size() || hovered != layoutBarHover_ || bandHover != layoutBandHover_ || areas.size() != spacingAreas_.size())
    needsRender_ = true;
  if (hovered >= 0 || dragging) needsRender_ = true;  // the badge follows the pointer
  if (gap.frame != gridGap_.frame || gap.axis != gridGap_.axis || gap.boundary != gridGap_.boundary || gap.cross != gridGap_.cross) needsRender_ = true;
  bands_ = std::move(bands);
  layoutBars_ = std::move(bars);
  spacingAreas_ = std::move(areas);
  layoutBarHover_ = hovered;
  layoutBandHover_ = bandHover;
  layoutBarsFrame_ = layoutBars_.empty() && spacingAreas_.empty() ? kNoGuid : selection_[0];
  gridGap_ = gap;
}

void Editor::startLayoutBar(int band) {
  const Node* n = doc_.get(selection_[0]);
  if (!n) return;
  begin(TxnKind::GESTURE, band >= 4 ? "Gap" : "Padding");
  layoutBar_ = band;
  layoutBarFrom_ = n->props.stack();
  // An Auto gap: the gap as laid out when the drag starts (it becomes that number, then follows the pointer).
  layoutBarGapFrom_ = n->props.stack().stackSpacing;
  for (const auto& bar : layoutBars_)
    if (bar.gap && 4 + bar.index == band) layoutBarGapFrom_ = bar.value;
  // A grid's gap (round 12): the gap between its columns or its rows.
  gridGapFrom_ = gridGap_.axis >= 0 && gridGap_.frame == selection_[0] ? Layout::gridGap(n->props, gridGap_.axis == 0) : 0;
  spacingCursor(downScreen_);
}

void Editor::dragLayoutBar(Vec2 world, uint32_t mods) {
  // A padding follows the pointer across its side; a gap's bar stays under the pointer (every gap changes alike), as
  // the smart selection's. help.figma.com: ⌥ the opposite padding too, ⌥⇧ all four, ⇧ the big nudge's steps.
  if (layoutBar_ < 0 || selection_.size() != 1) return;
  Guid id = selection_[0];
  Mat2x3 inv = doc_.worldTransform(id).inverse();
  Vec2 d = inv.applyLinear(world - downWorld_);
  const auto& from = layoutBarFrom_;
  const bool alt = (mods & MOD_ALT) != 0, shift = (mods & MOD_SHIFT) != 0;
  const double step = nudgeBig_ > 0 ? nudgeBig_ : 10;
  auto stepped = [&](double v) { return shift && !alt ? std::round(v / step) * step : std::round(v); };
  NodeChange c = NodeChange::changed(id);
  if (layoutBar_ >= 4 && gridGap_.axis >= 0 && gridGap_.frame == id) {
    // A grid's gap: every gap of the axis changes alike, the box under the pointer follows it as auto layout's gap bar
    // does (`boundary` + ½ gaps before its middle; unverified — live Figma has no capture of this drag).
    bool columns = gridGap_.axis == 0;
    double v = std::max(0.0, stepped(gridGapFrom_ + (columns ? d.x : d.y) / (static_cast<double>(gridGap_.boundary) + 0.5)));
    c.mask = F_EXTRA;
    c.props.extra = doc_.get(id)->props.extra;
    c.props.extra[columns ? "gridColumnGap" : "gridRowGap"] = Layout::gridGapBytes(columns, v);
    write(c);
    layoutDirty_.insert(id);
    flushLayout();
    updateAutoLayoutBands(world);
    needsRender_ = true;
    return;
  }
  if (layoutBar_ >= 4) {
    bool horizontal = from.stackMode == StackMode::HORIZONTAL;
    double along = horizontal ? d.x : d.y;
    double base = from.stackSpacing;
    if (from.stackPrimaryAlignItems == StackJustify::SPACE_BETWEEN) {
      // An Auto gap dragged becomes a number (from the gap as laid out when the drag started).
      base = layoutBarGapFrom_;
      c.mask |= F_STACK_PRIMARY_ALIGN;
      c.props.stack().stackPrimaryAlignItems = StackJustify::MIN;
    }
    // Negative gaps too (the layers overlap; live Figma, the recording at 8–10 s: −3, −16).
    c.mask |= F_STACK_SPACING;
    c.props.stack().stackSpacing = stepped(base + along / ((layoutBar_ - 4) + 0.5));
  } else {
    const double start[4] = {from.stackPaddingLeft, from.stackPaddingTop, from.stackPaddingRight, from.stackPaddingBottom};
    const double sign[4] = {d.x, d.y, -d.x, -d.y};
    double v = std::max(0.0, stepped(start[layoutBar_] + sign[layoutBar_]));
    bool sides[4] = {false, false, false, false};
    sides[layoutBar_] = true;
    if (alt) sides[(layoutBar_ + 2) % 4] = true;
    if (alt && shift) sides[0] = sides[1] = sides[2] = sides[3] = true;
    const FieldMask masks[4] = {F_STACK_PADDING_LEFT, F_STACK_PADDING_TOP, F_STACK_PADDING_RIGHT, F_STACK_PADDING_BOTTOM};
    double* fields[4] = {&c.props.stack().stackPaddingLeft, &c.props.stack().stackPaddingTop, &c.props.stack().stackPaddingRight, &c.props.stack().stackPaddingBottom};
    for (int k = 0; k < 4; k++) {
      *fields[k] = sides[k] ? v : start[k];
      c.mask |= masks[k];
    }
  }
  write(c);
  flushLayout();
  updateAutoLayoutBands(world);
  needsRender_ = true;
}

bool Editor::spacingCursor(Vec2 screen) {
  // Over a bar, or dragging one: Figma's spacing cursor — a double arrow across a short bar — along the drag on screen
  // (left / right paddings and a row's gaps: across; top / bottom and a column's: up and down; a turned frame's turned).
  (void)screen;
  int band = -1;
  if (gesture_ == Gesture::LayoutBar) band = layoutBar_;
  else if (gesture_ == Gesture::None && layoutBarHover_ >= 0 && static_cast<size_t>(layoutBarHover_) < layoutBars_.size()) {
    const Overlay::LayoutBar& b = layoutBars_[static_cast<size_t>(layoutBarHover_)];
    band = b.gap ? 4 + b.index : b.side;
  }
  if (band < 0 || selection_.size() != 1) return false;
  const Node* n = doc_.get(selection_[0]);
  if (!n) return false;
  bool acrossX;
  if (band >= 4 && gridGap_.axis >= 0 && gridGap_.frame == selection_[0]) acrossX = gridGap_.axis == 0;
  else if (band >= 4) acrossX = n->props.stack().stackMode == StackMode::HORIZONTAL;
  else acrossX = band == 0 || band == 2;
  Vec2 d = camera_.matrix().applyLinear(doc_.worldTransform(selection_[0]).applyLinear(acrossX ? Vec2{1, 0} : Vec2{0, 1}));
  double angle = std::round(std::atan2(d.y, d.x) * 180 / 3.14159265358979323846);
  changeCursor(CursorKind::SPACING, angle);
  return true;
}

void Editor::requestInlineEdit(int bar, int pair, Vec2 at) {
  if (selection_.size() != 1) return;
  const Node* n = doc_.get(selection_[0]);
  if (!n || !n->props.isAutoLayout()) return;
  const StackFacet& st = n->props.stack();
  InlineEdit e;
  e.node = selection_[0];
  static const char* kSides[4] = {"PADDING_LEFT", "PADDING_TOP", "PADDING_RIGHT", "PADDING_BOTTOM"};
  const double own[4] = {st.stackPaddingLeft, st.stackPaddingTop, st.stackPaddingRight, st.stackPaddingBottom};
  if (bar >= 4) {
    e.field = "GAP";
    e.value = st.stackSpacing;
    for (const Overlay::LayoutBar& b : layoutBars_)
      if (b.gap && b.index == bar - 4) e.value = b.value;  // an Auto gap: as laid out
  } else if (bar >= 0 && pair == 2) {
    e.field = "PADDING_ALL";
    e.value = own[bar];
  } else if (bar >= 0 && pair == 1) {
    e.field = bar == 0 || bar == 2 ? "PADDING_HORIZONTAL" : "PADDING_VERTICAL";
    e.value = own[bar];
  } else if (bar >= 0) {
    e.field = kSides[bar];
    e.value = own[bar];
  } else {
    return;
  }
  // Where the value's badge is: right of and above the pointer (render/SpacingOverlay.cpp).
  const OverlayStyle style = OverlayStyle::of(theme_);
  double w = std::max(40.0, labelWidth("0000", false) + 2 * style.badgePadding), h = std::max(style.badgeHeight, 20.0);
  if (at.x < 0) {
    for (const Overlay::LayoutBar& b : layoutBars_)
      if ((b.gap ? 4 + b.index : b.side) == bar) at = camera_.toScreen(b.at);
  }
  e.rect = {at.x + 10, at.y - 10 - h, w, h};
  events_.inlineEdits.push_back(e);
}

}  // namespace eng
