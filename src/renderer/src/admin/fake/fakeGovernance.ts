/**
 * Governance+ on the fake org (docs/governance.md; Phase 7 round 14h): an in-memory `GovernanceRepository` with the
 * server's rules the Admin views show — every route but `overview` / `setGovernancePlus` refused without the add-on,
 * removal refused while key management is on (and the idle timeout clamped), the IP allowlist normalized and diffed
 * (one log per range), network ranges no wider than /16 (v4) or /32 (v6) starting in Testing, policies never edited,
 * guest expiration dates for guests only, key management turned on once and files encrypted one per call, developer
 * logs filtered by prefix (commas mean OR) and paged, several IdPs with their domains and a SCIM token each. Every write
 * logs §1 / §3's action.
 */
import type { GovernanceRepository } from "@shared/org/repositories";
import type * as G from "@shared/org/governance";
import { GUEST_EXPIRY_MAX_DAYS, POLICY_TEXT_MAX, POLICY_TITLE_MAX, normalizeCidr, validIdleHours } from "@shared/org/governance";
import type * as I from "@shared/org/identity";
import type * as O from "@shared/org/types";
import { FAKE_ORIGIN, FakeIdentityError, type FakeIdentity } from "./fakeIdentity";
import type { Seed } from "./seed";

type Log = (type: O.ActivityAction, entity: O.ActivityLog["entity"], details?: Record<string, unknown>, teamId?: string | null) => void;
type ScimIdp = I.IdpConfig & { scim: { baseUrl: string; token: I.ScimTokenInfo | null } };

const DAY = 86_400_000;

/** Figma's entity `policy_acknowledgement_config` (as server/src/activity.ts `policyEntity`) */
const policyEntity = (p: G.InternalPolicy): O.ActivityLog["entity"] => ({
  type: "policy_acknowledgement_config", id: p.id, name: p.title, title: p.title, audience: p.audience, cadence: p.cadence,
  enabled_at: p.enabledAt === null ? "" : new Date(p.enabledAt).toISOString(),
  enabled_status: p.enabledAt !== null && p.disabledAt === null ? "enabled" : "disabled",
});

export interface GovernanceState {
  governancePlus: boolean;
  /** The caller's address as the Worker would see it */
  callerIp: string;
  allowlist: G.IpAllowlist;
  networkRanges: G.NetworkRange[];
  policies: G.InternalPolicy[];
  ekm: { enabled: boolean; state: "ok" | "unavailable" | null; checkedAt: number | null };
  /** The org's files and whether each is encrypted (key management's progress) */
  files: { key: string; name: string; encrypted: boolean }[];
  developerLogs: G.DeveloperLogItem[];
  /** IdPs after the oldest (the oldest is the identity fake's `idp`) */
  extraIdps: I.IdpConfig[];
  /** domain → tenant id */
  domainIdp: Map<string, string>;
  /** tenant id → its live SCIM token (the oldest IdP's is the identity fake's `scimToken`) */
  scimTokens: Map<string, I.ScimTokenInfo>;
  /** The caller's own 2FA (Settings › Security) */
  twoFactorPending: string | null;
}

