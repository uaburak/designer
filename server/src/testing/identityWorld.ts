/**
 * A world for the identity tests (docs/multiplayer.md §15; round 4a): the real handler on node:sqlite with the real
 * clock (node-saml checks times against `Date.now()`), Google's token endpoint, DNS-over-HTTPS and IdP metadata URLs
 * faked through `deps.fetch`, an org "Acme" made by alice@acme.test (admin), and helpers that drive the app's sign-in
 * flows the way the desktop app does (loopback, PKCE).
 */
import { inflateRawSync } from "node:zlib";
import { handle, type Deps } from "../api";
import { Db, type D1Like } from "../db";
import { b64url, sha256b64url } from "../tokens";
import type { OrgSettings } from "../../../src/shared/org/types";
import { sqliteD1 } from "./sqliteD1";
import { IDP_ENTITY, IDP_SSO, testKeys } from "./samlIdp";

export const ORIGIN = "https://designer.example.workers.dev";
export const WEB = "http://localhost:5199";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

export interface Answer {
  status: number;
  body: Any;
  text: string;
  headers: Headers;
  location: URL | null;
}

export interface IdentityWorld {
  deps: Deps;
  d1: D1Like;
  now: { t: number };
  inbox: { userId: string; msg: Any }[];
  rooms: { key: string; path: string }[];
  /** Google's ID token claims for the next callback */
  google: Record<string, unknown>;
  /** DoH answers by domain: the JSON API's body (or a status to fail with) */
  dns: Map<string, Any>;
  /** Metadata documents by URL */
  metadata: Map<string, string>;
  call(method: string, path: string, o?: { token?: string; body?: unknown; form?: Record<string, string>; headers?: Record<string, string> }): Promise<Answer>;
  run(sql: string, ...args: unknown[]): Promise<void>;
  rows<T = Any>(sql: string, ...args: unknown[]): Promise<T[]>;
  orgId: string;
  admin: { token: string; id: string };
  dev(email: string): Promise<{ token: string; id: string }>;
  /** An IdP configuration of the org written straight into D1 (tested unless told otherwise) → its tenant id */
  addIdp(orgId?: string, o?: { signing?: "assertion" | "assertion_or_response"; certs?: string[]; tested?: boolean }): Promise<string>;
  /** A verified domain of the org, written straight into D1 */
  verifiedDomain(domain: string, orgId?: string): Promise<void>;
  /** PATCH admin/settings (round 4b's route, calling the identity hooks); throws {status, code, message} when refused */
  settings(patch: Partial<OrgSettings>, orgId?: string): Promise<void>;
  /** The desktop app's sign-in start: /auth/login?port&state&challenge (+ extra) */
  login(extra?: string): Promise<{ res: Answer; verifier: string; state: string }>;
  /** /auth/login?tenant= → /saml/:t/start → the IdP: the AuthnRequest's id (= RelayState) and its XML */
  samlStart(tenantId: string): Promise<{ requestId: string; request: string; verifier: string }>;
  /** POST /saml/:t/consume */
  acs(tenantId: string, xml: string, relayState?: string): Promise<Answer>;
  /** The loopback's code traded for a session */
  token(location: URL, verifier: string): Promise<Answer>;
  /** Google's whole flow (method=google) → the callback's answer */
  googleFlow(claims?: Record<string, unknown>): Promise<{ res: Answer; verifier: string }>;
}

export const idToken = (claims: Record<string, unknown>) => `x.${b64url(new TextEncoder().encode(JSON.stringify(claims)))}.y`;

