// The trackpad's haptic tick for main (docs/desktop.md §10.2 "Haptics"): Electron has no API for it, so this tiny
// Node-API addon calls AppKit's NSHapticFeedbackManager — what Figma's desktop app does on each step of a scrub.
//
//   perform(pattern?: 0 generic | 1 alignment | 2 level change) → boolean (false: no performer)
//
// Node-API only (ABI-stable), so one build serves every Electron / Node version; built universal (arm64 + x86_64) by
// native/haptics/build.mjs and committed as haptics.node. AppKit wants the main thread: Electron's main process runs
// its JavaScript there. The tick plays only while a finger is on a Force Touch trackpad (macOS's own rule).

#import <AppKit/AppKit.h>
#include <node_api.h>

static napi_value Perform(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  int32_t kind = 1;
  if (argc >= 1) {
    napi_valuetype t;
    if (napi_typeof(env, argv[0], &t) == napi_ok && t == napi_number) napi_get_value_int32(env, argv[0], &kind);
  }
  NSHapticFeedbackPattern pattern = kind == 0 ? NSHapticFeedbackPatternGeneric : kind == 2 ? NSHapticFeedbackPatternLevelChange : NSHapticFeedbackPatternAlignment;
  bool ok = false;
  @autoreleasepool {
    id<NSHapticFeedbackPerformer> performer = [NSHapticFeedbackManager defaultPerformer];
    if (performer) {
      [performer performFeedbackPattern:pattern performanceTime:NSHapticFeedbackPerformanceTimeNow];
      ok = true;
    }
  }
  napi_value result;
  napi_get_boolean(env, ok, &result);
  return result;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_value fn;
  napi_create_function(env, "perform", NAPI_AUTO_LENGTH, Perform, nullptr, &fn);
  napi_set_named_property(env, exports, "perform", fn);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
