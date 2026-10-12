/**
 * The store's `governance` repository (docs/governance.md §4; Phase 7 round 14e): Governance+ over the server's routes as
 * built in rounds 14a–14d (§9 of the contract):
 *
 *   overview                GET    /orgs/:org/admin/governance                         → GovernanceOverview
 *   setGovernancePlus       PUT    /orgs/:org/admin/governance {governancePlus}        → GovernanceOverview (409 conflict
 *                                                                                        while key management is on)
 *   setIpAllowlist          PUT    /orgs/:org/admin/ip-allowlist {enabled, ranges}     → IpAllowlist
 *   addNetworkRange         POST   /orgs/:org/admin/network-ranges {cidr}              → 201 {range}
 *   setNetworkRange         PATCH  /orgs/:org/admin/network-ranges/:id {state}         → {range}
 *   removeNetworkRange      DELETE /orgs/:org/admin/network-ranges/:id                 → 204
 *   policies                GET    /orgs/:org/admin/policies                           → {policies}
 *   createPolicy            POST   /orgs/:org/admin/policies InternalPolicyInput       → 201 {policy}
 *   setPolicyEnabled        PATCH  /orgs/:org/admin/policies/:id {enabled}             → {policy}
 *   setGuestExpiration      PUT    /orgs/:org/admin/guests/expiration {userIds, expiresAt}  → 204
 *   ekm                     GET    /orgs/:org/admin/key-management                     → EkmStatus
 *   enableEkm               PUT    /orgs/:org/admin/key-management {source}            → EkmStatus
 *   encryptNext             POST   /orgs/:org/admin/key-management/encrypt-next        → EkmStatus
 *   developerLogs           GET    /orgs/:org/admin/developer-logs?…                   → DeveloperLogsResponse (→ its meta)
 *   idps                    GET    /orgs/:org/admin/identity/idps                      → {idps}
 *   saveIdp                 POST   /orgs/:org/admin/identity/idps (no tenant)          → 201 {idp}
 *                           PUT    /orgs/:org/admin/identity/idps/:tenantId            → {idp} ({name} alone renames)
 *   refreshIdp              POST   /orgs/:org/admin/identity/idps/:tenantId/refresh    → {idp}
 *   removeIdp               DELETE /orgs/:org/admin/identity/idps/:tenantId            → 204
 *   generateIdpScimToken    POST   /orgs/:org/admin/identity/idps/:tenantId/scim-token → 201 ScimTokenCreated
 *   revokeIdpScimToken      DELETE /orgs/:org/admin/identity/idps/:tenantId/scim-token → 204
 *   mapDomain               PUT    /orgs/:org/admin/domains/:domain/idp {tenantId}     → {domain, tenantId}
 *   pendingPolicies         GET    /orgs/:org/policies/pending                         → {policies}
 *   acknowledgePolicy       POST   /orgs/:org/policies/:id/acknowledge                 → 204
 *   twoFactor               GET    /me/two-factor                                      → TwoFactorStatus
 *   setupTwoFactor          POST   /me/two-factor/setup                                → TwoFactorSetup
 *   enableTwoFactor         POST   /me/two-factor/enable {code}                        → TwoFactorEnabled
 *   regenerateRecoveryCodes POST   /me/two-factor/recovery-codes {code}                → TwoFactorEnabled
 *   disableTwoFactor        DELETE /me/two-factor {code}                               → 204
 *
 * Nothing is cached (admins and Settings › Security, always online). Refusals are §14.6's StoreErrors with the server's
 * `code` in `detail.code` (MultiplayerService's httpError): 403 `governance_plus_required` and the gates → "forbidden"
 * (`detail.gate`), 503 `key_unavailable` → "unavailable", 400 `two_factor_invalid` / 429 `rate_limited` → "invalid", 409
 * → "conflict". A write that changes what the caller or members see of an org's gates (the add-on, the allowlist, a
 * policy, an agreement, the caller's 2FA, IdP mappings) answers after the org was read again through `changed` (as
 * identity.ts does), and an agreement or 2FA turned on lets waiting file links try again (`retry`).
 *
 * `governanceEvents` turns MultiplayerService's Governance+ refusals into org events for both stores: the org is read
 * again (`org.updated`, `orgs.changed`: Home re-reads `OrgSummary.gate`), then `access.blocked` says what refused.
 * No Node or DOM imports: LocalStore and the browser's MemoryStore both run it.
 */
