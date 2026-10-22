// The editor: the document, transactions and undo, layout, the selection, the
// tools and gestures that turn pointer/keyboard input into changes, the
// camera, and the event queue. It knows nothing about the GPU or JavaScript;
// api/Api.cpp feeds it input and drains its events (docs/engine.md §8–§10).
//
// Interim: the tool controller lives in this class (gesture code in
// tools/Gestures.cpp, commands in editor/Commands.cpp) rather than in
// tools/ToolController.
#pragma once

#include <algorithm>
#include <cmath>
#include <functional>
#include <limits>
#include <map>
#include <memory>
#include <string>
#include <string_view>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

#include "base/Json.h"
#include "editor/Annotations.h"
#include "editor/Commands.h"
#include "editor/Keys.h"
#include "editor/Selection.h"
#include "editor/Snapping.h"
#include "editor/Undo.h"
#include "geometry/Brush.h"
#include "geometry/DynamicStroke.h"
#include "geometry/Pathfinder.h"
#include "geometry/PlanarFaces.h"
#include "geometry/VariableWidth.h"
#include "geometry/VectorNetwork.h"
#include "layout/Layout.h"
#include "motion/MotionLayer.h"
#include "proto/Prototype.h"
#include "render/Camera.h"
#include "render/Renderer.h"
#include "scene/ChangeSet.h"
#include "scene/Document.h"
#include "text/DerivedText.h"
#include "text/TextLayout.h"

namespace eng {

// docs/engine.md §8.4's Tool enum (the wire values). Implemented: MOVE, HAND,
// FRAME, RECTANGLE, ELLIPSE; setTool refuses the others.
enum class Tool : uint8_t {
  MOVE, SCALE, HAND, FRAME, SECTION, SLICE, RECTANGLE, LINE, ARROW, ELLIPSE,
  POLYGON, STAR, IMAGE, PEN, PENCIL, TEXT, COMMENT,
  ANNOTATION, MEASUREMENT,
  EYEDROPPER,
  BRUSH, TEXT_PATH,
  ANCHOR_POINT,
  Count
};
// ANNOTATION and MEASUREMENT: Dev Mode's tools (⇧T, ⇧M), editor/DevMode.cpp. Round 8 (tools/CanvasTools.cpp): SCALE (K)
// selects and moves as MOVE, its handles scale the layers with their properties; SLICE (S) draws slices; COMMENT (C) is
// inert until multiplayer; EYEDROPPER (I, ⌃C "Pick color"): a click emits COLOR_PICK and the tool goes back to Move.
// ANCHOR_POINT (Phase 7 round 8, docs/motion.md §4.9; round 8a increment 2, editor/MotionCommands.cpp): Motion's anchor
// point (⌥R there): a press on the selected layer's target drags it, MOTION_SET_ANCHOR when let go; a press elsewhere —
// or any press while Motion is off, which shows no target — goes back to Move. Motion ending puts Move back.
// BRUSH and TEXT_PATH (Phase 7 round 7, docs/draw.md §4.4–4.5; round 7b, tools/DrawTools.cpp): the Brush draws as the
// Pencil does with the Brush's brush (setDrawToolSettings); Text on path makes a TEXT_PATH from a shape's edge.
const char* toolName(Tool t);
bool toolImplemented(Tool t);

// Modifier bits as TS sends them. PRIMARY is the platform's command key (⌘ on
// a Mac, Ctrl elsewhere).
enum Modifier : uint32_t { MOD_SHIFT = 1, MOD_ALT = 2, MOD_CTRL = 4, MOD_META = 8, MOD_PRIMARY = 16 };

enum class PointerEvent : uint8_t { DOWN = 0, MOVE = 1, UP = 2, CANCEL = 3, ENTER = 4, LEAVE = 5 };
enum PointerResult : uint32_t { P_HANDLED = 1, P_CAPTURE = 2 };
enum class KeyEvent : uint8_t { DOWN = 0, UP = 1 };
enum KeyResult : uint32_t { K_HANDLED = 1 };
// PINCH: ctrlKey from a trackpad, or a touch pinch. TRACKPAD / MOUSE: the source by Figma's rule (TS's pointerInput.ts:
// whole-number deltas are a trackpad's); passed through, no behaviour of its own yet (docs/research/rea/canvas.md §2.13).
enum WheelFlags : uint32_t { WHEEL_PINCH = 1, WHEEL_TRACKPAD = 2, WHEEL_MOUSE = 4 };
enum class DeltaMode : uint8_t { PIXEL = 0, LINE = 1, PAGE = 2 };

// APPLY_SYSTEM: journaled and emitted, not an undo step (library bookkeeping); APPLY_EXACT (with APPLY_USER: Restore
// version): the changes are a whole document state computed elsewhere — written as they are, library copies included,
// none of the user-edit rules (no read-only refusal, no detaching, no instance root overrides). APPLY_PEER (with
// APPLY_REMOTE: another session's change — multiplayer, another window): a remote session is an actor (docs/engine.md
// §9.5) — E_BUSY while anything is open (a gesture, a step, an actor's write), so it never joins the user's step, and
// its commit makes every history yield the fields it wrote, the user's too.
enum ApplyFlags : uint32_t { APPLY_USER = 1, APPLY_REMOTE = 2, APPLY_LOAD = 4, APPLY_SYSTEM = 8, APPLY_EXACT = 16, APPLY_PEER = 32 };
enum SetPropsFlags : uint32_t { NO_UNDO_MERGE = 1 };
// PASTE_OVER (⇧⌘V "Paste over selection"): in place, just above the selection (not into it); PASTE_REPLACE (⇧⌘R
// "Paste to replace"): a copy at each selected layer's place, which goes.
enum PasteFlags : uint32_t { PASTE_IN_PLACE = 1, PASTE_OVER = 2, PASTE_REPLACE = 4 };

// docs/engine.md §9.2.
enum class TxnKind : uint8_t { USER, GESTURE, UNDO, REDO, SYSTEM, REMOTE, LOAD };
const char* txnKindName(TxnKind k);

// docs/engine.md §10.4 CursorKind.
enum class CursorKind : uint8_t {
  DEFAULT, HAND, GRABBING, CROSSHAIR, PEN, PEN_ADD, PEN_REMOVE, PEN_CLOSE, IBEAM,
  RESIZE, ROTATE, MOVE_DUPLICATE, ZOOM_IN, ZOOM_OUT, EYEDROPPER, NOT_ALLOWED,
  COMMENT, SCALE,  // round 8: the Comment tool's pin, the Scale tool's arrow
  // Round 15: the Pencil tool's pencil; vector edit's Bend (⌘), Paint, Cut and Lasso tools.
  PENCIL, BEND, PAINT_BUCKET, CUT, LASSO,
  // Round 15: auto layout's padding / gap handle — a double arrow across a short bar, turned to the drag's angle.
  SPACING,
  // Phase 7 round 7 (Draw, docs/draw.md §4.7): the Brush tool; Text on path over a path's edge.
  BRUSH, TEXT_PATH
};
const char* cursorName(CursorKind k);

// Status codes (docs/engine.md §10.3).
enum Status : int32_t { OK = 0, E_HANDLE = -1, E_DECODE = -2, E_INVALID = -3, E_OOM = -4, E_NOT_FOUND = -5,
                        E_READONLY = -6, E_BUSY = -7, E_UNSUPPORTED = -8 };

// Arguments of engine_command.
struct CommandArgs {
  double dx = 0, dy = 0;  // NUDGE
  Guid page = kNoGuid;    // DELETE_PAGE, DUPLICATE_PAGE (the current page when absent)
  std::string mirroring;  // VECTOR_SET_MIRRORING
  std::string start, end; // SET_END_CAPS (StrokeCap names; empty = unchanged)
  bool hasX = false, hasY = false, hasCornerRadius = false;
  double x = 0, y = 0, cornerRadius = 0;  // VECTOR_SET_POINTS; PLACE_IMAGES (x, y: a page point)
  ImageHash hash;                          // PLACE_IMAGES
  double width = 0, height = 0;
  std::string name;
  json::Value raw;                         // the whole args object (component commands read theirs from it)
};

// What the panels show for a node's component side (componentInfo, docs/engine-build.md "E6").
struct ComponentProperty {
  Guid id = kNoGuid;
  std::string name;
  ComponentPropType type = ComponentPropType::BOOL;
  ComponentPropValue defaultValue, value;
  std::string defaultVariant, variantValue;  // VARIANT
  bool overridden = false;
  std::vector<Guid> preferredValues;
  std::vector<std::string> variantOptions;
  std::vector<Guid> boundLayers;
  // The variable the value (an instance's variant) or the default (a main's boolean / text property) is bound to.
  Guid boundVariable = kNoGuid;
};
// Figma's StateGroupError, in its order (the worst is the highest): a set past 1000 variants, a variant with no value
// for one of the set's Variant properties, two variants with the same values, a name that isn't "Property=Value, …".
enum class VariantError : uint8_t { NONE = 0, TOO_MANY_STATES = 1, MISSING_PROPERTIES = 2, DUPLICATE_STATE = 3, PARSE = 4 };
// Figma: "Components with more than 1000 variants may experience performance issues".
constexpr size_t kMaxVariants = 1000;
struct ComponentInfo {
  enum class Kind : uint8_t { NONE, COMPONENT, VARIANT, COMPONENT_SET, INSTANCE, NESTED_INSTANCE, INSTANCE_SUBLAYER, COMPONENT_SUBLAYER };
  Kind kind = Kind::NONE;
  Guid ref = kNoGuid;
  Guid main = kNoGuid, mainPage = kNoGuid, mainSet = kNoGuid;
  std::string mainName;
  bool mainSoftDeleted = false;
  Guid missingVariantSet = kNoGuid;  // the main is a deleted variant of this set (Figma's missing variant panel)
  bool mainRemote = false, mainCopied = false;  // a library copy; copied in from another file
  std::string mainLibraryKey, mainKey, mainVersion;
  Guid instance = kNoGuid;
  std::vector<Guid> path;
  struct Override {
    Guid ref;
    std::vector<std::string> fields;
  };
  std::vector<Override> overrides;
  std::vector<ComponentProperty> properties;
  struct Exposed {
    Guid ref;
    std::string name;
    std::vector<ComponentProperty> properties;
  };
  std::vector<Exposed> exposedInstances;
  bool hasVariantProperties = false;
  std::vector<std::pair<std::string, std::string>> variantProperties;
  bool canPush = false, canReset = false, canDetach = false, isExposed = false, mainDeleted = false;
  bool canExpose = false;  // a primary instance in a main that Figma lets expose its properties (canExposeInstance)
  uint32_t instanceCount = 0;
  // Figma's variant errors (atlas 10 §4.2): a variant's own, or a set's worst — TOO_MANY_STATES past 1000 variants
  // when none has one — with the variants that have it ("Select invalid / conflicting variants" selects them).
  VariantError variantError = VariantError::NONE;
  std::vector<Guid> errorVariants;
};

// Figma's default name of a new component property: `base`, else "base N+1" past the highest "base N" in `taken`.
std::string defaultPropertyName(const std::vector<std::string>& taken, const std::string& base);
// A NUMBER property's value (atlas 10 §5.2): a finite number, or text Figma accepts ("-1", "2.5", ".5"; not blank),
// stored rounded to 2 decimals; false for anything else. Shown without trailing zeros or a trailing "." (NaN: "0").
bool propNumber(const json::Value& v, float& out);
std::string formatPropNumber(double v);

// What a copy puts on the clipboard (docs/schema.md §4.1): the copied nodes as
// CREATED with their source GUIDs, parents first; for each source parent, its
// origin on the page (Figma's clipboardSelectionRegions.enclosingFrameOffset).
struct Clipboard {
  std::vector<NodeChange> nodes;  // the selection (in `regions`) and, cross-file, what it references (outside them)
  struct Region {
    Guid parent;
    std::vector<Guid> nodes;
    Vec2 offset;
  };
  std::vector<Region> regions;
  Guid page = kNoGuid;
  std::string fileKey;  // pasteFileKey: the file it was copied from
  bool isCut = false;
};

// Instances' override paths in Figma's form (they cross nested instances only, docs/schema.md §5.1): the tree paths
// this engine wrote before 2026-10-08 lose their intermediate frames, entries that then name one sublayer merge.
void normalizeOverridePaths(std::vector<NodeChange>& nodes);
// Slot content in Figma's form (under the Internal Only Canvas, named by its instance's SLOT assignment) moves under
// the instance it fills: drawn in its slot, resolved in its slot's modes (slotHosts_).
void adoptSlotContent(std::vector<NodeChange>& nodes);

// Figma Draw (editor/DrawCommands.cpp): SVG path data (a BrushArtwork's `d`: M L H V Q C Z, absolute or relative) as a
// path; a brush laid along a fixed S-curve as straight RGBA (black, coverage in alpha), w × h px at `weight`.
bool parseSvgPath(std::string_view d, geom::Path& out);
// A scatter brush is laid out with `settings` (its own; Figma's base when null).
bool brushPreview(const geom::Path& artwork, Vec2 box, bool scatter, int w, int h, double weight, std::string& rgba,
                  const geom::ScatterSettings* settings = nullptr);

class Editor : private LayoutHost, public TextLayouts {
 public:
  Editor();

  // ---- Document ----
  // ---- Derived data stored in the file (docs/engine-build.md "Figma parity round 3" §2; Figma's derivedSymbolData
  // 125 and derivedTextData 359). The stamp the engine writes into Message.derivedDataVersion and trusts at load: bump it
  // whenever layout or text layout would give a different result.
  // 3: derivedSymbolData paths cross nested instances only (Figma's) and slot content is a layer of its instance, drawn
  // in its slot (the fig-import-fidelity branch's 2, merged with round 4's 1); 1 named every frame on the way. Older
  // snapshots' stored data is re-derived; their override paths and slot content are converted at load
  // (normalizeOverridePaths, adoptSlotContent).
  // 4 (2026-10-13): a Fill child held by its max (or min) is placed by its frame's counter alignment — 3 put it at the
  // start, and files it laid out keep that geometry until their pages are laid out again.
  static constexpr uint32_t kDerivedDataVersion = 4;
  // Figma's own derived data, kept by a .fig import (src/shared/fig/convert.ts FIGMA_DERIVED_DATA_VERSION): the same
  // fields in the same shape, Figma's layout result. Read as this engine's own (a missing font's text draws Figma's
  // outlines, instances and auto layout open as Figma laid them out); never written.
  static constexpr uint32_t kFigmaDerivedDataVersion = 0x46494701;
  // One stored instance sublayer: where it is (its guidPath from the instance) and what layout gave it.
  struct StoredRow {
    std::vector<Guid> path;
    bool hasSize = false, hasTransform = false;
    Vec2 size;
    Mat2x3 transform;
    std::shared_ptr<const text::StoredText> text;
  };
  struct StoredDerived {
    std::unordered_map<Guid, std::shared_ptr<const text::StoredText>, GuidHash> texts;  // real TEXT nodes
    std::unordered_map<Guid, std::vector<StoredRow>, GuidHash> symbols;                 // per real INSTANCE
    bool sparse = false;  // Figma's derivedSymbolData: only the sublayers whose geometry isn't the main's
  };
  // Instances / texts whose stored data was used at their derivation, and those whose stored data didn't match.
  uint32_t derivedUsed() const { return derivedUsed_; }
  uint32_t derivedStale() const { return derivedStale_; }
  // A node's derived fields for a snapshot (derivedTextData of a TEXT node, derivedSymbolData of an instance): kiwi
  // fields appended to `fields`, their outlines to `blobs`. What isn't derived yet (pages never shown) is written from
  // what was loaded, when it is still current.
  void encodeDerivedFields(Guid id, std::string& fields, codec::BlobsOut& blobs);

  // Replaces the document with `nodes` (any order) and shows `page` (the first
  // CANVAS when kNoGuid). Resets undo and the selection. Emits nothing to storage. `derived`: the data the snapshot
  // stored with this engine's stamp — the opened page's instances take their sublayers' layout from it, texts draw
  // from it until their fonts arrive (and when a font is missing), stored auto-layout geometry is trusted.
  void loadDocument(std::vector<NodeChange>&& nodes, Guid page, StoredDerived* derived = nullptr);
  void loadDocument(const std::vector<NodeChange>& nodes, Guid page) { loadDocument(std::vector<NodeChange>(nodes), page); }
  void setSessionID(uint32_t sessionID);
  uint32_t sessionID() const { return sessionID_; }
  // Changes from outside. APPLY_USER: undoable and emitted (one step); APPLY_SYSTEM: emitted, not undoable
  // (E_BUSY inside an open user step); APPLY_REMOTE / APPLY_LOAD: neither (APPLY_REMOTE | APPLY_PEER: E_BUSY unless
  // idle, every history yields). User and system changes never write into library copies, unless APPLY_EXACT (a
  // store-computed state: Restore version).
  Status applyChanges(const std::vector<NodeChange>& changes, uint32_t flags);
  // Every node, parents before children (a full snapshot).
  std::vector<NodeChange> encodeDocument() const;
  // What a prototype played on `page` needs (the inline preview, Present here; Figma's viewer loads only the page it
  // presents): the DOCUMENT, every page node, the internal canvases whole, `page` whole, and from the other pages —
  // transitively — the components its instances show (a variant with its whole set, for Change to), the defaults of
  // their instance-swap properties and the nodes its interactions reach, each with its ancestors (their own fields
  // only); variables and styles wherever they are. Parents before children, as encodeDocument.
  std::vector<NodeChange> encodePage(Guid page) const;
  // An engine holding such a subset: nodes created under a parent it doesn't have are skipped, and the nodes a change
  // needs that it doesn't have — a layer moved in from elsewhere, a component an instance now shows, an interaction's
  // destination — are noted (takeLacking; their ids, at most 64, until taken or the next load) so its owner can
  // load a new subset.
  void setPartial(bool on) { partial_ = on; }
  bool partial() const { return partial_; }
  // A presentation's engine (whole document or subset) derives its page's screens as the player shows them
  // (deriveTree), not the whole page at load.
  void setLazyScreens(bool on) { lazyScreens_ = on; }
  std::vector<Guid> takeLacking() { return std::exchange(lacking_, {}); }
  // The next load copies a live engine's document (engine_load_page_of): its bound values are current, except on the
  // pages `stale` that engine hasn't resolved yet (pagesUnresolved). They aren't resolved again at load — only their
  // dependencies are noted, between frames (deriveNextTrees), or at once when a variable, a collection, a style or a
  // mode changes (the player's Set variable / Set variable mode).
  void setFreshBindings(std::vector<Guid> stale) {
    freshBindings_ = true;
    staleCanvases_ = std::unordered_set<Guid, GuidHash>(stale.begin(), stale.end());
  }
  // The pages whose bound values this engine hasn't resolved yet (not shown: pageBindings_).
  std::vector<Guid> pagesUnresolved() const;
  Status setCurrentPage(Guid page);
  std::vector<Guid> pages() const;  // O(1): the DOCUMENT node's canvases (the internal one left out)
  // Materializes `page`'s instances and verifies its auto layout, once (docs/engine.md §3.4 as built: per page, on
  // first show — setCurrentPage, a Layers read, a thumbnail, a read of one of its nodes). One SYSTEM change; a no-op
  // for a page already derived. `derivePageOf(id)`: the page holding `id`.
  void derivePage(Guid page);
  // On the Internal Only Canvas only what needs it is derived: a read of an instance or of one of its sublayers, or a
  // read of a whole subtree (`subtree`); a style, a variable or a main read for its own fields derives nothing.
  void derivePageOf(Guid id, bool subtree = false);
  void deriveInternal(Guid top);
  // A presentation's engine (setLazyScreens) derives its page's screens as the player shows them, not the whole page at
  // its load: derivePage resolves the page's bound values only, deriveTree(screen) its instances and auto layout
  // (instances elsewhere on the page wait), deriveNextTrees spends `budgetMs` on screens not shown yet — `only` those
  // when given (the player's upcoming ones) — at least one a call, true while some remain.
  void deriveTree(Guid top);
  bool deriveNextTrees(Guid page, double budgetMs, const std::vector<Guid>* only = nullptr);
  bool pageDerived(Guid page) const { return derivedPages_.count(page) != 0; }
  const Document& document() const override { return doc_; }
  Guid page() const { return page_; }

  // ---- View ----
  void setViewport(double cssWidth, double cssHeight, double dpr, int pixelWidth, int pixelHeight);
  const Viewport& viewport() const { return viewport_; }
  // What the panels over the canvas cover (CSS px): fitting, centring and "in view" use the rest.
  void setViewportInsets(double left, double top, double right, double bottom);
  const Camera& camera() const { return camera_; }
  void setCamera(const Camera& c);
  // Round 18: canvas CSS px → page coordinates under the camera now; the camera putting page point `world` at the
  // centre of the visible part (Viewport::visible) at `zoom` (clamped; CAMERA_CHANGED like any camera move); the page
  // point at the visible part's centre and the zoom (docs/engine.md §9.6).
  Vec2 screenToWorld(Vec2 screen) const { return camera_.toWorld(screen); }
  void centerOn(Vec2 world, double zoom);
  Camera viewCenter() const;
  void setTheme(Theme t);
  Theme theme() const { return theme_; }

  // ---- Input (CSS px relative to the canvas) ----
  uint32_t pointer(PointerEvent type, double x, double y, int button, uint32_t buttons, uint32_t mods, int clickCount = 1);
  uint32_t wheel(double x, double y, double dx, double dy, DeltaMode mode, uint32_t mods, uint32_t flags);
  uint32_t key(KeyEvent type, KeyCode code, uint32_t codepoint, uint32_t mods, bool repeat);
  void modifiers(uint32_t mods);
  void blur();
  // Figma's coalesced drags (docs/engine.md §8.4): while a gesture runs, a MOVE only keeps its position and the next
  // tick() handles the latest one; any other input handles it first. Hover moves stay immediate. Off by default (the
  // canvas's controller turns it on).
  void setCoalesceMoves(bool on);
  bool coalesceMoves() const { return coalesceMoves_; }
  bool moveQueued() const { return queuedMove_.on; }
  // Drag replays so far (tests): a move run again at the same pointer because it reflowed the page under the drag.
  uint32_t dragReplays() const { return dragReplays_; }

