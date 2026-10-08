// Export (docs/engine.md §10.8, E7): what a layer's export draws and at what
// size, as Figma does it (help.figma.com/hc/en-us/articles/13402894554519 and
// 360040028114): a layer's content bounds (its fills, strokes, effects, the
// children a frame doesn't clip, text ink) unless "Include bounding box"
// (useAbsoluteBounds) asks for its box; a slice's own box; with "Ignore
// overlapping layers" off (contentsOnly false) every layer of the page that
// shows inside those bounds; with nothing selected, the page's canvas on the
// page colour (when it shows in exports). The scale is a factor (CONTENT_SCALE,
// "2x") or a width / height in px ("512w", "512h").
//
// The raster formats are drawn by the renderer offscreen (api/Api.cpp); SVG and
// PDF are vector writers over the scene (export/SvgWriter, export/PdfWriter),
// both reading the drawn layers through export/Scene.
#pragma once

#include <string>
#include <unordered_map>
#include <vector>

#include "base/Json.h"
#include "render/ImageCache.h"
#include "render/Renderer.h"
#include "scene/Document.h"

namespace eng::exporter {

enum class Format : uint8_t { PNG, JPEG, SVG, PDF };
// schema ExportConstraintType.
enum class Constraint : uint8_t { SCALE = 0, WIDTH = 1, HEIGHT = 2 };

// schema ExportSettings, with Figma's defaults for what a payload leaves out (the plugin API's: contents only,
// outline text and simplify stroke on, no "id" attributes, no bounding box).
struct Settings {
  Format format = Format::PNG;
  Constraint constraint = Constraint::SCALE;
  double value = 1;
  bool contentsOnly = true;         // "Ignore overlapping layers"
  bool useAbsoluteBounds = false;   // "Include bounding box"
  bool svgIds = false;              // svgIDMode ALWAYS: "Include "id" attribute"
  bool svgOutlineText = true;       // "Outline text"
  bool svgSimplifyStroke = true;    // !svgForceStrokeMasks: "Simplify stroke"
};

// An ExportSettings as JSON with the schema's names (`imageType`, `constraint`, `contentsOnly`, `svgIDMode`, …).
Settings parseSettings(const json::Value& v);
// "png", "jpg", "svg", "pdf".
const char* extensionOf(Format f);

// What one export draws.
struct Target {
  Guid page = kNoGuid;
  Guid node = kNoGuid;  // the exported layer; kNoGuid: the page's canvas
  // Contents only: `node`'s subtree. Otherwise (`region`): every layer of `scope`'s subtree (the page, or a slice's
  // frame) as it shows within `bounds`.
  bool region = false;
  Guid scope = kNoGuid;
  Rect bounds;  // world: what the file shows
  // The canvas export: the page colour under everything (when the page shows it in exports).
  bool background = false;
  Color backgroundColor;
};

// The target of exporting `node` (kNoGuid: the canvas of `page`) with `s`; false when nothing would show.
bool resolveTarget(const Document& doc, TextLayouts* texts, Guid page, Guid node, const Settings& s, Target& out);

// What a layer and its subtree can cover (world): fills, strokes, effects, the children a frame doesn't clip, text
// ink, masks clipping what they mask. `any` (optional): whether anything shows at all.
Rect contentBounds(const Document& doc, TextLayouts* texts, Guid id, bool* any = nullptr);

// A raster export's pixels: `width` × `height`, world point p at ((p - origin) × scale).
struct Raster {
  int width = 0, height = 0;
  double scale = 1;
  Vec2 origin;
};
// The largest export, per side and in pixels (larger ones are scaled down to fit).
inline constexpr int kMaxSide = 16384;
inline constexpr double kMaxPixels = 36.0 * 1024 * 1024;
Raster rasterOf(const Rect& bounds, const Settings& s);

// The layers drawn by a target, in paint order, each once (a region: the page's layers that reach into it).
template <typename F>
void forEachDrawn(const Document& doc, const Target& t, F&& f);

// The images a target draws (handed in with engine_export_image before an SVG or PDF export).
std::vector<ImageHash> imagesOf(const Document& doc, TextLayouts* texts, const Target& t);
// Whether everything the target draws has arrived — every font, every image at the size it's drawn at (a low-res
// tier asks for the original) — requesting what is missing.
bool ready(const Document& doc, TextLayouts* texts, const Target& t, double scale);

// Images handed in for the vector formats (module-wide, like the registries): the file's own bytes (SVG data URIs),
// and for PDF a JPEG of the colour (DCTDecode) or raw RGB, plus an 8-bit alpha plane when it isn't opaque.
struct ImageData {
  std::string encoded;  // the original file (PNG, JPEG, GIF, WebP)
  std::string mime;     // its media type (sniffed)
  uint32_t width = 0, height = 0;
  std::string jpeg;     // PDF: the colour as a JPEG…
  std::string rgb;      // …or as raw RGB8, width × height × 3
  std::string alpha;    // PDF: width × height alpha bytes (empty: opaque)
};
class ImageStore {
 public:
  static ImageStore& get();
  enum Kind : uint32_t { ENCODED = 0, JPEG = 1, RGB = 2 };
  void put(const ImageHash& hash, uint32_t kind, uint32_t width, uint32_t height, std::string data, std::string alpha);
  const ImageData* find(const ImageHash& hash) const;
  void clear() { images_.clear(); }

 private:
  std::unordered_map<ImageHash, ImageData, ImageHashKey> images_;
};

// The media type of an image file by its first bytes ("" when it isn't one the browser shows).
std::string sniffMime(std::string_view bytes);

// ---- Implementation of the template above ----

void forEachDrawnImpl(const Document& doc, const Target& t, const std::function<void(Guid, const Node&)>& f);
template <typename F>
void forEachDrawn(const Document& doc, const Target& t, F&& f) {
  forEachDrawnImpl(doc, t, std::function<void(Guid, const Node&)>(std::forward<F>(f)));
}

}  // namespace eng::exporter