import type * as G from "../../shared/org/governance";
import { POLICY_AUDIENCE_LABEL, POLICY_CADENCE_LABEL, POLICY_TEXT_MAX, POLICY_TITLE_MAX } from "../../shared/org/governance";
import type * as I from "../../shared/org/identity";
import { IDP_PROVIDER_LABEL, normalizeDomain } from "../../shared/org/identity";
import type { GovernanceRepository, OrgEvent } from "../../shared/org/repositories";
import type { Unsubscribe } from "../../shared/store/emitter";
import { StoreError } from "../../shared/store/protocol";
import type { GovernanceRefusal } from "../multiplayer/service";
import type { IdentityHost } from "./identity";

/** What the repository needs: the session's JSON calls (the store's MultiplayerService) */
export type GovernanceHost = IdentityHost;

export interface GovernanceHooks {
  /** What the caller or members see of the org's gates changed: read it again (null: every org — the caller's 2FA) */
  changed?(orgId: string | null): void | Promise<void>;
  /** Shared files the server refused with a gate try again (null: every org's) */
  retry?(orgId: string | null): void;
}

const seg = (s: unknown, what: string): string => {
  if (typeof s !== "string" || !s || s.length > 256) throw new StoreError("invalid", `bad ${what}`, { code: "invalid", field: what });
  return encodeURIComponent(s);
};

const domainSeg = (d: unknown): string => {
  const n = typeof d === "string" ? normalizeDomain(d) : null;
  if (!n) throw new StoreError("invalid", "Enter a domain like acme.com", { code: "invalid", field: "domain" });
  return encodeURIComponent(n);
};

const str = (v: unknown, max: number): string | undefined => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);

/** A 6-digit code or a recovery code; the server checks it (and counts failures) */
const codeOf = (code: unknown): { code: string } => {
  const c = typeof code === "string" ? code.trim() : "";
  if (!c || c.length > 32) throw new StoreError("invalid", "Enter the 6-digit code from your authenticator app", { code: "invalid", field: "code" });
  return { code: c };
};

/** IdpConfigInput as the server takes it (round 4's keys plus `name`); with a tenant, `{name}` alone renames */
function cleanIdpInput(input: unknown, renaming: boolean): Partial<I.IdpConfigInput> {
  const i = (input && typeof input === "object" ? input : {}) as Partial<Record<keyof I.IdpConfigInput, unknown>>;
  const name = typeof i.name === "string" ? i.name.trim().slice(0, 100) : undefined;
  if (renaming && i.provider === undefined && name !== undefined) return { name };
  const provider = typeof i.provider === "string" && i.provider in IDP_PROVIDER_LABEL ? (i.provider as I.IdpProvider) : null;
  if (!provider) throw new StoreError("invalid", "Choose an identity provider", { code: "invalid", field: "provider" });
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
  if (name !== undefined) out.name = name;
  return out;
}

