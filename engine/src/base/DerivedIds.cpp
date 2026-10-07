#include "base/DerivedIds.h"

#include <unordered_map>

namespace eng {

namespace {

struct Entry {
  Guid instance;
  std::vector<Guid> keys;
  std::string text;
};

struct PairHash {
  size_t operator()(const std::pair<uint64_t, uint64_t>& p) const noexcept {
    return std::hash<uint64_t>()(p.first * 0x9E3779B97F4A7C15ull ^ p.second);
  }
};

struct Registry {
  std::vector<Entry> entries;  // localID - 1
  std::unordered_map<std::string, uint32_t> byText;
  std::unordered_map<std::pair<uint64_t, uint64_t>, uint32_t, PairHash> byChild;
};

Registry& registry() {
  static Registry* r = new Registry();
  return *r;
}

uint64_t pack(Guid g) { return (static_cast<uint64_t>(g.sessionID) << 32) | g.localID; }

std::string textOf(Guid instance, const std::vector<Guid>& keys) {
  std::string s = "I" + std::to_string(instance.sessionID) + ":" + std::to_string(instance.localID);
  for (Guid k : keys) s += ";" + std::to_string(k.sessionID) + ":" + std::to_string(k.localID);
  return s;
}

Guid internText(Guid instance, std::vector<Guid> keys, std::string text) {
  Registry& r = registry();
  auto it = r.byText.find(text);
  if (it != r.byText.end()) return {kDerivedSession, it->second};
  r.entries.push_back({instance, std::move(keys), text});
  uint32_t id = static_cast<uint32_t>(r.entries.size());
  r.byText.emplace(std::move(text), id);
  return {kDerivedSession, id};
}

}  // namespace

std::string derivedGuidString(uint32_t localID) {
  Registry& r = registry();
  if (localID == 0 || localID > r.entries.size()) return "I?";
  return r.entries[localID - 1].text;
}

bool parseDerivedGuid(std::string_view s, Guid& out) {
  if (s.size() < 2 || s[0] != 'I') return false;
  std::vector<Guid> parts;
  size_t start = 1;
  while (start <= s.size()) {
    size_t end = s.find(';', start);
    if (end == std::string_view::npos) end = s.size();
    bool ok = false;
    Guid g = Guid::parse(s.substr(start, end - start), &ok);
    if (!ok || g.isDerived()) return false;
    parts.push_back(g);
    start = end + 1;
  }
  if (parts.size() < 2) return false;
  Guid instance = parts[0];
  parts.erase(parts.begin());
  out = derived::intern(instance, parts);
  return true;
}

namespace derived {

Guid intern(Guid instance, const std::vector<Guid>& keys) {
  if (keys.empty()) return instance;
  return internText(instance, keys, textOf(instance, keys));
}

Guid child(Guid parent, Guid key) {
  Registry& r = registry();
  auto ck = std::make_pair(pack(parent), pack(key));
  auto it = r.byChild.find(ck);
  if (it != r.byChild.end()) return {kDerivedSession, it->second};
  Guid instance = parent;
  std::vector<Guid> keys;
  if (parent.isDerived()) {
    if (parent.localID == 0 || parent.localID > r.entries.size()) return kNoGuid;
    const Entry& e = r.entries[parent.localID - 1];
    instance = e.instance;
    keys = e.keys;
  }
  keys.push_back(key);
  Guid id = intern(instance, keys);
  r.byChild.emplace(ck, id.localID);
  return id;
}

bool path(Guid id, Guid& instance, std::vector<Guid>& keys) {
  if (!id.isDerived()) return false;
  Registry& r = registry();
  if (id.localID == 0 || id.localID > r.entries.size()) return false;
  instance = r.entries[id.localID - 1].instance;
  keys = r.entries[id.localID - 1].keys;
  return true;
}

Guid instanceOf(Guid id) {
  if (!id.isDerived()) return id;
  Registry& r = registry();
  if (id.localID == 0 || id.localID > r.entries.size()) return kNoGuid;
  return r.entries[id.localID - 1].instance;
}

}  // namespace derived

}  // namespace eng
