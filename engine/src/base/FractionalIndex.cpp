#include "base/FractionalIndex.h"

#include <cstdint>

namespace eng::fractional {

bool isValid(std::string_view key) {
  if (key.empty() || key.back() == kMinDigit) return false;
  for (char c : key)
    if (c < kMinDigit || c > kMaxDigit) return false;
  return true;
}

std::string keyBetween(std::string_view lo, std::optional<std::string_view> hiArg, Bias bias) {
  auto digit = [](std::string_view s, size_t i) { return static_cast<int>(s[i]) - kMinDigit; };
  auto ch = [](int d) { return static_cast<char>(d + kMinDigit); };
  std::string out;
  bool open = !hiArg.has_value();  // hi = 1
  std::string_view hi = hiArg.value_or(std::string_view());
  for (size_t i = 0;; i++) {
    int dl = i < lo.size() ? digit(lo, i) : 0;
    int dh = open ? kBase : (i < hi.size() ? digit(hi, i) : 0);
    if (dl == dh) {
      if (!open && i >= lo.size() && i >= hi.size()) return {};  // lo == hi
      out += ch(dl);
      continue;
    }
    if (dl > dh) return {};  // lo > hi
    if (dh - dl >= 2) return out + ch(bias == Bias::Low ? dl + 1 : bias == Bias::High ? dh - 1 : (dl + dh) >> 1);
    out += ch(dl);  // no digit fits here: keep lo's digit; everything after it is below hi
    open = true;
  }
}

std::vector<std::string> keysBetween(std::string_view lo, std::optional<std::string_view> hi, int n) {
  std::vector<std::string> r;
  if (n <= 0) return r;
  if (!hi) {
    std::string k(lo);
    for (int i = 0; i < n; i++) r.push_back(k = keyBetween(k, std::nullopt, Bias::Low));
    return r;
  }
  if (lo.empty()) {
    std::string k(*hi);
    for (int i = 0; i < n; i++) r.insert(r.begin(), k = keyBetween("", std::string_view(k), Bias::High));
    return r;
  }
  int left = (n - 1) >> 1;
  std::string m = keyBetween(lo, hi, Bias::Mid);
  r = keysBetween(lo, std::string_view(m), left);
  r.push_back(m);
  for (auto& k : keysBetween(m, hi, n - 1 - left)) r.push_back(std::move(k));
  return r;
}

std::vector<std::string> rebalancedKeys(int n) {
  std::vector<std::string> keys;
  if (n <= 0) return keys;
  int L = 1;
  uint64_t P = kBase;
  while (P < static_cast<uint64_t>(n) + 1) {
    L++;
    P *= kBase;
  }
  for (int i = 1; i <= n; i++) {
    uint64_t v = (static_cast<uint64_t>(i) * P) / (static_cast<uint64_t>(n) + 1);
    std::string k(static_cast<size_t>(L), kMinDigit);
    for (int j = L - 1; j >= 0; j--) {
      k[static_cast<size_t>(j)] = static_cast<char>(kMinDigit + static_cast<int>(v % kBase));
      v /= kBase;
    }
    while (!k.empty() && k.back() == kMinDigit) k.pop_back();
    keys.push_back(std::move(k));
  }
  return keys;
}

}  // namespace eng::fractional
