# Link flags of the wasm target (docs/engine.md §1.4). EXPORTED_FUNCTIONS comes
# from api/exports.txt (hand-kept until apigen generates it from api.def.ts).
function(eng_wasm_target target)
  target_compile_options(${target} PRIVATE -msimd128)
  target_link_options(${target} PRIVATE
    -sWASM=1
    -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createEngineModule
    -sENVIRONMENT=web
    -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=4GB -sINITIAL_HEAP=64MB -sSTACK_SIZE=2MB
    -sMIN_WEBGL_VERSION=2 -sMAX_WEBGL_VERSION=2
    -sGL_ENABLE_GET_PROC_ADDRESS=0 -sGL_SUPPORT_AUTOMATIC_ENABLE_EXTENSIONS=0
    -sFILESYSTEM=0 -sSUPPORT_LONGJMP=0 -sDYNAMIC_EXECUTION=0 -sTEXTDECODER=2 -sPOLYFILL=0
    "-sEXPORTED_FUNCTIONS=@${CMAKE_CURRENT_SOURCE_DIR}/api/exports.txt"
    "-sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAP32,HEAPU32,HEAPF32,HEAPF64"
    "-sINCOMING_MODULE_JS_API=locateFile,wasmBinary,instantiateWasm,print,printErr,onAbort"
    -sSTRICT=1
    --no-entry
    -lGL -lhtml5
    "--use-port=${CMAKE_CURRENT_SOURCE_DIR}/cmake/emdawnwebgpu_engine.py"
    "--js-library=${CMAKE_CURRENT_SOURCE_DIR}/src/gfx/wgpu/library_engine_wgpu.js"
  )
  set_target_properties(${target} PROPERTIES OUTPUT_NAME engine SUFFIX ".mjs"
    LINK_DEPENDS "${CMAKE_CURRENT_SOURCE_DIR}/api/exports.txt;${CMAKE_CURRENT_SOURCE_DIR}/src/gfx/wgpu/library_engine_wgpu.js")
  if(CMAKE_BUILD_TYPE STREQUAL "Debug")
    target_compile_options(${target} PRIVATE -O1 -g)
    target_link_options(${target} PRIVATE -O1 -gsource-map -sASSERTIONS=2 -sSTACK_OVERFLOW_CHECK=2 -sGL_ASSERTIONS=1)
  else()
    target_link_options(${target} PRIVATE -O3 -flto -sASSERTIONS=0 -sGL_TRACK_ERRORS=0)
  endif()
endfunction()
