// Renderer::renderScene: the presentation view's frames (render/PresentScene.h), drawn by the canvas's own code paths.

#include <cmath>

#include "render/Renderer.h"
#include "text/Fonts.h"

namespace eng {

RenderStats Renderer::renderScene(const Document& doc, Guid page, const Viewport& viewport, const PresentScene& scene, gfx::TargetId target) {
  ensurePipelines();
  frame_++;
  doc_ = &doc;
  viewport_ = viewport;
  stats_ = {};
  curves_.beginFrame();
  if (rampData_.size() > static_cast<size_t>(256) * 4 * 2048) {
    rampRows_.clear();
    rampData_.clear();
    rampRowsUploaded_ = 0;
  }
  view_ = Mat2x3{};
  if (trees_.size() > 4 && !trees_.count(page)) trees_.clear();
  RenderTree& tree = trees_[page];
  uint32_t fontGeneration = text::FontRegistry::get().generation();
  if (fontGeneration != treeFonts_) {
    for (auto& [id, t] : trees_) t.invalidate();
    treeFonts_ = fontGeneration;
  }
  tree.setTextInk([this](Guid id, Rect& out) {
    const text::TextLayout* L = texts_ ? texts_->textLayout(id) : nullptr;
    if (!L) return false;
    out = L->inkBounds;
    return true;
  });
  tree.sync(doc, page);
  (void)tree.takeDamage();
  tree_ = &tree;
  const int W = viewport.deviceWidth(), H = viewport.deviceHeight();
  const Color& bg = scene.background;
  float clearColor[4] = {bg.r * bg.a, bg.g * bg.a, bg.b * bg.a, 1};
  beginRecording({0, 0, W, H}, false);
  cull_ = false;
  const double sx = viewport_.scaleX(), sy = viewport_.scaleY();
  for (const PresentItem& item : scene.items) {
    current_ = 0;
    round_ = RoundClip{};
    scissorEnabled_ = false;
    if (item.clip) {
      int x0 = static_cast<int>(std::floor(item.clipCss.x * sx)), y0 = static_cast<int>(std::floor(item.clipCss.y * sy));
      int x1 = static_cast<int>(std::ceil(item.clipCss.right() * sx)), y1 = static_cast<int>(std::ceil(item.clipCss.bottom() * sy));
      scissorEnabled_ = true;
      scissor_ = {x0, y0, std::max(0, x1 - x0), std::max(0, y1 - y0)};
      if (item.clipRadius > 0) {
        // A device's screen: its rounded corners (the same anti-aliased rounded clip as a frame's).
        round_.on = true;
        round_.rect[0] = static_cast<float>(item.clipCss.x * sx);
        round_.rect[1] = static_cast<float>(item.clipCss.y * sy);
        round_.rect[2] = static_cast<float>(item.clipCss.right() * sx);
        round_.rect[3] = static_cast<float>(item.clipCss.bottom() * sy);
        for (float& r : round_.radii) r = static_cast<float>(item.clipRadius * sx);
      }
    }
    if (item.kind == PresentItem::Kind::Rect) {
      CornerRadii r{item.radius, item.radius, item.radius, item.radius};
      emit(makeShape(Mat2x3::translate(item.rect.x, item.rect.y), {item.rect.w, item.rect.h}, ShapeKind::Rect, r, item.color, item.alpha,
                     item.borderColor, item.border > 0 ? item.alpha : 0, item.border, 0),
           Pass::Shape);
      continue;
    }
    int i = tree.indexOf(item.node);
    if (i < 0) continue;
    overrides_ = item.overrides;
    drawChildren(doc, static_cast<uint32_t>(i), tree.nodes()[static_cast<size_t>(i)].end, item.parentCss, 1);
    overrides_ = nullptr;
  }
  cull_ = true;
  current_ = 0;
  scissorEnabled_ = false;
  round_ = RoundClip{};
  finishRecording(target, clearColor, false);
  device_.submit();
  dropIdleTargets();
  images_.endFrame();
  return stats_;
}

}  // namespace eng
