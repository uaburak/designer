cmake_minimum_required(VERSION 3.20)
project(designer_engine C CXX)

# DesignerV2's canvas engine (docs/engine.md): scene graph, editor (tools,
# hit-testing, transactions, undo), our renderer over gfx::Device. Built two
# ways (CMakePresets.json):
#   ENG_TARGET=wasm  → engine.mjs + engine.wasm (tools/build.mjs copies them to
#                      src/renderer/src/engine/wasm/)
#   native           → engine_tests (doctest, ASan/UBSan), no WebGL backend.

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)
set(ENG_SANITIZE "" CACHE STRING "Sanitizers for native builds, e.g. address;undefined")
include(cmake/Flags.cmake)
include(cmake/ThirdParty.cmake)
# schemagen's headers (the binary schema the kiwi codec reads; the generated codecs for the native tests).
include(cmake/Generators.cmake)

add_library(eng_core STATIC
  src/base/FractionalIndex.cpp
  src/base/Json.cpp
  src/base/DerivedIds.cpp
  src/schema/SchemaTable.cpp
  src/scene/Node.cpp
  src/scene/Document.cpp
  src/scene/ChangeSet.cpp
  src/scene/CodecJson.cpp
  src/scene/CodecKiwi.cpp
  src/hit/SpatialIndex.cpp
  src/hit/HitTest.cpp
  src/hit/Picking.cpp
  src/hit/Marquee.cpp
  src/layout/Layout.cpp
  src/layout/GridLayout.cpp
  src/editor/Selection.cpp
  src/editor/Snapping.cpp
  src/editor/Undo.cpp
  src/editor/Editor.cpp
  src/editor/Commands.cpp
  src/editor/Instances.cpp
  src/editor/ComponentCommands.cpp
  src/editor/Variables.cpp
  src/editor/VariableCommands.cpp
  src/editor/Libraries.cpp
  src/tools/Gestures.cpp
  src/render/Renderer.cpp
  src/render/RenderTree.cpp
  src/render/Overlay.cpp
  src/gfx/null/NullDevice.cpp
  src/api/Api.cpp
  src/text/Unicode.cpp
  src/text/Fonts.cpp
  src/text/TextLayout.cpp
  src/text/DerivedText.cpp
  src/text/TextEdit.cpp
  src/editor/TextEditing.cpp
  src/editor/VectorEditing.cpp
  src/editor/VectorCommands.cpp
  src/editor/PaintEditing.cpp
  src/render/CurveCache.cpp
  src/render/ImageCache.cpp
  src/render/TextRender.cpp
  src/geometry/Path.cpp
  src/geometry/VectorNetwork.cpp
  src/geometry/Shapes.cpp
  src/geometry/Stroker.cpp
  src/geometry/Boolean.cpp
  src/geometry/NodeGeometry.cpp
  src/export/Export.cpp
  src/export/Scene.cpp
  src/export/SvgWriter.cpp
  src/export/PdfWriter.cpp
  src/export/Deflate.cpp
  src/proto/Prototype.cpp
  src/proto/Player.cpp
  src/editor/PrototypeEditing.cpp
  src/render/PrototypeOverlay.cpp
  src/render/PresentRender.cpp
)
target_include_directories(eng_core PUBLIC src)
# kiwi.h (the runtime) and the generated binary schema: SYSTEM, so their warnings don't fail -Werror.
target_include_directories(eng_core SYSTEM PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/third_party/kiwi ${ENG_GENERATED})
add_dependencies(eng_core eng_schema_gen)
target_link_libraries(eng_core PUBLIC eng_third_party)
eng_compile_flags(eng_core)

