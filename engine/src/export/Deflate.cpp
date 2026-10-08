#include "export/Deflate.h"

#include <algorithm>
#include <cstdint>
#include <vector>

namespace eng::exporter {

namespace {

class Bits {
 public:
  explicit Bits(std::string& out) : out_(out) {}
  // `count` bits of `value`, least significant first (deflate's order for everything but Huffman codes).
  void put(uint32_t value, int count) {
    acc_ |= static_cast<uint64_t>(value) << n_;
    n_ += count;
    while (n_ >= 8) {
      out_ += static_cast<char>(acc_ & 0xff);
      acc_ >>= 8;
      n_ -= 8;
    }
  }
  // A Huffman code: most significant bit first.
  void code(uint32_t code, int length) {
    uint32_t r = 0;
    for (int i = 0; i < length; i++) r |= ((code >> i) & 1) << (length - 1 - i);
    put(r, length);
  }
  void flush() {
    if (n_ > 0) out_ += static_cast<char>(acc_ & 0xff);
    acc_ = 0;
    n_ = 0;
  }

 private:
  std::string& out_;
  uint64_t acc_ = 0;
  int n_ = 0;
};

const uint16_t kLenBase[29] = {3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258};
const uint8_t kLenExtra[29] = {0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0};
const uint16_t kDistBase[30] = {1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097,
                                6145, 8193, 12289, 16385, 24577};
const uint8_t kDistExtra[30] = {0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13};

// The fixed literal / length code of `sym` (RFC 1951 §3.2.6).
void literal(Bits& b, uint32_t sym) {
  if (sym <= 143) b.code(0x30 + sym, 8);
  else if (sym <= 255) b.code(0x190 + (sym - 144), 9);
  else if (sym <= 279) b.code(sym - 256, 7);
  else b.code(0xC0 + (sym - 280), 8);
}

void match(Bits& b, uint32_t length, uint32_t distance) {
  int li = 28;
  while (li > 0 && kLenBase[li] > length) li--;
  literal(b, 257 + li);
  if (kLenExtra[li]) b.put(length - kLenBase[li], kLenExtra[li]);
  int di = 29;
  while (di > 0 && kDistBase[di] > distance) di--;
  b.code(static_cast<uint32_t>(di), 5);
  if (kDistExtra[di]) b.put(distance - kDistBase[di], kDistExtra[di]);
}

constexpr uint32_t kWindow = 32768;
constexpr int kHashBits = 15;
constexpr int kMaxChain = 48;
constexpr uint32_t kMaxMatch = 258;

}  // namespace

std::string zlibCompress(std::string_view in) {
  std::string out;
  out.reserve(in.size() / 2 + 64);
  out += static_cast<char>(0x78);
  out += static_cast<char>(0x01);
  Bits b(out);
  b.put(1, 1);  // BFINAL
  b.put(1, 2);  // BTYPE = fixed Huffman
  const auto* data = reinterpret_cast<const uint8_t*>(in.data());
  const size_t n = in.size();
  std::vector<int32_t> head(1u << kHashBits, -1);
  std::vector<int32_t> prev(kWindow, -1);
  auto hash = [&](size_t i) { return ((data[i] << 10) ^ (data[i + 1] << 5) ^ data[i + 2]) & ((1u << kHashBits) - 1); };
  auto insert = [&](size_t i) {
    if (i + 2 >= n) return;
    uint32_t h = hash(i);
    prev[i & (kWindow - 1)] = head[h];
    head[h] = static_cast<int32_t>(i);
  };
  size_t i = 0;
  while (i < n) {
    uint32_t bestLen = 0, bestDist = 0;
    if (i + 2 < n) {
      int32_t cand = head[hash(i)];
      int chain = kMaxChain;
      uint32_t limit = static_cast<uint32_t>(std::min<size_t>(kMaxMatch, n - i));
      while (cand >= 0 && chain-- > 0) {
        size_t c = static_cast<size_t>(cand);
        if (i - c > kWindow - 1 || c >= i) break;
        if (data[c + bestLen] == data[i + bestLen]) {
          uint32_t len = 0;
          while (len < limit && data[c + len] == data[i + len]) len++;
          if (len > bestLen) {
            bestLen = len;
            bestDist = static_cast<uint32_t>(i - c);
            if (len == limit) break;
          }
        }
        int32_t next = prev[c & (kWindow - 1)];
        if (next >= cand) break;
        cand = next;
      }
    }
    if (bestLen >= 3) {
      match(b, bestLen, bestDist);
      for (uint32_t k = 0; k < bestLen; k++) insert(i + k);
      i += bestLen;
    } else {
      literal(b, data[i]);
      insert(i);
      i++;
    }
  }
  literal(b, 256);  // end of block
  b.flush();
  // Adler-32, big endian.
  uint32_t s1 = 1, s2 = 0;
  for (size_t k = 0; k < n;) {
    size_t end = std::min(n, k + 5552);
    for (; k < end; k++) {
      s1 += data[k];
      s2 += s1;
    }
    s1 %= 65521;
    s2 %= 65521;
  }
  uint32_t adler = (s2 << 16) | s1;
  for (int k = 3; k >= 0; k--) out += static_cast<char>((adler >> (8 * k)) & 0xff);
  return out;
}

}  // namespace eng::exporter
