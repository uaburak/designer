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

#include <list>
#include <functional>
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

#include "editor/Snapping.h"
#include "geometry/Path.h"
#include "gfx/Device.h"
#include "render/Camera.h"
#include "render/CurveCache.h"
#include "render/DrawInstance.h"
#include "render/FrameTitles.h"
#include "render/ImageCache.h"
#include "render/OverlayStyle.h"
#include "render/RenderTree.h"
#include "render/PresentScene.h"
#include "scene/Document.h"
#include "scene/Extras.h"
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

// Prototype mode (the right panel's Prototype tab, editor/PrototypeEditing.cpp): connections ("noodles") from hotspots
// to destinations, the "+" connection handles, flow starting point labels, the frame a dragged noodle connects to.
struct PrototypeLink {
  Rect source;            // world: the hotspot
  Rect dest;              // world: the destination (when `toPoint` is false)
  bool toPoint = false;   // dragged: the noodle ends at `point`
  Vec2 point;             // world
  bool highlighted = true;  // the selection's (others are drawn quieter)
};
struct PrototypeFlowLabel {
  Guid frame = kNoGuid;
  Rect bounds;            // world: the frame
  std::string name;
};
struct PrototypeOverlay {
  bool on = false;
  std::vector<PrototypeLink> links;
  std::vector<Rect> handles;       // world: hotspots showing the "+" connection handle on their right edge
  bool handleHovered = false;      // the pointer is on a handle (it shows its plus)
  std::vector<PrototypeFlowLabel> flows;
  bool hasTarget = false;
  Rect target;                     // world
  // The width (CSS px) a frame's flow label takes before its title (known once the labels are drawn).
  double labelWidth(Guid frame) const {
    for (auto& [id, w] : labelWidths)
      if (id == frame) return w;
    return 0;
  }
  mutable std::vector<std::pair<Guid, double>> labelWidths;
};
// A noodle on screen (CSS px): a cubic from the hotspot's side facing the destination to the destination's facing
// side (or to a point), and the direction its arrow points.
struct NoodleCurve {
  Vec2 a, c1, c2, b;
  Vec2 dir;  // unit, at `b`
};
NoodleCurve prototypeNoodle(const Rect& source, const Rect& dest, bool toPoint, Vec2 point);

