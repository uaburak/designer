// The fonts a document names, and Figma's "Replace fonts" (the Missing fonts dialog): docs/engine-build.md "Fonts".
//
// A font is named by a TEXT node (its own fontName, when some character takes it), by a run of its
// styleOverrideTable, and by an instance's override of a text sublayer (its fontName or its runs). Text styles are
// TEXT nodes too. Derived instance sublayers name nothing of their own: their fonts are their main's and the
// instance's overrides'.
#include <algorithm>
#include <map>

#include "editor/Editor.h"

namespace eng {

namespace {

// Whether a TEXT node's own fontName draws some character (no runs, or a character in style 0 or in a run that
// doesn't set the font).
bool nodeFontUsed(const TextData& td) {
  if (td.characters.empty() || td.styleOverrideTable.empty()) return true;
  size_t units = 0;
  for (size_t i = 0; i < td.characters.size();) {
    unsigned char c = static_cast<unsigned char>(td.characters[i]);
    size_t len = c < 0x80 ? 1 : c < 0xE0 ? 2 : c < 0xF0 ? 3 : 4;
    units += len == 4 ? 2 : 1;
    i += len;
  }
  if (td.characterStyleIDs.size() < units) return true;
  for (uint32_t id : td.characterStyleIDs) {
    if (id == 0) return true;
    auto it = std::find_if(td.styleOverrideTable.begin(), td.styleOverrideTable.end(), [&](const TextStyle& s) { return s.styleID == id; });
    if (it == td.styleOverrideTable.end() || !(it->mask & R_FONT_NAME)) return true;
  }
  return false;
}

template <class F>
void forRunFonts(const TextData& td, F&& f) {
  for (const TextStyle& s : td.styleOverrideTable)
    if (s.mask & R_FONT_NAME) f(s.fontName);
}

}  // namespace

std::vector<Editor::DocumentFont> Editor::documentFonts(const std::vector<Guid>& roots) const {
  std::map<std::pair<std::string, std::string>, DocumentFont> fonts;
  Guid current = kNoGuid;
  auto add = [&](const FontName& f) {
    if (f.family.empty()) return;
    DocumentFont& d = fonts[{f.family, f.style}];
    d.uses++;
    if (!roots.empty() && (d.nodes.empty() || d.nodes.back() != current)) d.nodes.push_back(current);
  };
  doc_.forEach([&](const Node& n) {
    if (n.guid.isDerived() || !inScope(roots, n.guid)) return;
    current = n.guid;
    const NodeProps& p = n.props;
    if (p.type == NodeType::TEXT) {
      if (nodeFontUsed(p.text().textData)) add(p.text().fontName);
      forRunFonts(p.text().textData, add);
    } else if (p.type == NodeType::INSTANCE) {
      for (const SymbolOverride& o : p.comp().symbolData.overrides) {
        if (o.mask & F_FONT_NAME) add(o.props.text().fontName);
        if (o.mask & F_TEXT_DATA) forRunFonts(o.props.text().textData, add);
      }
    }
  });
  std::vector<DocumentFont> out;
  out.reserve(fonts.size());
  for (auto& [k, d] : fonts) {
    d.font = FontName{k.first, k.second, ""};
    out.push_back(std::move(d));
  }
  return out;
}

bool Editor::inScope(const std::vector<Guid>& roots, Guid id) const {
  if (roots.empty()) return true;
  for (Guid r : roots)
    if (r == id || doc_.isAncestor(r, id)) return true;
  return false;
}

Status Editor::replaceFonts(const CommandArgs& args) {
  const json::Value* list = args.raw.isObject() ? args.raw.get("fonts") : nullptr;
  if (!list || !list->isArray()) return E_INVALID;
  std::vector<std::pair<FontName, FontName>> map;
  auto name = [](const json::Value* v, FontName& out) {
    if (!v || !v->isObject()) return false;
    const json::Value* fam = v->get("family");
    const json::Value* sty = v->get("style");
    if (!fam || !fam->isString() || fam->string.empty() || !sty || !sty->isString()) return false;
    out = {fam->string, sty->string, ""};
    return true;
  };
  for (const json::Value& e : list->array) {
    FontName from, to;
    if (!e.isObject() || !name(e.get("from"), from) || !name(e.get("to"), to)) return E_INVALID;
    map.emplace_back(from, to);
  }
  if (map.empty()) return E_INVALID;
  // The dialog's scope: these layers and what is inside them (none: the whole file).
  std::vector<Guid> roots;
  if (const json::Value* nodes = args.raw.get("nodes"); nodes && nodes->isArray())
    for (const json::Value& v : nodes->array) {
      bool ok = false;
      Guid g = v.isString() ? Guid::parse(v.string, &ok) : Guid{};
      if (ok && doc_.get(g)) roots.push_back(g);
    }
  auto replaced = [&](const FontName& f, FontName& out) {
    for (auto& [from, to] : map)
      if (f.family == from.family && f.style == from.style) {
        out = to;
        return true;
      }
    return false;
  };
  auto replaceRuns = [&](TextData& td) {
    bool changed = false;
    for (TextStyle& s : td.styleOverrideTable) {
      FontName to;
      if ((s.mask & R_FONT_NAME) && replaced(s.fontName, to)) s.fontName = to, changed = true;
    }
    return changed;
  };

  std::vector<Guid> ids;
  doc_.forEach([&](const Node& n) {
    if (!n.guid.isDerived() && (n.props.type == NodeType::TEXT || n.props.type == NodeType::INSTANCE) && inScope(roots, n.guid))
      ids.push_back(n.guid);
  });
  std::sort(ids.begin(), ids.end());
  bool open = false;
  for (Guid id : ids) {
    const NodeProps& p = doc_.get(id)->props;
    NodeChange c = NodeChange::changed(id);
    if (p.type == NodeType::TEXT) {
      FontName to;
      if (replaced(p.text().fontName, to)) c.mask |= F_FONT_NAME, c.props.text().fontName = to;
      TextData td = p.text().textData;
      if (replaceRuns(td)) c.mask |= F_TEXT_DATA, c.props.text().textData = std::move(td);
    } else {
      SymbolData sd = p.comp().symbolData;
      bool changed = false;
      for (SymbolOverride& o : sd.overrides) {
        FontName to;
        if ((o.mask & F_FONT_NAME) && replaced(o.props.text().fontName, to)) o.props.text().fontName = to, changed = true;
        if (o.mask & F_TEXT_DATA) changed |= replaceRuns(o.props.text().textData);
      }
      if (changed) c.mask |= F_SYMBOL_DATA, c.props.comp().symbolData = std::move(sd);
    }
    if (!c.mask) continue;
    if (!open) begin(TxnKind::USER, "Replace fonts"), open = true;
    write(c);
  }
  if (!open) return OK;
  commit();
  return OK;
}

}  // namespace eng