export function seedGovernance(s: Seed, now: number, on = false): GovernanceState {
  const people = s.people.filter((p) => !p.pending && p.role !== "guest");
  const names = ["CI deploys", "Design tokens sync", "Figma to Jira", "Local MCP"];
  const events = ["/v1/files/:key", "/v1/files/:key/nodes", "/v1/images/:key", "/v1/files/:key/variables/local", "/v1/teams/:team_id/projects", "/v1/activity_logs"];
  const tools = ["get_design_context", "get_screenshot", "get_variable_defs"];
  const places: [string, string, string][] = [["Istanbul", "34", "TR"], ["Berlin", "BE", "DE"], ["Ashburn", "VA", "US"], ["London", "ENG", "GB"]];
  const developerLogs: G.DeveloperLogItem[] = Array.from({ length: 80 }, (_, i) => {
    const p = people[(i * 7) % people.length];
    const mcp = i % 5 === 4;
    const kind = mcp ? "personal_access_token" : (["plan_access_token", "personal_access_token", "oauth_token", "session"] as const)[i % 4];
    const [city, region, country] = places[i % places.length];
    const plan = kind === "plan_access_token";
    return {
      uuid: `dl-${String(i + 1).padStart(4, "0")}`,
      timestamp: new Date(now - i * 9 * 3_600_000 - (i % 7) * 60_000).toISOString(),
      action: { event_name: mcp ? tools[i % tools.length] : events[i % events.length], event_source: mcp ? "mcp_server" : "rest_api" },
      actor: { user_id: plan ? null : p.id, user_name: plan ? null : p.name, token_name: kind === "session" ? null : names[i % names.length], token_type: kind, user_email: plan ? null : p.email },
      resource: { id_or_key: `f${String((i % 24) + 1).padStart(3, "0")}`, name: `File ${(i % 24) + 1}`, type: "file", org_id: s.orgId },
      context: { ip_address: i % 3 === 0 ? "2001:db8:4::1a" : `198.51.100.${10 + (i % 40)}`, city, country_region: region, country },
    };
  });
  const admin = s.people.find((p) => p.role === "admin")!;
  const by: O.PersonRef = { id: admin.id, email: admin.email, name: admin.name, picture: admin.picture, role: admin.role };
  return {
    governancePlus: on,
    callerIp: "203.0.113.24",
    allowlist: { enabled: false, ranges: [] },
    networkRanges: [],
    policies: [{
      id: "pol1", title: "Acceptable use", text: "Use the organization's files for its work only. Don't share customer data outside the organization.",
      audience: "everyone", cadence: "yearly", enabledAt: now - 40 * DAY, disabledAt: null, createdBy: by, createdAt: now - 40 * DAY, acknowledgedCount: 31,
    }],
    ekm: { enabled: false, state: null, checkedAt: null },
    files: Array.from({ length: 24 }, (_, i) => ({ key: `f${String(i + 1).padStart(3, "0")}`, name: `File ${i + 1}`, encrypted: false })),
    developerLogs,
    extraIdps: [],
    domainIdp: new Map(),
    scimTokens: new Map(),
    twoFactorPending: null,
  };
}

