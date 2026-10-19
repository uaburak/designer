#include "render/GradientRamp.h"

#include <algorithm>
#include <cmath>

namespace eng {

namespace {

double toLinear(double c) {
  double s = std::fabs(c);
  double v = s <= 0.04045 ? s / 12.92 : std::pow((s + 0.055) / 1.055, 2.4);
  return c < 0 ? -v : v;
}
double toGamma(double c) {
  double s = std::fabs(c);
  double v = s <= 0.0031308 ? s * 12.92 : 1.055 * std::pow(s, 1 / 2.4) - 0.055;
  return c < 0 ? -v : v;
}

// Hue in degrees, [0, 360); NaN: missing (powerless, CSS Color 4 §4.4).
void rgbToHsl(const double c[3], double out[3]) {
  double mx = std::max({c[0], c[1], c[2]}), mn = std::min({c[0], c[1], c[2]});
  double l = (mx + mn) / 2, d = mx - mn;
  double h = std::nan(""), s = 0;
  if (d > 1e-9) {
    s = (l == 0 || l == 1) ? 0 : (mx - l) / std::min(l, 1 - l);
    if (mx == c[0]) h = (c[1] - c[2]) / d + (c[1] < c[2] ? 6 : 0);
    else if (mx == c[1]) h = (c[2] - c[0]) / d + 2;
    else h = (c[0] - c[1]) / d + 4;
    h *= 60;
  }
  if (s <= 1e-9) h = std::nan("");
  out[0] = h, out[1] = s, out[2] = l;
}
void hslToRgb(const double hsl[3], double out[3]) {
  double h = std::isnan(hsl[0]) ? 0 : hsl[0], s = hsl[1], l = hsl[2];
  auto f = [&](double n) {
    double k = std::fmod(n + h / 30, 12);
    if (k < 0) k += 12;
    return l - s * std::min(l, 1 - l) * std::max(-1.0, std::min({k - 3, 9 - k, 1.0}));
  };
  out[0] = f(0), out[1] = f(8), out[2] = f(4);
}

// The two hues adjusted the chosen way round (CSS Color 4 §12.4); a missing one takes the other's.
void fixHues(double& h1, double& h2, InterpolationHueMethod method) {
  if (std::isnan(h1) && std::isnan(h2)) {
    h1 = h2 = 0;
    return;
  }
  if (std::isnan(h1)) h1 = h2;
  if (std::isnan(h2)) h2 = h1;
  double d = h2 - h1;
  switch (method) {
    case InterpolationHueMethod::SHORTER:
      if (d > 180) h1 += 360;
      else if (d < -180) h2 += 360;
      break;
    case InterpolationHueMethod::LONGER:
      if (d > 0 && d < 180) h1 += 360;
      else if (d > -180 && d <= 0) h2 += 360;
      break;
    case InterpolationHueMethod::INCREASING:
      if (h2 < h1) h2 += 360;
      break;
    case InterpolationHueMethod::DECREASING:
      if (h1 < h2) h1 += 360;
      break;
  }
}

}  // namespace

void srgbToOklab(const double rgb[3], double lab[3]) {
  double r = toLinear(rgb[0]), g = toLinear(rgb[1]), b = toLinear(rgb[2]);
  double l = std::cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  double m = std::cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  double s = std::cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  lab[0] = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
  lab[1] = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
  lab[2] = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
}

void oklabToSrgb(const double lab[3], double rgb[3]) {
  double l = lab[0] + 0.3963377774 * lab[1] + 0.2158037573 * lab[2];
  double m = lab[0] - 0.1055613458 * lab[1] - 0.0638541728 * lab[2];
  double s = lab[0] - 0.0894841775 * lab[1] - 1.2914855480 * lab[2];
  l = l * l * l, m = m * m * m, s = s * s * s;
  rgb[0] = toGamma(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s);
  rgb[1] = toGamma(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s);
  rgb[2] = toGamma(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s);
}

RampColor interpolateColor(const Color& ca, const Color& cb, double t, InterpolationColorSpace space, InterpolationHueMethod hue) {
  const double A = ca.a, B = cb.a;
  const double a[3] = {ca.r, ca.g, ca.b}, b[3] = {cb.r, cb.g, cb.b};
  RampColor out;
  out.a = A + (B - A) * t;
  double p[3] = {0, 0, 0}, q[3] = {0, 0, 0}, mix[3] = {0, 0, 0}, rgb[3] = {0, 0, 0};
  // Premultiplied blend of the components `on` (the non-hue ones), divided back by the blended alpha.
  auto blend = [&](const bool on[3]) {
    for (int i = 0; i < 3; i++) {
      if (!on[i]) continue;
      double v = (p[i] * A) + ((q[i] * B) - (p[i] * A)) * t;
      mix[i] = out.a > 1e-12 ? v / out.a : p[i] + (q[i] - p[i]) * t;
    }
  };
  static constexpr bool kAll[3] = {true, true, true};
  switch (space) {
    case InterpolationColorSpace::DEFAULT:
      for (int i = 0; i < 3; i++) p[i] = a[i], q[i] = b[i];
      blend(kAll);
      for (int i = 0; i < 3; i++) rgb[i] = mix[i];
      break;
    case InterpolationColorSpace::SRGB_LINEAR:
      for (int i = 0; i < 3; i++) p[i] = toLinear(a[i]), q[i] = toLinear(b[i]);
      blend(kAll);
      for (int i = 0; i < 3; i++) rgb[i] = toGamma(mix[i]);
      break;
    case InterpolationColorSpace::OKLAB:
      srgbToOklab(a, p);
      srgbToOklab(b, q);
      blend(kAll);
      oklabToSrgb(mix, rgb);
      break;
    case InterpolationColorSpace::OKLCH: {
      double la[3], lb[3];
      srgbToOklab(a, la);
      srgbToOklab(b, lb);
      // L, C, H; a chroma under 4e-6 (CSS's threshold for OKLCH) has no hue.
      auto lch = [](const double lab[3], double o[3]) {
        o[0] = lab[0];
        o[1] = std::hypot(lab[1], lab[2]);
        double h = std::atan2(lab[2], lab[1]) * 180 / M_PI;
        o[2] = o[1] < 4e-6 ? std::nan("") : (h < 0 ? h + 360 : h);
      };
      lch(la, p);
      lch(lb, q);
      fixHues(p[2], q[2], hue);
      static constexpr bool kLC[3] = {true, true, false};
      blend(kLC);
      mix[2] = p[2] + (q[2] - p[2]) * t;
      double lab[3] = {mix[0], mix[1] * std::cos(mix[2] * M_PI / 180), mix[1] * std::sin(mix[2] * M_PI / 180)};
      oklabToSrgb(lab, rgb);
      break;
    }
    case InterpolationColorSpace::HSL: {
      rgbToHsl(a, p);
      rgbToHsl(b, q);
      fixHues(p[0], q[0], hue);
      static constexpr bool kSL[3] = {false, true, true};
      blend(kSL);
      mix[0] = p[0] + (q[0] - p[0]) * t;
      hslToRgb(mix, rgb);
      break;
    }
  }
  out.r = rgb[0], out.g = rgb[1], out.b = rgb[2];
  return out;
}

void bakeGradientRamp(const std::vector<ColorStop>& stops0, InterpolationColorSpace space, InterpolationHueMethod hue, int width,
                      std::vector<uint8_t>& out) {
  std::vector<ColorStop> stops = stops0;
  std::stable_sort(stops.begin(), stops.end(), [](const ColorStop& a, const ColorStop& b) { return a.position < b.position; });
  auto byte = [](double v) { return static_cast<uint8_t>(std::clamp(v, 0.0, 1.0) * 255.0 + 0.5); };
  for (int i = 0; i < width; i++) {
    double t = i / double(width - 1);
    RampColor c;
    if (!stops.empty()) {
      size_t k = 0;
      while (k < stops.size() && stops[k].position < t) k++;
      const ColorStop& a = stops[k == 0 ? 0 : k - 1];
      const ColorStop& b = stops[k >= stops.size() ? stops.size() - 1 : k];
      double span = b.position - a.position;
      double f = span > 1e-9 ? std::clamp((t - a.position) / span, 0.0, 1.0) : 0;
      if (k == 0) f = 0;
      c = interpolateColor(a.color, b.color, f, space, hue);
    }
    // Out-of-gamut results clipped to the document's gamut, then premultiplied (the ramp texture's form).
    double al = std::clamp(c.a, 0.0, 1.0);
    out.push_back(byte(std::clamp(c.r, 0.0, 1.0) * al));
    out.push_back(byte(std::clamp(c.g, 0.0, 1.0) * al));
    out.push_back(byte(std::clamp(c.b, 0.0, 1.0) * al));
    out.push_back(byte(al));
  }
}

}  // namespace eng
