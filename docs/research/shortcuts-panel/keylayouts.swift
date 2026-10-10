// Prints, for macOS keyboard layouts (input source ids as arguments), the character every character key types on
// this Mac's keyboard type: alone, with ⇧ and with ⌘ — by KeyboardEvent.code (Chromium's names; on an ISO keyboard
// macOS reports the key left of 1 as kVK_ISO_Section and the one right of the left ⇧ as kVK_ANSI_Grave, and Chromium
// swaps them back: Backquote and IntlBackslash). A dead key prints the character it makes followed by a space.
//
// The Keyboard shortcuts panel's Turkish layouts (src/renderer/src/editor/shortcuts/layouts.ts) are its output on
// the owner's Turkish MacBook (keyboard type 92, ISO), 2026-10-10:
//   swift keylayouts.swift com.apple.keylayout.Turkish-QWERTY-PC com.apple.keylayout.Turkish-Standard \
//     com.apple.keylayout.British > keylayouts-tr.json
// ("Turkish Q" and "Turkish F" in System Settings; British as a check: § left of 1, ` right of ⇧, as printed on a
// U.K. MacBook.)
import Carbon
import Foundation

let codes: [(UInt16, String)] = [
  (0x32, "Backquote"), (0x12, "Digit1"), (0x13, "Digit2"), (0x14, "Digit3"), (0x15, "Digit4"), (0x17, "Digit5"),
  (0x16, "Digit6"), (0x1A, "Digit7"), (0x1C, "Digit8"), (0x19, "Digit9"), (0x1D, "Digit0"), (0x1B, "Minus"), (0x18, "Equal"),
  (0x0C, "KeyQ"), (0x0D, "KeyW"), (0x0E, "KeyE"), (0x0F, "KeyR"), (0x11, "KeyT"), (0x10, "KeyY"), (0x20, "KeyU"),
  (0x22, "KeyI"), (0x1F, "KeyO"), (0x23, "KeyP"), (0x21, "BracketLeft"), (0x1E, "BracketRight"), (0x2A, "Backslash"),
  (0x00, "KeyA"), (0x01, "KeyS"), (0x02, "KeyD"), (0x03, "KeyF"), (0x05, "KeyG"), (0x04, "KeyH"), (0x26, "KeyJ"),
  (0x28, "KeyK"), (0x25, "KeyL"), (0x29, "Semicolon"), (0x27, "Quote"),
  (0x0A, "IntlBackslash"), (0x06, "KeyZ"), (0x07, "KeyX"), (0x08, "KeyC"), (0x09, "KeyV"), (0x0B, "KeyB"), (0x2D, "KeyN"),
  (0x2E, "KeyM"), (0x2B, "Comma"), (0x2F, "Period"), (0x2C, "Slash"),
]

let kbdType = UInt32(LMGetKbdType())
let iso = KBGetLayoutType(Int16(kbdType)) == UInt32(kKeyboardISO)

func source(_ id: String) -> TISInputSource? {
  let filter = [kTISPropertyInputSourceID as String: id] as CFDictionary
  return (TISCreateInputSourceList(filter, true).takeRetainedValue() as! [TISInputSource]).first
}

func type(_ layout: UnsafePointer<UCKeyboardLayout>, _ key: UInt16, _ mods: Int) -> String {
  var dead: UInt32 = 0
  var chars = [UniChar](repeating: 0, count: 8)
  var len = 0
  let modState = UInt32((mods >> 8) & 0xFF)
  UCKeyTranslate(layout, key, UInt16(kUCKeyActionDown), modState, kbdType, OptionBits(kUCKeyTranslateNoDeadKeysBit), &dead, 8, &len, &chars)
  if len == 0 && dead != 0 {
    // A dead key: the character it makes on its own (followed by a space).
    UCKeyTranslate(layout, 0x31, UInt16(kUCKeyActionDown), 0, kbdType, 0, &dead, 8, &len, &chars)
  }
  return String(utf16CodeUnits: chars, count: len)
}

func quoted(_ s: String) -> String {
  let data = try! JSONSerialization.data(withJSONObject: [s], options: [.fragmentsAllowed, .withoutEscapingSlashes])
  return String(String(data: data, encoding: .utf8)!.dropFirst().dropLast())
}

// One key per line: "code": [alone, ⇧, ⌘].
var layouts: [String] = []
for id in CommandLine.arguments.dropFirst() {
  guard let src = source(id), let ptr = TISGetInputSourceProperty(src, kTISPropertyUnicodeKeyLayoutData) else {
    layouts.append("  \(quoted(id)): null")
    continue
  }
  let data = Unmanaged<CFData>.fromOpaque(ptr).takeUnretainedValue() as Data
  var lines: [String] = []
  data.withUnsafeBytes { raw in
    let layout = raw.baseAddress!.assumingMemoryBound(to: UCKeyboardLayout.self)
    for (vk, code) in codes {
      // On ISO keyboards the OS reports the key left of 1 as kVK_ISO_Section and the one by ⇧ as kVK_ANSI_Grave.
      let key: UInt16 = iso ? (vk == 0x32 ? 0x0A : vk == 0x0A ? 0x32 : vk) : vk
      let chars = [type(layout, key, 0), type(layout, key, shiftKey), type(layout, key, cmdKey)].map(quoted).joined(separator: ", ")
      lines.append("    \(quoted(code)): [\(chars)]")
    }
  }
  layouts.append("  \(quoted(id)): {\n\(lines.joined(separator: ",\n"))\n  }")
}
print("{\n  \"kbdType\": \(kbdType),\n  \"iso\": \(iso),\n\(layouts.joined(separator: ",\n"))\n}")