// Dev Mode's annotations, saved measurements and statuses (render/AnnotationOverlay.cpp; editor/Annotations.h).
struct AnnotationCard {
  Guid node = kNoGuid;
  uint32_t index = 0;
  Rect target;           // world: the annotated layer
  Guid frame = kNoGuid;  // its top-level layer (the labels sit beside it)
  Rect frameBounds;      // world
  std::string title;     // the category's label ("" none)
  Color color;
  struct Line {
    std::string text;
    bool heading = false;
  };
  std::vector<Line> lines;
  std::vector<std::pair<std::string, std::string>> properties;  // pinned: label, value
  bool selected = false;  // the annotated layer is selected
  bool open = true;       // a dot opened (Dev Mode); labels are always open in Design
};
struct MeasurementMark {
  Guid id = kNoGuid;
  Vec2 a, b;                       // world: the measured line
  std::vector<GuideLine> extensions;  // world: from the layers' edges to the line
  std::string text;                // the value, or its custom text
  bool selected = false;
};
// The `</>` at a selected design's top right (CSS px), and the room its name leaves for it.
inline constexpr double kDevIconWidth = 12, kDevIconGap = 8;
struct DevStatusMark {
  Guid frame = kNoGuid;
  enum class Kind : uint8_t { MarkButton, Ready, Completed, Changed } kind = Kind::Ready;
};
struct DevOverlay {
  bool annotations = true;  // View › Annotations (labels, dots and measurements)
  bool dots = false;        // Dev Mode: annotations as dots, the open one as its label
  std::vector<AnnotationCard> cards;
  std::vector<MeasurementMark> measurements;
  // The measurement tool: the edge under the pointer, and the measurement being dragged out.
  std::vector<GuideLine> edges;  // world
  bool hasDraft = false;
  MeasurementMark draft;
  std::vector<DevStatusMark> statuses;
  Guid focus = kNoGuid;  // focus view: only this layer is drawn
};
// Where the last canvas frame drew what can be clicked (CSS px in the canvas), for the editor's hit tests.
struct CanvasHits {
  struct Annotation {
    Guid node = kNoGuid;
    uint32_t index = 0;
    Rect rect;
    bool dot = false;
  };
  struct Measure {
    Guid id = kNoGuid;
    Rect pill;
    Vec2 a, b;
  };
  struct Status {
    Guid frame = kNoGuid;
    Rect rect;
    DevStatusMark::Kind kind = DevStatusMark::Kind::Ready;
  };
  std::vector<Annotation> annotations;
  std::vector<Measure> measurements;
  std::vector<Status> statuses;
  // A selected component set's "+" (Add variant) under its variants pill (round 11).
  struct AddVariant {
    Guid set = kNoGuid;
    Rect rect;
  } addVariant;
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
  std::vector<Vec2> trail;  // world (vector edit's Cut line / Erase path: an open line)
  double trailWidth = 1;    // CSS px
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
  // Grid auto layout, a selected grid (live Figma, canvas-grid-*): every cell outlined light blue (a selected track's
  // empty ones filled), the tracks' pills (screen CSS px: compact, or expanded with grabber, label and chevron — the
  // hovered segment darker), the outlined tracks (an expanded pill's; world corners).
  struct GridCell {
    Vec2 a, b;  // world: opposite corners (the grid is upright)
    bool fill = false;
    bool column = false;  // a track box (gridTrackBoxes): a column's, else a row's
  };
  std::vector<GridCell> gridCells;
  struct GridPill {
    Rect rect;              // screen CSS px
    bool column = true;     // above the frame (else left of it)
    bool expanded = false;
    bool selected = false;
    int hovered = -1;       // 0 grabber, 1 label, 2 chevron
    double segment = 16;    // the grabber's and the chevron's width
    double labelWidth = 0;
    std::string label;
  };
  std::vector<GridPill> gridPills;
  std::vector<GridCell> gridTrackBoxes;
  // The selection's box dashed (a grid's track selected).
  bool selectionDashed = false;
  // Reordering tracks: where they will land (world). A grid item's span handles: its sides' midpoints (world).
  bool hasGridDrop = false;
  GuideLine gridDrop;
  std::vector<Vec2> gridSpanHandles;
  // A selected line's two endpoint handles (world), drawn instead of the box's corner handles.
  std::vector<Vec2> lineEnds;
  // A selected rectangle under the pointer: its corner radius handles (world; top-left, top-right, bottom-right,
  // bottom-left), the one under the pointer (−1: none).
  std::vector<Vec2> radiusHandles;
  int radiusHovered = -1;
  // The selected ellipse's arc handles, a polygon's or star's corner radius / ratio / count handles (world), the one
  // under the pointer or dragged (−1: none): rings as the radius handles.
  std::vector<Vec2> shapeHandles;
  int shapeHovered = -1;
  // Equally spaced selected layers (smart selection): the pink gap handles (world, the middle of each gap, `vertical`:
  // a gap between rows) and the centre dots of the layers.
  struct GapHandle {
    Vec2 at;
    double length = 0;  // world, across the gap's axis
    bool vertical = false;
    bool hovered = false;
    double value = 0;
  };
  std::vector<GapHandle> gapHandles;
  // A selected auto-layout frame under the pointer: a bar in the middle of each padding (blue) and gap (pink); the
  // hovered one shows its value next to `edge` (a padding: the frame's edge there, world).
  struct LayoutBar {
    Vec2 at, edge;
    bool vertical = false;
    bool gap = false;
    bool hovered = false;
    int side = -1;   // a padding: 0 left, 1 top, 2 right, 3 bottom
    int index = -1;  // a gap: which
    double value = 0;
  };
  std::vector<LayoutBar> layoutBars;
  std::vector<Vec2> centreDots;
  int centreDotHovered = -1;  // round 8: the ring under the pointer, or the one being dragged (reorder)
  // Round 11: the pointer is off the selection (no gesture): tiny dots instead of the rings (live Figma: a ~3 px white
  // dot with a pink centre; the rings and the gap handles while the pointer is on the selection). A selected group's
  // equally spaced layers get these dots too (live canvas-group-selected).
  bool centreDotsIdle = false;
  // Round 11: a selected auto-layout component, set or instance — a pink box in each gap between its layers, across
  // its content box (live Figma, canvas-component-set-selected / -main-component-selected / -instance-selected).
  struct GapBox {
    Mat2x3 world;  // the frame's own space → world
    Rect rect;     // the gap, in the frame's space
  };
  std::vector<GapBox> gapBoxes;
  // Round 8: the ⌥R rotation origin (world); a badge text in place of "W × H" (rotating: the angle); ruler guides
  // (world ends, the selected or dragged one in the selection colour with its position); slices' boxes (View › Show
  // slices, dashed); pixel preview (the page drawn at `pixelPreview`× and scaled up without smoothing; 0: off).
  bool hasRotationOrigin = false;
  Vec2 rotationOrigin;
  std::string badgeText;
  struct RulerGuide {
    Vec2 a, b;           // world
    bool vertical = false;
    bool active = false;  // selected or dragged
    bool label = false;   // show its position
    double value = 0;
  };
  std::vector<RulerGuide> rulerGuides;
  struct SliceBox {
    Mat2x3 world;  // the slice's own space → world
    Vec2 size;
  };
  std::vector<SliceBox> slices;
  int pixelPreview = 0;
  // View options: the pixel grid (View › Pixel grid, drawn from 300 % zoom) and outline mode (⇧⌘O: every layer as a
  // thin outline, no fills).
  bool pixelGrid = true;
  bool outlines = false;
  bool layoutGuides = true;  // View › Layout guides (⇧G): frames' layout grids drawn
  // Top-level frames' names above them; one frame's left out (a grid whose track is selected: live Figma).
  bool frameTitles = true;
  Guid hideTitle = kNoGuid;
  // The camera is in a continuous zoom (the wheel, a pinch): a page that takes long to draw may show its cached
  // pixels scaled until the zoom settles (docs/engine.md §6.9).
  bool zooming = false;
  // Text editing: the node, its selection highlight and caret (node space).
  Guid textNode = kNoGuid;
  std::vector<Rect> textSelection;
  std::vector<Rect> misspelled;  // node space: a red wavy line under each (Text › Spell check, round 10)
  bool caretVisible = false;
  Rect caret;
  // Vector edit mode, the pen, gradient handles.
  std::vector<OverlayCurve> curves;
  // Round 12: the Shape builder's regions (world), filled in the selection colour at `alpha` and outlined.
  struct Region {
    geom::Path path;
    double alpha = 0.15;
  };
  std::vector<Region> regions;
  std::vector<OverlayLine> lines;
  std::vector<OverlayMark> marks;
  // Prototype mode.
  PrototypeOverlay prototype;
  // Dev Mode: annotations, measurements, statuses, focus view.
  DevOverlay dev;
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
  uint32_t tilesRastered = 0;  // tiles drawn this frame (docs/engine.md §6.9)
  uint32_t tilesStale = 0;     // tiles shown from another zoom level this frame
  uint32_t tilesShown = 0;     // tiles composited this frame
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
  // A label's layout (overlay text: Inter at `size` CSS px, `style` "Regular" / "Medium"; `weight` > 0: that weight on
  // Inter's variable axis, e.g. Figma's 550), cut with "…" past `maxWidth` (< 0: never); nullptr until Inter has loaded.
  const text::TextLayout* label(const std::string& text, const char* style, double size, double maxWidth = -1, int maxLines = 1, double weight = 0);
  // What the last canvas frame drew that the editor hit-tests (annotation labels, measurements, statuses).
  const CanvasHits& canvasHits() const { return hits_; }
  // Draws `page` through `camera` into `target` (0 = the canvas), viewport.deviceWidth × deviceHeight.
  RenderStats render(const Document& doc, Guid page, const Camera& camera, const Viewport& viewport,
                     const Overlay& overlay, const OverlayStyle& style, gfx::TargetId target = 0, Guid only = kNoGuid);
  // The presentation view (proto/Player): `scene`'s items over its background, `page`'s layers through its render
  // tree; no culling (items' props may move layers away from their document place), no content cache.
  RenderStats renderScene(const Document& doc, Guid page, const Viewport& viewport, const PresentScene& scene, gfx::TargetId target = 0);
  // The content cache (canvas frames only; off by default): see renderCached.
  void setContentCache(bool on) {
    cacheEnabled_ = on;
    if (!on) dropCache();
  }
  bool contentCache() const { return cacheEnabled_; }
  // Exports (export/Export.h): the page's layers on transparent (no page colour) and text never greeked.
  void setExporting(bool on) { exporting_ = on; }
  // When the next frame is wanted (a continuous zoom settling: draw the page sharp again), in nowMs() time; 0: none.
  double wantsFrameAt() const;
  // The clock the cache measures with (ms); tests set their own.
  void setClock(std::function<double()> clock) { clock_ = std::move(clock); }
  double nowMs() const;
  // How long a full raster may take before a continuous zoom shows the cache scaled instead, and how long after
  // the last zoom change the page is drawn sharp again.
  static constexpr double kZoomRasterBudgetMs = 6;
  static constexpr double kZoomSettleMs = 120;
  // Tiles (docs/engine.md §6.9, Figma's RTTileRasterizer / RTCompositeTileCache): the page in 256² device-px tiles at
  // power-of-two zoom levels, kept in atlas targets (64 tiles each) within a budget, least recently shown first out.
  // A continuous zoom on a slow page that the scaled content cache can't cover (zooming out) composites them — the
  // level at or above the zoom, else a coarser one scaled — and draws the missing ones from the viewport's centre
  // outward within kTileInteractingMs per frame; at rest on a slow page, the coarser level around the view is drawn
  // ahead within kTileIdleMs per frame, so the next zoom out has it.
  static constexpr int kTileSize = 256;
  // What a tile shows: its slot less a 1 px apron drawn from its neighbours' content, so bilinear sampling at its edge
  // reads real pixels (no seams between tiles).
  static constexpr int kTileContent = kTileSize - 2;
  static constexpr int kAtlasSize = 2048;
  // Colour + stencil of the atlases (4 of 64 tiles: 256 tiles, three Retina screens of a level).
  static constexpr uint64_t kTileBudgetBytes = 128ull << 20;
  static constexpr double kTileInteractingMs = 6;
  static constexpr double kTileIdleMs = 12;
  size_t tileCount() const { return tiles_.map.size(); }
  uint64_t tileBytes() const { return static_cast<uint64_t>(tiles_.atlases.size()) * kAtlasSize * kAtlasSize * 8; }
  // Offscreen layers' targets kept for reuse, at most (colour + stencil bytes; targets in use by the frame
  // being drawn can go past it).
  static constexpr uint64_t kPoolBudgetBytes = 192ull << 20;
  // Layers' pooled targets (tests, engine_stats).
  size_t poolTargets() const { return pool_.size(); }
  uint64_t poolTargetBytes() const { return poolBytes(); }

