// Dev Mode's annotations and measurements as the document stores them (docs/research/figma/R9-dev-mode.md "Round 6"):
// a layer's notes (NodeChange.annotations: markdown, pinned properties, a category), the page's measurements
// (NodeChange.measurements on the CANVAS) and the file's categories (NodeChange.annotationCategories on the DOCUMENT).
// The engine doesn't model these fields (they stay kiwi bytes in NodeProps::extra); this file reads them for the
// canvas and writes the measurements its tool makes.
#pragma once

#include <string>
#include <vector>

#include "base/Json.h"
#include "scene/Document.h"

namespace eng::annot {

// AnnotationMeasurementNodeSide's order (schema/document.kiwi).
enum class Side : uint8_t { TOP = 0, BOTTOM = 1, LEFT = 2, RIGHT = 3 };
const char* sideName(Side s);
bool sideFromName(const std::string& name, Side& out);
inline bool horizontalSide(Side s) { return s == Side::LEFT || s == Side::RIGHT; }
inline Side oppositeSide(Side s) {
  switch (s) {
    case Side::TOP: return Side::BOTTOM;
    case Side::BOTTOM: return Side::TOP;
    case Side::LEFT: return Side::RIGHT;
    case Side::RIGHT: return Side::LEFT;
  }
  return s;
}

struct Category {
  Guid id = kNoGuid;
  std::string preset;     // "DEVELOPMENT", …, or "" (custom)
  std::string label;      // what the canvas and the menus show
  std::string colorName;  // AnnotationCategoryColor: "YELLOW" … "GREEN"
  Color color;
};

struct Note {
  std::string markdown;                 // labelV2, else label (HTML from older files is reduced to text)
  std::vector<std::string> properties;  // AnnotationPropertyType names, in order
  Guid category = kNoGuid;
};

struct Measurement {
  Guid id = kNoGuid;
  Guid from = kNoGuid, to = kNoGuid;
  Side side = Side::LEFT;  // fromNodeSide
  bool toSameSide = false;
  double inner = 0;        // innerOffsetRelative: −1…1 along the edge, from the from-node's centre
  double outer = 0;        // outerOffsetFixed: past the layers' edge (the sign picks the side), world units
  std::string freeText;
};

// The colours of AnnotationCategoryColor (unverified hexes; Figma's palette names).
Color categoryColor(const std::string& colorName);
// The default colour of a preset category (unverified: Figma's files store presets without colours).
std::string presetColorName(const std::string& preset);
// "Development", "Interaction", …
std::string presetLabel(const std::string& preset);
// The colour annotations without a category are drawn in (Dev Mode's green).
Color defaultNoteColor();
// The colour of saved measurements (unverified).
Color measurementColor();

// Reads.
std::vector<Note> notesOf(const NodeProps& p);
bool hasNotes(const NodeProps& p);
std::vector<Measurement> measurementsOf(const NodeProps& page);
// The file's categories (the DOCUMENT's annotationCategories); Figma's four presets when the file has none.
std::vector<Category> categoriesOf(const NodeProps* document);
const Category* findCategory(const std::vector<Category>& list, Guid id);

// Writes: the field's kiwi bytes for NodeProps::extra (empty when the list is empty: the field is removed).
std::string encodeMeasurements(const std::vector<Measurement>& list);

// Markdown as the canvas shows it: one entry per paragraph / list item / heading, inline markers removed.
struct Line {
  std::string text;
  bool heading = false;
  bool bullet = false;
  int number = 0;  // a numbered item's number (0: none)
};
std::vector<Line> markdownLines(const std::string& markdown);
// A number as the canvas shows it (≤ 2 decimals, trailing zeros trimmed).
std::string formatNumber(double v);
// Plain text of a markdown note (the `label` written beside `labelV2`).
std::string markdownPlain(const std::string& markdown);

// A pinned property's label ("Width", "Fill", …) and the layer's value for it ("120", "#0D99FF", "—").
std::string propertyLabel(const std::string& type);
std::string propertyValue(const Document& doc, Guid id, const std::string& type);

// The GUID in a JSON value written by the schema's codec ({sessionID, localID}) or as "s:l".
Guid guidOf(const json::Value* v);
json::Value guidValue(Guid g);

}  // namespace eng::annot
