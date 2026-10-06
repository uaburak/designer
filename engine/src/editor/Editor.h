// The editor: the document, transactions and undo, layout, the selection, the
// tools and gestures that turn pointer/keyboard input into changes, the
// camera, and the event queue. It knows nothing about the GPU or JavaScript;
// api/Api.cpp feeds it input and drains its events (docs/engine.md §8–§10).
//
// Interim: the tool controller lives in this class (gesture code in
// tools/Gestures.cpp, commands in editor/Commands.cpp) rather than in
// tools/ToolController.
#pragma once

#include <map>
#include <string>
#include <string_view>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include "editor/Commands.h"
#include "editor/Keys.h"
#include "editor/Selection.h"
#include "editor/Snapping.h"
#include "editor/Undo.h"
#include "layout/Layout.h"
#include "render/Camera.h"
#include "render/Renderer.h"
#include "scene/ChangeSet.h"
#include "scene/Document.h"

namespace eng {

// docs/engine.md §8.4's Tool enum (the wire values). Implemented: MOVE, HAND,
// FRAME, RECTANGLE, ELLIPSE; setTool refuses the others.
enum class Tool : uint8_t {
  MOVE, SCALE, HAND, FRAME, SECTION, SLICE, RECTANGLE, LINE, ARROW, ELLIPSE,
  POLYGON, STAR, IMAGE, PEN, PENCIL, TEXT, COMMENT, Count
};
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

enum ApplyFlags : uint32_t { APPLY_USER = 1, APPLY_REMOTE = 2, APPLY_LOAD = 4 };
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
};

// What a copy puts on the clipboard (docs/schema.md §4.1): the copied nodes as
// CREATED with their source GUIDs, parents first; for each source parent, its
// origin on the page (Figma's clipboardSelectionRegions.enclosingFrameOffset).
struct Clipboard {
  std::vector<NodeChange> nodes;
  struct Region {
    Guid parent;
    std::vector<Guid> nodes;
    Vec2 offset;
  };
  std::vector<Region> regions;
  Guid page = kNoGuid;
};

class Editor : private LayoutHost {
 public:
  Editor();

  // ---- Document ----
  // Replaces the document with `nodes` (any order) and shows `page` (the first
  // CANVAS when kNoGuid). Resets undo and the selection. Emits nothing to storage.
  void loadDocument(const std::vector<NodeChange>& nodes, Guid page);
  void setSessionID(uint32_t sessionID);
  uint32_t sessionID() const { return sessionID_; }
  // Changes from outside. APPLY_USER: undoable and emitted (one step);
  // APPLY_REMOTE / APPLY_LOAD: neither.
  Status applyChanges(const std::vector<NodeChange>& changes, uint32_t flags);
  // Every node, parents before children (a full snapshot).
  std::vector<NodeChange> encodeDocument() const;
  Status setCurrentPage(Guid page);
  std::vector<Guid> pages() const;
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
  void rendered() { needsRender_ = false; }
  Overlay overlay() const;
  CursorKind cursor() const { return cursor_; }
  double cursorAngle() const { return cursorAngle_; }
  Guid hover() const { return hover_; }

  // ---- Selection, writes, commands (panels, menus, the Layers panel) ----
  const std::vector<Guid>& selection() const { return selection_; }
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
  bool copySelection(Clipboard& out) const;
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
  struct Events {
    std::vector<DocumentChanged> documents;        // DOCUMENT_CHANGED, one per committed transaction
    std::vector<ContextMenu> contextMenus;
    std::vector<std::pair<Guid, uint32_t>> nodes;  // NODES_CHANGED: node, field groups (merged)
    bool selection = false, camera = false, tool = false, cursor = false, hover = false, undo = false,
         structure = false, pages = false, currentPage = false;
    bool any() const {
      return !documents.empty() || !contextMenus.empty() || !nodes.empty() || selection || camera || tool || cursor || hover || undo ||
             structure || pages || currentPage;
    }
  };
  bool hasEvents() const { return events_.any(); }
  Events takeEvents();

  // Whether a gesture is in progress (undo and txn calls are refused meanwhile).
  bool busy() const { return gesture_ != Gesture::None && gesture_ != Gesture::Press; }

 private:
  enum class Gesture : uint8_t { None, Pan, Press, Move, Resize, Rotate, Draw, Marquee };

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

  // ---- Hover, handles, gestures (tools/Gestures.cpp) ----
  enum class Handle : uint8_t { None, Resize, Rotate };
  Handle handleAt(Vec2 screen, int& hx, int& hy) const;
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
  Guid dropTargetAt(Vec2 world) const;
  // The frame or page a parent's layers belong to (through groups).
  Guid containerOf(Guid parent) const;
  void keepResizedSize(Guid id, bool x, bool y);
  void endGesture();
  void startMove(uint32_t mods);
  void setDuplicating(bool on);
  void dragMove(Vec2 world, uint32_t mods);
  void finishMove();
  void updateInsertion(Guid frame, Vec2 world);
  void startResize(int hx, int hy);
  void dragResize(Vec2 world, uint32_t mods);
  void startRotate();
  void dragRotate(Vec2 world, uint32_t mods);
  void dragDraw(Vec2 world, uint32_t mods, bool click);
  void dragMarquee(Vec2 world, uint32_t mods);
  void finishClick(uint32_t mods);

  Document doc_;
  UndoStack undo_;
  Guid page_ = kNoGuid;
  std::map<Guid, std::vector<Guid>> pageSelections_;
  uint32_t sessionID_ = 1;
  uint32_t nextLocalID_ = 1;
  std::vector<Guid> selection_;
  Camera camera_;
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
  NodeType drawType_ = NodeType::NONE;
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
  std::vector<Rect> bands_;  // auto-layout padding / gap bands under the pointer (world)
};

}  // namespace eng
