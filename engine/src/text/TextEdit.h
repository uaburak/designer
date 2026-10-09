// Edits of a TEXT node's TextData (docs/engine.md §7.6), as pure functions:
// replacing a UTF-16 range (keeping characterStyleIDs and the per-paragraph
// lines in step), run styles on a range (styleOverrideTable), and the layer
// name autoRename gives. The caret and the gestures live in the editor.
#pragma once

#include <cstdint>
#include <string>
#include <map>
#include <string_view>
#include <vector>

#include "scene/Node.h"

namespace eng::text {

// The text's length in UTF-16 units.
uint32_t length16(const TextData& t);
// The style id typing at `index` takes: the character before it (at 0, the first one).
uint32_t styleIdAt(const TextData& t, uint32_t index);
// Replaces [from, to) with `insert`; the new units get `styleID`.
void replaceRange(TextData& t, uint32_t from, uint32_t to, std::u16string_view insert, uint32_t styleID);
// The UTF-16 text of [from, to).
std::u16string slice(const TextData& t, uint32_t from, uint32_t to);

// Sets the run fields in `fields.mask` on [from, to) through styleOverrideTable
// (entries equal to the node's own style collapse to id 0; unused ones go).
void applyRunStyle(TextData& t, uint32_t from, uint32_t to, const TextStyle& fields, const NodeProps& node);
// Drops the run fields in `runMask` from every override (the node's own value
// then applies to all the text: a whole-layer edit).
void clearRunFields(TextData& t, uint32_t runMask);
// The run fields a NodeChange's field mask stands for.
uint32_t runFieldsOf(FieldMask mask);
// The run style holding `node`'s values of `runMask`.
TextStyle runStyleOf(const NodeProps& node, uint32_t runMask);

// Run fields the engine keeps as data (NodeProps::extra form: schema name → varuint id + value; an empty value
// removes the field): set on [from, to) through styleOverrideTable, like applyRunStyle. A value equal to the node's
// own removes the field from the run.
void applyRunExtras(TextData& t, uint32_t from, uint32_t to, const std::map<std::string, std::string>& fields, const NodeProps& node);
// Drops these fields from every run (a whole-layer edit).
void clearRunExtras(TextData& t, const std::vector<std::string>& keys);
// Whether a NodeChange field (schema name) can be a run's: links, variable axes, OpenType switches, decoration details.
bool isRunExtraKey(std::string_view key);
// Whether a change's kept-as-data fields (NodeProps::extra) include one text layout reads (run keys, leadingTrim,
// listSpacing, hangingList, hangingPunctuation, textWrapStyle).
bool changesTextLayout(const std::map<std::string, std::string>& extra);

// A run's fields kept as data, read as a NodeChange's (its styleIdForText, parameterConsumptionMap…).
NodeProps runProps(const TextStyle& run);
// Whether a run holds a text style or variable bindings (styleIdForText / parameterConsumptionMap in its extra).
bool runHasBindings(const TextStyle& run);
// One field of `props` (`field`: its Field bit, `key`: its schema name) as an extra entry (varuint id + value) for
// applyRunExtras; empty when the field is at its default.
std::string extraEntry(const NodeProps& props, FieldMask field, const char* key);

// Paragraph (TextData.lines) edits: the paragraphs [first, last] of the text.
void paragraphsOf(const TextData& t, uint32_t from, uint32_t to, size_t& first, size_t& last);
// Sets the list type of paragraphs [first, last] (PLAIN removes it; a list starts at level 1 at least).
void setListType(TextData& t, size_t first, size_t last, uint8_t lineType);
// Text › Text direction (round 10): the paragraphs' sourceDirectionality (0 AUTO, 1 LTR, 2 RTL).
void setDirection(TextData& t, size_t first, size_t last, uint8_t direction);
// Indents paragraphs [first, last] by `delta` levels (0–5; a list item stays at 1 or more).
void indentParagraphs(TextData& t, size_t first, size_t last, int delta);

// What autoRename names a text layer: its characters on one line.
std::string layerNameFor(const std::string& characters);

}  // namespace eng::text
