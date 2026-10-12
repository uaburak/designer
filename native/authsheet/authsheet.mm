// The sign-in sheet for main (docs/desktop.md §18.6): Google refuses OAuth in embedded web views (a BrowserWindow or
// <webview> gets `disallowed_useragent`), so the app shows the server's /auth/login in Apple's
// ASWebAuthenticationSession — a system sheet over our window with only the server's, Google's (or the org's IdP's)
// pages, which Google allows (RFC 8252). The sign-in ends when the server redirects to `designer://auth/callback?…`:
// the session catches its callback scheme itself (nothing is registered for it) and hands the URL back.
//
//   available() → boolean                     (macOS 10.15+: the presentation context API)
//   start(url, callbackScheme, windowHandle, done(error: string | null, url: string | null)) → boolean
//                                             (false: not started — the caller uses the system browser;
//                                              error "cancelled": the sheet's Cancel or cancel())
//   cancel()                                  (the sheet in progress, if any)
//
// Not ephemeral (prefersEphemeralWebBrowserSession = NO): Safari's cookies are shared, so Google remembers the person
// (macOS first asks "“Wecra” Wants to Use “…” to Sign In"). The window handle is Electron's
// getNativeWindowHandle() — an NSView* on macOS — whose window the sheet hangs on. Node-API only (ABI-stable), built
// universal by native/authsheet/build.mjs and committed as authsheet.node, like native/haptics.

#import <AppKit/AppKit.h>
#import <AuthenticationServices/AuthenticationServices.h>
#include <node_api.h>
#include <string>

API_AVAILABLE(macos(10.15))
@interface DSGSheetAnchor : NSObject <ASWebAuthenticationPresentationContextProviding>
@property(nonatomic, weak) NSWindow* window;
@end

@implementation DSGSheetAnchor
- (ASPresentationAnchor)presentationAnchorForWebAuthenticationSession:(ASWebAuthenticationSession*)session {
  NSWindow* w = self.window;
  if (w) return w;
  if (NSApp.keyWindow) return NSApp.keyWindow;
  if (NSApp.mainWindow) return NSApp.mainWindow;
  return NSApp.windows.firstObject;
}
@end

// The sheet in progress (one at a time) and its callback into JavaScript. Touched on the JS (main) thread only; the
// completion handler, which may run on another queue, goes through the thread-safe function.
static id gSession = nil;
static id gAnchor = nil;
static napi_threadsafe_function gDone = nullptr;
static int gGeneration = 0;

struct Answer {
  int generation;
  bool hasError;
  std::string error;
  bool hasUrl;
  std::string url;
};

static void CallDone(napi_env env, napi_value js, void* /*context*/, void* data) {
  Answer* a = static_cast<Answer*>(data);
  if (a->generation == gGeneration) {
    gSession = nil;
    gAnchor = nil;
  }
  if (env && js) {
    napi_value argv[2];
    if (a->hasError) napi_create_string_utf8(env, a->error.c_str(), a->error.size(), &argv[0]);
    else napi_get_null(env, &argv[0]);
    if (a->hasUrl) napi_create_string_utf8(env, a->url.c_str(), a->url.size(), &argv[1]);
    else napi_get_null(env, &argv[1]);
    napi_value undefined;
    napi_get_undefined(env, &undefined);
    napi_call_function(env, undefined, js, 2, argv, nullptr);
  }
  delete a;
}

static std::string StringArg(napi_env env, napi_value v) {
  size_t len = 0;
  if (napi_get_value_string_utf8(env, v, nullptr, 0, &len) != napi_ok) return "";
  std::string s(len, '\0');
  napi_get_value_string_utf8(env, v, s.data(), len + 1, &len);
  return s;
}

static napi_value Bool(napi_env env, bool b) {
  napi_value r;
  napi_get_boolean(env, b, &r);
  return r;
}

static napi_value Available(napi_env env, napi_callback_info) {
  if (@available(macOS 10.15, *)) return Bool(env, true);
  return Bool(env, false);
}

