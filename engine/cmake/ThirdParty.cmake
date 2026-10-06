# Vendored third-party code (docs/engine.md §12), built without our warning
# flags or sanitizers:
#   third_party/harfbuzz     HarfBuzz 14.6.0 (shaping, font tables, glyph outlines), amalgamated harfbuzz.cc
#   third_party/libunibreak  libunibreak 8.0 (UAX #14 line breaks, UAX #29 word and grapheme breaks)
#   third_party/clipper2     Clipper2 2.0.1 (polygon clipping for path booleans; Boost licence), built with USINGZ
set(_tp ${CMAKE_CURRENT_SOURCE_DIR}/third_party)
add_library(eng_third_party STATIC
  ${_tp}/harfbuzz/src/harfbuzz.cc
  ${_tp}/libunibreak/eastasianwidthdata.c
  ${_tp}/libunibreak/eastasianwidthdef.c
  ${_tp}/libunibreak/emojidata.c
  ${_tp}/libunibreak/emojidef.c
  ${_tp}/libunibreak/graphemebreak.c
  ${_tp}/libunibreak/graphemebreakdata.c
  ${_tp}/libunibreak/indicconjunctbreakdata.c
  ${_tp}/libunibreak/linebreak.c
  ${_tp}/libunibreak/linebreakauxdata.c
  ${_tp}/libunibreak/linebreakdata.c
  ${_tp}/libunibreak/linebreakdef.c
  ${_tp}/libunibreak/unibreakbase.c
  ${_tp}/libunibreak/unibreakdef.c
  ${_tp}/libunibreak/wordbreak.c
  ${_tp}/libunibreak/wordbreakdata.c
  ${_tp}/clipper2/src/clipper.engine.cpp
)
target_include_directories(eng_third_party SYSTEM PUBLIC ${_tp}/harfbuzz/src ${_tp}/libunibreak ${_tp}/clipper2/include)
# Clipper's points carry a Z value (USINGZ): every user of its headers must see the same definition.
target_compile_definitions(eng_third_party PUBLIC USINGZ)
target_include_directories(eng_third_party PRIVATE ${_tp}/harfbuzz)
target_compile_definitions(eng_third_party PRIVATE HB_CONFIG_OVERRIDE_H="hb-config-override.h" NDEBUG)
set_source_files_properties(${_tp}/harfbuzz/src/harfbuzz.cc PROPERTIES COMPILE_OPTIONS "-fno-exceptions;-fno-rtti;-fno-threadsafe-statics")
set_source_files_properties(${_tp}/clipper2/src/clipper.engine.cpp PROPERTIES COMPILE_OPTIONS "-fno-exceptions;-fno-rtti")
target_compile_options(eng_third_party PRIVATE -w)
if(EMSCRIPTEN)
  if(CMAKE_BUILD_TYPE STREQUAL "Debug")
    target_compile_options(eng_third_party PRIVATE -O1)
  else()
    target_compile_options(eng_third_party PRIVATE -Os -flto)
  endif()
else()
  target_compile_options(eng_third_party PRIVATE -O2)
endif()
