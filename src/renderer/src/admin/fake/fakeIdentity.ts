/**
 * Admin › Settings' identity side on the fake org: an `IdentityRepository` (docs/multiplayer.md §15.13) over in-memory
 * rows, and the settings rules the server checks (§15.6, §15.7; server/src/org/admin.ts `patchSettings`, 4a's
 * settingsHooks) so the views show the same refusals: SAML required only after a successful test, the IdP config not
 * removable while required, SCIM needing SAML, domains verified by a TXT record (faked DNS), capture needing every
 * domain verified, external content needing capture, the idle and expiry ranges, the data region moved one object per
 * call. Every write logs §15.11's action.
 */
import type { IdentityRepository } from "@shared/org/repositories";
import type * as I from "@shared/org/identity";
import { DATA_REGION_LABEL, DOMAIN_TXT_PREFIX, IDLE_MAX_HOURS, IDLE_MIN_HOURS, LINK_EXPIRY_MAX_HOURS, emailDomain, normalizeDomain } from "@shared/org/identity";
import type * as O from "@shared/org/types";
import type { Seed } from "./seed";

type Log = (type: O.ActivityAction, entity: O.ActivityLog["entity"], details?: Record<string, unknown>, teamId?: string | null) => void;

/** The Worker's public origin (docs/multiplayer.md §15.3.2) */
export const FAKE_ORIGIN = "https://designer.burak-kc-sp.workers.dev";

/** A refusal shaped like the store's StoreError (`code`, `detail`), with the server's identity codes */
export class FakeIdentityError extends Error {
  override name = "StoreError";
  constructor(readonly code: string, message: string, readonly detail?: unknown) {
    super(message);
  }
}

export interface IdentityState {
  idp: I.IdpConfig | null;
  scimToken: I.ScimTokenInfo | null;
  domains: I.OrgDomain[];
  /** Faked DNS: the TXT values each domain answers (tests set them; `autoDns` publishes each new domain's record) */
  dns: Map<string, string[]>;
  /** Domains verified by another org (`domain_taken`) */
  taken: Set<string>;
  region: I.DataRegion;
  /** Objects (files then libraries) and the region each sits in */
  objects: { key: string; kind: "file" | "library"; name: string; region: I.DataRegion }[];
  regionAvailable: boolean;
  /** Accounts outside the org, by email (Manage domains' outside-accounts list) */
  outside: O.PersonRef[];
}

function digits(n: number, rnd: () => number): string {
  let s = String(1 + Math.floor(rnd() * 9));
  while (s.length < n) s += String(Math.floor(rnd() * 10));
  return s;
}
function hex(n: number, rnd: () => number): string {
  let s = "";
  while (s.length < n) s += Math.floor(rnd() * 16).toString(16);
  return s;
}

export function seedIdentity(s: Seed, now: number): IdentityState {
  // People's SAML / SCIM data (Admin › People's metadata columns): most members by SCIM, a few by JIT
  const departments = ["Design", "Engineering", "Research", "Marketing"];
  s.people.forEach((p, i) => {
    if (p.role === "guest" || p.pending) return void (p.idp = null);
    if (i % 7 === 6) return void (p.idp = { provisionedBy: "jit", scimActive: null, title: i % 2 ? "Designer" : "Engineer" });
    p.idp = {
      provisionedBy: "scim", scimActive: true, externalId: `00u${(1000 + i).toString(36)}`,
      title: ["Product Designer", "Senior Engineer", "Design Manager", "Researcher"][i % 4], employeeNumber: String(1000 + i),
      costCenter: `CC-${100 + (i % 5) * 10}`, organization: "Studio", division: i % 3 ? "Product" : "Brand", department: departments[i % 4],
      managerValue: "u1", managerDisplayName: "Burak Koç",
    };
  });
  const files = Array.from({ length: 24 }, (_, i) => ({ key: `f${String(i + 1).padStart(3, "0")}`, kind: "file" as const, name: `File ${i + 1}`, region: "default" as I.DataRegion }));
  const libs = Array.from({ length: 4 }, (_, i) => ({ key: `lib${i + 1}`, kind: "library" as const, name: `Library ${i + 1}`, region: "default" as I.DataRegion }));
  return {
    idp: null, scimToken: null,
    domains: [{ domain: "studio.co", verified: true, verifiedAt: now - 120 * 86_400_000, txtRecord: `${DOMAIN_TXT_PREFIX}5d41402abc4b2a76b9719d911017c592`, createdAt: now - 121 * 86_400_000 }],
    dns: new Map([["studio.co", [`${DOMAIN_TXT_PREFIX}5d41402abc4b2a76b9719d911017c592`, "v=spf1 include:_spf.google.com ~all"]]]),
    taken: new Set(["figma.com"]),
    region: "default", objects: [...files, ...libs], regionAvailable: true,
    outside: [
      { id: "x1", email: "lena.berg@studio.co", name: "Lena Berg", picture: null, role: "guest" },
      { id: "x2", email: "omar.haddad@studio.co", name: "Omar Haddad", picture: null, role: "guest" },
    ],
  };
}

