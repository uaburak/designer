// The prototype player (Figma's presentation view, docs/research/figma/R8-prototyping.md §9–§10): the screen shown
// (a top-level frame), the overlays over it, the navigation history, scroll positions, the interactions' triggers
// (click, hover, press, drag, keys, mouse enter / leave / down / up, after delay) and their actions, transitions
// (Instant, Dissolve, Smart animate, Move in / out, Push, Slide in / out, with easing and springs), and the scene the
// renderer draws (render/PresentScene.h) — the same Wasm renderer as the canvas.
//
// It runs on an engine of its own (the presentation tab loads the file read-only): "Change to", "Set variable" and
// "Set variable mode" write the document with APPLY_REMOTE (never journaled; Restart puts the original values back).
#pragma once

#include <deque>
#include <functional>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include "editor/Editor.h"
#include "proto/Prototype.h"
#include "render/PresentScene.h"

namespace eng::proto {

// Figma's scale options (without a device: Actual size (100%), Fit width, Fit width and height, Fill screen; with a
// device: Show device at 100%, —, Fit device on screen, Zoom device to fill screen). Z cycles them.
enum class ScaleMode : uint8_t { ACTUAL = 0, FIT_WIDTH = 1, FIT = 2, FILL = 3 };
const char* scaleName(ScaleMode m);

class Player {
 public:
  explicit Player(Editor& editor);

  // Starts presenting `page` at `start` (a top-level frame, or a layer in one); kNoGuid: the first flow's start, else
  // the first frame. False when the page has no frame to show.
  bool start(Guid page, Guid start);
  void stop();
  bool active() const { return base_ != kNoGuid; }

  // Input, CSS px in the canvas (the editor's viewport). Return P_HANDLED-like bits (1: handled).
  uint32_t pointer(PointerEvent type, double x, double y, uint32_t buttons, uint32_t mods);
  uint32_t wheel(double x, double y, double dx, double dy);
  // A key (JS keyCode); `down` false for a release. Interactions first, then the presentation's shortcuts
  // (R restart, → / Space / N next frame, ← previous, Z scale).
  uint32_t key(bool down, int keyCode, uint32_t mods);

  void restart();
  bool next();
  bool previous();
  bool back();
  void setScale(ScaleMode m);
  ScaleMode scale() const { return scale_; }
  void cycleScale();
  void setHints(bool on) { hints_ = on; }
  bool hints() const { return hints_; }

  // Advances transitions, scroll animations and timers to `nowMs`; true when a frame should be drawn.
  bool tick(double nowMs);
  // ms until the next timer fires (0: animating, −1: nothing pending).
  int32_t nextFrameDelay() const;
  bool needsFrame() const { return dirty_ || animating(); }
  void rendered() { dirty_ = false; }

  // What to draw now.
  const PresentScene& scene();

  // State (engine_present_state).
  Guid page() const { return page_; }
  Guid screen() const { return base_; }
  Guid flow() const { return flow_; }
  const std::vector<Guid>& history() const { return history_.empty() ? emptyIds_ : historyIds_; }
  size_t historySize() const { return history_.size(); }
  struct Shown {
    Guid frame = kNoGuid;
    Vec2 pos;  // top-left in screen units (the device's screen, unscaled)
    OverlaySettings settings;
  };
  const std::vector<Shown>& overlays() const { return overlays_; }
  Vec2 scrollOf(Guid frame) const;
  bool animating() const;
  bool hotspotUnder() const { return hotspot_; }
  // The frames → and ← go through (the flow's connected frames, else every frame of the page).
  std::vector<Guid> sequence() const;
  // Screen geometry: the device screen's size (design units) and where it is on the canvas (CSS px).
  Vec2 screenSize() const { return view_.screen; }
  Rect screenRect() const { return view_.css; }
  std::string stateJson() const;

