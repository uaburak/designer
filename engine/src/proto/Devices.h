// Prototype devices (docs/research/figma/R8-prototyping.md §1, §12): the presets the Prototype tab offers, each with
// its "Model" (the colour variants, help.figma.com 21158597546391: "the iPhone 15 Pro Max comes in four different
// colors"), and the device frame (bezel) the presentation view and the inline preview draw around the screen.
//
// Figma draws its device frames from SVG artwork (figma.com/blog/behind-the-feature-inline-device-frames); we draw
// them from rounded rectangles in the model's colour — body, glass, the camera (Dynamic Island, punch hole, notch),
// buttons, a laptop's base, a watch's crown. The preset list and the colour names are Apple's / Google's / Samsung's
// / Microsoft's published ones; Figma's own identifiers aren't published (unverified): ours are `<DEVICE>` or
// `<DEVICE>_<MODEL>` in prototypeDevice.presetIdentifier (no model: the first one).
#pragma once

#include <string>
#include <vector>

#include "math/Math.h"
#include "scene/Node.h"

namespace eng::proto {

enum class DeviceKind : uint8_t { PHONE_ISLAND, PHONE_HOME, ANDROID, TABLET, LAPTOP, DESKTOP, WATCH };

struct DeviceModel {
  const char* id;     // "BLACK_TITANIUM"
  const char* name;   // "Black Titanium"
  uint32_t color;     // the body's colour (RGB)
};

struct DeviceSpec {
  const char* id;      // "IPHONE_16_PRO"
  DeviceKind kind;
  double width, height;  // the screen in portrait (points)
  double screenRadius;   // the display's corner radius
  std::vector<DeviceModel> models;
};

const std::vector<DeviceSpec>& deviceSpecs();
// The preset and model of a presetIdentifier (`<DEVICE>` or `<DEVICE>_<MODEL>`); false when it names no preset.
bool findDevice(const std::string& presetIdentifier, const DeviceSpec*& spec, const DeviceModel*& model);

// A device frame drawn around a screen of `screen` units (landscape when `rotated`): rounded rectangles in screen
// units, the screen's top-left at (0, 0), in paint order; `over` ones are drawn over the screen (the camera).
struct DeviceShape {
  Rect rect;
  double radius = 0;
  Color color;
  double border = 0;
  Color borderColor;
  bool over = false;
};
struct DeviceFrame {
  double left = 0, top = 0, right = 0, bottom = 0;  // the frame's extent around the screen (units)
  double screenRadius = 0;
  std::vector<DeviceShape> shapes;
};
DeviceFrame deviceFrame(const DeviceSpec& spec, const DeviceModel& model, Vec2 screen, bool rotated);

}  // namespace eng::proto
