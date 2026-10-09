#include "render/FrameTitles.h"

#include <algorithm>
#include <cmath>

namespace eng {

bool showsTitle(const Document& doc, Guid id) {
  const Node* n = doc.get(id);
  if (!n || !n->props.isFrameLike()) return false;
  const Node* p = doc.get(n->props.parentIndex.guid);
  return p && (p->props.type == NodeType::CANVAS || p->props.type == NodeType::SECTION);
}

std::vector<FrameTitle> frameTitles(const Document& doc, Guid page, const Mat2x3& view, const Rect& screen, const OverlayStyle& style,
                                    const std::function<double(const std::string&, bool)>& measure, Guid focus) {
  std::vector<FrameTitle> out;
  Rect near{screen.x - 200, screen.y - 40, screen.w + 400, screen.h + 80};
  auto visit = [&](auto&& self, Guid parent) -> void {
    for (Guid c : doc.children(parent)) {
      const Node* n = doc.get(c);
      if (!n || !n->props.visible || !n->props.isFrameLike()) continue;
      bool section = n->props.type == NodeType::SECTION;
      if (focus != kNoGuid && focus != c && !section) continue;
      Rect b = transformedBounds(view * doc.worldTransform(c), n->props.size.x, n->props.size.y);
      if (b.intersects(near)) {
        FrameTitle t;
        t.id = c;
        t.section = section;
        t.frame = b;
        if (section) {
          // The pill above the section's top-left corner (live Figma), its width capped at the section's.
          double w = measure(n->props.name, true);
          double pw = std::min(std::ceil(w) + 2 * style.sectionPillPadding, b.w);
          double y = b.y - style.sectionPillGap - style.sectionPillHeight;
          t.text = {b.x + style.sectionPillPadding, y, std::max(0.0, pw - 2 * style.sectionPillPadding), style.sectionPillHeight};
          t.hit = {b.x, y, std::max(0.0, pw), style.sectionPillHeight};
          t.baseline = y + style.sectionPillHeight / 2 + style.sectionTitleSize * 0.36;
          if (pw >= 8) out.push_back(t);
        } else if (b.w >= 12 && n->props.type != NodeType::INSTANCE) {
          // The name above the frame, from its left edge, as wide as the frame at most. A top-level instance has none,
          // selected or not (live Figma round 11: canvas-instance-selected; menu-context-main-component and
          // menu-context-multi-and-smart-selection show the unselected "Button instance" and "Chip instance" bare under
          // the main component's "❖ Button").
          t.icon = n->props.isComponentish() ? TitleIcon::Component : TitleIcon::None;
          double x = b.x;
          t.baseline = b.y - style.titleBaselineGap;
          if (t.icon != TitleIcon::None) {
            const double s = style.titleIconSize;
            t.iconBox = {x, t.baseline - s + 1, s, s};
            x += s + style.titleIconGap;
          }
          double w = std::min(measure(n->props.name, false), std::max(0.0, b.right() - x));
          double ascent = style.titleSize * 0.97, descent = style.titleSize * 0.25;
          t.text = {x, t.baseline - ascent, w, ascent + descent};
          // A press takes the title's line from the frame's left edge (2 px of slack around it).
          t.hit = {b.x, t.baseline - ascent - 2, std::max(x + w - b.x, 8.0), ascent + descent + 4};
          out.push_back(t);
        }
      }
      if (section) self(self, c);
    }
  };
  visit(visit, page);
  return out;
}

}  // namespace eng
