// Renderer::renderScene: the presentation view's frames (render/PresentScene.h), drawn by the canvas's own code paths.

#include <cmath>

#include "render/Renderer.h"
#include "text/Fonts.h"

namespace eng {

RenderStats Renderer::renderScene(const Document& doc, Guid page, const Viewport& viewport, const PresentScene& scene, gfx::TargetId target) {
  ensurePipelines();
  frame_++;
  // A prototype never shows frames' layout grids (Figma's viewer; the owner's "Prototype deneme" drew its 12 columns
  // over every screen). The editor's own setting comes back after this frame.
  struct Guides {
    bool& on;
    bool was;
    ~Guides() { on = was; }
  } guides{layoutGuides_, layoutGuides_};
  layoutGuides_ = false;
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
  uint32_t fontGeneration = text::FontRegistry::get().generation();
  if (fontGeneration != treeFonts_) {
    for (auto& [id, t] : trees_) t.invalidate();
    for (auto& [id, t] : screenTrees_) t.invalidate();
    treeFonts_ = fontGeneration;
  }
  // Each item's screen (the layer under the page, or under a section) has a tree of its own: a frame shown costs its
  // own layers, not the whole page's — a heavy page's first frame, and a screen derived later (Editor::deriveTree),
  // don't rebuild the page's tree.
  auto screenOf = [&](Guid id) {
    Guid s = id;
    for (Guid p = doc.parentOf(s); p != kNoGuid; p = doc.parentOf(p)) {
      const Node* pn = doc.get(p);
      if (!pn || pn->props.type == NodeType::CANVAS || pn->props.type == NodeType::SECTION) break;
      s = p;
    }
    return s;
  };
  auto treeOf = [&](Guid screen) -> RenderTree& {
    if (screenTrees_.size() > 16 && !screenTrees_.count(screen)) screenTrees_.clear();
    RenderTree& tree = screenTrees_[screen];
    tree.setTextInk([this](Guid id, Rect& out) {
      const text::TextLayout* L = texts_ ? texts_->textLayout(id) : nullptr;
      if (!L) return false;
      out = L->inkBounds;
      return true;
    });
    tree.sync(doc, page, screen);
    (void)tree.takeDamage();
    return tree;
  };
  static const RenderTree kNoTree;
  tree_ = &kNoTree;  // until an item's screen is drawn
  const int W = viewport.deviceWidth(), H = viewport.deviceHeight();
  const Color& bg = scene.background;
  float clearColor[4] = {bg.r * bg.a, bg.g * bg.a, bg.b * bg.a, 1};
  beginRecording({0, 0, W, H}, false);
  cull_ = false;
  const double sx = viewport_.scaleX(), sy = viewport_.scaleY();
  sceneScrollbars_ = &scene.scrollbars;
  for (const PresentItem& item : scene.items) {
    current_ = 0;
    round_ = RoundClip{};
    scissorEnabled_ = false;
    if (item.clip) {
      int x0 = static_cast<int>(std::floor(item.clipCss.x * sx)), y0 = static_cast<int>(std::floor(item.clipCss.y * sy));
      int x1 = static_cast<int>(std::ceil(item.clipCss.right() * sx)), y1 = static_cast<int>(std::ceil(item.clipCss.bottom() * sy));
      scissorEnabled_ = true;
      scissor_ = {x0, y0, std::max(0, x1 - x0), std::max(0, y1 - y0)};
      // The screen's edge, exact (anti-aliased); a rounded screen's own clip does it when it has corners.
      clipRect_[0] = static_cast<float>(item.clipCss.x * sx), clipRect_[1] = static_cast<float>(item.clipCss.y * sy);
      clipRect_[2] = static_cast<float>(item.clipCss.right() * sx), clipRect_[3] = static_cast<float>(item.clipCss.bottom() * sy);
      if (item.clipRadius > 0) clipRect_[0] = clipRect_[1] = -1e9f, clipRect_[2] = clipRect_[3] = 1e9f;
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
                     item.borderColor, item.border > 0 ? (item.borderAlpha >= 0 ? item.borderAlpha : item.alpha) : 0, item.border, 0),
           Pass::Shape);
      continue;
    }
    if (!doc.has(item.node)) continue;
    RenderTree& tree = treeOf(screenOf(item.node));
    tree_ = &tree;
    int i = tree.indexOf(item.node);
    if (i < 0) continue;
    overrides_ = item.overrides;
    drawChildren(doc, static_cast<uint32_t>(i), tree.nodes()[static_cast<size_t>(i)].end, item.parentCss, 1);
    overrides_ = nullptr;
  }
  sceneScrollbars_ = nullptr;
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
