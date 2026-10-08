// The editor: the document, transactions and undo, layout, the selection, the
// tools and gestures that turn pointer/keyboard input into changes, the
// camera, and the event queue. It knows nothing about the GPU or JavaScript;
// api/Api.cpp feeds it input and drains its events (docs/engine.md §8–§10).
//
// Interim: the tool controller lives in this class (gesture code in
// tools/Gestures.cpp, commands in editor/Commands.cpp) rather than in
// tools/ToolController.
#pragma once

#include <functional>
#include <map>
#include <memory>
#include <string>
#include <string_view>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include "base/Json.h"
#include "editor/Annotations.h"
#include "editor/Commands.h"
#include "editor/Keys.h"
#include "editor/Selection.h"
#include "editor/Snapping.h"
#include "editor/Undo.h"
#include "geometry/VectorNetwork.h"
#include "layout/Layout.h"
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
  Count
};
// ANNOTATION and MEASUREMENT: Dev Mode's tools (⇧T, ⇧M), editor/DevMode.cpp.
const char* toolName(Tool t);
bool toolImplemented(Tool t);

// Modifier bits as TS sends them. PRIMARY is the platform's command key (⌘ on
// a Mac, Ctrl elsewhere).
enum Modifier : uint32_t { MOD_SHIFT = 1, MOD_ALT = 2, MOD_CTRL = 4, MOD_META = 8, MOD_PRIMARY = 16 };

enum class PointerEvent : uint8_t { DOWN = 0, MOVE = 1, UP = 2, CANCEL = 3, ENTER = 4, LEAVE = 5 };
enum PointerResult : uint32_t { P_HANDLED = 1, P_CAPTURE = 2 };
enum class KeyEvent : uint8_t { DOWN = 0, UP = 1 };
enum KeyResult : uint32_t { K_HANDLED = 1 };
enum WheelFlags : uint32_t { WHEEL_PINCH = 1 };
enum class DeltaMode : uint8_t { PIXEL = 0, LINE = 1, PAGE = 2 };

// APPLY_SYSTEM: journaled and emitted, not an undo step (library bookkeeping); APPLY_EXACT (with APPLY_USER: Restore
// version): the changes are a whole document state computed elsewhere — written as they are, library copies included,
// none of the user-edit rules (no read-only refusal, no detaching, no instance root overrides).
enum ApplyFlags : uint32_t { APPLY_USER = 1, APPLY_REMOTE = 2, APPLY_LOAD = 4, APPLY_SYSTEM = 8, APPLY_EXACT = 16 };
enum SetPropsFlags : uint32_t { NO_UNDO_MERGE = 1 };
enum PasteFlags : uint32_t { PASTE_IN_PLACE = 1 };

// docs/engine.md §9.2.
enum class TxnKind : uint8_t { USER, GESTURE, UNDO, REDO, SYSTEM, REMOTE, LOAD };
const char* txnKindName(TxnKind k);

// docs/engine.md §10.4 CursorKind.
enum class CursorKind : uint8_t {
  DEFAULT, HAND, GRABBING, CROSSHAIR, PEN, PEN_ADD, PEN_REMOVE, PEN_CLOSE, IBEAM,
  RESIZE, ROTATE, MOVE_DUPLICATE, ZOOM_IN, ZOOM_OUT, EYEDROPPER, NOT_ALLOWED
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
struct ComponentInfo {
  enum class Kind : uint8_t { NONE, COMPONENT, VARIANT, COMPONENT_SET, INSTANCE, NESTED_INSTANCE, INSTANCE_SUBLAYER, COMPONENT_SUBLAYER };
  Kind kind = Kind::NONE;
  Guid ref = kNoGuid;
  Guid main = kNoGuid, mainPage = kNoGuid, mainSet = kNoGuid;
  std::string mainName;
  bool mainSoftDeleted = false;
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
  uint32_t instanceCount = 0;
};

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
  static constexpr uint32_t kDerivedDataVersion = 3;
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
  // (E_BUSY inside an open user step); APPLY_REMOTE / APPLY_LOAD: neither. User and system changes never write into
  // library copies, unless APPLY_EXACT (a store-computed state: Restore version).
  Status applyChanges(const std::vector<NodeChange>& changes, uint32_t flags);
  // Every node, parents before children (a full snapshot).
  std::vector<NodeChange> encodeDocument() const;
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
  bool pageDerived(Guid page) const { return derivedPages_.count(page) != 0; }
  const Document& document() const override { return doc_; }
  Guid page() const { return page_; }

