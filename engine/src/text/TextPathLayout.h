// Text on a path (TEXT_PATH, docs/draw.md §4.4): a TEXT_PATH node's characters shaped as one line (line breaks become
// spaces, no wrapping) and laid along its own path — its vectorData network at its size — from textPathStart:
//
//   - tValue = segment index + position on that segment (0–1, by arc length), in vectorNetworkBlob order [unverified
//     encoding]; the text runs along the segment's direction when `forward`, against it when not (Flip);
//   - alignment places the line's width W about the start s₀: LEFT / JUSTIFIED start there, CENTER centres on it,
//     RIGHT ends there;
//   - each glyph's centre sits at s₀ + x + advance/2 along the path, turned to the path's tangent there (Glyph.rotation,
//     radians clockwise); vertical alignment puts the baseline (BOTTOM), the middle (CENTER) or the ascent line (TOP)
//     on the path;
//   - an open path hides glyphs whose centre falls off either end; a closed one wraps once and hides what would pass
//     s₀ again. Hidden glyphs keep their characters. Decorations and links aren't drawn on a path.
//
// Derived, never stored (derivedTextData carries the result, glyph rotations included).
#pragma once

#include <memory>
#include <vector>

#include "geometry/VectorNetwork.h"
#include "math/Math.h"
#include "scene/Node.h"
#include "text/TextLayout.h"

namespace eng::text {

// The path a TEXT_PATH's text runs on, and how the shaped line's straight coordinates map onto it.
struct TextPathMap {
  std::vector<Vec2> pts;    // the contour the text runs on, node space (closed: its last point repeats the first)
  std::vector<double> at;   // arc length at each point
  bool closed = false;
  double s0 = 0;            // where the text starts (arc length on the contour)
  int dir = 1;              // +1: the text runs with the contour's own direction, −1: against it
  double lineX = 0;         // the straight x the line starts at (the layout's line x)
  double shift = 0;         // alignment: the distance along the path from s₀ to the line's start (≤ 0)
  double baseline = 0;      // the line's baseline in the straight layout
  double v = 0;             // the baseline's offset from the path along the text's up direction

  double length() const { return at.empty() ? 0 : at.back(); }
  // The arc length the straight x lands at (closed: wrapped onto the loop; open: may fall off either end).
  double arcAt(double x) const;
  // Whether straight x lands on the path (open: within its ends; closed: before the line comes round to s₀ again).
  bool onPath(double x) const;
  // The frame at straight x: its origin on the baseline there, its x along the text, its y down across it (node space).
  Mat2x3 frameAt(double x) const;
  // A straight layout point (x, y as TextLayout gives them) → node space.
  Vec2 toNode(Vec2 straight) const { return frameAt(straight.x).apply({0, straight.y - baseline}); }
  // The point and unit direction of the contour at arc length s (s clamped, or wrapped when closed).
  void sample(double s, Vec2& pos, Vec2& tangent) const;
};

// textPathStart (absent: segment 0 at 0, forward).
void textPathStartOf(const NodeProps& p, double& tValue, bool& forward);

// The network of a TEXT_PATH at its size as contours to walk, and where tValue lands: false without a usable path.
// `contour` gets the walk (closed or open, node space), `s` the arc length at tValue and `segmentDir` the segment's
// direction on that contour (+1 / −1).
bool textPathContour(const geom::VectorNetwork& net, const VectorData& data, Vec2 size, double tValue, std::vector<Vec2>& contour,
                     bool& closed, double& s, int& segmentDir);

// The tValue (segment + position) of the path point nearest `local` (node space): the start handle's drag
// (gesture TEXT_PATH_START) and the Text on path tool's click. False without a usable path.
bool textPathProject(const geom::VectorNetwork& net, const VectorData& data, Vec2 size, Vec2 local, double& tValue);

// Lays out a TEXT_PATH node on its network (nullptr network: an empty layout of its characters along nothing).
std::unique_ptr<TextLayout> layoutTextPath(const NodeProps& p, const geom::VectorNetwork* net);

}  // namespace eng::text
