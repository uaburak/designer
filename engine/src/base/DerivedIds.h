// The ids of derived rows (instance sublayers, docs/engine.md §2.5): each path
// [instance GUID, key₁, …] is interned once per process and gets a Guid in
// kDerivedSession, so the id of a sublayer is the same however often it is
// re-derived, and in every document that has that instance. Printed as Figma's
// "I12:34;5:6;7:8".
#pragma once

#include <string>
#include <vector>

#include "base/Guid.h"

namespace eng::derived {

// The id of `parent`'s sublayer with `key` (parent: a real instance or a derived node).
Guid child(Guid parent, Guid key);
// The id of [instance, keys…] (keys non-empty; empty keys = the instance itself).
Guid intern(Guid instance, const std::vector<Guid>& keys);
// A derived id's instance and keys (false for real ids and unknown derived ones).
bool path(Guid id, Guid& instance, std::vector<Guid>& keys);
// The top-level real instance a derived id belongs to (the id itself when real).
Guid instanceOf(Guid id);

}  // namespace eng::derived