  // ---- View ----
  void setViewport(double cssWidth, double cssHeight, double dpr, int pixelWidth, int pixelHeight);
  const Viewport& viewport() const { return viewport_; }
  const Camera& camera() const { return camera_; }
  void setCamera(const Camera& c);
  void setTheme(Theme t);
  Theme theme() const { return theme_; }

  // ---- Input (CSS px relative to the canvas) ----
  uint32_t pointer(PointerEvent type, double x, double y, int button, uint32_t buttons, uint32_t mods, int clickCount = 1);
  uint32_t wheel(double x, double y, double dx, double dy, DeltaMode mode, uint32_t mods, uint32_t flags);
  uint32_t key(KeyEvent type, KeyCode code, uint32_t codepoint, uint32_t mods, bool repeat);
  void modifiers(uint32_t mods);
  void blur();

  // ---- Tools, hover, frames ----
  Status setTool(Tool t);
  Tool tool() const { return tool_; }
  void setHover(const std::vector<Guid>& ids);  // Layers row hover → canvas outline
  bool tick(double timeMs);                     // true: draw a frame
  bool needsFrame() const { return needsRender_; }
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
  Status txnCommit();
  void txnCancel();
  Status command(CommandId id, double dx = 0, double dy = 0);
  Status command(CommandId id, const CommandArgs& args);
  uint32_t commandState(CommandId id) const;
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
  bool canUndo() const { return undo_.canUndo(); }
  bool canRedo() const { return undo_.canRedo(); }
  const UndoStack& undoStack() const { return undo_; }

  // ---- Events ----
  struct DocumentChanged {
    TxnKind kind;
    std::string label;
    std::vector<NodeChange> changes;
  };
  // CONTEXT_MENU: a right-click (or ⌃-click on a Mac), after the selection settled.
  struct ContextMenu {
    bool selection = false;  // targetKind SELECTION (else CANVAS)
    double x = 0, y = 0;     // CSS px in the canvas
    std::vector<std::vector<Guid>> hits;  // each layer under the point, innermost first; topmost layer first
  };
  // The last connection made by a drag (PROTOTYPE_CONNECTED): its hotspots and the interaction's id.
  struct PrototypeConnected {
    std::vector<Guid> nodes;
    Guid interaction = kNoGuid;
  };
  // The grid tracks selected on the canvas (GRID_TRACKS); `edit`: a label was clicked (or Enter) — TS opens its
  // editor at `label` (screen, CSS px).
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
  struct Events {
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
    std::vector<GridTracksEvent> gridTracks;             // GRID_TRACKS: the grid tracks selected on the canvas
    std::vector<RenameRequest> renames;                  // REQUEST_RENAME: a double-click on a frame's title
    bool selection = false, camera = false, tool = false, cursor = false, hover = false, undo = false,
         structure = false, pages = false, currentPage = false, textEdit = false, vectorEdit = false, paintEdit = false,
         navigation = false;
    bool any() const {
      return !annotationOpens.empty() || !measurementEdits.empty() || !statusClicks.empty() || measurementSelection ||
             !documents.empty() || !contextMenus.empty() || !prototypeConnected.empty() || !gridTracks.empty() || !renames.empty() || !nodes.empty() || !components.empty() || !collections.empty() ||
             !variables.empty() || !styles.empty() || selection || camera || tool || cursor || hover || undo || structure || pages ||
             currentPage || textEdit || vectorEdit || paintEdit || navigation;
    }
  };
  bool hasEvents() const { return events_.any(); }
  Events takeEvents();

  // ---- Text (docs/engine.md §7.6) ----
  // The layout of a TEXT node as it is now (cached; nullptr for other nodes).
  const text::TextLayout* textLayout(Guid id) override;
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
  enum class VectorTool : uint8_t { MOVE, PEN, BEND, LASSO, PAINT_BUCKET };
  // Edits `id`'s vector network (VECTOR, LINE, and shapes: they become VECTORs at their first edit).
  Status startVectorEdit(Guid id);
  void endVectorEdit();
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

