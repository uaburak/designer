// KeyboardEvent.code as a number (docs/engine.md §10.3's keyCode). Interim:
// a hand-kept list until apigen generates it; the TS twin is
// src/renderer/src/engine/keyCodes.ts and a vitest checks the two agree.
#pragma once

#include <cstdint>
#include <string_view>

namespace eng {

// The order is the wire format: append only.
#define ENG_KEY_CODES(X)                                                                                         \
  X(Unidentified) X(KeyA) X(KeyB) X(KeyC) X(KeyD) X(KeyE) X(KeyF) X(KeyG) X(KeyH) X(KeyI) X(KeyJ) X(KeyK) X(KeyL) \
  X(KeyM) X(KeyN) X(KeyO) X(KeyP) X(KeyQ) X(KeyR) X(KeyS) X(KeyT) X(KeyU) X(KeyV) X(KeyW) X(KeyX) X(KeyY) X(KeyZ) \
  X(Digit0) X(Digit1) X(Digit2) X(Digit3) X(Digit4) X(Digit5) X(Digit6) X(Digit7) X(Digit8) X(Digit9)            \
  X(Space) X(Escape) X(Enter) X(NumpadEnter) X(Tab) X(Backspace) X(Delete)                                     \
  X(ArrowLeft) X(ArrowRight) X(ArrowUp) X(ArrowDown)                                                           \
  X(ShiftLeft) X(ShiftRight) X(AltLeft) X(AltRight) X(ControlLeft) X(ControlRight) X(MetaLeft) X(MetaRight)      \
  X(Equal) X(Minus) X(NumpadAdd) X(NumpadSubtract) X(Numpad0) X(Backslash) X(BracketLeft) X(BracketRight)        \
  X(Comma) X(Period) X(Slash) X(Semicolon) X(Quote) X(Backquote) X(Home) X(End) X(PageUp) X(PageDown)

enum class KeyCode : uint16_t {
#define ENG_KEY_ENUM(name) name,
  ENG_KEY_CODES(ENG_KEY_ENUM)
#undef ENG_KEY_ENUM
      Count
};

inline const char* keyCodeName(KeyCode k) {
  static constexpr const char* kNames[] = {
#define ENG_KEY_NAME(name) #name,
      ENG_KEY_CODES(ENG_KEY_NAME)
#undef ENG_KEY_NAME
  };
  auto i = static_cast<uint16_t>(k);
  return i < static_cast<uint16_t>(KeyCode::Count) ? kNames[i] : "Unidentified";
}

inline bool isModifierKey(KeyCode k) {
  return k == KeyCode::ShiftLeft || k == KeyCode::ShiftRight || k == KeyCode::AltLeft || k == KeyCode::AltRight ||
         k == KeyCode::ControlLeft || k == KeyCode::ControlRight || k == KeyCode::MetaLeft || k == KeyCode::MetaRight;
}

}  // namespace eng