  // ---- View options (View › Pixel grid, Outlines) ----
  // Round 8: VIEW_RULERS (⇧R: ruler guides shown, dragged and snapped to), VIEW_SNAP_PIXELS (Preferences › Snap to pixel
  // grid, ⇧⌘′: gestures land on whole px), VIEW_SLICES (View › Show slices), VIEW_PIXEL_PREVIEW / _2X (⌃P: the page drawn
  // at 1x / 2x and scaled up without smoothing).
  // Round 9, the Figma menu › Preferences (live Figma's defaults in kViewOptionsDefault): VIEW_SNAP_GEOMETRY (vector edit:
  // a dragged point snaps to the other points), VIEW_SNAP_OBJECTS (moves, resizes and draws snap to the other layers'
  // edges and centres and the parent frame's), VIEW_KEEP_TOOL (Keep tool selected after use: a shape tool stays after a
  // draw), VIEW_SHOW_DIMENSIONS (the W × H badge under the selection), VIEW_FLIP_RESIZE (an edge dragged past the
  // opposite one mirrors the layer; off: the box grows the other way, unmirrored), VIEW_KEYBOARD_ZOOM_SELECTION (Zoom
  // in / out about the selection), VIEW_INVERT_ZOOM (⌘ + wheel / pinch the other way), VIEW_SCROLL_WHEEL_ZOOM (a plain
  // wheel zooms; ⌘ / Ctrl + wheel pans), VIEW_RIGHT_DRAG_PAN (a right drag pans; the context menu opens on a right click's
  // release).
  enum ViewOption : uint32_t {
    VIEW_PIXEL_GRID = 1, VIEW_OUTLINES = 2, VIEW_LAYOUT_GUIDES = 4, VIEW_RULERS = 8, VIEW_SNAP_PIXELS = 16, VIEW_SLICES = 32,
    VIEW_PIXEL_PREVIEW = 64, VIEW_PIXEL_PREVIEW_2X = 128, VIEW_SNAP_GEOMETRY = 256, VIEW_SNAP_OBJECTS = 512,
    VIEW_KEEP_TOOL = 1024, VIEW_SHOW_DIMENSIONS = 2048, VIEW_FLIP_RESIZE = 4096, VIEW_KEYBOARD_ZOOM_SELECTION = 8192,
    VIEW_INVERT_ZOOM = 16384, VIEW_SCROLL_WHEEL_ZOOM = 32768, VIEW_RIGHT_DRAG_PAN = 65536,
    // Round 10, View › Frame outlines / Mask outlines: each frame's / mask's box as a thin line (unverified look).
    VIEW_FRAME_OUTLINES = 131072, VIEW_MASK_OUTLINES = 262144,
    // Atlas wave 1, View › Outlines ▸ Show hidden layers / Show object bounds (Figma's toggle-outline-mode-hidden-layers /
    // -object-bounds, Atlas 04 §9.3): in outline mode, hidden layers outlined too; each layer's box drawn.
    VIEW_OUTLINE_HIDDEN = 524288, VIEW_OUTLINE_BOUNDS = 1048576
  };
  static constexpr uint32_t kViewOptionsAll = 2097151;
  static constexpr uint32_t kViewOptionsDefault = VIEW_PIXEL_GRID | VIEW_LAYOUT_GUIDES | VIEW_SNAP_PIXELS | VIEW_SLICES | VIEW_SNAP_GEOMETRY |
                                                  VIEW_SNAP_OBJECTS | VIEW_SHOW_DIMENSIONS | VIEW_FLIP_RESIZE | VIEW_RIGHT_DRAG_PAN;
  void setViewOptions(uint32_t options);
  uint32_t viewOptions() const { return viewOptions_; }
  // Preferences › Nudge amount… (Small nudge, Big nudge: the arrows and ⇧ arrows), CSS-free page units.
  void setNudge(double small, double big);
  double nudgeSmall() const { return nudgeSmall_; }
  double nudgeBig() const { return nudgeBig_; }

  // ---- Ruler guides (round 8, tools/CanvasTools.cpp; Figma's `guides` on pages and frames) ----
  // axis 0 (X): a vertical guide at x = offset; 1 (Y): a horizontal one at y = offset — in the owner's space (a page's
  // or a top-level frame's).
  struct RulerGuide {
    Guid owner = kNoGuid;
    int axis = 0;
    double offset = 0;
    Guid id = kNoGuid;
    bool operator==(const RulerGuide& o) const { return owner == o.owner && axis == o.axis && offset == o.offset && id == o.id; }
  };
  std::vector<RulerGuide> guidesOf(Guid owner) const;
  // The rulers' press: a new guide dragged out of a ruler (axis 0: the left ruler's vertical guide, 1: the top
  // ruler's horizontal one) from `screen` (canvas CSS px); `rulerSize`: the rulers' thickness (a guide let go over a
  // ruler goes). The pointer events that follow drive it.
  Status startGuideDrag(int axis, Vec2 screen, double rulerSize);
  // Whose guides the rulers add to: the one selected top-level frame (axis-aligned), else the page.
  Guid guideOwner() const;
  bool hasSelectedGuide() const { return selectedGuide_.owner != kNoGuid; }
  const RulerGuide& selectedGuide() const { return selectedGuide_; }

  // ---- Tools, hover, frames ----
  Status setTool(Tool t);
  Tool tool() const { return tool_; }
  void setHover(const std::vector<Guid>& ids);  // Layers row hover → canvas outline
  // Round 18: other people in the file (multiplayer presence) — replaces the whole set ([] clears) and asks for a frame.
  // Chrome only: drawn in the editor's overlay (selections under the local chrome, cursors over it), never hit-tested,
  // never in the document, undo, exports, thumbnails or the content cache. Selected GUIDs not on the page are skipped.
  void setPresence(std::vector<PresencePeer> peers);
  const std::vector<PresencePeer>& presence() const { return presence_; }
  // The local user's own cursor chat ("/"): their bubble by their pointer at page point `at`, in the selection blue,
  // no arrow or name (`on` false: none; empty text: the placeholder).
  void setLocalChat(const LocalChat& chat);
  const LocalChat& localChat() const { return localChat_; }
  // Round 16: the Design panel's padding / gap field under the pointer (or focused) hatches what it edits on the
  // selected auto-layout frame — bits SPACING_* (1 left, 2 top, 4 right, 8 bottom, 16 every gap), 0 none.
  enum : uint32_t { SPACING_LEFT = 1, SPACING_TOP = 2, SPACING_RIGHT = 4, SPACING_BOTTOM = 8, SPACING_GAPS = 16 };
  void setSpacingHighlight(uint32_t mask);
  uint32_t spacingHighlight() const { return panelSpacing_; }
  bool tick(double timeMs);                     // true: draw a frame
  // Round 15: ms until a timed piece of chrome changes (the `</>` button's tooltip), −1: none.
  int32_t chromeDelay() const;
  // Round 15: siblings sliding; round 16: the camera gliding (animateCamera).
  bool needsFrame() const { return needsRender_ || !slides_.empty() || camAnim_.on || queuedMove_.on || replayWanted_; }
  // ---- Canvas navigation (editor/CanvasNav.cpp, round 16) ----
  // The camera glides to `to` over `ms` (ease in-out; the zoom geometric and the path a zoom about a point when it is
  // one); any pan, zoom or press stops it.
  void animateCamera(const Camera& to, double ms);
  void stopCameraAnimation();
  bool cameraAnimating() const { return camAnim_.on; }
  // The scrollbars' geometry now (the page's content on screen against the visible canvas).
  Scrollbars scrollbars();
  double scrollbarAlpha() const { return scroll_.alpha; }
  // Something the canvas shows changed outside the document (an image arrived): draw again.
  void invalidateCanvas() { needsRender_ = true; }
  void rendered() { needsRender_ = false; }
  Overlay overlay() const;
  CursorKind cursor() const { return cursor_; }
  double cursorAngle() const { return cursorAngle_; }
  Guid hover() const { return hover_; }
  // Frame titles and section pills on screen now (render/FrameTitles.h, measured as the overlay draws them); a press
  // on one takes its frame (titleAt).
  std::vector<FrameTitle> titles() const;

  // ---- Selection, writes, commands (panels, menus, the Layers panel) ----
  const std::vector<Guid>& selection() const { return selection_; }
  // A grid frame's cells as laid out now (tracks, items' cells); empty for other nodes.
  Layout::GridCells gridCellsOf(Guid frame) { return Layout(*this).gridCells(frame); }
  Status setSelection(const std::vector<Guid>& ids);
  // The generic setter: the fields of `props` (mask) written on each node.
  Status setProps(const std::vector<Guid>& ids, const NodeChange& props, uint32_t flags);
  // Panel scrubs: everything between begin and commit is one undo step and one message.
  Status txnBegin(const std::string& label);
  // A plugin run's slice (docs/plugins.md §3.1): a USER transaction like txnBegin's that marks the step it makes;
  // `join` folds it into the user's last step when that is still the step the last run slice made (nothing committed
  // or undone in the user's history since) — a run's writes are one undo step however many slices made them, and
  // figma.commitUndo() starts the next slice with join = false.
  Status txnBeginRun(const std::string& label, bool join);
  Status txnCommit();
  void txnCancel();
  Status command(CommandId id, double dx = 0, double dy = 0);
  Status command(CommandId id, const CommandArgs& args);
  uint32_t commandState(CommandId id) const;

  // ---- Figma Motion (docs/motion.md §4.9, §5; round 8a: motion/MotionLayer.*) ----
  // The view state: Motion on / off, the timeline root shown (kNoGuid: the selection's root), the playhead, auto-keyframe.
  // Setting it applies the evaluated values as preview writes (the motion layer) or restores the base values; the
  // document itself never changes. Omitted parts keep their value (setMotionJson, the ABI's engine_set_motion).
  void setMotion(const motion::State& s);
  Status setMotionJson(const json::Value& v);
  const motion::State& motion() const { return motion_; }
  // The root the layer plays now (the state's, or the selection's), kNoGuid when none.
  Guid motionRoot() const;
  // The decoded model (rebuilt after a commit; tests, the timeline reads of round 8b).
  const motion::MotionIndex& motionIndex();
  // How many times the motion index was rebuilt (Batch D's tests: a commit without motion data keeps it).
  uint64_t motionRebuilds() const { return motionRebuilds_; }
  // How many times an instance was derived (materialize) — Batch D's tests: a size from layout refits instead.
  uint64_t materializations() const { return materializations_; }
  const motion::MotionLayer& motionLayer() const { return motionLayer_; }
  // The base values put back for the scope (storage, exports, the clipboard), the layer applied again after it.
  motion::Suspend motionSuspended();
  // Round 8b (editor/MotionCommands.cpp): the timeline model of a root (or of the selection's: kNoGuid), the right
  // panel's diamonds for nodes, the resolved model of a root or a layer — as JSON (src/shared/motion/types.ts shapes).
  void writeMotionTimeline(json::Writer& w, Guid root);
  void writeMotionFieldStates(json::Writer& w, const std::vector<Guid>& ids);
  void writeMotionResolved(json::Writer& w, Guid node);
  // Round 8e (editor/MotionExport.cpp): what the vector exports draw — the root's layers as shapes at base values, and
  // their evaluated transform, opacity, path trim, solid colours and stroke weight at each of `times` (µs).
  void writeMotionShapes(json::Writer& w, Guid root);
  void writeMotionSamples(json::Writer& w, Guid root, const std::vector<int64_t>& times);

  // ---- Figma Draw (docs/draw.md §4; round 7b: editor/DrawCommands.cpp, tools/DrawTools.cpp) ----
  // The Pencil's and the Brush's settings (the secondary toolbar's DrawToolSettings, src/shared/draw/types.ts).
  struct DrawTools {
    struct Pencil {
      Color color{0, 0, 0, 1};
      double opacity = 1, weight = 2;
      bool dynamic = false;
      geom::DynamicSettings settings;
    } pencil;
    struct Brush {
      Color color{0, 0, 0, 1};
      double opacity = 1, weight = 4;
      Guid brush = kNoGuid;
    } brush;
  };
  Status setDrawToolSettings(const json::Value& v);
  const DrawTools& drawTools() const { return drawTools_; }
  // INSTALL_BRUSH: a BRUSH node on the Internal Only Canvas with this artwork (its own box, the stroke along +x); the
  // one already there with this name and type when there is one. Inside an open step it joins it; otherwise it is a
  // system write (journaled, no undo step: installing a brush to pick it isn't an edit). kNoGuid on bad input.
  // A scatter brush's node carries its own scatterStrokeSettings (449): `settings` over Figma's base {gap 0.9, 0…}
  // (the built-ins' measured values, rea/vector.md §5; a custom brush the base).
  Guid installBrush(const std::string& name, bool scatter, Vec2 size, const geom::Path& artwork, WindingRule rule,
                    const json::Value* settings = nullptr);
  struct BrushInfo {
    Guid guid = kNoGuid;
    std::string name;
    bool scatter = false;
  };
  // The file's BRUSH nodes, in document order.
  std::vector<BrushInfo> listBrushes() const;
  // A BRUSH node's artwork (its fill paths, own space) and box; false when `id` isn't a usable brush.
  // `settings`: a scatter brush's own settings over Figma's base.
  bool brushArtwork(Guid id, geom::Path& out, Vec2& box, bool& scatter, geom::ScatterSettings* settings = nullptr) const;
  // A selected TEXT_PATH's start handle (world), when one shows (selected alone, not being edited).
  bool textPathHandle(Guid& node, Vec2& world) const;
  // The layer whose edge the Text on path tool would write on at `world` (kNoGuid: none).
  Guid textPathTargetAt(Vec2 world) const;
  // Layers panel drag: `ids` to `parent` at `index` in paint order (0 = bottom-most,
  // n = above the top-most), keeping their relative order and their place on the
  // page. Pages: parent = the DOCUMENT. Returns how many moved (0 = refused).
  uint32_t moveNodes(const std::vector<Guid>& ids, Guid parent, uint32_t index);
  // The selection as a clipboard Message (nothing selected: false).
  bool copySelection(Clipboard& out, bool cut = false) const;
  // Pastes with fresh GUIDs: into the selected frame, beside the selected layer,
  // or on the page (where it was if that's in view, else at the view's centre);
  // `inPlace` (⇧⌘V): exactly where it was. Selects what was pasted; returns how
  // many top-level layers that was.
  uint32_t paste(const Clipboard& clip, bool inPlace);
  uint32_t pasteWith(const Clipboard& clip, uint32_t flags);  // PasteFlags
  bool canUndo() const { return undo_.canUndo(); }
  // Figma's openIgnoreUndoRedoScope / closeIgnoreUndoRedoScope (docs/research/rea/canvas.md §2.4): while one is open
  // (they nest), writes go into the document and the transaction's changes as usual but leave no inverse in any undo
  // history — system bookkeeping that must not become, or join, a step. Closing more than were opened does nothing.
  void openIgnoreUndo() { ignoreUndo_++; }
  void closeIgnoreUndo() {
    if (ignoreUndo_ > 0) ignoreUndo_--;
  }
  bool ignoringUndo() const { return ignoreUndo_ > 0; }
  bool canRedo() const { return undo_.canRedo(); }
  const UndoStack& undoStack() const { return undo_; }
  // The local user's undo history as Figma's Message.localUndoStack / localRedoStack (docs/research/rea/canvas.md
  // §2.18): the last `maxSteps` steps of each, fewer when they pass `maxBytes`. Per device: the store keeps it beside
  // the file, never in a snapshot. Labels and selections don't travel (a restored step selects nothing).
  std::string exportUndoHistory(size_t maxSteps = 100, size_t maxBytes = 16u << 20) const;
  // Takes such a history back (the document must be the one it was exported from). False on malformed bytes or while
  // a transaction is open; the history is left as it was then.
  bool importUndoHistory(std::string_view bytes);

  // ---- Actors (docs/engine.md §9.5): per-actor undo and view state ----
  // Actor 0 is the local user (⌘Z / ⇧⌘Z, the selection, the page, the view). Any other id is a writer working
  // beside them — an agent's chat turn today, a multiplayer session in Phase 6 — with its own undo history and its
  // own selection and page while it writes. actorBegin opens one write of `actor` as a step (a USER transaction):
  // until actorEnd the selection is `selection` (on `page`: given, else the first selected layer's, else the user's)
  // and commands, reads of the selection and the step's undo record are the actor's; the user's selection, page,
  // view, text / vector / gradient edit and selected connection are set aside untouched and their events held back.
  // `merge` joins the step to the actor's last one (an agent turn is one step however many writes it made). `undoTo`
  // names the history the step goes to (default: the actor's own; 0: the user's — an outside client's call, which
  // ⌘Z takes back). E_BUSY while a gesture or another step is open: the caller waits and tries again.
  Status actorBegin(uint32_t actor, const std::vector<Guid>& selection, Guid page, const std::string& label, bool merge, uint32_t undoTo);
  // Commits (or, `cancel`, rolls back) the actor's write and puts the user's view state back.
  Status actorEnd(bool cancel);
  // Undo / redo the actor's last step — only its fields that nobody changed since — without touching the user's
  // selection, page or view (a layer it removes leaves their selection).
  bool actorUndo(uint32_t actor, bool redo);
  struct ActorInfo {
    bool canUndo = false, canRedo = false;
    std::string undoLabel, redoLabel;
    std::vector<Guid> overwritten;  // nodes whose changes by the actor someone else changed since
  };
  ActorInfo actorInfo(uint32_t actor) const;
  void forgetActor(uint32_t actor);
  bool inActor() const { return scope_.on; }
  // Nothing open: no gesture past its threshold, no step (a panel scrub), no actor write.
  bool idle() const { return !busy() && !txn_.open && !scope_.on; }

  // ---- Events ----
  struct DocumentChanged {
    TxnKind kind;
    std::string label;
    std::vector<NodeChange> changes;
    uint32_t actor = 0;  // who made it (0: the local user; see actorBegin)
  };
  // CONTEXT_MENU: a right-click (or ⌃-click on a Mac), after the selection settled.
  struct ContextMenu {
    bool guide = false;  // round 8: on a ruler guide (the menu: Remove guide)
    bool selection = false;  // targetKind SELECTION (else CANVAS)
    double x = 0, y = 0;     // CSS px in the canvas
    std::vector<std::vector<Guid>> hits;  // each layer under the point, innermost first; topmost layer first
  };
  // The last connection made by a drag (PROTOTYPE_CONNECTED): its hotspots and the interaction's id.
  struct PrototypeConnected {
    std::vector<Guid> nodes;
    Guid interaction = kNoGuid;
  };
  // A connection clicked on the canvas (its line or its label; PROTOTYPE_CONNECTION_SELECTED, round 17): its hotspot,
  // the interaction's index among the hotspot's live ones, and where its label sits (screen, CSS px — the Interaction
  // details popover opens under it, live 62–63.png).
  struct PrototypeSelected {
    Guid node = kNoGuid;
    int index = -1;
    double x = 0, y = 0, w = 0, h = 0;
  };
  // The grid tracks selected on the canvas (GRID_TRACKS); `edit`: a pill's chevron was clicked (or Enter) — TS opens
  // the label's field and the sizing list at `label` (screen, CSS px; round 12, live grid/row-track-menu.txt).
  struct GridTracksEvent {
    Guid frame = kNoGuid;
    bool column = true;
    std::vector<size_t> tracks;
    bool edit = false;
    Rect label;
  };
  // ANNOTATION_OPEN: a click on an annotation's label or dot (index ≥ 0), or the Annotation tool's click on a layer
  // (index −1: a new note); `rect`: CSS px in the canvas (the label, else the layer).
  struct AnnotationOpen {
    Guid node = kNoGuid;
    int index = -1;
    Rect rect;
  };
  // MEASUREMENT_EDIT: a double-click on a saved measurement (its custom text); `rect`: the value's pill.
  struct MeasurementEdit {
    Guid id = kNoGuid;
    Rect rect;
    std::string text;
  };
  // REQUEST_RENAME: a double-click on a frame's title or a section's pill — TS edits the name in place over `rect`
  // (CSS px in the canvas).
  struct RenameRequest {
    Guid node = kNoGuid;
    Rect rect;
  };
  // DEV_STATUS: a click on a design's status chip ("menu") or on "Mark as ready for dev" ("mark").
  struct DevStatusClick {
    Guid frame = kNoGuid;
    std::string action;
    Rect rect;
  };
  // REQUEST_INLINE_EDIT (round 8): a click on a selected auto-layout frame's padding or gap bar — TS edits the value in
  // place over `rect` (canvas CSS px); field: PADDING_LEFT / _TOP / _RIGHT / _BOTTOM, GAP.
  struct InlineEdit {
    Guid node = kNoGuid;
    std::string field;
    double value = 0;
    Rect rect;
  };
  struct Events {
    std::vector<Vec2> colorPicks;             // COLOR_PICK (round 8): the eyedropper clicked there (canvas CSS px)
    std::vector<InlineEdit> inlineEdits;      // REQUEST_INLINE_EDIT
    std::vector<AnnotationOpen> annotationOpens;
    std::vector<MeasurementEdit> measurementEdits;
    std::vector<DevStatusClick> statusClicks;
    bool measurementSelection = false;  // MEASUREMENT_SELECTED
    std::vector<DocumentChanged> documents;        // DOCUMENT_CHANGED, one per committed transaction
    std::vector<ContextMenu> contextMenus;
    std::vector<std::pair<Guid, uint32_t>> nodes;  // NODES_CHANGED: node, field groups (merged)
    std::vector<Guid> components;                  // COMPONENTS_CHANGED: instances re-derived, the mains they come from
    std::vector<Guid> collections, variables;      // VARIABLES_CHANGED
    std::vector<Guid> styles;                      // STYLES_CHANGED: styles changed, or their usage
    // STRUCTURE_CHANGED: the nodes (the page included) whose child lists changed; `structureAll`: can't say (a load,
    // a page switch, too many) — the event carries null and the Layers tree re-reads the page.
    std::vector<Guid> structureParents;
    bool structureAll = false;
    std::vector<PrototypeConnected> prototypeConnected;  // PROTOTYPE_CONNECTED
    std::vector<PrototypeSelected> prototypeSelected;    // PROTOTYPE_CONNECTION_SELECTED
    std::vector<GridTracksEvent> gridTracks;             // GRID_TRACKS: the grid tracks selected on the canvas
    std::vector<RenameRequest> renames;                  // REQUEST_RENAME: a double-click on a frame's title
    std::vector<Rect> aiButtons;                         // AI_BUTTON (Group 1): the sparkle by the selection pressed
    // HAPTIC (round 17): the trackpad's tick — a canvas drag changed its value by a whole step (a padding, gap, corner
    // radius, W / H, whole degree), its auto-layout flow swapped, or it snapped to a new guide. At most one per pointer
    // move (several steps in one move: one tick); the count is the moves that ticked since the last takeEvents.
    uint32_t haptics = 0;
    // DRAW_TOOL_SAMPLED (round 7b, docs/draw.md §4.5): ⌘-click with the Pencil or the Brush — each a JSON object
    // (DrawToolSampled without its type).
    std::vector<std::string> drawSampled;
    // NOTICE (round 17 B): a refusal in Figma's words — the message keys of what was refused (editor/Refusals.h); the
    // editor shows each as a toast (Figma's visual bell). Once per key per take.
    std::vector<std::string> notices;
    bool pathTool = false;  // PATH_TOOL: Simplify vector / Offset path opened, changed or closed
    bool motion = false;    // MOTION_CHANGED (round 8a): the root's motion model or the view state changed
    bool selection = false, camera = false, tool = false, cursor = false, hover = false, undo = false,
         structure = false, pages = false, currentPage = false, textEdit = false, vectorEdit = false, paintEdit = false,
         navigation = false;
    bool any() const {
      return !colorPicks.empty() || !inlineEdits.empty() || !annotationOpens.empty() || !measurementEdits.empty() || !statusClicks.empty() || measurementSelection ||
             !documents.empty() || !contextMenus.empty() || !prototypeConnected.empty() || !prototypeSelected.empty() || !gridTracks.empty() || !renames.empty() || !aiButtons.empty() || haptics != 0 || !drawSampled.empty() || !notices.empty() || pathTool || !nodes.empty() || !components.empty() || !collections.empty() ||
             !variables.empty() || !styles.empty() || selection || camera || tool || cursor || hover || undo || structure || pages ||
             currentPage || textEdit || vectorEdit || paintEdit || navigation || motion;
    }
  };
  bool hasEvents() const { return events_.any(); }
  Events takeEvents();

