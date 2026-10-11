/**
 * Round 4c — the store's `identity` repository (docs/multiplayer.md §15) against the real server handler of rounds 4a
 * and 4b (server/src/api.ts `handle` on node:sqlite, fake/real.ts: IdP metadata URLs and DNS-over-HTTPS faked through
 * `deps.fetch`; rooms in round 4b's fake `ROOMS` namespace with `jurisdiction()`), through LocalStore and over the port:
 * the SAML configuration, the SCIM token, domains, the data region and its move, the refusals.
 */
import { MessageChannel } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { roomsOn } from "../../../server/src/policy/region";
import { memoryRoomNamespace } from "../../../server/src/testing/memoryRooms";
import type { OrgEvent } from "../../shared/org/repositories";
import { StoreClient } from "../../shared/store/client";
import { portTransport, StoreError } from "../../shared/store/protocol";
import { StoreServer } from "../server";
import { openTestStore, settle, type TestStore } from "../testing/harness";
import { acmeServer, REAL_ORIGIN as ORIGIN, TEST_IDP_ENTITY as IDP_ENTITY, TEST_IDP_SSO as IDP_SSO, testIdpMetadata as idpMetadata } from "./fake/real";

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

/** The server as the tests drive it behind the store's back */
async function world() {
  const a = await acmeServer();
  const { srv } = a;
  return {
    ...a,
    deps: srv.deps,
    metadata: srv.metadata,
    dns: srv.dns,
    run: (sql: string, ...args: unknown[]) => srv.exec(sql, ...args),
    rows: (sql: string, ...args: unknown[]) => srv.rows(sql, ...args),
    call: (method: string, path: string, o: { token?: string; body?: unknown } = {}) => srv.call(method, path, o.token, o.body),
  };
}

let w: Awaited<ReturnType<typeof world>>;
let t: TestStore;
const log: string[] = [];

