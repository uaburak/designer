#include <algorithm>
#include <fstream>
#include <optional>
#include <random>
#include <string>
#include <vector>

#include "base/FractionalIndex.h"
#include "base/Json.h"
#include "doctest.h"

using namespace eng;
using fractional::Bias;

namespace {

Bias biasOf(const std::string& s) { return s == "LOW" ? Bias::Low : s == "HIGH" ? Bias::High : Bias::Mid; }

std::optional<std::string_view> hiOf(const json::Value& v) {
  const json::Value* hi = v.get("hi");
  if (!hi || hi->isNull()) return std::nullopt;
  return std::string_view(hi->string);
}

}  // namespace

TEST_CASE("fractional: the shared vectors (docs/schema.md §10.2)") {
  std::ifstream in(ENG_TEST_DATA "/fractional-index-vectors.txt");
  REQUIRE(in.good());
  std::string line;
  int checked = 0;
  while (std::getline(in, line)) {
    if (line.empty() || line[0] == '#') continue;
    json::Value v;
    REQUIRE(json::parse(line, v));
    const std::string& fn = v.get("fn")->string;
    INFO(line);
    if (fn == "keyBetween") {
      CHECK(fractional::keyBetween(v.get("lo")->string, hiOf(v), biasOf(v.get("bias")->string)) == v.get("out")->string);
    } else if (fn == "keysBetween") {
      auto keys = fractional::keysBetween(v.get("lo")->string, hiOf(v), static_cast<int>(v.get("n")->number));
      const auto& out = v.get("out")->array;
      REQUIRE(keys.size() == out.size());
      for (size_t i = 0; i < out.size(); i++) CHECK(keys[i] == out[i].string);
    } else if (fn == "rebalancedKeys") {
      auto keys = fractional::rebalancedKeys(static_cast<int>(v.get("n")->number));
      const auto& out = v.get("out")->array;
      REQUIRE(keys.size() >= out.size());
      for (size_t i = 0; i < out.size(); i++) CHECK(keys[i] == out[i].string);
    } else if (fn == "appendRun") {
      std::string k;
      for (int i = 0; i < static_cast<int>(v.get("n")->number); i++) k = fractional::keyBetween(k, std::nullopt, Bias::Low);
      CHECK(k == v.get("out")->string);
    }
    checked++;
  }
  CHECK(checked > 300);
}

TEST_CASE("fractional: validity and refusals") {
  CHECK(fractional::isValid("!"));
  CHECK_FALSE(fractional::isValid(""));
  CHECK_FALSE(fractional::isValid("a "));  // trailing zero digit
  CHECK_FALSE(fractional::isValid("a\x7f"));
  CHECK(fractional::keyBetween("B", std::string_view("A")).empty());
  CHECK(fractional::keyBetween("A", std::string_view("A")).empty());
}

TEST_CASE("fractional: random inserts stay ordered, valid and short") {
  std::mt19937 rng(42);
  std::vector<std::string> keys{fractional::keyBetween("", std::nullopt, Bias::Low)};
  for (int i = 0; i < 20000; i++) {
    size_t at = rng() % (keys.size() + 1);
    std::string lo = at == 0 ? "" : keys[at - 1];
    std::optional<std::string> hi;
    if (at < keys.size()) hi = keys[at];
    Bias bias = !hi ? Bias::Low : lo.empty() ? Bias::High : Bias::Mid;
    std::string k = fractional::keyBetween(lo, hi ? std::optional<std::string_view>(*hi) : std::nullopt, bias);
    REQUIRE(fractional::isValid(k));
    if (!lo.empty()) REQUIRE(lo < k);
    if (hi) REQUIRE(k < *hi);
    keys.insert(keys.begin() + static_cast<long>(at), k);
  }
  size_t longest = 0;
  for (auto& k : keys) longest = std::max(longest, k.size());
  CHECK(longest <= 8);  // docs/schema.md measured ≤ 7 with its own random sequence
}

TEST_CASE("fractional: rebalanced keys are ordered and valid") {
  for (int n : {1, 2, 94, 95, 96, 1000, 9024}) {
    auto keys = fractional::rebalancedKeys(n);
    REQUIRE(keys.size() == static_cast<size_t>(n));
    CHECK(std::is_sorted(keys.begin(), keys.end()));
    CHECK(std::adjacent_find(keys.begin(), keys.end()) == keys.end());
    for (auto& k : keys) CHECK(fractional::isValid(k));
  }
}