  // ---- Text (docs/engine.md §7.6) ----
  // The layout of a TEXT node as it is now (cached; nullptr for other nodes).
  const text::TextLayout* textLayout(Guid id) override;
  // Motion's text stagger (round 8h): the poses the motion layer applied to a text's elements.
  const motion::TextElementPoses* textElements(Guid id) override { return motionLayer_.textElements(id); }
  size_t textCacheSize() const { return textCache_.size(); }  // layouts kept (tests: a lookup that hits adds none)
  // A font arrived or went missing: text is laid out again (and auto-resized
  // texts measured while it loaded take their size).
  void fontsChanged();
  // Starts editing `id` (a TEXT node): all its text selected, or the caret at the end.
  Status startTextEdit(Guid id, bool selectAll);
  // Leaves text editing (an empty text it created, or that ends empty, is deleted).
  void endTextEdit();
  bool textEditing() const { return text_.node != kNoGuid; }
  Guid textNode() const { return text_.node; }
  // Typed text (UTF-8) replacing the selection; IME composition and its end.
  Status textInput(std::string_view utf8);
  Status textComposition(std::string_view utf8, uint32_t selStart, uint32_t selEnd);
  Status textCompositionEnd(std::string_view utf8);
  // The selected text (UTF-8), for copy.
  std::string textSelection() const;
  // A plugin's setRange* (docs/plugins.md §5): run fields written by setProps go to UTF-16 [from, to) of a text that
  // isn't being edited, until cleared (from = to = UINT32_MAX).
  void setStyleRange(uint32_t from, uint32_t to) {
    styleFrom_ = from;
    styleTo_ = to;
  }
  // UTF-16 [start, end) of the text selection (start ≤ end).
  uint32_t textSelStart() const { return std::min(text_.anchor, text_.focus); }
  uint32_t textSelEnd() const { return std::max(text_.anchor, text_.focus); }
  // The caret on screen (CSS px in the canvas): x, y, height.
  Rect caretRectCss() const;
  // The style of a text range as the Typography section shows it (JSON: {from, to, values: {field: value},
  // mixed: [fields]}): typed run fields, the run fields kept as data (links, axes, OpenType switches…), the
  // paragraphs' list type and indentation. `useSelection`: the edited selection when `id` is being edited (a caret:
  // the style typing takes), else the whole text; otherwise [from, to).
  std::string textRangeStyle(Guid id, uint32_t from, uint32_t to, bool useSelection);
  // Paragraph edits on the edited selection's paragraphs (or every paragraph when `id` isn't being edited):
  // op 0 = list type (value: 0 none, 1 numbered, 2 bulleted; the same type again removes it), op 1 = indent by
  // `value` levels. One undo step (merged into an edit session).
  Status textParagraphs(Guid id, int op, int value);
  // The part of `id`'s text the panel edits: the edited selection when it is part of the text (Figma's per-range
  // styling), else false (the whole layer).
  bool textRange(Guid id, uint32_t& from, uint32_t& to) const;
  // "- ", "* ", "1. " or "1) " typed at a paragraph's start: it becomes a list item.
  void textAutoformatList();

  // ---- Vector edit mode (editor/VectorEditing.cpp) ----
  // Round 10 (live toolbar/vector-edit-toolbar.txt): Cut and Erase after Paint and Bend. Round 12 (live
  // toolbar/vector-edit-more-menu.txt, "Vector editing tools"): Shape builder (M) and Variable width (⇧W).
  enum class VectorTool : uint8_t { MOVE, PEN, BEND, LASSO, PAINT_BUCKET, CUT, ERASE, SHAPE_BUILDER, VARIABLE_WIDTH };
  // Edits `id`'s vector network (VECTOR, LINE, and shapes: they become VECTORs at their first edit).
  Status startVectorEdit(Guid id);
  // Round 12 (help.figma.com "Select one or more vector layers and press Enter"): several layers at once — the first
  // is the one whose points show (a click on another switches to it); the Shape builder works on all of them.
  Status startVectorEditMany(const std::vector<Guid>& ids);
  // Multi-edit (docs/draw.md §4.6): each held layer's selected points and segments, the edited one first.
  struct HeldSelection {
    Guid node = kNoGuid;
    std::vector<uint32_t> vertices, segments;
  };
  std::vector<HeldSelection> vectorSelections() const;
  // The layers vector edit mode holds (the edited one first; ones undone away are left out).
  std::vector<Guid> vectorLayers() const;
  // Round 12: the Variable width tool applies (a stroke without dashes or a dynamic stroke, a network without
  // branching paths — Figma: "Split vector" first).
  bool variableWidthAvailable() const;
  // The Shape builder's regions (world space) and which one is under the pointer / taken by the drag (tests, the
  // overlay): computed from the vector layers when asked.
  const std::vector<geom::PlanarFace>& shapeBuilderFaces();
  int shapeBuilderHover() const { return vector_.builderHover; }
  // The edited layer's width points (Variable width; positions along the stroke) and the selected one (−1: none).
  std::vector<geom::WidthPoint> vectorWidthPoints() const;
  int vectorWidthSelected() const { return vector_.widthSelected; }
  void endVectorEdit();
  // Simplify vector and Offset path as Figma's tools (editor/PathTools.cpp; docs/research/rea/vector.md §8, §10;
  // SimplifyVectorTsApi / OffsetPath): one vector-editable layer (not in multi-edit); every change previews live — the
  // step stays open and is written again from the layer as it was — Apply commits it as one undo step, Cancel (Esc,
  // undo) restores the layer. While one is open the canvas takes no clicks and commands wait (zoom aside); Enter
  // applies and Esc cancels. Each change reports PATH_TOOL.
  enum class PathTool : uint8_t { NONE, SIMPLIFY, OFFSET };
  bool pathToolEnabled(PathTool kind) const;
  Status pathToolBegin(PathTool kind);
  // {threshold} (Simplify: −2…3, tolerance 10^−threshold node px) or {offset, join: "MITER" | "ROUND"} (Offset path:
  // within [minOffset, maxOffset]).
  Status pathToolSet(const json::Value& v);
  Status pathToolApply();
  void pathToolCancel();
  PathTool pathTool() const { return pathTool_.kind; }
  // {active, kind, node, threshold, offset, join, minOffset, maxOffset} (PATH_TOOL, engine_path_tool).
  void writePathToolState(json::Writer& w) const;
  static double simplifyTolerance(double threshold) { return std::pow(10.0, -std::clamp(threshold, -2.0, 3.0)); }
  bool vectorEditing() const { return vector_.node != kNoGuid; }
  Guid vectorNode() const { return vector_.node; }
  Status setVectorTool(VectorTool t);
  VectorTool vectorTool() const { return vector_.tool; }
  const std::vector<uint32_t>& vectorSelectedVertices() const { return vector_.selVerts; }
  const std::vector<uint32_t>& vectorSelectedSegments() const { return vector_.selSegs; }
  const geom::VectorNetwork& vectorNetwork() const { return vector_.net; }
  struct VectorPoint {
    uint32_t index;
    Vec2 parent;  // the vertex in the node's parent's space (the panel's X / Y)
    double cornerRadius;
    VectorMirror mirroring;
  };
  std::vector<VectorPoint> vectorPoints() const;
  // The selected vertices' handle mirroring (0 none selected, 1 one value in `out`, 2 mixed).
  int vectorMirroring(VectorMirror& out) const;
  Status setVectorMirroring(VectorMirror m);
  Status vectorDeleteAndHeal();
  // Moves the selected points' bounds' top-left to (x, y) (parent space) and / or sets their corner radius.
  Status setVectorPoints(const double* x, const double* y, const double* cornerRadius);
  // Open paths' ends (Figma's Start point / End point): false when the node has none.
  bool endCaps(Guid id, StrokeCap& start, StrokeCap& end) const;
  Status setEndCaps(const std::vector<Guid>& ids, const StrokeCap* start, const StrokeCap* end);
  // A LINE's network: two vertices, one segment, the ends' caps as per-vertex styles.
  static VectorData lineNetwork(double length, StrokeCap start, StrokeCap end);

  // ---- Gradient (paint) edit mode (editor/PaintEditing.cpp) ----
  // Shows `id`'s gradient paint (fills or strokes, `index`) on the canvas with its handles and stops.
  Status startPaintEdit(Guid id, bool strokes, uint32_t index);
  void endPaintEdit();
  bool paintEditing() const { return paint_.node != kNoGuid; }
  Guid paintNode() const { return paint_.node; }
  bool paintStrokes() const { return paint_.strokes; }
  uint32_t paintIndex() const { return paint_.index; }
  int paintStop() const { return paint_.stop; }
  Status setPaintStop(int stop);
  // A progressive blur's edit mode (Figma's PROGRESSIVE_BLUR, atlas 08 §6.2), in the same session: `id`'s effect
  // `index` (a layer or background blur, progressive) shows its Start and End handles; dragging one moves startOffset /
  // endOffset. `paintStop()` is then the marked handle: 0 Start, 1 End, −1 none (the panel's hovered field).
  Status startBlurEdit(Guid id, uint32_t index);
  bool blurEditing() const { return paint_.node != kNoGuid && paint_.effect; }

  // ---- Prototype mode (editor/PrototypeEditing.cpp; the right panel's Prototype tab) ----
  // The canvas shows connections, the "+" connection handle on selected layers and flow labels; dragging a handle to a
  // frame adds an On click → Navigate to interaction (Figma's defaults), dragging a noodle's end retargets or removes it.
  void setPrototypeMode(bool on);
  bool prototypeMode() const { return proto_.on; }
  // Round 17: the connection whose Interaction details are open (the panel's; a click on a connection's line or label
  // sets it too) — drawn in the selection colour, its label chip solid; the others quiet (the owner's live 61–65.png).
  // `index`: the interaction among the node's live ones; −1 / kNoGuid for none.
  void setPrototypeSelection(Guid node, int index);
  Guid prototypeSelectionNode() const { return proto_.selNode; }
  int prototypeSelectionIndex() const { return proto_.selIndex; }
  // Round 17: Delete / Backspace with a connection selected (its details open) removes its interaction — one undo
  // step — not the hotspot (Commands.cpp DELETE). False when no connection is selected.
  bool deletePrototypeSelection();
  // Viewer mode (developer previews, Dev Mode): read-only — the selection without resize / rotate handles, clicks
  // select and drags never move anything, no context menu, no text / vector / paint editing, only the Move and Hand
  // tools; edits through the API are refused (E_READONLY, Api.cpp).
  void setViewerMode(bool on);
  bool viewerMode() const { return viewer_; }

  // ---- Dev Mode (editor/DevMode.cpp; editor/Annotations.h; R9-dev-mode.md "Round 6") ----
  // The editor's Dev Mode: viewer mode that still takes Dev Mode's own edits — annotations, measurements, statuses,
  // annotation categories (Api lets those fields and the measurement commands through), the Annotation and
  // Measurement tools.
  void setDevEdits(bool on);
  bool devEdits() const { return devEdits_; }
  bool canEditDev() const { return !viewer_ || devEdits_; }
  // Dev Mode's inspect chrome on the canvas (the selection's design highlighted, an auto-layout frame's paddings and
  // gaps measured, the two-line size badge: DevMode.cpp devInspectOverlay); viewer mode only.
  void setDevInspect(bool on);
  bool devInspect() const { return viewer_ && devInspect_; }
  // View › Annotations (labels, dots and saved measurements); `dots`: Dev Mode's dots (a click opens one's label).
  void setAnnotationView(bool show, bool dots);
  bool annotationsShown() const { return dev_.show; }
  // The zoom menu's Annotations ▸ <category> (Figma's filterAnnotationCategoryId): only that category's annotations
  // show; kNoGuid ("Show all categories"): every one.
  void setAnnotationFilter(Guid category);
  Guid annotationFilter() const { return dev_.category; }
  // Every user edit stamps editInfo {lastEditedAt, createdAt} (unix seconds) on the edited nodes and their ancestors,
  // as Figma's files do — a design marked ready whose lastEditedAt is later than its status shows "Changed". Edits of
  // annotations, measurements and statuses don't count.
  // With it on, each edited node also gets Figma's editScopeInfo (365): the scope stack the change was made in — the
  // pushed scopes when any (editScopePush), else the transaction's own: a plugin run PLUGIN, an actor's write (an
  // agent turn) AI, the user USER, labelled with the step's name (docs/research/rea/canvas.md §2.9).
  void setEditTracking(bool on) { editTracking_ = on; }
  bool editTracking() const { return editTracking_; }
  // Figma's edit scopes (EditScopeType's numbers): pushes a scope with Figma's nesting rules — USER never inside
  // PLUGIN / SYSTEM / REST_API / ONBOARDING / AI, PLUGIN never inside SYSTEM / REST_API / AI, REST_API and ONBOARDING
  // inside nothing but SYSTEM's absence of others (never inside USER / PLUGIN / SYSTEM / REST_API / ONBOARDING / AI),
  // AI never inside SYSTEM / REST_API / ONBOARDING, AUTOSAVE inside nothing, TEST_SETUP only first, never two of one
  // type. E_INVALID (with Figma's message as the error) otherwise; pop takes only the top one.
  enum class EditScopeType : uint8_t { INVALID = 0, TEST_SETUP, USER, PLUGIN, SYSTEM, REST_API, ONBOARDING, AUTOSAVE, AI };
  Status editScopePush(EditScopeType type, std::string label);
  Status editScopePop();
  size_t editScopeDepth() const { return editScopes_.size(); }
  const std::string& editScopeError() const { return editScopeError_; }  // the last refused push / pop's message
  void setWallClock(std::function<double()> secondsNow) { wallClock_ = std::move(secondsNow); }
  double wallClock() const;
  // Focus view: only `id` (a design on the current page) is drawn, hovered and selected; kNoGuid leaves it.
  Status setFocus(Guid id);
  Guid focus() const { return dev_.focus; }
  // What the last canvas frame drew that can be clicked (engine_render hands it over).
  void setCanvasHits(const CanvasHits& hits) { hits_ = hits; }
  const CanvasHits& canvasHits() const { return hits_; }
  // A design's Dev Mode status as the canvas shows it: 0 none, 1 Ready for dev, 2 Completed, 3 Changed.
  int devStatus(Guid id) const;
  // The owner's workflow status (ours, docs/editor.md "Frame status (ours)"): 0 none, else 1–7 in his order (Done,
  // R to Merge, Ready to Dev, To be done, Process, Revised, Cancelled; kWorkflowLabels). From pluginData
  // `designer.workflow` / `status`; without that entry, Figma's sectionStatusInfo (BUILD: Ready to Dev, COMPLETED: Done).
  int workflowStatus(Guid id) const;
  // The page's saved measurements; the selected one.
  std::vector<annot::Measurement> measurements(Guid page = kNoGuid) const;
  Guid selectedMeasurement() const { return dev_.selectedMeasurement; }
  Status selectMeasurement(Guid id);
  // Where a measurement is drawn (world): its line and the extension lines from the layers to it.
  bool measurementLine(const annot::Measurement& m, Vec2& a, Vec2& b, std::vector<GuideLine>* extensions = nullptr) const;

  // ---- Components and instances (editor/Instances.cpp, editor/ComponentCommands.cpp) ----
  bool componentInfo(Guid id, ComponentInfo& out) const;  // cached per document version
  // Round 17 B: the last refusal's message key (editor/Refusals.h; engine_command's "error"), cleared per command.
  const std::string& lastRefusal() const { return lastRefusal_; }
  void clearRefusal() { lastRefusal_.clear(); }
  // What RESET_OVERRIDES clears: override fields and extra keys (`otherExtras`: every extra key no other kind names),
  // the instance's property values (`assignments`) or only its slots' (`slotAssignments`, their content goes too).
  struct ResetSpec {
    bool all = false;  // every override (and, unless keepAssignments, every property value)
    bool keepAssignments = false;
    FieldMask bits = 0;
    std::vector<std::string> extraKeys;
    bool otherExtras = false, assignments = false, slotAssignments = false;
    // Figma's reset-prop-assignments for one property ("Reset {property}", resetComponentPropAssignmentForInstances):
    // only these properties' values (ids or names of the instance's main), nothing else.
    std::vector<std::string> props;
  };
  // Figma's reset kinds (ResetOverridesKind 0–14, and reset-variable-modes / reset-prop-assignments as VARIABLE_MODES /
  // PROPERTY_ASSIGNMENTS) into `spec`; false for an unknown kind. LAYER is every field no other kind names (Figma's
  // "others": opacity, corners, auto layout, layout guides, …).
  static bool resetKind(const std::string& kind, ResetSpec& spec);
  bool computeComponentInfo(Guid id, ComponentInfo& out) const;
  // GO_TO_MAIN_COMPONENT / RETURN_TO_INSTANCE: where the last navigation went and where it came from (Figma keeps
  // {mainComponentGUID, instanceGUIDs}: every instance selected when it went; the first is `returnToInstance`).
  Guid navigationMain() const { return navMain_; }
  Guid returnToInstance() const { return returnTo_.empty() ? kNoGuid : returnTo_[0]; }
  const std::vector<Guid>& returnToInstances() const { return returnTo_; }
  // A derived node (an instance's sublayer).
  bool isDerived(Guid id) const { return id.isDerived(); }
  // The real instance a derived node belongs to (kNoGuid for real nodes).
  Guid instanceOfDerived(Guid id) const;
  // Whether `id` can take new layers: a frame that isn't an instance and isn't inside one.
  bool acceptsChildren(Guid id) const;
  // The real main component (SYMBOL) an instance (real or derived) shows now; kNoGuid when it has none.
  Guid mainOf(Guid instance) const;
  // The interactions a layer plays (editor/PrototypeEditing.cpp): an instance's are its main's with its own changes and
  // additions (proto::instanceInteractions); any other layer's, its own. `ownIndex`: as proto::instanceInteractions.
  std::vector<proto::Interaction> playedInteractions(Guid id, std::vector<int>* ownIndex = nullptr) const;
  // Which of a layer's own interactions are its connections (proto::instanceOwnEntries; all of them but an instance's).
  std::vector<bool> ownInteractions(Guid id) const;
  // A copy's interactions (duplicate, paste) get ids of their own, as Figma's do — but an instance's entries for its
  // main's interactions, which are matched by id.
  void freshInteractionIds(NodeProps& p);

