// A small JSON reader (to a tree) and writer, for the engine's interim wire
// encoding (see scene/codec_json.h). No exceptions: parse() returns null on error.
#pragma once

#include <cstdint>
#include <memory>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace eng::json {

struct Value {
  enum class Kind : uint8_t { Null, Bool, Number, String, Array, Object };
  Kind kind = Kind::Null;
  bool boolean = false;
  double number = 0;
  std::string string;
  std::vector<Value> array;
  std::vector<std::pair<std::string, Value>> object;

  bool isNull() const { return kind == Kind::Null; }
  bool isBool() const { return kind == Kind::Bool; }
  bool isNumber() const { return kind == Kind::Number; }
  bool isString() const { return kind == Kind::String; }
  bool isArray() const { return kind == Kind::Array; }
  bool isObject() const { return kind == Kind::Object; }

  // The member `key` of an object, or nullptr.
  const Value* get(std::string_view key) const;
  double numberOr(double fallback) const { return isNumber() ? number : fallback; }
};

// Parses `text`; on malformed input returns false and leaves `out` null.
bool parse(std::string_view text, Value& out);

class Writer;
// Writes `v` as the next value of `w`.
void write(Writer& w, const Value& v);
// `v` encoded.
std::string encode(const Value& v);

// Streaming writer: the caller keeps track of commas via the helpers.
class Writer {
 public:
  Writer& beginObject();
  Writer& endObject();
  Writer& beginArray();
  Writer& endArray();
  Writer& key(std::string_view k);
  Writer& string(std::string_view s);
  Writer& number(double n);
  Writer& boolean(bool b);
  Writer& null();
  // Already-encoded JSON as the next value.
  Writer& raw(std::string_view encoded);
  const std::string& str() const { return out_; }
  std::string take() { return std::move(out_); }

 private:
  void separate();
  void quoted(std::string_view s);
  std::string out_;
  std::vector<bool> first_;  // per open container: whether nothing was written yet
  bool afterKey_ = false;
};

}  // namespace eng::json
