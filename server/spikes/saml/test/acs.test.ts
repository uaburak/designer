// Runs the Worker under `wrangler dev` (wrangler's unstable_dev: the same esbuild bundle + workerd, nodejs_compat), and drives the SP-initiated flow: GET /login → the AuthnRequest id → a Response signed by the test
// IdP → POST /acs. Every attack must answer 403 and never authenticate admin@acme.test.
import { inflateRawSync } from "node:zlib";
import { join } from "node:path";
import { unstable_dev, type Unstable_DevWorker } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  SP, appendForgedAssertion, buildResponse, injectComment, keys, newId, signAssertion, signBoth, signResponse, tamperNameId, xsw,
  type ResponseOptions,
} from "./idp";

let worker: Unstable_DevWorker;
const mf = {
  // Requests go to the local wrangler dev server; the Worker routes on the path only (its SP origin is fixed).
  dispatchFetch: (url: string, init?: RequestInit) => {
    const u = new URL(url);
    return fetch(`http://${worker.address}:${worker.port}${u.pathname}${u.search}`, init);
  },
};
beforeAll(async () => {
  worker = await unstable_dev(join(import.meta.dirname, "..", "src", "worker.ts"), {
    config: join(import.meta.dirname, "..", "wrangler.jsonc"),
    ip: "127.0.0.1",
    experimental: { disableExperimentalWarning: true },
  });
}, 60_000);
afterAll(async () => {
  console.log(reasons.join("\n"));
  await worker?.stop();
});

async function login(): Promise<string> {
  const res = await mf.dispatchFetch(`${SP}/login?relay=%2Ffiles`, { redirect: "manual" });
  expect(res.status).toBe(302);
  const location = new URL(res.headers.get("location")!);
  expect(location.origin + location.pathname).toBe("https://idp.spike.test/sso");
  expect(location.searchParams.get("RelayState")).toBe("/files");
  const request = inflateRawSync(Buffer.from(location.searchParams.get("SAMLRequest")!, "base64")).toString("utf8");
  expect(request).toContain(`AssertionConsumerServiceURL="${SP}/acs"`);
  expect(request).toContain(`Destination="https://idp.spike.test/sso"`);
  return /\bID="([^"]+)"/.exec(request)![1];
}

async function post(xml: string): Promise<{ status: number; body: { nameID?: string; error?: string } }> {
  const form = new URLSearchParams({ SAMLResponse: Buffer.from(xml, "utf8").toString("base64"), RelayState: "/files" });
  const res = await mf.dispatchFetch(`${SP}/acs`, { method: "POST", body: form, headers: { "content-type": "application/x-www-form-urlencoded" } });
  return { status: res.status, body: (await res.json()) as { nameID?: string; error?: string } };
}

async function signedFor(sign: (xml: string) => string, o: Partial<ResponseOptions> = {}): Promise<string> {
  const inResponseTo = "inResponseTo" in o ? o.inResponseTo! : await login();
  return sign(buildResponse({ ...o, inResponseTo }));
}

/** Why each case was answered as it was — printed at the end (the README's evidence table). */
const reasons: string[] = [];
function rejected(r: { status: number; body: { nameID?: string; error?: string } }) {
  reasons.push(`${expect.getState().currentTestName} → ${r.status} ${r.body.error ?? r.body.nameID}`);
  expect(r.status, JSON.stringify(r.body)).toBe(403);
  expect(r.body.nameID).toBeUndefined();
}

describe("SP basics in workerd", () => {
  it("serves metadata", async () => {
    const res = await mf.dispatchFetch(`${SP}/metadata`);
    expect(res.status).toBe(200);
    const xml = await res.text();
    expect(xml).toContain(`entityID="${SP}/metadata"`);
    expect(xml).toContain(`Location="${SP}/acs"`);
    expect(xml).toContain("urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST");
  });
});

describe("valid responses", () => {
  it("assertion signed (Okta / Entra default)", async () => {
    const r = await post(await signedFor(signAssertion));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.nameID).toBe("eve@acme.test");
  });
  it("response and assertion both signed", async () => {
    const r = await post(await signedFor(signBoth));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.nameID).toBe("eve@acme.test");
  });
});

