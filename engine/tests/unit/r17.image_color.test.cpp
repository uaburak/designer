// Round 17: image colour at upload (docs/engine.md §6.6; docs/research/rea/canvas.md §2.6). A bitmap decoded the way
// Figma's image worker does it (straight alpha, no colour management, a profile tag) is premultiplied and converted
// into the canvas's space by the upload pass; prepPixel is that pass on the CPU (the shaders compute the same steps).
#include <array>
#include <cmath>
#include <cstdint>
#include <cstdlib>

#include "doctest.h"
#include "gfx/ImageColor.h"
#include "render/ImageCache.h"

using namespace eng;
using namespace eng::gfx;

namespace {

using Px = std::array<uint8_t, 4>;

// The browser's premultiply (createImageBitmap premultiplyAlpha "premultiply"): the old upload path's pixels.
Px browserPremultiplied(const Px& p) {
  auto m = [&](uint8_t c) { return static_cast<uint8_t>(std::lround(c * p[3] / 255.0)); };
  return {m(p[0]), m(p[1]), m(p[2]), p[3]};
}

bool near(const Px& a, const Px& b, int tolerance) {
  for (int i = 0; i < 4; i++)
    if (std::abs(a[i] - b[i]) > tolerance) return false;
  return true;
}

}  // namespace

TEST_CASE("image colour: flags — straight alpha and the profile tag") {
  CHECK_FALSE(bitmapColorOf(0).straight);
  CHECK(bitmapColorOf(0).profile == ColorProfile::SRGB);
  CHECK(bitmapColorOf(IMAGE_STRAIGHT).straight);
  CHECK(bitmapColorOf(IMAGE_STRAIGHT | IMAGE_DISPLAY_P3).profile == ColorProfile::DISPLAY_P3);
}

TEST_CASE("image colour: the same space — premultiplying at upload gives the old path's pixels") {
  // Opaque: unchanged, every value.
  for (int v = 0; v < 256; v += 5) {
    Px p{static_cast<uint8_t>(v), static_cast<uint8_t>(255 - v), static_cast<uint8_t>(v / 2), 255};
    CHECK(prepPixel(p, ColorProfile::SRGB, ColorProfile::SRGB) == p);
    CHECK(prepPixel(p, ColorProfile::DISPLAY_P3, ColorProfile::DISPLAY_P3) == p);
  }
  // Translucent: the browser's premultiply, rounded the same way.
  for (int a : {0, 1, 3, 64, 128, 200, 254}) {
    Px p{200, 100, 50, static_cast<uint8_t>(a)};
    CHECK(prepPixel(p, ColorProfile::SRGB, ColorProfile::SRGB) == browserPremultiplied(p));
  }
}

TEST_CASE("image colour: sRGB into a Display P3 canvas and back") {
  // sRGB red is (0.9175, 0.2003, 0.1386) in Display P3 (CSS Color 4).
  CHECK(near(prepPixel({255, 0, 0, 255}, ColorProfile::SRGB, ColorProfile::DISPLAY_P3), {234, 51, 35, 255}, 1));
  // White and greys stay (both spaces are D65 with the sRGB curve).
  CHECK(near(prepPixel({255, 255, 255, 255}, ColorProfile::SRGB, ColorProfile::DISPLAY_P3), {255, 255, 255, 255}, 0));
  CHECK(near(prepPixel({128, 128, 128, 255}, ColorProfile::DISPLAY_P3, ColorProfile::SRGB), {128, 128, 128, 255}, 1));
  // Display P3's own red is outside sRGB: clipped to sRGB red.
  CHECK(prepPixel({255, 0, 0, 255}, ColorProfile::DISPLAY_P3, ColorProfile::SRGB) == Px{255, 0, 0, 255});
  // Converted, then premultiplied (half alpha halves the converted colour).
  Px half = prepPixel({255, 0, 0, 128}, ColorProfile::SRGB, ColorProfile::DISPLAY_P3);
  CHECK(near(half, {118, 26, 18, 128}, 1));
  // An sRGB colour survives the trip there and back.
  for (Px p : {Px{30, 144, 255, 255}, Px{250, 128, 114, 255}, Px{46, 139, 87, 255}}) {
    Px p3 = prepPixel(p, ColorProfile::SRGB, ColorProfile::DISPLAY_P3);
    CHECK(near(prepPixel(p3, ColorProfile::DISPLAY_P3, ColorProfile::SRGB), p, 1));
  }
}

TEST_CASE("image colour: the pass's uniforms are the matrix rows and the convert switch") {
  float rows[4][4];
  prepUniforms(ColorProfile::SRGB, ColorProfile::SRGB, rows);
  CHECK(rows[3][0] == 0);
  CHECK(rows[0][0] == 1);
  prepUniforms(ColorProfile::DISPLAY_P3, ColorProfile::SRGB, rows);
  CHECK(rows[3][0] == 1);
  CHECK(rows[0][0] == doctest::Approx(1.2249401));
  CHECK(rows[2][1] == doctest::Approx(-0.0786361));
  // Each row of a conversion sums to 1: white stays white.
  for (int i = 0; i < 3; i++) CHECK(rows[i][0] + rows[i][1] + rows[i][2] == doctest::Approx(1).epsilon(1e-5));
}

TEST_CASE("image colour: the registry keeps a bitmap's flags for its uploads") {
  ImageRegistry::get().clear();
  const ImageHash A = ImageHash::fromHex("abababababababababababababababababababab");
  ImageRegistry::get().addBitmap(A, 7, 4, 4, IMAGE_STRAIGHT | IMAGE_DISPLAY_P3);
  const ImageRegistry::Source* s = ImageRegistry::get().find(A);
  REQUIRE(s);
  CHECK(s->bitmapId == 7);
  CHECK(bitmapColorOf(s->color).straight);
  CHECK(bitmapColorOf(s->color).profile == ColorProfile::DISPLAY_P3);
  ImageRegistry::get().addBitmap(A, 8, 8, 8);  // a larger copy, decoded by the browser
  CHECK(ImageRegistry::get().find(A)->color == 0);
  ImageRegistry::get().clear();
}
