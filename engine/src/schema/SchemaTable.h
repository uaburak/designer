// The engine's schema (schema/document.kiwi) at run time: every definition's
// name, kind and fields, parsed once from the binary schema schemagen embeds
// (document.schema.h — the same bytes as SCHEMA_BINARY on the TS side).
//
// scene/CodecKiwi uses it for the fields the engine doesn't model: it skips
// their bytes (keeping them verbatim in `extra`, so they round-trip without
// being understood), and converts them to and from the interim JSON of the
// panel reads (engine_read_nodes, engine_set_props). The modelled fields never
// go through here.
#pragma once

#include <cstdint>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

#include "base/Json.h"
#include "kiwi.h"

namespace eng::schema {

// A kiwi output buffer (kiwi::ByteBuffer appends one byte at a time and has no bulk write): the encodings of
// kiwi.h's writers, over a std::string.
struct Out {
  std::string s;
  void byte(uint8_t b) { s.push_back(static_cast<char>(b)); }
  void varuint(uint32_t v) {
    do {
      uint8_t b = v & 127;
      v >>= 7;
      byte(v ? static_cast<uint8_t>(b | 128) : b);
    } while (v);
  }
  void varint(int32_t v) { varuint((static_cast<uint32_t>(v) << 1) ^ static_cast<uint32_t>(v >> 31)); }
  void varuint64(uint64_t v) {
    for (int i = 0; v > 127 && i < 8; i++) {
      byte(static_cast<uint8_t>((v & 127) | 128));
      v >>= 7;
    }
    byte(static_cast<uint8_t>(v));
  }
  void varint64(int64_t v) { varuint64((static_cast<uint64_t>(v) << 1) ^ static_cast<uint64_t>(v >> 63)); }
  void varfloat(float value);
  void str(std::string_view v) {
    s.append(v.data(), v.size());
    s.push_back('\0');
  }
  void bytes(const void* d, size_t n) { s.append(static_cast<const char*>(d), n); }
  void raw(std::string_view v) { s.append(v.data(), v.size()); }
  size_t size() const { return s.size(); }
};

enum class DefKind : uint8_t { Enum = 0, Struct = 1, Message = 2 };

// kiwi's native type codes (as the binary schema writes them), or a definition index (≥ 0).
enum NativeType : int32_t {
  T_BOOL = -1, T_BYTE = -2, T_INT = -3, T_UINT = -4, T_FLOAT = -5, T_STRING = -6, T_INT64 = -7, T_UINT64 = -8
};

struct FieldDef {
  std::string name;
  int32_t type = 0;    // a NativeType, or the index of a definition
  bool isArray = false;
  uint32_t value = 0;  // the field id (messages), its 1-based position (structs), or the enum value
};

struct Def {
  std::string name;
  DefKind kind = DefKind::Message;
  std::vector<FieldDef> fields;
  // Messages: the field with this id; enums: the value. nullptr when unknown.
  const FieldDef* byId(uint32_t id) const;
  const FieldDef* byName(std::string_view name) const;

 private:
  friend class SchemaTable;
  std::unordered_map<uint32_t, size_t> ids_;
  std::unordered_map<std::string, size_t> names_;
};

class SchemaTable {
 public:
  // The engine's schema, parsed once from document.schema.h.
  static const SchemaTable& get();

  bool parse(const uint8_t* data, size_t len);
  const Def* def(std::string_view name) const;
  const Def* def(int32_t index) const;
  int32_t indexOf(std::string_view name) const;
  const std::vector<Def>& defs() const { return defs_; }

  // Skips one value of `f` (an array's count read first); false on malformed bytes.
  bool skipValue(kiwi::ByteBuffer& bb, const FieldDef& f) const;

  // ---- Kiwi ⇄ the interim JSON (schema names; enums as names; GUID structs as {sessionID, localID}; byte[] as numbers).
  // A raw field sequence of message `def` — (varuint id, value)*, no terminator — as members appended to an open object.
  bool fieldsToJson(json::Writer& w, const Def& def, std::string_view bytes) const;
  // One field's value (an array's count read first) as the next JSON value.
  bool valueToJson(json::Writer& w, const FieldDef& f, kiwi::ByteBuffer& bb) const;
  // A JSON value as field `f`: its id and value appended to `out`; false when the value doesn't fit the type.
  bool fieldFromJson(Out& out, const FieldDef& f, const json::Value& v) const;
  // The value alone (an array's count first), no id.
  bool valueFromJson(Out& out, const FieldDef& f, const json::Value& v) const;
  // A JSON object of message `def` as a raw field sequence (members the schema doesn't know are dropped).
  bool objectToFields(Out& out, const Def& def, const json::Value& v) const;
  // The (id, value bytes) entries of a raw field sequence of `def`: f(const FieldDef&, std::string_view valueBytes).
  template <typename F>
  bool forEachField(const Def& def, std::string_view bytes, F&& f) const {
    kiwi::ByteBuffer bb(reinterpret_cast<const uint8_t*>(bytes.data()), bytes.size());
    while (bb.index() < bb.size()) {
      uint32_t id = 0;
      if (!bb.readVarUint(id) || id == 0) return false;
      const FieldDef* fd = def.byId(id);
      if (!fd) return false;
      size_t start = bb.index();
      if (!skipValue(bb, *fd)) return false;
      f(*fd, bytes.substr(start, bb.index() - start));
    }
    return true;
  }

 private:
  bool skipType(kiwi::ByteBuffer& bb, int32_t type) const;
  bool typeToJson(json::Writer& w, int32_t type, kiwi::ByteBuffer& bb) const;
  bool typeFromJson(Out& out, int32_t type, const json::Value& v) const;

  std::vector<Def> defs_;
  std::unordered_map<std::string, int32_t> index_;
};

// Appends a field's bytes — varuint `id`, then `value` (already encoded) — to a raw field sequence.
void appendField(std::string& out, uint32_t id, std::string_view value);
// Inserts a field's bytes keeping the sequence in field-id order (the canonical order: every writer's output reads
// into the same bytes, so sequences compare by value).
void insertField(const Def& def, std::string& sequence, uint32_t id, std::string_view value);
// A raw field sequence's bytes for field `id` (the first entry; empty when absent). Needs the message's definition.
std::string_view fieldBytes(const Def& def, std::string_view sequence, uint32_t id);
// Removes every entry of field `id` from a raw field sequence.
void eraseField(const Def& def, std::string& sequence, uint32_t id);

}  // namespace eng::schema