  // Whether a page colour is dark: frame titles then use their on-dark colours (Figma picks them by the page's
  // luminance, not the UI theme).
  static bool darkCanvas(const Color& page);

 private:
  enum class Pass : uint8_t {
    Shape, ShapeClipped, ShapeStencilInc, ShapeStencilDec,
    Path, PathClipped, PathStencilInc, PathStencilDec,
    Composite, CompositeClipped, CompositeReplace, CompositeReplaceClipped,
    Blur, Shader, Count
  };
  // An axis-aligned rounded clip, anti-aliased in the shaders (DrawInstance::round / radii): canvas device px.
  struct RoundClip {
    bool on = false;
    float rect[4] = {0, 0, 0, 0};   // x0 y0 x1 y1
    float radii[4] = {0, 0, 0, 0};  // tl tr br bl
  };
  // A clip shape (a turned, smoothed or second rounded clipping frame), anti-aliased in the shaders by its coverage
  // (gfx/gl/Shaders.h kClipFunctions, uniform slots 12–15): canvas device px → the shape's own space, and the shape.
  struct ShapeClip {
    float rows[2][4] = {};  // (a b c kind), (d e f first curve texel); kind 1 rounded box, 2 path, 3 path (ODD)
    float size[4] = {};     // the box's width, height
    float radii[4] = {};    // tl tr br bl, in its own space
  };
  // A draw's extra state (batches only merge when it is equal).
  struct DrawState {
    gfx::TextureId image = 0;   // the image paint's texture, or the blurred backdrop
    int backdrop = -1;          // the backdrop blur whose texture paints (PaintKind::Backdrop / Progressive / Glass)
    int level = 0;              // a progressive backdrop blur: the interval between its levels `level` and `level + 1`
    int clip = -1;              // the clip shape in force (shapeClips_), −1: none
    float filters[8] = {0, 0, 0, 0, 0, 0, 0, 0};
    bool operator==(const DrawState& o) const;
  };
  struct Cmd {
    // Shader: a shader paint's or effect's quad (`rect`) into its own layer — `layer` the layer an effect reads (−1: a
    // fill), `aux` its uniforms in shaderCalls_.
    enum class Kind : uint8_t { Draw, Composite, BackdropBlur, Blit, Shader } kind = Kind::Draw;
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
    // Composite modes 5–7 (progressive blur, noise, texture): uniform slots 16–19 (gfx/gl/Shaders.h).
    bool fxOn = false;
    float fx[4][4] = {};
    RoundClip round;  // Composite: the rounded clip it lands in
    float clipRect[4] = {0, 0, -1, -1};  // Composite: the clip rectangle it lands in (canvas device px; x1 < x0: none)
    int shapeClip = -1;                  // Composite: the clip shape it lands in
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
    float clipRect[4] = {0, 0, 0, 0};  // the clip rectangle before this one
    int shapeClip = -1;                // the clip shape before this one
  };
  struct PoolTarget {
    gfx::TargetId target = 0;
    gfx::TextureId texture = 0;
    int w = 0, h = 0;
    bool busy = false;
    uint64_t lastUsed = 0;
  };
  // A background blur's (or glass's) copy of the backdrop, blurred: one level, or a progressive blur's levels (σ
  // ascending; the shape is drawn once per interval between two, each pixel by the one its σ falls in).
  static constexpr int kMaxBlurLevels = 8;
  struct BackdropBlur {
    enum class Kind : uint8_t { Plain, Progressive, Glass } kind = Kind::Plain;
    int count = 1;
    double sigmas[kMaxBlurLevels] = {};                    // device px
    gfx::TextureId textures[kMaxBlurLevels] = {};          // set at execution
    float places[kMaxBlurLevels][4] = {};                  // x, y in window px, width, height in texels
    float fx[3][4] = {};                                   // progressive: slots 16–18 (the node's box, start / end)
    double start = 0, end = 0;                             // progressive: σ at the start and at the end (device px)
    float glass[2][4] = {};                                // glass: slots 6 and 8
  };

