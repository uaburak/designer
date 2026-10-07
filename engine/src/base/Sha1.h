// SHA-1 (FIPS 180-4), for content hashes: a library asset's versionHash (docs/data.md §9.1). Not for security.
#pragma once

#include <algorithm>
#include <array>
#include <cstdint>
#include <cstring>
#include <string>
#include <string_view>

namespace eng {

class Sha1 {
 public:
  Sha1() { reset(); }
  void reset() {
    h_ = {0x67452301u, 0xEFCDAB89u, 0x98BADCFEu, 0x10325476u, 0xC3D2E1F0u};
    len_ = 0;
    used_ = 0;
  }
  void update(const void* data, size_t n) {
    const auto* p = static_cast<const uint8_t*>(data);
    len_ += n;
    while (n) {
      size_t take = std::min(n, sizeof(buf_) - used_);
      std::memcpy(buf_ + used_, p, take);
      used_ += take, p += take, n -= take;
      if (used_ == sizeof(buf_)) block(buf_), used_ = 0;
    }
  }
  void update(std::string_view s) { update(s.data(), s.size()); }
  std::array<uint8_t, 20> digest() {
    uint64_t bits = len_ * 8;
    uint8_t pad = 0x80;
    update(&pad, 1);
    uint8_t zero = 0;
    while (used_ != 56) update(&zero, 1);
    uint8_t lenBytes[8];
    for (int i = 0; i < 8; i++) lenBytes[i] = static_cast<uint8_t>(bits >> (56 - 8 * i));
    update(lenBytes, 8);
    std::array<uint8_t, 20> out{};
    for (int i = 0; i < 5; i++)
      for (int j = 0; j < 4; j++) out[static_cast<size_t>(i * 4 + j)] = static_cast<uint8_t>(h_[static_cast<size_t>(i)] >> (24 - 8 * j));
    return out;
  }
  // 40 lowercase hex digits.
  std::string hexDigest() {
    static const char* kHex = "0123456789abcdef";
    std::string s;
    for (uint8_t b : digest()) s += kHex[b >> 4], s += kHex[b & 15];
    return s;
  }
  static std::string hex(std::string_view data) {
    Sha1 h;
    h.update(data);
    return h.hexDigest();
  }

 private:
  static uint32_t rol(uint32_t x, int n) { return (x << n) | (x >> (32 - n)); }
  void block(const uint8_t* b) {
    uint32_t w[80];
    for (int i = 0; i < 16; i++)
      w[i] = (uint32_t(b[i * 4]) << 24) | (uint32_t(b[i * 4 + 1]) << 16) | (uint32_t(b[i * 4 + 2]) << 8) | uint32_t(b[i * 4 + 3]);
    for (int i = 16; i < 80; i++) w[i] = rol(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    uint32_t a = h_[0], bb = h_[1], c = h_[2], d = h_[3], e = h_[4];
    for (int i = 0; i < 80; i++) {
      uint32_t f, k;
      if (i < 20) f = (bb & c) | (~bb & d), k = 0x5A827999u;
      else if (i < 40) f = bb ^ c ^ d, k = 0x6ED9EBA1u;
      else if (i < 60) f = (bb & c) | (bb & d) | (c & d), k = 0x8F1BBCDCu;
      else f = bb ^ c ^ d, k = 0xCA62C1D6u;
      uint32_t t = rol(a, 5) + f + e + k + w[i];
      e = d, d = c, c = rol(bb, 30), bb = a, a = t;
    }
    h_[0] += a, h_[1] += bb, h_[2] += c, h_[3] += d, h_[4] += e;
  }
  std::array<uint32_t, 5> h_{};
  uint64_t len_ = 0;
  size_t used_ = 0;
  uint8_t buf_[64]{};
};

}  // namespace eng