function cleanPolicy(input: unknown): G.InternalPolicyInput {
  const i = (input && typeof input === "object" ? input : {}) as Partial<Record<keyof G.InternalPolicyInput, unknown>>;
  const title = typeof i.title === "string" ? i.title.trim() : "";
  const text = typeof i.text === "string" ? i.text.trim() : "";
  if (!title || title.length > POLICY_TITLE_MAX) throw new StoreError("invalid", "Enter a title", { code: "invalid", field: "title" });
  if (!text || text.length > POLICY_TEXT_MAX) throw new StoreError("invalid", "Enter the policy's text", { code: "invalid", field: "text" });
  if (typeof i.audience !== "string" || !(i.audience in POLICY_AUDIENCE_LABEL)) throw new StoreError("invalid", "Choose who must agree", { code: "invalid", field: "audience" });
  if (typeof i.cadence !== "string" || !(i.cadence in POLICY_CADENCE_LABEL)) throw new StoreError("invalid", "Choose how often", { code: "invalid", field: "cadence" });
  return { title, text, audience: i.audience as G.PolicyAudience, cadence: i.cadence as G.PolicyCadence };
}

const LOG_FILTERS = ["token", "token_name", "user_email", "ip_address", "token_type", "event_source", "date_range", "cursor"] as const;

function logQuery(q: unknown): string {
  const query = (q && typeof q === "object" ? q : {}) as Record<string, unknown>;
  const p = new URLSearchParams();
  for (const k of LOG_FILTERS) if (typeof query[k] === "string" && query[k]) p.set(k, (query[k] as string).slice(0, 512));
  if (typeof query.limit === "number" && Number.isFinite(query.limit)) p.set("limit", String(Math.max(1, Math.min(100, Math.floor(query.limit)))));
  const s = p.toString();
  return s ? `?${s}` : "";
}