  struct Event {
    enum class Kind : uint8_t { CHANGED, OPEN_URL } kind = Kind::CHANGED;
    std::string url;
    bool newTab = true;
  };
  std::vector<Event> takeEvents() {
    std::vector<Event> out;
    out.swap(events_);
    return out;
  }

  // Smart animate (tests): the layers of `from` and `to` that match (by name and place in the hierarchy).
  static std::string matchKey(const Document& doc, Guid root, Guid id);
  std::vector<std::pair<Guid, Guid>> matches(Guid from, Guid to) const;
  // The props a layer is drawn with in the last scene (tests): nullptr when it is drawn as the document has it.
  const NodeProps* drawnProps(Guid id) const;

 private:
  struct SnapNode {
    Guid id = kNoGuid;
    Mat2x3 rel;  // relative to the snapshot's root (or the root's parent, for instances)
    Vec2 size;
    double opacity = 1;
    std::vector<Paint> fills, strokes;
    double strokeWeight = 0;
    CornerRadii radii{0, 0, 0, 0};
  };
  struct Snapshot {
    std::unordered_map<std::string, SnapNode> byKey;
  };
  struct Side {
    Guid frame = kNoGuid;
    Vec2 pos;
    Vec2 scroll;  // a top-level frame's own scroll
    OverlaySettings settings;
    bool overlay = false;
  };
  // A transition of the base screen (slot −1) or of overlay `slot`: X → Y (either may be empty).
  struct Anim {
    bool active = false;
    int slot = -1;
    Side x, y;
    Action action;
    bool reverse = false;
    bool smart = false;
    Snapshot fromSnap;  // smart: X's layers
    double start = 0, duration = 0;
    bool started = false;  // its clock starts at the first tick after it was made
    std::function<void()> done;
  };
  // An interactive component changing state (Change to) with Smart animate / Dissolve.
  struct InstanceAnim {
    Guid instance = kNoGuid;
    Snapshot from;
    Action action;
    double start = 0, duration = 0;
    bool started = false;
  };
  struct ScrollAnim {
    Guid frame = kNoGuid;
    Vec2 from, to;
    Action action;
    double start = 0, duration = 0;
    bool started = false;
  };
  struct Timer {
    Guid node = kNoGuid;
    size_t interaction = 0;
    double at = 0;  // ms; < 0: not armed yet (armed at the next tick)
    double delayMs = 0;
  };
  struct Hit {
    Guid id = kNoGuid;
    Mat2x3 toCss;  // node space → CSS px
    Vec2 size;
  };
  // A hit chain: the deepest layer first, its ancestors up to the shown frame; `layer` −1 for the base screen,
  // else the overlay's index.
  struct Chain {
    std::vector<Hit> hits;
    int layer = -2;  // −2: nothing
  };
  // While hovering / While pressing: how to undo what they did when the pointer leaves / is released.
  struct Held {
    Guid anchor = kNoGuid;  // what must stay under the pointer (the swapped instance, or the hotspot)
    std::vector<std::function<void()>> revert;
  };
  struct View {
    Vec2 screen;   // design units
    double s = 1;  // CSS px per unit
    Rect css;      // the screen on the canvas
    Mat2x3 toCss;  // screen units → CSS px
  };

  const Document& doc() const { return ed_.document(); }
  const NodeProps* props(Guid id) const;
  // The interactions a layer has: its own, else (an instance) its main component's — instances inherit them.
  bool hasIx(Guid id) const;
  std::vector<Interaction> ix(Guid id) const;
  Guid topLevelOf(Guid id) const;
  void layout();
  Vec2 topScrollRange(Guid frame) const;
  Vec2 nestedScrollRange(Guid frame) const;
  bool scrollsNested(Guid id) const;
  Vec2 overlayPos(Guid frame, const OverlaySettings& s, const Action* a, const Hit* hotspot) const;
  Chain hitTest(Vec2 css) const;
  bool hitWalk(Guid id, const Mat2x3& parentCss, Vec2 css, std::vector<Hit>& out, bool root) const;
  Mat2x3 frameCss(const Side& s) const;
  Side baseSide() const;

