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

// A Message's blobs as they are read (Message.blobs: base64 strings): blob-index
// fields (vectorData.vectorNetworkBlob, Image.dataBlob) resolve through it.
struct BlobsIn {
  std::vector<Bytes> blobs;
  Bytes get(const json::Value* index) const;
};
// Message.blobs of `message` (absent or malformed entries are empty blobs).
BlobsIn readBlobs(const json::Value& message);

// A Message's blobs as they are written: each distinct blob once, in first-use order.
class BlobsOut {
 public:
  uint32_t add(const Bytes& bytes);
  bool empty() const { return list_.empty(); }
  // `"blobs": [...]` as the next member of an open object (nothing when there are none).
  void writeMember(json::Writer& w) const;
  const std::vector<Bytes>& list() const { return list_; }

 private:
  std::vector<Bytes> list_;
};

// The fields a CREATED change of `p` carries.
FieldMask presentFields(const NodeProps& p);
// Writes one change. Blob fields need `blobs` (the Message's blob table); without it they're left out.
void writeChange(json::Writer& w, const NodeChange& change, BlobsOut* blobs = nullptr);
void writeChanges(json::Writer& w, const std::vector<NodeChange>& changes, BlobsOut* blobs = nullptr);
// A node with every field (for panels), or with the fields of `mask` (`type` always; a panel that needs only paints).
void writeNode(json::Writer& w, const Node& node, BlobsOut* blobs = nullptr);
void writeNode(json::Writer& w, const Node& node, FieldMask mask, BlobsOut* blobs);
// {"type":"NODE_CHANGES","sessionID":…,"nodeChanges":[…],"blobs":[…]}.
void writeMessage(json::Writer& w, uint32_t sessionID, const std::vector<NodeChange>& changes);

// A GUID as "s:l" or {"sessionID","localID"}.
bool readGuid(const json::Value& v, Guid& out);
// Reads one change; false when it has no valid guid. Blob indices resolve through `blobs`.
bool readChange(const json::Value& v, NodeChange& out, const BlobsIn* blobs = nullptr);
// Reads an array of changes (invalid entries are skipped).
std::vector<NodeChange> readChanges(const json::Value& v, const BlobsIn* blobs = nullptr);
// The changes of a Message (or a bare array of changes), its blobs resolved.
std::vector<NodeChange> readMessage(const json::Value& message);

// The schema key a Field bit is written under (its first key: "cornerRadius" for the corner radii, "borderTopWeight"
// for the border weights…), and the bits a key stands for (0 when the engine doesn't model it).
const char* fieldKey(FieldMask bit);
FieldMask fieldOfKey(std::string_view key);
// The keys of every bit in `mask`, in bit order.
std::vector<std::string> fieldKeys(FieldMask mask);

// Where clipboard images' bytes (Image.dataBlob) go when a paint is read (the image registry).
using ImageDataSink = void (*)(const ImageHash& hash, Bytes bytes);
void setImageDataSink(ImageDataSink sink);

// Paints and effects on their own (style tables, tests).
void writePaints(json::Writer& w, const std::vector<Paint>& paints);
std::vector<Paint> readPaints(const json::Value& v, const BlobsIn* blobs = nullptr);
void writeEffects(json::Writer& w, const std::vector<Effect>& effects);
void writeLayoutGrids(json::Writer& w, const std::vector<LayoutGrid>& grids);
// schema VariableData (docs/schema.md §6.2) on its own.
void writeVariable(json::Writer& w, const VariableData& d);
VariableData readVariable(const json::Value& v);

}  // namespace eng::codec
