// The one translation unit that holds the kiwi runtime and the generated schema
// codecs' implementations (docs/schema.md §2.2): kiwi.h (third_party/kiwi),
// and schemagen's document.kiwi.h (the tree codec, namespace schema),
// document.stream.h (the visitor codec, namespace schema_stream) and
// node_fields.h (the NodeChange field registry), generated into
// <build>/generated/schema by cmake/Generators.cmake. Native tests only: the
// engine reads and writes kiwi through scene/CodecKiwi (which needs only the
// runtime; the wasm build gets that from KiwiRuntime.cpp). The runtime's
// templates are defined inside kiwi.h's implementation block, so the generated
// codecs must be compiled in the TU that implements it.
#define IMPLEMENT_KIWI_H
#define IMPLEMENT_SCHEMA_H
#include "kiwi.h"
// node_fields.h includes document.kiwi.h, whose implementation block isn't
// include-guarded: it must be included exactly once here, through node_fields.h.
#include "schema/node_fields.h"
#include "schema/document.stream.h"