export async function identityWorld(): Promise<IdentityWorld> {
  const d1 = sqliteD1();
  const now = { t: Date.now() };
  const inbox: IdentityWorld["inbox"] = [];
  const rooms: IdentityWorld["rooms"] = [];
  const dns = new Map<string, Any>();
  const metadata = new Map<string, string>();
  const google: Record<string, unknown> = {};
  const deps: Deps = {
    db: new Db(d1),
    env: { SESSION_SECRET: "s".repeat(40), DEV_AUTH: "1", GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "csecret", WEB_ORIGINS: WEB },
    rooms: {
      async fetch(key, path) {
        rooms.push({ key, path });
        return Response.json({ ok: true });
      },
    },
    inboxes: {
      async notify(userId, msg) {
        inbox.push({ userId, msg });
      },
      async connect() {
        return new Response(null);
      },
    },
    now: () => now.t,
    fetch: (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.href === "https://oauth2.googleapis.com/token") return Response.json({ id_token: idToken({ iss: "https://accounts.google.com", aud: "cid", email_verified: true, exp: Math.floor(now.t / 1000) + 3600, ...google }) });
      if (url.origin === "https://cloudflare-dns.com") {
        const a = dns.get(url.searchParams.get("name") ?? "");
        if (typeof a === "number") return new Response("fail", { status: a });
        return Response.json(a ?? { Status: 3 });
      }
      const doc = metadata.get(url.href);
      if (doc !== undefined) return new Response(doc, { headers: { "content-type": "application/samlmetadata+xml" } });
      return new Response("not found", { status: 404 });
    }) as typeof fetch,
  };
  const call: IdentityWorld["call"] = async (method, path, o = {}) => {
    const headers: Record<string, string> = { ...(o.token ? { authorization: `Bearer ${o.token}` } : {}), ...(o.headers ?? {}) };
    let body: BodyInit | undefined;
    if (o.form) {
      headers["content-type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(o.form).toString();
    } else if (o.body !== undefined) {
      headers["content-type"] ??= "application/json";
      body = typeof o.body === "string" ? o.body : JSON.stringify(o.body);
    }
    const res = await handle(new Request(ORIGIN + path, { method, headers, body }), deps);
    const text = await res.text();
    let parsed: Any = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // HTML, XML
    }
    const loc = res.headers.get("location");
    return { status: res.status, body: parsed, text, headers: res.headers, location: loc ? new URL(loc, ORIGIN) : null };
  };
  const run = async (sql: string, ...args: unknown[]) => void (await d1.prepare(sql).bind(...args).run());
  const rows = async <T = Any>(sql: string, ...args: unknown[]) => (await d1.prepare(sql).bind(...args).all<T>()).results;
  const dev = async (email: string) => {
    const r = await call("POST", "/auth/dev", { body: { email, name: email.split("@")[0] } });
    return { token: r.body.token as string, id: r.body.user.id as string };
  };
  const admin = await dev("alice@acme.test");
  const orgId = (await call("POST", "/orgs", { token: admin.token, body: { name: "Acme" } })).body.org.id as string;

  let tenantSeq = 0;
  const addIdp: IdentityWorld["addIdp"] = async (org = orgId, o = {}) => {
    const tenantId = "1" + String(++tenantSeq).padStart(17, "0");
    const pem = o.certs ?? [testKeys().idp.cert];
    await run(
      `INSERT INTO idp_configs (org_id, tenant_id, provider, idp_entity_id, sso_url, certificates, signing, tested_at, created_at, updated_at) VALUES (?1, ?2, 'okta', ?3, ?4, ?5, ?6, ?7, ?8, ?8)`,
      org,
      tenantId,
      IDP_ENTITY,
      IDP_SSO,
      JSON.stringify(pem),
      o.signing ?? "assertion",
      o.tested === false ? null : now.t,
      now.t,
    );
    return tenantId;
  };
  const verifiedDomain = async (domain: string, org = orgId) => run(`INSERT INTO org_domains (org_id, domain, token, created_at, verified_at) VALUES (?1, ?2, 'tok', ?3, ?3)`, org, domain, now.t);
  const settings: IdentityWorld["settings"] = async (patch, org = orgId) => {
    const r = await call("PATCH", `/orgs/${org}/admin/settings`, { token: admin.token, body: patch });
    if (r.status !== 200) throw Object.assign(new Error(r.body?.error ?? r.text), { status: r.status, code: r.body?.code });
  };
  const login: IdentityWorld["login"] = async (extra = "") => {
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(40)));
    const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
    const res = await call("GET", `/auth/login?port=50123&state=${state}&challenge=${await sha256b64url(verifier)}${extra}`);
    return { res, verifier, state };
  };
  const samlStart: IdentityWorld["samlStart"] = async (tenantId) => {
    const { res, verifier } = await login(`&tenant=${tenantId}`);
    if (res.status !== 302) throw new Error(`login: ${res.status} ${res.text}`);
    const start = await call("GET", res.location!.pathname + res.location!.search);
    if (start.status !== 302) throw new Error(`start: ${start.status} ${start.text}`);
    const idp = start.location!;
    const request = inflateRawSync(Buffer.from(idp.searchParams.get("SAMLRequest")!, "base64")).toString("utf8");
    const requestId = /\bID="([^"]+)"/.exec(request)![1];
    if (idp.searchParams.get("RelayState") !== requestId) throw new Error("RelayState is not the request id");
    return { requestId, request, verifier };
  };
  const acs: IdentityWorld["acs"] = (tenantId, xml, relayState) => call("POST", `/saml/${tenantId}/consume`, { form: { SAMLResponse: Buffer.from(xml, "utf8").toString("base64"), ...(relayState ? { RelayState: relayState } : {}) } });
  const token: IdentityWorld["token"] = async (location, verifier) => call("POST", "/auth/token", { body: { code: location.searchParams.get("code"), verifier } });
  const googleFlow: IdentityWorld["googleFlow"] = async (claims = {}) => {
    for (const k of Object.keys(google)) delete google[k];
    Object.assign(google, claims);
    const { res, verifier } = await login("&method=google");
    const state = res.location!.searchParams.get("state")!;
    return { res: await call("GET", `/auth/callback?code=good&state=${encodeURIComponent(state)}`), verifier };
  };
  return { deps, d1, now, inbox, rooms, google, dns, metadata, call, run, rows, orgId, admin, dev, addIdp, verifiedDomain, settings, login, samlStart, acs, token, googleFlow };
}
