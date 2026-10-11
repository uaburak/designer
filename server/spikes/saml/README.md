# Spike: a SAML ACS in a Cloudflare Worker (Phase 7 round 1e)

Not deployed, not wired into `server/src` or the app. Round 4a (`server/src/auth/`) builds the real one from this.

## Recommendation

**Use `@node-saml/node-saml` 5.1.0** (the library behind `passport-saml`; it brings `xml-crypto` 6.3.3 and
`@xmldom/xmldom` 0.8.15) under `nodejs_compat`, wrapped by a thin SP layer of our own that adds the checks the library
leaves to the caller. It runs unchanged in workerd: signature verification, C14N, `zlib` (Redirect binding) and
`crypto` all work with `nodejs_compat`, with no shims.

Pin exact versions (`@node-saml/node-saml` 5.1.0, `@xmldom/xmldom` ≥ 0.8.15, `xml-crypto` ≥ 6.3.3) and keep this
suite as the gate for every bump.

## What was built (`src/worker.ts`)

Per tenant (an org; one `acme` in the spike):

| Route | What it does |
|---|---|
| `GET /saml/:tenant/metadata` | SP metadata: entity id `…/metadata`, ACS `…/acs` (HTTP-POST), NameID format emailAddress |
| `GET /saml/:tenant/login` | AuthnRequest over HTTP-Redirect (deflate + base64), `RelayState`; the request id is stored (10 min) |
| `POST /saml/:tenant/acs` | The POST binding. 200 `{nameID, issuer, sessionIndex…}` or 403 `{error}` |

node-saml settings: `wantAssertionsSigned: true` (the assertion must be signed: Okta and Entra sign the assertion by
default), `wantAuthnResponseSigned: false` (a signed envelope is accepted, not required), `idpIssuer`, `audience`,
`validateInResponseTo: always` (SP-initiated only), clock skew 60 s, assertion max age 5 min, our own `CacheProvider`.

Our checks on top, run on the XML node-saml returns as **verified** (`profile.getAssertionXml()`), never on the raw post:

- the assertion's `Issuer` is the tenant's IdP entity id;
- exactly one bearer `SubjectConfirmation`; its `Recipient` is our ACS URL (**node-saml doesn't check Recipient**);
- its `InResponseTo` is present (signed; node-saml otherwise accepts the unsigned `Response/@InResponseTo` alone);
- the Response's `Destination`, when present, is our ACS URL (**node-saml doesn't check Destination**);
- the assertion `ID` is consumed once until its `NotOnOrAfter` (replay cache);
- posts over 256 KiB and any `<!DOCTYPE` are refused before parsing.

## Evidence

`npm test` (= `node scripts/gen-fixtures.mjs && wrangler deploy --dry-run --outdir dist && vitest run`): fresh
throwaway RSA-2048 keys per run (openssl; never committed), the Worker started with wrangler's `unstable_dev` (the
`wrangler dev` path: esbuild bundle + workerd 1.20261006.1, `nodejs_compat`), Responses built and signed in Node by a
test IdP (`test/idp.ts`, xml-crypto, RSA-SHA256, exclusive C14N), each flow starting from a real `GET /login` whose
AuthnRequest id is inflated and answered. **29 / 29 pass** (2026-10-11), the answer per case:

| Case | Answer |
|---|---|
| metadata; valid: assertion signed; valid: Response + assertion signed | 200 (nameID `eve@acme.test`) |
| XSW1 (signed Response moved into its Signature, new root) | 403 Invalid signature, too many transforms |
| XSW2 (signed Response beside the Signature) | 403 Referenced node does not refer to its parent element |
| XSW1 / XSW2 when only the Response was signed | 403 Referenced node does not refer to its parent element |
| XSW3 (evil assertion before the signed one) | 403 Invalid signature: multiple assertions |
| XSW4 (signed assertion inside the evil one) | 403 Invalid signature |
| XSW5 (signed assertion edited, untouched copy appended) | 403 Invalid signature: multiple assertions |
| XSW6 (edited, untouched copy inside its Signature) | 403 ID cannot refer to more than one element |
| XSW7 (signed assertion hidden in `samlp:Extensions`) | 403 Invalid signature |
| XSW8 (untouched copy in a `ds:Object` of the evil one's Signature) | 403 ID cannot refer to more than one element |
| forged second assertion after the signed one | 403 multiple assertions |
| unsigned assertion | 403 Invalid signature |
| only the Response signed | 403 Invalid signature (policy: assertion must be signed) |
| signed by an untrusted key, its certificate embedded in KeyInfo | 403 Invalid signature (KeyInfo certificates are ignored) |
| NameID edited after signing | 403 Invalid signature |
| comment injection `admin@acme.test<!---->.evil.test` (CVE-2017-11427 class) | 200 with the **full** signed value `admin@acme.test.evil.test`, never the truncated one |
| `<!DOCTYPE>` with an entity | 403 DTDs are not accepted (ours) |
| expired / not yet valid | 403 (node-saml) |
| wrong Audience | 403 audience mismatch (node-saml) |
| wrong Recipient / wrong Destination / wrong Issuer | 403 (ours) |
| unknown InResponseTo / none (unsolicited) | 403 (node-saml) |
| the same Response posted twice | 403 InResponseTo is not valid (the request id is consumed) |
| a new Response re-using an accepted assertion ID | 403 assertion replayed (ours) |

Size: the bundle is 1.22 MiB / 203 KiB gzip (583 KiB / 150 KiB gzip minified) — xml-crypto 296 KiB, xml-encryption
181, xpath 170, xmldom 159, xmlbuilder 151, xml2js 148, node-saml 84 (source sizes). Workers now limit only the
uncompressed size (64 MiB), so this is no concern. `npm audit --omit=dev`: 0 vulnerabilities.

## Candidates

| Library | Version (2026-10-11) | Workers | CVE history | Verdict |
|---|---|---|---|---|
| **@node-saml/node-saml** | 5.1.0 (2025-07) | runs under `nodejs_compat`, tested | CVE-2025-54419 (sig. verification, ≤ 5.0.1), CVE-2025-54369 (≤ 3.1.2), CVE-2022-39299 (multiple roots, < 3.2.2), CVE-2023-40178 (timestamps) — all fixed, disclosed and patched promptly; since 5.x it processes only the XML xml-crypto returns as verified | **chosen**: the most used Node SAML SP, maintained by the node-saml org, defensive on wrapping (one assertion, one reference, ≤ 2 transforms) |
| samlify | 2.13.1 (2026-05) | not tried | CVE-2025-47949 (**signature wrapping**, < 2.10.0, critical), CVE-2026-46490 (XML injection in AttributeValue, < 2.13.0), CVE-2017-1000452 | rejected: two serious bypasses in 13 months, pulls `node-rsa`, needs a pluggable schema validator for safety |
| xml-crypto + @xmldom/xmldom (by hand) | 6.3.3 / 0.8.15 | what node-saml uses | xml-crypto CVE-2025-29774 / 29775 (< 6.0.1), CVE-2024-32962 (< 6.0.0) | not alone: we would rewrite node-saml's SAML-level defences ourselves |
| xmldsigjs (PeculiarVentures) | 2.8.8 (2026-07) | WebCrypto-native, no `nodejs_compat` needed | none listed | not chosen: a generic XMLDSig library; all of SAML (wrapping rules, conditions, InResponseTo) would be ours — the riskiest part |

## Risks and what round 4 must still do

1. **No real IdP was tested.** None is installed on this Mac (no Docker, Podman or Keycloak) and an Okta developer
   org needs an account; per the brief nothing was installed. Round 4 must run the same flow against Okta (developer
   org) and Entra / Google Workspace before release; their Responses differ (Okta signs the assertion, ADFS / Entra may
   sign the Response only — then `wantAssertionsSigned` must become per-tenant, and XSW1/2 coverage is what matters).
2. **Replay and InResponseTo storage**: the spike keeps both in module memory (one isolate). Production: D1
   `saml_requests(id PK, tenant, created_at)` consumed with one `DELETE … RETURNING`, and `saml_assertions(id PK,
   expires_at)` written with a plain INSERT (a conflict = replay). node-saml calls `getAsync` then `removeAsync`, so two
   concurrent posts of one Response can both pass its check; our assertion-id INSERT is what stops the second.
3. **IdP-initiated sign-in** (an Okta tile) is refused (`validateInResponseTo: always`). Figma supports it; enabling it
   means `ifPresent` + the assertion-id replay cache as the only replay defence + a RelayState allow-list. Test before.
4. **xmldom's advisory cadence**: 15 advisories in 2026 alone (all fixed in 0.8.15 / 0.9.12; mostly serialization
   injection and quadratic-time DoS). Keep the 256 KiB cap and the DOCTYPE refusal, pin, watch `npm audit` in CI.
5. **Algorithms**: not yet restricted. Add an allow-list (RSA-SHA256/384/512, reject SHA-1) — check the `SignatureMethod`
   on the verified signature ourselves; untested here.
6. **Encrypted assertions** (`xml-encryption`, bundled) are untested; enable only if an IdP needs them.
7. **CPU on the free plan** (10 ms a request): one ACS is two XML parses and one or two RSA verifications; a whole
   test case (signing in Node, the `GET /login`, the POST over local HTTP) took 4–43 ms. Measure CPU with `wrangler tail` on a preview deploy in
   round 4; the paid plan's 30 s default removes the question.
8. The `debug` package and `xml2js` are bundled but harmless; node-saml's default `InMemoryCacheProvider` uses
   `setInterval` — always pass our own provider (as here).

## Running it

```sh
cd server/spikes/saml
npm install
npm test        # fixtures, dry-run bundle (size), 29 tests in workerd
npm run dev     # wrangler dev on :8787 (after npm run fixtures): GET /saml/acme/metadata
```