  // ---- Variables, modes and styles (editor/Variables.cpp, editor/VariableCommands.cpp; docs/schema.md §6) ----
  // A resolved variable value.
  struct Resolved {
    enum class Kind : uint8_t { NONE, BOOL, FLOAT, STRING, COLOR, OTHER };
    Kind kind = Kind::NONE;
    bool b = false;
    double f = 0;
    std::string s;
    Color c;
    std::string raw;  // OTHER (EASING…): the literal VariableData, encoded
  };
  // Figma's resolveForConsumer: `variable`'s value for `consumer` (kNoGuid: every collection's default mode).
  bool resolveVariable(Guid variable, Guid consumer, Resolved& out) const;
  // `variable`'s value in `mode` of its own collection (aliases into other collections: their default modes).
  bool resolveVariableInMode(Guid variable, Guid mode, Resolved& out) const;
  // A VariableData's value for `consumer` (a literal, an alias, or one of Figma's expressions): the one evaluator —
  // bindings, and the prototype's Conditional and Set variable (proto/Player).
  bool resolveValue(const VariableData& d, Guid consumer, Resolved& out) const;
  // The mode of collection `set` that a node (or page) uses: its explicit one, else an ancestor's, else the default.
  Guid resolvedMode(Guid node, Guid set) const;
  // A node's own explicit mode for `set` (a collection or an extended one; kNoGuid: Auto, or another of the chain's).
  Guid explicitModeOf(Guid node, Guid set) const;
  // A variable's value in a mode of its collection or of an extended collection of it (`overridden`: the extension's own).
  const VariableData* valueForMode(Guid variable, Guid mode, bool* overridden = nullptr) const;
  // Assets by reference: a GUID, or a library key (imported files).
  Guid findVariable(const AssetId& id) const;
  Guid findCollection(const AssetId& id) const;
  Guid findStyle(const AssetId& id) const;
  // Extended collections: the collection one extends (kNoGuid: not one), the root of its chain (itself when not one),
  // the VARIABLE_OVERRIDE holding its values for a variable (kNoGuid: none), the collections extending one.
  Guid extensionParent(Guid set) const;
  Guid rootCollection(Guid set) const;
  Guid overrideNode(Guid extension, Guid variable) const;
  std::vector<Guid> extensionsOf(Guid set) const;
  // The collection (or extended collection) a mode id belongs to, among `set`'s chain and its extensions.
  Guid collectionOfMode(Guid set, Guid mode) const;
  // Live collections in the panel's order; a collection's variables in order; styles of a type (NONE: all) in order.
  std::vector<Guid> collections(bool includeRemote = false) const;
  std::vector<Guid> variablesOf(Guid collection, bool includeDeleted = false) const;
  std::vector<Guid> stylesOf(StyleType type, bool includeRemote = false) const;
  // How many layers use a style.
  uint32_t styleUsage(Guid style) const;
  // The fonts the document names (text, runs, instance overrides), each with how many places name it
  // (editor/FontCommands.cpp). With `roots` (the Missing fonts dialog's Current page / Current selection), only the
  // layers in them and inside them, and each font's layers (`nodes`).
  struct DocumentFont {
    FontName font;
    uint32_t uses = 0;
    std::vector<Guid> nodes;
  };
  std::vector<DocumentFont> documentFonts(const std::vector<Guid>& roots = {}) const;
  // Whether `id` is one of `roots` or inside one (every node when there are none).
  bool inScope(const std::vector<Guid>& roots, Guid id) const;
  struct BoundVariable {
    std::string target;     // BindingTarget (docs/engine-build.md)
    Guid variable = kNoGuid;  // the alias (a composed colour: its colour's alias)
    VariableData value;
    Resolved resolved;
    bool ok = false;        // resolved
  };
  std::vector<BoundVariable> boundVariables(Guid node) const;
  bool resolvedValue(Guid node, const std::string& target, Resolved& out) const;
  // What the last command created (variables, collections, modes, styles).
  const std::vector<Guid>& lastCreated() const { return created_; }

  // ---- Libraries (editor/Libraries.cpp; docs/data.md §9, docs/schema.md §8) ----
  enum class AssetKind : uint8_t { NONE, COMPONENT, COMPONENT_SET, STYLE, VARIABLE_COLLECTION, VARIABLE };
  static const char* assetKindName(AssetKind k);
  // A local asset (localAssets, encodeAssets) or a library copy (libraryUsage).
  struct AssetInfo {
    Guid id = kNoGuid;
    std::string key;
    AssetKind kind = AssetKind::NONE;
    std::string name, description;
    StyleType styleType = StyleType::NONE;
    bool hasResolvedType = false;
    VariableResolvedType resolvedType = VariableResolvedType::BOOLEAN;
    Guid owner = kNoGuid;  // a variant's component set, a variable's collection
    std::string ownerKey;
    bool hidden = false, softDeleted = false;
    std::string versionHash, publishedVersion;
    std::vector<std::string> dependencies;  // keys of this file's assets it needs (transitively)
    Guid pageId = kNoGuid, frameId = kNoGuid;
    std::string pageName, frameName;
    // Library copies.
    std::string libraryKey, version;
    Guid publishID = kNoGuid;
    uint32_t usage = 0;
  };
  struct EncodedAsset {
    AssetInfo info;
    bool dependencyOnly = false;
    std::vector<NodeChange> nodes;  // the payload: the asset's nodes and every node it depends on (library GUIDs)
    std::vector<ImageHash> images;  // the images the payload's nodes use
  };
  struct Redirect {
    std::string fromKey, toKey;
    std::string fromLibraryKey;  // "": the copies of fromKey from any library
  };
  struct LibraryOptions {
    std::string libraryKey;
    bool update = false;    // applyLibraryUpdate: replace copies (one undo step); else import (SYSTEM)
    bool hasKeys = false;   // update: only these keys are replaced; asNew: these keys get new copies
    std::vector<std::string> keys;
    std::vector<Redirect> redirects;  // Move to this file
    bool asNew = false;     // import: a new copy of the asked assets even when copies of them are here
    bool hasCopies = false;  // update: only these copy roots are replaced
    std::vector<Guid> copies;
  };
  struct ImportedAsset {
    std::string key;
    Guid id = kNoGuid;
    AssetKind kind = AssetKind::NONE;
    std::string libraryKey, version;
    bool created = false, updated = false;
  };
  // markPublished: an asset of the new version (its versionHash), or one the version no longer has (removed: "").
  struct PublishedEntry {
    std::string key, versionHash;
  };
  // This file's FileKey (clipboard pasteFileKey; cross-file paste).
  void setFileKey(const std::string& key) { fileKey_ = key; }
  const std::string& fileKey() const { return fileKey_; }
  AssetKind assetKindOf(Guid id) const;
  // The root of the library copy holding `id` (itself included), kNoGuid when it isn't in one.
  Guid libraryRootOf(Guid id) const;
  // Read-only: inside a library copy.
  bool isLibraryCopy(Guid id) const { return hasLibraryCopies_ && libraryRootOf(id) != kNoGuid; }
  // A main (or set) copied in from another file onto the internal canvas (local, not a library copy).
  bool isCopiedMain(Guid id) const;
  // Gives local assets in `refs` (empty: all) a key when they have none (SYSTEM); returns each one's key.
  std::vector<std::pair<Guid, std::string>> ensureAssetKeys(const std::vector<Guid>& refs);
  // Every local asset. `listOnly`: what Assets lists, without the content hash and the dependencies (each walks the
  // asset's whole subtree; the panel reads the list again after a change to a component). `hashMains` false: the
  // content hash of styles, variables and collections only — no hash for components and sets, no dependencies (the
  // Libraries button's unpublished-changes check, which judges mains by new or removed only).
  std::vector<AssetInfo> localAssets(bool listOnly = false, bool hashMains = true) const;
  // The assets with these keys and their dependencies (keys are given to dependencies that lack one).
  void encodeAssets(const std::vector<std::string>& keys, std::vector<EncodedAsset>& out, std::vector<ImageHash>& images);
  // The content hash of an asset (docs/data.md §9.1): its own content, and the hashes of the hidden (dependency-only)
  // assets it uses, which are never listed on their own.
  std::string assetVersionHash(Guid id) const;
  // The references the last library import / update or cross-file paste could not resolve (each left pointing at
  // nothing; 0 when every reference found its node). A debug build also reports them on stderr.
  size_t unresolvedReferences() const { return unresolved_; }
  // After a publish: publishedVersion on the version's assets (libraryMoveInfo cleared on its mains); cleared on assets
  // the version removed (an entry with an empty hash). SYSTEM.
  Status markPublished(const std::vector<PublishedEntry>& entries);
  // `images`: the images the copies written or reused use.
  Status importLibrary(const std::vector<std::vector<NodeChange>>& messages, const LibraryOptions& opts, std::vector<ImportedAsset>& out,
                       std::vector<ImageHash>* images = nullptr);
  std::vector<AssetInfo> libraryUsage() const;

  // Whether a gesture is in progress (undo and txn calls are refused meanwhile).
  bool busy() const { return gesture_ != Gesture::None && gesture_ != Gesture::Press; }

 private:
  // ---- Variables and styles: resolution (editor/Variables.cpp) ----
  struct BindingDeps {
    std::vector<Guid> vars, sets, styles;
  };
  // Where modes come from: the consumer and its ancestors; `self`: the consumer's props when the document's copy
  // is stale (rows being built); `forcedSet` / `forcedMode`: one collection's mode chosen (the table's columns).
  struct ModeContext {
    Guid consumer = kNoGuid;
    const NodeProps* self = nullptr;
    Guid forcedSet = kNoGuid, forcedMode = kNoGuid;  // forcedSet: a collection, or an extended collection of it
    // Rows being built (an instance's expansion): their props ahead of the document's (null: none).
    std::function<const NodeProps*(Guid)> pending;
  };
  // The mode of collection `set` (a variable's own) for the context; an extended collection's mode sets `extension`.
  Guid modeFor(const ModeContext& ctx, Guid set, Guid* extension = nullptr) const;
  // A variable's value entry in `mode` (of its collection `set`, or of `extension`, an extended collection of it):
  // the extension's override, else its parent's for the parent mode, up to the variable's own (default mode fallback).
  const VariableModeValue* valueInMode(Guid variable, const NodeProps& vp, Guid set, Guid mode, Guid extension, BindingDeps* deps) const;
  // A variant bound to variables (VARIANT_PROPERTIES = RESOLVE_VARIANT(MAP)): the variant of `main`'s set it picks.
  Guid variantFor(Guid main, const VariableData& binding, const ModeContext& ctx, BindingDeps* deps) const;
  bool resolveData(const VariableData& d, const ModeContext& ctx, Resolved& out, BindingDeps* deps, int depth) const;
  bool resolveVar(Guid variable, const ModeContext& ctx, Resolved& out, BindingDeps* deps, int depth) const;
  // A node's styles copied in, then its variable bindings resolved into its fields (`p`: its props, changed in place).
  void resolveBindings(Guid id, NodeProps& p, BindingDeps* deps) const;
  const NodeProps* styleNode(const AssetId& id, StyleType type) const;
  void setDeps(Guid id, BindingDeps&& deps);
  void dropDeps(Guid id);
  // A change applied: what must be resolved again (and the panels' events).
  void noteBindings(const NodeChange& c, NodeType typeBefore);
  void markBindingsSubtree(Guid id);
  void flushBindings();
  // A user's edit of a bound value detaches it (Figma): the binding, a paint's colorVar, the style.
  void detachEdited(const NodeProps& before, NodeChange& c) const;
  void rebuildAssetKeys() const;
  // Extended collections follow their parent's modes (names, order, new ones) — the collections whose modes changed.
  void syncExtensions();

  // ---- Libraries (editor/Libraries.cpp) ----
  using GuidMap = std::unordered_map<Guid, Guid, GuidHash>;
  // Nodes from outside (a library payload, a clipboard): by id, children in order, roots.
  struct SourceNodes {
    std::unordered_map<Guid, const NodeChange*, GuidHash> byId;
    std::unordered_map<Guid, std::vector<const NodeChange*>, GuidHash> kids;
    std::vector<Guid> roots;
    std::vector<Guid> own;  // addMessages: each message's own asset root (its first node's), in message order
    void add(const NodeChange& c);
    // Payloads: each message's own asset (its first node's subtree) wins over copies of it embedded in other messages;
    // an embedded asset is taken whole from the first message that has it (never two versions mixed).
    void addMessages(const std::vector<std::vector<NodeChange>>& messages);
    void link();  // kids (by position) and roots, after every add
    void subtree(Guid root, std::vector<const NodeChange*>& out) const;  // pre-order
  };
  // One asset to bring in: as a library copy (read-only, COPY) or as a local asset (LOCAL: copied from another file).
  struct ImportPlan {
    Guid src = kNoGuid;
    enum class Mode : uint8_t { COPY, LOCAL } mode = Mode::COPY;
    std::string libraryKey, key, version;
    Guid publishID = kNoGuid;
    Guid target = kNoGuid;  // the node it becomes (kNoGuid: created)
    bool replace = false;   // the target's content is replaced
    bool redirected = false;
    bool copiedIn = false;  // LOCAL: a main copied in from another file (not this file's own asset)
    Guid result = kNoGuid;  // writeImports: the node the root became
  };
  // Writes the plans in the open transaction; `map` gets source GUID → local GUID for every node they reach (a source
  // with several plans: the first one's). An existing target that isn't replaced but lacks a node a written plan — or
  // `extra` (a paste's own nodes) — refers to (a variant added since) becomes a new copy (a copied-in main: copied in
  // again). A replaced copy's components
  // the new version no longer has (a deleted variant) stay for what uses them, as copies of their own.
  void writeImports(const SourceNodes& src, std::vector<ImportPlan>& plans, GuidMap& map,
                    const std::vector<const NodeProps*>* extra = nullptr);
  // Source nodes (pre-order, the root first) matched to an existing tree top-down: the root to `target`, each node only
  // among its mapped parent's children, each existing node once; components by publishID (`byPublishID`; `pub`: the
  // library GUID the source node copies), then key + name, then key — never onto a component that copies a library
  // node the source no longer has; other layers by key; a key unique in the tree as a last resort (a layer moved to
  // another parent).
  struct MatchNode {
    Guid id, parent;
    const NodeProps* props;
    Guid pub = kNoGuid;  // kNoGuid: `id`
  };
  void matchTree(const std::vector<MatchNode>& nodes, Guid target, bool byPublishID, GuidMap& out) const;
  // Move to this file, when this file is where the asset moved: every user of each library copy (first) is relinked to
  // this file's own asset (second), nodes matched by key, and the copy is removed. In the open transaction.
  void relinkCopies(const std::vector<std::pair<Guid, Guid>>& copyToLocal);
  // A source node's references mapped into this document (`own`, then `map`, then library copies by publishID, then by
  // library + key). Returns how many main references it could not map (left pointing at nothing: the caller counts
  // them in unresolved_).
  size_t remapRefs(NodeProps& p, const GuidMap* own, const GuidMap& map, const std::string& libraryKey) const;
  // The copy root of (library, key): the one at `version` if any, else the first by GUID; kNoGuid when none.
  Guid copyRootByKey(const std::string& libraryKey, const std::string& key, const std::string& version = std::string()) const;
  // A main (component or set, a variant included) in a library's copies by its key: the first by GUID; kNoGuid when none.
  Guid copyMainByKey(const std::string& libraryKey, const std::string& key) const;
  // An asset's content hash (docs/data.md §9.1) over nodes from anywhere: the document's, or a clipboard's.
  struct HashView {
    std::function<const NodeProps*(Guid)> get;
    std::function<void(Guid, std::vector<Guid>&)> kids;          // real children, in order
    std::function<std::string(Guid)> mainKey;                    // a referenced main's (or set's) key; "" none
    std::function<std::string(const AssetId&, AssetKind)> assetKey;  // a referenced style's / variable's / collection's
    std::function<bool(Guid)> exists;                            // a referenced node is there (unset: always)
  };
  std::string hashAsset(Guid root, const HashView& v) const;
  // assetVersionHash with the hashes already computed (several assets in one call).
  using HashMemo = std::unordered_map<Guid, std::string, GuidHash>;
  std::string versionHashOf(Guid id, HashMemo& memo) const;
  // The hidden (dependency-only) local assets an asset's nodes use directly (their payload roots).
  std::vector<Guid> hiddenDependencies(Guid id) const;
  // Bound values left out (Variables.cpp): every field a variable binding or a style sets, reset (the binding counts).
  static void clearBoundValues(NodeProps& p);
  Guid localAssetByKey(const std::string& key) const;
  Guid copyByPublishID(const std::string& libraryKey, Guid publishID) const;
  // The node an asset's payload starts at (a variant: its set).
  Guid payloadRoot(Guid asset) const;
  // Real nodes of a subtree, pre-order.
  void realSubtree(Guid root, std::vector<Guid>& out) const;
  // The payload roots `roots` depend on, transitively (`roots` excluded).
  // `extra`: nodes outside the document (a clipboard's) whose references count too.
  std::vector<Guid> dependencyRoots(const std::vector<Guid>& roots, const std::vector<const NodeProps*>* extra = nullptr) const;
  bool assetHidden(Guid id) const;
  void fillAssetInfo(Guid id, AssetInfo& info) const;
  // Clears an asset's library identity (duplicates: a key of their own later).
  static void clearIdentity(NodeProps& p);

  // ---- Variables and styles: commands (editor/VariableCommands.cpp) ----
  Status variableCommand(CommandId id, const CommandArgs& args);
  // REPLACE_FONTS (editor/FontCommands.cpp).
  Status replaceFonts(const CommandArgs& args);
  uint32_t variableCommandState(CommandId id) const;
  std::string newAssetKey();

  enum class Gesture : uint8_t { None, Pan, Press, Move, Resize, Rotate, Draw, Marquee, TextSelect, Vector, Pencil, Paint, Noodle, Grid,
                                 Measure, MeasureDrag, Radius, Gap, LayoutBar, ZoomArea, Reorder, RotationOrigin, Guide, Shape,
                                 Scrollbar, TextPathStart, MotionAnchor };

  struct Target {
    Guid id;
    Mat2x3 transform;  // when the gesture started
    Mat2x3 world;
    Vec2 size;
    Guid parent;           // its parent then
    std::string position;  // and its place there
  };

  // ---- LayoutHost ----
  void writeGeometry(Guid id, const Mat2x3& transform, Vec2 size) override;
  bool resizedInTxn(Guid frame, Vec2& oldSize) const override;
  void base(Guid id, Mat2x3& transform, Vec2& size) const override;
  bool excludedFromFlow(Guid id) const override { return excluded_.count(id) != 0; }
  bool placedByGesture(Guid id) const override { return excluded_.count(id) != 0 || pinned_.count(id) != 0; }
  bool ignoreConstraints(Guid frame) const override { return ignoreConstraints_; }
  bool measureText(Guid id, double width, Vec2& size) override;
  double firstBaseline(Guid id, Vec2 size) override;
  Guid slotContentOf(Guid id) override;

  // ---- Transactions ----
  void begin(TxnKind kind, const std::string& label);
  void write(const NodeChange& c);
  void commit(bool mergeWithLast = false);
  void rollback();
  void noteNode(Guid id, uint32_t groups);
  void noteChange(const NodeChange& c, NodeType typeBefore);
  void markLayout(const NodeChange& c, Guid parentBefore);
  // Transactions whose changes are laid out (docs/engine.md §3.3): the user's and gestures, and — Figma's invariant
  // enforcers, `-remote` included — undo, redo and remote changes, whose restored or received sizes aren't trusted.
  static bool laysOut(TxnKind k) {
    return k == TxnKind::USER || k == TxnKind::GESTURE || k == TxnKind::UNDO || k == TxnKind::REDO || k == TxnKind::REMOTE;
  }
  void flushLayout();
  void removeEmptyGroups();
  // A file just loaded: the global bookkeeping (styles, collections, deleted mains nobody uses, bound values), as one
  // SYSTEM change; the per-page work (instances, auto layout) waits for derivePage.
  void relayoutAll();

  // ---- Indexes kept on every write (no document scans on the hot paths) ----
  // Called after every applied change of a real node (noteChange): the key, instance-count and document indexes.
  void indexChange(const NodeChange& c);
  void rebuildIndexes();
  // The real nodes carrying an asset key (nullptr: none).
  const std::vector<Guid>* nodesWithKey(const std::string& key) const;

  void changeSelection(std::vector<Guid> ids);
  void changeCamera(const Camera& c);
  void changeCursor(CursorKind c, double angle = 0);
  void pruneSelection();
  Guid newGuid();
  std::string nextName(const char* base) const;
  double pixel() const { return 1.0 / camera_.zoom; }
  bool selected(Guid id) const;
  bool undoStep(bool redo);
  // Is the node on a page already derived (or on the internal canvas)? Undo, redo and remote changes lay out only there.
  bool onDerivedPage(Guid id) const;
  Camera snapped(Camera c) const;
  // The visible part of the canvas (Viewport::visible): a camera fitting r in it with `padding` px on each side (the
  // camera as it is when the padding alone fills it), its centre (screen), its world rect.
  Camera fitVisible(const Rect& r, double padding) const;
  Vec2 visibleCentre() const;
  Rect visibleWorld() const;
  void zoomToFit();
  // `animateMs` > 0: the camera glides there (round 16: a Layers row's glyph clicked).
  void zoomToSelection(double animateMs = 0);
  void zoomTo(double zoom);

  // ---- Canvas navigation (editor/CanvasNav.cpp, round 16): the rest ----
  void cameraTick(double timeMs);
  int32_t scrollbarDelay() const;  // ms until the bars change (−1: never; 0: next frame)
  Rect pageContentBounds(bool& any);  // world, cached per document version and page
  // A press on a bar: a thumb drags (the view follows), the track pages towards the press. 0: not on a bar.
  uint32_t scrollbarPointerDown(Vec2 s);
  void scrollbarPointerMove(Vec2 s);
  // The pointer over a bar's zone (it shows, darker): true when it is.
  bool scrollbarHover(Vec2 s);
  void scrollbarTick(double timeMs);
  void scrollbarOverlay(Overlay& o) const;
  // A wheel pixel's zoom: Figma's 4^(delta / 100) (pinchToZoomExponent() = 4.0f), i.e. e^(delta · ln 4 / 100).
  static constexpr double kWheelZoomRate = 0.013862943611198906;
  static constexpr double kScrollbarShowMs = 1000;  // shown this long after the view stops…
  static constexpr double kScrollbarFadeMs = 300;   // …then fading out

