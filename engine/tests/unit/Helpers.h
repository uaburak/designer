// Builders for test documents.
#pragma once

#include <string>
#include <vector>

#include "scene/Document.h"

namespace eng::test {

inline const Guid kDoc{0, 0};
inline const Guid kPage{0, 1};
inline const Guid kInternal{0, 2};

inline NodeChange make(Guid id, NodeType type, Guid parent, const std::string& position, Rect r, const std::string& name = "") {
  NodeProps p = defaultProps(type);
  p.name = name.empty() ? nodeTypeName(type) : name;
  p.parentIndex = {parent, position};
  p.transform = Mat2x3::translate(r.x, r.y);
  p.size = {r.w, r.h};
  return NodeChange::created(id, p);
}

// A new file's three nodes (docs/schema.md §3.1).
inline std::vector<NodeChange> baseChanges() {
  NodeProps doc;
  doc.type = NodeType::DOCUMENT;
  doc.name = "Document";
  NodeProps page;
  page.type = NodeType::CANVAS;
  page.name = "Page 1";
  page.parentIndex = {kDoc, "!"};
  page.rare().backgroundColor = Color::hex(0xF5F5F5);
  page.rare().backgroundEnabled = true;
  NodeProps internal;
  internal.type = NodeType::CANVAS;
  internal.name = "Internal Only Canvas";
  internal.parentIndex = {kDoc, "~"};
  internal.rare().internalOnly = true;
  internal.visible = false;
  return {NodeChange::created(kDoc, doc), NodeChange::created(kPage, page), NodeChange::created(kInternal, internal)};
}

inline void base(Document& d) {
  for (auto& c : baseChanges()) d.apply(c);
}

}  // namespace eng::test
