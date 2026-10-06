// Text editing in the engine (docs/engine.md §7.6): the session (the edited
// TEXT node, its caret and selection as UTF-16 offsets), keys, pointer
// selection, typing and IME, run styles on the selected range, and the
// layouts every TEXT node is drawn and measured with. A session's edits are
// one undo step: each edit commits (so storage gets it at once) and merges
// into the step the session started.

#include <algorithm>
#include <cmath>

#include "editor/Editor.h"
#include "hit/HitTest.h"
#include "layout/Layout.h"
#include "text/TextEdit.h"
#include "text/Unicode.h"

namespace eng {

// ---- Layouts ------------------------------------------------------------------------

const text::TextLayout* Editor::textLayout(Guid id) {
  const Node* n = doc_.get(id);
  if (!n || n->props.type != NodeType::TEXT) return nullptr;
  text::LayoutOptions o = text::optionsFor(n->props);
  uint32_t generation = text::FontRegistry::get().generation();
  CachedText& c = textCache_[id];
  if (c.layout && c.width == o.width && c.height == o.height && c.generation == generation) return c.layout.get();
  c.layout = text::layoutText(n->props, o);
  c.width = o.width;
  c.height = o.height;
  c.generation = generation;
  return c.layout.get();
}

bool Editor::measureText(Guid id, double width, Vec2& size) {
  const Node* n = doc_.get(id);
  if (!n || n->props.type != NodeType::TEXT) return false;
  text::LayoutOptions o;
  o.width = width;
  auto L = text::layoutText(n->props, o);
  // A font still loading: measured again when it arrives. A missing one: the stored size stands (Figma).
  if (L->pendingFont) unmeasured_.insert(id);
  if (L->pendingFont || L->missingFont) return false;
  size = L->size;
  return true;
}

double Editor::firstBaseline(Guid id, Vec2 size) {
  const Node* n = doc_.get(id);
  if (!n || n->props.type != NodeType::TEXT) return -1;
  NodeProps p = n->props;
  p.size = size;
  auto L = text::layoutText(p, text::optionsFor(p));
  return L->lines.empty() ? -1 : L->lines[0].baseline;
}

void Editor::fontsChanged() {
  textCache_.clear();
  needsRender_ = true;
  if (text_.node != kNoGuid) events_.textEdit = true;
  if (unmeasured_.empty() || busy() || txn_.open) return;
  std::vector<Guid> dirty;
  for (Guid id : unmeasured_)
    if (doc_.has(id)) dirty.push_back(id);
  unmeasured_.clear();
  std::sort(dirty.begin(), dirty.end());
  // The sizes the texts should have had: a system change, not an undo step.
  begin(TxnKind::SYSTEM, "Text layout");
  inLayout_ = true;
  Layout(*this).run(dirty);
  inLayout_ = false;
  commit();
}

// ---- Session ------------------------------------------------------------------------

std::u16string Editor::editedText() const {
  const Node* n = doc_.get(text_.node);
  return n ? text::utf8To16(n->props.textData.characters) : std::u16string();
}

void Editor::textChanged() {
  events_.textEdit = true;
  needsRender_ = true;
  text_.blinkStart = timeMs_ > 0 ? timeMs_ : 0;
  text_.caretOn = true;
}

void Editor::setTextSelection(uint32_t anchor, uint32_t focus, bool keepX) {
  uint32_t n = static_cast<uint32_t>(editedText().size());
  text_.anchor = std::min(anchor, n);
  text_.focus = std::min(focus, n);
  if (!keepX) text_.preferredX = -1;
  textChanged();
}

Status Editor::startTextEdit(Guid id, bool selectAll) {
  const Node* n = doc_.get(id);
  if (!n || n->props.type != NodeType::TEXT || n->props.locked) return E_INVALID;
  if (text_.node == id) {
    if (selectAll) setTextSelection(0, static_cast<uint32_t>(editedText().size()));
    return OK;
  }
  endTextEdit();
  if (const text::TextLayout* L = textLayout(id); L && L->missingFont) return E_UNSUPPORTED;  // Figma: fonts first
  text_ = TextSession{};
  text_.node = id;
  uint32_t len = static_cast<uint32_t>(editedText().size());
  text_.anchor = selectAll ? 0 : len;
  text_.focus = len;
  changeSelection({id});
  if (hover_ != kNoGuid) events_.hover = true;
  hover_ = kNoGuid;
  textChanged();
  updateCursor(lastScreen_);
  return OK;
}

void Editor::endTextEdit() {
  if (text_.node == kNoGuid) return;
  Guid id = text_.node;
  bool created = text_.created;
  size_t step = text_.undoCount;
  text_ = TextSession{};
  events_.textEdit = true;
  needsRender_ = true;
  const Node* n = doc_.get(id);
  if (n && n->props.textData.characters.empty()) {
    // Leaving an empty text deletes it (Figma); one the session made leaves no undo step at all.
    bool merge = step && undo_.undoCount() == step && !undo_.canRedo();
    begin(TxnKind::USER, "Delete");
    write(NodeChange::removed(id));
    commit(merge);
    if (merge && created) {
      undo_.dropLast();
      events_.undo = true;
    }
    pruneSelection();
  } else if (n) {
    changeSelection({id});
  }
  updateCursor(lastScreen_);
}

void Editor::textReplace(uint32_t from, uint32_t to, std::u16string_view insert, const char* label) {
  const Node* n = doc_.get(text_.node);
  if (!n) return;
  const NodeProps& p = n->props;
  TextData t = p.textData;
  uint32_t len = text::length16(t);
  from = std::min(from, len);
  to = std::clamp(to, from, len);
  // New text takes the style of what it replaces, else of the character before it.
  uint32_t style = from < to && from < t.characterStyleIDs.size() ? t.characterStyleIDs[from] : text::styleIdAt(t, from);
  text::replaceRange(t, from, to, insert, style);
  NodeChange c = NodeChange::changed(text_.node);
  c.mask = F_TEXT_DATA;
  c.props.textData = t;
  if (p.autoRename) {
    c.mask |= F_NAME;
    c.props.name = text::layerNameFor(t.characters);
  }
  bool merge = text_.undoCount && undo_.undoCount() == text_.undoCount && !undo_.canRedo();
  begin(TxnKind::USER, label);
  write(c);
  flushLayout();
  commit(merge);
  text_.undoCount = undo_.undoCount();
  uint32_t caret = from + static_cast<uint32_t>(insert.size());
  text_.upstream = false;
  setTextSelection(caret, caret);
}

Status Editor::textInput(std::string_view utf8) {
  if (text_.node == kNoGuid) return E_INVALID;
  std::u16string s = text::utf8To16(utf8);
  // Line endings as Figma stores them.
  s.erase(std::remove(s.begin(), s.end(), u'\r'), s.end());
  if (text_.composing) {
    uint32_t from = text_.compStart;
    text_.composing = false;
    textReplace(from, from + text_.compLength, s, "Edit text");
    return OK;
  }
  textReplace(textSelStart(), textSelEnd(), s, "Edit text");
  return OK;
}

Status Editor::textComposition(std::string_view utf8, uint32_t selStart, uint32_t selEnd) {
  if (text_.node == kNoGuid) return E_INVALID;
  std::u16string s = text::utf8To16(utf8);
  if (!text_.composing) {
    text_.compStart = textSelStart();
    text_.compLength = textSelEnd() - textSelStart();
  }
  uint32_t from = text_.compStart;
  textReplace(from, from + text_.compLength, s, "Edit text");
  text_.composing = true;
  text_.compStart = from;
  text_.compLength = static_cast<uint32_t>(s.size());
  uint32_t a = from + std::min<uint32_t>(selStart, text_.compLength), b = from + std::min<uint32_t>(selEnd, text_.compLength);
  setTextSelection(a, b);
  return OK;
}

Status Editor::textCompositionEnd(std::string_view utf8) {
  if (text_.node == kNoGuid) return E_INVALID;
  if (!text_.composing) return textInput(utf8);
  return textInput(utf8);
}

std::string Editor::textSelection() const {
  if (text_.node == kNoGuid) return {};
  std::u16string s = editedText();
  uint32_t a = std::min<uint32_t>(textSelStart(), static_cast<uint32_t>(s.size()));
  uint32_t b = std::min<uint32_t>(textSelEnd(), static_cast<uint32_t>(s.size()));
  return text::utf16To8(std::u16string_view(s).substr(a, b - a));
}

Rect Editor::caretRectCss() const {
  if (text_.node == kNoGuid) return {};
  const text::TextLayout* L = const_cast<Editor*>(this)->textLayout(text_.node);
  if (!L || L->lines.empty()) return {};
  size_t line = L->lineOf(text_.focus, text_.upstream);
  const text::LaidLine& l = L->lines[line];
  double x = L->caretX(text_.focus, line);
  Mat2x3 m = camera_.matrix() * doc_.worldTransform(text_.node);
  Vec2 top = m.apply({x, l.top}), bottom = m.apply({x, l.top + l.height});
  return {top.x, top.y, 0, (bottom - top).length()};
}

// ---- Creating text ----------------------------------------------------------------

void Editor::createTextAt(Vec2 world, double width) {
  // Into the innermost frame under the point (the page when none).
  Guid parent = page_;
  auto path = hitPath(doc_, page_, world, pixel());
  for (auto it = path.rbegin(); it != path.rend(); ++it)
    if (doc_.get(*it)->props.isFrameLike()) {
      parent = *it;
      break;
    }
  NodeProps p = defaultProps(NodeType::TEXT);
  p.name = "Text";
  if (width > 0) {
    p.textAutoResize = TextAutoResize::HEIGHT;
    p.size = {width, 0};
  }
  // Its box starts where the click was, the first line's middle on the pointer.
  double lineHeight = 15;
  if (text::Font* f = text::FontRegistry::get().find(p.fontName)) lineHeight = text::autoLineHeight(f, p.fontSize);
  Vec2 at{std::round(world.x), std::round(width > 0 ? world.y : world.y - lineHeight / 2)};
  p.transform = doc_.worldTransform(parent).inverse() * Mat2x3::translate(at.x, at.y);
  p.parentIndex = {parent, placeAt(parent, doc_.children(parent).size(), kNoGuid)};
  Guid id = newGuid();
  begin(TxnKind::USER, "Create text");
  write(NodeChange::created(id, p));
  flushLayout();
  commit();
  if (tool_ != Tool::MOVE) setTool(Tool::MOVE);
  startTextEdit(id, false);
  text_.created = true;
  text_.undoCount = undo_.undoCount();
}

// ---- Pointer ----------------------------------------------------------------------

uint32_t Editor::textIndexAt(Vec2 screen) const {
  const text::TextLayout* L = const_cast<Editor*>(this)->textLayout(text_.node);
  if (!L) return 0;
  Vec2 local = doc_.worldTransform(text_.node).inverse().apply(camera_.toWorld(screen));
  return L->indexAt(local);
}

uint32_t Editor::textPointerDown(Vec2 s, uint32_t mods, int clickCount) {
  const Node* n = doc_.get(text_.node);
  if (!n) {
    endTextEdit();
    return 0;
  }
  Vec2 local = doc_.worldTransform(text_.node).inverse().apply(camera_.toWorld(s));
  double slop = 4 / camera_.zoom;
  Rect box{-slop, -slop, n->props.size.x + 2 * slop, n->props.size.y + 2 * slop};
  const text::TextLayout* L = textLayout(text_.node);
  if (L) box = box.united(L->inkBounds);
  if (!box.contains(local)) {
    endTextEdit();
    return 0;  // the press goes on as a normal one
  }
  std::u16string str = editedText();
  uint32_t idx = textIndexAt(s);
  text_.granularity = 0;
  if (clickCount >= 3) {
    size_t a, b;
    text::paragraphAt(str, idx, a, b);
    text_.granularity = 2;
    text_.dragStart = static_cast<uint32_t>(a);
    text_.dragEnd = static_cast<uint32_t>(b);
    setTextSelection(text_.dragStart, text_.dragEnd);
  } else if (clickCount == 2) {
    size_t a, b;
    text::wordAt(str, idx, a, b);
    text_.granularity = 1;
    text_.dragStart = static_cast<uint32_t>(a);
    text_.dragEnd = static_cast<uint32_t>(b);
    setTextSelection(text_.dragStart, text_.dragEnd);
  } else if (mods & MOD_SHIFT) {
    setTextSelection(text_.anchor, idx);
  } else {
    setTextSelection(idx, idx);
    // A click past a soft-wrapped line's end puts the caret there, not at the next line's start.
    if (L && !L->lines.empty()) {
      size_t byY = 0;
      while (byY + 1 < L->lines.size() && local.y >= L->lines[byY].top + L->lines[byY].height) byY++;
      text_.upstream = L->lineOf(idx, false) != byY && L->lineOf(idx, true) == byY;
    }
  }
  gesture_ = Gesture::TextSelect;
  return P_HANDLED | P_CAPTURE;
}

void Editor::textDrag(Vec2 s) {
  uint32_t idx = textIndexAt(s);
  if (text_.granularity == 0) {
    text_.upstream = false;
    setTextSelection(text_.anchor, idx);
    return;
  }
  std::u16string str = editedText();
  size_t a, b;
  if (text_.granularity == 1) text::wordAt(str, idx, a, b);
  else text::paragraphAt(str, idx, a, b);
  if (idx < text_.dragStart) setTextSelection(text_.dragEnd, static_cast<uint32_t>(a));
  else setTextSelection(text_.dragStart, std::max(text_.dragEnd, static_cast<uint32_t>(b)));
}

// ---- Keys -------------------------------------------------------------------------

uint32_t Editor::textKey(KeyCode code, uint32_t mods) {
  const text::TextLayout* L = textLayout(text_.node);
  if (!L) {
    endTextEdit();
    return 0;
  }
  const std::u16string& str = L->text;
  const uint32_t n = static_cast<uint32_t>(str.size());
  const bool shift = (mods & MOD_SHIFT) != 0, alt = (mods & MOD_ALT) != 0, primary = (mods & MOD_PRIMARY) != 0;
  uint32_t focus = std::min(text_.focus, n);
  auto lineStart = [&](uint32_t at) { return L->lines[L->lineOf(at, text_.upstream)].start; };
  auto lineEnd = [&](uint32_t at) {
    const text::LaidLine& l = L->lines[L->lineOf(at, text_.upstream)];
    return l.hardEnd ? l.end - 1 : std::min(l.end, n);
  };
  auto moveTo = [&](uint32_t target, bool upstream = false) {
    if (shift) setTextSelection(text_.anchor, target);
    else setTextSelection(target, target);
    text_.upstream = upstream;
  };
  auto erase = [&](uint32_t from, uint32_t to) {
    if (from == to) return;
    textReplace(std::min(from, to), std::max(from, to), u"", "Edit text");
  };
  bool collapsed = text_.anchor == text_.focus;

  switch (code) {
    case KeyCode::Escape: endTextEdit(); return K_HANDLED;
    case KeyCode::ArrowLeft:
    case KeyCode::ArrowRight: {
      bool left = code == KeyCode::ArrowLeft;
      if (!shift && !collapsed && !alt && !primary) {
        moveTo(left ? textSelStart() : textSelEnd());
        return K_HANDLED;
      }
      if (primary) {
        if (left) moveTo(lineStart(focus));
        else moveTo(lineEnd(focus), !L->lines[L->lineOf(focus, text_.upstream)].hardEnd);
      } else if (alt) {
        moveTo(static_cast<uint32_t>(left ? text::prevWordStart(str, focus) : text::nextWordEnd(str, focus)));
      } else {
        moveTo(static_cast<uint32_t>(left ? text::prevGrapheme(str, focus) : text::nextGrapheme(str, focus)));
      }
      return K_HANDLED;
    }
    case KeyCode::ArrowUp:
    case KeyCode::ArrowDown: {
      bool up = code == KeyCode::ArrowUp;
      if (primary) {
        moveTo(up ? 0 : n);
        return K_HANDLED;
      }
      if (alt) {
        // ⌥↑ / ⌥↓: the paragraph's start / end, else the previous one's start / the next one's end.
        size_t a, b;
        text::paragraphAt(str, focus, a, b);
        uint32_t target;
        if (up) {
          if (focus > a || a == 0) target = static_cast<uint32_t>(a);
          else {
            text::paragraphAt(str, a - 1, a, b);
            target = static_cast<uint32_t>(a);
          }
        } else {
          if (focus < b || b >= n) target = static_cast<uint32_t>(b);
          else {
            text::paragraphAt(str, b + 1, a, b);
            target = static_cast<uint32_t>(b);
          }
        }
        moveTo(target);
        return K_HANDLED;
      }
      size_t line = L->lineOf(focus, text_.upstream);
      double x = text_.preferredX >= 0 ? text_.preferredX : L->caretX(focus, line);
      uint32_t target;
      bool upstream = false;
      if (up && line == 0) target = 0;
      else if (!up && line + 1 >= L->lines.size()) target = n;
      else {
        const text::LaidLine& l = L->lines[up ? line - 1 : line + 1];
        target = L->indexAt({x, l.top + l.height / 2});
        upstream = target == l.end && !l.hardEnd;
      }
      if (shift) setTextSelection(text_.anchor, target, true);
      else setTextSelection(target, target, true);
      text_.upstream = upstream;
      text_.preferredX = x;
      return K_HANDLED;
    }
    case KeyCode::Home: moveTo(lineStart(focus)); return K_HANDLED;
    case KeyCode::End: moveTo(lineEnd(focus), true); return K_HANDLED;
    case KeyCode::Backspace:
      if (!collapsed) erase(textSelStart(), textSelEnd());
      else if (primary) erase(lineStart(focus), focus);
      else if (alt) erase(static_cast<uint32_t>(text::prevWordStart(str, focus)), focus);
      else if (focus > 0) {
        // One code point back (Mac's Delete), a whole grapheme for emoji sequences.
        size_t g = text::prevGrapheme(str, focus);
        erase(static_cast<uint32_t>(g), focus);
      }
      return K_HANDLED;
    case KeyCode::Delete:
      if (!collapsed) erase(textSelStart(), textSelEnd());
      else if (primary) erase(focus, lineEnd(focus));
      else if (alt) erase(focus, static_cast<uint32_t>(text::nextWordEnd(str, focus)));
      else erase(focus, static_cast<uint32_t>(text::nextGrapheme(str, focus)));
      return K_HANDLED;
    case KeyCode::Enter:
    case KeyCode::NumpadEnter:
      if (primary) {
        endTextEdit();
        return K_HANDLED;
      }
      textReplace(textSelStart(), textSelEnd(), shift ? u" " : u"\n", "Edit text");
      return K_HANDLED;
    case KeyCode::Tab:
      textReplace(textSelStart(), textSelEnd(), u"\t", "Edit text");
      return K_HANDLED;
    case KeyCode::KeyA:
      if (!primary) return 0;
      setTextSelection(0, n);
      return K_HANDLED;
    case KeyCode::KeyZ:
      if (!primary) return 0;
      endTextEdit();
      undoStep(shift);
      return K_HANDLED;
    case KeyCode::KeyB:
    case KeyCode::KeyI:
    case KeyCode::KeyU:
      if (!primary || shift) return 0;
      textToggleStyle(code, mods);
      return K_HANDLED;
    case KeyCode::KeyX:
      if (!primary || !shift) return 0;
      textToggleStyle(code, mods);
      return K_HANDLED;
    default: return 0;
  }
}

void Editor::textToggleStyle(KeyCode code, uint32_t /*mods*/) {
  const text::TextLayout* L = textLayout(text_.node);
  if (!L) return;
  uint32_t at = std::min<uint32_t>(textSelStart(), L->styleOf.empty() ? 0 : static_cast<uint32_t>(L->styleOf.size() - 1));
  const text::ResolvedStyle& cur = L->styles[L->styleOf.empty() ? 0 : L->styleOf[at]];
  NodeChange c = NodeChange::changed(text_.node);
  if (code == KeyCode::KeyU || code == KeyCode::KeyX) {
    TextDecoration d = code == KeyCode::KeyU ? TextDecoration::UNDERLINE : TextDecoration::STRIKETHROUGH;
    c.mask = F_TEXT_DECORATION;
    c.props.textDecoration = cur.textDecoration == d ? TextDecoration::NONE : d;
  } else {
    int weight = 400;
    bool italic = false;
    text::styleWeight(cur.fontName.style, weight, italic);
    if (code == KeyCode::KeyB) weight = weight >= 600 ? 400 : 700;
    else italic = !italic;
    std::string style = weight == 700 ? "Bold" : weight == 400 ? (italic ? "" : "Regular") : cur.fontName.style;
    if (weight != 700 && weight != 400) {
      // Keep the weight word, toggle "Italic".
      std::string base = cur.fontName.style;
      size_t i = base.find("Italic");
      if (i != std::string::npos) base.erase(i, 6);
      while (!base.empty() && base.back() == ' ') base.pop_back();
      style = base;
    }
    if (italic) style = style.empty() ? "Italic" : style + " Italic";
    c.mask = F_FONT_NAME;
    c.props.fontName = {cur.fontName.family, style, ""};
  }
  uint32_t a = text_.anchor, f = text_.focus;
  setProps({text_.node}, c, 0);
  setTextSelection(a, f);
}

// ---- Run styles from the panel ------------------------------------------------------

Status Editor::applyTextStyle(Guid id, const NodeChange& change) {
  const NodeProps p = doc_.get(id)->props;
  constexpr FieldMask kRunNodeFields = F_FONT_NAME | F_FONT_SIZE | F_LINE_HEIGHT | F_LETTER_SPACING | F_TEXT_CASE | F_TEXT_DECORATION | F_FILLS;
  FieldMask mask = change.mask & ~static_cast<FieldMask>(F_TYPE);
  uint32_t run = text::runFieldsOf(mask);
  NodeChange c = NodeChange::changed(id);
  FieldMask plain = mask & ~kRunNodeFields & ~static_cast<FieldMask>(F_TEXT_DATA);
  c.mask = differingFields(p, change.props, plain);
  copyFields(c.props, change.props, c.mask);
  TextData t = (mask & F_TEXT_DATA) ? change.props.textData : p.textData;
  uint32_t len = text::length16(t);
  uint32_t from = textSelStart(), to = textSelEnd();
  bool ranged = text_.node == id && from < to && !(from == 0 && to >= len);
  if (ranged) {
    text::applyRunStyle(t, from, to, text::runStyleOf(change.props, run), p);
  } else {
    FieldMask own = differingFields(p, change.props, mask & kRunNodeFields);
    copyFields(c.props, change.props, own);
    c.mask |= own;
    text::clearRunFields(t, run);
  }
  if (!(t == p.textData)) {
    c.mask |= F_TEXT_DATA;
    c.props.textData = t;
  }
  if (c.mask) write(c);
  return OK;
}

}  // namespace eng
