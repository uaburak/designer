// Scene graph → draws on a gfx::Device, then the editor's overlays
// (render/Overlay.cpp). Direct mode (no tiles yet, docs/engine.md §6.9).
// Geometry is composed on the CPU in doubles, camera included, and handed to
// the GPU in CSS px, so floats never see large world coordinates (§6.12).
//
// What draws what (docs/engine.md §6.3–§6.7, as built in E4/E5):
// - Rectangles, rounded rectangles, ellipses, frames: the Shape shader's SDFs
//   (any paint, strokes as SDF bands, analytic drop / inner shadows).
// - Everything else with a path (vectors, stars, polygons, lines, booleans,
//   arcs, smoothed corners, dashed strokes, text): the Path shader, coverage
//   from the curves in the CurveCache; strokes are the stroker's outlines,
//   INSIDE / OUTSIDE kept to the fill's inside / outside by a clip path.
// - Paints: solid, the four gradients (a ramp atlas), images (the ImageCache).
// - Layers: a node that needs one (opacity on a container, a blend mode, layer
//   blur, shadows the analytic path can't do, masks) is drawn into an offscreen
//   target, post-processed (blur, dilate / erode) and composited by the
//   Composite shader (opacity, all blend modes via the backdrop, alpha /
//   luminance masks, shadows). Background blur copies the backdrop, blurs it and
//   paints it into the node's shape.
#pragma once

#include <deque>
#include <functional>
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

#include "editor/Snapping.h"
#include "gfx/Device.h"
#include "render/Camera.h"
#include "render/CurveCache.h"
#include "render/DrawInstance.h"
#include "render/ImageCache.h"
#include "render/OverlayStyle.h"
#include "render/RenderTree.h"
#include "scene/Document.h"
#include "text/TextLayout.h"

namespace eng {

// Vector edit mode and gradient handles: generic overlay marks (world space).
struct OverlayCurve {
  Vec2 p0, c1, c2, p3;  // a cubic (lines: c1 = p0, c2 = p3)
  double width = 1;     // CSS px
  bool highlight = false;  // hovered / selected: the selection colour, else a quieter one
};
struct OverlayMark {
  enum class Shape : uint8_t { Vertex, Handle, GradientHandle, GradientStop } shape = Shape::Vertex;
  Vec2 world;
  bool selected = false;
  bool hovered = false;
  Color color;  // gradient stops: the stop's colour
};
struct OverlayLine {
  Vec2 a, b;  // world
  bool dashed = false;
  bool dark = false;  // drawn over a white halo (gradient lines)
};

// What the editor wants drawn over the scene.
struct Overlay {
  std::vector<Guid> hover;  // outlined (the canvas hover, or rows hovered in Layers)
  std::vector<Guid> selection;
  bool handles = true;      // resize handles on the selection box
  bool sizeBadge = true;    // the W × H badge under the selection
  bool selectionBox = true; // the selection's box (off in vector edit mode)
  bool hasMarquee = false;
  Rect marquee;             // world
  std::vector<Vec2> lasso;  // world (vector edit's lasso)
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
  // The camera is in a continuous zoom (the wheel, a pinch): a page that takes long to draw may show its cached
  // pixels scaled until the zoom settles (docs/engine.md §6.9).
  bool zooming = false;
  // Text editing: the node, its selection highlight and caret (node space).
  Guid textNode = kNoGuid;
  std::vector<Rect> textSelection;
  bool caretVisible = false;
  Rect caret;
  // Vector edit mode, the pen, gradient handles.
  std::vector<OverlayCurve> curves;
  std::vector<OverlayLine> lines;
  std::vector<OverlayMark> marks;
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
  uint32_t shapes = 0;  // instances (shapes, paths, glyphs)
  uint32_t glyphs = 0;
  uint32_t paths = 0;
  uint32_t layers = 0;  // offscreen layers
  uint32_t drawCalls = 0;
  uint32_t nodes = 0;    // render-tree nodes visited (drawn or culled at their subtree)
  uint32_t culled = 0;   // subtrees skipped: off screen
  uint32_t tiny = 0;     // subtrees skipped: under half a device pixel (LOD)
  uint32_t greeked = 0;  // texts drawn as bars (em under 3 device px)
  uint32_t cachedRegions = 0;  // content cache: parts drawn again this frame (0: composited only)
  uint32_t stale = 0;          // content cache: shown scaled (a zoom settling)
};

class Renderer {
 public:
  explicit Renderer(gfx::Device& device);
  ~Renderer();
  void setTextLayouts(TextLayouts* texts) { texts_ = texts; }
  const CurveCache& curveCache() const { return curves_; }
  // The render tree of `page` as the last frame drew it (tests, diagnostics); nullptr before any.
  const RenderTree* renderTree(Guid page) const {
    auto it = trees_.find(page);
    return it == trees_.end() ? nullptr : &it->second;
  }
  const ImageCache& imageCache() const { return images_; }
  // A label's layout (overlay text: Inter at `size` CSS px, `style` "Regular" / "Medium"), cut with "…" past
  // `maxWidth` (< 0: never); nullptr until Inter has loaded.
  const text::TextLayout* label(const std::string& text, const char* style, double size, double maxWidth = -1);
  // Draws `page` through `camera` into `target` (0 = the canvas), viewport.deviceWidth × deviceHeight.
  RenderStats render(const Document& doc, Guid page, const Camera& camera, const Viewport& viewport,
                     const Overlay& overlay, const OverlayStyle& style, gfx::TargetId target = 0, Guid only = kNoGuid);
  // The content cache (canvas frames only; off by default): see renderCached.
  void setContentCache(bool on) {
    cacheEnabled_ = on;
    if (!on) dropCache();
  }
  bool contentCache() const { return cacheEnabled_; }
  // When the next frame is wanted (a continuous zoom settling: draw the page sharp again), in nowMs() time; 0: none.
  double wantsFrameAt() const;
  // The clock the cache measures with (ms); tests set their own.
  void setClock(std::function<double()> clock) { clock_ = std::move(clock); }
  double nowMs() const;
  // How long a full raster may take before a continuous zoom shows the cache scaled instead, and how long after
  // the last zoom change the page is drawn sharp again.
  static constexpr double kZoomRasterBudgetMs = 6;
  static constexpr double kZoomSettleMs = 120;
  // Offscreen layers' targets kept for reuse, at most (colour + stencil bytes; targets in use by the frame
  // being drawn can go past it).
  static constexpr uint64_t kPoolBudgetBytes = 192ull << 20;
  // Layers' pooled targets (tests, engine_stats).
  size_t poolTargets() const { return pool_.size(); }
  uint64_t poolTargetBytes() const { return poolBytes(); }

