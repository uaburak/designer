// Edits of a TEXT node's TextData (docs/engine.md §7.6), as pure functions:
// replacing a UTF-16 range (keeping characterStyleIDs and the per-paragraph
// lines in step), run styles on a range (styleOverrideTable), and the layer
// name autoRename gives. The caret and the gestures live in the editor.
#pragma once

#include <cstdint>
#include <string>
#include <string_view>

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

// What autoRename names a text layer: its characters on one line.
std::string layerNameFor(const std::string& characters);

}  // namespace eng::text