  // ---- Instances (editor/Instances.cpp) ----
  struct OverrideStack;
  // One derived row of an instance's materialization.
  struct DerivedRow {
    Guid id;
    NodeProps props;
    Guid source;             // the real node in a main it mirrors
    Guid level;              // the instance (real or derived) whose main holds `source`
    std::vector<Guid> path;  // keys from the top-level instance
  };
  struct DerivedInfo {
    Guid instance = kNoGuid;  // the top-level real instance
    std::vector<Guid> path;
    Guid source = kNoGuid;
    Guid level = kNoGuid;
    std::vector<Guid> levelPath;  // `level`'s path from the instance (empty: the instance itself)
    Guid symbol = kNoGuid;        // derived instances: the main they show
  };
  struct Blueprint {
    Mat2x3 transform;
    Vec2 size;
    bool geometry = false;  // transform / size: the node before the instance's own layout (constraints start here)
    Vec2 sourceSize;        // frames and the instance: the size their children were laid out for in the main
    bool frame = false;
  };
  // Layout of derived subtrees: resizedInTxn / base answer from these.
  bool blueprintBase(Guid id, Mat2x3& transform, Vec2& size) const;
  bool blueprintSourceSize(Guid id, Vec2& size) const;
  // The instance's main as it is now (a SYMBOL), or kNoGuid.
  Guid symbolOf(const NodeProps& instance) const;
  // The component properties defined for a main: its own, or its set's.
  const std::vector<ComponentPropDef>* defsOf(Guid symbol) const;
  Guid setOf(Guid symbol) const;  // the component set holding a variant (kNoGuid otherwise)
  // An instance root's effective fields: the main's root, the instance's own fields kept.
  NodeProps instanceRoot(const NodeProps& own, const NodeProps& main, Guid mainId = kNoGuid) const;
  void markInstanceDirty(const NodeChange& c);
  void flushInstances();
  // Batch D: instances whose size alone layout changed — their rows fitted again (stage B), not derived again.
  bool canRefit(Guid R) const;
  void flushRefits();
  void materialize(Guid instance);
  // Stage B of materialization (layout to the instance's size, constraints, slots), for one instance or a batch.
  struct PendingLayout {
    Guid instance;
    std::vector<Guid> rows;
    bool hasMain = false;
    std::vector<std::pair<Guid, Guid>> slots;
    bool stored = false;  // its rows took the stored layout (derivedSymbolData): nothing to lay out
  };
  // The stored layout of `R`'s rows when it matches them (every row's path stored, nothing more): applied, true.
  bool applyStoredRows(Guid R, const std::vector<Guid>& rows);
  // The stored text layout of `id` when it can stand for its real layout `real` (fonts pending or missing).
  const text::TextLayout* storedLayout(Guid id, const NodeProps& p, const text::TextLayout& real);
  // A change from outside the derivation: what stored derived data it makes stale.
  void invalidateStored(const NodeChange& c, NodeType typeBefore);
  void finishLayouts(const std::vector<PendingLayout>& batch);
  void removeDerived(Guid instance);
  struct Expansion;
  void expandChildren(Expansion& ex, Guid symbol, Guid sourceParent, Guid parentRow, const std::vector<Guid>& prefix, Guid level,
                      const std::vector<Guid>& levelPath, const std::vector<ComponentPropAssignment>& assigns, int depth);
  // `resolve`: resolves a property value bound to a variable in the level's modes (null: bound values aren't resolved).
  void applyBindings(const NodeProps& source, NodeProps& p, Guid symbol, const std::vector<ComponentPropAssignment>& assigns,
                     Guid* swap, Guid* slotContent, const std::function<bool(const VariableData&, Resolved&)>* resolve = nullptr) const;
  void applyDerivedDirect(const NodeChange& change);
  // The overrides in force for a derived nested instance, relative to it (usage site over its own), and its assignments.
  void composedOverrides(Guid nested, std::vector<SymbolOverride>& out, std::vector<ComponentPropAssignment>& assigns) const;
  void writeDerived(const NodeChange& change);
  void recordRootOverride(Guid instance, const NodeChange& change, const std::vector<ParamBinding>* mapBefore = nullptr);
  // Writes `fields` of `entry` into the override at `path` of top-level instance `instance` (merged).
  void writeOverride(Guid instance, const std::vector<Guid>& path, FieldMask fields, const NodeProps& values);
  // Sets property `def` to `value` on the instance level (a real instance, or a derived nested one).
  void writeAssignment(Guid level, Guid def, const ComponentPropValue& value);
  // The assignments in force for an instance level (its own, with usage-site overrides on top).
  std::vector<ComponentPropAssignment> assignmentsOf(Guid level) const;
  std::vector<ComponentProperty> propertiesOf(Guid level, Guid symbol) const;
  bool isStructuralTarget(Guid parent) const;
  // Remaps an instance's overrides from one main to another (variant switch / swap; Figma's name rules).
  std::vector<SymbolOverride> remapOverrides(const std::vector<SymbolOverride>& overrides, Guid from, Guid to, bool variant) const;
  // A nested swap of the derived instance `ref` from `from` to `to` (Figma's override stash, docs/schema.md §5.3): the
  // top-level instance's overrides under it are rewritten to `to`'s layers (remapOverrides), the ones that don't carry
  // over are stashed in its overrideStash under (path, from's key), and a stash kept for (path, to's key) comes back.
  void transferNestedSwap(Guid ref, Guid from, Guid to);
  // The path (keys) of the one TEXT layer in `symbol`'s tree, nested instances' mains included (false: none or several).
  bool soleTextPath(Guid symbol, std::vector<Guid>& path) const;
  // An instance's assignment of one of `main`'s SLOT properties (its slot content frame; Push changes keeps it).
  bool isSlotAssignment(Guid main, const ComponentPropAssignment& a) const;
  // The real layer at `path` (keys) in `symbol`'s tree, following nested instances' mains (kNoGuid: none).
  Guid layerAtPath(Guid symbol, const std::vector<Guid>& path) const;
  // Batch D: layerAtPath's answers (an override's path into a main, asked again for every instance of that main — 1.4 s
  // of deriving the owner's heaviest page), dropped when a real node is created, removed, moved, retyped, re-keyed or
  // swapped (noteChange) and at a load.
  struct PathMemo {
    Guid symbol;
    std::vector<Guid> path;
    Guid at;
  };
  mutable std::unordered_map<uint64_t, PathMemo> pathMemo_;
  // A nested instance showing `main` (a variant chosen by a variable, a variant or instance picked at the usage site):
  // the overrides under `path` made on another of `from` or `main`'s variants follow it by layer name (remapOverrides).
  void carryNestedOverrides(Expansion& ex, const std::vector<Guid>& path, Guid main, const std::vector<Guid>& from);

  // ---- Component commands (editor/ComponentCommands.cpp) ----
  Status componentCommand(CommandId id, const CommandArgs& args);
  uint32_t componentCommandState(CommandId id) const;
  // Slots (editor/SlotCommands.cpp): Convert to slot, Wrap in new slot, Delete contents.
  Status slotCommand(CommandId id, const CommandArgs& args);
  uint32_t slotCommandState(CommandId id) const;
  bool canBecomeSlot(Guid id) const;
  bool canWrapInSlot() const;
  Status convertToSlot(std::vector<Guid> ids);
  Status wrapInNewSlot();
  Status clearSlot(Guid ref);
  std::vector<Guid> refsArg(const CommandArgs& args, const char* key) const;
  Status createComponent(const std::string& mode);
  Guid makeComponentFrom(Guid node);
  Status combineAsVariants(std::vector<Guid> symbols, Guid* setOut = nullptr);
  Status addVariant();
  Status detachInstance(const std::vector<Guid>& ids);
  Guid detachOne(Guid instance);
  // What a frame detached from `main` records (detachedSymbolId): a library main's asset ref, else its GUID.
  AssetId detachedIdOf(Guid main) const;
  Status resetOverrides(const std::vector<Guid>& ids, const ResetSpec& spec, const std::string& label);
  // ---- Refusals and component cycles (round 17 B, docs/schema.md §5.10) ----
  // A refusal in Figma's words: `key` (editor/Refusals.h) becomes a NOTICE event and the command's "error"; E_INVALID.
  Status refuse(const char* key);
  // A property's default (`dv`, as the command gives it) checked against its type (Figma's messages; OK when absent),
  // and the preferred values in `args`: components or sets, for an instance swap, that don't contain `owner`.
  Status checkDefaultValue(Guid owner, ComponentPropType type, const json::Value* dv);
  Status checkPreferredValues(Guid owner, ComponentPropType type, const CommandArgs& args);
  // The mains a property of `owner` shows inside: its variants (or itself) and the mains around it.
  std::vector<Guid> propertyHosts(Guid owner) const;
  // The mains a layer under `node` is drawn inside: its component ancestors and, inside an instance, the mains of the
  // instances on the way (Figma's containing symbols).
  std::vector<Guid> enclosingMains(Guid node) const;
  // The mains a real subtree shows: its instances' mains, their nested swaps and instance-swap values (sets: every
  // variant).
  void mainsShownIn(Guid root, std::vector<Guid>& out) const;
  void mainsOfInstance(const NodeProps& instance, std::vector<Guid>& out) const;
  // Whether one of `mains` is, or shows somewhere in its tree, an instance of one of `targets` (Figma's "would create
  // a cycle").
  bool reachesAny(const std::vector<Guid>& mains, const std::vector<Guid>& targets) const;
  // Whether showing `mains` under `parent` would make a component contain an instance of itself.
  bool wouldContainItself(Guid parent, const std::vector<Guid>& mains) const;
  // Duplicate effective override keys inside one main's tree: the later ones' overrideKeys (Figma's "conflicting
  // override keys", repaired at load).
  std::vector<Guid> conflictingOverrideKeys() const;
  // Library copies whose prototype interactions still name the library file's GUIDs (copies made before imports
  // remapped them): the changes that point them at the copies' own nodes, repaired at load.
  std::vector<NodeChange> copyInteractionRepairs() const;
  // A variant renamed by hand (round 17 B, Figma's backfillVariantPropDefs): its name's pairs become its values, a new
  // property name a Variant property of the set; an invalid name is kept (the variant shows as conflicting).
  void backfillVariantNames();
  // Figma's variant errors (StateGroupError): each variant of `set` with its own, read from its name; a variant's.
  std::vector<std::pair<Guid, VariantError>> variantErrors(Guid set) const;
  VariantError variantError(Guid variant) const;
  Status insertInstance(Guid main, const CommandArgs& args);
  Status setVariantProperties(Guid variant, const CommandArgs& args);
  Status pushChangesToMain(Guid instance);
  Status goToMainComponent(const std::vector<Guid>& refs);
  // The instance behind a ref (an instance, or the instance a derived sublayer lies in).
  Guid instanceBehind(Guid ref) const;
  Status returnToInstanceCmd();
  Status swapInstance(const std::vector<Guid>& ids, Guid main);
  Status setComponentProperty(Guid ref, const std::string& prop, const json::Value& value);
  Status addComponentProperty(Guid ref, const CommandArgs& args);
  Status editComponentProperty(Guid ref, const CommandArgs& args);
  // The layers bound to `d` under `owner` (a main, or every variant of a set) take its default (visible, text, swap).
  void applyPropertyDefault(Guid owner, const ComponentPropDef& d);
  Status deleteComponentProperty(Guid ref, const std::string& prop);
  Status bindComponentProperty(const std::vector<Guid>& ids, const std::string& field, const std::string& prop);
  Status restoreComponent(Guid ref);
  Status setExposedInstance(Guid ref, bool exposed);
  // Figma's preconditions for exposing a nested instance: a primary instance in a component or set, not in a slot,
  // whose main has properties or exposed instances of its own. `connected`: the same instance (by key) in every variant.
  bool canExposeInstance(Guid ref) const;
  std::vector<Guid> connectedInstances(Guid ref) const;
  Status resetSlot(Guid ref);
  // A slot inside an instance (a derived slot frame): its content frame, made on the first edit — the whole slot
  // diverges from the main then (copies of its default content), as Figma.
  Guid slotContentFor(Guid slotRow, bool create);
  // A soft delete of a main that still has instances (docs/schema.md §5.7). False when it has none.
  bool softDeleteMain(Guid main);
  Guid internalCanvas(bool create);
  uint32_t instanceCount(Guid symbol) const;
  // The owner of a main's property definitions (the main, or its component set).
  Guid propOwner(Guid ref) const;
  const ComponentPropDef* findDef(Guid owner, const std::string& prop) const;
  void renameVariants(Guid set);
  // An instance of `symbol` (real) under `parent` at `position` with `transform`.
  Guid createInstance(Guid symbol, Guid parent, const std::string& position, const Mat2x3& transform);
  // Copies keep the keys of a whole component they copy (docs/schema.md §5.1).
  void keepKeys(Guid src, NodeProps& p) const;

  // ---- Commands (editor/Commands.cpp) ----
  // Top-level frames duplicated with ⌘D land this far to the right of the originals.
  static constexpr double kDuplicateGap = 100;
  // The selection without nodes inside other selected nodes, bottom-most first.
  std::vector<Guid> topSelectionInPaintOrder() const;
  // What align / distribute move: the top-level selection without locked layers
  // and without layers an auto-layout parent places.
  std::vector<Guid> arrangeable() const;
  bool canUngroup(Guid id) const;
  Guid documentNode() const;
  // The transform under `parent` that puts a node at `world`.
  Mat2x3 localFor(Guid parent, const Mat2x3& world) const;
  // Moves a node by `d` in world space.
  void shiftWorld(Guid id, Vec2 d);
  // Turns `frame` into auto layout, inferring direction, gap and alignment from
  // its children (and its padding from where they sit, when `padFromContent`;
  // layout/Infer.h: a grid or a wrap too). Atlas wave 2 (editor/AutoLayoutCommands.cpp).
  void inferAutoLayout(Guid frame, bool padFromContent);
  // Sibling layers wrapped in a new auto-layout frame inferred from them (in the open transaction).
  Guid wrapInAutoLayout(const std::vector<Guid>& ids);
  // Suggest auto layout: sibling layers stacked into nested auto-layout frames (`into`: the frame they are in becomes
  // the outer stack); the frames created go to `made`. What stands for them now, or kNoGuid when nothing was stacked.
  Guid suggestStack(const std::vector<Guid>& ids, Guid into, std::vector<Guid>& made, int depth);
  void suggestInside(Guid frame, std::vector<Guid>& made, int depth);
  // SUGGEST_AUTO_LAYOUT, REMOVE_ALL_AUTO_LAYOUT, SET_STACK_LAYOUT_VERSION.
  Status autoLayoutCommand(CommandId id, const CommandArgs& args);
  uint32_t autoLayoutCommandState(CommandId id) const;
  // The auto-layout frames (their own layout) not at `version`'s layout: the selection's (with what is inside them
  // when `deep`) or the current page's.
  std::vector<Guid> stacksAt(uint32_t version, bool page, bool deep) const;
  // A position for a child of `parent` at `index` among its children without
  // `moving`; rebalances the siblings (in the open transaction) when the key
  // would be longer than 24 characters.
  std::string placeAt(Guid parent, size_t index, Guid moving);
  // `count` positions at `index` among `parent`'s children other than `moving`.
  std::vector<std::string> placeManyAt(Guid parent, size_t index, size_t count, const std::unordered_set<Guid, GuidHash>& moving);
  // Moves a node under `parent` at `position`, keeping its place on the page.
  void reparent(Guid id, Guid parent, const std::string& position);
  // A copy of `src`'s subtree with fresh GUIDs under `parent` at `position`; its root
  // gets `transform`. Returns the copy's id.
  Guid cloneSubtree(Guid src, Guid parent, const std::string& position, const Mat2x3& transform, const std::string* name = nullptr);
  Guid cloneTree(Guid src, Guid parent, const std::string& position, const Mat2x3& transform, const std::string* name, bool keepKeys);
  void deleteSelection();
  void nudge(double dx, double dy, bool repeat);
  // Arrows on auto-layout children: one place along the flow. False when the selection isn't that.
  bool reorderInFlow(const std::vector<Guid>& top, double dx, double dy);
  void reorder(int direction);  // ±1 one step, ±2 to the end
  void toggle(FieldMask field);
  void selectRelative(int which);  // 0 children, 1 parent, 2 next sibling, 3 previous sibling
  void selectAll();
  void selectInverse();
  Guid wrapSelection(const char* kind);  // "Group", "Frame", "Auto"
  // Round 7 (editor/SelectionCommands.cpp).
  Status selectionCommand(CommandId id, const CommandArgs& args);
  uint32_t selectionCommandState(CommandId id) const;
  void adoptIntoSection(Guid section);
  Guid wrapInSection();
  bool canRemoveKeepingContents(Guid id) const;
  void removeKeepingContents();
  std::vector<Guid> matchingLayers(const std::string& mode) const;
  Status selectMatching(const std::string& mode);
  void tidyUp();
  Status zoomToSiblingFrame(int step);
  // Round 10 (editor/ArrangeCommands.cpp): Convert to section / frame, Distribute edges, Pack, Round to pixel, the
  // Vector menu's Join / Smooth join / Split / Simplify / Offset.
  Status arrangeCommand(CommandId id, const CommandArgs& args);
  uint32_t arrangeCommandState(CommandId id) const;
  std::vector<Guid> convertibleToSection() const;
  std::vector<Guid> convertibleToFrame() const;
  Status convertKind(bool toSection);
  Status distributeEdges(CommandId id);
  Status pack(bool horizontal);
  Status roundToPixel();
  std::vector<Guid> vectorTargets() const;
  bool vectorJoinable() const;
  Status vectorJoin(bool smooth);
  Status vectorSplit();
  // Simplify vector within `tolerance` node px (each target in one step); Offset vector by `amount` (+ grows).
  Status vectorSimplify(double tolerance);
  Status vectorOffset(double amount, StrokeJoin join);
  // Their parts, shared with the tools (editor/PathTools.cpp): `net` with the points whose removal keeps the path
  // within `tolerance` merged away (false: nothing to remove); the result written (in vector edit mode, its network);
  // one layer offset (false: nothing to write).
  bool simplifyNetwork(geom::VectorNetwork& net, double tolerance) const;
  void writeSimplified(Guid id, const geom::VectorNetwork& net);
  bool writeOffset(Guid id, double amount, StrokeJoin join);
  // A layer written as a VECTOR with `net` (node space): shapes become VECTORs (same GUID), as Flatten makes them.
  void writeAsVector(Guid id, const geom::VectorNetwork& net);
  // Edit › Set default properties (this session only, as live Figma): a new layer of a type takes the look last set
  // for that type.
  Status setDefaultProperties();
  bool canSetDefaultProperties() const;
  NodeProps toolProps(NodeType type) const;
  std::map<NodeType, NodeProps> userDefaults_;
  // Text › Spell check (round 10): the edited text's misspelled words (UTF-16 ranges, the editor's spell checker's),
  // underlined while it is edited.
  std::vector<std::pair<uint32_t, uint32_t>> spelling_;
  Guid spellingNode_ = kNoGuid;
  std::vector<Guid> navigableFrames() const;
  // A new section as Figma makes one in the current UI theme (live 2026-10-08: dark — #444444, a white 10 % inside
  // stroke; light — white, a black 10 % stroke; radius 2, not clipping).
  NodeProps sectionProps() const;
  // A new slice (round 8, the Slice tool): no paints, one export setting (PNG 1x) as Figma gives it (unverified).
  NodeProps sliceProps() const;
  void ungroup();
  void duplicate();
  void flip(bool horizontal);
  void align(CommandId how, bool toParent = false);
  void distribute(bool horizontal);
  void addAutoLayout();
  void removeAutoLayout();
  Guid createPage();
  Status deletePage(Guid page);
  Guid duplicatePage(Guid page);
  // E4 / E5 (editor/VectorCommands.cpp).
  Status booleanSelection(BooleanOperation op);
  // The selected boolean groups still at an older vectorOperationVersion (Atlas 05 §9.2): how many, and brought to the
  // latest as one undo step ("Update boolean").
  size_t outdatedBooleans() const;
  Status upgradeBooleans();
  Status flattenSelection();
  // Round 19b (editor/PathfinderCommands.cpp): Illustrator's Pathfinders over the selection — its shapes (groups and
  // frames opened up, a boolean as its result) replaced by ordinary vectors, grouped (Minus Back: one vector), one undo
  // step with Illustrator's name, the result selected.
  Status pathfinderSelection(geom::PathfinderOp op, const geom::PathfinderOptions& options);
  bool pathfinderEnabled(geom::PathfinderOp op) const;
  // The selection's shapes as Pathfinder inputs (bottom first) in `toSpace`'s space, with the layers they came from.
  void pathfinderInputs(const Mat2x3& toSpace, std::vector<geom::PathfinderInput>& inputs, std::vector<Guid>& sources) const;
  Status outlineStroke();
  Status useAsMask();
  Status placeImage(const CommandArgs& args);
  bool selectionIsMask() const;
  // The paths a node's fills cover, in the space `toSpace` maps its own space to (groups: their children's).
  void fillPathsOf(Guid id, const Mat2x3& toSpace, geom::Path& out, WindingRule& rule) const;
  // Can Flatten take it? Shapes, texts, groups and frames (not components; an instance is detached first).
  bool flattenable(const NodeProps& p) const;
  // Figma's gates (docs/research/rea/vector.md §18): Flatten refuses a selection with an instance sublayer (a derived
  // layer; slot content, the user's own layers, is allowed); Outline stroke refuses every layer inside an instance,
  // slot content included.
  bool instanceSublayer(Guid id, bool slotsAllowed) const;

