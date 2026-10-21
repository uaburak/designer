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
#include "proto/Scroll.h"
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

  // Input, CSS px in the canvas (the editor's viewport). Return P_HANDLED-like bits (1: handled). `timeMs`: the event's
  // time on tick()'s clock (0: the last tick's) — a drag's release speed is measured with it.
  uint32_t pointer(PointerEvent type, double x, double y, uint32_t buttons, uint32_t mods, double timeMs = 0);
  uint32_t wheel(double x, double y, double dx, double dy);
  // A key (JS keyCode); `down` false for a release. Interactions first, then the presentation's shortcuts
  // (R restart, → / Space / N next frame, ← previous, Z scale).
  uint32_t key(bool down, int keyCode, uint32_t mods);

  void restart();
  bool next();
  bool previous();
  // Figma's Back (`returnToState2`, "before the last non-transient state"): the steps that only opened overlays are
  // skipped and the step before them is undone — back to its screen with no overlays (live 2026-10-20: Back in an
  // overlay opened on B returns to A). Only overlays since the start: nothing (Close overlay closes them).
  bool back();
  // Undoes exactly the last step (a hover's or a press's revert: Figma's "before the last state"), overlays included.
  bool undoLast(bool restoreOverlays = true);
  void setScale(ScaleMode m);
  ScaleMode scale() const { return scale_; }
  void cycleScale();
  // The scale options in Figma's order for this file (atlas 13 §10.1): its class's five without a device (the first two
  // "Recommended"), the device's three with one; Z goes to the next, the first is the default.
  std::vector<ScaleMode> scaleOrder() const;
  // The machine the prototype plays on (the viewer's host): its scroll physics when the page has no device (iOS / macOS
  // bounce, Android / Windows / Linux clamp), and Key / Gamepad triggers read ⌘ as Ctrl off the Mac.
  enum class Host : uint8_t { MAC, WINDOWS, LINUX, OTHER };
  void setHost(Host h) { host_ = h; }
  Host host() const { return host_; }
  scroll::Physics scrollPhysics() const;
  void setHints(bool on) { hints_ = on; }
  bool hints() const { return hints_; }
  // "Enable Figma shortcuts" (help "Play your prototypes"): off, only the prototype's own Key / Gamepad triggers take keys.
  void setShortcuts(bool on) { shortcuts_ = on; }
  bool shortcuts() const { return shortcuts_; }
  // "Website behaviours" (Options › Advanced settings, on by default; Wecra's, docs/engine.md §3.4 "Website behaviours"):
  // a Manual overlay follows its hotspot and stays in the window, a screen switches to its other breakpoint on resize
  // under Responsive, Change to and screen transitions are interruptible, Stack overlays queue like toasts. Off, the
  // player behaves as Figma's.
  void setWebBehaviours(bool on);
  bool webBehaviours() const { return web_; }
  // "Keep state on reload" (Options; the page keeps it in its session storage, never the document): the runtime state
  // — the screen, variables and modes the prototype set, component states, scroll positions — as JSON, and back on a
  // player that started the same page (false: not this page, or unreadable). Restart forgets it (the page's part).
  std::string saveState();
  bool restoreState(const std::string& json);
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
    Action opened;  // the transition it came in with: closing plays it backwards (live Figma)
    // Website behaviours, a Manual overlay opened from a hotspot (Keep in window): the hotspot by key, where its origin
    // was and its box (screen units) when the overlay opened, and where Figma's rule placed the overlay then — it moves
    // with the hotspot from there, flipped and shifted into the window.
    bool anchored = false;
    std::string anchorKey;
    Vec2 anchorAt, placed;
    Rect anchorBox;
  };
  const std::vector<Shown>& overlays() const { return overlays_; }
  Vec2 scrollOf(Guid frame) const;
  bool animating() const;
  bool hotspotUnder() const { return hotspot_; }
  // The frames → and ← go through (the flow's connected frames, else every frame of the page). Kept per document
  // version: the state is read a few times a second, and the connected frames are found by reading every layer of
  // them (a heavy screen's thousands).
  std::vector<Guid> sequence() const;
  // The screens the prototype can go to next from what it shows: its hotspots' destinations (navigate, overlays,
  // swaps, scroll to) and the frames → and ← go to — what a partial engine derives ahead, between frames.
  std::vector<Guid> upcoming() const;
  // Screen geometry: the device screen's size (design units) and where it is on the canvas (CSS px).
  Vec2 screenSize() const { return view_.screen; }
  Rect screenRect() const { return view_.css; }
  std::string stateJson() const;

  struct Event {
    enum class Kind : uint8_t { CHANGED, OPEN_URL } kind = Kind::CHANGED;
    std::string url;
    bool newTab = true;
    bool restarted = false;  // CHANGED by Restart (the page forgets the state it kept)
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
  // A GIF fill plays as a video does, always and looping, without sound ("GIFs in prototypes", atlas 07 §8.5).
  struct Media {
    Guid node = kNoGuid;
    ImageHash video;         // the file (Paint.video.hash; a GIF's Paint.animatedImage.hash)
    bool gif = false;        // a GIF fill, not a video
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
  // {"videos": [{id, hash, gif?, playing, muted, loop, seek, seekSerial}]}: the videos (and GIFs) shown now and what
  // they should do.
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
    NodeType type = NodeType::NONE;  // a leaf shape whose kind changed (rectangle → ellipse) dissolves while it moves
    double fontSize = 0;  // a TEXT layer's: a size change alone scales it (Figma)
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
    uint64_t serial = 0;  // what an action queue waits for
  };
  // An interactive component changing state (Change to) with Smart animate / Dissolve.
  struct InstanceAnim {
    Guid instance = kNoGuid;
    std::string key;  // keyOf(instance): found again when a change above it gives it a new id
    Guid ghost = kNoGuid;  // the old state, kept (hidden from layout) while its unmatched layers fade out
    Snapshot from;
    Action action;
    double start = 0, duration = 0;
    bool started = false;
    // On drag scrubbing it (as Anim's): the progress follows the pointer; released before half way it runs back and
    // the instance returns to `fromMain`.
    Guid fromMain = kNoGuid;
    // The layers around it that its new size moved or resized — its auto-layout parents (Hug), their other children —
    // from where they were to where they are now: they move with it every frame, as the parent re-lays out (Figma).
    struct Around {
      Guid id = kNoGuid;
      Mat2x3 t0, t1;
      Vec2 s0, s1;
    };
    std::vector<Around> around;
    // Website behaviours: interrupted, the old state's layers start at this alpha (where they were drawn).
    double ghostAlpha = 1;
    bool scrubbing = false;
    double scrubP = 0;
    double p0 = 0, p1 = 1;
    uint64_t serial = 0;
  };
  struct ScrollAnim {
    Guid frame = kNoGuid;
    Vec2 from, to;
    Action action;
    double start = 0, duration = 0;
    bool started = false;
    uint64_t serial = 0;
  };
  // A frame flung after a drag (scroll::Simulation per axis, in CSS px of scroll), on the animation clock.
  struct Fling {
    Guid frame = kNoGuid;
    bool top = false;  // a top-level frame (else a nested scrolling one)
    scroll::Simulation x, y;
    double start = 0;
    bool started = false;
  };
  // A drag scrolling a frame (it reacted to no On drag): the scroll follows the pointer; past an end it resists
  // (bouncing) or stops (clamping); let go, it flings.
  struct ScrollDrag {
    bool active = false;
    Guid frame = kNoGuid;
    bool top = false;
    Vec2 last;  // the pointer's last place (CSS px)
  };
  // After delay (atlas 13 §3.5): a timer started when its screen's transition ends (`at` < 0 until then), fired only if
  // no prototype action ran meanwhile; due ones run in order of time, then of creation.
  struct Timer {
    Guid node = kNoGuid;
    size_t interaction = 0;
    double at = 0;  // ms; < 0: not started yet
    double delayMs = 0;
    uint64_t order = 0;
    uint64_t actions = 0;  // actionCounter_ when it started
  };
  struct Hit {
    Guid id = kNoGuid;
    Mat2x3 toCss;  // node space → CSS px
    Vec2 size;
  };
  // A mouse enter / leave / down / up interaction with a delay (interactionMaintained): it runs `delayMs` after its
  // trigger unless the pointer undoes it first (leaves, comes back, is released, is pressed again).
  struct Delayed {
    Guid node = kNoGuid;
    size_t interaction = 0;
    Trigger trigger = Trigger::MOUSE_ENTER;
    double at = -1;  // ms; < 0: armed at the next tick
    double delayMs = 0;
    Hit hotspot;
    uint64_t actions = 0;  // actionCounter_ when it was triggered: another action meanwhile drops it
  };
  // A hit chain: the deepest layer first, its ancestors up to the shown frame; `layer` −1 for the base screen,
  // else the overlay's index.
  struct Chain {
    std::vector<Hit> hits;
    int layer = -2;  // −2: nothing
    // Each hit's layer key (keyOf), filled by keyChain: a layer inside an instance gets a new id when an instance above
    // it changes variant, its key stays — what the pointer was over and still is over is compared by key.
    std::vector<std::string> keys;
  };
  // While hovering / While pressing: how to undo what they did when the pointer leaves / is released.
  struct Held {
    Guid anchor = kNoGuid;  // what must stay under the pointer (the swapped instance, or the hotspot)
    Guid hotspot = kNoGuid;  // the While hovering's own layer (hovered already: not fired again)
    std::string anchorKey, hotspotKey;  // the same by key (ids inside instances change with their parents' variants)
    std::vector<std::function<void()>> revert;
    uint64_t id = 0;
  };
  // The ordered action queue (atlas 13 §4.4, viewer `runSequentialAction`): an interaction's actions run in order; one
  // that starts a screen change or a Change to holds the rest until its animation ends; a Conditional puts its chosen
  // block's actions in its place.
  struct Pending {
    Guid source = kNoGuid;
    std::deque<Action> actions;
    bool hasHotspot = false;
    Hit hotspot;
    uint64_t held = 0;  // the Held the actions add their undo to (0: none); gone (released, left): the rest is dropped
    uint64_t wait = 0;  // the animation they wait for
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
  // Figma's drag (atlas 13 §5.6): progress = clamp(dot(pointer − start, v) / ‖v‖², 0, 1) along the transition's vector
  // v; let go, the pointer's speed along v decides where it settles.
  struct Scrub {
    bool active = false;
    Vec2 axis;           // the drag direction that advances (unit, CSS px)
    double extent = 1;   // CSS px for the whole transition (‖v‖)
    Vec2 from;           // where the drag started
    Guid instance = kNoGuid;  // a Change to being scrubbed (else the screen's transition)
  };
  // The pointer's recent places (ms, CSS px) while it is down: drags' release speeds.
  struct Sample {
    double t;
    Vec2 at;
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
  // How far a top-level frame scrolled by `scroll` itself moves under the screen (the rest scrolls its layers).
  Vec2 topShift(Guid frame, Vec2 scroll) const;
  Vec2 nestedScrollRange(Guid frame) const;
  bool scrollsNested(Guid id) const;
  Vec2 overlayPos(Guid frame, const OverlaySettings& s, const Action* a, const Hit* hotspot) const;
  // Website behaviours: a Manual overlay's Keep in window (anchored to its hotspot, flipped and shifted), and the toast
  // stacks (Stack overlays at one preset position, the newest at the edge), placed again on every layout.
  OverlayEdge edgeOf(const OverlaySettings& s) const;
  void anchor(Shown& s, const Hit& hotspot);
  void placeAnchored(Shown& o) const;
  Vec2 keepInWindow(Vec2 size, const Rect& anchor, Vec2 at) const;
  void stackOverlays();
  // A shown layer's space → CSS px as the scene draws it (scroll included); false when it isn't shown.
  bool shownCss(Guid id, Mat2x3& out) const;
  // Where an overlay is drawn: its place, or on its way there (a stack sliding).
  Vec2 drawnPos(const Shown& o) const;
  struct Slide {
    Guid frame = kNoGuid;
    Vec2 from, to;
    Action action;
    double start = 0, duration = 0;
    bool started = false;
  };
  std::vector<Slide> slides_;
  // Website behaviours, breakpoints: the frame of `frame`'s responsive group (top-level frames named alike, "Home /
  // Desktop", "Home / Mobile") a window `width` wide shows — each size from half way between its width and the next
  // narrower one's; `frame` itself when it has no group.
  Guid breakpointFor(Guid frame, double width) const;
  // The shown screen replaced at once by `to` (no history, no transition): its component states and scroll carried.
  void replaceScreen(Guid to);
  struct BreakpointMemo {
    uint64_t version = ~0ull;
    Guid frame, page;
    double width = -1;
    Guid result;
  };
  mutable BreakpointMemo breakpoint_;
  bool web_ = true;
  Vec2 overlayPlace(Guid frame, const OverlaySettings& s, const Action* a, const Hit* hotspot) const;
  Chain hitTest(Vec2 css) const;
  // A layer's children in hit order: the topmost first (Canvas stacking "First on top" respected).
  std::vector<Guid> topmostFirst(Guid id) const;
  bool hitWalk(Guid id, const Mat2x3& parentCss, Vec2 css, std::vector<Hit>& out, bool root, Vec2 rootScroll = {}) const;
  Mat2x3 frameCss(const Side& s) const;
  Side baseSide() const;

  // Running interactions.
  bool fire(Guid node, Trigger t, const Hit* hotspot, Held* held = nullptr);
  void run(Guid source, const std::vector<Action>& actions, const Hit* hotspot, Held* held);
  void drain(Pending&& q, Held* now = nullptr);
  Held* heldById(uint64_t id);
  void leaveHeld();
  void releaseLeftHeld();
  bool running(uint64_t serial) const;
  void resumePending();
  const Branch* chosenBranch(const Action& a, Guid source) const;
  void runAction(Guid source, const Action& a, const Hit* hotspot, Held* held);
  void navigate(Guid dest, const Action& a, bool record = true);
  void openOverlay(Guid dest, const Action& a, const Hit* hotspot, Held* held);
  void swapOverlay(Guid source, Guid dest, const Action& a);
  void closeOverlay(int index, const Action* a);
  void changeTo(Guid source, Guid dest, const Action& a, Held* held);
  void swapInstance(Guid instance, Guid main, const Action& a);
  // Figma's component-state storage (`hV`, stateManagementVersion 1): the state an interacted instance was changed to
  // (non-transient Change to), by its semantic path — layer names with their index among same-named siblings from the
  // screen down, the screen's own name left out — so an instance at the same path on the next screen shows it too,
  // unless the step resets component states. Cleared by Restart.
  std::string semanticPath(Guid node) const;
  // A layer's key: its screen (top-level frame) and its semantic path in it. Stable while an instance above it changes
  // variant (its derived id is not: the id follows the variant's own layers). `byKey` finds the layer a key names now
  // (kNoGuid: none); `underKey` the layer at a path relative to `root` (a key's part after the root's key).
  std::string keyOf(Guid node) const;
  Guid byKey(const std::string& key) const;
  Guid underKey(Guid root, const std::string& rel) const;
  void keyChain(Chain& c) const;
  // Nested instances' states the player set (Change to on an instance inside another instance), by key → the variant
  // shown. A Change to on an instance above keeps them where its old and new variants design that layer alike, and
  // gives the new variant's design where they differ (the outer state drives that layer, a prop in a web page).
  std::unordered_map<std::string, Guid> nestedStates_;
  void keepNestedStates(Guid instance, Guid fromMain, Guid toMain);
  // Re-finds running Change-to animations whose instance got a new id (by their key).
  void rekeyInstanceAnims();
  // What the screen shows (base and overlays): a change of it ends a hover round.
  uint64_t screenSignature() const;
  void carryComponentStates(Guid screen, const Action& a);
  std::unordered_map<std::string, Guid> componentStates_;  // path → the variant shown (its set is the variant's parent)
  // Scroll positions the same way (Figma's v1 `handleStateChangeInitiated`): the old screen's offsets stored by semantic
  // path ("" = the screen itself) when it is left; the next screen's scrolling frames take the offset stored at their
  // path, 0 where none — or all 0 with "Reset scroll position". Live 2026-10-20: a list scrolled 200 on A, Next → B's
  // same-named list at 200.
  void carryScroll(Guid from, Guid to, const Action& a);
  std::unordered_map<std::string, Vec2> scrollStore_;
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
  /** The document fields the runtime changed, back as they were before presenting (restart, stop). */
  void restoreOriginals();
  void startAnim(Anim&& a);
  void finishAnim();
  void armTimers(Guid root);
  void dropTimers(Guid root);
  // Drops the pending delayed interactions of trigger `t` (on `node`, or on any node when it is kNoGuid).
  void cancelDelayed(Trigger t, Guid node = kNoGuid);
  // `live`: the pointer is over the prototype (re-hit-tested after a change under it); false when it left.
  void hover(const Chain& c, bool live = true);
  // While hovering on one layer of the chain (its first such interaction), unless that layer is hovered already.
  void whileHovering(const Hit& h, const std::string& key);
  // The hyperlink under `css` in a text of the chain (Figma: "Links in text also work in prototypes").
  const text::LinkBox* linkAt(const Chain& c, Vec2 css) const;
  // Follows a link: a URL opens (OPEN_URL), a frame of this file is navigated to.
  void follow(const text::LinkBox& link);
  void changed();
  bool frameExists(Guid id) const;

  // Scene building.
  Snapshot snapshot(Guid root, bool rootTransform) const;
  // `over`: the props drawn (a running animation's), where it has them.
  void snapWalk(Snapshot& s, Guid id, const Mat2x3& parentRel, const std::string& key, bool root, bool rootTransform,
                const PropsOverrides* over = nullptr) const;
  // Website behaviours, interruptible transitions: a running Change to's instance as it is drawn at progress `e` (its
  // old state's fading layers included), and a running screen transition's destination as drawn now.
  Snapshot drawnInstance(const InstanceAnim& ia, double e) const;
  Snapshot drawnScreen(const Anim& a) const;
  void smartDest(Guid id, const Snapshot& from, double p, bool rootTransform, PropsOverrides& out, const Mat2x3& parentInterp,
                 const Mat2x3& parentDest, const std::string& key, bool root, bool parentUnmatched) const;
  void smartSource(Guid id, const std::unordered_set<std::string>& keys, double p, PropsOverrides& out, const std::string& key,
                   bool root, bool parentUnmatched, const Mat2x3& parentRel = Mat2x3{}) const;
  void scrollOverrides(Guid frame, PropsOverrides& out, bool topLevel, Vec2 topScroll) const;
  // `fixedAlpha`: the top-level frame's Fixed children's alpha (< 0: `alpha`; 0: left out — drawn by the caller).
  void addFrame(const Side& s, Vec2 offset, double alpha, PropsOverrides&& overrides, double fixedAlpha = -1);
  void addSlot(const Side* x, const Side* y, const Anim* a);
  // Move / Push / Slide with "Animate matching layers": the screens move, matching layers smart-animate in place.
  void addMatching(const Side& x, const Side& y, const Anim& a, double p);
  // Fixed children of a top-level frame drawn on their own (unscrolled), each with the alpha `alphaOf` gives (0: none).
  void addFixed(const Side& s, Vec2 offset, const std::function<double(Guid, const std::string&)>& alphaOf);
  // The keys of `from`'s layers that `to`'s layers match and can animate (a matched layer whose text content or shape
  // kind changed dissolves while it moves; shadows animate — live Figma 2026-10-20).
  std::unordered_set<std::string> matchedKeys(const Snapshot& from, Guid to, bool rootTransform) const;
  bool animatable(const SnapNode& s, const NodeProps& p) const;
  // Matched layers that can't animate (text content, shadows, shape kind changed) dissolve while they move (Figma's
  // plan nodes with `isDissolve`, live 2026-10-20: a rectangle → an ellipse of the same name cross-fades along the
  // path): smartDest records each one's interpolated transform (relative to the destination frame) under its key, so
  // smartSource moves the old layer along the same path as it fades out. Filled by smartDest, read by smartSource.
  mutable std::unordered_map<std::string, Mat2x3> dissolving_;
  double progress(const Anim& a) const;
  // Responsive: the frames shown resized to the window (or the device's screen); `restoreResponsive` puts them back.
  bool responsiveOn() const;
  void fitResponsive();
  void restoreResponsive(bool keepFitted = false);
  // Wecra's overlay "Fit to window" (OverlaySettings::fit): the open overlays (and `opening`) take the screen's size
  // along the chosen sides; their own sizes are kept in responsiveSizes_ like Responsive's.
  void fitOverlays(Guid opening = kNoGuid);
  bool fittedOverlay(Guid frame) const;
  // Drag scrubbing.
  void beginScrub(Vec2 at, Guid hotspot);
  void beginInstanceScrub(Vec2 at, InstanceAnim& ia);
  void endScrub(double timeMs);
  // The pointer's speed (CSS px / s) over its last 100 ms, at `timeMs` (0 when it stopped 40 ms before).
  Vec2 pointerVelocity(double timeMs) const;
  // Drag scrolling.
  bool beginScrollDrag(Vec2 at);
  void moveScrollDrag(Vec2 at);
  void endScrollDrag(double timeMs);
  void stopFlings(Guid frame);
  Vec2 scrollRange(Guid frame, bool top) const;
  // Sticky layers under a scrolling frame scrolled by `scrollY` (atlas 13 §8.2): their offsets, added to `out`.
  void stick(Guid scroller, double scrollY, PropsOverrides& out) const;
  // Motion timelines (docs/motion.md §4.12): the shown screen's timeline plays from when its transition ends.
  void startTimeline();
  void stopTimeline();
  void timelineAction(const Action& a);
  double instanceProgress(const InstanceAnim& ia) const;
  InstanceAnim* instanceAnim(Guid instance);
  void silentBack();

  Editor& ed_;
  struct SequenceMemo {
    uint64_t version = ~0ull;
    Guid page, flow, start;
    std::vector<Guid> frames;
  };
  mutable SequenceMemo sequence_;
  std::vector<Guid> computeSequence() const;
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
  std::vector<Delayed> delayed_;  // mouse triggers waiting out their delay
  std::vector<Held> held_;     // While hovering
  Held pressed_;               // While pressing
  std::vector<Held> leftHeld_;  // held on a screen that went: undone once its screen change has played
  bool instantSwaps_ = false;   // Change to without its animation (a left screen's states going back)
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
  std::deque<Sample> samples_;
  ScrollDrag scrollDrag_;
  std::vector<Fling> flings_;
  Guid wheelFrame_ = kNoGuid;  // the frame the last wheel events scrolled, and when
  double wheelAt_ = -1e9;
  Host host_ = Host::MAC;
  // The animation clock (atlas 13 §5.4): each tick adds the time since the last, at most 1/30 s — a long frame slows the
  // animations down instead of skipping them. Timers run on the wall clock (now_).
  double clock_ = 0, lastTick_ = -1;
  std::vector<Pending> pending_;
  uint64_t motionSerial_ = 0;   // bumped by every animation started (Anim, InstanceAnim, ScrollAnim)
  uint64_t actionCounter_ = 0;  // bumped by every action run
  uint64_t heldSerial_ = 0;
  uint64_t timerOrder_ = 0;
  bool arrowReached_ = false;  // the screen was reached with ← / → (its After delays wait at least 500 ms)
  // Motion: the shown screen's timeline (kNoGuid: none), its time and whether it runs; it starts when the screen's
  // transition ends.
  Guid timelineRoot_ = kNoGuid;
  double timelineMs_ = 0;
  bool timelinePlaying_ = false;
  bool timelineWaits_ = false;
  uint64_t animSerial_ = 0;  // bumped by every startAnim (a drag knows whether its trigger started one)
  uint64_t instanceSerial_ = 0;  // bumped by every animated Change to (the same, for instances)
  Guid lastInstanceAnim_ = kNoGuid;
  bool noAnim_ = false;      // silentBack: Back without its animation
  // Change to's old states while they fade out (swapInstance), never hit; removed when their animation ends.
  static constexpr uint32_t kGhostSession = 0xFFFFFFF0u;
  uint32_t nextGhost_ = 1;
  std::unordered_set<Guid, GuidHash> ghosts_;
  bool noInstanceAnims_ = false;  // addFrame: a pass that draws only its overrides (addMatching's fading source)
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
