// The heavy half of lib.js: @node-saml/node-saml and @xmldom/xmldom (and xpath, xmlbuilder, xml-crypto under them).
// The Worker loads it as its own module, src/samlVendor.gen.mjs (server/scripts/build-saml.mjs), only on SAML routes;
// Node's tests import this file as it is.
export { SAML } from "@node-saml/node-saml";
export { DOMParser } from "@xmldom/xmldom";
