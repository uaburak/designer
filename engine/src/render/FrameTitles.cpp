#include "render/FrameTitles.h"

#include <algorithm>
#include <cmath>

#include "kiwi.h"

namespace eng {

LabelFrame labelFrame(const Mat2x3& toScreen, Vec2 size) {
  LabelFrame f;
  Vec2 u{toScreen.m00, toScreen.m10};
  double len = std::hypot(u.x, u.y);
  if (len < 1e-12) {
    // No x axis (a zero-width scale): the y axis turned a quarter back, else upright.
    u = {toScreen.m11, -toScreen.m01};
    len = std::hypot(u.x, u.y);
  }
  if (len >= 1e-12) {
    u = {u.x / len, u.y / len};
    const double eps = 1e-9;
    // Never upside down: reading leftwards (or straight down) is read the other way.
    if (u.x < -eps || (std::fabs(u.x) <= eps && u.y > 0)) u = {-u.x, -u.y};
    // Group 1 (2026-10-19; live Figma, the owner's recording autolayout-drag-06 / -08): a quarter turn (±90°, 270°)
    // keeps its labels level — the name above the on-screen top-left corner, the W × H badge centred under the
    // on-screen bottom edge — as an upright layer's; other angles turn them (round 15, 42.png at 37°).
    const bool quarter = std::fabs(u.x) <= 1e-6;
    if (std::fabs(u.y) > eps && !quarter) {
      f.upright = false;
      f.place = {u.x, -u.y, 0, u.y, u.x, 0};
    }
  }
  if (f.upright) {
    f.box = transformedBounds(toScreen, size.x, size.y);
    return f;
  }
  // The corners in label-local coordinates (the place's inverse: its transpose).
  const Mat2x3& m = f.place;
  Mat2x3 back{m.m00, m.m10, 0, m.m01, m.m11, 0};
  f.box = transformedBounds(back * toScreen, size.x, size.y);
  return f;
}

Guid thumbnailNode(const Document& doc) {
  const Node* root = doc.get(Guid{0, 0});
  if (!root) return kNoGuid;
  auto it = root->props.extra.find("thumbnailInfo");
  if (it == root->props.extra.end() || it->second.empty()) return kNoGuid;
  // NodeChange.thumbnailInfo = 466: ThumbnailInfo { GUID nodeID = 1; string thumbnailVersion = 2; }
  constexpr uint32_t kThumbnailInfoField = 466;
  kiwi::ByteBuffer bb(reinterpret_cast<const uint8_t*>(it->second.data()), it->second.size());
  uint32_t field = 0;
  if (!bb.readVarUint(field) || field != kThumbnailInfoField) return kNoGuid;
  for (;;) {
    uint32_t f = 0;
    if (!bb.readVarUint(f) || f == 0) return kNoGuid;
    if (f == 1) {
      Guid g;
      if (!bb.readVarUint(g.sessionID) || !bb.readVarUint(g.localID)) return kNoGuid;
      return doc.get(g) ? g : kNoGuid;
    }
    const char* text = nullptr;
    if (f != 2 || !bb.readString(text)) return kNoGuid;
  }
}

bool showsTitle(const Document& doc, Guid id) {
  const Node* n = doc.get(id);
  if (!n || !n->props.isFrameLike()) return false;
  const Node* p = doc.get(n->props.parentIndex.guid);
  return p && (p->props.type == NodeType::CANVAS || p->props.type == NodeType::SECTION);
}

std::vector<FrameTitle> frameTitles(const Document& doc, Guid page, const Mat2x3& view, const Rect& screen, const OverlayStyle& style,
                                    const std::function<double(const std::string&, bool)>& measure, Guid focus,
                                    const std::vector<Guid>& motion, bool assets) {
  std::vector<FrameTitle> out;
  const Guid thumbnail = thumbnailNode(doc);
  Rect near{screen.x - 200, screen.y - 40, screen.w + 400, screen.h + 80};
  auto visit = [&](auto&& self, Guid parent) -> void {
    for (Guid c : doc.children(parent)) {
      const Node* n = doc.get(c);
      if (!n || !n->props.visible || !n->props.isFrameLike()) continue;
      bool section = n->props.type == NodeType::SECTION;
      if (focus != kNoGuid && focus != c && !section) continue;
      Mat2x3 toScreen = view * doc.worldTransform(c);
      Rect aabb = transformedBounds(toScreen, n->props.size.x, n->props.size.y);
      if (aabb.intersects(near)) {
        FrameTitle t;
        t.id = c;
        t.section = section;
        // A turned frame's name lies along its edge, turned with it (labelFrame); sections don't turn.
        LabelFrame lf = section ? LabelFrame{{}, aabb, true} : labelFrame(toScreen, n->props.size);
        t.place = lf.place;
        t.upright = lf.upright;
        Rect b = lf.box;
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
        } else if (b.w >= 12 && (n->props.type != NodeType::INSTANCE || (assets && parent == page))) {
          // The name above the frame, from its left edge, as wide as the frame at most. A top-level instance has none,
          // selected or not (live Figma round 11: canvas-instance-selected; menu-context-main-component and
          // menu-context-multi-and-smart-selection show the unselected "Button instance" and "Chip instance" bare under
          // the main component's "❖ Button").
          // The file's thumbnail shows Figma's thumbnail glyph before its name (a component's too: the glyph says more).
          t.icon = c == thumbnail                                             ? TitleIcon::Thumbnail
                   : n->props.isComponentish() && !(assets && parent == page && n->props.type == NodeType::INSTANCE) ? TitleIcon::Component
                   : std::find(motion.begin(), motion.end(), c) != motion.end() ? TitleIcon::Motion
                                                                              : TitleIcon::None;
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
          // A Social file's post (docs/social.md §23, Buzz): the whole band over it, across its card, is its name's —
          // the pointer level with the name, past its end, hovers and presses the post.
          if (assets && parent == page && t.upright)
            t.hit = {b.x - style.assetCardPad, b.y - style.assetCardBand, b.w + 2 * style.assetCardPad, style.assetCardBand};
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
