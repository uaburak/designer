// Text stagger (docs/motion.md §4.10; round 8h): a text preset's tracks played by the text's elements one after another
// — its laid-out glyphs grouped into characters (with or without the spaces), words, lines or paragraphs; element i
// plays the preset's tracks `rank(i) × step` later, its rank from the order (left to right, right to left, from the
// centre out, or shuffled by the node's GUID). Each element moves, turns and scales about its own box's centre and
// fades by its own opacity; the text node's own box doesn't move. The motion layer computes the poses
// (MotionLayer::apply); the renderer draws each glyph with its element's (TextRender.cpp).
//
// The behaviour is the preset instance's own `textElementDelayBehaviour` (610), written when its output is
// materialised: Figma's preset returns it with its tracks, so a text's other animations don't stagger [ours: Figma's
// storage place unverified]. `delayMs` is the step; the clip's tracks span one element's part of the clip:
// g = D / (1 + (m − 1)(1 − overlap)), step = g (1 − overlap), m the order's slots (probe 5.12: Figma's formula unseen).
#pragma once

#include <cstdint>
#include <unordered_map>
#include <vector>

#include "base/Guid.h"
#include "math/Math.h"

namespace eng::text {
struct TextLayout;
}

namespace eng::motion {

// schema TextElementGrouping / TextElementDelayOrder.
enum class Grouping : uint8_t { CHARACTER = 0, CHARACTER_NO_WHITESPACE = 1, WORD = 2, LINE = 3, PARAGRAPH = 4 };
enum class StaggerOrder : uint8_t { LEFT_RIGHT = 0, RIGHT_LEFT = 1, CENTER_OUT = 2, RANDOM = 3 };

struct Stagger {
  bool enabled = false;
  Grouping grouping = Grouping::CHARACTER;
  StaggerOrder order = StaggerOrder::LEFT_RIGHT;
  int64_t stepUs = 0;  // delayMs, in µs
};

// A text's elements: each glyph's element (−1: none — a space between words or lines), each element's box (node space:
// its glyphs' advances over their lines' heights).
struct TextElements {
  std::vector<int32_t> elementOf;
  std::vector<Rect> boxes;
};
TextElements groupElements(const text::TextLayout& L, Grouping g);

// Each element's rank in time (0 plays first): its order's slot. CENTER_OUT by distance from the middle (equal
// distances together), RANDOM a permutation seeded by the node's GUID.
std::vector<uint32_t> staggerRanks(size_t count, StaggerOrder order, Guid seed);
inline uint32_t slotsOf(const std::vector<uint32_t>& ranks) {
  uint32_t m = 0;
  for (uint32_t r : ranks) m = std::max(m, r + 1);
  return m;
}

// The clip's timing split among `slots` (above): one element's length and the step between them (µs).
void staggerTiming(int64_t clipUs, uint32_t slots, double overlap, int64_t& elementUs, int64_t& stepUs);

// What the renderer draws a staggered text with: each glyph's element, each element's transform (node space, applied
// before the glyph's own) and opacity, and where the elements reach (node space: its ink grows by it).
struct TextElementPoses {
  std::vector<int32_t> elementOf;
  std::vector<Mat2x3> transform;
  std::vector<float> alpha;
  Rect reach;
};
using TextElementMap = std::unordered_map<Guid, TextElementPoses, GuidHash>;

}  // namespace eng::motion
