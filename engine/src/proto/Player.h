// The prototype player (Figma's presentation view, docs/research/figma/R8-prototyping.md §9–§10): the screen shown
// (a top-level frame), the overlays over it, the navigation history, scroll positions, the interactions' triggers
// (click, hover, press, drag, keys, mouse enter / leave / down / up, after delay) and their actions, transitions
// (Instant, Dissolve, Smart animate, Move in / out, Push, Slide in / out, with easing and springs), and the scene the
// renderer draws (render/PresentScene.h) — the same Wasm renderer as the canvas.
//
// It runs on an engine of its own (the presentation tab loads the file read-only): "Change to", "Set variable" and
// "Set variable mode" write the document with APPLY_REMOTE (never journaled; Restart puts the original values back).
#pragma once

#include "text/TextLayout.h"

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

// Figma's scale options (help.figma.com 360040318013 "Play your prototypes"). Without a device: Actual size (100%),
// Responsive (the frame resized to the window and laid out again by its constraints and auto layout), Fit width,
// Fit width and height, Fill screen. With a device: Show device at 100%, Fit device on screen, Zoom device to fill
// screen (Fit width and Responsive read as Fit device on screen there), and apart from them Responsive / Fixed size
// (the frame resized to the device's screen, or shown at 100% in it) and Show device frame. Z cycles them.
enum class ScaleMode : uint8_t { ACTUAL = 0, FIT_WIDTH = 1, FIT = 2, FILL = 3, RESPONSIVE = 4 };
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
  // "Enable Figma shortcuts" (help "Play your prototypes"): off, only the prototype's own Key / Gamepad triggers take keys.
  void setShortcuts(bool on) { shortcuts_ = on; }
  bool shortcuts() const { return shortcuts_; }
  // With a device: Responsive (true) or Fixed size, and Show device frame.
  void setResponsive(bool on);
  bool responsive() const { return responsive_; }
  void setDeviceFrame(bool on);
  bool deviceFrame() const { return deviceFrame_; }
  // Whether the page's device has a frame to draw (a preset we know).
  bool hasDeviceFrame() const;

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

  // ---- Video (help.figma.com 8878274530455 "Use videos in prototypes", 14397859494295 "State management") ----------
  // The browser plays the videos (the page's <video> elements); the player decides what each one does — autoplay,
  // loop and sound from Prototype › Video, the video actions, state memorised per layer, shared between matching
  // layers, reset by "Reset video state" — and hears back each video's time and frames (the triggers "When video
  // hits" / "When video ends"; the frames drawn in place of the poster).
  struct Media {
    Guid node = kNoGuid;
    ImageHash video;         // the file (Paint.video.hash)
    VideoSettings settings;
    std::string key;         // matching across frames (state sharing): the top-level frame's name (before " /") + the layer's place
    bool playing = false, muted = false;
    double time = 0;         // seconds: the page's last report, or a seek's target
    double duration = 0;     // seconds; 0 until known
    bool ended = false;
    double seekTo = -1;      // a seek the page hasn't made yet (seconds), with its serial
    uint32_t seekSerial = 0, ackSerial = 0;
    bool shown = false;      // in a frame shown now
    bool frame = false;      // a frame of it arrived (drawn in place of the poster)
  };
  // {"videos": [{id, hash, playing, muted, loop, seek, seekSerial}]}: the videos shown now and what they should do.
  std::string mediaJson();
  // The page's report for a video: its current time, length and whether it ended (`seekSerial`: the last seek it made),
  // and a new frame — Module.engineBitmaps[bitmapId] is its <video> (0: no frame; `rgba`: pixels, tests).
  void mediaFrame(Guid node, uint32_t bitmapId, uint32_t width, uint32_t height, double time, double duration, bool ended,
                  uint32_t seekSerial, Bytes rgba = {});
  const Media* media(Guid node) const;
  // The image hash a video's frames are registered under (ImageRegistry, a live source).
  ImageHash frameHash(Guid node) const;

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
    std::vector<Effect> effects;
    std::string text;  // a TEXT layer's characters and font (Smart animate dissolves a text whose content changed)
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
    // On drag: the pointer sets the progress (`scrubP`) while it drags; released, the animation runs from there to
    // `p1` (1: completes, 0: goes back) — progress p0 + (p1 − p0) × ease(t).
    bool scrubbing = false;
    double scrubP = 0;
    double p0 = 0, p1 = 1;
  };
  // An interactive component changing state (Change to) with Smart animate / Dissolve.
  struct InstanceAnim {
    Guid instance = kNoGuid;
    Guid ghost = kNoGuid;  // the old state, kept (hidden from layout) while its unmatched layers fade out
    Snapshot from;
    Action action;
    double start = 0, duration = 0;
    bool started = false;
    // On drag scrubbing it (as Anim's): the progress follows the pointer; released before half way it runs back and
    // the instance returns to `fromMain`.
    Guid fromMain = kNoGuid;
    bool scrubbing = false;
    double scrubP = 0;
    double p0 = 0, p1 = 1;
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
    bool framed = false;     // a device frame is drawn around the screen
    double radius = 0;       // the screen's corner radius (CSS px)
    std::vector<PresentItem> under, over;  // the device frame's shapes (CSS px): behind the screen, over it
  };
  // On drag (R8 §12, help "Prototype triggers": "Drag allows you to move back and forward through the transition"):
  // the transition the drag started follows the pointer along its axis.
  struct Scrub {
    bool active = false;
    Vec2 axis;           // the drag direction that advances (unit, CSS px)
    double extent = 1;   // CSS px for the whole transition
    Vec2 from;           // where the drag started
    Guid instance = kNoGuid;  // a Change to being scrubbed (else the screen's transition)
  };

  const Document& doc() const { return ed_.document(); }
  const NodeProps* props(Guid id) const;
  // The interactions a layer has: its own, else (an instance) its main component's — instances inherit them.
  bool hasIx(Guid id) const;
  std::vector<Interaction> ix(Guid id) const;
  Guid topLevelOf(Guid id) const;
  void layout();
  void replaceOverlays();
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
  void mediaAction(const Action& a);
  Media* mediaEntry(Guid node);
  Media freshMedia(Guid node) const;
  std::string mediaKey(Guid node) const;
  void syncMedia();
  void applyMediaFrames();
  void clearMedia();
  bool evaluate(const json::Value& data, Guid source, Editor::Resolved& out) const;
  void remember(Guid id, FieldMask mask);
  void startAnim(Anim&& a);
  void finishAnim();
  void armTimers(Guid root);
  void dropTimers(Guid root);
  void hover(const Chain& c);
  // The hyperlink under `css` in a text of the chain (Figma: "Links in text also work in prototypes").
  const text::LinkBox* linkAt(const Chain& c, Vec2 css) const;
  // Follows a link: a URL opens (OPEN_URL), a frame of this file is navigated to.
  void follow(const text::LinkBox& link);
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
  // `fixedAlpha`: the top-level frame's Fixed children's alpha (< 0: `alpha`; 0: left out — drawn by the caller).
  void addFrame(const Side& s, Vec2 offset, double alpha, PropsOverrides&& overrides, double fixedAlpha = -1);
  void addSlot(const Side* x, const Side* y, const Anim* a);
  // Move / Push / Slide with "Animate matching layers": the screens move, matching layers smart-animate in place.
  void addMatching(const Side& x, const Side& y, const Anim& a, double p, Vec2 offX, Vec2 offY);
  // Fixed children of a top-level frame drawn on their own (unscrolled), each with the alpha `alphaOf` gives (0: none).
  void addFixed(const Side& s, Vec2 offset, const std::function<double(Guid, const std::string&)>& alphaOf);
  // The keys of `from`'s layers that `to`'s layers match and can animate (Smart animate falls back to Dissolve for a
  // layer whose shadows or text content changed: help.figma.com 360039818874).
  std::unordered_set<std::string> matchedKeys(const Snapshot& from, Guid to, bool rootTransform) const;
  bool animatable(const SnapNode& s, const NodeProps& p) const;
  double progress(const Anim& a) const;
  // Responsive: the frames shown resized to the window (or the device's screen); `restoreResponsive` puts them back.
  bool responsiveOn() const;
  void fitResponsive();
  void restoreResponsive();
  // Drag scrubbing.
  void beginScrub(Vec2 at);
  void beginInstanceScrub(Vec2 at, InstanceAnim& ia);
  void endScrub();
  double instanceProgress(const InstanceAnim& ia) const;
  InstanceAnim* instanceAnim(Guid instance);
  void silentBack();

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
  Vec2 hoverCss_;
  Vec2 downCss_;
  bool down_ = false, dragFired_ = false;
  bool hotspot_ = false;
  double now_ = 0;
  bool dirty_ = true;
  ScaleMode scale_ = ScaleMode::FIT;
  bool scaleChosen_ = false;  // the viewer picked a scale (else Figma's default for the file, chosen at start)
  bool responsive_ = false;   // with a device: Responsive (else Fixed size)
  bool deviceFrame_ = true;   // Show device frame
  bool fitting_ = false;
  std::unordered_map<Guid, Vec2, GuidHash> responsiveSizes_;  // frames resized for Responsive: their own size
  Scrub scrub_;
  uint64_t animSerial_ = 0;  // bumped by every startAnim (a drag knows whether its trigger started one)
  uint64_t instanceSerial_ = 0;  // bumped by every animated Change to (the same, for instances)
  Guid lastInstanceAnim_ = kNoGuid;
  bool noAnim_ = false;      // silentBack: Back without its animation
  // Change to's old states while they fade out (swapInstance), never hit; removed when their animation ends.
  static constexpr uint32_t kGhostSession = 0xFFFFFFF0u;
  uint32_t nextGhost_ = 1;
  std::unordered_set<Guid, GuidHash> ghosts_;
  void dropGhost(Guid ghost);
  void dropGhosts();
  bool hints_ = true;
  bool shortcuts_ = true;
  double hintsAt_ = -1e9;  // hotspot hints flash (ms)
  bool hintsPending_ = false;
  View view_;
  PresentScene scene_;
  std::deque<PropsOverrides> store_;
  std::vector<Event> events_;
  std::unordered_map<Guid, Media, GuidHash> media_;
  bool mediaDirty_ = true;   // the frames shown changed: syncMedia
  bool videoReset_ = false;  // the step that changed them had "Reset video state"
  uint32_t playerSerial_ = 0;  // this player's part of its videos' frame hashes
  // What the player wrote into the document, as it was before (Restart puts it back).
  std::unordered_map<Guid, NodeChange, GuidHash> originals_;
};

}  // namespace eng::proto
