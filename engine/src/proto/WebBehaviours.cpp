// The player's website behaviours (docs/engine.md §3.4 "Website behaviours"; the plan:
// docs/research/prototype-web-behaviours.md §2, items 1–5, 10, 11). Everything here is what a browser does for a web
// page, folded into Figma's prototype model, behind the presentation's Options › Advanced settings › "Website
// behaviours" (Player::setWebBehaviours; off, the player is Figma's):
//
// - Text inputs (Prototype › Text input, NodeChange.prototypeTextInput): a click or Tab focuses the text layer, the page's
//   hidden <textarea> takes the typing (caret, selection, IME, clipboard) and hands the text here (textInput); the layer
//   shows it (APPLY_REMOTE, put back on stop / Restart) — its own characters are the placeholder while it is empty, a
//   password shows bullets; a layer whose characters are bound to a string variable writes the variable instead (two-way,
//   like v-model), else the text is kept by semantic path and shown again by the same field on the next screen.
// - Keyboard focus: the focusable layers (click / press hotspots, text inputs, texts with links) in Tab order — auto
//   layout in its direction, free layers in reading order —, the top modal overlay's only (a focus trap) when one is
//   open; keyboard focus shows a ring (:focus-visible) or switches the instance to its "Focus" variant, and runs the
//   layer's hover interactions while it is focused (Figma's accessible mode).
// - Keys, after the prototype's own Key / Gamepad triggers: Tab / ⇧Tab, Enter and Space activate (Space not on links),
//   Esc leaves a text input or closes the top overlay that closes on a click outside, arrows and Home / End move focus
//   within an auto-layout group (a menu, tabs, a list), ↓ from an overlay's opener goes into it.
// - Focus return: an overlay that opens takes the focus (a modal always, a popover when opened by a key) and gives it
//   back to what had it when it closes.
// - Cursors: Prototype › Cursor (NodeChange.prototypeCursor), inherited like CSS's; else text over inputs, pointer over
//   click hotspots and links, grab over drag hotspots, not-allowed over disabled instances.
// - Disabled instances: a variant value "Disabled" or a boolean component property "Disabled" on — no interactions,
//   not focusable; hovers pass to the parent.
#include <algorithm>
#include <cctype>
#include <cmath>
#include <functional>

#include "proto/Player.h"
#include "text/TextEdit.h"
#include "text/Unicode.h"

