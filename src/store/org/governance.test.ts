/**
 * Round 14e — the store's `governance` repository (docs/governance.md §4) against the real server handler of rounds
 * 14a–14d (server/src/api.ts `handle` on node:sqlite, fake/real.ts), through LocalStore and over the port: the add-on,
 * the IP allowlist, network ranges, internal policies and their gate, guest expiration, key management, developer logs,
 * multiple IdPs and domain mapping, the caller's 2FA; the refusals as StoreErrors; Governance+'s refusals as org events
 * (`access.blocked`) and as a shared file's `blocked` state (a gate on its route, `key_unavailable` on its socket).
 */
import { MessageChannel } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { base32Decode, totpCode, totpStep } from "../../shared/org/governance";
import type { OrgEvent } from "../../shared/org/repositories";
import { encodeMessage } from "../../shared/schema/codec";
import { StoreClient } from "../../shared/store/client";
import { portTransport, StoreError } from "../../shared/store/protocol";
import type { FileKey, FileMeta } from "../../shared/store/types";
import { httpError, MultiplayerService, type GovernanceRefusal, type MultiplayerHost } from "../multiplayer/service";
import { StoreServer } from "../server";
import { openTestStore, type TestStore } from "../testing/harness";
import { acmeServer, REAL_ORIGIN as ORIGIN, testIdpMetadata as idpMetadata } from "./fake/real";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** No inbox socket leaves the test */
class NoSocket {
  binaryType = "arraybuffer";
  readyState = 0;
  onopen = null;
  onmessage = null;
  onclose = null;
  onerror = null;
  send() {}
  close() {}
}

/** The server's clock, held still for TOTP codes */
const clock = { t: Date.UTC(2026, 9, 12, 9) };

async function world() {
  const a = await acmeServer();
  a.srv.deps.now = () => clock.t;
  return {
    ...a,
    run: (sql: string, ...args: unknown[]) => a.srv.exec(sql, ...args),
    rows: (sql: string, ...args: unknown[]) => a.srv.rows<any>(sql, ...args),
    call: (method: string, path: string, o: { token?: string; body?: unknown } = {}) => a.srv.call(method, path, o.token, o.body),
  };
}

let w: Awaited<ReturnType<typeof world>>;
let t: TestStore;
const log: string[] = [];

beforeEach(async () => {
  vi.stubGlobal("WebSocket", NoSocket);
  clock.t = Date.UTC(2026, 9, 12, 9);
  w = await world();
  log.length = 0;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    log.push(`${init?.method ?? "GET"} ${new URL(String(input)).pathname}${new URL(String(input)).search}`);
    return w.srv.fetch(input, init);
  };
  t = await openTestStore({ fetch });
  await t.api.multiplayer.setSession({ server: ORIGIN, token: w.admin.token });
});

afterEach(async () => {
  await t.close();
  t.dispose();
  vi.unstubAllGlobals();
});

const refusal = async (p: Promise<unknown>): Promise<StoreError> => {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(StoreError);
  return e as StoreError;
};

const settle = async (n = 20) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

