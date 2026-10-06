// Fractional indexing, Figma's format and docs/schema.md §10's reference
// algorithm: a sibling's position is a fraction in (0, 1) written in base 95
// over printable ASCII (' ' = digit 0 … '~' = digit 94), leading "0." left off,
// never ending in digit 0. Children sort ascending (back to front). The TS
// twin must produce identical keys: both are checked against
// engine/tests/data/fractional-index-vectors.txt.
#pragma once

#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace eng::fractional {

inline constexpr char kMinDigit = ' ';
inline constexpr char kMaxDigit = '~';
inline constexpr int kBase = 95;
// Longer keys trigger a rebalance of the sibling list (docs/schema.md §10.3).
inline constexpr size_t kMaxKeyLength = 24;

enum class Bias : unsigned char { Low, Mid, High };

bool isValid(std::string_view key);

// The shortest key k with lo < k < hi. lo = "" means 0; hi = nullopt means 1.
// Bias: append after the last sibling with Low, prepend with High, between two
// with Mid; the first child of an empty parent is keyBetween("", nullopt, Low) = "!".
// Returns "" when lo >= hi (the reference throws).
std::string keyBetween(std::string_view lo, std::optional<std::string_view> hi, Bias bias = Bias::Mid);

// n keys strictly between lo and hi, ascending.
std::vector<std::string> keysBetween(std::string_view lo, std::optional<std::string_view> hi, int n);

// Evenly spaced keys for n siblings (rebalancing).
std::vector<std::string> rebalancedKeys(int n);

}  // namespace eng::fractional