  // The frame-title colour for a page colour (Figma picks it by the page's luminance).
  static Color titleColor(const Color& page, double* alpha);

 private:
  enum class Pass : uint8_t {
    Shape, ShapeClipped, ShapeStencilInc, ShapeStencilDec,
    Path, PathClipped, PathStencilInc, PathStencilDec,
    Composite, CompositeClipped, CompositeReplace, CompositeReplaceClipped,
    Blur, Count
  };
  // An axis-aligned rounded clip, anti-aliased in the shaders (DrawInstance::round / radii): canvas device px.
  struct RoundClip {
    bool on = false;
    float rect[4] = {0, 0, 0, 0};   // x0 y0 x1 y1
    float radii[4] = {0, 0, 0, 0};  // tl tr br bl
  };
  // A draw's extra state (batches only merge when it is equal).
  struct DrawState {
    gfx::TextureId image = 0;   // the image paint's texture, or the blurred backdrop
    int backdrop = -1;          // the backdrop blur whose texture paints (PaintKind::Backdrop)
    float filters[8] = {0, 0, 0, 0, 0, 0, 0, 0};
    bool operator==(const DrawState& o) const;
  };
  struct Cmd {
    enum class Kind : uint8_t { Draw, Composite, BackdropBlur, Blit } kind = Kind::Draw;
    Pass pass = Pass::Shape;
    uint32_t first = 0, count = 0;  // Draw: instances_
    bool scissorEnabled = false;
    gfx::IRect scissor;  // device px, canvas space
    uint8_t stencilRef = 0;
    DrawState state;
    // Composite: layer `layer` (and `aux`, the mask / the node's alpha) into this one.
    int layer = -1, aux = -1;
    int mode = 0;  // see gfx/gl/Shaders.h kCompositeFragment
    float opacity = 1;
    BlendMode blend = BlendMode::NORMAL;
    Color color;
    Vec2 offset;  // device px
    bool knockout = false;
    gfx::IRect rect;  // Composite: the quad; BackdropBlur: the region (device px, canvas space)
    double sigma = 0;  // BackdropBlur: device px
    // Blit (the content cache onto the canvas): the texture, where its top-left lands (device px), texels per
    // device px, its height in texels.
    RoundClip round;  // Composite: the rounded clip it lands in
    gfx::TextureId blitTexture = 0;
    Vec2 blitOrigin;
    double blitScale = 1;
    int blitHeight = 0;
  };
  struct Layer {
    gfx::IRect rect;           // device px, canvas space
    std::vector<Cmd> cmds;
    int copyOf = -1;           // a copy of another layer (then blurred: shadows)
    double blur = 0;           // σ in device px, applied after drawing
    double morph = 0;          // + dilate / − erode, device px, before the blur
    bool executed = false;
    // Execution: where its pixels ended up.
    gfx::TargetId target = 0;
    gfx::TextureId texture = 0;
    double scale = 1;          // texels per device px
    int contentH = 0;          // texels
  };
  struct Clip {
    bool stencil;
    bool scissorEnabled;
    gfx::IRect scissor;
    DrawInstance shape;
    bool path;
    RoundClip round;  // the rounded clip before this one
  };
  struct PoolTarget {
    gfx::TargetId target = 0;
    gfx::TextureId texture = 0;
    int w = 0, h = 0;
    bool busy = false;
    uint64_t lastUsed = 0;
  };
  struct BackdropBlur {
    gfx::TextureId texture = 0;  // set at execution
    gfx::IRect rect;             // device px, canvas space (window y computed per pass)
    float place[4] = {0, 0, 1, 1};
  };

