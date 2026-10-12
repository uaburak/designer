// The Node libraries of the SAML SP (docs/multiplayer.md §15.2 decision 1), behind one module so the Worker's
// typecheck reads lib.d.ts — our narrow types — instead of their own, which pull in Node's and the DOM's globals and
// clash with @cloudflare/workers-types.
//
// node-saml and xmldom are about 1.2 MB of code: the Worker doesn't bundle them (every isolate would parse them at
// startup, on every route — the free plan's 10 ms of CPU, docs/multiplayer.md §17). They are their own module,
// src/samlVendor.gen.mjs (server/scripts/build-saml.mjs, uploaded unbundled: wrangler.jsonc `find_additional_modules`),
// loaded by `loadSamlLib()` — awaited by the async entry points that use them (sp.ts authnRedirect, verifyResponse;
// config.ts resolveInput) before `SAML` and `DOMParser` here are used. Node's tests load vendor.js itself.
export { X509Certificate, createHash } from "node:crypto";
import { loadSamlVendor } from "../../samlLoader.js";

/** node-saml's ValidateInResponseTo (its values) */
export const ValidateInResponseTo = Object.freeze({ never: "never", ifPresent: "ifPresent", always: "always" });

let vendor = null;

/** Loads node-saml and xmldom once per isolate */
export async function loadSamlLib() {
  vendor ??= await loadSamlVendor();
}

const loaded = () => {
  if (!vendor) throw new Error("the SAML libraries aren't loaded (await loadSamlLib() first)");
  return vendor;
};

/** node-saml's SAML (loaded by `loadSamlLib`) */
export class SAML {
  constructor(options) {
    return new (loaded().SAML)(options);
  }
}

/** xmldom's DOMParser (loaded by `loadSamlLib`) */
export class DOMParser {
  constructor(options) {
    return new (loaded().DOMParser)(options);
  }
}