beforeEach(async () => {
  vi.stubGlobal("WebSocket", NoSocket);
  w = await world();
  const ns = memoryRoomNamespace(() => Date.now());
  w.deps.rooms = roomsOn(ns.binding, w.srv.d1);
  (w.deps.env as any).ROOMS = ns.binding;
  log.length = 0;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    log.push(`${init?.method ?? "GET"} ${new URL(String(input)).pathname}`);
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

describe("identity (docs/multiplayer.md §15.13, as built §15.16–§15.17)", () => {
  it("SAML: the overview, a configuration by metadata XML and by hand, refresh, delete", async () => {
    const id = t.api.identity;
    const empty = await id.overview(w.orgId);
    expect(empty).toEqual({ authMethod: "any", idp: null, scim: null, domains: [], domainCapture: false });

    const idp = await id.saveIdp(w.orgId, { provider: "okta", metadataXml: idpMetadata() });
    expect(idp.tenantId).toMatch(/^\d{18}$/);
    expect(idp).toMatchObject({ provider: "okta", idpEntityId: IDP_ENTITY, ssoUrl: IDP_SSO, metadataUrl: null, testedAt: null });
    expect(idp.spEntityId).toBe(`${ORIGIN}/saml/${idp.tenantId}`);
    expect(idp.spAcsUrl).toBe(`${ORIGIN}/saml/${idp.tenantId}/consume`);
    expect(idp.certificates[0].sha256).toBeTruthy();
    const o = await id.overview(w.orgId);
    expect(o.idp?.tenantId).toBe(idp.tenantId);
    expect(o.scim).toEqual({ baseUrl: `${ORIGIN}/scim/v2/${idp.tenantId}`, token: null });

    // Refresh needs a metadata URL; by URL it re-fetches it
    expect((await refusal(id.refreshIdpMetadata(w.orgId))).code).toBe("conflict");
    w.metadata.set("https://idp.example.test/app/metadata", idpMetadata({ sso: "https://idp.example.test/sso2" }));
    const byUrl = await id.saveIdp(w.orgId, { provider: "okta", metadataUrl: "https://idp.example.test/app/metadata" });
    expect(byUrl).toMatchObject({ tenantId: idp.tenantId, ssoUrl: "https://idp.example.test/sso2", metadataUrl: "https://idp.example.test/app/metadata" });
    w.metadata.set("https://idp.example.test/app/metadata", idpMetadata({ sso: "https://idp.example.test/sso3" }));
    expect((await id.refreshIdpMetadata(w.orgId)).ssoUrl).toBe("https://idp.example.test/sso3");

    // By hand; the server names the bad field
    const bad = await refusal(id.saveIdp(w.orgId, { provider: "custom", idpEntityId: IDP_ENTITY, ssoUrl: IDP_SSO, certificate: "nope" }));
    expect(bad.code).toBe("invalid");
    // The store refuses what isn't an IdpConfigInput before asking
    const before = log.length;
    expect((await refusal(id.saveIdp(w.orgId, { provider: "acme" } as any))).detail).toMatchObject({ field: "provider" });
    expect(log.length).toBe(before);

    // Required → can't be removed; any method → removed (and with it the SCIM token)
    await w.run(`UPDATE idp_configs SET tested_at = 1 WHERE org_id = ?1`, w.orgId);
    await w.settings({ authMethod: "saml" });
    expect((await refusal(id.deleteIdp(w.orgId))).code).toBe("conflict");
    await w.settings({ authMethod: "any" });
    await id.generateScimToken(w.orgId);
    await id.deleteIdp(w.orgId);
    expect(await id.overview(w.orgId)).toMatchObject({ idp: null, scim: null });
    expect(await w.rows(`SELECT id FROM scim_tokens WHERE org_id = ?1 AND revoked_at IS NULL`, w.orgId)).toEqual([]);
  });

  it("SCIM: needs SAML; a token shown once, a new one revokes the old, revoke", async () => {
    const id = t.api.identity;
    expect((await refusal(id.generateScimToken(w.orgId))).code).toBe("conflict");
    await id.saveIdp(w.orgId, { provider: "entra", metadataXml: idpMetadata() });
    const first = await id.generateScimToken(w.orgId);
    expect(first.token).toMatch(/^dsgn_scim_/);
    expect(first.info).toMatchObject({ createdBy: { id: w.admin.id }, lastUsedAt: null });
    const tenant = (await id.overview(w.orgId)).idp!.tenantId;
    const scim = (token: string) => w.call("GET", `/scim/v2/${tenant}/Users`, { token });
    expect((await scim(first.token)).status).toBe(200);
    const second = await id.generateScimToken(w.orgId);
    expect((await id.overview(w.orgId)).scim?.token?.id).toBe(second.info.id);
    expect((await scim(first.token)).status).toBe(401);
    await id.revokeScimToken(w.orgId);
    expect((await id.overview(w.orgId)).scim?.token).toBeNull();
    expect((await scim(second.token)).status).toBe(401);
    await id.revokeScimToken(w.orgId); // nothing live: still fine
  });

  it("domains: add (normalized), verify against DNS, the record not found, accounts, remove", async () => {
    const id = t.api.identity;
    const d = await id.addDomain(w.orgId, " https://Acme.TEST/ ");
    expect(d).toMatchObject({ domain: "acme.test", verified: false, verifiedAt: null });
    expect(d.txtRecord).toMatch(/^designerv2-domain-verification=/);
    expect((await refusal(id.addDomain(w.orgId, "not a domain"))).code).toBe("invalid");

    w.dns.set("acme.test", { Status: 0, Answer: [{ type: 16, data: '"v=spf1 -all"' }] });
    const no = await refusal(id.verifyDomain(w.orgId, "acme.test"));
    expect(no.code).toBe("conflict");
    expect(no.detail).toMatchObject({ code: "domain_unverified", found: ["v=spf1 -all"] });
    w.dns.set("acme.test", { Status: 0, Answer: [{ type: 16, data: `"${d.txtRecord}"` }] });
    const ok = await id.verifyDomain(w.orgId, "ACME.test");
    expect(ok).toMatchObject({ domain: "acme.test", verified: true });
    expect((await id.overview(w.orgId)).domains.map((x) => [x.domain, x.verified])).toEqual([["acme.test", true]]);

    // Another org can't verify it
    const other = await w.dev("zed@zed.test");
    const zedOrg = (await w.call("POST", "/orgs", { token: other.token, body: { name: "Zed" } })).body.org.id as string;
    const zedStore = await openTestStore({ fetch: w.srv.fetch });
    try {
      await zedStore.api.multiplayer.setSession({ server: ORIGIN, token: other.token });
      await zedStore.api.identity.addDomain(zedOrg, "acme.test").then(
        () => {
          throw new Error("added");
        },
        (e: StoreError) => expect(e.detail).toMatchObject({ code: "domain_taken" }),
      );
    } finally {
      await zedStore.close();
      zedStore.dispose();
    }

    const bob = await w.dev("bob@acme.test");
    // The accounts on the domain outside the org (alice is its admin)
    expect((await id.domainAccounts(w.orgId, "acme.test")).map((p) => p.email)).toEqual(["bob@acme.test"]);
    void bob;

    // An admin can't remove their own domain; another one goes
    expect((await refusal(id.removeDomain(w.orgId, "acme.test"))).code).toBe("conflict");
    await id.addDomain(w.orgId, "acme-design.test");
    await id.removeDomain(w.orgId, "acme-design.test");
    expect((await id.overview(w.orgId)).domains.map((x) => x.domain)).toEqual(["acme.test"]);
  });

  it("data storage localization: status, change to the EU, the move one object at a time", async () => {
    const id = t.api.identity;
    for (const key of ["filekeyA0001", "filekeyB0002"]) {
      expect((await w.call("POST", "/files", { token: w.admin.token, body: { key, name: key, orgId: w.orgId } })).status).toBe(201);
      expect((await w.call("PUT", `/files/${key}/snapshot?seq=0`, { token: w.admin.token, body: new Uint8Array([1, 2, 3]) })).status).toBe(200);
    }
    expect(await id.dataRegion(w.orgId)).toEqual({ region: "default", files: { total: 2, moved: 2 }, libraries: { total: 0, moved: 0 }, moving: null, available: true });
    const events: OrgEvent[] = [];
    t.store.org.onEvent((e) => events.push(e));
    expect(await id.setDataRegion(w.orgId, "eu")).toMatchObject({ region: "eu", files: { total: 2, moved: 0 } });
    await settle();
    expect(events).toContainEqual({ type: "org.updated", orgId: w.orgId });
    expect((await t.api.orgs.get(w.orgId)).dataRegion).toBe("eu");
    const moved: string[] = [];
    for (let i = 0; i < 5; i++) {
      const s = await id.moveNext(w.orgId);
      if (!s.moving) break;
      moved.push(s.moving);
    }
    expect(moved.sort()).toEqual(["filekeyA0001", "filekeyB0002"]);
    expect(await id.dataRegion(w.orgId)).toMatchObject({ region: "eu", files: { total: 2, moved: 2 }, moving: null });
    expect((await refusal(id.setDataRegion(w.orgId, "us" as any))).code).toBe("invalid");
  });

  it("org admins only; signed out → offline; a bad org id never reaches the server", async () => {
    const bob = await w.dev("bob@acme.test");
    await w.call("POST", `/orgs/${w.orgId}/admin/people`, { token: w.admin.token, body: { emails: ["bob@acme.test"], role: "member" } });
    await t.api.multiplayer.setSession({ server: ORIGIN, token: bob.token });
    const e = await refusal(t.api.identity.overview(w.orgId));
    expect(e.code).toBe("forbidden");
    expect(e.detail).toMatchObject({ code: "not_admin" });
    await t.api.multiplayer.setSession(null);
    expect((await refusal(t.api.identity.overview(w.orgId))).code).toBe("offline");
    await t.api.multiplayer.setSession({ server: ORIGIN, token: w.admin.token });
    const before = log.length;
    expect((await refusal(t.api.identity.overview(""))).code).toBe("invalid");
    expect((await refusal(t.api.identity.verifyDomain(w.orgId, "../x"))).code).toBe("invalid");
    expect(log.length).toBe(before);
  });

  it("over the port: the view's StoreClient calls identity.*", async () => {
    const server = new StoreServer(t.store, { generation: 1 });
    const { port1, port2 } = new MessageChannel();
    server.connect(portTransport(port1), "home");
    const client = new StoreClient();
    client.attach(portTransport(port2));
    await client.whenReady();
    try {
      expect((await client.identity.overview(w.orgId)).authMethod).toBe("any");
      expect((await client.identity.addDomain(w.orgId, "acme.test")).domain).toBe("acme.test");
      const e = await refusal(client.identity.verifyDomain(w.orgId, "acme.test"));
      expect(e.detail).toMatchObject({ code: "domain_unverified", found: [] });
    } finally {
      port1.close();
      port2.close();
    }
  });
});
