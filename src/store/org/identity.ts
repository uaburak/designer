/**
 * The store's `identity` repository (docs/multiplayer.md §15, round 4c): Admin › Settings › Login and provisioning,
 * domains and data storage localization over the server's admin routes as built in rounds 4a (§15.17) and 4b (§15.16):
 *
 *   overview            GET    /orgs/:org/admin/identity                     → IdentityOverview
 *   saveIdp             PUT    /orgs/:org/admin/identity/saml                IdpConfigInput → {idp}
 *   refreshIdpMetadata  POST   /orgs/:org/admin/identity/saml/refresh        → {idp}
 *   deleteIdp           DELETE /orgs/:org/admin/identity/saml                → 204
 *   generateScimToken   POST   /orgs/:org/admin/identity/scim-token          → ScimTokenCreated (the token shown once)
 *   revokeScimToken     DELETE /orgs/:org/admin/identity/scim-token          → 204
 *   addDomain           POST   /orgs/:org/admin/domains {domain}             → {domain}
 *   verifyDomain        POST   /orgs/:org/admin/domains/:domain/verify       → {domain} · 409 domain_unverified {found}
 *   removeDomain        DELETE /orgs/:org/admin/domains/:domain              → 204
 *   domainAccounts      GET    /orgs/:org/admin/domains/:domain/accounts     → {people}
 *   dataRegion          GET    /orgs/:org/admin/data-region                  → DataRegionStatus
 *   setDataRegion       PUT    /orgs/:org/admin/data-region {region}         → DataRegionStatus
 *   moveNext            POST   /orgs/:org/admin/data-region/move             → DataRegionStatus (`moving` null: done)
 *
 * Nothing is cached (admins only, always online). Refusals are §14.6's StoreErrors: the server's `code` in
 * `detail.code` (409 `domain_unverified` → "conflict" with `detail.found`, the TXT values seen; 409 `domain_taken`;
 * 403 `not_admin`; 503 → "invalid"). A write that changes what members see of the org (its IdP, domains — members
 * on a removed domain become guests —, the region) also refreshes the org's cache through `changed`, as the server's
 * own `{t: "org"}` notice would. No Node or DOM imports: LocalStore and the browser's MemoryStore both run it.
 */
import type * as I from "../../shared/org/identity";
import { IDP_PROVIDER_LABEL, normalizeDomain } from "../../shared/org/identity";
import type { IdentityRepository } from "../../shared/org/repositories";
import type * as O from "../../shared/org/types";
import { StoreError } from "../../shared/store/protocol";
import { t as tr } from "../../shared/i18n";

/** What the repository needs: the session's JSON calls (the store's MultiplayerService) */
export interface IdentityHost {
  call<T = unknown>(method: string, path: string, body?: unknown): Promise<T>;
  readonly signedIn: boolean;
}

const seg = (s: unknown, what: string): string => {
  if (typeof s !== "string" || !s || s.length > 256) throw new StoreError("invalid", `bad ${what}`);
  return encodeURIComponent(s);
};

const domainSeg = (d: unknown): string => {
  const n = typeof d === "string" ? normalizeDomain(d) : null;
  if (!n) throw new StoreError("invalid", tr("Enter a domain like acme.com"), { code: "invalid", field: "domain" });
  return encodeURIComponent(n);
};

const str = (v: unknown, max: number): string | undefined => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);

/** IdpConfigInput as the server takes it: only its keys, strings only (the server names a bad field itself) */
function cleanIdpInput(input: unknown): I.IdpConfigInput {
  const i = (input && typeof input === "object" ? input : {}) as Partial<Record<keyof I.IdpConfigInput, unknown>>;
  const provider = typeof i.provider === "string" && i.provider in IDP_PROVIDER_LABEL ? (i.provider as I.IdpProvider) : null;
  if (!provider) throw new StoreError("invalid", tr("Choose an identity provider"), { code: "invalid", field: "provider" });
  const out: I.IdpConfigInput = { provider };
  const metadataUrl = str(i.metadataUrl, 2048);
  const metadataXml = str(i.metadataXml, 1_000_000);
  const idpEntityId = str(i.idpEntityId, 1024);
  const ssoUrl = str(i.ssoUrl, 2048);
  const certificate = str(i.certificate, 100_000);
  if (metadataUrl) out.metadataUrl = metadataUrl;
  if (metadataXml) out.metadataXml = metadataXml;
  if (idpEntityId) out.idpEntityId = idpEntityId;
  if (ssoUrl) out.ssoUrl = ssoUrl;
  if (certificate) out.certificate = certificate;
  if (i.signing === "assertion" || i.signing === "assertion_or_response") out.signing = i.signing;
  return out;
}