  // ---- Hover, handles, gestures (tools/Gestures.cpp) ----
  // LineEnd: a line's start (hx 0) or end (hx 1) handle.
  // Radius: a rectangle's corner radius handle (hx: the corner, 0 top-left … 3 bottom-left); Gap: a smart
  // selection's gap handle (hx: the gap, hy: 1 between rows).
  // Reorder: a smart selection's centre ring (hx: its index in the order); RotationOrigin: the ⌥R origin.
  // Shape: an ellipse's arc handles, a polygon's or a star's corner radius / ratio / count handle (hx: its index in
  // shapeHandles()).
  enum class Handle : uint8_t { None, Resize, Rotate, LineEnd, Radius, Gap, Reorder, RotationOrigin, Shape };
  Handle handleAt(Vec2 screen, int& hx, int& hy) const;
  // A single selected line — a LINE, or a vector with no width or no height — and its ends (world): Figma gives it
  // two endpoint handles instead of a box.
  bool selectedLine(Guid& id, Vec2& a, Vec2& b) const;
  void startLineEnd(int end);
  void dragLineEnd(Vec2 world, uint32_t mods);
  // The corner radius handles of the one selected rectangle while the pointer is over it (world; false: none shown).
  bool radiusHandles(Guid& id, Vec2 out[4]) const;
  void startRadius(int corner);
  void dragRadius(Vec2 world, uint32_t mods);
  // Live Figma's shape handles (canvas-ellipse-selected-arc-handle, canvas-star-selected-handles,
  // canvas-polygon-selected-handles): the one selected ellipse, polygon or star under the pointer shows rings — an
  // ellipse its arc's end (a full one: one ring on its right, inside the edge), with an arc also its start and the
  // ratio (inner radius); a polygon its corner radius (the top corner, inside it) and count (the next corner); a star
  // also its ratio (the first inner corner). World positions; false: none shown.
  enum class ShapeHandle : uint8_t { ArcEnd, ArcStart, ArcRatio, Radius, Ratio, Count };
  struct ShapeHandlePos {
    ShapeHandle kind = ShapeHandle::ArcEnd;
    Vec2 world;
  };
  bool shapeHandles(Guid& id, std::vector<ShapeHandlePos>& out) const;
  void startShapeHandle(int index);
  void dragShapeHandle(Vec2 world, uint32_t mods);
  // Smart selection (Figma): three or more selected layers of one parent, equally spaced in a row or a column — their
  // order along the axis, the axis (0 x, 1 y) and the spacing. False when the selection isn't that.
  struct SmartSelection {
    std::vector<Guid> order;
    int axis = 0;
    double spacing = 0;
  };
  bool smartSelection(SmartSelection& out) const;
  // `ids` (siblings) in a row or a column with equal gaps (smartSelection's test without the selection's conditions).
  bool equallySpaced(const std::vector<Guid>& ids, SmartSelection& out) const;
  // Round 11: the centre dots of a selected group's equally spaced layers (live Figma, canvas-group-selected) and the
  // pink gap boxes of a selected auto-layout component, set or instance (tools/Gestures.cpp).
  void groupDotsOverlay(Overlay& o) const;
  void hoverDottedOverlay(Overlay& o) const;
  void gapBoxesOverlay(Overlay& o) const;
  bool autoLayoutGaps(std::vector<Rect>& gaps, Mat2x3& W) const;
  std::vector<Guid> openForHit() const;  // what the selected layers are in (hitPath's `open`)  // the selected auto-layout component's gaps, in its space
  bool pointerInGap_ = false;                                    // the pointer is in one of them (they show then)
  void startGap(int gap);
  void startLayoutBar(int band);
  void dragLayoutBar(Vec2 world, uint32_t mods);
  // The pointer went into or out of the selection's box (true: draw again).
  bool selectionHoverChanged(Vec2 screen);
  void dragGap(Vec2 world, uint32_t mods);
  // ---- Round 8 (tools/CanvasTools.cpp) ----
  // The tools that select and move (Move, and Scale whose handles scale).
  bool selectingTool() const { return tool_ == Tool::MOVE || tool_ == Tool::SCALE; }
  // Smart selection reorder: the centre ring dragged — that layer follows the pointer, the others take the places in
  // the order its centre gives; let go, it takes its place.
  void startReorder(int index);
  void dragReorder(Vec2 world, uint32_t mods);
  void placeReorder(bool final);
  // ⌥R: the rotation origin (world), the selection's centre until it is dragged; reset when the selection changes.
  bool rotationOriginShown() const;
  Vec2 rotationOrigin() const;
  void dragRotationOrigin(Vec2 world, uint32_t mods);
  // The Scale tool (K): the handles scale the layers and what they hold — sizes, positions, radii, strokes, effects,
  // text sizes, auto layout's padding and gaps, layout grids, limits.
  void startScale();
  void applyScale(double s);
  // Ruler guides.
  bool rulersOn() const { return (viewOptions_ & VIEW_RULERS) != 0; }
  bool guideAt(Vec2 screen, RulerGuide& out) const;
  void writeGuides(Guid owner, const std::vector<RulerGuide>& guides);
  bool pressGuide(Vec2 screen, uint32_t mods);
  void dragGuide(Vec2 screen, uint32_t mods);
  void finishGuide(Vec2 screen);
  void guideOverlay(Overlay& o) const;
  // Lines a moving box or a dragged edge snaps to besides the layers: the guides in force there (rulers on) and the
  // layout grids of the frame it is in (layout guides on), world.
  void snapLines(Guid parent, std::vector<double>& xs, std::vector<double>& ys) const;
  // Whole px when Snap to pixel grid is on.
  double px(double v) const { return (viewOptions_ & VIEW_SNAP_PIXELS) ? std::round(v) : v; }
  // A click on an auto-layout bar: its value edited in place (REQUEST_INLINE_EDIT). Round 15: `pair` — a ⌥-click on a
  // padding: its pair (PADDING_HORIZONTAL / _VERTICAL), ⌥⇧ all four (PADDING_ALL); `at`: where the click was (screen).
  void requestInlineEdit(int bar, int pair = 0, Vec2 at = {-1, -1});
  // Round 15 (tools/SpacingHandles.cpp): the spacing cursor over a padding / gap bar or while dragging one (true: set).
  bool spacingCursor(Vec2 screen);
  // The `</>` button under the pointer (its hover and tooltip, DevMode.cpp's devHover).
  void devIconHoverAt(Vec2 screen);
  // Rotating: the first layer's rotation as the badge shows it ("45°", the Design panel's sign).
  std::string rotateBadgeText() const;
  // Paste: the view follows what was pasted when it isn't all in view (panned; zoomed out when it is larger).
  void revealPasted(const Rect& world);
  Guid titleAt(Vec2 screen) const;
  // An overlay label's width in CSS px (Inter Regular at the title size; `section`: Medium at the pill's size).
  double labelWidth(const std::string& text, bool section) const;
  void updateCursor(Vec2 screen);
  void updateHover(Vec2 screen, uint32_t mods);
  void updateMeasure(uint32_t mods);
  void updateAutoLayoutBands(Vec2 world);
  uint32_t pointerDown(Vec2 s, int button, uint32_t mods);
  uint32_t contextMenu(Vec2 s, uint32_t mods);
  void pointerMove(Vec2 s, uint32_t mods);
  void pointerUp(Vec2 s, uint32_t mods);
  void cancelGesture();
  void redrag(uint32_t mods);
  std::vector<Target> targetsOf(const std::vector<Guid>& ids) const;
  void prepareSnapping(Guid parent, const std::unordered_set<Guid, GuidHash>& moving);
  // Where a move would put its layers: the topmost frame under `world` (the page when none).
  Guid dropTargetAt(Vec2 world, bool force = false) const;
  // The frame or page a parent's layers belong to (through groups).
  Guid containerOf(Guid parent) const;
  void keepResizedSize(Guid id, bool x, bool y);
  void endGesture();
  // Round 17 (haptics): the dragged values as whole steps for the drag in progress (empty: the drag has none), and
  // one HAPTIC tick for a pointer move that changed them.
  std::vector<double> hapticValues() const;
  void movePointer(Vec2 s, uint32_t mods);  // pointerMove's gesture step
  // The coalesced move, handled now (before any other input, and at tick).
  void flushQueuedMove();
  // Figma's drag replay: a move that reflowed the page (layout ran: siblings moved, a parent grew) is run again once at
  // the same pointer at the next tick, so what it hit-tests (the drop target, the insertion, the marquee) sees the new
  // layout. A newer move in that frame takes its place (the replay is elided).
  void replayDrag();
  void hapticTick() { events_.haptics++; }
  // Opens the Move gesture for the selection's movable layers; false (nothing opened) when there are none.
  bool startMove(uint32_t mods);
  void setDuplicating(bool on);
  void dragMove(Vec2 world, uint32_t mods);
  void motionDragMove(Vec2 world, uint32_t mods);
  void finishMove();
  void updateInsertion(Guid frame, Vec2 world);
  void startResize(int hx, int hy);
  void dragResize(Vec2 world, uint32_t mods);
  void startRotate();
  void dragRotate(Vec2 world, uint32_t mods);
  void dragDraw(Vec2 world, uint32_t mods, bool click);
  void dragLine(Vec2 world, uint32_t mods, bool click);
  void dragMarquee(Vec2 world, uint32_t mods);
  void finishClick(uint32_t mods);

  // ---- Vector editing (editor/VectorEditing.cpp) ----
  struct VectorSession {
    Guid node = kNoGuid;
    VectorTool tool = VectorTool::MOVE;
    geom::VectorNetwork net;  // node space, at the node's size
    std::vector<uint32_t> selVerts, selSegs;
    bool pendingType = false;  // a shape that becomes a VECTOR at its first edit
    int penFrom = -1;          // the vertex the pen's next segment starts at
    Vec2 penOut;               // its outgoing tangent (node space)
    Vec2 pointer;              // world, for the pen's preview
    bool pointerKnown = false;
    // Hover.
    int hoverVertex = -1, hoverSegment = -1;
    // The gesture.
    enum class Drag : uint8_t { None, Vertices, Handle, Bend, PenNew, PenHandle, Marquee, Lasso, Cut, Erase, Builder, Width } drag = Drag::None;
    bool dragged = false;
    geom::VectorNetwork startNet;  // when the drag started (node space then)
    Mat2x3 startWorld;             // the node's world transform then
    Mat2x3 startLocal;             // its transform then
    int handleVertex = -1, handleSegment = -1;
    bool handleAtStart = false;  // the handle is the segment's start tangent
    double bendT = 0.5;
    int newVertex = -1;
    std::vector<Vec2> lasso;  // world
    std::vector<Vec2> trail;  // world: the Cut tool's line, the Erase tool's path
    Rect marquee;             // world
    std::vector<uint32_t> baseSel;
    bool committedInDrag = false;
    // Round 12: the other layers held (Enter on several), the edited one included; ones not in the document are skipped.
    std::vector<Guid> group;
    // Multi-edit (round 7b, docs/draw.md §4.6): the other held layers' selected points and segments (the edited one's
    // are selVerts / selSegs), and, while they are dragged, their networks and transforms when the drag started.
    struct Held {
      std::vector<uint32_t> verts, segs;
    };
    std::map<Guid, Held> others;
    struct HeldStart {
      Guid id;
      geom::VectorNetwork net;
      Mat2x3 world, local;
    };
    std::vector<HeldStart> othersStart;
    std::map<Guid, Held> othersBase;  // a Shift marquee / lasso: the other layers' selections it adds to
    // The Shape builder: its regions (world) for `builderKey`, the inputs' layers, the region under the pointer, the
    // regions a drag took (⌥ held when it started: they are removed).
    uint64_t builderKey = 0;
    geom::PlanarMap builderMap;
    std::vector<Guid> builderLayers;
    int builderHover = -1;
    std::vector<int> builderTaken;
    bool builderRemove = false;
    Vec2 builderLast;  // world: the drag's last point (regions crossed between moves count)
    // Variable width: the point under the pointer (its centre or a side: 1 left, 2 right), the selected one, where a
    // click on the stroke adds one (position along it, contour), the drag's points when it started.
    int widthHover = -1, widthHoverPart = 0, widthSelected = -1;
    bool widthPreview = false;
    double widthPreviewPos = 0;
    size_t widthPreviewContour = 0;
    int widthDragPart = 0;
    std::vector<geom::WidthPoint> widthStart;
  };
  uint32_t vectorPointerDown(Vec2 s, uint32_t mods, int clickCount);
  void vectorPointerMove(Vec2 s, uint32_t mods);
  void vectorPointerUp(Vec2 s, uint32_t mods);
  // Round 10: the Cut tool (a click on a segment or point, or a line dragged across the path) and the Erase tool (a
  // path dragged over segments), applied when the pointer comes up; one undo step each.
  void vectorCut(Vec2 s);
  void vectorErase();
  uint32_t vectorKey(KeyCode code, uint32_t mods);
  void vectorChanged();  // VECTOR_EDIT, a frame
  // Re-reads the network from the node (after undo / redo / outside changes).
  void reloadVector();
  // Writes `net` (in the space of a node whose transform is `local`) to node `id`: the box refitted to the
  // network, the vector data replaced. Returns the network as stored (shifted into the new box).
  geom::VectorNetwork writeVector(Guid id, geom::VectorNetwork net, const Mat2x3& local, const std::vector<VectorStyle>* styles = nullptr);
  // A node's network in its own space at its size; false when it has none (`convert`: a shape's outline).
  bool networkOf(Guid id, geom::VectorNetwork& out, bool& convert) const;
  void vectorOverlay(Overlay& o) const;
  // Hit-tests in screen px: a vertex, a handle (vertex + segment + which end), a segment (+ its t).
  int vectorVertexAt(Vec2 screen) const;
  bool vectorHandleAt(Vec2 screen, int& segment, bool& atStart) const;
  int vectorSegmentAt(Vec2 screen, double& t) const;
  Mat2x3 vectorToScreen() const;
  // Round 12: the Shape builder (tools/ShapeBuilder.cpp) and the Variable width tool (tools/VariableWidthTool.cpp).
  void builderUpdate();                        // the regions recomputed when the layers or the zoom changed
  int builderFaceAt(Vec2 world);
  uint32_t builderPointerDown(Vec2 s, uint32_t mods);
  void builderPointerMove(Vec2 s, uint32_t mods);
  void builderPointerUp();
  Status builderApply(const std::vector<int>& faces, bool remove);
  void builderOverlay(Overlay& o) const;
  bool widthCenter(geom::Path& center, Mat2x3& toWorld) const;  // the edited layer's stroke centre line (node space)
  int widthPointAt(Vec2 screen, int& part) const;
  uint32_t widthPointerDown(Vec2 s, uint32_t mods);
  void widthPointerMove(Vec2 s, uint32_t mods);
  void widthPointerUp();
  void widthWrite(const std::vector<geom::WidthPoint>& points);
  Status widthDeleteSelected();
  void widthOverlay(Overlay& o) const;
  Status widthCommand(CommandId id, const CommandArgs& args);
  uint32_t widthCommandState(CommandId id) const;
  // Figma Draw (editor/DrawCommands.cpp, tools/DrawTools.cpp).
  Status drawCommand(CommandId id, const CommandArgs& args);
  uint32_t drawCommandState(CommandId id) const;
  std::vector<Guid> drawTargets(const CommandArgs& args) const;
  Status createTextPath(Guid src, double tValue, bool replace, Guid* made);
  // Simplify vector / Offset path (editor/PathTools.cpp): the open tool, its layer and values, and — in vector edit
  // mode — the edit's state to restore before each preview.
  struct PathToolState {
    PathTool kind = PathTool::NONE;
    Guid node = kNoGuid;
    bool editing = false;
    geom::VectorNetwork net;
    std::vector<uint32_t> selVerts, selSegs;
    int penFrom = -1;
    bool pendingType = false;
    double threshold = 3, offset = 0, minOffset = 0, maxOffset = 0;
    StrokeJoin join = StrokeJoin::MITER;
  } pathTool_;
  Status pathToolPreview();
  void drawStrokeProps(NodeProps& p, bool brush);  // a new Pencil / Brush stroke: the tool's colour, weight and style
  // A brush applied to a stroke (SET_STROKE_BRUSH, the Brush tool): Figma's {base, ...the BRUSH node's own settings,
  // ...`user`} (3187.min.js @3366400, docs/research/rea/vector.md §5), clamped; the scatter or stretch settings as the
  // encoded NodeChange field, replacing what the layer had for its previous brush.
  std::string appliedBrushSettings(Guid brush, bool scatter, const json::Value* user) const;
  uint64_t newStrokeSeed();
  uint64_t seedState_ = 0x9E3779B97F4A7C15ull;
  uint32_t drawPointerDown(Vec2 s, uint32_t mods);
  bool drawCursor(Vec2 s);
  bool drawSample(Vec2 world, uint32_t mods);
  void textPathStartMove(Vec2 world);
  void textPathOverlay(Overlay& o) const;
  void textPathEditOverlay(Overlay& o, const text::TextLayout& L) const;
  void brushClipboard(std::vector<NodeChange>& nodes, const std::vector<const NodeProps*>& copied) const;
  void brushPaste(const std::vector<NodeChange>& clip, std::unordered_map<Guid, Guid, GuidHash>& remap);
  void remapStrokeBrush(NodeProps& p, const std::unordered_map<Guid, Guid, GuidHash>& remap) const;
  DrawTools drawTools_;
  // Motion (round 8a): the view state, the decoded model and the preview-write layer; `motionDirty_`: the index is
  // rebuilt before its next use (a commit changed the document).
  motion::State motion_;
  motion::MotionIndex motionIndex_;
  motion::MotionLayer motionLayer_;
  bool motionDirty_ = true;
  // Batch D: what the open transaction wrote, for its commit — anything (`motionDocTouched_`), and anything that puts
  // a node in the index (`motionTouched_`, MotionIndex::mayAnimate). A commit that wrote nothing, or nothing motion
  // into a document whose index is empty, keeps the index: the rebuild walks every node (~150 ms on a 350k-node file,
  // after every click).
  bool motionDocTouched_ = false;
  uint64_t motionRebuilds_ = 0;
  bool motionTouched_ = false;
  // Round 8j: the layer evaluates inside the open transaction (setMotion's `inTransaction`: a style's canvas preview,
  // whose transaction is cancelled and holds no other write); cleared when the transaction ends.
  bool motionInTxn_ = false;
  void motionApply();
  // Round 8i: the index rebuilt with the variables resolved (EASING / TIMING bindings, in the animated layer's modes);
  // the top-level frames with animated layers (the Motion icon before their names, render/FrameTitles.h), kept with it.
  void motionRebuild();
  std::vector<Guid> motionTitleRoots_;
  // Round 8a, increment 2: lays out what the motion layer's layout-changing fields touched, its writes previews; the
  // motion path and the anchor point's target of the selected layer on the canvas.
  void motionRelayout(const std::vector<Guid>& dirty);
  void motionOverlay(Overlay& o) const;
  // Round 8b (editor/MotionCommands.cpp).
  Status motionCommand(CommandId id, const CommandArgs& args);
  Status motionAudioCommand(CommandId id, const json::Value& raw);  // round 8e: 345–348 on the root's audio
  std::vector<std::pair<Guid, Guid>> motionExportLayers(Guid root);  // round 8e: (layer, parent) as the exports walk them
  bool motionRasterized(Guid id) const;
  uint32_t motionCommandState(CommandId id) const;
  const VariableData* motionSlotData(const NodeProps& p, const motion::Slot& s) const;
  bool motionBaseValue(const NodeProps& p, const motion::Slot& s, motion::KeyframeValue& out) const;
  void motionWriteSlot(Guid id, const motion::Slot& s, const VariableData& data);
  Guid internalCanvas() const;
  Guid motionTrackOf(const NodeProps& p, const motion::Slot& s) const;
  Guid motionEnsureTrack(Guid id, const motion::Slot& s, Guid root);
  Guid motionKeyframeAt(Guid track, int64_t timeUs) const;
  Guid motionUpsertKeyframe(Guid track, int64_t timeUs, const motion::KeyframeValue& value, const json::Value* easing);
  // Round 8i: easings and a clip's timing bound to EASING / TIMING variables; X / Y tracks combined and split.
  void motionBindEasing(Guid keyframe, Guid variable);
 public:
  // A public MotionEasing as an EasingData (JSON), for keyframes, clips and EASING variables (VariableCommands.cpp).
  static bool motionEasingData(const json::Value& pub, json::Value& out);