describe("governance (docs/governance.md §4, as built §9 14a–14d)", () => {
  it("the add-on: the overview, G+ routes refused without it, Add / Remove", async () => {
    const g = t.api.governance;
    expect(await g.overview(w.orgId)).toMatchObject({ governancePlus: false, ipAllowlist: { enabled: false, ranges: [] }, networkRanges: [], policies: [], guestsWithout2fa: 0, ekm: { enabled: false } });
    const off = await refusal(g.policies(w.orgId));
    expect(off.code).toBe("forbidden");
    expect(off.message).toBe("Requires Governance+");
    expect(off.detail).toMatchObject({ code: "governance_plus_required" });
    expect((await refusal(g.developerLogs(w.orgId, {}))).detail).toMatchObject({ code: "governance_plus_required" });
    expect((await refusal(g.idps(w.orgId))).detail).toMatchObject({ code: "governance_plus_required" });

    const events: OrgEvent[] = [];
    t.store.org.onEvent((e) => events.push(e));
    expect(await g.setGovernancePlus(w.orgId, true)).toMatchObject({ governancePlus: true });
    // The write answers after the org was read again
    expect(events).toContainEqual({ type: "org.updated", orgId: w.orgId });
    expect(await g.policies(w.orgId)).toEqual([]);
    // Not a member's call
    const bob = await w.dev("bob@acme.test");
    await w.call("POST", `/orgs/${w.orgId}/admin/people`, { token: w.admin.token, body: { emails: ["bob@acme.test"], role: "member" } });
    const bobs = await openTestStore({ fetch: w.srv.fetch });
    try {
      await bobs.api.multiplayer.setSession({ server: ORIGIN, token: bob.token });
      expect((await refusal(bobs.api.governance.overview(w.orgId))).detail).toMatchObject({ code: "not_admin" });
    } finally {
      await bobs.close();
      bobs.dispose();
    }
    expect((await g.setGovernancePlus(w.orgId, false)).governancePlus).toBe(false);
    // The store refuses what isn't a boolean before asking
    const before = log.length;
    expect((await refusal(g.setGovernancePlus(w.orgId, "yes" as any))).code).toBe("invalid");
    expect(log.length).toBe(before);
  });

  it("the IP allowlist and network ranges", async () => {
    const g = t.api.governance;
    await g.setGovernancePlus(w.orgId, true);
    const list = await g.setIpAllowlist(w.orgId, { enabled: false, ranges: ["10.0.0.1", " 2001:db8::/32 "] });
    expect(list.enabled).toBe(false);
    expect(list.ranges.map((r) => r.cidr).sort()).toEqual(["10.0.0.1/32", "2001:db8::/32"]);
    expect((await g.setIpAllowlist(w.orgId, { enabled: true, ranges: ["10.0.0.0/8"] })).ranges.map((r) => r.cidr)).toEqual(["10.0.0.0/8"]);
    const bad = await refusal(g.setIpAllowlist(w.orgId, { enabled: true, ranges: ["nope"] }));
    expect(bad.code).toBe("invalid");
    expect(bad.detail).toMatchObject({ field: "ranges" });

    const r = await g.addNetworkRange(w.orgId, "198.51.0.0/16");
    expect(r).toMatchObject({ cidr: "198.51.0.0/16", state: "testing", wouldBlock7d: 0, createdBy: { id: w.admin.id } });
    // Wider than /16: refused by the server
    expect((await refusal(g.addNetworkRange(w.orgId, "10.0.0.0/8"))).code).toBe("invalid");
    expect((await refusal(g.addNetworkRange(w.orgId, "198.51.0.0/16"))).code).toBe("conflict");
    // Enforcing needs 24 h in testing first (review fixes, §2.2)
    expect((await refusal(g.setNetworkRange(w.orgId, r.id, "enforced"))).code).toBe("conflict");
    clock.t += 24 * 3_600_000;
    expect(await g.setNetworkRange(w.orgId, r.id, "enforced")).toMatchObject({ id: r.id, state: "enforced" });
    expect((await g.overview(w.orgId)).networkRanges.map((x) => x.state)).toEqual(["enforced"]);
    await g.removeNetworkRange(w.orgId, r.id);
    expect((await g.overview(w.orgId)).networkRanges).toEqual([]);
    expect((await refusal(g.setNetworkRange(w.orgId, r.id, "on" as any))).code).toBe("invalid");
  });

  it("internal policies: the gate on org routes, the event, pending, Agree; disable", async () => {
    const g = t.api.governance;
    await g.setGovernancePlus(w.orgId, true);
    const p = await g.createPolicy(w.orgId, { title: "Acceptable use", text: "Be kind.", audience: "everyone", cadence: "once" });
    expect(p).toMatchObject({ title: "Acceptable use", audience: "everyone", cadence: "once", acknowledgedCount: 0, disabledAt: null });
    expect(p.enabledAt).not.toBeNull();
    expect((await refusal(g.createPolicy(w.orgId, { title: "", text: "x", audience: "everyone", cadence: "once" }))).detail).toMatchObject({ field: "title" });

    // Admins are members: the admin is gated now. The refusal carries the gate; the store re-reads the org and says it.
    const events: OrgEvent[] = [];
    t.store.org.onEvent((e) => events.push(e));
    t.store.governanceEvents.onEvent((e) => events.push(e));
    const gated = await refusal(t.store.multiplayer.call("GET", `/orgs/${w.orgId}/teams`));
    expect(gated.code).toBe("forbidden");
    expect(gated.message).toBe("Agree to your organization's policies to continue.");
    expect(gated.detail).toMatchObject({ code: "policy_acknowledgement_required", gate: { kind: "policy", policies: [{ id: p.id, title: "Acceptable use", text: "Be kind." }] } });
    await settle();
    expect(events).toContainEqual({ type: "org.updated", orgId: w.orgId });
    expect(events).toContainEqual({ type: "orgs.changed" });
    const blocked = events.find((e) => e.type === "access.blocked");
    expect(blocked).toMatchObject({ type: "access.blocked", orgId: w.orgId, code: "policy_acknowledgement_required", gate: { kind: "policy" } });
    // The list Home reads carries the gate
    expect((await t.api.orgs.list()).find((o) => o.id === w.orgId)?.gate).toMatchObject({ kind: "policy" });
    // The same refusal again: nothing more read or said within the gap
    const n = events.length;
    await refusal(t.store.multiplayer.call("GET", `/orgs/${w.orgId}/teams`));
    await settle();
    expect(events.length).toBe(n);

    expect(await g.pendingPolicies(w.orgId)).toEqual([{ id: p.id, title: "Acceptable use", text: "Be kind." }]);
    await g.acknowledgePolicy(w.orgId, p.id);
    expect(await g.pendingPolicies(w.orgId)).toEqual([]);
    expect((await t.api.orgs.list()).find((o) => o.id === w.orgId)?.gate ?? null).toBeNull();
    await t.store.multiplayer.call("GET", `/orgs/${w.orgId}/teams`);
    // Admin's own routes waited for the agreement too (admins are members)
    expect((await g.policies(w.orgId))[0].acknowledgedCount).toBe(1);

    const off = await g.setPolicyEnabled(w.orgId, p.id, false);
    expect(off.disabledAt).not.toBeNull();
    expect((await refusal(g.acknowledgePolicy(w.orgId, p.id))).code).toBe("not-found");
  });

  it("guest expiration", async () => {
    const g = t.api.governance;
    const gus = await w.dev("gus@elsewhere.test");
    await w.call("POST", `/orgs/${w.orgId}/admin/people`, { token: w.admin.token, body: { emails: ["gus@elsewhere.test"], role: "guest" } });
    expect((await refusal(g.setGuestExpiration(w.orgId, [gus.id], clock.t + 86_400_000))).detail).toMatchObject({ code: "governance_plus_required" });
    await g.setGovernancePlus(w.orgId, true);
    const at = clock.t + 7 * 86_400_000;
    await g.setGuestExpiration(w.orgId, [gus.id], at);
    expect(await w.rows(`SELECT expires_at FROM org_members WHERE org_id = ?1 AND user_id = ?2`, w.orgId, gus.id)).toEqual([{ expires_at: at }]);
    await g.setGuestExpiration(w.orgId, [gus.id], null);
    expect(await w.rows(`SELECT expires_at FROM org_members WHERE org_id = ?1 AND user_id = ?2`, w.orgId, gus.id)).toEqual([{ expires_at: null }]);
    // Members aren't guests; a past date is refused
    expect((await refusal(g.setGuestExpiration(w.orgId, [w.admin.id], at))).code).toBe("invalid");
    expect((await refusal(g.setGuestExpiration(w.orgId, [gus.id], clock.t - 1))).detail).toMatchObject({ field: "expiresAt" });
    expect((await refusal(g.setGuestExpiration(w.orgId, [], at))).detail).toMatchObject({ field: "userIds" });
  });

  it("the guest's list entry keeps guestExpiresAt (and the gate) after the org itself is read (§9 end-to-end run)", async () => {
    // Found end to end: `orgs.get` rewrote the cached summary with five fields, so Home's list lost the guest's expiry
    // (no banner) and any gate after the org was opened once.
    const gus = await w.dev("gus@elsewhere.test");
    await w.call("POST", `/orgs/${w.orgId}/admin/people`, { token: w.admin.token, body: { emails: ["gus@elsewhere.test"], role: "guest" } });
    await t.api.governance.setGovernancePlus(w.orgId, true);
    const at = clock.t + 5 * 86_400_000;
    await t.api.governance.setGuestExpiration(w.orgId, [gus.id], at);
    await w.call("PATCH", `/orgs/${w.orgId}/admin/settings`, { token: w.admin.token, body: { twoFactorForGuests: true } });
    await t.api.multiplayer.setSession({ server: ORIGIN, token: gus.token });
    const entry = async () => (await t.api.orgs.list()).find((o) => o.id === w.orgId);
    expect(await entry()).toMatchObject({ guestExpiresAt: at, gate: { kind: "two_factor" } });
    expect(await t.api.orgs.get(w.orgId)).toMatchObject({ guestExpiresAt: at, gate: { kind: "two_factor" } });
    expect(await entry()).toMatchObject({ guestExpiresAt: at, gate: { kind: "two_factor" } });
  });

  it("key management: no root key → unavailable; turn on, encrypt-next; Governance+ can't be removed then", async () => {
    const g = t.api.governance;
    expect((await refusal(g.enableEkm(w.orgId, { source: "managed" }))).detail).toMatchObject({ code: "governance_plus_required" });
    await g.setGovernancePlus(w.orgId, true);
    const no = await refusal(g.enableEkm(w.orgId, { source: "managed" }));
    expect(no.code).toBe("unavailable");
    expect(no.detail).toMatchObject({ code: "key_unavailable" });
    (w.srv.deps.env as any).EKM_ROOT_KEY = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");
    expect(await g.ekm(w.orgId)).toMatchObject({ enabled: false, source: null });
    expect(await g.enableEkm(w.orgId, { source: "managed" })).toMatchObject({ enabled: true, source: "managed", state: "ok" });
    expect(await g.encryptNext(w.orgId)).toMatchObject({ enabled: true, encrypting: null, files: { total: 0, encrypted: 0 } });
    expect((await refusal(g.setGovernancePlus(w.orgId, false))).code).toBe("conflict");
    expect((await refusal(g.enableEkm(w.orgId, { source: "aws" } as any))).detail).toMatchObject({ field: "source" });
  });

  it("developer logs: the filters as the query, the page's meta", async () => {
    const g = t.api.governance;
    await g.setGovernancePlus(w.orgId, true);
    expect(await g.developerLogs(w.orgId, {})).toEqual({ items: [], cursor: null, has_more: false });
    log.length = 0;
    await g.developerLogs(w.orgId, { token_name: "CI", date_range: "LAST_7D", limit: 500, user_email: "" });
    expect(log).toEqual([`GET /orgs/${w.orgId}/admin/developer-logs?token_name=CI&date_range=LAST_7D&limit=100`]);
    expect((await refusal(g.developerLogs(w.orgId, { date_range: "LAST_YEAR" as any }))).code).toBe("invalid");
  });

  it("identity providers: add, rename, map a domain, SCIM per IdP, remove", async () => {
    const g = t.api.governance;
    await g.setGovernancePlus(w.orgId, true);
    expect(await g.idps(w.orgId)).toEqual([]);
    const idp = await g.saveIdp(w.orgId, null, { provider: "okta", metadataXml: idpMetadata(), name: "Okta" });
    expect(idp).toMatchObject({ provider: "okta", name: "Okta" });
    expect((await g.saveIdp(w.orgId, idp.tenantId, { name: "Okta (design)" } as any)).name).toBe("Okta (design)");
    expect((await g.idps(w.orgId)).map((i) => [i.tenantId, i.name])).toEqual([[idp.tenantId, "Okta (design)"]]);
    expect((await refusal(g.refreshIdp(w.orgId, idp.tenantId))).code).toBe("conflict");

    await t.api.identity.addDomain(w.orgId, "acme.test");
    await w.run(`UPDATE org_domains SET verified_at = 1 WHERE org_id = ?1`, w.orgId);
    expect(await g.mapDomain(w.orgId, "ACME.test", idp.tenantId)).toMatchObject({ domain: "acme.test", tenantId: idp.tenantId });
    expect((await g.idps(w.orgId))[0].domains).toEqual(["acme.test"]);
    expect((await refusal(g.mapDomain(w.orgId, "acme.test", "123456789012345678"))).code).toBe("not-found");
    expect(await g.mapDomain(w.orgId, "acme.test", null)).toMatchObject({ tenantId: null });

    const tok = await g.generateIdpScimToken(w.orgId, idp.tenantId);
    expect(tok.token).toMatch(/^dsgn_scim_/);
    expect((await w.call("GET", `/scim/v2/${idp.tenantId}/Users`, { token: tok.token })).status).toBe(200);
    await g.revokeIdpScimToken(w.orgId, idp.tenantId);
    expect((await w.call("GET", `/scim/v2/${idp.tenantId}/Users`, { token: tok.token })).status).toBe(401);
    await g.removeIdp(w.orgId, idp.tenantId);
    expect(await g.idps(w.orgId)).toEqual([]);
    expect((await refusal(g.saveIdp(w.orgId, null, { provider: "acme" } as any))).detail).toMatchObject({ field: "provider" });
  });

  it("two-factor authentication: set up, turn on, recovery codes, a wrong code, turn off", async () => {
    const g = t.api.governance;
    expect(await g.twoFactor()).toEqual({ enabled: false, enabledAt: null, recoveryCodesLeft: 0 });
    const setup = await g.setupTwoFactor();
    expect(setup.otpauthUrl).toContain(`secret=${setup.secret}`);
    const secret = base32Decode(setup.secret)!;
    const code = async () => totpCode(secret, totpStep(clock.t));
    const wrong = await refusal(g.enableTwoFactor("000000" === (await code()) ? "111111" : "000000"));
    expect(wrong.code).toBe("invalid");
    expect(wrong.detail).toMatchObject({ code: "two_factor_invalid" });
    const events: OrgEvent[] = [];
    t.store.org.onEvent((e) => events.push(e));
    const on = await g.enableTwoFactor(await code());
    expect(on.recoveryCodes).toHaveLength(10);
    expect(events).toContainEqual({ type: "orgs.changed" });
    expect(await g.twoFactor()).toMatchObject({ enabled: true, recoveryCodesLeft: 10 });
    clock.t += 30_000;
    const again = await g.regenerateRecoveryCodes(await code());
    expect(again.recoveryCodes).not.toEqual(on.recoveryCodes);
    await g.disableTwoFactor(again.recoveryCodes[0]);
    expect((await g.twoFactor()).enabled).toBe(false);
    expect((await refusal(g.disableTwoFactor(""))).detail).toMatchObject({ field: "code" });
  });

  it("over the port: the view's StoreClient calls governance.* and hears access.blocked on topic org", async () => {
    const server = new StoreServer(t.store, { generation: 1 });
    const { port1, port2 } = new MessageChannel();
    server.connect(portTransport(port1), "home");
    const client = new StoreClient();
    client.attach(portTransport(port2));
    await client.whenReady();
    try {
      expect((await client.governance.overview(w.orgId)).governancePlus).toBe(false);
      await client.governance.setGovernancePlus(w.orgId, true);
      await client.governance.createPolicy(w.orgId, { title: "NDA", text: "Keep it secret.", audience: "members", cadence: "yearly" });
      const heard: OrgEvent[] = [];
      client.orgs.watch((e) => heard.push(e));
      const e = await refusal(t.store.multiplayer.call("GET", `/orgs/${w.orgId}/teams`));
      expect(e.detail).toMatchObject({ code: "policy_acknowledgement_required" });
      for (let i = 0; i < 50 && !heard.some((x) => x.type === "access.blocked"); i++) await settle(2);
      expect(heard.find((x) => x.type === "access.blocked")).toMatchObject({ orgId: w.orgId, code: "policy_acknowledgement_required", gate: { kind: "policy" } });
      const [p] = await client.governance.pendingPolicies(w.orgId);
      await client.governance.acknowledgePolicy(w.orgId, p.id);
      expect(await client.governance.pendingPolicies(w.orgId)).toEqual([]);
    } finally {
      port1.close();
      port2.close();
    }
  });
});

