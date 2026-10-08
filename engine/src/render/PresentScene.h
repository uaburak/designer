// What the presentation view draws (proto/Player → Renderer::renderScene): a list of items in paint order over a
// background colour — layers' subtrees placed anywhere on the screen, their props optionally replaced (scrolling,
// transitions, Smart animate), and plain rectangles (overlay backgrounds, hotspot hints). The same renderer as the
// canvas: the page's render tree, the same shaders, effects and text.
#pragma once

#include <unordered_map>
#include <vector>

#include "math/Math.h"
#include "scene/Node.h"

namespace eng {

using PropsOverrides = std::unordered_map<Guid, NodeProps, GuidHash>;

struct PresentItem {
  enum class Kind : uint8_t { Node, Rect } kind = Kind::Node;
  // Node: `node`'s subtree, placed by `parentCss` (its parent's space → CSS px), each node's props taken from
  // `overrides` where it has an entry.
  Guid node = kNoGuid;
  Mat2x3 parentCss;
  const PropsOverrides* overrides = nullptr;
  // Clipped to this CSS rect (the device's screen).
  bool clip = false;
  Rect clipCss;
  // Rect: filled with `color` × `alpha`, `radius` at its corners, an optional 1 px-ish border.
  Rect rect;
  Color color;
  double alpha = 1;
  double radius = 0;
  double border = 0;
  Color borderColor;
};

struct PresentScene {
  Color background;
  std::vector<PresentItem> items;
};

}  // namespace eng
