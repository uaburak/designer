// Scene graph → batched instanced shapes on a gfx::Device, then the editor's
// overlays (render/Overlay.cpp). Direct mode: no render tree or tiles yet
// (docs/engine.md §6.2, §6.9 come later). Geometry is composed on the CPU in
// doubles, camera included, and handed to the GPU in CSS px, so floats never
// see large world coordinates (§6.12's camera-relative rendering).
#pragma once

#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

#include "editor/Snapping.h"
#include "gfx/Device.h"
#include "render/Camera.h"
#include "render/GlyphCache.h"
#include "render/GlyphInstance.h"
#include "render/OverlayStyle.h"
#include "render/ShapeInstance.h"
#include "scene/Document.h"
#include "text/TextLayout.h"

namespace eng {

// What the editor wants drawn over the scene.
struct Overlay {
  std::vector<Guid> hover;  // outlined (the canvas hover, or rows hovered in Layers)
  std::vector<Guid> selection;
  bool handles = true;      // resize handles on the selection box
  bool sizeBadge = true;    // the W × H badge under the selection
  bool hasMarquee = false;
  Rect marquee;             // world
  // Smart guides and equal-spacing marks while moving, resizing or drawing (world).
  std::vector<GuideLine> guides;
  std::vector<SpacingMark> spacings;
  // ⌥ measurement: the measured layer (outlined in red), the distances, extension lines.
  Guid measureTarget = kNoGuid;
  std::vector<SpacingMark> measures;
  std::vector<GuideLine> measureGuides;
  // Auto layout: where a dragged layer will go, and the padding / gap bands under the pointer.
  bool hasInsertion = false;
  GuideLine insertion;
  std::vector<Rect> bands;
  // Top-level frames' names above them.
  bool frameTitles = true;
  // Text editing: the node, its selection highlight and caret (node space).
  Guid textNode = kNoGuid;
  std::vector<Rect> textSelection;
  bool caretVisible = false;
  Rect caret;
};

// Where the renderer gets TEXT nodes' layouts (the editor caches them).
class TextLayouts {
 public:
  virtual ~TextLayouts() = default;
  virtual const text::TextLayout* textLayout(Guid id) = 0;
};

struct Viewport {
  double width = 0, height = 0;  // CSS px
  double dpr = 1;                // device pixels per CSS px
  int pixelWidth = 0, pixelHeight = 0;  // the canvas's backing store
  int deviceWidth() const { return pixelWidth > 0 ? pixelWidth : static_cast<int>(width * dpr + 0.5); }
  int deviceHeight() const { return pixelHeight > 0 ? pixelHeight : static_cast<int>(height * dpr + 0.5); }
  // Backing pixels per CSS px as the canvas really is (its backing store can
  // differ from width × dpr): scissors and pixel snapping use these.
  double scaleX() const { return width > 0 ? deviceWidth() / width : dpr; }
  double scaleY() const { return height > 0 ? deviceHeight() / height : dpr; }
};

struct RenderStats {
  uint32_t shapes = 0;
  uint32_t glyphs = 0;
  uint32_t drawCalls = 0;
};

class Renderer {
 public:
  explicit Renderer(gfx::Device& device) : device_(device), glyphCache_(device) {}
  ~Renderer();
  void setTextLayouts(TextLayouts* texts) { texts_ = texts; }
  const GlyphCache& glyphCache() const { return glyphCache_; }
  // A label's layout (overlay text: Inter at `size` CSS px, `style` "Regular" / "Medium"), cut with "…" past
  // `maxWidth` (< 0: never); nullptr until Inter has loaded.
  const text::TextLayout* label(const std::string& text, const char* style, double size, double maxWidth = -1);
  // Draws `page` through `camera` into `target` (0 = the canvas), viewport.deviceWidth × deviceHeight.
  RenderStats render(const Document& doc, Guid page, const Camera& camera, const Viewport& viewport,
                     const Overlay& overlay, const OverlayStyle& style, gfx::TargetId target = 0);

 private:
  enum class Pass : uint8_t { Color, ColorClipped, StencilIncrement, StencilDecrement, Glyph, GlyphClipped, Count };
  struct PendingDraw {
    Pass pass;  // Glyph*: `first`/`count` index glyphs_
    uint32_t first, count;
    bool scissorEnabled;
    gfx::IRect scissor;
    uint8_t stencilRef;
  };
  struct Clip {
    bool stencil;
    bool scissorEnabled;
    gfx::IRect scissor;
    ShapeInstance shape;
  };

  void ensurePipelines();
  void emit(const ShapeInstance& s, Pass pass);
  void emitGlyph(const GlyphInstance& g);
  void drawNode(const Document& doc, Guid id, const Mat2x3& parentScreen, double opacity);
  void drawText(const NodeProps& p, Guid id, const Mat2x3& m, double alpha);
  // Glyphs of `layout` placed by `m` (layout space → CSS px), all in `color`.
  void drawGlyphs(const text::TextLayout& layout, const Mat2x3& m, const Color& color, double alpha);
  void drawOverlay(const Document& doc, Guid page, const Camera& camera, const Overlay& overlay, const OverlayStyle& style);
  void pushClip(const Mat2x3& m, Vec2 size, const CornerRadii& radii);
  void popClip();

  gfx::Device& device_;
  gfx::PipelineId pipelines_[static_cast<int>(Pass::Count)] = {};
  gfx::BufferId buffer_ = 0;
  uint32_t capacity_ = 0;
  gfx::BufferId glyphBuffer_ = 0;
  uint32_t glyphCapacity_ = 0;
  GlyphCache glyphCache_;
  TextLayouts* texts_ = nullptr;
  std::unordered_map<std::string, std::unique_ptr<text::TextLayout>> labels_;
  uint32_t labelsGeneration_ = 0;

  // This frame.
  Viewport viewport_;
  Rect screen_;
  std::vector<ShapeInstance> shapes_;
  std::vector<GlyphInstance> glyphs_;
  std::vector<PendingDraw> draws_;
  std::vector<Clip> clips_;
  bool scissorEnabled_ = false;
  gfx::IRect scissor_;
  uint8_t stencilDepth_ = 0;
};

// A shape instance for a w×h shape placed by `m` (shape space → draw space).
ShapeInstance makeShape(const Mat2x3& m, Vec2 size, ShapeKind kind, const CornerRadii& radii, const Color& fill,
                        double fillAlpha, const Color& stroke, double strokeAlpha, double inner, double outer);

}  // namespace eng
