// The wire encoding of NodeChanges between the engine and TypeScript — JSON
// for now, with schema/document.kiwi's names and meanings (docs/schema.md §4).
// This file (and src/renderer/src/engine/codec.ts on the other side) is the
// only place that knows the encoding: when schemagen's kiwi codecs exist,
// these two change and nothing else.
//
//   { "guid": "1:2", "phase": "CREATED" | "REMOVED" (absent = update),
//     "parentIndex": {"guid": "0:1", "position": "!"}, "type": "FRAME",
//     "name": "Frame 1", "visible": true, "locked": false, "opacity": 1,
//     "size": {"x":100,"y":100},
//     "transform": {"m00":1,"m01":0,"m02":10,"m10":0,"m11":1,"m12":20},
//     "cornerRadius": 0, "rectangleCornerRadiiIndependent": false,
//     "rectangleTopLeftCornerRadius": 0, … "rectangleBottomLeftCornerRadius": 0,
//     "strokeWeight": 1, "strokeAlign": "INSIDE",
//     "fillPaints": [{"type":"SOLID","color":{"r":1,"g":1,"b":1,"a":1},"opacity":1,"visible":true}],
//     "strokePaints": [...], "frameMaskDisabled": false, "resizeToFit": false,
//     "backgroundColor": {...}, "backgroundEnabled": true, "internalOnly": false,
//     "stackMode": "HORIZONTAL", "stackSpacing": 8, "stackHorizontalPadding": 16, …
//     "minSize": {"value": {"x": 0, "y": 0}}, "horizontalConstraint": "MIN", …
//     "clearedFields": [kiwi field ids] (updates only) }
//
// GUIDs are "s:l" strings (objects {"sessionID","localID"} are read too, as in
// decoded .fig files).
//
// A CREATED change carries only the fields that differ from their absence
// value (docs/schema.md §3.4) plus type and parentIndex; an update carries the
// fields it touches.
#pragma once

#include <string>
#include <vector>

#include "base/Json.h"
#include "scene/Node.h"

namespace eng::codec {

// The fields a CREATED change of `p` carries.
FieldMask presentFields(const NodeProps& p);
void writeChange(json::Writer& w, const NodeChange& change);
void writeChanges(json::Writer& w, const std::vector<NodeChange>& changes);
// A node with every field (for panels).
void writeNode(json::Writer& w, const Node& node);

// A GUID as "s:l" or {"sessionID","localID"}.
bool readGuid(const json::Value& v, Guid& out);
// Reads one change; false when it has no valid guid.
bool readChange(const json::Value& v, NodeChange& out);
// Reads an array of changes (invalid entries are skipped).
std::vector<NodeChange> readChanges(const json::Value& v);

}  // namespace eng::codec
