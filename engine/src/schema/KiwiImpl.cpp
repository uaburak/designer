// The one translation unit that holds the kiwi runtime and the generated
// schema codecs' implementations (docs/schema.md §2.2): kiwi.h
// (third_party/kiwi), and schemagen's document.kiwi.h (the tree codec,
// namespace schema), document.stream.h (the visitor codec, namespace
// schema_stream) and node_fields.h (the NodeChange field registry), generated
// into <build>/generated/schema by cmake/Generators.cmake.
//
// Interim: compiled and tested in the native build only; the TS ↔ C++ boundary
// still speaks JSON through scene/CodecJson (docs/engine-build.md).
#define IMPLEMENT_KIWI_H
#define IMPLEMENT_SCHEMA_H
#include "kiwi.h"
// node_fields.h includes document.kiwi.h, whose implementation block isn't
// include-guarded: it must be included exactly once here, through node_fields.h.
#include "schema/node_fields.h"
#include "schema/document.stream.h"
