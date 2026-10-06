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

struct Guid {
  uint32_t sessionID = 0;
  uint32_t localID = 0;

  bool operator==(const Guid& o) const { return sessionID == o.sessionID && localID == o.localID; }
  bool operator!=(const Guid& o) const { return !(*this == o); }
  bool operator<(const Guid& o) const {
    return sessionID != o.sessionID ? sessionID < o.sessionID : localID < o.localID;
  }

  std::string toString() const { return std::to_string(sessionID) + ":" + std::to_string(localID); }

  // "s:l" → Guid; `ok` false for anything else.
  static Guid parse(std::string_view s, bool* ok = nullptr) {
    Guid g;
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