export function fakeGovernance(s: Seed, st: GovernanceState, ident: FakeIdentity, me: string, log: Log, wait: <T>(v: T) => Promise<T>, now: () => number): GovernanceRepository {
  const org = () => ({ type: "org" as const, id: s.orgId, name: s.orgName });
  const fail = (code: string, message: string, detail?: unknown) => new FakeIdentityError(code, message, detail);
  const requireGp = () => {
    if (!st.governancePlus) throw fail("forbidden", "Requires Governance+", { code: "governance_plus_required" });
  };
  const ref = (id: string): O.PersonRef => {
    const p = s.people.find((x) => x.id === id)!;
    return { id: p.id, email: p.email, name: p.name, picture: p.picture, role: p.role };
  };
  const ekmStatus = (encrypting: string | null = null): G.EkmStatus => ({
    enabled: st.ekm.enabled, source: st.ekm.enabled ? "managed" : null, state: st.ekm.state, checkedAt: st.ekm.checkedAt,
    files: { total: st.files.length, encrypted: st.files.filter((f) => f.encrypted).length }, encrypting,
  });
  const overview = (): G.GovernanceOverview => ({
    governancePlus: st.governancePlus,
    ipAllowlist: st.allowlist,
    callerIp: st.callerIp,
    networkRanges: st.networkRanges,
    policies: st.policies,
    ekm: ekmStatus(),
    guestsWithout2fa: s.people.filter((p) => p.role === "guest" && !p.pending && !p.twoFactor).length,
  });

  // ---- IdPs: the identity fake's `idp` is the oldest; the rest live here
  const istate = ident.state;
  const allIdps = (): I.IdpConfig[] => (istate.idp ? [istate.idp, ...st.extraIdps] : [...st.extraIdps]);
  const withDomains = (c: I.IdpConfig): ScimIdp => ({
    ...c,
    name: c.name ?? "",
    domains: istate.domains.filter((d) => st.domainIdp.get(d.domain) === c.tenantId).map((d) => d.domain),
    scim: { baseUrl: `${FAKE_ORIGIN}/scim/v2/${c.tenantId}`, token: istate.idp?.tenantId === c.tenantId ? istate.scimToken : st.scimTokens.get(c.tenantId) ?? null },
  });
  const findIdp = (tenantId: string): I.IdpConfig => {
    const c = allIdps().find((x) => x.tenantId === tenantId);
    if (!c) throw fail("not-found", "No such identity provider");
    return c;
  };
  const putIdp = (c: I.IdpConfig) => {
    if (istate.idp?.tenantId === c.tenantId) istate.idp = c;
    else st.extraIdps = st.extraIdps.map((x) => (x.tenantId === c.tenantId ? c : x));
  };
  /** In use: the only IdP, or one with mapped domains, while members must log in with SAML SSO */
  const inUse = (tenantId: string) => s.settings.authMethod === "saml" && (allIdps().length === 1 || [...st.domainIdp.values()].includes(tenantId));

  const repo: GovernanceRepository = {
    // ---- admin
    async overview() {
      return wait(overview());
    },
    async setGovernancePlus(_org, on) {
      if (on === st.governancePlus) return wait(overview());
      if (!on && st.ekm.enabled) throw fail("conflict", "Key management can't be turned off, so Governance+ can't be removed");
      st.governancePlus = on;
      log(on ? "governance_plus_enable" : "governance_plus_disable", org());
      const h = s.settings.idleSessionTimeoutHours;
      if (!on && h !== null && !validIdleHours(h, false)) {
        const to = Math.min(336, Math.max(12, Math.ceil(h)));
        s.settings = { ...s.settings, idleSessionTimeoutHours: to };
        log("idle_timeout_setting_change", org(), { setting: "idleSessionTimeoutHours", from: h, to });
      }
      return wait(overview());
    },
    async setIpAllowlist(_org, input) {
      requireGp();
      const ranges: string[] = [];
      for (const raw of input.ranges) {
        const c = normalizeCidr(raw, "allowlist");
        if (!c) throw fail("invalid", `"${raw.trim()}" isn't an IP address or range`, { field: "ranges", value: raw });
        if (!ranges.includes(c)) ranges.push(c);
      }
      if (ranges.length > 200) throw fail("invalid", "Add at most 200 IP addresses and ranges");
      if (input.enabled && ranges.length === 0) throw fail("invalid", "Add at least one IP address or range");
      if (input.enabled && !st.allowlist.enabled && (istate.domains.length === 0 || istate.domains.some((d) => !d.verified))) {
        throw fail("conflict", "Verify every domain of the organization before turning on the IP allowlist", { code: "domain_unverified" });
      }
      const before = st.allowlist;
      const kept = before.ranges.filter((r) => ranges.includes(r.cidr));
      for (const r of before.ranges.filter((x) => !ranges.includes(x.cidr))) log("ip_allowlist_range_delete", org(), { range: r.cidr });
      const added = ranges.filter((c) => !before.ranges.some((r) => r.cidr === c)).map((cidr, i): G.IpRange => ({ id: `ip${now()}-${i}`, cidr, createdAt: now(), createdBy: ref(me) }));
      for (const r of added) log("ip_allowlist_range_create", org(), { range: r.cidr });
      if (before.enabled !== input.enabled) log("ip_allowlist_setting_change", org(), { from: before.enabled, to: input.enabled });
      st.allowlist = { enabled: input.enabled, ranges: ranges.map((c) => kept.find((r) => r.cidr === c) ?? added.find((r) => r.cidr === c)!) };
      return wait(st.allowlist);
    },
    async addNetworkRange(_org, cidr) {
      requireGp();
      const c = normalizeCidr(cidr, "network");
      if (!c) throw fail("invalid", "Use an IPv4 range of /16 or narrower, or an IPv6 range of /32 or narrower", { field: "cidr" });
      if (st.networkRanges.some((r) => r.cidr === c)) throw fail("conflict", `${c} is already in the list`);
      // The shadow count a new range would have collected (deterministic for the demo)
      const range: G.NetworkRange = { id: `net${st.networkRanges.length + 1}-${now()}`, cidr: c, createdAt: now(), createdBy: ref(me), state: "testing", wouldBlock7d: (c.length * 7) % 5 };
      st.networkRanges = [...st.networkRanges, range];
      log("network_access_restriction_range_create", org(), { range: c, state: "testing" });
      return wait(range);
    },
    async setNetworkRange(_org, id, state) {
      requireGp();
      const r = st.networkRanges.find((x) => x.id === id);
      if (!r) throw fail("not-found", "No such range");
      if (r.state !== state) {
        const before = st.networkRanges.some((x) => x.state === "enforced");
        log("network_access_restriction_range_update", org(), { range: r.cidr, from: r.state, to: state });
        r.state = state;
        const after = st.networkRanges.some((x) => x.state === "enforced");
        if (before !== after) log("ip_restriction_change", org(), { from: before, to: after });
      }
      return wait(r);
    },
    async removeNetworkRange(_org, id) {
      requireGp();
      const r = st.networkRanges.find((x) => x.id === id);
      if (!r) throw fail("not-found", "No such range");
      const before = st.networkRanges.some((x) => x.state === "enforced");
      st.networkRanges = st.networkRanges.filter((x) => x !== r);
      log("network_access_restriction_range_delete", org(), { range: r.cidr, state: r.state });
      const after = st.networkRanges.some((x) => x.state === "enforced");
      if (before !== after) log("ip_restriction_change", org(), { from: before, to: after });
      return wait(undefined);
    },
    async policies() {
      requireGp();
      return wait(st.policies);
    },
    async createPolicy(_org, input) {
      requireGp();
      const title = input.title.trim();
      if (!title || title.length > POLICY_TITLE_MAX) throw fail("invalid", `The title is 1 to ${POLICY_TITLE_MAX} characters`, { field: "title" });
      if (!input.text.trim() || input.text.length > POLICY_TEXT_MAX) throw fail("invalid", `The text is 1 to ${POLICY_TEXT_MAX.toLocaleString("en-US")} characters`, { field: "text" });
      const p: G.InternalPolicy = { id: `pol${st.policies.length + 1}-${now()}`, title, text: input.text, audience: input.audience, cadence: input.cadence, enabledAt: now(), disabledAt: null, createdBy: ref(me), createdAt: now(), acknowledgedCount: 0 };
      st.policies = [p, ...st.policies];
      log("policy_create", policyEntity(p));
      return wait(p);
    },
    async setPolicyEnabled(_org, id, enabled) {
      requireGp();
      const p = st.policies.find((x) => x.id === id);
      if (!p) throw fail("not-found", "No such policy");
      if ((p.enabledAt !== null && p.disabledAt === null) !== enabled) {
        if (enabled) Object.assign(p, { enabledAt: now(), disabledAt: null });
        else p.disabledAt = now();
        log("policy_update", policyEntity(p), { enabled });
      }
      return wait(p);
    },
    async setGuestExpiration(_org, userIds, expiresAt) {
      requireGp();
      if (expiresAt !== null && (expiresAt <= now() || expiresAt > now() + GUEST_EXPIRY_MAX_DAYS * DAY)) throw fail("invalid", "Choose a date in the future, within 10 years", { field: "expiresAt" });
      const guests = userIds.map((id) => s.people.find((p) => p.id === id));
      if (guests.some((p) => !p || p.role !== "guest")) throw fail("invalid", "Only guests have an access expiration date", { field: "userIds" });
      for (const p of guests as O.AdminPerson[]) {
        const from = p.guestExpiresAt ?? null;
        if (from === expiresAt) continue;
        p.guestExpiresAt = expiresAt;
        log("org_user_guest_expiration_change", { type: "user", id: p.id, name: p.name ?? p.email, email: p.email }, { from, to: expiresAt });
      }
      return wait(undefined);
    },
    async ekm() {
      requireGp();
      return wait(ekmStatus());
    },
    async enableEkm(_org, input) {
      requireGp();
      if (st.ekm.enabled) throw fail("conflict", "Key management is already on");
      if (input.source !== "managed") throw fail("invalid", "Only managed keys are available", { field: "source" });
      st.ekm = { enabled: true, state: "ok", checkedAt: now() };
      log("ekm_enable", org(), { source: "managed" });
      return wait(ekmStatus());
    },
    async encryptNext() {
      requireGp();
      if (!st.ekm.enabled) throw fail("conflict", "Turn on key management first");
      const f = st.files.find((x) => !x.encrypted);
      if (!f) return wait(ekmStatus());
      f.encrypted = true;
      log("fig_file_encrypt", { type: "file", id: f.key, name: f.name, key: f.key });
      return wait(ekmStatus(f.key));
    },
    async developerLogs(_org, q) {
      requireGp();
      const prefixes = (v: string | undefined) => (v ?? "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
      const match = (v: string | null, list: string[]) => list.length === 0 || (v !== null && list.some((x) => v.toLowerCase().startsWith(x)));
      const names = prefixes(q.token_name), emails = prefixes(q.user_email), ips = prefixes(q.ip_address);
      const since = now() - (q.date_range === "LAST_24H" ? 1 : q.date_range === "LAST_7D" ? 7 : 30) * DAY;
      const rows = st.developerLogs.filter((r) =>
        match(r.actor.token_name, names) && match(r.actor.user_email, emails) && match(r.context.ip_address, ips) &&
        (!q.token_type || r.actor.token_type === q.token_type.toLowerCase()) &&
        (!q.event_source || r.action.event_source === q.event_source.toLowerCase()) &&
        Date.parse(r.timestamp) >= since
      );
      const limit = Math.min(100, Math.max(1, q.limit ?? 25));
      const from = q.cursor ? Number(q.cursor) : 0;
      const items = rows.slice(from, from + limit);
      const more = from + limit < rows.length;
      return wait({ items, cursor: more ? String(from + limit) : null, has_more: more });
    },
    async idps() {
      requireGp();
      return wait(allIdps().map(withDomains));
    },
    async saveIdp(_org, tenantId, input) {
      requireGp();
      const nameOnly = Object.keys(input).every((k) => k === "name");
      if (tenantId === null) {
        if (nameOnly) throw fail("invalid", "Choose the identity provider and its metadata");
        const c = ident.makeIdp({ ...input, name: input.name ?? "" }, null, null);
        if (allIdps().some((x) => x.idpEntityId === c.idpEntityId)) throw fail("conflict", "This identity provider is already configured");
        if (istate.idp === null) istate.idp = c;
        else st.extraIdps = [...st.extraIdps, c];
        log("idp_config_create", org(), { tenant_id: c.tenantId, provider: c.provider, idp_entity_id: c.idpEntityId, name: c.name });
        return wait(withDomains(c));
      }
      const had = findIdp(tenantId);
      if (nameOnly) {
        const c = { ...had, name: (input.name ?? "").trim(), updatedAt: now() };
        putIdp(c);
        log("idp_config_update", org(), { tenant_id: tenantId, name: c.name });
        return wait(withDomains(c));
      }
      if (inUse(tenantId)) throw fail("conflict", "Members must log in with SAML SSO through this identity provider. Change the authentication method first.");
      const c = ident.makeIdp(input, tenantId, had);
      putIdp(c);
      log("idp_config_update", org(), { tenant_id: tenantId, provider: c.provider, idp_entity_id: c.idpEntityId, ...(input.name !== undefined ? { name: input.name } : {}) });
      return wait(withDomains(c));
    },
    async refreshIdp(_org, tenantId) {
      requireGp();
      const had = findIdp(tenantId);
      if (!had.metadataUrl) throw fail("invalid", "This configuration has no metadata URL");
      const c = { ...had, updatedAt: now() };
      putIdp(c);
      log("idp_config_update", org(), { tenant_id: tenantId, refreshed: true });
      return wait(withDomains(c));
    },
    async removeIdp(_org, tenantId) {
      requireGp();
      findIdp(tenantId);
      if (inUse(tenantId)) throw fail("conflict", "Members must log in with SAML SSO through this identity provider. Change the authentication method first.");
      for (const [d, t] of [...st.domainIdp]) {
        if (t !== tenantId) continue;
        st.domainIdp.delete(d);
        log("org_domain_idp_mapping_change", org(), { domain: d, from: tenantId, to: null });
      }
      if (istate.idp?.tenantId === tenantId) {
        if (istate.scimToken) log("scim_token_revoke", org(), { tenant_id: tenantId });
        // The next oldest becomes the round-4 IdP
        const next = st.extraIdps[0] ?? null;
        istate.idp = next;
        istate.scimToken = next ? st.scimTokens.get(next.tenantId) ?? null : null;
        if (next) {
          st.extraIdps = st.extraIdps.slice(1);
          st.scimTokens.delete(next.tenantId);
        }
      } else {
        if (st.scimTokens.has(tenantId)) log("scim_token_revoke", org(), { tenant_id: tenantId });
        st.scimTokens.delete(tenantId);
        st.extraIdps = st.extraIdps.filter((x) => x.tenantId !== tenantId);
      }
      log("idp_config_delete", org(), { tenant_id: tenantId });
      return wait(undefined);
    },
    async generateIdpScimToken(_org, tenantId) {
      requireGp();
      findIdp(tenantId);
      const created = ident.newScimToken();
      const oldest = istate.idp?.tenantId === tenantId;
      if (oldest ? istate.scimToken : st.scimTokens.has(tenantId)) log("scim_token_revoke", org(), { tenant_id: tenantId });
      if (oldest) istate.scimToken = created.info;
      else st.scimTokens.set(tenantId, created.info);
      log("scim_token_generate", org(), { tenant_id: tenantId });
      return wait(created);
    },
    async revokeIdpScimToken(_org, tenantId) {
      requireGp();
      const oldest = istate.idp?.tenantId === tenantId;
      if (!(oldest ? istate.scimToken : st.scimTokens.has(tenantId))) return wait(undefined);
      if (oldest) istate.scimToken = null;
      else st.scimTokens.delete(tenantId);
      log("scim_token_revoke", org(), { tenant_id: tenantId });
      return wait(undefined);
    },
    async mapDomain(_org, domain, tenantId) {
      requireGp();
      const d = istate.domains.find((x) => x.domain === domain);
      if (!d) throw fail("not-found", `${domain} isn't added`);
      if (tenantId !== null) {
        const c = findIdp(tenantId);
        if (s.settings.authMethod === "saml" && c.testedAt === null) throw fail("conflict", "Test SAML SSO first");
      }
      const from = st.domainIdp.get(domain) ?? null;
      if (from !== tenantId) {
        if (tenantId === null) st.domainIdp.delete(domain);
        else st.domainIdp.set(domain, tenantId);
        log("org_domain_idp_mapping_change", org(), { domain, from, to: tenantId });
      }
      return wait(d);
    },
    // ---- members
    async pendingPolicies() {
      if (!st.governancePlus) return wait([]);
      return wait(st.policies.filter((p) => p.disabledAt === null && p.enabledAt !== null).map((p) => ({ id: p.id, title: p.title, text: p.text })));
    },
    async acknowledgePolicy(_org, id) {
      const p = st.policies.find((x) => x.id === id && x.disabledAt === null);
      if (!p) throw fail("not-found", "No such policy");
      p.acknowledgedCount++;
      log("policy_acknowledge", policyEntity(p));
      return wait(undefined);
    },
    // ---- the caller's account (not Admin's; minimal)
    async twoFactor() {
      const p = s.people.find((x) => x.id === me)!;
      return wait({ enabled: Boolean(p.twoFactor), enabledAt: p.twoFactor ? now() - 30 * DAY : null, recoveryCodesLeft: p.twoFactor ? 10 : 0 });
    },
    async setupTwoFactor() {
      st.twoFactorPending = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
      const p = s.people.find((x) => x.id === me)!;
      return wait({ secret: st.twoFactorPending, otpauthUrl: `otpauth://totp/DesignerV2:${encodeURIComponent(p.email)}?secret=${st.twoFactorPending}&issuer=DesignerV2` });
    },
    async enableTwoFactor(code) {
      if (!st.twoFactorPending || !/^\d{6}$/.test(code)) throw fail("invalid", "That code didn't work. Try again.", { code: "two_factor_invalid" });
      s.people.find((x) => x.id === me)!.twoFactor = true;
      st.twoFactorPending = null;
      return wait({ recoveryCodes: Array.from({ length: 10 }, (_, i) => `ab${i}c-d${i}ef`) });
    },
    async regenerateRecoveryCodes() {
      return wait({ recoveryCodes: Array.from({ length: 10 }, (_, i) => `gh${i}j-k${i}mn`) });
    },
    async disableTwoFactor() {
      s.people.find((x) => x.id === me)!.twoFactor = false;
      return wait(undefined);
    },
  };
  return repo;
}
