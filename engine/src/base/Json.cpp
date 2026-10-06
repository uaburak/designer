#include "base/Json.h"

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>

namespace eng::json {

const Value* Value::get(std::string_view key) const {
  if (kind != Kind::Object) return nullptr;
  for (auto& [k, v] : object)
    if (k == key) return &v;
  return nullptr;
}

namespace {

struct Parser {
  std::string_view s;
  size_t i = 0;
  int depth = 0;

  void ws() {
    while (i < s.size() && (s[i] == ' ' || s[i] == '\n' || s[i] == '\r' || s[i] == '\t')) i++;
  }
  bool lit(std::string_view w) {
    if (s.substr(i, w.size()) != w) return false;
    i += w.size();
    return true;
  }
  static void utf8(std::string& out, uint32_t cp) {
    if (cp < 0x80) {
      out += static_cast<char>(cp);
    } else if (cp < 0x800) {
      out += static_cast<char>(0xC0 | (cp >> 6));
      out += static_cast<char>(0x80 | (cp & 0x3F));
    } else if (cp < 0x10000) {
      out += static_cast<char>(0xE0 | (cp >> 12));
      out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
      out += static_cast<char>(0x80 | (cp & 0x3F));
    } else {
      out += static_cast<char>(0xF0 | (cp >> 18));
      out += static_cast<char>(0x80 | ((cp >> 12) & 0x3F));
      out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
      out += static_cast<char>(0x80 | (cp & 0x3F));
    }
  }
  bool hex4(uint32_t& v) {
    if (i + 4 > s.size()) return false;
    v = 0;
    for (int k = 0; k < 4; k++) {
      char c = s[i++];
      v <<= 4;
      if (c >= '0' && c <= '9') v |= c - '0';
      else if (c >= 'a' && c <= 'f') v |= c - 'a' + 10;
      else if (c >= 'A' && c <= 'F') v |= c - 'A' + 10;
      else return false;
    }
    return true;
  }
  bool str(std::string& out) {
    if (i >= s.size() || s[i] != '"') return false;
    i++;
    while (i < s.size()) {
      char c = s[i++];
      if (c == '"') return true;
      if (c != '\\') {
        out += c;
        continue;
      }
      if (i >= s.size()) return false;
      char e = s[i++];
      switch (e) {
        case '"': out += '"'; break;
        case '\\': out += '\\'; break;
        case '/': out += '/'; break;
        case 'b': out += '\b'; break;
        case 'f': out += '\f'; break;
        case 'n': out += '\n'; break;
        case 'r': out += '\r'; break;
        case 't': out += '\t'; break;
        case 'u': {
          uint32_t cp;
          if (!hex4(cp)) return false;
          if (cp >= 0xD800 && cp < 0xDC00 && s.substr(i, 2) == "\\u") {
            i += 2;
            uint32_t lo;
            if (!hex4(lo)) return false;
            cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
          }
          utf8(out, cp);
          break;
        }
        default: return false;
      }
    }
    return false;
  }
  bool value(Value& v) {
    if (++depth > 256) return false;
    ws();
    if (i >= s.size()) return false;
    char c = s[i];
    bool ok = true;
    if (c == '{') {
      i++;
      v.kind = Value::Kind::Object;
      ws();
      if (i < s.size() && s[i] == '}') {
        i++;
      } else {
        while (true) {
          ws();
          std::string k;
          if (!str(k)) { ok = false; break; }
          ws();
          if (i >= s.size() || s[i] != ':') { ok = false; break; }
          i++;
          Value child;
          if (!value(child)) { ok = false; break; }
          v.object.emplace_back(std::move(k), std::move(child));
          ws();
          if (i < s.size() && s[i] == ',') { i++; continue; }
          if (i < s.size() && s[i] == '}') { i++; break; }
          ok = false;
          break;
        }
      }
    } else if (c == '[') {
      i++;
      v.kind = Value::Kind::Array;
      ws();
      if (i < s.size() && s[i] == ']') {
        i++;
      } else {
        while (true) {
          Value child;
          if (!value(child)) { ok = false; break; }
          v.array.push_back(std::move(child));
          ws();
          if (i < s.size() && s[i] == ',') { i++; continue; }
          if (i < s.size() && s[i] == ']') { i++; break; }
          ok = false;
          break;
        }
      }
    } else if (c == '"') {
      v.kind = Value::Kind::String;
      ok = str(v.string);
    } else if (lit("true")) {
      v.kind = Value::Kind::Bool;
      v.boolean = true;
    } else if (lit("false")) {
      v.kind = Value::Kind::Bool;
    } else if (lit("null")) {
      v.kind = Value::Kind::Null;
    } else {
      size_t start = i;
      while (i < s.size() && (std::string_view("+-.eE0123456789").find(s[i]) != std::string_view::npos)) i++;
      if (i == start) return false;
      std::string num(s.substr(start, i - start));
      char* end = nullptr;
      v.kind = Value::Kind::Number;
      v.number = std::strtod(num.c_str(), &end);
      ok = end && *end == '\0';
    }
    depth--;
    return ok;
  }
};

}  // namespace

bool parse(std::string_view text, Value& out) {
  Parser p{text};
  Value v;
  if (!p.value(v)) {
    out = Value{};
    return false;
  }
  p.ws();
  if (p.i != text.size()) {
    out = Value{};
    return false;
  }
  out = std::move(v);
  return true;
}

void Writer::separate() {
  if (afterKey_) {
    afterKey_ = false;
    return;
  }
  if (!first_.empty()) {
    if (!first_.back()) out_ += ',';
    first_.back() = false;
  }
}

Writer& Writer::beginObject() {
  separate();
  out_ += '{';
  first_.push_back(true);
  return *this;
}
Writer& Writer::endObject() {
  out_ += '}';
  first_.pop_back();
  return *this;
}
Writer& Writer::beginArray() {
  separate();
  out_ += '[';
  first_.push_back(true);
  return *this;
}
Writer& Writer::endArray() {
  out_ += ']';
  first_.pop_back();
  return *this;
}
Writer& Writer::key(std::string_view k) {
  separate();
  quoted(k);
  out_ += ':';
  afterKey_ = true;
  return *this;
}
Writer& Writer::string(std::string_view s) {
  separate();
  quoted(s);
  return *this;
}
void Writer::quoted(std::string_view s) {
  out_ += '"';
  for (unsigned char c : s) {
    switch (c) {
      case '"': out_ += "\\\""; break;
      case '\\': out_ += "\\\\"; break;
      case '\n': out_ += "\\n"; break;
      case '\r': out_ += "\\r"; break;
      case '\t': out_ += "\\t"; break;
      default:
        if (c < 0x20) {
          char buf[8];
          std::snprintf(buf, sizeof buf, "\\u%04x", c);
          out_ += buf;
        } else {
          out_ += static_cast<char>(c);
        }
    }
  }
  out_ += '"';
}
Writer& Writer::number(double n) {
  separate();
  if (!std::isfinite(n)) {
    out_ += "0";
    return *this;
  }
  char buf[32];
  if (n == std::floor(n) && std::fabs(n) < 1e15) std::snprintf(buf, sizeof buf, "%.0f", n);
  else std::snprintf(buf, sizeof buf, "%.17g", n);
  out_ += buf;
  return *this;
}
Writer& Writer::boolean(bool b) {
  separate();
  out_ += b ? "true" : "false";
  return *this;
}
Writer& Writer::raw(std::string_view encoded) {
  separate();
  out_ += encoded;
  return *this;
}
Writer& Writer::null() {
  separate();
  out_ += "null";
  return *this;
}

}  // namespace eng::json
