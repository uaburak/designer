#include "schema/SchemaTable.h"

#include <algorithm>
#include <cmath>
#include <cstring>

#include "schema/document.schema.h"

namespace eng::schema {

namespace {

bool readString(kiwi::ByteBuffer& bb, std::string& out) {
  const char* s = nullptr;
  if (!bb.readString(s)) return false;
  out = s;
  return true;
}

// A GUID struct's two fields from "s:l" (the engine's JSON writes GUIDs as strings at the top level).
bool guidFromString(std::string_view s, uint32_t& session, uint32_t& local) {
  size_t colon = s.find(':');
  if (colon == std::string_view::npos || colon == 0 || colon + 1 >= s.size()) return false;
  for (size_t i = 0; i < s.size(); i++)
    if (i != colon && (s[i] < '0' || s[i] > '9')) return false;
  session = static_cast<uint32_t>(std::strtoul(std::string(s.substr(0, colon)).c_str(), nullptr, 10));
  local = static_cast<uint32_t>(std::strtoul(std::string(s.substr(colon + 1)).c_str(), nullptr, 10));
  return true;
}

int hexDigit(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

}  // namespace

const FieldDef* Def::byId(uint32_t id) const {
  auto it = ids_.find(id);
  return it == ids_.end() ? nullptr : &fields[it->second];
}

const FieldDef* Def::byName(std::string_view name) const {
  auto it = names_.find(std::string(name));
  return it == names_.end() ? nullptr : &fields[it->second];
}

const SchemaTable& SchemaTable::get() {
  static SchemaTable* table = [] {
    auto* t = new SchemaTable();
    t->parse(::schema::kSchemaBinary, ::schema::kSchemaBinarySize);
    return t;
  }();
  return *table;
}

bool SchemaTable::parse(const uint8_t* data, size_t len) {
  defs_.clear();
  index_.clear();
  kiwi::ByteBuffer bb(data, len);
  uint32_t count = 0;
  if (!bb.readVarUint(count)) return false;
  defs_.resize(count);
  for (uint32_t i = 0; i < count; i++) {
    Def& d = defs_[i];
    uint8_t kind = 0;
    uint32_t fields = 0;
    if (!readString(bb, d.name) || !bb.readByte(kind) || !bb.readVarUint(fields) || kind > 2) return false;
    d.kind = static_cast<DefKind>(kind);
    d.fields.resize(fields);
    for (uint32_t j = 0; j < fields; j++) {
      FieldDef& f = d.fields[j];
      uint8_t isArray = 0;
      if (!readString(bb, f.name) || !bb.readVarInt(f.type) || !bb.readByte(isArray) || !bb.readVarUint(f.value)) return false;
      if (f.type < T_UINT64 || f.type >= static_cast<int32_t>(count)) return false;
      f.isArray = isArray != 0;
      d.ids_.emplace(f.value, j);
      d.names_.emplace(f.name, j);
    }
    index_.emplace(d.name, static_cast<int32_t>(i));
  }
  return true;
}

const Def* SchemaTable::def(std::string_view name) const {
  auto it = index_.find(std::string(name));
  return it == index_.end() ? nullptr : &defs_[static_cast<size_t>(it->second)];
}

const Def* SchemaTable::def(int32_t index) const {
  return index >= 0 && static_cast<size_t>(index) < defs_.size() ? &defs_[static_cast<size_t>(index)] : nullptr;
}

int32_t SchemaTable::indexOf(std::string_view name) const {
  auto it = index_.find(std::string(name));
  return it == index_.end() ? -1 : it->second;
}

// ---- Skipping -------------------------------------------------------------------------------------------------

bool SchemaTable::skipValue(kiwi::ByteBuffer& bb, const FieldDef& f) const {
  uint32_t count = 1;
  if (f.isArray && !bb.readVarUint(count)) return false;
  while (count-- > 0)
    if (!skipType(bb, f.type)) return false;
  return true;
}

bool SchemaTable::skipType(kiwi::ByteBuffer& bb, int32_t type) const {
  switch (type) {
    case T_BOOL:
    case T_BYTE: {
      uint8_t b;
      return bb.readByte(b);
    }
    case T_INT:
    case T_UINT: {
      uint32_t u;
      return bb.readVarUint(u);
    }
    case T_FLOAT: {
      float x;
      return bb.readVarFloat(x);
    }
    case T_STRING: {
      uint8_t b;
      do {
        if (!bb.readByte(b)) return false;
      } while (b);
      return true;
    }
    case T_INT64:
    case T_UINT64: {
      uint64_t u;
      return bb.readVarUint64(u);
    }
    default: break;
  }
  const Def* d = def(type);
  if (!d) return false;
  switch (d->kind) {
    case DefKind::Enum: {
      uint32_t u;
      return bb.readVarUint(u);
    }
    case DefKind::Struct:
      for (const FieldDef& f : d->fields)
        if (!skipValue(bb, f)) return false;
      return true;
    case DefKind::Message:
      for (;;) {
        uint32_t id = 0;
        if (!bb.readVarUint(id)) return false;
        if (!id) return true;
        const FieldDef* f = d->byId(id);
        if (!f || !skipValue(bb, *f)) return false;
      }
  }
  return false;
}

// ---- Kiwi → JSON ---------------------------------------------------------------------------------------------

bool SchemaTable::fieldsToJson(json::Writer& w, const Def& d, std::string_view bytes) const {
  kiwi::ByteBuffer bb(reinterpret_cast<const uint8_t*>(bytes.data()), bytes.size());
  while (bb.index() < bb.size()) {
    uint32_t id = 0;
    if (!bb.readVarUint(id) || !id) return false;
    const FieldDef* f = d.byId(id);
    if (!f) return false;
    w.key(f->name);
    if (!valueToJson(w, *f, bb)) return false;
  }
  return true;
}

bool SchemaTable::valueToJson(json::Writer& w, const FieldDef& f, kiwi::ByteBuffer& bb) const {
  if (!f.isArray) return typeToJson(w, f.type, bb);
  uint32_t count = 0;
  if (!bb.readVarUint(count)) return false;
  w.beginArray();
  for (uint32_t i = 0; i < count; i++)
    if (!typeToJson(w, f.type, bb)) return false;
  w.endArray();
  return true;
}

bool SchemaTable::typeToJson(json::Writer& w, int32_t type, kiwi::ByteBuffer& bb) const {
  switch (type) {
    case T_BOOL: {
      bool b;
      if (!bb.readByte(b)) return false;
      w.boolean(b);
      return true;
    }
    case T_BYTE: {
      uint8_t b;
      if (!bb.readByte(b)) return false;
      w.number(b);
      return true;
    }
    case T_INT: {
      int32_t i;
      if (!bb.readVarInt(i)) return false;
      w.number(i);
      return true;
    }
    case T_UINT: {
      uint32_t u;
      if (!bb.readVarUint(u)) return false;
      w.number(u);
      return true;
    }
    case T_FLOAT: {
      float x;
      if (!bb.readVarFloat(x)) return false;
      w.number(x);
      return true;
    }
    case T_STRING: {
      const char* s;
      if (!bb.readString(s)) return false;
      w.string(s);
      return true;
    }
    case T_INT64: {
      int64_t i;
      if (!bb.readVarInt64(i)) return false;
      w.number(static_cast<double>(i));
      return true;
    }
    case T_UINT64: {
      uint64_t u;
      if (!bb.readVarUint64(u)) return false;
      w.number(static_cast<double>(u));
      return true;
    }
    default: break;
  }
  const Def* d = def(type);
  if (!d) return false;
  switch (d->kind) {
    case DefKind::Enum: {
      uint32_t u;
      if (!bb.readVarUint(u)) return false;
      const FieldDef* v = d->byId(u);
      if (v) w.string(v->name);
      else w.number(u);
      return true;
    }
    case DefKind::Struct:
      w.beginObject();
      for (const FieldDef& f : d->fields) {
        w.key(f.name);
        if (!valueToJson(w, f, bb)) return false;
      }
      w.endObject();
      return true;
    case DefKind::Message:
      w.beginObject();
      for (;;) {
        uint32_t id = 0;
        if (!bb.readVarUint(id)) return false;
        if (!id) break;
        const FieldDef* f = d->byId(id);
        if (!f) return false;
        w.key(f->name);
        if (!valueToJson(w, *f, bb)) return false;
      }
      w.endObject();
      return true;
  }
  return false;
}

// ---- JSON → kiwi ---------------------------------------------------------------------------------------------

void Out::varfloat(float value) {
  uint32_t bits;
  std::memcpy(&bits, &value, 4);
  bits = (bits >> 23) | (bits << 9);  // the exponent first: a zero exponent is one byte
  if ((bits & 255) == 0) {
    byte(0);
    return;
  }
  byte(static_cast<uint8_t>(bits));
  byte(static_cast<uint8_t>(bits >> 8));
  byte(static_cast<uint8_t>(bits >> 16));
  byte(static_cast<uint8_t>(bits >> 24));
}

bool SchemaTable::valueFromJson(Out& out, const FieldDef& f, const json::Value& v) const {
  if (!f.isArray) return typeFromJson(out, f.type, v);
  // byte[] also as a hex string (an image hash).
  if (f.type == T_BYTE && v.isString()) {
    if (v.string.size() % 2) return false;
    out.varuint(static_cast<uint32_t>(v.string.size() / 2));
    for (size_t i = 0; i + 1 < v.string.size(); i += 2) {
      int hi = hexDigit(v.string[i]), lo = hexDigit(v.string[i + 1]);
      if (hi < 0 || lo < 0) return false;
      out.byte(static_cast<uint8_t>(hi * 16 + lo));
    }
    return true;
  }
  if (!v.isArray()) return false;
  out.varuint(static_cast<uint32_t>(v.array.size()));
  for (const json::Value& e : v.array)
    if (!typeFromJson(out, f.type, e)) return false;
  return true;
}

bool SchemaTable::fieldFromJson(Out& out, const FieldDef& f, const json::Value& v) const {
  Out value;
  if (!valueFromJson(value, f, v)) return false;
  out.varuint(f.value);
  out.raw(value.s);
  return true;
}

bool SchemaTable::objectToFields(Out& out, const Def& d, const json::Value& v) const {
  if (!v.isObject()) return false;
  for (auto& [k, x] : v.object) {
    const FieldDef* f = d.byName(k);
    if (!f || x.isNull()) continue;
    if (!fieldFromJson(out, *f, x)) return false;
  }
  return true;
}

bool SchemaTable::typeFromJson(Out& out, int32_t type, const json::Value& v) const {
  switch (type) {
    case T_BOOL:
      if (v.isBool()) out.byte(v.boolean ? 1 : 0);
      else if (v.isNumber()) out.byte(v.number != 0 ? 1 : 0);
      else return false;
      return true;
    case T_BYTE:
      if (!v.isNumber()) return false;
      out.byte(static_cast<uint8_t>(std::clamp(v.number, 0.0, 255.0)));
      return true;
    case T_INT:
      if (!v.isNumber()) return false;
      out.varint(static_cast<int32_t>(v.number));
      return true;
    case T_UINT:
      if (!v.isNumber() || v.number < 0) return false;
      out.varuint(static_cast<uint32_t>(v.number));
      return true;
    case T_FLOAT:
      if (!v.isNumber()) return false;
      out.varfloat(static_cast<float>(v.number));
      return true;
    case T_STRING:
      if (!v.isString()) return false;
      out.str(v.string);
      return true;
    case T_INT64:
      if (!v.isNumber()) return false;
      out.varint64(static_cast<int64_t>(v.number));
      return true;
    case T_UINT64:
      if (!v.isNumber() || v.number < 0) return false;
      out.varuint64(static_cast<uint64_t>(v.number));
      return true;
    default: break;
  }
  const Def* d = def(type);
  if (!d) return false;
  switch (d->kind) {
    case DefKind::Enum: {
      if (v.isNumber()) {
        out.varuint(static_cast<uint32_t>(v.number));
        return true;
      }
      if (!v.isString()) return false;
      const FieldDef* e = d->byName(v.string);
      if (!e) return false;
      out.varuint(e->value);
      return true;
    }
    case DefKind::Struct: {
      // A GUID as "s:l".
      if (v.isString() && d->name == "GUID") {
        uint32_t s, l;
        if (!guidFromString(v.string, s, l)) return false;
        out.varuint(s);
        out.varuint(l);
        return true;
      }
      if (!v.isObject()) return false;
      for (const FieldDef& f : d->fields) {
        const json::Value* x = v.get(f.name);
        if (x && !x->isNull()) {
          if (!valueFromJson(out, f, *x)) return false;
          continue;
        }
        // A missing struct member: its zero value.
        if (f.isArray) {
          out.varuint(0);
          continue;
        }
        json::Value zero;
        if (f.type == T_STRING) zero.kind = json::Value::Kind::String;
        else if (f.type == T_BOOL) zero.kind = json::Value::Kind::Bool;
        else if (f.type < 0) zero.kind = json::Value::Kind::Number;
        else {
          const Def* fd = def(f.type);
          zero.kind = fd && fd->kind == DefKind::Enum ? json::Value::Kind::Number : json::Value::Kind::Object;
        }
        if (!typeFromJson(out, f.type, zero)) return false;
      }
      return true;
    }
    case DefKind::Message: {
      if (!v.isObject()) return false;
      if (!objectToFields(out, *d, v)) return false;
      out.varuint(0);
      return true;
    }
  }
  return false;
}

// ---- Raw field sequences --------------------------------------------------------------------------------------

void appendField(std::string& out, uint32_t id, std::string_view value) {
  Out o;
  o.varuint(id);
  out += o.s;
  out.append(value.data(), value.size());
}

void insertField(const Def& def, std::string& sequence, uint32_t id, std::string_view value) {
  if (sequence.empty()) {
    appendField(sequence, id, value);
    return;
  }
  std::string before, after;
  bool placed = false;
  bool ok = SchemaTable::get().forEachField(def, sequence, [&](const FieldDef& f, std::string_view v) {
    if (!placed && f.value > id) placed = true;
    appendField(placed ? after : before, f.value, v);
  });
  if (!ok) {  // not a sequence this definition reads: keep what is there, append
    appendField(sequence, id, value);
    return;
  }
  sequence = std::move(before);
  appendField(sequence, id, value);
  sequence += after;
}

std::string_view fieldBytes(const Def& def, std::string_view sequence, uint32_t id) {
  std::string_view found;
  bool got = false;
  SchemaTable::get().forEachField(def, sequence, [&](const FieldDef& f, std::string_view value) {
    if (!got && f.value == id) {
      found = value;
      got = true;
    }
  });
  return found;
}

void eraseField(const Def& def, std::string& sequence, uint32_t id) {
  std::string kept;
  SchemaTable::get().forEachField(def, sequence, [&](const FieldDef& f, std::string_view value) {
    if (f.value != id) appendField(kept, f.value, value);
  });
  sequence = std::move(kept);
}

}  // namespace eng::schema
