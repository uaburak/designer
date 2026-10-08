#include "proto/Devices.h"

#include <algorithm>

namespace eng::proto {

namespace {

// Colours: the makers' finishes, approximated.
const std::vector<DeviceModel> kIphone16{
    {"BLACK", "Black", 0x3C3C3E}, {"WHITE", "White", 0xF2F2EF}, {"PINK", "Pink", 0xF2C9D4}, {"TEAL", "Teal", 0xA9CFCB},
    {"ULTRAMARINE", "Ultramarine", 0x8D9BE0}};
const std::vector<DeviceModel> kIphone16Pro{
    {"BLACK_TITANIUM", "Black Titanium", 0x3B3B3C}, {"WHITE_TITANIUM", "White Titanium", 0xE8E6E1},
    {"NATURAL_TITANIUM", "Natural Titanium", 0xB9B4A9}, {"DESERT_TITANIUM", "Desert Titanium", 0xC4A98E}};
const std::vector<DeviceModel> kIphone15{
    {"BLACK", "Black", 0x40444A}, {"BLUE", "Blue", 0xD4E1E9}, {"GREEN", "Green", 0xD8E4D2}, {"YELLOW", "Yellow", 0xF4E8C5},
    {"PINK", "Pink", 0xF1DCDF}};
const std::vector<DeviceModel> kIphone15Pro{
    {"BLACK_TITANIUM", "Black Titanium", 0x3C3B39}, {"WHITE_TITANIUM", "White Titanium", 0xE4E3DF},
    {"BLUE_TITANIUM", "Blue Titanium", 0x3F4756}, {"NATURAL_TITANIUM", "Natural Titanium", 0xBAB4A9}};
const std::vector<DeviceModel> kIphoneSE{{"MIDNIGHT", "Midnight", 0x2E3239}, {"STARLIGHT", "Starlight", 0xF0EBE3}, {"PRODUCT_RED", "(PRODUCT)RED", 0xBA0C2F}};
const std::vector<DeviceModel> kPixel8{{"OBSIDIAN", "Obsidian", 0x2F3133}, {"HAZEL", "Hazel", 0x9EA59A}, {"ROSE", "Rose", 0xF0D5CC}, {"MINT", "Mint", 0xCDE8D6}};
const std::vector<DeviceModel> kGalaxyS24{
    {"ONYX_BLACK", "Onyx Black", 0x2B2B2D}, {"MARBLE_GREY", "Marble Grey", 0xC9C8C6}, {"COBALT_VIOLET", "Cobalt Violet", 0x6B5D8F},
    {"AMBER_YELLOW", "Amber Yellow", 0xE9D59B}};
const std::vector<DeviceModel> kAndroid{{"BLACK", "Black", 0x2C2C2E}};
const std::vector<DeviceModel> kIpadMini{{"SPACE_GRAY", "Space Gray", 0x5F6064}, {"BLUE", "Blue", 0x9DB0C8}, {"PURPLE", "Purple", 0xC8BFD9}, {"STARLIGHT", "Starlight", 0xE8E2D7}};
const std::vector<DeviceModel> kIpadPro{{"SPACE_BLACK", "Space Black", 0x3A3A3C}, {"SILVER", "Silver", 0xE3E4E5}};
const std::vector<DeviceModel> kSurface{{"PLATINUM", "Platinum", 0xD7D7D5}, {"GRAPHITE", "Graphite", 0x4A4A4C}};
const std::vector<DeviceModel> kMacbookAir{{"MIDNIGHT", "Midnight", 0x2E3642}, {"STARLIGHT", "Starlight", 0xE3DCCF}, {"SPACE_GRAY", "Space Gray", 0x7D7E80}, {"SILVER", "Silver", 0xE3E4E5}};
const std::vector<DeviceModel> kMacbookPro{{"SPACE_BLACK", "Space Black", 0x2E2E30}, {"SILVER", "Silver", 0xE3E4E5}};
const std::vector<DeviceModel> kDesktop{{"BLACK", "Black", 0x1C1C1E}};
const std::vector<DeviceModel> kWatch{{"JET_BLACK", "Jet Black", 0x1F1F21}, {"ROSE_GOLD", "Rose Gold", 0xE6C3B3}, {"SILVER", "Silver", 0xDADBDD}};

Rect rotateRect(const Rect& r, double portraitWidth) {
  // Landscape (CCW 90°): the device's top goes left, its right side up — (x, y) → (y, w − x).
  return {r.y, portraitWidth - r.x - r.w, r.h, r.w};
}

}  // namespace

const std::vector<DeviceSpec>& deviceSpecs() {
  static const std::vector<DeviceSpec> specs{
      {"IPHONE_16", DeviceKind::PHONE_ISLAND, 393, 852, 55, kIphone16},
      {"IPHONE_16_PLUS", DeviceKind::PHONE_ISLAND, 430, 932, 55, kIphone16},
      {"IPHONE_16_PRO", DeviceKind::PHONE_ISLAND, 402, 874, 62, kIphone16Pro},
      {"IPHONE_16_PRO_MAX", DeviceKind::PHONE_ISLAND, 440, 956, 62, kIphone16Pro},
      {"IPHONE_15", DeviceKind::PHONE_ISLAND, 393, 852, 55, kIphone15},
      {"IPHONE_15_PRO", DeviceKind::PHONE_ISLAND, 393, 852, 55, kIphone15Pro},
      {"IPHONE_15_PRO_MAX", DeviceKind::PHONE_ISLAND, 430, 932, 55, kIphone15Pro},
      {"IPHONE_SE", DeviceKind::PHONE_HOME, 375, 667, 0, kIphoneSE},
      {"ANDROID_COMPACT", DeviceKind::ANDROID, 412, 917, 34, kAndroid},
      {"ANDROID_MEDIUM", DeviceKind::ANDROID, 700, 840, 24, kAndroid},
      {"GOOGLE_PIXEL_8", DeviceKind::ANDROID, 412, 915, 40, kPixel8},
      {"SAMSUNG_GALAXY_S24", DeviceKind::ANDROID, 384, 832, 36, kGalaxyS24},
      {"IPAD_MINI", DeviceKind::TABLET, 744, 1133, 22, kIpadMini},
      {"IPAD_PRO_11", DeviceKind::TABLET, 834, 1194, 18, kIpadPro},
      {"IPAD_PRO_13", DeviceKind::TABLET, 1024, 1366, 18, kIpadPro},
      {"SURFACE_PRO_8", DeviceKind::TABLET, 1440, 960, 8, kSurface},
      {"MACBOOK_AIR", DeviceKind::LAPTOP, 1280, 832, 10, kMacbookAir},
      {"MACBOOK_PRO_14", DeviceKind::LAPTOP, 1512, 982, 10, kMacbookPro},
      {"MACBOOK_PRO_16", DeviceKind::LAPTOP, 1728, 1117, 10, kMacbookPro},
      {"DESKTOP", DeviceKind::DESKTOP, 1440, 1024, 0, kDesktop},
      {"APPLE_WATCH", DeviceKind::WATCH, 208, 248, 46, kWatch},
  };
  return specs;
}

bool findDevice(const std::string& id, const DeviceSpec*& spec, const DeviceModel*& model) {
  spec = nullptr;
  model = nullptr;
  size_t best = 0;
  for (const DeviceSpec& s : deviceSpecs()) {
    std::string sid = s.id;
    if (id.size() < sid.size() || id.compare(0, sid.size(), sid) != 0) continue;
    if (id.size() > sid.size() && id[sid.size()] != '_') continue;
    if (sid.size() > best) {
      best = sid.size();
      spec = &s;
    }
  }
  if (!spec) return false;
  std::string rest = id.size() > best ? id.substr(best + 1) : std::string();
  for (const DeviceModel& m : spec->models)
    if (rest == m.id) model = &m;
  if (!model) {
    // A suffix that is no model of the device: an identifier we don't know (it would have matched a longer device).
    if (!rest.empty()) {
      bool longer = false;
      for (const DeviceSpec& s : deviceSpecs()) longer |= std::string(s.id).size() > best && id.compare(0, std::string(s.id).size(), s.id) == 0;
      if (longer) return false;
    }
    model = &spec->models.front();
  }
  return true;
}

DeviceFrame deviceFrame(const DeviceSpec& spec, const DeviceModel& model, Vec2 screen, bool rotated) {
  // Drawn in portrait (the screen w × h at the origin), then turned for landscape.
  double w = rotated ? screen.y : screen.x, h = rotated ? screen.x : screen.y;
  Color body = Color::hex(model.color);
  Color glass = Color::hex(0x050506);
  Color edge = Color::hex(0x000000, 0.25f);
  DeviceFrame f;
  f.screenRadius = spec.screenRadius;
  auto add = [&](Rect r, double radius, Color c, bool over = false, double border = 0, Color bc = {}) {
    DeviceShape s;
    s.rect = r;
    s.radius = std::max(0.0, radius);
    s.color = c;
    s.over = over;
    s.border = border;
    s.borderColor = bc;
    f.shapes.push_back(s);
  };
  double l = 0, t = 0, r = 0, b = 0;
  switch (spec.kind) {
    case DeviceKind::PHONE_ISLAND:
    case DeviceKind::ANDROID: {
      double bezel = spec.kind == DeviceKind::PHONE_ISLAND ? 14 : 12, band = 4;
      l = t = r = b = bezel + band;
      double R = spec.screenRadius + bezel + band;
      // Buttons first (behind the body): action + volume left, power right (iPhone); volume + power right (Android).
      if (spec.kind == DeviceKind::PHONE_ISLAND) {
        add({-l - 3, h * 0.17, 5, 30}, 2, body);
        add({-l - 3, h * 0.25, 5, 58}, 2, body);
        add({-l - 3, h * 0.33, 5, 58}, 2, body);
        add({w + r - 2, h * 0.27, 5, 92}, 2, body);
      } else {
        add({w + r - 2, h * 0.2, 5, 64}, 2, body);
        add({w + r - 2, h * 0.32, 5, 110}, 2, body);
      }
      add({-l, -t, w + l + r, h + t + b}, R, body, false, 1, edge);
      add({-bezel, -bezel, w + 2 * bezel, h + 2 * bezel}, spec.screenRadius + bezel, glass);
      if (spec.kind == DeviceKind::PHONE_ISLAND) add({(w - 125) / 2, 11, 125, 37}, 18.5, glass, true);
      else add({(w - 22) / 2, 12, 22, 22}, 11, glass, true);
      break;
    }
    case DeviceKind::PHONE_HOME: {
      double side = 22, top = 110, band = 4;
      l = r = side + band;
      t = b = top + band;
      add({-l - 3, h * 0.08 - t, 5, 30}, 2, body);
      add({-l - 3, h * 0.16 - t, 5, 52}, 2, body);
      add({-l - 3, h * 0.25 - t, 5, 52}, 2, body);
      add({w + r - 2, h * 0.1 - t, 5, 58}, 2, body);
      add({-l, -t, w + l + r, h + t + b}, 60, body, false, 1, edge);
      add({-side, -top, w + 2 * side, h + 2 * top}, 56, glass);
      add({(w - 56) / 2, -top / 2 - 3, 56, 6}, 3, Color::hex(0x2A2A2C));
      add({(w - 64) / 2, h + (top - 64) / 2, 64, 64}, 32, glass, false, 2, Color::hex(0x3A3A3C));
      break;
    }
    case DeviceKind::TABLET: {
      double bezel = spec.width > 1200 ? 34 : 24, band = 4;
      l = t = r = b = bezel + band;
      add({-l, -t, w + l + r, h + t + b}, spec.screenRadius + bezel + band, body, false, 1, edge);
      add({-bezel, -bezel, w + 2 * bezel, h + 2 * bezel}, spec.screenRadius + bezel, glass);
      add({(w - 8) / 2, -bezel / 2 - 4, 8, 8}, 4, Color::hex(0x1C1C1E));
      break;
    }
    case DeviceKind::LAPTOP: {
      double side = 18, top = 22, chin = 26, band = 3;
      l = r = side + band;
      t = top + band;
      double baseH = std::round(w * 0.022), baseOver = w * 0.07;
      b = chin + band + baseH;
      double lidB = h + chin + band;
      add({-l, -t, w + l + r, lidB + t}, 18, body, false, 1, edge);
      add({-side, -top, w + 2 * side, h + top + chin}, 14, glass);
      // The notch, the base and its finger groove.
      add({(w - w * 0.13) / 2, -1, w * 0.13, 22}, 8, glass, true);
      add({-l - baseOver, lidB, w + l + r + 2 * baseOver, baseH}, baseH / 2, body, false, 1, edge);
      add({(w - w * 0.16) / 2, lidB, w * 0.16, baseH * 0.45}, baseH * 0.2, Color::hex(0x000000, 0.18f));
      l += baseOver;
      r += baseOver;
      break;
    }
    case DeviceKind::DESKTOP: {
      double bezel = 18, chin = 64;
      l = r = t = bezel;
      double neckH = h * 0.14, footH = 14;
      b = chin + neckH + footH;
      add({(w - w * 0.16) / 2, h + chin - 2, w * 0.16, neckH + 2}, 4, Color::hex(0xB8B9BB));
      add({(w - w * 0.3) / 2, h + chin + neckH, w * 0.3, footH}, 7, Color::hex(0xC8C9CB));
      add({-l, -t, w + l + r, h + t + chin}, 14, body, false, 1, edge);
      add({0, 0, w, h}, 0, glass);
      break;
    }
    case DeviceKind::WATCH: {
      double bezel = 14, band = 6;
      l = t = b = bezel + band;
      r = bezel + band + 10;  // the crown sticks out
      add({w + bezel + band - 4, h * 0.2, 14, 46}, 6, body);
      add({w + bezel + band - 3, h * 0.55, 6, 64}, 3, body);
      add({-bezel - band, -bezel - band, w + 2 * (bezel + band), h + 2 * (bezel + band)}, spec.screenRadius + bezel + band, body, false, 1, edge);
      add({-bezel, -bezel, w + 2 * bezel, h + 2 * bezel}, spec.screenRadius + bezel, glass);
      break;
    }
  }
  if (rotated) {
    for (auto& s : f.shapes) s.rect = rotateRect(s.rect, w);
    // Portrait left / top / right / bottom → landscape bottom / left / top / right.
    f.left = t;
    f.top = r;
    f.right = b;
    f.bottom = l;
  } else {
    f.left = l;
    f.top = t;
    f.right = r;
    f.bottom = b;
  }
  return f;
}

}  // namespace eng::proto