/**
 * `onChanged`: the org's members-visible state changed (the stores pass OrgService.notice({t: "org", what: "org",
 * orgId})). The write answers after that refresh, so the org read next — and the `org.updated` event — already carry
 * the change (the refresh used to run detached, and whoever read the org right after the write raced it).
 */
export function identityRepository(host: IdentityHost, onChanged?: (orgId: string) => void | Promise<void>): IdentityRepository {
  const base = (orgId: unknown) => `/orgs/${seg(orgId, "org")}/admin`;
  const call = <T>(method: string, path: string, body?: unknown): Promise<T> => {
    if (!host.signedIn) return Promise.reject(new StoreError("offline", tr("Log in to manage your organization")));
    return host.call<T>(method, path, body);
  };
  const changed = async (orgId: unknown) => {
    try {
      await onChanged?.(String(orgId));
    } catch {
      // a refresh is best effort
    }
  };
  return {
    overview: async (orgId) => call<I.IdentityOverview>("GET", `${base(orgId)}/identity`),
    saveIdp: async (orgId, input) => {
      const { idp } = await call<{ idp: I.IdpConfig }>("PUT", `${base(orgId)}/identity/saml`, cleanIdpInput(input));
      await changed(orgId);
      return idp;
    },
    refreshIdpMetadata: async (orgId) => (await call<{ idp: I.IdpConfig }>("POST", `${base(orgId)}/identity/saml/refresh`)).idp,
    deleteIdp: async (orgId) => {
      await call("DELETE", `${base(orgId)}/identity/saml`);
      await changed(orgId);
    },
    generateScimToken: async (orgId) => call<I.ScimTokenCreated>("POST", `${base(orgId)}/identity/scim-token`),
    revokeScimToken: async (orgId) => void (await call("DELETE", `${base(orgId)}/identity/scim-token`)),
    addDomain: async (orgId, domain) => {
      const n = typeof domain === "string" ? normalizeDomain(domain) : null;
      if (!n) throw new StoreError("invalid", tr("Enter a domain like acme.com"), { code: "invalid", field: "domain" });
      return (await call<{ domain: I.OrgDomain }>("POST", `${base(orgId)}/domains`, { domain: n })).domain;
    },
    verifyDomain: async (orgId, domain) => {
      const d = (await call<{ domain: I.OrgDomain }>("POST", `${base(orgId)}/domains/${domainSeg(domain)}/verify`)).domain;
      await changed(orgId);
      return d;
    },
    removeDomain: async (orgId, domain) => {
      await call("DELETE", `${base(orgId)}/domains/${domainSeg(domain)}`);
      await changed(orgId);
    },
    domainAccounts: async (orgId, domain) => (await call<{ people: O.PersonRef[] }>("GET", `${base(orgId)}/domains/${domainSeg(domain)}/accounts`)).people,
    dataRegion: async (orgId) => call<I.DataRegionStatus>("GET", `${base(orgId)}/data-region`),
    setDataRegion: async (orgId, region) => {
      if (region !== "default" && region !== "eu") throw new StoreError("invalid", "region is default or eu", { code: "invalid", field: "region" });
      const s = await call<I.DataRegionStatus>("PUT", `${base(orgId)}/data-region`, { region });
      await changed(orgId);
      return s;
    },
    moveNext: async (orgId) => call<I.DataRegionStatus>("POST", `${base(orgId)}/data-region/move`),
  };
}
