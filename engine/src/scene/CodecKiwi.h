// The kiwi encoding of Messages between the engine and TypeScript: Figma's
// own schema/document.kiwi Message, read and written directly by the engine
// (docs/engine-build.md "Figma parity round 3"). engine_load takes the store's
// snapshot bytes as they are; every NODE_CHANGES the engine emits or accepts is
// one of these. The interim JSON (scene/CodecJson) stays for the panels' reads
// and writes (engine_read_nodes, engine_set_props) and, during the transition,
// as an alternative input detected by its first byte.
//
// Modelled fields map onto NodeProps exactly as CodecJson does; every other
// field keeps its kiwi bytes verbatim (NodeProps::extra and the structs'
// `extra` sequences, see scene/Node.h), so it round-trips without being
// understood and costs nothing to load.
#pragma once

#include <functional>
#include <string>
#include <string_view>
#include <vector>

#include "kiwi.h"
#include "scene/CodecJson.h"
#include "scene/Node.h"

namespace eng::codec {

// A clipboard Message's region (Message.clipboardSelectionRegions).
struct KiwiRegion {
  Guid parent = kNoGuid;
  std::vector<Guid> nodes;
  Vec2 offset;
};

// What a Message carries besides its changes.
struct KiwiMessage {
  uint32_t sessionID = 0;
  std::vector<NodeChange> changes;
  uint32_t derivedDataVersion = 0;  // Message.derivedDataVersion (0: no derived data)
  // Clipboard (docs/schema.md §4.1).
  bool hasPastePage = false;
  Guid pastePageId = kNoGuid;
  std::string pasteFileKey;
  bool isCut = false;
  std::vector<KiwiRegion> regions;
  // Message.blobs (blob-index fields of what a DerivedSink was handed resolve through it).
  std::vector<Bytes> blobs;
};

// Derived data read along with a Message (item 2 of the round): per node, its stored derived entries.
struct DerivedSymbolEntry {
  std::vector<Guid> path;  // guidPath (effective keys from the instance down)
  bool hasSize = false, hasTransform = false;
  Vec2 size;
  Mat2x3 transform;
  std::string text;  // a TEXT sublayer: its derivedTextData's raw field sequence (empty: none)
};
struct DerivedTextEntry {
  std::string bytes;  // the DerivedTextData message's raw field sequence (decoded by text/DerivedText)
};
class DerivedSink {
 public:
  virtual ~DerivedSink() = default;
  virtual void symbolData(Guid instance, std::vector<DerivedSymbolEntry>&& entries) = 0;
  virtual void textData(Guid node, DerivedTextEntry&& entry) = 0;
};

// Is `bytes` a kiwi payload? The interim JSON starts with '{', '[' or whitespace; a kiwi Message with a field id.
bool looksKiwi(std::string_view bytes);
// A Message's bytes → its changes and extras. False (and `out` partial) on malformed bytes. Blob-index fields
// resolve through Message.blobs whatever their order; clipboard images (Image.dataBlob) go to the image sink.
bool readMessage(std::string_view bytes, KiwiMessage& out, DerivedSink* derived = nullptr);
// A message list (import / update payloads): 0x00, varuint count, count × (varuint length, Message bytes).
bool isMessageList(std::string_view bytes);
bool readMessageList(std::string_view bytes, std::vector<KiwiMessage>& out);
std::string writeMessageList(const std::vector<std::string>& messages);

struct KiwiWriteOptions {
  uint32_t derivedDataVersion = 0;
  // Called for each CREATED change before its terminator: further fields (derived data) and their blobs.
  std::function<void(const NodeChange&, std::string& fields, BlobsOut& blobs)> extraFields;
  const Guid* pastePageId = nullptr;
  std::string pasteFileKey;
  bool isCut = false;
  const std::vector<KiwiRegion>* regions = nullptr;
};
// {type NODE_CHANGES, sessionID, nodeChanges, blobs, …}: the Message's bytes.
std::string writeMessage(uint32_t sessionID, const std::vector<NodeChange>& changes, const KiwiWriteOptions& opts = {});

// One change (tests, derived data): a NodeChange message, terminator included.
void writeChange(kiwi::ByteBuffer& bb, const NodeChange& change, BlobsOut& blobs);
// Reads one NodeChange message (positioned at its first field id). `blobs`: the Message's table, filled later.
class KiwiBlobs;
bool readChange(kiwi::ByteBuffer& bb, NodeChange& out, KiwiBlobs* blobs, DerivedSink* derived = nullptr);

// Message.blobs as read: slots handed out by index while the changes are read (the table may come after them in the
// bytes), filled when it arrives.
class KiwiBlobs {
 public:
  Bytes get(uint32_t index);
  void fill(uint32_t index, const uint8_t* data, size_t len);
  // A clipboard image's bytes (Image.dataBlob): handed to the image sink once the table is in.
  void deferImage(const ImageHash& hash, uint32_t index);
  void finish();
  std::vector<Bytes> table() const;

 private:
  std::vector<std::shared_ptr<std::vector<uint8_t>>> slots_;
  std::vector<std::pair<ImageHash, uint32_t>> images_;
};

// Paints / effects / variable data on their own (the JSON codec's conversions, tests).
void writePaint(kiwi::ByteBuffer& bb, const Paint& p, BlobsOut* blobs);
bool readPaint(kiwi::ByteBuffer& bb, Paint& out, KiwiBlobs* blobs);
void writeVariableData(kiwi::ByteBuffer& bb, const VariableData& d);
bool readVariableData(kiwi::ByteBuffer& bb, VariableData& out);

// Unmodelled fields ⇄ the interim JSON, through the schema (schema/SchemaTable): the raw field sequence of a
// message `def` as JSON members ("k":v,…), and one JSON member as raw bytes (empty when the schema doesn't know it).
std::string extraToJsonMembers(const char* def, std::string_view sequence);
// NodeProps::extra: one entry's value (varuint id + value bytes) as a JSON value ("null" when unreadable).
std::string extraValueToJson(const char* def, std::string_view entry);
// A JSON member → the (varuint id, value) bytes of field `key` of `def`; empty when the schema doesn't know the key
// or the value doesn't fit.
std::string extraFromJson(const char* def, std::string_view key, const json::Value& value);
// The kiwi field id of `key` in `def` (0 when unknown).
uint32_t fieldIdOf(const char* def, std::string_view key);
// A ComponentPropAssignment's slot content as Figma's files give it — its varValue's slotContentIdValue (the raw
// field sequence `extra`); kNoGuid when it has none.
Guid assignmentSlotContent(std::string_view extra);
// A ComponentPropAssignment's varValue (Figma's files may give a property's value there only, `value` left empty).
bool assignmentVarValue(std::string_view extra, VariableData& out);
// A bool field of a raw sequence (Libraries' isSymbolPublishable): `fallback` when absent.
bool extraBool(const std::map<std::string, std::string>& extra, const char* key, bool fallback);

}  // namespace eng::codec
