// Round 7 — selection and canvas commands as Figma has them (docs/engine-build.md "Round 7 — selection"): sections
// (wrap in a new section, draw one around layers), removing a frame / section / group while keeping what is in it,
// select matching layers and Edit ▸ Select all with the same properties, Tidy up, zoom to the next / previous frame.

#include <algorithm>
#include <cmath>
#include <map>

#include "base/FractionalIndex.h"
#include "editor/Editor.h"
#include "render/FrameTitles.h"

namespace eng {

namespace {

using GuidSet = std::unordered_set<Guid, GuidHash>;

constexpr double kSectionPadding = 80;  // around what "Wrap in new section" wraps (unverified: as Figma looks)

bool canvasLevel(const Document& doc, Guid parent) {
  const Node* p = doc.get(parent);
  return p && (p->props.type == NodeType::CANVAS || p->props.type == NodeType::SECTION);
}

// The paint fields "Select all with same fill / stroke / effect" compare (the paints themselves, bound or not).
bool samePaints(const std::vector<Paint>& a, const std::vector<Paint>& b) {
  if (a.size() != b.size()) return false;
  for (size_t i = 0; i < a.size(); i++) {
    const Paint &x = a[i], &y = b[i];
    if (x.type != y.type || x.visible != y.visible || std::fabs(x.opacity - y.opacity) > 1e-4) return false;
    if (x.type == PaintType::SOLID && !(x.color == y.color)) return false;
    if (x.type != PaintType::SOLID && !(x == y)) return false;
  }
  return true;
}

}  // namespace

NodeProps Editor::sectionProps() const {
  NodeProps p = defaultProps(NodeType::SECTION);
  if (theme_ == Theme::Dark) {
    p.fillPaints = {Paint::solid(Color::hex(0x444444))};
    Paint stroke = Paint::solid(Color::hex(0xFFFFFF));
    stroke.opacity = 0.1f;
    p.strokePaints = {stroke};
  }
  return p;
}

void Editor::adoptIntoSection(Guid section) {
  // A section drawn around layers takes the ones it fully covers (Figma), keeping their place on the page and their order.
  const Node* s = doc_.get(section);
  if (!s) return;
  Guid parent = s->props.parentIndex.guid;
  Rect box = doc_.worldBounds(section);
  std::vector<Guid> inside;
  for (Guid c : doc_.children(parent)) {
    if (c == section || c.isDerived()) continue;
    const Node* n = doc_.get(c);
    if (!n || n->props.locked) continue;
    if (box.containsRect(doc_.worldBounds(c))) inside.push_back(c);
  }
  if (inside.empty()) return;
  auto keys = placeManyAt(section, doc_.children(section).size(), inside.size(), GuidSet{});
  for (size_t i = 0; i < inside.size(); i++) reparent(inside[i], section, keys[i]);
}

Guid Editor::wrapInSection() {
  std::vector<Guid> top = topSelectionInPaintOrder();
  if (top.empty()) return kNoGuid;
  Guid parent = doc_.parentOf(top.back());
  for (Guid id : top)
    if (doc_.parentOf(id) != parent || id.isDerived()) return kNoGuid;
  if (!canvasLevel(doc_, parent)) return kNoGuid;
  GuidSet moving(top.begin(), top.end());
  size_t index = 0;
  for (Guid c : doc_.children(parent)) {
    if (c == top.back()) break;
    if (!moving.count(c)) index++;
  }
  Mat2x3 toParent = doc_.worldTransform(parent).inverse();
  Rect u;
  bool any = false;
  for (Guid id : top) {
    const Node* n = doc_.get(id);
    Rect b = transformedBounds(toParent * doc_.worldTransform(id), n->props.size.x, n->props.size.y);
    u = any ? u.united(b) : b;
    any = true;
  }
  begin(TxnKind::USER, "Wrap in new section");
  NodeProps p = sectionProps();
  p.name = nextName("Section");
  p.transform = Mat2x3::translate(std::round(u.x - kSectionPadding), std::round(u.y - kSectionPadding));
  p.size = {std::round(u.w + 2 * kSectionPadding), std::round(u.h + 2 * kSectionPadding)};
  p.parentIndex = {parent, placeManyAt(parent, index, 1, moving)[0]};
  Guid section = newGuid();
  write(NodeChange::created(section, p));
  auto keys = fractional::keysBetween("", std::nullopt, static_cast<int>(top.size()));
  for (size_t i = 0; i < top.size(); i++) reparent(top[i], section, keys[i]);
  changeSelection({section});
  commit();
  return section;
}

bool Editor::canRemoveKeepingContents(Guid id) const {
  const Node* n = doc_.get(id);
  if (!n || id.isDerived() || n->props.locked) return false;
  const NodeProps& p = n->props;
  bool container = p.type == NodeType::SECTION || p.isGroupLike() || (p.type == NodeType::FRAME && !p.isComponentish());
  return container && !doc_.children(id).empty();
}

void Editor::removeKeepingContents() {
  // Figma's ⇧⌘⌫-free "Remove section / frame / group": the container goes, its layers stay where they are on the page.
  std::vector<Guid> top = topSelectionInPaintOrder();
  std::vector<Guid> targets;
  for (Guid id : top)
    if (canRemoveKeepingContents(id)) targets.push_back(id);
  if (targets.empty()) return;
  const Node* first = doc_.get(targets[0]);
  begin(TxnKind::USER, first && first->props.type == NodeType::SECTION ? "Remove section" : first && first->props.isGroupLike() ? "Ungroup selection" : "Remove frame");
  std::vector<Guid> next;
  for (Guid id : top)
    if (std::find(targets.begin(), targets.end(), id) == targets.end()) next.push_back(id);
  for (Guid g : targets) {
    Guid parent = doc_.parentOf(g);
    std::vector<Guid> kids = doc_.children(g);
    const auto& siblings = doc_.children(parent);
    size_t index = static_cast<size_t>(std::find(siblings.begin(), siblings.end(), g) - siblings.begin());
    auto keys = placeManyAt(parent, index, kids.size(), GuidSet{g});
    for (size_t i = 0; i < kids.size(); i++) {
      if (kids[i].isDerived()) continue;
      reparent(kids[i], parent, keys[i]);
      next.push_back(kids[i]);
    }
    std::vector<Guid> order;
    auto collect = [&](auto&& self, Guid id) -> void {
      for (Guid c : std::vector<Guid>(doc_.children(id))) self(self, c);
      order.push_back(id);
    };
    collect(collect, g);
    for (Guid id : order)
      if (!id.isDerived()) write(NodeChange::removed(id));
  }
  changeSelection(std::move(next));
  commit();
}

// ---- Select matching ----------------------------------------------------------------------------------------------

std::vector<Guid> Editor::matchingLayers(const std::string& mode) const {
  // "Select matching layers" (⌥⌘A, Figma): layers like the selected ones — same type and properties — among the
  // selection's siblings' scope: within the selection's top-level frame or section, else the whole page. Edit ▸
  // "Select all with same …": every layer on the page with that property.
  std::vector<Guid> sel = selection_;
  if (sel.empty() || page_ == kNoGuid) return {};
  std::vector<const NodeProps*> refs;
  for (Guid id : sel)
    if (const Node* n = doc_.get(id)) refs.push_back(&n->props);
  auto fontOf = [](const NodeProps& p, FontName& out) {
    if (p.type != NodeType::TEXT) return false;
    out = p.text().fontName;
    return true;
  };
  auto matches = [&](const NodeProps& c) {
    for (const NodeProps* r : refs) {
      if (mode == "FILL") {
        if (!c.fillPaints.empty() && samePaints(c.fillPaints, r->fillPaints)) return true;
      } else if (mode == "STROKE") {
        if (!c.strokePaints.empty() && samePaints(c.strokePaints, r->strokePaints) && c.strokeWeight == r->strokeWeight) return true;
      } else if (mode == "EFFECT") {
        if (!c.effects.empty() && c.effects == r->effects) return true;
      } else if (mode == "FONT") {
        FontName a, b;
        if (fontOf(c, a) && fontOf(*r, b) && a.family == b.family && a.style == b.style) return true;
      } else if (mode == "TEXT") {
        if (c.type == NodeType::TEXT && r->type == NodeType::TEXT && c.text().fontName.family == r->text().fontName.family &&
            c.text().fontName.style == r->text().fontName.style && c.text().fontSize == r->text().fontSize &&
            c.text().lineHeight == r->text().lineHeight && c.text().letterSpacing == r->text().letterSpacing)
          return true;
      } else if (mode == "INSTANCE") {
        if (c.type == NodeType::INSTANCE && r->type == NodeType::INSTANCE && c.comp().symbolData.symbolID == r->comp().symbolData.symbolID) return true;
      } else {
        // Matching layers: same type, same size, same fills and strokes (Figma's "similar layers").
        if (c.type != r->type) continue;
        if (c.type == NodeType::INSTANCE) {
          if (c.comp().symbolData.symbolID == r->comp().symbolData.symbolID) return true;
          continue;
        }
        if (std::fabs(c.size.x - r->size.x) < 0.5 && std::fabs(c.size.y - r->size.y) < 0.5 && samePaints(c.fillPaints, r->fillPaints) &&
            samePaints(c.strokePaints, r->strokePaints))
          return true;
      }
    }
    return false;
  };
  // The scope: matching layers stay within the selection's top-level frame or section (Figma); the page otherwise.
  Guid scope = page_;
  if (mode == "LAYERS") {
    std::vector<Guid> path = doc_.pathFromPage(sel[0]);
    Guid common = path.empty() ? kNoGuid : path[0];
    for (Guid id : sel) {
      std::vector<Guid> p = doc_.pathFromPage(id);
      if (p.empty() || p[0] != common) common = kNoGuid;
    }
    if (common != kNoGuid && common != sel[0]) scope = common;
  }
  std::vector<Guid> out;
  auto visit = [&](auto&& self, Guid parent) -> void {
    for (Guid c : doc_.children(parent)) {
      const Node* n = doc_.get(c);
      if (!n || !n->props.visible || n->props.locked) continue;
      if (matches(n->props)) out.push_back(c);
      // Inside instances only for their own layers' properties (not "matching layers").
      if (n->props.type == NodeType::INSTANCE && mode == "LAYERS") continue;
      if (c.isDerived() && mode == "LAYERS") continue;
      self(self, c);
    }
  };
  visit(visit, scope);
  return out;
}

Status Editor::selectMatching(const std::string& mode) {
  std::vector<Guid> found = matchingLayers(mode);
  if (found.empty()) return E_NOT_FOUND;
  // Nested matches under another match stay out (a layer and its own children never both).
  changeSelection(topLevelSelection(doc_, found));
  return OK;
}

// ---- Tidy up ------------------------------------------------------------------------------------------------------

void Editor::tidyUp() {
  // ⌃⌥T (Figma): the selected layers into a grid of their rows and columns as they lie, one even spacing each way
  // (the mean of their gaps, never negative), each row and column aligned to its first layer's edge.
  std::vector<Guid> ids = arrangeable();
  if (ids.size() < 2) return;
  struct Item {
    Guid id;
    Rect b;
  };
  std::vector<Item> items;
  for (Guid id : ids) items.push_back({id, doc_.worldBounds(id)});
  // Rows: layers whose vertical centres fall within the first one's height, top to bottom.
  std::sort(items.begin(), items.end(), [](const Item& a, const Item& b) { return a.b.y + a.b.h / 2 < b.b.y + b.b.h / 2; });
  std::vector<std::vector<Item>> rows;
  for (const Item& it : items) {
    if (!rows.empty()) {
      const Rect& f = rows.back()[0].b;
      double cy = it.b.y + it.b.h / 2;
      if (cy >= f.y && cy <= f.bottom()) {
        rows.back().push_back(it);
        continue;
      }
    }
    rows.push_back({it});
  }
  for (auto& r : rows) std::sort(r.begin(), r.end(), [](const Item& a, const Item& b) { return a.b.x < b.b.x; });
  // The spacing: the mean of the gaps between neighbours across and down.
  double gx = 0, gy = 0;
  int nx = 0, ny = 0;
  size_t cols = 0;
  for (auto& r : rows) {
    cols = std::max(cols, r.size());
    for (size_t i = 1; i < r.size(); i++) gx += r[i].b.x - r[i - 1].b.right(), nx++;
  }
  for (size_t i = 1; i < rows.size(); i++) {
    double top = rows[i][0].b.y, bottom = rows[i - 1][0].b.bottom();
    for (auto& it : rows[i]) top = std::min(top, it.b.y);
    for (auto& it : rows[i - 1]) bottom = std::max(bottom, it.b.bottom());
    gy += top - bottom, ny++;
  }
  double spaceX = nx ? std::max(0.0, std::round(gx / nx)) : 0, spaceY = ny ? std::max(0.0, std::round(gy / ny)) : 0;
  // Column widths and row heights: the widest / tallest in each.
  std::vector<double> colW(cols, 0), rowH(rows.size(), 0);
  for (size_t r = 0; r < rows.size(); r++)
    for (size_t c = 0; c < rows[r].size(); c++) colW[c] = std::max(colW[c], rows[r][c].b.w), rowH[r] = std::max(rowH[r], rows[r][c].b.h);
  double x0 = rows[0][0].b.x, y0 = rows[0][0].b.y;
  for (auto& r : rows)
    for (auto& it : r) x0 = std::min(x0, it.b.x), y0 = std::min(y0, it.b.y);
  begin(TxnKind::USER, "Tidy up");
  double y = y0;
  for (size_t r = 0; r < rows.size(); r++) {
    double x = x0;
    for (size_t c = 0; c < rows[r].size(); c++) {
      const Item& it = rows[r][c];
      double dx = std::round(x - it.b.x), dy = std::round(y - it.b.y);
      if (dx != 0 || dy != 0) {
        NodeChange ch = NodeChange::changed(it.id);
        ch.mask = F_TRANSFORM;
        Mat2x3 world = Mat2x3::translate(dx, dy) * doc_.worldTransform(it.id);
        ch.props.transform = localFor(doc_.parentOf(it.id), world);
        write(ch);
      }
      x += colW[c] + spaceX;
    }
    y += rowH[r] + spaceY;
  }
  commit();
}

// ---- Next / previous frame ----------------------------------------------------------------------------------------

std::vector<Guid> Editor::navigableFrames() const {
  // The page's titled frames (those in sections too, at their section's place) in Layers order, bottom first (live
  // Figma, 2026-10-08: N from nothing went to the page's first frame, then on up the list).
  std::vector<Guid> frames;
  auto visit = [&](auto&& self, Guid parent) -> void {
    for (Guid c : doc_.children(parent)) {
      const Node* n = doc_.get(c);
      if (!n || !n->props.visible) continue;
      if (n->props.type == NodeType::SECTION) self(self, c);
      else if (showsTitle(doc_, c)) frames.push_back(c);
    }
  };
  if (page_ != kNoGuid) visit(visit, page_);
  return frames;
}

Status Editor::zoomToSiblingFrame(int step) {
  // N / ⇧N ("Zoom to next frame" / "Zoom to previous frame", live View menu): the view goes to the next / previous
  // frame; the selection stays (live). From the selection's frame, else from where N last went, else from the ends.
  std::vector<Guid> frames = navigableFrames();
  if (frames.empty()) return E_NOT_FOUND;
  long n = static_cast<long>(frames.size());
  auto indexOf = [&](Guid id) -> long {
    for (long i = 0; i < n; i++)
      if (frames[static_cast<size_t>(i)] == id) return i;
    return -1;
  };
  long at = -1;
  if (!selection_.empty()) {
    for (Guid cur = selection_[0]; at < 0 && cur != kNoGuid && doc_.has(cur) && cur != page_; cur = doc_.parentOf(cur)) at = indexOf(cur);
    if (at >= 0 && frames[static_cast<size_t>(at)] != zoomFrame_ && zoomFrame_ != kNoGuid && indexOf(zoomFrame_) >= 0 && selection_ == zoomSelection_)
      at = indexOf(zoomFrame_);
  } else if (zoomFrame_ != kNoGuid) {
    at = indexOf(zoomFrame_);
  }
  long next = at < 0 ? (step > 0 ? 0 : n - 1) : ((at + step) % n + n) % n;
  Guid frame = frames[static_cast<size_t>(next)];
  zooming_ = false;
  changeCamera(snapped(fitVisible(doc_.worldBounds(frame), false)));
  zoomFrame_ = frame;
  zoomSelection_ = selection_;
  return OK;
}

// ---- Dispatch -----------------------------------------------------------------------------------------------------

Status Editor::selectionCommand(CommandId id, const CommandArgs& args) {
  bool derived = false;
  for (Guid s : selection_) derived |= s.isDerived();
  switch (id) {
    case CommandId::WRAP_IN_SECTION:
      if (derived) return E_INVALID;
      return wrapInSection() == kNoGuid ? E_INVALID : OK;
    case CommandId::REMOVE_KEEP_CONTENTS:
      if (derived) return E_INVALID;
      removeKeepingContents();
      return OK;
    case CommandId::SELECT_MATCHING: {
      std::string mode = "LAYERS";
      if (const json::Value* v = args.raw.isObject() ? args.raw.get("mode") : nullptr; v && v->isString()) mode = v->string;
      return selectMatching(mode);
    }
    case CommandId::TIDY_UP:
      if (derived) return E_INVALID;
      tidyUp();
      return OK;
    case CommandId::ZOOM_TO_NEXT_FRAME: return zoomToSiblingFrame(1);
    case CommandId::ZOOM_TO_PREVIOUS_FRAME: return zoomToSiblingFrame(-1);
    case CommandId::SHOW_ROTATION_ORIGIN:
      // ⌥R (a forum report, unverified on help.figma.com): the origin shows at the selection's centre; drag it, and
      // the rotation handles turn the selection about it. Again: hidden.
      if (selection_.empty()) return E_INVALID;
      rotationOriginOn_ = !rotationOriginOn_;
      needsRender_ = true;
      return OK;
    case CommandId::REMOVE_GUIDE: {
      if (!hasSelectedGuide()) return E_INVALID;
      RulerGuide g = selectedGuide_;
      std::vector<RulerGuide> list = guidesOf(g.owner);
      size_t before = list.size();
      list.erase(std::remove_if(list.begin(), list.end(), [&](const RulerGuide& x) { return x.id == g.id && x.axis == g.axis && x.offset == g.offset; }),
                 list.end());
      selectedGuide_ = {};
      needsRender_ = true;
      if (list.size() == before) return E_NOT_FOUND;
      begin(TxnKind::USER, "Remove guide");
      writeGuides(g.owner, list);
      commit();
      return OK;
    }
    default: return E_UNSUPPORTED;
  }
}

uint32_t Editor::selectionCommandState(CommandId id) const {
  bool derived = false;
  for (Guid s : selection_) derived |= s.isDerived();
  switch (id) {
    case CommandId::WRAP_IN_SECTION: {
      std::vector<Guid> top = topSelectionInPaintOrder();
      if (top.empty() || derived) return 0;
      Guid parent = doc_.parentOf(top[0]);
      for (Guid t : top)
        if (doc_.parentOf(t) != parent) return 0;
      return canvasLevel(doc_, parent) ? CMD_ENABLED : 0;
    }
    case CommandId::REMOVE_KEEP_CONTENTS:
      for (Guid s : selection_)
        if (canRemoveKeepingContents(s)) return CMD_ENABLED;
      return 0;
    case CommandId::SELECT_MATCHING: return selection_.empty() ? 0 : CMD_ENABLED;
    case CommandId::TIDY_UP: return !derived && arrangeable().size() >= 2 ? CMD_ENABLED : 0;
    case CommandId::ZOOM_TO_NEXT_FRAME:
    case CommandId::ZOOM_TO_PREVIOUS_FRAME: return page_ != kNoGuid ? CMD_ENABLED : 0;
    case CommandId::SHOW_ROTATION_ORIGIN: return selection_.empty() ? 0 : CMD_ENABLED | (rotationOriginOn_ ? CMD_CHECKED : 0);
    case CommandId::REMOVE_GUIDE: return hasSelectedGuide() ? CMD_ENABLED : 0;
    default: return 0;
  }
}

}  // namespace eng
