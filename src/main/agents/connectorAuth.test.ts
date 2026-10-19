// OAuth connectors (docs/ai.md §2.11; connectorAuth.ts) against a local MCP server with its own authorization server:
// the Bearer challenge read, the protected-resource and authorization-server metadata found, Wecra registered for the
// sign-in's loopback redirect, the browser's code (PKCE S256, the state, the resource) exchanged, the tokens kept sealed
// apart and sent as the Authorization header; a refused token refreshed once, an expiring one before it is used; Sign
// out; a cancelled sign-in, a stray callback; the challenge's parameters, secure endpoints only, tokens never in errors.
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { ConnectorHub, type ConnectorStorage, type StoredConnector } from "./connectors";
import { bearerParams, canonicalResource, discover, pkce, safeEndpoint, signIn } from "./connectorAuth";
import type { SpawnFn } from "./providers/turns";

const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** An MCP server at /mcp guarded by an authorization server at /as (dynamic registration, PKCE, refresh). */
async function oauthMcp(o: { refreshable?: boolean } = {}) {
  const seen = { registered: [] as string[], authorize: [] as Record<string, string>[], tokens: [] as Record<string, string>[], mcpAuth: [] as string[] };
  const valid = new Set<string>();
  const codes = new Map<string, { challenge: string; redirect: string; resource: string }>();
  let base = "";
  let n = 0;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", base);
      const json = (status: number, body: unknown) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
      if (url.pathname === "/mcp") {
        seen.mcpAuth.push(req.headers.authorization ?? "");
        const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
        if (!token || !valid.has(token)) return res.writeHead(401, { "WWW-Authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp", scope="notes:read"` }).end();
        const m = JSON.parse(data) as { id?: number; method: string };
        if (m.id === undefined) return res.writeHead(202).end();
        const result = m.method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: { tools: {} } } : m.method === "tools/list" ? { tools: [{ name: "search", description: "Searches notes" }] } : { content: [{ type: "text", text: `found with ${token}` }] };
        return json(200, { jsonrpc: "2.0", id: m.id, result });
      }
      if (url.pathname === "/.well-known/oauth-protected-resource/mcp") return json(200, { resource: `${base}/mcp`, authorization_servers: [`${base}/as`], scopes_supported: ["notes:read"] });
      if (url.pathname === "/.well-known/oauth-authorization-server/as") return json(200, { issuer: `${base}/as`, authorization_endpoint: `${base}/as/authorize`, token_endpoint: `${base}/as/token`, registration_endpoint: `${base}/as/register`, code_challenge_methods_supported: ["S256"] });
      if (url.pathname === "/as/register") {
        const r = JSON.parse(data) as { redirect_uris: string[]; token_endpoint_auth_method: string };
        seen.registered.push(`${r.token_endpoint_auth_method} ${r.redirect_uris.join(",")}`);
        return json(201, { client_id: "wecra-client" });
      }
      if (url.pathname === "/as/authorize") {
        const p = Object.fromEntries(url.searchParams);
        seen.authorize.push(p);
        const code = `code-${++n}`;
        codes.set(code, { challenge: p.code_challenge, redirect: p.redirect_uri, resource: p.resource });
        return res.writeHead(302, { Location: `${p.redirect_uri}?code=${code}&state=${p.state}` }).end();
      }
      if (url.pathname === "/as/token") {
        const p = Object.fromEntries(new URLSearchParams(data));
        seen.tokens.push(p);
        if (p.grant_type === "authorization_code") {
          const c = codes.get(p.code);
          codes.delete(p.code);
          if (!c || c.redirect !== p.redirect_uri || c.resource !== p.resource || b64url(createHash("sha256").update(p.code_verifier).digest()) !== c.challenge) return json(400, { error: "invalid_grant", leaked: "secret-token-xyz" });
          valid.add("A1");
          return json(200, { access_token: "A1", token_type: "Bearer", expires_in: 3600, ...(o.refreshable !== false ? { refresh_token: "R1" } : {}) });
        }
        if (p.grant_type === "refresh_token" && p.refresh_token === "R1") {
          valid.add("A2");
          return json(200, { access_token: "A2", token_type: "Bearer", expires_in: 3600 });
        }
        return json(400, { error: "invalid_grant" });
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, url: `${base}/mcp`, seen, valid, close: () => new Promise<void>((r) => server.close(() => r())) };
}

function memoryStorage(): ConnectorStorage & { list: StoredConnector[]; keys: Map<string, string> } {
  const s = {
    list: [] as StoredConnector[],
    keys: new Map<string, string>(),
    read: () => JSON.parse(JSON.stringify(s.list)) as StoredConnector[],
    write: (l: StoredConnector[]) => void (s.list = JSON.parse(JSON.stringify(l))),
    key: (id: string) => s.keys.get(id) ?? null,
    setKey: (id: string, k: string | null) => void (k ? s.keys.set(id, k) : s.keys.delete(id)),
  };
  return s;
}

/** The browser: follows the authorization page's redirect to the loopback (the owner signed in and allowed). */
const browser = async (url: string) => void (await fetch(url));
const hubFor = (storage: ConnectorStorage, openBrowser = browser) => new ConnectorHub({ storage, spawn: (() => null) as unknown as SpawnFn, env: () => process.env, cwd: "/tmp", ask: async () => ({ allow: true }), openBrowser });

describe("OAuth connectors", () => {
  it("a server's Bearer challenge: Sign in needed; signed in through the browser, the tokens kept apart and sent; Sign out forgets them", async () => {
    const mcp = await oauthMcp();
    const storage = memoryStorage();
    const hub = hubFor(storage);
    try {
      const [c] = hub.add({ name: "Notes", transport: { kind: "http", url: mcp.url } });
      expect((await hub.test(c.id)).state).toBe("sign-in");
      const signed = await hub.signIn(c.id);
      expect(signed).toMatchObject({ state: "connected", transport: { kind: "http", signedIn: true, hasKey: false }, tools: [{ name: "search", policy: "ask" }] });
      // Registered as a public client for the loopback; the browser asked with PKCE S256, the state, the resource, the scope.
      expect(mcp.seen.registered[0]).toMatch(/^none http:\/\/127\.0\.0\.1:\d+\/callback$/);
      expect(mcp.seen.authorize[0]).toMatchObject({ response_type: "code", client_id: "wecra-client", code_challenge_method: "S256", resource: mcp.url, scope: "notes:read" });
      expect(mcp.seen.authorize[0].state).toMatch(/^[\w-]{20,}$/);
      // The tokens: sealed apart (the key store), never in the list on disk.
      expect(JSON.stringify(storage.list)).not.toContain("A1");
      expect(JSON.parse(storage.keys.get(`${c.id}:oauth`)!)).toMatchObject({ accessToken: "A1", refreshToken: "R1", clientId: "wecra-client", resource: mcp.url });
      expect((await hub.call([c.id], "notes__search", { q: "x" }, "t")).content).toEqual([{ type: "text", text: "found with A1" }]);
      expect(mcp.seen.mcpAuth.at(-1)).toBe("Bearer A1");
      // Sign out: the tokens gone; the server asks again.
      hub.signOut(c.id);
      expect(storage.keys.has(`${c.id}:oauth`)).toBe(false);
      expect((await hub.test(c.id)).state).toBe("sign-in");
      hub.remove(c.id);
      expect(storage.keys.size).toBe(0);
    } finally {
      hub.close();
      await mcp.close();
    }
  });

  it("a refused token is refreshed once and the call goes on; one running out is refreshed before it is used; no refresh token: Sign in needed again", async () => {
    const mcp = await oauthMcp();
    const storage = memoryStorage();
    const hub = hubFor(storage);
    try {
      const [c] = hub.add({ name: "Notes", transport: { kind: "http", url: mcp.url } });
      await hub.signIn(c.id);
      mcp.valid.delete("A1");
      expect((await hub.call([c.id], "notes__search", {}, "t")).content).toEqual([{ type: "text", text: "found with A2" }]);
      expect(JSON.parse(storage.keys.get(`${c.id}:oauth`)!)).toMatchObject({ accessToken: "A2", refreshToken: "R1" });
      expect(mcp.seen.tokens.at(-1)).toMatchObject({ grant_type: "refresh_token", refresh_token: "R1", client_id: "wecra-client", resource: mcp.url });
      // Running out within the minute: refreshed first (the server sees only the new one).
      const kept = JSON.parse(storage.keys.get(`${c.id}:oauth`)!);
      storage.keys.set(`${c.id}:oauth`, JSON.stringify({ ...kept, accessToken: "A1", expiresAt: Date.now() + 10_000 }));
      const before = mcp.seen.mcpAuth.length;
      await hub.test(c.id);
      expect(mcp.seen.mcpAuth.slice(before).every((h) => h === "Bearer A2")).toBe(true);
    } finally {
      hub.close();
      await mcp.close();
    }
    const once = await oauthMcp({ refreshable: false });
    const s2 = memoryStorage();
    const hub2 = hubFor(s2);
    try {
      const [c] = hub2.add({ name: "Notes", transport: { kind: "http", url: once.url } });
      await hub2.signIn(c.id);
      once.valid.delete("A1");
      const r = await hub2.call([c.id], "notes__search", {}, "t");
      expect(r.isError).toBe(true);
      expect(r.content[0]).toMatchObject({ text: "Notes: Sign in to use this connector." });
      expect(hub2.list()[0].state).toBe("sign-in");
    } finally {
      hub2.close();
      await once.close();
    }
  });

  it("the owner cancels in the browser: no tokens; a stray callback with another state is ignored", async () => {
    const mcp = await oauthMcp();
    try {
      const cancelled = signIn({ serverUrl: mcp.url, wwwAuthenticate: null, openBrowser: async (url) => void (await fetch(`${new URL(url).searchParams.get("redirect_uri")}?error=access_denied`)) });
      await expect(cancelled).rejects.toThrow("The sign-in was cancelled (access_denied).");
      const tokens = await signIn({
        serverUrl: mcp.url,
        wwwAuthenticate: null,
        openBrowser: async (url) => {
          const back = new URL(url).searchParams.get("redirect_uri")!;
          expect((await fetch(`${back}?code=forged&state=not-ours`)).status).toBe(400);
          await fetch(url);
        },
      });
      expect(tokens.accessToken).toBe("A1");
    } finally {
      await mcp.close();
    }
  });

  it("reads the challenge, finds the metadata, keeps to secure endpoints, and never puts a token in an error", async () => {
    expect(bearerParams('Bearer realm="mcp", resource_metadata="https://a.example/.well-known/oauth-protected-resource", scope="read write"')).toEqual({ realm: "mcp", resource_metadata: "https://a.example/.well-known/oauth-protected-resource", scope: "read write" });
    expect(bearerParams("Basic realm=x")).toEqual({});
    expect(() => safeEndpoint("http://auth.example.com/token")).toThrow(/secure address/);
    expect(safeEndpoint("http://127.0.0.1:9/token")).toBe("http://127.0.0.1:9/token");
    expect(() => safeEndpoint("https://user:pw@auth.example.com/")).toThrow(/secure address/);
    expect(canonicalResource("https://mcp.example.com/mcp#x")).toBe("https://mcp.example.com/mcp");
    const { verifier, challenge } = pkce();
    expect(verifier).toMatch(/^[\w-]{43}$/);
    expect(challenge).toBe(b64url(createHash("sha256").update(verifier).digest()));
    const mcp = await oauthMcp();
    try {
      // Found from the server's path alone (no challenge header): RFC 9728's well-known place, then RFC 8414's.
      expect(await discover(mcp.url, null)).toEqual({ resource: mcp.url, authorizationEndpoint: `${mcp.base}/as/authorize`, tokenEndpoint: `${mcp.base}/as/token`, registrationEndpoint: `${mcp.base}/as/register`, scope: "notes:read" });
      // A code the server refuses: its answer (here with a token in it) isn't repeated.
      const refused = signIn({ serverUrl: mcp.url, wwwAuthenticate: null, openBrowser: async (url) => void (await fetch(url.replace(/code_challenge=[^&]+/, "code_challenge=wrong"))) });
      await expect(refused).rejects.toThrow("The connector's sign-in was refused (invalid_grant).");
      await expect(refused.catch((e: Error) => e.message)).resolves.not.toContain("secret-token");
    } finally {
      await mcp.close();
    }
  });
});
