/**
 * The parts of @node-saml/node-saml 5.1.0, @xmldom/xmldom 0.8 and node:crypto the SP uses (lib.js re-exports them).
 * Narrow on purpose: their own typings bring Node's and the DOM's globals into the Worker's typecheck.
 */

/** node-saml's request-id cache (we back it with D1: saml/config.ts d1Cache) */
export interface CacheProvider {
  saveAsync(key: string, value: string): Promise<unknown>;
  getAsync(key: string): Promise<string | null>;
  removeAsync(key: string | null): Promise<string | null>;
}

export interface Profile {
  issuer: string;
  nameID: string;
  nameIDFormat: string;
  getAssertionXml?(): string;
  [attribute: string]: unknown;
}

export declare const ValidateInResponseTo: { readonly never: "never"; readonly ifPresent: "ifPresent"; readonly always: "always" };

export declare class SAML {
  constructor(options: Record<string, unknown>);
  getAuthorizeUrlAsync(relayState: string, host: string | undefined, options: Record<string, unknown>): Promise<string>;
  validatePostResponseAsync(container: Record<string, string>): Promise<{ profile: Profile | null; loggedOut: boolean }>;
}

export interface XNode {
  readonly nodeType: number;
  readonly nodeValue: string | null;
  readonly textContent: string | null;
  readonly childNodes: ArrayLike<XNode>;
}
export interface XElement extends XNode {
  readonly localName: string;
  readonly namespaceURI: string | null;
  getAttribute(name: string): string | null;
  getElementsByTagNameNS(ns: string, localName: string): ArrayLike<XElement>;
}
export interface XDocument extends XNode {
  readonly documentElement: XElement | null;
  getElementsByTagNameNS(ns: string, localName: string): ArrayLike<XElement>;
}
export declare class DOMParser {
  constructor(options?: { errorHandler?: (level: "warning" | "error" | "fatalError", message: string) => void });
  parseFromString(xml: string, mimeType: string): XDocument;
}

export declare class X509Certificate {
  constructor(pem: string);
  readonly raw: Uint8Array;
  readonly subject: string;
  readonly validTo: string;
  readonly publicKey: { readonly asymmetricKeyType?: string; readonly asymmetricKeyDetails?: { modulusLength?: number }; export(options: { format: "jwk" }): unknown };
}
export declare function createHash(algorithm: string): { update(data: Uint8Array | string): { digest(encoding: "hex"): string } };

/** Loads node-saml and xmldom (the Worker: its separate module) — before `SAML` or `DOMParser` is used */
export declare function loadSamlLib(): Promise<void>;
