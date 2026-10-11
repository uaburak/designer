/**
 * A contract fake of the server's shared-font routes (docs/desktop.md §14.3; the real ones are `server/src/fonts/`,
 * round 3a) as a `fetch`, for sharedFonts.test.ts: who gets which fonts (org members and admins the org's, guests none;
 * a team's members the team's), uploads with the licence header and Skip / Replace, removal, the bytes by SHA-1.
 */
import { createHash } from "node:crypto";
import type { FontConflict, SharedFontFace, SharedFontFaceInput, SharedFontList } from "../shared/fonts/sharedTypes";

export type FakeOrgRole = "admin" | "member" | "guest";

export interface FakeFontServer {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  /** Puts a person in an org (and teams); returns their token */
  person(userId: string, org: { orgId: string; role: FakeOrgRole; teams?: string[]; teamAdmin?: string[] }[]): string;
  faces(): SharedFontFace[];
  /** Requests seen, "METHOD path" */
  log: string[];
  /** Answers nothing (offline) while true */
  offline: boolean;
}

export function fakeFontServer(base = "https://fake.test"): FakeFontServer {
  const tokens = new Map<string, string>();
  const orgRoles = new Map<string, Map<string, FakeOrgRole>>(); // orgId → userId → role
  const teamMembers = new Map<string, Set<string>>(); // teamId → userIds
  const teamAdmins = new Map<string, Set<string>>();
  const teamOrg = new Map<string, string>();
  let faces: SharedFontFace[] = [];
  const blobs = new Map<string, Uint8Array>();
  let seq = 0;
  const log: string[] = [];

  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const roleIn = (user: string, orgId: string) => orgRoles.get(orgId)?.get(user) ?? null;
  const inTeam = (user: string, teamId: string) => teamMembers.get(teamId)?.has(user) ?? false;
  /** Org fonts: members and admins (not guests — the owner's default). Team fonts: the team's members. */
  const mayUse = (user: string, f: SharedFontFace) => (f.teamId === null ? ["admin", "member"].includes(roleIn(user, f.orgId) ?? "") : inTeam(user, f.teamId));
  const mayUpload = (user: string, orgId: string, teamId: string | null) => roleIn(user, orgId) === "admin" || (teamId !== null && (teamAdmins.get(teamId)?.has(user) ?? false));
  const inScope = (orgId: string, teamId: string | null) => (f: SharedFontFace) => f.orgId === orgId && f.teamId === teamId;
  const versionOf = (list: SharedFontFace[]) => createHash("sha1").update(list.map((f) => f.id).sort().join(",")).digest("hex").slice(0, 16);

  const server: FakeFontServer = {
    log,
    offline: false,
    faces: () => faces,
    person(userId, orgs) {
      const token = `t-${userId}`;
      tokens.set(token, userId);
      for (const o of orgs) {
        if (!orgRoles.has(o.orgId)) orgRoles.set(o.orgId, new Map());
        orgRoles.get(o.orgId)!.set(userId, o.role);
        for (const t of [...(o.teams ?? []), ...(o.teamAdmin ?? [])]) {
          teamOrg.set(t, o.orgId);
          if (!teamMembers.has(t)) teamMembers.set(t, new Set());
          teamMembers.get(t)!.add(userId);
        }
        for (const t of o.teamAdmin ?? []) {
          if (!teamAdmins.has(t)) teamAdmins.set(t, new Set());
          teamAdmins.get(t)!.add(userId);
        }
      }
      return token;
    },
    async fetch(url, init = {}) {
      if (server.offline) throw new TypeError("fetch failed");
      const u = new URL(url);
      if (u.origin !== base) return reply(404, { error: "Not found" });
      const method = init.method ?? "GET";
      log.push(`${method} ${u.pathname}${u.search}`);
      const headers = new Headers(init.headers);
      const user = tokens.get((headers.get("authorization") ?? "").replace(/^Bearer /, ""));
      if (!user) return reply(401, { error: "Log in first" });
      const path = u.pathname;
      const team = u.searchParams.get("team");

      if (method === "GET" && path === "/me/fonts") {
        const mine = faces.filter((f) => mayUse(user, f));
        return reply(200, { version: versionOf(mine), faces: mine } satisfies SharedFontList);
      }
      const bytesRoute = path.match(/^\/fonts\/([0-9a-f]{40})$/);
      if (method === "GET" && bytesRoute) {
        const sha = bytesRoute[1];
        if (!faces.some((f) => f.sha1 === sha && mayUse(user, f)) || !blobs.has(sha)) return reply(404, { error: "Not found" });
        const f = faces.find((x) => x.sha1 === sha)!;
        return new Response(blobs.get(sha)!.slice(), { status: 200, headers: { "content-type": f.format === "otf" ? "font/otf" : "font/ttf" } });
      }
      const m = path.match(/^\/orgs\/([^/]+)\/fonts(?:\/(check|[^/]+))?$/);
      if (!m) return reply(404, { error: "Not found" });
      const orgId = decodeURIComponent(m[1]);
      if (team && teamOrg.get(team) !== orgId) return reply(404, { error: "Not found" });

      if (method === "GET" && !m[2]) {
        if (team ? !inTeam(user, team) : !["admin", "member"].includes(roleIn(user, orgId) ?? "")) return reply(403, { error: "You can't see these fonts" });
        return reply(200, { faces: faces.filter(inScope(orgId, team)) });
      }
      if (method === "POST" && m[2] === "check") {
        const body = JSON.parse(String(init.body)) as { teamId?: string; families: string[] };
        const teamId = body.teamId ?? null;
        if (!mayUpload(user, orgId, teamId)) return reply(403, { error: "Only admins can upload fonts" });
        const scoped = faces.filter(inScope(orgId, teamId));
        const conflicts: FontConflict[] = body.families.flatMap((family) => {
          const existing = scoped.filter((f) => f.family === family).length;
          return existing ? [{ family, existing }] : [];
        });
        return reply(200, { conflicts });
      }
      if (method === "PUT" && !m[2]) {
        if (!mayUpload(user, orgId, team)) return reply(403, { error: "Only admins can upload fonts" });
        if (headers.get("x-font-licence") !== "confirmed") return reply(400, { error: "Confirm the font's licence" });
        const bytes = new Uint8Array(init.body as Uint8Array);
        const tag = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
        if (tag !== 0x00010000 && tag !== 0x74727565 && tag !== 0x4f54544f) return reply(400, { error: "Not a TTF or OTF file" });
        const inputs = JSON.parse(Buffer.from(headers.get("x-font-faces") ?? "", "base64").toString("utf8")) as SharedFontFaceInput[];
        const families = [...new Set(inputs.map((f) => f.family))];
        const onConflict = u.searchParams.get("onConflict");
        const scoped = faces.filter(inScope(orgId, team));
        const taken = families.filter((fam) => scoped.some((f) => f.family === fam));
        if (taken.length && !onConflict) return reply(409, { error: "conflict", families: taken });
        const replaced: string[] = [];
        let keep = inputs;
        if (taken.length && onConflict === "skip") keep = inputs.filter((f) => !taken.includes(f.family));
        if (taken.length && onConflict === "replace") {
          faces = faces.filter((f) => !(inScope(orgId, team)(f) && taken.includes(f.family)));
          replaced.push(...taken);
        }
        const sha1 = createHash("sha1").update(bytes).digest("hex");
        if (keep.length) blobs.set(sha1, bytes);
        const uploaded = keep.map(
          (f): SharedFontFace => ({
            ...f,
            id: `f${++seq}`,
            sha1,
            format: tag === 0x4f54544f ? "otf" : "ttf",
            size: bytes.length,
            fileName: decodeURIComponent(headers.get("x-font-file-name") ?? "font"),
            orgId,
            teamId: team,
            uploadedAt: Date.now(),
            uploadedBy: { id: user, name: null },
          }),
        );
        faces.push(...uploaded);
        return reply(200, { uploaded, replaced });
      }
      if (method === "DELETE") {
        const id = m[2] ? decodeURIComponent(m[2]) : null;
        const family = u.searchParams.get("family");
        const target = id ? faces.find((f) => f.id === id && f.orgId === orgId) : null;
        const teamId = target ? target.teamId : team;
        if (!mayUpload(user, orgId, teamId)) return reply(403, { error: "Only admins can remove fonts" });
        if (id) faces = faces.filter((f) => f.id !== id);
        else if (family) faces = faces.filter((f) => !(inScope(orgId, team)(f) && f.family === family));
        return reply(200, { faces: faces.filter(inScope(orgId, teamId)) });
      }
      return reply(404, { error: "Not found" });
    },
  };
  return server;
}