  void ensurePipelines();
  // Recording.
  void emit(const DrawInstance& s, Pass pass, const DrawState& state);
  void emit(const DrawInstance& s, Pass pass);
  // Render-tree node `i` (its subtree), `parentCss`: its parent's space → CSS px.
  void drawNode(const Document& doc, uint32_t i, const Mat2x3& parentCss, double alpha);
  // The siblings from render-tree node `first` up to `end` (one past the last), in paint order.
  void drawChildren(const Document& doc, uint32_t first, uint32_t end, const Mat2x3& m, double alpha);
  // strokes = false: without the node's own strokes (drawn apart, above its inner shadows).
  void drawContent(const Document& doc, uint32_t i, const NodeProps& p, const Mat2x3& m, double alpha, bool shadowsDone, bool strokes = true);
  void drawFills(const Document& doc, Guid id, const NodeProps& p, const Mat2x3& m, double alpha, bool whiteMask = false);
  void drawStrokes(const Document& doc, Guid id, const NodeProps& p, const Mat2x3& m, double alpha);
  void drawAnalyticShadows(const NodeProps& p, const Mat2x3& m, double alpha, bool inner);
  // A background blur (uniform or progressive), or glass: the backdrop copied, blurred and painted into the shape.
  void drawBackgroundBlur(const Document& doc, Guid id, const NodeProps& p, const Mat2x3& m, double alpha, const Effect& e,
                          bool glass = false);
  // Layer `src` composited through a progressive blur (σ `s0` at the effect's start to `s1` at its end, device px):
  // copies of it at levels between, each pixel from the two levels around its σ.
  void progressiveComposite(int src, float opacity, BlendMode bm, gfx::IRect r, double s0, double s1, const Effect& e,
                            const Mat2x3& m, Vec2 size);
  // A PATTERN fill: its source layer tiled over the node's box, through the node's fill shape.
  void drawPattern(const Document& doc, Guid id, const NodeProps& p, const Mat2x3& m, double alpha, const Paint& paint);
  // A shader fill (PaintType::CUSTOM, round 11): its preset drawn over the node's box into a layer, through the node's
  // fill shape.
  void drawShaderPaint(const Document& doc, Guid id, const NodeProps& p, const Mat2x3& m, double alpha, const Paint& paint);
  // A layer of `r` holding one shader quad: a fill's preset (`source` −1), or an effect's of layer `source`. Its index.
  int shaderLayer(const ShaderSetup& s, int source, gfx::IRect r, const Mat2x3& m, Vec2 size);
  struct ShaderCall {
    float u[gfx::kUniformSlots][4] = {};  // slots 4–19 (gfx/gl/CustomShader.h); 0–3 are set when it runs
  };
  std::vector<ShaderCall> shaderCalls_;  // this frame's
  int patternDepth_ = 0;
  void drawText(const Document& doc, const NodeProps& p, Guid id, const Mat2x3& m, double alpha);
  // The smallest em (device px) drawn as glyphs; smaller text is a bar per line holding the line's ink.
  static constexpr double kGlyphMinEmPx = 1;
  // A glyph's outline area in em² (cached): the ink of greeked lines.
  double glyphArea(text::Font* font, uint32_t glyph);
  // Outline mode (View › Outlines, ⇧⌘O): a node as a thin outline (text: its glyphs in the outline colour), then its
  // children; no fills, strokes, effects or masks.
  void drawOutlined(const Document& doc, uint32_t i, const NodeProps& p, const Mat2x3& m);
  // A polyline in CSS px, `width` across: a thin rectangle per segment.
  void strokePolyline(const std::vector<Vec2>& pts, bool closed, double width, const Color& color, double alpha);
  // Glyphs of `layout` placed by `m` (layout space → CSS px), all in `color`.
  void drawGlyphs(const text::TextLayout& layout, const Mat2x3& m, const Color& color, double alpha);
  void drawOverlay(const Document& doc, Guid page, const Camera& camera, const Overlay& overlay, const OverlayStyle& style);
  // Prototype mode's connections, hotspots and flow labels (render/PrototypeOverlay.cpp).
  void drawPrototypeOverlay(const Document& doc, Guid page, const Camera& camera, const Overlay& overlay, const OverlayStyle& style);
  void drawPrototypeLabels(const Document& doc, const Camera& camera, const Overlay& overlay, const OverlayStyle& style);
  // Dev Mode (render/AnnotationOverlay.cpp): saved measurements, annotation labels with their leader lines (or dots),
  // the measurement tool's edges and draft; a frame title's status chip (`x`: where it starts, `baseline`).
  void drawDevOverlay(const Document& doc, const Camera& camera, const Overlay& overlay, const OverlayStyle& style);
  void drawStatusChip(const DevStatusMark& mark, double x, double baseline, const OverlayStyle& style);
  // The `</>` at a selected design's top right (Overlay.cpp): its right edge at `right`, by the title's baseline.
  void drawDevIcon(Guid frame, double right, double baseline, const Color& color);
  // Figma's component (four diamonds) or instance (a diamond outline) icon before a title, in `box` (screen CSS px).
  void drawTitleIcon(TitleIcon icon, const Rect& box, const Color& color);
  // A hovered text layer (Overlay.cpp, round 11): each line's baseline underlined across its text, 2 px (1 px when
  // the text is selected) just under it. False when the text has no laid-out line to underline.
  bool baselineUnderline(const Document& doc, Guid text, const Mat2x3& view, const Overlay& overlay, const OverlayStyle& style);
  // A selected component set's "+" (Add variant) button, its top-left at (x, y) in CSS px (Overlay.cpp, round 11).
  void drawAddVariant(Guid set, double x, double y, const Color& color, const OverlayStyle& style);
  // Render-tree node `i`'s props: the scene item's override when it has one (renderScene), else the document's.
  const NodeProps& propsAt(uint32_t i) const {
    const RenderNode& rn = tree_->nodes()[i];
    if (overrides_) {
      auto it = overrides_->find(rn.id);
      if (it != overrides_->end()) return it->second;
    }
    return rn.node->props;
  }
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
  // Pixel preview (round 8, View › Pixel preview, ⌃P): the page drawn at `factor` px per page unit into its own target,
  // then scaled onto the canvas without smoothing, the overlays over it. False: not drawn that way (too small a zoom).
  bool renderPixelPreview(const Document& doc, Guid page, const Camera& camera, const Viewport& viewport, const Overlay& overlay,
                          const OverlayStyle& style, const float clearColor[4], int factor);
  struct PixelPreviewTarget {
    gfx::TargetId target = 0;
    int w = 0, h = 0;
  } preview_;
  bool inPreview_ = false;
  void renderCached(const Document& doc, Guid page, const Camera& camera, const Overlay& overlay, const OverlayStyle& style,
                    const Color& clear, const float clearColor[4]);
  // `from` into `to`, shifted by (dx, dy) device px, `scale` texels per device px.
  void blitCache(gfx::TargetId from, gfx::TargetId to, int dx, int dy, double scale);
  void dropCache();
  // Tiles.
  struct TileCoord {
    int level = 0, tx = 0, ty = 0;
  };
  static bool tileKey(const TileCoord& t, uint64_t& key);
  // The tiles of `level` that the canvas shows through `camera`, nearest the centre first.
  std::vector<TileCoord> visibleTiles(const Camera& camera, int level, double grow) const;
  // Draws one tile into its atlas slot (false: no room).
  bool rasterTile(const Document& doc, const TileCoord& t, const Color& clear, const float clearColor[4]);
  // Missing tiles of `want` drawn within `budgetMs` (one at least): how many remain.
  size_t rasterTiles(const Document& doc, const std::vector<TileCoord>& want, double budgetMs, const Color& clear, const float clearColor[4]);
  // Blits of the tiles covering the canvas at `level` (coarser cached levels standing in) into the canvas recording.
  // coarse: the coarser levels standing in (drawn under the scaled cache), else the level's own (over it).
  void composeTiles(const Camera& camera, int level, bool coarse);
  void invalidateTiles(const std::vector<Rect>& world);
  void dropTiles();
  void blurLayer(Layer& L);
  PoolTarget* acquire(int w, int h);
  void release(gfx::TargetId target);
  uint64_t poolBytes() const;
  void dropIdleTargets();  // after a frame: pooled targets unused for 30 frames
  void rows(float out[2][4], double sx, double sy, int ox, int oy, int w, int h) const;
  // Uniform slots 12–15 of a draw or composite: the clip shape `index` (−1: none).
  void setShapeClip(gfx::DrawCall& call, int index) const;