if(EMSCRIPTEN)
  include(cmake/Emscripten.cmake)
  # The kiwi runtime (natively it comes with the generated codecs in eng_schema, whose templates need it in one TU).
  target_sources(eng_core PRIVATE src/schema/KiwiRuntime.cpp)
  target_compile_options(eng_core PRIVATE -msimd128)
  if(NOT CMAKE_BUILD_TYPE STREQUAL "Debug")
    target_compile_options(eng_core PRIVATE -O3 -flto -DNDEBUG)
    # The exporters run once per export, not per frame: built for size.
    set_source_files_properties(src/export/Export.cpp src/export/Scene.cpp src/export/SvgWriter.cpp src/export/PdfWriter.cpp
      PROPERTIES COMPILE_OPTIONS "-Os")
  else()
    target_compile_options(eng_core PRIVATE -O1 -g)
  endif()
  # The GPU backends (docs/engine.md §6.1): WebGPU (emdawnwebgpu's webgpu.h, Emscripten's port of Dawn's
  # bindings) and WebGL2, and the choice between them.
  add_library(eng_gfx_gl STATIC src/gfx/gl/GLDevice.cpp src/gfx/wgpu/WGPUDevice.cpp src/gfx/Backend.cpp)
  target_link_libraries(eng_gfx_gl PUBLIC eng_core)
  target_compile_options(eng_gfx_gl PRIVATE "--use-port=${CMAKE_CURRENT_SOURCE_DIR}/cmake/emdawnwebgpu_engine.py")
  eng_compile_flags(eng_gfx_gl)
  if(NOT CMAKE_BUILD_TYPE STREQUAL "Debug")
    target_compile_options(eng_gfx_gl PRIVATE -O3 -flto -DNDEBUG)
  endif()
  # The exports live in eng_core (api/Api.cpp); the executable only links them.
  add_executable(engine_wasm src/api/Main.cpp)
  target_link_libraries(engine_wasm PRIVATE -Wl,--whole-archive eng_core -Wl,--no-whole-archive eng_gfx_gl eng_third_party)
  target_compile_definitions(eng_core PRIVATE ENG_HAS_GL=1)
  eng_compile_flags(engine_wasm)
  eng_wasm_target(engine_wasm)
else()
  add_executable(engine_tests
    tests/main.cpp
    tests/unit/base.fractional_index.test.cpp
    tests/unit/scene.hierarchy.test.cpp
    tests/unit/scene.codec.test.cpp
    tests/unit/scene.txn.test.cpp
    tests/unit/undo.test.cpp
    tests/unit/hit.picking.test.cpp
    tests/unit/render.camera.test.cpp
    tests/unit/render.batching.test.cpp
    tests/unit/editor.gestures.test.cpp
    tests/unit/api.test.cpp
    tests/unit/layout.test.cpp
    tests/unit/editor.commands.test.cpp
    tests/unit/editor.move.test.cpp
    tests/unit/layout.figma_golden.test.cpp
    tests/unit/scene.kiwi.test.cpp
    tests/unit/components.test.cpp
    tests/unit/variables.test.cpp
    tests/unit/libraries.test.cpp
    tests/unit/text.layout.test.cpp
    tests/unit/text.edit.test.cpp
    tests/unit/text.render.test.cpp
    tests/unit/geometry.path.test.cpp
    tests/unit/geometry.boolean.test.cpp
    tests/unit/editor.vector.test.cpp
    tests/unit/render.paths.test.cpp
    tests/unit/render.cache.test.cpp
    tests/unit/text.stored.test.cpp
    tests/unit/export.test.cpp
    tests/unit/prototype.test.cpp
  )
  target_link_libraries(engine_tests PRIVATE eng_core eng_schema)
  # The system zlib inflates what export/Deflate writes (tests only; the engine has no dependency on it).
  target_link_libraries(engine_tests PRIVATE z)
  target_include_directories(engine_tests PRIVATE third_party/doctest tests/unit)
  # The engine builds without exceptions; doctest then ends the run on a failed REQUIRE.
  target_compile_definitions(engine_tests PRIVATE ENG_TEST_DATA="${CMAKE_CURRENT_SOURCE_DIR}/tests/data"
    ENG_FONTS_DIR="${CMAKE_CURRENT_SOURCE_DIR}/../src/renderer/src/engine/fonts"
    DOCTEST_CONFIG_NO_EXCEPTIONS_BUT_WITH_ALL_ASSERTS)
  target_compile_features(engine_tests PRIVATE cxx_std_20)
  enable_testing()
  add_test(NAME engine_tests COMMAND engine_tests)
endif()