describe("Governance+'s refusals in the multiplayer service", () => {
  it("httpError: gates → forbidden with {code, gate}, key_unavailable → unavailable, two_factor_invalid stays invalid", async () => {
    const gate = { kind: "ip", ip: "203.0.113.9" };
    const ip = await httpError(Response.json({ error: "x", code: "ip_not_allowed", gate }, { status: 403 }));
    expect(ip).toMatchObject({ code: "forbidden", message: "This organization only allows access from approved networks.", detail: { code: "ip_not_allowed", gate } });
    const net = await httpError(Response.json({ error: "x", code: "network_restricted" }, { status: 403 }));
    expect(net).toMatchObject({ code: "forbidden", message: "This network only allows work accounts. Log in with your work account, or switch networks." });
    expect(await httpError(Response.json({ error: "x", code: "key_unavailable" }, { status: 503 }))).toMatchObject({ code: "unavailable", detail: { code: "key_unavailable" } });
    expect(await httpError(Response.json({ error: "That code didn't work. Try again.", code: "two_factor_invalid" }, { status: 400 }))).toMatchObject({ code: "invalid", message: "That code didn't work. Try again." });
    expect(await httpError(Response.json({ error: "x", code: "export_restricted" }, { status: 403 }))).toMatchObject({ code: "forbidden", message: "Exporting is turned off for you in this file." });
  });

  /** A socket the test drives */
  const sockets: Ctl[] = [];
  class Ctl {
    binaryType = "arraybuffer";
    readyState = 0;
    onopen: ((e: unknown) => void) | null = null;
    onmessage: ((e: { data: unknown }) => void) | null = null;
    onclose: ((e: { code: number; reason: string }) => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    constructor(readonly url: string) {
      sockets.push(this);
    }
    send() {}
    close(code = 1000, reason = "") {
      this.closed(code, reason);
    }
    closed(code: number, reason = "") {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.onclose?.({ code, reason });
    }
  }

  class Host implements MultiplayerHost {
    deviceOrdinal = 1;
    metas = new Map<FileKey, FileMeta>();
    readonly fileChanges = { on: () => () => {} };
    saved: { installationId?: string; links: Record<string, unknown> } = { links: {} };
    add(name: string, orgId: string): FileKey {
      const fileKey = `local${this.metas.size + 1}`;
      this.metas.set(fileKey, { fileKey, name, space: { orgId, key: "", teamId: null, projectId: null } } as unknown as FileMeta);
      return fileKey;
    }
    async backlog() {
      return [];
    }
    async appendRemote() {
      return { seq: 1 };
    }
    async createSharedFile(): Promise<FileMeta> {
      throw new Error("not here");
    }
    getMeta(fileKey: FileKey) {
      return this.metas.get(fileKey) ?? null;
    }
    async setDeviceOrdinal(o: number) {
      this.deviceOrdinal = o;
    }
    async load() {
      return structuredClone(this.saved);
    }
    async saveInstallationId(id: string) {
      this.saved.installationId = id;
    }
    async saveLink() {}
    log() {}
    async hasBlobs(sha1s: string[]) {
      return sha1s.map(() => true);
    }
    async getBlob() {
      return new Uint8Array();
    }
    async putBlob() {}
    async headSnapshot() {
      return encodeMessage({ type: "NODE_CHANGES", sessionID: 0, ackID: 0, nodeChanges: [], blobs: [] });
    }
  }

  it("a shared file: key_unavailable on its socket, then a policy gate on its route — the link waits, the editor is told, Agree resumes", async () => {
    sockets.length = 0;
    const host = new Host();
    const mp = new MultiplayerService(host, { fetch: w.srv.fetch, WebSocket: Ctl as never, random: Math.random, backoff: () => 0 });
    const refusals: GovernanceRefusal[] = [];
    mp.onGovernance((e) => refusals.push(e));
    const states: unknown[] = [];
    mp.onFileState((_k, s) => states.push(s.blocked ?? null));
    try {
      await mp.setSession({ server: ORIGIN, token: w.admin.token });
      const fileKey = host.add("Spec", w.orgId);
      const doc = await host.headSnapshot();
      await mp.shareTo(fileKey, { snapshot: doc, headSeq: 0 }, async (k, name) => (await mp.call("POST", "/files", { key: k, name, orgId: w.orgId }), k));
      expect(sockets).toHaveLength(1);

      // The org's key became unavailable: the room says so and closes with 4003
      sockets[0].onmessage?.({ data: JSON.stringify({ t: "error", code: "key_unavailable", message: "this file's encryption key is unavailable" }) });
      sockets[0].closed(4003);
      await settle();
      expect((await mp.fileState(fileKey)).blocked).toEqual({ code: "key_unavailable" });
      expect(states).toContainEqual({ code: "key_unavailable" });
      expect(refusals).toContainEqual({ code: "key_unavailable", orgId: w.orgId, fileKey });
      expect(sockets).toHaveLength(1); // no reconnect into the room's 503
      mp.retryBlocked();
      expect(sockets).toHaveLength(2);
      expect((await mp.fileState(fileKey)).blocked).toBeNull();

      // A policy to agree to: the upgrade fails, the link asks the file's route, which answers the gate
      const g = t.api.governance;
      await g.setGovernancePlus(w.orgId, true);
      const p = await g.createPolicy(w.orgId, { title: "NDA", text: "Keep it secret.", audience: "everyone", cadence: "once" });
      sockets[1].closed(1006);
      for (let i = 0; i < 50 && sockets.length < 3; i++) await settle(2);
      expect(sockets).toHaveLength(3);
      sockets[2].closed(1006);
      for (let i = 0; i < 20 && !(await mp.fileState(fileKey)).blocked; i++) await settle();
      expect((await mp.fileState(fileKey)).blocked).toMatchObject({ code: "policy_acknowledgement_required", gate: { kind: "policy", policies: [{ id: p.id }] } });
      expect(refusals.at(-1)).toMatchObject({ code: "policy_acknowledgement_required", orgId: w.orgId, fileKey });
      const n = sockets.length;
      // Agreeing (here through the server, as the policy modal would through governance.acknowledgePolicy's retry)
      await w.call("POST", `/orgs/${w.orgId}/policies/${p.id}/acknowledge`, { token: w.admin.token });
      mp.retryBlocked(w.orgId);
      expect(sockets.length).toBe(n + 1);
      expect((await mp.fileState(fileKey)).blocked).toBeNull();
    } finally {
      mp.close();
    }
  });
});
