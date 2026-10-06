// The wasm executable's own translation unit: it has no main (linked with --no-entry);
// nothing runs at instantiation, and every export lives in api/Api.cpp.
namespace eng {
extern const int kEngineModule = 1;
}