export function governanceRepository(host: GovernanceHost, hooks: GovernanceHooks = {}): GovernanceRepository {
  const admin = (orgId: unknown) => `/orgs/${seg(orgId, "org")}/admin`;
  const call = <T>(method: string, path: string, body?: unknown): Promise<T> => {
    if (!host.signedIn) return Promise.reject(new StoreError("offline", "Log in to manage your organization"));
    return host.call<T>(method, path, body);
  };
  const changed = async (orgId: string | null) => {
    try {
      await hooks.changed?.(orgId);
    } catch {
      // a refresh is best effort
    }
  };
  return {
    // ---- admin
    overview: async (orgId) => call<G.GovernanceOverview>("GET", `${admin(orgId)}/governance`),
    setGovernancePlus: async (orgId, on) => {
      if (typeof on !== "boolean") throw new StoreError("invalid", "governancePlus is true or false", { code: "invalid", field: "governancePlus" });
      const o = await call<G.GovernanceOverview>("PUT", `${admin(orgId)}/governance`, { governancePlus: on });
      await changed(orgId);
      return o;
    },
    setIpAllowlist: async (orgId, input) => {
      const ranges = Array.isArray(input?.ranges) ? input.ranges.filter((r): r is string => typeof r === "string").map((r) => r.trim()).filter(Boolean) : [];
      const list = await call<G.IpAllowlist>("PUT", `${admin(orgId)}/ip-allowlist`, { enabled: input?.enabled === true, ranges });
      await changed(orgId);
      return list;
    },
    addNetworkRange: async (orgId, cidr) => {
      if (typeof cidr !== "string" || !cidr.trim()) throw new StoreError("invalid", "Enter an IP range like 203.0.113.0/24", { code: "invalid", field: "cidr" });
      return (await call<{ range: G.NetworkRange }>("POST", `${admin(orgId)}/network-ranges`, { cidr: cidr.trim() })).range;
    },
    setNetworkRange: async (orgId, rangeId, state) => {
      if (state !== "testing" && state !== "enforced" && state !== "disabled") throw new StoreError("invalid", "state is testing, enforced or disabled", { code: "invalid", field: "state" });
      return (await call<{ range: G.NetworkRange }>("PATCH", `${admin(orgId)}/network-ranges/${seg(rangeId, "range")}`, { state })).range;
    },
    removeNetworkRange: async (orgId, rangeId) => void (await call("DELETE", `${admin(orgId)}/network-ranges/${seg(rangeId, "range")}`)),
    policies: async (orgId) => (await call<{ policies: G.InternalPolicy[] }>("GET", `${admin(orgId)}/policies`)).policies,
    createPolicy: async (orgId, input) => {
      const { policy } = await call<{ policy: G.InternalPolicy }>("POST", `${admin(orgId)}/policies`, cleanPolicy(input));
      await changed(orgId);
      return policy;
    },
    setPolicyEnabled: async (orgId, policyId, enabled) => {
      if (typeof enabled !== "boolean") throw new StoreError("invalid", "enabled is true or false", { code: "invalid", field: "enabled" });
      const { policy } = await call<{ policy: G.InternalPolicy }>("PATCH", `${admin(orgId)}/policies/${seg(policyId, "policy")}`, { enabled });
      await changed(orgId);
      return policy;
    },
    setGuestExpiration: async (orgId, userIds, expiresAt) => {
      const ids = Array.isArray(userIds) ? [...new Set(userIds.filter((u): u is string => typeof u === "string" && !!u))] : [];
      if (!ids.length) throw new StoreError("invalid", "Choose the guests", { code: "invalid", field: "userIds" });
      if (expiresAt !== null && (typeof expiresAt !== "number" || !Number.isFinite(expiresAt))) throw new StoreError("invalid", "Choose a date", { code: "invalid", field: "expiresAt" });
      await call("PUT", `${admin(orgId)}/guests/expiration`, { userIds: ids, expiresAt });
    },
    ekm: async (orgId) => call<G.EkmStatus>("GET", `${admin(orgId)}/key-management`),
    enableEkm: async (orgId, input) => {
      if (input?.source !== "managed") throw new StoreError("invalid", "source is managed", { code: "invalid", field: "source" });
      return call<G.EkmStatus>("PUT", `${admin(orgId)}/key-management`, { source: "managed" });
    },
    encryptNext: async (orgId) => call<G.EkmStatus>("POST", `${admin(orgId)}/key-management/encrypt-next`),
    developerLogs: async (orgId, query) => (await call<G.DeveloperLogsResponse>("GET", `${admin(orgId)}/developer-logs${logQuery(query)}`)).meta,
    idps: async (orgId) => (await call<{ idps: I.IdpConfig[] }>("GET", `${admin(orgId)}/identity/idps`)).idps,
    saveIdp: async (orgId, tenantId, input) => {
      const body = cleanIdpInput(input, tenantId !== null);
      const { idp } =
        tenantId === null || tenantId === undefined
          ? await call<{ idp: I.IdpConfig }>("POST", `${admin(orgId)}/identity/idps`, body)
          : await call<{ idp: I.IdpConfig }>("PUT", `${admin(orgId)}/identity/idps/${seg(tenantId, "tenantId")}`, body);
      await changed(orgId);
      return idp;
    },
    refreshIdp: async (orgId, tenantId) => (await call<{ idp: I.IdpConfig }>("POST", `${admin(orgId)}/identity/idps/${seg(tenantId, "tenantId")}/refresh`)).idp,
    removeIdp: async (orgId, tenantId) => {
      await call("DELETE", `${admin(orgId)}/identity/idps/${seg(tenantId, "tenantId")}`);
      await changed(orgId);
    },
    generateIdpScimToken: async (orgId, tenantId) => call<I.ScimTokenCreated>("POST", `${admin(orgId)}/identity/idps/${seg(tenantId, "tenantId")}/scim-token`),
    revokeIdpScimToken: async (orgId, tenantId) => void (await call("DELETE", `${admin(orgId)}/identity/idps/${seg(tenantId, "tenantId")}/scim-token`)),
    mapDomain: async (orgId, domain, tenantId) => {
      if (tenantId !== null && (typeof tenantId !== "string" || !tenantId)) throw new StoreError("invalid", "Choose an identity provider", { code: "invalid", field: "tenantId" });
      const r = await call<{ domain: I.OrgDomain; tenantId: string | null }>("PUT", `${admin(orgId)}/domains/${domainSeg(domain)}/idp`, { tenantId });
      await changed(orgId);
      // The domain as Admin lists it, with the IdP it now maps to (`tenantId`, ours beside OrgDomain's fields)
      return { ...r.domain, tenantId: r.tenantId } as I.OrgDomain;
    },
    // ---- members
    pendingPolicies: async (orgId) => (await call<{ policies: G.PolicyPrompt[] }>("GET", `/orgs/${seg(orgId, "org")}/policies/pending`)).policies,
    acknowledgePolicy: async (orgId, policyId) => {
      await call("POST", `/orgs/${seg(orgId, "org")}/policies/${seg(policyId, "policy")}/acknowledge`);
      await changed(orgId);
      hooks.retry?.(orgId);
    },
    // ---- the caller's account
    twoFactor: async () => call<G.TwoFactorStatus>("GET", "/me/two-factor"),
    setupTwoFactor: async () => call<G.TwoFactorSetup>("POST", "/me/two-factor/setup"),
    enableTwoFactor: async (code) => {
      const r = await call<G.TwoFactorEnabled>("POST", "/me/two-factor/enable", codeOf(code));
      await changed(null);
      hooks.retry?.(null);
      return r;
    },
    regenerateRecoveryCodes: async (code) => call<G.TwoFactorEnabled>("POST", "/me/two-factor/recovery-codes", codeOf(code)),
    disableTwoFactor: async (code) => {
      await call("DELETE", "/me/two-factor", codeOf(code));
      await changed(null);
    },
  };
}