  // ---- Prototype mode (editor/PrototypeEditing.cpp; the right panel's Prototype tab) ----
  // The canvas shows connections, the "+" connection handle on selected layers and flow labels; dragging a handle to a
  // frame adds an On click → Navigate to interaction (Figma's defaults), dragging a noodle's end retargets or removes it.
  void setPrototypeMode(bool on);
  bool prototypeMode() const { return proto_.on; }
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
  // View › Annotations (labels, dots and saved measurements); `dots`: Dev Mode's dots (a click opens one's label).
  void setAnnotationView(bool show, bool dots);
  bool annotationsShown() const { return dev_.show; }
  // Every user edit stamps editInfo {lastEditedAt, createdAt} (unix seconds) on the edited nodes and their ancestors,
  // as Figma's files do — a design marked ready whose lastEditedAt is later than its status shows "Changed". Edits of
  // annotations, measurements and statuses don't count.
  void setEditTracking(bool on) { editTracking_ = on; }
  bool editTracking() const { return editTracking_; }
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
  // The page's saved measurements; the selected one.
  std::vector<annot::Measurement> measurements(Guid page = kNoGuid) const;
  Guid selectedMeasurement() const { return dev_.selectedMeasurement; }
  Status selectMeasurement(Guid id);
  // Where a measurement is drawn (world): its line and the extension lines from the layers to it.
  bool measurementLine(const annot::Measurement& m, Vec2& a, Vec2& b, std::vector<GuideLine>* extensions = nullptr) const;