 private:
  void motionBindPresetVariables(Guid preset, const json::Value& variables);
  Status motionCombineTracks(Guid node, bool scale, bool combine);
  Status motionCreateStyle(const json::Value& spec);
  void motionReapplyStyle(Guid style, const json::Value& runs);
  void motionRemoveTrack(Guid track);
  std::vector<Guid> motionTracksOwnedBy(const std::vector<Guid>& ids);
  bool motionSlotOfTrack(Guid track, Guid& owner, motion::Slot& slot);
  bool motionCurrentValue(Guid id, const motion::Slot& slot, int64_t timeUs, motion::KeyframeValue& out);
  FieldMask motionRouteWrite(Guid id, NodeChange& props);
  // Round 8b, increment 2: a move, resize or rotate of layers under the timeline's root while Motion is on is drawn as
  // the motion layer's preview writes (no transaction) and keyed in one step when it ends; a nudge is keyed at once.
  struct MotionDrag {
    bool on = false;
    bool moved = false;     // a preview was written (a click on a handle keys nothing)
    bool rotating = false;  // the rotate handle: the turn goes to ROTATION
    struct Item {
      Guid id;
      Mat2x3 shown;  // where the canvas showed it when the gesture began (the parent's space)
      Vec2 shownSize;
      Mat2x3 to;  // where the gesture leaves it
      Vec2 toSize;
    };
    std::vector<Item> items;
  };
  MotionDrag motionDrag_;
  bool motionGestureFor(const std::vector<Guid>& ids);
  bool motionStartGesture(const std::vector<Target>& targets, bool rotating);
  void motionPreview(Guid id, const Mat2x3& transform, Vec2 size);
  void motionFinishGesture(const char* label);
  void motionCancelGesture();
  void motionKeyPose(Guid id, const Mat2x3& shown, Vec2 shownSize, const Mat2x3& to, Vec2 toSize, bool rotating);
  motion::LayerBase motionPoseAt(Guid id, int64_t timeUs);
  void motionKeyAtPlayhead(Guid id, const motion::Slot& s, Guid root, const motion::KeyframeValue& value);
  void motionShiftTranslation(Guid id, Vec2 by);
  // Round 8a, increment 2: the anchor point tool (⌥R in Motion, docs/motion.md §4.9) — its target dragged (a view state,
  // snapped to the layer's box), MOTION_SET_ANCHOR when let go.
  struct MotionAnchorDrag {
    Guid id = kNoGuid;
    Vec2 world;  // where the target is drawn
  };
  MotionAnchorDrag motionAnchor_;
  bool motionAnchorTarget(Guid& id, Vec2& world) const;
  bool motionAnchorPress(Vec2 screen);
  void motionAnchorDrag(Vec2 world, uint32_t mods);
  void motionAnchorDrop();
  // Ownership (docs/motion.md §4.2): a copied layer's tracks copied with it; the clipboard carries them.
  void motionCopyTracks(NodeProps& p, Guid parent, const std::vector<NodeChange>* clip);
  Guid motionCopyTrack(Guid track, const std::vector<NodeChange>* clip);
  void motionClipboard(std::vector<NodeChange>& nodes, const std::vector<const NodeProps*>& copied) const;
  Guid motionCopyPreset(Guid preset, const std::vector<NodeChange>* clip, std::unordered_map<Guid, Guid, GuidHash>& tracks);
  // Round 8h (docs/motion.md §4.6): animation presets — ANIMATION_PRESET_INSTANCE clips on the internal canvas, listed
  // in their layer's `animationPresets`, their materialised tracks their KEYFRAME_TRACK children bound through
  // ANIMATION_PRESET parameters — and the composite styles that generated them (`styleIdsForAnimation`).
  bool motionBindingOf(const NodeProps& p, const motion::Slot& s, VariableData& base, std::vector<motion::Param>& params) const;
  Guid motionAddPreset(Guid node, Guid root, const json::Value& spec, int64_t startUs);
  bool motionPresetProps(const json::Value& spec, Guid parent, int64_t startUs, NodeProps& out);
  bool motionEditPreset(Guid preset, const json::Value& edit);
  void motionSetPresetTracks(Guid preset, const json::Value& output);
  void motionRemovePreset(Guid preset);
  void motionScalePreset(Guid preset, double factor);
  Guid motionPresetOwner(Guid preset) const;
  void motionWritePresetList(Guid node, const std::vector<Guid>& presets);
  Guid textPathDrag_ = kNoGuid;    // the TEXT_PATH whose start handle is dragged
  Guid textPathHover_ = kNoGuid;   // the edge the Text on path tool is over (highlighted)
  void switchVectorNode(Guid id);
  // Multi-edit (docs/draw.md §4.6): another held layer's point under the pointer; the other layers' selected points
  // remembered when a drag starts and moved by a world delta; their points selected where `inside` holds (a marquee, a lasso).
  int heldVertexAt(Vec2 screen, Guid& node) const;
  void heldDragStart();
  void heldDragMove(Vec2 worldDelta);
  void heldSelectWhere(const std::function<bool(Vec2)>& inside);
  // Pencil.
  void pencilFinish();
  std::vector<Vec2> pencilPoints_;  // world

  // ---- Paint editing (editor/PaintEditing.cpp) ----
  struct PaintSession {
    Guid node = kNoGuid;
    bool strokes = false;
    uint32_t index = 0;
    int stop = 0;
    enum class Drag : uint8_t { None, Handle, Stop } drag = Drag::None;
    int handle = 0;  // 0 start / centre, 1 end, 2 width
    Paint start;     // the paint when the drag started
    bool dragged = false;
    bool effect = false;  // a progressive blur (`index` into the effects), not a gradient paint
    Effect effectStart;   // the effect when the drag started
  };
  const Paint* editedPaint() const;
  const Effect* editedBlur() const;
  // The session's paint or progressive blur is still there.
  bool paintSessionLive() const { return paint_.effect ? editedBlur() != nullptr : editedPaint() != nullptr; }
  void writeBlur(const Effect& e);
  // The handles in node unit space: [start or centre, end, width].
  void paintHandles(const Paint& p, Vec2 out[3]) const;
  uint32_t paintPointerDown(Vec2 s, uint32_t mods);
  void paintPointerMove(Vec2 s, uint32_t mods);
  void paintPointerUp();
  void writePaint(const Paint& p);
  void paintOverlay(Overlay& o) const;
  void paintChanged();

  // ---- Prototype mode (editor/PrototypeEditing.cpp) ----
  struct ProtoLink {
    Guid source = kNoGuid;       // the hotspot
    Guid interaction = kNoGuid;  // its interaction's id
    size_t index = 0;            // which of the hotspot's interactions
    std::vector<size_t> action;  // the action's path (conditional branches: action, branch, action…)
    Guid dest = kNoGuid;
    bool media = false;          // a video action (UPDATE_MEDIA_RUNTIME): its end goes onto videos
    bool changeTo = false;       // a Change to (SWAP_STATE): drawn lavender (round 17)
  };
  struct ProtoSession {
    bool on = false;
    // Line (round 17): pressed on a connection's line or label — a click selects it, a drag moves its end (Retarget).
    // MoveStart: its start dragged to another layer (the selected connection's start dot).
    enum class Drag : uint8_t { None, New, Retarget, Line, MoveStart } drag = Drag::None;
    std::vector<Guid> sources;  // New: the hotspots (the selection)
    ProtoLink link;             // Retarget / Line / MoveStart: the connection
    Vec2 point;                 // world: where the dragged end is
    Guid target = kNoGuid;      // the frame (variant, layer) it would connect to
    proto::Navigation targetNav = proto::Navigation::NAVIGATE;  // what connecting there makes (Change to, Scroll to)
    Vec2 labelAt;               // Line: the pressed connection's label centre (screen)
    double labelW = 0, labelH = 0;
    // The connection open in Interaction details (setPrototypeSelection).
    Guid selNode = kNoGuid;
    int selIndex = -1;
    // Selected by a click on its line or label (not just opened in the panel, nor just made): its start dot drags
    // the start; otherwise a press there is the hotspot's nub (a further new connection, as live).
    bool selClicked = false;
    bool handleHovered = false;
    // Round 16: the pointer (screen; the nubs sit on the sides nearest it), the hotspot whose nub it is on, and the
    // sides a new connection leaves from (one per source).
    bool hasPointer = false;
    Vec2 pointer;
    Guid hoveredNub = kNoGuid;
    std::vector<NoodleSide> sourceSides;
    // The page's connections, cached per document version.
    uint64_t version = ~0ull;
    Guid page = kNoGuid;
    std::vector<ProtoLink> links;
  };
  ProtoSession proto_;
  bool viewer_ = false;
  bool partial_ = false;          // setPartial: a page's subset (encodePage)
  bool lazyScreens_ = false;      // setLazyScreens: a page's screens derived as they are shown (deriveTree)
  bool freshBindings_ = false;    // setFreshBindings: the next load's bound values are current
  std::unordered_set<Guid, GuidHash> staleCanvases_;  // … except on these pages
  std::vector<Guid> bindingsPending_;  // bound nodes loaded current, their dependencies not noted yet
  void flushPendingBindings();          // all of them into bindingsDirty_ (a variable, style or mode changed)
  std::vector<Guid> lacking_;     // what changes needed that the subset doesn't have (takeLacking)
  void noteLacking(Guid id);

  // ---- Canvas navigation (editor/CanvasNav.cpp, round 16) ----
  struct CameraAnimation {
    bool on = false;
    Camera from, to;
    double start = -1;  // the first tick's time
    double duration = 300;
  };
  CameraAnimation camAnim_;
  struct ScrollbarSession {
    bool pendingShow = false;  // the view moved: shown from the next tick's time
    double shownAt = -1e12;    // when the view last moved (or the pointer was on a bar)
    double alpha = 0;          // as last drawn
    bool hoverH = false, hoverV = false;
    int drag = 0;              // 1 the horizontal thumb, 2 the vertical one
    double panPerPx = 0;       // the drag's ratio (fixed at the press: the extent grows with the view)
    // The page's content bounds (world), per document version and page.
    uint64_t version = ~0ull;
    Guid page = kNoGuid;
    bool any = false;
    Rect content;
  };
  ScrollbarSession scroll_;

  // ---- Dev Mode (editor/DevMode.cpp) ----
  struct DevSession {
    bool show = true, dots = false;
    Guid category = kNoGuid;  // the zoom menu's Annotations ▸ filter: only this category's notes (none: all)
    Guid focus = kNoGuid;
    Guid selectedMeasurement = kNoGuid;
    Guid openNode = kNoGuid;  // dots: the annotation whose label is open
    int openIndex = -1;
    // The measurement tool: the edge under the pointer; a drag from it.
    bool hasEdge = false;
    Guid edgeNode = kNoGuid;
    annot::Side edgeSide = annot::Side::LEFT;
    Guid fromNode = kNoGuid;
    annot::Side fromSide = annot::Side::LEFT;
    Vec2 point;
    bool hasTo = false;
    Guid toNode = kNoGuid;
    annot::Side toSide = annot::Side::LEFT;
    // A saved measurement being dragged off the design.
    annot::Measurement dragged;
    bool draggedMoved = false;
  };
  DevSession dev_;
  bool devEdits_ = false;
  bool devInspect_ = false;
  bool editTracking_ = false;
  std::function<double()> wallClock_;
  std::unordered_set<Guid, GuidHash> userGeometry_;  // this USER step's nodes whose size / transform the user wrote (base)
  std::unordered_set<Guid, GuidHash> edited_;     // this transaction's edited nodes (editInfo)
  std::unordered_set<Guid, GuidHash> scoped_;     // this transaction's written nodes (editScopeInfo)
  std::vector<std::pair<EditScopeType, std::string>> editScopes_;  // editScopePush's stack, outermost first
  std::string editScopeError_;
  std::unordered_set<Guid, GuidHash> annotated_;  // nodes with annotations
  CanvasHits hits_;
  void devOverlay(Overlay& o) const;
  void devInspectOverlay(Overlay& o) const;
  void devInspectSpacing(Guid frame, Overlay& o) const;  // an auto-layout frame's paddings and gaps (DevMode.cpp)
  uint32_t devPointerDown(Vec2 s, uint32_t mods);
  bool devPointerMove(Vec2 s);
  bool devPointerUp(Vec2 s);
  void devHover(Vec2 s);
  uint32_t devKey(KeyCode code, uint32_t mods);
  // Writes the page's measurements (one undo step).
  void writeMeasurements(Guid page, const std::vector<annot::Measurement>& list, const char* label);
  // editInfo: the user edits of the open transaction, stamped at its commit.
  void noteEdited(const NodeChange& c);
  void stampEdited();
  void stampScopes();  // editScopeInfo on scoped_ (DevMode.cpp)
  void noteAnnotated(const NodeChange& c);
  // The edge the measurement tool snaps to under `s` (`axis`: 0 any, 1 left / right, 2 top / bottom).
  bool edgeAt(Vec2 s, int axis, Guid& node, annot::Side& side) const;
  Status measurementCommand(CommandId id, const CommandArgs& args);
  // Focus view: a hit path outside the focused design is no hit.
  void focusFilter(std::vector<Guid>& path) const;
  const std::vector<ProtoLink>& protoLinks();
  // The hotspots that show a "+" handle (the selection, top-level layers and layers inside frames) and where it is.
  std::vector<Guid> protoHandleNodes() const;
  // Round 16: the nub under `s` (on the hotspot's side nearest it): its hotspot and side.
  bool protoHandleAt(Vec2 s, std::vector<Guid>* nodes = nullptr, Guid* hit = nullptr, NoodleSide* side = nullptr) const;
  bool protoEndAt(Vec2 s, ProtoLink& out);
  // Round 17: the selected connection's start dot under `s`.
  bool protoStartAt(Vec2 s, ProtoLink& out);
  // Round 17: a connection whose line (within a few px) or label chip is under `s`, topmost first; `label` gets its
  // label's box (screen; the curve's middle when it has none).
  bool protoLineAt(Vec2 s, ProtoLink& out, Rect* label = nullptr);
  // A connection's curve on screen (CSS px) and its label ("" for On click: Figma labels only the other triggers).
  NoodleCurve protoCurve(const ProtoLink& l) const;
  std::string protoLabel(const ProtoLink& l) const;
  bool protoSelected(const ProtoLink& l) const;
  // Where a noodle lands: a video layer (`videos`: help "Use videos in prototypes" — "Create a connection from your
  // starting object to the video"), else — round 17 — another variant of the hotspot's own component set (Change to:
  // help "Create interactive components"), a layer in the hotspot's own top-level frame (Scroll to), or a top-level
  // frame (one in a section too). `nav` gets what connecting there makes.
  Guid protoTargetAt(Vec2 world, const std::vector<Guid>& sources, bool videos = false, bool frames = true,
                     proto::Navigation* nav = nullptr) const;
  // Round 17: the layer a dragged start lands on (the innermost under the point; not the destination).
  Guid protoSourceAt(Vec2 world, Guid dest) const;
  // Selects a connection: its hotspot, the highlight, PROTOTYPE_CONNECTION_SELECTED with its label's box.
  void protoSelectLink(const ProtoLink& l, const Rect* label);
  uint32_t protoPointerDown(Vec2 s, uint32_t mods);
  void protoPointerMove(Vec2 s);
  void protoPointerUp(Vec2 s);
  void protoHover(Vec2 s);
  void protoOverlay(Overlay& o) const;
  // ---- Grid auto layout on the canvas (tools/GridGestures.cpp) ----
  // A selected grid's tracks along its edges, the hovered / selected ones labelled with their grabber, the drop line.
  void gridTrackOverlay(Overlay& o) const;
  void gridSpanOverlay(Overlay& o) const;
  // What the pointer is over: Hover — a track's band (its compact pill shows; inside the frame a column and a row at
  // once: hoverColumn / hoverRow), an expanded pill's Grabber, Label or Chevron, or the Edge between two tracks.
  struct GridHit {
    enum class Kind : uint8_t { None, Hover, Edge, Grabber, Label, Chevron } kind = Kind::None;
    bool column = true;
    size_t track = 0;
    int hoverColumn = -1, hoverRow = -1;
  };
  // A track's pill (screen CSS px): compact, or expanded — grabber, label, chevron (`labelWidth` the middle one).
  Rect gridPillRect(Guid frame, bool column, size_t track, bool expanded, double& labelWidth) const;
  struct GridDrag {
    enum class Kind : uint8_t { None, Select, Resize, Reorder, Span } kind = Kind::None;
    Guid frame = kNoGuid, item = kNoGuid;
    bool column = true, moved = false, edit = false;
    size_t track = 0, dropAt = 0, start = 0, span = 1;
    int edge = 0;  // span handles: 0 left, 1 top, 2 right, 3 bottom
    double startSize = 0;
  };
  struct GridTrackSelection {
    Guid frame = kNoGuid;
    bool column = true;
    std::vector<size_t> tracks;
  };
  Guid gridFrameSelected() const;
  void gridTrackSpans(Guid frame, bool column, std::vector<std::pair<double, double>>& spans, double& across) const;
  GridHit gridHitAt(Vec2 s) const;
  bool gridSpanHandles(Guid& item, Vec2 out[4]) const;
  int gridSpanHandleAt(Vec2 s) const;
  // `edit`: the GRID_TRACKS event asks TS for the label's field and sizing menu at track `anchor`'s pill (default: the
  // first selected).
  void setGridTrackSelection(Guid frame, bool column, std::vector<size_t> tracks, bool edit, size_t anchor = SIZE_MAX);
  // Round 12: a selected grid's gaps as boxes in its own space (live Figma, grid-selected-hover-gap): between columns
  // (axis 0) one per row, between rows (1) one per column, each with the boundary and the track across it.
  struct GridGapBox {
    Rect rect;
    size_t boundary = 0, cross = 0;
  };
  // A selected grid's gap under the pointer (live Figma, grid-selected-hover-gap) or being dragged: the gaps between
  // columns (axis 0) or rows (1), the one after track `boundary`, in the track `cross` across it.
  struct GridGapHover {
    Guid frame = kNoGuid;
    int axis = -1;
    size_t boundary = 0, cross = 0;
  };
  std::vector<GridGapBox> gridGapBoxes(Guid frame, int axis) const;
  // The gap under `local` (the frame's space): axis −1 when none.
  GridGapHover gridGapAt(Guid frame, Vec2 local) const;
  void gridGapOverlay(Overlay& o) const;
  void clearGridTrackSelection();
  Status selectGridTracksCommand(const CommandArgs& args);
  uint32_t gridPointerDown(Vec2 s, uint32_t mods);
  void gridPointerMove(Vec2 s, uint32_t mods);
  void gridPointerUp(Vec2 s, uint32_t mods);
  void gridCancel();
  bool gridCursor(Vec2 s);
  uint32_t gridKey(KeyCode code, uint32_t mods);
  Status deleteGridTracks();
  std::vector<size_t> gridMovingTracks(Guid frame, bool column, std::vector<size_t> tracks);
  void writeGridTracks(Guid frame, bool column, const std::vector<Layout::GridTrackDef>& tracks);
  GridDrag gridDrag_;
  GridTrackSelection gridSel_;
  // The column whose compact pill stays while the pointer is on the rows' side (Group 1; updateAutoLayoutBands).
  Guid gridBandFrame_ = kNoGuid;
  int gridBandColumn_ = -1;

  // ---- Text editing (editor/TextEditing.cpp) ----
  struct TextSession {
    Guid node = kNoGuid;
    uint32_t anchor = 0, focus = 0;  // UTF-16
    bool upstream = false;           // the caret at a soft wrap sits at the end of the line before
    double preferredX = -1;          // ↑ / ↓ keep this x
    bool created = false;            // the session made the node
    size_t undoCount = 0;            // the undo step the session's edits merge into (0: none yet)
    bool composing = false;
    uint32_t compStart = 0, compLength = 0;
    double blinkStart = 0;
    bool caretOn = true;
    int granularity = 0;             // a drag selecting by 0 characters, 1 words, 2 paragraphs
    uint32_t dragStart = 0, dragEnd = 0;  // the word / paragraph the drag started in
  };
  uint32_t textKey(KeyCode code, uint32_t mods);
  uint32_t textPointerDown(Vec2 s, uint32_t mods, int clickCount);
  void textDrag(Vec2 s);
  // Puts [from, to) of the edited text = `insert`, one merged undo step, autoRename, layout.
  void textReplace(uint32_t from, uint32_t to, std::u16string_view insert, const char* label);
  void setTextSelection(uint32_t anchor, uint32_t focus, bool keepX = false);
  void textChanged();  // TEXT_EDIT, caret blink restart, a frame
  uint32_t textIndexAt(Vec2 screen) const;
  std::u16string editedText() const;
  void createTextAt(Vec2 world, double width);
  Status applyTextStyle(Guid id, const NodeChange& props);
  void textToggleStyle(KeyCode code, uint32_t mods);
  uint32_t styleFrom_ = UINT32_MAX, styleTo_ = UINT32_MAX;  // setStyleRange

  Document doc_;
  UndoStack undo_;
  Guid page_ = kNoGuid;
  std::map<Guid, std::vector<Guid>> pageSelections_;
  uint32_t sessionID_ = 1;
  uint32_t nextLocalID_ = 1;
  std::vector<Guid> selection_;
  Camera camera_;
  // A right press with Right-click and drag to pan on (round 9): panning once it moved, the context menu on release if not.
  bool rightPress_ = false, rightPanned_ = false;
  bool zooming_ = false;  // the camera's zoom last changed by the wheel or a pinch (Overlay::zooming)
  Viewport viewport_{800, 600, 1, 0, 0};
  Theme theme_ = Theme::Dark;
  Tool tool_ = Tool::MOVE;
  CursorKind cursor_ = CursorKind::DEFAULT;
  double cursorAngle_ = 0;
  Guid hover_ = kNoGuid;
  std::vector<Guid> layersHover_;
  LocalChat localChat_;  // round 18: the local user's cursor chat bubble
  std::vector<PresencePeer> presence_;  // round 18: other people's cursors and selections
  bool spaceHeld_ = false;
  bool needsRender_ = true;
  uint32_t viewOptions_ = kViewOptionsDefault;
  bool zoomHeld_ = false;  // Z held: the zoom tool (a click zooms in, ⌥ out, a drag to the area)
  uint32_t mods_ = 0;
  bool coalesceMoves_ = false;
  struct QueuedMove {
    bool on = false;
    Vec2 s;
    uint32_t mods = 0;
  } queuedMove_;
  uint64_t layoutRuns_ = 0;    // reflows: layout passes that laid something out (flushLayout), flows placed (placeFlow)
  bool replayWanted_ = false;  // the last move reflowed the page: replayDrag at the next tick
  bool replaying_ = false;
  uint32_t dragReplays_ = 0;
  Events events_;
  std::unordered_map<Guid, size_t, GuidHash> nodeEventIndex_;

  // The open transaction.
  struct Txn {
    bool open = false;
    int depth = 0;
    TxnKind kind = TxnKind::USER;
    std::string label;
    ChangeSet changes;
    bool run = false;   // txnBeginRun: the step is marked for the next run slice
    bool join = false;  // txnBeginRun(join): folds into the marked step
    bool peer = false;  // APPLY_PEER: another session's change — every history yields what it wrote
  } txn_;
  // The user's undo count right after the last run slice committed (SIZE_MAX: none, or something else since).
  size_t runMark_ = SIZE_MAX;
  std::vector<Guid> lastNudged_;
  // ⌘D: each copy the last duplicate made → its original (the next ⌘D repeats the offset the copy was moved by).
  std::unordered_map<Guid, Guid, GuidHash> duplicatedFrom_;
  // N / ⇧N: the frame the view last went to, and the selection then.
  Guid zoomFrame_ = kNoGuid;
  std::vector<Guid> zoomSelection_;