describe("signature wrapping (XSW1–XSW8)", () => {
  for (const [name, attack] of Object.entries(xsw)) {
    const base = name === "XSW1" || name === "XSW2" ? signBoth : signAssertion;
    it(`${name} is rejected`, async () => rejected(await post(attack(await signedFor(base)))));
  }
  it("XSW1/XSW2 also rejected when only the Response was signed", async () => {
    rejected(await post(xsw.XSW1(await signedFor(signResponse))));
    rejected(await post(xsw.XSW2(await signedFor(signResponse))));
  });
  it("a forged second assertion after the signed one is rejected", async () => rejected(await post(appendForgedAssertion(await signedFor(signAssertion)))));
});

describe("signature and content", () => {
  it("unsigned assertion is rejected", async () => rejected(await post(await signedFor((x) => x))));
  it("only the Response signed is rejected (we require a signed assertion)", async () => rejected(await post(await signedFor(signResponse))));
  it("signed by an untrusted key with its own certificate in KeyInfo is rejected", async () =>
    rejected(await post(await signedFor((x) => signAssertion(x, keys.attacker)))));
  it("NameID changed after signing is rejected", async () => rejected(await post(tamperNameId(await signedFor(signAssertion)))));
  it("comment injection in NameID never yields the truncated identity", async () => {
    // The IdP signs eve's legitimate address admin@acme.test.evil.test; she splits it with a comment.
    const signed = await signedFor(signAssertion, { nameId: "admin@acme.test.evil.test" });
    const r = await post(injectComment(signed, "admin@acme.test", ".evil.test"));
    // Either way is safe: rejected, or the full signed value. Never "admin@acme.test".
    reasons.push(`comment injection → ${r.status} ${r.body.error ?? r.body.nameID}`);
    if (r.status === 200) expect(r.body.nameID).toBe("admin@acme.test.evil.test");
    else rejected(r);
    expect(r.body.nameID).not.toBe("admin@acme.test");
  });
  it("a DOCTYPE (entity expansion / XXE) is rejected", async () => {
    const signed = await signedFor(signAssertion);
    rejected(await post(`<?xml version="1.0"?><!DOCTYPE r [<!ENTITY x "admin@acme.test">]>` + signed));
  });
});

describe("conditions", () => {
  it("expired (NotOnOrAfter in the past) is rejected", async () => rejected(await post(await signedFor(signAssertion, { notBefore: -20 * 60_000, notOnOrAfter: -10 * 60_000 }))));
  it("not yet valid (NotBefore in the future) is rejected", async () => rejected(await post(await signedFor(signAssertion, { notBefore: 10 * 60_000, notOnOrAfter: 20 * 60_000 }))));
  it("wrong audience is rejected", async () => rejected(await post(await signedFor(signAssertion, { audience: "https://other-sp.test/metadata" }))));
  it("wrong Recipient is rejected", async () => rejected(await post(await signedFor(signAssertion, { recipient: "https://other-sp.test/acs" }))));
  it("wrong Destination is rejected", async () => rejected(await post(await signedFor(signAssertion, { destination: "https://other-sp.test/acs" }))));
  it("wrong issuer is rejected", async () => rejected(await post(await signedFor(signAssertion, { issuer: "https://evil-idp.test/metadata" }))));
  it("unknown InResponseTo is rejected", async () => rejected(await post(await signedFor(signAssertion, { inResponseTo: newId() }))));
  it("missing InResponseTo (unsolicited) is rejected", async () => rejected(await post(await signedFor(signAssertion, { inResponseTo: null }))));
  it("replay of an accepted Response is rejected", async () => {
    const signed = await signedFor(signAssertion);
    expect((await post(signed)).status).toBe(200);
    rejected(await post(signed));
  });
  it("replay of an accepted assertion id under a fresh request is rejected", async () => {
    const assertionId = newId();
    expect((await post(await signedFor(signAssertion, { assertionId }))).status).toBe(200);
    const r = await post(await signedFor(signAssertion, { assertionId }));
    rejected(r);
    expect(r.body.error).toBe("assertion replayed");
  });
});
