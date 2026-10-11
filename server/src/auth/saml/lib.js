// The Node libraries of the SAML SP (docs/multiplayer.md §15.2 decision 1), behind one module so the Worker's
// typecheck reads lib.d.ts — our narrow types — instead of their own, which pull in Node's and the DOM's globals and
// clash with @cloudflare/workers-types. Bundled by wrangler under nodejs_compat; run as is by Node's tests.
export { SAML, ValidateInResponseTo } from "@node-saml/node-saml";
export { DOMParser } from "@xmldom/xmldom";
export { X509Certificate, createHash } from "node:crypto";