namespace eng::proto {

namespace {

constexpr int kTab = 9, kEnter = 13, kEsc = 27, kSpace = 32, kEnd = 35, kHome = 36, kLeft = 37, kUp = 38, kRight = 39, kDown = 40;

std::string lower(std::string s) {
  for (char& c : s) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  return s;
}

std::string trim(const std::string& s) {
  size_t a = s.find_first_not_of(" \t"), b = s.find_last_not_of(" \t");
  return a == std::string::npos ? std::string() : s.substr(a, b - a + 1);
}

// A variant's name as its properties: "State=Default, Size=Large" → {state: default, size: large} (lower case).
std::vector<std::pair<std::string, std::string>> variantProps(const std::string& name) {
  std::vector<std::pair<std::string, std::string>> out;
  size_t pos = 0;
  while (pos <= name.size()) {
    size_t comma = name.find(',', pos);
    std::string part = name.substr(pos, comma == std::string::npos ? std::string::npos : comma - pos);
    size_t eq = part.find('=');
    if (eq != std::string::npos) out.emplace_back(lower(trim(part.substr(0, eq))), lower(trim(part.substr(eq + 1))));
    if (comma == std::string::npos) break;
    pos = comma + 1;
  }
  return out;
}

bool isFocusValue(const std::string& v) { return v == "focus" || v == "focused" || v == "focus visible" || v == "focus-visible"; }

bool clickTrigger(Trigger t) { return t == Trigger::ON_CLICK || t == Trigger::ON_PRESS || t == Trigger::MOUSE_DOWN || t == Trigger::MOUSE_UP; }

uint32_t length16(const std::string& s) { return static_cast<uint32_t>(text::utf8To16(s).size()); }

}  // namespace

// ---- Switch and state ------------------------------------------------------------------------------------------

void Player::setWebBehaviours(bool on) {
  if (web_ == on) return;
  if (!on) {
    blur();
    focusReturns_.clear();
  }
  web_ = on;
  cursor_ = hotspot_ ? Cursor::POINTER : Cursor::DEFAULT;
  dirty_ = true;
  events_.push_back(Event{});
}

void Player::resetWeb() {
  // A fresh prototype: nothing focused or typed (what was written goes back with the originals).
  focusHeld_ = Held{};
  focusVariant_ = false;
  focusKey_.clear();
  focusVisible_ = false;
  focusReturns_.clear();
  webOverlays_.clear();
  webBase_ = kNoGuid;
  field_ = Field{};
  fieldOn_ = false;
  typed_.clear();
  placeholders_.clear();
  webVersion_ = ~0ull;
  lastKeyboard_ = false;
  cursor_ = Cursor::DEFAULT;
}

Cursor Player::cursorNow() const {
  if (scrollDrag_.active || (anim_.active && anim_.scrubbing)) return Cursor::GRABBING;
  return cursor_;
}

Guid Player::focused() const { return focusKey_.empty() ? kNoGuid : byKey(focusKey_); }

Guid Player::focusedField() const { return fieldOn_ ? byKey(field_.key) : kNoGuid; }

void Player::webState(json::Writer& w) const {
  w.key("webBehaviours").boolean(web_);
  w.key("cursor").string(cssCursor(cursorNow()));
  Guid f = focused();
  w.key("focus");
  if (f == kNoGuid) w.null();
  else w.string(f.toString());
  w.key("focusVisible").boolean(focusVisible());
  w.key("field");
  Guid node = focusedField();
  if (node == kNoGuid) {
    w.null();
    return;
  }
  static const char* types[] = {"TEXT", "PASSWORD", "EMAIL", "NUMBER", "MULTI_LINE"};
  Mat2x3 m;
  Rect r;
  if (const NodeProps* p = props(node); p && cssOf(node, m)) r = transformedBounds(m, p->size.x, p->size.y);
  w.beginObject()
      .key("id").string(node.toString())
      .key("value").string(field_.value)
      .key("start").number(field_.start)
      .key("end").number(field_.end)
      .key("serial").number(fieldSerial_)
      .key("type").string(types[static_cast<int>(field_.settings.type)])
      .key("maxLength").number(field_.settings.maxLength)
      .key("rect").beginObject().key("x").number(r.x).key("y").number(r.y).key("w").number(r.w).key("h").number(r.h).endObject()
      .endObject();
}

// ---- What a layer is -------------------------------------------------------------------------------------------

bool Player::instanceDisabled(Guid inst) const {
  const NodeProps* p = props(inst);
  if (!p || p->type != NodeType::INSTANCE) return false;
  Guid main = ed_.mainOf(inst);
  const NodeProps* mp = props(main);
  if (!mp) return false;
  // A variant value "Disabled" (State=Disabled, any property).
  Guid set = doc().parentOf(main);
  const NodeProps* sp = props(set);
  bool inSet = sp && sp->isComponentSet();
  if (inSet)
    for (auto& [k, v] : variantProps(mp->name))
      if (v == "disabled") return true;
  // A boolean component property "Disabled": the instance's value (bound to a variable: its value now), else the
  // property's default.
  const std::vector<ComponentPropDef>& defs = inSet ? sp->comp().componentPropDefs : mp->comp().componentPropDefs;
  for (const ComponentPropDef& d : defs) {
    if (d.type != ComponentPropType::BOOL || lower(trim(d.name)) != "disabled") continue;
    bool on = d.initialValue.hasBool && d.initialValue.boolValue;
    for (const ComponentPropAssignment& a : p->comp().componentPropAssignments) {
      if (a.defID != d.id) continue;
      if (a.boundValue.present()) {
        Editor::Resolved r;
        if (ed_.resolvedValue(inst, "componentProperties." + d.name, r) && r.kind == Editor::Resolved::Kind::BOOL) on = r.b;
      } else if (a.value.hasBool) {
        on = a.value.boolValue;
      }
    }
    if (on) return true;
  }
  return false;
}

bool Player::disabled(Guid id) const {
  for (Guid cur = id; cur != kNoGuid; cur = doc().parentOf(cur)) {
    const NodeProps* p = props(cur);
    if (!p || p->type == NodeType::CANVAS) break;
    if (p->type == NodeType::INSTANCE && instanceDisabled(cur)) return true;
  }
  return false;
}

bool Player::textInputOf(Guid id, TextInputSettings* s) const {
  const NodeProps* p = props(id);
  TextInputSettings settings;
  if (!p || !p->visible || !proto::textInput(*p, settings)) return false;
  if (s) *s = settings;
  return true;
}

bool Player::isLink(Guid id) const {
  // Navigate / Open link hotspots are links (Figma's accessible prototypes; the web's <a>): Enter, not Space.
  if (hasIx(id))
    for (const Interaction& i : ix(id))
      if (i.trigger == Trigger::ON_CLICK && !i.actions.empty()) {
        const Action& a = i.actions.front();
        return a.connection == Connection::URL || (a.connection == Connection::INTERNAL_NODE && a.navigation == Navigation::NAVIGATE);
      }
  const NodeProps* p = props(id);
  if (p && p->type == NodeType::TEXT)
    if (const text::TextLayout* L = ed_.textLayout(id); L && !L->links.empty()) return true;
  return false;
}

bool Player::focusable(Guid id) const {
  const NodeProps* p = props(id);
  if (!p || !p->visible || ghosts_.count(id)) return false;
  if (disabled(id)) return false;
  if (textInputOf(id)) return true;
  if (hasIx(id))
    for (const Interaction& i : ix(id))
      if (clickTrigger(i.trigger)) return true;
  if (p->type == NodeType::TEXT && p->text().textData.characters.size() > 0)
    if (const text::TextLayout* L = ed_.textLayout(id); L && !L->links.empty()) return true;
  return false;
}

Guid Player::textVariable(Guid id) const {
  const NodeProps* p = props(id);
  if (!p) return kNoGuid;
  for (const ParamBinding& b : p->parameterConsumptionMap)
    if (b.field == VariableField::TEXT_DATA && b.isVariable() && b.data.kind == VariableData::Kind::ALIAS) return ed_.findVariable(b.data.alias);
  return kNoGuid;
}

// ---- Geometry --------------------------------------------------------------------------------------------------

bool Player::cssOf(Guid id, Mat2x3& out) const {
  // The layer's space → CSS px as the scene draws it (hitWalk's walk: scrolled frames offset their children, Fixed
  // children don't move).
  Guid top = topLevelOf(id);
  if (top == kNoGuid) return false;
  Mat2x3 m;
  Vec2 inner;
  if (top == base_) {
    Side b = baseSide();
    m = frameCss(b);
    inner = b.scroll - topShift(base_, b.scroll);
  } else {
    bool found = false;
    for (const Shown& o : overlays_)
      if (o.frame == top) {
        Side s;
        s.frame = o.frame;
        s.pos = o.pos;
        s.overlay = true;
        m = frameCss(s);
        found = true;
      }
    if (!found) return false;
  }
  std::vector<Guid> path;
  for (Guid cur = id; cur != top; cur = doc().parentOf(cur)) {
    if (cur == kNoGuid) return false;
    path.push_back(cur);
  }
  Guid parent = top;
  for (auto it = path.rbegin(); it != path.rend(); ++it) {
    const NodeProps* p = props(*it);
    if (!p) return false;
    bool fixed = scrollBehavior(*p) == ScrollBehavior::FIXED;
    Vec2 sc = parent == top ? inner : scrollsNested(parent) ? scrollOf(parent) : Vec2{};
    Mat2x3 base = m;
    if (parent == base_ && fixed) base = view_.toCss;
    else if (!fixed && (sc.x != 0 || sc.y != 0)) base = m * Mat2x3::translate(-sc.x, -sc.y);
    m = base * p->transform;
    parent = *it;
  }
  out = m;
  return true;
}

Player::Hit Player::hitOf(Guid id) const {
  Hit h;
  h.id = id;
  if (const NodeProps* p = props(id)) h.size = p->size;
  cssOf(id, h.toCss);
  return h;
}

void Player::scrollIntoView(Guid id) {
  // Keyboard focus scrolls the layer into view (the web's focus()): its closest scrolling frame, or the screen.
  layout();
  const NodeProps* p = props(id);
  Mat2x3 m;
  if (!p || !cssOf(id, m)) return;
  Rect r = transformedBounds(m, p->size.x, p->size.y);
  double s = view_.s > 0 ? view_.s : 1;
  for (Guid a = doc().parentOf(id); a != kNoGuid; a = doc().parentOf(a)) {
    bool top = a == base_;
    if (!top && !scrollsNested(a)) {
      if (topLevelOf(a) == a) break;
      continue;
    }
    Rect box = view_.css;
    if (!top) {
      Mat2x3 am;
      const NodeProps* ap = props(a);
      if (!ap || !cssOf(a, am)) return;
      box = transformedBounds(am, ap->size.x, ap->size.y);
    }
    double dy = r.y < box.y ? r.y - box.y : r.bottom() > box.bottom() ? std::min(r.bottom() - box.bottom(), r.y - box.y) : 0;
    double dx = r.x < box.x ? r.x - box.x : r.right() > box.right() ? std::min(r.right() - box.right(), r.x - box.x) : 0;
    if (dx == 0 && dy == 0) return;
    Vec2 range = scrollRange(a, top);
    Vec2 cur = scrollOf(a);
    scroll_[a] = {std::clamp(cur.x + dx / s, 0.0, range.x), std::clamp(cur.y + dy / s, 0.0, range.y)};
    dirty_ = true;
    return;
  }
}

// ---- Focus -----------------------------------------------------------------------------------------------------

std::vector<Guid> Player::focusOrder() const {
  std::vector<Guid> out;
  if (!active() || !web_) return out;
  // The roots Tab goes through: from the top modal overlay (an overlay with a background: the page under it is inert),
  // else the screen and every overlay (overlays come after it, as portals at the end of a page's body).
  std::vector<Guid> roots;
  int from = -1;
  const Guid now = focused();
  for (int k = static_cast<int>(overlays_.size()) - 1; k >= 0; k--)
    if (overlays_[static_cast<size_t>(k)].settings.background) {
      from = k;
      break;
    }
  if (from < 0) roots.push_back(base_);
  for (size_t k = static_cast<size_t>(std::max(from, 0)); k < overlays_.size(); k++) roots.push_back(overlays_[k].frame);
  std::function<void(Guid, bool)> walk = [&](Guid id, bool root) {
    const NodeProps* p = props(id);
    if (!p || !p->visible || ghosts_.count(id)) return;
    // The focused layer stays in the order while it shows a state without the hotspot (its Focus variant).
    if (!root && (id == now || focusable(id))) out.push_back(id);
    if (p->type == NodeType::INSTANCE && instanceDisabled(id)) return;
    std::vector<Guid> kids = doc().children(id);
    if (!p->isAutoLayout()) {
      // Free layers in reading order: rows top to bottom (a layer whose top is within half the row's first height
      // joins it), left to right in a row.
      struct Item {
        Guid id;
        double x, y, h;
      };
      std::vector<Item> items;
      for (Guid c : kids)
        if (const NodeProps* cp = props(c)) {
          Rect b = transformedBounds(cp->transform, cp->size.x, cp->size.y);
          items.push_back({c, b.x, b.y, b.h});
        }
      std::stable_sort(items.begin(), items.end(), [](const Item& a, const Item& b) { return a.y < b.y; });
      kids.clear();
      for (size_t i = 0; i < items.size();) {
        size_t j = i + 1;
        double limit = items[i].y + std::max(1.0, items[i].h / 2);
        while (j < items.size() && items[j].y < limit) j++;
        std::stable_sort(items.begin() + static_cast<long>(i), items.begin() + static_cast<long>(j), [](const Item& a, const Item& b) { return a.x < b.x; });
        for (size_t k = i; k < j; k++) kids.push_back(items[k].id);
        i = j;
      }
    }
    for (Guid c : kids) walk(c, false);
  };
  for (Guid r : roots) walk(r, true);
  return out;
}

Guid Player::firstFocusable(Guid root) const {
  for (Guid id : focusOrder())
    if (id == root || doc().isAncestor(root, id)) return id;
  return kNoGuid;
}

Guid Player::focusVariantOf(Guid inst) const {
  // The variant of the instance's set that differs from the one shown in one property only, whose value is "Focus"
  // ("Focused", "Focus visible"): the component's :focus state.
  Guid main = ed_.mainOf(inst);
  const NodeProps* mp = props(main);
  Guid set = doc().parentOf(main);
  const NodeProps* sp = props(set);
  if (!mp || !sp || !sp->isComponentSet()) return kNoGuid;
  auto mine = variantProps(mp->name);
  if (mine.empty()) return kNoGuid;
  for (Guid v : doc().children(set)) {
    const NodeProps* vp = props(v);
    if (v == main || !vp || vp->type != NodeType::SYMBOL) continue;
    auto theirs = variantProps(vp->name);
    if (theirs.size() != mine.size()) continue;
    int diff = 0;
    bool focus = false;
    for (auto& [k, val] : theirs) {
      auto it = std::find_if(mine.begin(), mine.end(), [&](const auto& m) { return m.first == k; });
      if (it == mine.end()) {
        diff = 99;
        break;
      }
      if (it->second != val) {
        diff++;
        focus = isFocusValue(val);
      }
    }
    if (diff == 1 && focus) return v;
  }
  return kNoGuid;
}

void Player::focus(Guid id, bool visible) {
  if (!props(id)) return;
  std::string key = keyOf(id);
  if (key == focusKey_) {
    if (visible && !focusVisible_) {
      undoFocusState();
      focusVisible_ = true;
      applyFocusState();
    }
    if (visible) scrollIntoView(focused());
    dirty_ = true;
    return;
  }
  undoFocusState();
  focusKey_ = key;
  focusVisible_ = visible;
  TextInputSettings s;
  fieldOn_ = textInputOf(id, &s);
  field_ = Field{};
  if (fieldOn_) {
    field_.key = key;
    field_.path = semanticPath(id);
    field_.settings = s;
    field_.variable = textVariable(id);
    if (field_.variable != kNoGuid) {
      field_.value = props(id)->text().textData.characters;
    } else if (auto t = typed_.find(field_.path); t != typed_.end()) {
      field_.value = t->second;
    }
    field_.start = field_.end = field_.anchor = length16(field_.value);
    fieldSerial_++;
  }
  applyFocusState();
  if (visible) scrollIntoView(focused());
  dirty_ = true;
  events_.push_back(Event{});
}

void Player::blur() {
  if (focusKey_.empty() && !fieldOn_) return;
  undoFocusState();
  focusKey_.clear();
  focusVisible_ = false;
  fieldOn_ = false;
  field_ = Field{};
  dirty_ = true;
  events_.push_back(Event{});
}

void Player::applyFocusState() {
  Guid id = focused();
  if (id == kNoGuid) return;
  bool field = fieldOn_;
  if (!focusVisible_ && !field) return;  // a click's focus shows nothing (:focus-visible)
  focusHeld_ = Held{};
  focusHeld_.id = ++heldSerial_;
  focusHeld_.anchor = focusHeld_.hotspot = id;
  focusHeld_.anchorKey = focusHeld_.hotspotKey = focusKey_;
  focusVariant_ = false;
  // The component's Focus variant: on the layer itself, else on the closest instance holding it (a text input's
  // field box).
  for (Guid cur = id; cur != kNoGuid; cur = doc().parentOf(cur)) {
    const NodeProps* p = props(cur);
    if (!p || p->type == NodeType::CANVAS || topLevelOf(cur) == cur) break;
    if (p->type != NodeType::INSTANCE) continue;
    Guid v = focusVariantOf(cur);
    if (v != kNoGuid) {
      Guid before = ed_.mainOf(cur);
      std::string key = keyOf(cur);
      swapInstance(cur, v, Action{});
      focusVariant_ = true;
      focusHeld_.revert.push_back([this, key, before, v] {
        Guid now = byKey(key);
        if (now != kNoGuid && ed_.mainOf(now) == v) swapInstance(now, before, Action{});
      });
    }
    break;  // only the closest instance
  }
  // Keyboard focus on a hotspot runs its While hovering (Figma's accessible mode: hover interactions fire while a
  // clickable element has keyboard focus), unless the pointer hovers it already.
  if (!focusVariant_ && focusVisible_ && !field) {
    Guid now = focused();
    bool hovered = false;
    for (auto& h : held_) hovered |= h.hotspotKey == focusKey_;
    if (now != kNoGuid && !hovered && hasIx(now)) {
      Hit h = hitOf(now);
      for (const Interaction& i : ix(now))
        if (i.trigger == Trigger::ON_HOVER) run(now, i.actions, &h, &focusHeld_);
    }
  }
  dirty_ = true;
}

void Player::undoFocusState() {
  Held h = std::move(focusHeld_);
  focusHeld_ = Held{};
  focusVariant_ = false;
  for (auto it = h.revert.rbegin(); it != h.revert.rend(); ++it) (*it)();
  if (!h.revert.empty()) dirty_ = true;
}

void Player::activate(Guid id) {
  // Enter / Space on a focused hotspot: what a click does (Mouse down, Mouse up, On click), from its own state (a Focus
  // variant goes first, and comes back after).
  const NodeProps* p = props(id);
  if (!p) return;
  if (!hasIx(id) && p->type == NodeType::TEXT) {
    if (const text::TextLayout* L = ed_.textLayout(id); L && !L->links.empty()) {
      text::LinkBox l = L->links.front();
      follow(l);
    }
    return;
  }
  std::string key = focusKey_;
  Guid screen = base_;
  uint64_t shown = screenSignature();
  undoFocusState();
  Guid now = byKey(key);
  if (now == kNoGuid) now = id;
  Hit h = hitOf(now);
  fire(now, Trigger::MOUSE_DOWN, &h);
  if (doc().has(now)) fire(now, Trigger::MOUSE_UP, &h);
  if (Guid again = doc().has(now) ? now : byKey(key); again != kNoGuid) {
    h.id = again;
    fire(again, Trigger::ON_CLICK, &h);
  }
  // Still focused there (not navigated away): its focus state again.
  if (base_ == screen && screenSignature() == shown && focusKey_ == key && byKey(key) != kNoGuid) applyFocusState();
}

bool Player::moveFocus(int dir) {
  std::vector<Guid> order = focusOrder();
  if (order.empty()) return false;
  Guid cur = focused();
  int n = static_cast<int>(order.size());
  int at = -1;
  for (int i = 0; i < n; i++)
    if (order[static_cast<size_t>(i)] == cur) at = i;
  int next = at < 0 ? (dir > 0 ? 0 : n - 1) : ((at + dir) % n + n) % n;
  focus(order[static_cast<size_t>(next)], true);
  return true;
}

bool Player::arrowFocus(int keyCode) {
  std::vector<Guid> order = focusOrder();
  if (order.empty()) return false;
  Guid cur = focused();
  // Into an open menu: ↓ from the overlay's opener (or with nothing focused) goes to its first item.
  if (!overlays_.empty() && keyCode == kDown) {
    Guid top = overlays_.back().frame;
    bool opener = cur == kNoGuid || (!focusReturns_.empty() && focusReturns_.back().overlay == top && focusReturns_.back().key == focusKey_);
    if (opener && (cur == kNoGuid || topLevelOf(cur) != top))
      if (Guid first = firstFocusable(top); first != kNoGuid) {
        focus(first, true);
        return true;
      }
  }
  if (cur == kNoGuid) return false;
  // The closest auto-layout group around it with two focusable items or more, along its direction (a wrapping or
  // grid one both ways); an outer group takes the other direction (tabs in a vertical list).
  for (Guid a = doc().parentOf(cur); a != kNoGuid; a = doc().parentOf(a)) {
    const NodeProps* ap = props(a);
    if (!ap || ap->type == NodeType::CANVAS) break;
    if (!ap->isAutoLayout()) {
      if (topLevelOf(a) == a) break;
      continue;
    }
    // Each child's first focusable (the child itself or inside it).
    std::vector<Guid> items;
    int at = -1;
    for (Guid c : doc().children(a))
      for (Guid f : order)
        if (f == c || doc().isAncestor(c, f)) {
          if (cur == c || doc().isAncestor(c, cur)) at = static_cast<int>(items.size());
          items.push_back(f);
          break;
        }
    if (items.size() < 2 || at < 0) continue;
    StackMode mode = ap->stack().stackMode;
    bool wraps = mode == StackMode::GRID || (mode == StackMode::HORIZONTAL && ap->stack().stackWrap != StackWrap::NO_WRAP);
    bool vertical = mode == StackMode::VERTICAL || wraps, horizontal = mode == StackMode::HORIZONTAL || wraps;
    int n = static_cast<int>(items.size()), next = -1;
    if (keyCode == kHome) next = 0;
    else if (keyCode == kEnd) next = n - 1;
    else if ((keyCode == kDown && vertical) || (keyCode == kRight && horizontal)) next = (at + 1) % n;
    else if ((keyCode == kUp && vertical) || (keyCode == kLeft && horizontal)) next = (at - 1 + n) % n;
    if (next < 0) continue;
    focus(items[static_cast<size_t>(next)], true);
    return true;
  }
  return false;
}

uint32_t Player::webKey(int keyCode, uint32_t mods) {
  bool other = (mods & (MOD_CTRL | MOD_META | MOD_ALT)) != 0;
  if (other) return 0;
  bool shift = (mods & MOD_SHIFT) != 0;
  Guid cur = focused();
  switch (keyCode) {
    case kTab:
      lastKeyboard_ = true;
      return moveFocus(shift ? -1 : 1) ? 1 : 0;
    case kEsc:
      lastKeyboard_ = true;
      // Leaves a text input; else closes the top overlay that a click outside closes (a dismissible one).
      if (fieldOn_) {
        Guid f = focusedField();
        blur();
        (void)f;
        return 1;
      }
      if (!overlays_.empty() && overlays_.back().settings.closeOnClickOutside) {
        Action none;
        closeOverlay(static_cast<int>(overlays_.size()) - 1, &none);
        return 1;
      }
      return 0;
    case kEnter:
      if (shift) return 0;
      lastKeyboard_ = true;
      if (fieldOn_) return 1;  // a single-line field: Enter is no character (its Key / Gamepad trigger ran first)
      if (cur == kNoGuid) return 0;
      activate(cur);
      return 1;
    case kSpace:
      if (shift || cur == kNoGuid || fieldOn_ || isLink(cur)) return 0;  // links take Enter only
      lastKeyboard_ = true;
      activate(cur);
      return 1;
    case kLeft:
    case kUp:
    case kRight:
    case kDown:
    case kHome:
    case kEnd:
      if (shift || fieldOn_) return 0;
      if (arrowFocus(keyCode)) {
        lastKeyboard_ = true;
        return 1;
      }
      return 0;
    default: return 0;
  }
}

// ---- Pointer ---------------------------------------------------------------------------------------------------

uint32_t Player::fieldIndexAt(Guid node, Vec2 css) const {
  if (field_.value.empty()) return 0;
  const text::TextLayout* L = ed_.textLayout(node);
  Mat2x3 m;
  if (!L || !cssOf(node, m)) return length16(field_.value);
  return std::min(L->indexAt(m.inverse().apply(css)), length16(field_.value));
}

void Player::webPointerDown(const Chain& c, Vec2 css) {
  lastKeyboard_ = false;
  // The deepest focusable layer pressed takes the focus (a mouse focus: no ring); pressing nothing focusable blurs.
  for (const Hit& h : c.hits) {
    if (!focusable(h.id)) continue;
    bool wasField = fieldOn_ && keyOf(h.id) == field_.key;
    focus(h.id, false);
    if (fieldOn_) {
      Guid node = focusedField();
      uint32_t i = fieldIndexAt(node, css);
      field_.start = field_.end = field_.anchor = i;
      field_.dragging = true;
      fieldSerial_++;
      (void)wasField;
      dirty_ = true;
    }
    return;
  }
  blur();
}

bool Player::webPointerMove(Vec2 css) {
  if (!fieldOn_ || !field_.dragging || !down_) return false;
  Guid node = focusedField();
  if (node == kNoGuid) return false;
  uint32_t i = fieldIndexAt(node, css);
  uint32_t s = std::min(i, field_.anchor), e = std::max(i, field_.anchor);
  if (s != field_.start || e != field_.end) {
    field_.start = s;
    field_.end = e;
    fieldSerial_++;
    dirty_ = true;
  }
  return true;
}

void Player::webPointerUp() { field_.dragging = false; }

// ---- Text input --------------------------------------------------------------------------------------------------

void Player::textInput(const std::string& value, uint32_t start, uint32_t end) {
  if (!active() || !web_ || !fieldOn_) return;
  Guid node = focusedField();
  if (node == kNoGuid) return;
  std::u16string v = text::utf8To16(value);
  bool changed = false;
  // What the field takes: one line unless Multi-line, digits and signs for Number, up to its Max length.
  if (!field_.settings.multiline()) {
    size_t before = v.size();
    v.erase(std::remove_if(v.begin(), v.end(), [](char16_t ch) { return ch == u'\n' || ch == u'\r'; }), v.end());
    changed |= v.size() != before;
  }
  if (field_.settings.type == TextInputType::NUMBER) {
    size_t before = v.size();
    v.erase(std::remove_if(v.begin(), v.end(), [](char16_t ch) { return !((ch >= u'0' && ch <= u'9') || ch == u'.' || ch == u',' || ch == u'-' || ch == u'+'); }), v.end());
    changed |= v.size() != before;
  }
  if (field_.settings.maxLength > 0 && v.size() > field_.settings.maxLength) {
    v.resize(field_.settings.maxLength);
    changed = true;
  }
  uint32_t n = static_cast<uint32_t>(v.size());
  field_.start = std::min(std::min(start, end), n);
  field_.end = std::min(std::max(start, end), n);
  std::string text8 = text::utf16To8(v);
  if (changed) fieldSerial_++;  // the page's <textarea> takes the filtered text back
  if (text8 == field_.value) {
    dirty_ = true;
    return;
  }
  field_.value = text8;
  if (field_.variable != kNoGuid) {
    VariableData d;
    d.kind = VariableData::Kind::TEXT;
    d.textValue = text8;
    d.dataType = VariableDataType::STRING;
    d.hasDataType = true;
    writeVariable(field_.variable, d, node);
  } else {
    typed_[field_.path] = text8;
    writeField(node, text8, field_.settings);
  }
  actionCounter_++;  // typing is an action: pending After delays and delayed mouse triggers drop
  webVersion_ = ~0ull;
  syncWeb();
  dirty_ = true;
}

void Player::writeField(Guid id, const std::string& value, const TextInputSettings& s) {
  const NodeProps* p = props(id);
  if (!p || p->type != NodeType::TEXT) return;
  auto known = placeholders_.find(id);
  if (known == placeholders_.end()) known = placeholders_.emplace(id, p->text().textData.characters).first;
  // Empty: its own characters (the placeholder); a password: one bullet per unit (the caret's offsets stay the text's).
  std::u16string shown;
  if (value.empty()) shown = text::utf8To16(known->second);
  else if (s.type == TextInputType::PASSWORD) shown.assign(text::utf8To16(value).size(), u'•');
  else shown = text::utf8To16(value);
  TextData td = p->text().textData;
  if (text::utf8To16(td.characters) == shown) return;
  remember(id, F_TEXT_DATA);
  NodeChange c = NodeChange::changed(id);
  c.mask = F_TEXT_DATA;
  c.props.text().textData = td;
  text::replaceRange(c.props.text().textData, 0, text::length16(td), shown, text::styleIdAt(td, 0));
  ed_.applyChanges({c}, APPLY_REMOTE);
  dirty_ = true;
}

// ---- Keeping up with what is shown ------------------------------------------------------------------------------

void Player::syncWeb() {
  if (!active()) return;
  // A new screen: nothing focused (a page load).
  if (base_ != webBase_) {
    if (webBase_ != kNoGuid && focusHeld_.id) leftHeld_.push_back(std::move(focusHeld_));
    focusHeld_ = Held{};
    focusVariant_ = false;
    focusKey_.clear();
    focusVisible_ = false;
    fieldOn_ = false;
    field_ = Field{};
    focusReturns_.clear();
    webOverlays_.clear();
    webBase_ = base_;
    for (const Shown& o : overlays_) webOverlays_.push_back(o.frame);
    webVersion_ = ~0ull;
  }
  if (web_) {
    std::vector<Guid> now;
    for (const Shown& o : overlays_) now.push_back(o.frame);
    if (now != webOverlays_) {
      size_t same = 0;
      while (same < now.size() && same < webOverlays_.size() && now[same] == webOverlays_[same]) same++;
      // Closed (the shown list was cut at `same`): focus back to what had it when each opened, the last first.
      std::string giveBack;
      bool restore = false;
      while (!focusReturns_.empty()) {
        Guid o = focusReturns_.back().overlay;
        bool shown = std::find(now.begin(), now.begin() + static_cast<long>(same), o) != now.begin() + static_cast<long>(same);
        if (shown) break;
        giveBack = focusReturns_.back().key;
        restore = true;
        focusReturns_.pop_back();
      }
      if (restore) {
        Guid back = giveBack.empty() ? kNoGuid : byKey(giveBack);
        if (back != kNoGuid && focusable(back)) focus(back, lastKeyboard_);
        else blur();
      }
      // Opened: it takes the focus — a modal (an overlay with a background) always, another when a key opened it — and
      // gives it back on close.
      for (size_t k = same; k < now.size(); k++) {
        focusReturns_.push_back({now[k], focusKey_});
        bool modal = overlays_[k].settings.background;
        if (modal || lastKeyboard_) {
          if (Guid first = firstFocusable(now[k]); first != kNoGuid) focus(first, lastKeyboard_);
          else if (modal) blur();
        }
      }
      webOverlays_ = now;
    }
    // The focused layer gone (removed, or on a screen no longer shown): nothing focused.
    bool shown = false;
    if (Guid f = focusKey_.empty() ? kNoGuid : focused(); f != kNoGuid) {
      Guid top = topLevelOf(f);
      shown = top == base_;
      for (const Shown& o : overlays_) shown |= o.frame == top;
    }
    if (!focusKey_.empty() && !shown) {
      if (focusHeld_.id) leftHeld_.push_back(std::move(focusHeld_));  // undone once a running change has played
      focusHeld_ = Held{};
      focusVariant_ = false;
      focusKey_.clear();
      focusVisible_ = false;
      fieldOn_ = false;
      field_ = Field{};
      events_.push_back(Event{});
    }
  }
  // Text inputs show what was typed into them (by semantic path): a field on a new screen, or one an instance's change
  // of variant derived anew.
  if (doc().version() == webVersion_) return;
  if (!typed_.empty() || !placeholders_.empty()) {
    std::vector<Guid> roots{base_};
    for (const Shown& o : overlays_) roots.push_back(o.frame);
    std::function<void(Guid)> walk = [&](Guid id) {
      const NodeProps* p = props(id);
      if (!p || ghosts_.count(id)) return;
      TextInputSettings s;
      if (p->type == NodeType::TEXT) {
        if (proto::textInput(*p, s) && textVariable(id) == kNoGuid) {
          auto t = typed_.find(semanticPath(id));
          if (t != typed_.end()) writeField(id, t->second, s);
          else if (placeholders_.count(id)) writeField(id, std::string(), s);
        }
        return;
      }
      for (Guid c : doc().children(id)) walk(c);
    };
    for (Guid r : roots) walk(r);
  }
  webVersion_ = doc().version();
}

// ---- Cursor --------------------------------------------------------------------------------------------------------

void Player::updateCursor(const Chain& c) {
  Cursor cur = hotspot_ ? Cursor::POINTER : Cursor::DEFAULT;
  if (web_) {
    // Like CSS: the deepest layer that says (Prototype › Cursor, inherited by its layers), else the web's defaults.
    cur = Cursor::DEFAULT;
    if (linkAt(c, hoverCss_)) cur = Cursor::POINTER;
    else
      for (const Hit& h : c.hits) {
        const NodeProps* p = props(h.id);
        if (!p) continue;
        if (Cursor own = cursor(*p); own != Cursor::AUTO) {
          cur = own;
          break;
        }
        if (p->type == NodeType::INSTANCE && instanceDisabled(h.id)) {
          cur = Cursor::NOT_ALLOWED;
          break;
        }
        if (textInputOf(h.id)) {
          cur = Cursor::TEXT;
          break;
        }
        if (hasIx(h.id) && !disabled(h.id)) {
          bool click = false, drag = false;
          for (const Interaction& i : ix(h.id)) {
            click |= clickTrigger(i.trigger);
            drag |= i.trigger == Trigger::DRAG;
          }
          if (click || drag) {
            cur = click ? Cursor::POINTER : Cursor::GRAB;
            break;
          }
        }
      }
  }
  if (cur != cursor_) {
    cursor_ = cur;
    events_.push_back(Event{});
  }
}

// ---- Drawing ---------------------------------------------------------------------------------------------------

void Player::addWebItems() {
  if (!web_) return;
  double s = view_.s > 0 ? view_.s : 1;
  // The focus ring (:focus-visible): 2 px of the web's focus blue, 2 px out, following the corners — unless the
  // component shows its Focus variant. A text input's goes round its field (the layer holding the text).
  Guid f = focused();
  if (f != kNoGuid && !focusVariant_ && (focusVisible_ || fieldOn_)) {
    Guid ringed = f;
    if (fieldOn_) {
      Guid parent = doc().parentOf(f);
      if (parent != kNoGuid && topLevelOf(parent) != parent && props(parent)) ringed = parent;
    }
    const NodeProps* p = props(ringed);
    Mat2x3 m;
    if (p && cssOf(ringed, m)) {
      Rect r = transformedBounds(m, p->size.x, p->size.y);
      double gap = 2;
      PresentItem ring;
      ring.kind = PresentItem::Kind::Rect;
      ring.rect = {r.x - gap, r.y - gap, r.w + 2 * gap, r.h + 2 * gap};
      ring.color = Color::hex(0x005FCC);
      ring.alpha = 0;
      ring.border = 2;
      ring.borderColor = Color::hex(0x005FCC);
      ring.borderAlpha = 1;
      double radius = 0;
      for (double c : p->cornerRadii) radius = std::max(radius, c);
      ring.radius = radius > 0 ? radius * s + gap : 0;
      ring.clip = true;
      ring.clipCss = view_.css;
      scene_.items.push_back(ring);
    }
  }
  // A text input's selection and caret (steady, in the text's colour).
  Guid node = focusedField();
  if (node == kNoGuid) return;
  const NodeProps* p = props(node);
  const text::TextLayout* L = ed_.textLayout(node);
  Mat2x3 m;
  if (!p || !L || L->lines.empty() || !cssOf(node, m)) return;
  uint32_t n = field_.value.empty() ? 0 : static_cast<uint32_t>(L->caretXs.empty() ? 0 : L->caretXs.size() - 1);
  uint32_t a = std::min(field_.start, n), b = std::min(field_.end, n);
  if (a != b) {
    for (const Rect& r : L->selectionRects(a, b)) {
      PresentItem sel;
      sel.kind = PresentItem::Kind::Rect;
      sel.rect = transformedBounds(m * Mat2x3::translate(r.x, r.y), r.w, r.h);
      sel.color = Color::hex(0x3390FF);
      sel.alpha = 0.3;
      sel.clip = true;
      sel.clipCss = view_.css;
      scene_.items.push_back(sel);
    }
    return;
  }
  size_t line = L->lineOf(b);
  if (line >= L->lines.size()) line = L->lines.size() - 1;
  double x = L->caretX(b, line);
  const text::LaidLine& ln = L->lines[line];
  double scale = std::sqrt(std::fabs(m.determinant()));
  double w = 1.5 / (scale > 0 ? scale : 1);
  PresentItem caret;
  caret.kind = PresentItem::Kind::Rect;
  caret.rect = transformedBounds(m * Mat2x3::translate(x - w / 2, ln.top), w, ln.height);
  caret.color = Color::hex(0x000000);
  for (const Paint& fill : p->fillPaints)
    if (fill.visible && fill.type == PaintType::SOLID) caret.color = fill.color;
  caret.clip = true;
  caret.clipCss = view_.css;
  scene_.items.push_back(caret);
}

}  // namespace eng::proto
