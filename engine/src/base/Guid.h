// A node's id, as Figma's: {sessionID, localID}, written "s:l". Each editing
// session claims a sessionID and counts localIDs from 1, so ids never collide.
#pragma once

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <functional>
#include <string>
#include <string_view>

namespace eng {

struct Guid;
// Instance sublayers are derived rows (docs/schema.md §5.1): their ids live in this session and print as
// Figma's "I<instance>;<key>;…" (base/DerivedIds.h interns the paths).
inline constexpr uint32_t kDerivedSession = 0xFFFFFFFEu;
std::string derivedGuidString(uint32_t localID);
bool parseDerivedGuid(std::string_view s, Guid& out);

struct Guid {
  uint32_t sessionID = 0;
  uint32_t localID = 0;

  bool operator==(const Guid& o) const { return sessionID == o.sessionID && localID == o.localID; }
  bool operator!=(const Guid& o) const { return !(*this == o); }
  bool operator<(const Guid& o) const {
    return sessionID != o.sessionID ? sessionID < o.sessionID : localID < o.localID;
  }

  bool isDerived() const { return sessionID == kDerivedSession; }

  std::string toString() const {
    if (sessionID == kDerivedSession) return derivedGuidString(localID);
    return std::to_string(sessionID) + ":" + std::to_string(localID);
  }

  // "s:l" (or a derived "I…;…") → Guid; `ok` false for anything else.
  static Guid parse(std::string_view s, bool* ok = nullptr) {
    Guid g;
    if (!s.empty() && s[0] == 'I') {
      bool good = parseDerivedGuid(s, g);
      if (ok) *ok = good;
      return good ? g : Guid{};
    }
    size_t colon = s.find(':');
    bool good = colon != std::string_view::npos && colon > 0 && colon + 1 < s.size();
    for (size_t i = 0; good && i < s.size(); i++)
      if (i != colon && (s[i] < '0' || s[i] > '9')) good = false;
    if (good) {
      g.sessionID = static_cast<uint32_t>(std::strtoul(std::string(s.substr(0, colon)).c_str(), nullptr, 10));
      g.localID = static_cast<uint32_t>(std::strtoul(std::string(s.substr(colon + 1)).c_str(), nullptr, 10));
    }
    if (ok) *ok = good;
    return good ? g : Guid{};
  }
};

// The "no node" id. 0:0 is the DOCUMENT itself, so the null id is ~0:~0.
inline constexpr Guid kNoGuid{0xffffffffu, 0xffffffffu};

struct GuidHash {
  size_t operator()(const Guid& g) const noexcept {
    return std::hash<uint64_t>()((static_cast<uint64_t>(g.sessionID) << 32) | g.localID);
  }
};

}  // namespace eng