  // Running interactions.
  bool fire(Guid node, Trigger t, const Hit* hotspot, Held* held = nullptr);
  void run(Guid source, const std::vector<Action>& actions, const Hit* hotspot, Held* held);
  void runAction(Guid source, const Action& a, const Hit* hotspot, Held* held);
  void navigate(Guid dest, const Action& a, bool record = true);
  void openOverlay(Guid dest, const Action& a, const Hit* hotspot, Held* held);
  void swapOverlay(Guid source, Guid dest, const Action& a);
  void closeOverlay(int index, const Action* a);
  void changeTo(Guid source, Guid dest, const Action& a, Held* held);
  void swapInstance(Guid instance, Guid main, const Action& a);
  void scrollTo(Guid dest, const Action& a);
  void setVariable(const Action& a, Guid source);
  void setVariableMode(const Action& a);
  bool evaluate(const json::Value& data, Guid source, Editor::Resolved& out, int depth = 0) const;
  bool evalData(const VariableData& d, Guid source, Editor::Resolved& out, int depth) const;
  void remember(Guid id, FieldMask mask);
  void startAnim(Anim&& a);
  void finishAnim();
  void armTimers(Guid root);
  void dropTimers(Guid root);
  void hover(const Chain& c);
  void changed();
  bool frameExists(Guid id) const;

  // Scene building.
  Snapshot snapshot(Guid root, bool rootTransform) const;
  void snapWalk(Snapshot& s, Guid id, const Mat2x3& parentRel, const std::string& key, bool root, bool rootTransform) const;
  void smartDest(Guid id, const Snapshot& from, double p, bool rootTransform, PropsOverrides& out, const Mat2x3& parentInterp,
                 const Mat2x3& parentDest, const std::string& key, bool root, bool parentUnmatched) const;
  void smartSource(Guid id, const std::unordered_set<std::string>& keys, double p, PropsOverrides& out, const std::string& key,
                   bool root, bool parentUnmatched) const;
  void scrollOverrides(Guid frame, PropsOverrides& out, bool topLevel, Vec2 topScroll) const;
  void addFrame(const Side& s, Vec2 offset, double alpha, PropsOverrides&& overrides);
  void addSlot(const Side* x, const Side* y, const Anim* a);
  double progress(const Anim& a) const;

  Editor& ed_;
  Guid page_ = kNoGuid, base_ = kNoGuid, flow_ = kNoGuid;
  Guid startFrame_ = kNoGuid;  // where the presentation started (Restart without a flow)
  std::vector<Shown> overlays_;
  struct HistoryEntry {
    Guid base = kNoGuid;
    Vec2 baseScroll;
    std::vector<Shown> overlays;
    Action via;
    bool overlayOpen = false;  // the step opened an overlay (Back closes it)
  };
  std::vector<HistoryEntry> history_;
  std::vector<Guid> historyIds_, emptyIds_;
  std::unordered_map<Guid, Vec2, GuidHash> scroll_;
  Anim anim_;
  std::vector<InstanceAnim> instanceAnims_;
  std::vector<ScrollAnim> scrollAnims_;
  std::vector<Timer> timers_;
  std::vector<Held> held_;     // While hovering
  Held pressed_;               // While pressing
  Chain hoverChain_, downChain_;
  Vec2 downCss_;
  bool down_ = false, dragFired_ = false;
  bool hotspot_ = false;
  double now_ = 0;
  bool dirty_ = true;
  ScaleMode scale_ = ScaleMode::FIT;
  bool hints_ = true;
  double hintsAt_ = -1e9;  // hotspot hints flash (ms)
  bool hintsPending_ = false;
  View view_;
  PresentScene scene_;
  std::deque<PropsOverrides> store_;
  std::vector<Event> events_;
  // What the player wrote into the document, as it was before (Restart puts it back).
  std::unordered_map<Guid, NodeChange, GuidHash> originals_;
};

}  // namespace eng::proto