export interface FakeIdentity {
  identity: IdentityRepository;
  state: IdentityState;
  /** The checks `PATCH admin/settings` runs for round 4's keys (throws); then `afterSettings` logs and applies them */
  validateSettings(before: O.OrgSettings, patch: Partial<O.OrgSettings>): void;
  afterSettings(before: O.OrgSettings, next: O.OrgSettings): void;
  /** A successful SAML sign-in through the config (`idp_configs.tested_at`): the fake's Test */
  completeTest(): void;
}

export function fakeIdentity(s: Seed, st: IdentityState, me: string, log: Log, wait: <T>(v: T) => Promise<T>, now: () => number, options: { autoDns?: boolean; seed?: number } = {}): FakeIdentity {
  let r = (options.seed ?? 4) >>> 0;
  const rnd = () => {
    r = (r * 1664525 + 1013904223) >>> 0;
    return r / 4294967296;
  };
  const org = () => ({ type: "org" as const, id: s.orgId, name: s.orgName });
  const fail = (code: string, message: string, detail?: unknown) => new FakeIdentityError(code, message, detail);
  const overview = (): I.IdentityOverview => ({
    authMethod: s.settings.authMethod,
    idp: st.idp,
    scim: st.idp ? { baseUrl: `${FAKE_ORIGIN}/scim/v2/${st.idp.tenantId}`, token: st.scimToken } : null,
    domains: st.domains,
    domainCapture: s.settings.domainCapture,
  });
  const regionStatus = (moving: string | null = null): I.DataRegionStatus => {
    const files = st.objects.filter((o) => o.kind === "file");
    const libs = st.objects.filter((o) => o.kind === "library");
    return {
      region: st.region,
      files: { total: files.length, moved: files.filter((o) => o.region === st.region).length },
      libraries: { total: libs.length, moved: libs.filter((o) => o.region === st.region).length },
      moving, available: st.regionAvailable,
    };
  };
  const myDomain = () => emailDomain(s.people.find((p) => p.id === me)?.email ?? "");

  const identity: IdentityRepository = {
    async overview() {
      return wait(overview());
    },
    async saveIdp(_org, input) {
      let idpEntityId: string, ssoUrl: string;
      const metadataUrl = input.metadataUrl?.trim() || null;
      if (metadataUrl !== null) {
        if (!/^https:\/\/[^\s/]+\.[^\s]+$/.test(metadataUrl)) throw fail("invalid", "The metadata URL must start with https://");
        const host = new URL(metadataUrl).host;
        idpEntityId = `http://${host}/exk${hex(16, rnd)}`;
        ssoUrl = `https://${host}/app/designerv2/exk${hex(16, rnd)}/sso/saml`;
      } else if (input.metadataXml?.trim()) {
        const xml = input.metadataXml;
        if (/<!DOCTYPE/i.test(xml)) throw fail("invalid", "The metadata can't contain a DOCTYPE");
        const entity = /entityID="([^"]+)"/.exec(xml)?.[1];
        const sso = /SingleSignOnService[^>]*Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect"[^>]*Location="([^"]+)"/.exec(xml)?.[1] ?? /SingleSignOnService[^>]*Location="([^"]+)"[^>]*Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect"/.exec(xml)?.[1];
        if (!entity) throw fail("invalid", "The metadata has no entityID");
        if (!sso) throw fail("invalid", "The metadata has no SSO service with the HTTP-Redirect binding");
        if (!/X509Certificate/.test(xml)) throw fail("invalid", "The metadata has no signing certificate");
        idpEntityId = entity;
        ssoUrl = sso;
      } else {
        if (!input.idpEntityId?.trim()) throw fail("invalid", "Enter the IdP Entity ID");
        if (!input.ssoUrl?.trim() || !/^https:\/\//.test(input.ssoUrl.trim())) throw fail("invalid", "The IdP SSO Target URL must start with https://");
        if (!input.certificate?.trim()) throw fail("invalid", "Add the signing certificate");
        idpEntityId = input.idpEntityId.trim();
        ssoUrl = input.ssoUrl.trim();
      }
      const creating = st.idp === null;
      const tenantId = st.idp?.tenantId ?? digits(18, rnd);
      st.idp = {
        tenantId, provider: input.provider, idpEntityId, ssoUrl,
        certificates: [{ sha256: hex(64, rnd).toUpperCase().replace(/(..)(?!$)/g, "$1:"), subject: `CN=${new URL(ssoUrl).host}`, notAfter: now() + 3 * 365 * 86_400_000 }],
        metadataUrl, signing: input.signing ?? "assertion",
        spEntityId: `${FAKE_ORIGIN}/saml/${tenantId}`, spAcsUrl: `${FAKE_ORIGIN}/saml/${tenantId}/consume`, startUrl: `${FAKE_ORIGIN}/saml/${tenantId}/start`,
        // A new IdP must be tested again before it can be required
        testedAt: null, updatedAt: now(),
      };
      log(creating ? "idp_config_create" : "idp_config_update", org(), { tenant_id: tenantId, provider: input.provider });
      return wait(st.idp);
    },
    async refreshIdpMetadata() {
      if (!st.idp) throw fail("not-found", "SAML SSO isn't set up");
      if (!st.idp.metadataUrl) throw fail("invalid", "This configuration has no metadata URL");
      st.idp = { ...st.idp, updatedAt: now() };
      log("idp_config_update", org(), { tenant_id: st.idp.tenantId, refreshed: true });
      return wait(st.idp);
    },
    async deleteIdp() {
      if (!st.idp) throw fail("not-found", "SAML SSO isn't set up");
      if (s.settings.authMethod === "saml") throw fail("conflict", "Members must log in with SAML SSO. Change the authentication method first.");
      const tenantId = st.idp.tenantId;
      st.idp = null;
      if (st.scimToken) {
        st.scimToken = null;
        log("scim_token_revoke", org(), { tenant_id: tenantId });
      }
      log("idp_config_delete", org(), { tenant_id: tenantId });
      return wait(undefined);
    },
    async generateScimToken() {
      if (!st.idp) throw fail("conflict", "Set up SAML SSO first");
      const p = s.people.find((x) => x.id === me)!;
      const info: I.ScimTokenInfo = { id: `scim${hex(8, rnd)}`, createdAt: now(), createdBy: { id: p.id, email: p.email, name: p.name, picture: p.picture, role: p.role }, lastUsedAt: null };
      if (st.scimToken) log("scim_token_revoke", org(), { tenant_id: st.idp.tenantId });
      st.scimToken = info;
      log("scim_token_generate", org(), { tenant_id: st.idp.tenantId });
      let token = "dsgn_scim_";
      const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
      while (token.length < 10 + 43) token += abc[Math.floor(rnd() * 64)];
      return wait({ token, info });
    },
    async revokeScimToken() {
      if (!st.scimToken) return wait(undefined);
      st.scimToken = null;
      log("scim_token_revoke", org(), { tenant_id: st.idp?.tenantId });
      return wait(undefined);
    },
    async addDomain(_org, input) {
      const domain = normalizeDomain(input);
      if (!domain) throw fail("invalid", `"${input.trim()}" isn't a domain`);
      if (st.domains.some((d) => d.domain === domain)) throw fail("conflict", `${domain} is already added`);
      if (st.taken.has(domain)) throw fail("domain_taken", `${domain} is verified by another organization`);
      const d: I.OrgDomain = { domain, verified: false, verifiedAt: null, txtRecord: `${DOMAIN_TXT_PREFIX}${hex(32, rnd)}`, createdAt: now() };
      st.domains.push(d);
      if (options.autoDns) st.dns.set(domain, [d.txtRecord]);
      log("org_domain_add", org(), { domain });
      return wait(d);
    },
    async verifyDomain(_org, domain) {
      const d = st.domains.find((x) => x.domain === domain);
      if (!d) throw fail("not-found", `${domain} isn't added`);
      if (d.verified) return wait(d);
      if (st.taken.has(domain)) throw fail("domain_taken", `${domain} is verified by another organization`);
      const found = st.dns.get(domain) ?? [];
      if (!found.includes(d.txtRecord)) throw fail("domain_unverified", `The TXT record wasn't found on ${domain}`, { found });
      d.verified = true;
      d.verifiedAt = now();
      log("org_domain_verify", org(), { domain });
      return wait(d);
    },
    async removeDomain(_org, domain) {
      const d = st.domains.find((x) => x.domain === domain);
      if (!d) throw fail("not-found", `${domain} isn't added`);
      if (myDomain() === domain) throw fail("conflict", "You can't remove the domain of your own email");
      st.domains = st.domains.filter((x) => x !== d);
      // Members on it (and on no other domain of the org) become guests [F-domain]
      const left = new Set(st.domains.map((x) => x.domain));
      for (const p of s.people) if (p.role === "member" && emailDomain(p.email) === domain && !left.has(domain)) p.role = "guest";
      log("org_domain_remove", org(), { domain });
      if (s.settings.domainCapture && !st.domains.some((x) => x.verified)) {
        s.settings = { ...s.settings, domainCapture: false, externalContent: "allowed" };
        log("org_domain_capture_change", org(), { setting: "domainCapture", from: true, to: false });
      }
      return wait(undefined);
    },
    async domainAccounts(_org, domain) {
      return wait(st.outside.filter((p) => emailDomain(p.email) === domain));
    },
    async dataRegion() {
      return wait(regionStatus());
    },
    async setDataRegion(_org, region) {
      if (region === "eu" && !st.regionAvailable) throw fail("invalid", "The European Union region isn't available");
      if (region !== st.region) {
        log("data_storage_localization_change", org(), { from: st.region, to: region, from_label: DATA_REGION_LABEL[st.region], to_label: DATA_REGION_LABEL[region] });
        st.region = region;
      }
      return wait(regionStatus());
    },
    async moveNext() {
      const o = st.objects.find((x) => x.region !== st.region && x.kind === "file") ?? st.objects.find((x) => x.region !== st.region);
      if (!o) return wait(regionStatus());
      const from = o.region;
      o.region = st.region;
      log("fig_file_region_move", { type: "file", id: o.key, name: o.name, key: o.key }, { object: o.kind === "file" ? "room" : "library", from, to: st.region });
      return wait(regionStatus(o.key));
    },
  };

  const validateSettings = (before: O.OrgSettings, patch: Partial<O.OrgSettings>) => {
    const next = { ...before, ...patch };
    if (patch.authMethod === "saml" && before.authMethod !== "saml") {
      if (!st.idp) throw fail("invalid", "Set up SAML SSO first");
      if (st.idp.testedAt === null) throw fail("invalid", "Test SAML SSO first");
    }
    const h = patch.idleSessionTimeoutHours;
    if (h !== undefined && h !== null && !(Number.isInteger(h) && h >= IDLE_MIN_HOURS && h <= IDLE_MAX_HOURS)) throw fail("invalid", "The idle session timeout must be between 12 hours and 14 days");
    const x = patch.linkExpiryMaxHours;
    if (x !== undefined && x !== null && !(Number.isInteger(x) && x >= 1 && x <= LINK_EXPIRY_MAX_HOURS)) throw fail("invalid", "Links must expire within 1 hour to 31 days");
    if (patch.domainCapture === true && !before.domainCapture) {
      if (st.domains.length === 0) throw fail("domain_unverified", "Add a domain first");
      if (st.domains.some((d) => !d.verified)) throw fail("domain_unverified", "Verify every domain first");
    }
    if (next.externalContent === "restricted" && !next.domainCapture) throw fail("conflict", "Turn on domain capture before restricting external content");
  };
  const afterSettings = (before: O.OrgSettings, next: O.OrgSettings) => {
    if (before.authMethod !== next.authMethod) {
      const google = before.authMethod === "google" || next.authMethod === "google";
      const saml = before.authMethod === "saml" || next.authMethod === "saml";
      if (google) log("google_sso_auth_change", org(), { setting: "authMethod", from: before.authMethod, to: next.authMethod });
      if (saml || !google) log("saml_sso_auth_change", org(), { setting: "authMethod", from: before.authMethod, to: next.authMethod });
    }
    if (before.idleSessionTimeoutHours !== next.idleSessionTimeoutHours) log("idle_timeout_setting_change", org(), { setting: "idleSessionTimeoutHours", from: before.idleSessionTimeoutHours, to: next.idleSessionTimeoutHours });
    if (before.domainCapture !== next.domainCapture) {
      log("org_domain_capture_change", org(), { setting: "domainCapture", from: before.domainCapture, to: next.domainCapture });
      if (next.domainCapture) {
        // Existing accounts on the verified domains join as members with a View seat [F-domain]
        const verified = new Set(st.domains.filter((d) => d.verified).map((d) => d.domain));
        for (const o of st.outside.filter((p) => verified.has(emailDomain(p.email) ?? ""))) {
          s.people.push({ ...o, role: "member", seat: "view", workspaceId: null, billingGroupId: null, lastActiveAt: null, joinedAt: now(), pending: false, teams: 0, idp: null });
          log("org_user_create", { type: "user", id: o.id, name: o.name ?? o.email, email: o.email }, { domain_capture: true });
        }
        st.outside = st.outside.filter((p) => !verified.has(emailDomain(p.email) ?? ""));
      }
    }
  };
  const completeTest = () => {
    if (st.idp && st.idp.testedAt === null) st.idp = { ...st.idp, testedAt: now() };
  };
  return { identity, state: st, validateSettings, afterSettings, completeTest };
}