  // Layout.
  std::unordered_set<Guid, GuidHash> layoutDirty_;
  std::unordered_set<Guid, GuidHash> groupsTouched_;
  // An undo / redo's system writes after its replay (layout, groups, bindings), as inverses: they join the batch the
  // replay put on the other stack (UndoStack::extendTop) when it commits.
  std::vector<NodeChange> replayWrites_;
  bool replayPushed_ = false;
  // The first of replayWrites_ for `id` holding `field`: its value as the replay left it (layout's base, as the open
  // inverse is in the user's steps).
  const NodeChange* replayInverse(Guid id, FieldMask field) const;
  std::unordered_set<Guid, GuidHash> excluded_;  // dragged into an auto-layout flow: no space there yet
  std::unordered_set<Guid, GuidHash> pinned_;    // dragged inside its own flow: keeps its slot, not moved by layout
  // Round 15 (live Figma, docs/research/figma/live/behaviour/autolayout-drag.md; docs/engine.md §8.6): one layer
  // dragged inside its own horizontal, vertical or wrapping auto-layout flow is reordered in the document as its
  // leading edge passes a neighbour's centre (layout/Reorder.h); its slot travels with it, the siblings slide to their
  // new places, it draws above them, and its chrome goes at the first swap (the last child's at the first move).
  // Round 2 (the owner's second recording): several selected layers of one flow move as one block — together, in
  // their order, from the first swap; dragged out of the frame (the pointer leaves it) they are the page's or another
  // frame's, the others close up at once, and from then on the frame is "elsewhere" (a drag back in shows the
  // insertion line, as a layer from anywhere else).
  struct FlowDrag {
    std::vector<Guid> ids;      // the dragged layers, in flow order
    Guid frame = kNoGuid;       // their auto-layout frame
    bool last = false;          // the block held the last of the flow when the drag began
    bool chromeHidden = false;  // outline, handles, size label and the frame's dashes gone until the drop
    bool left = false;          // dragged out of the frame (for the rest of the gesture)
    double along = 0;           // the block's leading coordinate along the flow at the last move (the direction of travel)
  } flowDrag_;
  struct Slide {
    Mat2x3 from, to, shown;  // where it slides from and to, and where the slide last put it
    double start = -1;       // ms (tick time); < 0: from the next tick
  };
  std::unordered_map<Guid, Slide, GuidHash> slides_;  // siblings sliding to their new places
  static constexpr double kSlideMs = 120;             // CSS ease-out over 120 ms (fitted on the recording)
  void startFlowDrag();
  bool flowDragLive() const;  // the layers are in their own flow now (not dragged out, not ⌥ copies)
  // Every layer moved ignores auto layout (stackPositioning ABSOLUTE) and is still in the parent it started in.
  bool absoluteAtHome() const;
  Rect flowDragBox() const;   // the dragged layers' layout boxes' union, in the frame's space
  void reorderFlow();
  bool placeFlow(Guid frame, const std::unordered_set<Guid, GuidHash>& dragged);
  void slideFrom(const std::unordered_map<Guid, Mat2x3, GuidHash>& shown);
  void applySlides(double now);
  void writeQuiet(Guid id, const Mat2x3& transform);
  bool inLayout_ = false;
  bool ignoreConstraints_ = false;

  // The gesture in progress.
  Gesture gesture_ = Gesture::None;
  Vec2 downScreen_, downWorld_, lastScreen_;
  Camera downCamera_;
  uint32_t downMods_ = 0;
  Guid pressed_ = kNoGuid;       // what the press picked
  bool pressedWasSelected_ = false;
  bool pressMarquee_ = false;    // a drag from here is a marquee
  Guid marqueeScope_ = kNoGuid;  // the top-level frame a marquee started in
  std::vector<Guid> baseSelection_;
  Rect marquee_;
  std::vector<Target> targets_;
  std::vector<Target> originalTargets_;  // a move's layers as they started (⌥ may swap in copies)
  std::vector<Guid> originals_;  // ⌥-drag: the layers the copies came from
  bool duplicating_ = false;
  Rect moveBox_;                 // the moving layers' world bounds when the move started
  Guid dropParent_ = kNoGuid;
  Guid snapParent_ = kNoGuid;    // whose children the snapper holds
  SelectionBox box_;
  // A selection across parents (selectionGroups): the other groups a resize moves by the dragged box's amounts, and which
  // group's box handleAt found the handle on.
  struct ResizeGroup {
    SelectionBox box;
    std::vector<Target> targets;
  };
  std::vector<ResizeGroup> resizeGroups_;
  mutable size_t handleGroup_ = 0;
  int handleX_ = 0, handleY_ = 0;
  int lineEnd_ = -1;             // dragging a line's start (0) or end (1) handle; -1: a box resize
  int radiusCorner_ = -1;        // dragging a corner radius handle
  bool hapticArmed_ = false;            // round 17: hapticFrom_ holds the drag's values at its last tick
  std::vector<double> hapticFrom_;
  double snapTickX_ = std::numeric_limits<double>::quiet_NaN(), snapTickY_ = std::numeric_limits<double>::quiet_NaN();  // the guides a move last snapped to
  int radiusHover_ = -1;         // the radius handle under the pointer
  int gapHover_ = -1;            // the smart selection's gap handle under the pointer
  SmartSelection gapDrag_;       // dragging a gap handle: the selection as it started
  int gapIndex_ = -1;
  CornerRadii originalRadii_{0, 0, 0, 0};  // the dragged rectangle's radii at the press
  uint32_t originalInverted_ = 0;           // and its inverted corners (round 16: ⌘ drags them inward)
  int shapeHover_ = -1;                    // the shape handle under the pointer
  // Dragging a shape handle: which, the layer's shape fields and corner radius at the press, the pointer's angle
  // around the shape's centre (unwrapped as it turns) and its distance from it (the shape's unit circle).
  struct ShapeDrag {
    int index = -1;
    ShapeHandle kind = ShapeHandle::ArcEnd;
    ArcData arc;
    uint32_t count = 0;
    double ratio = 0, radius = 0;
    double lastAngle = 0, turned = 0, startReach = 0;
  } shapeDrag_;
  bool aiHover_ = false;
  bool pointerNearSelection_ = false;  // within 64 px of the selection on screen (the AI sparkle, Group 1)  // the pointer on the AI sparkle by the selection (Group 1)
  bool contextMenuHeld_ = false;  // a context menu opened from the canvas: a pointer leave keeps the hover handles (Group 1)
  bool pointerInSelection_ = false;        // the pointer is over the selection's box (radius and gap handles show)
  NodeType drawType_ = NodeType::NONE;
  bool drawArrow_ = false;
  Guid drawParent_ = kNoGuid;
  Guid drawn_ = kNoGuid;
  Snapper snapper_;

  // What the overlay shows besides the selection.
  std::vector<GuideLine> guides_;
  std::vector<SpacingMark> spacings_;
  std::vector<SpacingMark> measures_;
  std::vector<GuideLine> measureGuides_;
  Guid measureTarget_ = kNoGuid;
  bool hasInsertion_ = false;
  GuideLine insertion_;
  size_t insertIndex_ = 0;
  // Dropping into a grid without automatic placement: the cell the dragged layer takes (its anchors).
  bool gridDrop_ = false;
  Guid gridDropCol_ = kNoGuid, gridDropRow_ = kNoGuid;
  std::vector<Rect> bands_;  // auto-layout padding / gap bands under the pointer (world)
  std::vector<Overlay::LayoutBar> layoutBars_;  // the selected auto-layout frame's padding and gap bars
  int layoutBarHover_ = -1;                     // the bar (handle) under the pointer (round 15: the bar itself)
  Guid layoutBarsFrame_ = kNoGuid;              // the frame they are the bars of
  int layoutBar_ = -1;                          // dragging: a side (0..3) or 4 + a gap
  StackFacet layoutBarFrom_;                    // the frame's auto layout when the drag started
  double layoutBarGapFrom_ = 0;                 // the dragged gap as laid out then (an Auto gap's number)
  // Round 15 (tools/SpacingHandles.cpp): the padding or gap under the pointer (hatched; a side 0..3 or 4 + a gap, −1),
  // its area and the dragged one's (world corners); a ⌥-press on a padding (not its bar): the band whose value a click
  // edits — the pair (⌥) or all four (⌥⇧).
  int layoutBandHover_ = -1;
  std::vector<Overlay::SpacingArea> spacingAreas_;
  // Round 16: what the panel's padding / gap field under the pointer edits (SPACING_* bits), hatched as a hover would.
  uint32_t panelSpacing_ = 0;
  void panelSpacingAreas(std::vector<Overlay::SpacingArea>& out) const;
  int altBand_ = -1;
  uint32_t altBandMods_ = 0;
  // The `</>` button under the pointer and since when (the tick's clock; −1: not yet ticked) — its tooltip after the
  // tooltip delay (500 ms, ds timing.tooltip).
  Guid devIconHover_ = kNoGuid;
  double devIconSince_ = -1;
  bool devTooltip_ = false;
  // Pressed (its status menu opens): no tooltip again until the pointer leaves the button (the chrome's tooltips never
  // show under an open menu, ds TooltipManager).
  bool devIconPressed_ = false;
  static constexpr double kTooltipDelayMs = 500;
  // Round 12: a selected grid's gap under the pointer or being dragged; the drag's gap when it started.
  GridGapHover gridGap_;
  double gridGapFrom_ = 0;

  // Text.
  struct CachedText {
    std::unique_ptr<text::TextLayout> layout;
    double width = 0, height = 0;
    uint32_t generation = 0;
  };
  std::unordered_map<Guid, CachedText, GuidHash> textCache_;
  CachedText& cachedText(Guid id);
  // `layout`, made with `o` at font generation `generation`, as `id`'s cached layout (textLayout, measureText).
  void keepTextLayout(Guid id, CachedText& c, std::unique_ptr<text::TextLayout> layout, const text::LayoutOptions& o, uint32_t generation);
  struct MeasuredText {
    double width = 0;
    uint32_t generation = 0;
    Vec2 size;
    bool ok = false, pending = false;
  };
  std::unordered_map<Guid, std::vector<MeasuredText>, GuidHash> measured_;  // measureText's results
  std::unordered_set<Guid, GuidHash> unmeasured_;  // auto-resized texts measured while their font loaded
  // Texts whose text fields an edit changed (their own, a main's reaching an instance's sublayer, an override, a
  // property): with a missing font they are measured with the fallback they draw with (Figma), where an untouched
  // one keeps the size it was stored with.
  std::unordered_set<Guid, GuidHash> fallbackMeasured_;
  unsigned long setNumber_ = 0;  // the last "Component N" a new component set took (combineAsVariants)
  TextSession text_;
  VectorSession vector_;
  PaintSession paint_;
  double timeMs_ = 0;
  int clickCount_ = 1;

  // Instances.
  std::unordered_set<Guid, GuidHash> instanceDirty_;
  std::unordered_set<Guid, GuidHash> instanceRefit_;
  uint64_t materializations_ = 0;
  std::unordered_map<Guid, std::vector<Guid>, GuidHash> sourceDeps_;       // a real node → instances derived from it
  std::unordered_map<Guid, std::vector<Guid>, GuidHash> instanceSources_;  // an instance → what it read
  std::unordered_map<Guid, std::vector<Guid>, GuidHash> derivedRows_;      // an instance → its derived rows
  std::unordered_map<Guid, DerivedInfo, GuidHash> derivedInfo_;
  std::unordered_map<Guid, Blueprint, GuidHash> blueprint_;
  bool deriving_ = false;
  Guid materializing_ = kNoGuid;
  std::vector<PendingLayout>* deferredLayout_ = nullptr;  // flushInstances' batch: stage B waits for all of it
  std::unordered_set<Guid, GuidHash> layingOut_;          // instances in stage B (their writes don't dirty them)
  bool intrinsicLayout_ = false;  // stage A of an instance's layout: no constraints
  Guid navMain_ = kNoGuid;
  std::vector<Guid> returnTo_;
  std::unordered_map<Guid, Guid, GuidHash> detachMap_;  // the last detach: derived id → the real node made for it
  bool pasteAsInstances_ = true;

  // Variables and styles.
  using GuidSet = std::unordered_set<Guid, GuidHash>;
  GuidSet bindingsDirty_;                                     // nodes to resolve again
  std::unordered_map<Guid, BindingDeps, GuidHash> deps_;      // a consumer → what its resolution read
  std::unordered_map<Guid, GuidSet, GuidHash> varConsumers_;  // a variable → consumers (real nodes and derived rows)
  std::unordered_map<Guid, GuidSet, GuidHash> setConsumers_;  // a collection → consumers
  std::unordered_map<Guid, GuidSet, GuidHash> styleConsumers_;  // a style → consumers
  GuidSet styleIds_;                                          // style nodes seen (their removal is an event)
  GuidSet collectionIds_;                                     // collections seen (likewise)
  std::unordered_map<Guid, Guid, GuidHash> variableSets_;     // variables seen → their collection
  GuidSet instanceBindings_;                                  // instances with bound sublayers
  GuidSet instanceVarDeps_;  // instances whose expansion read variables (bound variants, bound property values)
  // Extended collections' overrides: extension → variable → its VARIABLE_OVERRIDE, and the reverse.
  std::unordered_map<Guid, std::unordered_map<Guid, Guid, GuidHash>, GuidHash> overridesBySet_;
  std::unordered_map<Guid, std::pair<Guid, Guid>, GuidHash> overrideIndex_;
  void indexOverride(Guid node);
  GuidSet extensionSyncDirty_;  // collections whose modes changed (their extended collections follow)
  // Slot content as Figma's files keep it (a FRAME with isSlotContent under the Internal Only Canvas, named by its
  // instance's SLOT assignment): its variables resolve where the slot shows it — the instance's slot row and up.
  std::unordered_map<Guid, Guid, GuidHash> slotHosts_;                    // content frame → its slot row
  std::unordered_map<Guid, std::vector<Guid>, GuidHash> slotContentsOf_;  // instance → the content frames it hosts
  // The content frame a node is inside (Figma's form) when its slot row isn't derived yet (kNoGuid: hosted, or not
  // slot content): its bound values stay as stored until it is.
  Guid unhostedSlotContent(Guid id, const NodeProps& p) const;
  // The fields resolveBindings writes for `p` (its styles' and its variables' targets).
  static FieldMask boundFieldMask(const NodeProps& p);
  mutable std::unordered_map<std::string, Guid> assetKeys_;   // key → asset (imported library references)
  mutable bool assetKeysDirty_ = true;
  bool resolving_ = false;                                    // the resolver's own writes
  std::vector<Guid> created_;
  uint64_t keyState_ = 0;

  // Libraries.
  std::string fileKey_;
  bool hasLibraryCopies_ = false;  // any node carries sourceLibraryKey (read-only checks only then)
  bool libraryWrite_ = false;      // the library code's own writes into copies (and APPLY_EXACT)
  size_t unresolved_ = 0;          // references the last import / cross-file paste left pointing at nothing
  bool applyGuard_ = false;        // applyChanges(APPLY_SYSTEM): copies are read-only for it too

  // Indexes (indexChange): what the hot reads looked the whole document up for.
  std::unordered_map<std::string, std::vector<Guid>> keyIndex_;   // an asset key → the real nodes carrying it
  std::unordered_map<Guid, std::string, GuidHash> keyOf_;        // the reverse: what keyIndex_ holds for a node
  std::unordered_map<Guid, uint32_t, GuidHash> instanceCounts_;  // a main (symbolID) → real instances showing it
  std::unordered_map<Guid, Guid, GuidHash> instanceMain_;        // a real instance → the symbolID it is counted under
  Guid docNode_ = kNoGuid;                                       // the DOCUMENT node
  // Bound nodes of pages not derived yet: resolved when the page is first shown (derivePage), not at load.
  std::unordered_map<Guid, std::vector<Guid>, GuidHash> pageBindings_;
  // The Internal Only Canvas is never derived as a page (it holds dependencies: styles, variables, mains, slot
  // content): what is read there derives the instances under that node's top-level container only (deriveInternal).
  GuidSet derivedInternal_;
  GuidSet derivedTrees_;  // a partial engine's screens derived (deriveTree)
  // A presentation page's bound nodes by their screen, resolved when it is derived (deriveTree), not at load.
  std::unordered_map<Guid, std::vector<Guid>, GuidHash> screenBindings_;
  bool inDerivedTree(Guid id) const;
  Guid internalRootOf(Guid id) const;  // the child of the Internal Only Canvas holding `id` (kNoGuid: not there)
  // An instance not derived yet whose page (or internal container) isn't either: it waits for it.
  bool instanceWaits(Guid r) const;
  // componentInfo's answers, each good for one document version (a panel asks five times per render).
  struct CachedInfo {
    uint64_t version = 0;
    bool ok = false;
    ComponentInfo info;
  };
  mutable std::unordered_map<Guid, CachedInfo, GuidHash> infoCache_;
  // Round 17 B: the last refusal's message key (engine_command's "error"), and variants renamed in the open step.
  std::string lastRefusal_;
  std::vector<Guid> renamedVariants_;
  // Pages whose instances are materialized and auto layout verified (derivePage); others wait for their first show.
  std::unordered_set<Guid, GuidHash> derivedPages_;
  // Derived data loaded from the snapshot (this engine's stamp), until used or made stale.
  std::unordered_map<Guid, std::shared_ptr<const text::StoredText>, GuidHash> storedText_;  // real texts and sublayers
  std::unordered_map<Guid, std::vector<StoredRow>, GuidHash> storedSymbols_;             // instances not derived yet
  struct StoredLayout {
    std::unique_ptr<text::TextLayout> layout;
    double width = 0, height = 0;
  };
  std::unordered_map<Guid, StoredLayout, GuidHash> storedLayouts_;  // drawn from storedText_ (fonts pending / missing)
  bool trustLayout_ = false;     // the snapshot's geometry is this engine's own: pages derive without re-verifying it
  bool applyingStored_ = false;  // writes of stored geometry (not edits)
  bool storedSparse_ = false;    // storedSymbols_ came from Figma (StoredDerived::sparse)
  uint32_t derivedUsed_ = 0, derivedStale_ = 0;

  // The press (Gestures.cpp pointerDown): inside a selected layer — the selection stays, a drag moves it, a click
  // selects the pressed layer; a press-drag with nothing movable (instance sublayers, locked layers) is a no-op.
  bool pressInSelected_ = false;
  bool pressNoop_ = false;
  // A press on empty space inside the selection's box: a drag moves the selection (live Figma MS).
  bool pressMovesSelection_ = false;
  // ⇧ on a layer inside a selected one: the click leaves the selection as it is (live Figma K3).
  bool pressShiftKeeps_ = false;

  // Round 8 (tools/CanvasTools.cpp).
  double nudgeSmall_ = 1, nudgeBig_ = 10;
  int reorderHover_ = -1;          // the smart selection's centre ring under the pointer
  SmartSelection reorderFrom_;     // dragging a centre ring: the selection as it started
  int reorderIndex_ = -1;          // the dragged layer's index in reorderFrom_.order
  std::vector<Guid> reorderOrder_;  // the order now
  bool rotationOriginOn_ = false;   // ⌥R
  bool rotationOriginSet_ = false;  // dragged away from the centre
  Vec2 rotationOrigin_;
  std::vector<Guid> rotationOriginFor_;  // the selection it belongs to
  RulerGuide selectedGuide_;       // a clicked guide (owner kNoGuid: none)
  RulerGuide hoverGuide_;          // the guide under the pointer
  RulerGuide guideDrag_;           // the guide being dragged, as it is now
  RulerGuide guideFrom_;           // …as it was (owner kNoGuid: a new one)
  bool guideNew_ = false;
  double guideRuler_ = 20;         // the rulers' thickness (CSS px): a guide let go over one goes
  bool guideMoved_ = false;
  bool scaling_ = false;           // the Scale tool's handles
  std::unordered_map<Guid, NodeProps, GuidHash> scaleFrom_;  // the scaled layers and their descendants at the press
  Vec2 lastDrawWorld_;             // drawing: where the pointer was (Space held moves the shape)
  Vec2 rotateCentre_;              // rotating: about this (world)
  std::unordered_set<Guid, GuidHash> slices_;  // the document's slices (View › Show slices)
  bool layoutBarMoved_ = false;    // an auto-layout bar pressed: dragged (else a click edits its value)
  // Overlay labels measured for hit-testing (labelWidth), by style and text; dropped when the fonts change.
  mutable std::unordered_map<std::string, double> labelWidths_;
  mutable uint64_t labelWidthsGeneration_ = ~0ull;

  // ---- Actors (actorBegin) ----
  UndoStack& stackOf(uint32_t actor);
  // Open ignore-undo scopes (openIgnoreUndo)
  int ignoreUndo_ = 0;
  UndoStack& recording() { return stackOf(undoTo_); }
  const UndoStack& recording() const {
    auto it = actorUndo_.find(undoTo_);
    return it == actorUndo_.end() ? undo_ : it->second;
  }
  // A step of `undoTo_` committed: every other history yields the fields it wrote.
  void yieldOthers();
  // Another session's change committed (APPLY_PEER): every history yields the fields it wrote, the user's too.
  void yieldAll();
  // After another actor's write or undo: the user's text / vector / gradient edit follows what changed under it.
  void followForeign(const std::vector<Guid>& touched);
  uint32_t actor_ = 0;   // who is writing (DOCUMENT_CHANGED.actor)
  uint32_t undoTo_ = 0;  // whose history the open step goes to
  std::map<uint32_t, UndoStack> actorUndo_;
  static constexpr size_t kMaxActors = 256;
  struct ActorScope {
    bool on = false;
    bool merge = false;
    // The user's view state, set aside while the actor writes.
    std::vector<Guid> selection;
    Guid page = kNoGuid;
    std::map<Guid, std::vector<Guid>> pageSelections;
    Camera camera;
    CameraAnimation camAnim;
    TextSession text;
    VectorSession vector;
    PaintSession paint;
    Guid protoNode = kNoGuid;
    int protoIndex = -1;
    RulerGuide guide;
    GridTrackSelection gridSel;
    std::vector<Guid> lastNudged;
    Guid zoomFrame = kNoGuid;
    std::vector<Guid> zoomSelection;
    bool rotationOriginOn = false;
    // View events pending when it began (held back: the actor's own are not the user's).
    bool evSelection = false, evCurrentPage = false, evCamera = false, evTextEdit = false, evVectorEdit = false, evPaintEdit = false;
  } scope_;
};

}  // namespace eng
