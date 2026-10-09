# schemagen's C++ outputs (docs/schema.md §2.2): generated at build time from
# schema/document.kiwi into <build>/generated/schema, never committed.
#   ENG_SCHEMA_HEADERS   the five generated headers (facet_readers.h: the per-facet read bindings from fieldmeta.ts)
#   eng_schema_gen       the target that generates them (eng_core depends on it: scene/CodecKiwi reads the
#                        binary schema from document.schema.h in every build)
#   eng_schema           the generated tree / stream codecs' implementations (src/schema/KiwiImpl.cpp; native
#                        tests only — the engine itself reads kiwi through scene/CodecKiwi)
set(ENG_GENERATED ${CMAKE_BINARY_DIR}/generated)
set(ENG_SCHEMA_HEADERS
  ${ENG_GENERATED}/schema/document.kiwi.h
  ${ENG_GENERATED}/schema/document.stream.h
  ${ENG_GENERATED}/schema/node_fields.h
  ${ENG_GENERATED}/schema/document.schema.h
  ${ENG_GENERATED}/schema/facet_readers.h)
get_filename_component(ENG_REPO ${CMAKE_CURRENT_SOURCE_DIR}/.. ABSOLUTE)
find_program(ENG_NODE node REQUIRED)
add_custom_command(
  OUTPUT ${ENG_SCHEMA_HEADERS}
  COMMAND ${ENG_NODE} --disable-warning=MODULE_TYPELESS_PACKAGE_JSON ${ENG_REPO}/engine/tools/schemagen/schemagen.ts --cpp ${CMAKE_BINARY_DIR}
  # schemagen leaves unchanged files alone; touch them so the rule is satisfied.
  COMMAND ${CMAKE_COMMAND} -E touch ${ENG_SCHEMA_HEADERS}
  DEPENDS ${ENG_REPO}/schema/document.kiwi ${ENG_REPO}/engine/tools/schemagen/schemagen.ts ${ENG_REPO}/engine/tools/schemagen/fieldmeta.ts
  COMMENT "schemagen: C++ codecs from schema/document.kiwi"
  VERBATIM)
add_custom_target(eng_schema_gen DEPENDS ${ENG_SCHEMA_HEADERS})

# Figma's shader presets (round 11): the renderer's table from src/shared/shaders/presets.json, the one definition the
# panels read too (engine/tools/shaderpresets.mjs) — <build>/generated/render/shader_presets.h, never committed.
set(ENG_SHADER_PRESETS_HEADER ${ENG_GENERATED}/render/shader_presets.h)
add_custom_command(
  OUTPUT ${ENG_SHADER_PRESETS_HEADER}
  COMMAND ${ENG_NODE} ${ENG_REPO}/engine/tools/shaderpresets.mjs ${ENG_REPO}/src/shared/shaders/presets.json ${ENG_SHADER_PRESETS_HEADER}
  COMMAND ${CMAKE_COMMAND} -E touch ${ENG_SHADER_PRESETS_HEADER}
  DEPENDS ${ENG_REPO}/src/shared/shaders/presets.json ${ENG_REPO}/engine/tools/shaderpresets.mjs
  COMMENT "shaderpresets: the shader presets' table from src/shared/shaders/presets.json"
  VERBATIM)
add_custom_target(eng_shader_presets_gen DEPENDS ${ENG_SHADER_PRESETS_HEADER})

if(NOT EMSCRIPTEN)
  add_library(eng_schema STATIC src/schema/KiwiImpl.cpp ${ENG_SCHEMA_HEADERS})
  # Third-party and generated code: SYSTEM, so their warnings don't fail -Werror.
  target_include_directories(eng_schema SYSTEM PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/third_party/kiwi ${ENG_GENERATED})
  eng_compile_flags(eng_schema)
endif()
