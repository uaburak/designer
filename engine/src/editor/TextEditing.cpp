// Text editing in the engine (docs/engine.md §7.6): the session (the edited
// TEXT node, its caret and selection as UTF-16 offsets), keys, pointer
// selection, typing and IME, run styles on the selected range, and the
// layouts every TEXT node is drawn and measured with. A session's edits are
// one undo step: each edit commits (so storage gets it at once) and merges
// into the step the session started.

#include <algorithm>
#include <cmath>
#include <map>

#include "editor/Editor.h"
#include "hit/HitTest.h"
#include "layout/Layout.h"
#include "base/Json.h"
#include "scene/CodecJson.h"
#include "scene/CodecKiwi.h"
#include "text/TextEdit.h"
#include "text/Unicode.h"

namespace eng {

namespace {

// The list data of the paragraph holding UTF-16 index `at`, and that paragraph's [start, end).
text::LineInfo paragraphLine(const TextData& t, const std::u16string& str, uint32_t at, size_t* index = nullptr) {
  size_t para = static_cast<size_t>(std::count(str.begin(), str.begin() + std::min<size_t>(at, str.size()), u'\n'));
  if (index) *index = para;
  return para < t.lines.size() ? text::readLine(t.lines[para]) : text::LineInfo{};
}

}  // namespace

// ---- Layouts ------------------------------------------------------------------------

const text::TextLayout* Editor::textLayout(Guid id) {
  const Node* n = doc_.get(id);
  if (!n || n->props.type != NodeType::TEXT) return nullptr;
  text::LayoutOptions o = text::optionsFor(n->props);
  uint32_t generation = text::FontRegistry::get().generation();
  CachedText& c = textCache_[id];
  if (!(c.layout && c.width == o.width && c.height == o.height && c.generation == generation)) keepTextLayout(id, c, text::layoutText(n->props, o), o, generation);
  if ((c.layout->pendingFont || c.layout->missingFont) && !storedText_.empty())
    if (const text::TextLayout* stored = storedLayout(id, n->props, *c.layout)) return stored;
  return c.layout.get();
}

void Editor::keepTextLayout(Guid id, CachedText& c, std::unique_ptr<text::TextLayout> layout, const text::LayoutOptions& o, uint32_t generation) {
  c.layout = std::move(layout);
  c.width = o.width;
  c.height = o.height;
  c.generation = generation;
  // Its fonts arrived and they are the ones the stored layout was made with: the stored data has done its work.
  if (!c.layout->pendingFont && !c.layout->missingFont && !storedText_.empty()) {
    auto st = storedText_.find(id);
    if (st != storedText_.end() && text::sameFonts(*st->second, *c.layout)) {
      storedText_.erase(st);
      storedLayouts_.erase(id);
    }
  }
}

const text::TextLayout* Editor::storedLayout(Guid id, const NodeProps& p, const text::TextLayout& real) {
  auto st = storedText_.find(id);
  if (st == storedText_.end()) return nullptr;
  text::LayoutOptions o = text::optionsFor(p);
  StoredLayout& s = storedLayouts_[id];
  if (!s.layout || s.width != o.width || s.height != o.height) {
    s.layout = text::layoutFromStored(st->second, p);
    s.width = o.width;
    s.height = o.height;
  }
  // What a reader of the layout needs to know about its fonts (editing refuses a missing one).
  s.layout->pendingFont = real.pendingFont;
  s.layout->missingFont = real.missingFont;
  return s.layout.get();
}

bool Editor::measureText(Guid id, double width, Vec2& size) {
  const Node* n = doc_.get(id);
  if (!n || n->props.type != NodeType::TEXT) return false;
  // Measures are kept (per width, until the text's layout fields change or a font arrives): layout asks for
  // the same text many times (hug sizes, each instance's stages, every relayout of its tree).
  uint32_t generation = text::FontRegistry::get().generation();
  auto& entries = measured_[id];
  for (const MeasuredText& m : entries) {
    if (m.width != width || m.generation != generation) continue;
    if (m.pending) unmeasured_.insert(id);
    if (!m.ok) return false;
    size = m.size;
    return true;
  }
  text::LayoutOptions o;
  o.width = width;
  auto L = text::layoutText(n->props, o);
  // Its fonts not in yet, and a stored layout for this box: its size is the text's (the stored data was made by this
  // engine with these fonts), nothing to measure again when they arrive.
  if ((L->pendingFont || L->missingFont) && !storedText_.empty())
    if (auto st = storedText_.find(id); st != storedText_.end() && text::optionsFor(n->props).width == width) {
      MeasuredText m{width, generation, st->second->layoutSize, true, false};
      if (entries.size() >= 4) entries.erase(entries.begin());
      entries.push_back(m);
      size = m.size;
      return true;
    }
  MeasuredText m{width, generation, L->size, !(L->pendingFont || L->missingFont), L->pendingFont};
  if (entries.size() >= 4) entries.erase(entries.begin());
  entries.push_back(m);
  // A font still loading: measured again when it arrives. A missing one: the stored size stands (Figma).
  if (L->pendingFont) unmeasured_.insert(id);
  // Measured in the box it is drawn in (an Auto width text, a fixed width one at its width): the layout is the one
  // drawing will ask for — kept, so a page's texts are shaped once at load, not once to measure and again to draw.
  if (text::LayoutOptions own = text::optionsFor(n->props); own.width == width && own.height < 0) {
    CachedText& c = textCache_[id];
    if (!(c.layout && c.width == own.width && c.height == own.height && c.generation == generation)) keepTextLayout(id, c, std::move(L), own, generation);
  }
  if (!m.ok) return false;
  size = m.size;
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
  measured_.clear();
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
  return n ? text::utf8To16(n->props.text().textData.characters) : std::u16string();
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
  spelling_.clear();
  spellingNode_ = kNoGuid;
  Guid id = text_.node;
  bool created = text_.created;
  size_t step = text_.undoCount;
  text_ = TextSession{};
  events_.textEdit = true;
  needsRender_ = true;
  const Node* n = doc_.get(id);
  if (n && n->props.text().textData.characters.empty()) {
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
  TextData t = p.text().textData;
  uint32_t len = text::length16(t);
  from = std::min(from, len);
  to = std::clamp(to, from, len);
  // New text takes the style of what it replaces, else of the character before it.
  uint32_t style = from < to && from < t.characterStyleIDs.size() ? t.characterStyleIDs[from] : text::styleIdAt(t, from);
  text::replaceRange(t, from, to, insert, style);
  NodeChange c = NodeChange::changed(text_.node);
  c.mask = F_TEXT_DATA;
  c.props.text().textData = t;
  if (p.text().autoRename) {
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
  if (s == u" ") textAutoformatList();
  return OK;
}

void Editor::textAutoformatList() {
  const Node* n = doc_.get(text_.node);
  if (!n || text_.anchor != text_.focus) return;
  std::u16string str = text::utf8To16(n->props.text().textData.characters);
  uint32_t focus = std::min<uint32_t>(text_.focus, static_cast<uint32_t>(str.size()));
  size_t a, b;
  text::paragraphAt(str, focus, a, b);
  std::u16string head = str.substr(a, focus - a);
  int type = head == u"- " || head == u"* " ? 2 : (head == u"1. " || head == u"1) ") ? 1 : 0;
  if (!type) return;
  text::LineInfo info = paragraphLine(n->props.text().textData, str, focus);
  if (info.type != text::LineType::PLAIN) return;
  // One step with the typing (⌘Z right after takes the list away, keeping what was typed).
  textReplace(static_cast<uint32_t>(a), focus, u"", "Edit text");
  textParagraphs(text_.node, 0, type);
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
    if (acceptsChildren(*it)) {
      parent = *it;
      break;
    }
  NodeProps p = toolProps(NodeType::TEXT);
  p.name = "Text";
  if (width > 0) {
    p.text().textAutoResize = TextAutoResize::HEIGHT;
    p.size = {width, 0};
  }
  // Its box starts where the click was, the first line's middle on the pointer.
  double lineHeight = 15;
  if (text::Font* f = text::FontRegistry::get().find(p.text().fontName)) lineHeight = text::autoLineHeight(f, p.text().fontSize);
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
      if (collapsed && !primary && !alt) {
        // At a list item's start: its marker goes, its indent stays (Figma).
        size_t a, b;
        text::paragraphAt(str, focus, a, b);
        const Node* tn = doc_.get(text_.node);
        if (tn && focus == a && paragraphLine(tn->props.text().textData, str, focus).type != text::LineType::PLAIN) {
          textParagraphs(text_.node, 0, static_cast<int>(paragraphLine(tn->props.text().textData, str, focus).type));
          return K_HANDLED;
        }
      }
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
      if (!shift && collapsed) {
        // Return on an empty list item: one level out, then out of the list (Figma).
        size_t a, b;
        text::paragraphAt(str, focus, a, b);
        const Node* tn = doc_.get(text_.node);
        text::LineInfo info = tn ? paragraphLine(tn->props.text().textData, str, focus) : text::LineInfo{};
        if (a == b && info.type != text::LineType::PLAIN) {
          if (info.indentationLevel > 1) textParagraphs(text_.node, 1, -1);
          else textParagraphs(text_.node, 0, static_cast<int>(info.type));
          return K_HANDLED;
        }
      }
      textReplace(textSelStart(), textSelEnd(), shift ? u"\u2028" : u"\n", "Edit text");
      return K_HANDLED;
    case KeyCode::Tab: {
      // In a list (or with several paragraphs selected): indent / outdent; else a tab character.
      const Node* tn = doc_.get(text_.node);
      bool list = tn && paragraphLine(tn->props.text().textData, str, focus).type != text::LineType::PLAIN;
      bool multi = std::count(str.begin() + textSelStart(), str.begin() + textSelEnd(), u'\n') > 0;
      if (list || multi || shift) {
        textParagraphs(text_.node, 1, shift ? -1 : 1);
        return K_HANDLED;
      }
      textReplace(textSelStart(), textSelEnd(), u"\t", "Edit text");
      return K_HANDLED;
    }
    case KeyCode::BracketLeft:
    case KeyCode::BracketRight:
      // ⌘] / ⌘[: indentation.
      if (!primary || shift || alt) return 0;
      textParagraphs(text_.node, 1, code == KeyCode::BracketRight ? 1 : -1);
      return K_HANDLED;
    case KeyCode::Digit7:
    case KeyCode::Digit8:
      // ⇧⌘7 numbered list, ⇧⌘8 bulleted list.
      if (!primary || !shift) return 0;
      textParagraphs(text_.node, 0, code == KeyCode::Digit7 ? 1 : 2);
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
    c.props.text().textDecoration = cur.textDecoration == d ? TextDecoration::NONE : d;
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
    c.props.text().fontName = {cur.fontName.family, style, ""};
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
  TextData t = (mask & F_TEXT_DATA) ? change.props.text().textData : p.text().textData;
  uint32_t len = text::length16(t);
  uint32_t from = textSelStart(), to = textSelEnd();
  bool ranged = text_.node == id && from < to && !(from == 0 && to >= len);
  // Run fields kept as data (links, variable axes, OpenType switches, decoration details): to the range, or to the
  // node and out of every run.
  std::map<std::string, std::string> runExtras;
  if (mask & F_EXTRA)
    for (auto& [k, v] : change.props.extra)
      if (text::isRunExtraKey(k)) runExtras[k] = v;
  if (ranged) {
    text::applyRunStyle(t, from, to, text::runStyleOf(change.props, run), p);
    if (!runExtras.empty()) {
      text::applyRunExtras(t, from, to, runExtras, p);
      // The range takes them; the node keeps its own.
      NodeProps rest = change.props;
      for (auto& [k, v] : runExtras) rest.extra.erase(k);
      c.mask &= ~static_cast<FieldMask>(F_EXTRA);
      c.props.extra.clear();
      if (!rest.extra.empty()) {
        c.props.extra = rest.extra;
        c.mask |= F_EXTRA;
      }
    }
  } else {
    FieldMask own = differingFields(p, change.props, mask & kRunNodeFields);
    copyFields(c.props, change.props, own);
    c.mask |= own;
    text::clearRunFields(t, run);
    std::vector<std::string> keys;
    for (auto& [k, v] : runExtras) keys.push_back(k);
    text::clearRunExtras(t, keys);
  }
  if (!(t == p.text().textData)) {
    c.mask |= F_TEXT_DATA;
    c.props.text().textData = t;
  }
  if (c.mask) write(c);
  return OK;
}

bool Editor::textRange(Guid id, uint32_t& from, uint32_t& to) const {
  if (text_.node != id) return false;
  const Node* n = doc_.get(id);
  if (!n) return false;
  uint32_t len = text::length16(n->props.text().textData);
  from = textSelStart();
  to = std::min(textSelEnd(), len);
  return from < to && !(from == 0 && to >= len);
}

// ---- The Typography section's view of a range -----------------------------------------------

std::string Editor::textRangeStyle(Guid id, uint32_t from, uint32_t to, bool useSelection) {
  const Node* n = doc_.get(id);
  if (!n || n->props.type != NodeType::TEXT) return {};
  const NodeProps& p = n->props;
  const text::TextLayout* L = textLayout(id);
  if (!L) return {};
  uint32_t len = static_cast<uint32_t>(L->text.size());
  if (useSelection && text_.node == id) {
    from = textSelStart();
    to = textSelEnd();
  } else if (useSelection) {
    from = 0;
    to = len;
  }
  to = std::min(to, len);
  from = std::min(from, to);
  // The styles in the range (a caret: the one typing takes, the character before it).
  std::vector<uint16_t> used;
  auto use = [&](uint16_t s) {
    if (std::find(used.begin(), used.end(), s) == used.end()) used.push_back(s);
  };
  if (from == to || len == 0) use(len == 0 ? 0 : L->styleOf[std::min<uint32_t>(from > 0 ? from - 1 : 0, len - 1)]);
  else
    for (uint32_t i = from; i < to; i++) use(L->styleOf[i]);
  // Each style's value of each field as JSON; a field whose values differ is mixed.
  std::map<std::string, std::vector<std::string>> values;
  auto put = [&](const std::string& k, std::string v) {
    auto& list = values[k];
    if (std::find(list.begin(), list.end(), v) == list.end()) list.push_back(std::move(v));
  };
  auto quoted = [](const char* v) { return std::string("\"") + v + "\""; };
  std::map<std::string, std::string> nodeExtras;
  for (auto& [k, v] : p.extra)
    if (text::isRunExtraKey(k) && !v.empty()) nodeExtras[k] = codec::extraValueToJson("NodeChange", v);
  for (uint16_t si : used) {
    const text::ResolvedStyle& s = L->styles[si];
    json::Writer w;
    w.beginObject().key("family").string(s.fontName.family).key("style").string(s.fontName.style).key("postscript").string(s.fontName.postscript).endObject();
    put("fontName", w.take());
    // Family and style apart: the panel shows one "Mixed" without the other.
    json::Writer wfam, wsty;
    wfam.string(s.fontName.family);
    wsty.string(s.fontName.style);
    put("fontFamily", wfam.take());
    put("fontStyle", wsty.take());
    json::Writer ws;
    ws.number(s.fontSize);
    put("fontSize", ws.take());
    auto number = [](Number v) {
      json::Writer w;
      w.beginObject().key("value").number(v.value).key("units").string(enumName(v.units)).endObject();
      return w.take();
    };
    put("lineHeight", number(s.lineHeight));
    put("letterSpacing", number(s.letterSpacing));
    put("textCase", quoted(enumName(s.textCase)));
    put("textDecoration", quoted(enumName(s.textDecoration)));
    json::Writer wf;
    codec::writePaints(wf, s.fills ? *s.fills : std::vector<Paint>{});
    put("fillPaints", wf.take());
    // Kept-as-data fields: the run's own, else the node's.
    std::map<std::string, std::string> extras = nodeExtras;
    if (s.styleID) {
      for (const TextStyle& o : p.text().textData.styleOverrideTable)
        if (o.styleID == s.styleID && !o.extra.empty()) {
          json::Value obj;
          if (json::parse("{" + codec::extraToJsonMembers("NodeChange", o.extra) + "}", obj))
            for (auto& [k, x] : obj.object)
              if (text::isRunExtraKey(k)) extras[k] = json::encode(x);
        }
    }
    for (const char* k : {"hyperlink", "fontVariations", "toggledOnOTFeatures", "toggledOffOTFeatures", "fontVariantCommonLigatures",
                          "fontVariantContextualLigatures", "fontVariantDiscretionaryLigatures", "fontVariantHistoricalLigatures",
                          "fontVariantOrdinal", "fontVariantSlashedZero", "fontVariantNumericFigure", "fontVariantNumericSpacing",
                          "fontVariantNumericFraction", "fontVariantCaps", "fontVariantPosition", "textDecorationStyle",
                          "textDecorationSkipInk", "textUnderlineOffset", "textDecorationThickness", "textDecorationFillPaints",
                          "styleIdForText", "parameterConsumptionMap"}) {
      auto it = extras.find(k);
      put(k, it == extras.end() ? "null" : it->second);
    }
    // The font's variable axes, at this run's values.
    json::Writer wa;
    wa.beginArray();
    if (s.font)
      for (const text::AxisInfo& a : s.font->axes()) {
        wa.beginObject().key("tag").string(text::tagString(a.tag)).key("value").number(a.value).endObject();
        // Each axis on its own too ("axis:wght"): one axis can be Mixed while another isn't.
        json::Writer one;
        one.number(a.value);
        put("axis:" + text::tagString(a.tag), one.take());
      }
    wa.endArray();
    put("axisValues", wa.take());
  }
  // Paragraphs: list type and indentation.
  size_t first = 0, last = 0;
  text::paragraphsOf(p.text().textData, from, to, first, last);
  static const char* const kTypes[] = {"PLAIN", "ORDERED_LIST", "UNORDERED_LIST"};
  static const char* const kDirections[] = {"AUTO", "LTR", "RTL"};
  for (size_t i = first; i <= last; i++) {
    text::LineInfo info = i < p.text().textData.lines.size() ? text::readLine(p.text().textData.lines[i]) : text::LineInfo{};
    put("lineType", quoted(kTypes[static_cast<int>(info.type)]));
    put("indentationLevel", std::to_string(info.indentationLevel));
    put("sourceDirectionality", quoted(kDirections[std::min<int>(info.direction, 2)]));
  }
  json::Writer w;
  w.beginObject().key("from").number(from).key("to").number(to).key("values").beginObject();
  for (auto& [k, list] : values) w.key(k).raw(list.front());
  w.endObject().key("mixed").beginArray();
  for (auto& [k, list] : values)
    if (list.size() > 1) w.string(k);
  w.endArray().endObject();
  return w.take();
}

Status Editor::textParagraphs(Guid id, int op, int value) {
  const Node* n = doc_.get(id);
  if (!n || n->props.type != NodeType::TEXT) return E_NOT_FOUND;
  if (busy()) return E_BUSY;
  TextData t = n->props.text().textData;
  size_t first = 0, last = 0;
  uint32_t len = text::length16(t);
  if (text_.node == id) text::paragraphsOf(t, textSelStart(), textSelEnd(), first, last);
  else {
    (void)len;
    last = static_cast<size_t>(std::count(t.characters.begin(), t.characters.end(), '\n'));
  }
  if (op == 0) {
    // The same type on every paragraph again: the list goes (Figma's toggles).
    bool all = true;
    for (size_t i = first; i <= last; i++) {
      text::LineInfo info = i < t.lines.size() ? text::readLine(t.lines[i]) : text::LineInfo{};
      all &= static_cast<int>(info.type) == value;
    }
    text::setListType(t, first, last, static_cast<uint8_t>(all ? 0 : std::clamp(value, 0, 2)));
  } else if (op == 1) {
    text::indentParagraphs(t, first, last, value);
  } else if (op == 2) {
    text::setDirection(t, first, last, static_cast<uint8_t>(std::clamp(value, 0, 2)));
  } else {
    return E_INVALID;
  }
  if (t == n->props.text().textData) return OK;
  NodeChange c = NodeChange::changed(id);
  c.mask = F_TEXT_DATA;
  c.props.text().textData = t;
  uint32_t a = text_.anchor, f = text_.focus;
  bool editing = text_.node == id;
  setProps({id}, c, 0);
  if (editing) setTextSelection(a, f);
  return OK;
}

}  // namespace eng
