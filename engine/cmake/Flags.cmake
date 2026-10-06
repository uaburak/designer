# Shared compile flags (docs/engine.md §1.2): C++20, no exceptions, no RTTI,
# warnings as errors (not for third_party/).
function(eng_compile_flags target)
  target_compile_features(${target} PUBLIC cxx_std_20)
  target_compile_options(${target} PRIVATE -Wall -Wextra -Wpedantic -Werror -Wno-unused-parameter)
  target_compile_options(${target} PUBLIC -fno-exceptions -fno-rtti)
  if(ENG_SANITIZE)
    string(REPLACE ";" "," _san "${ENG_SANITIZE}")
    target_compile_options(${target} PUBLIC -fsanitize=${_san} -fno-sanitize-recover=all -fno-omit-frame-pointer)
    target_link_options(${target} PUBLIC -fsanitize=${_san})
  endif()
endfunction()