  void ensurePipelines();
  // Recording.
  void emit(const DrawInstance& s, Pass pass, const DrawState& state);
  void emit(const DrawInstance& s, Pass pass);
  // Render-tree node `i` (its subtree), `parentCss`: its parent's space → CSS px.
  void drawNode(const Document& doc, uint32_t i, const Mat2x3& parentCss, double alpha);
  // The siblings from render-tree node `first` up to `end` (one past the last), in paint order.
  void drawChildren(const Document& doc, uint32_t first, uint32_t end, const Mat2x3& m, double alpha);
  void drawContent(const Document& doc, uint32_t i, const NodeProps& p, const Mat2x3& m, double alpha, bool shadowsDone);
  void drawFills(const Document& doc, Guid id, const NodeProps& p, const Mat2x3& m, double alpha, bool whiteMask = false);
  void drawStrokes(const Document& doc, Guid id, const NodeProps& p, const Mat2x3& m, double alpha);
  void drawAnalyticShadows(const NodeProps& p, const Mat2x3& m, double alpha, bool inner);
  void drawBackgroundBlur(const Document& doc, Guid id, const NodeProps& p, const Mat2x3& m, double alpha, const Effect& e);
  void drawText(const Document& doc, const NodeProps& p, Guid id, const Mat2x3& m, double alpha);
  // Glyphs of `layout` placed by `m` (layout space → CSS px), all in `color`.
  void drawGlyphs(const text::TextLayout& layout, const Mat2x3& m, const Color& color, double alpha);
  void drawOverlay(const Document& doc, Guid page, const Camera& camera, const Overlay& overlay, const OverlayStyle& style);
  // A path in local space (`m` → CSS px) filled with `paint`; `clip` (optional) intersects / subtracts.
  void emitPath(const CurveEntry* entry, const Mat2x3& m, bool evenOdd, const Paint& paint, Vec2 nodeSize, double alpha,
                const CurveEntry* clip = nullptr, bool clipSubtract = false, bool clipEvenOdd = false, Pass pass = Pass::Path);
  // An instance's paint fields; false when there is nothing to draw (an invisible paint).
  bool setPaint(DrawInstance& q, DrawState& state, const Paint& paint, const Mat2x3& localToNode, Vec2 nodeSize, double alpha);
  int rampRow(const std::vector<ColorStop>& stops);
  void compositeLayer(int src, int aux, int mode, float opacity, BlendMode bm, const Color& color, Vec2 offset, bool knockout,
                      gfx::IRect rect);
  // Draws one paint (`draw(alpha)`), through a layer when the paint has its own blend mode.
  void blendedPaint(const Paint& paint, const Mat2x3& m, Vec2 size, double alpha, const std::function<void(double)>& draw);
  void pushClip(const Document& doc, Guid id, const NodeProps& p, const Mat2x3& m);
  void popClip();
  int beginLayer(gfx::IRect rect);
  void endLayer(int saved);
  gfx::IRect deviceRect(const Rect& css, double margin) const;
  // Render-tree node `i`'s visual bounds on screen (CSS px).
  Rect screenBounds(uint32_t i) const;
  double levelScale(const Mat2x3& m) const;
  // Execution.
  void execute(int layer, gfx::TargetId target, const float clear[4], bool keep = false);
  void runLayer(int index);
  void runCmds(Layer& L, gfx::TargetId target, gfx::IRect viewport, const float clear[4], bool keep);
  // A recording of `region` (device px; clipToRegion: nothing drawn outside it), then its execution into `target`
  // (keep: what the target holds stays outside the region).
  void beginRecording(gfx::IRect region, bool clipToRegion);
  void finishRecording(gfx::TargetId target, const float clear[4], bool keep);
  // The page's layers (into the part being recorded), over the page colour when `background`.
  void drawPageContent(const Document& doc, const Color& page, bool background);
  void renderCached(const Document& doc, Guid page, const Camera& camera, const Overlay& overlay, const OverlayStyle& style,
                    const Color& clear, const float clearColor[4]);
  // `from` into `to`, shifted by (dx, dy) device px, `scale` texels per device px.
  void blitCache(gfx::TargetId from, gfx::TargetId to, int dx, int dy, double scale);
  void dropCache();
  void blurLayer(Layer& L);
  PoolTarget* acquire(int w, int h);
  void release(gfx::TargetId target);
  uint64_t poolBytes() const;
  void rows(float out[2][4], double sx, double sy, int ox, int oy, int w, int h) const;

