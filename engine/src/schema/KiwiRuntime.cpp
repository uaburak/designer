// The kiwi runtime (third_party/kiwi/kiwi.h: ByteBuffer, MemoryPool,
// BinarySchema), implemented once for every build. scene/CodecKiwi reads and
// writes schema/document.kiwi Messages over ByteBuffer; schema/SchemaTable
// parses the binary schema for the fields the engine doesn't model.
#define IMPLEMENT_KIWI_H
#include "kiwi.h"
