// DesignerV2's HarfBuzz configuration (docs/engine.md §12): no threads, no
// environment, no file access, no debugging serialisers; what the engine
// doesn't use is compiled out. Included by hb-config.hh through
// HB_CONFIG_OVERRIDE_H.
#pragma once
#ifndef HB_NO_MT
#define HB_NO_MT
#endif
#define HB_NO_GETENV
#define HB_NO_SETLOCALE
#define HB_NO_OPEN
#define HB_NO_MMAP
#define HB_NO_ERRNO
#define HB_NO_ATEXIT
#define HB_NO_BUFFER_SERIALIZE
#define HB_NO_BUFFER_MESSAGE
#define HB_NO_BUFFER_VERIFY
#define HB_NO_HINTING
#define HB_NO_LAYOUT_FEATURE_PARAMS
#define HB_NO_LAYOUT_COLLECT_GLYPHS
#define HB_NO_MATH
#define HB_NO_META
#define HB_NO_OT_FONT_GLYPH_NAMES
#define HB_NO_FACE_COLLECT_UNICODES
#define HB_NO_VERTICAL
#define HB_NO_STYLE
#define HB_DISABLE_DEPRECATED
#define HB_OPTIMIZE_SIZE