static void CancelCurrent() {
  if (@available(macOS 10.15, *)) {
    ASWebAuthenticationSession* s = gSession;
    // Its completion handler answers "cancelled" through the thread-safe function.
    if (s) [s cancel];
  }
}

static napi_value Cancel(napi_env env, napi_callback_info) {
  CancelCurrent();
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

static napi_value Start(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value argv[4];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (argc < 4) return Bool(env, false);
  napi_valuetype t;
  if (napi_typeof(env, argv[3], &t) != napi_ok || t != napi_function) return Bool(env, false);
  if (@available(macOS 10.15, *)) {
    std::string url = StringArg(env, argv[0]);
    std::string scheme = StringArg(env, argv[1]);
    NSURL* nsurl = [NSURL URLWithString:[NSString stringWithUTF8String:url.c_str()]];
    if (!nsurl || scheme.empty()) return Bool(env, false);

    NSWindow* window = nil;
    bool isBuffer = false;
    if (napi_is_buffer(env, argv[2], &isBuffer) == napi_ok && isBuffer) {
      void* data = nullptr;
      size_t length = 0;
      napi_get_buffer_info(env, argv[2], &data, &length);
      if (data && length >= sizeof(void*)) {
        void* ptr = *static_cast<void**>(data);
        NSView* view = (__bridge NSView*)ptr;
        if ([view isKindOfClass:[NSView class]]) window = view.window;
      }
    }

    // One sheet at a time: one still showing is cancelled (its own answer still arrives, then this one's).
    CancelCurrent();

    napi_value name;
    napi_create_string_utf8(env, "authsheet", NAPI_AUTO_LENGTH, &name);
    napi_threadsafe_function tsfn = nullptr;
    if (napi_create_threadsafe_function(env, argv[3], nullptr, name, 0, 1, nullptr, nullptr, nullptr, CallDone, &tsfn) != napi_ok) return Bool(env, false);
    int generation = ++gGeneration;

    DSGSheetAnchor* anchor = [DSGSheetAnchor new];
    anchor.window = window;
    __block bool answered = false;
    ASWebAuthenticationSession* session = [[ASWebAuthenticationSession alloc]
              initWithURL:nsurl
        callbackURLScheme:[NSString stringWithUTF8String:scheme.c_str()]
        completionHandler:^(NSURL* callbackURL, NSError* error) {
          if (answered) return;
          answered = true;
          Answer* a = new Answer{generation, false, "", false, ""};
          if (error) {
            a->hasError = true;
            bool cancelled = [error.domain isEqualToString:ASWebAuthenticationSessionErrorDomain] && error.code == ASWebAuthenticationSessionErrorCodeCanceledLogin;
            a->error = cancelled ? "cancelled" : std::string(error.localizedDescription.UTF8String ?: "the sign-in sheet failed");
          } else if (callbackURL) {
            a->hasUrl = true;
            a->url = callbackURL.absoluteString.UTF8String ?: "";
          } else {
            a->hasError = true;
            a->error = "no callback";
          }
          napi_call_threadsafe_function(tsfn, a, napi_tsfn_blocking);
          napi_release_threadsafe_function(tsfn, napi_tsfn_release);
        }];
    session.presentationContextProvider = anchor;
    session.prefersEphemeralWebBrowserSession = NO;
    gSession = session;
    gAnchor = anchor;
    if (![session start]) {
      gSession = nil;
      gAnchor = nil;
      if (!answered) {
        answered = true;
        napi_release_threadsafe_function(tsfn, napi_tsfn_release);
      }
      return Bool(env, false);
    }
    return Bool(env, true);
  }
  return Bool(env, false);
}

static napi_value Init(napi_env env, napi_value exports) {
  const struct { const char* name; napi_callback fn; } fns[] = {{"available", Available}, {"start", Start}, {"cancel", Cancel}};
  for (const auto& f : fns) {
    napi_value fn;
    napi_create_function(env, f.name, NAPI_AUTO_LENGTH, f.fn, nullptr, &fn);
    napi_set_named_property(env, exports, f.name, fn);
  }
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