  gfx::Device& device_;
  gfx::PipelineId pipelines_[static_cast<int>(Pass::Count)] = {};
  gfx::BufferId buffer_ = 0;
  uint32_t capacity_ = 0;
  CurveCache curves_;
  ImageCache images_;
  TextLayouts* texts_ = nullptr;
  std::unordered_map<std::string, std::unique_ptr<text::TextLayout>> labels_;
  std::unordered_map<uint64_t, double> glyphAreas_;
  // The pages' render trees (the current page's, and those thumbnails were drawn from), kept in step with the
  // document (render/RenderTree.h).
  std::unordered_map<Guid, RenderTree, GuidHash> trees_;
  const RenderTree* tree_ = nullptr;  // this frame's
  uint32_t treeFonts_ = 0;            // the font generation the trees' text bounds are from
  Mat2x3 view_;                       // this frame's world → CSS px
  gfx::IRect region_;                 // the part being recorded (device px)
  // The content cache (renderCached).
  bool cacheEnabled_ = false;
  bool exporting_ = false;
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
  struct TileEntry {
    TileCoord coord;
    uint32_t slot = 0;  // atlas × 64 + index
    uint64_t used = 0;  // the frame it was last shown or drawn
  };
  struct TileCache {
    std::vector<gfx::TargetId> atlases;
    std::vector<uint32_t> free;
    std::unordered_map<uint64_t, TileEntry> map;
    Guid page = kNoGuid;
    uint32_t fonts = 0, images = 0;
    double sx = 0, sy = 0;
    Color clear;
    double prefetchAt = 0;  // when the next idle frame should draw tiles ahead (0: none wanted)
  } tiles_;
  std::function<double()> clock_;
  uint32_t labelsGeneration_ = 0;
  CanvasHits hits_;
  bool recordHits_ = false;  // this frame is the canvas's (not a thumbnail or an export)
  // Gradient ramps: 256 premultiplied texels per row.
  std::unordered_map<uint64_t, int> rampRows_;
  std::vector<uint8_t> rampData_;
  int rampRowsUploaded_ = 0, rampCapacity_ = 0;
  gfx::TextureId ramp_ = 0;
  gfx::TextureId white_ = 0;  // 1×1, bound to unused texture units
  // A list: acquire() hands out pointers that stay good while it evicts other targets in the middle of a frame (a
  // deque's erase moves the elements after the one erased: a blur then drew into the target it sampled).
  std::list<PoolTarget> pool_;
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
  gfx::IRect scissor_;     // whole device px: every pixel the clips touch (hard bounds: GPU scissors, culling)
  float clipRect_[4] = {0, 0, 0, 0};  // the same clip, exact (fractional device px): anti-aliased in the shaders
  RoundClip round_;
  std::vector<ShapeClip> shapeClips_;  // this frame's
  int shapeClip_ = -1;                 // the clip shape in force
  uint8_t stencilDepth_ = 0;
  gfx::TextureId curveTexture_ = 0;
  RenderStats stats_;
  // renderScene: the item's props overrides, and culling off (layers may be drawn away from their tree bounds).
  const PropsOverrides* overrides_ = nullptr;
  bool cull_ = true;
  bool outlines_ = false;  // this frame draws the page in outline mode
  bool layoutGuides_ = true;  // frames' layout grids drawn (View › Layout guides)
  Color outlineInk_;       // its colour (light on a dark page, dark on a light one)
};

// A shape instance for a w×h shape placed by `m` (shape space → draw space): a solid fill and / or a solid
// stroke band [−inner, outer] (overlays, clips).
DrawInstance makeShape(const Mat2x3& m, Vec2 size, ShapeKind kind, const CornerRadii& radii, const Color& fill,
                       double fillAlpha, const Color& stroke, double strokeAlpha, double inner, double outer);

}  // namespace eng