/** The org reads a gate change needs: `OrgInfo.gate` (`org.updated`) and the list's `OrgSummary.gate` (`orgs.changed`) */
export async function refreshGates(org: { notice(n: { t: "org"; what: string; orgId?: string }): Promise<void> }, orgId: string | null): Promise<void> {
  if (orgId) await org.notice({ t: "org", what: "org", orgId });
  await org.notice({ t: "org", what: "orgs" });
}

/** The same refusal said again within this long reads nothing and says nothing (one blocked screen makes many calls) */
export const GATE_EVENT_GAP_MS = 10_000;

/**
 * MultiplayerService's Governance+ refusals as org events (topic `org`): for an org gate the org is read again first,
 * then `access.blocked` goes out. `network_restricted` refreshes nothing (every org route would refuse it too).
 */
export function governanceEvents(
  mp: { onGovernance(listener: (e: GovernanceRefusal) => void): Unsubscribe },
  org: { notice(n: { t: "org"; what: string; orgId?: string }): Promise<void> },
  now: () => number = Date.now,
): { onEvent(listener: (e: OrgEvent) => void): Unsubscribe; close(): void } {
  const listeners = new Set<(e: OrgEvent) => void>();
  const said = new Map<string, number>();
  const off = mp.onGovernance((e) => {
    const key = `${e.orgId ?? ""}|${e.code}|${e.fileKey ?? ""}`;
    const t = now();
    if (t - (said.get(key) ?? -Infinity) < GATE_EVENT_GAP_MS) return;
    said.set(key, t);
    if (said.size > 256) for (const [k, at] of said) if (t - at >= GATE_EVENT_GAP_MS) said.delete(k);
    const event: OrgEvent = { type: "access.blocked", orgId: e.orgId, code: e.code, ...(e.gate ? { gate: e.gate } : {}), ...(e.fileKey ? { fileKey: e.fileKey } : {}) };
    const refresh = e.code === "network_restricted" || e.code === "key_unavailable" || !e.orgId ? Promise.resolve() : refreshGates(org, e.orgId).catch(() => {});
    void refresh.then(() => {
      for (const l of [...listeners]) {
        try {
          l(event);
        } catch {
          // a listener's own failure
        }
      }
    });
  });
  return {
    onEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: () => {
      off();
      listeners.clear();
    },
  };
}
