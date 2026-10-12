/**
 * The real server (server/src/api.ts `handle`, round 1a) behind the fake's surface (fake/server.ts): D1 on node:sqlite
 * with every migration, rooms that keep snapshots in memory, dev sign-in for people. The store's org tests run against
 * it, so the two sides of §14.12 are checked together. Round 4c: the Worker's own fetches (DNS-over-HTTPS, IdP
 * metadata URLs) answered from `dns` / `metadata`, and IdP metadata for the SAML configuration (docs/multiplayer.md §15).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handle, type Deps } from "../../../../server/src/api";
import { Db, type D1Like } from "../../../../server/src/db";
import { sqliteD1 } from "../../../../server/src/testing/sqliteD1";
import { memoryFonts } from "../../../../server/src/testing/memoryLibraries";

export class RealOrgServer {
  /** Requests answered so far, "METHOD /path" */
  readonly log: string[] = [];
  /** Off: every request fails as a network error would */
  online = true;
  readonly d1: D1Like = sqliteD1();
  readonly snapshots = new Map<string, { seq: number; bytes: Uint8Array }>();
  private clock = Date.UTC(2026, 9, 11);
  readonly deps: Deps = {
    db: new Db(this.d1),
    // FONTS: the org's object, which keeps its fonts and its icons (§14.16)
    env: { SESSION_SECRET: "s".repeat(40), DEV_AUTH: "1", FONTS: memoryFonts().binding } as Deps["env"],
    rooms: {
      fetch: async (key, path, init) => {
        if (path.startsWith("/room/snapshot")) {
          if (init.method === "PUT") {
            const seq = Number(new URL(`https://room${path}`).searchParams.get("seq"));
            this.snapshots.set(key, { seq, bytes: new Uint8Array(init.body as ArrayBuffer) });
            return Response.json({ ok: true, seq, lastSeq: seq });
          }
          const s = this.snapshots.get(key);
          if (!s) return Response.json({ error: "no snapshot yet", code: "no_snapshot" }, { status: 404 });
          return new Response(s.bytes, { headers: { "x-seq": String(s.seq), "x-last-seq": String(s.seq) } });
        }
        if (path === "/room/blobs/missing") return Response.json({ missing: [] });
        return Response.json({ ok: true });
      },
    },
    now: () => (this.clock += 1000),
    // The Worker's own fetches (round 4a, docs/multiplayer.md §15.17): DNS-over-HTTPS and IdP metadata URLs, faked
    fetch: (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.origin === "https://cloudflare-dns.com") return Response.json(this.dns.get(url.searchParams.get("name") ?? "") ?? { Status: 3 });
      const doc = this.metadata.get(url.href);
      if (doc !== undefined) return new Response(doc, { headers: { "content-type": "application/samlmetadata+xml" } });
      return new Response("no", { status: 500 });
    }) as typeof fetch,
  };
  /** DoH answers by name (the JSON API's body; none: NXDOMAIN) */
  readonly dns = new Map<string, unknown>();
  /** IdP metadata documents by URL */
  readonly metadata = new Map<string, string>();

  /** A call straight to the handler (setting things up behind the store's back): status and JSON body */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async call(method: string, path: string, token?: string, body?: unknown): Promise<{ status: number; body: any }> {
    const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
    if (body !== undefined) headers["content-type"] = body instanceof Uint8Array ? "application/octet-stream" : "application/json";
    const res = await handle(new Request(`https://org.test${path}`, { method, headers, body: body === undefined ? undefined : body instanceof Uint8Array ? (body as unknown as RequestInit["body"]) : JSON.stringify(body) }), this.deps);
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // not JSON
    }
    return { status: res.status, body: parsed };
  }

  /** Rows of a query (tests' checks) */
  async rows<T = Record<string, unknown>>(sql: string, ...args: unknown[]): Promise<T[]> {
    return (await this.d1.prepare(sql).bind(...args).all<T>()).results;
  }

  /** A person and their session token (dev sign-in) */
  async addUser(email: string, name = email.split("@")[0]): Promise<{ user: { id: string; email: string; name: string }; token: string }> {
    const res = await handle(new Request("https://org.test/auth/dev", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, name }) }), this.deps);
    const out = (await res.json()) as { token: string; user: { id: string; email: string } };
    return { user: { id: out.user.id, email: out.user.email, name }, token: out.token };
  }

  /** The handler, as `fetch` */
  readonly fetch: typeof fetch = async (input, init) => {
    if (!this.online) throw new TypeError("fetch failed");
    const req = new Request(String(input), init);
    this.log.push(`${req.method} ${new URL(req.url).pathname}`);
    return handle(req, this.deps);
  };

  /** A file's row as the store's tests look at it */
  async file(key: string): Promise<{ orgId: string | null; teamId: string | null; projectId: string | null; snapshot: { seq: number; bytes: Uint8Array } | null } | null> {
    const r = await this.d1.prepare(`SELECT org_id, team_id, project_id FROM files WHERE key = ?1`).bind(key).first<{ org_id: string | null; team_id: string | null; project_id: string | null }>();
    return r ? { orgId: r.org_id, teamId: r.team_id, projectId: r.project_id, snapshot: this.snapshots.get(key) ?? null } : null;
  }

  /** A change made behind the store's back (someone else, elsewhere) */
  async exec(sql: string, ...args: unknown[]): Promise<void> {
    await this.d1.prepare(sql).bind(...args).run();
  }
}

