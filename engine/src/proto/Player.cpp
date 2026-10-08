#include "proto/Player.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <optional>

#include "base/FractionalIndex.h"
#include "proto/Devices.h"
#include "render/ImageCache.h"
#include "scene/CodecJson.h"

namespace eng::proto {

namespace {

constexpr double kDragThreshold = 4;  // CSS px before a press becomes a drag
constexpr double kHintsMs = 600;      // hotspot hints flash
constexpr double kSlideOffset = 0.3;  // Slide in / out: how far the other screen moves (of the screen)

double lerp(double a, double b, double t) { return a + (b - a) * t; }

Color lerpColor(const Color& a, const Color& b, double t) {
  return {static_cast<float>(lerp(a.r, b.r, t)), static_cast<float>(lerp(a.g, b.g, t)), static_cast<float>(lerp(a.b, b.b, t)),
          static_cast<float>(lerp(a.a, b.a, t))};
}

// Rotation + translation (and a flip) interpolate as an angle and a position; anything else by components.
Mat2x3 lerpMatrix(const Mat2x3& a, const Mat2x3& b, double t) {
  if (t <= 0) return a;
  if (t >= 1) return b;
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
    out[i].opacity = static_cast<float>(lerp(a[i].opacity, b[i].opacity, t));
    if (a[i].visible != b[i].visible) {
      // One side hidden: fade it.
      out[i].visible = true;
      double from = a[i].visible ? a[i].opacity : 0, to = b[i].visible ? b[i].opacity : 0;
      out[i].opacity = static_cast<float>(lerp(from, to, t));
    }
    if (a[i].stops.size() == b[i].stops.size())
      for (size_t k = 0; k < a[i].stops.size(); k++) {
        out[i].stops[k].color = lerpColor(a[i].stops[k].color, b[i].stops[k].color, t);
        out[i].stops[k].position = lerp(a[i].stops[k].position, b[i].stops[k].position, t);
      }
  }
  return out;
}

// Transition directions: where the incoming screen comes from (FROM_*) or where the outgoing one goes (OUT_TO_*).
Vec2 directionOf(Transition t) {
  switch (t) {
    case Transition::SLIDE_FROM_LEFT: case Transition::PUSH_FROM_LEFT: case Transition::MOVE_FROM_LEFT:
    case Transition::SLIDE_OUT_TO_LEFT: case Transition::MOVE_OUT_TO_LEFT: return {-1, 0};
    case Transition::SLIDE_FROM_RIGHT: case Transition::PUSH_FROM_RIGHT: case Transition::MOVE_FROM_RIGHT:
    case Transition::SLIDE_OUT_TO_RIGHT: case Transition::MOVE_OUT_TO_RIGHT: return {1, 0};
    case Transition::SLIDE_FROM_TOP: case Transition::PUSH_FROM_TOP: case Transition::MOVE_FROM_TOP:
    case Transition::SLIDE_OUT_TO_TOP: case Transition::MOVE_OUT_TO_TOP: return {0, -1};
    case Transition::SLIDE_FROM_BOTTOM: case Transition::PUSH_FROM_BOTTOM: case Transition::MOVE_FROM_BOTTOM:
    case Transition::SLIDE_OUT_TO_BOTTOM: case Transition::MOVE_OUT_TO_BOTTOM: return {0, 1};
    default: return {0, 0};
  }
}
bool isMoveIn(Transition t) { return t >= Transition::MOVE_FROM_LEFT && t <= Transition::MOVE_FROM_BOTTOM; }
bool isMoveOut(Transition t) { return t >= Transition::MOVE_OUT_TO_LEFT && t <= Transition::MOVE_OUT_TO_BOTTOM; }
bool isPush(Transition t) { return t >= Transition::PUSH_FROM_LEFT && t <= Transition::PUSH_FROM_BOTTOM; }
bool isSlideIn(Transition t) { return t >= Transition::SLIDE_FROM_LEFT && t <= Transition::SLIDE_FROM_BOTTOM; }
bool isSlideOut(Transition t) { return t >= Transition::SLIDE_OUT_TO_LEFT && t <= Transition::SLIDE_OUT_TO_BOTTOM; }
bool isSmart(const Action& a) { return a.transition == Transition::SMART_ANIMATE || a.transition == Transition::MAGIC_MOVE; }

// A TEXT layer's content and font: Smart animate dissolves a text whose content changed (and animates one that only
// moved, resized or changed colour).
std::string textSignature(const NodeProps& p) {
  if (p.type != NodeType::TEXT) return std::string();
  const TextFacet& t = p.text();
  char size[32];
  std::snprintf(size, sizeof size, "%g", t.fontSize);
  return t.textData.characters + "\x01" + t.fontName.family + "\x01" + t.fontName.style + "\x01" + size;
}

// The visible shadows of a layer (help.figma.com 360039818874: "Figma does not support smart animate for layers with
// drop shadow and inner shadow effects" — a layer whose shadows differ dissolves instead).
std::vector<Effect> shadowsOf(const std::vector<Effect>& list) {
  std::vector<Effect> out;
  for (const Effect& e : list)
    if (e.visible && e.isShadow()) out.push_back(e);
  return out;
}

// Layer and background blurs (and texture / noise) animate: their radius and colour, when both sides have the
// same effects in the same order; otherwise the destination's.
std::vector<Effect> lerpEffects(const std::vector<Effect>& a, const std::vector<Effect>& b, double t) {
  if (a.size() != b.size()) return t < 0.5 ? a : b;
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

bool Player::hasIx(Guid id) const {
  const NodeProps* p = props(id);
  if (!p) return false;
  if (hasInteractions(*p)) return true;
  if (p->type != NodeType::INSTANCE) return false;
  const NodeProps* m = props(ed_.mainOf(id));
  return m && hasInteractions(*m);
}

std::vector<Interaction> Player::ix(Guid id) const {
  const NodeProps* p = props(id);
  if (!p) return {};
  if (hasInteractions(*p)) return interactions(*p);
  if (p->type != NodeType::INSTANCE) return {};
  const NodeProps* m = props(ed_.mainOf(id));
  return m ? interactions(*m) : std::vector<Interaction>{};
}

Guid Player::topLevelOf(Guid id) const {
  Guid cur = id;
  for (int guard = 0; guard < 4096 && cur != kNoGuid; guard++) {
    Guid parent = doc().parentOf(cur);
    const NodeProps* pp = props(parent);
    if (!pp) return kNoGuid;
    if (pp->type == NodeType::CANVAS) return cur;
    cur = parent;
  }
  return kNoGuid;
}

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
  page_ = page;
  if (ed_.page() != page) ed_.setCurrentPage(page);
  ed_.derivePage(page);
  Guid frame = start != kNoGuid ? topLevelOf(start) : kNoGuid;
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
  if (!scaleChosen_) {
    // Figma's default scale (help "Play your prototypes", "Recommended"): Fill screen when the device is Presentation
    // or every frame is 16:9; Fit width and height for a custom device; Fit device on screen with a preset
    // (unverified); otherwise Actual size (100%).
    Device dev = device(*pg);
    bool wide = true;
    int frames = 0;
    for (Guid c : doc().children(page)) {
      const NodeProps* cp = props(c);
      if (!cp || !cp->visible || !cp->isFrameLike() || cp->type == NodeType::SECTION || cp->size.y <= 0) continue;
      frames++;
      wide &= std::fabs(cp->size.x / cp->size.y - 16.0 / 9.0) < 0.01;
    }
    scale_ = dev.type == Device::Type::PRESENTATION || (frames > 0 && wide) ? ScaleMode::FILL
             : dev.type == Device::Type::CUSTOM || dev.type == Device::Type::PRESET ? ScaleMode::FIT
                                                                                     : ScaleMode::ACTUAL;
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
  timers_.clear();
  held_.clear();
  pressed_ = Held{};
  hoverChain_ = Chain{};
  downChain_ = Chain{};
  down_ = false;
  clearMedia();
  armTimers(base_);
  layout();
  changed();
  return true;
}

void Player::stop() {
  restoreResponsive();
  dropGhosts();
  instanceAnims_.clear();
  base_ = kNoGuid;
  overlays_.clear();
  timers_.clear();
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

void Player::restart() {
  if (page_ == kNoGuid) return;
  // Runtime writes back as they were.
  if (!originals_.empty()) {
    std::vector<NodeChange> back;
    for (auto& [id, c] : originals_)
      if (doc().has(id)) back.push_back(c);
    originals_.clear();
    ed_.applyChanges(back, APPLY_REMOTE);
  }
  start(page_, flow_ != kNoGuid ? flow_ : startFrame_);
}

std::vector<Guid> Player::sequence() const {
  std::vector<Guid> frames;
  for (Guid c : doc().children(page_))
    if (frameExists(c) && props(c)->isFrameLike() && props(c)->type != NodeType::SECTION) frames.push_back(c);
  // Reading order: left to right, then top to bottom (R8 §9).
  std::stable_sort(frames.begin(), frames.end(), [&](Guid a, Guid b) {
    Mat2x3 ta = props(a)->transform, tb = props(b)->transform;
    if (ta.m02 != tb.m02) return ta.m02 < tb.m02;
    return ta.m12 < tb.m12;
  });
  // With connections: the frames reachable from the flow's start, in the order they are reached.
  bool connected = false;
  std::function<void(Guid, std::vector<std::pair<Navigation, Guid>>&)> collect = [&](Guid id, std::vector<std::pair<Navigation, Guid>>& out) {
    if (!props(id)) return;
    for (auto& i : ix(id))
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
  navigate(*(it + 1), Action{});
  return true;
}

bool Player::previous() {
  auto seq = sequence();
  auto it = std::find(seq.begin(), seq.end(), base_);
  if (it == seq.end() || it == seq.begin()) return false;
  navigate(*(it - 1), Action{});
  return true;
}

void Player::setScale(ScaleMode m) {
  scale_ = m;
  scaleChosen_ = true;
  dirty_ = true;
  if (active()) layout();
  events_.push_back(Event{});
}

void Player::cycleScale() {
  // The options in the menu's order: Actual size, Responsive, Fit width, Fit width and height, Fill screen; with a
  // device: Fit device on screen, Zoom device to fill screen, Show device at 100%.
  bool dev = page_ != kNoGuid && props(page_) && !device(*props(page_)).none;
  static const ScaleMode plain[] = {ScaleMode::ACTUAL, ScaleMode::RESPONSIVE, ScaleMode::FIT_WIDTH, ScaleMode::FIT, ScaleMode::FILL};
  static const ScaleMode withDevice[] = {ScaleMode::FIT, ScaleMode::FILL, ScaleMode::ACTUAL};
  const ScaleMode* list = dev ? withDevice : plain;
  size_t n = dev ? 3 : 5, at = 0;
  for (size_t i = 0; i < n; i++)
    if (list[i] == scale_) at = i;
  setScale(list[(at + 1) % n]);
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

bool Player::hasDeviceFrame() const {
  if (page_ == kNoGuid || !props(page_)) return false;
  Device dev = device(*props(page_));
  const DeviceSpec* spec = nullptr;
  const DeviceModel* model = nullptr;
  return dev.type == Device::Type::PRESET && !dev.none && findDevice(dev.preset, spec, model);
}

// ---- Geometry --------------------------------------------------------------------------------------------

void Player::layout() {
  const Viewport& vp = ed_.viewport();
  double W = std::max(1.0, vp.width), H = std::max(1.0, vp.height);
  Device dev = device(*props(page_));
  // Responsive: the frame takes the window's (or the device screen's) size first.
  if (!fitting_) {
    if (responsiveOn()) fitResponsive();
    else if (!responsiveSizes_.empty()) restoreResponsive();
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
      case ScaleMode::FILL: v.s = std::max(W / tw, H / th); break;
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
    return;
  }
  double fw = std::max(1.0, frame.x), fh = std::max(1.0, frame.y);
  switch (scale_) {
    case ScaleMode::ACTUAL:
    case ScaleMode::RESPONSIVE: v.s = 1; break;
    case ScaleMode::FIT_WIDTH: v.s = W / fw; break;
    case ScaleMode::FIT: v.s = std::min(1.0, std::min(W / fw, H / fh)); break;  // "It will not scale up the prototype"
    case ScaleMode::FILL: v.s = std::max(W / fw, H / fh); break;
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
}

// ---- Responsive -----------------------------------------------------------------------------------------

bool Player::responsiveOn() const {
  if (page_ == kNoGuid || !props(page_)) return false;
  Device dev = device(*props(page_));
  return dev.none ? scale_ == ScaleMode::RESPONSIVE : responsive_;
}

void Player::fitResponsive() {
  // "The contents of the prototype will resize and re-layout as the prototype viewer resizes according to the
  // constraints and auto layout properties applied to the design": the frames shown take the window's width (the
  // device screen's) and its height when they are no taller (a taller one keeps its height and scrolls); their
  // children follow by their constraints and auto layout (the editor's layout runs on a user write — the player's
  // engine is its own, its undo never used; the sizes go back when Responsive is turned off or the presentation
  // stops).
  const Viewport& vp = ed_.viewport();
  Device dev = device(*props(page_));
  Vec2 target = dev.none ? Vec2{std::max(1.0, vp.width), std::max(1.0, vp.height)} : dev.size;
  std::vector<Guid> frames{base_};
  if (anim_.active) {
    frames.push_back(anim_.x.frame);
    frames.push_back(anim_.y.frame);
  }
  std::vector<NodeChange> changes;
  for (Guid f : frames) {
    const NodeProps* p = props(f);
    if (!p || (anim_.active && anim_.x.overlay && f == anim_.x.frame)) continue;
    bool isOverlay = false;
    for (auto& o : overlays_) isOverlay |= o.frame == f;
    if (isOverlay) continue;
    auto it = responsiveSizes_.find(f);
    Vec2 own = it != responsiveSizes_.end() ? it->second : p->size;
    Vec2 want{std::round(target.x), own.y <= target.y ? std::round(target.y) : own.y};
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

void Player::restoreResponsive() {
  if (responsiveSizes_.empty()) return;
  std::vector<NodeChange> changes;
  for (auto& [f, size] : responsiveSizes_) {
    if (!doc().has(f)) continue;
    NodeChange c = NodeChange::changed(f);
    c.mask = F_SIZE;
    c.props.size = size;
    changes.push_back(std::move(c));
  }
  responsiveSizes_.clear();
  fitting_ = true;
  for (const NodeChange& c : changes) ed_.setProps({c.guid}, c, 0);
  fitting_ = false;
  dirty_ = true;
}

Vec2 Player::topScrollRange(Guid frame) const {
  const NodeProps* p = props(frame);
  if (!p) return {};
  Overflow o = overflow(*p);
  // A top-level frame bigger than the screen scrolls (vertically always, horizontally when its overflow says so).
  double rx = (o == Overflow::HORIZONTAL || o == Overflow::BOTH) ? std::max(0.0, p->size.x - view_.screen.x) : 0;
  double ry = std::max(0.0, p->size.y - view_.screen.y);
  return {rx, ry};
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
  return view_.toCss * Mat2x3::translate(-s.scroll.x, -s.scroll.y);
}

Vec2 Player::overlayPos(Guid frame, const OverlaySettings& s, const Action* a, const Hit* hotspot) const {
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

bool Player::hitWalk(Guid id, const Mat2x3& parentCss, Vec2 css, std::vector<Hit>& out, bool root) const {
  const NodeProps* p = props(id);
  if (!p || !p->visible || ghosts_.count(id)) return false;
  // Scrolling: the same offsets the scene draws with.
  Mat2x3 m = root ? parentCss : parentCss * p->transform;
  Vec2 local = m.inverse().apply(css);
  bool inside = local.x >= 0 && local.y >= 0 && local.x <= p->size.x && local.y <= p->size.y;
  if (p->clipsContent() && !inside) return false;
  // Children, topmost first; a nested scrolling frame's children are offset by its scroll.
  Mat2x3 childBase = m;
  Vec2 sc = scrollsNested(id) && !root ? scrollOf(id) : Vec2{};
  const auto& kids = doc().children(id);
  // A nested scrolling frame's Fixed children are drawn above its other children: hit first.
  bool nestedScroll = !root && scrollsNested(id);
  for (int pass = nestedScroll ? 0 : 1; pass < 2; pass++)
    for (auto it = kids.rbegin(); it != kids.rend(); ++it) {
      const NodeProps* cp = props(*it);
      bool fixed = cp && scrollBehavior(*cp) == ScrollBehavior::FIXED;
      if (nestedScroll && (pass == 0) != fixed) continue;
      Mat2x3 cb = childBase;
      if (cp && (sc.x != 0 || sc.y != 0) && !fixed) cb = childBase * Mat2x3::translate(-sc.x, -sc.y);
      if (hitWalk(*it, cb, css, out, false)) {
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
    s.pos = overlays_[static_cast<size_t>(k)].pos;
    s.overlay = true;
    std::vector<Hit> hits;
    if (hitWalk(s.frame, frameCss(s), css, hits, true)) {
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
    const auto& kids = doc().children(base_);
    for (auto it = kids.rbegin(); it != kids.rend(); ++it) {
      const NodeProps* cp = props(*it);
      if (!cp || scrollBehavior(*cp) != ScrollBehavior::FIXED) continue;
      if (hitWalk(*it, view_.toCss, css, hits, false)) {
        hits.push_back({base_, view_.toCss, bp->size});
        c.hits = std::move(hits);
        c.layer = -1;
        return c;
      }
    }
  }
  hits.clear();
  if (hitWalk(base_, frameCss(b), css, hits, true)) {
    c.hits = std::move(hits);
    c.layer = -1;
  }
  return c;
}

// ---- Input -----------------------------------------------------------------------------------------------

bool Player::fire(Guid node, Trigger t, const Hit* hotspot, Held* held) {
  if (!hasIx(node)) return false;
  bool any = false;
  for (const Interaction& i : ix(node)) {
    if (i.trigger != t) continue;
    run(node, i.actions, hotspot, held);
    any = true;
  }
  return any;
}

void Player::hover(const Chain& c) {
  auto contains = [](const Chain& ch, Guid id) {
    for (auto& h : ch.hits)
      if (h.id == id) return true;
    return false;
  };
  // Left: Mouse leave, and While hovering undone.
  for (auto& h : hoverChain_.hits)
    if (!contains(c, h.id) && doc().has(h.id)) fire(h.id, Trigger::MOUSE_LEAVE, &h);
  for (size_t i = 0; i < held_.size();) {
    if (!contains(c, held_[i].anchor)) {
      Held h = std::move(held_[i]);
      held_.erase(held_.begin() + static_cast<long>(i));
      for (auto it = h.revert.rbegin(); it != h.revert.rend(); ++it) (*it)();
    } else {
      i++;
    }
  }
  // Entered: Mouse enter, While hovering (deepest first).
  Chain before = hoverChain_;
  hoverChain_ = c;
  for (auto& h : c.hits) {
    if (contains(before, h.id)) continue;
    fire(h.id, Trigger::MOUSE_ENTER, &h);
    if (!hasIx(h.id)) continue;
    for (const Interaction& i : ix(h.id)) {
      if (i.trigger != Trigger::ON_HOVER) continue;
      Held held;
      held.anchor = h.id;
      run(h.id, i.actions, &h, &held);
      held_.push_back(std::move(held));
    }
  }
  // The pointer is a hand over anything that reacts to a click, and over links.
  bool hand = linkAt(c, hoverCss_) != nullptr;
  for (auto& h : c.hits) {
    if (!hasIx(h.id)) continue;
    for (auto& i : ix(h.id))
      hand |= i.trigger == Trigger::ON_CLICK || i.trigger == Trigger::ON_PRESS || i.trigger == Trigger::MOUSE_DOWN ||
              i.trigger == Trigger::MOUSE_UP || i.trigger == Trigger::DRAG;
  }
  if (hand != hotspot_) {
    hotspot_ = hand;
    events_.push_back(Event{});
  }
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

uint32_t Player::pointer(PointerEvent type, double x, double y, uint32_t /*buttons*/, uint32_t /*mods*/) {
  if (!active()) return 0;
  layout();
  Vec2 css{x, y};
  hoverCss_ = css;
  switch (type) {
    case PointerEvent::MOVE: {
      Chain c = hitTest(css);
      hover(c);
      if (scrub_.active) {
        // On drag: the transition follows the pointer along its axis.
        double p = std::clamp(((css.x - scrub_.from.x) * scrub_.axis.x + (css.y - scrub_.from.y) * scrub_.axis.y) / scrub_.extent, 0.0, 1.0);
        if (anim_.active && anim_.scrubbing && p != anim_.scrubP) {
          anim_.scrubP = p;
          dirty_ = true;
        }
        return 1;
      }
      if (down_ && !dragFired_ && (css - downCss_).length() >= kDragThreshold) {
        dragFired_ = true;
        uint64_t before = animSerial_;
        for (auto& h : downChain_.hits)
          if (doc().has(h.id) && fire(h.id, Trigger::DRAG, &h)) break;
        if (animSerial_ != before && anim_.active) beginScrub(css);
      }
      return 1;
    }
    case PointerEvent::DOWN: {
      Chain c = hitTest(css);
      hover(c);
      down_ = true;
      dragFired_ = false;
      downCss_ = css;
      downChain_ = c;
      for (auto& h : c.hits)
        if (fire(h.id, Trigger::MOUSE_DOWN, &h)) break;
      for (auto& h : c.hits) {
        if (!hasIx(h.id)) continue;
        bool any = false;
        for (const Interaction& i : ix(h.id)) {
          if (i.trigger != Trigger::ON_PRESS) continue;
          pressed_ = Held{};
          pressed_.anchor = h.id;
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
      if (scrub_.active) endScrub();
      Held p = std::move(pressed_);
      pressed_ = Held{};
      for (auto it = p.revert.rbegin(); it != p.revert.rend(); ++it) (*it)();
      Chain c = hitTest(css);
      for (auto& h : c.hits)
        if (fire(h.id, Trigger::MOUSE_UP, &h)) break;
      bool clicked = false;
      if (!dragFired_) {
        // On click: the deepest layer pressed and released on that reacts to a click.
        for (auto& h : c.hits) {
          bool wasDown = false;
          for (auto& d : downChain_.hits) wasDown |= d.id == h.id;
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
      }
      downChain_ = Chain{};
      return 1;
    }
    case PointerEvent::LEAVE: hover(Chain{}); return 1;
    case PointerEvent::CANCEL:
      down_ = false;
      if (scrub_.active) endScrub();
      return 1;
    default: return 0;
  }
}

uint32_t Player::wheel(double x, double y, double dx, double dy) {
  if (!active()) return 0;
  layout();
  Chain c = hitTest({x, y});
  double s = view_.s > 0 ? view_.s : 1;
  Vec2 d{dx / s, dy / s};
  auto apply = [&](Guid frame, Vec2 range) {
    Vec2 cur = scrollOf(frame);
    Vec2 next{std::clamp(cur.x + d.x, 0.0, range.x), std::clamp(cur.y + d.y, 0.0, range.y)};
    if (next.x == cur.x && next.y == cur.y) return false;
    scroll_[frame] = next;
    dirty_ = true;
    return true;
  };
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
  // Key / Gamepad interactions: the topmost overlay's first, then the screen's.
  std::vector<int> pressed{keyCode};
  if (mods & MOD_SHIFT) pressed.push_back(kShift);
  if (mods & MOD_CTRL) pressed.push_back(kCtrl);
  if (mods & MOD_ALT) pressed.push_back(kAlt);
  if (mods & MOD_META) pressed.push_back(kMeta);
  std::sort(pressed.begin(), pressed.end());
  pressed.erase(std::unique(pressed.begin(), pressed.end()), pressed.end());
  std::vector<Guid> roots;
  for (auto it = overlays_.rbegin(); it != overlays_.rend(); ++it) roots.push_back(it->frame);
  roots.push_back(base_);
  for (Guid root : roots) {
    bool handled = false;
    std::function<void(Guid)> walk = [&](Guid id) {
      if (handled) return;
      const NodeProps* p = props(id);
      if (!p || !p->visible) return;
      // Deepest first.
      const auto& kids = doc().children(id);
      for (auto it = kids.rbegin(); it != kids.rend() && !handled; ++it) walk(*it);
      if (handled || !hasIx(id)) return;
      for (const Interaction& i : ix(id)) {
        if (i.trigger != Trigger::ON_KEY_DOWN || i.keyCodes.empty()) continue;
        std::vector<int> want = i.keyCodes;
        std::sort(want.begin(), want.end());
        want.erase(std::unique(want.begin(), want.end()), want.end());
        if (want != pressed) continue;
        run(id, i.actions, nullptr, nullptr);
        handled = true;
        return;
      }
    };
    walk(root);
    if (handled) return 1;
  }
  if (mods & (MOD_META | MOD_CTRL | MOD_ALT)) return 0;
  // The presentation's shortcuts (R8 §9).
  switch (keyCode) {
    case 82: restart(); return 1;             // R
    case 39: case 32: case 78: next(); return 1;  // → Space N
    case 37: previous(); return 1;            // ←
    case 90: cycleScale(); return 1;          // Z
    default: return 0;
  }
}

// ---- Actions ---------------------------------------------------------------------------------------------

void Player::run(Guid source, const std::vector<Action>& actions, const Hit* hotspot, Held* held) {
  for (const Action& a : actions) runAction(source, a, hotspot, held);
}

void Player::runAction(Guid source, const Action& a, const Hit* hotspot, Held* held) {
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
            if (base_ != from) back();
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
    case Connection::CONDITIONAL: {
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
        run(source, b.actions, hotspot, held);
        return;
      }
      return;
    }
    default: return;
  }
}

void Player::navigate(Guid dest, const Action& a, bool record) {
  if (!frameExists(dest)) return;
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
  held_.clear();
  base_ = dest;
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
  changed();
}

bool Player::back() {
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
  overlays_ = h.overlays;
  scroll_[base_] = h.baseScroll;
  held_.clear();
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
  changed();
  return true;
}

void Player::openOverlay(Guid dest, const Action& a, const Hit* hotspot, Held* held) {
  Guid frame = topLevelOf(dest);
  if (frame == kNoGuid || !frameExists(frame)) return;
  layout();
  for (auto& o : overlays_)
    if (o.frame == frame) return;  // already open
  Shown s;
  s.frame = frame;
  s.settings = overlaySettings(*props(frame));
  s.pos = overlayPos(frame, s.settings, &a, hotspot);
  HistoryEntry h;
  h.base = base_;
  h.baseScroll = scrollOf(base_);
  h.overlays = overlays_;
  h.via = a;
  h.overlayOpen = true;
  history_.push_back(std::move(h));
  overlays_.push_back(s);
  scroll_.erase(frame);
  // Open overlay never smart-animates (R8 §5): its animation is the overlay's own entrance.
  Action an = a;
  if (isSmart(an)) an.transition = Transition::DISSOLVE;
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
  layout();
  if (overlays_.empty()) {
    openOverlay(dest, a, nullptr, nullptr);
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
  bool animate = a.transition != Transition::INSTANT && durationOf(a) > 0;
  Snapshot from;
  if (animate) from = snapshot(instance, true);
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
  remember(real, F_SYMBOL_DATA | F_COMPONENT_PROP_ASSIGNMENTS);
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
  if (animate && doc().has(instance)) {
    for (auto& x : instanceAnims_)
      if (x.instance == instance) dropGhost(x.ghost);
    instanceAnims_.erase(std::remove_if(instanceAnims_.begin(), instanceAnims_.end(), [&](const InstanceAnim& x) { return x.instance == instance; }),
                         instanceAnims_.end());
    InstanceAnim ia;
    ia.instance = instance;
    ia.ghost = ghost;
    ia.from = std::move(from);
    ia.action = a;
    ia.duration = durationOf(a) * 1000;
    instanceAnims_.push_back(std::move(ia));
  }
  dropTimers(instance);
  armTimers(instance);
  mediaDirty_ = true;
  dirty_ = true;
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
  swapInstance(inst, dest, a);
  if (held) {
    if (held->anchor != kNoGuid && (held->anchor == source) && source != inst && doc().isAncestor(inst, source)) held->anchor = inst;
    held->revert.push_back([this, inst, old, a] {
      if (doc().has(inst) && ed_.mainOf(inst) != old) swapInstance(inst, old, a);
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
    if (pp->type == NodeType::CANVAS) {
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
  for (Guid c : doc().children(page_)) targets.push_back(c);
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
  if (anim_.active) finishAnim();
  if (noAnim_) return;
  animSerial_++;
  a.active = true;
  a.duration = durationOf(a.action) * 1000;
  a.start = now_;
  a.started = false;
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

bool Player::animating() const { return (anim_.active && !anim_.scrubbing) || !instanceAnims_.empty() || !scrollAnims_.empty() || hintsPending_ || now_ - hintsAt_ < kHintsMs; }

void Player::armTimers(Guid root) {
  std::function<void(Guid)> walk = [&](Guid id) {
    const NodeProps* p = props(id);
    if (!p || !p->visible) return;
    if (hasIx(id)) {
      auto list = ix(id);
      for (size_t i = 0; i < list.size(); i++)
        if (list[i].trigger == Trigger::AFTER_TIMEOUT) timers_.push_back({id, i, -1, list[i].timeout * 1000});
    }
    for (Guid c : doc().children(id)) walk(c);
  };
  walk(root);
}

void Player::dropTimers(Guid root) {
  timers_.erase(std::remove_if(timers_.begin(), timers_.end(),
                               [&](const Timer& t) { return t.node == root || doc().isAncestor(root, t.node) || !doc().has(t.node); }),
                timers_.end());
}

double Player::progress(const Anim& a) const {
  double v;
  if (a.scrubbing) {
    v = a.scrubP;
  } else {
    double t = a.duration > 0 ? std::clamp((now_ - a.start) / a.duration, 0.0, 1.0) : 1;
    v = a.p0 + (a.p1 - a.p0) * ease(a.action, t);
  }
  return a.reverse ? 1 - v : v;
}

// ---- On drag ---------------------------------------------------------------------------------------------

void Player::beginScrub(Vec2 at) {
  Transition t = anim_.action.transition;
  Vec2 dir = directionOf(t);
  Vec2 axis;
  if (dir.x != 0 || dir.y != 0) {
    // The incoming screen comes from `dir` (dragging the other way pulls it in); an outgoing one leaves towards it.
    bool out = isMoveOut(t) || isSlideOut(t);
    axis = out ? dir : Vec2{-dir.x, -dir.y};
  } else {
    // Dissolve, Smart animate: the way the drag started, on its main axis.
    Vec2 d = at - downCss_;
    axis = std::fabs(d.x) >= std::fabs(d.y) ? Vec2{d.x >= 0 ? 1.0 : -1.0, 0} : Vec2{0, d.y >= 0 ? 1.0 : -1.0};
  }
  scrub_.active = true;
  scrub_.axis = axis;
  scrub_.from = downCss_;
  scrub_.extent = std::max(1.0, (axis.x != 0 ? view_.screen.x : view_.screen.y) * view_.s);
  anim_.scrubbing = true;
  anim_.scrubP = std::clamp(((at.x - downCss_.x) * axis.x + (at.y - downCss_.y) * axis.y) / scrub_.extent, 0.0, 1.0);
  dirty_ = true;
}

void Player::endScrub() {
  scrub_ = Scrub{};
  if (!anim_.active || !anim_.scrubbing) return;
  // Released: on to the end past half way, else back to where it started (and the step undone).
  double p = anim_.scrubP, full = anim_.duration;
  anim_.scrubbing = false;
  anim_.p0 = p;
  anim_.started = false;
  if (p >= 0.5) {
    anim_.p1 = 1;
    anim_.duration = full * (1 - p);
  } else {
    anim_.p1 = 0;
    anim_.duration = full * p;
    anim_.done = [this] { silentBack(); };
  }
  dirty_ = true;
}

void Player::silentBack() {
  noAnim_ = true;
  back();
  noAnim_ = false;
}

bool Player::tick(double nowMs) {
  now_ = nowMs;
  bool draw = dirty_;
  if (anim_.active && !anim_.scrubbing) {
    if (!anim_.started) {
      anim_.start = now_;
      anim_.started = true;
    }
    draw = true;
    if (now_ - anim_.start >= anim_.duration) finishAnim();
  }
  for (size_t i = 0; i < instanceAnims_.size();) {
    auto& ia = instanceAnims_[i];
    if (!ia.started) {
      ia.start = now_;
      ia.started = true;
    }
    draw = true;
    if (now_ - ia.start >= ia.duration || !doc().has(ia.instance)) {
      Guid g = ia.ghost;
      instanceAnims_.erase(instanceAnims_.begin() + static_cast<long>(i));
      dropGhost(g);
    } else {
      i++;
    }
  }
  for (size_t i = 0; i < scrollAnims_.size();) {
    auto& s = scrollAnims_[i];
    if (!s.started) {
      s.start = now_;
      s.started = true;
    }
    double t = s.duration > 0 ? std::clamp((now_ - s.start) / s.duration, 0.0, 1.0) : 1;
    double e = ease(s.action, t);
    scroll_[s.frame] = {lerp(s.from.x, s.to.x, e), lerp(s.from.y, s.to.y, e)};
    draw = true;
    if (t >= 1) scrollAnims_.erase(scrollAnims_.begin() + static_cast<long>(i));
    else i++;
  }
  if (hintsPending_) {
    hintsPending_ = false;
    hintsAt_ = now_;
  }
  if (now_ - hintsAt_ < kHintsMs + 50) draw = true;
  // After delay.
  std::vector<Timer> due;
  for (auto& t : timers_) {
    if (t.at < 0) t.at = now_ + t.delayMs;
    else if (now_ >= t.at) due.push_back(t);
  }
  if (!due.empty()) {
    timers_.erase(std::remove_if(timers_.begin(), timers_.end(), [&](const Timer& t) { return t.at >= 0 && now_ >= t.at; }), timers_.end());
    for (auto& t : due) {
      if (!props(t.node)) continue;
      auto list = ix(t.node);
      if (t.interaction < list.size()) run(t.node, list[t.interaction].actions, nullptr, nullptr);
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

void Player::snapWalk(Snapshot& s, Guid id, const Mat2x3& parentRel, const std::string& key, bool root, bool rootTransform) const {
  const NodeProps* p = props(id);
  if (!p) return;
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
  s.byKey.emplace(key, std::move(n));
  std::unordered_map<std::string, int> seen;
  for (Guid c : doc().children(id)) {
    const NodeProps* cp = props(c);
    if (!cp) continue;
    int k = seen[cp->name]++;
    snapWalk(s, c, rel, key + "/" + cp->name + "#" + std::to_string(k), false, rootTransform);
  }
}

Player::Snapshot Player::snapshot(Guid root, bool rootTransform) const {
  Snapshot s;
  snapWalk(s, root, Mat2x3{}, std::string(), true, rootTransform);
  return s;
}

bool Player::animatable(const SnapNode& s, const NodeProps& p) const {
  if (s.text != textSignature(p)) return false;
  return shadowsOf(s.effects) == shadowsOf(p.effects);
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
  auto it = from.byKey.find(key);
  if (it != from.byKey.end() && (root || animatable(it->second, *np))) {
    const SnapNode& s = it->second;
    interpRel = lerpMatrix(s.rel, destRel, p);
    NodeProps q = *np;
    q.size = {lerp(s.size.x, np->size.x, p), lerp(s.size.y, np->size.y, p)};
    double toOpacity = np->visible ? np->opacity : 0;
    q.opacity = lerp(s.opacity, toOpacity, p);
    if (!np->visible && q.opacity > 0) q.visible = true;
    q.fillPaints = lerpPaints(s.fills, np->fillPaints, p);
    q.strokePaints = lerpPaints(s.strokes, np->strokePaints, p);
    q.strokeWeight = lerp(s.strokeWeight, np->strokeWeight, p);
    for (size_t k = 0; k < 4; k++) q.cornerRadii[k] = lerp(s.radii[k], np->cornerRadii[k], p);
    q.effects = lerpEffects(s.effects, np->effects, p);
    if (!(root && !rootTransform)) q.transform = parentInterp.inverse() * interpRel;
    out[id] = std::move(q);
  } else {
    unmatched = true;
    interpRel = parentInterp * own;
    if (!parentUnmatched) {
      NodeProps q = *np;
      q.opacity *= p;
      out[id] = std::move(q);
    }
  }
  std::unordered_map<std::string, int> seen;
  for (Guid c : doc().children(id)) {
    const NodeProps* cp = props(c);
    if (!cp) continue;
    int k = seen[cp->name]++;
    smartDest(c, from, p, rootTransform, out, interpRel, destRel, key + "/" + cp->name + "#" + std::to_string(k), false,
              unmatched || parentUnmatched);
  }
}

void Player::smartSource(Guid id, const std::unordered_set<std::string>& keys, double p, PropsOverrides& out, const std::string& key,
                         bool root, bool parentUnmatched) const {
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
    q.opacity *= 1 - p;
    out[id] = std::move(q);
  }
  std::unordered_map<std::string, int> seen;
  for (Guid c : kids) {
    const NodeProps* cp = props(c);
    if (!cp) continue;
    int k = seen[cp->name]++;
    smartSource(c, keys, p, out, key + "/" + cp->name + "#" + std::to_string(k), false, !matched || parentUnmatched);
  }
}

// ---- The scene -------------------------------------------------------------------------------------------

void Player::scrollOverrides(Guid frame, PropsOverrides& out, bool topLevel, Vec2 topScroll) const {
  auto shift = [&](Guid child, Vec2 sc, bool sticky) {
    const NodeProps* cp = props(child);
    if (!cp) return;
    auto it = out.find(child);
    NodeProps q = it != out.end() ? it->second : *cp;
    if (sticky) {
      // Scrolls until its top reaches the frame's top, then stays there.
      double y0 = q.transform.m12;
      q.transform = Mat2x3::translate(-sc.x, -sc.y + std::max(0.0, sc.y - y0)) * q.transform;
    } else {
      q.transform = Mat2x3::translate(-sc.x, -sc.y) * q.transform;
    }
    out[child] = std::move(q);
  };
  std::function<void(Guid, bool)> walk = [&](Guid id, bool root) {
    const NodeProps* p = props(id);
    if (!p || !p->visible) return;
    if (root && topLevel) {
      // A top-level frame scrolls as a whole (the scene's matrix); sticky children pin to the screen's top.
      if (topScroll.y > 0)
        for (Guid c : doc().children(id)) {
          const NodeProps* cp = props(c);
          if (!cp || scrollBehavior(*cp) != ScrollBehavior::STICKY) continue;
          auto it = out.find(c);
          NodeProps q = it != out.end() ? it->second : *cp;
          double y0 = q.transform.m12;
          q.transform = Mat2x3::translate(0, std::max(0.0, topScroll.y - y0)) * q.transform;
          out[c] = std::move(q);
        }
    } else if (scrollsNested(id)) {
      Vec2 sc = scrollOf(id);
      if (sc.x != 0 || sc.y != 0)
        for (Guid c : doc().children(id)) {
          const NodeProps* cp = props(c);
          if (!cp) continue;
          ScrollBehavior b = scrollBehavior(*cp);
          if (b == ScrollBehavior::FIXED) continue;
          shift(c, sc, b == ScrollBehavior::STICKY);
        }
    }
    for (Guid c : doc().children(id)) walk(c, false);
  };
  walk(frame, true);
}

void Player::addFrame(const Side& s, Vec2 offset, double alpha, PropsOverrides&& overrides, double fixedAlpha) {
  const NodeProps* p = props(s.frame);
  if (!p) return;
  scrollOverrides(s.frame, overrides, !s.overlay, s.scroll);
  // Instances changing state inside it.
  for (auto& ia : instanceAnims_) {
    if (ia.instance != s.frame && !doc().isAncestor(s.frame, ia.instance)) continue;
    double t = ia.duration > 0 ? std::clamp((now_ - ia.start) / ia.duration, 0.0, 1.0) : 1;
    if (!ia.started) t = 0;
    double e = ease(ia.action, t);
    PropsOverrides tmp;
    if (isSmart(ia.action)) {
      smartDest(ia.instance, ia.from, e, true, tmp, Mat2x3{}, Mat2x3{}, std::string(), true, false);
      // The old state's unmatched layers fade out over it (help: layers that don't match dissolve).
      if (ia.ghost != kNoGuid && doc().has(ia.ghost)) smartSource(ia.ghost, matchedKeys(ia.from, ia.instance, true), e, tmp, std::string(), true, false);
    } else {
      // Dissolve: the new state fades in over the old one.
      if (const NodeProps* ip = props(ia.instance)) {
        NodeProps q = *ip;
        q.opacity *= e;
        tmp[ia.instance] = std::move(q);
      }
      if (ia.ghost != kNoGuid)
        if (const NodeProps* gp = props(ia.ghost)) {
          NodeProps q = *gp;
          q.opacity *= 1 - e;
          tmp[ia.ghost] = std::move(q);
        }
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
    Mat2x3 unscrolled = Mat2x3::translate(offset.x * view_.s, offset.y * view_.s) * view_.toCss;
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
  Transition t = a->action.transition;
  Vec2 dir = directionOf(t);
  Vec2 S = view_.screen;
  Vec2 d{dir.x * S.x, dir.y * S.y};
  bool hasX = x && x->frame != kNoGuid && doc().has(x->frame), hasY = y && y->frame != kNoGuid && doc().has(y->frame);
  // Overlay backgrounds fade with their overlay.
  if (a->smart && hasX && hasY) {
    PropsOverrides src, dst;
    std::unordered_set<std::string> keys = matchedKeys(a->fromSnap, y->frame, false);
    smartSource(x->frame, keys, p, src, std::string(), true, false);
    smartDest(y->frame, a->fromSnap, p, false, dst, Mat2x3{}, Mat2x3{}, std::string(), true, false);
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
  if (!a->smart && a->action.smartAnimate && hasX && hasY && !x->overlay && !y->overlay && (dir.x != 0 || dir.y != 0)) {
    Vec2 offX, offY;
    if (isMoveIn(t)) offY = {d.x * (1 - p), d.y * (1 - p)};
    else if (isMoveOut(t)) offX = {d.x * p, d.y * p};
    else if (isPush(t)) offX = {-d.x * p, -d.y * p}, offY = {d.x * (1 - p), d.y * (1 - p)};
    else if (isSlideIn(t)) offX = {-d.x * p * kSlideOffset, -d.y * p * kSlideOffset}, offY = {d.x * (1 - p), d.y * (1 - p)};
    else if (isSlideOut(t)) offY = {-d.x * (1 - p) * kSlideOffset, -d.y * (1 - p) * kSlideOffset}, offX = {d.x * p, d.y * p};
    addMatching(*x, *y, *a, p, offX, offY);
    return;
  }
  auto drawX = [&](Vec2 off, double alpha) {
    if (!hasX) return;
    background(*x, alpha);
    addFrame(*x, off, alpha, {});
  };
  auto drawY = [&](Vec2 off, double alpha) {
    if (!hasY) return;
    background(*y, alpha);
    addFrame(*y, off, alpha, {});
  };
  if (isMoveIn(t)) {
    drawX({}, 1);
    drawY({d.x * (1 - p), d.y * (1 - p)}, 1);
  } else if (isMoveOut(t)) {
    drawY({}, 1);
    drawX({d.x * p, d.y * p}, 1);
  } else if (isPush(t)) {
    drawX({-d.x * p, -d.y * p}, 1);
    drawY({d.x * (1 - p), d.y * (1 - p)}, 1);
  } else if (isSlideIn(t)) {
    drawX({-d.x * p * kSlideOffset, -d.y * p * kSlideOffset}, 1);
    drawY({d.x * (1 - p), d.y * (1 - p)}, 1);
  } else if (isSlideOut(t)) {
    drawY({-d.x * (1 - p) * kSlideOffset, -d.y * (1 - p) * kSlideOffset}, 1);
    drawX({d.x * p, d.y * p}, 1);
  } else {
    // Dissolve (and Smart animate with nothing to match): the new one fades in over the old.
    if (hasX && hasY) {
      drawX({}, 1);
      drawY({}, p);
    } else {
      drawX({}, 1 - p);
      drawY({}, p);
    }
  }
}

void Player::addFixed(const Side& s, Vec2 offset, const std::function<double(Guid, const std::string&)>& alphaOf) {
  if (s.overlay || !props(s.frame)) return;
  PropsOverrides own;
  std::vector<Guid> drawn;
  std::unordered_map<std::string, int> seen;
  for (Guid c : doc().children(s.frame)) {
    const NodeProps* cp = props(c);
    if (!cp) continue;
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
  Mat2x3 unscrolled = Mat2x3::translate(offset.x * view_.s, offset.y * view_.s) * view_.toCss;
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

void Player::addMatching(const Side& x, const Side& y, const Anim& a, double p, Vec2 offX, Vec2 offY) {
  // help.figma.com 360039818874: "Layers that don't match: Figma will use the main transition you select. Layers that
  // do match: Figma will Smart animate any differences … Fixed layers that do match: Figma won't apply any
  // transition. Fixed layers that don't match: Figma will apply a dissolve transition" — and the frames' fills move
  // with the main transition ("Figma also doesn't include a frame's fill as part of the animation").
  std::unordered_set<std::string> keys = matchedKeys(a.fromSnap, y.frame, false);
  keys.erase(std::string());
  // A screen moving with the transition: its matching layers hidden (their match draws them), the unmatched layers
  // inside a matching one fading (`inner`: the source fades them out; the destination leaves them to the match).
  auto moving = [&](Guid root, double inner) {
    PropsOverrides out;
    std::function<void(Guid, const std::string&, bool, bool)> walk = [&](Guid id, const std::string& key, bool isRoot, bool underMatch) {
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
        NodeProps q = *np;
        q.opacity *= inner;
        out[id] = std::move(q);
        return;  // its subtree goes with it
      }
      std::unordered_map<std::string, int> seen;
      for (Guid c : doc().children(id)) {
        const NodeProps* cp = props(c);
        if (!cp) continue;
        walk(c, key + "/" + cp->name + "#" + std::to_string(seen[cp->name]++), false, matched);
      }
    };
    walk(root, std::string(), true, false);
    return out;
  };
  bool xOnTop = isMoveOut(a.action.transition) || isSlideOut(a.action.transition);
  auto drawX = [&] { addFrame(x, offX, 1, moving(x.frame, 1 - p), 0); };
  auto drawY = [&] { addFrame(y, offY, 1, moving(y.frame, 0), 0); };
  if (xOnTop) {
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
  std::function<void(Guid, const std::string&, bool)> hide = [&](Guid id, const std::string& key, bool isRoot) {
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
      auto it = dst.find(id);
      NodeProps q = it != dst.end() ? it->second : *np;
      q.visible = false;
      dst[id] = std::move(q);
      return;
    } else {
      return;  // a match: drawn with its (fading-in) unmatched children
    }
    std::unordered_map<std::string, int> seen;
    for (Guid c : doc().children(id)) {
      const NodeProps* cp = props(c);
      if (!cp) continue;
      hide(c, key + "/" + cp->name + "#" + std::to_string(seen[cp->name]++), false);
    }
  };
  hide(y.frame, std::string(), true);
  Side ys = y;
  addFrame(ys, {}, 1, std::move(dst), 0);
  // Fixed layers: a match shows as it ends (no transition), the others dissolve.
  addFixed(x, {}, [&](Guid, const std::string& key) { return keys.count(key) ? 0.0 : 1 - p; });
  addFixed(y, {}, [&](Guid, const std::string& key) { return keys.count(key) ? 1.0 : p; });
}

const PresentScene& Player::scene() {
  scene_.items.clear();
  store_.clear();
  if (!active()) return scene_;
  layout();
  if (mediaDirty_) syncMedia();
  const NodeProps* pg = props(page_);
  scene_.background = pg ? background(*pg) : Color::hex(0x1E1E1E);
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
        s.pos = overlays_[k].pos;
        s.settings = overlays_[k].settings;
        s.overlay = true;
        addSlot(nullptr, &s, nullptr);
      }
      continue;
    }
    if (k >= overlays_.size()) continue;
    Side s;
    s.frame = overlays_[k].frame;
    s.pos = overlays_[k].pos;
    s.settings = overlays_[k].settings;
    s.overlay = true;
    addSlot(nullptr, &s, nullptr);
  }
  // Hotspot hints: every layer that reacts, flashed in blue.
  double since = now_ - hintsAt_;
  if (since >= 0 && since < kHintsMs) {
    double alpha = since < kHintsMs * 0.6 ? 1 : 1 - (since - kHintsMs * 0.6) / (kHintsMs * 0.4);
    std::vector<std::pair<Guid, Mat2x3>> roots{{base_, frameCss(base)}};
    for (auto& o : overlays_) {
      Side s;
      s.frame = o.frame;
      s.pos = o.pos;
      s.overlay = true;
      roots.emplace_back(o.frame, frameCss(s));
    }
    for (auto& [root, m] : roots) {
      std::function<void(Guid, const Mat2x3&, bool)> walk = [&](Guid id, const Mat2x3& parent, bool isRoot) {
        const NodeProps* p = props(id);
        if (!p || !p->visible) return;
        Mat2x3 mm = isRoot ? parent : parent * p->transform;
        if (!isRoot && hasIx(id)) {
          Rect r = transformedBounds(mm, p->size.x, p->size.y);
          PresentItem h;
          h.kind = PresentItem::Kind::Rect;
          h.rect = r;
          h.color = Color::hex(0x0D99FF);
          h.alpha = 0.25 * alpha;
          h.border = 1;
          h.borderColor = Color::hex(0x0D99FF);
          h.radius = 2;
          h.clip = true;
          h.clipCss = view_.css;
          scene_.items.push_back(h);
        }
        Vec2 sc = scrollsNested(id) && !isRoot ? scrollOf(id) : Vec2{};
        for (Guid c : doc().children(id)) walk(c, sc.x != 0 || sc.y != 0 ? mm * Mat2x3::translate(-sc.x, -sc.y) : mm, false);
      };
      walk(root, m, true);
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
    if (k >= 0) m.video = paintVideoHash(p->fillPaints[static_cast<size_t>(k)]);
    m.settings = videoSettings(*p);
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
  if (!p || videoFill(*p) < 0) return nullptr;
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
    if (videoFill(*p) >= 0 && seen.insert(id).second) shown.push_back(id);
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
  // A video with a frame: its VIDEO fills draw that frame (the live source) instead of the poster, in every item.
  std::vector<std::pair<Guid, ImageHash>> live;
  for (auto& [id, m] : media_)
    if (m.shown && m.frame && doc().has(id)) live.emplace_back(id, frameHash(id));
  if (live.empty()) return;
  for (PropsOverrides& map : store_)
    for (auto& [id, hash] : live) {
      auto it = map.find(id);
      if (it == map.end()) it = map.emplace(id, *props(id)).first;
      for (Paint& p : it->second.fillPaints)
        if (p.type == PaintType::VIDEO && p.visible) p.image = hash;
    }
}

// ---- State ---------------------------------------------------------------------------------------------

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
  w.key("hints").boolean(hints_);
  w.key("device").boolean(page_ != kNoGuid && props(page_) && !device(*props(page_)).none);
  {
    Device dev = page_ != kNoGuid && props(page_) ? device(*props(page_)) : Device{};
    static const char* types[] = {"NONE", "PRESET", "CUSTOM", "PRESENTATION"};
    w.key("deviceType").string(types[static_cast<int>(dev.type)]);
    w.key("devicePreset").string(dev.preset);
  }
  w.key("hasDeviceFrame").boolean(hasDeviceFrame());
  w.key("deviceFrame").boolean(deviceFrame_);
  w.key("responsive").boolean(responsive_);
  w.key("scrubbing").boolean(anim_.active && anim_.scrubbing);
  w.key("hotspot").boolean(hotspot_);
  w.key("screenRect").beginObject().key("x").number(view_.css.x).key("y").number(view_.css.y).key("w").number(view_.css.w)
      .key("h").number(view_.css.h).endObject();
  w.endObject();
  return w.take();
}

}  // namespace eng::proto
