// Fonts for the text tests: the bundled Inter (src/renderer/src/engine/fonts),
// loaded into the module-wide registry once, the way TypeScript does it.
#pragma once

#include <cstdio>
#include <cstdlib>
#include <string>

#include "scene/Node.h"
#include "text/Fonts.h"

namespace eng::test {

inline int32_t addFontFile(const std::string& path) {
  FILE* f = std::fopen(path.c_str(), "rb");
  if (!f) return -1;
  std::fseek(f, 0, SEEK_END);
  long n = std::ftell(f);
  std::fseek(f, 0, SEEK_SET);
  auto* bytes = static_cast<uint8_t*>(std::malloc(static_cast<size_t>(n)));
  size_t read = std::fread(bytes, 1, static_cast<size_t>(n), f);
  std::fclose(f);
  return text::FontRegistry::get().addFace(bytes, read, 0);
}

// Inter's styles, as TS binds them (upright and italic files).
inline void loadInter() {
  static bool loaded = false;
  if (loaded) return;
  loaded = true;
  auto& fonts = text::FontRegistry::get();
  int32_t upright = addFontFile(std::string(ENG_FONTS_DIR) + "/InterVariable.ttf");
  int32_t italic = addFontFile(std::string(ENG_FONTS_DIR) + "/InterVariable-Italic.ttf");
  for (const char* s : {"Thin", "Extra Light", "Light", "Regular", "Medium", "Semi Bold", "Bold", "Extra Bold", "Black"}) {
    fonts.bind("Inter", s, upright);
    std::string it = std::string(s) == "Regular" ? "Italic" : std::string(s) + " Italic";
    fonts.bind("Inter", it, italic);
  }
  fonts.takeRequests();
}

inline NodeProps textProps(const std::string& characters, double fontSize = 12) {
  NodeProps p = defaultProps(NodeType::TEXT);
  p.textData.characters = characters;
  p.fontSize = fontSize;
  p.name = characters;
  return p;
}

}  // namespace eng::test