/** The server's origin in these tests */
export const REAL_ORIGIN = "https://org.test";

/** The real server with an org "Acme" made by alice@acme.test (its admin), for round 4's store tests */
export async function acmeServer() {
  const srv = new RealOrgServer();
  const alice = await srv.addUser("alice@acme.test", "alice");
  const orgId = (await srv.call("POST", "/orgs", alice.token, { name: "Acme" })).body.org.id as string;
  return {
    srv,
    orgId,
    admin: { token: alice.token, id: alice.user.id },
    /** A person signed in by dev sign-in */
    dev: async (email: string) => {
      const u = await srv.addUser(email);
      return { token: u.token, id: u.user.id };
    },
    /** PATCH admin/settings as alice (round 4b's route, calling 4a's hooks); throws when refused */
    settings: async (patch: Record<string, unknown>) => {
      const r = await srv.call("PATCH", `/orgs/${orgId}/admin/settings`, alice.token, patch);
      if (r.status !== 200) throw Object.assign(new Error(String(r.body?.error ?? r.body)), { status: r.status, code: r.body?.code });
    },
  };
}

export const TEST_IDP_ENTITY = "https://idp.example.test/metadata";
export const TEST_IDP_SSO = "https://idp.example.test/sso";
let testCert: string | null = null;

/**
 * IdP metadata (Redirect binding, NameID email) around a throwaway RSA-2048 certificate made with openssl once per run
 * — as server/src/testing/samlIdp.ts does; not imported from there, whose xml-crypto typings bring a second
 * @types/node into the root typecheck.
 */
export function testIdpMetadata(o: { entityId?: string; sso?: string } = {}): string {
  if (!testCert) {
    const dir = mkdtempSync(join(tmpdir(), "designer-idp-"));
    try {
      execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "30", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"), "-subj", "/CN=Test IdP"], { stdio: "ignore" });
      testCert = readFileSync(join(dir, "c.pem"), "utf8");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const der = testCert.replace(/-----[^-]+-----|\s+/g, "");
  return `<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" entityID="${o.entityId ?? TEST_IDP_ENTITY}"><md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol"><md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${der}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor><md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</md:NameIDFormat><md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${o.sso ?? TEST_IDP_SSO}"/></md:IDPSSODescriptor></md:EntityDescriptor>`;
}
