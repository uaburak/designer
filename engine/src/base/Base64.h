// Base64 (RFC 4648, with padding): how a Message's blobs travel in the
// interim JSON encoding (docs/engine-build.md "Wire format additions").
#pragma once

#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

namespace eng::base64 {

inline std::string encode(const uint8_t* data, size_t size) {
  static constexpr char kDigits[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string out;
  out.reserve((size + 2) / 3 * 4);
  size_t i = 0;
  for (; i + 2 < size; i += 3) {
    uint32_t v = (static_cast<uint32_t>(data[i]) << 16) | (static_cast<uint32_t>(data[i + 1]) << 8) | data[i + 2];
    out += kDigits[v >> 18];
    out += kDigits[(v >> 12) & 63];
    out += kDigits[(v >> 6) & 63];
    out += kDigits[v & 63];
  }
  if (i < size) {
    uint32_t v = static_cast<uint32_t>(data[i]) << 16;
    if (i + 1 < size) v |= static_cast<uint32_t>(data[i + 1]) << 8;
    out += kDigits[v >> 18];
    out += kDigits[(v >> 12) & 63];
    out += i + 1 < size ? kDigits[(v >> 6) & 63] : '=';
    out += '=';
  }
  return out;
}

inline std::string encode(const std::vector<uint8_t>& bytes) { return encode(bytes.data(), bytes.size()); }

// Decodes `text` (padding optional, whitespace not allowed); false on a bad digit.
inline bool decode(std::string_view text, std::vector<uint8_t>& out) {
  auto value = [](char c) -> int {
    if (c >= 'A' && c <= 'Z') return c - 'A';
    if (c >= 'a' && c <= 'z') return c - 'a' + 26;
    if (c >= '0' && c <= '9') return c - '0' + 52;
    if (c == '+' || c == '-') return 62;
    if (c == '/' || c == '_') return 63;
    return -1;
  };
  out.clear();
  out.reserve(text.size() / 4 * 3);
  uint32_t acc = 0;
  int bits = 0;
  for (char c : text) {
    if (c == '=') break;
    int v = value(c);
    if (v < 0) return false;
    acc = (acc << 6) | static_cast<uint32_t>(v);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push_back(static_cast<uint8_t>((acc >> bits) & 0xff));
    }
  }
  return true;
}

}  // namespace eng::base64