  gfx::Device& device_;
  gfx::PipelineId pipelines_[static_cast<int>(Pass::Count)] = {};
  gfx::BufferId buffer_ = 0;
  uint32_t capacity_ = 0;
  CurveCache curves_;
  ImageCache images_;
  TextLayouts* texts_ = nullptr;
  std::unordered_map<std::string, std::unique_ptr<text::TextLayout>> labels_;
  // The pages' render trees (the current page's, and those thumbnails were drawn from), kept in step with the
  // document (render/RenderTree.h).
  std::unordered_map<Guid, RenderTree, GuidHash> trees_;
  const RenderTree* tree_ = nullptr;  // this frame's
  uint32_t treeFonts_ = 0;            // the font generation the trees' text bounds are from
  Mat2x3 view_;                       // this frame's world → CSS px
  gfx::IRect region_;                 // the part being recorded (device px)
  // The content cache (renderCached).
  bool cacheEnabled_ = false;
  struct ContentCache {
    gfx::TargetId target = 0, spare = 0;  // the pixels, and the other one (shifts ping-pong)
    int w = 0, h = 0;
    bool valid = false;
    bool pendingFull = false;  // changes came while it was shown scaled: draw everything
    Guid page = kNoGuid;
    double zoom = 0, camX = 0, camY = 0;  // the camera it was drawn with
    double sx = 0, sy = 0;
    uint32_t fonts = 0, images = 0;       // the registries' generations it was drawn with
    Color clear;
    double fullMs = 0;                    // how long its last full raster took
    double lastZoom = 0, zoomChangedAt = 0, settleAt = 0;
  } cache_;
  std::function<double()> clock_;
  uint32_t labelsGeneration_ = 0;
  // Gradient ramps: 256 premultiplied texels per row.
  std::unordered_map<uint64_t, int> rampRows_;
  std::vector<uint8_t> rampData_;
  int rampRowsUploaded_ = 0, rampCapacity_ = 0;
  gfx::TextureId ramp_ = 0;
  gfx::TextureId white_ = 0;  // 1×1, bound to unused texture units
  std::deque<PoolTarget> pool_;  // stable addresses: acquire() hands out pointers
  std::vector<gfx::TextureId> scratch_;  // backdrop copies of this frame
  uint64_t frame_ = 0;

  // This frame.
  const Document* doc_ = nullptr;
  Viewport viewport_;
  Rect screen_;
  std::vector<DrawInstance> instances_;
  std::vector<Layer> layers_;
  std::vector<BackdropBlur> backdrops_;
  int current_ = 0;  // the layer being recorded
  std::vector<Clip> clips_;
  bool scissorEnabled_ = false;
  gfx::IRect scissor_;
  RoundClip round_;
  uint8_t stencilDepth_ = 0;
  gfx::TextureId curveTexture_ = 0;
  RenderStats stats_;
};

// A shape instance for a w×h shape placed by `m` (shape space → draw space): a solid fill and / or a solid
// stroke band [−inner, outer] (overlays, clips).
DrawInstance makeShape(const Mat2x3& m, Vec2 size, ShapeKind kind, const CornerRadii& radii, const Color& fill,
                       double fillAlpha, const Color& stroke, double strokeAlpha, double inner, double outer);

}  // namespace eng
