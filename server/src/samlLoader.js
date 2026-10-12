// Loads the SAML libraries' module (auth/saml/lib.js `loadSamlLib`). It sits next to index.ts on purpose: the Worker's
// bundle (index.js) and the separate module (samlVendor.gen.mjs, server/scripts/build-saml.mjs) are uploaded side by
// side, and wrangler keeps this import's path as written — "./samlVendor.gen.mjs" is right from here and from the bundle.
/* global URL */
export async function loadSamlVendor() {
  try {
    return await import("./samlVendor.gen.mjs");
  } catch {
    // Node (tests, tools): the packages themselves
    return import(/* @vite-ignore */ new URL("./auth/saml/vendor.js", import.meta.url).href);
  }
}
