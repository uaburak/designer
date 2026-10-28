#include "proto/Player.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <optional>
#include <tuple>

#include "base/FractionalIndex.h"
#include "motion/Easing.h"
#include "proto/Devices.h"
#include "render/ImageCache.h"
#include "scene/CodecJson.h"

namespace eng::proto {

namespace {

// Figma's viewer (atlas 13 §3.5, §5.4, §5.6, §8.2, §10.4).
constexpr double kDragThreshold = 5;      // CSS px a press moves past before it is a drag (`SQ = 5`)
constexpr double kHintsMs = 700;          // hotspot hints: one 0.7 s fade
constexpr double kMaxFrameMs = 1000.0 / 30;  // a frame advances the animations by at most 1/30 s
constexpr double kReleaseSpeed = 0.15;    // On drag: the release speed (progress per duration) that flips the end
constexpr double kArrowDelayMs = 500;     // After delay on a screen reached with ← / →: at least this long
constexpr double kWheelLatchMs = 200;     // wheel events this close keep scrolling the same frame
constexpr double kDoubleClickMs = 500;    // On double click (@ours): the second click this soon after the first (the OS default)

double lerp(double a, double b, double t) { return a + (b - a) * t; }
// An eased progress used as an opacity: an overshooting easing never makes a layer more than opaque or less than clear.
double unit(double t) { return std::clamp(t, 0.0, 1.0); }

Color lerpColor(const Color& a, const Color& b, double t) {
  return {static_cast<float>(lerp(a.r, b.r, t)), static_cast<float>(lerp(a.g, b.g, t)), static_cast<float>(lerp(a.b, b.b, t)),
          static_cast<float>(lerp(a.a, b.a, t))};
}

// Rotation + translation (and a flip) interpolate as an angle and a position; anything else by components. Not clamped:
// an easing that overshoots (Back, springs) carries the layer past its end and back, as Figma's viewer does (its
// translation is a plain lerp of the eased progress; measured live 2026-10-20, docs/research/rea/prototype.md §3).
Mat2x3 lerpMatrix(const Mat2x3& a, const Mat2x3& b, double t) {
  if (t == 0) return a;
  if (t == 1) return b;
  double da = a.determinant(), db = b.determinant();
  bool rigid = std::fabs(std::fabs(da) - 1) < 1e-3 && std::fabs(std::fabs(db) - 1) < 1e-3 && (da > 0) == (db > 0);
  if (rigid) {
    double flip = da > 0 ? 1 : -1;
    double aa = std::atan2(a.m10, a.m00), ab = std::atan2(b.m10, b.m00);
    double d = ab - aa;
    while (d > M_PI) d -= 2 * M_PI;
    while (d < -M_PI) d += 2 * M_PI;
    double ang = aa + d * t;
    double c = std::cos(ang), s = std::sin(ang);
    return {c, -s * flip, lerp(a.m02, b.m02, t), s, c * flip, lerp(a.m12, b.m12, t)};
  }
  return {lerp(a.m00, b.m00, t), lerp(a.m01, b.m01, t), lerp(a.m02, b.m02, t),
          lerp(a.m10, b.m10, t), lerp(a.m11, b.m11, t), lerp(a.m12, b.m12, t)};
}

std::vector<Paint> lerpPaints(const std::vector<Paint>& a, const std::vector<Paint>& b, double t) {
  if (a.size() != b.size()) return t < 0.5 ? a : b;
  std::vector<Paint> out = b;
  for (size_t i = 0; i < a.size(); i++) {
    if (a[i].type != b[i].type) {
      if (t < 0.5) out[i] = a[i];
      continue;
    }
    out[i].color = lerpColor(a[i].color, b[i].color, t);
    // Opacities stay in [0, 1] when the easing overshoots (Figma's viewer clamps a paint's opacity).
    out[i].opacity = static_cast<float>(std::clamp(lerp(a[i].opacity, b[i].opacity, t), 0.0, 1.0));
    if (a[i].visible != b[i].visible) {
      // One side hidden: fade it.
      out[i].visible = true;
      double from = a[i].visible ? a[i].opacity : 0, to = b[i].visible ? b[i].opacity : 0;
      out[i].opacity = static_cast<float>(std::clamp(lerp(from, to, t), 0.0, 1.0));
    }
    if (a[i].stops.size() == b[i].stops.size())
      for (size_t k = 0; k < a[i].stops.size(); k++) {
        out[i].stops[k].color = lerpColor(a[i].stops[k].color, b[i].stops[k].color, t);
        out[i].stops[k].position = lerp(a[i].stops[k].position, b[i].stops[k].position, t);
      }
  }
  return out;
}

bool isSmart(const Action& a) { return a.transition == Transition::SMART_ANIMATE || a.transition == Transition::MAGIC_MOVE; }

// A TEXT layer's content and font: Smart animate dissolves a text whose content changed (and animates one that only
// moved, resized or changed colour).
// Live Figma (2026-10-20, prototype-playback.txt "Whole-file audit"): a text whose characters or font (family, style)
// differ dissolves; one whose font size alone differs is matched and scales; its colour interpolates.
std::string textSignature(const NodeProps& p) {
  if (p.type != NodeType::TEXT) return std::string();
  const TextFacet& t = p.text();
  return t.textData.characters + "\x01" + t.fontName.family + "\x01" + t.fontName.style;
}

// Effects animate pair by pair: radius, spread, offset and colour; an effect only one side has comes in (or goes) with
// its colour's alpha — live Figma 2026-10-20: a layer that gains a drop shadow moves at full opacity while the shadow
// fades in at its final offset (help.figma.com's "no smart animate for shadows" no longer holds); types that differ at
// an index switch half way.
std::vector<Effect> lerpEffects(std::vector<Effect> a, std::vector<Effect> b, double t) {
  auto clear = [](Effect e) {
    e.color.a = 0;
    return e;
  };
  while (a.size() < b.size()) a.push_back(clear(b[a.size()]));
  while (b.size() < a.size()) b.push_back(clear(a[b.size()]));
  std::vector<Effect> out = b;
  for (size_t i = 0; i < a.size(); i++) {
    if (a[i].type != b[i].type) return t < 0.5 ? a : b;
    out[i].radius = lerp(a[i].radius, b[i].radius, t);
    out[i].spread = lerp(a[i].spread, b[i].spread, t);
    out[i].offset = {lerp(a[i].offset.x, b[i].offset.x, t), lerp(a[i].offset.y, b[i].offset.y, t)};
    out[i].color = lerpColor(a[i].color, b[i].color, t);
    if (a[i].visible != b[i].visible) {
      out[i].visible = true;
      out[i].radius = a[i].visible ? lerp(a[i].radius, 0, t) : lerp(0, b[i].radius, t);
    }
  }
  return out;
}

// JS keyCodes of the modifiers (how Figma's keyTrigger lists them).
constexpr int kShift = 16, kCtrl = 17, kAlt = 18, kMeta = 91;

json::Value parseJson(const std::string& s) {
  json::Value v;
  json::parse(s, v);
  return v;
}

}  // namespace

const char* scaleName(ScaleMode m) {
  switch (m) {
    case ScaleMode::ACTUAL: return "ACTUAL";
    case ScaleMode::FIT_WIDTH: return "FIT_WIDTH";
    case ScaleMode::FIT: return "FIT";
    case ScaleMode::FILL: return "FILL";
    case ScaleMode::RESPONSIVE: return "RESPONSIVE";
  }
  return "FIT";
}

Player::Player(Editor& editor) : ed_(editor) {
  static uint32_t players = 0;
  playerSerial_ = ++players;
}

const NodeProps* Player::props(Guid id) const {
  const Node* n = doc().get(id);
  return n ? &n->props : nullptr;
}

const std::vector<Interaction>& Player::played(Guid id) const {
  if (playedCacheVersion_ != doc().version()) {
    // Only what changed goes: a variant swap rewrites one instance and its derived layers. A main or a set changed (an
    // instance plays its main's and reads every variant), or the log gone: everything.
    std::vector<Document::ChangeRecord> changes;
    bool all = !doc().changesSince(playedCacheVersion_, changes);
    for (size_t k = 0; k < changes.size() && !all; k++) {
      const Document::ChangeRecord& c = changes[k];
      playedCache_.erase(c.id);
      if (c.id.isDerived()) continue;
      const NodeProps* p = props(c.id);
      if (!p || p->type == NodeType::SYMBOL || (p->type == NodeType::FRAME && p->comp().isStateGroup)) all = true;
    }
    if (all) playedCache_.clear();
    playedCacheVersion_ = doc().version();
  }
  auto it = playedCache_.find(id);
  if (it == playedCache_.end()) it = playedCache_.emplace(id, ed_.playedInteractions(id)).first;
  return it->second;
}

bool Player::hasIx(Guid id) const {
  const NodeProps* p = props(id);
  if (!p) return false;
  if (p->type != NodeType::INSTANCE) return hasInteractions(*p);
  const NodeProps* m = props(ed_.mainOf(id));
  if (!hasInteractions(*p) && !(m && hasInteractions(*m))) return false;
  return !played(id).empty();
}

std::vector<Interaction> Player::ix(Guid id) const {
  const NodeProps* p = props(id);
  if (!p) return {};
  // An instance plays its main's (the variant it shows now) with its own changes and additions.
  std::vector<Interaction> list = played(id);
  // A delay or a duration bound to a number variable (Figma's transitionTimeoutVar / transitionDurationVar): its value
  // in the hotspot's modes, else the literal stored next to it.
  auto seconds = [&](const json::Value& var, double& out) {
    Editor::Resolved r;
    if (!var.isNull() && evaluate(var, id, r) && r.kind == Editor::Resolved::Kind::FLOAT && std::isfinite(r.f)) out = std::max(0.0, r.f);
  };
  std::function<void(std::vector<Action>&)> actions = [&](std::vector<Action>& as) {
    for (Action& a : as) {
      seconds(a.durationVar, a.duration);
      for (Branch& b : a.branches) actions(b.actions);
    }
  };
  for (Interaction& i : list) {
    if (i.trigger == Trigger::NONE) i.trigger = Trigger::ON_CLICK;  // Figma's viewer reads a NONE trigger as On click
    seconds(i.timeoutVar, i.timeout);
    actions(i.actions);
  }
  return list;
}

// The screen a layer is on: its top-level frame, a frame in a section counting as top-level (Figma's).
Guid Player::topLevelOf(Guid id) const { return screenOf(doc(), id); }

void Player::dropGhost(Guid ghost) {
  if (ghost == kNoGuid || !ghosts_.erase(ghost) || !doc().has(ghost)) return;
  ed_.applyChanges({NodeChange::removed(ghost)}, APPLY_REMOTE);
  dirty_ = true;
}

void Player::dropGhosts() {
  std::vector<Guid> all(ghosts_.begin(), ghosts_.end());
  for (Guid g : all) dropGhost(g);
}

bool Player::frameExists(Guid id) const {
  const NodeProps* p = props(id);
  return p && p->visible && (p->isFrameLike() || p->isGroupLike());
}

// ---- Lifecycle -------------------------------------------------------------------------------------------

bool Player::start(Guid page, Guid start) {
  const NodeProps* pg = props(page);
  if (!pg || pg->type != NodeType::CANVAS) return false;
  // A start is a fresh prototype, as Figma's Restart and its flow / frame picks are: what the player wrote while it
  // ran (Change to states, variables, modes) goes back first — the inline preview's Restart and a jump to another frame
  // or flow come here, not through restart().
  restoreOriginals();
  resetWeb();
  page_ = page;
  componentStates_.clear();
  nestedStates_.clear();
  scrollStore_.clear();
  if (ed_.page() != page) ed_.setCurrentPage(page);
  ed_.derivePage(page);
  Guid frame = start != kNoGuid ? topLevelOf(start) : kNoGuid;
  // A section (or a layer only sections hold): its first flow's frame, else its first frame (sectionStart).
  if (frame == kNoGuid && start != kNoGuid) {
    Guid s = start;
    while (s != kNoGuid && props(s) && props(s)->type != NodeType::SECTION) s = doc().parentOf(s);
    if (s != kNoGuid) frame = sectionStart(doc(), page, s);
  }
  flow_ = kNoGuid;
  if (frame == kNoGuid) {
    auto fl = flows(doc(), page);
    if (!fl.empty()) frame = fl[0].node;
  }
  if (frame == kNoGuid) {
    auto seq = sequence();
    if (!seq.empty()) frame = seq[0];
  }
  if (frame == kNoGuid || !frameExists(frame)) return false;
  restoreResponsive();
  // Website behaviours: under Responsive, the frame's breakpoint for the window (its other size).
  if (web_ && responsiveOn() && pageDevice(page).none) frame = breakpointFor(frame, ed_.viewport().width);
  ed_.deriveTree(frame);  // a partial engine derives the screens it shows (Editor::deriveTree)
  if (!scaleChosen_) {
    // Figma's default scale: the first of the file's order (Fill screen for a presentation, Fit device on screen with a
    // device, otherwise Actual size (100%)).
    startFrame_ = frame;
    scale_ = scaleOrder().front();
  }
  scrub_ = Scrub{};
  // The flow the frame starts (or the first flow that reaches it).
  Flow f;
  if (const NodeProps* fp = props(frame); fp && flowStart(*fp, f)) flow_ = frame;
  base_ = frame;
  startFrame_ = frame;
  overlays_.clear();
  history_.clear();
  historyIds_.clear();
  scroll_.clear();
  anim_ = Anim{};
  dropGhosts();
  instanceAnims_.clear();
  scrollAnims_.clear();
  slides_.clear();
  flings_.clear();
  scrollDrag_ = ScrollDrag{};
  thumbDrag_ = ThumbDrag{};
  lastClickAt_ = -1e9;
  pending_.clear();
  timers_.clear();
  delayed_.clear();
  held_.clear();
  leftHeld_.clear();
  pressed_ = Held{};
  hoverChain_ = Chain{};
  downChain_ = Chain{};
  down_ = false;
  clearMedia();
  armTimers(base_);
  layout();
  startTimeline();
  changed();
  return true;
}

void Player::stop() {
  // The file is as it was before presenting: Set variable / Set variable mode / Change to are the prototype's runtime
  // state, never the document's (Figma's prototypes don't edit the file).
  stopTimeline();
  resetWeb();
  restoreOriginals();
  restoreResponsive();
  dropGhosts();
  instanceAnims_.clear();
  slides_.clear();
  base_ = kNoGuid;
  overlays_.clear();
  timers_.clear();
  delayed_.clear();
  pending_.clear();
  flings_.clear();
  scrollDrag_ = ScrollDrag{};
  thumbDrag_ = ThumbDrag{};
  scene_ = PresentScene{};
  store_.clear();
  clearMedia();
}

void Player::changed() {
  dirty_ = true;
  mediaDirty_ = true;
  historyIds_.clear();
  for (auto& h : history_) historyIds_.push_back(h.base);
  events_.push_back(Event{});
}

std::string Player::semanticPath(Guid node) const {
  std::string path;
  for (Guid cur = node; cur != kNoGuid; cur = doc().parentOf(cur)) {
    Guid parent = doc().parentOf(cur);
    const NodeProps* p = props(cur);
    if (!p || parent == kNoGuid || topLevelOf(cur) == cur) break;
    int k = 0;
    for (Guid s : doc().children(parent)) {
      if (s == cur) break;
      if (const NodeProps* sp = props(s); sp && sp->name == p->name) k++;
    }
    // Separators no layer name holds ("Iconset/search" has a '/'): keys are split again by byKey.
    path = "\x1f" + p->name + "\x1e" + std::to_string(k) + path;
  }
  return path;
}

void Player::carryComponentStates(Guid screen, const Action& a) {
  if (a.stateVersion < 1) return;
  // Outer instances first, their children read after each one's swap: an outer state's swap gives the layers inside it
  // new ids (and a nested instance's own state is then applied inside the outer's new variant).
  auto apply = [&](Guid inst) {
    Guid main = ed_.mainOf(inst);
    if (a.resetComponents) {
      // "Reset component state": the instance as it was designed.
      auto o = originals_.find(inst);
      if (o != originals_.end() && (o->second.mask & F_SYMBOL_DATA)) {
        Guid designed = o->second.props.comp().symbolData.symbolID;
        if (designed != kNoGuid && designed != main && doc().has(designed)) swapInstance(inst, designed, Action{});
      }
      return;
    }
    auto it = componentStates_.find(semanticPath(inst));
    if (it == componentStates_.end() || it->second == main || !doc().has(it->second)) return;
    // Only a variant of the same set.
    if (doc().parentOf(it->second) != doc().parentOf(main)) return;
    swapInstance(inst, it->second, Action{});
  };
  std::function<void(Guid, int)> walk = [&](Guid id, int depth) {
    const NodeProps* p = props(id);
    if (!p || depth > 256) return;
    if (p->type == NodeType::INSTANCE) apply(id);
    const std::vector<Guid> kids = doc().children(id);
    for (Guid c : kids) walk(c, depth + 1);
  };
  walk(screen, 0);
}

void Player::carryScroll(Guid from, Guid to, const Action& a) {
  if (a.stateVersion < 1) return;
  auto inside = [&](Guid root, Guid id) { return id == root || doc().isAncestor(root, id); };
  if (from != kNoGuid)
    for (auto& [id, off] : scroll_)
      if (doc().has(id) && inside(from, id)) scrollStore_[semanticPath(id)] = off;
  for (auto it = scroll_.begin(); it != scroll_.end();) it = inside(to, it->first) ? scroll_.erase(it) : std::next(it);
  std::function<void(Guid)> walk = [&](Guid id) {
    std::string path = semanticPath(id);
    if (a.resetScroll) {
      if (scrollStore_.count(path)) scrollStore_[path] = Vec2{};
    } else if (auto s = scrollStore_.find(path); s != scrollStore_.end() && (s->second.x != 0 || s->second.y != 0)) {
      scroll_[id] = s->second;
    }
    for (Guid c : doc().children(id))
      if (const NodeProps* cp = props(c); cp && (cp->type == NodeType::FRAME || cp->type == NodeType::INSTANCE || cp->type == NodeType::SYMBOL))
        walk(c);
  };
  walk(to);
}

void Player::restart() {
  if (page_ == kNoGuid) return;
  componentStates_.clear();
  nestedStates_.clear();
  scrollStore_.clear();
  restoreOriginals();
  start(page_, flow_ != kNoGuid ? flow_ : startFrame_);
  Event e;
  e.restarted = true;
  events_.push_back(e);
}

void Player::setWebBehaviours(bool on) {
  if (web_ == on) return;
  if (!on) {
    // Nothing focused or typed into any more (proto/WebBehaviours.cpp).
    blur();
    focusReturns_.clear();
  }
  web_ = on;
  cursor_ = hotspot_ ? Cursor::POINTER : Cursor::DEFAULT;
  dirty_ = true;
  breakpoint_ = BreakpointMemo{};
  if (!on) {
    // Figma's again: overlays where Figma's rule puts them, no stacks sliding.
    slides_.clear();
    for (auto& o : overlays_)
      if (o.anchored) {
        o.pos = o.placed;
        o.anchored = false;
      }
  }
  if (active()) layout();
  events_.push_back(Event{});
}

void Player::restoreOriginals() {
  // Runtime writes back as they were.
  if (originals_.empty()) return;
  std::vector<NodeChange> back;
  for (auto& [id, c] : originals_)
    if (doc().has(id)) back.push_back(c);
  originals_.clear();
  ed_.applyChanges(back, APPLY_REMOTE);
}

std::vector<Guid> Player::sequence() const {
  SequenceMemo& m = sequence_;
  uint64_t version = doc().version();
  // The frames and the navigations between them: a variant swap's writes (derived layers, an instance's symbol, layout)
  // keep them — only a layer made, removed or moved, or its interactions (extra), read the file again.
  bool stale = m.version == ~0ull;
  if (!stale && m.version != version) {
    std::vector<Document::ChangeRecord> changes;
    stale = !doc().changesSince(m.version, changes);
    for (const Document::ChangeRecord& c : changes)
      if (!c.id.isDerived() && (c.structural || (c.fields & (F_EXTRA | F_PARENT_INDEX)))) stale = true;
    if (!stale) m.version = version;
  }
  if (stale || m.page != page_ || m.flow != flow_ || m.start != startFrame_) {
    m.frames = computeSequence();
    m.version = version;
    m.page = page_;
    m.flow = flow_;
    m.start = startFrame_;
  }
  return m.frames;
}

std::vector<Guid> Player::upcoming() const {
  std::vector<Guid> out;
  std::unordered_set<Guid, GuidHash> seen{base_};
  auto add = [&](Guid id) {
    Guid top = id != kNoGuid ? topLevelOf(id) : kNoGuid;
    if (top != kNoGuid && seen.insert(top).second && frameExists(top)) out.push_back(top);
  };
  std::vector<std::pair<Navigation, Guid>> dests;
  std::vector<Guid> stack{base_};
  for (const Shown& o : overlays_) stack.push_back(o.frame);
  while (!stack.empty()) {
    Guid id = stack.back();
    stack.pop_back();
    const NodeProps* p = props(id);
    if (!p) continue;
    const NodeProps* m = p->type == NodeType::INSTANCE ? props(ed_.mainOf(id)) : nullptr;
    if (hasInteractions(*p) || (m && hasInteractions(*m)))
      for (auto& i : played(id))
        for (auto& a : i.actions) destinations(a, dests);
    for (Guid c : doc().children(id)) stack.push_back(c);
  }
  for (auto& d : dests) add(d.second);
  // → and ←.
  auto seq = sequence();
  if (auto it = std::find(seq.begin(), seq.end(), base_); it != seq.end()) {
    if (it + 1 != seq.end()) add(*(it + 1));
    if (it != seq.begin()) add(*(it - 1));
  }
  return out;
}

std::vector<Guid> Player::computeSequence() const {
  std::vector<Guid> frames;
  for (Guid c : screens(doc(), page_))
    if (frameExists(c) && props(c)->isFrameLike() && props(c)->type != NodeType::SECTION) frames.push_back(c);
  // Reading order: left to right, then top to bottom (R8 §9).
  // (On the page: a frame in a section is placed by the sections around it too.)
  auto onPage = [&](Guid id) {
    Mat2x3 m = props(id)->transform;
    for (Guid p = doc().parentOf(id); p != kNoGuid && p != page_ && props(p); p = doc().parentOf(p)) m = props(p)->transform * m;
    return m;
  };
  std::stable_sort(frames.begin(), frames.end(), [&](Guid a, Guid b) {
    Mat2x3 ta = onPage(a), tb = onPage(b);
    if (ta.m02 != tb.m02) return ta.m02 < tb.m02;
    return ta.m12 < tb.m12;
  });
  // With connections: the frames reachable from the flow's start, in the order they are reached.
  bool connected = false;
  std::function<void(Guid, std::vector<std::pair<Navigation, Guid>>&)> collect = [&](Guid id, std::vector<std::pair<Navigation, Guid>>& out) {
    const NodeProps* p = props(id);
    if (!p) return;
    // Only the destinations: no variable read (ix), and nothing read for a layer without interactions.
    const NodeProps* m = p->type == NodeType::INSTANCE ? props(ed_.mainOf(id)) : nullptr;
    if (hasInteractions(*p) || (m && hasInteractions(*m)))
      for (auto& i : played(id))
        for (auto& a : i.actions) destinations(a, out);
    for (Guid c : doc().children(id)) collect(c, out);
  };
  Guid startAt = flow_ != kNoGuid ? flow_ : startFrame_ != kNoGuid ? startFrame_ : (frames.empty() ? kNoGuid : frames[0]);
  if (startAt == kNoGuid) return frames;
  std::vector<Guid> order{startAt};
  std::unordered_set<Guid, GuidHash> seen{startAt};
  for (size_t i = 0; i < order.size(); i++) {
    std::vector<std::pair<Navigation, Guid>> dests;
    collect(order[i], dests);
    for (auto& [nav, d] : dests) {
      if (nav != Navigation::NAVIGATE) continue;
      Guid top = topLevelOf(d);
      connected = true;
      if (top != kNoGuid && frameExists(top) && seen.insert(top).second) order.push_back(top);
    }
  }
  return connected ? order : frames;
}

bool Player::next() {
  auto seq = sequence();
  auto it = std::find(seq.begin(), seq.end(), base_);
  if (it == seq.end() || it + 1 == seq.end()) return false;
  arrowReached_ = true;
  navigate(*(it + 1), Action{});
  arrowReached_ = false;
  return true;
}

bool Player::previous() {
  auto seq = sequence();
  auto it = std::find(seq.begin(), seq.end(), base_);
  if (it == seq.end() || it == seq.begin()) return false;
  arrowReached_ = true;
  navigate(*(it - 1), Action{});
  arrowReached_ = false;
  return true;
}

void Player::setScale(ScaleMode m) {
  scale_ = m;
  scaleChosen_ = true;
  dirty_ = true;
  if (active()) layout();
  events_.push_back(Event{});
}

std::vector<ScaleMode> Player::scaleOrder() const {
  // Figma's file classes (atlas 13 §10.1; the thresholds are the help's, Figma computes them in its C++): a device —
  // Fit device on screen, Zoom device to fill screen, Show device at 100%; PRESENTATION (a Presentation device or every
  // frame 16:9), LARGE (the first frame wider than 1024), SMALL (narrower), each with its order of the five.
  using S = ScaleMode;
  const NodeProps* pg = page_ != kNoGuid ? props(page_) : nullptr;
  Device dev = pg ? pageDevice(page_) : Device{};
  if (!dev.none) return {S::FIT, S::FILL, S::ACTUAL};
  bool wide = true;
  int frames = 0;
  if (pg)
    for (Guid c : screens(doc(), page_)) {
      const NodeProps* cp = props(c);
      if (!cp || !cp->visible || !cp->isFrameLike() || cp->type == NodeType::SECTION || cp->size.y <= 0) continue;
      frames++;
      wide &= std::fabs(cp->size.x / cp->size.y - 16.0 / 9.0) < 0.01;
    }
  if (dev.type == Device::Type::PRESENTATION || (frames > 0 && wide)) return {S::FILL, S::ACTUAL, S::FIT, S::FIT_WIDTH, S::RESPONSIVE};
  double first = 0;
  std::vector<Guid> seq = active() ? sequence() : std::vector<Guid>{};
  Guid firstFrame = !seq.empty() ? seq.front() : startFrame_;
  if (const NodeProps* fp = props(firstFrame)) first = fp->size.x;
  if (auto own = responsiveSizes_.find(firstFrame); own != responsiveSizes_.end()) first = own->second.x;
  if (first > 1024) return {S::ACTUAL, S::RESPONSIVE, S::FIT_WIDTH, S::FIT, S::FILL};
  return {S::ACTUAL, S::FIT, S::FIT_WIDTH, S::RESPONSIVE, S::FILL};
}

void Player::cycleScale() {
  // Z: the next option in the file's order.
  std::vector<ScaleMode> list = scaleOrder();
  size_t at = 0;
  for (size_t i = 0; i < list.size(); i++)
    if (list[i] == scale_) at = i;
  setScale(list[(at + 1) % list.size()]);
}

void Player::setResponsive(bool on) {
  responsive_ = on;
  dirty_ = true;
  if (active()) layout();
  events_.push_back(Event{});
}

void Player::setDeviceFrame(bool on) {
  deviceFrame_ = on;
  dirty_ = true;
  if (active()) layout();
  events_.push_back(Event{});
}

Device Player::pageDevice(Guid page) const {
  const NodeProps* p = page != kNoGuid ? props(page) : nullptr;
  return p && !ignoreDevice_ ? device(*p) : Device{};
}

void Player::setIgnoreDevice(bool on) {
  if (ignoreDevice_ == on) return;
  ignoreDevice_ = on;
  dirty_ = true;
  if (active()) layout();
  events_.push_back(Event{});
}

void Player::setBaseScroll(Vec2 offset, double windowTop) {
  if (!active() || !bare_) return;
  Vec2 range = topScrollRange(base_);
  Vec2 next{std::clamp(offset.x, 0.0, range.x), offset.y};
  Vec2& cur = scroll_[base_];
  if (cur.x == next.x && cur.y == next.y && windowTop_ == windowTop) return;
  windowTop_ = windowTop;
  stopFlings(base_);
  cur = next;
  dirty_ = true;
}

void Player::setBare(bool on) {
  if (bare_ == on) return;
  bare_ = on;
  // Out of bare: back within the range (the page may have left it above the frame's top)
  if (!on)
    if (auto it = scroll_.find(base_); it != scroll_.end()) it->second.y = std::max(0.0, it->second.y);
  dirty_ = true;
  if (active()) layout();
  events_.push_back(Event{});
}

bool Player::screenColor(Color& out) const {
  const NodeProps* p = base_ != kNoGuid ? props(base_) : nullptr;
  if (!p) return false;
  for (auto it = p->fillPaints.rbegin(); it != p->fillPaints.rend(); ++it) {
    if (it->type != PaintType::SOLID || !it->visible || it->color.a * it->opacity < 1) continue;
    out = it->color;
    out.a = 1;
    return true;
  }
  return false;
}

bool Player::hasDeviceFrame() const {
  if (page_ == kNoGuid || !props(page_)) return false;
  Device dev = pageDevice(page_);
  const DeviceSpec* spec = nullptr;
  const DeviceModel* model = nullptr;
  return dev.type == Device::Type::PRESET && !dev.none && findDevice(dev.preset, spec, model);
}

// ---- Geometry --------------------------------------------------------------------------------------------

void Player::layout() {
  const Viewport& vp = ed_.viewport();
  double W = std::max(1.0, vp.width), H = std::max(1.0, vp.height);
  Device dev = pageDevice(page_);
  // Website behaviours, breakpoints: under Responsive (no device) the screen's other size when the window crosses its
  // width — as a media query swaps a layout, at once, nothing recorded.
  bool switched = false;
  if (web_ && !fitting_ && dev.none && !anim_.active && responsiveOn()) {
    Guid to = breakpointFor(base_, W);
    if (to != base_ && frameExists(to)) {
      replaceScreen(to);
      switched = true;
    }
  }
  // Responsive: the frame takes the window's (or the device screen's) size first.
  if (!fitting_) {
    if (responsiveOn()) fitResponsive();
    else if (!responsiveSizes_.empty()) restoreResponsive(true);
  }
  const NodeProps* fp = props(base_);
  Vec2 frame = fp ? fp->size : Vec2{W, H};
  View v;
  if (!dev.none) {
    v.screen = dev.size;
    // The device frame around the screen (Show device frame, a preset we draw).
    DeviceFrame df;
    const DeviceSpec* spec = nullptr;
    const DeviceModel* model = nullptr;
    v.framed = deviceFrame_ && dev.type == Device::Type::PRESET && findDevice(dev.preset, spec, model);
    if (v.framed) df = proto::deviceFrame(*spec, *model, v.screen, dev.rotated);
    // The device on the window, with a margin when it is fitted (Figma leaves room around it).
    double margin = v.framed ? 32 : 0;
    double tw = v.screen.x + df.left + df.right, th = v.screen.y + df.top + df.bottom;
    double aw = std::max(1.0, W - 2 * margin), ah = std::max(1.0, H - 2 * margin);
    switch (scale_) {
      case ScaleMode::ACTUAL: v.s = 1; break;
      // Zoom device to fill screen: Figma's "contain" — the whole device, as large as the window takes it.
      case ScaleMode::FILL: v.s = std::min(W / tw, H / th); break;
      default: v.s = std::min(1.0, std::min(aw / tw, ah / th)); break;  // Fit device on screen: it shrinks, never grows
    }
    double ox = std::round((W - tw * v.s) / 2 + df.left * v.s), oy = std::round((H - th * v.s) / 2 + df.top * v.s);
    v.css = {ox, oy, v.screen.x * v.s, v.screen.y * v.s};
    v.toCss = Mat2x3::translate(ox, oy) * Mat2x3::scale(v.s);
    v.radius = v.framed ? df.screenRadius * v.s : 0;
    if (v.framed)
      for (const DeviceShape& sh : df.shapes) {
        PresentItem r;
        r.kind = PresentItem::Kind::Rect;
        r.rect = {ox + sh.rect.x * v.s, oy + sh.rect.y * v.s, sh.rect.w * v.s, sh.rect.h * v.s};
        r.color = sh.color;
        r.alpha = sh.color.a;
        r.color.a = 1;
        r.radius = sh.radius * v.s;
        r.border = sh.border;
        r.borderColor = sh.borderColor;
        (sh.over ? v.over : v.under).push_back(r);
      }
    view_ = std::move(v);
    if (!fitting_) fitOverlays();
    replaceOverlays();
    return;
  }
  double fw = std::max(1.0, frame.x), fh = std::max(1.0, frame.y);
  switch (scale_) {
    case ScaleMode::ACTUAL:
    case ScaleMode::RESPONSIVE: v.s = 1; break;
    // Figma's viewport modes (atlas 13 §10.1; live 2026-10-20 in the inline preview): Fit width is "scale-down-width"
    // (a narrower window shrinks the frame, a wider one leaves it at 100 %), Fit width and height "scale-down", Fill
    // screen "contain" (the whole frame, as large as the window takes it — never cropped).
    case ScaleMode::FIT_WIDTH: v.s = bare_ ? W / fw : std::min(1.0, W / fw); break;  // bare: the width, grown too
    case ScaleMode::FIT: v.s = std::min(1.0, std::min(W / fw, H / fh)); break;  // "It will not scale up the prototype"
    case ScaleMode::FILL: v.s = std::min(W / fw, H / fh); break;
  }
  // The screen is the frame, cut to what the window shows (a taller frame scrolls).
  v.screen = {std::min(fw, W / v.s), std::min(fh, H / v.s)};
  double cw = v.screen.x * v.s, ch = v.screen.y * v.s;
  double ox = std::round((W - cw) / 2), oy = std::round((H - ch) / 2);
  if (ch > H) oy = 0;
  if (cw > W) ox = 0;
  v.css = {ox, oy, cw, ch};
  v.toCss = Mat2x3::translate(ox, oy) * Mat2x3::scale(v.s);
  view_ = std::move(v);
  if (switched) {
    // The scroll carried from the other size, within this one's range.
    Vec2 range = topScrollRange(base_);
    if (auto it = scroll_.find(base_); it != scroll_.end()) it->second = {std::min(it->second.x, range.x), std::min(it->second.y, range.y)};
  }
  if (!fitting_) fitOverlays();
  replaceOverlays();
}

void Player::replaceOverlays() {
  // The window (or Responsive) changed the screen: overlays at a preset position go where it puts them now; with
  // Website behaviours a Manual one follows its hotspot (scrolled, re-laid out) and stays in the window, and Stack ones
  // queue at their edge.
  for (auto& o : overlays_) {
    if (web_ && o.settings.stack && o.settings.position != OverlayPosition::MANUAL && o.settings.position != OverlayPosition::CENTER) continue;
    if (o.settings.position != OverlayPosition::MANUAL) o.pos = overlayPos(o.frame, o.settings, nullptr, nullptr);
    else if (o.anchored) placeAnchored(o);
  }
  if (web_) stackOverlays();
  // An overlay coming in goes where its place went.
  if (anim_.active && anim_.slot >= 0 && anim_.slot < static_cast<int>(overlays_.size()) && anim_.y.overlay &&
      anim_.y.frame == overlays_[static_cast<size_t>(anim_.slot)].frame)
    anim_.y.pos = overlays_[static_cast<size_t>(anim_.slot)].pos;
}

// ---- Website behaviours: anchored overlays, toast stacks, breakpoints -------------------------------------

OverlayEdge Player::edgeOf(const OverlaySettings& s) const {
  // Absent: Keep in window while Website behaviours is on; off, always Figma's.
  if (!web_) return OverlayEdge::NONE;
  return s.edgeSet ? s.edge : OverlayEdge::AUTO;
}

bool Player::shownCss(Guid id, Mat2x3& out) const {
  Guid top = topLevelOf(id);
  if (top == kNoGuid) return false;
  std::vector<Guid> chain;
  for (Guid cur = id; cur != top; cur = doc().parentOf(cur)) {
    if (cur == kNoGuid || chain.size() > 4096) return false;
    chain.push_back(cur);
  }
  std::reverse(chain.begin(), chain.end());
  Mat2x3 m;
  Vec2 sc;
  bool firstFixed = !chain.empty() && props(chain[0]) && scrollBehavior(*props(chain[0])) == ScrollBehavior::FIXED;
  if (top == base_) {
    Side b = baseSide();
    // The screen's own scroll as the scene draws it (frameCss: the frame's share; its layers: the rest); its Fixed
    // children don't scroll.
    m = firstFixed ? fixedToCss() : frameCss(b);
    sc = firstFixed ? Vec2{} : b.scroll - topShift(base_, b.scroll);
  } else {
    const Shown* o = nullptr;
    for (const Shown& x : overlays_)
      if (x.frame == top) o = &x;
    if (!o) return false;
    Vec2 at = drawnPos(*o);
    m = view_.toCss * Mat2x3::translate(at.x, at.y);
    sc = scrollsNested(top) ? scrollOf(top) : Vec2{};
  }
  for (Guid c : chain) {
    const NodeProps* cp = props(c);
    if (!cp) return false;
    bool fixed = scrollBehavior(*cp) == ScrollBehavior::FIXED;
    if ((sc.x != 0 || sc.y != 0) && !fixed) m = m * Mat2x3::translate(-sc.x, -sc.y);
    m = m * cp->transform;
    sc = scrollsNested(c) ? scrollOf(c) : Vec2{};
  }
  out = m;
  return true;
}

void Player::anchor(Shown& s, const Hit& hotspot) {
  // Floating UI's reference element: the hotspot, found again by key as the page scrolls or re-lays out.
  Mat2x3 toScreen = view_.toCss.inverse();
  s.anchored = true;
  s.anchorKey = keyOf(hotspot.id);
  s.anchorAt = toScreen.apply(hotspot.toCss.apply({0, 0}));
  Rect css = transformedBounds(hotspot.toCss, hotspot.size.x, hotspot.size.y);
  double k = view_.s > 0 ? view_.s : 1;
  s.anchorBox = {(css.x - view_.css.x) / k, (css.y - view_.css.y) / k, css.w / k, css.h / k};
  s.placed = s.pos;
  placeAnchored(s);
}

void Player::placeAnchored(Shown& o) const {
  OverlayEdge edge = edgeOf(o.settings);
  if (!o.anchored || edge == OverlayEdge::NONE) return;
  Vec2 at = o.anchorAt;
  Rect box = o.anchorBox;
  Guid a = byKey(o.anchorKey);
  const NodeProps* ap = a != kNoGuid ? props(a) : nullptr;
  Mat2x3 m;
  if (ap && shownCss(a, m)) {
    // autoUpdate: where the hotspot is now.
    double k = view_.s > 0 ? view_.s : 1;
    at = view_.toCss.inverse().apply(m.apply({0, 0}));
    Rect css = transformedBounds(m, ap->size.x, ap->size.y);
    box = {(css.x - view_.css.x) / k, (css.y - view_.css.y) / k, css.w / k, css.h / k};
  }
  Vec2 pos = o.placed + (at - o.anchorAt);
  const NodeProps* p = props(o.frame);
  if (edge == OverlayEdge::AUTO && p) pos = keepInWindow(p->size, box, pos);
  if (o.settings.fitsWidth()) pos.x = 0;
  if (o.settings.fitsHeight()) pos.y = 0;
  o.pos = pos;
}

Vec2 Player::keepInWindow(Vec2 size, const Rect& anchor, Vec2 at) const {
  // Floating UI's flip() then shift(): an overlay running past the window's edge goes to the other side of its hotspot
  // (mirrored about the hotspot's centre: below with a gap → above with the same gap) when that runs past less; then it
  // is moved inside the window, 8 px from its edges.
  constexpr double kMargin = 8;
  double W = view_.screen.x, H = view_.screen.y;
  auto overflow = [&](double pos, double len, double room) { return std::max(0.0, kMargin - pos) + std::max(0.0, pos + len - (room - kMargin)); };
  auto flip = [&](double pos, double len, double a0, double alen, double room) {
    double mirrored = 2 * a0 + alen - pos - len;
    double now = overflow(pos, len, room);
    return now > 0 && overflow(mirrored, len, room) < now ? mirrored : pos;
  };
  at.y = flip(at.y, size.y, anchor.y, anchor.h, H);
  at.x = flip(at.x, size.x, anchor.x, anchor.w, W);
  auto shift = [&](double pos, double len, double room) { return std::max(kMargin, std::min(pos, room - kMargin - len)); };
  at.x = shift(at.x, size.x, W);
  at.y = shift(at.y, size.y, H);
  return at;
}

void Player::stackOverlays() {
  // Toasts: Stack overlays at one preset position, the newest at its edge, the older ones further in (a bottom
  // position stacks upwards, a top one downwards), `gap` apart. A change of place slides with the overlay's own
  // transition curve (its opening one; Instant: ease out, 0.25 s).
  const OverlayPosition positions[] = {OverlayPosition::TOP_LEFT, OverlayPosition::TOP_CENTER, OverlayPosition::TOP_RIGHT,
                                       OverlayPosition::BOTTOM_LEFT, OverlayPosition::BOTTOM_CENTER, OverlayPosition::BOTTOM_RIGHT};
  for (OverlayPosition at : positions) {
    bool top = at == OverlayPosition::TOP_LEFT || at == OverlayPosition::TOP_CENTER || at == OverlayPosition::TOP_RIGHT;
    double offset = 0;
    for (size_t k = overlays_.size(); k-- > 0;) {
      Shown& o = overlays_[k];
      if (!o.settings.stack || o.settings.position != at) continue;
      const NodeProps* p = props(o.frame);
      if (!p) continue;
      Vec2 target = overlayPos(o.frame, o.settings, nullptr, nullptr);
      target.y += top ? offset : -offset;
      offset += p->size.y + o.settings.stackGap;
      if (std::fabs(target.x - o.pos.x) < 0.01 && std::fabs(target.y - o.pos.y) < 0.01) continue;
      bool coming = anim_.active && anim_.slot == static_cast<int>(k) && anim_.y.frame == o.frame;
      Vec2 from = drawnPos(o);
      o.pos = target;
      slides_.erase(std::remove_if(slides_.begin(), slides_.end(), [&](const Slide& x) { return x.frame == o.frame; }), slides_.end());
      if (coming) continue;
      Slide sl;
      sl.frame = o.frame;
      sl.from = from;
      sl.to = target;
      sl.action = o.opened;
      if (sl.action.transition == Transition::INSTANT || durationOf(sl.action) <= 0) {
        sl.action = Action{};
        sl.action.transition = Transition::DISSOLVE;
        sl.action.easing = Easing::OUT_CUBIC;
        sl.action.duration = 0.25;
      }
      sl.duration = durationOf(sl.action) * 1000;
      slides_.push_back(sl);
      dirty_ = true;
    }
  }
}

Vec2 Player::drawnPos(const Shown& o) const {
  for (const Slide& sl : slides_) {
    if (sl.frame != o.frame) continue;
    double t = !sl.started ? 0 : sl.duration > 0 ? std::clamp((clock_ - sl.start) / sl.duration, 0.0, 1.0) : 1;
    double e = ease(sl.action, t);
    return {lerp(sl.from.x, sl.to.x, e), lerp(sl.from.y, sl.to.y, e)};
  }
  return o.pos;
}

namespace {

std::string lowered(std::string s) {
  for (char& c : s) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  return s;
}

std::string trimmed(const std::string& s) {
  size_t b = 0, e = s.size();
  while (b < e && s[b] == ' ') b++;
  while (e > b && s[e - 1] == ' ') e--;
  return s.substr(b, e - b);
}

// A frame name's group and size ("Home / Desktop" → "Home", "Desktop"; "Home" → "Home", "").
std::pair<std::string, std::string> breakpointName(const std::string& name) {
  size_t slash = name.rfind('/');
  if (slash == std::string::npos) return {trimmed(name), std::string()};
  return {trimmed(name.substr(0, slash)), trimmed(name.substr(slash + 1))};
}

// The part after the group names a size: a device class or a width ("Desktop", "Mobile 390", "1440", "md"). A flow's
// step ("Checkout / 2", "Checkout / Payment") does not.
bool sizeWord(const std::string& part) {
  if (part.empty()) return true;
  static const char* const kWords[] = {"desktop", "laptop", "tablet", "mobile", "phone", "web", "wide", "narrow", "compact", "large",
                                       "medium", "small", "xl", "lg", "md", "sm", "xs", "xxl", "ipad", "iphone", "android", "tv",
                                       "landscape", "portrait", "breakpoint"};
  auto known = [&](std::string t) {
    if (t.size() > 2 && t.compare(t.size() - 2, 2, "px") == 0) t = t.substr(0, t.size() - 2);
    if (t.empty()) return false;
    bool digits = std::all_of(t.begin(), t.end(), [](char c) { return c >= '0' && c <= '9'; });
    if (digits) return t.size() <= 5 && std::atoi(t.c_str()) >= 240;  // a width, not a step number
    for (const char* w : kWords)
      if (t == w) return true;
    return false;
  };
  std::string token;
  for (char c : lowered(part) + " ") {
    if (c == ' ' || c == '-' || c == '_' || c == '(' || c == ')' || c == ',') {
      if (known(token)) return true;
      token.clear();
    } else {
      token += c;
    }
  }
  return false;
}

}  // namespace

Guid Player::breakpointFor(Guid frame, double width) const {
  BreakpointMemo& m = breakpoint_;
  if (m.version == doc().version() && m.frame == frame && m.width == width && m.page == page_) return m.result;
  m.version = doc().version();
  m.frame = frame;
  m.width = width;
  m.page = page_;
  m.result = frame;
  const NodeProps* fp = props(frame);
  if (!fp || page_ == kNoGuid) return frame;
  auto [group, size] = breakpointName(fp->name);
  if (group.empty() || !sizeWord(size)) return frame;
  auto own = [&](Guid id) {
    auto it = responsiveSizes_.find(id);
    return it != responsiveSizes_.end() ? it->second.x : props(id)->size.x;
  };
  // The group: top-level frames with the same name, or the same name before " / " and a size after it.
  std::vector<Guid> members;
  for (Guid c : screens(doc(), page_)) {
    const NodeProps* cp = props(c);
    if (!cp || !frameExists(c) || !cp->isFrameLike() || cp->type == NodeType::SECTION) continue;
    if (c == frame || cp->name == fp->name) {
      members.push_back(c);
      continue;
    }
    auto [g, z] = breakpointName(cp->name);
    if (g == group && sizeWord(z)) members.push_back(c);
  }
  if (members.size() < 2) return frame;
  // Each size takes over half way between its width and the next narrower one's (its min width, as Sites'
  // breakpointMinWidth would hold it; the narrowest from 0): a 1440 desktop and a 390 mobile switch at 915 — a desktop
  // design squeezed in a 1300 window, the mobile one stretched in an 800 one, as a site with a ~768–1024 breakpoint.
  std::vector<double> widths;
  for (Guid c : members) widths.push_back(own(c));
  std::sort(widths.begin(), widths.end());
  widths.erase(std::unique(widths.begin(), widths.end(), [](double a, double b) { return std::fabs(a - b) <= 0.5; }), widths.end());
  if (widths.size() < 2) return frame;  // sizes alike: not breakpoints
  double chosen = widths.front();
  for (size_t i = 1; i < widths.size(); i++)
    if (width + 0.5 >= (widths[i - 1] + widths[i]) / 2) chosen = widths[i];
  Guid pick = frame;
  if (std::fabs(own(frame) - chosen) > 0.5)
    for (Guid c : members)
      if (std::fabs(own(c) - chosen) <= 0.5) {
        pick = c;
        break;
      }
  m.result = pick;
  return pick;
}

void Player::replaceScreen(Guid to) {
  // A media query's swap: the other size at once (no history entry, no transition); hovers on the old one are undone,
  // component states and scroll positions carried by semantic path as a navigation carries them; variables are global.
  if (to == base_ || !frameExists(to)) return;
  ed_.deriveTree(to);
  Guid left = base_;
  dropTimers(left);
  leaveHeld();
  hoverChain_ = Chain{};
  base_ = to;
  Action a;
  a.stateVersion = 1;
  carryComponentStates(to, a);
  carryScroll(left, to, a);
  armTimers(base_);
  startTimeline();
  changed();
}

// ---- Responsive -----------------------------------------------------------------------------------------

bool Player::responsiveOn() const {
  if (page_ == kNoGuid || !props(page_)) return false;
  Device dev = pageDevice(page_);
  return dev.none ? scale_ == ScaleMode::RESPONSIVE : responsive_;
}

void Player::fitResponsive() {
  // "The contents of the prototype will resize and re-layout as the prototype viewer resizes according to the
  // constraints and auto layout properties applied to the design": the frames shown take the window's width (the
  // device screen's); their children follow by their constraints and auto layout (the editor's layout runs on a user
  // write — the player's engine is its own, its undo never used; the sizes go back when Responsive is turned off or
  // the presentation stops).
  // Height (docs/engine.md §3.4). With a device, Figma's: the screen's height when the frame is no taller (a taller
  // one keeps its height and scrolls). Without one (the window is the viewport), Wecra's web page rule — Figma keeps
  // the frame's height there, so an app shell taller than the window never fits it:
  //   - a frame that scrolls inside itself (overflow Vertical or Both: the app-shell pattern) is `height: 100vh` —
  //     the window's height; its sidebar (Top & Bottom / Scale / Fill) follows, what runs past it scrolls inside
  //     (topScrollRange);
  //   - any other frame is `min-height: 100vh` — max(its height, the window's): a short page fills the window, a
  //     long one keeps its height and scrolls as a whole.
  const Viewport& vp = ed_.viewport();
  Device dev = pageDevice(page_);
  Vec2 target = dev.none ? Vec2{std::max(1.0, vp.width), std::max(1.0, vp.height)} : dev.size;
  std::vector<Guid> frames{base_};
  if (anim_.active) {
    frames.push_back(anim_.x.frame);
    frames.push_back(anim_.y.frame);
  }
  std::vector<NodeChange> changes;
  // The screen's own width before Responsive (its overlays designed to its width follow the window as it does).
  Vec2 baseOwn;
  if (const NodeProps* bp = props(base_)) {
    auto bt = responsiveSizes_.find(base_);
    baseOwn = bt != responsiveSizes_.end() ? bt->second : bp->size;
  }
  for (auto& o : overlays_) frames.push_back(o.frame);
  std::unordered_set<Guid, GuidHash> done;
  for (Guid f : frames) {
    const NodeProps* p = props(f);
    if (!p || !done.insert(f).second || (anim_.active && anim_.x.overlay && f == anim_.x.frame)) continue;
    bool isOverlay = false;
    for (auto& o : overlays_) isOverlay |= o.frame == f;
    auto it = responsiveSizes_.find(f);
    Vec2 own = it != responsiveSizes_.end() ? it->second : p->size;
    if (isOverlay && fittedOverlay(f)) continue;  // fitOverlays sizes it
    Vec2 want{std::round(target.x), own.y <= target.y ? std::round(target.y) : own.y};
    if (dev.none && !isOverlay) {
      Overflow ov = overflow(*p);
      if (ov == Overflow::VERTICAL || ov == Overflow::BOTH) want.y = std::round(target.y);
    }
    if (isOverlay) {
      // An overlay keeps its size, except along a side it shares with its screen (a full-width sheet, a full-height
      // drawer): that side follows the window and its layers follow their constraints (unverified: Figma doesn't say).
      want = own;
      if (baseOwn.x > 0 && std::fabs(own.x - baseOwn.x) < 0.5) want.x = std::round(target.x);
      if (baseOwn.y > 0 && std::fabs(own.y - baseOwn.y) < 0.5 && own.y <= target.y) want.y = std::round(target.y);
    }
    if (std::fabs(p->size.x - want.x) < 0.5 && std::fabs(p->size.y - want.y) < 0.5) continue;
    if (it == responsiveSizes_.end()) responsiveSizes_.emplace(f, own);
    NodeChange c = NodeChange::changed(f);
    c.mask = F_SIZE;
    c.props.size = want;
    c.guid = f;
    changes.push_back(std::move(c));
  }
  if (changes.empty()) return;
  fitting_ = true;
  for (const NodeChange& c : changes) ed_.setProps({c.guid}, c, 0);
  fitting_ = false;
  dirty_ = true;
}

void Player::restoreResponsive(bool keepFitted) {
  if (responsiveSizes_.empty()) return;
  std::vector<NodeChange> changes;
  for (auto it = responsiveSizes_.begin(); it != responsiveSizes_.end();) {
    auto [f, size] = *it;
    // Responsive turned off: an open overlay that fits the window stays fitted (fitOverlays sizes it from its own).
    if (keepFitted && fittedOverlay(f)) {
      ++it;
      continue;
    }
    it = responsiveSizes_.erase(it);
    if (!doc().has(f)) continue;
    NodeChange c = NodeChange::changed(f);
    c.mask = F_SIZE;
    c.props.size = size;
    changes.push_back(std::move(c));
  }
  if (changes.empty()) return;
  fitting_ = true;
  for (const NodeChange& c : changes) ed_.setProps({c.guid}, c, 0);
  fitting_ = false;
  dirty_ = true;
}

bool Player::fittedOverlay(Guid frame) const {
  const NodeProps* p = props(frame);
  if (!p || overlaySettings(*p).fit == OverlayFit::NONE) return false;
  for (const auto& o : overlays_)
    if (o.frame == frame) return true;
  return false;
}

void Player::fitOverlays(Guid opening) {
  // Wecra's overlay "Fit to window" (an @ours field Figma's export never writes; docs/engine.md §3.4): a drawer taller
  // than the window takes the screen's height (Height), a sheet its width (Width), or both; its layers follow their
  // constraints and auto layout, what runs past it scrolls inside when it has an overflow. Other sides as Responsive
  // leaves them (an overlay keeps its size, except a side it shares with its screen).
  std::vector<Guid> frames;
  for (const auto& o : overlays_) frames.push_back(o.frame);
  if (opening != kNoGuid) frames.push_back(opening);
  if (frames.empty()) return;
  bool resp = responsiveOn();
  Device dev = pageDevice(page_);
  const Viewport& vp = ed_.viewport();
  Vec2 target = dev.none ? Vec2{std::max(1.0, vp.width), std::max(1.0, vp.height)} : dev.size;
  Vec2 baseOwn;
  if (const NodeProps* bp = props(base_)) {
    auto bt = responsiveSizes_.find(base_);
    baseOwn = bt != responsiveSizes_.end() ? bt->second : bp->size;
  }
  std::vector<NodeChange> changes;
  for (Guid f : frames) {
    const NodeProps* p = props(f);
    if (!p || (anim_.active && anim_.x.overlay && f == anim_.x.frame)) continue;
    OverlaySettings st = overlaySettings(*p);
    if (st.fit == OverlayFit::NONE) continue;
    auto it = responsiveSizes_.find(f);
    Vec2 own = it != responsiveSizes_.end() ? it->second : p->size;
    Vec2 want = own;
    if (resp) {
      if (baseOwn.x > 0 && std::fabs(own.x - baseOwn.x) < 0.5) want.x = std::round(target.x);
      if (baseOwn.y > 0 && std::fabs(own.y - baseOwn.y) < 0.5 && own.y <= target.y) want.y = std::round(target.y);
    }
    if (st.fitsWidth()) want.x = std::max(1.0, std::round(view_.screen.x));
    if (st.fitsHeight()) want.y = std::max(1.0, std::round(view_.screen.y));
    if (std::fabs(p->size.x - want.x) < 0.5 && std::fabs(p->size.y - want.y) < 0.5) continue;
    if (it == responsiveSizes_.end()) responsiveSizes_.emplace(f, own);
    NodeChange c = NodeChange::changed(f);
    c.mask = F_SIZE;
    c.props.size = want;
    changes.push_back(std::move(c));
  }
  if (changes.empty()) return;
  fitting_ = true;
  for (const NodeChange& c : changes) ed_.setProps({c.guid}, c, 0);
  fitting_ = false;
  dirty_ = true;
}

Vec2 Player::topScrollRange(Guid frame) const {
  // Figma's viewer (`NodeScrollingLogic`): the shown top-level frame scrolls both ways (scrollDirection BOTH); its box
  // is the frame cut to the screen (resized to fit the viewport) and its content is, with "No scrolling", the frame
  // itself, otherwise that box plus every child that isn't Fixed (a frame whose content runs past its bottom scrolls
  // that content), along the overflow's axis only (Vertical keeps the box's width, Horizontal its height). Range =
  // content's end − the box's end, per axis. (Content above or left of the frame — Figma's negative minimum — isn't
  // reached; nested frames don't reach it either.)
  const NodeProps* p = props(frame);
  if (!p) return {};
  Overflow o = overflow(*p);
  Vec2 box{std::min(p->size.x, view_.screen.x), std::min(p->size.y, view_.screen.y)};
  if (o == Overflow::NONE) return {std::max(0.0, p->size.x - box.x), std::max(0.0, p->size.y - box.y)};
  double right = 0, bottom = 0;
  for (Guid c : doc().children(frame)) {
    const NodeProps* cp = props(c);
    if (!cp || !cp->visible || scrollBehavior(*cp) == ScrollBehavior::FIXED) continue;
    Rect b = transformedBounds(cp->transform, cp->size.x, cp->size.y);
    right = std::max(right, b.right());
    bottom = std::max(bottom, b.bottom());
  }
  // Auto layout: the padding after the last child belongs to the content (as a nested frame's).
  if (p->isAutoLayout()) {
    right += p->stack().stackPaddingRight;
    bottom += p->stack().stackPaddingBottom;
  }
  right = std::max(right, box.x);
  bottom = std::max(bottom, box.y);
  Vec2 r;
  if (o == Overflow::HORIZONTAL || o == Overflow::BOTH) r.x = std::max(0.0, right - box.x);
  if (o == Overflow::VERTICAL || o == Overflow::BOTH) r.y = std::max(0.0, bottom - box.y);
  return r;
}

Vec2 Player::topShift(Guid frame, Vec2 scroll) const {
  // A top-level frame bigger than the screen moves under it until its far edge meets the screen's; scrolling past
  // that (content running beyond the frame) — or bouncing past either end — moves its layers inside it instead.
  const NodeProps* p = props(frame);
  if (!p) return {};
  Vec2 room{std::max(0.0, p->size.x - view_.screen.x), std::max(0.0, p->size.y - view_.screen.y)};
  return {std::clamp(scroll.x, 0.0, room.x), std::clamp(scroll.y, 0.0, room.y)};
}

Vec2 Player::nestedScrollRange(Guid frame) const {
  const NodeProps* p = props(frame);
  if (!p) return {};
  Overflow o = overflow(*p);
  if (o == Overflow::NONE) return {};
  double right = 0, bottom = 0;
  for (Guid c : doc().children(frame)) {
    const NodeProps* cp = props(c);
    if (!cp || !cp->visible || scrollBehavior(*cp) == ScrollBehavior::FIXED) continue;
    Rect b = transformedBounds(cp->transform, cp->size.x, cp->size.y);
    right = std::max(right, b.right());
    bottom = std::max(bottom, b.bottom());
  }
  // Auto layout: the padding after the last child belongs to the content.
  if (p->isAutoLayout()) {
    right += p->stack().stackPaddingRight;
    bottom += p->stack().stackPaddingBottom;
  }
  Vec2 r;
  if (o == Overflow::HORIZONTAL || o == Overflow::BOTH) r.x = std::max(0.0, right - p->size.x);
  if (o == Overflow::VERTICAL || o == Overflow::BOTH) r.y = std::max(0.0, bottom - p->size.y);
  return r;
}

bool Player::scrollsNested(Guid id) const {
  const NodeProps* p = props(id);
  return p && p->isFrameLike() && overflow(*p) != Overflow::NONE;
}

Vec2 Player::scrollOf(Guid frame) const {
  auto it = scroll_.find(frame);
  return it == scroll_.end() ? Vec2{} : it->second;
}

Player::Side Player::baseSide() const {
  Side s;
  s.frame = base_;
  s.scroll = scrollOf(base_);
  return s;
}

Mat2x3 Player::frameCss(const Side& s) const {
  if (s.overlay) return view_.toCss * Mat2x3::translate(s.pos.x, s.pos.y);
  Vec2 f = topShift(s.frame, s.scroll);
  return view_.toCss * Mat2x3::translate(-f.x, -f.y);
}

Vec2 Player::overlayPos(Guid frame, const OverlaySettings& s, const Action* a, const Hit* hotspot) const {
  // Fit to window: a fitted side starts at the screen's edge (it spans the screen); the other side keeps the position
  // (a manual offset too).
  Vec2 at = overlayPlace(frame, s, a, hotspot);
  if (s.fitsWidth()) at.x = 0;
  if (s.fitsHeight()) at.y = 0;
  return at;
}

Vec2 Player::overlayPlace(Guid frame, const OverlaySettings& s, const Action* a, const Hit* hotspot) const {
  const NodeProps* p = props(frame);
  Vec2 o = p ? p->size : Vec2{};
  double W = view_.screen.x, H = view_.screen.y;
  switch (s.position) {
    case OverlayPosition::CENTER: return {(W - o.x) / 2, (H - o.y) / 2};
    case OverlayPosition::TOP_LEFT: return {0, 0};
    case OverlayPosition::TOP_CENTER: return {(W - o.x) / 2, 0};
    case OverlayPosition::TOP_RIGHT: return {W - o.x, 0};
    case OverlayPosition::BOTTOM_LEFT: return {0, H - o.y};
    case OverlayPosition::BOTTOM_CENTER: return {(W - o.x) / 2, H - o.y};
    case OverlayPosition::BOTTOM_RIGHT: return {W - o.x, H - o.y};
    case OverlayPosition::MANUAL: {
      Vec2 at;
      if (hotspot) {
        Vec2 css = hotspot->toCss.apply({0, 0});
        at = view_.toCss.inverse().apply(css);
      }
      if (a && a->hasOverlayOffset) at = at + a->overlayOffset;
      return at;
    }
  }
  return {};
}

// ---- Hit-testing -----------------------------------------------------------------------------------------

std::vector<Guid> Player::topmostFirst(Guid id) const {
  // Paint order backwards: the last child is on top, unless an auto-layout parent stacks "First on top"
  // (stackReverseZIndex) — then the first one is (Document::paintsBefore, RenderTree's paint order).
  const auto& kids = doc().children(id);
  const NodeProps* p = props(id);
  if (p && p->stack().stackReverseZIndex && p->isAutoLayout()) return kids;
  return std::vector<Guid>(kids.rbegin(), kids.rend());
}

PropsOverrides Player::stuckOf(Guid frame, bool topLevel, Vec2 topScroll) const {
  PropsOverrides out;
  std::function<void(Guid, bool)> walk = [&](Guid id, bool root) {
    const NodeProps* p = props(id);
    if (!p || !p->visible) return;
    if (root && topLevel) stick(id, topScroll.y + (bare_ ? windowTop_ : 0), out);
    else if (scrollsNested(id)) stick(id, scrollOf(id).y, out);
    for (Guid c : doc().children(id)) walk(c, false);
  };
  walk(frame, true);
  return out;
}

bool Player::hitWalk(Guid id, const Mat2x3& parentCss, Vec2 css, std::vector<Hit>& out, bool root, Vec2 rootScroll,
                     const PropsOverrides* stuck) const {
  const NodeProps* p = props(id);
  if (!p || !p->visible || ghosts_.count(id)) return false;
  // Scrolling: the same offsets the scene draws with (a stuck layer where its stick moved it).
  const Mat2x3* tf = &p->transform;
  if (stuck && !root)
    if (auto it = stuck->find(id); it != stuck->end()) tf = &it->second.transform;
  Mat2x3 m = root ? parentCss : parentCss * *tf;
  Vec2 local = m.inverse().apply(css);
  bool inside = local.x >= 0 && local.y >= 0 && local.x <= p->size.x && local.y <= p->size.y;
  if (p->clipsContent() && !inside) return false;
  // Children, topmost first; a nested scrolling frame's children are offset by its scroll.
  Mat2x3 childBase = m;
  // The shown screen's layers by the part of its scroll the frame doesn't take (`rootScroll`).
  Vec2 sc = root ? rootScroll : scrollsNested(id) ? scrollOf(id) : Vec2{};
  // Topmost first, as the scene paints them (Canvas stacking "First on top" included: the owner's "homesearch" lays its
  // "finder-segmented" over its "adv-banner" so — read last-first, every click on the segments went to the banner).
  const std::vector<Guid> kids = topmostFirst(id);
  // A nested scrolling frame's Fixed children are drawn above its other children: hit first.
  bool nestedScroll = !root && scrollsNested(id);
  for (int pass = nestedScroll ? 0 : 1; pass < 2; pass++)
    for (auto it = kids.begin(); it != kids.end(); ++it) {
      const NodeProps* cp = props(*it);
      bool fixed = cp && scrollBehavior(*cp) == ScrollBehavior::FIXED;
      if (nestedScroll && (pass == 0) != fixed) continue;
      Mat2x3 cb = childBase;
      if (cp && (sc.x != 0 || sc.y != 0) && !fixed) cb = childBase * Mat2x3::translate(-sc.x, -sc.y);
      if (hitWalk(*it, cb, css, out, false, {}, stuck)) {
        out.push_back({id, m, p->size});
        return true;
      }
    }
  if (!inside) return false;
  out.push_back({id, m, p->size});
  return true;
}

Player::Chain Player::hitTest(Vec2 css) const {
  Chain c;
  if (!view_.css.contains(css)) return c;
  for (int k = static_cast<int>(overlays_.size()) - 1; k >= 0; k--) {
    Side s;
    s.frame = overlays_[static_cast<size_t>(k)].frame;
    s.pos = drawnPos(overlays_[static_cast<size_t>(k)]);
    s.overlay = true;
    std::vector<Hit> hits;
    PropsOverrides stuck = stuckOf(s.frame, false, {});
    if (hitWalk(s.frame, frameCss(s), css, hits, true, {}, stuck.empty() ? nullptr : &stuck)) {
      c.hits = std::move(hits);
      c.layer = k;
      return c;
    }
    // An overlay with a background covers the screen under it.
    if (overlays_[static_cast<size_t>(k)].settings.background) {
      c.layer = k;
      return c;
    }
  }
  Side b = baseSide();
  // The base's fixed children don't scroll.
  std::vector<Hit> hits;
  const NodeProps* bp = props(base_);
  if (bp) {
    const std::vector<Guid> kids = topmostFirst(base_);
    for (auto it = kids.begin(); it != kids.end(); ++it) {
      const NodeProps* cp = props(*it);
      if (!cp || scrollBehavior(*cp) != ScrollBehavior::FIXED) continue;
      if (hitWalk(*it, fixedToCss(), css, hits, false)) {
        hits.push_back({base_, view_.toCss, bp->size});
        c.hits = std::move(hits);
        c.layer = -1;
        return c;
      }
    }
  }
  hits.clear();
  PropsOverrides stuck = stuckOf(base_, true, b.scroll);
  if (hitWalk(base_, frameCss(b), css, hits, true, b.scroll - topShift(base_, b.scroll), stuck.empty() ? nullptr : &stuck)) {
    c.hits = std::move(hits);
    c.layer = -1;
  }
  return c;
}

// ---- Input -----------------------------------------------------------------------------------------------

bool Player::fire(Guid node, Trigger t, const Hit* hotspot, Held* held) {
  if (!hasIx(node)) return false;
  // Website behaviours: a disabled instance runs nothing (its parent's interactions still do).
  if (web_ && disabled(node)) return false;
  bool any = false;
  auto list = ix(node);
  // Every interaction of the trigger runs, in the list's order: an instance's inherited ones (its component's own
  // state change) before its own (an overlay, a navigation…) — Wecra's web rule, docs/engine.md §3.4. A Change to
  // above may give the layer a new id: the next ones run from the layer by its key.
  const std::string key = list.size() > 1 ? keyOf(node) : std::string();
  for (size_t k = 0; k < list.size(); k++) {
    if (k > 0 && !doc().has(node) && !key.empty())
      if (Guid again = byKey(key); again != kNoGuid) node = again;
    const Interaction& i = list[k];
    // The legacy Mouse in / Mouse out play as Mouse enter / Mouse leave (Figma reads them so).
    bool match = i.trigger == t || (t == Trigger::MOUSE_ENTER && i.trigger == Trigger::MOUSE_IN) ||
                 (t == Trigger::MOUSE_LEAVE && i.trigger == Trigger::MOUSE_OUT);
    if (!match) continue;
    any = true;
    if (hasDelay(i.trigger) && i.delay > 0) {
      Delayed d;
      d.node = node;
      d.interaction = k;
      d.trigger = t;
      d.delayMs = i.delay * 1000;
      if (hotspot) d.hotspot = *hotspot;
      d.actions = actionCounter_;
      delayed_.push_back(d);
      continue;
    }
    run(node, i.actions, hotspot, held);
  }
  return any;
}

void Player::cancelDelayed(Trigger t, Guid node) {
  delayed_.erase(std::remove_if(delayed_.begin(), delayed_.end(),
                                [&](const Delayed& d) { return d.trigger == t && (node == kNoGuid || d.node == node); }),
                 delayed_.end());
}

void Player::hover(const Chain& in, bool live) {
  // Every layer under the pointer gets its own hover, as a web page's :hover / mouseenter / mouseleave do (the owner's
  // nested interactive components, 2026-10-21): the inner button's and the outer card's apply together; leaving the
  // inner keeps the outer hovered. Figma's viewer (`mP`) stops at the first enter / leave that changes something and runs
  // While hovering only on the deepest hover hotspot — one level at a time; we go further on purpose (docs/engine.md
  // §3.4 "Nested interactive components"). A change of the screen (navigate, overlay) still ends the round.
  Chain c = in;
  keyChain(c);
  auto has = [](const Chain& ch, const std::string& k) { return std::find(ch.keys.begin(), ch.keys.end(), k) != ch.keys.end(); };
  // A delayed Mouse enter waits for the pointer to stay; a delayed Mouse leave for it to stay away.
  for (size_t i = 0; i < hoverChain_.hits.size(); i++)
    if (i >= hoverChain_.keys.size() || !has(c, hoverChain_.keys[i])) cancelDelayed(Trigger::MOUSE_ENTER, hoverChain_.hits[i].id);
  for (size_t i = 0; i < c.hits.size(); i++)
    if (!has(hoverChain_, c.keys[i])) cancelDelayed(Trigger::MOUSE_LEAVE, c.hits[i].id);
  const uint64_t shown = screenSignature();
  auto screenChanged = [&] { return screenSignature() != shown; };
  // The layer a key of the last chain names now (its id, unless a change above it gave it another).
  auto now = [&](const Hit& h, const std::string& k) {
    if (doc().has(h.id) && keyOf(h.id) == k) return h.id;
    return byKey(k);
  };
  // Left: Mouse leave on every layer the pointer left, inner to outer.
  Chain before = hoverChain_;
  const uint64_t version0 = doc().version();
  for (size_t i = 0; i < before.hits.size() && i < before.keys.size() && !screenChanged(); i++) {
    if (has(c, before.keys[i])) continue;
    Hit h = before.hits[i];
    h.id = now(h, before.keys[i]);
    if (h.id != kNoGuid) fire(h.id, Trigger::MOUSE_LEAVE, &h);
  }
  // While hovering undone where the pointer is no longer over its layer: the innermost first (the reverse of the order
  // they were made in), so an outer state goes back after the inner ones it holds.
  auto under = [&](const Held& x) {
    if (!x.anchorKey.empty()) return has(c, x.anchorKey);
    for (auto& h : c.hits)
      if (h.id == x.anchor) return true;
    return false;
  };
  for (size_t i = held_.size(); i-- > 0;) {
    if (i >= held_.size() || under(held_[i])) continue;
    Held h = std::move(held_[i]);
    held_.erase(held_.begin() + static_cast<long>(i));
    for (auto it = h.revert.rbegin(); it != h.revert.rend(); ++it) (*it)();
  }
  auto rehit = [&] {
    if (!live) return;
    c = hitTest(hoverCss_);
    keyChain(c);
  };
  if (!screenChanged() && doc().version() != version0) rehit();  // what the leaves and reverts changed under the pointer
  // Entered: Mouse enter on every layer newly under the pointer, then While hovering on every layer under it that has
  // one and isn't hovered yet — outer to inner, the chain hit-tested again after a change (an outer state's new layers
  // are under the pointer now; an inner one's ids changed).
  std::unordered_set<std::string> seen;
  for (int round = 0; round < 64 && !screenChanged(); round++) {
    bool again = false;
    for (size_t j = c.hits.size(); j-- > 0;) {
      const std::string k = c.keys[j];
      if (!seen.insert(k).second) continue;
      Hit h = c.hits[j];
      uint64_t version = doc().version();
      if (!has(before, k)) fire(h.id, Trigger::MOUSE_ENTER, &h);
      if (!screenChanged() && doc().has(h.id)) whileHovering(h, k);
      if (screenChanged()) break;
      if (doc().version() != version && live) {
        rehit();
        again = true;
        break;
      }
    }
    if (!again) break;
  }
  hoverChain_ = c;
  // The pointer is a hand over anything that reacts to a click, and over links.
  bool hand = linkAt(c, hoverCss_) != nullptr;
  for (auto& h : c.hits) {
    if (!hasIx(h.id)) continue;
    for (auto& i : ix(h.id))
      hand |= i.trigger == Trigger::ON_CLICK || i.trigger == Trigger::ON_PRESS || i.trigger == Trigger::MOUSE_DOWN ||
              i.trigger == Trigger::MOUSE_UP || i.trigger == Trigger::DRAG || i.trigger == Trigger::ON_DOUBLE_CLICK;
  }
  if (hand != hotspot_) {
    hotspot_ = hand;
    events_.push_back(Event{});
  }
  updateCursor(c);
}

void Player::whileHovering(const Hit& h, const std::string& key) {
  if (!hasIx(h.id) || (web_ && disabled(h.id))) return;
  std::vector<Interaction> list = ix(h.id);
  // Every While hovering of the layer, one hold: an instance's inherited (its hover state) and its own (an overlay…).
  // Each runs as its own queue (an animated hover state doesn't hold the overlay back).
  std::vector<const Interaction*> hovers;
  for (const Interaction& i : list)
    if (i.trigger == Trigger::ON_HOVER) hovers.push_back(&i);
  if (hovers.empty()) return;
  for (auto& x : held_)
    if (x.hotspotKey == key || x.anchorKey == key || x.anchor == h.id || x.hotspot == h.id) return;  // hovered already
  Held held;
  held.anchor = h.id;
  held.hotspot = h.id;
  held.anchorKey = key;
  held.hotspotKey = key;
  held.id = ++heldSerial_;
  for (const Interaction* i : hovers) {
    Hit at = h;
    if (!doc().has(at.id))
      if (Guid again = byKey(key); again != kNoGuid) at.id = again;
    run(at.id, i->actions, &at, &held);
  }
  held_.push_back(std::move(held));
}

std::string Player::keyOf(Guid node) const {
  Guid top = topLevelOf(node);
  if (top == kNoGuid) return node.toString();
  return top.toString() + semanticPath(node);
}

Guid Player::underKey(Guid root, const std::string& rel) const {
  Guid cur = root;
  size_t pos = 0;
  while (pos < rel.size()) {
    if (rel[pos] != '\x1f') return kNoGuid;
    size_t mark = rel.find('\x1e', pos + 1);
    if (mark == std::string::npos) return kNoGuid;
    size_t end = rel.find('\x1f', mark + 1);
    if (end == std::string::npos) end = rel.size();
    std::string_view name(rel.data() + pos + 1, mark - pos - 1);
    int k = std::atoi(rel.substr(mark + 1, end - mark - 1).c_str());
    Guid next = kNoGuid;
    int seen = 0;
    for (Guid c : doc().children(cur)) {
      const NodeProps* cp = props(c);
      if (!cp || cp->name != name || ghosts_.count(c)) continue;
      if (seen++ == k) {
        next = c;
        break;
      }
    }
    if (next == kNoGuid) return kNoGuid;
    cur = next;
    pos = end;
  }
  return cur;
}

Guid Player::byKey(const std::string& key) const {
  size_t cut = key.find('\x1f');
  bool ok = false;
  Guid root = Guid::parse(key.substr(0, cut), &ok);
  if (!ok || !doc().has(root)) return kNoGuid;
  return cut == std::string::npos ? root : underKey(root, key.substr(cut));
}

void Player::keyChain(Chain& c) const {
  c.keys.clear();
  c.keys.reserve(c.hits.size());
  for (const Hit& h : c.hits) c.keys.push_back(keyOf(h.id));
}

uint64_t Player::screenSignature() const {
  auto mix = [](uint64_t h, Guid g) { return (h ^ ((static_cast<uint64_t>(g.sessionID) << 32) | g.localID)) * 1099511628211ull; };
  uint64_t h = mix(1469598103934665603ull, base_);
  for (const Shown& o : overlays_) h = mix(h, o.frame);
  return h ^ overlays_.size();
}

const text::LinkBox* Player::linkAt(const Chain& c, Vec2 css) const {
  for (const Hit& h : c.hits) {
    const NodeProps* p = props(h.id);
    if (!p || p->type != NodeType::TEXT) continue;
    const text::TextLayout* L = ed_.textLayout(h.id);
    if (!L || L->links.empty()) continue;
    Vec2 local = h.toCss.inverse().apply(css);
    for (const text::LinkBox& b : L->links)
      if (b.rect.contains(local)) return &b;
  }
  return nullptr;
}

void Player::follow(const text::LinkBox& link) {
  if (!link.link.url.empty()) {
    Event e;
    e.kind = Event::Kind::OPEN_URL;
    e.url = link.link.url;
    e.newTab = true;
    events_.push_back(std::move(e));
    return;
  }
  // A node of this file: its top-level frame (a page: nothing to show here).
  Guid dest = topLevelOf(link.link.guid);
  if (dest != kNoGuid && frameExists(dest) && dest != base_) navigate(dest, Action{}, true);
}

uint32_t Player::pointer(PointerEvent type, double x, double y, uint32_t /*buttons*/, uint32_t /*mods*/, double timeMs) {
  if (!active()) return 0;
  layout();
  Vec2 css{x, y};
  hoverCss_ = css;
  double t = timeMs > 0 ? timeMs : now_;
  if (down_ && (type == PointerEvent::MOVE || type == PointerEvent::UP)) {
    samples_.push_back({t, css});
    while (samples_.size() > 2 && samples_.front().t < t - 100) samples_.pop_front();
  }
  switch (type) {
    case PointerEvent::MOVE: {
      if (thumbDrag_.active) {
        moveThumbDrag(css);
        return 1;
      }
      if (scrollDrag_.active) {
        moveScrollDrag(css);
        return 1;
      }
      Chain c = hitTest(css);
      hover(c);
      if (web_ && webPointerMove(css)) return 1;  // selecting in a text input
      if (scrub_.active) {
        // On drag: the transition follows the pointer along its vector.
        double p = std::clamp(((css.x - scrub_.from.x) * scrub_.axis.x + (css.y - scrub_.from.y) * scrub_.axis.y) / scrub_.extent, 0.0, 1.0);
        if (scrub_.instance != kNoGuid) {
          if (InstanceAnim* ia = instanceAnim(scrub_.instance); ia && ia->scrubbing && p != ia->scrubP) {
            ia->scrubP = p;
            dirty_ = true;
          }
          return 1;
        }
        if (anim_.active && anim_.scrubbing && p != anim_.scrubP) {
          anim_.scrubP = p;
          dirty_ = true;
        }
        return 1;
      }
      if (down_ && !dragFired_ && (css - downCss_).length() > kDragThreshold) {
        dragFired_ = true;
        uint64_t before = animSerial_, beforeInstance = instanceSerial_;
        Guid hotspot = kNoGuid;
        for (auto& h : downChain_.hits)
          if (doc().has(h.id) && fire(h.id, Trigger::DRAG, &h)) {
            hotspot = h.id;
            break;
          }
        if (animSerial_ != before && anim_.active) beginScrub(css, hotspot);
        else if (instanceSerial_ != beforeInstance) {
          if (InstanceAnim* ia = instanceAnim(lastInstanceAnim_)) beginInstanceScrub(css, *ia);
        } else if (hotspot == kNoGuid) {
          // No On drag: the drag scrolls what it started on.
          beginScrollDrag(css);
        }
      }
      return 1;
    }
    case PointerEvent::DOWN: {
      Chain c = hitTest(css);
      // A scrollbar thumb takes the press before the layers under it (it is drawn over them).
      if (beginThumbDrag(c, css)) {
        down_ = true;
        dragFired_ = true;  // no click
        downCss_ = css;
        downChain_ = Chain{};
        samples_.clear();
        return 1;
      }
      hover(c);
      c = hoverChain_;  // as hover left it (hit again if a hover changed what is under the pointer), with its keys
      if (web_) webPointerDown(c, css);  // focus (a text input takes the caret), or blur
      down_ = true;
      dragFired_ = false;
      downCss_ = css;
      downChain_ = c;
      samples_.clear();
      samples_.push_back({t, css});
      // A press stops what it lands on from flinging.
      for (auto& h : c.hits) stopFlings(h.id);
      if (c.layer == -1) stopFlings(base_);
      cancelDelayed(Trigger::MOUSE_UP);  // pressed again before a delayed Mouse up ran
      for (auto& h : c.hits)
        if (fire(h.id, Trigger::MOUSE_DOWN, &h)) break;
      for (auto& h : c.hits) {
        if (!hasIx(h.id) || (web_ && disabled(h.id))) continue;
        bool any = false;
        for (const Interaction& i : ix(h.id)) {
          if (i.trigger != Trigger::ON_PRESS) continue;
          if (!any) {
            pressed_ = Held{};
            pressed_.anchor = h.id;
            for (size_t k = 0; k < c.hits.size() && k < c.keys.size(); k++)
              if (c.hits[k].id == h.id) pressed_.anchorKey = pressed_.hotspotKey = c.keys[k];
            pressed_.id = ++heldSerial_;
          }
          run(h.id, i.actions, &h, &pressed_);
          any = true;
        }
        if (any) break;
      }
      return 1;
    }
    case PointerEvent::UP: {
      if (!down_) return 0;
      down_ = false;
      if (thumbDrag_.active) {
        thumbDrag_ = ThumbDrag{};
        return 1;
      }
      if (web_) webPointerUp();
      if (scrub_.active) endScrub(t);
      if (scrollDrag_.active) {
        endScrollDrag(t);
        downChain_ = Chain{};
        return 1;
      }
      Held p = std::move(pressed_);
      pressed_ = Held{};
      for (auto it = p.revert.rbegin(); it != p.revert.rend(); ++it) (*it)();
      Chain c = hitTest(css);
      keyChain(c);
      cancelDelayed(Trigger::MOUSE_DOWN);  // released before a delayed Mouse down ran
      for (auto& h : c.hits)
        if (fire(h.id, Trigger::MOUSE_UP, &h)) break;
      bool clicked = false;
      if (!dragFired_) {
        // On click: the deepest layer pressed and released on that reacts to a click.
        // Pressed and released on the same layer by key: a press's change above it may have given it a new id.
        for (size_t i = 0; i < c.hits.size(); i++) {
          auto& h = c.hits[i];
          bool wasDown = false;
          for (size_t j = 0; j < downChain_.hits.size(); j++)
            wasDown |= downChain_.hits[j].id == h.id || (j < downChain_.keys.size() && downChain_.keys[j] == c.keys[i]);
          if (!wasDown) continue;
          if (fire(h.id, Trigger::ON_CLICK, &h)) {
            clicked = true;
            break;
          }
        }
        if (!clicked)
          if (const text::LinkBox* link = linkAt(c, css)) {
            text::LinkBox l = *link;
            follow(l);
            clicked = true;
          }
        if (!clicked) {
          // Outside the top overlay: "Close when clicking outside".
          if (!overlays_.empty() && overlays_.back().settings.closeOnClickOutside &&
              (c.layer != static_cast<int>(overlays_.size()) - 1 || c.hits.empty())) {
            Action none;
            closeOverlay(static_cast<int>(overlays_.size()) - 1, &none);
            clicked = true;
          }
        }
        // Nothing reacted: hotspot hints.
        bool reacted = false;
        for (auto& h : c.hits) reacted |= hasIx(h.id);
        if (!clicked && !reacted && hints_) {
          hintsPending_ = true;
          dirty_ = true;
        }
        // On double click (Wecra's, @ours): a second click soon after the first and near it — after its own On click,
        // as a browser's dblclick follows the second click. The deepest layer under the pointer now (the clicks may
        // have changed what is there) with an On double click runs it; a third click starts a new pair.
        if (t - lastClickAt_ <= kDoubleClickMs && (css - lastClickCss_).length() <= kDragThreshold) {
          lastClickAt_ = -1e9;
          Chain d = hitTest(css);
          for (auto& h : d.hits)
            if (doc().has(h.id) && fire(h.id, Trigger::ON_DOUBLE_CLICK, &h)) break;
        } else {
          lastClickAt_ = t;
          lastClickCss_ = css;
        }
      }
      downChain_ = Chain{};
      return 1;
    }
    case PointerEvent::LEAVE: hover(Chain{}, false); return 1;
    case PointerEvent::CANCEL:
      down_ = false;
      thumbDrag_ = ThumbDrag{};
      if (scrub_.active) endScrub(t);
      if (scrollDrag_.active) endScrollDrag(t);
      return 1;
    default: return 0;
  }
}

uint32_t Player::wheel(double x, double y, double dx, double dy) {
  if (!active()) return 0;
  layout();
  double s = view_.s > 0 ? view_.s : 1;
  Vec2 d{dx / s, dy / s};
  auto apply = [&](Guid frame, Vec2 range) {
    Vec2 cur = scrollOf(frame);
    Vec2 next{std::clamp(cur.x + d.x, 0.0, range.x), std::clamp(cur.y + d.y, 0.0, range.y)};
    if (next.x == cur.x && next.y == cur.y) return false;
    stopFlings(frame);
    scroll_[frame] = next;
    wheelFrame_ = frame;
    wheelAt_ = now_;
    dirty_ = true;
    return true;
  };
  // Wheel events 0.2 s apart or less keep scrolling the frame they scrolled (Figma's viewer).
  if (wheelFrame_ != kNoGuid && now_ - wheelAt_ <= kWheelLatchMs && doc().has(wheelFrame_)) {
    bool top = wheelFrame_ == base_;
    bool shown = top;
    for (Guid cur = wheelFrame_; !shown && cur != kNoGuid; cur = doc().parentOf(cur)) {
      shown = cur == base_;
      for (auto& o : overlays_) shown |= cur == o.frame;
    }
    if (shown) {
      wheelAt_ = now_;
      apply(wheelFrame_, top ? topScrollRange(base_) : nestedScrollRange(wheelFrame_));
      return 1;
    }
  }
  Chain c = hitTest({x, y});
  for (auto& h : c.hits) {
    bool rootOfBase = h.id == base_ && c.layer == -1;
    if (rootOfBase) break;
    if (scrollsNested(h.id) && apply(h.id, nestedScrollRange(h.id))) return 1;
  }
  if (c.layer == -1 || c.layer == -2) apply(base_, topScrollRange(base_));
  return 1;
}

uint32_t Player::key(bool down, int keyCode, uint32_t mods) {
  if (!active()) return 0;
  if (!down) return 0;
  layout();
  // Key / Gamepad interactions (atlas 13 §3.5): on the topmost screen only (the top overlay, else the base screen); the
  // keys held — the modifiers as their own codes, then the key — must be exactly a trigger's; off the Mac ⌘ reads as
  // Ctrl; the first hotspot that matches takes the key.
  auto code = [&](int k) { return host_ != Host::MAC && (k == kMeta || k == 93) ? kCtrl : k; };
  std::vector<int> pressed{code(keyCode)};
  if (mods & MOD_SHIFT) pressed.push_back(kShift);
  if (mods & MOD_CTRL) pressed.push_back(kCtrl);
  if (mods & MOD_ALT) pressed.push_back(kAlt);
  if (mods & MOD_META) pressed.push_back(code(kMeta));
  std::sort(pressed.begin(), pressed.end());
  pressed.erase(std::unique(pressed.begin(), pressed.end()), pressed.end());
  std::vector<Guid> roots{overlays_.empty() ? base_ : overlays_.back().frame};
  for (Guid root : roots) {
    bool handled = false;
    std::function<void(Guid)> walk = [&](Guid id) {
      if (handled) return;
      const NodeProps* p = props(id);
      if (!p || !p->visible) return;
      if (web_ && p->type == NodeType::INSTANCE && instanceDisabled(id)) return;  // a disabled instance takes no keys
      // Deepest first.
      const std::vector<Guid> kids = topmostFirst(id);
      for (auto it = kids.begin(); it != kids.end() && !handled; ++it) walk(*it);
      if (handled || !hasIx(id)) return;
      for (const Interaction& i : ix(id)) {
        if (i.trigger != Trigger::ON_KEY_DOWN || i.keyCodes.empty()) continue;
        std::vector<int> want;
        for (int k : i.keyCodes) want.push_back(code(k));
        std::sort(want.begin(), want.end());
        want.erase(std::unique(want.begin(), want.end()), want.end());
        if (want != pressed) continue;
        run(id, i.actions, nullptr, nullptr);
        handled = true;
        return;
      }
    };
    walk(root);
    if (handled) {
      syncWeb();
      return 1;
    }
  }
  // Website behaviours: Tab, Enter, Space, Esc, arrows (after the prototype's own Key / Gamepad triggers).
  if (web_)
    if (uint32_t r = webKey(keyCode, mods)) {
      syncWeb();
      return r;
    }
  if (mods & (MOD_META | MOD_CTRL | MOD_ALT)) return 0;
  if (!shortcuts_) return 0;
  // The presentation's shortcuts (R8 §9).
  switch (keyCode) {
    case 82: restart(); return 1;             // R
    case 39: case 32: case 78: next(); return 1;  // → Space N
    case 37: previous(); return 1;                // ←
    case 90: cycleScale(); return 1;          // Z
    default: return 0;
  }
}

// ---- Actions ---------------------------------------------------------------------------------------------

void Player::run(Guid source, const std::vector<Action>& actions, const Hit* hotspot, Held* held) {
  Pending q;
  q.source = source;
  q.actions.assign(actions.begin(), actions.end());
  if (hotspot) {
    q.hasHotspot = true;
    q.hotspot = *hotspot;
  }
  q.held = held ? held->id : 0;
  drain(std::move(q), held);
}

void Player::drain(Pending&& q, Held* now) {
  while (!q.actions.empty()) {
    Action a = std::move(q.actions.front());
    q.actions.pop_front();
    if (a.connection == Connection::CONDITIONAL) {
      // The first block whose condition holds: its actions go into the queue here.
      if (const Branch* b = chosenBranch(a, q.source)) q.actions.insert(q.actions.begin(), b->actions.begin(), b->actions.end());
      continue;
    }
    // The Held the actions undo through: the caller's while it runs them, later found by its id (a While hovering's is
    // stored once its first actions ran).
    Held* held = now ? now : q.held != 0 ? heldById(q.held) : nullptr;
    if (q.held != 0 && !held) return;  // released or left: the rest of the queue is dropped
    uint64_t before = motionSerial_;
    runAction(q.source, a, q.hasHotspot ? &q.hotspot : nullptr, held);
    // A screen change, a Change to or an animated Scroll to holds the rest until its animation ends.
    if (motionSerial_ != before && !q.actions.empty() && running(motionSerial_)) {
      q.wait = motionSerial_;
      pending_.push_back(std::move(q));
      return;
    }
  }
}

void Player::leaveHeld() {
  // While hovering / While pressing on a screen that goes: the pointer is no longer over their hotspots, so they are
  // undone (Figma's reverse hover, `returnInstanceToState(…, BEFORE_LAST_ANY_STATE, REVERSE_HOVER)`, atlas 13 §3) —
  // once the screen change has played, at once: the screen leaves as it was shown and is as it was when it comes back.
  for (auto& h : held_) leftHeld_.push_back(std::move(h));
  held_.clear();
  if (pressed_.id) leftHeld_.push_back(std::move(pressed_));
  pressed_ = Held{};
}

void Player::releaseLeftHeld() {
  std::vector<Held> left = std::move(leftHeld_);
  leftHeld_.clear();
  instantSwaps_ = true;
  for (auto& h : left)
    for (auto it = h.revert.rbegin(); it != h.revert.rend(); ++it) (*it)();
  instantSwaps_ = false;
  dirty_ = true;
}

Player::Held* Player::heldById(uint64_t id) {
  if (pressed_.id == id) return &pressed_;
  if (focusHeld_.id == id) return &focusHeld_;
  for (auto& h : held_)
    if (h.id == id) return &h;
  return nullptr;
}

bool Player::running(uint64_t serial) const {
  if (anim_.active && anim_.serial == serial) return true;
  for (auto& ia : instanceAnims_)
    if (ia.serial == serial) return true;
  for (auto& sa : scrollAnims_)
    if (sa.serial == serial) return true;
  return false;
}

void Player::resumePending() {
  for (size_t i = 0; i < pending_.size();) {
    if (running(pending_[i].wait)) {
      i++;
      continue;
    }
    Pending q = std::move(pending_[i]);
    pending_.erase(pending_.begin() + static_cast<long>(i));
    drain(std::move(q));
    i = 0;  // what it ran may have finished others' waits
  }
}

const Branch* Player::chosenBranch(const Action& a, Guid source) const {
  for (const Branch& b : a.branches) {
    if (b.hasCondition) {
      Editor::Resolved r;
      if (!evaluate(b.condition, source, r)) continue;
      bool truthy = r.kind == Editor::Resolved::Kind::BOOL ? r.b
                    : r.kind == Editor::Resolved::Kind::FLOAT ? r.f != 0
                    : r.kind == Editor::Resolved::Kind::STRING ? !r.s.empty() && r.s != "false"
                                                               : false;
      if (!truthy) continue;
    }
    return &b;
  }
  return nullptr;
}

void Player::runAction(Guid source, const Action& a, const Hit* hotspot, Held* held) {
  // An action that changes the prototype's state drops the delayed mouse triggers and After delays waiting meanwhile
  // (Figma's actionCounter; which actions count is inferred: screens, overlays, Change to, Back, Close, variables — not
  // Scroll to, Open link or the video actions).
  bool changesState = (a.connection == Connection::INTERNAL_NODE && a.navigation != Navigation::SCROLL_TO) || a.connection == Connection::BACK ||
                      a.connection == Connection::CLOSE || a.connection == Connection::SET_VARIABLE || a.connection == Connection::SET_VARIABLE_MODE;
  if (changesState) actionCounter_++;
  // "Reset video state": the videos the step shows start again as they were set on the canvas.
  if (a.resetVideo && a.connection == Connection::INTERNAL_NODE) videoReset_ = true;
  switch (a.connection) {
    case Connection::INTERNAL_NODE: {
      if (a.dest == kNoGuid || !doc().has(a.dest)) return;
      switch (a.navigation) {
        case Navigation::NAVIGATE: {
          Guid top = topLevelOf(a.dest);
          if (top == kNoGuid || top == base_) return;
          Guid from = base_;
          navigate(top, a);
          if (held) held->revert.push_back([this, from, a] {
            if (base_ != from) undoLast();
          });
          return;
        }
        case Navigation::OVERLAY: openOverlay(a.dest, a, hotspot, held); return;
        case Navigation::SWAP: swapOverlay(source, a.dest, a); return;
        case Navigation::SWAP_STATE: changeTo(source, a.dest, a, held); return;
        case Navigation::SCROLL_TO: scrollTo(a.dest, a); return;
      }
      return;
    }
    case Connection::BACK: back(); return;
    case Connection::CLOSE: {
      // The overlay holding the hotspot, else the topmost.
      int index = static_cast<int>(overlays_.size()) - 1;
      for (size_t k = 0; k < overlays_.size(); k++)
        if (overlays_[k].frame == source || doc().isAncestor(overlays_[k].frame, source)) index = static_cast<int>(k);
      if (index >= 0) closeOverlay(index, &a);
      return;
    }
    case Connection::URL: {
      Event e;
      e.kind = Event::Kind::OPEN_URL;
      e.url = a.url;
      e.newTab = a.newTab;
      events_.push_back(std::move(e));
      return;
    }
    case Connection::SET_VARIABLE: setVariable(a, source); return;
    case Connection::SET_VARIABLE_MODE: setVariableMode(a); return;
    case Connection::UPDATE_MEDIA_RUNTIME: mediaAction(a); return;
    case Connection::CONDITIONAL:
      if (const Branch* b = chosenBranch(a, source)) run(source, b->actions, hotspot, held);
      return;
    case Connection::UPDATE_ANIMATION_TIMELINE_STATE: timelineAction(a); return;
    default: return;
  }
}

void Player::navigate(Guid dest, const Action& a, bool record) {
  // Website behaviours: under Responsive the destination's size for the window (its breakpoint).
  if (web_ && page_ != kNoGuid && pageDevice(page_).none && responsiveOn()) {
    Guid sized = breakpointFor(dest, ed_.viewport().width);
    if (sized == base_ && sized != dest) return;  // another size of the screen shown: already there
    dest = sized;
  }
  if (!frameExists(dest)) return;
  ed_.deriveTree(dest);
  layout();
  Side x = baseSide();
  if (record) {
    HistoryEntry h;
    h.base = base_;
    h.baseScroll = scrollOf(base_);
    h.overlays = overlays_;
    h.via = a;
    history_.push_back(std::move(h));
  }
  dropTimers(base_);
  for (auto& o : overlays_) dropTimers(o.frame);
  overlays_.clear();
  leaveHeld();
  Guid left = base_;
  base_ = dest;
  carryComponentStates(dest, a);
  carryScroll(left, dest, a);
  // Scroll: reset unless the action keeps it (Figma's state memorises it per frame; "Reset scroll position" resets).
  if (a.resetScroll) scroll_.erase(dest);
  Vec2 range = topScrollRange(dest);
  if (auto it = scroll_.find(dest); it != scroll_.end()) it->second = {std::min(it->second.x, range.x), std::min(it->second.y, range.y)};
  Side y = baseSide();
  if (a.transition != Transition::INSTANT && durationOf(a) > 0) {
    Anim an;
    an.slot = -1;
    an.x = x;
    an.y = y;
    an.action = a;
    an.smart = isSmart(a);
    if (an.smart || a.smartAnimate) an.fromSnap = snapshot(x.frame, false);
    startAnim(std::move(an));
  }
  armTimers(base_);
  startTimeline();
  changed();
}

bool Player::back() {
  size_t i = history_.size();
  while (i > 0 && history_[i - 1].overlayOpen) i--;
  if (i == 0) return false;
  if (i < history_.size()) {
    // The overlays opened since go with the screen they were opened on (no animation of their own).
    history_.resize(i);
    for (auto& o : overlays_) dropTimers(o.frame);
    overlays_.clear();
  }
  return undoLast(false);
}

bool Player::undoLast(bool restoreOverlays) {
  if (history_.empty()) return false;
  HistoryEntry h = std::move(history_.back());
  history_.pop_back();
  layout();
  if (h.overlayOpen) {
    // Back closes the overlay that step opened.
    if (!overlays_.empty()) {
      Action reverse = h.via;
      int index = static_cast<int>(overlays_.size()) - 1;
      Side x;
      x.frame = overlays_.back().frame;
      x.pos = overlays_.back().pos;
      x.settings = overlays_.back().settings;
      x.overlay = true;
      dropTimers(x.frame);
      overlays_.pop_back();
      if (reverse.transition != Transition::INSTANT && durationOf(reverse) > 0) {
        Anim an;
        an.slot = index;
        an.y = x;  // played backwards: the overlay leaves the way it came
        an.action = reverse;
        an.reverse = true;
        startAnim(std::move(an));
      }
    }
    changed();
    return true;
  }
  Side x = baseSide();
  dropTimers(base_);
  for (auto& o : overlays_) dropTimers(o.frame);
  base_ = h.base;
  if (restoreOverlays) overlays_ = h.overlays;
  else overlays_.clear();
  scroll_[base_] = h.baseScroll;
  leaveHeld();
  Side y = baseSide();
  if (h.via.transition != Transition::INSTANT && durationOf(h.via) > 0) {
    Anim an;
    an.slot = -1;
    an.x = y;  // the forward step, played backwards
    an.y = x;
    an.action = h.via;
    an.reverse = true;
    an.smart = isSmart(h.via);
    if (an.smart || h.via.smartAnimate) an.fromSnap = snapshot(y.frame, false);
    startAnim(std::move(an));
  }
  armTimers(base_);
  for (auto& o : overlays_) armTimers(o.frame);
  startTimeline();
  changed();
  return true;
}

void Player::openOverlay(Guid dest, const Action& a, const Hit* hotspot, Held* held) {
  Guid frame = topLevelOf(dest);
  if (frame == kNoGuid || !frameExists(frame)) return;
  ed_.deriveTree(frame);
  layout();
  for (auto& o : overlays_)
    if (o.frame == frame) {
      // Already open. Website behaviours: a stacked toast shown again stays for its whole delay again.
      if (web_ && o.settings.stack) {
        dropTimers(frame);
        armTimers(frame);
      }
      return;
    }
  fitOverlays(frame);  // Fit to window: sized before it is placed
  Shown s;
  s.frame = frame;
  s.settings = overlaySettings(*props(frame));
  s.pos = overlayPos(frame, s.settings, &a, hotspot);
  // Website behaviours: a Manual overlay opened from a hotspot stays with it (Keep in window).
  if (s.settings.position == OverlayPosition::MANUAL && hotspot && edgeOf(s.settings) != OverlayEdge::NONE) anchor(s, *hotspot);
  // A toast stack at its most: the oldest goes (it leaves the way it came).
  if (web_ && s.settings.stack && s.settings.stackMax > 0 && s.settings.position != OverlayPosition::MANUAL &&
      s.settings.position != OverlayPosition::CENTER) {
    for (;;) {
      int count = 0, oldest = -1;
      for (size_t k = 0; k < overlays_.size(); k++)
        if (overlays_[k].settings.stack && overlays_[k].settings.position == s.settings.position) {
          if (oldest < 0) oldest = static_cast<int>(k);
          count++;
        }
      if (count < s.settings.stackMax || oldest < 0) break;
      closeOverlay(oldest, nullptr);
    }
  }
  HistoryEntry h;
  h.base = base_;
  h.baseScroll = scrollOf(base_);
  h.overlays = overlays_;
  h.via = a;
  h.overlayOpen = true;
  history_.push_back(std::move(h));
  // Open overlay never smart-animates (R8 §5): its animation is the overlay's own entrance.
  Action an = a;
  if (isSmart(an)) an.transition = Transition::DISSOLVE;
  // Figma's viewer (`s1.transitionType` @432546): an overlay opened with Fade, Push or Slide in appears instantly.
  if (an.transition == Transition::FADE || (an.transition >= Transition::PUSH_FROM_LEFT && an.transition <= Transition::PUSH_FROM_BOTTOM) ||
      (an.transition >= Transition::SLIDE_FROM_LEFT && an.transition <= Transition::SLIDE_FROM_BOTTOM))
    an.transition = Transition::INSTANT;
  s.opened = an;
  overlays_.push_back(s);
  scroll_.erase(frame);
  if (an.transition != Transition::INSTANT && durationOf(an) > 0) {
    Anim m;
    m.slot = static_cast<int>(overlays_.size()) - 1;
    m.y.frame = frame;
    m.y.pos = s.pos;
    m.y.settings = s.settings;
    m.y.overlay = true;
    m.action = an;
    startAnim(std::move(m));
  }
  if (held) held->revert.push_back([this, frame] {
    for (size_t k = 0; k < overlays_.size(); k++)
      if (overlays_[k].frame == frame) {
        closeOverlay(static_cast<int>(k), nullptr);
        // While hovering opened it: its history step goes too.
        if (!history_.empty() && history_.back().overlayOpen) history_.pop_back();
        return;
      }
  });
  armTimers(frame);
  changed();
}

void Player::swapOverlay(Guid source, Guid dest, const Action& a) {
  Guid frame = topLevelOf(dest);
  if (frame == kNoGuid || !frameExists(frame)) return;
  ed_.deriveTree(frame);
  layout();
  if (overlays_.empty()) {
    // No overlay to swap: Navigate to (Figma's `SWAP && !hasOverlay`).
    if (frame != base_) navigate(frame, a);
    return;
  }
  // The overlay holding the hotspot, else the topmost; it keeps its place and settings (not recorded in history).
  size_t index = overlays_.size() - 1;
  for (size_t k = 0; k < overlays_.size(); k++)
    if (overlays_[k].frame == source || doc().isAncestor(overlays_[k].frame, source)) index = k;
  Shown old = overlays_[index];
  Shown s = old;
  s.frame = frame;
  dropTimers(old.frame);
  overlays_[index] = s;
  fitOverlays();  // Fit to window: the swapped-in frame's own setting
  if (a.transition != Transition::INSTANT && durationOf(a) > 0) {
    Anim m;
    m.slot = static_cast<int>(index);
    m.x.frame = old.frame;
    m.x.pos = old.pos;
    m.x.settings = old.settings;
    m.x.overlay = true;
    m.y.frame = frame;
    m.y.pos = s.pos;
    m.y.settings = s.settings;
    m.y.overlay = true;
    m.action = a;
    m.smart = isSmart(a);
    if (m.smart) m.fromSnap = snapshot(old.frame, false);
    startAnim(std::move(m));
  }
  armTimers(frame);
  changed();
}

void Player::closeOverlay(int index, const Action* a) {
  if (index < 0 || index >= static_cast<int>(overlays_.size())) return;
  layout();
  Shown s = overlays_[static_cast<size_t>(index)];
  dropTimers(s.frame);
  overlays_.erase(overlays_.begin() + index);
  if (a && a->transition != Transition::INSTANT && durationOf(*a) > 0) {
    Anim m;
    m.slot = index;
    m.x.frame = s.frame;
    m.x.pos = s.pos;
    m.x.settings = s.settings;
    m.x.overlay = true;
    m.action = *a;
    if (isSmart(m.action)) m.action.transition = Transition::DISSOLVE;
    startAnim(std::move(m));
  } else if (s.opened.transition != Transition::INSTANT && durationOf(s.opened) > 0) {
    // Close (and a click outside) with no animation of its own: the overlay leaves the way it came, as Back plays it
    // (live Figma, the owner's "Edit news": Move in from the bottom, out to the bottom).
    Anim m;
    m.slot = index;
    m.y.frame = s.frame;
    m.y.pos = s.pos;
    m.y.settings = s.settings;
    m.y.overlay = true;
    m.action = s.opened;
    m.reverse = true;
    startAnim(std::move(m));
  }
  changed();
}

void Player::remember(Guid id, FieldMask mask) {
  const NodeProps* p = props(id);
  if (!p) return;
  auto it = originals_.find(id);
  if (it == originals_.end()) {
    NodeChange c = NodeChange::changed(id);
    c.mask = mask;
    c.props = *p;
    originals_.emplace(id, std::move(c));
  } else if ((it->second.mask & mask) != mask) {
    FieldMask add = mask & ~it->second.mask;
    copyFields(it->second.props, *p, add);
    it->second.mask |= add;
  }
}

void Player::swapInstance(Guid instance, Guid main, const Action& a) {
  // A Smart animate / Dissolve between the two states: the instance's layers as they are now.
  bool animate = !instantSwaps_ && a.transition != Transition::INSTANT && durationOf(a) > 0;
  Snapshot from;
  // Website behaviours, interruptible: a Change to on an instance still animating starts from what is drawn (CSS's
  // transitions retarget from the current value) — a hover left half way goes back from there, in the time it took
  // (the reversal shortened), instead of from the hovered state's end.
  const InstanceAnim* running = nullptr;
  if (animate && web_)
    for (const InstanceAnim& x : instanceAnims_)
      if (x.instance == instance && !x.scrubbing && doc().has(instance)) running = &x;
  double reached = running ? unit(instanceProgress(*running)) : 1;
  bool reversal = running && main == running->fromMain;
  if (animate) from = running ? drawnInstance(*running, reached) : snapshot(instance, true);
  // (Copied: the running one goes below.)
  std::vector<InstanceAnim::Around> runningAround = running ? running->around : std::vector<InstanceAnim::Around>{};
  bool runningSmart = running && isSmart(running->action);
  running = nullptr;
  // What its new size moves around it: the auto-layout parents it sits in (up to the outermost one) and everything in
  // them but itself, where they are now.
  struct Geo {
    Mat2x3 t;
    Vec2 s;
  };
  std::unordered_map<Guid, Geo, GuidHash> before;
  Guid layoutRoot = instance;
  if (animate) {
    for (int guard = 0; guard < 1000; guard++) {
      const NodeProps* cp = props(layoutRoot);
      const NodeProps* pp = props(doc().parentOf(layoutRoot));
      if (!cp || !pp || !pp->isAutoLayout() || !cp->inFlow()) break;
      layoutRoot = doc().parentOf(layoutRoot);
    }
    if (layoutRoot != instance) {
      std::function<void(Guid)> walk = [&](Guid id) {
        if (id == instance || before.size() > 20000) return;
        const NodeProps* np = props(id);
        if (!np) return;
        before[id] = {np->transform, np->size};
        for (Guid c : doc().children(id)) walk(c);
      };
      walk(layoutRoot);
      // Interrupted: the layers around it from where they are drawn.
      for (const InstanceAnim::Around& r : runningAround)
        if (auto it = before.find(r.id); it != before.end())
          it->second = {lerpMatrix(r.t0, r.t1, reached), {lerp(r.s0.x, r.s1.x, reached), lerp(r.s0.y, r.s1.y, reached)}};
    }
  }
  Guid real = instance.isDerived() ? ed_.instanceOfDerived(instance) : instance;
  // The old state stays on screen while it animates: a copy of the instance as it is (absolute, so auto layout
  // doesn't make room for it; never hit), drawn with only its unmatched layers, fading out (Dissolve: all of them).
  Guid ghost = kNoGuid;
  if (animate && !instance.isDerived())
    if (const NodeProps* ip = props(instance)) {
      Guid parent = doc().parentOf(instance);
      const auto& sib = doc().children(parent);
      auto at = std::find(sib.begin(), sib.end(), instance);
      std::optional<std::string> next;
      if (at != sib.end() && at + 1 != sib.end())
        if (const NodeProps* np = props(*(at + 1))) next = np->parentIndex.position;
      ghost = Guid{kGhostSession, nextGhost_++};
      NodeChange c = NodeChange::created(ghost, *ip);
      c.props.parentIndex = {parent, fractional::keyBetween(ip->parentIndex.position, next ? std::optional<std::string_view>(*next) : std::nullopt)};
      c.props.stackPositioning = StackPositioning::ABSOLUTE;
      c.props.name = "\x01";  // not a name any layer matches (Smart animate matches by name)
      c.props.extra.erase("prototypeInteractions");
      ed_.applyChanges({c}, APPLY_REMOTE);
      if (!doc().has(ghost)) ghost = kNoGuid;
      else ghosts_.insert(ghost);
    }
  remember(real, F_SYMBOL_DATA | F_COMPONENT_PROP_ASSIGNMENTS | F_TRANSFORM | F_SIZE);  // a Hug resize moves it (hugAnchored)
  Guid fromMain = ed_.mainOf(instance);
  CommandArgs args;
  json::Value raw = parseJson("{}");
  json::Value m;
  m.kind = json::Value::Kind::String;
  m.string = main.toString();
  json::Value r = m;
  r.string = instance.toString();
  raw.object.emplace_back("main", m);
  raw.object.emplace_back("ref", r);
  args.raw = raw;
  ed_.command(CommandId::SWAP_INSTANCE, args);
  keepNestedStates(instance, fromMain, main);
  if (animate && doc().has(instance)) {
    for (auto& x : instanceAnims_)
      if (x.instance == instance) dropGhost(x.ghost);
    instanceAnims_.erase(std::remove_if(instanceAnims_.begin(), instanceAnims_.end(), [&](const InstanceAnim& x) { return x.instance == instance; }),
                         instanceAnims_.end());
    InstanceAnim ia;
    ia.instance = instance;
    ia.key = keyOf(instance);
    ia.ghost = ghost;
    ia.from = std::move(from);
    ia.action = a;
    ia.duration = durationOf(a) * 1000;
    ia.fromMain = fromMain;
    if (reached < 1) {
      // Interrupted (Website behaviours): the old state's layers fade out from where they had come (Smart animate's
      // from-snapshot holds the rest); a Dissolve goes on from the opacity it reached. Back to where it came from: in
      // the time it took — CSS's shortened reversal.
      if (runningSmart && isSmart(a)) ia.ghostAlpha = reached;
      else if (!isSmart(a) && reversal) ia.p0 = 1 - reached;
      else if (!isSmart(a)) ia.ghostAlpha = reached;
      if (reversal) ia.duration = std::max(1.0, ia.duration * reached);
    }
    for (auto& [id, g] : before) {
      const NodeProps* np = props(id);
      if (np && (!(np->transform == g.t) || !(np->size == g.s))) ia.around.push_back({id, g.t, np->transform, g.s, np->size});
    }
    ia.serial = ++motionSerial_;
    instanceAnims_.push_back(std::move(ia));
    instanceSerial_++;
    lastInstanceAnim_ = instance;
  } else if (!animate) {
    // An instant change ends the instance's running one (it would play on towards the state it left).
    for (auto& x : instanceAnims_)
      if (x.instance == instance) dropGhost(x.ghost);
    instanceAnims_.erase(std::remove_if(instanceAnims_.begin(), instanceAnims_.end(), [&](const InstanceAnim& x) { return x.instance == instance; }),
                         instanceAnims_.end());
  }
  rekeyInstanceAnims();
  dropTimers(instance);
  armTimers(instance);
  mediaDirty_ = true;
  dirty_ = true;
}

void Player::keepNestedStates(Guid instance, Guid fromMain, Guid toMain) {
  if (nestedStates_.empty() || fromMain == kNoGuid || toMain == kNoGuid || fromMain == toMain || !doc().has(instance)) return;
  const std::string base = keyOf(instance);
  std::vector<std::pair<std::string, Guid>> inside;
  for (const auto& [k, v] : nestedStates_)
    if (k.size() > base.size() && k.compare(0, base.size(), base) == 0 && k[base.size()] == '\x1f') inside.emplace_back(k, v);
  // Outer ones first (a shorter key is never inside a longer one's layer).
  std::sort(inside.begin(), inside.end(), [](const auto& x, const auto& y) { return x.first.size() < y.first.size(); });
  auto designed = [&](Guid variant, const std::string& rel) {
    Guid at = underKey(variant, rel);
    const NodeProps* p = at != kNoGuid ? props(at) : nullptr;
    return p && p->type == NodeType::INSTANCE ? ed_.mainOf(at) : kNoGuid;
  };
  for (const auto& [k, state] : inside) {
    Guid node = byKey(k);
    const NodeProps* np = node != kNoGuid ? props(node) : nullptr;
    if (!np || np->type != NodeType::INSTANCE) {
      nestedStates_.erase(k);  // not in the new variant: its state goes with it (an unmounted component's)
      continue;
    }
    const std::string rel = k.substr(base.size());
    Guid before = designed(fromMain, rel), after = designed(toMain, rel);
    Guid want = state;
    if (before != after) {
      // The outer variants design this layer differently: the new one's design shows (the outer state drives it) — and
      // stays noted, so the next outer change gives its design again (the variant switch alone would carry this one).
      want = after;
      if (after != kNoGuid) nestedStates_[k] = after;
    }
    Guid shown = ed_.mainOf(node);
    if (want == kNoGuid || want == shown || !doc().has(want)) continue;
    if (doc().parentOf(want) != doc().parentOf(shown)) continue;  // another set: left as the variant switch made it
    swapInstance(node, want, Action{});
  }
}

void Player::rekeyInstanceAnims() {
  for (InstanceAnim& ia : instanceAnims_) {
    if (doc().has(ia.instance) || ia.key.empty()) continue;
    Guid again = byKey(ia.key);
    if (again == kNoGuid) continue;
    if (scrub_.instance == ia.instance) scrub_.instance = again;
    if (lastInstanceAnim_ == ia.instance) lastInstanceAnim_ = again;
    ia.instance = again;
  }
}

void Player::changeTo(Guid source, Guid dest, const Action& a, Held* held) {
  const NodeProps* dp = props(dest);
  if (!dp || dp->type != NodeType::SYMBOL) return;
  Guid set = doc().parentOf(dest);
  // The closest instance (the hotspot or an ancestor) showing a variant of the destination's set.
  Guid inst = kNoGuid;
  for (Guid cur = source; cur != kNoGuid; cur = doc().parentOf(cur)) {
    const NodeProps* p = props(cur);
    if (!p) break;
    if (p->type == NodeType::INSTANCE) {
      Guid main = ed_.mainOf(cur);
      if (main != kNoGuid && doc().parentOf(main) == set) {
        inst = cur;
        break;
      }
    }
    if (p->type == NodeType::CANVAS) break;
  }
  if (inst == kNoGuid) return;
  Guid old = ed_.mainOf(inst);
  if (old == dest) return;
  const std::string key = keyOf(inst);
  swapInstance(inst, dest, a);
  // A nested instance's own state (it is inside another instance): kept when an instance above it changes variant.
  if (inst.isDerived()) nestedStates_[key] = dest;
  if (!held) componentStates_[semanticPath(inst)] = dest;
  if (held) {
    if (held->anchor != kNoGuid && (held->anchor == source) && source != inst && doc().isAncestor(inst, source)) {
      held->anchor = inst;
      held->anchorKey = key;
    }
    // Undone on the layer the key names then (an outer change may have given it a new id), and only while it shows
    // what this change set (an outer state that drove it elsewhere since wins).
    held->revert.push_back([this, inst, key, old, dest, a] {
      Guid cur = doc().has(inst) ? inst : byKey(key);
      if (cur == kNoGuid || ed_.mainOf(cur) != dest) return;
      swapInstance(cur, old, a);
      if (cur.isDerived()) nestedStates_[key] = old;
    });
  }
}

void Player::scrollTo(Guid dest, const Action& a) {
  layout();
  // The scrolling frame that holds it: the closest nested one, else the shown top-level frame.
  Guid frame = kNoGuid;
  Vec2 pos;  // dest's top-left in that frame's content space
  Mat2x3 acc;  // dest's space → cur's parent's space
  Guid cur = dest;
  while (cur != kNoGuid) {
    Guid parent = doc().parentOf(cur);
    const NodeProps* cp = props(cur);
    const NodeProps* pp = props(parent);
    if (!cp || !pp) return;
    if (pp->type == NodeType::CANVAS || pp->type == NodeType::SECTION) {  // the screen (a section's frames are screens)
      frame = cur;
      pos = acc.apply({0, 0});
      break;
    }
    acc = cp->transform * acc;
    if (scrollsNested(parent) && parent != base_) {
      frame = parent;
      pos = acc.apply({0, 0});
      break;
    }
    cur = parent;
  }
  if (frame == kNoGuid) return;
  bool top = topLevelOf(frame) == frame;
  Vec2 range = top ? topScrollRange(frame) : nestedScrollRange(frame);
  Vec2 to{std::clamp(pos.x + a.scrollOffset.x, 0.0, range.x), std::clamp(pos.y + a.scrollOffset.y, 0.0, range.y)};
  if (top && range.x == 0) to.x = 0;
  Vec2 from = scrollOf(frame);
  if (a.transition == Transition::INSTANT || durationOf(a) <= 0) {
    scroll_[frame] = to;
  } else {
    ScrollAnim s;
    s.frame = frame;
    s.from = from;
    s.to = to;
    s.action = a;
    s.duration = durationOf(a) * 1000;
    s.serial = ++motionSerial_;
    stopFlings(frame);
    scrollAnims_.push_back(s);
  }
  dirty_ = true;
}

// The editor's evaluator (Editor::resolveValue): the same values as bindings, the variables' modes the hotspot's.
bool Player::evaluate(const json::Value& data, Guid source, Editor::Resolved& out) const {
  VariableData d = codec::readVariable(data);
  return ed_.resolveValue(d, source, out);
}

void Player::setVariable(const Action& a, Guid source) {
  if (a.targetVariable.isNull() || a.targetVariableData.isNull()) return;
  AssetId id;
  if (const json::Value* g = a.targetVariable.get("guid")) {
    Guid gg = kNoGuid;
    if (g->isString()) gg = Guid::parse(g->string);
    else if (g->isObject() && g->get("sessionID") && g->get("localID"))
      gg = Guid{static_cast<uint32_t>(g->get("sessionID")->numberOr(0)), static_cast<uint32_t>(g->get("localID")->numberOr(0))};
    id.guid = gg;
  }
  if (const json::Value* r = a.targetVariable.get("assetRef"); r && r->isObject())
    if (const json::Value* k = r->get("key"); k && k->isString()) id.key = k->string;
  Guid var = ed_.findVariable(id);
  const NodeProps* vp = props(var);
  if (!vp) return;
  Editor::Resolved r;
  if (!evaluate(a.targetVariableData, source, r)) return;
  VariableData value;
  using R = Editor::Resolved::Kind;
  using K = VariableData::Kind;
  switch (r.kind) {
    case R::BOOL: value.kind = K::BOOL; value.boolValue = r.b; value.dataType = VariableDataType::BOOLEAN; break;
    case R::FLOAT: value.kind = K::FLOAT; value.floatValue = r.f; value.dataType = VariableDataType::FLOAT; break;
    case R::STRING: value.kind = K::TEXT; value.textValue = r.s; value.dataType = VariableDataType::STRING; break;
    case R::COLOR: value.kind = K::COLOR; value.colorValue = r.c; value.dataType = VariableDataType::COLOR; break;
    default: return;
  }
  value.hasDataType = true;
  writeVariable(var, value, source);
}

void Player::writeVariable(Guid var, const VariableData& value, Guid source) {
  const NodeProps* vp = props(var);
  if (!vp) return;
  remember(var, F_VARIABLE_DATA_VALUES);
  // The value of the mode the hotspot resolves the variable in (help.figma.com 15253268379799: "Any variables
  // contained within a layer that has a set mode will only update the value of that specific mode definition"):
  // the source's explicit mode, an ancestor's, the page's, else the collection's default. A collection we can't find:
  // every mode.
  NodeChange c = NodeChange::changed(var);
  c.mask = F_VARIABLE_DATA_VALUES;
  c.props.asset().variableDataValues = vp->asset().variableDataValues;
  Guid coll = ed_.findCollection(vp->asset().variableSetID);
  Guid mode = coll != kNoGuid ? ed_.resolvedMode(source != kNoGuid && doc().has(source) ? source : page_, coll) : kNoGuid;
  bool found = false;
  for (auto& mv : c.props.asset().variableDataValues)
    if (mode == kNoGuid || mv.modeID == mode) {
      mv.data = value;
      found = true;
    }
  if (!found && mode != kNoGuid) c.props.asset().variableDataValues.push_back({mode, value});
  ed_.applyChanges({c}, APPLY_REMOTE);
  dirty_ = true;
}

void Player::setVariableMode(const Action& a) {
  if (a.targetMode == kNoGuid || a.targetVariableSet.isNull()) return;
  AssetId set;
  if (const json::Value* g = a.targetVariableSet.get("guid"); g && g->isObject() && g->get("sessionID") && g->get("localID"))
    set.guid = Guid{static_cast<uint32_t>(g->get("sessionID")->numberOr(0)), static_cast<uint32_t>(g->get("localID")->numberOr(0))};
  if (const json::Value* r = a.targetVariableSet.get("assetRef"); r && r->isObject())
    if (const json::Value* k = r->get("key"); k && k->isString()) set.key = k->string;
  Guid coll = ed_.findCollection(set);
  if (coll != kNoGuid) set.guid = coll;
  // The page and every top-level frame shown take the mode (frames' own explicit modes would win otherwise).
  std::vector<Guid> targets{page_, base_};
  for (auto& o : overlays_) targets.push_back(o.frame);
  for (Guid c : screens(doc(), page_)) targets.push_back(c);
  std::vector<NodeChange> changes;
  std::unordered_set<Guid, GuidHash> seen;
  for (Guid t : targets) {
    if (!seen.insert(t).second) continue;
    const NodeProps* p = props(t);
    if (!p) continue;
    bool isPageOrShown = t == page_ || t == base_;
    for (auto& o : overlays_) isPageOrShown |= o.frame == t;
    bool hasEntry = p->explicitMode(set.guid, set.key) != kNoGuid;
    if (!isPageOrShown && !hasEntry) continue;
    remember(t, F_VARIABLE_MODES);
    NodeChange c = NodeChange::changed(t);
    c.mask = F_VARIABLE_MODES;
    c.props.refs().variableModeBySetMap = p->refs().variableModeBySetMap;
    bool found = false;
    for (auto& e : c.props.refs().variableModeBySetMap)
      if ((set.guid != kNoGuid && e.set.guid == set.guid) || (!set.key.empty() && e.set.key == set.key)) {
        e.mode = a.targetMode;
        found = true;
      }
    if (!found) c.props.refs().variableModeBySetMap.push_back({set, a.targetMode, {}});
    changes.push_back(std::move(c));
  }
  ed_.applyChanges(changes, APPLY_REMOTE);
  dirty_ = true;
}

// ---- Time ------------------------------------------------------------------------------------------------

void Player::startAnim(Anim&& a) {
  // Website behaviours: a transition interrupted by another goes on from where it is drawn (a CSS transition's
  // retargeting) instead of jumping to its end first (Figma's: the running one is finished).
  double share = 1;  // of the new one's duration still to run
  if (anim_.active && web_ && !noAnim_ && !anim_.scrubbing && !anim_.done) {
    double now = std::clamp(progress(anim_), 0.0, 1.0);
    if (a.slot == anim_.slot && a.x.frame == anim_.x.frame && a.y.frame == anim_.y.frame && a.reverse != anim_.reverse &&
        a.x.overlay == anim_.x.overlay && a.y.overlay == anim_.y.overlay && !a.scrubbing) {
      // The same step played back (Back, a hover's revert, an overlay closed while it opens): from the place it reached,
      // in the time it took to get there — the reversal shortened as in CSS.
      a.p0 = a.reverse ? 1 - now : now;
      a.p1 = 1;
      share = std::max(0.0, 1 - a.p0);
      if (a.smart && anim_.smart) a.fromSnap = anim_.fromSnap;
      anim_.active = false;
      mediaDirty_ = true;
    } else if (a.smart && anim_.smart && a.slot == anim_.slot && a.x.frame != kNoGuid && a.x.frame == anim_.y.frame) {
      // On to another screen by Smart animate: its matching layers start where they are drawn now.
      a.fromSnap = drawnScreen(anim_);
    }
  }
  if (anim_.active) finishAnim();
  if (noAnim_) return;
  animSerial_++;
  a.active = true;
  a.duration = durationOf(a.action) * 1000 * share;
  if (share < 1) a.duration = std::max(1.0, a.duration);
  a.start = clock_;
  a.started = false;
  a.serial = ++motionSerial_;
  anim_ = std::move(a);
  dirty_ = true;
}

void Player::finishAnim() {
  anim_.active = false;
  mediaDirty_ = true;
  if (anim_.done) {
    auto d = std::move(anim_.done);
    anim_.done = nullptr;
    d();
  }
  dirty_ = true;
}

bool Player::animating() const {
  bool instances = std::any_of(instanceAnims_.begin(), instanceAnims_.end(), [](const InstanceAnim& ia) { return !ia.scrubbing; });
  return (anim_.active && !anim_.scrubbing) || instances || !scrollAnims_.empty() || !slides_.empty() || !flings_.empty() || timelinePlaying_ ||
         hintsPending_ || now_ - hintsAt_ < kHintsMs;
}

Player::InstanceAnim* Player::instanceAnim(Guid instance) {
  if (instance == kNoGuid) return nullptr;
  for (auto& ia : instanceAnims_)
    if (ia.instance == instance) return &ia;
  return nullptr;
}

double Player::instanceProgress(const InstanceAnim& ia) const {
  if (ia.scrubbing) return ia.scrubP;
  double t = ia.duration > 0 ? std::clamp((clock_ - ia.start) / ia.duration, 0.0, 1.0) : 1;
  if (!ia.started) t = 0;
  return ia.p0 + (ia.p1 - ia.p0) * ease(ia.action, t);
}

void Player::armTimers(Guid root) {
  // Every After delay in the screen (the outermost hotspot's, not those inside it); their clocks start when the
  // screen's transition ends. Reached with ← / →: at least 500 ms (Figma's `Math.max(500, …)`).
  std::function<void(Guid)> walk = [&](Guid id) {
    const NodeProps* p = props(id);
    if (!p || !p->visible) return;
    bool armed = false;
    if (hasIx(id)) {
      auto list = ix(id);
      for (size_t i = 0; i < list.size(); i++) {
        if (list[i].trigger != Trigger::AFTER_TIMEOUT) continue;
        Timer t;
        t.node = id;
        t.interaction = i;
        t.at = -1;
        t.delayMs = arrowReached_ ? std::max(kArrowDelayMs, list[i].timeout * 1000) : list[i].timeout * 1000;
        t.order = ++timerOrder_;
        timers_.push_back(t);
        armed = true;
      }
    }
    if (armed) return;
    for (Guid c : doc().children(id)) walk(c);
  };
  walk(root);
}

bool Player::inStackedOverlay(Guid node) const {
  if (!web_) return false;
  for (auto& o : overlays_)
    if (o.settings.stack && (o.frame == node || doc().isAncestor(o.frame, node))) return true;
  return false;
}

void Player::dropTimers(Guid root) {
  timers_.erase(std::remove_if(timers_.begin(), timers_.end(),
                               [&](const Timer& t) { return t.node == root || doc().isAncestor(root, t.node) || !doc().has(t.node); }),
                timers_.end());
  delayed_.erase(std::remove_if(delayed_.begin(), delayed_.end(),
                                [&](const Delayed& d) { return d.node == root || doc().isAncestor(root, d.node) || !doc().has(d.node); }),
                 delayed_.end());
}

double Player::progress(const Anim& a) const {
  double v;
  if (a.scrubbing) {
    v = a.scrubP;
  } else {
    double t = a.duration > 0 ? std::clamp((clock_ - a.start) / a.duration, 0.0, 1.0) : 1;
    if (!a.started) t = 0;
    v = a.p0 + (a.p1 - a.p0) * ease(a.action, t);
  }
  return a.reverse ? 1 - v : v;
}

// ---- On drag ---------------------------------------------------------------------------------------------

void Player::beginScrub(Vec2 at, Guid hotspot) {
  // The transition's vector (atlas 13 §5.6): Move / Push / Slide — the path of the screen drawn on top times the larger
  // of the two screens (an overlay's: its own size); Smart animate — the dragged layer's match, from its centre in the
  // source to its centre in the destination. Dissolve and Instant have none: the way the drag started, a screen long.
  Transition t = anim_.action.transition;
  Geometry g = geometryOf(t);
  Vec2 v;
  if (g.moves) {
    Vec2 path = g.enteringOnTop ? g.inTo - g.inFrom : g.outTo - g.outFrom;
    const NodeProps* xp = props(anim_.x.frame);
    const NodeProps* yp = props(anim_.y.frame);
    Vec2 size = yp ? yp->size : view_.screen;
    if (!anim_.y.overlay && xp) size = {std::max(size.x, xp->size.x), std::max(size.y, xp->size.y)};
    v = {path.x * size.x, path.y * size.y};
  } else if (anim_.smart && hotspot != kNoGuid && anim_.x.frame != kNoGuid && anim_.y.frame != kNoGuid) {
    std::string key = matchKey(doc(), anim_.x.frame, hotspot);
    auto from = anim_.fromSnap.byKey.find(key);
    Snapshot dest = snapshot(anim_.y.frame, false);
    auto to = dest.byKey.find(key);
    if (!key.empty() && from != anim_.fromSnap.byKey.end() && to != dest.byKey.end()) {
      Vec2 a = from->second.rel.apply({from->second.size.x / 2, from->second.size.y / 2});
      Vec2 b = to->second.rel.apply({to->second.size.x / 2, to->second.size.y / 2});
      v = b - a;
    }
  }
  Vec2 axis;
  double extent = 1;
  if (v.length() > 1e-6) {
    axis = {v.x / v.length(), v.y / v.length()};
    extent = v.length() * view_.s;
  } else {
    Vec2 d = at - downCss_;
    axis = std::fabs(d.x) >= std::fabs(d.y) ? Vec2{d.x >= 0 ? 1.0 : -1.0, 0} : Vec2{0, d.y >= 0 ? 1.0 : -1.0};
    extent = (axis.x != 0 ? view_.screen.x : view_.screen.y) * view_.s;
  }
  scrub_.active = true;
  scrub_.axis = axis;
  scrub_.from = downCss_;
  scrub_.extent = std::max(1.0, extent);
  anim_.scrubbing = true;
  anim_.scrubP = std::clamp(((at.x - downCss_.x) * axis.x + (at.y - downCss_.y) * axis.y) / scrub_.extent, 0.0, 1.0);
  dirty_ = true;
}

void Player::beginInstanceScrub(Vec2 at, InstanceAnim& ia) {
  // Change to (an interactive component): the drag's main axis, the instance's extent on screen for the whole of it.
  Vec2 d = at - downCss_;
  Vec2 axis = std::fabs(d.x) >= std::fabs(d.y) ? Vec2{d.x >= 0 ? 1.0 : -1.0, 0} : Vec2{0, d.y >= 0 ? 1.0 : -1.0};
  double extent = 0;
  if (const NodeProps* p = props(ia.instance)) extent = (axis.x != 0 ? p->size.x : p->size.y) * view_.s;
  scrub_.active = true;
  scrub_.axis = axis;
  scrub_.from = downCss_;
  scrub_.extent = std::max(24.0, extent);
  scrub_.instance = ia.instance;
  ia.scrubbing = true;
  ia.scrubP = std::clamp((d.x * axis.x + d.y * axis.y) / scrub_.extent, 0.0, 1.0);
  dirty_ = true;
}

Vec2 Player::pointerVelocity(double timeMs) const {
  if (samples_.size() < 2) return {};
  const Sample& last = samples_.back();
  // Still before letting go: no speed (Flutter's and Figma's trackers assume the pointer stopped after 40 ms).
  if (timeMs - last.t > 40) return {};
  const Sample* first = nullptr;
  for (const Sample& s : samples_)
    if (s.t >= last.t - 100 && s.t < last.t) {
      first = &s;
      break;
    }
  if (!first) return {};
  double dt = (last.t - first->t) / 1000;
  return dt > 0 ? Vec2{(last.at.x - first->at.x) / dt, (last.at.y - first->at.y) / dt} : Vec2{};
}

void Player::endScrub(double timeMs) {
  // Let go (atlas 13 §5.6): the pointer's speed along the vector, s (progress per second), against r = 0.15 per the
  // transition's duration — past half way it goes back only when s ≤ −r, before half way it completes only when s ≥ r —
  // then runs there in |target − progress| × the duration.
  Vec2 vel = pointerVelocity(timeMs);
  double speed = (vel.x * scrub_.axis.x + vel.y * scrub_.axis.y) / std::max(1.0, scrub_.extent);
  auto target = [&](double p, double durationMs) {
    double r = kReleaseSpeed / std::max(1e-6, durationMs / 1000);
    return p >= 0.5 ? (speed <= -r ? 0.0 : 1.0) : (speed >= r ? 1.0 : 0.0);
  };
  if (scrub_.instance != kNoGuid) {
    Guid inst = scrub_.instance;
    scrub_ = Scrub{};
    InstanceAnim* ia = instanceAnim(inst);
    if (!ia || !ia->scrubbing) return;
    double p = ia->scrubP, full = ia->duration;
    ia->scrubbing = false;
    ia->p0 = p;
    ia->started = false;
    ia->p1 = target(p, full);
    ia->duration = std::max(0.001, full * std::fabs(ia->p1 - p));
    dirty_ = true;
    return;
  }
  scrub_ = Scrub{};
  if (!anim_.active || !anim_.scrubbing) return;
  double p = anim_.scrubP, full = anim_.duration;
  anim_.scrubbing = false;
  anim_.p0 = p;
  anim_.started = false;
  anim_.p1 = target(p, full);
  anim_.duration = std::max(0.001, full * std::fabs(anim_.p1 - p));
  // Back to where it started: the step is undone.
  if (anim_.p1 < 0.5) anim_.done = [this] { silentBack(); };
  dirty_ = true;
}

void Player::silentBack() {
  noAnim_ = true;
  undoLast();  // the dragged step alone, overlays as they were
  noAnim_ = false;
}

// ---- Scrolling -------------------------------------------------------------------------------------------

scroll::Physics Player::scrollPhysics() const {
  // The device's platform, else the host's (atlas 13 §8.2): iOS / macOS bounce, Android / Windows / Linux clamp.
  if (page_ != kNoGuid && props(page_)) {
    Device dev = pageDevice(page_);
    if (dev.type == Device::Type::PRESET) {
      const DeviceSpec* spec = nullptr;
      const DeviceModel* model = nullptr;
      if (findDevice(dev.preset, spec, model)) return spec->kind == DeviceKind::ANDROID ? scroll::Physics::CLAMPING : scroll::Physics::BOUNCING;
    }
  }
  switch (host_) {
    case Host::MAC: return scroll::Physics::BOUNCING;
    case Host::WINDOWS:
    case Host::LINUX: return scroll::Physics::CLAMPING;
    case Host::OTHER: break;
  }
  return scroll::Physics::NONE;
}

Vec2 Player::scrollRange(Guid frame, bool top) const { return top ? topScrollRange(frame) : nestedScrollRange(frame); }

bool Player::beginScrollDrag(Vec2 at) {
  // What the drag started on that scrolls along it: the deepest nested scrolling frame, else the screen.
  Vec2 d = at - downCss_;
  auto along = [&](Vec2 range) { return (std::fabs(d.x) > 0 && range.x > 0) || (std::fabs(d.y) > 0 && range.y > 0); };
  Guid frame = kNoGuid;
  bool top = false;
  for (auto& h : downChain_.hits) {
    if (h.id == base_ && downChain_.layer == -1) break;
    if (scrollsNested(h.id) && along(nestedScrollRange(h.id))) {
      frame = h.id;
      break;
    }
  }
  if (frame == kNoGuid && downChain_.layer == -1 && !bare_ && along(topScrollRange(base_))) {
    frame = base_;
    top = true;
  }
  if (frame == kNoGuid) return false;
  stopFlings(frame);
  scrollDrag_.active = true;
  scrollDrag_.frame = frame;
  scrollDrag_.top = top;
  scrollDrag_.last = downCss_;
  moveScrollDrag(at);
  return true;
}

void Player::moveScrollDrag(Vec2 at) {
  if (!doc().has(scrollDrag_.frame)) {
    scrollDrag_ = ScrollDrag{};
    return;
  }
  double s = view_.s > 0 ? view_.s : 1;
  Vec2 range = scrollRange(scrollDrag_.frame, scrollDrag_.top);
  Vec2 cur = scrollOf(scrollDrag_.frame);
  Vec2 delta{(scrollDrag_.last.x - at.x) / s, (scrollDrag_.last.y - at.y) / s};
  scrollDrag_.last = at;
  const NodeProps* fp = props(scrollDrag_.frame);
  Vec2 viewport = scrollDrag_.top ? view_.screen : fp ? fp->size : view_.screen;
  bool bounce = scrollPhysics() == scroll::Physics::BOUNCING;
  auto axis = [&](double pos, double d, double max, double length) {
    if (max <= 0) return pos;
    // Bouncing: past an end the content resists (in CSS px, as Figma's).
    if (bounce) return pos + scroll::applyDrag(pos * s, d * s, 0, max * s, length * s) / s;
    return std::clamp(pos + d, 0.0, max);
  };
  Vec2 next{axis(cur.x, delta.x, range.x, viewport.x), axis(cur.y, delta.y, range.y, viewport.y)};
  if (next.x != cur.x || next.y != cur.y) {
    scroll_[scrollDrag_.frame] = next;
    dirty_ = true;
  }
}

void Player::endScrollDrag(double timeMs) {
  ScrollDrag d = scrollDrag_;
  scrollDrag_ = ScrollDrag{};
  if (!doc().has(d.frame)) return;
  scroll::Physics physics = scrollPhysics();
  double s = view_.s > 0 ? view_.s : 1;
  Vec2 range = scrollRange(d.frame, d.top);
  Vec2 pos = scrollOf(d.frame);
  Vec2 vel = pointerVelocity(timeMs);
  vel = {-vel.x, -vel.y};  // the content goes the pointer's way: its scroll the other
  scroll::Tolerance tol = scroll::toleranceFor(ed_.viewport().dpr);
  Fling f;
  f.frame = d.frame;
  f.top = d.top;
  if (physics == scroll::Physics::NONE) {
    scroll_[d.frame] = {std::clamp(pos.x, 0.0, range.x), std::clamp(pos.y, 0.0, range.y)};
    dirty_ = true;
    return;
  }
  // Clamping: the faster axis's fling sets the length of both.
  double main = std::fabs(vel.x) >= std::fabs(vel.y) ? vel.x : vel.y;
  double shared = scroll::Simulation::clampingDuration(main);
  auto sim = [&](double p, double v, double max) {
    if (max <= 0) return scroll::Simulation{};
    if (physics == scroll::Physics::BOUNCING) return scroll::Simulation::bouncing(p * s, v, 0, max * s, tol);
    return scroll::Simulation::clamping(p * s, v, 0, max * s, tol, shared);
  };
  f.x = sim(pos.x, vel.x, range.x);
  f.y = sim(pos.y, vel.y, range.y);
  if (!f.x.active() && !f.y.active()) return;
  if ((!f.x.active() || f.x.done(0)) && (!f.y.active() || f.y.done(0))) return;
  flings_.push_back(std::move(f));
  dirty_ = true;
}

void Player::stopFlings(Guid frame) {
  flings_.erase(std::remove_if(flings_.begin(), flings_.end(), [&](const Fling& f) { return f.frame == frame; }), flings_.end());
}

// ---- Wecra's Scrollbar (prototypeScrollbar, @ours; render/FrameScrollbar.h) -----------------------------------

FrameScrollbarState Player::scrollbarState(Guid frame, bool top, Vec2 topScroll) const {
  FrameScrollbarState s;
  const NodeProps* p = props(frame);
  if (!p) return s;
  Overflow o = overflow(*p);
  s.horizontal = o == Overflow::HORIZONTAL || o == Overflow::BOTH;
  s.vertical = o == Overflow::VERTICAL || o == Overflow::BOTH;
  s.thickness = frameScrollbarWidth(*p);
  if (top) {
    Vec2 f = topShift(frame, topScroll);
    s.box = {f.x, f.y, std::min(p->size.x, view_.screen.x), std::min(p->size.y, view_.screen.y)};
    s.scroll = topScroll;
    s.range = topScrollRange(frame);
  } else {
    s.box = {0, 0, p->size.x, p->size.y};
    s.scroll = scrollOf(frame);
    s.range = nestedScrollRange(frame);
  }
  return s;
}

bool Player::beginThumbDrag(const Chain& c, Vec2 css) {
  for (const Hit& h : c.hits) {
    const NodeProps* p = props(h.id);
    if (!p || !p->isFrameLike() || !scrollbar(*p) || overflow(*p) == Overflow::NONE) continue;
    bool top = h.id == base_ && c.layer == -1;
    Mat2x3 m = top ? frameCss(baseSide()) : h.toCss;
    FrameScrollbarState s = scrollbarState(h.id, top, top ? scrollOf(base_) : Vec2{});
    FrameScrollbarThumbs t = frameScrollbarThumbs(s);
    Mat2x3 inv = m.inverse();
    Vec2 local = inv.apply(css);
    const double slop = kFrameScrollbarInset;
    auto in = [&](const Rect& r, bool vertical) {
      Rect g = vertical ? Rect{r.x - slop, r.y, r.w + 2 * slop, r.h} : Rect{r.x, r.y - slop, r.w, r.h + 2 * slop};
      return g.contains(local);
    };
    bool vertical;
    if (t.v && in(t.vThumb, true)) vertical = true;
    else if (t.h && in(t.hThumb, false)) vertical = false;
    else continue;
    const Rect& track = vertical ? t.vTrack : t.hTrack;
    const Rect& thumb = vertical ? t.vThumb : t.hThumb;
    double free = vertical ? track.h - thumb.h : track.w - thumb.w;
    double range = vertical ? s.range.y : s.range.x;
    if (free <= 0 || range <= 0) continue;
    stopFlings(h.id);
    thumbDrag_ = ThumbDrag{};
    thumbDrag_.active = true;
    thumbDrag_.frame = h.id;
    thumbDrag_.vertical = vertical;
    thumbDrag_.inverse = inv;
    thumbDrag_.from = local;
    thumbDrag_.scroll = {std::clamp(s.scroll.x, 0.0, s.range.x), std::clamp(s.scroll.y, 0.0, s.range.y)};
    thumbDrag_.perUnit = range / free;
    thumbDrag_.range = range;
    return true;
  }
  return false;
}

void Player::moveThumbDrag(Vec2 css) {
  if (!doc().has(thumbDrag_.frame)) {
    thumbDrag_ = ThumbDrag{};
    return;
  }
  Vec2 local = thumbDrag_.inverse.apply(css);
  double d = thumbDrag_.vertical ? local.y - thumbDrag_.from.y : local.x - thumbDrag_.from.x;
  Vec2 next = thumbDrag_.scroll;
  double& axis = thumbDrag_.vertical ? next.y : next.x;
  axis = std::clamp(axis + d * thumbDrag_.perUnit, 0.0, thumbDrag_.range);
  Vec2 cur = scrollOf(thumbDrag_.frame);
  if (next.x != cur.x || next.y != cur.y) {
    scroll_[thumbDrag_.frame] = next;
    dirty_ = true;
  }
}

// ---- Motion timelines ------------------------------------------------------------------------------------

void Player::startTimeline() {
  // The shown screen's own timeline, if it plays anything (docs/motion.md §4.12): from 0 when its transition ends.
  Guid root = base_ != kNoGuid && ed_.motionIndex().plays(base_) ? base_ : kNoGuid;
  if (root == timelineRoot_ && root != kNoGuid) {
    timelineMs_ = 0;
    timelinePlaying_ = false;
    timelineWaits_ = true;
    return;
  }
  stopTimeline();
  if (root == kNoGuid) return;
  timelineRoot_ = root;
  timelineMs_ = 0;
  timelineWaits_ = true;
  motion::State st;
  st.on = true;
  st.root = root;
  st.timeUs = 0;
  st.showMotionPath = false;
  ed_.setMotion(st);
}

void Player::stopTimeline() {
  if (timelineRoot_ == kNoGuid) return;
  timelineRoot_ = kNoGuid;
  timelinePlaying_ = timelineWaits_ = false;
  timelineMs_ = 0;
  motion::State st = ed_.motion();
  st.on = false;
  st.root = kNoGuid;
  ed_.setMotion(st);
}

void Player::timelineAction(const Action& a) {
  // Play / Pause / Toggle / Set playhead on the timeline's root (animationTimelineDefId; none: the screen's).
  Guid root = a.timelineDef != kNoGuid ? ed_.motionIndex().rootOf(doc(), a.timelineDef) : base_;
  if (root == kNoGuid || root != timelineRoot_) return;
  timelineWaits_ = false;
  switch (a.timeline) {
    case TimelineAction::PLAY: timelinePlaying_ = true; break;
    case TimelineAction::PAUSE: timelinePlaying_ = false; break;
    case TimelineAction::TOGGLE_PLAY_PAUSE: timelinePlaying_ = !timelinePlaying_; break;
    case TimelineAction::SET_PLAYHEAD: {
      timelineMs_ = std::max(0.0, a.timelineSkipTo * 1000);
      motion::State st = ed_.motion();
      st.timeUs = static_cast<int64_t>(std::llround(timelineMs_ * 1000));
      ed_.setMotion(st);
      break;
    }
  }
  dirty_ = true;
}

bool Player::tick(double nowMs) {
  now_ = nowMs;
  syncWeb();
  // The animation clock: at most 1/30 s per frame.
  double step = lastTick_ < 0 ? 0 : std::clamp(nowMs - lastTick_, 0.0, kMaxFrameMs);
  lastTick_ = nowMs;
  clock_ += step;
  bool draw = dirty_;
  if (anim_.active && !anim_.scrubbing) {
    if (!anim_.started) {
      anim_.start = clock_;
      anim_.started = true;
    }
    draw = true;
    if (clock_ - anim_.start >= anim_.duration) finishAnim();
  }
  if (!leftHeld_.empty() && !anim_.active) {
    releaseLeftHeld();
    draw = true;
  }
  for (size_t i = 0; i < instanceAnims_.size();) {
    auto& ia = instanceAnims_[i];
    if (ia.scrubbing) {
      i++;
      continue;
    }
    if (!ia.started) {
      ia.start = clock_;
      ia.started = true;
    }
    draw = true;
    if (clock_ - ia.start >= ia.duration || !doc().has(ia.instance)) {
      Guid g = ia.ghost, inst = ia.instance, back = ia.p1 < 0.5 ? ia.fromMain : kNoGuid;
      instanceAnims_.erase(instanceAnims_.begin() + static_cast<long>(i));
      dropGhost(g);
      // A Change to dragged back: to the state it came from.
      if (back != kNoGuid && doc().has(inst) && ed_.mainOf(inst) != back) swapInstance(inst, back, Action{});
    } else {
      i++;
    }
  }
  // Toast stacks sliding into place.
  for (size_t i = 0; i < slides_.size();) {
    Slide& sl = slides_[i];
    if (!sl.started) {
      sl.start = clock_;
      sl.started = true;
    }
    draw = true;
    if (clock_ - sl.start >= sl.duration) slides_.erase(slides_.begin() + static_cast<long>(i));
    else i++;
  }
  for (size_t i = 0; i < scrollAnims_.size();) {
    auto& s = scrollAnims_[i];
    if (!s.started) {
      s.start = clock_;
      s.started = true;
    }
    double t = s.duration > 0 ? std::clamp((clock_ - s.start) / s.duration, 0.0, 1.0) : 1;
    double e = ease(s.action, t);
    scroll_[s.frame] = {lerp(s.from.x, s.to.x, e), lerp(s.from.y, s.to.y, e)};
    draw = true;
    if (t >= 1) scrollAnims_.erase(scrollAnims_.begin() + static_cast<long>(i));
    else i++;
  }
  // Flings.
  double sc = view_.s > 0 ? view_.s : 1;
  for (size_t i = 0; i < flings_.size();) {
    Fling& f = flings_[i];
    if (!f.started) {
      f.start = clock_;
      f.started = true;
    }
    double t = (clock_ - f.start) / 1000;
    Vec2 cur = scrollOf(f.frame);
    Vec2 next{f.x.active() ? f.x.x(t) / sc : cur.x, f.y.active() ? f.y.x(t) / sc : cur.y};
    scroll_[f.frame] = next;
    draw = true;
    bool done = (!f.x.active() || f.x.done(t)) && (!f.y.active() || f.y.done(t));
    if (done || !doc().has(f.frame)) {
      // At rest within the range.
      Vec2 range = scrollRange(f.frame, f.top);
      scroll_[f.frame] = {std::clamp(next.x, 0.0, range.x), std::clamp(next.y, 0.0, range.y)};
      flings_.erase(flings_.begin() + static_cast<long>(i));
    } else {
      i++;
    }
  }
  // The action queues waiting for an animation that ended.
  if (!pending_.empty()) {
    resumePending();
    draw = true;
  }
  // The screen's Motion timeline.
  if (timelineRoot_ != kNoGuid) {
    if (timelineWaits_ && !anim_.active) {
      timelineWaits_ = false;
      timelinePlaying_ = true;
      timelineMs_ = 0;
      step = 0;
    }
    if (timelinePlaying_ && doc().has(timelineRoot_)) {
      timelineMs_ += step;
      motion::Timeline tl = ed_.motionIndex().timeline(doc(), timelineRoot_);
      double length = static_cast<double>(tl.durationUs) / 1000;
      // Once: it stops at its end; Loop and Boomerang run until the screen goes (the motion layer folds the time).
      if (tl.playback == motion::Playback::ONCE && timelineMs_ >= length) {
        timelineMs_ = length;
        timelinePlaying_ = false;
      }
      motion::State st = ed_.motion();
      st.timeUs = static_cast<int64_t>(std::llround(timelineMs_ * 1000));
      ed_.setMotion(st);
      draw = true;
    }
  }
  if (hintsPending_) {
    hintsPending_ = false;
    hintsAt_ = now_;
  }
  if (now_ - hintsAt_ < kHintsMs + 50) draw = true;
  // After delay: started once the screen's transition ended, fired in order of time then of creation, dropped when
  // another action ran meanwhile.
  std::vector<Timer> due;
  for (auto& t : timers_) {
    if (t.at < 0) {
      if (anim_.active) continue;
      t.at = now_ + t.delayMs;
      t.actions = actionCounter_;
    } else if (now_ >= t.at) {
      due.push_back(t);
    }
  }
  if (!due.empty()) {
    timers_.erase(std::remove_if(timers_.begin(), timers_.end(), [&](const Timer& t) { return t.at >= 0 && now_ >= t.at; }), timers_.end());
    std::sort(due.begin(), due.end(), [](const Timer& a, const Timer& b) { return a.at != b.at ? a.at < b.at : a.order < b.order; });
    uint64_t counter = actionCounter_;
    for (auto& t : due) {
      // Website behaviours: an open stacked overlay (a toast) keeps its own After delay whatever ran meanwhile — opening
      // or closing another toast doesn't cancel it (re-opening one restarts only its own, openOverlay).
      bool own = inStackedOverlay(t.node);
      if (!props(t.node) || (!own && (t.actions != counter || actionCounter_ != counter))) continue;
      auto list = ix(t.node);
      if (t.interaction < list.size()) run(t.node, list[t.interaction].actions, nullptr, nullptr);
    }
    draw = true;
  }
  // Mouse triggers' delays: run only if no other action ran since their trigger.
  std::vector<Delayed> ready;
  for (auto& d : delayed_) {
    if (d.at < 0) d.at = now_ + d.delayMs;
    else if (now_ >= d.at) ready.push_back(d);
  }
  if (!ready.empty()) {
    delayed_.erase(std::remove_if(delayed_.begin(), delayed_.end(), [&](const Delayed& d) { return d.at >= 0 && now_ >= d.at; }),
                   delayed_.end());
    for (auto& d : ready) {
      if (!props(d.node) || !doc().has(d.node) || d.actions != actionCounter_) continue;
      auto list = ix(d.node);
      if (d.interaction < list.size()) run(d.node, list[d.interaction].actions, &d.hotspot, nullptr);
    }
    draw = true;
  }
  return draw;
}

int32_t Player::nextFrameDelay() const {
  if (dirty_ || animating()) return 0;
  double soonest = -1;
  for (auto& t : timers_) {
    double d = t.at < 0 ? 0 : std::max(0.0, t.at - now_);
    soonest = soonest < 0 ? d : std::min(soonest, d);
  }
  for (auto& t : delayed_) {
    double d = t.at < 0 ? 0 : std::max(0.0, t.at - now_);
    soonest = soonest < 0 ? d : std::min(soonest, d);
  }
  return soonest < 0 ? -1 : static_cast<int32_t>(std::ceil(soonest));
}

// ---- Smart animate ---------------------------------------------------------------------------------------

std::string Player::matchKey(const Document& doc, Guid root, Guid id) {
  std::vector<std::string> parts;
  for (Guid cur = id; cur != root && cur != kNoGuid; cur = doc.parentOf(cur)) {
    const Node* n = doc.get(cur);
    if (!n) return std::string();
    Guid parent = doc.parentOf(cur);
    int k = 0;
    for (Guid s : doc.children(parent)) {
      if (s == cur) break;
      const Node* sn = doc.get(s);
      if (sn && sn->props.name == n->props.name) k++;
    }
    parts.push_back(n->props.name + "#" + std::to_string(k));
  }
  std::string key;
  for (auto it = parts.rbegin(); it != parts.rend(); ++it) key += "/" + *it;
  return key;
}

void Player::snapWalk(Snapshot& s, Guid id, const Mat2x3& parentRel, const std::string& key, bool root, bool rootTransform,
                      const PropsOverrides* over) const {
  const NodeProps* p = props(id);
  if (!p) return;
  if (over)
    if (auto it = over->find(id); it != over->end()) p = &it->second;
  Mat2x3 rel = root && !rootTransform ? Mat2x3{} : parentRel * p->transform;
  SnapNode n;
  n.id = id;
  n.rel = rel;
  n.size = p->size;
  n.opacity = p->visible ? p->opacity : 0;
  n.fills = p->fillPaints;
  n.strokes = p->strokePaints;
  n.strokeWeight = p->strokeWeight;
  n.radii = p->cornerRadii;
  n.effects = p->effects;
  n.text = textSignature(*p);
  n.type = p->type;
  if (p->type == NodeType::TEXT) n.fontSize = p->text().fontSize;
  s.byKey.emplace(key, std::move(n));
  std::unordered_map<std::string, int> seen;
  for (Guid c : doc().children(id)) {
    const NodeProps* cp = props(c);
    if (!cp || ghosts_.count(c)) continue;
    int k = seen[cp->name]++;
    snapWalk(s, c, rel, key + "/" + cp->name + "#" + std::to_string(k), false, rootTransform, over);
  }
}

Player::Snapshot Player::snapshot(Guid root, bool rootTransform) const {
  Snapshot s;
  snapWalk(s, root, Mat2x3{}, std::string(), true, rootTransform);
  return s;
}

Player::Snapshot Player::drawnInstance(const InstanceAnim& ia, double e) const {
  // As addFrame draws it: Smart animate interpolates the new state's layers from the old snapshot; the old state's
  // unmatched layers (the ghost) fade out — they join the snapshot under their keys where the new state has none, so a
  // layer going back (a hover undone) comes back from the opacity it reached.
  PropsOverrides drawn;
  if (isSmart(ia.action)) smartDest(ia.instance, ia.from, e, true, drawn, Mat2x3{}, Mat2x3{}, std::string(), true, false);
  Snapshot s;
  snapWalk(s, ia.instance, Mat2x3{}, std::string(), true, true, &drawn);
  if (ia.ghost != kNoGuid && doc().has(ia.ghost)) {
    PropsOverrides fading;
    if (isSmart(ia.action)) {
      smartSource(ia.ghost, matchedKeys(ia.from, ia.instance, true), e, fading, std::string(), true, false, props(ia.ghost)->transform);
    } else {
      NodeProps q = *props(ia.ghost);
      q.opacity *= unit(1 - e);
      fading[ia.ghost] = std::move(q);
    }
    if (auto g = fading.find(ia.ghost); g != fading.end()) g->second.opacity *= ia.ghostAlpha;
    Snapshot old;
    snapWalk(old, ia.ghost, Mat2x3{}, std::string(), true, true, &fading);
    for (auto& [k, n] : old.byKey)
      if (!k.empty()) s.byKey.emplace(k, std::move(n));
  }
  if (!isSmart(ia.action))
    if (auto r = s.byKey.find(std::string()); r != s.byKey.end()) r->second.opacity *= unit(e);
  return s;
}

Player::Snapshot Player::drawnScreen(const Anim& a) const {
  // A Smart animate screen transition's destination as drawn now (its layers between their two places).
  PropsOverrides drawn;
  if (a.smart && a.y.frame != kNoGuid && doc().has(a.y.frame))
    smartDest(a.y.frame, a.fromSnap, std::clamp(progress(a), 0.0, 1.0), false, drawn, Mat2x3{}, Mat2x3{}, std::string(), true, false);
  Snapshot s;
  snapWalk(s, a.y.frame, Mat2x3{}, std::string(), true, false, &drawn);
  return s;
}

namespace {
// A leaf shape (no children of its own): a change of kind can't morph, it cross-fades.
bool leafShape(NodeType t) {
  return t == NodeType::RECTANGLE || t == NodeType::ROUNDED_RECTANGLE || t == NodeType::ELLIPSE || t == NodeType::VECTOR ||
         t == NodeType::STAR || t == NodeType::REGULAR_POLYGON || t == NodeType::LINE;
}
}  // namespace

bool Player::animatable(const SnapNode& s, const NodeProps& p) const {
  if (s.text != textSignature(p)) return false;
  return !(s.type != p.type && (leafShape(s.type) || leafShape(p.type)));
}

std::unordered_set<std::string> Player::matchedKeys(const Snapshot& from, Guid to, bool rootTransform) const {
  std::unordered_set<std::string> keys;
  Snapshot b = snapshot(to, rootTransform);
  for (auto& [k, n] : b.byKey) {
    auto it = from.byKey.find(k);
    const NodeProps* p = props(n.id);
    if (it != from.byKey.end() && p && animatable(it->second, *p)) keys.insert(k);
  }
  return keys;
}

std::vector<std::pair<Guid, Guid>> Player::matches(Guid from, Guid to) const {
  Snapshot a = snapshot(from, false), b = snapshot(to, false);
  std::vector<std::pair<Guid, Guid>> out;
  for (auto& [k, n] : b.byKey) {
    auto it = a.byKey.find(k);
    if (it != a.byKey.end()) out.emplace_back(it->second.id, n.id);
  }
  std::sort(out.begin(), out.end(), [](auto& x, auto& y) { return x.second.localID < y.second.localID; });
  return out;
}

void Player::smartDest(Guid id, const Snapshot& from, double p, bool rootTransform, PropsOverrides& out, const Mat2x3& parentInterp,
                       const Mat2x3& parentDest, const std::string& key, bool root, bool parentUnmatched) const {
  const NodeProps* np = props(id);
  if (!np) return;
  Mat2x3 own = root && !rootTransform ? Mat2x3{} : np->transform;
  Mat2x3 destRel = parentDest * own;
  Mat2x3 interpRel;
  bool unmatched = false;
  if (root) dissolving_.clear();
  auto it = from.byKey.find(key);
  if (it != from.byKey.end() && !root && !animatable(it->second, *np)) {
    // Matched but not animatable: the new layer fades in along the matched path (its subtree with it); the old one
    // fades out along the same path (smartSource, through dissolving_).
    unmatched = true;
    interpRel = lerpMatrix(it->second.rel, destRel, p);
    dissolving_[key] = interpRel;
    NodeProps q = *np;
    q.opacity *= unit(p);
    q.transform = parentInterp.inverse() * interpRel;
    out[id] = std::move(q);
  } else if (it != from.byKey.end() && (root || animatable(it->second, *np))) {
    const SnapNode& s = it->second;
    interpRel = lerpMatrix(s.rel, destRel, p);
    NodeProps q = *np;
    // Position and size follow the eased progress past 0 and 1 (Back easings, springs); opacity is clamped to [0, 1],
    // radii and stroke weight to ≥ 0 (Figma's viewer: `max(lerp, 0)` for each corner radius, opacity clamped).
    q.size = {std::max(0.0, lerp(s.size.x, np->size.x, p)), std::max(0.0, lerp(s.size.y, np->size.y, p))};
    double toOpacity = np->visible ? np->opacity : 0;
    q.opacity = std::clamp(lerp(s.opacity, toOpacity, p), 0.0, 1.0);
    if (!np->visible && q.opacity > 0) q.visible = true;
    q.fillPaints = lerpPaints(s.fills, np->fillPaints, p);
    q.strokePaints = lerpPaints(s.strokes, np->strokePaints, p);
    q.strokeWeight = std::max(0.0, lerp(s.strokeWeight, np->strokeWeight, p));
    for (size_t k = 0; k < 4; k++) q.cornerRadii[k] = std::max(0.0, lerp(s.radii[k], np->cornerRadii[k], p));
    q.effects = lerpEffects(s.effects, np->effects, p);
    if (!(root && !rootTransform)) q.transform = parentInterp.inverse() * interpRel;
    // A text whose font size changed: drawn at its new size, scaled from the old one (its glyphs grow, no re-wrap).
    if (np->type == NodeType::TEXT && s.fontSize > 0 && np->text().fontSize > 0 && std::fabs(s.fontSize - np->text().fontSize) > 1e-6) {
      double k = lerp(s.fontSize, np->text().fontSize, p) / np->text().fontSize;
      q.size = np->size;
      q.transform = q.transform * Mat2x3::scale(k);
    }
    out[id] = std::move(q);
  } else {
    unmatched = true;
    interpRel = parentInterp * own;
    if (!parentUnmatched) {
      NodeProps q = *np;
      q.opacity *= unit(p);
      out[id] = std::move(q);
    }
  }
  std::unordered_map<std::string, int> seen;
  for (Guid c : doc().children(id)) {
    const NodeProps* cp = props(c);
    if (!cp || ghosts_.count(c)) continue;
    int k = seen[cp->name]++;
    smartDest(c, from, p, rootTransform, out, interpRel, destRel, key + "/" + cp->name + "#" + std::to_string(k), false,
              unmatched || parentUnmatched);
  }
}

void Player::smartSource(Guid id, const std::unordered_set<std::string>& keys, double p, PropsOverrides& out, const std::string& key,
                         bool root, bool parentUnmatched, const Mat2x3& parentRel) const {
  const NodeProps* np = props(id);
  if (!np) return;
  bool matched = root || keys.count(key) != 0;
  const auto& kids = doc().children(id);
  if (matched) {
    // Drawn by its match in the destination: only its unmatched children stay here, fading out.
    NodeProps q = *np;
    q.fillPaints.clear();
    q.strokePaints.clear();
    q.effects.clear();
    q.strokeWeight = 0;
    if (kids.empty() || np->type == NodeType::TEXT || np->isBoolean()) q.opacity = 0;
    out[id] = std::move(q);
  } else if (!parentUnmatched) {
    NodeProps q = *np;
    q.opacity *= unit(1 - p);
    // A dissolving match: it leaves along the path its new layer comes in on.
    if (auto d = dissolving_.find(key); d != dissolving_.end()) q.transform = parentRel.inverse() * d->second;
    out[id] = std::move(q);
  }
  // `parentRel` is, for the root, the root's own matrix as drawn (identity for a screen).
  Mat2x3 rel = root ? parentRel : parentRel * np->transform;
  std::unordered_map<std::string, int> seen;
  for (Guid c : kids) {
    const NodeProps* cp = props(c);
    if (!cp || ghosts_.count(c)) continue;
    int k = seen[cp->name]++;
    smartSource(c, keys, p, out, key + "/" + cp->name + "#" + std::to_string(k), false, !matched || parentUnmatched, rel);
  }
}

// ---- The scene -------------------------------------------------------------------------------------------

void Player::stick(Guid scroller, double scrollY, PropsOverrides& out) const {
  // Vertical only (atlas 13 §8.2). s = the layer's top in the scroller's content. A child of the scroller scrolls until
  // its top meets the scroller's top, then stays (pushed down by scrollY − s); one inside a non-scrolling parent stays
  // only while its parent shows, pushed down by at most o = the room under it in that parent; under a Fixed one, not.
  if (scrollY == 0) return;
  std::function<void(Guid, double, bool)> walk = [&](Guid parent, double parentTop, bool direct) {
    const NodeProps* pp = props(parent);
    for (Guid c : doc().children(parent)) {
      const NodeProps* cp = props(c);
      if (!cp || !cp->visible) continue;
      ScrollBehavior b = scrollBehavior(*cp);
      if (b == ScrollBehavior::FIXED) continue;
      double top = parentTop + cp->transform.m12;
      if (b == ScrollBehavior::STICKY) {
        double push = scrollY - top;
        if (!direct && pp) push = std::min(push, std::max(0.0, pp->size.y - (cp->transform.m12 + cp->size.y)));
        if (push > 0) {
          auto it = out.find(c);
          NodeProps q = it != out.end() ? it->second : *cp;
          q.transform = Mat2x3::translate(0, push) * q.transform;
          out[c] = std::move(q);
        }
      }
      // Into its children, unless it scrolls on its own.
      if (!scrollsNested(c)) walk(c, top, false);
    }
  };
  walk(scroller, 0, true);
}

void Player::scrollOverrides(Guid frame, PropsOverrides& out, bool topLevel, Vec2 topScroll,
                             std::unordered_map<Guid, FrameScrollbarState, GuidHash>* bars) const {
  std::function<void(Guid, bool)> walk = [&](Guid id, bool root) {
    const NodeProps* p = props(id);
    if (!p || !p->visible) return;
    if (bars && p->isFrameLike() && scrollbar(*p)) (*bars)[id] = scrollbarState(id, root && topLevel, topScroll);
    if (root && topLevel) {
      // A top-level frame moves under the screen as far as it is bigger (the scene's matrix, `topShift`); the rest of
      // its scroll moves its layers inside it, Fixed ones excepted; its sticky layers stay.
      Vec2 inner = topScroll - topShift(id, topScroll);
      if (inner.x != 0 || inner.y != 0)
        for (Guid c : doc().children(id)) {
          const NodeProps* cp = props(c);
          if (!cp || scrollBehavior(*cp) == ScrollBehavior::FIXED) continue;
          auto it = out.find(c);
          NodeProps q = it != out.end() ? it->second : *cp;
          q.transform = Mat2x3::translate(-inner.x, -inner.y) * q.transform;
          out[c] = std::move(q);
        }
      stick(id, topScroll.y + (bare_ ? windowTop_ : 0), out);
    } else if (scrollsNested(id)) {
      Vec2 sc = scrollOf(id);
      if (sc.x != 0 || sc.y != 0) {
        for (Guid c : doc().children(id)) {
          const NodeProps* cp = props(c);
          if (!cp || scrollBehavior(*cp) == ScrollBehavior::FIXED) continue;
          auto it = out.find(c);
          NodeProps q = it != out.end() ? it->second : *cp;
          q.transform = Mat2x3::translate(-sc.x, -sc.y) * q.transform;
          out[c] = std::move(q);
        }
        stick(id, sc.y, out);
      }
    }
    for (Guid c : doc().children(id)) walk(c, false);
  };
  walk(frame, true);
}

void Player::addFrame(const Side& s, Vec2 offset, double alpha, PropsOverrides&& overrides, double fixedAlpha) {
  const NodeProps* p = props(s.frame);
  if (!p) return;
  // A screen's or an overlay's fade follows the eased progress clamped to [0, 1] (Figma's frame-pair transitions:
  // `clamp(lerp(from, to, t), 0, 1)` for opacity, the translation unclamped).
  alpha = unit(alpha);
  if (fixedAlpha >= 0) fixedAlpha = unit(fixedAlpha);
  scrollOverrides(s.frame, overrides, !s.overlay, s.scroll, &scene_.scrollbars);
  // Instances changing state inside it.
  for (auto& ia : instanceAnims_) {
    if (noInstanceAnims_ || (ia.instance != s.frame && !doc().isAncestor(s.frame, ia.instance))) continue;
    double e = instanceProgress(ia);
    PropsOverrides tmp;
    if (isSmart(ia.action)) {
      smartDest(ia.instance, ia.from, e, true, tmp, Mat2x3{}, Mat2x3{}, std::string(), true, false);
      // The old state's unmatched layers fade out over it (help: layers that don't match dissolve), moving with it.
      if (ia.ghost != kNoGuid && doc().has(ia.ghost)) {
        // Where the old state is drawn: over the instance as it moves (in auto layout), else where it was.
        Mat2x3 ghostAt = props(ia.ghost)->transform;
        if (auto i = tmp.find(ia.instance); i != tmp.end() && !ia.around.empty()) ghostAt = i->second.transform;
        smartSource(ia.ghost, matchedKeys(ia.from, ia.instance, true), e, tmp, std::string(), true, false, ghostAt);
        if (auto g = tmp.find(ia.ghost), i = tmp.find(ia.instance); g != tmp.end() && i != tmp.end() && !ia.around.empty())
          g->second.transform = i->second.transform;
        if (auto g = tmp.find(ia.ghost); g != tmp.end()) g->second.opacity *= ia.ghostAlpha;
      }
    } else {
      // Dissolve: the new state fades in over the old one.
      if (const NodeProps* ip = props(ia.instance)) {
        NodeProps q = *ip;
        q.opacity *= unit(e);
        tmp[ia.instance] = std::move(q);
      }
      if (ia.ghost != kNoGuid)
        if (const NodeProps* gp = props(ia.ghost)) {
          NodeProps q = *gp;
          q.opacity *= unit(1 - e) * ia.ghostAlpha;
          tmp[ia.ghost] = std::move(q);
        }
    }
    // Its auto-layout parents and their other layers re-lay out with it: from where they were to where they are.
    for (const InstanceAnim::Around& a : ia.around) {
      const NodeProps* np = props(a.id);
      if (!np) continue;
      auto it = overrides.find(a.id);
      NodeProps q = it != overrides.end() ? it->second : *np;
      Mat2x3 shift = q.transform * np->transform.inverse();  // a scroll given to it already
      q.transform = shift * lerpMatrix(a.t0, a.t1, e);
      q.size = {lerp(a.s0.x, a.s1.x, e), lerp(a.s0.y, a.s1.y, e)};
      overrides[a.id] = std::move(q);
    }
    for (auto& [id, q] : tmp) {
      // Keep a scroll shift already given to the instance itself.
      auto it = overrides.find(id);
      if (it != overrides.end() && (id == ia.instance || id == ia.ghost)) q.transform = it->second.transform * props(id)->transform.inverse() * q.transform;
      overrides[id] = std::move(q);
    }
  }
  // The root: the alpha of a transition (group opacity: a layer), placed by the frame's matrix.
  NodeProps root = overrides.count(s.frame) ? overrides[s.frame] : *p;
  root.opacity *= alpha;
  Mat2x3 rootTransform = root.transform;
  // Fixed children of a scrolling top-level frame: drawn above the rest, unscrolled.
  std::vector<Guid> fixed;
  if (!s.overlay)
    for (Guid c : doc().children(s.frame)) {
      const NodeProps* cp = props(c);
      if (cp && cp->visible && scrollBehavior(*cp) == ScrollBehavior::FIXED) fixed.push_back(c);
    }
  Mat2x3 frameToCss = Mat2x3::translate(offset.x * view_.s, offset.y * view_.s) * frameCss(s);
  overrides[s.frame] = root;
  store_.push_back(std::move(overrides));
  PropsOverrides* stored = &store_.back();
  for (Guid c : fixed) {
    auto it = stored->find(c);
    NodeProps q = it != stored->end() ? it->second : *props(c);
    q.visible = false;
    (*stored)[c] = std::move(q);
  }
  PresentItem item;
  item.node = s.frame;
  item.parentCss = frameToCss * rootTransform.inverse();
  item.overrides = stored;
  item.clip = true;
  item.clipCss = view_.css;
  // Fixed layers of nested scrolling frames: above the frame's other layers (Figma moves Fixed layers above the rest
  // of their frame, help "Prototype scroll and overflow behavior"), unscrolled, within their frame.
  struct NestedFixed {
    Guid node;
    Mat2x3 parentCss;
    Rect clip;
  };
  std::vector<NestedFixed> nested;
  std::function<void(Guid, const Mat2x3&, bool)> findNested = [&](Guid id, const Mat2x3& css, bool root) {
    auto it = stored->find(id);
    const NodeProps* p = it != stored->end() ? &it->second : props(id);
    if (!p || !p->visible) return;
    Mat2x3 m = root ? css * p->transform : css * p->transform;
    if (!root && scrollsNested(id)) {
      Rect r = transformedBounds(m, p->size.x, p->size.y);
      double x0 = std::max(r.x, view_.css.x), y0 = std::max(r.y, view_.css.y);
      double x1 = std::min(r.right(), view_.css.right()), y1 = std::min(r.bottom(), view_.css.bottom());
      for (Guid c : doc().children(id)) {
        const NodeProps* cp = props(c);
        if (!cp || !cp->visible || scrollBehavior(*cp) != ScrollBehavior::FIXED) continue;
        nested.push_back({c, m, {x0, y0, std::max(0.0, x1 - x0), std::max(0.0, y1 - y0)}});
      }
    }
    for (Guid c : doc().children(id)) findNested(c, m, false);
  };
  findNested(s.frame, item.parentCss, true);
  for (auto& n : nested) {
    auto it = stored->find(n.node);
    NodeProps q = it != stored->end() ? it->second : *props(n.node);
    q.visible = false;
    (*stored)[n.node] = std::move(q);
  }
  scene_.items.push_back(item);
  if (!nested.empty()) {
    PropsOverrides own;
    for (auto& n : nested) {
      NodeProps q = *props(n.node);
      q.opacity *= alpha;
      own[n.node] = std::move(q);
    }
    store_.push_back(std::move(own));
    for (auto& n : nested) {
      PresentItem f;
      f.node = n.node;
      f.parentCss = n.parentCss;
      f.overrides = &store_.back();
      f.clip = true;
      f.clipCss = n.clip;
      scene_.items.push_back(f);
    }
  }
  double fa = fixedAlpha < 0 ? alpha : fixedAlpha;
  if (!fixed.empty() && fa > 0) {
    PropsOverrides fixedOverrides;
    for (Guid c : fixed) {
      NodeProps q = *props(c);
      q.opacity *= fa;
      fixedOverrides[c] = std::move(q);
    }
    store_.push_back(std::move(fixedOverrides));
    Mat2x3 unscrolled = Mat2x3::translate(offset.x * view_.s, offset.y * view_.s) * fixedToCss();
    for (Guid c : fixed) {
      PresentItem f;
      f.node = c;
      f.parentCss = unscrolled;
      f.overrides = &store_.back();
      f.clip = true;
      f.clipCss = view_.css;
      scene_.items.push_back(f);
    }
  }
}

void Player::addSlot(const Side* x, const Side* y, const Anim* a) {
  auto background = [&](const Side& s, double alpha) {
    if (!s.overlay || !s.settings.background) return;
    PresentItem r;
    r.kind = PresentItem::Kind::Rect;
    r.rect = view_.css;
    r.color = s.settings.backgroundColor;
    r.alpha = s.settings.backgroundColor.a * alpha;
    r.color.a = 1;
    r.clip = true;
    r.clipCss = view_.css;
    scene_.items.push_back(r);
  };
  if (!a) {
    if (y) {
      background(*y, 1);
      addFrame(*y, {}, 1, {});
    }
    return;
  }
  double p = progress(*a);
  Geometry g = geometryOf(a->action.transition);
  bool hasX = x && x->frame != kNoGuid && doc().has(x->frame), hasY = y && y->frame != kNoGuid && doc().has(y->frame);
  // Overlay backgrounds fade with their overlay.
  if (a->smart && hasX && hasY) {
    PropsOverrides src, dst;
    std::unordered_set<std::string> keys = matchedKeys(a->fromSnap, y->frame, false);
    smartDest(y->frame, a->fromSnap, p, false, dst, Mat2x3{}, Mat2x3{}, std::string(), true, false);
    smartSource(x->frame, keys, p, src, std::string(), true, false);
    background(*y, 1);
    Side xs = *x, ys = *y;
    Vec2 pos{lerp(x->pos.x, y->pos.x, p), lerp(x->pos.y, y->pos.y, p)};
    xs.pos = ys.pos = pos;
    // In three passes, so what fades out stays visible: the destination frame's own (interpolated) background, the
    // source's unmatched layers over it, then the destination's layers.
    PropsOverrides bg = dst;
    for (Guid c : doc().children(y->frame)) {
      auto it = bg.find(c);
      NodeProps q = it != bg.end() ? it->second : *props(c);
      q.visible = false;
      bg[c] = std::move(q);
    }
    if (auto it = dst.find(y->frame); it != dst.end()) {
      it->second.fillPaints.clear();
      it->second.strokePaints.clear();
      it->second.effects.clear();
    }
    addFrame(ys, {}, 1, std::move(bg));
    addFrame(xs, {}, 1, std::move(src));
    addFrame(ys, {}, 1, std::move(dst));
    return;
  }
  // Move / Push / Slide with "Animate matching layers".
  if (!a->smart && a->action.smartAnimate && hasX && hasY && !x->overlay && !y->overlay && g.moves) {
    addMatching(*x, *y, *a, p);
    return;
  }
  if (g.moves) {
    // The screens along their paths (in units of the screen), the exiting one fading where the type says. An overlay's
    // background doesn't travel: it fades with the transition's progress (Figma's `backgroundTransitionProgress`,
    // atlas 13 §5) — in as the overlay moves in, out as it moves out (Close plays the opening backwards). A screen
    // travels a screen's length; an overlay from just outside the screen's edge to its place (live Figma, 2026-10-20: a
    // centred 158-tall modal moving in from the bottom of a 1024-tall screen travels 591, a top toast only its own
    // height — Wecra moved both a whole screen, and the toast showed only in the last frames).
    Vec2 S = view_.screen;
    auto at = [&](const Side& s, Vec2 from, Vec2 to) {
      Vec2 v{lerp(from.x, to.x, p), lerp(from.y, to.y, p)};
      if (!s.overlay) return Vec2{v.x * S.x, v.y * S.y};
      const NodeProps* op = props(s.frame);
      Vec2 o = op ? op->size : Vec2{};
      Vec2 side{from.x != 0 ? from.x : to.x, from.y != 0 ? from.y : to.y};
      return Vec2{v.x * (side.x > 0 ? S.x - s.pos.x : s.pos.x + o.x), v.y * (side.y > 0 ? S.y - s.pos.y : s.pos.y + o.y)};
    };
    auto drawX = [&] {
      if (!hasX) return;
      double alpha = unit(lerp(g.outAlphaFrom, g.outAlphaTo, p));
      background(*x, alpha * unit(1 - p));
      addFrame(*x, at(*x, g.outFrom, g.outTo), alpha, {});
    };
    auto drawY = [&] {
      if (!hasY) return;
      double alpha = unit(lerp(g.inAlphaFrom, g.inAlphaTo, p));
      background(*y, alpha * unit(p));
      addFrame(*y, at(*y, g.inFrom, g.inTo), alpha, {});
    };
    if (g.enteringOnTop) drawX(), drawY();
    else drawY(), drawX();
    return;
  }
  // Dissolve (and Smart animate with nothing to match): the new one fades in over the old.
  auto draw = [&](const Side& s, double alpha) {
    alpha = unit(alpha);
    background(s, alpha);
    addFrame(s, {}, alpha, {});
  };
  if (hasX && hasY) {
    draw(*x, 1);
    draw(*y, p);
  } else {
    if (hasX) draw(*x, 1 - p);
    if (hasY) draw(*y, p);
  }
}

void Player::addFixed(const Side& s, Vec2 offset, const std::function<double(Guid, const std::string&)>& alphaOf) {
  if (s.overlay || !props(s.frame)) return;
  PropsOverrides own;
  std::vector<Guid> drawn;
  std::unordered_map<std::string, int> seen;
  for (Guid c : doc().children(s.frame)) {
    const NodeProps* cp = props(c);
    if (!cp || ghosts_.count(c)) continue;
    std::string key = "/" + cp->name + "#" + std::to_string(seen[cp->name]++);
    if (!cp->visible || scrollBehavior(*cp) != ScrollBehavior::FIXED) continue;
    double alpha = alphaOf(c, key);
    if (alpha <= 0) continue;
    NodeProps q = *cp;
    q.opacity *= alpha;
    own[c] = std::move(q);
    drawn.push_back(c);
  }
  if (drawn.empty()) return;
  store_.push_back(std::move(own));
  Mat2x3 unscrolled = Mat2x3::translate(offset.x * view_.s, offset.y * view_.s) * fixedToCss();
  for (Guid c : drawn) {
    PresentItem f;
    f.node = c;
    f.parentCss = unscrolled;
    f.overrides = &store_.back();
    f.clip = true;
    f.clipCss = view_.css;
    scene_.items.push_back(f);
  }
}

void Player::addMatching(const Side& x, const Side& y, const Anim& a, double p) {
  // help.figma.com 360039818874: "Layers that don't match: Figma will use the main transition you select. Layers that
  // do match: Figma will Smart animate any differences … Fixed layers that do match: Figma won't apply any
  // transition. Fixed layers that don't match: Figma will apply a dissolve transition" — and the frames' fills move
  // with the main transition ("Figma also doesn't include a frame's fill as part of the animation").
  std::unordered_set<std::string> keys = matchedKeys(a.fromSnap, y.frame, false);
  keys.erase(std::string());
  // A screen moving with the transition: its matching layers hidden (their match draws them). An unmatched layer inside
  // a matching one moves with the transition too (live Figma, the owner's 1 → 4 Push: "content-1-admin" in the matched
  // "body / container" slides out under the sidebar, clipped there) — unless it is inside a matching instance, whose
  // differing insides dissolve in place (the sidebar button's and the breadcrumb's labels): `inner` fades those (the
  // source fades them out; the destination leaves them to the match).
  auto moving = [&](Guid root, double inner) {
    PropsOverrides out;
    std::function<void(Guid, const std::string&, bool, bool, bool)> walk = [&](Guid id, const std::string& key, bool isRoot, bool underMatch,
                                                                              bool inInstance) {
      const NodeProps* np = props(id);
      if (!np) return;
      bool matched = !isRoot && keys.count(key) != 0;
      if (matched) {
        NodeProps q = *np;
        q.fillPaints.clear();
        q.strokePaints.clear();
        q.effects.clear();
        q.strokeWeight = 0;
        if (doc().children(id).empty() || np->type == NodeType::TEXT || np->isBoolean()) q.opacity = 0;
        out[id] = std::move(q);
      } else if (underMatch) {
        if (inInstance) {
          NodeProps q = *np;
          q.opacity *= inner;
          out[id] = std::move(q);
        }
        return;  // its subtree goes with it
      }
      bool inst = inInstance || (matched && np->type == NodeType::INSTANCE);
      std::unordered_map<std::string, int> seen;
      for (Guid c : doc().children(id)) {
        const NodeProps* cp = props(c);
        if (!cp || ghosts_.count(c)) continue;
        walk(c, key + "/" + cp->name + "#" + std::to_string(seen[cp->name]++), false, matched, inst);
      }
    };
    walk(root, std::string(), true, false, false);
    return out;
  };
  Geometry g = geometryOf(a.action.transition);
  Vec2 S = view_.screen;
  auto at = [&](Vec2 from, Vec2 to) { return Vec2{lerp(from.x, to.x, p) * S.x, lerp(from.y, to.y, p) * S.y}; };
  auto drawX = [&] { addFrame(x, at(g.outFrom, g.outTo), lerp(g.outAlphaFrom, g.outAlphaTo, p), moving(x.frame, 0), 0); };
  auto drawY = [&] { addFrame(y, at(g.inFrom, g.inTo), lerp(g.inAlphaFrom, g.inAlphaTo, p), moving(y.frame, 0), 0); };
  if (!g.enteringOnTop) {
    drawY();
    drawX();
  } else {
    drawX();
    drawY();
  }
  // The matching layers, smart-animated in place over both screens (the destination's unmatched layers hidden here:
  // the moving screen draws them).
  PropsOverrides dst;
  smartDest(y.frame, a.fromSnap, p, false, dst, Mat2x3{}, Mat2x3{}, std::string(), true, false);
  std::function<void(Guid, const std::string&, bool, bool)> hide = [&](Guid id, const std::string& key, bool isRoot, bool inInstance) {
    const NodeProps* np = props(id);
    if (!np) return;
    if (isRoot) {
      auto it = dst.find(id);
      NodeProps q = it != dst.end() ? it->second : *np;
      q.fillPaints.clear();
      q.strokePaints.clear();
      q.effects.clear();
      q.strokeWeight = 0;
      dst[id] = std::move(q);
    } else if (!keys.count(key)) {
      // Unmatched: the moving screen draws it — unless it is inside a matching instance (it fades in here).
      if (inInstance) return;
      auto it = dst.find(id);
      NodeProps q = it != dst.end() ? it->second : *np;
      q.visible = false;
      dst[id] = std::move(q);
      return;
    }
    bool inst = inInstance || (!isRoot && np->type == NodeType::INSTANCE);
    std::unordered_map<std::string, int> seen;
    for (Guid c : doc().children(id)) {
      const NodeProps* cp = props(c);
      if (!cp || ghosts_.count(c)) continue;
      hide(c, key + "/" + cp->name + "#" + std::to_string(seen[cp->name]++), false, inst);
    }
  };
  hide(y.frame, std::string(), true, false);
  Side ys = y;
  addFrame(ys, {}, 1, std::move(dst), 0);
  // The source's differing layers inside a matching instance fade out where they are, over the match (they don't
  // leave with the moving screen, nor go under the destination's matched fills: the sidebar button's old label).
  PropsOverrides fading;
  bool anyFading = false;
  std::function<void(Guid, const std::string&, bool, bool)> fade = [&](Guid id, const std::string& key, bool isRoot, bool inInstance) {
    const NodeProps* np = props(id);
    if (!np) return;
    bool matched = isRoot || keys.count(key) != 0;
    NodeProps q = *np;
    if (!matched) {
      if (inInstance) {
        q.opacity *= unit(1 - p);
        anyFading = anyFading || q.opacity > 0;
      } else {
        q.visible = false;
      }
      fading[id] = std::move(q);
      return;
    }
    q.fillPaints.clear();
    q.strokePaints.clear();
    q.effects.clear();
    q.strokeWeight = 0;
    if (doc().children(id).empty() || np->type == NodeType::TEXT || np->isBoolean()) q.opacity = 0;
    fading[id] = std::move(q);
    bool inst = inInstance || (!isRoot && np->type == NodeType::INSTANCE);
    std::unordered_map<std::string, int> seen;
    for (Guid c : doc().children(id)) {
      const NodeProps* cp = props(c);
      if (!cp || ghosts_.count(c)) continue;
      fade(c, key + "/" + cp->name + "#" + std::to_string(seen[cp->name]++), false, inst);
    }
  };
  fade(x.frame, std::string(), true, false);
  if (anyFading) {
    Side xs = x;
    xs.pos = y.pos;
    noInstanceAnims_ = true;
    addFrame(xs, {}, 1, std::move(fading), 0);
    noInstanceAnims_ = false;
  }
  // Fixed layers: a match shows as it ends (no transition), the others dissolve.
  addFixed(x, {}, [&](Guid, const std::string& key) { return keys.count(key) ? 0.0 : 1 - p; });
  addFixed(y, {}, [&](Guid, const std::string& key) { return keys.count(key) ? 1.0 : p; });
}

const PresentScene& Player::scene() {
  scene_.items.clear();
  scene_.scrollbars.clear();
  store_.clear();
  if (!active()) return scene_;
  // Every screen drawn is derived (a partial engine's, Editor::deriveTree; a no-op otherwise).
  ed_.deriveTree(base_);
  for (const Shown& o : overlays_) ed_.deriveTree(o.frame);
  if (anim_.active) {
    ed_.deriveTree(anim_.x.frame);
    ed_.deriveTree(anim_.y.frame);
  }
  layout();
  if (mediaDirty_) syncMedia();
  const NodeProps* pg = props(page_);
  scene_.background = pg ? background(*pg) : Color::hex(0x000000);
  if (Color c; bare_ && screenColor(c)) scene_.background = c;
  // The device frame behind the screen.
  for (const PresentItem& r : view_.under) scene_.items.push_back(r);
  size_t firstScreenItem = scene_.items.size();
  // The screen's own colour behind the frames (white, as Figma's device screen).
  const Anim* a = anim_.active ? &anim_ : nullptr;
  // The base screen.
  Side base = baseSide();
  if (a && a->slot == -1) addSlot(&a->x, &a->y, a);
  else addSlot(nullptr, &base, nullptr);
  // Overlays (and one leaving: an animation of a slot past the end).
  size_t slots = std::max(overlays_.size(), a && a->slot >= 0 ? static_cast<size_t>(a->slot + 1) : size_t(0));
  for (size_t k = 0; k < slots; k++) {
    if (a && a->slot == static_cast<int>(k)) {
      addSlot(&a->x, &a->y, a);
      // An overlay that moved down one place while another closed above it (Close overlay at k): drawn too.
      if (k < overlays_.size() && a->y.frame != overlays_[k].frame && a->x.frame != overlays_[k].frame) {
        Side s;
        s.frame = overlays_[k].frame;
        s.pos = drawnPos(overlays_[k]);
        s.settings = overlays_[k].settings;
        s.overlay = true;
        addSlot(nullptr, &s, nullptr);
      }
      continue;
    }
    if (k >= overlays_.size()) continue;
    Side s;
    s.frame = overlays_[k].frame;
    s.pos = drawnPos(overlays_[k]);
    s.settings = overlays_[k].settings;
    s.overlay = true;
    addSlot(nullptr, &s, nullptr);
  }
  // Website behaviours: the focus ring, a text input's caret and selection.
  addWebItems();
  // Hotspot hints (atlas 13 §10.4): every layer that reacts, in #30C2FF — the fill at half the opacity, a 2-device-pixel
  // border at full — clipped as the layer is; one 0.7 s fade from full, opacity 1 − ease-out (cubic-bezier(0, 0, 0.58, 1)).
  double since = now_ - hintsAt_;
  if (since >= 0 && since < kHintsMs) {
    double alpha = 1 - motion::cubicBezier(0, 0, 0.58, 1, since / kHintsMs);
    double dpr = ed_.viewport().dpr > 0 ? ed_.viewport().dpr : 1;
    Vec2 baseInner = base.scroll - topShift(base_, base.scroll);
    std::vector<std::pair<Guid, Mat2x3>> roots{{base_, frameCss(base)}};
    for (auto& o : overlays_) {
      Side s;
      s.frame = o.frame;
      s.pos = drawnPos(o);
      s.overlay = true;
      roots.emplace_back(o.frame, frameCss(s));
    }
    auto intersect = [](const Rect& a, const Rect& b) {
      double x0 = std::max(a.x, b.x), y0 = std::max(a.y, b.y);
      return Rect{x0, y0, std::max(0.0, std::min(a.right(), b.right()) - x0), std::max(0.0, std::min(a.bottom(), b.bottom()) - y0)};
    };
    for (auto& [root, m] : roots) {
      std::function<void(Guid, const Mat2x3&, bool, const Rect&)> walk = [&](Guid id, const Mat2x3& parent, bool isRoot, const Rect& clip) {
        const NodeProps* p = props(id);
        if (!p || !p->visible) return;
        Mat2x3 mm = isRoot ? parent : parent * p->transform;
        Rect r = transformedBounds(mm, p->size.x, p->size.y);
        if (!isRoot && hasIx(id) && clip.w > 0 && clip.h > 0) {
          PresentItem h;
          h.kind = PresentItem::Kind::Rect;
          h.rect = r;
          h.color = Color::hex(0x30C2FF);
          h.alpha = 0.5 * alpha;
          h.border = 2 / dpr;
          h.borderColor = Color::hex(0x30C2FF);
          h.borderAlpha = alpha;
          h.clip = true;
          h.clipCss = clip;
          scene_.items.push_back(h);
        }
        Rect inner = p->clipsContent() ? intersect(clip, r) : clip;
        Vec2 sc = isRoot ? (id == base_ ? baseInner : Vec2{}) : scrollsNested(id) ? scrollOf(id) : Vec2{};
        for (Guid c : doc().children(id)) {
          const NodeProps* cp = props(c);
          bool fixed = isRoot && cp && scrollBehavior(*cp) == ScrollBehavior::FIXED;
          walk(c, (sc.x != 0 || sc.y != 0) && !fixed ? mm * Mat2x3::translate(-sc.x, -sc.y) : mm, false, inner);
        }
      };
      walk(root, m, true, view_.css);
    }
  }
  // The screen's rounded corners, and the device's camera over it.
  if (view_.radius > 0)
    for (size_t i = firstScreenItem; i < scene_.items.size(); i++) {
      PresentItem& it = scene_.items[i];
      if (it.clip && it.clipCss.x == view_.css.x && it.clipCss.y == view_.css.y && it.clipCss.w == view_.css.w && it.clipCss.h == view_.css.h)
        it.clipRadius = view_.radius;
    }
  for (const PresentItem& r : view_.over) scene_.items.push_back(r);
  applyMediaFrames();
  return scene_;
}

const NodeProps* Player::drawnProps(Guid id) const {
  for (auto it = store_.rbegin(); it != store_.rend(); ++it) {
    auto f = it->find(id);
    if (f != it->end()) return &f->second;
  }
  return nullptr;
}

// ---- Video -----------------------------------------------------------------------------------------------

std::string Player::mediaKey(Guid node) const {
  // Matching objects (help.figma.com 14397859494295): "the same layer name and the same set of parents across
  // top-level frames"; top-level frames match by identical names, or the same text before a "/" ("Checkout / 1"
  // matches "Checkout / 2").
  Guid top = topLevelOf(node);
  const NodeProps* tp = props(top);
  if (!tp) return std::string();
  std::string name = tp->name;
  if (size_t slash = name.rfind('/'); slash != std::string::npos) {
    name = name.substr(0, slash);
    while (!name.empty() && name.back() == ' ') name.pop_back();
  }
  return name + '\x01' + matchKey(doc(), top, node);
}

Player::Media Player::freshMedia(Guid node) const {
  Media m;
  m.node = node;
  if (const NodeProps* p = props(node)) {
    int k = videoFill(*p);
    if (k >= 0) {
      m.video = paintVideoHash(p->fillPaints[static_cast<size_t>(k)]);
      m.settings = videoSettings(*p);
    } else if (int g = gifFill(*p); g >= 0) {
      m.video = paintGifHash(p->fillPaints[static_cast<size_t>(g)]);
      m.gif = true;
      m.settings.autoplay = m.settings.loop = m.settings.muted = true;
    }
  }
  m.playing = m.settings.autoplay;
  m.muted = m.settings.muted;
  m.key = mediaKey(node);
  return m;
}

Player::Media* Player::mediaEntry(Guid node) {
  auto it = media_.find(node);
  if (it != media_.end()) return &it->second;
  const NodeProps* p = props(node);
  if (!p || (videoFill(*p) < 0 && gifFill(*p) < 0)) return nullptr;
  return &media_.emplace(node, freshMedia(node)).first->second;
}

const Player::Media* Player::media(Guid node) const {
  auto it = media_.find(node);
  return it == media_.end() ? nullptr : &it->second;
}

ImageHash Player::frameHash(Guid node) const {
  // Not a SHA-1 of anything: "VID", the player, the layer — a live source no file holds.
  ImageHash h;
  h.present = true;
  h.bytes = {0x56, 0x49, 0x44, 0x00};
  auto put = [&](size_t at, uint32_t v) {
    for (int i = 0; i < 4; i++) h.bytes[at + static_cast<size_t>(i)] = static_cast<uint8_t>(v >> (24 - 8 * i));
  };
  put(4, playerSerial_);
  put(8, node.sessionID);
  put(12, node.localID);
  return h;
}

void Player::clearMedia() {
  for (auto& [id, m] : media_)
    if (m.frame) ImageRegistry::get().forget(frameHash(id));
  media_.clear();
  mediaDirty_ = true;
  videoReset_ = false;
}

void Player::syncMedia() {
  mediaDirty_ = false;
  bool reset = videoReset_;
  videoReset_ = false;
  // The videos in the frames shown: the screen, its overlays, and both sides of a transition.
  std::vector<Guid> roots{base_};
  for (auto& o : overlays_) roots.push_back(o.frame);
  if (anim_.active) {
    roots.push_back(anim_.x.frame);
    roots.push_back(anim_.y.frame);
  }
  std::vector<Guid> shown;
  std::unordered_set<Guid, GuidHash> seen;
  std::function<void(Guid)> walk = [&](Guid id) {
    const NodeProps* p = props(id);
    if (!p || !p->visible || ghosts_.count(id)) return;
    if ((videoFill(*p) >= 0 || gifFill(*p) >= 0) && seen.insert(id).second) shown.push_back(id);
    for (Guid c : doc().children(id)) walk(c);
  };
  for (Guid r : roots)
    if (r != kNoGuid) walk(r);
  std::vector<Guid> before;
  for (auto& [id, m] : media_)
    if (m.shown) before.push_back(id);
  for (auto& [id, m] : media_) m.shown = seen.count(id) != 0;
  for (Guid id : shown) {
    bool wasShown = std::find(before.begin(), before.end(), id) != before.end();
    auto it = media_.find(id);
    if (wasShown && it != media_.end()) continue;
    if (it != media_.end() && !reset) continue;  // state memorisation: as it was left
    Media m = freshMedia(id);
    if (it != media_.end()) {
      // Reset video state: from the beginning, as set on the canvas.
      m.frame = it->second.frame;
      m.seekSerial = it->second.seekSerial + 1;
      m.ackSerial = it->second.ackSerial;
      m.seekTo = 0;
    } else if (!reset && !m.key.empty()) {
      // State sharing: a matching video that was on screen hands its state over.
      for (Guid b : before) {
        auto o = media_.find(b);
        if (o == media_.end() || b == id || o->second.key != m.key || !(o->second.video == m.video)) continue;
        m.playing = o->second.playing;
        m.muted = o->second.muted;
        m.time = o->second.time;
        m.duration = o->second.duration;
        m.ended = o->second.ended;
        m.seekTo = o->second.time;
        m.seekSerial = 1;
        break;
      }
    }
    m.shown = true;
    media_[id] = std::move(m);
  }
}

void Player::mediaAction(const Action& a) {
  if (mediaDirty_) syncMedia();
  Media* m = mediaEntry(a.dest);
  if (!m) return;
  auto seek = [&](double t) {
    // help "Prototype actions": past the end jumps to the end; a looping video begins again from the beginning.
    if (m->duration > 0 && t >= m->duration) t = m->settings.loop ? 0 : m->duration;
    t = std::max(0.0, t);
    m->seekTo = t;
    m->seekSerial++;
    m->time = t;
    m->ended = m->duration > 0 && t >= m->duration && !m->settings.loop;
    if (m->ended) m->playing = false;
  };
  bool wasEnded = m->ended;
  switch (a.media) {
    case MediaAction::PLAY: m->playing = true; break;
    case MediaAction::PAUSE: m->playing = false; break;
    case MediaAction::TOGGLE_PLAY_PAUSE: m->playing = !m->playing; break;
    case MediaAction::MUTE: m->muted = true; break;
    case MediaAction::UNMUTE: m->muted = false; break;
    case MediaAction::TOGGLE_MUTE_UNMUTE: m->muted = !m->muted; break;
    case MediaAction::SKIP_FORWARD: seek(m->time + a.mediaSkipBy); break;
    case MediaAction::SKIP_BACKWARD: seek(m->time - a.mediaSkipBy); break;
    case MediaAction::SKIP_TO: seek(a.mediaSkipTo); break;
  }
  // Played again after its end: from the beginning (a browser's video does the same).
  if (m->playing && m->ended && wasEnded) {
    seek(0);
    m->ended = false;
  }
  dirty_ = true;
  events_.push_back(Event{});
}

std::string Player::mediaJson() {
  if (active() && mediaDirty_) syncMedia();
  json::Writer w;
  w.beginObject().key("videos").beginArray();
  std::vector<const Media*> list;
  for (auto& [id, m] : media_)
    if (m.shown) list.push_back(&m);
  std::sort(list.begin(), list.end(), [](const Media* a, const Media* b) {
    return a->node.sessionID != b->node.sessionID ? a->node.sessionID < b->node.sessionID : a->node.localID < b->node.localID;
  });
  for (const Media* m : list) {
    w.beginObject().key("id").string(m->node.toString()).key("hash").string(m->video.present ? m->video.hex() : std::string());
    if (m->gif) w.key("gif").boolean(true);
    w.key("playing").boolean(m->playing).key("muted").boolean(m->muted).key("loop").boolean(m->settings.loop);
    w.key("time").number(m->time).key("duration").number(m->duration).key("ended").boolean(m->ended);
    w.key("seek");
    if (m->seekTo >= 0 && m->ackSerial < m->seekSerial) w.number(m->seekTo);
    else w.null();
    w.key("seekSerial").number(m->seekSerial);
    w.endObject();
  }
  w.endArray().endObject();
  return w.take();
}

void Player::mediaFrame(Guid node, uint32_t bitmapId, uint32_t width, uint32_t height, double time, double duration, bool ended,
                        uint32_t seekSerial, Bytes rgba) {
  if (mediaDirty_) syncMedia();
  auto it = media_.find(node);
  if (it == media_.end()) return;
  Media& m = it->second;
  if ((bitmapId || rgba) && width && height) {
    ImageRegistry::get().addLiveFrame(frameHash(node), bitmapId, width, height, std::move(rgba));
    m.frame = true;
    dirty_ = true;
  }
  if (seekSerial > m.ackSerial) m.ackSerial = std::min(seekSerial, m.seekSerial);
  if (m.ackSerial < m.seekSerial) return;  // a seek on its way: the old time means nothing
  if (duration > 0) m.duration = duration;
  double prev = m.time;
  bool wasEnded = m.ended;
  m.time = time;
  m.ended = ended;
  if (ended && !m.settings.loop) m.playing = false;
  // "When video hits" (a time beyond the video's length: when it ends) and "When video ends" (a looping video: each
  // time it begins again — unverified).
  bool wrapped = m.settings.loop && m.playing && time + 0.25 < prev;
  bool justEnded = (ended && !wasEnded) || wrapped;
  if (!justEnded && !m.playing) return;
  if (!hasIx(node)) return;
  std::vector<size_t> due;
  auto list = ix(node);
  for (size_t i = 0; i < list.size(); i++) {
    if (list[i].trigger == Trigger::ON_MEDIA_END && justEnded) due.push_back(i);
    if (list[i].trigger != Trigger::ON_MEDIA_HIT) continue;
    double h = list[i].mediaHitTime;
    bool beyond = m.duration > 0 && h >= m.duration;
    bool hit = beyond ? justEnded : wrapped ? (prev < h || h <= time) : (prev < h && h <= time);
    if (hit) due.push_back(i);
  }
  for (size_t i : due) run(node, list[i].actions, nullptr, nullptr);
  if (!due.empty()) changed();
}

void Player::applyMediaFrames() {
  // A video with a frame: its VIDEO fills draw that frame (the live source) instead of the poster, in every item; a
  // GIF's GIF fills instead of their cover frame.
  std::vector<std::tuple<Guid, ImageHash, bool>> live;
  for (auto& [id, m] : media_)
    if (m.shown && m.frame && doc().has(id)) live.emplace_back(id, frameHash(id), m.gif);
  if (live.empty()) return;
  for (PropsOverrides& map : store_)
    for (auto& [id, hash, gif] : live) {
      auto it = map.find(id);
      if (it == map.end()) it = map.emplace(id, *props(id)).first;
      for (Paint& p : it->second.fillPaints)
        if (p.visible && (gif ? paintGifHash(p).present : p.type == PaintType::VIDEO)) p.image = hash;
    }
}

// ---- State ---------------------------------------------------------------------------------------------

std::string Player::saveState() {
  // Keep state on reload (Website behaviours; the page keeps this in its session storage, never the document): what a
  // web app's store and the browser's scroll restoration would keep — the screen, the variables and modes the
  // prototype set, interacted components' states, scroll positions by semantic path.
  json::Writer w;
  w.beginObject().key("v").number(1);
  auto id = [&](const char* k, Guid g) {
    w.key(k);
    if (g == kNoGuid) w.null();
    else w.string(g.toString());
  };
  id("page", page_);
  id("screen", base_);
  id("start", flow_ != kNoGuid ? flow_ : startFrame_);
  w.key("components").beginObject();
  for (const auto& [path, variant] : componentStates_) w.key(path).string(variant.toString());
  w.endObject();
  w.key("nested").beginObject();
  for (const auto& [key, variant] : nestedStates_) w.key(key).string(variant.toString());
  w.endObject();
  // Scroll: what was stored when screens were left, and the screen shown now.
  std::unordered_map<std::string, Vec2> scroll = scrollStore_;
  for (const auto& [frame, off] : scroll_)
    if (doc().has(frame) && (frame == base_ || doc().isAncestor(base_, frame))) scroll[semanticPath(frame)] = off;
  w.key("scroll").beginObject();
  for (const auto& [path, off] : scroll) w.key(path).beginArray().number(off.x).number(off.y).endArray();
  w.endObject();
  // Text typed into text inputs by semantic path (a field bound to a variable is kept with the variables below).
  w.key("typed").beginObject();
  for (const auto& [path, text] : typed_)
    if (!secretPaths_.count(path)) w.key(path).string(text);  // a password is never kept (as a browser's form restore)
  w.endObject();
  // Variables and modes: the fields the player wrote, as they are now.
  w.key("changes").beginArray();
  for (const auto& [node, orig] : originals_) {
    FieldMask mask = orig.mask & (F_VARIABLE_DATA_VALUES | F_VARIABLE_MODES);
    const NodeProps* p = props(node);
    if (!mask || !p) continue;
    NodeChange c = NodeChange::changed(node);
    c.mask = mask;
    copyFields(c.props, *p, mask);
    codec::writeChange(w, c);
  }
  w.endArray();
  w.endObject();
  return w.take();
}

bool Player::restoreState(const std::string& text) {
  json::Value v;
  if (!active() || !json::parse(text, v) || !v.isObject()) return false;
  const json::Value* ver = v.get("v");
  if (!ver || ver->numberOr(0) != 1) return false;
  auto guid = [&](const char* k) {
    const json::Value* g = v.get(k);
    bool ok = false;
    Guid out = g && g->isString() ? Guid::parse(g->string, &ok) : kNoGuid;
    return ok ? out : kNoGuid;
  };
  if (guid("page") != page_) return false;
  Guid screen = guid("screen");
  if (screen == kNoGuid || !frameExists(screen) || topLevelOf(screen) != screen) return false;
  // Variables and modes first (they may show or hide what follows).
  std::vector<NodeChange> changes;
  if (const json::Value* list = v.get("changes"); list && list->isArray())
    for (const json::Value& e : list->array) {
      NodeChange c;
      FieldMask allowed = F_VARIABLE_DATA_VALUES | F_VARIABLE_MODES;
      if (!codec::readChange(e, c) || !doc().has(c.guid) || !(c.mask & allowed)) continue;
      c.mask &= allowed;
      remember(c.guid, c.mask);
      changes.push_back(std::move(c));
    }
  if (!changes.empty()) ed_.applyChanges(changes, APPLY_REMOTE);
  auto states = [&](const char* k, std::unordered_map<std::string, Guid>& out) {
    out.clear();
    if (const json::Value* o = v.get(k); o && o->isObject())
      for (const auto& [path, g] : o->object) {
        bool ok = false;
        Guid id = g.isString() ? Guid::parse(g.string, &ok) : kNoGuid;
        if (ok && doc().has(id)) out[path] = id;
      }
  };
  states("components", componentStates_);
  states("nested", nestedStates_);
  // Typed text: shown again by its fields (syncWeb writes them on the next document version check).
  typed_.clear();
  if (const json::Value* o = v.get("typed"); o && o->isObject())
    for (const auto& [path, t] : o->object)
      if (t.isString()) typed_[path] = t.string;
  webVersion_ = ~0ull;
  scrollStore_.clear();
  if (const json::Value* o = v.get("scroll"); o && o->isObject())
    for (const auto& [path, xy] : o->object)
      if (xy.isArray() && xy.array.size() == 2) scrollStore_[path] = {xy.array[0].numberOr(0), xy.array[1].numberOr(0)};
  // The screen, its components and scroll as they were.
  for (auto& o : overlays_) dropTimers(o.frame);
  overlays_.clear();
  history_.clear();
  layout();
  if (screen != base_) {
    Guid left = base_;
    replaceScreen(screen);
    scroll_.erase(left);
  } else {
    Action a;
    a.stateVersion = 1;
    carryComponentStates(base_, a);
    carryScroll(kNoGuid, base_, a);
  }
  layout();
  Vec2 range = topScrollRange(base_);
  if (auto it = scroll_.find(base_); it != scroll_.end()) it->second = {std::min(it->second.x, range.x), std::min(it->second.y, range.y)};
  changed();
  return true;
}

std::string Player::stateJson() const {
  json::Writer w;
  auto id = [&](Guid g) {
    if (g == kNoGuid) w.null();
    else w.string(g.toString());
  };
  auto nameOf = [&](Guid g) {
    const NodeProps* p = props(g);
    return p ? p->name : std::string();
  };
  w.beginObject();
  w.key("active").boolean(active());
  w.key("page");
  id(page_);
  w.key("screen");
  id(base_);
  w.key("screenName").string(nameOf(base_));
  w.key("flow");
  id(flow_);
  Flow f;
  std::string flowName;
  if (const NodeProps* fp = props(flow_); fp && flowStart(*fp, f)) flowName = f.name;
  w.key("flowName").string(flowName);
  w.key("flows").beginArray();
  if (page_ != kNoGuid)
    for (const Flow& x : flows(doc(), page_)) {
      w.beginObject().key("node");
      id(x.node);
      w.key("name").string(x.name).key("description").string(x.description).endObject();
    }
  w.endArray();
  w.key("overlays").beginArray();
  for (auto& o : overlays_) id(o.frame);
  w.endArray();
  w.key("history").number(static_cast<double>(history_.size()));
  w.key("canBack").boolean(!history_.empty());
  std::vector<Guid> seq = active() ? sequence() : std::vector<Guid>{};
  auto it = std::find(seq.begin(), seq.end(), base_);
  w.key("canNext").boolean(it != seq.end() && it + 1 != seq.end());
  w.key("canPrevious").boolean(it != seq.end() && it != seq.begin());
  w.key("scale").string(scaleName(scale_));
  w.key("scaleOrder").beginArray();
  if (active())
    for (ScaleMode m : scaleOrder()) w.string(scaleName(m));
  w.endArray();
  w.key("hints").boolean(hints_);
  w.key("shortcuts").boolean(shortcuts_);
  w.key("websiteBehaviours").boolean(web_);
  // Bumped by every action that changes the prototype's state (the page saves the kept state when it moves).
  w.key("actions").number(static_cast<double>(actionCounter_));
  {
    // Figma's recommended scales (help "Play your prototypes"): the first frame's width, every frame 16:9.
    double first = 0;
    bool wide = true;
    int frames = 0;
    std::vector<Guid> seq = active() ? sequence() : std::vector<Guid>{};
    if (!seq.empty())
      if (const NodeProps* fp = props(seq.front())) first = fp->size.x;
    if (page_ != kNoGuid)
      for (Guid c : screens(doc(), page_)) {
        const NodeProps* cp = props(c);
        if (!cp || !cp->visible || !cp->isFrameLike() || cp->type == NodeType::SECTION || cp->size.y <= 0) continue;
        frames++;
        wide &= std::fabs(cp->size.x / cp->size.y - 16.0 / 9.0) < 0.01;
      }
    auto own = responsiveSizes_.find(seq.empty() ? kNoGuid : seq.front());
    if (own != responsiveSizes_.end()) first = own->second.x;
    w.key("firstFrameWidth").number(first);
    w.key("allWide").boolean(frames > 0 && wide);
  }
  w.key("device").boolean(page_ != kNoGuid && props(page_) && !pageDevice(page_).none);
  {
    Device dev = page_ != kNoGuid && props(page_) ? pageDevice(page_) : Device{};
    static const char* types[] = {"NONE", "PRESET", "CUSTOM", "PRESENTATION"};
    w.key("deviceType").string(types[static_cast<int>(dev.type)]);
    w.key("devicePreset").string(dev.preset);
  }
  w.key("hasDeviceFrame").boolean(hasDeviceFrame());
  w.key("deviceFrame").boolean(deviceFrame_);
  w.key("responsive").boolean(responsive_);
  {
    // Bare: the base screen as the page's document — its scroll, its content's size (frame units) and the view's scale
    Vec2 s = scrollOf(base_), range = active() ? topScrollRange(base_) : Vec2{};
    const NodeProps* bp = active() ? props(base_) : nullptr;
    Vec2 box = bp ? Vec2{std::min(bp->size.x, view_.screen.x), std::min(bp->size.y, view_.screen.y)} : Vec2{};
    w.key("baseScroll").beginArray().number(s.x).number(s.y).endArray();
    w.key("content").beginArray().number(range.x + box.x).number(range.y + box.y).endArray();
    w.key("viewScale").number(view_.s);
  }
  {
    Color c;
    w.key("screenColor");
    if (active() && screenColor(c)) {
      char hex[8];
      auto b = [](float v) { return static_cast<int>(std::lround(std::clamp(v, 0.0f, 1.0f) * 255)); };
      std::snprintf(hex, sizeof hex, "#%02x%02x%02x", b(c.r), b(c.g), b(c.b));
      w.string(hex);
    } else
      w.null();
  }
  w.key("scrubbing").boolean(anim_.active && anim_.scrubbing);
  w.key("hotspot").boolean(hotspot_);
  w.key("screenRect").beginObject().key("x").number(view_.css.x).key("y").number(view_.css.y).key("w").number(view_.css.w)
      .key("h").number(view_.css.h).endObject();
  webState(w);
  w.endObject();
  return w.take();
}

}  // namespace eng::proto