  // ---- Components and instances (editor/Instances.cpp, editor/ComponentCommands.cpp) ----
  bool componentInfo(Guid id, ComponentInfo& out) const;  // cached per document version
  bool computeComponentInfo(Guid id, ComponentInfo& out) const;
  // GO_TO_MAIN_COMPONENT / RETURN_TO_INSTANCE: where the last navigation went and where it came from.
  Guid navigationMain() const { return navMain_; }
  Guid returnToInstance() const { return returnTo_; }
  // A derived node (an instance's sublayer).
  bool isDerived(Guid id) const { return id.isDerived(); }
  // The real instance a derived node belongs to (kNoGuid for real nodes).
  Guid instanceOfDerived(Guid id) const;
  // Whether `id` can take new layers: a frame that isn't an instance and isn't inside one.
  bool acceptsChildren(Guid id) const;
  // The real main component (SYMBOL) an instance (real or derived) shows now; kNoGuid when it has none.
  Guid mainOf(Guid instance) const;

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
  // (editor/FontCommands.cpp).
  struct DocumentFont {
    FontName font;
    uint32_t uses = 0;
  };
  std::vector<DocumentFont> documentFonts() const;
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
  std::vector<AssetInfo> localAssets() const;
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
                                 Measure, MeasureDrag };

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
  Camera snapped(Camera c) const;
  void zoomToFit();
  void zoomToSelection();
  void zoomTo(double zoom);

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
  Status resetOverrides(const std::vector<Guid>& ids, const std::vector<std::string>& fields);
  Status insertInstance(Guid main, const CommandArgs& args);
  Status setVariantProperties(Guid variant, const CommandArgs& args);
  Status pushChangesToMain(Guid instance);
  Status goToMainComponent(Guid ref);
  Status returnToInstanceCmd();
  Status swapInstance(const std::vector<Guid>& ids, Guid main);
  Status setComponentProperty(Guid ref, const std::string& prop, const json::Value& value);
  Status addComponentProperty(Guid ref, const CommandArgs& args);
  Status editComponentProperty(Guid ref, const CommandArgs& args);
  Status deleteComponentProperty(Guid ref, const std::string& prop);
  Status bindComponentProperty(const std::vector<Guid>& ids, const std::string& field, const std::string& prop);
  Status restoreComponent(Guid ref);
  Status setExposedInstance(Guid ref, bool exposed);
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
  // its children (and its padding from where they sit, when `padFromContent`).
  void inferAutoLayout(Guid frame, bool padFromContent);
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
  std::vector<Guid> navigableFrames() const;
  // A new section as Figma makes one in the current UI theme (live 2026-10-08: dark — #444444, a white 10 % inside
  // stroke; light — white, a black 10 % stroke; radius 2, not clipping).
  NodeProps sectionProps() const;
  void ungroup();
  void duplicate();
  void flip(bool horizontal);
  void align(CommandId how);
  void distribute(bool horizontal);
  void addAutoLayout();
  void removeAutoLayout();
  Guid createPage();
  Status deletePage(Guid page);
  Guid duplicatePage(Guid page);
  // E4 / E5 (editor/VectorCommands.cpp).
  Status booleanSelection(BooleanOperation op);
  Status flattenSelection();
  Status outlineStroke();
  Status useAsMask();
  Status placeImage(const CommandArgs& args);
  bool selectionIsMask() const;
  // The paths a node's fills cover, in the space `toSpace` maps its own space to (groups: their children's).
  void fillPathsOf(Guid id, const Mat2x3& toSpace, geom::Path& out, WindingRule& rule) const;

  // ---- Hover, handles, gestures (tools/Gestures.cpp) ----
  // LineEnd: a line's start (hx 0) or end (hx 1) handle.
  enum class Handle : uint8_t { None, Resize, Rotate, LineEnd };
  Handle handleAt(Vec2 screen, int& hx, int& hy) const;
  // A single selected line — a LINE, or a vector with no width or no height — and its ends (world): Figma gives it
  // two endpoint handles instead of a box.
  bool selectedLine(Guid& id, Vec2& a, Vec2& b) const;
  void startLineEnd(int end);
  void dragLineEnd(Vec2 world, uint32_t mods);
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
  // Opens the Move gesture for the selection's movable layers; false (nothing opened) when there are none.
  bool startMove(uint32_t mods);
  void setDuplicating(bool on);
  void dragMove(Vec2 world, uint32_t mods);
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
    enum class Drag : uint8_t { None, Vertices, Handle, Bend, PenNew, PenHandle, Marquee, Lasso } drag = Drag::None;
    bool dragged = false;
    geom::VectorNetwork startNet;  // when the drag started (node space then)
    Mat2x3 startWorld;             // the node's world transform then
    Mat2x3 startLocal;             // its transform then
    int handleVertex = -1, handleSegment = -1;
    bool handleAtStart = false;  // the handle is the segment's start tangent
    double bendT = 0.5;
    int newVertex = -1;
    std::vector<Vec2> lasso;  // world
    Rect marquee;             // world
    std::vector<uint32_t> baseSel;
    bool committedInDrag = false;
  };
  uint32_t vectorPointerDown(Vec2 s, uint32_t mods, int clickCount);
  void vectorPointerMove(Vec2 s, uint32_t mods);
  void vectorPointerUp(Vec2 s, uint32_t mods);
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
  };
  const Paint* editedPaint() const;
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
  };
  struct ProtoSession {
    bool on = false;
    enum class Drag : uint8_t { None, New, Retarget } drag = Drag::None;
    std::vector<Guid> sources;  // New: the hotspots (the selection)
    ProtoLink link;             // Retarget: the connection whose end moves
    Vec2 point;                 // world: where the dragged end is
    Guid target = kNoGuid;      // the frame it would connect to
    bool handleHovered = false;
    // The page's connections, cached per document version.
    uint64_t version = ~0ull;
    Guid page = kNoGuid;
    std::vector<ProtoLink> links;
  };
  ProtoSession proto_;
  bool viewer_ = false;

  // ---- Dev Mode (editor/DevMode.cpp) ----
  struct DevSession {
    bool show = true, dots = false;
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
  bool editTracking_ = false;
  std::function<double()> wallClock_;
  std::unordered_set<Guid, GuidHash> edited_;     // this transaction's edited nodes (editInfo)
  std::unordered_set<Guid, GuidHash> annotated_;  // nodes with annotations
  CanvasHits hits_;
  void devOverlay(Overlay& o) const;
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
  void noteAnnotated(const NodeChange& c);
  // The edge the measurement tool snaps to under `s` (`axis`: 0 any, 1 left / right, 2 top / bottom).
  bool edgeAt(Vec2 s, int axis, Guid& node, annot::Side& side) const;
  Status measurementCommand(CommandId id, const CommandArgs& args);
  // Focus view: a hit path outside the focused design is no hit.
  void focusFilter(std::vector<Guid>& path) const;
  const std::vector<ProtoLink>& protoLinks();
  // The hotspots that show a "+" handle (the selection, top-level layers and layers inside frames) and where it is.
  std::vector<Guid> protoHandleNodes() const;
  bool protoHandleAt(Vec2 s, std::vector<Guid>* nodes = nullptr) const;
  bool protoEndAt(Vec2 s, ProtoLink& out);
  // Where a noodle lands: a video layer (`videos`: help "Use videos in prototypes" — "Create a connection from your
  // starting object to the video"), else a top-level frame.
  Guid protoTargetAt(Vec2 world, const std::vector<Guid>& sources, bool videos = false, bool frames = true) const;
  uint32_t protoPointerDown(Vec2 s, uint32_t mods);
  void protoPointerMove(Vec2 s);
  void protoPointerUp(Vec2 s);
  void protoHover(Vec2 s);
  void protoOverlay(Overlay& o) const;
  // ---- Grid auto layout on the canvas (tools/GridGestures.cpp) ----
  // A selected grid's tracks along its edges, the hovered / selected ones labelled with their grabber, the drop line.
  void gridTrackOverlay(Overlay& o) const;
  void gridSpanOverlay(Overlay& o) const;
  struct GridHit {
    enum class Kind : uint8_t { None, Track, Edge, Grabber } kind = Kind::None;
    bool column = true;
    size_t track = 0;
  };
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
  void setGridTrackSelection(Guid frame, bool column, std::vector<size_t> tracks, bool edit);
  void clearGridTrackSelection();
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

  Document doc_;
  UndoStack undo_;
  Guid page_ = kNoGuid;
  std::map<Guid, std::vector<Guid>> pageSelections_;
  uint32_t sessionID_ = 1;
  uint32_t nextLocalID_ = 1;
  std::vector<Guid> selection_;
  Camera camera_;
  bool zooming_ = false;  // the camera's zoom last changed by the wheel or a pinch (Overlay::zooming)
  Viewport viewport_{800, 600, 1, 0, 0};
  Theme theme_ = Theme::Dark;
  Tool tool_ = Tool::MOVE;
  CursorKind cursor_ = CursorKind::DEFAULT;
  double cursorAngle_ = 0;
  Guid hover_ = kNoGuid;
  std::vector<Guid> layersHover_;
  bool spaceHeld_ = false;
  bool needsRender_ = true;
  uint32_t mods_ = 0;
  Events events_;
  std::unordered_map<Guid, size_t, GuidHash> nodeEventIndex_;

  // The open transaction.
  struct Txn {
    bool open = false;
    int depth = 0;
    TxnKind kind = TxnKind::USER;
    std::string label;
    ChangeSet changes;
  } txn_;
  std::vector<Guid> lastNudged_;
  // ⌘D: each copy the last duplicate made → its original (the next ⌘D repeats the offset the copy was moved by).
  std::unordered_map<Guid, Guid, GuidHash> duplicatedFrom_;
  // N / ⇧N: the frame the view last went to, and the selection then.
  Guid zoomFrame_ = kNoGuid;
  std::vector<Guid> zoomSelection_;

  // Layout.
  std::unordered_set<Guid, GuidHash> layoutDirty_;
  std::unordered_set<Guid, GuidHash> groupsTouched_;
  std::unordered_set<Guid, GuidHash> excluded_;  // dragged into an auto-layout flow: no space there yet
  std::unordered_set<Guid, GuidHash> pinned_;    // dragged inside its own flow: keeps its slot, not moved by layout
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
  int handleX_ = 0, handleY_ = 0;
  int lineEnd_ = -1;             // dragging a line's start (0) or end (1) handle; -1: a box resize
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

  // Text.
  struct CachedText {
    std::unique_ptr<text::TextLayout> layout;
    double width = 0, height = 0;
    uint32_t generation = 0;
  };
  std::unordered_map<Guid, CachedText, GuidHash> textCache_;
  struct MeasuredText {
    double width = 0;
    uint32_t generation = 0;
    Vec2 size;
    bool ok = false, pending = false;
  };
  std::unordered_map<Guid, std::vector<MeasuredText>, GuidHash> measured_;  // measureText's results
  std::unordered_set<Guid, GuidHash> unmeasured_;  // auto-resized texts measured while their font loaded
  TextSession text_;
  VectorSession vector_;
  PaintSession paint_;
  double timeMs_ = 0;
  int clickCount_ = 1;

  // Instances.
  std::unordered_set<Guid, GuidHash> instanceDirty_;
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
  Guid navMain_ = kNoGuid, returnTo_ = kNoGuid;
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
  // Overlay labels measured for hit-testing (labelWidth), by style and text; dropped when the fonts change.
  mutable std::unordered_map<std::string, double> labelWidths_;
  mutable uint64_t labelWidthsGeneration_ = ~0ull;
};

}  // namespace eng
